// Replays one Claude recording: the recording's scenario runs through a fresh
// driver from `createClaudeDriver({ loadSdk })` over the replay SDK, in a
// fresh temp workspace laid out as the recorder lays it out (./run.ts). When
// the scenario ends, the sequencer must have matched every recorded outbound
// frame and the driver must have taken every recorded inbound frame, and the
// scenario's assertions must hold.

import * as fs from "node:fs";
import type { DiagnosticEntry } from "../../../src/generated/host.ts";
import type { Session } from "../../../src/runtime.ts";
import type { Recording } from "../format.ts";
import { readRecording } from "../format.ts";
import { createSanitiser } from "../sanitiser.ts";
import { ScenarioStallError, checkScenario, scenarioNamed } from "../scenarios.ts";
import type { ScenarioRun } from "../scenarios.ts";
import type { ReplaySequencer } from "../sequencer.ts";
import { claudeNativeAnswers } from "./frames.ts";
import { CLAUDE_PROTOCOL_WORDS } from "./protocol-words.ts";
import { createClaudeReplaySdk } from "./replay-sdk.ts";
import type { ClaudeReplay } from "./replay-sdk.ts";
import { CLAUDE_STAND_IN_PATH, createClaudeLayout, runClaudeScenario } from "./run.ts";

export interface ClaudeReplayResult {
  readonly run: ScenarioRun;
  readonly replay: ClaudeReplay;
  /** What the driver logged to the host's diagnostics. */
  readonly diagnostics: readonly DiagnosticEntry[];
}

export interface ClaudeReplayOptions {
  /** How long the scenario waits for any one thing; 30 s by default. */
  readonly timeoutMs?: number;
  /** After the scenario, how long replay waits with no frame taken before it calls a delivered frame never taken; 500 ms by default. */
  readonly idleMs?: number;
  /** The replay's environment (HOME, PATH, USER, LOGNAME); process.env by default. */
  readonly env?: { readonly [name: string]: string | undefined };
  /** The OS user name; os.userInfo().username by default. */
  readonly user?: string;
  /** Wraps each session the replay's host opens, given the replay's sequencer; tests use it to play a host that behaves differently. */
  readonly wrapSession?: (session: Session, sequencer: ReplaySequencer) => Session;
}

export async function replayClaude(source: Recording | string, options: ClaudeReplayOptions = {}): Promise<ClaudeReplayResult> {
  const recording = typeof source === "string" ? await readRecording(source) : source;
  const header = recording.header;
  if (header.driver !== "claude") throw new Error(`${recording.file}: the recording is of driver ${header.driver}, not claude`);
  const scenario = scenarioNamed(header.scenario);
  const layout = createClaudeLayout(`ari-claude-replay-${scenario.name}-`);
  try {
    const env = options.env ?? process.env;
    const replay = createClaudeReplaySdk(recording, { workspace: layout.root, sanitise: createSanitiser({ workspace: layout.root, env, protocolWords: CLAUDE_PROTOCOL_WORDS, ...(options.user === undefined ? {} : { user: options.user }) }) });
    const wrapSession = options.wrapSession;
    const sequencer = replay.sequencer;
    let result: { run: ScenarioRun; diagnostics: readonly DiagnosticEntry[] };
    try {
      result = await runClaudeScenario({
        scenario,
        runtime: { sdk: replay.sdk, version: header.sdkVersion, claudeCodeVersion: header.vendorVersion },
        // The Claude Code the recording ran; the driver needs one to open a session, and nothing runs it.
        claudeCode: { path: CLAUDE_STAND_IN_PATH, version: header.vendorVersion },
        layout,
        sourceEnv: env,
        model: header.model,
        timeoutMs: options.timeoutMs ?? 30_000,
        native: replay.progress,
        ...(wrapSession === undefined ? {} : { wrapSession: (session: Session) => wrapSession(session, sequencer) }),
      });
    } catch (error) {
      // A stall happened while nothing had drifted: what the cleanup after it sent is not the cause.
      if (error instanceof ScenarioStallError) throw error;
      // Otherwise a drift explains a failed run better than whatever the driver made of it.
      throw replay.sequencer.failure ?? error;
    }
    // The driver may still be taking the last frames (the end of a closed stream); wait until it has taken all, or stops taking.
    await replay.sequencer.whenTaken(options.idleMs ?? 500);
    replay.sequencer.finish();
    checkScenario(result.run, claudeNativeAnswers(replay.sequencer.matchedOutbound()));
    return { run: result.run, replay, diagnostics: result.diagnostics };
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
}
