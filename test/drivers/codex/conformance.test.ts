// The Codex driver passes the conformance suite against the fake Codex CLI,
// and neither side sent a frame the vendored app-server schema rejects.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { conformanceTests, formatReport } from "../../../src/conformance/index.ts";
import type { ConformanceReport } from "../../../src/conformance/index.ts";
import { codexHarness } from "./harness.ts";

const harness = codexHarness();
let report: ConformanceReport | undefined;
after(() => harness.cleanup());

conformanceTests(test, harness, {
  onReport: (finished) => {
    report = finished;
  },
});

test("every applicable scenario passed, and the only one not exercised has the harness's stated reason", () => {
  assert.ok(report !== undefined, "the conformance suite did not report");
  assert.equal(report.passed, true, formatReport(report));
  assert.deepEqual(
    report.results.map((result) => [result.id, result.status]),
    Array.from({ length: 15 }, (_, index) => [index + 1, "passed"]),
    formatReport(report),
  );
  const honesty = report.results.find((result) => result.key === "capability-honesty")!;
  assert.match(honesty.notes.join("\n"), /left out: none; not exercised: ext codex\.review/);
  // Under full_access Codex sends no approval, so scenario 15 reports that branch not checked, with the harness's reason, rather than a reply nobody sent.
  const idempotent = report.results.find((result) => result.key === "idempotent-responses")!;
  assert.match(idempotent.notes.join("\n"), /not checked \(idempotent-responses\.full-access\): under full_access the driver runs Codex with approval policy never/);
  assert.doesNotMatch(idempotent.notes.join("\n"), /answered the full_access approval/);
});

test("every frame the fake app-server and the driver exchanged validates against the vendored Codex schema", () => {
  const checked = harness.worlds.reduce((sum, world) => sum + world.validator.checked, 0);
  const problems = harness.worlds.flatMap((world) => world.validator.problems);
  assert.ok(checked > 1000, `only ${checked} frames were checked`);
  assert.deepEqual(
    problems.map((problem) => `${problem.direction}: ${problem.message}`),
    [],
  );
});
