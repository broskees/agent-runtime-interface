// The request ledger sends each (requestId, responseKey) to the session once,
// refuses a second answer, expires only requests that cannot survive a
// restart, and never drops a request because a later window lacks it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isAriError } from "../../src/index.ts";
import type { AriEvent, Request, RespondInput, RespondResult } from "../../src/index.ts";
import { RequestLedger } from "../../src/host/index.ts";
import { THREAD_ID, sessionEvents, toEvents } from "../fixtures/session-stream.ts";

function request(overrides: Partial<Request> & { id: string }): Request {
  return {
    native: { id: `n-${overrides.id}`, strength: "strong" },
    kind: "command",
    origin: { threadId: THREAD_ID, turnId: "turn-1" },
    options: [{ optionId: "allow", label: "Allow", decision: "accept", scope: "once" }],
    allowCustomAnswer: false,
    allowFeedback: false,
    response: { mode: "live" },
    survivesRestart: false,
    status: "pending",
    ...overrides,
  };
}

function upsert(value: Request, seq = 1): AriEvent {
  return { seq, at: "2026-11-23T12:00:00.000Z", sessionId: "session-1", threadId: THREAD_ID, body: { type: "request.upsert", request: value } };
}

/** A session whose respond calls are counted and settle when the test says so. */
function countingSession(): {
  session: { respond(input: RespondInput): Promise<RespondResult | void> };
  calls: RespondInput[];
  settle(result?: RespondResult, error?: Error): void;
} {
  const calls: RespondInput[] = [];
  const waiting: Array<{ resolve: (value: RespondResult | void) => void; reject: (error: Error) => void }> = [];
  return {
    calls,
    session: {
      respond(input) {
        calls.push(input);
        return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
      },
    },
    settle(result, error) {
      const next = waiting.shift()!;
      if (error !== undefined) next.reject(error);
      else next.resolve(result);
    },
  };
}

function isInvalidState(error: unknown): boolean {
  return isAriError(error, "invalid_state");
}

describe("request ledger", () => {
  test("two responses with the same (requestId, responseKey) reach the session once and both get the first result", async () => {
    const ledger = new RequestLedger();
    ledger.observe(upsert(request({ id: "request-1" })));
    const { session, calls, settle } = countingSession();

    const first = ledger.respond(session, { requestId: "request-1", responseKey: "key-a", optionId: "allow" });
    const second = ledger.respond(session, { requestId: "request-1", responseKey: "key-a", optionId: "allow" });
    await Promise.resolve();
    settle({ followUpPrompt: [{ type: "text", text: "go" }] });

    assert.deepEqual(await first, { followUpPrompt: [{ type: "text", text: "go" }] });
    assert.deepEqual(await second, { followUpPrompt: [{ type: "text", text: "go" }] });
    const third = await ledger.respond(session, { requestId: "request-1", responseKey: "key-a", optionId: "allow" });
    assert.deepEqual(third, { followUpPrompt: [{ type: "text", text: "go" }] });
    assert.equal(calls.length, 1);
    assert.equal(ledger.get("request-1")?.status, "resolved");
  });

  test("a different responseKey for a resolved request is refused with invalid_state", async () => {
    const ledger = new RequestLedger();
    ledger.observe(upsert(request({ id: "request-1" })));
    const { session, calls, settle } = countingSession();
    const first = ledger.respond(session, { requestId: "request-1", responseKey: "key-a", optionId: "allow" });
    await Promise.resolve();
    settle();
    await first;

    await assert.rejects(ledger.respond(session, { requestId: "request-1", responseKey: "key-b", optionId: "allow" }), isInvalidState);
    assert.equal(calls.length, 1);

    // The same holds when the driver reported the request resolved on its own.
    ledger.observe(upsert(request({ id: "request-2", status: "resolved" }), 2));
    await assert.rejects(ledger.respond(session, { requestId: "request-2", responseKey: "key-c", optionId: "allow" }), isInvalidState);
    assert.equal(calls.length, 1);
  });

  test("a different responseKey while a response is in flight is refused; after a failure a new key may retry, the failed key may not resend", async () => {
    const ledger = new RequestLedger();
    ledger.observe(upsert(request({ id: "request-1" })));
    const { session, calls, settle } = countingSession();
    const first = ledger.respond(session, { requestId: "request-1", responseKey: "key-a", optionId: "allow" });
    await assert.rejects(ledger.respond(session, { requestId: "request-1", responseKey: "key-b", optionId: "allow" }), isInvalidState);
    await Promise.resolve();
    settle(undefined, new Error("pipe closed"));
    await assert.rejects(first, /pipe closed/);
    await assert.rejects(ledger.respond(session, { requestId: "request-1", responseKey: "key-a", optionId: "allow" }), /pipe closed/);
    assert.equal(calls.length, 1);
    assert.equal(ledger.get("request-1")?.status, "pending");

    const retry = ledger.respond(session, { requestId: "request-1", responseKey: "key-c", optionId: "allow" });
    await Promise.resolve();
    settle();
    await retry;
    assert.equal(calls.length, 2);
  });

  test("on session end a pending request with survivesRestart: false becomes expired", () => {
    const ledger = new RequestLedger();
    ledger.observe(upsert(request({ id: "request-1", survivesRestart: false })));
    const expired = ledger.endSession();
    assert.deepEqual(expired.map((value) => value.id), ["request-1"]);
    assert.equal(ledger.get("request-1")?.status, "expired");
    assert.deepEqual(ledger.pending(), []);
  });

  test("a message-mode request with survivesRestart: true stays pending across session end and can still be answered", async () => {
    const ledger = new RequestLedger();
    ledger.observe(
      upsert(
        request({
          id: "question-1",
          kind: "user_input",
          options: undefined,
          questions: [{ id: "q1", type: "text", prompt: "Which branch?" }],
          response: { mode: "message" },
          survivesRestart: true,
        }),
      ),
    );
    ledger.observe(upsert(request({ id: "request-2", survivesRestart: false }), 2));
    ledger.observe({ seq: 3, at: "2026-11-23T12:00:03.000Z", sessionId: "session-1", body: { type: "session.state", state: "stopped" } });

    assert.equal(ledger.get("question-1")?.status, "pending");
    assert.equal(ledger.get("request-2")?.status, "expired");

    // A later session answers it.
    const { session, calls, settle } = countingSession();
    const answer = ledger.respond(session, { requestId: "question-1", responseKey: "key-a", answers: { q1: { text: "main" } } });
    await Promise.resolve();
    settle();
    await answer;
    assert.equal(calls.length, 1);
  });

  test("a request absent from a later event window or snapshot is not removed", () => {
    const ledger = new RequestLedger();
    ledger.observe(upsert(request({ id: "request-1", survivesRestart: true })));
    // A later window of the stream (as after a reconnect) that never mentions request-1.
    for (const event of sessionEvents().slice(20)) ledger.observe(event);
    ledger.observeSnapshot({
      thread: { id: THREAD_ID, native: { id: "n", strength: "strong" }, cwd: "/work", status: "idle" },
      turns: [],
      items: [],
      requests: [request({ id: "request-3" })],
    });
    assert.equal(ledger.get("request-1")?.status, "pending");
    assert.deepEqual(ledger.list().map((value) => value.id), ["request-1", "request-3"]);
  });

  test("request.upsert patches are folded with the patch rules", () => {
    const ledger = new RequestLedger();
    for (const event of toEvents([
      { body: { type: "request.upsert", request: request({ id: "request-1", subject: { command: ["ls"] } }) } },
      { body: { type: "request.upsert", request: { id: "request-1", subject: null, fullAccessOverride: "ask_rule" } } },
    ])) {
      ledger.observe(event);
    }
    const stored = ledger.get("request-1");
    assert.equal(stored?.subject, undefined);
    assert.equal(stored?.fullAccessOverride, "ask_rule");
    assert.equal(stored?.kind, "command");
  });

  test("an unknown request is refused with not_found and a not_resumable one with invalid_state", async () => {
    const ledger = new RequestLedger({ requests: [request({ id: "request-9", response: { mode: "not_resumable", reason: "process exited" } })] });
    const { session, calls } = countingSession();
    await assert.rejects(ledger.respond(session, { requestId: "nope", responseKey: "k" }), (error: unknown) => isAriError(error, "not_found"));
    await assert.rejects(ledger.respond(session, { requestId: "request-9", responseKey: "k" }), isInvalidState);
    assert.equal(calls.length, 0);
  });
});
