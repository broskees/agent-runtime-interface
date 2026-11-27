// The Codex recording function: scripts/record-codex.ts calls it with the
// recorder's own environment, and the tests call it with a fake `codex` on
// PATH. For each scenario it makes a fresh temp workspace (./run.ts), copies
// the user's Codex sign-in file into the workspace's Codex home
// (./credentials.ts), lists the models Codex offers and picks one, runs the
// scenario through a fresh Codex driver whose process service starts the
// `codex` on PATH behind the process tap (../stdio/tap.ts), sanitises every
// frame, writes `<outDir>/<scenario>.ndjson`, and checks the scenario's
// assertions.
//
// The user's Codex setup stays out and unchanged: `codex` gets its own
// CODEX_HOME (holding the recorder's config.toml and the copied sign-in),
// HOME, XDG directories and TMPDIR inside the workspace, an unreachable
// session bus, and none of the user's CODEX_ or OPENAI_ variables, so it reads
// none of the user's config, MCP servers, plugins, memories, skills, rules,
// sessions or goals, and keeps every credential in files of its own home,
// never in the user's keyring. It works in the workspace's `cwd/`, the root
// of its own Git repository, so it reads no AGENTS.md, `.codex/` or `.agents/`
// of the folders above; and the recorder stops before it starts `codex` when
// the workspace lies in the user's home or below a folder holding one of
// those. It also stops before it starts `codex` unless the user's Codex keeps
// its sign-in in the file it copies (./credential-store.ts). A sign-in
// `codex` refreshed during the run (Codex rotates a ChatGPT refresh token)
// goes back to the resolved target under both Codex locks (./sign-in-lock.ts),
// or, when it cannot, into this run's recovery file (../recovery.ts). The
// workspace is removed after every scenario,
// also after one that fails, unless it holds the only copy of a refreshed
// sign-in: then the recorder keeps it and stops.

import * as fs from "node:fs";
import * as path from "node:path";
import { codexDriver } from "../../../src/drivers/codex/index.ts";
import type { ModelInfo } from "../../../src/generated/instance.ts";
import type { Request } from "../../../src/generated/request.ts";
import { createProcessService } from "../../../src/node/process.ts";
import type { ProcessService } from "../../../src/node/process.ts";
import { CODEX_SOURCE } from "../../../scripts/codegen-codex.ts";
import type { Frame, RecordingSource } from "../format.ts";
import { writeRecording } from "../format.ts";
import { copyCredentialFile } from "../credential-file.ts";
import type { CopiedCredentialFile } from "../credential-file.ts";
import { CredentialsKeptError, CredentialsNotSavedError, RecordingNotWrittenError, keepRefreshedCredentials, recoveryFileFor } from "../recovery.ts";
import { createSanitiser } from "../sanitiser.ts";
import { SCENARIOS, checkScenario } from "../scenarios.ts";
import type { Scenario, ScenarioName } from "../scenarios.ts";
import { tapProcess } from "../stdio/tap.ts";
import { CODEX_SYSTEM_CONFIG_DIR, CodexCredentialStoreError, checkCodexCredentialStore } from "./credential-store.ts";
import { CODEX_SIGN_IN_FILE, userCodexHome, userSignInFile, workspaceSignInFile } from "./credentials.ts";
import { CODEX_SIGN_IN_LOCK, CodexSignInLockError, checkFlockRuns, takeCodexSignInLock } from "./sign-in-lock.ts";
import type { HeldCodexSignInLock } from "./sign-in-lock.ts";
import { codexNativeAnswers } from "./frames.ts";
import { CODEX_PROTOCOL_WORDS } from "./protocol-words.ts";
import { CODEX_RECORDER_ENV_POLICY, CODEX_RECORDER_INSTANCE_ID, codexRecorderConfig, codexRecorderHost, createCodexLayout, runCodexScenario } from "./run.ts";
import type { CodexLayout } from "./run.ts";

export const CODEX_VENDOR_NAME = "codex-cli";
/** Codex speaks its app-server protocol over stdio; no package stands between the driver and `codex`. The header's sdkVersion is the tag whose schema the driver is built on. */
export const CODEX_SDK_NAME = "codex-app-server";
export const CODEX_MODEL_VARIABLE = "ARI_RECORD_CODEX_MODEL";

/** The variables of the recorder's environment `codex` does not get: its own HOME, XDG directories, TMPDIR and session bus replace them. Every CODEX_ and OPENAI_ variable goes too, by the host's rule (CODEX_RECORDER_ENV_POLICY). */
export function droppedFromAgent(name: string): boolean {
  return name === "HOME" || name === "TMPDIR" || name === "DBUS_SESSION_BUS_ADDRESS" || name.startsWith("XDG_");
}

/**
 * The environment `codex` starts from, before the host strips every CODEX_
 * and OPENAI_ variable: the recorder's own, without the variables
 * `droppedFromAgent` names, plus the workspace's directories, and a session
 * bus address where nothing listens, so the Secret Service of the user's
 * keyring is out of reach even if a setting the recorder does not control
 * sends codex there.
 */
export function codexEnvironment(layout: CodexLayout, env: { readonly [name: string]: string | undefined }): { [name: string]: string } {
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
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(layout.root, "no-session-bus")}`,
  };
}

/**
 * The real process service the recorder starts `codex` through, before the
 * tap: the workspace's environment, the host's stripping, and the
 * workspace's Codex home as CODEX_HOME on every spawn. A process the driver
 * starts without a working directory (the driver names none for
 * `codex app-server`) starts in the workspace's `cwd/`, not in the recorder's
 * own directory, which is the user's checkout.
 */
export function codexProcessService(layout: CodexLayout, env: { readonly [name: string]: string | undefined }): ProcessService {
  const service = createProcessService({ envPolicy: CODEX_RECORDER_ENV_POLICY, baseEnv: codexEnvironment(layout, env) });
  return {
    envPolicy: service.envPolicy,
    resolveExecutable: (name, options) => service.resolveExecutable(name, options),
    spawn: (request) => service.spawn({ ...request, cwd: request.cwd ?? layout.cwd, env: { ...(request.env ?? {}), CODEX_HOME: layout.codexHome } }),
    dispose: () => service.dispose(),
  };
}

/** The version `codex --version` prints, run through the recorder's own process service (not recorded), or "unknown". */
export async function agentVersion(service: ProcessService, command: string): Promise<string> {
  try {
    const child = await service.spawn({ command, args: ["--version"], purpose: "probe", stdin: "ignore", timeoutMs: 10_000 });
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

/** The model is missing from what Codex lists, or Codex lists none the recorder would pick: the recorder stops before the first prompt. */
export class CodexModelChoiceError extends Error {
  readonly models: readonly string[];
  constructor(message: string, models: readonly string[]) {
    super(message);
    this.name = "CodexModelChoiceError";
    this.models = models;
  }
}

/** A model's id or name naming one of OpenAI's small, cheap models: a word `luna`, `nano` or `mini`, any case. */
const SMALL_MODEL = /(?:^|[^a-z0-9])(?:luna|nano|mini)(?:[^a-z0-9]|$)/i;

/**
 * The recorder's default: the first model Codex lists (its `model/list`, in
 * Codex's order, hidden models aside) whose id or name holds the word `luna`,
 * `nano` or `mini`, any case. OpenAI's API docs ("Models", read 2026-11-25)
 * name GPT-6 Luna the model "for cost-sensitive, high-volume workloads"; its
 * earlier small models were named mini and nano. Codex's model list carries
 * no size or price, so the name decides.
 */
export function defaultCodexModel(models: readonly ModelInfo[]): string | undefined {
  return models.find((model) => model.legacy !== true && (SMALL_MODEL.test(model.id) || SMALL_MODEL.test(model.label)))?.id;
}

function listed(models: readonly ModelInfo[]): string {
  return models.length === 0 ? "  (none)" : models.map((model) => `  ${model.id}${model.label === model.id ? "" : ` (${model.label})`}`).join("\n");
}

/** The recorder's choice: ARI_RECORD_CODEX_MODEL when set, else `defaultCodexModel`. Throws CodexModelChoiceError when it cannot pick one. */
export function chooseCodexModel(models: readonly ModelInfo[], env: { readonly [name: string]: string | undefined }): string {
  const ids = models.map((model) => model.id);
  const named = env[CODEX_MODEL_VARIABLE]?.trim();
  if (named !== undefined && named !== "") {
    if (!ids.includes(named)) throw new CodexModelChoiceError(`${CODEX_MODEL_VARIABLE} names ${named}, which Codex does not list. It lists:\n${listed(models)}`, ids);
    return named;
  }
  const small = defaultCodexModel(models);
  if (small === undefined) throw new CodexModelChoiceError(`Codex lists no Luna, nano or mini model, the recorder's default. Set ${CODEX_MODEL_VARIABLE} to one of the models it lists:\n${listed(models)}`, ids);
  return small;
}

/** The models Codex lists (`model/list`), asked through an instance of the driver whose `codex app-server` starts through the recorder's own process service: not recorded. */
export async function listCodexModels(layout: CodexLayout, service: ProcessService): Promise<readonly ModelInfo[]> {
  const instance = await codexDriver.create(codexRecorderHost(layout, service), { instanceId: CODEX_RECORDER_INSTANCE_ID, config: codexDriver.defaultConfig(), environment: {} });
  try {
    return (await instance.catalog.list()).models;
  } finally {
    await instance.dispose();
  }
}

export interface RecordCodexOptions {
  /** The scenarios to record, in order; all six when left out. */
  readonly scenarios?: readonly ScenarioName[];
  readonly outDir: string;
  readonly source: RecordingSource;
  /**
   * The recorder's environment: HOME and CODEX_HOME (where the user's sign-in
   * file is), PATH (where `codex` is), ARI_RECORD_CODEX_MODEL, what `codex`
   * inherits, and the values the sanitiser replaces.
   */
  readonly env: { readonly [name: string]: string | undefined };
  /** How long a scenario waits for any one thing. */
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
  /** The recording date; today when left out. */
  readonly date?: string;
  /** The OS user name the sanitiser replaces; os.userInfo().username when left out. */
  readonly user?: string;
  /** Where the recorder reads the system's Codex files (CODEX_SYSTEM_CONFIG_DIR, `/etc/codex`, when left out): a seam for tests, which never write /etc. scripts/record-codex.ts leaves it out. */
  readonly systemConfigDir?: string;
}

export interface CodexRecordOutcome {
  readonly scenario: ScenarioName;
  /** The recording written, when the run reached `codex` and chose a model, and the write succeeded. */
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
  /** The workspace still exists: its Codex home holds the only copy of a refreshed sign-in. The run stopped after this scenario. */
  readonly workspaceKept: boolean;
  /** The recovery file this scenario added a refreshed sign-in to, when it could not go back to the user's sign-in file. */
  readonly recoveryFile?: string;
}

/** No sign-in file to copy on a live run: Codex keeps the sign-in where the recorder cannot copy it from. */
export class CodexSignInMissingError extends Error {
  constructor(file: string | undefined) {
    super(
      `no Codex sign-in file at ${file ?? "~/.codex/auth.json"}. Codex keeps a ChatGPT or API-key sign-in there unless your config.toml sets cli_auth_credentials_store to keyring or auto, which keeps it in your OS keyring; the recorder copies only the file, and never reads your keyring. Sign in with \`codex login\` with file storage, then record again. See "How Codex finds the sign-in" in docs/recordings.md.`,
    );
    this.name = "CodexSignInMissingError";
  }
}

/** The temp workspace lies inside the user's home: the recorder stops before it starts `codex`, so nothing above the folder `codex` works in is the user's. */
export class CodexWorkspaceInHomeError extends Error {
  constructor(workspace: string, home: string) {
    super(`the recorder's temp workspace ${workspace} is inside your home ${home}, and codex reads AGENTS.md, .codex/ and .agents/ in the folders above the folder it works in up to the project root. Set TMPDIR to a directory outside your home and record again.`);
    this.name = "CodexWorkspaceInHomeError";
  }
}

/** What Codex reads as the instructions and configuration of the folder it works in and of each parent folder up to the project root (codex-rs/core/src/agents_md.rs:7–18). */
export const CODEX_WORKSPACE_CUSTOMIZATIONS = ["AGENTS.md", "AGENTS.override.md", ".codex", ".agents"] as const;

/** Every AGENTS.md, AGENTS.override.md, .codex and .agents in a folder above `directory`, nearest first. */
export function customizationsAbove(directory: string): string[] {
  const found: string[] = [];
  for (let folder = path.dirname(directory); ; folder = path.dirname(folder)) {
    for (const name of CODEX_WORKSPACE_CUSTOMIZATIONS) if (fs.existsSync(path.join(folder, name))) found.push(path.join(folder, name));
    if (path.dirname(folder) === folder) return found;
  }
}

/**
 * A folder above the temp workspace holds AGENTS.md, AGENTS.override.md,
 * .codex or .agents. The workspace's `cwd/` is the root of its own Git
 * repository, so by Codex's source `codex` reads none of them; the recorder
 * still stops before it starts `codex`, so a lookup that goes further finds
 * nothing of the user's either.
 */
export class CodexWorkspaceCustomizedError extends Error {
  readonly found: readonly string[];
  constructor(workspace: string, found: readonly string[]) {
    super(`a folder above the recorder's temp workspace ${workspace} holds ${found.join(", ")}, and codex reads AGENTS.md, .codex/ and .agents/ in the folders above the folder it works in up to the project root. Set TMPDIR to a directory with none of them in it or above it, and record again.`);
    this.name = "CodexWorkspaceCustomizedError";
    this.found = found;
  }
}

/** Each failure of a scenario, in order. */
export function failuresOf(outcome: CodexRecordOutcome): readonly Error[] {
  if (outcome.error === undefined) return [];
  return outcome.error instanceof AggregateError ? (outcome.error.errors as Error[]) : [outcome.error];
}

/** The lines that end a run: how many scenarios passed, then every recovery file and every kept workspace, so none goes unseen. */
export function describeCodexRun(outcomes: readonly CodexRecordOutcome[], outDir: string): string[] {
  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  const lines = [`${outcomes.length - failed.length} of ${outcomes.length} scenario(s) passed; recordings in ${outDir}`];
  for (const file of new Set(outcomes.flatMap((outcome) => (outcome.recoveryFile === undefined ? [] : [outcome.recoveryFile])))) {
    lines.push(`a refreshed Codex sign-in that could not go back to your sign-in file is in ${file}, readable only by you: write the newest value over your Codex home's ${CODEX_SIGN_IN_FILE} (~/.codex/${CODEX_SIGN_IN_FILE}, or CODEX_HOME's), or sign in again`);
  }
  for (const outcome of outcomes.filter((each) => each.workspaceKept)) {
    lines.push(`the run stopped after ${outcome.scenario} and kept its workspace ${outcome.workspace}: its codex-home/${CODEX_SIGN_IN_FILE} holds the only copy of a refreshed sign-in`);
  }
  return lines;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** How long the copy-back waits for another codex to let go of auth.lock. Codex holds it only while it commits a sign-in, never across a network request (codex-rs/login/src/auth/storage_commit.rs:1–2). */
export const CODEX_SIGN_IN_LOCK_WAIT_MS = 30_000;

const CODEX_COMMIT_LOCK_WAIT_MS = 5_000;

interface CopiedCodexSignIn extends CopiedCredentialFile {
  /** Resolved target at copy time. `real` still names the selected home's auth.json. */
  readonly target: string;
}

/** Copy the target's bytes, never the link, and remember which file the run refreshed. */
export function copyCodexSignIn(real: string, copy: string): CopiedCodexSignIn | undefined {
  let target: string;
  try {
    target = fs.realpathSync.native(real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!fs.lstatSync(target).isFile()) throw new Error(`Codex sign-in ${real} must resolve to a regular file`);
  const credential = copyCredentialFile(target, copy, CODEX_SIGN_IN_FILE);
  return credential === undefined ? undefined : { ...credential, real, target };
}

/** Keeps the refreshed copy in the recovery file beside the user's file, as ../credential-file.ts does, and throws CredentialsKeptError naming it; CredentialsNotSavedError when even that file cannot take it. */
function keepRefreshedSignIn(credential: CopiedCredentialFile, why: string): never {
  const recoveryFile = recoveryFileFor(credential.real);
  try {
    keepRefreshedCredentials(recoveryFile, [{ id: credential.id, value: fs.readFileSync(credential.copy, "utf8") }]);
  } catch (error) {
    throw new CredentialsNotSavedError(
      `${why}, and the recorder could not keep the refreshed sign-in in ${recoveryFile} either (${error instanceof Error ? error.message : String(error)}). The refreshed sign-in is only in the recorder's copy, ${credential.copy}.`,
      credential.copy,
      recoveryFile,
    );
  }
  throw new CredentialsKeptError(`${why}; it kept the refreshed sign-in in ${recoveryFile}, readable only by you. Write its newest value over ${credential.real}, or sign in again.`, recoveryFile);
}

/** Compare and replace the resolved file under both pinned Codex locks. Never rename over a link. */
export async function returnCodexSignIn(credential: CopiedCodexSignIn, env: { readonly [name: string]: string | undefined }, homeWaitMs = CODEX_SIGN_IN_LOCK_WAIT_MS, commitWaitMs = CODEX_COMMIT_LOCK_WAIT_MS): Promise<void> {
  if (!fs.existsSync(credential.copy)) return;
  const refreshed = fs.readFileSync(credential.copy);
  if (refreshed.equals(credential.original)) return;
  const { real, target } = credential;
  const writeFailure = `the recorder could not write the sign-in codex refreshed back to ${real}`;
  const requireLock = async (file: string, waitMs: number, mode?: number): Promise<HeldCodexSignInLock> => {
    let held: HeldCodexSignInLock | undefined;
    try {
      held = await takeCodexSignInLock(file, waitMs, env, mode);
    } catch (error) {
      return keepRefreshedSignIn(credential, `the recorder could not take Codex's lock ${file} to write the sign-in codex refreshed back to ${real} (${error instanceof Error ? error.message : String(error)})`);
    }
    return held ?? keepRefreshedSignIn(credential, `another codex held its lock ${file} for ${waitMs / 1000} s, so the recorder did not write the sign-in codex refreshed back to ${real}`);
  };
  const checkTarget = (): void => {
    if (fs.realpathSync.native(real) !== target) throw new Error("the sign-in resolves to a different target than the one copied");
  };
  const homeLock = await requireLock(path.join(path.dirname(real), CODEX_SIGN_IN_LOCK), homeWaitMs);
  let commitLock: HeldCodexSignInLock | undefined;
  try {
    try {
      checkTarget();
    } catch (error) {
      return keepRefreshedSignIn(credential, `${writeFailure} (${error instanceof Error ? error.message : String(error)})`);
    }
    // storage_commit.rs:28–68 uses Path::with_extension("json.lock"), not a lock beside the symlink.
    const commitLockFile = target.slice(0, target.length - path.extname(target).length) + ".json.lock";
    commitLock = await requireLock(commitLockFile, commitWaitMs, 0o600);
    try {
      checkTarget();
      const metadata = fs.lstatSync(target);
      if (!metadata.isFile() || metadata.nlink > 1) throw new Error("the credential target is not a regular file with one link");
      if (fs.readFileSync(target).equals(credential.original)) {
        // Like storage_file.rs and storage.rs, require a writable target, then replace it with a private, synced file.
        if ((metadata.mode & 0o222) === 0) throw new Error("the credential target is read-only");
        fs.closeSync(fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW));
        const staging = fs.mkdtempSync(path.join(path.dirname(target), ".ari-recorder-"));
        try {
          const replacement = path.join(staging, CODEX_SIGN_IN_FILE);
          fs.writeFileSync(replacement, refreshed, { mode: 0o600, flag: "wx", flush: true });
          checkTarget();
          fs.renameSync(replacement, target);
        } finally {
          fs.rmSync(staging, { recursive: true, force: true });
        }
        return;
      }
    } catch (error) {
      return keepRefreshedSignIn(credential, `${writeFailure} (${error instanceof Error ? error.message : String(error)})`);
    }
    return keepRefreshedSignIn(credential, `${real} changed while the recorder ran, and codex also refreshed the recorder's copy; the recorder left ${real} as it is`);
  } finally {
    try {
      await commitLock?.release();
    } finally {
      await homeLock.release();
    }
  }
}

/** Codex reports the command as one string, sometimes wrapped in a shell invocation. Never parse or execute it here. */
export function isCodexMarkerApproval(request: Pick<Request, "kind" | "subject">, scenario: Scenario, cwd: string): boolean {
  if (scenario.name !== "approval_allowed" || scenario.command === undefined || request.kind !== "command" || request.subject?.cwd !== cwd) return false;
  const command = request.subject.command;
  if (command?.length !== 1) return false;
  const singleQuoted = `'${scenario.command.replaceAll("'", "'\\''")}'`;
  const doubleQuoted = `"${scenario.command.replace(/["\\$`]/g, "\\$&")}"`;
  return command[0] === scenario.command || ["/usr/bin/bash -lc", "/bin/bash -lc", "/bin/bash -c", "/bin/sh -c"].some((shell) => command[0] === `${shell} ${singleQuoted}` || command[0] === `${shell} ${doubleQuoted}`);
}

async function recordOne(scenario: Scenario, options: RecordCodexOptions): Promise<CodexRecordOutcome> {
  const log = options.log ?? (() => undefined);
  const layout = createCodexLayout(`ari-codex-record-${scenario.name}-`);
  const frames: Frame[] = [];
  let model: string | undefined;
  let credential: CopiedCodexSignIn | undefined;
  let service: ProcessService | undefined;
  let vendorVersion = "unknown";
  const errors: Error[] = [];
  const failed = (reason: unknown): void => {
    errors.push(reason instanceof Error ? reason : new Error(String(reason)));
  };
  let recoveryFile: string | undefined;
  let workspaceKept = false;
  try {
    const home = options.env["HOME"]?.trim();
    if (home !== undefined && home !== "") {
      const homes = new Set([home, fs.existsSync(home) ? fs.realpathSync(home) : home]);
      for (const each of homes) if (layout.root.startsWith(`${each}${path.sep}`)) throw new CodexWorkspaceInHomeError(layout.root, home);
    }
    const above = customizationsAbove(layout.root);
    if (above.length > 0) throw new CodexWorkspaceCustomizedError(layout.root, above);
    const real = userSignInFile(options.env);
    checkCodexCredentialStore(userCodexHome(options.env), options.systemConfigDir ?? CODEX_SYSTEM_CONFIG_DIR, real ?? `~/.codex/${CODEX_SIGN_IN_FILE}`);
    // A sign-in to copy may come back refreshed, under Codex's locks, which the recorder takes with flock.
    if (real !== undefined && fs.existsSync(real)) checkFlockRuns(options.env);
    credential = real === undefined ? undefined : copyCodexSignIn(real, workspaceSignInFile(layout.codexHome));
    if (options.source === "live" && credential === undefined) throw new CodexSignInMissingError(real);
    service = codexProcessService(layout, options.env);
    vendorVersion = await agentVersion(service, codexDriver.defaultConfig().binaryPath);
    model = chooseCodexModel(await listCodexModels(layout, service), options.env);
    const tap = tapProcess(service, (frame) => frames.push(frame));
    let run;
    try {
      let approved = false;
      ({ run } = await runCodexScenario({
        scenario, layout, process: tap.process, model, timeoutMs: options.timeoutMs ?? 300_000,
        ...(options.source !== "live" ? {} : { mayApprove: (request: Request) => {
          if (approved || !isCodexMarkerApproval(request, scenario, layout.cwd)) return false;
          approved = true;
          return true;
        } }),
      }));
    } finally {
      if (!(await tap.settled(10_000))) failed(new Error(`a codex process of scenario ${scenario.name} was still running, or its output still open, 10 s after the driver closed its sessions`));
    }
    checkScenario(run, codexNativeAnswers(frames));
  } catch (reason) {
    failed(reason);
  } finally {
    await service?.dispose().catch(failed);
    if (credential !== undefined) {
      try {
        await returnCodexSignIn(credential, options.env);
      } catch (reason) {
        failed(reason);
        // Kept in the recovery file: the copy can go. Anything else: the copy may hold the only refreshed sign-in.
        if (reason instanceof CredentialsKeptError) recoveryFile = reason.recoveryFile;
        else {
          workspaceKept = true;
          failed(new Error(`the recorder kept the workspace ${layout.root}, with its copy of your Codex sign-in, ${credential.copy}, and stopped. Write that copy over ${credential.real}, then delete the workspace.`));
        }
      }
    }
    if (!workspaceKept) fs.rmSync(layout.root, { recursive: true, force: true });
  }
  let file: string | undefined;
  if (frames.length > 0 && model !== undefined) {
    const target = path.join(options.outDir, `${scenario.name}.ndjson`);
    // A failed write joins the scenario's other failures, so none of them, nor where a refreshed sign-in went, is lost with it.
    try {
      const sanitise = createSanitiser({ workspace: layout.root, env: options.env, protocolWords: CODEX_PROTOCOL_WORDS, recordedModel: model, ...(options.user === undefined ? {} : { user: options.user }) });
      await writeRecording(
        target,
        {
          driver: "codex",
          vendor: CODEX_VENDOR_NAME,
          vendorVersion,
          sdk: CODEX_SDK_NAME,
          sdkVersion: CODEX_SOURCE.tag,
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
  log(`${scenario.name}: ${error === undefined ? "passed" : `FAILED: ${error.message}`}${file === undefined ? ", nothing recorded" : `, ${frames.length} frames in ${file}`}`);
  return {
    scenario: scenario.name,
    frames: frames.length,
    workspace: layout.root,
    workspaceKept,
    ...(model === undefined ? {} : { model }),
    ...(file === undefined ? {} : { file }),
    ...(error === undefined ? {} : { error }),
    ...(recoveryFile === undefined ? {} : { recoveryFile }),
  };
}

/**
 * Records each scenario in turn. A failed scenario does not stop the others,
 * but eight failures stop them all: a temp workspace inside the user's home,
 * a temp workspace below a folder holding AGENTS.md, AGENTS.override.md,
 * .codex or .agents, a Codex setup that keeps the sign-in elsewhere than the
 * file the recorder copies, no `flock` to take Codex's lock with, no sign-in
 * file to copy, a model Codex does not list, a refreshed sign-in the recorder
 * could keep nowhere but in the workspace, and a recording it could not
 * write.
 */
export async function recordCodex(options: RecordCodexOptions): Promise<CodexRecordOutcome[]> {
  const names = options.scenarios ?? SCENARIOS.map((scenario) => scenario.name);
  const outcomes: CodexRecordOutcome[] = [];
  for (const name of names) {
    const scenario = SCENARIOS.find((candidate) => candidate.name === name);
    if (scenario === undefined) throw new Error(`no scenario is named ${JSON.stringify(name)}`);
    const outcome = await recordOne(scenario, options);
    outcomes.push(outcome);
    const stops = (failure: Error): boolean =>
      failure instanceof CodexWorkspaceInHomeError ||
      failure instanceof CodexWorkspaceCustomizedError ||
      failure instanceof CodexCredentialStoreError ||
      failure instanceof CodexSignInLockError ||
      failure instanceof CodexSignInMissingError ||
      failure instanceof CodexModelChoiceError ||
      failure instanceof RecordingNotWrittenError;
    if (outcome.workspaceKept || failuresOf(outcome).some(stops)) break;
  }
  return outcomes;
}
