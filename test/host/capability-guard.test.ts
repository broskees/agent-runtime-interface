// The capability guard refuses capability-gated calls whose capability is off
// without reaching the driver, and planFallback returns, without executing
// anything, the host-side plan the capabilities allow.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isAriError } from "../../src/index.ts";
import type { Capabilities, Session } from "../../src/index.ts";
import { guardSession, planFallback } from "../../src/host/index.ts";
import { fullCapabilities } from "../fixtures/capabilities.ts";
import { fakeSession } from "../fixtures/fake-session.ts";

function capabilitiesWith(edit: (capabilities: Capabilities) => void): Capabilities {
  const capabilities = fullCapabilities();
  edit(capabilities);
  return capabilities;
}

/** Every capability the guard checks turned off. */
function allGatesOff(): Capabilities {
  return capabilitiesWith((capabilities) => {
    capabilities.threads.readSnapshot = false;
    capabilities.threads.fork = { supported: false, fromTurn: false, fromItem: false, fromSubagent: false, crossCwd: false };
    capabilities.threads.rollback = false;
    capabilities.threads.compact = false;
    capabilities.threads.injectHistory = false;
    capabilities.threads.unload = false;
    capabilities.background = { list: false, stop: false, await: false, tasksEndWithProcess: true };
    capabilities.subagents.stop = false;
    capabilities.tools.mcpApps = false;
    capabilities.contextWindowReporting = false;
    capabilities.sessions.contextUsageReuse = false;
    capabilities.sessions.feedbackUpload = false;
    capabilities.extensions = [];
    capabilities.turns.steer = false;
    capabilities.turns.queue = false;
  });
}

/** Each gated call and the capability path its refusal must name. */
const GATED_CALLS: Array<{ capability: string; call: (session: Session) => unknown }> = [
  { capability: "threads.readSnapshot", call: (session) => session.readSnapshot!("thread-1") },
  { capability: "threads.fork", call: (session) => session.forkThread!({ threadId: "thread-1", at: { type: "latest" } }) },
  { capability: "threads.rollback", call: (session) => session.rollbackThread!({ threadId: "thread-1", to: { type: "start" } }) },
  { capability: "threads.compact", call: (session) => session.compactThread!("thread-1") },
  { capability: "threads.injectHistory", call: (session) => session.injectHistory!({ threadId: "thread-1", messages: [], summary: "s" }) },
  { capability: "threads.unload", call: (session) => session.unloadThread!("thread-1") },
  { capability: "background.list", call: (session) => session.backgroundTasks!.list("thread-1") },
  { capability: "background.stop", call: (session) => session.backgroundTasks!.stop({ threadId: "thread-1", taskId: "task-1" }) },
  { capability: "background.await", call: (session) => session.backgroundTasks!.await({ threadId: "thread-1", taskIds: ["task-1"], awaited: true }) },
  { capability: "subagents.stop", call: (session) => session.stopSubagent!({ subagentId: "subagent-1" }) },
  { capability: "tools.mcpApps", call: (session) => session.mcpApps!.listTools("thread-1", "docs") },
  { capability: "tools.mcpApps", call: (session) => session.mcpApps!.callTool("thread-1", "docs", "search", { q: "x" }) },
  { capability: "tools.mcpApps", call: (session) => session.mcpApps!.readResource("thread-1", "docs", "file:///a") },
  { capability: "sessions.feedbackUpload", call: (session) => session.uploadFeedback!({ threadId: "thread-1" }) },
  { capability: "extensions.ari.goal", call: (session) => session.ext!("ari.goal", "get", {}) },
  { capability: "contextWindowReporting", call: (session) => session.contextWindow!("fast") },
  { capability: "sessions.contextUsageReuse", call: (session) => session.canReuseContextUsage!("fast", "slow") },
];

async function refusal(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("capability guard", () => {
  test("each gated call whose capability is off rejects with unsupported{capability} and never reaches the driver", async () => {
    const driver = fakeSession(allGatesOff());
    const guarded = guardSession(driver);
    for (const { capability, call } of GATED_CALLS) {
      const error = await refusal(() => call(guarded));
      assert.ok(isAriError(error, "unsupported"), `${capability}: ${String(error)}`);
      assert.equal(error.callError.code === "unsupported" ? error.callError.capability : undefined, capability);
    }
    assert.deepEqual(driver.calls, []);
  });

  test("each gated call whose capability is on reaches the driver", async () => {
    const capabilities = capabilitiesWith((value) => {
      value.threads.rollback = true;
      value.threads.injectHistory = true;
      value.background.await = true;
      value.sessions.feedbackUpload = true;
    });
    const driver = fakeSession(capabilities);
    const guarded = guardSession(driver);
    await guarded.createThread({ cwd: "/work", policy: { mode: "approval_required", interaction: "default", cwd: "/work" } });
    for (const { call } of GATED_CALLS) await call(guarded);
    assert.deepEqual(
      driver.calls.slice(1).map((entry) => entry.member),
      [
        "readSnapshot",
        "forkThread",
        "rollbackThread",
        "compactThread",
        "injectHistory",
        "unloadThread",
        "backgroundTasks.list",
        "backgroundTasks.stop",
        "backgroundTasks.await",
        "stopSubagent",
        "mcpApps.listTools",
        "mcpApps.callTool",
        "mcpApps.readResource",
        "uploadFeedback",
        "ext",
        "contextWindow",
        "canReuseContextUsage",
      ],
    );
  });

  test("forking from a turn or an item needs fromTurn or fromItem", async () => {
    const driver = fakeSession(capabilitiesWith((value) => (value.threads.fork = { supported: true, fromTurn: false, fromItem: true, fromSubagent: false, crossCwd: false })));
    const guarded = guardSession(driver);
    const error = await refusal(() => guarded.forkThread!({ threadId: "thread-1", at: { type: "turn", turnId: "turn-1" } }));
    assert.ok(isAriError(error, "unsupported"));
    assert.equal(error.callError.code === "unsupported" ? error.callError.capability : undefined, "threads.fork.fromTurn");
    await guarded.forkThread!({ threadId: "thread-1", at: { type: "item", itemId: "item-1" } });
    assert.deepEqual(driver.calls.map((entry) => entry.member), ["forkThread"]);
  });

  test("a steer or queue the capabilities do not allow answers unsupported without reaching the driver", async () => {
    const driver = fakeSession(allGatesOff());
    const guarded = guardSession(driver);
    const base = { threadId: "thread-1", clientTurnKey: "key", content: [{ type: "text" as const, text: "hi" }] };
    assert.deepEqual(await guarded.startTurn({ ...base, intent: "steer", expectedTurnId: "turn-1" }), { status: "unsupported", capability: "turns.steer" });
    assert.deepEqual(await guarded.startTurn({ ...base, intent: "queue" }), { status: "unsupported", capability: "turns.queue" });
    assert.equal(driver.calls.length, 0);
    const started = await guarded.startTurn({ ...base, intent: "start" });
    assert.equal(started.status, "accepted");
    assert.deepEqual(driver.calls.map((entry) => entry.member), ["startTurn"]);
  });

  test("a capabilities change applies to the next call", async () => {
    const driver = fakeSession(allGatesOff());
    const guarded = guardSession(driver);
    assert.ok(isAriError(await refusal(() => guarded.compactThread!("thread-1")), "unsupported"));
    driver.setCapabilities(capabilitiesWith((value) => (value.threads.compact = true)));
    await guarded.compactThread!("thread-1");
    assert.deepEqual(driver.calls.map((entry) => entry.member), ["compactThread"]);
  });

  test("members the driver leaves out stay absent, and the rest pass through", async () => {
    const { compactThread: _compact, mcpApps: _mcpApps, ...partial } = fakeSession(fullCapabilities());
    const guarded = guardSession(partial);
    assert.equal(guarded.compactThread, undefined);
    assert.equal(guarded.mcpApps, undefined);
    assert.equal(guarded.id, partial.id);
    assert.equal(guarded.canRelease(), true);
    assert.deepEqual(await guarded.planConfigChange({ threadId: "thread-1", changes: { model: "slow" } }), { type: "apply_next_turn" });
  });
});

describe("planFallback", () => {
  const steerOff = (queue: boolean): Capabilities =>
    capabilitiesWith((value) => {
      value.turns.steer = false;
      value.turns.queue = queue;
    });

  test("steer unsupported with a native queue: queue the message", () => {
    const plan = planFallback(steerOff(true), { kind: "steer", outcome: "unsupported", threadId: "thread-1", turnId: "turn-1" });
    assert.equal(plan.native, false);
    assert.deepEqual(plan.steps, [{ action: "start_turn", threadId: "thread-1", intent: "queue" }]);
  });

  test("steer unsupported without a native queue: wait for the turn to settle, then start a turn", () => {
    const plan = planFallback(steerOff(false), { kind: "steer", outcome: "unsupported", threadId: "thread-1", turnId: "turn-1" });
    assert.deepEqual(plan.steps, [
      { action: "wait_for_turn_terminal", turnId: "turn-1" },
      { action: "start_turn", threadId: "thread-1", intent: "start" },
    ]);
  });

  test("steer answered prompt_required: send the message as a normal turn", () => {
    const plan = planFallback(fullCapabilities(), { kind: "steer", outcome: "prompt_required", threadId: "thread-1", turnId: "turn-1" });
    assert.deepEqual(plan.steps, [{ action: "start_turn", threadId: "thread-1", intent: "start" }]);
  });

  test("fork supported natively for this point: one native call", () => {
    const plan = planFallback(fullCapabilities(), { kind: "fork", threadId: "thread-1", at: { type: "turn", turnId: "turn-1" } });
    assert.equal(plan.native, true);
    assert.deepEqual(plan.steps, [{ action: "fork_thread", threadId: "thread-1", at: { type: "turn", turnId: "turn-1" } }]);
  });

  test("fork unsupported: read history up to the point, create a thread and seed it the way the capabilities allow", () => {
    const noFork = capabilitiesWith((value) => {
      value.threads.fork.supported = false;
      value.threads.readSnapshot = true;
      value.threads.injectHistory = true;
    });
    const plan = planFallback(noFork, { kind: "fork", threadId: "thread-1", at: { type: "turn", turnId: "turn-1" }, sourceCwd: "/work" });
    assert.equal(plan.native, false);
    assert.deepEqual(plan.steps, [
      { action: "read_history", threadId: "thread-1", source: "provider_snapshot", upTo: { type: "turn", turnId: "turn-1" } },
      { action: "create_thread", cwd: "/work" },
      { action: "seed_history", method: "inject_history" },
    ]);

    const bare = capabilitiesWith((value) => {
      value.threads.fork.supported = false;
      value.threads.readSnapshot = false;
      value.threads.injectHistory = false;
    });
    assert.deepEqual(planFallback(bare, { kind: "fork", threadId: "thread-1", at: { type: "latest" } }).steps, [
      { action: "read_history", threadId: "thread-1", source: "host_transcript", upTo: { type: "latest" } },
      { action: "create_thread" },
      { action: "seed_history", method: "first_user_message" },
    ]);
  });

  test("fork into another directory without crossCwd is planned host-side", () => {
    const plan = planFallback(fullCapabilities(), { kind: "fork", threadId: "thread-1", at: { type: "latest" }, cwd: "/elsewhere", sourceCwd: "/work" });
    assert.equal(plan.native, false);
    assert.deepEqual(plan.steps[1], { action: "create_thread", cwd: "/elsewhere" });
  });

  test("rollback unsupported but fork from a turn supported: continue in a fork at the target turn", () => {
    const capabilities = capabilitiesWith((value) => (value.threads.rollback = false));
    const plan = planFallback(capabilities, { kind: "rollback", threadId: "thread-1", to: { type: "turn", turnId: "turn-2" } });
    assert.equal(plan.native, false);
    assert.deepEqual(plan.steps, [
      { action: "fork_thread", threadId: "thread-1", at: { type: "turn", turnId: "turn-2" } },
      { action: "switch_thread", fromThreadId: "thread-1" },
    ]);
  });

  test("rollback and fork from a turn both unsupported: a new thread seeded with the history up to the target", () => {
    const capabilities = capabilitiesWith((value) => {
      value.threads.rollback = false;
      value.threads.fork.fromTurn = false;
      value.threads.readSnapshot = false;
      value.threads.injectHistory = true;
    });
    const plan = planFallback(capabilities, { kind: "rollback", threadId: "thread-1", to: { type: "turn", turnId: "turn-2" }, cwd: "/work" });
    assert.deepEqual(plan.steps, [
      { action: "read_history", threadId: "thread-1", source: "host_transcript", upTo: { type: "turn", turnId: "turn-2" } },
      { action: "create_thread", cwd: "/work" },
      { action: "seed_history", method: "inject_history" },
      { action: "switch_thread", fromThreadId: "thread-1" },
    ]);
  });

  test("rollback unsupported to the start: a fresh thread", () => {
    const capabilities = capabilitiesWith((value) => (value.threads.rollback = false));
    const plan = planFallback(capabilities, { kind: "rollback", threadId: "thread-1", to: { type: "start" } });
    assert.deepEqual(plan.steps, [{ action: "create_thread" }, { action: "switch_thread", fromThreadId: "thread-1" }]);
  });

  test("rollback supported natively: one native call", () => {
    const capabilities = capabilitiesWith((value) => (value.threads.rollback = true));
    const plan = planFallback(capabilities, { kind: "rollback", threadId: "thread-1", to: { type: "start" } });
    assert.equal(plan.native, true);
    assert.deepEqual(plan.steps, [{ action: "rollback_thread", threadId: "thread-1", to: { type: "start" } }]);
  });

  test("planning calls nothing on a session", () => {
    const driver = fakeSession(allGatesOff());
    planFallback(driver.capabilities(), { kind: "rollback", threadId: "thread-1", to: { type: "turn", turnId: "turn-1" } });
    planFallback(driver.capabilities(), { kind: "fork", threadId: "thread-1", at: { type: "latest" } });
    assert.deepEqual(driver.calls, []);
  });
});
