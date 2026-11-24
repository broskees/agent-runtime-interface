// The Muse driver passes the conformance suite against the fake `muse serve`,
// through the real @muse-code/sdk Connection; frames.ts type-checks every
// frame either side sent against the SDK's wire types when this file ends.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { conformanceTests, formatReport } from "../../../src/conformance/index.ts";
import type { ConformanceReport } from "../../../src/conformance/index.ts";
import { FRAME_LOG } from "./frames.ts";
import { museHarness } from "./harness.ts";

const harness = museHarness();
let report: ConformanceReport | undefined;
after(() => harness.cleanup());

conformanceTests(test, harness, {
  onReport: (finished) => {
    report = finished;
  },
});

test("every applicable scenario passed, and the one check not exercised has the harness's stated reason", () => {
  assert.ok(report !== undefined, "the conformance suite did not report");
  assert.equal(report.passed, true, formatReport(report));
  assert.deepEqual(
    report.results.map((result) => [result.id, result.status]),
    Array.from({ length: 15 }, (_, index) => [index + 1, "passed"]),
    formatReport(report),
  );
  const auth = report.results.find((result) => result.key === "auth-states")!;
  assert.match(auth.notes.join("\n"), /not checked \(auth-states\.unavailable\): the driver runs no sign-in check/);
  const honesty = report.results.find((result) => result.key === "capability-honesty")!;
  assert.match(honesty.notes.join("\n"), /not exercised: none/);
});

test("the fake hosts exchanged frames with the driver in every scenario", () => {
  assert.ok(harness.worlds.length >= 15, `only ${harness.worlds.length} rigs ran`);
  assert.ok(FRAME_LOG.frames.length > 500, `only ${FRAME_LOG.frames.length} frames were recorded`);
  assert.ok(FRAME_LOG.frames.some((frame) => frame.direction === "client" && frame.method === "turn/steer"));
  assert.ok(FRAME_LOG.frames.some((frame) => frame.direction === "client" && frame.method === "approval/decide"));
});
