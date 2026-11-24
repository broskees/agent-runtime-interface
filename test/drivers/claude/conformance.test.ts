// The Claude driver passes the conformance suite against the fake Claude
// Agent SDK, whose every message and callback is typed by the pinned SDK.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { conformanceTests, formatReport } from "../../../src/conformance/index.ts";
import type { ConformanceReport } from "../../../src/conformance/index.ts";
import { claudeHarness } from "./harness.ts";

const harness = claudeHarness();
let report: ConformanceReport | undefined;
after(() => harness.cleanup());

conformanceTests(test, harness, {
  onReport: (finished) => {
    report = finished;
  },
});

test("every scenario passed, and the only checks not exercised are the three with the harness's stated reasons", () => {
  assert.ok(report !== undefined, "the conformance suite did not report");
  assert.equal(report.passed, true, formatReport(report));
  assert.deepEqual(
    report.results.map((result) => [result.id, result.status]),
    Array.from({ length: 15 }, (_, index) => [index + 1, "passed"]),
    formatReport(report),
  );
  const notes = report.results.flatMap((result) => result.notes).join("\n");
  assert.match(notes, /steer-after-end\.race/);
  assert.match(notes, /capability-honesty\.ext\.ari\.goal/);
  // Under full_access Claude Code calls canUseTool for nothing it auto-approves, so scenario 15 reports that branch not checked, with the harness's reason, rather than a reply nobody sent.
  const idempotent = report.results.find((result) => result.key === "idempotent-responses")!;
  assert.match(idempotent.notes.join("\n"), /not checked \(idempotent-responses\.full-access\): under full_access the driver runs Claude Code in bypassPermissions/);
  assert.doesNotMatch(idempotent.notes.join("\n"), /answered the full_access approval/);
});

test("the fake served every rig, and the driver ran its turns through queries in each", () => {
  assert.ok(harness.worlds.length >= 15, `only ${harness.worlds.length} rigs ran`);
  for (const world of harness.worlds) {
    if (world.prompts().length > 0) assert.ok(world.queries.length > 0);
  }
  assert.ok(harness.worlds.filter((world) => world.prompts().length > 0).length >= 13, "fewer than 13 rigs ran a turn");
});
