// Capability honesty for the Codex driver: all 42 optional members of the
// Session and Instance interfaces (inventories D and E) with the driver's
// outcome for each. A member the driver leaves out is absent; each member it
// supports is exercised here against the fake Codex app-server, with a check
// of its native effect. docs/drivers/codex.md gives the reason for each
// member left out.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { CODEX_CAPABILITIES, CODEX_TESTED_VERSIONS } from "../../../src/drivers/codex/index.ts";
import { isAriError } from "../../../src/index.ts";
import type { Instance, Session, Thread } from "../../../src/index.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import type { CodexNativeTurn } from "./fake-app-server.ts";
import { codexRig, policy } from "./rig.ts";
import type { CodexTestRig, OpenedCodexSession } from "./rig.ts";

/** The driver's outcome for each optional member: it works, or the driver leaves it out. */
export const CODEX_OPTIONAL_MEMBERS: { readonly [member: string]: "supported" | "absent" } = {
  // Session (inventory D).
  "Session.readSnapshot": "supported",
  "Session.forkThread": "supported",
  "Session.rollbackThread": "supported",
  "Session.compactThread": "supported",
  "Session.injectHistory": "supported",
  "Session.unloadThread": "supported",
  "Session.backgroundTasks.list": "supported",
  "Session.backgroundTasks.stop": "supported",
  "Session.backgroundTasks.await": "supported",
  "Session.stopSubagent": "supported",
  "Session.mcpApps.listTools": "supported",
  "Session.mcpApps.callTool": "supported",
  "Session.mcpApps.readResource": "supported",
  "Session.contextWindow": "supported",
  "Session.canReuseContextUsage": "supported",
  "Session.uploadFeedback": "supported",
  "Session.ext": "supported",
  // Instance (inventory E).
  "Instance.invalidateCaches": "supported",
  "Instance.maintenance.advisory": "supported",
  "Instance.auth.methods": "supported",
  "Instance.auth.state": "supported",
  "Instance.auth.reportRuntimeFailure": "supported",
  "Instance.auth.start": "supported",
  "Instance.auth.complete": "supported",
  "Instance.auth.respond": "supported",
  "Instance.auth.cancel": "supported",
  "Instance.auth.logout": "supported",
  "Instance.auth.transferProfile": "supported",
  "Instance.auth.transferSession": "absent",
  "Instance.catalog.refresh": "supported",
  "Instance.workspace.snapshot": "absent",
  "Instance.limits.current": "supported",
  "Instance.limits.accountKey": "supported",
  "Instance.limits.consumeResetCredit": "supported",
  "Instance.usageHistory.scan": "absent",
  "Instance.textGeneration.generate": "absent",
  "Instance.nativeSessions.list": "supported",
  "Instance.nativeSessions.delete": "supported",
  "Instance.nativeSessions.archive": "supported",
  "Instance.subProviders.list": "absent",
  "Instance.subProviders.set": "absent",
  "Instance.subProviders.disable": "absent",
};

function member(target: object, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((value, key) => (value === undefined || value === null ? undefined : (value as { [key: string]: unknown })[key]), target);
}

describe("capability honesty: the 42 optional members", () => {
  test("the table lists exactly the optional Session and Instance members of methods.json", () => {
    const methods = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "spec", "v1", "methods.json"), "utf8")) as { methods: Array<{ interface?: string; member?: string; optional?: boolean }> };
    const optional = methods.methods.filter((entry) => (entry.interface === "Session" || entry.interface === "Instance") && entry.optional === true).map((entry) => `${entry.interface}.${entry.member}`);
    assert.equal(optional.length, 42);
    assert.deepEqual(Object.keys(CODEX_OPTIONAL_MEMBERS).sort(), optional.sort());
  });

  let rig: CodexTestRig;
  let opened: OpenedCodexSession;
  let session: Session;
  let instance: Instance;
  let thread: Thread;
  const turnIds: string[] = [];
  let firstTurn: CodexNativeTurn;

  before(async () => {
    rig = await codexRig();
    instance = rig.instance;
    opened = await rig.open();
    session = opened.session;
    thread = await session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    for (const prompt of ["Start the server.", "Add a test."]) {
      const started = await session.startTurn({ threadId: thread.id, clientTurnKey: prompt, intent: "start", content: [{ type: "text", text: prompt }] });
      const native = await rig.nextTurn();
      if (turnIds.length === 0) {
        firstTurn = native;
        await native.startBackgroundTask!({ title: "npm run dev" });
        await native.spawnSubagent!({ name: "researcher" });
        await native.reportUsage(1200, 400_000);
      }
      await native.say("Done.");
      await native.complete();
      turnIds.push((started as { turnId: string }).turnId);
      await opened.until(() => opened.bodies("turn.terminal").find((body) => body.turnId === turnIds.at(-1)), "the turn to end");
    }
    void firstTurn;
  });
  after(async () => rig.cleanup());

  test("each member the driver leaves out is absent", () => {
    for (const [name, outcome] of Object.entries(CODEX_OPTIONAL_MEMBERS)) {
      const [owner, ...rest] = name.split(".");
      const value = member(owner === "Session" ? session : instance, rest.join("."));
      if (outcome === "absent") assert.equal(value, undefined, `${name} is declared absent but present`);
      else assert.equal(typeof value, "function", `${name} is declared supported but not a function`);
    }
  });

  test("capabilities gate what the driver supports and refuse what it does not", async () => {
    assert.equal(CODEX_CAPABILITIES.turns.queue, false);
    assert.deepEqual(await session.startTurn({ threadId: thread.id, clientTurnKey: "queued", intent: "queue", content: [{ type: "text", text: "Later." }] }), { status: "unsupported", capability: "turns.queue" });
    assert.equal(CODEX_CAPABILITIES.threads.fork.fromItem, false);
    await assert.rejects(session.forkThread!({ threadId: thread.id, at: { type: "item", itemId: "item_x" } }), (error) => isAriError(error, "unsupported") && (error.callError as { capability?: string }).capability === "threads.fork.fromItem");
    await assert.rejects(session.ext!("ari.unknown", "get", { threadId: thread.id }), (error) => isAriError(error, "unsupported"));
  });

  // Session members.

  test("Session.readSnapshot: the snapshot holds the turns that ran and their prompts", async () => {
    const snapshot = await session.readSnapshot!(thread.id);
    assert.deepEqual(snapshot.turns.map((turn) => turn.id), turnIds);
    assert.deepEqual(snapshot.items.filter((item) => item.kind === "user_message").map((item) => item.text), ["Start the server.", "Add a test."]);
    assert.ok(rig.requests("thread/turns/list").every((params) => params["itemsView"] === "full"));
  });

  test("Session.forkThread: a new native thread holding the source's prompts", async () => {
    const fork = await session.forkThread!({ threadId: thread.id, at: { type: "turn", turnId: turnIds[0]! } });
    assert.notEqual(fork.native.id, thread.native.id);
    assert.deepEqual(rig.world.inspect(fork.native.id!)!.prompts, ["Start the server."]);
  });

  test("Session.backgroundTasks.list, await and stop: the running terminal is listed, matched and terminated natively", async () => {
    const listed = await session.backgroundTasks!.list(thread.id);
    assert.deepEqual(listed.map((task) => task.title), ["npm run dev"]);
    assert.deepEqual(await session.backgroundTasks!.await({ threadId: thread.id, taskIds: [listed[0]!.id], awaited: true }), { matched: [listed[0]!.id] });
    await session.backgroundTasks!.stop({ threadId: thread.id, taskId: listed[0]!.id });
    assert.deepEqual(rig.world.inspect(thread.native.id!)!.backgroundTasks, [{ title: "npm run dev", running: false }]);
  });

  test("Session.stopSubagent: the subagent's turn is interrupted natively and its status settles", async () => {
    const subagent = opened.bodies("subagent.upsert").find((body) => body.subagent.name === "researcher")!.subagent;
    const outcome = await session.stopSubagent!({ subagentId: subagent.id });
    assert.deepEqual(outcome, { status: "interrupted" });
    await opened.until(() => opened.bodies("subagent.upsert").find((body) => body.subagent.id === subagent.id && body.subagent.status === "interrupted"), "the subagent to settle");
    assert.deepEqual(rig.world.inspect(thread.native.id!)!.subagents, [{ name: "researcher", running: false }]);
  });

  test("Session.mcpApps.listTools, callTool and readResource: answered by the native MCP server", async () => {
    assert.deepEqual((await session.mcpApps!.listTools(thread.id, "fake-tools")).map((tool) => tool.name), ["echo"]);
    const called = await session.mcpApps!.callTool(thread.id, "fake-tools", "echo", { text: "x" });
    assert.deepEqual(called, rig.world.activityLog.mcp.findLast((entry) => entry.operation === "callTool")!.output);
    const read = await session.mcpApps!.readResource(thread.id, "fake-tools", "fake://readme");
    assert.deepEqual(read, rig.world.activityLog.mcp.findLast((entry) => entry.operation === "readResource")!.output);
  });

  test("Session.contextWindow and canReuseContextUsage: the window Codex reported for the model", () => {
    assert.equal(session.contextWindow!("fake-large"), 400_000);
    assert.equal(session.contextWindow!("never-used"), undefined);
    assert.equal(session.canReuseContextUsage!("fake-large", "fake-large"), true);
    assert.equal(session.canReuseContextUsage!("fake-large", "fake-small"), false);
  });

  test("Session.uploadFeedback: Codex took the upload and answered the id", async () => {
    const { feedbackId } = await session.uploadFeedback!({ threadId: thread.id, reason: "slow" });
    assert.deepEqual(rig.world.activityLog.feedback.at(-1), { feedbackId, reason: "slow" });
  });

  test("Session.ext: a declared extension reaches Codex and returns its answer", async () => {
    const memory = (await session.ext!("codex.memory", "read", { threadId: thread.id })) as { summary: string };
    assert.equal(memory.summary, (rig.world.activityLog.extensions.at(-1)!.result as { summary: string }).summary);
  });

  test("Session.compactThread: Codex compacted the native thread", async () => {
    await session.compactThread!(thread.id);
    assert.equal(rig.world.inspect(thread.native.id!)!.compactions, 1);
  });

  test("Session.injectHistory: Codex received each message", async () => {
    const result = await session.injectHistory!({ threadId: thread.id, messages: [{ role: "user", content: [{ type: "text", text: "Earlier question." }] }], summary: "We set up the server." });
    assert.deepEqual(result, { consumed: true });
    assert.deepEqual(rig.world.inspect(thread.native.id!)!.injectedMessages, ["We set up the server.", "Earlier question."]);
  });

  test("Session.rollbackThread: back to the first turn, natively too", async () => {
    const snapshot = await session.rollbackThread!({ threadId: thread.id, to: { type: "turn", turnId: turnIds[0]! } });
    assert.deepEqual(snapshot.turns.map((turn) => turn.id), [turnIds[0]]);
    assert.deepEqual(rig.world.inspect(thread.native.id!)!.prompts, ["Start the server."]);
  });

  test("Session.unloadThread: Codex unloads the thread, and resumeThread brings it back", async () => {
    await session.unloadThread!(thread.id);
    assert.equal(rig.world.inspect(thread.native.id!)!.loaded, false);
    const resumed = await session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd) });
    assert.equal(resumed.id, thread.id);
    assert.equal(rig.world.inspect(thread.native.id!)!.loaded, true);
  });

  // Instance members.

  test("Instance.invalidateCaches and catalog.refresh: the next list asks Codex again", async () => {
    const catalog = await instance.catalog.list();
    assert.deepEqual(catalog.models.map((model) => model.id), ["fake-large", "fake-small"]);
    assert.equal(catalog.defaultModelId, "fake-large");
    await instance.catalog.list();
    const asked = rig.requests("model/list").length;
    await instance.invalidateCaches!();
    await instance.catalog.list();
    assert.equal(rig.requests("model/list").length, asked + 1);
    await instance.catalog.refresh!();
    assert.equal(rig.requests("model/list").length, asked + 2);
  });

  test("Instance.maintenance.advisory: none at a tested version", async () => {
    assert.equal(await instance.maintenance!.advisory(), null);
    assert.ok(CODEX_TESTED_VERSIONS.includes("0.172.0"));
  });

  test("Instance.auth members: methods, state, reportRuntimeFailure, start, respond, complete, cancel, transferProfile, logout", async () => {
    const auth = instance.auth!;
    assert.equal(auth.methods().length, 3);
    assert.equal((await auth.state()).status, "authenticated");
    const flow = await auth.start({ ownerSessionId: "o", methodId: "chatgpt", callback: { mode: "client" } });
    const redirect = new URL(flow.url!).searchParams.get("redirect_uri")!;
    assert.equal((await auth.complete({ flowId: flow.flowId, callbackUrl: `${redirect}?code=c&state=${flow.flowId}` })).status, "authenticated");
    const device = await auth.start({ ownerSessionId: "o", methodId: "device-code", callback: { mode: "client" } });
    await auth.cancel(device.flowId);
    assert.deepEqual(rig.requests("account/login/cancel").at(-1), { loginId: device.flowId });
    const keyFlow = await auth.start({ ownerSessionId: "o", methodId: "api-key", callback: { mode: "client" } });
    assert.equal((await auth.respond!({ flowId: keyFlow.flowId, values: { apiKey: "sk-x" } })).scope, "managed_profile");
    assert.equal((await auth.reportRuntimeFailure!({ message: "401" })).evidence, "runtime_poison");
    await auth.logout!();
    assert.deepEqual(rig.host.storedSecrets(), []);
    const transferred = await auth.transferProfile!({ format: "codex.chatgpt_auth_tokens", data: JSON.stringify({ accessToken: "a", chatgptAccountId: "b" }) });
    assert.equal(transferred.status, "configured");
    await auth.logout!();
  });

  test("Instance.limits.current, accountKey and consumeResetCredit: Codex's rate limits and reset credits", async () => {
    const current = await instance.limits!.current();
    assert.deepEqual(current.windows.map((window) => [window.window, window.utilization]), [["5h", 0.12], ["weekly", 0.03]]);
    assert.equal(instance.limits!.accountKey(), "codex:ambient");
    const consumed = await instance.limits!.consumeResetCredit!({ idempotencyKey: "reset-1" });
    assert.equal(consumed.status, "consumed");
    assert.deepEqual(rig.requests("account/rateLimitResetCredit/consume").at(-1), { idempotencyKey: "reset-1" });
  });

  test("Instance.nativeSessions.list, archive and delete: Codex's thread list", async () => {
    const page = await instance.nativeSessions!.list({ cwd: rig.cwd });
    assert.ok(page.items.some((item) => item.id === thread.native.id));
    await instance.nativeSessions!.archive!(thread.native.id!);
    assert.deepEqual(rig.requests("thread/archive").at(-1), { threadId: thread.native.id });
    const fork = (await instance.nativeSessions!.list({ cwd: rig.cwd })).items[0]!;
    await instance.nativeSessions!.delete!(fork.id);
    assert.deepEqual(rig.requests("thread/delete").at(-1), { threadId: fork.id });
  });
});

describe("capability honesty: the runtime modes Codex enforces natively", () => {
  let rig: CodexTestRig | undefined;
  after(async () => rig?.cleanup());

  /** Runs one turn on `threadId` with no per-turn policy and returns the reviewer Codex used for it. */
  async function reviewerOfNextTurn(current: CodexTestRig, opened: OpenedCodexSession, threadId: string, key: string): Promise<string> {
    const started = await opened.session.startTurn({ threadId, clientTurnKey: key, intent: "start", content: [{ type: "text", text: key }] });
    const native = await current.nextTurn();
    await native.complete();
    await opened.until(() => opened.bodies("turn.terminal").find((body) => body.turnId === (started as { turnId: string }).turnId), `turn ${key} to end`);
    return native.settings.approvalsReviewer;
  }

  test("auto reaches Codex as approvalsReviewer auto_review on start, resume, fork and the next turn, and leaving auto sets it back to user", async () => {
    rig = await codexRig();
    const first = await rig.open();
    const thread = await first.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    assert.equal(await reviewerOfNextTurn(rig, first, thread.id, "human-1"), "user");
    await first.session.close();

    // Resume a human-reviewed thread in auto; the next turn names no policy. Codex keeps an omitted reviewer, so the driver must name it.
    const second = await rig.open();
    await second.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd, "auto") });
    assert.equal(rig.requests("thread/resume").at(-1)!["approvalsReviewer"], "auto_review");
    assert.equal(await reviewerOfNextTurn(rig, second, thread.id, "auto-1"), "auto_review");

    // Fork the now auto-reviewed thread back into approval_required: the fork must not keep the source's reviewer.
    const fork = await second.session.forkThread!({ threadId: thread.id, at: { type: "latest" }, policy: policy(rig.cwd, "approval_required") });
    assert.equal(rig.requests("thread/fork").at(-1)!["approvalsReviewer"], "user");
    assert.equal(await reviewerOfNextTurn(rig, second, fork.id, "fork-human"), "user");

    // Fork a human-reviewed thread into auto.
    const autoFork = await second.session.forkThread!({ threadId: fork.id, at: { type: "latest" }, policy: policy(rig.cwd, "auto") });
    assert.equal(await reviewerOfNextTurn(rig, second, autoFork.id, "fork-auto"), "auto_review");

    // A per-turn switch out of auto names the reviewer too.
    const switched = await second.session.startTurn({ threadId: thread.id, clientTurnKey: "switch", intent: "start", policy: policy(rig.cwd, "auto_accept_edits"), content: [{ type: "text", text: "switch" }] });
    const native = await rig.nextTurn();
    assert.equal(native.settings.approvalsReviewer, "user");
    await native.complete();
    await second.until(() => second.bodies("turn.terminal").find((body) => body.turnId === (switched as { turnId: string }).turnId), "the switched turn to end");
    assert.equal(await reviewerOfNextTurn(rig, second, thread.id, "after-switch"), "user");
  });
});

describe("native sessions ARI did not create", () => {
  test("a thread nativeSessions.list returns that ARI did not create resumes with only the host's LaunchContext, and runs a turn", async () => {
    const rig = await codexRig();
    try {
      // Listing starts the account's app-server, whose Codex home then holds a thread the user's own codex wrote.
      await rig.instance.nativeSessions!.list({ cwd: rig.cwd });
      assert.equal(rig.world.stores.size, 1);
      const store = [...rig.world.stores.values()][0]!;
      const nativeId = store.newThreadId();
      const now = Math.floor(Date.now() / 1000);
      store.threads.set(nativeId, {
        id: nativeId,
        cwd: rig.cwd,
        createdAt: now,
        updatedAt: now,
        turns: [],
        compactions: 0,
        injected: [],
        archived: false,
        materialized: true,
        ephemeral: false,
        forkedFromId: null,
        parentThreadId: null,
        agentNickname: null,
        goal: undefined,
        readState: { revision: 1, unread: false },
        terminals: [],
        subagents: [],
        settings: { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", mcpServers: [] },
        launches: [],
      });

      const listed = (await rig.instance.nativeSessions!.list({ cwd: rig.cwd })).items.find((item) => item.id === nativeId);
      assert.ok(listed?.handle !== undefined, "nativeSessions.list returns the thread");
      const opened = await rig.open();
      const thread = await opened.session.resumeThread({ native: { handle: listed.handle }, policy: policy(rig.cwd), launch: { appendSystemPrompt: ["HOST-LAUNCH-MARKER"] } });
      assert.equal(thread.native.id, nativeId);
      const resume = rig.requests("thread/resume").at(-1)!;
      assert.equal(resume["threadId"], nativeId);
      assert.equal(resume["developerInstructions"], "HOST-LAUNCH-MARKER");
      assert.deepEqual(Object.keys(resume["config"] as object), [`mcp_servers.host-tools-${thread.id}`], "only the host's tool server, under the name the host chose");
      const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "carry-on", intent: "start", content: [{ type: "text", text: "Carry on." }] });
      assert.equal(started.status, "accepted");
      const native = await rig.nextTurn();
      await native.say("Done.");
      await native.complete();
      await opened.until(() => opened.bodies("turn.terminal").find((body) => body.status === "completed"), "the turn to complete");
      assert.equal(opened.bodies("session.replaced").length, 0, "the thread itself was resumed, not replaced");
    } finally {
      await rig.cleanup();
    }
  });
});
