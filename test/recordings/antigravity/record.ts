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
// user's GEMINI_*, GOOGLE_*, GCLOUD_*, CLOUDSDK_* or AGY_* variables, and an
// unreachable session bus, so it cannot reach the user's keyring and keeps its
// sign-in in the copied file. A sign-in `agy` refreshed during the run goes
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
import { tapProcess } from "../stdio/tap.ts";
import { acpNativeAnswers } from "../acp/frames.ts";
import { ACP_PROTOCOL_WORDS } from "../acp/protocol-words.ts";
import { ANTIGRAVITY_SIGN_IN_FILE, profileSignInFile, userSignInFile } from "./credentials.ts";
import { ANTIGRAVITY_RECORDER_ENV_POLICY, AntigravityModelChoiceError, antigravityRecorderConfig, createAntigravityLayout, recordingModelChooser, runAntigravityScenario } from "./run.ts";
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

/** Added to every spawn after the host's stripping: the name `agy` 1.5.17's binary holds for forcing its file token storage. */
export const ANTIGRAVITY_RECORDER_ADDITIONS: { readonly [name: string]: string } = { AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1" };

/**
 * The real process service the recorder starts `agy` through, before the tap:
 * the workspace's environment, the host's stripping, and
 * ANTIGRAVITY_RECORDER_ADDITIONS. A process the driver starts without a
 * working directory (the driver names none for `agy acp`) starts in the
 * workspace's `cwd/`, not in the recorder's own directory: Antigravity loads
 * workspace rules and customizations from the folder it works in and its
 * parents ("Customization discovery"), and the recorder runs in the user's
 * checkout.
 */
export function antigravityProcessService(layout: AntigravityLayout, env: { readonly [name: string]: string | undefined }): ProcessService {
  const service = createProcessService({ envPolicy: ANTIGRAVITY_RECORDER_ENV_POLICY, baseEnv: antigravityEnvironment(layout, env) });
  return {
    envPolicy: service.envPolicy,
    resolveExecutable: (name, options) => service.resolveExecutable(name, options),
    spawn: (request) => service.spawn({ ...request, cwd: request.cwd ?? layout.cwd, env: { ...(request.env ?? {}), ...ANTIGRAVITY_RECORDER_ADDITIONS } }),
    dispose: () => service.dispose(),
  };
}

/** The version `<command> --version` prints, run through the recorder's own process service (not recorded), or "unknown". */
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

export interface RecordAntigravityOptions {
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
    super(
      `no Antigravity sign-in file at ${file ?? "~/.gemini/antigravity-cli/antigravity-oauth-token"}. agy keeps a Google sign-in in your OS keyring, and in that file only when the keyring is bypassed or unreachable; the recorder copies only the file, and never reads your keyring. See "How Antigravity finds the sign-in" in docs/recordings.md.`,
    );
    this.name = "AntigravitySignInMissingError";
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

async function recordOne(scenario: Scenario, options: RecordAntigravityOptions): Promise<AntigravityRecordOutcome> {
  const log = options.log ?? (() => undefined);
  const layout = createAntigravityLayout(`ari-antigravity-record-${scenario.name}-`);
  const frames: Frame[] = [];
  const models = recordingModelChooser(options.env);
  let credential: CopiedCredentialFile | undefined;
  let service: ProcessService | undefined;
  let vendorVersion = "unknown";
  const errors: Error[] = [];
  const failed = (reason: unknown): void => {
    errors.push(reason instanceof Error ? reason : new Error(String(reason)));
  };
  let recoveryFile: string | undefined;
  let workspaceKept = false;
  try {
    const real = userSignInFile(options.env);
    credential = real === undefined ? undefined : copyCredentialFile(real, profileSignInFile(layout.profile), ANTIGRAVITY_SIGN_IN_FILE);
    if (options.source === "live" && credential === undefined) throw new AntigravitySignInMissingError(real);
    service = antigravityProcessService(layout, options.env);
    vendorVersion = await agentVersion(service, antigravityRecorderConfig().command);
    const tap = tapProcess(service, (frame) => frames.push(frame));
    let run;
    try {
      ({ run } = await runAntigravityScenario({ scenario, layout, process: tap.process, models, timeoutMs: options.timeoutMs ?? 300_000 }));
    } finally {
      if (!(await tap.settled(10_000))) failed(new Error(`an agy process of scenario ${scenario.name} was still running, or its output still open, 10 s after the driver closed its sessions`));
    }
    checkScenario(run, acpNativeAnswers(frames));
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
    if (!workspaceKept) fs.rmSync(layout.root, { recursive: true, force: true });
  }
  const model = models.chosen;
  let file: string | undefined;
  if (frames.length > 0 && model !== undefined) {
    const target = path.join(options.outDir, `${scenario.name}.ndjson`);
    // A failed write joins the scenario's other failures, so none of them, nor where a refreshed sign-in went, is lost with it.
    try {
      const sanitise = createSanitiser({ workspace: layout.root, env: options.env, protocolWords: ACP_PROTOCOL_WORDS, recordedModel: model, ...(options.user === undefined ? {} : { user: options.user }) });
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
 * but four failures stop them all: no sign-in file to copy, a model the agent
 * does not offer, a refreshed sign-in the recorder could keep nowhere but in
 * the workspace, and a recording it could not write.
 */
export async function recordAntigravity(options: RecordAntigravityOptions): Promise<AntigravityRecordOutcome[]> {
  const names = options.scenarios ?? SCENARIOS.map((scenario) => scenario.name);
  const outcomes: AntigravityRecordOutcome[] = [];
  for (const name of names) {
    const scenario = SCENARIOS.find((candidate) => candidate.name === name);
    if (scenario === undefined) throw new Error(`no scenario is named ${JSON.stringify(name)}`);
    const outcome = await recordOne(scenario, options);
    outcomes.push(outcome);
    const stops = (failure: Error): boolean => failure instanceof AntigravitySignInMissingError || failure instanceof AntigravityModelChoiceError || failure instanceof RecordingNotWrittenError;
    if (outcome.workspaceKept || failuresOf(outcome).some(stops)) break;
  }
  return outcomes;
}
