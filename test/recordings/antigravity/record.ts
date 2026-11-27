// The Antigravity recording function: scripts/record-antigravity.ts calls it
// with the recorder's own environment, and the tests call it with a fake `agy`
// on PATH. For each scenario it makes a fresh temp workspace (./run.ts),
// copies the user's Antigravity sign-in file into the instance's profile
// (./credentials.ts), runs the scenario through a fresh Antigravity driver
// whose process service starts the `agy` on PATH behind the process tap
// (../stdio/tap.ts), sanitises every frame, writes
// `<outDir>/<scenario>.ndjson`, and checks the scenario's assertions.
//
// The user's Antigravity setup stays out and unchanged: `agy` gets its own
// HOME, XDG directories, TMPDIR and profile inside the workspace, none of the
// user's GEMINI_*, GOOGLE_*, GCLOUD_*, CLOUDSDK_* or AGY_* variables, the
// driver's AGY_CLI_FORCE_FILE_TOKEN_STORAGE, and an unreachable session bus,
// so it cannot reach the user's keyring and keeps its sign-in in the copied
// file. After each scenario the recorder logs what `agy`'s own log says about
// where it kept the sign-in (`tokenStorageLog`). It works in the workspace's
// `cwd/`, the root of its own Git repository, so it reads no AGENTS.md,
// GEMINI.md or .agents/ of the folders above; and the recorder stops before
// it starts `agy` when the workspace lies in the user's home or below a folder
// holding one of those. A sign-in `agy` refreshed during the run goes
// back to the user's file, or, when it cannot, into this run's recovery file
// beside it (../credential-file.ts). The workspace is removed after every
// scenario, also after one that fails, unless it holds the only copy of a
// refreshed sign-in: then the recorder keeps it and stops.

import * as fs from "node:fs";
import * as path from "node:path";
import { createProcessService } from "../../../src/node/process.ts";
import type { ProcessService } from "../../../src/node/process.ts";
import { ACP_TESTED_SCHEMA_RELEASE } from "../../../src/meta/acp.ts";
import type { Frame, RecordingSource } from "../format.ts";
import { writeRecording } from "../format.ts";
import { copyCredentialFile, returnCredentialFile } from "../credential-file.ts";
import type { CopiedCredentialFile } from "../credential-file.ts";
import { CredentialsKeptError, RecordingNotWrittenError } from "../recovery.ts";
import { createSanitiser } from "../sanitiser.ts";
import { SCENARIOS, checkScenario } from "../scenarios.ts";
import type { Scenario, ScenarioName } from "../scenarios.ts";
import type { Request } from "../../../src/generated/request.ts";
import { tapProcess } from "../stdio/tap.ts";
import { acpNativeAnswers } from "../acp/frames.ts";
import { ACP_PROTOCOL_WORDS } from "../acp/protocol-words.ts";
import { ANTIGRAVITY_SIGN_IN_FILE, profileSignInFile, userSignInFile } from "./credentials.ts";
import { ANTIGRAVITY_EFFORT_VARIABLE, ANTIGRAVITY_MODEL_VARIABLE, ANTIGRAVITY_RECORDER_ENV_POLICY, AntigravityModelChoiceError, antigravityRecorderConfig, createAntigravityLayout, listAntigravityModels, recordingModelChooser, runAntigravityScenario } from "./run.ts";
import type { AntigravityLayout } from "./run.ts";

export const ANTIGRAVITY_VENDOR_NAME = "antigravity-cli";
/** Antigravity speaks ACP over stdio; no package stands between the driver and `agy`. */
export const ANTIGRAVITY_SDK_NAME = "acp";

/**
 * The variables of the recorder's environment `agy` does not get: its own HOME,
 * XDG directories and TMPDIR replace them, and its session bus is one that
 * does not exist.
 */
export function droppedFromAgent(name: string): boolean {
  return name === "HOME" || name === "TMPDIR" || name === "DBUS_SESSION_BUS_ADDRESS" || name.startsWith("XDG_");
}

/**
 * The environment `agy` starts from, before the host strips the ambient
 * Google and Antigravity variables (ANTIGRAVITY_RECORDER_ENV_POLICY): the
 * recorder's own, without the variables `droppedFromAgent` names, plus the
 * workspace's directories.
 */
export function antigravityEnvironment(layout: AntigravityLayout, env: { readonly [name: string]: string | undefined }): { [name: string]: string } {
  const base: { [name: string]: string } = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined && !droppedFromAgent(name)) base[name] = value;
  return {
    ...base,
    HOME: layout.home,
    XDG_CONFIG_HOME: layout.configHome,
    XDG_DATA_HOME: layout.dataHome,
    XDG_STATE_HOME: layout.stateHome,
    XDG_CACHE_HOME: layout.cacheHome,
    XDG_RUNTIME_DIR: layout.runtimeDir,
    TMPDIR: layout.tmp,
    // D-Bus clients find the session bus at this address (D-Bus Specification, "Well-known Message Bus Instances"); no bus listens there.
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(layout.root, "no-session-bus")}`,
  };
}

/**
 * The real process service the recorder starts `agy` through, before the tap:
 * the workspace's environment, the host's stripping, and the variables the
 * driver adds. A process the driver starts without a working directory (the
 * driver names none for `agy acp`) starts in the workspace's `cwd/`, not in
 * the recorder's own directory: Antigravity loads workspace rules and
 * customizations from the folder it works in and its parents ("Customization
 * discovery"), and the recorder runs in the user's checkout.
 */
export function antigravityProcessService(layout: AntigravityLayout, env: { readonly [name: string]: string | undefined }): ProcessService {
  const service = createProcessService({ envPolicy: ANTIGRAVITY_RECORDER_ENV_POLICY, baseEnv: antigravityEnvironment(layout, env) });
  return {
    envPolicy: service.envPolicy,
    resolveExecutable: (name, options) => service.resolveExecutable(name, options),
    spawn: (request) => {
      if (request.cwd !== undefined && request.cwd !== layout.cwd) throw new Error("the recorder requires the isolated process cwd");
      return service.spawn({ ...request, cwd: layout.cwd });
    },
    dispose: () => service.dispose(),
  };
}

/** The lines of `agy`'s log that say where it keeps a Google sign-in: "Using file-based token storage because ..." and "... falling back to file ...". */
const EXPLICIT_FILE_MODE = "Using file-based token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set";
const TOKEN_STORAGE_LINE = /Using file-based token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set|Using file-based token storage because no D-Bus session bus detected|Failed to load stored token from keyring, falling back to file/g;

/**
 * What `agy` logged, in any `*.log` file under `directory`, about where it
 * keeps the sign-in: each distinct line TOKEN_STORAGE_LINE matches, from its
 * first word on. `agy` 1.5.16 logs "Using file-based token storage because
 * AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set" when the driver's variable took
 * effect, so a live run shows that the driver, not only the unreachable
 * session bus, kept the keyring out.
 */
export function tokenStorageLog(directory: string): string[] {
  const found = new Set<string>();
  const visit = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith(".log")) for (const match of fs.readFileSync(file, "utf8").matchAll(TOKEN_STORAGE_LINE)) found.add(match[0].trim());
    }
  };
  visit(directory);
  return [...found];
}

/** The version `<command> --version` prints, run through the recorder's own process service (not recorded), or "unknown". It runs with auto-update off, as the driver runs `agy acp`. */
export async function agentVersion(service: ProcessService, command: string): Promise<string> {
  try {
    const child = await service.spawn({ command, args: ["--version"], env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, purpose: "probe", stdin: "ignore", timeoutMs: 10_000 });
    let output = "";
    const decoder = new TextDecoder();
    const drain = async (stream: AsyncIterable<Uint8Array>): Promise<void> => {
      for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
    };
    await Promise.all([drain(child.stdout), drain(child.stderr), child.exited]);
    return /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output)?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface RecordAntigravityOptions {
  /** Open one ACP thread to list models, without sending a prompt or writing a tape. */
  readonly listModels?: boolean;
  /** Abort before ACP startup if the installed CLI reports another version. */
  readonly requireVersion?: string;
  /** The scenarios to record, in order; all six when left out. */
  readonly scenarios?: readonly ScenarioName[];
  readonly outDir: string;
  readonly source: RecordingSource;
  /**
   * The recorder's environment: HOME (where the user's sign-in file is), PATH
   * (where `agy` is), ARI_RECORD_ANTIGRAVITY_MODEL, what `agy` inherits, and
   * the values the sanitiser replaces.
   */
  readonly env: { readonly [name: string]: string | undefined };
  /** How long a scenario waits for any one thing. */
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
  /** The recording date; today when left out. */
  readonly date?: string;
  /** The OS user name the sanitiser replaces; os.userInfo().username when left out. */
  readonly user?: string;
}

export interface AntigravityRecordOutcome {
  readonly offeredModels?: readonly string[];
  readonly scenario: ScenarioName;
  /** The recording written, when the run reached `agy` and chose a model, and the write succeeded. */
  readonly file?: string;
  readonly frames: number;
  /** The model the scenario ran with, once chosen. */
  readonly model?: string;
  /**
   * Why the scenario failed: its run, its assertions, the model choice, the
   * sign-in copy-back, the recording's write. With more than one failure, an
   * AggregateError whose message names each, in the order they happened.
   */
  readonly error?: Error;
  /** The temp workspace the scenario ran in; removed unless `workspaceKept`. */
  readonly workspace: string;
  /** The workspace still exists: its profile holds the only copy of a refreshed sign-in. The run stopped after this scenario. */
  readonly workspaceKept: boolean;
  /** The recovery file this scenario added a refreshed sign-in to, when it could not go back to the user's sign-in file. */
  readonly recoveryFile?: string;
}

/** No sign-in file to copy on a live run: `agy` keeps the sign-in where the recorder cannot copy it from. */
export class AntigravitySignInMissingError extends Error {
  constructor(file: string | undefined) {
    const geminiDirectory = file === undefined ? "~/.gemini" : path.dirname(path.dirname(file));
    super(
      `no Antigravity sign-in file at ${file ?? "~/.gemini/antigravity-cli/antigravity-oauth-token"}. agy keeps a Google sign-in in your OS keyring, and in that file only when it uses its file storage; the recorder copies only the file, and never reads your keyring. To sign in once into that file, leaving your keyring's sign-in as it is, run \`AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy acp --login --gemini-dir ${geminiDirectory} --app-data-dir antigravity-cli\` and finish the Google sign-in it opens. See "How Antigravity finds the sign-in" in docs/recordings.md.`,
    );
    this.name = "AntigravitySignInMissingError";
  }
}

/**
 * The temp workspace lies inside the user's home: `agy` reads `AGENTS.md`,
 * `GEMINI.md` and `.agents/` in the folder it works in and the folders above
 * it, so it could read the user's own. The recorder stops before it starts
 * `agy`.
 */
export class AntigravityWorkspaceInHomeError extends Error {
  constructor(workspace: string, home: string) {
    super(`the recorder's temp workspace ${workspace} is inside your home ${home}, and agy reads AGENTS.md, GEMINI.md and .agents/ in the folders above the folder it works in. Set TMPDIR to a directory outside your home and record again.`);
    this.name = "AntigravityWorkspaceInHomeError";
  }
}

/** What Antigravity reads as the rules and customizations of the folder it works in and of each parent folder up to its repository's root ("Customization discovery"). */
export const ANTIGRAVITY_WORKSPACE_CUSTOMIZATIONS = ["AGENTS.md", "GEMINI.md", ".agents"] as const;

/** Every AGENTS.md, GEMINI.md and .agents in a folder above `directory`, nearest first. */
export function customizationsAbove(directory: string): string[] {
  const found: string[] = [];
  for (let folder = path.dirname(directory); ; folder = path.dirname(folder)) {
    for (const name of ANTIGRAVITY_WORKSPACE_CUSTOMIZATIONS) if (fs.existsSync(path.join(folder, name))) found.push(path.join(folder, name));
    if (path.dirname(folder) === folder) return found;
  }
}

/**
 * A folder above the temp workspace holds AGENTS.md, GEMINI.md or .agents/.
 * The workspace's `cwd/` is the root of its own Git repository, so by
 * Antigravity's docs `agy` reads none of them; the recorder still stops
 * before it starts `agy`, so a lookup that goes further than the docs say
 * finds nothing of the user's either.
 */
export class AntigravityWorkspaceCustomizedError extends Error {
  readonly found: readonly string[];
  constructor(workspace: string, found: readonly string[]) {
    super(`a folder above the recorder's temp workspace ${workspace} holds ${found.join(", ")}, and agy reads AGENTS.md, GEMINI.md and .agents/ in the folders above the folder it works in. Set TMPDIR to a directory with none of them in it or above it, and record again.`);
    this.name = "AntigravityWorkspaceCustomizedError";
    this.found = found;
  }
}

/** Each failure of a scenario, in order. */
export function failuresOf(outcome: AntigravityRecordOutcome): readonly Error[] {
  if (outcome.error === undefined) return [];
  return outcome.error instanceof AggregateError ? (outcome.error.errors as Error[]) : [outcome.error];
}

/** The lines that end a run: how many scenarios passed, then every recovery file and every kept workspace, so none goes unseen. */
export function describeAntigravityRun(outcomes: readonly AntigravityRecordOutcome[], outDir: string): string[] {
  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  const lines = [`${outcomes.length - failed.length} of ${outcomes.length} scenario(s) passed; recordings in ${outDir}`];
  for (const file of new Set(outcomes.flatMap((outcome) => (outcome.recoveryFile === undefined ? [] : [outcome.recoveryFile])))) {
    lines.push(`a refreshed Antigravity sign-in that could not go back to your sign-in file is in ${file}, readable only by you: write the newest value over ~/.gemini/antigravity-cli/${ANTIGRAVITY_SIGN_IN_FILE}, or sign in again`);
  }
  for (const outcome of outcomes.filter((each) => each.workspaceKept)) {
    lines.push(`the run stopped after ${outcome.scenario} and kept its workspace ${outcome.workspace}: its profile's antigravity-acp/${ANTIGRAVITY_SIGN_IN_FILE} holds the only copy of a refreshed sign-in`);
  }
  return lines;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Never print a native error: an ACP error can carry account details in its text. */
export function safeAntigravityFailure(error: Error): string {
  if (error instanceof AntigravitySignInMissingError || error instanceof AntigravityWorkspaceInHomeError || error instanceof AntigravityWorkspaceCustomizedError) return error.message;
  if (error instanceof AntigravityModelChoiceError) return "the ACP thread did not confirm the requested model or effort";
  if (error instanceof AggregateError) return (error.errors as Error[]).map(safeAntigravityFailure).join("; ");
  const code = (error as { callError?: { code?: unknown } }).callError?.code;
  if (typeof code === "string" && /^[a-z_]{1,40}$/.test(code)) return `ACP call failed (${code})`;
  if (["the installed agy does not report the required version", "the isolated ACP thread advertised no models", "agy did not confirm explicitly forced profile-file token storage"].includes(error.message)) return error.message;
  return "recording or scenario check failed";
}

/** Accept only the literal marker command; omission of Cwd needs a guard at execution. */
export function isAntigravityMarkerApproval(request: Pick<Request, "kind" | "subject" | "options">, scenario: Scenario, cwd: string, guarded = false): boolean {
  if (scenario.name !== "approval_allowed" || scenario.command === undefined || request.kind !== "command" || request.subject?.cwd !== cwd) return false;
  const input = request.subject.tool?.input;
  if (typeof input !== "object" || input === null || !("CommandLine" in input) || input.CommandLine !== scenario.command) return false;
  if ("Cwd" in input ? input.Cwd !== cwd : !guarded) return false;
  if (Object.keys(input).some((key) => !["Cwd", "CommandLine", "WaitMsBeforeAsync", "toolSummary"].includes(key))) return false;
  if (request.subject.tool?.name !== scenario.command) return false;
  if (request.subject.command !== undefined && (request.subject.command.length !== 1 || request.subject.command[0] !== scenario.command)) return false;
  return request.options?.some((option) => option.decision === "accept" && option.scope === "once") === true;
}

/** agy 1.5.17 omits Cwd for run_command. Its only approved write must
 * pass this cwd check before reaching the system tee. No command is rewritten. */
export function installMarkerCwdGuard(layout: AntigravityLayout): string {
  const bin = path.join(layout.root, "marker-bin");
  fs.mkdirSync(bin, { mode: 0o700 });
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(path.join(bin, "tee"), `#!/bin/sh\nset -eu\n[ "$(pwd -P)" = ${quote(layout.cwd)} ] && [ "$#" -eq 1 ] && [ "$1" = ari-marker.txt ] && [ ! -e "$1" ] && [ ! -L "$1" ] || exit 1\n/usr/bin/tee -- "$1"\n: > ${quote(path.join(bin, "marker-written"))}\n`, { mode: 0o700 });
  return bin;
}

async function recordOne(scenario: Scenario, options: RecordAntigravityOptions): Promise<AntigravityRecordOutcome> {
  const log = options.log ?? (() => undefined);
  const label = options.listModels ? "model preflight" : scenario.name;
  const layout = createAntigravityLayout(`ari-antigravity-record-${options.listModels ? "models" : scenario.name}-`);
  const frames: Frame[] = [];
  const models = recordingModelChooser(options.env);
  let credential: CopiedCredentialFile | undefined;
  let service: ProcessService | undefined;
  let vendorVersion = "unknown";
  let offeredModels: readonly string[] | undefined;
  const errors: Error[] = [];
  const failed = (reason: unknown): void => {
    errors.push(reason instanceof Error ? reason : new Error(String(reason)));
  };
  let recoveryFile: string | undefined;
  let workspaceKept = false;
  try {
    const thought_level = options.env[ANTIGRAVITY_EFFORT_VARIABLE]?.trim();
    const named = options.env[ANTIGRAVITY_MODEL_VARIABLE]?.trim();
    if (thought_level !== undefined && (!named || !thought_level)) throw new AntigravityModelChoiceError("pinning effort requires both a model and an effort", []);
    const pin = thought_level === undefined || !named ? undefined : { model: named, thought_level };
    const home = options.env["HOME"]?.trim();
    if (home !== undefined && home !== "") {
      const homes = new Set([home, fs.existsSync(home) ? fs.realpathSync(home) : home]);
      for (const each of homes) if (layout.root.startsWith(`${each}${path.sep}`)) throw new AntigravityWorkspaceInHomeError(layout.root, home);
    }
    const above = customizationsAbove(layout.root);
    if (above.length > 0) throw new AntigravityWorkspaceCustomizedError(layout.root, above);
    const real = userSignInFile(options.env);
    credential = real === undefined ? undefined : copyCredentialFile(real, profileSignInFile(layout.profile), ANTIGRAVITY_SIGN_IN_FILE);
    if (options.source === "live" && credential === undefined) throw new AntigravitySignInMissingError(real);
    service = antigravityProcessService(layout, options.env);
    vendorVersion = await agentVersion(service, antigravityRecorderConfig().command);
    if (options.requireVersion !== undefined && vendorVersion !== options.requireVersion) throw new Error("the installed agy does not report the required version");
    const guarded = options.source === "live" && !options.listModels && scenario.name === "approval_allowed" && vendorVersion === "1.5.17";
    if (guarded) {
      const bin = installMarkerCwdGuard(layout);
      await service.dispose();
      service = antigravityProcessService(layout, { ...options.env, PATH: `${bin}${path.delimiter}${options.env["PATH"] ?? "/usr/bin:/bin"}` });
    }
    const tap = tapProcess(service, (frame) => frames.push(frame));
    let run;
    try {
      if (options.listModels) {
        offeredModels = await listAntigravityModels(layout, tap.process, models, pin);
        if (offeredModels.length === 0) throw new Error("the isolated ACP thread advertised no models");
      } else {
        let allowed = false;
        ({ run } = await runAntigravityScenario({ scenario, layout, process: tap.process, models, timeoutMs: options.timeoutMs ?? 300_000,
          ...(pin === undefined ? {} : { pin }),
          ...(options.source === "live" ? { mayApprove: (request: Request) => {
            if (allowed || !isAntigravityMarkerApproval(request, scenario, layout.cwd, guarded)) return false;
            allowed = true;
            return true;
          } } : {}),
        }));
      }
    } finally {
      if (!(await tap.settled(10_000))) failed(new Error(`an agy process of scenario ${scenario.name} was still running, or its output still open, 10 s after the driver closed its sessions`));
    }
    if (run !== undefined) {
      checkScenario(run, acpNativeAnswers(frames));
      if (guarded && (!fs.existsSync(path.join(layout.root, "marker-bin", "marker-written")) || fs.readFileSync(path.join(layout.cwd, "ari-marker.txt"), "utf8") !== `${scenario.marker}\n`)) throw new Error("the guarded marker was not written in the isolated cwd");
    }
  } catch (reason) {
    failed(reason);
  } finally {
    await service?.dispose().catch(failed);
    if (credential !== undefined) {
      try {
        returnCredentialFile(credential, "agy");
      } catch (reason) {
        failed(reason);
        // Kept in the recovery file: the copy can go. Anything else: the copy may hold the only refreshed sign-in.
        if (reason instanceof CredentialsKeptError) recoveryFile = reason.recoveryFile;
        else {
          workspaceKept = true;
          failed(new Error(`the recorder kept the workspace ${layout.root}, with its copy of your Antigravity sign-in, ${credential.copy}, and stopped. Write that copy over ${credential.real}, then delete the workspace.`));
        }
      }
    }
    // Only once an agy acp ran: the recorder can stop before it starts one.
    if (frames.some((frame) => frame.kind === "spawn" && frame["purpose"] === "runtime")) {
      try {
        const storage = tokenStorageLog(layout.root);
        log(`${label}: agy's log ${storage.length === 0 ? "says nothing about where it keeps the sign-in" : `on where it keeps the sign-in: ${storage.join("; ")}`}`);
        if (options.listModels && !storage.includes(EXPLICIT_FILE_MODE)) failed(new Error("agy did not confirm explicitly forced profile-file token storage"));
      } catch (reason) {
        log(`${label}: agy's token storage log could not be read`);
        if (options.listModels) failed(reason);
      }
    }
    if (!workspaceKept) fs.rmSync(layout.root, { recursive: true, force: true });
  }
  const model = models.chosen;
  let file: string | undefined;
  if (frames.length > 0 && model !== undefined) {
    const target = path.join(options.outDir, `${scenario.name}.ndjson`);
    // A failed write joins the scenario's other failures, so none of them, nor where a refreshed sign-in went, is lost with it.
    try {
      const sanitise = createSanitiser({ workspace: layout.root, env: options.env, protocolWords: ACP_PROTOCOL_WORDS, antigravity: true, recordedModel: model, ...(options.user === undefined ? {} : { user: options.user }) });
      await writeRecording(
        target,
        {
          driver: "antigravity",
          vendor: ANTIGRAVITY_VENDOR_NAME,
          vendorVersion,
          sdk: ANTIGRAVITY_SDK_NAME,
          sdkVersion: ACP_TESTED_SCHEMA_RELEASE,
          model,
          scenario: scenario.name,
          recorded: options.date ?? today(),
          source: options.source,
        },
        frames.map((frame) => sanitise(frame)),
      );
      file = target;
    } catch (reason) {
      failed(new RecordingNotWrittenError(target, reason));
    }
  }
  const error = errors.length <= 1 ? errors[0] : new AggregateError(errors, `${errors.length} failures:\n${errors.map((each, index) => `  ${index + 1}. ${each.message}`).join("\n")}`);
  log(`${label}: ${error === undefined ? "passed" : `FAILED: ${options.source === "live" ? safeAntigravityFailure(error) : error.message}`}${file === undefined ? ", nothing recorded" : `, ${frames.length} frames in ${file}`}`);
  return {
    scenario: scenario.name,
    frames: frames.length,
    workspace: layout.root,
    workspaceKept,
    ...(model === undefined ? {} : { model }),
    ...(offeredModels === undefined ? {} : { offeredModels }),
    ...(file === undefined ? {} : { file }),
    ...(error === undefined ? {} : { error }),
    ...(recoveryFile === undefined ? {} : { recoveryFile }),
  };
}

/**
 * Records each scenario in turn. A failed scenario does not stop the others,
 * but six failures stop them all: a temp workspace inside the user's home, a
 * temp workspace below a folder holding AGENTS.md, GEMINI.md or .agents/, no
 * sign-in file to copy, a model the agent does not offer, a refreshed sign-in
 * the recorder could keep nowhere but in the workspace, and a recording it
 * could not write.
 */
export async function recordAntigravity(options: RecordAntigravityOptions): Promise<AntigravityRecordOutcome[]> {
  const names = options.listModels ? ["simple"] as const : options.scenarios ?? SCENARIOS.map((scenario) => scenario.name);
  const outcomes: AntigravityRecordOutcome[] = [];
  for (const name of names) {
    const scenario = SCENARIOS.find((candidate) => candidate.name === name);
    if (scenario === undefined) throw new Error(`no scenario is named ${JSON.stringify(name)}`);
    const outcome = await recordOne(scenario, options);
    outcomes.push(outcome);
    const stops = (failure: Error): boolean =>
      failure instanceof AntigravityWorkspaceInHomeError ||
      failure instanceof AntigravityWorkspaceCustomizedError ||
      failure instanceof AntigravitySignInMissingError ||
      failure instanceof AntigravityModelChoiceError ||
      failure instanceof RecordingNotWrittenError;
    if (outcome.workspaceKept || failuresOf(outcome).some(stops)) break;
  }
  return outcomes;
}
