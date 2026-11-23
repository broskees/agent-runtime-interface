// The request ledger: the host's record of a thread's requests (approvals,
// questions, elicitation) and of the responses it sent. It enforces the
// request safety rules of the proposal (§8) on the host side:
//
// - Responses are idempotent by `(requestId, responseKey)`. A second response
//   with the same pair never reaches the session again: it returns the first
//   response's outcome, success or failure.
// - Once a request is resolved, or while a response to it is in flight, a
//   response with a different `responseKey` is refused with `invalid_state`.
//   A response that failed leaves the request pending, so the host may retry
//   with a new `responseKey`.
// - When a session ends, a pending request it raised that cannot survive a
//   restart (`survivesRestart: false`) becomes `expired`. A request that
//   survives a restart, such as a `message`-mode question, stays pending. A
//   `session.state` event with state `stopped` ends its own session only.
// - A request is never removed because it is absent from a later event window
//   or snapshot. Only its own `request.upsert` events change it.
// - An older event never undoes a newer one. Each field of each request keeps
//   a stamp: the session it came from (sessions are numbered in the order the
//   ledger first sees them, and a later session outranks an earlier one) and
//   the `seq` within that session. A `request.upsert` sets a field only when
//   its stamp is later than the field's. So an event seen again (an
//   overlapping reconnect window) changes nothing, while an earlier event
//   seen for the first time (a backfilled window) still adds requests and the
//   fields nothing newer set, without turning an expired or resolved request
//   back into a pending one. A request its session raised before that session
//   stopped is expired even when the stop was seen first.
//
// The ledger outlives sessions: feed it every session's events for the thread
// and pass the current session to `respond`.

import { callErrors } from "../errors.ts";
import type { AriEvent } from "../generated/events.ts";
import type { Request } from "../generated/request.ts";
import type { RespondInput, RespondResult } from "../generated/session.ts";
import type { ThreadSnapshot } from "../generated/thread.ts";
import type { Session } from "../runtime.ts";

type RespondOutcome = RespondResult | void;

/** When a request field was set: the session's number (in first-seen order) and the `seq` within that session. */
interface Stamp {
  readonly session: number;
  readonly seq: number;
}

/** The stamp of a request restored from host storage: older than any event. */
const RESTORED: Stamp = { session: -1, seq: 0 };

function isLater(candidate: Stamp, current: Stamp): boolean {
  return candidate.session > current.session || (candidate.session === current.session && candidate.seq > current.seq);
}

function isSameStamp(candidate: Stamp, current: Stamp): boolean {
  return candidate.session === current.session && candidate.seq === current.seq;
}

interface ResponseAttempt {
  state: "in_flight" | "succeeded" | "failed";
  readonly outcome: Promise<RespondOutcome>;
}

export interface RequestLedgerOptions {
  /** Requests restored from the host's own storage, for example after a restart. */
  readonly requests?: Iterable<Request>;
}

export class RequestLedger {
  readonly #requests = new Map<string, Request>();
  /** The stamp of each field of each request, by request id, then field name. */
  readonly #stamps = new Map<string, Map<string, Stamp>>();
  /** Each session's number, in the order the ledger first saw it. */
  readonly #sessionNumbers = new Map<string, number>();
  /** The highest `seq` seen in each session, by session number. */
  readonly #highestSeq = new Map<number, number>();
  /** The `seq` of each session's latest `stopped` state, by session number. */
  readonly #stops = new Map<number, number>();
  /** Response attempts by request id, then by response key. */
  readonly #attempts = new Map<string, Map<string, ResponseAttempt>>();

  constructor(options: RequestLedgerOptions = {}) {
    for (const request of options.requests ?? []) this.#apply(request, RESTORED, true);
  }

  /**
   * Follows one session event. `request.upsert` patches the request it names,
   * field by field, where the event is later than what set the field;
   * `session.state` with state `stopped` expires the pending requests its
   * session raised before the stop that cannot survive a restart. Every other
   * event is ignored.
   */
  observe(event: AriEvent): void {
    const session = this.#sessionNumber(event.sessionId);
    this.#highestSeq.set(session, Math.max(this.#highestSeq.get(session) ?? 0, event.seq));
    const body = event.body;
    if (body.type === "request.upsert") {
      this.#apply(body.request, { session, seq: event.seq }, false);
      this.#expireIfStopped(body.request.id);
    } else if (body.type === "session.state" && body.state === "stopped") {
      this.#stops.set(session, Math.max(this.#stops.get(session) ?? 0, event.seq));
      for (const requestId of this.#requests.keys()) this.#expireIfStopped(requestId);
    }
  }

  /**
   * Upserts the requests of a thread snapshot (from `readSnapshot` or a resumed
   * thread), as current as the newest event seen. Requests the snapshot does
   * not list are kept unchanged.
   */
  observeSnapshot(snapshot: ThreadSnapshot): void {
    const newest = this.#sessionNumbers.size - 1;
    const stamp: Stamp = newest < 0 ? RESTORED : { session: newest, seq: this.#highestSeq.get(newest) ?? 0 };
    for (const request of snapshot.requests) this.#apply(request, stamp, true);
  }

  get(requestId: string): Request | undefined {
    return this.#requests.get(requestId);
  }

  /** Every request the ledger knows, in the order it first saw them. */
  list(): Request[] {
    return [...this.#requests.values()];
  }

  /** Requests still waiting for an answer. */
  pending(): Request[] {
    return this.list().filter((request) => request.status === "pending");
  }

  /**
   * Sends a response through `session.respond` at most once per
   * `(requestId, responseKey)`. A repeat of the same pair returns the first
   * outcome without calling the session. Rejects with `not_found` for a
   * request the ledger has never seen, and with `invalid_state` when another
   * response is in flight or succeeded, when the request is no longer pending,
   * or when it is `not_resumable`.
   */
  respond(session: Pick<Session, "respond">, input: RespondInput): Promise<RespondOutcome> {
    const attempts = this.#attempts.get(input.requestId) ?? new Map<string, ResponseAttempt>();
    const repeat = attempts.get(input.responseKey);
    if (repeat !== undefined) return repeat.outcome;

    for (const [responseKey, attempt] of attempts) {
      if (attempt.state === "in_flight") {
        return Promise.reject(
          callErrors.invalidState("response_in_flight", `Request ${input.requestId} already has response ${responseKey} in flight`),
        );
      }
      if (attempt.state === "succeeded") {
        return Promise.reject(
          callErrors.invalidState("request_resolved", `Request ${input.requestId} was already answered with response ${responseKey}`),
        );
      }
    }

    const request = this.#requests.get(input.requestId);
    if (request === undefined) return Promise.reject(callErrors.notFound({ resource: "request", id: input.requestId }));
    if (request.status !== "pending") {
      return Promise.reject(
        callErrors.invalidState(`request_${request.status}`, `Request ${input.requestId} is ${request.status}, not pending`),
      );
    }
    if (request.response.mode === "not_resumable") {
      return Promise.reject(callErrors.invalidState("request_not_resumable", `Request ${input.requestId} can no longer be answered`));
    }

    const outcome = Promise.resolve().then(() => session.respond(input));
    const attempt: ResponseAttempt = { state: "in_flight", outcome };
    attempts.set(input.responseKey, attempt);
    this.#attempts.set(input.requestId, attempts);
    outcome.then(
      () => {
        attempt.state = "succeeded";
        if (this.#requests.get(input.requestId)?.status !== "pending") return;
        // As current as everything seen in the session that last set the status.
        const statusStamp = this.#statusStamp(input.requestId);
        const resolvedStamp: Stamp = { session: statusStamp.session, seq: Math.max(statusStamp.seq, this.#highestSeq.get(statusStamp.session) ?? 0) };
        this.#apply({ id: input.requestId, status: "resolved" }, resolvedStamp, true);
      },
      () => {
        attempt.state = "failed";
      },
    );
    return outcome;
  }

  /**
   * Marks the end of every session that held these requests. Each pending
   * request with `survivesRestart: false` becomes `expired`, and no later
   * event of the session that set its status can make it pending again; the
   * rest stay pending. Returns the requests that expired.
   */
  endSession(): Request[] {
    const expired: Request[] = [];
    for (const request of [...this.#requests.values()]) {
      if (request.status !== "pending" || request.survivesRestart) continue;
      const { session } = this.#statusStamp(request.id);
      this.#apply({ id: request.id, status: "expired" }, { session, seq: Number.POSITIVE_INFINITY }, false);
      expired.push(this.#requests.get(request.id)!);
    }
    return expired;
  }

  #sessionNumber(sessionId: string): number {
    let number = this.#sessionNumbers.get(sessionId);
    if (number === undefined) {
      number = this.#sessionNumbers.size;
      this.#sessionNumbers.set(sessionId, number);
    }
    return number;
  }

  #statusStamp(requestId: string): Stamp {
    return this.#stamps.get(requestId)?.get("status") ?? RESTORED;
  }

  /** Expires a pending, non-surviving request whose status was set by a session before that session stopped. */
  #expireIfStopped(requestId: string): void {
    const request = this.#requests.get(requestId);
    if (request === undefined || request.status !== "pending" || request.survivesRestart) return;
    const statusStamp = this.#statusStamp(requestId);
    const stop = this.#stops.get(statusStamp.session);
    if (stop === undefined || statusStamp.seq >= stop) return;
    this.#apply({ id: requestId, status: "expired" }, { session: statusStamp.session, seq: stop }, false);
  }

  /**
   * Applies a patch with the ACP v2 rules (an omitted field is unchanged,
   * `null` clears it, a value replaces it whole), field by field: a field
   * changes only when `stamp` is later than the stamp that set it, or the same
   * stamp when `orSameStamp`.
   */
  #apply(patch: { readonly id: string; readonly [field: string]: unknown }, stamp: Stamp, orSameStamp: boolean): void {
    const stamps = this.#stamps.get(patch.id) ?? new Map<string, Stamp>();
    const next: { [field: string]: unknown } = { ...this.#requests.get(patch.id) };
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const previous = stamps.get(field);
      if (previous !== undefined && !isLater(stamp, previous) && !(orSameStamp && isSameStamp(stamp, previous))) continue;
      if (value === null) delete next[field];
      else next[field] = value;
      stamps.set(field, stamp);
    }
    this.#stamps.set(patch.id, stamps);
    this.#requests.set(patch.id, next as Request);
  }
}
