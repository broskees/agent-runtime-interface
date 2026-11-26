// Checks every recording the ACP suites made in this process against ACP's
// own schema: the conformance runs, every rig (the protocol, rules and flavor
// suites) and the standalone runs. `acp-drivers.test.ts` imports this file
// last, so its test runs after every test that records frames.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFrames } from "./frames.ts";
import { ACP_RECORDINGS } from "./harness.ts";

/**
 * How many recordings each test file makes: one per harness or rig, and one
 * per standalone run. A test that adds or removes a recording changes its
 * file's count here, so no recording can bypass the check unnoticed.
 */
const EXPECTED_RECORDINGS: { readonly [source: string]: number } = {
  "test/drivers/acp-registry/registry.suite.ts": 6,
  // One harness per conformance run, shared by its 15 scenarios: the base over v1 and over v2, and the five flavors.
  "test/drivers/acp/conformance-suite.ts": 7,
  // Per driver: the optional members, the missing agent, the status (2 for a release range, 1 for the protocol range),
  // for a release range a CLI below the minimum and the real --version output (1 each), the protocol advisory, resume
  // instructions (2), no driver text, host instructions (2). Four release-range drivers and two protocol-range ones: 4 × 12 + 2 × 9.
  "test/drivers/acp/driver-rules.ts": 66,
  "test/drivers/acp/protocol.suite.ts": 23,
  "test/drivers/acp/standalone.suite.ts": 4,
  "test/drivers/antigravity/antigravity.suite.ts": 7,
  "test/drivers/fx/fx.suite.ts": 1,
  "test/drivers/grok/grok.suite.ts": 1,
  "test/drivers/kiro/kiro.suite.ts": 1,
};

test("every frame of every recording the ACP suites made matches ACP's schema, and every recording was checked", () => {
  const problems: string[] = [];
  const recordingsBySource: { [source: string]: number } = {};
  const seenBySource = new Map<string, Set<string>>();
  let checkedRecordings = 0;
  let checkedFrames = 0;
  for (const recording of ACP_RECORDINGS) {
    const result = checkFrames(recording.frames);
    checkedRecordings += 1;
    checkedFrames += result.checked + result.extension;
    recordingsBySource[recording.source] = (recordingsBySource[recording.source] ?? 0) + 1;
    for (const problem of result.problems) problems.push(`${recording.source} (${recording.name}): ${problem}`);
    const seen = seenBySource.get(recording.source) ?? new Set<string>();
    for (const entry of result.seenByVersion) seen.add(entry);
    seenBySource.set(recording.source, seen);
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(
    Object.fromEntries(Object.entries(recordingsBySource).sort(([a], [b]) => a.localeCompare(b))),
    EXPECTED_RECORDINGS,
    `recordings by test file (${checkedRecordings} recordings, ${checkedFrames} frames checked)`,
  );
  // The protocol suite's own exchanges are among the checked frames: v1 chosen when v2 was asked for, both fork exchanges, v2 upserts.
  const protocol = seenBySource.get("test/drivers/acp/protocol.suite.ts") ?? new Set<string>();
  for (const expected of [
    "v2 client initialize Request",
    "v1 agent initialize Response",
    "v1 client session/fork Request",
    "v1 agent session/fork Response",
    "v2 client session/fork Request",
    "v2 agent session/fork Response",
    "v2 agent session/update Notification",
    "v2 client session/resume Request",
    "v2 agent session/resume Response",
  ]) {
    assert.ok(protocol.has(expected), `protocol.suite.ts: no ${expected} frame was checked`);
  }
});
