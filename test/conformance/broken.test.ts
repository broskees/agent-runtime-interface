// Every conformance scenario catches the failure it exists for: a
// deliberately broken variant of the reference driver fails it, with a
// reason that names the bug. The honest reference driver passes the same
// scenario (test/conformance/reference.test.ts).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SCENARIOS, referenceHarness } from "../../src/conformance/index.ts";
import { BROKEN_VARIANTS, runScenario } from "./broken-drivers.ts";

describe("each scenario fails its deliberately broken variant", () => {
  for (const variant of BROKEN_VARIANTS) {
    const scenario = SCENARIOS.find((candidate) => candidate.id === variant.scenario)!;
    test(`scenario ${scenario.id} (${scenario.key}) fails a driver that ${variant.bug}`, async () => {
      const harness = variant.harness();
      try {
        const result = await runScenario(harness, variant.scenario, variant.timeoutMs);
        assert.equal(result.status, "failed", `expected the broken variant to fail; got ${result.status}: ${result.reason ?? ""}`);
        assert.match(result.reason ?? "", variant.reason);
      } finally {
        harness.cleanup?.();
      }
    });
  }

  test("every one of the 15 scenarios has a broken variant", () => {
    const covered = new Set(BROKEN_VARIANTS.map((variant) => variant.scenario));
    assert.deepEqual(
      SCENARIOS.map((scenario) => scenario.id).filter((id) => !covered.has(id)),
      [],
    );
    assert.equal(SCENARIOS.length, 15);
  });

  test("the honest reference driver passes each scenario the broken variants fail", async () => {
    for (const id of new Set(BROKEN_VARIANTS.map((variant) => variant.scenario))) {
      const harness = id === 15 ? referenceHarness({ config: { fullAccessReplies: "host" } }) : referenceHarness();
      const result = await runScenario(harness, id);
      assert.equal(result.status, "passed", `scenario ${id}: ${result.reason ?? ""}`);
    }
  });
});

describe("the settlement scenario and the quiet timer", () => {
  test("the scenario pauses at least 36 seconds and the broken variant's timer is an ordinary 30-second setTimeout", async () => {
    const variant = BROKEN_VARIANTS.find((candidate) => candidate.scenario === 6)!;
    const started = Date.now();
    const result = await runScenario(variant.harness(), 6);
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /about 30\.\d s into a 36\.5 s pause/);
    // Virtual time: the 30 seconds passed without the test waiting for them.
    assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);

    const honest = await runScenario(referenceHarness(), 6);
    assert.equal(honest.status, "passed", honest.reason);
    // The pause is 36.5 s; virtual time also follows the real time the kit spends polling, so a loaded machine can add a tenth or so.
    const passed = honest.notes.map((note) => /^(\d+\.\d) s of virtual time passed between the tool result and the completion$/.exec(note)).find((match) => match !== null);
    assert.ok(passed !== undefined, honest.notes.join("\n"));
    assert.ok(Number(passed[1]) >= 36.5, honest.notes.join("\n"));
  });
});
