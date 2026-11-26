// Replays one Antigravity recording: the recording's scenario runs through a
// fresh driver from `createAntigravityDriver()`, whose agent processes are the
// replay process service's (../stdio/replay-process.ts), in a fresh temp
// workspace laid out as the recorder lays it out (./run.ts), with the model the
// header names. When the scenario ends, the sequencer must have matched every
// recorded outbound frame, the driver must have taken every recorded inbound
// frame, and the scenario's assertions must hold. A failed assertion names the
// recording file, the frame replayed last, and the recorded frame the outcome
// depended on where one can be named (ReplaySequencer.checkFailed).

import * as fs from "node:fs";
import type { DiagnosticEntry } from "../../../src/generated/host.ts";
import type { Session } from "../../../src/runtime.ts";
import type { Frame, Recording } from "../format.ts";
import { readRecording } from "../format.ts";
import { REPLAY_IGNORED_FIELDS } from "../ignored-fields.ts";
import { createSanitiser } from "../sanitiser.ts";
import { ScenarioCheckError, ScenarioStallError, checkScenario, scenarioNamed } from "../scenarios.ts";
import type { ScenarioRun } from "../scenarios.ts";
import type { ReplaySequencer } from "../sequencer.ts";
import { startStdioReplay } from "../stdio/replay-process.ts";
import type { StdioReplay } from "../stdio/replay-process.ts";
import { acpNativeAnswers } from "../acp/frames.ts";
import { ACP_PROTOCOL_WORDS } from "../acp/protocol-words.ts";
import { ANTIGRAVITY_RECORDER_ENV_POLICY, createAntigravityLayout, fixedModelChooser, runAntigravityScenario } from "./run.ts";

export interface AntigravityReplayResult {
  readonly run: ScenarioRun;
  readonly replay: StdioReplay;
  /** What the driver logged to the host's diagnostics. */
  readonly diagnostics: readonly DiagnosticEntry[];
}

export interface AntigravityReplayOptions {
  /** How long the scenario waits for any one thing; 30 s by default. */
  readonly timeoutMs?: number;
  /** After the scenario, how long replay waits with no frame taken before it calls a frame never taken; 500 ms by default. */
  readonly idleMs?: number;
  /** The replay's environment (HOME, PATH, USER, LOGNAME); process.env by default. */
  readonly env?: { readonly [name: string]: string | undefined };
  /** The OS user name; os.userInfo().username by default. */
  readonly user?: string;
  /** Wraps each session the replay's host opens, given the replay's sequencer; tests use it to play a host that behaves differently. */
  readonly wrapSession?: (session: Session, sequencer: ReplaySequencer) => Session;
}

/** The approval answers a replay's driver sent: the recorded inbound frames, and the outbound ones it matched. */
export function replayedNativeAnswers(recording: Recording, sequencer: ReplaySequencer): ReturnType<typeof acpNativeAnswers> {
  const matched = new Set<Frame>(sequencer.matchedOutbound());
  const kept = recording.frames.filter((entry) => entry.frame.dir === "in" || matched.has(entry.frame));
  return acpNativeAnswers(
    kept.map((entry) => entry.frame),
    kept.map((entry) => entry.line),
  );
}

export async function replayAntigravity(source: Recording | string, options: AntigravityReplayOptions = {}): Promise<AntigravityReplayResult> {
  const recording = typeof source === "string" ? await readRecording(source) : source;
  const header = recording.header;
  if (header.driver !== "antigravity") throw new Error(`${recording.file}: the recording is of driver ${header.driver}, not antigravity`);
  const scenario = scenarioNamed(header.scenario);
  const layout = createAntigravityLayout(`ari-antigravity-replay-${scenario.name}-`);
  try {
    const env = options.env ?? process.env;
    const replay = startStdioReplay(recording, {
      workspace: layout.root,
      sanitise: createSanitiser({ workspace: layout.root, env, protocolWords: ACP_PROTOCOL_WORDS, ...(options.user === undefined ? {} : { user: options.user }) }),
      ignored: REPLAY_IGNORED_FIELDS,
      envPolicy: ANTIGRAVITY_RECORDER_ENV_POLICY,
    });
    const wrapSession = options.wrapSession;
    let result: { run: ScenarioRun; diagnostics: readonly DiagnosticEntry[] };
    try {
      result = await runAntigravityScenario({
        scenario,
        layout,
        process: replay.process,
        models: fixedModelChooser(header.model),
        timeoutMs: options.timeoutMs ?? 30_000,
        native: replay.progress,
        ...(wrapSession === undefined ? {} : { wrapSession: (session: Session) => wrapSession(session, replay.sequencer) }),
      });
    } catch (error) {
      // A stall happened while nothing had drifted: what the cleanup after it sent is not the cause.
      if (error instanceof ScenarioStallError) throw error;
      // Otherwise a drift explains a failed run better than whatever the driver made of it.
      throw replay.sequencer.failure ?? error;
    }
    await replay.sequencer.whenTaken(options.idleMs ?? 500);
    replay.sequencer.finish();
    try {
      checkScenario(result.run, replayedNativeAnswers(recording, replay.sequencer));
    } catch (error) {
      // Every recorded frame was replayed, yet the outcome is wrong: the error names the recorded frame the outcome depended on.
      const nativeIds = error instanceof ScenarioCheckError ? error.items.flatMap((item) => (typeof item.native?.id === "string" ? [item.native.id] : [])) : [];
      throw replay.sequencer.checkFailed(error, nativeIds);
    }
    return { run: result.run, replay, diagnostics: result.diagnostics };
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
}
