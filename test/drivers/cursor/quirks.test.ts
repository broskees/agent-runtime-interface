// The Cursor driver is thin and honest, and keeps Cursor's quirks: it runs in
// process, rejects fork and rollback with `unsupported`, declares no
// approvals and raises no requests; item ids come from positions and kinds
// (Cursor gives messages no ids) and are identical when the same native
// session is replayed; subagents, plan streaming, todo lists and usage are
// mapped; steering, stopping, read-only threads, plan mode, model changes,
// failures and a missing agent behave the way the SDK does.

import "./setup-env.ts";
import assert from "node:assert/strict";
import * as path from "node:path";
import { after, test } from "node:test";
import { READ_ONLY_TOOLS, cursorCapabilities, failureFromRunError } from "../../../src/drivers/cursor/index.ts";
import type { AriEvent, Session } from "../../../src/index.ts";
import { isAriError, toCallError } from "../../../src/index.ts";
import { EventGrammar } from "../../../src/host/event-grammar.ts";
import { reduceEvents } from "../../../src/host/reducer.ts";
import type { FakeRun } from "./fake-sdk.ts";
import { openCursorRig, policy } from "./rig.ts";
import type { CursorTestRig } from "./rig.ts";

const rigs: CursorTestRig[] = [];
after(async () => {
  for (const rig of rigs) await rig.close();
});

async function rig(options: Parameters<typeof openCursorRig>[0] = {}): Promise<CursorTestRig> {
  const opened = await openCursorRig(options);
  rigs.push(opened);
  return opened;
}

/** Throws on the first event that breaks ARI's event grammar. */
function strictGrammar(events: readonly AriEvent[]): void {
  const grammar = new EventGrammar({ mode: "strict" });
  for (const event of events) grammar.observe(event);
}

/** The events without the times they were emitted at and with the rig's own directory as `<root>`: what differs between two runs of one session. */
function timeless(events: readonly AriEvent[], root: string): unknown[] {
  const text = JSON.stringify(events, (key, value: unknown) => (key === "at" || key === "startedAt" || key === "completedAt" || key === "updatedAt" ? undefined : value));
  return JSON.parse(text.split(root).join("<root>")) as unknown[];
}

/** One native session with every kind of item: thinking, text, parallel tools, a streamed plan, todos, a subagent, a steer. */
async function richSession(target: CursorTestRig): Promise<{ events: AriEvent[]; session: Session; threadId: string; turnId: string }> {
  const { session, events } = await target.open();
  const thread = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  const { turnId, run } = await target.turn(session, thread.id, "Plan the work.");
  await run.think("Looking around first.");
  await run.say("Reading two files.");
  // Two tools in parallel: both start, then both complete.
  await run.update({ type: "tool-call-started", callId: "tool_a", toolCall: { type: "read", args: { path: path.join(target.cwd, "README.md") } }, modelCallId: "m1" });
  await run.update({ type: "tool-call-started", callId: "tool_b", toolCall: { type: "grep", args: { pattern: "TODO" } }, modelCallId: "m1" });
  await run.update({ type: "tool-call-completed", callId: "tool_b", toolCall: { type: "grep", args: { pattern: "TODO" }, result: { status: "success", value: {} } }, modelCallId: "m1" });
  await run.update({ type: "tool-call-completed", callId: "tool_a", toolCall: { type: "read", args: { path: path.join(target.cwd, "README.md") }, result: { status: "success", value: { content: "# Project", totalLines: 1, fileSize: 9 } } }, modelCallId: "m1" });
  await run.runTool("tool_plan", { type: "createPlan", args: { plan: "# Plan\n1. Read\n2. Write" }, result: { status: "success", value: {} } }, [{ type: "createPlan", args: { plan: "" } }, { type: "createPlan", args: { plan: "# Plan\n1. Read" } }]);
  await run.runTool(
    "tool_todos",
    { type: "updateTodos", args: { todos: [{ content: "Read", status: "completed" }, { content: "Write", status: "inProgress" }] }, result: { status: "success", value: { todos: [{ content: "Read", status: "completed" }, { content: "Write", status: "inProgress" }], totalCount: 2 } } },
    [{ type: "updateTodos", args: { todos: [{ content: "Read", status: "completed" }] } }],
  );
  await run.runTool("tool_task", { type: "task", args: { description: "Check the tests", prompt: "Run the test suite and report.", subagentType: { kind: "unspecified" }, agentId: "a82c3b84-7d5d-454d-862d-cd679b05d294" }, result: { status: "success", value: { agentId: "a82c3b84-7d5d-454d-862d-cd679b05d294", isBackground: false, backgroundReason: "unspecified" } } });
  const steered = await session.startTurn({ threadId: thread.id, clientTurnKey: "steer-1", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "Also check the docs." }] });
  assert.deepEqual(steered, { status: "accepted", turnId, accepted: "steered" });
  assert.equal(await run.nextSteer(), "Also check the docs.");
  await run.say("All done.");
  await run.endTurn({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0 });
  run.finish();
  assert.equal((await target.terminal(events, turnId)).status, "completed");
  return { events, session, threadId: thread.id, turnId };
}

test("the driver runs in process, rejects fork and rollback with unsupported, and declares no approvals", async () => {
  const capabilities = cursorCapabilities();
  assert.equal(capabilities.sessionModel, "in_process");
  assert.equal(capabilities.externallyOwned, false);
  assert.deepEqual(capabilities.threads.fork, { supported: false, fromTurn: false, fromItem: false, fromSubagent: false, crossCwd: false });
  assert.equal(capabilities.threads.rollback, false);
  assert.equal(capabilities.checkpointing.conversationRollback, false);
  assert.deepEqual(capabilities.approvals, { command: false, fileRead: false, fileChange: false, permission: false, fromSubagents: false });
  assert.equal(capabilities.planning.structuredQuestions, false);
  assert.deepEqual(capabilities.requests, { responseModes: [], allowCustomAnswer: false, approvalScopes: [] });
  assert.deepEqual(capabilities.identity, { threadIds: "strong", turnIds: "strong", itemIds: "weak", requestIds: "none", identityVersion: 1 });

  const target = await rig();
  const { session } = await target.open();
  const thread = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  for (const [call, capability] of [
    [() => session.forkThread!({ threadId: thread.id, at: { type: "latest" } }), "threads.fork"],
    [() => session.forkThread!({ threadId: thread.id, at: { type: "turn", turnId: "turn_x" }, cwd: target.root }), "threads.fork"],
    [() => session.rollbackThread!({ threadId: thread.id, to: { type: "start" } }), "threads.rollback"],
  ] as const) {
    await assert.rejects(call(), (error: unknown) => isAriError(error, "unsupported") && (toCallError(error) as { capability?: string }).capability === capability);
  }
});

test("item, turn, thread, subagent and plan ids are deterministic: replaying the same native session gives identical events", async () => {
  const firstRig = await rig();
  const secondRig = await rig();
  const first = await richSession(firstRig);
  const second = await richSession(secondRig);
  assert.notEqual(firstRig.root, secondRig.root);
  assert.deepEqual(timeless(second.events, secondRig.root), timeless(first.events, firstRig.root));
  // Every stream keeps the grammar, and the ids are the kinds' own.
  strictGrammar(first.events);
  const state = reduceEvents(first.events);
  const items = [...state.items.values()];
  for (const item of items) {
    assert.match(item.id, /^item_[0-9a-f]{32}$/);
    assert.equal(item.native.strength, "weak");
    assert.equal(typeof item.native.ordinal, "number");
    assert.equal(typeof item.native.fingerprint, "string");
  }
  // Ordinals follow the order each item's first update arrived; tools keep Cursor's call id.
  assert.deepEqual(
    items.map((item) => [item.native.ordinal, item.native.fingerprint, item.native.id, item.kind]),
    [
      [0, "user", null, "user_message"],
      [1, "reasoning", null, "reasoning"],
      [2, "assistant", null, "assistant_message"],
      [3, "tool:read", "tool_a", "file_read"],
      [4, "tool:grep", "tool_b", "file_search"],
      [5, "tool:createPlan", "tool_plan", "proposed_plan"],
      [6, "tool:updateTodos", "tool_todos", "todo_list"],
      [7, "tool:task", "tool_task", "subagent_spawn"],
      [8, "user", null, "user_message"],
      [9, "assistant", null, "assistant_message"],
    ],
  );
  const turn = [...state.turns.values()][0]!;
  assert.deepEqual(turn.native, { id: target0RunId(first.events), strength: "strong" });
  assert.equal([...state.requests.values()].length, 0, "Cursor raises no requests");
});

function target0RunId(events: readonly AriEvent[]): string | null {
  for (const event of events) if (event.body.type === "turn.upsert" && event.body.turn.native !== undefined) return event.body.turn.native.id;
  return null;
}

test("subagents, plan streaming, todo lists and usage are mapped", async () => {
  const { events, turnId } = await richSession(await rig());
  const state = reduceEvents(events);
  const items = [...state.items.values()];

  // createPlan streams its plan: the partial updates become plan deltas, then the item holds the whole plan.
  const plan = items.find((item) => item.kind === "proposed_plan")!;
  const planDeltas = events.flatMap((event) => (event.body.type === "item.delta" && event.body.itemId === plan.id ? [[event.body.field, event.body.chunk]] : []));
  assert.deepEqual(planDeltas, [
    ["plan", "# Plan\n1. Read"],
    ["plan", "\n2. Write"],
  ]);
  assert.equal(plan.plan, "# Plan\n1. Read\n2. Write");
  assert.equal(plan.status, "completed");

  // updateTodos is a todo list and the thread's plan.
  const todos = items.find((item) => item.kind === "todo_list")!;
  assert.deepEqual(todos.todos, [
    { text: "Read", status: "completed" },
    { text: "Write", status: "in_progress" },
  ]);
  const plans = [...state.plans.values()];
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.entries, [
    { text: "Read", status: "completed" },
    { text: "Write", status: "in_progress" },
  ]);
  assert.equal(plans[0]!.turnId, turnId);

  // A task call is a subagent: spawned running, completed when the call returns.
  const spawn = items.find((item) => item.kind === "subagent_spawn")!;
  const subagents = [...state.subagents.values()];
  assert.equal(subagents.length, 1);
  assert.deepEqual(
    { id: subagents[0]!.id, status: subagents[0]!.status, name: subagents[0]!.name, prompt: subagents[0]!.prompt, parentItemId: subagents[0]!.parentItemId, parentTurnId: subagents[0]!.parentTurnId },
    { id: spawn.subagentId, status: "completed", name: "Check the tests", prompt: "Run the test suite and report.", parentItemId: spawn.id, parentTurnId: turnId },
  );
  assert.deepEqual(
    events.flatMap((event) => (event.body.type === "subagent.upsert" && event.body.subagent.status !== undefined ? [event.body.subagent.status] : [])),
    ["running", "completed"],
  );
  assert.equal(subagents[0]!.native.id, "a82c3b84-7d5d-454d-862d-cd679b05d294");

  // Usage from turn-ended, with Cursor's own total.
  const usage = events.flatMap((event) => (event.body.type === "usage.updated" ? [event.body.usage] : []));
  assert.deepEqual(usage, [{ scope: "turn", model: "composer-2.5", inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, totalTokens: 120 }]);

  // Text and reasoning streamed, and the delivered steer is a user message.
  const texts = items.filter((item) => item.kind === "assistant_message").map((item) => item.text);
  assert.deepEqual(texts, ["Reading two files.", "All done."]);
  assert.equal(items.find((item) => item.kind === "reasoning")?.reasoning, "Looking around first.");
  assert.deepEqual(
    items.filter((item) => item.kind === "user_message").map((item) => item.text),
    ["Plan the work.", "Also check the docs."],
  );
});

test("a background subagent keeps running after its task call returns and settles with the run", async () => {
  const target = await rig();
  const { session, events } = await target.open();
  const thread = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  const { turnId, run } = await target.turn(session, thread.id, "Work in the background.");
  await run.runTool("tool_bg", { type: "task", args: { description: "Watch the build", prompt: "Watch it." }, result: { status: "success", value: { isBackground: true, backgroundReason: "agentRequest" } } });
  await target.until(events, (event) => (event.body.type === "item.upsert" && event.body.item.status === "completed" && event.body.item.id.startsWith("item_") ? true : undefined), "the task item completed");
  const running = reduceEvents(events).subagents;
  assert.deepEqual([...running.values()].map((subagent) => subagent.status), ["running"]);
  // Cursor's run waits for it: its result comes back as a follow-up turn of the same run.
  await run.say("The build passed.");
  await run.endTurn();
  run.finish();
  assert.equal((await target.terminal(events, turnId)).status, "completed");
  assert.deepEqual([...reduceEvents(events).subagents.values()].map((subagent) => subagent.status), ["completed"]);
});

test("a failed tool, an edit's diff and emitDiffs: false", async () => {
  for (const emitDiffs of [true, false]) {
    const target = await rig();
    const { session, events } = await target.open({ emitDiffs });
    const thread = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
    const { turnId, run } = await target.turn(session, thread.id, "Edit it.");
    const file = path.join(target.cwd, "README.md");
    await run.runTool("tool_edit", { type: "edit", args: { path: file }, result: { status: "success", value: { linesAdded: 1, linesRemoved: 0, diffString: "@@ -1 +1,2 @@\n # Project\n+More\n" } } });
    await run.runTool("tool_shell", { type: "shell", args: { command: "false" }, result: { status: "error", error: { message: "exit 1" } } });
    await run.endTurn();
    run.finish();
    await target.terminal(events, turnId);
    const items = [...reduceEvents(events).items.values()];
    const edit = items.find((item) => item.kind === "file_change")!;
    assert.deepEqual(edit.changes, emitDiffs ? [{ kind: "modify", path: file, diff: "@@ -1 +1,2 @@\n # Project\n+More\n" }] : [{ kind: "modify", path: file }]);
    const shell = items.find((item) => item.kind === "command_execution")!;
    assert.equal(shell.status, "failed");
    assert.deepEqual(shell.error, { message: "exit 1" });
    assert.deepEqual(shell.command, ["false"]);
  }
});

test("a read_only thread offers Cursor only reading tools, on creation and on resume; full_access offers Cursor's default set", async () => {
  const target = await rig();
  const first = await target.open();
  const readOnly = await first.session.createThread({ cwd: target.cwd, policy: policy(target.cwd, "read_only") });
  assert.deepEqual(target.world.creations.at(-1)?.tools, [...READ_ONLY_TOOLS]);
  await first.session.createThread({ cwd: target.cwd, policy: policy(target.cwd, "full_access") });
  assert.equal(target.world.creations.at(-1)?.tools, undefined);
  await first.session.close();
  const second = await target.open();
  await second.session.resumeThread({ native: { handle: readOnly.handle! }, policy: policy(target.cwd, "read_only") });
  assert.deepEqual(target.world.resumes.at(-1)?.options?.tools, [...READ_ONLY_TOOLS]);
  // The fake Cursor refuses a tool the agent does not offer, as Cursor's model is never given it.
  const { run } = await target.turn(second.session, readOnly.id, "Look around.");
  await assert.rejects(run.runTool("tool_x", { type: "shell", args: { command: "rm -rf /" } }), /does not offer the shell tool/);
  await run.runTool("tool_y", { type: "read", args: { path: path.join(target.cwd, "README.md") }, result: { status: "success", value: { content: "# Project", totalLines: 1, fileSize: 9 } } });
});

test("plan mode and a model change reach the run; an unknown model is refused by Cursor", async () => {
  const target = await rig();
  const { session, events } = await target.open();
  const thread = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  const planned = await target.turn(session, thread.id, "Design it.", { policy: policy(target.cwd, "full_access", "plan") });
  assert.equal(target.world.sends.at(-1)?.options?.mode, "plan");
  await planned.run.endTurn();
  planned.run.finish();
  await target.terminal(events, planned.turnId);
  const switched = await target.turn(session, thread.id, "Build it.", { config: { model: "gpt-5.5" } });
  assert.deepEqual(target.world.sends.at(-1)?.options?.model, { id: "gpt-5.5" });
  assert.equal(target.world.sends.at(-1)?.options?.mode, "agent");
  await switched.run.endTurn();
  switched.run.finish();
  await target.terminal(events, switched.turnId);
  assert.deepEqual(await session.planConfigChange({ threadId: thread.id, changes: { model: "composer-2.5" } }), { type: "apply_next_turn" });
  assert.equal((await session.planConfigChange({ threadId: thread.id, changes: { effort: "high" } })).type, "reject");
  await assert.rejects(session.startTurn({ threadId: thread.id, clientTurnKey: "bad", intent: "start", content: [{ type: "text", text: "Go." }], config: { model: "no-such-model" } }), (error: unknown) => isAriError(error, "validation"));
});

test("a steer after the turn ended, or for another turn, is prompt_required; a steer Cursor reverts is prompt_required", async () => {
  const target = await rig();
  const { session, events } = await target.open();
  const thread = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  const first = await target.turn(session, thread.id, "One.");
  assert.deepEqual(await session.startTurn({ threadId: thread.id, clientTurnKey: "s1", intent: "steer", expectedTurnId: "turn_other", content: [{ type: "text", text: "Hm." }] }), { status: "prompt_required" });
  assert.equal(target.world.steers.length, 0, "a steer for another turn never reached Cursor");
  // Cursor's turn ends before the driver hears: Cursor reverts the steer.
  await first.run.endTurn();
  assert.deepEqual(await session.startTurn({ threadId: thread.id, clientTurnKey: "s2", intent: "steer", expectedTurnId: first.turnId, content: [{ type: "text", text: "Late." }] }), { status: "prompt_required" });
  assert.deepEqual(target.world.steers.at(-1), { runId: first.run.id, text: "Late.", outcome: "revert_to_followup" });
  first.run.finish();
  await target.terminal(events, first.turnId);
  assert.deepEqual(await session.startTurn({ threadId: thread.id, clientTurnKey: "s3", intent: "steer", content: [{ type: "text", text: "Later." }] }), { status: "prompt_required" });
  assert.equal(target.world.steers.length, 1);
});

test("Stop cancels the run and the turn ends interrupted; the thread takes the next turn", async () => {
  const target = await rig();
  const { session, events } = await target.open();
  const thread = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  const { turnId, run } = await target.turn(session, thread.id, "Long task.");
  await run.say("Working");
  await session.interruptTurn({ turnId });
  assert.equal(await run.stopRequested(), "cancel");
  assert.equal(run.status, "cancelled");
  run.finishCancelled();
  const terminal = await target.terminal(events, turnId);
  assert.deepEqual({ status: terminal.status, threadDisposition: terminal.threadDisposition }, { status: "interrupted", threadDisposition: "reusable" });
  const next = await target.turn(session, thread.id, "Next.");
  await next.run.endTurn();
  next.run.finish();
  assert.equal((await target.terminal(events, next.turnId)).status, "completed");
});

test("failures are classified from Cursor's error codes; a usage limit has no reset time because Cursor gives none", async () => {
  assert.deepEqual(failureFromRunError({ message: "You've hit your usage limit", code: "PRO_USER_USAGE_LIMIT" }), { class: "usage_limit", message: "You've hit your usage limit", code: "PRO_USER_USAGE_LIMIT", retryable: false });
  assert.equal(failureFromRunError({ message: "slow down", code: "RATE_LIMITED" }).class, "usage_limit");
  assert.equal(failureFromRunError({ message: "slow down", code: "RATE_LIMITED" }).retryable, true);
  assert.equal(failureFromRunError({ message: "x", code: "resource_exhausted" }).class, "usage_limit");
  assert.equal(failureFromRunError({ message: "x", code: "unauthenticated" }).class, "permission_error");
  assert.equal(failureFromRunError({ message: "x", code: "unavailable" }).class, "transport_error");
  assert.equal(failureFromRunError({ message: "x", code: "BAD_MODEL_NAME" }).class, "validation_error");
  assert.equal(failureFromRunError({ message: "x" }).class, "provider_error");

  const target = await rig();
  const { session, events } = await target.open();
  const thread = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  const { turnId, run } = await target.turn(session, thread.id, "Spend.");
  run.fail({ message: "You've hit your usage limit", code: "PRO_USER_USAGE_LIMIT" });
  const terminal = await target.terminal(events, turnId);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.failure?.class, "usage_limit");
  assert.equal(terminal.failure?.resetAt, undefined);
  assert.equal(terminal.threadDisposition, "reusable");
});

test("resuming an agent Cursor does not hold: a fresh agent and session.replaced with a policy; without one, Cursor has no directory to look in", async () => {
  const target = await rig();
  const { session, events } = await target.open();
  const missing = "agent-ffffffff-ffff-4fff-8fff-ffffffffffff";
  // Cursor finds a local agent by its directory, which only a policy gives for a thread this session does not know.
  await assert.rejects(session.resumeThread({ native: { id: missing, strength: "strong" } }), (error: unknown) => isAriError(error, "validation"));
  const known = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  const other = await target.open();
  // An unloaded thread whose agent Cursor no longer holds, resumed without a policy: Cursor's own AgentNotFoundError.
  await session.unloadThread!(known.id);
  target.world.agents.delete(known.native.id!);
  await assert.rejects(session.resumeThread({ native: { handle: known.handle! } }), (error: unknown) => isAriError(error, "not_found"));
  target.world.agents.set(known.native.id!, { agentId: known.native.id!, cwd: target.cwd, prompts: [], replies: [], compactions: 0, finishedRuns: 0, activeRun: undefined, handles: new Set(), subagents: [] });
  const replaced = await session.resumeThread({ native: { id: missing, strength: "strong" }, policy: policy(target.cwd) });
  assert.notEqual(replaced.native.id, missing);
  const event = await target.until(events, (candidate) => (candidate.body.type === "session.replaced" ? candidate : undefined), "session.replaced");
  assert.equal(event.threadId, replaced.id);
  assert.deepEqual({ previousNativeId: (event.body as { previousNativeId?: string }).previousNativeId, contextLost: (event.body as { contextLost: boolean }).contextLost }, { previousNativeId: missing, contextLost: true });
  // The same directory through a link resumes the same agent: Cursor scopes agents by their real directory.
  const linked = await other.session.resumeThread({ native: { handle: known.handle! }, policy: policy(target.linkedCwd) });
  assert.equal(linked.id, known.id);
  assert.equal(linked.cwd, target.cwd);
});

test("a run that reaches the driver's turn before send() resolves keeps every update", async () => {
  const target = await rig();
  const { session, events } = await target.open();
  const thread = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  // Updates the fake sends synchronously from inside send(), before the driver has the run.
  const original = target.world.startRun.bind(target.world);
  target.world.startRun = (agent, message, options) => {
    const run: FakeRun = original(agent, message, options);
    void run.say("Early words.");
    return run;
  };
  const { turnId, run } = await target.turn(session, thread.id, "Hurry.");
  target.world.startRun = original;
  await run.endTurn();
  run.finish();
  await target.terminal(events, turnId);
  assert.deepEqual(
    [...reduceEvents(events).items.values()].filter((item) => item.kind === "assistant_message").map((item) => item.text),
    ["Early words."],
  );
  strictGrammar(events);
});
