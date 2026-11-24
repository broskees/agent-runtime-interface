// Replays one OpenCode recording: the recording's scenario runs through a
// fresh driver from `createOpencodeDriver()`, in external-server mode, against
// the replay server (./replay-server.ts), in a fresh temp workspace laid out
// as the recorder lays it out (./run.ts). When the scenario ends, the
// sequencer must have matched every recorded outbound frame, the driver
// must have taken every recorded inbound frame, and the scenario's
// assertions must hold.

import * as fs from "node:fs";
import type { DiagnosticEntry } from "../../../src/generated/host.ts";
import type { Recording } from "../format.ts";
import { readRecording } from "../format.ts";
import { createSanitiser } from "../sanitiser.ts";
import { ScenarioStallError, checkScenario, scenarioNamed } from "../scenarios.ts";
import type { ScenarioRun } from "../scenarios.ts";
import { opencodeNativeAnswers } from "./frames.ts";
import { OPENCODE_PROTOCOL_WORDS } from "./protocol-words.ts";
import { startOpencodeReplayServer } from "./replay-server.ts";
import type { OpencodeReplay } from "./replay-server.ts";
import { createOpencodeLayout, runOpencodeScenario } from "./run.ts";

/** The server password the replay's driver instance holds. The replay server asks for none; the recording holds no headers. */
export const REPLAY_SERVER_PASSWORD = "ari-replay";

export interface OpencodeReplayResult {
  readonly run: ScenarioRun;
  readonly replay: OpencodeReplay;
  /** What the driver logged to the host's diagnostics. */
  readonly diagnostics: readonly DiagnosticEntry[];
}

export interface OpencodeReplayOptions {
  /** How long the scenario waits for any one thing; 30 s by default. */
  readonly timeoutMs?: number;
  /** After the scenario, how long replay waits with no frame taken (or a stream still open) before it calls a frame never taken; 500 ms by default. */
  readonly idleMs?: number;
  /** The replay's environment (HOME, PATH, USER, LOGNAME); process.env by default. */
  readonly env?: { readonly [name: string]: string | undefined };
  /** The OS user name; os.userInfo().username by default. */
  readonly user?: string;
}

export async function replayOpencode(source: Recording | string, options: OpencodeReplayOptions = {}): Promise<OpencodeReplayResult> {
  const recording = typeof source === "string" ? await readRecording(source) : source;
  const header = recording.header;
  if (header.driver !== "opencode") throw new Error(`${recording.file}: the recording is of driver ${header.driver}, not opencode`);
  const scenario = scenarioNamed(header.scenario);
  const layout = createOpencodeLayout(`ari-opencode-replay-${scenario.name}-`);
  let replay: OpencodeReplay | undefined;
  try {
    const env = options.env ?? process.env;
    replay = await startOpencodeReplayServer(recording, { workspace: layout.root, sanitise: createSanitiser({ workspace: layout.root, env, protocolWords: OPENCODE_PROTOCOL_WORDS, ...(options.user === undefined ? {} : { user: options.user }) }) });
    let result: { run: ScenarioRun; diagnostics: readonly DiagnosticEntry[] };
    try {
      result = await runOpencodeScenario({ scenario, layout, transport: replay, password: REPLAY_SERVER_PASSWORD, model: header.model, timeoutMs: options.timeoutMs ?? 30_000, native: replay.progress });
    } catch (error) {
      // A stall happened while nothing had drifted: what the cleanup after it sent is not the cause.
      if (error instanceof ScenarioStallError) throw error;
      // Otherwise a drift explains a failed run better than whatever the driver made of it.
      throw replay.sequencer.failure ?? error;
    }
    const idleMs = options.idleMs ?? 500;
    // The driver closes its event stream as its session closes; then it may still be taking the last frames.
    await replay.whenStreamsClosed(idleMs);
    await replay.sequencer.whenTaken(idleMs);
    replay.sequencer.finish();
    checkScenario(result.run, opencodeNativeAnswers(replay.sequencer.matchedOutbound()));
    return { run: result.run, replay, diagnostics: result.diagnostics };
  } finally {
    await replay?.close();
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
}
