// EventGrammar catches each of its six rules in strict, warn and repair mode,
// and passes a valid recorded stream through all three modes unchanged.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AriEventSchema } from "../../src/index.ts";
import type { AriEvent } from "../../src/index.ts";
import { EVENT_GRAMMAR_RULES, EventGrammar, EventGrammarError } from "../../src/host/index.ts";
import type { EventGrammarMode, EventGrammarRule, EventGrammarViolation } from "../../src/host/index.ts";
import { SESSION_ID, THREAD_ID, sessionEvents, sessionSteps, stepIndex, toEvents } from "../fixtures/session-stream.ts";
import type { StreamStep } from "../fixtures/session-stream.ts";

function run(mode: EventGrammarMode, events: readonly AriEvent[]): { output: AriEvent[]; violations: EventGrammarViolation[] } {
  const violations: EventGrammarViolation[] = [];
  const grammar = new EventGrammar({ mode, onViolation: (violation) => violations.push(violation) });
  const output: AriEvent[] = [];
  for (const event of events) {
    const passed = grammar.observe(event);
    if (passed !== undefined) output.push(passed);
  }
  return { output, violations };
}

function insertAfter(steps: StreamStep[], index: number, ...inserted: StreamStep[]): StreamStep[] {
  return [...steps.slice(0, index + 1), ...inserted, ...steps.slice(index + 1)];
}

/** Six streams, each breaking exactly one rule. */
function brokenStreams(): Array<{ rule: EventGrammarRule; events: AriEvent[] }> {
  const steps = sessionSteps();
  const firstTerminal = stepIndex(steps, (body) => body.type === "turn.terminal");
  const item2Settles = stepIndex(steps, (body) => body.type === "item.upsert" && body.item.id === "item-2" && body.item.status === "completed");

  const gap = sessionEvents().map((event) => (event.seq > 10 ? { ...event, seq: event.seq + 1 } : event));

  return [
    {
      rule: "item/opens-before-delta",
      events: toEvents(
        insertAfter(steps, item2Settles, { body: { type: "item.delta", itemId: "item-9", field: "text", chunk: "orphan" }, threadId: THREAD_ID, turnId: "turn-1" }),
      ),
    },
    {
      rule: "item/settles-once",
      events: toEvents(
        insertAfter(steps, item2Settles, { body: { type: "item.upsert", item: { id: "item-2", status: "failed" } }, threadId: THREAD_ID, turnId: "turn-1" }),
      ),
    },
    {
      rule: "turn/starts-once",
      events: toEvents(
        insertAfter(steps, firstTerminal, { body: { type: "turn.upsert", turn: { id: "turn-1", status: "running" } }, threadId: THREAD_ID, turnId: "turn-1" }),
      ),
    },
    {
      rule: "turn/settles-once",
      events: toEvents(insertAfter(steps, firstTerminal, steps[firstTerminal]!)),
    },
    {
      rule: "turn/known",
      events: toEvents(
        insertAfter(steps, firstTerminal, {
          body: { type: "turn.terminal", turnId: "turn-9", status: "failed", threadDisposition: "reusable" },
          threadId: THREAD_ID,
        }),
      ),
    },
    { rule: "seq/gap-free", events: gap },
  ];
}

describe("EventGrammar", () => {
  test("names the six rules", () => {
    assert.deepEqual([...EVENT_GRAMMAR_RULES], [
      "item/opens-before-delta",
      "item/settles-once",
      "turn/starts-once",
      "turn/settles-once",
      "turn/known",
      "seq/gap-free",
    ]);
  });

  test("the valid stream has at least 30 schema-valid events with two turns, deltas, a request and a subagent", () => {
    const events = sessionEvents();
    assert.ok(events.length >= 30, `${events.length} events`);
    for (const event of events) assert.ok(AriEventSchema.is(event), JSON.stringify(event));
    const types = events.map((event) => event.body.type);
    assert.equal(types.filter((type) => type === "turn.terminal").length, 2);
    assert.ok(types.includes("item.delta"));
    assert.ok(types.includes("request.upsert"));
    assert.ok(types.includes("subagent.upsert"));
  });

  for (const mode of ["strict", "warn", "repair"] as const) {
    test(`a valid stream passes ${mode} mode unchanged`, () => {
      const events = sessionEvents();
      const { output, violations } = run(mode, events);
      assert.deepEqual(violations, []);
      assert.deepEqual(output, events);
    });
  }

  for (const { rule, events } of brokenStreams()) {
    describe(`a stream that breaks ${rule}`, () => {
      test("breaks exactly that rule", () => {
        const { violations } = run("warn", events);
        assert.deepEqual(
          violations.map((violation) => violation.rule),
          [rule],
        );
      });

      test("strict mode throws an error naming the rule", () => {
        const grammar = new EventGrammar({ mode: "strict" });
        assert.throws(
          () => {
            for (const event of events) grammar.observe(event);
          },
          (error: unknown) => {
            assert.ok(error instanceof EventGrammarError);
            assert.equal(error.rule, rule);
            assert.ok(error.message.includes(rule), error.message);
            return true;
          },
        );
      });

      test("warn mode reports the rule through the callback and passes every event through", () => {
        const { output, violations } = run("warn", events);
        assert.equal(violations.length, 1);
        assert.equal(violations[0]!.rule, rule);
        assert.equal(output.length, events.length);
        output.forEach((event, index) => assert.equal(event, events[index]));
      });

      test("repair mode yields a stream that strict mode accepts", () => {
        const { output, violations } = run("repair", events);
        assert.deepEqual(
          violations.map((violation) => violation.rule),
          [rule],
        );
        const strict = new EventGrammar({ mode: "strict" });
        for (const event of output) assert.equal(strict.observe(event), event);
        assert.ok(output.length >= events.length - 1);
      });
    });
  }

  test("an envelope naming a turn that never started breaks turn/known, and repair removes the turn id", () => {
    const steps = sessionSteps();
    const index = stepIndex(steps, (body) => body.type === "usage.updated");
    const events = toEvents(insertAfter(steps, index, { body: { type: "notice", level: "info", text: "hi" }, threadId: THREAD_ID, turnId: "turn-9" }));
    assert.deepEqual(
      run("warn", events).violations.map((violation) => violation.rule),
      ["turn/known"],
    );
    const { output } = run("repair", events);
    const notice = output.find((event) => event.body.type === "notice");
    assert.ok(notice !== undefined);
    assert.equal(notice.turnId, undefined);
    assert.equal(notice.threadId, THREAD_ID);
  });

  test("the event that starts a turn may carry its own turn id", () => {
    const events = toEvents([
      { body: { type: "turn.upsert", turn: { id: "turn-1", threadId: THREAD_ID, native: { id: null, strength: "none", ordinal: 0 }, origin: "user", status: "running" } }, turnId: "turn-1" },
      { body: { type: "turn.terminal", turnId: "turn-1", status: "completed", threadDisposition: "reusable" }, turnId: "turn-1" },
    ]);
    assert.deepEqual(run("strict", events).output, events);
  });

  test("a delta after its item settled breaks item/opens-before-delta", () => {
    const steps = sessionSteps();
    const settles = stepIndex(steps, (body) => body.type === "item.upsert" && body.item.id === "item-2" && body.item.status === "completed");
    const events = toEvents(
      insertAfter(steps, settles, { body: { type: "item.delta", itemId: "item-2", field: "text", chunk: " late" }, threadId: THREAD_ID, turnId: "turn-1" }),
    );
    const { violations } = run("warn", events);
    assert.deepEqual(
      violations.map((violation) => violation.rule),
      ["item/opens-before-delta"],
    );
    assert.match(violations[0]!.reason, /after it settled/);
  });

  test("an upsert for a settled item that leaves status alone is allowed; repair strips a status it sets again", () => {
    const steps = sessionSteps();
    const settles = stepIndex(steps, (body) => body.type === "item.upsert" && body.item.id === "item-2" && body.item.status === "completed");
    const retitled = toEvents(insertAfter(steps, settles, { body: { type: "item.upsert", item: { id: "item-2", title: "Answer" } }, threadId: THREAD_ID, turnId: "turn-1" }));
    assert.deepEqual(run("strict", retitled).output, retitled);

    const reopened = toEvents(
      insertAfter(steps, settles, { body: { type: "item.upsert", item: { id: "item-2", status: "running", title: "Answer" } }, threadId: THREAD_ID, turnId: "turn-1" }),
    );
    const repaired = run("repair", reopened).output.find((event) => event.body.type === "item.upsert" && event.body.item.title === "Answer");
    assert.ok(repaired !== undefined && repaired.body.type === "item.upsert");
    assert.deepEqual(repaired.body.item, { id: "item-2", title: "Answer" });
  });

  test("repair renumbers seq after a dropped event so the output stays gap-free", () => {
    const { rule, events } = brokenStreams().find((stream) => stream.rule === "turn/settles-once")!;
    assert.equal(rule, "turn/settles-once");
    const { output } = run("repair", events);
    assert.equal(output.length, events.length - 1);
    output.forEach((event, index) => assert.equal(event.seq, index + 1));
  });

  test("sessions are tracked separately", () => {
    const first = sessionEvents();
    const second = toEvents(sessionSteps(), "session-2");
    const interleaved: AriEvent[] = [];
    first.forEach((event, index) => interleaved.push(event, second[index]!));
    assert.equal(interleaved[0]!.sessionId, SESSION_ID);
    assert.deepEqual(run("strict", interleaved).output, interleaved);
  });

  test("check() filters an async stream", async () => {
    const { events } = brokenStreams().find((stream) => stream.rule === "turn/known")!;
    async function* source(): AsyncGenerator<AriEvent> {
      for (const event of events) yield event;
    }
    const output: AriEvent[] = [];
    for await (const event of new EventGrammar({ mode: "repair" }).check(source())) output.push(event);
    assert.equal(output.length, events.length - 1);
  });
});
