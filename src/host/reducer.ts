// The event reducer: folds a session's events into the durable state a host
// keeps (threads, turns, items, requests, subagents, plans, background tasks,
// usage, limits, capabilities and config options).
//
// - `*.upsert` events apply their patch with `applyPatch` (ACP v2 rules: an
//   omitted field is unchanged, `null` clears it, a value replaces it whole).
// - `item.delta` appends its chunk to the named string field of an open item.
//   Deltas for an unknown or settled item are ignored: once an item settles,
//   its settling `item.upsert` carries the full text, so a stream with every
//   delta removed folds to the same state.
// - `turn.terminal` sets the turn's terminal `status` (and `failure`) and is
//   kept whole in `turnTerminals`.
// - `background.updated`, `usage.updated`, `limits.updated`,
//   `capabilities.updated`, `config.updated` and `commands.updated` replace
//   their part of the state.
// - `notice`, `retry` and `x:` extension events are not state; the reducer
//   only advances `lastSeq` for them.
//
// `reduceEvent` never mutates its input state. Collections are `ReadonlyMap`s
// keyed by entity id, so any id (even `__proto__`) is safe; an update copies
// only the collection it changes.

import type { BackgroundTaskSummary } from "../generated/background.ts";
import type { Capabilities } from "../generated/capabilities.ts";
import type { ConfigOption, Skill, SlashCommand } from "../generated/config.ts";
import type { Failure } from "../generated/errors.ts";
import type { AriEvent, SessionReplacedBody, SessionState, TurnTerminalBody } from "../generated/events.ts";
import type { Item } from "../generated/item.ts";
import type { Plan } from "../generated/plan.ts";
import type { Request } from "../generated/request.ts";
import type { Subagent } from "../generated/subagent.ts";
import type { Thread, Turn } from "../generated/thread.ts";
import type { LimitStatus, UsageSnapshot } from "../generated/usage.ts";
import { applyPatch } from "../patch.ts";
import type { Patch } from "../patch.ts";
import { TERMINAL_ITEM_STATUSES } from "./event-grammar.ts";

/** A session's state, folded from its events. */
export interface ReducedSession {
  /** The `seq` of the last event folded in; 0 before any. Resume with `fromSeq: lastSeq + 1`. */
  readonly lastSeq: number;
  readonly sessionId: string | undefined;
  /** The last `session.state` value, and its failure when it carried one. */
  readonly state: SessionState | undefined;
  readonly failure: Failure | undefined;
  /** Every `session.replaced` event, oldest first. */
  readonly replacements: readonly SessionReplacedBody[];
  readonly capabilities: Capabilities | undefined;
  readonly configOptions: readonly ConfigOption[];
  readonly commands: readonly SlashCommand[];
  readonly skills: readonly Skill[];
  readonly threads: ReadonlyMap<string, Thread>;
  /** The latest `retainedNativeTurnIds` each thread's upsert carried, for reconciling after a rollback. */
  readonly retainedNativeTurnIds: ReadonlyMap<string, readonly string[]>;
  readonly turns: ReadonlyMap<string, Turn>;
  /** Each settled turn's `turn.terminal` body. */
  readonly turnTerminals: ReadonlyMap<string, TurnTerminalBody>;
  readonly items: ReadonlyMap<string, Item>;
  readonly requests: ReadonlyMap<string, Request>;
  readonly subagents: ReadonlyMap<string, Subagent>;
  readonly plans: ReadonlyMap<string, Plan>;
  /** The latest full list of yielded-but-alive background work. */
  readonly backgroundTasks: readonly BackgroundTaskSummary[];
  readonly usage: UsageSnapshot | undefined;
  readonly limits: LimitStatus | undefined;
}

/** The state before any event. */
export function emptyReducedSession(): ReducedSession {
  return {
    lastSeq: 0,
    sessionId: undefined,
    state: undefined,
    failure: undefined,
    replacements: [],
    capabilities: undefined,
    configOptions: [],
    commands: [],
    skills: [],
    threads: new Map(),
    retainedNativeTurnIds: new Map(),
    turns: new Map(),
    turnTerminals: new Map(),
    items: new Map(),
    requests: new Map(),
    subagents: new Map(),
    plans: new Map(),
    backgroundTasks: [],
    usage: undefined,
    limits: undefined,
  };
}

function withEntry<Value>(map: ReadonlyMap<string, Value>, key: string, value: Value): ReadonlyMap<string, Value> {
  const copy = new Map(map);
  copy.set(key, value);
  return copy;
}

function patched<Entity extends { id: string }>(
  map: ReadonlyMap<string, Entity>,
  patch: Patch<Entity> & { id: string },
): ReadonlyMap<string, Entity> {
  return withEntry(map, patch.id, applyPatch(map.get(patch.id), patch));
}

/** Folds one event into `state` and returns the new state. `state` is not changed. */
export function reduceEvent(state: ReducedSession, event: AriEvent): ReducedSession {
  const next: ReducedSession = { ...state, lastSeq: event.seq, sessionId: event.sessionId };
  const body = event.body;
  switch (body.type) {
    case "session.state":
      return { ...next, state: body.state, failure: body.failure };
    case "session.replaced":
      return { ...next, replacements: [...state.replacements, body] };
    case "capabilities.updated":
      return { ...next, capabilities: body.capabilities };
    case "config.updated":
      return { ...next, configOptions: body.options };
    case "commands.updated":
      return { ...next, commands: body.commands, skills: body.skills ?? state.skills };
    case "thread.upsert": {
      const threads = patched(state.threads, body.thread);
      if (body.retainedNativeTurnIds === undefined) return { ...next, threads };
      return { ...next, threads, retainedNativeTurnIds: withEntry(state.retainedNativeTurnIds, body.thread.id, body.retainedNativeTurnIds) };
    }
    case "turn.upsert":
      return { ...next, turns: patched(state.turns, body.turn) };
    case "turn.terminal": {
      const turnTerminals = withEntry(state.turnTerminals, body.turnId, body);
      const turn = state.turns.get(body.turnId);
      if (turn === undefined) return { ...next, turnTerminals };
      const settled = applyPatch<Turn>(turn, { status: body.status, ...(body.failure === undefined ? {} : { failure: body.failure }) });
      return { ...next, turnTerminals, turns: withEntry(state.turns, body.turnId, settled) };
    }
    case "item.upsert":
      return { ...next, items: patched(state.items, body.item) };
    case "item.delta": {
      const item = state.items.get(body.itemId);
      if (item === undefined || TERMINAL_ITEM_STATUSES.has(item.status)) return next;
      const current = (item as { [field: string]: unknown })[body.field];
      if (current !== undefined && typeof current !== "string") return next;
      const appended = { ...item, [body.field]: (current ?? "") + body.chunk } as Item;
      return { ...next, items: withEntry(state.items, item.id, appended) };
    }
    case "request.upsert":
      return { ...next, requests: patched(state.requests, body.request) };
    case "subagent.upsert":
      return { ...next, subagents: patched(state.subagents, body.subagent) };
    case "plan.upsert":
      return { ...next, plans: patched(state.plans, body.plan) };
    case "background.updated":
      return { ...next, backgroundTasks: body.tasks };
    case "usage.updated":
      return { ...next, usage: body.usage };
    case "limits.updated":
      return { ...next, limits: body.limits };
    default:
      // notice, retry and extension events carry no durable state.
      return next;
  }
}

/** Folds every event, in order, starting from `initial` (the empty state by default). */
export function reduceEvents(events: Iterable<AriEvent>, initial: ReducedSession = emptyReducedSession()): ReducedSession {
  let state = initial;
  for (const event of events) state = reduceEvent(state, event);
  return state;
}
