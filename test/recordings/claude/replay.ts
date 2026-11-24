// Replays one Claude recording: the recording's scenario runs through a fresh
// driver from `createClaudeDriver({ loadSdk })` over the replay SDK, in a
// fresh temp workspace laid out as the recorder lays it out (./run.ts). The
// sequencer must have replayed every recorded frame when the scenario ends,
// and the scenario's assertions must hold.

import * as fs from "node:fs";
import type { Recording } from "../format.ts";
import { readRecording } from "../format.ts";
import { createSanitiser } from "../sanitiser.ts";
import { ScenarioStallError, checkScenario, scenarioNamed } from "../scenarios.ts";
import type { ScenarioRun } from "../scenarios.ts";
import { claudeNativeAnswers } from "./frames.ts";
import { createClaudeReplaySdk } from "./replay-sdk.ts";
import type { ClaudeReplay } from "./replay-sdk.ts";
import { createClaudeLayout, runClaudeScenario } from "./run.ts";

/** Where the replay says its native binary is. The driver needs one to open a session; nothing runs it. */
export const REPLAY_CLAUDE_BINARY = "/ari-replay/claude";

export interface ClaudeReplayResult {
  readonly run: ScenarioRun;
  readonly replay: ClaudeReplay;
}

export async function replayClaude(source: Recording | string, options: { readonly timeoutMs?: number } = {}): Promise<ClaudeReplayResult> {
  const recording = typeof source === "string" ? await readRecording(source) : source;
  const header = recording.header;
  if (header.driver !== "claude") throw new Error(`${recording.file}: the recording is of driver ${header.driver}, not claude`);
  const scenario = scenarioNamed(header.scenario);
  const layout = createClaudeLayout(`ari-claude-replay-${scenario.name}-`);
  try {
    const replay = createClaudeReplaySdk(recording, { workspace: layout.root, sanitise: createSanitiser({ workspace: layout.root, env: process.env }) });
    let run: ScenarioRun;
    try {
      run = await runClaudeScenario({
        scenario,
        runtime: { sdk: replay.sdk, version: header.sdkVersion, claudeCodeVersion: header.vendorVersion, bundledExecutable: REPLAY_CLAUDE_BINARY },
        layout,
        sourceEnv: process.env,
        model: header.model,
        timeoutMs: options.timeoutMs ?? 30_000,
        native: replay.progress,
      });
    } catch (error) {
      // A stall happened while nothing had drifted: what the cleanup after it sent is not the cause.
      if (error instanceof ScenarioStallError) throw error;
      // Otherwise a drift explains a failed run better than whatever the driver made of it.
      throw replay.sequencer.failure ?? error;
    }
    replay.sequencer.finish();
    checkScenario(run, claudeNativeAnswers(replay.sequencer.matchedOutbound()));
    return { run, replay };
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
}
