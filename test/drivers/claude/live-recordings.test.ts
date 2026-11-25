// The committed live Claude recordings: what the real Claude Code did when a
// person ran `ARI_LIVE_RECORD=1 node scripts/record-claude.ts`. The directory
// holds exactly one recording per scenario of the scenario module, each made
// live by the Claude Code the pinned Agent SDK bundles, and each replays
// through a fresh driver with every scenario assertion passing. The expected
// files come from the scenario module, so a missing recording fails here.
// docs/recordings.md says how to record them again.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { CLAUDE_TESTED_CLAUDE_CODE_VERSION } from "../../../src/meta/claude.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { CLAUDE_SDK_NAME, CLAUDE_VENDOR_NAME } from "../../recordings/claude/record.ts";
import { replayClaude } from "../../recordings/claude/replay.ts";
import { readRecording } from "../../recordings/format.ts";
import { SCENARIO_NAMES } from "../../recordings/scenarios.ts";

const RECORDINGS = path.join(REPO_ROOT, "test", "drivers", "claude", "recordings");

/** The pinned Agent SDK's own version and the Claude Code version it bundles. */
function pinnedSdk(): { version: string; claudeCodeVersion: string } {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")) as { version: string; claudeCodeVersion: string };
}

test("test/drivers/claude/recordings/ holds exactly one recording per scenario, six in all", () => {
  assert.deepEqual(fs.readdirSync(RECORDINGS).sort(), SCENARIO_NAMES.map((name) => `${name}.ndjson`).sort());
});

for (const name of SCENARIO_NAMES) {
  test(`${name}: the live recording was made by the Claude Code the pinned Agent SDK runs, and replays through the driver with every scenario assertion passing`, async () => {
    const file = path.join(RECORDINGS, `${name}.ndjson`);
    // The loader checks the body against the header's sha256.
    const recording = await readRecording(file);
    const sdk = pinnedSdk();
    const { header } = recording;
    assert.equal(header.source, "live");
    assert.equal(header.driver, "claude");
    assert.equal(header.scenario, name);
    assert.equal(header.vendor, CLAUDE_VENDOR_NAME);
    assert.equal(header.vendorVersion, sdk.claudeCodeVersion, "the Claude Code version the pinned Agent SDK runs; record again after an SDK bump");
    assert.equal(header.vendorVersion, CLAUDE_TESTED_CLAUDE_CODE_VERSION);
    assert.equal(header.sdk, CLAUDE_SDK_NAME);
    assert.equal(header.sdkVersion, sdk.version);
    assert.match(header.model, /\S/, "the model used");
    // replayClaude fails on any drift from the recording and runs the scenario's checks.
    const { run } = await replayClaude(recording);
    assert.equal(run.scenario.name, name);
  });
}
