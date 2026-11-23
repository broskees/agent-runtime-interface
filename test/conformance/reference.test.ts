// The in-memory reference driver passes all 15 conformance scenarios, in both
// of its profiles and with either side answering full_access approvals. The
// minimal profile declares every optional feature off, so its "not
// applicable" results come from declared capabilities, with the reason shown.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { conformanceTests, formatReport, referenceHarness, runConformance } from "../../src/conformance/index.ts";

describe("the reference driver passes the conformance suite", () => {
  test("full profile, the driver answers full_access approvals: all 15 pass", async () => {
    const report = await runConformance(referenceHarness({ config: { profile: "full", fullAccessReplies: "driver" } }));
    assert.equal(report.passed, true, formatReport(report));
    assert.deepEqual(
      report.results.map((result) => [result.id, result.status]),
      Array.from({ length: 15 }, (_, index) => [index + 1, "passed"]),
      formatReport(report),
    );
    const honesty = report.results.find((result) => result.key === "capability-honesty")!;
    assert.match(honesty.notes.join("\n"), /left out: none; not exercised: none/);
    assert.match(report.results.find((result) => result.key === "idempotent-responses")!.notes.join("\n"), /the driver answered the full_access approval itself/);
  });

  test("full profile, the host answers full_access approvals: all 15 pass", async () => {
    const report = await runConformance(referenceHarness({ config: { fullAccessReplies: "host" } }));
    assert.equal(report.passed, true, formatReport(report));
    assert.ok(report.results.every((result) => result.status === "passed"), formatReport(report));
    assert.match(report.results.find((result) => result.key === "idempotent-responses")!.notes.join("\n"), /handed the full_access approval to the host, which auto-replied/);
  });

  test("minimal profile: every applicable scenario passes, and each not-applicable one names the declared capability", async () => {
    const report = await runConformance(referenceHarness({ config: { profile: "minimal" } }));
    assert.equal(report.passed, true, formatReport(report));
    const notApplicable = report.results.filter((result) => result.status === "not_applicable");
    assert.deepEqual(
      notApplicable.map((result) => [result.key, result.notApplicableBy, result.reason]),
      [
        ["steer-after-end", "capability", "the driver declares capability turns.steer off"],
        ["duplicate-always-options", "capability", "the driver declares capability approvals.command off"],
        ["auth-states", "capability", "the driver leaves out the optional member Instance.auth"],
        ["idempotent-responses", "capability", "the driver declares capability approvals.command off"],
      ],
    );
    const honesty = report.results.find((result) => result.key === "capability-honesty")!;
    assert.equal(honesty.status, "passed");
    assert.match(honesty.notes.join("\n"), /works: none; unsupported: startTurn steer, startTurn queue, stopSubagent, readSnapshot/);
    assert.match(honesty.notes.join("\n"), /left out: backgroundTasks\.list, backgroundTasks\.await, backgroundTasks\.stop, mcpApps\.listTools/);
  });
});

// The same suite through the node:test adapter: one subtest per scenario.
conformanceTests(test, referenceHarness());
