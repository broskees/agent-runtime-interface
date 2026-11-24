// Registers the conformance suite for one ACP driver (the base or a flavor)
// against the SDK-based fake agent, then checks what it recorded: every
// scenario that applies passed, and every frame between the driver and the
// agent matches ACP's schema for the version the connection negotiated.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { conformanceTests } from "../../../src/conformance/index.ts";
import type { ConformanceReport } from "../../../src/conformance/index.ts";
import { checkFrames } from "./frames.ts";
import { acpHarness } from "./harness.ts";
import type { AcpHarnessOptions } from "./harness.ts";

/** The scenarios an ACP driver's own declarations rule out: no steering, and no `Instance.auth` (agents sign in through their own CLI). */
export const NOT_APPLICABLE_BY_CAPABILITY = ["steer-after-end", "auth-states"];

export function acpConformance<Config>(options: AcpHarnessOptions<Config>): void {
  const harness = acpHarness(options);
  after(() => harness.cleanup());
  let report: ConformanceReport | undefined;
  conformanceTests(test, harness, {
    onReport: (result) => {
      report = result;
    },
  });

  test(`${options.name}: every applicable scenario passes, and only the declared ones do not apply`, () => {
    assert.ok(report !== undefined, "the conformance suite did not run");
    assert.equal(report.results.length, 15);
    for (const result of report.results) {
      if (NOT_APPLICABLE_BY_CAPABILITY.includes(result.key)) {
        assert.equal(result.status, "not_applicable", `scenario ${result.key}`);
        assert.equal(result.notApplicableBy, "capability", `scenario ${result.key}`);
      } else {
        assert.equal(result.status, "passed", `scenario ${result.key}: ${result.reason ?? ""}`);
      }
    }
  });

  test(`${options.name}: every frame the driver and the fake agent sent matches ACP's v${options.protocol} schema`, () => {
    const result = checkFrames(harness.frames);
    assert.deepEqual(result.problems, []);
    assert.ok(result.checked > 100, `only ${result.checked} frames were checked`);
    // Both directions of every method the scenarios use were checked.
    for (const seen of [
      "client initialize Request",
      "agent initialize Response",
      "client session/new Request",
      "agent session/new Response",
      "client session/prompt Request",
      "agent session/prompt Response",
      "client session/cancel Notification",
      "agent session/update Notification",
      "agent session/request_permission Request",
      "client session/request_permission Response",
      "client session/resume Request",
    ]) {
      assert.ok(result.seen.has(seen) || (seen.includes("session/resume") && result.seen.has("client session/load Request")), `no ${seen} frame was checked`);
    }
  });
}
