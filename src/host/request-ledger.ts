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
// - When a session ends, a pending request that cannot survive a restart
//   (`survivesRestart: false`) becomes `expired`. A request that survives a
//   restart, such as a `message`-mode question, stays pending.
// - A request is never removed because it is absent from a later event window
//   or snapshot. Only its own `request.upsert` events change it.
// - An event is applied once. The ledger remembers the highest `seq` it saw in
//   each session and ignores events at or below it, so a reconnect whose
//   `fromSeq` window overlaps events already seen cannot turn an expired or
//   resolved request back into a pending one.
//
// The ledger outlives sessions: feed it every session's events for the thread
// and pass the current session to `respond`.

import { callErrors } from "../errors.ts";
import type { AriEvent } from "../generated/events.ts";
import type { Request } from "../generated/request.ts";
import type { RespondInput, RespondResult } from "../generated/session.ts";
import type { ThreadSnapshot } from "../generated/thread.ts";
import { applyPatch } from "../patch.ts";
import type { Patch } from "../patch.ts";
import type { Session } from "../runtime.ts";

type RespondOutcome = RespondResult | void;

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
  /** Response attempts by request id, then by response key. */
  readonly #attempts = new Map<string, Map<string, ResponseAttempt>>();
  /** The highest `seq` observed in each session. */
  readonly #lastSeqBySession = new Map<string, number>();

  constructor(options: RequestLedgerOptions = {}) {
    for (const request of options.requests ?? []) this.#requests.set(request.id, request);
  }

  /**
   * Follows one session event. `request.upsert` patches the request it names;
   * `session.state` with state `stopped` ends the session (see `endSession`).
   * Every other event, and any event whose `seq` is not above the highest
   * already seen in its session, is ignored.
   */
  observe(event: AriEvent): void {
    const lastSeq = this.#lastSeqBySession.get(event.sessionId);
    if (lastSeq !== undefined && event.seq <= lastSeq) return;
    this.#lastSeqBySession.set(event.sessionId, event.seq);
    const body = event.body;
    if (body.type === "request.upsert") {
      const patch = body.request;
      this.#requests.set(patch.id, applyPatch(this.#requests.get(patch.id), patch as Patch<Request>));
    } else if (body.type === "session.state" && body.state === "stopped") {
      this.endSession();
    }
  }

  /**
   * Upserts the requests of a thread snapshot (from `readSnapshot` or a resumed
   * thread). Requests the snapshot does not list are kept unchanged.
   */
  observeSnapshot(snapshot: ThreadSnapshot): void {
    for (const request of snapshot.requests) {
      this.#requests.set(request.id, applyPatch(this.#requests.get(request.id), request as Patch<Request>));
    }
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
        const current = this.#requests.get(input.requestId);
        if (current !== undefined && current.status === "pending") {
          this.#requests.set(input.requestId, { ...current, status: "resolved" });
        }
      },
      () => {
        attempt.state = "failed";
      },
    );
    return outcome;
  }

  /**
   * Marks the end of the session that held these requests. Each pending
   * request with `survivesRestart: false` becomes `expired`; the rest stay
   * pending. Returns the requests that expired.
   */
  endSession(): Request[] {
    const expired: Request[] = [];
    for (const request of this.#requests.values()) {
      if (request.status !== "pending" || request.survivesRestart) continue;
      const next: Request = { ...request, status: "expired" };
      this.#requests.set(request.id, next);
      expired.push(next);
    }
    return expired;
  }
}
