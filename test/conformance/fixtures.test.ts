// Replay fixtures in the conformance kit: every scenario's sessions come back
// as fixtures in the format of spec/v1/fixture.schema.json, `checkFixture`
// judges a fixture's events with the strict grammar, and a fixture written
// with a newer persistence major version is refused, naming both versions.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SUPPORTED_FIXTURE_PERSISTENCE, checkFixture, loadFixture, referenceHarness, runConformance } from "../../src/conformance/index.ts";
import { FixtureSchema, serializeFixture } from "../../src/host/index.ts";
import { PERSISTENCE_VERSION, isAriError } from "../../src/index.ts";
import type { Fixture } from "../../src/host/index.ts";
import { createSpecAjv, defId } from "../helpers/spec.ts";

async function recordedFixture(): Promise<Fixture> {
  const report = await runConformance(referenceHarness(), { scenarios: ["turn-completed"] });
  const fixture = report.results[0]?.fixtures[0];
  assert.ok(fixture !== undefined, "scenario 2 returned no fixture");
  return fixture;
}

describe("conformance fixtures", () => {
  test("each scenario returns its sessions as fixtures that validate against fixture.schema.json", async () => {
    const report = await runConformance(referenceHarness(), { scenarios: ["turn-completed", "replay-from-seq"] });
    const fixtures = report.results.flatMap((result) => result.fixtures);
    assert.ok(fixtures.length >= 2);
    const validate = createSpecAjv().getSchema(defId("fixture.schema.json", "Fixture"))!;
    for (const fixture of fixtures) {
      assert.ok(FixtureSchema.is(fixture));
      assert.ok(validate(JSON.parse(serializeFixture(fixture))), JSON.stringify(validate.errors));
      const check = checkFixture(serializeFixture(fixture));
      assert.equal(check.ok, true, JSON.stringify(check.grammarViolation ?? check.unsettledCalls));
      assert.ok(check.fixture.entries.some((entry) => entry.type === "event"));
      assert.ok(check.fixture.entries.some((entry) => entry.type === "call" && entry.method === "session/startTurn"));
    }
  });

  test("checkFixture reports a grammar violation and a call with no outcome", async () => {
    const fixture = await recordedFixture();
    const events = fixture.entries.filter((entry) => entry.type === "event");
    const terminal = events.find((entry) => entry.event.body.type === "turn.terminal")!;
    const doubled: Fixture = { ...fixture, entries: [...fixture.entries, { ...terminal, event: { ...terminal.event, seq: events.length + 1 } }, { type: "call", callId: 999, method: "session/close", params: {}, at: "2026-11-23T12:00:00.000Z" }] };
    const check = checkFixture(doubled);
    assert.equal(check.ok, false);
    assert.equal(check.grammarViolation?.rule, "turn/settles-once");
    assert.deepEqual(check.unsettledCalls, [999]);
  });

  test("a fixture with a higher persistence major version is refused with an error naming both versions", async () => {
    assert.deepEqual(SUPPORTED_FIXTURE_PERSISTENCE, PERSISTENCE_VERSION);
    const fixture = await recordedFixture();
    const newer = { ...fixture, persistence: { major: PERSISTENCE_VERSION.major + 1, minor: 3 } };
    const found = `${PERSISTENCE_VERSION.major + 1}.3`;
    const supported = `${PERSISTENCE_VERSION.major}.${PERSISTENCE_VERSION.minor}`;
    for (const load of [() => loadFixture(serializeFixture(newer)), () => checkFixture(newer)]) {
      assert.throws(load, (error: unknown) => {
        assert.ok(isAriError(error, "validation"));
        assert.ok(error.message.includes(found), error.message);
        assert.ok(error.message.includes(supported), error.message);
        return true;
      });
    }
    // A newer minor version of the same major is read.
    const newerMinor = { ...fixture, persistence: { major: PERSISTENCE_VERSION.major, minor: PERSISTENCE_VERSION.minor + 1 } };
    assert.equal(loadFixture(newerMinor).persistence.minor, PERSISTENCE_VERSION.minor + 1);
  });
});
