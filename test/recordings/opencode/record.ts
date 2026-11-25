// The OpenCode recording function: scripts/record-opencode.ts calls it with a
// starter that runs the real `opencode serve`, and the tests call it with the
// fake. For each scenario it makes a fresh temp workspace (./run.ts), copies
// the user's sign-ins into it (./credentials.ts), starts the server there
// (./serve.ts), checks that the server offers the model the recorder was
// asked for, puts the recording proxy (./proxy.ts) in front, runs the
// scenario through a fresh driver whose `serverUrl` is the proxy, sanitises
// every frame, writes `<outDir>/<scenario>.ndjson`, and checks the scenario's
// assertions.
//
// The user's OpenCode setup stays out and unchanged: the server gets its own
// HOME and XDG base directories inside the workspace and none of the user's
// OPENCODE_* variables (./serve.ts), and its database holds only the user's
// sign-ins. A sign-in OpenCode refreshed during the run goes back to the
// user's database, or, when it cannot, into this run's recovery file beside
// it (./credentials.ts). The workspace is removed after every scenario, also
// after one that fails, unless it holds the only copy of a refreshed sign-in:
// then the recorder keeps it and stops.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame, RecordingSource } from "../format.ts";
import { writeRecording } from "../format.ts";
import { createSanitiser } from "../sanitiser.ts";
import { SCENARIOS, checkScenario } from "../scenarios.ts";
import type { Scenario, ScenarioName } from "../scenarios.ts";
import { CredentialsKeptError, copyCredentials, returnCredentials } from "./credentials.ts";
import type { CopiedCredentials } from "./credentials.ts";
import { opencodeNativeAnswers } from "./frames.ts";
import { OPENCODE_PROTOCOL_WORDS } from "./protocol-words.ts";
import { startRecordingProxy } from "./proxy.ts";
import type { RecordingProxy } from "./proxy.ts";
import { STREAM_CLOSE_WAIT_MS, createOpencodeLayout, runOpencodeScenario } from "./run.ts";
import type { OpencodeLayout } from "./run.ts";
import { opencodeServeEnvironment } from "./serve.ts";
import type { OpencodeServerHandle } from "./serve.ts";

export const OPENCODE_SDK_NAME = "@opencode/client";
export const OPENCODE_VENDOR_NAME = "opencode";
export const OPENCODE_MODEL_VARIABLE = "ARI_RECORD_OPENCODE_MODEL";

export interface StartServerInput {
  readonly scenario: Scenario;
  readonly layout: OpencodeLayout;
  /** The whole environment the server must run with. */
  readonly env: { readonly [name: string]: string };
  /** The password the server must require. */
  readonly password: string;
}

export interface RecordOpencodeOptions {
  /** The scenarios to record, in order; all six when left out. */
  readonly scenarios?: readonly ScenarioName[];
  readonly outDir: string;
  readonly source: RecordingSource;
  /**
   * The recorder's environment: HOME and XDG_DATA_HOME (where the user's
   * OpenCode database is), ARI_RECORD_OPENCODE_MODEL, what the server inherits
   * (PATH, provider keys), and the values the sanitiser replaces.
   */
  readonly env: { readonly [name: string]: string | undefined };
  /** Starts the server for one scenario: `opencode serve` when live, a fake when testing. */
  readonly startServer: (input: StartServerInput) => Promise<OpencodeServerHandle>;
  /** How long a scenario waits for any one thing. */
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
  /** The recording date; today when left out. */
  readonly date?: string;
  /** The OS user name the sanitiser replaces; os.userInfo().username when left out. */
  readonly user?: string;
}

export interface OpencodeRecordOutcome {
  readonly scenario: ScenarioName;
  /** The recording written, when the run reached the server at all and the write succeeded. */
  readonly file?: string;
  readonly frames: number;
  /**
   * Why the scenario failed: its run, its assertions, the model check, the
   * sign-in copy-back, the recording's write. With more than one failure, an AggregateError whose
   * message names each, in the order they happened.
   */
  readonly error?: Error;
  /** The temp workspace the scenario ran in; removed unless `workspaceKept`. */
  readonly workspace: string;
  /** The workspace still exists: its database copy holds the only copy of a refreshed sign-in. The run stopped after this scenario. */
  readonly workspaceKept: boolean;
  /** The recovery file this scenario added refreshed sign-ins to, when one could not go back to the user's database. */
  readonly recoveryFile?: string;
}

/** The recorder could not write a scenario's recording (an output directory it cannot use, a full disk): the recorder stops, since the next scenario would fail the same way. */
export class RecordingNotWrittenError extends Error {
  readonly file: string;
  constructor(file: string, cause: unknown) {
    super(`the recorder could not write the recording ${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "RecordingNotWrittenError";
    this.file = file;
  }
}

/** Each failure of a scenario, in order. */
export function failuresOf(outcome: OpencodeRecordOutcome): readonly Error[] {
  if (outcome.error === undefined) return [];
  return outcome.error instanceof AggregateError ? (outcome.error.errors as Error[]) : [outcome.error];
}

/** The lines that end a run: how many scenarios passed, then every recovery file and every kept workspace, so none goes unseen. */
export function describeOpencodeRun(outcomes: readonly OpencodeRecordOutcome[], outDir: string): string[] {
  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  const lines = [`${outcomes.length - failed.length} of ${outcomes.length} scenario(s) passed; recordings in ${outDir}`];
  for (const file of new Set(outcomes.flatMap((outcome) => (outcome.recoveryFile === undefined ? [] : [outcome.recoveryFile])))) {
    lines.push(`refreshed sign-in(s) that could not go back to your OpenCode database are in ${file}, readable only by you: put each value back into its row of the credential table, or sign in again`);
  }
  for (const outcome of outcomes.filter((each) => each.workspaceKept)) {
    lines.push(`the run stopped after ${outcome.scenario} and kept its workspace ${outcome.workspace}: its database copy holds the only copy of a refreshed sign-in`);
  }
  return lines;
}

/** The model is missing or not one the server offers: the recorder stops before the first prompt. */
export class OpencodeModelChoiceError extends Error {
  readonly models: readonly string[];
  constructor(message: string, models: readonly string[]) {
    super(message);
    this.name = "OpencodeModelChoiceError";
    this.models = models;
  }
}

/** The model the recorder asks for: ARI_RECORD_OPENCODE_MODEL, as `provider/model`, or undefined. */
export function recordModel(env: { readonly [name: string]: string | undefined }): string | undefined {
  const chosen = env[OPENCODE_MODEL_VARIABLE]?.trim();
  return chosen === undefined || chosen === "" ? undefined : chosen;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The version of the `@opencode/client` package the driver loads. */
export function opencodeClientVersion(): string {
  let directory = path.dirname(fileURLToPath(import.meta.resolve(OPENCODE_SDK_NAME)));
  for (;;) {
    const file = path.join(directory, "package.json");
    if (fs.existsSync(file)) {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (manifest.name === OPENCODE_SDK_NAME && typeof manifest.version === "string") return manifest.version;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return "unknown";
    directory = parent;
  }
}

/** One GET of the server's API, straight to the server and not through the proxy: nothing of it is recorded. */
async function askServer(server: OpencodeServerHandle, route: string): Promise<unknown> {
  const authorization = `Basic ${Buffer.from(`opencode:${server.password}`, "utf8").toString("base64")}`;
  const response = await fetch(`${server.url}${route}`, { headers: { authorization } });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`the OpenCode server answered GET ${route} with HTTP ${response.status}`);
  }
  return response.json();
}

/** The models the server offers (2.1.2 `GET /api/model`), as `provider/model`, as the driver's catalog lists them. */
async function offeredModels(server: OpencodeServerHandle, directory: string): Promise<string[]> {
  const listed = (await askServer(server, `/api/model?${new URLSearchParams({ "location[directory]": directory })}`)) as { data?: unknown };
  const data = Array.isArray(listed.data) ? listed.data : [];
  return data.flatMap((model: unknown) => {
    const entry = (model ?? {}) as { providerID?: unknown; modelID?: unknown; enabled?: unknown };
    return entry.enabled !== false && typeof entry.providerID === "string" && typeof entry.modelID === "string" ? [`${entry.providerID}/${entry.modelID}`] : [];
  });
}

function chooseModel(env: RecordOpencodeOptions["env"], models: readonly string[]): string {
  const list = models.length === 0 ? "  (none: sign in to a provider with `opencode auth login`, or set its API key)" : models.map((model) => `  ${model}`).join("\n");
  const chosen = recordModel(env);
  if (chosen === undefined) throw new OpencodeModelChoiceError(`${OPENCODE_MODEL_VARIABLE} is not set. Set it to one of the models the OpenCode server offers:\n${list}`, models);
  if (!models.includes(chosen)) throw new OpencodeModelChoiceError(`${OPENCODE_MODEL_VARIABLE} names ${chosen}, which the OpenCode server does not offer. It offers:\n${list}`, models);
  return chosen;
}

async function recordOne(scenario: Scenario, options: RecordOpencodeOptions): Promise<OpencodeRecordOutcome> {
  const log = options.log ?? (() => undefined);
  const layout = createOpencodeLayout(`ari-opencode-record-${scenario.name}-`);
  const frames: Frame[] = [];
  const password = randomBytes(32).toString("base64url");
  let credentials: CopiedCredentials | undefined;
  let server: OpencodeServerHandle | undefined;
  let proxy: RecordingProxy | undefined;
  let model: string | undefined;
  let vendorVersion = "unknown";
  const errors: Error[] = [];
  const failed = (reason: unknown): void => {
    errors.push(reason instanceof Error ? reason : new Error(String(reason)));
  };
  let recoveryFile: string | undefined;
  let workspaceKept = false;
  try {
    credentials = await copyCredentials(options.env, layout);
    server = await options.startServer({ scenario, layout, env: opencodeServeEnvironment(layout, options.env, password), password });
    const info = (await askServer(server, "/api/info")) as { version?: unknown };
    if (typeof info.version === "string") vendorVersion = info.version;
    model = chooseModel(options.env, await offeredModels(server, layout.cwd));
    proxy = await startRecordingProxy({ upstream: server.url, record: (frame) => frames.push(frame) });
    const { run } = await runOpencodeScenario({ scenario, layout, transport: proxy, password, model, timeoutMs: options.timeoutMs ?? 300_000 });
    // The driver closed its event stream when the session closed; the proxy records that close.
    if (!(await proxy.whenStreamsClosed(STREAM_CLOSE_WAIT_MS))) failed(new Error(`an event stream of scenario ${scenario.name} was still open ${STREAM_CLOSE_WAIT_MS} ms after the driver closed its session`));
    checkScenario(run, opencodeNativeAnswers(frames));
  } catch (reason) {
    failed(reason);
  } finally {
    await proxy?.close().catch(failed);
    await server?.stop().catch(failed);
    if (credentials !== undefined) {
      try {
        await returnCredentials(credentials);
      } catch (reason) {
        failed(reason);
        // Kept in the recovery file: the copy can go. Anything else: the copy may hold the only refreshed value.
        if (reason instanceof CredentialsKeptError) recoveryFile = reason.recoveryFile;
        else {
          workspaceKept = true;
          failed(new Error(`the recorder kept the workspace ${layout.root}, with its copy of your OpenCode database, ${credentials.copy}, and stopped. Put each refreshed value from that copy's credential table back into yours, then delete the workspace.`));
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
      const sanitise = createSanitiser({ workspace: layout.root, env: options.env, protocolWords: OPENCODE_PROTOCOL_WORDS, ...(options.user === undefined ? {} : { user: options.user }) });
      await writeRecording(
        target,
        {
          driver: "opencode",
          vendor: OPENCODE_VENDOR_NAME,
          vendorVersion,
          sdk: OPENCODE_SDK_NAME,
          sdkVersion: opencodeClientVersion(),
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
    ...(file === undefined ? {} : { file }),
    ...(error === undefined ? {} : { error }),
    ...(recoveryFile === undefined ? {} : { recoveryFile }),
  };
}

/**
 * Records each scenario in turn. A failed scenario does not stop the others,
 * but three failures stop them all: a model the server does not offer, a
 * refreshed sign-in the recorder could keep nowhere but in the workspace, and
 * a recording it could not write.
 */
export async function recordOpencode(options: RecordOpencodeOptions): Promise<OpencodeRecordOutcome[]> {
  const names = options.scenarios ?? SCENARIOS.map((scenario) => scenario.name);
  const outcomes: OpencodeRecordOutcome[] = [];
  for (const name of names) {
    const scenario = SCENARIOS.find((candidate) => candidate.name === name);
    if (scenario === undefined) throw new Error(`no scenario is named ${JSON.stringify(name)}`);
    const outcome = await recordOne(scenario, options);
    outcomes.push(outcome);
    if (outcome.workspaceKept || failuresOf(outcome).some((failure) => failure instanceof OpencodeModelChoiceError || failure instanceof RecordingNotWrittenError)) break;
  }
  return outcomes;
}
