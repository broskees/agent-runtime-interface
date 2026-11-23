// Replay fixtures in the kit. A fixture is the recording format of
// spec/v1/fixture.schema.json, written by `ari/host`'s replay recorder: every
// scenario's sessions come back as fixtures in the report, and a host or
// driver author can check a fixture recorded elsewhere with `checkFixture`.
//
// `loadFixture` refuses a fixture whose persistence major version is newer
// than this kit's, with a `validation` call error naming both versions, and
// otherwise validates it against the schema.

import type { Fixture } from "../generated/fixture.ts";
import { EventGrammar, EventGrammarError } from "../host/event-grammar.ts";
import type { EventGrammarViolation } from "../host/event-grammar.ts";
import { fixtureEvents, parseFixture } from "../host/replay-recorder.ts";
import { PERSISTENCE_VERSION } from "../version.ts";

/** The fixture persistence version this kit reads; a fixture with a higher major version is refused. */
export const SUPPORTED_FIXTURE_PERSISTENCE: { readonly major: number; readonly minor: number } = PERSISTENCE_VERSION;

/** Reads a fixture from JSON text or parsed JSON, refusing newer persistence major versions. */
export function loadFixture(input: string | unknown): Fixture {
  return parseFixture(input);
}

export interface FixtureCheck {
  readonly fixture: Fixture;
  /** True when every event keeps the strict event grammar and every call has exactly one outcome. */
  readonly ok: boolean;
  readonly grammarViolation?: EventGrammarViolation;
  /** Calls with no `result` or `error` entry, or with more than one. */
  readonly unsettledCalls: readonly number[];
}

/** Loads a fixture and checks its events with the strict EventGrammar and its calls for one outcome each. */
export function checkFixture(input: string | unknown): FixtureCheck {
  const fixture = loadFixture(input);
  const grammar = new EventGrammar({ mode: "strict" });
  let grammarViolation: EventGrammarViolation | undefined;
  for (const event of fixtureEvents(fixture)) {
    try {
      grammar.observe(event);
    } catch (error) {
      if (!(error instanceof EventGrammarError)) throw error;
      grammarViolation = error.violation;
      break;
    }
  }
  const outcomes = new Map<number, number>();
  for (const entry of fixture.entries) {
    if (entry.type === "call") outcomes.set(entry.callId, outcomes.get(entry.callId) ?? 0);
    else if (entry.type === "result" || entry.type === "error") outcomes.set(entry.callId, (outcomes.get(entry.callId) ?? 0) + 1);
  }
  const unsettledCalls = [...outcomes].filter(([, count]) => count !== 1).map(([callId]) => callId);
  return {
    fixture,
    ok: grammarViolation === undefined && unsettledCalls.length === 0,
    ...(grammarViolation === undefined ? {} : { grammarViolation }),
    unsettledCalls,
  };
}
