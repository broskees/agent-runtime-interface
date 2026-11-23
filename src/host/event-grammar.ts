// EventGrammar: checks that a session's event stream keeps the grammar of
// spec/v1/README.md ("Event grammar"). The definitions it applies:
//
// - An item opens with the first `item.upsert` that carries its id in the
//   session, and settles with the first `item.upsert` that sets its `status` to
//   `completed`, `failed`, `cancelled` or `interrupted`.
// - A turn starts with the first `turn.upsert` that carries its id in the
//   session, and settles with its `turn.terminal` event, never otherwise.
//
// The six rules it enforces:
//
//   item/opens-before-delta  an `item.delta` comes after its item opens and
//                            before it settles.
//   item/settles-once        after an item settles, no `item.upsert` for it sets
//                            `status` again.
//   turn/starts-once         no `turn.upsert` for a turn that already settled.
//   turn/settles-once        a turn has at most one `turn.terminal`.
//   turn/known               a `turn.terminal`, and every event whose envelope
//                            carries a `turnId`, names a turn that has started.
//                            The event that starts a turn may carry its own id.
//   seq/gap-free             the first event of a session has `seq` 1 and each
//                            next event the previous `seq` plus 1.
//
// Three modes:
//
//   strict  throws an `EventGrammarError` naming the rule at the first
//           violation. `ari/conformance` runs this mode.
//   warn    reports each violation to `onViolation` and passes every event
//           through unchanged, so a vendor regression never crashes a live host.
//   repair  reports each violation to `onViolation` and yields a stream that
//           strict mode accepts: it drops deltas for items that are not open,
//           `turn.upsert` events for settled turns, a second `turn.terminal` and
//           a `turn.terminal` for a turn that never started; it removes `status`
//           from an `item.upsert` for a settled item and an unknown `turnId`
//           from an envelope; and it renumbers `seq` so the output is gap-free.
//
// State is kept per `sessionId`, so one grammar can watch several sessions'
// events interleaved. The grammar checks whole streams from `seq` 1; a stream
// that resumes with `events({ fromSeq })` misses the turns that started before
// it and is not a stream this checker can judge.

import type { AriEvent, AriEventBody } from "../generated/events.ts";

/** The six grammar rules, by the name violations report. */
export const EVENT_GRAMMAR_RULES = [
  "item/opens-before-delta",
  "item/settles-once",
  "turn/starts-once",
  "turn/settles-once",
  "turn/known",
  "seq/gap-free",
] as const;

export type EventGrammarRule = (typeof EVENT_GRAMMAR_RULES)[number];

export type EventGrammarMode = "strict" | "warn" | "repair";

/** One broken rule. `event` is the event as it arrived, before any repair. */
export interface EventGrammarViolation {
  readonly rule: EventGrammarRule;
  readonly reason: string;
  readonly event: AriEvent;
}

/** Thrown by strict mode. The message starts with the rule name in brackets. */
export class EventGrammarError extends Error {
  readonly rule: EventGrammarRule;
  readonly violation: EventGrammarViolation;

  constructor(violation: EventGrammarViolation) {
    super(`[${violation.rule}] ${violation.reason}`);
    this.name = "EventGrammarError";
    this.rule = violation.rule;
    this.violation = violation;
  }
}

export interface EventGrammarOptions {
  readonly mode: EventGrammarMode;
  /** Called once per violation in `warn` and `repair` modes. */
  readonly onViolation?: (violation: EventGrammarViolation) => void;
}

/** Item statuses that settle an item. */
export const TERMINAL_ITEM_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted"]);

interface SessionGrammarState {
  lastInputSeq: number;
  lastOutputSeq: number;
  readonly openItemIds: Set<string>;
  readonly settledItemIds: Set<string>;
  /** Every turn that has started, settled or not. */
  readonly startedTurnIds: Set<string>;
  readonly settledTurnIds: Set<string>;
}

/** What one event does to the grammar: the rules it breaks and the event repair mode passes on. */
interface Verdict {
  readonly violations: Array<{ rule: EventGrammarRule; reason: string }>;
  /** Undefined when repair mode drops the event. */
  repaired: AriEvent | undefined;
}

export class EventGrammar {
  readonly mode: EventGrammarMode;
  readonly #onViolation: ((violation: EventGrammarViolation) => void) | undefined;
  readonly #sessions = new Map<string, SessionGrammarState>();

  constructor(options: EventGrammarOptions) {
    this.mode = options.mode;
    this.#onViolation = options.onViolation;
  }

  /**
   * Checks one event and returns what to pass on. Strict mode returns the event
   * or throws an `EventGrammarError`. Warn mode always returns the event
   * unchanged. Repair mode returns the event, a repaired copy, or `undefined`
   * when the event must be dropped.
   */
  observe(event: AriEvent): AriEvent | undefined {
    const state = this.#stateFor(event.sessionId);
    const verdict = judge(state, event);
    for (const { rule, reason } of verdict.violations) {
      const violation: EventGrammarViolation = { rule, reason, event };
      if (this.mode === "strict") throw new EventGrammarError(violation);
      this.#onViolation?.(violation);
    }
    if (this.mode !== "repair") return event;
    const repaired = verdict.repaired;
    if (repaired === undefined) return undefined;
    state.lastOutputSeq += 1;
    if (repaired.seq === state.lastOutputSeq) return repaired;
    return { ...repaired, seq: state.lastOutputSeq };
  }

  /** Runs `observe` over a stream and yields what it passes on. */
  async *check(events: AsyncIterable<AriEvent> | Iterable<AriEvent>): AsyncGenerator<AriEvent, void, undefined> {
    for await (const event of events) {
      const passed = this.observe(event);
      if (passed !== undefined) yield passed;
    }
  }

  /** Forgets everything about one session, or about every session. */
  reset(sessionId?: string): void {
    if (sessionId === undefined) this.#sessions.clear();
    else this.#sessions.delete(sessionId);
  }

  #stateFor(sessionId: string): SessionGrammarState {
    let state = this.#sessions.get(sessionId);
    if (state === undefined) {
      state = {
        lastInputSeq: 0,
        lastOutputSeq: 0,
        openItemIds: new Set(),
        settledItemIds: new Set(),
        startedTurnIds: new Set(),
        settledTurnIds: new Set(),
      };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }
}

/**
 * Applies one event to the session's grammar state and reports what it breaks.
 * The state follows the stream the same way in every mode: an event that
 * breaks a rule never opens, starts or settles anything, so warn mode (which
 * passes it on) and repair mode (which drops or trims it) track the same state.
 */
function judge(state: SessionGrammarState, event: AriEvent): Verdict {
  const verdict: Verdict = { violations: [], repaired: event };
  const broke = (rule: EventGrammarRule, reason: string): void => {
    verdict.violations.push({ rule, reason });
  };

  const expectedSeq = state.lastInputSeq + 1;
  if (event.seq !== expectedSeq) {
    broke("seq/gap-free", `event has seq ${String(event.seq)} where seq ${expectedSeq} was expected`);
  }
  // Resynchronize on the received number, so one gap is reported once.
  if (Number.isInteger(event.seq)) state.lastInputSeq = event.seq;

  const body: AriEventBody = event.body;
  // The body's own turn id, when this event already judged it under turn/known.
  let bodyTurnIdJudged: string | undefined;

  switch (body.type) {
    case "turn.upsert": {
      const turnId = body.turn.id;
      if (state.settledTurnIds.has(turnId)) {
        broke("turn/starts-once", `turn.upsert for turn "${turnId}", which already settled`);
        verdict.repaired = undefined;
      } else {
        state.startedTurnIds.add(turnId);
      }
      break;
    }
    case "turn.terminal": {
      const turnId = body.turnId;
      bodyTurnIdJudged = turnId;
      if (state.settledTurnIds.has(turnId)) {
        broke("turn/settles-once", `second turn.terminal for turn "${turnId}"`);
        verdict.repaired = undefined;
      } else if (!state.startedTurnIds.has(turnId)) {
        broke("turn/known", `turn.terminal for turn "${turnId}", which never started`);
        verdict.repaired = undefined;
      } else {
        state.settledTurnIds.add(turnId);
      }
      break;
    }
    case "item.upsert": {
      const item = body.item;
      const setsStatus = item.status !== undefined;
      if (state.settledItemIds.has(item.id)) {
        if (setsStatus) {
          broke("item/settles-once", `item.upsert sets status "${String(item.status)}" on item "${item.id}", which already settled`);
          const { status: _droppedStatus, ...withoutStatus } = item;
          verdict.repaired = { ...event, body: { ...body, item: withoutStatus } };
        }
        break;
      }
      state.openItemIds.add(item.id);
      if (setsStatus && TERMINAL_ITEM_STATUSES.has(item.status as string)) {
        state.openItemIds.delete(item.id);
        state.settledItemIds.add(item.id);
      }
      break;
    }
    case "item.delta": {
      const itemId = body.itemId;
      if (state.openItemIds.has(itemId)) break;
      const when = state.settledItemIds.has(itemId) ? "after it settled" : "before it opened";
      broke("item/opens-before-delta", `item.delta for item "${itemId}" arrived ${when}`);
      verdict.repaired = undefined;
      break;
    }
    default:
      break;
  }

  // Checked after the body, so the event that starts a turn may carry its own id.
  if (event.turnId !== undefined && event.turnId !== bodyTurnIdJudged && !state.startedTurnIds.has(event.turnId)) {
    broke("turn/known", `event envelope names turn "${event.turnId}", which never started`);
    if (verdict.repaired !== undefined) {
      const { turnId: _unknownTurnId, ...withoutTurnId } = verdict.repaired;
      verdict.repaired = withoutTurnId;
    }
  }

  return verdict;
}
