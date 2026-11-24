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
import type { FakeSession } from "../fixtures/fake-session.ts";

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
      value.context.handoffSummaries = true;
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

  test("a cross-directory fork with crossCwd off rejects with unsupported naming threads.fork.crossCwd and never reaches the driver", async () => {
    const capabilities = fullCapabilities();
    assert.equal(capabilities.threads.fork.supported, true);
    assert.equal(capabilities.threads.fork.crossCwd, false);
    const driver = fakeSession(capabilities);
    const guarded = guardSession(driver);
    const thread = await guarded.createThread({ cwd: "/work/project", policy: { mode: "approval_required", interaction: "default", cwd: "/work/project" } });

    const error = await refusal(() => guarded.forkThread!({ threadId: thread.id, at: { type: "latest" }, cwd: "/work/other-project" }));
    assert.ok(isAriError(error, "unsupported"), String(error));
    assert.equal(error.callError.code === "unsupported" ? error.callError.capability : undefined, "threads.fork.crossCwd");
    assert.deepEqual(driver.calls.map((entry) => entry.member), ["createThread"]);

    // A thread the guard has not seen has no known directory, so naming one is refused too.
    const unknown = await refusal(() => guarded.forkThread!({ threadId: "thread-elsewhere", at: { type: "latest" }, cwd: "/work/project" }));
    assert.ok(isAriError(unknown, "unsupported"));
    assert.deepEqual(driver.calls.map((entry) => entry.member), ["createThread"]);

    // The same directory, or no directory, is not a cross-directory fork.
    await guarded.forkThread!({ threadId: thread.id, at: { type: "latest" }, cwd: "/work/project" });
    await guarded.forkThread!({ threadId: "thread-elsewhere", at: { type: "latest" } });
    assert.deepEqual(driver.calls.map((entry) => entry.member), ["createThread", "forkThread", "forkThread"]);
  });

  test("the guard learns thread directories from thread.upsert events read through it", async () => {
    const driver = fakeSession(fullCapabilities());
    const guarded = guardSession(driver);
    driver.sequencer.emit({ body: { type: "thread.upsert", thread: { id: "thread-9", native: { id: "n9", strength: "strong" }, cwd: "/work/nine", status: "idle" } } });
    const stream = guarded.events();
    await stream[Symbol.asyncIterator]().next();
    await guarded.forkThread!({ threadId: "thread-9", at: { type: "latest" }, cwd: "/work/nine" });
    assert.deepEqual(driver.calls.map((entry) => entry.member), ["forkThread"]);
  });

  test("forking a subagent's thread with fromSubagent off rejects with unsupported naming threads.fork.fromSubagent and never reaches the driver", async () => {
    const capabilities = capabilitiesWith((value) => (value.threads.fork = { supported: true, fromTurn: true, fromItem: true, fromSubagent: false, crossCwd: false }));
    const driver = fakeSession(capabilities);
    const guarded = guardSession(driver);
    driver.sequencer.emit({
      threadId: "thread-review",
      body: {
        type: "thread.upsert",
        thread: { id: "thread-review", native: { id: "n-review", strength: "strong" }, cwd: "/work", status: "idle", subagentId: "review-agent", parentThreadId: "thread-parent" },
      },
    });
    // A subagent.upsert naming its thread marks that thread too.
    driver.sequencer.emit({
      body: { type: "subagent.upsert", subagent: { id: "explore-agent", native: { id: "n-explore", strength: "strong" }, parentThreadId: "thread-parent", status: "running", threadId: "thread-explore" } },
    });
    const stream = guarded.events()[Symbol.asyncIterator]();
    await stream.next();
    await stream.next();

    for (const threadId of ["thread-review", "thread-explore"]) {
      const error = await refusal(() => guarded.forkThread!({ threadId, at: { type: "latest" } }));
      assert.ok(isAriError(error, "unsupported"), `${threadId}: ${String(error)}`);
      assert.equal(error.callError.code === "unsupported" ? error.callError.capability : undefined, "threads.fork.fromSubagent");
    }
    assert.equal(driver.calls.length, 0);

    driver.setCapabilities(capabilitiesWith((value) => (value.threads.fork.fromSubagent = true)));
    await guarded.forkThread!({ threadId: "thread-review", at: { type: "latest" } });
    assert.deepEqual(driver.calls.map((entry) => entry.member), ["forkThread"]);
  });

  test("replaying an older thread.upsert does not bring back an older directory", async () => {
    const driver = fakeSession(fullCapabilities());
    const guarded = guardSession(driver);
    const thread = await guarded.createThread({ cwd: "/work/original", policy: { mode: "approval_required", interaction: "default", cwd: "/work/original" } });
    driver.sequencer.emit({ threadId: thread.id, body: { type: "thread.upsert", thread: { id: thread.id, cwd: "/work/new" } } });
    const live = guarded.events()[Symbol.asyncIterator]();
    await live.next();
    await live.next();

    const fork = () => guarded.forkThread!({ threadId: thread.id, at: { type: "latest" }, cwd: "/work/original" });
    const before = await refusal(fork);
    assert.ok(isAriError(before, "unsupported"));
    assert.equal(before.callError.code === "unsupported" ? before.callError.capability : undefined, "threads.fork.crossCwd");

    // A reconnect that replays seq 1, which still says /work/original.
    const replay = guarded.events({ fromSeq: 1 })[Symbol.asyncIterator]();
    await replay.next();
    const after = await refusal(fork);
    assert.ok(isAriError(after, "unsupported"), `the replayed seq 1 let the fork through: ${String(after)}`);
    assert.equal(after.callError.code === "unsupported" ? after.callError.capability : undefined, "threads.fork.crossCwd");
    assert.deepEqual(driver.calls.map((entry) => entry.member), ["createThread"]);
  });

  test("a backfilled earlier window adds threads it introduces but never overwrites newer facts", async () => {
    const driver = fakeSession(fullCapabilities());
    const guarded = guardSession(driver);
    const native = { id: "n", strength: "strong" } as const;
    driver.sequencer.emit({ body: { type: "thread.upsert", thread: { id: "thread-a", native, cwd: "/a/old", status: "idle" } } });
    driver.sequencer.emit({ body: { type: "thread.upsert", thread: { id: "thread-b", native, cwd: "/b", status: "idle", subagentId: "helper" } } });
    driver.sequencer.emit({ body: { type: "thread.upsert", thread: { id: "thread-a", cwd: "/a/new" } } });

    // The tail first (seq 3), then the earlier window (seq 1 and 2).
    const tail = guarded.events({ fromSeq: 3 })[Symbol.asyncIterator]();
    await tail.next();
    const backfill = guarded.events({ fromSeq: 1 })[Symbol.asyncIterator]();
    await backfill.next();
    await backfill.next();

    await guarded.forkThread!({ threadId: "thread-a", at: { type: "latest" }, cwd: "/a/new" });
    assert.deepEqual(driver.calls.map((entry) => entry.member), ["forkThread"]);
    const older = await refusal(() => guarded.forkThread!({ threadId: "thread-a", at: { type: "latest" }, cwd: "/a/old" }));
    assert.equal(isAriError(older, "unsupported") && older.callError.code === "unsupported" ? older.callError.capability : undefined, "threads.fork.crossCwd");
    const subagent = await refusal(() => guarded.forkThread!({ threadId: "thread-b", at: { type: "latest" } }));
    assert.equal(isAriError(subagent, "unsupported") && subagent.callError.code === "unsupported" ? subagent.callError.capability : undefined, "threads.fork.fromSubagent");
    assert.deepEqual(driver.calls.map((entry) => entry.member), ["forkThread"]);
  });

  test("with crossCwd on, a cross-directory fork reaches the driver", async () => {
    const capabilities = capabilitiesWith((value) => (value.threads.fork.crossCwd = true));
    const driver = fakeSession(capabilities);
    const guarded = guardSession(driver);
    const thread = await guarded.createThread({ cwd: "/work/project", policy: { mode: "approval_required", interaction: "default", cwd: "/work/project" } });
    await guarded.forkThread!({ threadId: thread.id, at: { type: "latest" }, cwd: "/work/other-project" });
    assert.deepEqual(driver.calls.map((entry) => entry.member), ["createThread", "forkThread"]);
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

/** Every capability the argument and thread-state gates read, turned on. */
function argumentGatesOn(): Capabilities {
  return capabilitiesWith((value) => {
    for (const mode of ["read_only", "approval_required", "auto_accept_edits", "auto", "full_access"] as const) {
      value.runtimePolicy.modes[mode] = { supported: true, enforcement: "native" };
    }
    value.runtimePolicy.interactionModes = ["default", "plan"];
    value.runtimePolicy.switchInSession = true;
    value.sessions.switchRuntimeMode = true;
    value.sessions.multipleThreads = true;
    value.sessions.release = true;
    value.context.instructionChannels = ["system", "developer"];
    value.context.syntheticContext = true;
    value.context.handoffSummaries = true;
    value.tools.mcp = true;
    value.tools.dynamicTools = true;
    value.mcp.acceptsHostServers = ["stdio", "http", "sse"];
    value.threads.rollback = true;
    value.threads.injectHistory = true;
    value.checkpointing.conversationRollback = true;
    value.requests.allowCustomAnswer = true;
    value.requests.approvalScopes = [
      { decision: "accept", scope: "once" },
      { decision: "accept_always", scope: "global" },
    ];
  });
}

const SETUP_POLICY = { mode: "approval_required", interaction: "default", cwd: "/work" } as const;
const TEXT = [{ type: "text" as const, text: "hi" }];

/**
 * Each gate an argument or the thread's state triggers: the capability it
 * needs, how to turn that capability off, and the call. Every call runs after
 * `createThread` made thread-1 in /work with SETUP_POLICY.
 */
const ARGUMENT_GATES: Array<{ capability: string; off: (capabilities: Capabilities) => void; call: (session: Session) => Promise<unknown> }> = [
  {
    capability: "runtimePolicy.modes.full_access",
    off: (value) => (value.runtimePolicy.modes.full_access = { supported: false, enforcement: "client_boundary" }),
    call: (session) => session.forkThread!({ threadId: "thread-1", at: { type: "latest" }, policy: { ...SETUP_POLICY, mode: "full_access" } }),
  },
  {
    capability: "runtimePolicy.modes.read_only",
    off: (value) => (value.runtimePolicy.modes.read_only = { supported: false, enforcement: "client_boundary" }),
    call: (session) => session.resumeThread({ native: { id: "n-thread-1", strength: "strong" }, policy: { ...SETUP_POLICY, mode: "read_only" } }),
  },
  {
    capability: "runtimePolicy.interactionModes",
    off: (value) => (value.runtimePolicy.interactionModes = ["default"]),
    call: (session) => session.createThread({ cwd: "/work", policy: { ...SETUP_POLICY, interaction: "plan" } }),
  },
  {
    capability: "context.instructionChannels",
    off: (value) => (value.context.instructionChannels = []),
    call: (session) => session.createThread({ cwd: "/work", policy: SETUP_POLICY, context: { system: "Follow the house style." } }),
  },
  {
    capability: "context.instructionChannels",
    off: (value) => (value.context.instructionChannels = []),
    call: (session) => session.resumeThread({ native: { id: "n-thread-1", strength: "strong" }, launch: { developerPrompt: ["Run the tests first."] } }),
  },
  {
    capability: "context.instructionChannels",
    off: (value) => (value.context.instructionChannels = []),
    call: (session) => session.startTurn({ threadId: "thread-1", clientTurnKey: "k", intent: "start", content: TEXT, context: { developer: "Be brief." } }),
  },
  {
    capability: "context.syntheticContext",
    off: (value) => (value.context.syntheticContext = false),
    call: (session) => session.startTurn({ threadId: "thread-1", clientTurnKey: "k", intent: "start", content: TEXT, context: { synthetic: [{ key: "branch", text: "main" }] } }),
  },
  {
    capability: "context.handoffSummaries",
    off: (value) => (value.context.handoffSummaries = false),
    call: (session) => session.injectHistory!({ threadId: "thread-1", messages: [], summary: "Earlier we fixed the build." }),
  },
  {
    capability: "tools.dynamicTools",
    off: (value) => (value.tools.dynamicTools = false),
    call: (session) => session.createThread({ cwd: "/work", policy: SETUP_POLICY, launch: { dynamicTools: [{ name: "preview", inputSchema: {} }] } }),
  },
  {
    capability: "tools.mcp",
    off: (value) => (value.tools.mcp = false),
    call: (session) => session.createThread({ cwd: "/work", policy: SETUP_POLICY, launch: { mcpServers: [{ name: "host", transport: "stdio", command: "host-mcp" }] } }),
  },
  {
    capability: "mcp.acceptsHostServers",
    off: (value) => (value.mcp.acceptsHostServers = ["stdio", "http"]),
    call: (session) => session.createThread({ cwd: "/work", policy: SETUP_POLICY, launch: { mcpServers: [{ name: "host", transport: "sse", url: "http://127.0.0.1:1/sse" }] } }),
  },
  {
    capability: "sessions.multipleThreads",
    off: (value) => (value.sessions.multipleThreads = false),
    call: (session) => session.createThread({ cwd: "/work", policy: SETUP_POLICY }),
  },
  {
    capability: "sessions.multipleThreads",
    off: (value) => (value.sessions.multipleThreads = false),
    call: (session) => session.resumeThread({ native: { id: "n-other-thread", strength: "strong" } }),
  },
  {
    capability: "sessions.switchRuntimeMode",
    off: (value) => (value.sessions.switchRuntimeMode = false),
    call: (session) => session.startTurn({ threadId: "thread-1", clientTurnKey: "k", intent: "start", content: TEXT, policy: { ...SETUP_POLICY, mode: "full_access" } }),
  },
  {
    capability: "runtimePolicy.switchInSession",
    off: (value) => (value.runtimePolicy.switchInSession = false),
    call: (session) => session.startTurn({ threadId: "thread-1", clientTurnKey: "k", intent: "start", content: TEXT, policy: { ...SETUP_POLICY, interaction: "plan" } }),
  },
  {
    capability: "checkpointing.conversationRollback",
    off: (value) => (value.checkpointing.conversationRollback = false),
    call: (session) => session.rollbackThread!({ threadId: "thread-1", to: { type: "start" } }),
  },
  {
    capability: "requests.allowCustomAnswer",
    off: (value) => (value.requests.allowCustomAnswer = false),
    call: (session) => session.respond({ requestId: "request-1", responseKey: "k", custom: "Use the staging database" }),
  },
  {
    capability: "requests.approvalScopes",
    off: (value) => (value.requests.approvalScopes = [{ decision: "accept", scope: "once" }]),
    call: (session) => session.respond({ requestId: "request-1", responseKey: "k", optionId: "always", scope: "global" }),
  },
  {
    capability: "sessions.release",
    off: (value) => (value.sessions.release = false),
    call: (session) => session.release(),
  },
];

/** The capability a refusal names: a rejection's unsupported call error, or startTurn's unsupported result. */
async function refusedCapability(call: () => Promise<unknown>): Promise<string | undefined> {
  try {
    const result = await call();
    const status = (result as { status?: unknown } | undefined)?.status;
    return status === "unsupported" ? (result as { capability: string }).capability : undefined;
  } catch (error) {
    return isAriError(error, "unsupported") && error.callError.code === "unsupported" ? error.callError.capability : `not unsupported: ${String(error)}`;
  }
}

describe("argument and thread-state gates", () => {
  for (const [index, gate] of ARGUMENT_GATES.entries()) {
    test(`${index + 1}. ${gate.capability} off refuses the call without reaching the driver; on, the call reaches it`, async () => {
      const offCapabilities = argumentGatesOn();
      gate.off(offCapabilities);
      const offDriver = fakeSession(offCapabilities);
      const offGuarded = guardSession(offDriver);
      await offGuarded.createThread({ cwd: "/work", policy: SETUP_POLICY });
      assert.equal(await refusedCapability(() => gate.call(offGuarded)), gate.capability);
      assert.deepEqual(offDriver.calls.map((entry) => entry.member), ["createThread"]);

      const onDriver = fakeSession(argumentGatesOn());
      const onGuarded = guardSession(onDriver);
      await onGuarded.createThread({ cwd: "/work", policy: SETUP_POLICY });
      assert.equal(await refusedCapability(() => gate.call(onGuarded)), undefined);
      assert.equal(onDriver.calls.length, 2);
    });
  }

  test("resuming the thread the session already holds, or a thread after unloading it, is not a second thread", async () => {
    const capabilities = argumentGatesOn();
    capabilities.sessions.multipleThreads = false;
    capabilities.threads.unload = true;
    const driver = fakeSession(capabilities);
    const guarded = guardSession(driver);
    const thread = await guarded.createThread({ cwd: "/work", policy: SETUP_POLICY });
    await guarded.resumeThread({ native: { id: "n-thread-1", strength: "strong" } });
    await guarded.unloadThread!(thread.id);
    await guarded.createThread({ cwd: "/work", policy: SETUP_POLICY });
    assert.deepEqual(driver.calls.map((entry) => entry.member), ["createThread", "resumeThread", "unloadThread", "createThread"]);
  });

  test("a policy the host passes again unchanged is not a switch, and an accepted turn's policy becomes the thread's", async () => {
    const capabilities = argumentGatesOn();
    capabilities.sessions.switchRuntimeMode = false;
    capabilities.runtimePolicy.switchInSession = false;
    const driver = fakeSession(capabilities);
    const guarded = guardSession(driver);
    await guarded.createThread({ cwd: "/work", policy: SETUP_POLICY });
    const same = await guarded.startTurn({ threadId: "thread-1", clientTurnKey: "k1", intent: "start", content: TEXT, policy: SETUP_POLICY });
    assert.equal(same.status, "accepted");
    // A thread the guard has never seen has no known policy, so nothing marks a switch.
    const unknown = await guarded.startTurn({ threadId: "thread-elsewhere", clientTurnKey: "k2", intent: "start", content: TEXT, policy: { ...SETUP_POLICY, mode: "full_access" } });
    assert.equal(unknown.status, "accepted");
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

  test("the planner applies the guard's fromSubagent and conversationRollback gates", () => {
    const capabilities = capabilitiesWith((value) => {
      value.threads.fork = { supported: true, fromTurn: true, fromItem: true, fromSubagent: false, crossCwd: true };
      value.threads.rollback = true;
      value.checkpointing.conversationRollback = false;
    });
    assert.equal(planFallback(capabilities, { kind: "fork", threadId: "thread-review", at: { type: "latest" }, subagentThread: true }).native, false);
    assert.equal(planFallback(capabilities, { kind: "fork", threadId: "thread-1", at: { type: "latest" } }).native, true);
    const rollback = planFallback(capabilities, { kind: "rollback", threadId: "thread-1", to: { type: "turn", turnId: "turn-2" } });
    assert.equal(rollback.native, false);
    assert.deepEqual(rollback.steps[0], { action: "fork_thread", threadId: "thread-1", at: { type: "turn", turnId: "turn-2" } });
    const subagentRollback = planFallback(capabilities, { kind: "rollback", threadId: "thread-review", to: { type: "turn", turnId: "turn-2" }, subagentThread: true });
    assert.equal(subagentRollback.steps[0]?.action, "read_history");
  });

  test("a fork on a single-thread Session opens a fresh Session for the new thread", () => {
    const singleThread = capabilitiesWith((value) => {
      value.sessions.multipleThreads = false;
      value.threads.fork.supported = false;
      value.threads.readSnapshot = true;
      value.threads.injectHistory = true;
    });
    const plan = planFallback(singleThread, { kind: "fork", threadId: "thread-1", at: { type: "latest" }, sourceCwd: "/work" });
    assert.deepEqual(plan.steps, [
      { action: "read_history", threadId: "thread-1", source: "provider_snapshot", upTo: { type: "latest" } },
      { action: "open_session" },
      { action: "create_thread", cwd: "/work" },
      { action: "seed_history", method: "inject_history" },
    ]);
  });

  test("a rollback on a single-thread Session unloads the source first, or opens a fresh Session when it cannot unload", () => {
    const unloadable = capabilitiesWith((value) => {
      value.sessions.multipleThreads = false;
      value.threads.rollback = false;
      value.threads.fork.fromTurn = false;
      value.threads.unload = true;
      value.threads.readSnapshot = false;
    });
    assert.deepEqual(planFallback(unloadable, { kind: "rollback", threadId: "thread-1", to: { type: "turn", turnId: "turn-1" }, cwd: "/work" }).steps, [
      { action: "read_history", threadId: "thread-1", source: "host_transcript", upTo: { type: "turn", turnId: "turn-1" } },
      { action: "unload_thread", threadId: "thread-1" },
      { action: "create_thread", cwd: "/work" },
      { action: "seed_history", method: "first_user_message" },
      { action: "switch_thread", fromThreadId: "thread-1" },
    ]);
    assert.deepEqual(planFallback(unloadable, { kind: "rollback", threadId: "thread-1", to: { type: "start" } }).steps, [
      { action: "unload_thread", threadId: "thread-1" },
      { action: "create_thread" },
      { action: "switch_thread", fromThreadId: "thread-1" },
    ]);
    const stuck = capabilitiesWith((value) => {
      value.sessions.multipleThreads = false;
      value.threads.rollback = false;
      value.threads.unload = false;
    });
    assert.deepEqual(planFallback(stuck, { kind: "rollback", threadId: "thread-1", to: { type: "start" } }).steps, [
      { action: "open_session" },
      { action: "create_thread" },
      { action: "switch_thread", fromThreadId: "thread-1" },
    ]);
    // Unloading a subagent's thread frees nothing: the session still holds its parent's thread.
    assert.equal(planFallback(unloadable, { kind: "rollback", threadId: "thread-review", to: { type: "start" }, subagentThread: true }).steps[0]?.action, "open_session");
  });

  test("every plan's steps, run through the capability guard, are accepted", async () => {
    const policy = { mode: "approval_required", interaction: "default", cwd: "/work" } as const;
    const forkModes: Array<Capabilities["threads"]["fork"]> = [
      { supported: false, fromTurn: false, fromItem: false, fromSubagent: false, crossCwd: false },
      { supported: true, fromTurn: false, fromItem: false, fromSubagent: false, crossCwd: false },
      { supported: true, fromTurn: true, fromItem: true, fromSubagent: true, crossCwd: true },
    ];
    const requests: Array<{ name: string; subagent: boolean; request: (sourceThreadId: string) => Parameters<typeof planFallback>[1] }> = [
      { name: "steer unsupported", subagent: false, request: (threadId) => ({ kind: "steer", outcome: "unsupported", threadId, turnId: "turn-1" }) },
      { name: "steer prompt_required", subagent: false, request: (threadId) => ({ kind: "steer", outcome: "prompt_required", threadId, turnId: "turn-1" }) },
      { name: "fork latest", subagent: false, request: (threadId) => ({ kind: "fork", threadId, at: { type: "latest" }, sourceCwd: "/work" }) },
      { name: "fork from a turn", subagent: false, request: (threadId) => ({ kind: "fork", threadId, at: { type: "turn", turnId: "turn-1" }, sourceCwd: "/work" }) },
      { name: "fork into another directory", subagent: false, request: (threadId) => ({ kind: "fork", threadId, at: { type: "latest" }, cwd: "/elsewhere", sourceCwd: "/work" }) },
      { name: "fork a subagent's thread", subagent: true, request: (threadId) => ({ kind: "fork", threadId, at: { type: "latest" }, subagentThread: true }) },
      { name: "rollback to the start", subagent: false, request: (threadId) => ({ kind: "rollback", threadId, to: { type: "start" }, cwd: "/work" }) },
      { name: "rollback to a turn", subagent: false, request: (threadId) => ({ kind: "rollback", threadId, to: { type: "turn", turnId: "turn-1" }, cwd: "/work" }) },
      { name: "rollback a subagent's thread", subagent: true, request: (threadId) => ({ kind: "rollback", threadId, to: { type: "turn", turnId: "turn-1" }, subagentThread: true }) },
    ];

    let runs = 0;
    for (const multipleThreads of [true, false]) {
      for (const unload of [true, false]) {
        for (const fork of forkModes) {
          for (const native of [true, false]) {
            const capabilities = capabilitiesWith((value) => {
              value.sessions.multipleThreads = multipleThreads;
              value.threads.unload = unload;
              value.threads.fork = { ...fork };
              value.threads.rollback = native;
              value.threads.readSnapshot = native;
              value.threads.injectHistory = native;
              value.turns.steer = false;
              value.turns.queue = native;
            });
            for (const { name, subagent, request } of requests) {
              const label = `${name} (multipleThreads ${multipleThreads}, unload ${unload}, fork ${JSON.stringify(fork)}, native rollback/snapshot/inject/queue ${native})`;
              const sessions: FakeSession[] = [];
              const open = (): Session => {
                const driver = fakeSession(capabilities, `session-${sessions.length + 1}`);
                sessions.push(driver);
                return guardSession(driver);
              };
              let session = open();
              const source = await session.createThread({ cwd: "/work", policy });
              await session.startTurn({ threadId: source.id, clientTurnKey: "k1", intent: "start", content: TEXT });
              let sourceId = source.id;
              if (subagent) {
                // The provider opened a subagent's thread on its own; the guard learns of it from the events it reads.
                const review = await sessions[0]!.createThread({ cwd: "/work", policy });
                sessions[0]!.sequencer.emit({
                  body: {
                    type: "subagent.upsert",
                    subagent: { id: "review-agent", native: { id: "n-review", strength: "strong" }, parentThreadId: source.id, status: "running", threadId: review.id },
                  },
                });
                const lastSeq = sessions[0]!.sequencer.lastSeq;
                for await (const event of session.events()) if (event.seq === lastSeq) break;
                sourceId = review.id;
              }
              const setupCalls = sessions[0]!.calls.length;

              const plan = planFallback(capabilities, request(sourceId));
              let created: string | undefined;
              for (const [index, step] of plan.steps.entries()) {
                const where = `${label}: step ${index + 1} ${step.action}`;
                try {
                  switch (step.action) {
                    case "read_history":
                      if (step.source === "provider_snapshot") await session.readSnapshot!(step.threadId);
                      break;
                    case "unload_thread":
                      await session.unloadThread!(step.threadId);
                      break;
                    case "open_session":
                      session = open();
                      break;
                    case "create_thread":
                      created = (await session.createThread({ cwd: step.cwd ?? "/work", policy: { ...policy, cwd: step.cwd ?? "/work" } })).id;
                      break;
                    case "seed_history": {
                      assert.ok(created !== undefined, `${where}: no thread was created to seed`);
                      if (step.method === "inject_history") {
                        await session.injectHistory!({ threadId: created, messages: [{ role: "user", content: TEXT }], summary: "" });
                      } else {
                        const seeded = await session.startTurn({ threadId: created, clientTurnKey: "seed", intent: "start", content: TEXT });
                        assert.equal(seeded.status, "accepted", where);
                      }
                      break;
                    }
                    case "fork_thread":
                      await session.forkThread!(step.cwd === undefined ? { threadId: step.threadId, at: step.at } : { threadId: step.threadId, at: step.at, cwd: step.cwd });
                      break;
                    case "rollback_thread":
                      await session.rollbackThread!({ threadId: step.threadId, to: step.to });
                      break;
                    case "start_turn": {
                      const started = await session.startTurn({ threadId: step.threadId, clientTurnKey: "plan", intent: step.intent, content: TEXT });
                      assert.equal(started.status, "accepted", where);
                      break;
                    }
                    case "wait_for_turn_terminal":
                    case "switch_thread":
                      break;
                  }
                } catch (error) {
                  if (isAriError(error, "unsupported")) {
                    assert.fail(`${where} was refused for ${error.callError.code === "unsupported" ? error.callError.capability : "?"}`);
                  }
                  throw error;
                }
              }
              // Every step that calls the session reached a driver: the guard refused none of them.
              const reached = [...sessions[0]!.calls.slice(setupCalls), ...sessions.slice(1).flatMap((driver) => driver.calls)].map((entry) => entry.member);
              const expected = plan.steps.flatMap((step): string[] => {
                if (step.action === "read_history") return step.source === "provider_snapshot" ? ["readSnapshot"] : [];
                if (step.action === "unload_thread") return ["unloadThread"];
                if (step.action === "create_thread") return ["createThread"];
                if (step.action === "seed_history") return [step.method === "inject_history" ? "injectHistory" : "startTurn"];
                if (step.action === "fork_thread") return ["forkThread"];
                if (step.action === "rollback_thread") return ["rollbackThread"];
                if (step.action === "start_turn") return ["startTurn"];
                return [];
              });
              assert.deepEqual(reached, expected, label);
              runs += 1;
            }
          }
        }
      }
    }
    assert.equal(runs, 2 * 2 * forkModes.length * 2 * requests.length);
  });

  test("planning calls nothing on a session", () => {
    const driver = fakeSession(allGatesOff());
    planFallback(driver.capabilities(), { kind: "rollback", threadId: "thread-1", to: { type: "turn", turnId: "turn-1" } });
    planFallback(driver.capabilities(), { kind: "fork", threadId: "thread-1", at: { type: "latest" } });
    assert.deepEqual(driver.calls, []);
  });
});
