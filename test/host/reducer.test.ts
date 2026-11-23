// The event reducer folds a recorded stream into durable session state with
// the patch rules, appends deltas, and reaches the same state when every
// delta is removed, because each settling item.upsert carries the full text.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AriEvent } from "../../src/index.ts";
import { emptyReducedSession, reduceEvent, reduceEvents } from "../../src/host/index.ts";
import { fullCapabilities } from "../fixtures/capabilities.ts";
import { SESSION_ID, THREAD_ID, sessionEvents, toEvents } from "../fixtures/session-stream.ts";

describe("event reducer", () => {
  test("a recorded multi-turn stream folds to the same state with and without its item.delta events", () => {
    const events = sessionEvents();
    const withoutDeltas = events.filter((event) => event.body.type !== "item.delta");
    assert.ok(withoutDeltas.length < events.length - 5, "the stream streams several deltas");

    const full = reduceEvents(events);
    const settledOnly = reduceEvents(withoutDeltas);
    assert.deepEqual(settledOnly, full);
  });

  test("the folded state holds threads, turns, items, requests, subagents, plans, background tasks, usage, limits, capabilities and config", () => {
    const configEvent: AriEvent = {
      seq: 1,
      at: "2026-11-23T11:59:59.000Z",
      sessionId: SESSION_ID,
      body: {
        type: "config.updated",
        options: [{ id: "model", category: "model", label: "Model", type: "select", current: "fast", scope: "thread", changeEffect: "next_turn" }],
      },
    };
    const state = reduceEvents(sessionEvents(), reduceEvent(emptyReducedSession(), configEvent));

    assert.equal(state.sessionId, SESSION_ID);
    assert.equal(state.lastSeq, sessionEvents().length);
    assert.equal(state.state, "ready");
    assert.deepEqual(state.capabilities, fullCapabilities());
    assert.deepEqual(state.configOptions.map((option) => option.id), ["model"]);

    assert.deepEqual(state.threads.get(THREAD_ID), {
      id: THREAD_ID,
      native: { id: "n-thread-1", strength: "strong" },
      cwd: "/work",
      status: "idle",
      title: "Fix and refactor",
    });
    assert.equal(state.turns.get("turn-1")?.status, "completed");
    assert.equal(state.turns.get("turn-2")?.status, "completed");
    assert.equal(state.turnTerminals.get("turn-2")?.threadDisposition, "reusable");

    assert.equal(state.items.size, 7);
    assert.equal(state.items.get("item-2")?.text, "I'll look at the test.");
    assert.equal(state.items.get("item-3")?.output, "1 failing\n0 failing\n");
    assert.equal(state.items.get("item-3")?.exitCode, 0);
    assert.equal(state.items.get("item-3")?.kind, "command_execution");
    assert.equal(state.items.get("item-6")?.reasoning, "Thinking about the refactor.");

    assert.equal(state.requests.get("request-1")?.status, "resolved");
    assert.equal(state.requests.get("request-1")?.options?.length, 2);
    assert.equal(state.subagents.get("subagent-1")?.status, "completed");
    assert.equal(state.subagents.get("subagent-1")?.name, "explorer");
    assert.deepEqual(state.plans.get("plan-1")?.entries.map((entry) => entry.status), ["completed", "completed"]);
    assert.equal(state.plans.get("plan-1")?.turnId, "turn-2");
    assert.deepEqual(state.backgroundTasks, []);
    assert.equal(state.usage?.inputTokens, 1200);
    assert.equal(state.limits?.limited, false);
  });

  test("item.delta appends chunks to the named field while the item is open", () => {
    const events = sessionEvents();
    const secondDelta = events.findIndex((event) => event.body.type === "item.delta" && event.body.chunk === "at the test.");
    const midway = reduceEvents(events.slice(0, secondDelta + 1));
    assert.equal(midway.items.get("item-2")?.text, "I'll look at the test.");
    assert.equal(midway.items.get("item-2")?.status, "running");
  });

  test("a delta for a settled or unknown item is ignored", () => {
    const events = toEvents([
      { body: { type: "item.upsert", item: { id: "item-1", kind: "assistant_message", native: { id: null, strength: "none", ordinal: 0 }, status: "completed", text: "Final." } } },
      { body: { type: "item.delta", itemId: "item-1", field: "text", chunk: " late" } },
      { body: { type: "item.delta", itemId: "item-9", field: "text", chunk: "orphan" } },
    ]);
    const state = reduceEvents(events);
    assert.equal(state.items.get("item-1")?.text, "Final.");
    assert.equal(state.items.has("item-9"), false);
  });

  test("patches follow ACP v2: omitted fields stay, null clears, values replace whole", () => {
    const events = toEvents([
      {
        body: {
          type: "item.upsert",
          item: {
            id: "item-1",
            kind: "mcp_tool_call",
            native: { id: "n-1", strength: "strong" },
            status: "running",
            title: "Search",
            tool: { server: "docs", name: "search", input: { q: "a" } },
          },
        },
      },
      { body: { type: "item.upsert", item: { id: "item-1", title: null, tool: { name: "lookup" } } } },
    ]);
    const item = reduceEvents(events).items.get("item-1");
    assert.deepEqual(item, { id: "item-1", kind: "mcp_tool_call", native: { id: "n-1", strength: "strong" }, status: "running", tool: { name: "lookup" } });
  });

  test("reduceEvent never changes the state it is given", () => {
    const events = sessionEvents();
    let state = emptyReducedSession();
    for (const event of events) {
      const before = state;
      const snapshot = structuredClone(before);
      state = reduceEvent(before, event);
      assert.deepEqual(before, snapshot);
    }
  });

  test("ids that look like object internals are ordinary keys", () => {
    const events = toEvents([
      { body: { type: "item.upsert", item: { id: "__proto__", kind: "error", native: { id: null, strength: "none", ordinal: 0 }, status: "failed" } } },
    ]);
    const state = reduceEvents(events);
    assert.equal(state.items.get("__proto__")?.kind, "error");
  });

  test("thread.upsert keeps the retained native turn ids for rollback reconciliation", () => {
    const events = toEvents([
      { body: { type: "thread.upsert", thread: { id: THREAD_ID, native: { id: "n", strength: "strong" }, cwd: "/w", status: "idle" }, retainedNativeTurnIds: ["n-turn-1"] } },
    ]);
    assert.deepEqual(reduceEvents(events).retainedNativeTurnIds.get(THREAD_ID), ["n-turn-1"]);
  });
});
