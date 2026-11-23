// The kit drives a driver whose native agent is a separate process: the
// reference agent runs as a real Node child process, reached over its stdin
// and stdout, with real session files and a real symbolic link. All 15
// scenarios pass, through the `node:test` adapter.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { conformanceTests } from "../../src/conformance/index.ts";
import type { ConformanceReport } from "../../src/conformance/index.ts";
import { childProcessHarness } from "./child-process-harness.ts";

const harness = childProcessHarness();
after(() => harness.cleanup());

let report: ConformanceReport | undefined;
conformanceTests(test, harness, {
  onReport: (result) => {
    report = result;
  },
});

test("every scenario passes with the agent in a child process", () => {
  assert.ok(report !== undefined, "the conformance suite did not run");
  assert.deepEqual(
    report.results.map((result) => [result.id, result.status, result.reason ?? ""]),
    report.results.map((result) => [result.id, "passed", ""]),
  );
  assert.equal(report.results.length, 15);
  const symlink = report.results.find((result) => result.key === "symlinked-workspace")!;
  assert.match(symlink.notes.join("\n"), /between \/.*\/project and \/.*\/link-to-project/);
});
