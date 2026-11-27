// Replays one Codex recording: the recording's scenario runs through a fresh
// driver from `codexDriver`, whose `codex` processes are the replay process
// service's (../stdio/replay-process.ts), in a fresh temp workspace laid out
// as the recorder lays it out (./run.ts), with the model the header names.
// When the scenario ends, the sequencer must have matched every recorded
// outbound frame, the driver must have taken every recorded inbound frame,
// and the scenario's assertions must hold. A failed assertion names the
// recording file, the recorded frame the outcome depended on, and the frame
// replayed last (ReplaySequencer.checkFailed): the last frame naming an item
// the check looked at, else the `turn/completed` that ended each turn it
// looked at.

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
import { codexNativeAnswers, codexTurnsDependedOn } from "./frames.ts";
import { readPreAdmissionCodexCapture } from "./pre-admission.ts";
import { CODEX_PROTOCOL_WORDS } from "./protocol-words.ts";
import { CODEX_RECORDER_ENV_POLICY, createCodexLayout, runCodexScenario } from "./run.ts";

export interface CodexReplayResult {
  readonly run: ScenarioRun;
  readonly replay: StdioReplay;
  /** What the driver logged to the host's diagnostics. */
  readonly diagnostics: readonly DiagnosticEntry[];
}

export interface CodexReplayOptions {
  /** Only for the six pinned live captures made before session admission probed the CLI. Requires a file path. */
  readonly preAdmissionLiveCapture?: true;
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
export function replayedNativeAnswers(recording: Recording, sequencer: ReplaySequencer): ReturnType<typeof codexNativeAnswers> {
  const matched = new Set<Frame>(sequencer.matchedOutbound());
  const kept = recording.frames.filter((entry) => entry.frame.dir === "in" || matched.has(entry.frame));
  return codexNativeAnswers(
    kept.map((entry) => entry.frame),
    kept.map((entry) => entry.line),
  );
}

export async function replayCodex(source: Recording | string, options: CodexReplayOptions = {}): Promise<CodexReplayResult> {
  if (options.preAdmissionLiveCapture && typeof source !== "string") throw new Error("pre-admission replay requires a recording file for checksum validation");
  const legacy = options.preAdmissionLiveCapture && typeof source === "string" ? await readPreAdmissionCodexCapture(source) : undefined;
  const recording = legacy?.recording ?? (typeof source === "string" ? await readRecording(source) : source);
  const header = recording.header;
  if (header.driver !== "codex") throw new Error(`${recording.file}: the recording is of driver ${header.driver}, not codex`);
  const scenario = scenarioNamed(header.scenario);
  const layout = createCodexLayout(`ari-codex-replay-${scenario.name}-`);
  try {
    const env = options.env ?? process.env;
    const transport = {
      workspace: layout.root,
      sanitise: createSanitiser({ workspace: layout.root, env, protocolWords: CODEX_PROTOCOL_WORDS, ...(options.user === undefined ? {} : { user: options.user }) }),
      ignored: REPLAY_IGNORED_FIELDS,
      envPolicy: CODEX_RECORDER_ENV_POLICY,
    };
    const replay = legacy === undefined ? startStdioReplay(recording, transport) : legacy.startReplay(transport);
    const wrapSession = options.wrapSession;
    let result: { run: ScenarioRun; diagnostics: readonly DiagnosticEntry[] };
    try {
      result = await runCodexScenario({
        scenario,
        layout,
        process: replay.process,
        model: header.model,
        timeoutMs: options.timeoutMs ?? 30_000,
        native: replay.progress,
        ...(wrapSession === undefined ? {} : { wrapSession: (session: Session) => wrapSession(session, replay.sequencer) }),
      });
    } catch (error) {
      // A stall happened while nothing had drifted: what the cleanup after it sent is not the cause.
      if (error instanceof ScenarioStallError) throw error;
      // Otherwise a drift explains a failed run better than whatever the driver made of it.
      throw replay.progress.failure() ?? error;
    }
    await replay.sequencer.whenTaken(options.idleMs ?? 500);
    const failure = replay.progress.failure();
    if (failure !== undefined) throw failure;
    replay.sequencer.finish();
    try {
      checkScenario(result.run, replayedNativeAnswers(recording, replay.sequencer));
    } catch (error) {
      // Every recorded frame was replayed, yet the outcome is wrong: the error names the recorded frames the outcome depended on.
      // An item's last frame when the check looked at an item the recording names; else the frames of the turns it looked at.
      // A failure the checks did not attribute is about every turn.
      const subject = error instanceof ScenarioCheckError ? error : { turns: scenario.prompts.map((_prompt, index) => index), items: [] };
      const nativeIds = subject.items.flatMap((item) => (typeof item.native?.id === "string" ? [item.native.id] : []));
      const named = replay.sequencer.lastFrameNaming(nativeIds);
      throw replay.sequencer.checkFailed(error, named === undefined ? codexTurnsDependedOn(recording, subject.turns) : [named]);
    }
    return { run: result.run, replay, diagnostics: result.diagnostics };
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
}
