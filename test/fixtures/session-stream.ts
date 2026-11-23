// A recorded session stream that keeps the event grammar: two turns, streamed
// deltas, a command approval request, a subagent and a plan. Each settling
// `item.upsert` carries the item's full text, so the stream folds to the same
// state with or without its deltas. Tests build broken variants by inserting,
// removing or renumbering steps.

import type { AriEvent, AriEventBody } from "../../src/index.ts";
import { fullCapabilities } from "./capabilities.ts";

export const SESSION_ID = "session-1";
export const THREAD_ID = "thread-1";

/** One event before numbering: its body and envelope ids. */
export interface StreamStep {
  readonly body: AriEventBody;
  readonly threadId?: string;
  readonly turnId?: string;
}

const strong = (id: string) => ({ id, strength: "strong" }) as const;

function inTurn(turnId: string, body: AriEventBody): StreamStep {
  return { body, threadId: THREAD_ID, turnId };
}

function inThread(body: AriEventBody): StreamStep {
  return { body, threadId: THREAD_ID };
}

/** The steps of the valid recorded stream, in order. */
export function sessionSteps(): StreamStep[] {
  return [
    { body: { type: "session.state", state: "starting" } },
    { body: { type: "capabilities.updated", capabilities: fullCapabilities() } },
    { body: { type: "session.state", state: "ready" } },
    inThread({ type: "thread.upsert", thread: { id: THREAD_ID, native: strong("n-thread-1"), cwd: "/work", status: "idle" } }),

    // Turn 1: a message, a streamed answer, a command that needs approval.
    inTurn("turn-1", {
      type: "turn.upsert",
      turn: { id: "turn-1", threadId: THREAD_ID, native: strong("n-turn-1"), origin: "user", status: "running", clientTurnKey: "key-1" },
    }),
    inTurn("turn-1", {
      type: "item.upsert",
      item: { id: "item-1", kind: "user_message", native: strong("n-item-1"), status: "completed", turnId: "turn-1", text: "Fix the failing test" },
    }),
    inTurn("turn-1", { type: "item.upsert", item: { id: "item-2", kind: "assistant_message", native: strong("n-item-2"), status: "running", turnId: "turn-1" } }),
    inTurn("turn-1", { type: "item.delta", itemId: "item-2", field: "text", chunk: "I'll look " }),
    inTurn("turn-1", { type: "item.delta", itemId: "item-2", field: "text", chunk: "at the test." }),
    inTurn("turn-1", { type: "item.upsert", item: { id: "item-2", status: "completed", text: "I'll look at the test." } }),
    inTurn("turn-1", {
      type: "item.upsert",
      item: { id: "item-3", kind: "command_execution", native: strong("n-item-3"), status: "running", turnId: "turn-1", command: ["npm", "test"], cwd: "/work" },
    }),
    inTurn("turn-1", {
      type: "request.upsert",
      request: {
        id: "request-1",
        native: strong("n-request-1"),
        kind: "command",
        origin: { threadId: THREAD_ID, turnId: "turn-1", itemId: "item-3" },
        subject: { command: ["npm", "test"], cwd: "/work" },
        options: [
          { optionId: "allow-once", label: "Allow", decision: "accept", scope: "once" },
          { optionId: "deny", label: "Deny", decision: "decline", scope: "once" },
        ],
        allowCustomAnswer: false,
        allowFeedback: true,
        response: { mode: "live" },
        survivesRestart: false,
        status: "pending",
      },
    }),
    inTurn("turn-1", { type: "request.upsert", request: { id: "request-1", status: "resolved" } }),
    inTurn("turn-1", { type: "item.delta", itemId: "item-3", field: "output", chunk: "1 failing\n", stream: "stdout" }),
    inTurn("turn-1", { type: "item.delta", itemId: "item-3", field: "output", chunk: "0 failing\n", stream: "stdout" }),
    inTurn("turn-1", { type: "item.upsert", item: { id: "item-3", status: "completed", exitCode: 0, output: "1 failing\n0 failing\n" } }),
    inTurn("turn-1", { type: "usage.updated", usage: { scope: "turn", inputTokens: 1200, outputTokens: 300 } }),
    inTurn("turn-1", { type: "turn.upsert", turn: { id: "turn-1", status: "completed" } }),
    inTurn("turn-1", { type: "turn.terminal", turnId: "turn-1", status: "completed", threadDisposition: "reusable" }),

    // Turn 2: a subagent, a plan, streamed reasoning and an answer.
    inTurn("turn-2", {
      type: "turn.upsert",
      turn: { id: "turn-2", threadId: THREAD_ID, native: strong("n-turn-2"), origin: "user", status: "running", clientTurnKey: "key-2" },
    }),
    inTurn("turn-2", {
      type: "item.upsert",
      item: { id: "item-4", kind: "user_message", native: strong("n-item-4"), status: "completed", turnId: "turn-2", text: "Now refactor it" },
    }),
    inTurn("turn-2", {
      type: "item.upsert",
      item: { id: "item-5", kind: "subagent_spawn", native: strong("n-item-5"), status: "running", turnId: "turn-2", subagentId: "subagent-1" },
    }),
    inTurn("turn-2", {
      type: "subagent.upsert",
      subagent: { id: "subagent-1", native: strong("n-subagent-1"), parentThreadId: THREAD_ID, status: "running", parentTurnId: "turn-2", name: "explorer" },
    }),
    inTurn("turn-2", {
      type: "plan.upsert",
      plan: {
        id: "plan-1",
        threadId: THREAD_ID,
        turnId: "turn-2",
        entries: [
          { text: "Find callers", status: "in_progress" },
          { text: "Extract helper", status: "pending" },
        ],
      },
    }),
    inTurn("turn-2", { type: "item.upsert", item: { id: "item-6", kind: "reasoning", native: strong("n-item-6"), status: "running", turnId: "turn-2" } }),
    inTurn("turn-2", { type: "item.delta", itemId: "item-6", field: "reasoning", chunk: "Thinking about " }),
    inTurn("turn-2", { type: "item.delta", itemId: "item-6", field: "reasoning", chunk: "the refactor." }),
    inTurn("turn-2", { type: "item.upsert", item: { id: "item-6", status: "completed", reasoning: "Thinking about the refactor." } }),
    inTurn("turn-2", {
      type: "subagent.upsert",
      subagent: { id: "subagent-1", status: "completed", outcome: { status: "completed", summary: "Found 3 callers" } },
    }),
    inTurn("turn-2", { type: "item.upsert", item: { id: "item-5", status: "completed" } }),
    inTurn("turn-2", { type: "item.upsert", item: { id: "item-7", kind: "assistant_message", native: strong("n-item-7"), status: "running", turnId: "turn-2" } }),
    inTurn("turn-2", { type: "item.delta", itemId: "item-7", field: "text", chunk: "Done." }),
    inTurn("turn-2", { type: "item.upsert", item: { id: "item-7", status: "completed", text: "Done." } }),
    inTurn("turn-2", {
      type: "plan.upsert",
      plan: { id: "plan-1", entries: [{ text: "Find callers", status: "completed" }, { text: "Extract helper", status: "completed" }] },
    }),
    inThread({ type: "background.updated", tasks: [] }),
    { body: { type: "limits.updated", limits: { windows: [{ window: "5h", utilization: 0.25 }], limited: false } } },
    inTurn("turn-2", { type: "turn.terminal", turnId: "turn-2", status: "completed", threadDisposition: "reusable" }),
    inThread({ type: "thread.upsert", thread: { id: THREAD_ID, status: "idle", title: "Fix and refactor" } }),
  ];
}

/** Numbers steps into events: seq 1, 2, 3, ... and a fixed clock. */
export function toEvents(steps: readonly StreamStep[], sessionId = SESSION_ID): AriEvent[] {
  return steps.map((step, index) => ({
    seq: index + 1,
    at: new Date(Date.UTC(2026, 10, 23, 12, 0, index)).toISOString(),
    sessionId,
    ...(step.threadId === undefined ? {} : { threadId: step.threadId }),
    ...(step.turnId === undefined ? {} : { turnId: step.turnId }),
    body: step.body,
  }));
}

/** The valid recorded stream as events. */
export function sessionEvents(): AriEvent[] {
  return toEvents(sessionSteps());
}

/** The index of the first step whose body matches `predicate`. Throws when there is none. */
export function stepIndex(steps: readonly StreamStep[], predicate: (body: AriEventBody) => boolean): number {
  const index = steps.findIndex((step) => predicate(step.body));
  if (index === -1) throw new Error("no step matches");
  return index;
}
