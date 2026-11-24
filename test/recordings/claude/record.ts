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
// goes back to the user's file, so a rotated token is never lost. Or, with
// ANTHROPIC_API_KEY set, the driver instance keeps that key as its own. The
// workspace is removed after every scenario, also after one that fails.
//
// The SDK's session functions run in this process and read this process's
// CLAUDE_CONFIG_DIR (sdk.mjs 0.3.330 resolves the config dir from
// process.env.CLAUDE_CONFIG_DIR on every call), so it points at the isolated
// dir while a scenario runs.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Frame, RecordingSource } from "../format.ts";
import { writeRecording } from "../format.ts";
import { createSanitiser } from "../sanitiser.ts";
import { SCENARIOS, checkScenario } from "../scenarios.ts";
import type { Scenario, ScenarioName } from "../scenarios.ts";
import { claudeNativeAnswers } from "./frames.ts";
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
}

export interface ClaudeRecordOutcome {
  readonly scenario: ScenarioName;
  /** The recording written, when the run reached the SDK at all. */
  readonly file?: string;
  readonly frames: number;
  /** Why the scenario failed: its run, its assertions, or the credential copy-back. */
  readonly error?: Error;
  /** The temp workspace the scenario ran in; it no longer exists. */
  readonly workspace: string;
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

/** Puts a credential Claude Code rewrote back where the user keeps it. Throws when the user's file changed meanwhile too. */
function returnCredential(credential: CopiedCredential): void {
  if (!fs.existsSync(credential.copy)) return;
  const now = fs.readFileSync(credential.copy);
  if (now.equals(credential.original)) return;
  const current = fs.existsSync(credential.real) ? fs.readFileSync(credential.real) : undefined;
  if (current !== undefined && !current.equals(credential.original)) {
    throw new Error(`${credential.real} changed while the recorder ran, and Claude Code also refreshed the recorder's copy; the recorder left ${credential.real} as it is. Sign in again if Claude Code reports the sign-in as expired.`);
  }
  const mode = current === undefined ? 0o600 : fs.statSync(credential.real).mode & 0o777;
  const staged = `${credential.real}.ari-recorder-${process.pid}`;
  fs.writeFileSync(staged, now, { mode });
  fs.renameSync(staged, credential.real);
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
  let error: Error | undefined;
  const failed = (reason: unknown): void => {
    error ??= reason instanceof Error ? reason : new Error(String(reason));
  };
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
      run = await runClaudeScenario({
        scenario,
        runtime: { ...runtime, sdk: tap.sdk },
        layout,
        sourceEnv: options.env,
        model,
        ...(apiKey === undefined ? {} : { apiKey }),
        timeoutMs: options.timeoutMs ?? 300_000,
      });
    } finally {
      if (!(await tap.settled(10_000))) failed(new Error(`a query of scenario ${scenario.name} was still streaming 10 s after the driver closed it`));
    }
    checkScenario(run, claudeNativeAnswers(frames));
  } catch (reason) {
    failed(reason);
  } finally {
    if (previousConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = previousConfigDir;
    try {
      if (credential !== undefined) returnCredential(credential);
    } catch (reason) {
      failed(reason);
    }
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
  let file: string | undefined;
  if (frames.length > 0 && runtime !== undefined) {
    const sanitise = createSanitiser({ workspace: layout.root, env: options.env });
    file = path.join(options.outDir, `${scenario.name}.ndjson`);
    await writeRecording(
      file,
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
  }
  log(`${scenario.name}: ${error === undefined ? "passed" : `FAILED: ${error.message}`}${file === undefined ? ", nothing recorded" : `, ${frames.length} frames in ${file}`}`);
  return { scenario: scenario.name, frames: frames.length, workspace: layout.root, ...(file === undefined ? {} : { file }), ...(error === undefined ? {} : { error }) };
}

/** Records each scenario in turn. A failed scenario does not stop the others; its outcome carries the error. */
export async function recordClaude(options: RecordClaudeOptions): Promise<ClaudeRecordOutcome[]> {
  const names = options.scenarios ?? SCENARIOS.map((scenario) => scenario.name);
  const outcomes: ClaudeRecordOutcome[] = [];
  for (const name of names) {
    const scenario = SCENARIOS.find((candidate) => candidate.name === name);
    if (scenario === undefined) throw new Error(`no scenario is named ${JSON.stringify(name)}`);
    outcomes.push(await recordOne(scenario, options));
  }
  return outcomes;
}
