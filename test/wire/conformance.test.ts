// The conformance suite passes over the wire: all 15 scenarios run against
// the reference driver twice, once in process and once inside the built
// `ari-driver` bin through `ari/wire`'s TypeScript client, and the two runs
// must agree on every scenario's result and on every event of every recorded
// session: the same `seq` values, the same ids, the same bodies. Only
// timestamps differ between runs: each event's `at`, and times the kit derives
// from the clock, such as a usage limit's `resetAt` an hour after the scenario
// ran.
//
// The wire run uses real time (the driver's timers run in another process),
// so the settlement scenario's 36.5-second pause and the auth scenario's
// 30-second poison take their full length.

import assert from "node:assert/strict";
import { test } from "node:test";
import { referenceHarness, runConformance } from "../../src/conformance/index.ts";
import type { ConformanceReport, ScenarioResult } from "../../src/conformance/index.ts";
import type { AriEvent } from "../../src/index.ts";
import type { Fixture } from "../../src/host/index.ts";
import { requireBuild, wireReferenceHarness } from "./helpers.ts";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** `value` with every ISO-8601 timestamp string replaced by a placeholder. */
function withoutTimestamps(value: unknown): unknown {
  if (typeof value === "string") return ISO_TIMESTAMP.test(value) ? "<timestamp>" : value;
  if (Array.isArray(value)) return value.map(withoutTimestamps);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, withoutTimestamps(field)]));
  }
  return value;
}

/** A recorded session's events in order, without the `at` field and with other timestamps as placeholders. */
function eventsOf(fixture: Fixture): Array<Omit<AriEvent, "at">> {
  return fixture.entries.flatMap((entry) => {
    if (entry.type !== "event") return [];
    const { at: _at, ...rest } = entry.event as AriEvent;
    return [withoutTimestamps(rest) as Omit<AriEvent, "at">];
  });
}

/** Every id an event carries, envelope and body. */
function idsOf(event: Omit<AriEvent, "at">): string[] {
  const ids: string[] = [event.sessionId];
  if (event.threadId !== undefined) ids.push(event.threadId);
  if (event.turnId !== undefined) ids.push(event.turnId);
  const body = event.body as { readonly [key: string]: unknown };
  for (const key of ["thread", "turn", "item", "request", "subagent", "plan"]) {
    const entity = body[key] as { id?: unknown } | undefined;
    if (typeof entity?.id === "string") ids.push(entity.id);
  }
  for (const key of ["turnId", "itemId"]) if (typeof body[key] === "string") ids.push(body[key]);
  return ids;
}

/**
 * A result without its duration. The notes of the settlement and auth
 * scenarios say whether the pause ran on "virtual" or "real" time, which is
 * the harness's clock setting (the in-process run uses the kit's default
 * virtual clock), so that one word is left out of the comparison.
 */
function resultSummary(result: ScenarioResult): object {
  const notes = result.notes.map((note) => note.replace(/ of (?:virtual|real) time\b/, " of <clock> time"));
  return { id: result.id, key: result.key, status: result.status, notApplicableBy: result.notApplicableBy, reason: result.reason, notes };
}

/** The fixtures of one scenario, in a stable order. */
function fixturesOf(result: ScenarioResult): Fixture[] {
  return [...result.fixtures].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

test("all 15 conformance scenarios give the same results, seqs and ids over ari-driver as in process", async () => {
  requireBuild();
  const inProcess: ConformanceReport = await runConformance(referenceHarness());
  const overWire: ConformanceReport = await runConformance(wireReferenceHarness());

  assert.equal(inProcess.results.length, 15);
  assert.equal(overWire.results.length, 15);
  assert.ok(inProcess.passed, `the in-process run failed:\n${JSON.stringify(inProcess.results.map(resultSummary), null, 2)}`);
  for (const result of overWire.results) {
    assert.equal(result.status, "passed", `scenario ${result.id} (${result.key}) over the wire: ${result.status}: ${result.reason ?? ""}`);
  }
  assert.deepEqual(overWire.results.map(resultSummary), inProcess.results.map(resultSummary));

  let eventCount = 0;
  for (const [index, wireResult] of overWire.results.entries()) {
    const localResult = inProcess.results[index]!;
    const wireFixtures = fixturesOf(wireResult);
    const localFixtures = fixturesOf(localResult);
    assert.equal(wireFixtures.length, localFixtures.length, `scenario ${wireResult.key}: number of recorded sessions`);
    for (const [position, wireFixture] of wireFixtures.entries()) {
      const localFixture = localFixtures[position]!;
      assert.equal(wireFixture.sessionId, localFixture.sessionId, `scenario ${wireResult.key}: session id`);
      const wireEvents = eventsOf(wireFixture);
      const localEvents = eventsOf(localFixture);
      const where = `scenario ${wireResult.key}, session ${wireFixture.sessionId}`;
      assert.deepEqual(
        wireEvents.map((event) => event.seq),
        localEvents.map((event) => event.seq),
        `${where}: seq values`,
      );
      assert.deepEqual(wireEvents.map(idsOf), localEvents.map(idsOf), `${where}: ids`);
      assert.deepEqual(wireEvents, localEvents, `${where}: event bodies`);
      eventCount += wireEvents.length;
    }
  }
  assert.ok(eventCount > 300, `the runs compared only ${eventCount} events`);
});
