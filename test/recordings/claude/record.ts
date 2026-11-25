// The Claude recording function: scripts/record-claude.ts calls it with the
// real SDK, and the tests call it with the fake one. For each scenario it
// makes a fresh temp workspace (./run.ts), runs the scenario through a fresh
// driver over the tapped SDK, sanitises every frame, writes
// `<outDir>/<scenario>.ndjson`, and checks the scenario's assertions.
//
// The user's Claude setup stays out and unchanged. Claude Code gets its own
// CLAUDE_CONFIG_DIR and HOME inside the workspace, so it reads none of the
// user's settings, hooks, plugins, agents, MCP servers or CLAUDE.md. Its
// sign-in: the user's credential file (`.credentials.json` in the user's
// Claude config dir, `$CLAUDE_CONFIG_DIR` or `~/.claude`) is copied into the
// isolated dir, and when Claude Code rewrote the copy (a refreshed token) it
// goes back to the user's file, so a rotated token is never lost. When it
// cannot go back (the user's file changed meanwhile too, or the recorder
// cannot write it), it goes into this run's recovery file beside the user's
// file (../recovery.ts). Or, with ANTHROPIC_API_KEY set, the driver instance
// keeps that key as its own. The workspace is removed after every scenario,
// also after one that fails, unless it holds the only copy of a refreshed
// sign-in: then the recorder keeps it and stops.
//
// The SDK's session functions run in this process and read this process's
// CLAUDE_CONFIG_DIR (sdk.mjs 0.3.330 resolves the config dir from
// process.env.CLAUDE_CONFIG_DIR on every call), so it points at the isolated
// dir while a scenario runs.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Frame, RecordingSource } from "../format.ts";
import { writeRecording } from "../format.ts";
import { CredentialsKeptError, CredentialsNotSavedError, RecordingNotWrittenError, keepRefreshedCredentials, recoveryFileFor } from "../recovery.ts";
import { createSanitiser } from "../sanitiser.ts";
import { SCENARIOS, checkScenario } from "../scenarios.ts";
import type { Scenario, ScenarioName } from "../scenarios.ts";
import { claudeNativeAnswers } from "./frames.ts";
import { CLAUDE_PROTOCOL_WORDS } from "./protocol-words.ts";
import type { ClaudeRuntime } from "./frames.ts";
import { DEFAULT_RECORD_MODEL, createClaudeLayout, runClaudeScenario } from "./run.ts";
import type { ClaudeLayout } from "./run.ts";
import { tapClaudeSdk } from "./tap.ts";

export const CLAUDE_SDK_NAME = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_VENDOR_NAME = "claude-code";
export const CLAUDE_CREDENTIAL_FILE = ".credentials.json";

export interface RecordClaudeOptions {
  /** The scenarios to record, in order; all six when left out. */
  readonly scenarios?: readonly ScenarioName[];
  readonly outDir: string;
  readonly source: RecordingSource;
  /**
   * The recorder's environment: HOME and CLAUDE_CONFIG_DIR (where the user's
   * credential file is), PATH (handed to Claude Code), ARI_RECORD_CLAUDE_MODEL,
   * ANTHROPIC_API_KEY, and the values the sanitiser replaces.
   */
  readonly env: { readonly [name: string]: string | undefined };
  /** Loads the SDK for one scenario: the real SDK when live, a fake when testing. */
  readonly loadSdk: (scenario: Scenario, layout: ClaudeLayout) => Promise<ClaudeRuntime>;
  /** How long a scenario waits for any one thing. */
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
  /** The recording date; today when left out. */
  readonly date?: string;
  /** The OS user name the sanitiser replaces; os.userInfo().username when left out. */
  readonly user?: string;
}

export interface ClaudeRecordOutcome {
  readonly scenario: ScenarioName;
  /** The recording written, when the run reached the SDK at all and the write succeeded. */
  readonly file?: string;
  readonly frames: number;
  /**
   * Why the scenario failed: its run, its assertions, the credential
   * copy-back, the recording's write. With more than one failure, an
   * AggregateError whose message names each, in the order they happened.
   */
  readonly error?: Error;
  /** The temp workspace the scenario ran in; removed unless `workspaceKept`. */
  readonly workspace: string;
  /** The workspace still exists: its credential copy holds the only copy of a refreshed sign-in. The run stopped after this scenario. */
  readonly workspaceKept: boolean;
  /** The recovery file this scenario added a refreshed sign-in to, when it could not go back to the user's credential file. */
  readonly recoveryFile?: string;
}

/** Each failure of a scenario, in order. */
export function failuresOf(outcome: ClaudeRecordOutcome): readonly Error[] {
  if (outcome.error === undefined) return [];
  return outcome.error instanceof AggregateError ? (outcome.error.errors as Error[]) : [outcome.error];
}

/** The lines that end a run: how many scenarios passed, then every recovery file and every kept workspace, so none goes unseen. */
export function describeClaudeRun(outcomes: readonly ClaudeRecordOutcome[], outDir: string): string[] {
  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  const lines = [`${outcomes.length - failed.length} of ${outcomes.length} scenario(s) passed; recordings in ${outDir}`];
  for (const file of new Set(outcomes.flatMap((outcome) => (outcome.recoveryFile === undefined ? [] : [outcome.recoveryFile])))) {
    lines.push(`a refreshed Claude sign-in that could not go back to your credential file is in ${file}, readable only by you: write the newest value over your .credentials.json, or sign in again with \`claude auth login\``);
  }
  for (const outcome of outcomes.filter((each) => each.workspaceKept)) {
    lines.push(`the run stopped after ${outcome.scenario} and kept its workspace ${outcome.workspace}: its claude-config/${CLAUDE_CREDENTIAL_FILE} holds the only copy of a refreshed sign-in`);
  }
  return lines;
}

/** The model the recorder asks for: ARI_RECORD_CLAUDE_MODEL, or Claude Code's `haiku` alias. */
export function recordModel(env: { readonly [name: string]: string | undefined }): string {
  const chosen = env["ARI_RECORD_CLAUDE_MODEL"]?.trim();
  return chosen === undefined || chosen === "" ? DEFAULT_RECORD_MODEL : chosen;
}

/** The user's Claude credential file, as Claude Code finds it: in $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function userCredentialFile(env: { readonly [name: string]: string | undefined }): string | undefined {
  const configured = env["CLAUDE_CONFIG_DIR"]?.trim();
  if (configured !== undefined && configured !== "") return path.join(configured, CLAUDE_CREDENTIAL_FILE);
  const home = env["HOME"]?.trim();
  return home === undefined || home === "" ? undefined : path.join(home, ".claude", CLAUDE_CREDENTIAL_FILE);
}

interface CopiedCredential {
  readonly real: string;
  readonly copy: string;
  readonly original: Buffer;
}

function copyCredential(env: RecordClaudeOptions["env"], layout: ClaudeLayout): CopiedCredential | undefined {
  const real = userCredentialFile(env);
  if (real === undefined || !fs.existsSync(real)) return undefined;
  const original = fs.readFileSync(real);
  const copy = path.join(layout.configDir, CLAUDE_CREDENTIAL_FILE);
  fs.writeFileSync(copy, original, { mode: 0o600 });
  return { real, copy, original };
}

/**
 * Puts a credential Claude Code rewrote back where the user keeps it. When it
 * cannot go back (the user's file also changed while the recorder ran, or the
 * recorder cannot write it), the refreshed content is added to the recovery
 * file beside the user's file (`recoveryFileFor`), and this throws a
 * CredentialsKeptError naming it. When even that file cannot take it, this
 * throws a CredentialsNotSavedError: the copy is then the only place the
 * refreshed sign-in is, and the caller must keep it. Any other error leaves
 * the caller unsure whether the copy changed, so it must keep the copy too.
 */
function returnCredential(credential: CopiedCredential): void {
  if (!fs.existsSync(credential.copy)) return;
  const now = fs.readFileSync(credential.copy);
  if (now.equals(credential.original)) return;
  const recoveryFile = recoveryFileFor(credential.real);
  /** Keeps the refreshed content in the recovery file, or throws CredentialsNotSavedError saying why it could not. */
  const keep = (why: string): never => {
    try {
      keepRefreshedCredentials(recoveryFile, [{ id: CLAUDE_CREDENTIAL_FILE, value: now.toString("utf8") }]);
    } catch (error) {
      throw new CredentialsNotSavedError(
        `${why}, and the recorder could not keep the refreshed sign-in in ${recoveryFile} either (${error instanceof Error ? error.message : String(error)}). The refreshed sign-in is only in the recorder's copy, ${credential.copy}.`,
        credential.copy,
        recoveryFile,
      );
    }
    throw new CredentialsKeptError(`${why}; it kept the refreshed sign-in in ${recoveryFile}, readable only by you. Write its newest value over ${credential.real}, or sign in again.`, recoveryFile);
  };
  let current: Buffer | undefined;
  const staged = `${credential.real}.ari-recorder-${process.pid}`;
  try {
    current = fs.existsSync(credential.real) ? fs.readFileSync(credential.real) : undefined;
    if (current === undefined || current.equals(credential.original)) {
      const mode = current === undefined ? 0o600 : fs.statSync(credential.real).mode & 0o777;
      fs.writeFileSync(staged, now, { mode });
      fs.renameSync(staged, credential.real);
      return;
    }
  } catch (error) {
    fs.rmSync(staged, { force: true });
    keep(`the recorder could not write the sign-in Claude Code refreshed back to ${credential.real} (${error instanceof Error ? error.message : String(error)})`);
  }
  keep(`${credential.real} changed while the recorder ran, and Claude Code also refreshed the recorder's copy; the recorder left ${credential.real} as it is`);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The Claude Code version the init message names, else the one the SDK package bundles. */
function vendorVersion(frames: readonly Frame[], runtime: ClaudeRuntime): string {
  for (const frame of frames) {
    if (frame.kind !== "message") continue;
    const message = frame["message"] as { type?: unknown; subtype?: unknown; claude_code_version?: unknown };
    if (message.type === "system" && message.subtype === "init" && typeof message.claude_code_version === "string") return message.claude_code_version;
  }
  return runtime.claudeCodeVersion ?? "unknown";
}

async function recordOne(scenario: Scenario, options: RecordClaudeOptions): Promise<ClaudeRecordOutcome> {
  const log = options.log ?? (() => undefined);
  const layout = createClaudeLayout(`ari-claude-record-${scenario.name}-`);
  const frames: Frame[] = [];
  const apiKey = options.env["ANTHROPIC_API_KEY"]?.trim() === "" ? undefined : options.env["ANTHROPIC_API_KEY"]?.trim();
  const model = recordModel(options.env);
  const previousConfigDir = process.env["CLAUDE_CONFIG_DIR"];
  let credential: CopiedCredential | undefined;
  let runtime: ClaudeRuntime | undefined;
  const errors: Error[] = [];
  const failed = (reason: unknown): void => {
    errors.push(reason instanceof Error ? reason : new Error(String(reason)));
  };
  let recoveryFile: string | undefined;
  let workspaceKept = false;
  try {
    credential = copyCredential(options.env, layout);
    if (options.source === "live" && credential === undefined && apiKey === undefined) {
      throw new Error(`no Claude sign-in found: neither ${userCredentialFile(options.env) ?? "~/.claude/.credentials.json"} nor ANTHROPIC_API_KEY. Run \`claude auth login\`, or set ANTHROPIC_API_KEY.`);
    }
    process.env["CLAUDE_CONFIG_DIR"] = layout.configDir;
    runtime = await options.loadSdk(scenario, layout);
    const tap = tapClaudeSdk(runtime.sdk, (frame) => frames.push(frame));
    let run;
    try {
      ({ run } = await runClaudeScenario({
        scenario,
        runtime: { ...runtime, sdk: tap.sdk },
        layout,
        sourceEnv: options.env,
        model,
        ...(apiKey === undefined ? {} : { apiKey }),
        timeoutMs: options.timeoutMs ?? 300_000,
      }));
    } finally {
      if (!(await tap.settled(10_000))) failed(new Error(`a query of scenario ${scenario.name} was still streaming 10 s after the driver closed it`));
    }
    checkScenario(run, claudeNativeAnswers(frames));
  } catch (reason) {
    failed(reason);
  } finally {
    if (previousConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = previousConfigDir;
    if (credential !== undefined) {
      try {
        returnCredential(credential);
      } catch (reason) {
        failed(reason);
        // Kept in the recovery file: the copy can go. Anything else: the copy may hold the only refreshed sign-in.
        if (reason instanceof CredentialsKeptError) recoveryFile = reason.recoveryFile;
        else {
          workspaceKept = true;
          failed(new Error(`the recorder kept the workspace ${layout.root}, with its copy of your Claude credential file, ${credential.copy}, and stopped. Write that copy over ${credential.real}, then delete the workspace.`));
        }
      }
    }
    if (!workspaceKept) fs.rmSync(layout.root, { recursive: true, force: true });
  }
  let file: string | undefined;
  if (frames.length > 0 && runtime !== undefined) {
    const target = path.join(options.outDir, `${scenario.name}.ndjson`);
    // A failed write joins the scenario's other failures, so none of them, nor where a refreshed sign-in went, is lost with it.
    try {
      const sanitise = createSanitiser({ workspace: layout.root, env: options.env, protocolWords: CLAUDE_PROTOCOL_WORDS, ...(options.user === undefined ? {} : { user: options.user }) });
      await writeRecording(
        target,
        {
          driver: "claude",
          vendor: CLAUDE_VENDOR_NAME,
          vendorVersion: vendorVersion(frames, runtime),
          sdk: CLAUDE_SDK_NAME,
          sdkVersion: runtime.version ?? "unknown",
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
 * but two failures stop them all: a refreshed sign-in the recorder could keep
 * nowhere but in the workspace, and a recording it could not write.
 */
export async function recordClaude(options: RecordClaudeOptions): Promise<ClaudeRecordOutcome[]> {
  const names = options.scenarios ?? SCENARIOS.map((scenario) => scenario.name);
  const outcomes: ClaudeRecordOutcome[] = [];
  for (const name of names) {
    const scenario = SCENARIOS.find((candidate) => candidate.name === name);
    if (scenario === undefined) throw new Error(`no scenario is named ${JSON.stringify(name)}`);
    const outcome = await recordOne(scenario, options);
    outcomes.push(outcome);
    if (outcome.workspaceKept || failuresOf(outcome).some((failure) => failure instanceof RecordingNotWrittenError)) break;
  }
  return outcomes;
}
