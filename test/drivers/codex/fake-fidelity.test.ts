// The fake app-server behaves as pinned Codex does where the driver's
// correctness depends on it. A raw JSON-RPC client talks to the fake here,
// with no driver in between; each test names the pinned source the fake
// follows (paths under codex-rs/ at commit 3d86e43b, tag rust-v0.172.0).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { FakeSpawnRequest } from "../../../src/conformance/index.ts";
import { FakeCodexWorld, isUuid, pinnedApproval } from "./fake-app-server.ts";
import type { CodexNativeTurn } from "./fake-app-server.ts";

type JsonObject = { [key: string]: unknown };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A world and a raw client on one of its app-servers. */
function rawAppServer(options: { goalAutopilot?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-codex-raw-")));
  roots.push(root);
  const world = new FakeCodexWorld({ realpath: (value) => fs.realpathSync(value), ...options });
  const process = world.spawn({ command: "/usr/local/bin/codex", args: ["app-server"], environment: { HOME: root } } as FakeSpawnRequest);
  const frames: JsonObject[] = [];
  let partial = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of process.stdout) {
      partial += decoder.decode(chunk);
      let newline = partial.indexOf("\n");
      while (newline !== -1) {
        frames.push(JSON.parse(partial.slice(0, newline)) as JsonObject);
        partial = partial.slice(newline + 1);
        newline = partial.indexOf("\n");
      }
    }
  })();
  let nextId = 1;
  const until = async <T>(find: () => T | undefined, what: string): Promise<T> => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const found = find();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  const client = {
    world,
    root,
    frames,
    until,
    send: (frame: JsonObject) => process.write(`${JSON.stringify(frame)}\n`),
    /** Sends a request and returns its id; `answer(id)` waits for the response. */
    async call(method: string, params: JsonObject = {}): Promise<number> {
      const id = nextId;
      nextId += 1;
      await client.send({ id, method, params });
      return id;
    },
    answer: (id: number) => until(() => frames.find((frame) => frame["id"] === id && !("method" in frame)), `the answer to request ${id}`),
    async request(method: string, params: JsonObject = {}): Promise<JsonObject> {
      return client.answer(await client.call(method, params));
    },
    async result(method: string, params: JsonObject = {}): Promise<JsonObject> {
      const response = await client.request(method, params);
      assert.ok("result" in response, `${method} failed: ${JSON.stringify(response["error"])}`);
      return response["result"] as JsonObject;
    },
    async handshake(): Promise<void> {
      await client.result("initialize", { clientInfo: { name: "raw", title: null, version: "0" }, capabilities: { experimentalApi: true } });
      await client.send({ method: "initialized" });
    },
    async startThread(params: JsonObject = {}): Promise<string> {
      const started = await client.result("thread/start", { cwd: root, ...params });
      return (started["thread"] as { id: string }).id;
    },
    /** The index in `frames` of the first frame matching. */
    indexOf: (match: (frame: JsonObject) => boolean) => frames.findIndex(match),
  };
  return client;
}

function errorOf(response: JsonObject): { code: number; message: string } {
  assert.ok("error" in response, `expected an error, got ${JSON.stringify(response)}`);
  return response["error"] as { code: number; message: string };
}

async function nextTurn(world: FakeCodexWorld, queue: "client" | "codex" = "client"): Promise<CodexNativeTurn> {
  const next = await Promise.race([(queue === "client" ? world.turnQueue : world.autonomousTurns).next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no turn")), 3000))]);
  if (next.done === true) throw new Error("disposed");
  return next.value;
}

describe("the fake app-server follows pinned Codex", () => {
  test("handshake: requests before initialize are refused, a second initialize is refused, and a request before `initialized` is a problem", async () => {
    // message_processor.rs:1047–1049; initialize_processor.rs:68–70.
    const client = rawAppServer();
    assert.deepEqual(errorOf(await client.request("thread/list", {})), { code: -32600, message: "Not initialized" });
    await client.result("initialize", { clientInfo: { name: "raw", title: null, version: "0" }, capabilities: { experimentalApi: true } });
    assert.deepEqual(errorOf(await client.request("initialize", { clientInfo: { name: "raw", title: null, version: "0" } })), { code: -32600, message: "Already initialized" });
    await client.result("thread/list", {});
    assert.match(client.world.validator.problems.at(-1)!.message, /thread\/list sent before the initialized notification/);
    const before = client.world.validator.problems.length;
    await client.send({ method: "initialized" });
    await client.result("thread/list", {});
    assert.equal(client.world.validator.problems.length, before);
    client.world.dispose();
  });

  test("a second reply to a server request is validated and recorded as a problem; Codex has no callback left for it", async () => {
    // outgoing_message.rs:603–631.
    const client = rawAppServer();
    await client.handshake();
    const threadId = await client.startThread({ approvalPolicy: "untrusted" });
    await client.result("turn/start", { threadId, input: [{ type: "text", text: "Check.", text_elements: [] }] });
    const turn = await nextTurn(client.world);
    const approval = await turn.commandApproval("git status", ["accept", "cancel"]);
    const asked = await client.until(() => client.frames.find((frame) => frame["method"] === "item/commandExecution/requestApproval"), "the approval");
    await client.send({ id: asked["id"], result: { decision: "accept" } });
    assert.equal(await approval.decision, "accept");
    assert.equal(client.world.validator.problems.length, 0);
    await client.send({ id: asked["id"], result: { decision: "always" } });
    await client.until(() => (client.world.validator.problems.length >= 2 ? true : undefined), "both problems");
    const messages = client.world.validator.problems.map((problem) => problem.message);
    assert.ok(messages.some((message) => /does not match/.test(message)), "the second reply is still checked against the schema");
    assert.ok(messages.some((message) => /a second reply to server request 0 \(item\/commandExecution\/requestApproval\)/.test(message)));
    client.world.dispose();
  });

  test("turn/interrupt answers only when the turn aborts, just before its turn/completed; another active turn's id is refused", async () => {
    // turn_processor.rs:1550–1605; bespoke_event_handling.rs:1288–1290, 1645–1662.
    const client = rawAppServer();
    await client.handshake();
    const threadId = await client.startThread();
    const started = await client.result("turn/start", { threadId, input: [{ type: "text", text: "Work.", text_elements: [] }] });
    const turnId = (started["turn"] as { id: string }).id;
    const turn = await nextTurn(client.world);
    const wrong = errorOf(await client.request("turn/interrupt", { threadId, turnId: "019a0000-0000-7000-9000-0000000000ff" }));
    assert.equal(wrong.code, -32600);
    assert.equal(wrong.message, `expected active turn id 019a0000-0000-7000-9000-0000000000ff but found ${turnId}`);
    const interrupt = await client.call("turn/interrupt", { threadId, turnId });
    assert.equal(await turn.stopRequested(), "cancel");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(client.indexOf((frame) => frame["id"] === interrupt && !("method" in frame)), -1, "Codex has not answered while the turn still runs");
    await turn.finishCancelled();
    await client.answer(interrupt);
    await client.until(() => client.frames.find((frame) => frame["method"] === "turn/completed"), "turn/completed");
    const answered = client.indexOf((frame) => frame["id"] === interrupt && !("method" in frame));
    const completed = client.indexOf((frame) => frame["method"] === "turn/completed");
    assert.ok(answered !== -1 && completed !== -1 && answered < completed, "the answer goes out just before turn/completed");
    assert.deepEqual(errorOf(await client.request("turn/interrupt", { threadId, turnId })), { code: -32600, message: "no active turn to interrupt" });
    client.world.dispose();
  });

  test("thread/list refuses malformed or too many filter ids with -32602, filters before paging, and exclusions win", async () => {
    // thread_processor.rs:6335–6348; app-server README lines 57–79.
    const client = rawAppServer();
    await client.handshake();
    const ids: string[] = [];
    for (const prompt of ["one", "two", "three"]) {
      const threadId = await client.startThread();
      await client.result("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }] });
      await (await nextTurn(client.world)).complete();
      ids.push(threadId);
    }
    assert.deepEqual(errorOf(await client.request("thread/list", { includedThreadIds: ["not-a-uuid"] })).code, -32602);
    assert.match(errorOf(await client.request("thread/list", { excludedThreadIds: [ids[0], "thread-1"] })).message, /^invalid excluded thread id/);
    assert.match(errorOf(await client.request("thread/list", { excludedThreadIds: Array.from({ length: 101 }, () => ids[0]) })).message, /excludedThreadIds accepts at most 100 entries/);
    const page = await client.result("thread/list", { includedThreadIds: [ids[0], ids[2]], excludedThreadIds: [ids[2]], limit: 1 });
    assert.deepEqual((page["data"] as Array<{ id: string }>).map((thread) => thread.id), [ids[0]]);
    assert.equal(page["nextCursor"], null, "filters apply before paging, so one match fills the page and ends the list");
    assert.equal(isUuid(ids[0]!), true);
    client.world.dispose();
  });

  test("background terminal process ids are i32 numbers, and terminating parses the id as i32 first", async () => {
    // thread_processor.rs:2707–2721.
    const client = rawAppServer();
    await client.handshake();
    const threadId = await client.startThread();
    await client.result("turn/start", { threadId, input: [{ type: "text", text: "Serve.", text_elements: [] }] });
    const turn = await nextTurn(client.world);
    await turn.startBackgroundTask!({ title: "npm run dev" });
    await turn.complete();
    const listed = await client.result("thread/backgroundTerminals/list", { threadId });
    const processId = (listed["data"] as Array<{ processId: string }>)[0]!.processId;
    assert.match(processId, /^\d+$/);
    assert.deepEqual(errorOf(await client.request("thread/backgroundTerminals/terminate", { threadId, processId: `proc-${processId}` })), { code: -32600, message: "invalid background terminal process id: invalid digit found in string" });
    assert.deepEqual(await client.result("thread/backgroundTerminals/terminate", { threadId, processId }), { terminated: true });
    client.world.dispose();
  });

  test("a fresh thread cannot be resumed before its first turn; archive gives it a rollout; a loaded thread's resume ignores config, a cold one applies it", async () => {
    // tests/suite/v2/thread_resume.rs:521–566; thread_processor.rs:1895–1904, 4900–4955; tests/suite/v2/thread_archive.rs:313–355.
    const client = rawAppServer();
    await client.handshake();
    const threadId = await client.startThread({ config: { "mcp_servers.launch": { url: "http://127.0.0.1:1/mcp" } } });
    assert.equal(errorOf(await client.request("thread/resume", { threadId, config: { "mcp_servers.host": { url: "http://127.0.0.1:2/mcp" } } })).message, `no rollout found for thread id ${threadId}`);
    assert.deepEqual((await client.result("thread/list", {}))["data"], [], "a thread without a rollout is not listed");
    assert.match(errorOf(await client.request("thread/turns/list", { threadId })).message, /is not materialized yet/);
    assert.equal(errorOf(await client.request("thread/resume", { threadId: "thread-x" })).message.startsWith("invalid session id"), true);

    await client.result("thread/archive", { threadId });
    assert.ok(client.frames.some((frame) => frame["method"] === "thread/archived"));
    assert.equal(client.world.inspect(threadId)!.loaded, false, "archiving shuts the thread down");
    await client.result("thread/unarchive", { threadId });
    await client.result("thread/resume", { threadId, config: { "mcp_servers.host": { url: "http://127.0.0.1:2/mcp" } } });
    assert.deepEqual(client.world.storedThread(threadId)!.settings.mcpServers, ["host"], "a cold resume applies its config");
    await client.result("thread/resume", { threadId, config: { "mcp_servers.other": { url: "http://127.0.0.1:3/mcp" } } });
    assert.deepEqual(client.world.storedThread(threadId)!.settings.mcpServers, ["host"], "a resume of the loaded thread ignores its config");
    client.world.dispose();
  });

  test("approval settings persist: omitted on resume or fork they keep the thread's or the source's; turn/start overrides last", async () => {
    // thread_processor.rs:4782–4791, 5788–5794; turn_processor.rs:865–990.
    const client = rawAppServer();
    await client.handshake();
    const threadId = await client.startThread({ approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
    await client.result("turn/start", { threadId, input: [{ type: "text", text: "One.", text_elements: [] }] });
    await (await nextTurn(client.world)).complete();
    await client.result("thread/unsubscribe", { threadId });
    const resumed = await client.result("thread/resume", { threadId, approvalPolicy: "untrusted" });
    assert.equal(resumed["approvalsReviewer"], "auto_review", "an omitted reviewer keeps the persisted one");
    const forked = await client.result("thread/fork", { threadId });
    assert.equal(forked["approvalsReviewer"], "auto_review", "a fork keeps the source's reviewer");
    await client.result("turn/start", { threadId, approvalsReviewer: "user", input: [{ type: "text", text: "Two.", text_elements: [] }] });
    assert.equal((await nextTurn(client.world)).settings.approvalsReviewer, "user");
    client.world.dispose();
  });

  test("turn/start while a turn runs steers the input into it and answers with its id", async () => {
    // turn_processor.rs:722–763.
    const client = rawAppServer();
    await client.handshake();
    const threadId = await client.startThread();
    const first = await client.result("turn/start", { threadId, input: [{ type: "text", text: "First.", text_elements: [] }] });
    const turn = await nextTurn(client.world);
    const steer = turn.nextSteer!();
    const second = await client.result("turn/start", { threadId, input: [{ type: "text", text: "Also this.", text_elements: [] }] });
    assert.equal((second["turn"] as { id: string }).id, (first["turn"] as { id: string }).id);
    assert.equal(await steer, "Also this.");
    client.world.dispose();
  });

  test("an active goal set on an idle thread starts a turn at once, and Codex continues after each completed turn until the goal is met", async () => {
    // ext/goal/src/runtime.rs:223–239; tests/suite/v2/thread_goal_empty_responses.rs:141–165.
    const client = rawAppServer();
    await client.handshake();
    const threadId = await client.startThread();
    await client.result("thread/goal/set", { threadId, objective: "Finish the work" });
    const first = await nextTurn(client.world, "codex");
    assert.equal(first.prompt, "");
    await first.complete();
    const second = await nextTurn(client.world, "codex");
    await second.reachGoal();
    await second.complete();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = client.frames.filter((frame) => frame["method"] === "turn/started");
    assert.equal(started.length, 2, "no turn after the goal is met");
    assert.equal(client.world.activeTurns().length, 0);
    client.world.dispose();
  });

  test("approvals take the shapes pinned Codex produces, and under approval policy never Codex asks nothing", async () => {
    // protocol/src/approvals.rs:379–411; core/src/session/mod.rs:3433–3439; core/src/exec_policy.rs:907–911.
    const command = ["git", "status"];
    const ordinary = pinnedApproval({ kind: "command", options: [{ optionId: "once", label: "", decision: "accept" }, { optionId: "always", label: "", decision: "accept_always" }, { optionId: "no", label: "", decision: "decline" }] }, command);
    assert.deepEqual(ordinary.decisions, ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: command } }, "cancel"]);
    assert.equal(ordinary.network, false);
    const twoAlways = pinnedApproval({ kind: "command", options: [{ optionId: "a", label: "", decision: "accept_always" }, { optionId: "b", label: "", decision: "accept_always" }, { optionId: "no", label: "", decision: "decline" }] }, command);
    assert.equal(twoAlways.network, true);
    assert.deepEqual(twoAlways.decisions.filter((decision) => typeof decision === "object").length, 1, "one network amendment, never two prefixes");
    assert.notDeepEqual(twoAlways.byKit.get("a"), twoAlways.byKit.get("b"));
    assert.throws(() => pinnedApproval({ kind: "command", options: ["a", "b", "c"].map((optionId) => ({ optionId, label: "", decision: "accept_always" as const })) }, command), /at most two/);

    const client = rawAppServer();
    await client.handshake();
    const threadId = await client.startThread({ approvalPolicy: "never", sandbox: "danger-full-access" });
    await client.result("turn/start", { threadId, input: [{ type: "text", text: "Deploy.", text_elements: [] }] });
    const turn = await nextTurn(client.world);
    const handle = await turn.requestApproval({ kind: "command", options: [{ optionId: "once", label: "", decision: "accept" }, { optionId: "no", label: "", decision: "decline" }] });
    assert.equal(await handle.nextReply(), "once");
    assert.equal(client.frames.some((frame) => frame["method"] === "item/commandExecution/requestApproval"), false);
    client.world.dispose();
  });
});
