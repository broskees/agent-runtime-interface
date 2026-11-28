// What the ACP base driver does with each protocol version, against agents
// written with the official ACP SDK: version negotiation, v2's accepted-then-
// finished prompt lifecycle, upserts, fork constraints, config option
// dependencies, native option ids, vendor `_meta` and policy enforcement.

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { ACP_DEFAULT_CONFIG, AcpSession, acpDriver } from "../../../src/drivers/acp/index.ts";
import type { AcpDriverConfig } from "../../../src/drivers/acp/index.ts";
import type { AriEvent, ConfigOption, Item } from "../../../src/index.ts";
import { isAriError } from "../../../src/index.ts";
import type { FakeNativeTurn } from "./harness.ts";
import { endsBegunTogether, slowEnds } from "../../helpers/slow-ends.ts";
import { openRig, until } from "./rig.ts";

function config(maxProtocolVersion: 1 | 2, extra: Partial<AcpDriverConfig> = {}): AcpDriverConfig {
  return { ...ACP_DEFAULT_CONFIG, command: "fake-acp-agent", maxProtocolVersion, ...extra };
}

function frameMessages(frames: ReadonlyArray<{ from: string; message: unknown }>, from: "client" | "agent"): Array<{ [key: string]: unknown }> {
  return frames.filter((frame) => frame.from === from).map((frame) => frame.message as { [key: string]: unknown });
}

function itemUpserts(events: readonly AriEvent[], itemId: string): Array<Partial<Item>> {
  return events.flatMap((event) => (event.body.type === "item.upsert" && event.body.item.id === itemId ? [event.body.item as Partial<Item>] : []));
}

const V2_OPTIONS = [
  { configId: "provider", name: "Provider", type: "select", currentValue: "openai", options: [{ value: "openai", name: "OpenAI" }, { value: "anthropic", name: "Anthropic" }] },
  { configId: "model", name: "Model", category: "model", type: "select", currentValue: "gpt-5", options: [{ value: "gpt-5", name: "GPT-5" }, { value: "claude", name: "Claude" }] },
];

test("a v1 agent asked for v2 answers with v1, and the driver speaks v1 to it", async () => {
  const rig = await openRig({ name: "v1", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 1 });
  try {
    const { session, waitFor } = await rig.open();
    assert.equal((session as AcpSession).protocolVersion, 1);
    const initialize = frameMessages(rig.harness.frames, "client").find((message) => message["method"] === "initialize")!;
    assert.equal((initialize["params"] as { protocolVersion: number }).protocolVersion, 2);
    const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
    const started = await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Hi" }] });
    assert.equal(started.status, "accepted");
    const native = await rig.nextTurn();
    await native.complete();
    await waitFor((event) => event.body.type === "turn.terminal", "turn.terminal");
    // v1: the session/prompt response is what ended the turn, and it carries the stop reason.
    const promptId = frameMessages(rig.harness.frames, "client").find((message) => message["method"] === "session/prompt")!["id"];
    const response = frameMessages(rig.harness.frames, "agent").find((message) => message["id"] === promptId && "result" in message)!;
    assert.deepEqual(response["result"], { stopReason: "end_turn" });
  } finally {
    await rig.cleanup();
  }
});

test("a history resume reports history unavailable: ACP opens a session only live, so the driver sends no session/resume, session/load or session/new", async () => {
  const rig = await openRig({ name: "history", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 2 });
  try {
    const first = await rig.open();
    const thread = await first.session.createThread({ cwd: rig.cwd, policy: rig.policy() });
    await first.session.close();
    const { session, events } = await rig.open();
    const opens = (): number => frameMessages(rig.harness.frames, "client").filter((message) => ["session/resume", "session/load", "session/new"].includes(String(message["method"]))).length;
    const before = opens();
    await assert.rejects(session.resumeThread({ native: { handle: thread.handle! }, policy: rig.policy(), purpose: "history" }), (error) => isAriError(error, "unsupported"));
    assert.equal(opens(), before, "a history read opened a session");
    assert.ok(!events.some((event) => event.body.type === "session.replaced" || event.body.type === "thread.upsert"));
  } finally {
    await rig.cleanup();
  }
});

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: a resume the agent refuses for any reason but a missing session returns the agent's error and starts no session; a missing session is replaced`, async () => {
    const rig = await openRig({ name: "resume errors", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol, lockSessions: true });
    try {
      const first = await rig.open();
      const thread = await first.session.createThread({ cwd: rig.cwd, policy: rig.policy() });
      await first.session.close();
      // The fake answers a resume of a held session with an internal error (-32603), as ACP has no error for it.
      await rig.rig.native.lockSession!(thread);
      const { session, events } = await rig.open();
      const news = (): number => frameMessages(rig.harness.frames, "client").filter((message) => message["method"] === "session/new").length;
      const before = news();
      await assert.rejects(session.resumeThread({ native: { handle: thread.handle! }, policy: rig.policy() }), (error) => isAriError(error, "protocol") && /already open in another process/.test(error.message));
      assert.equal(news(), before, "no fresh session replaced the one the agent refused");
      assert.ok(!events.some((event) => event.body.type === "session.replaced"));

      const replaced = await session.resumeThread({ native: { handle: "ari-missing-session" }, policy: rig.policy() });
      assert.notEqual(replaced.native.id, "ari-missing-session");
      assert.equal(news(), before + 1);
      const notice = events.find((event) => event.body.type === "session.replaced");
      assert.ok(notice !== undefined && notice.body.type === "session.replaced" && notice.body.previousNativeId === "ari-missing-session" && notice.body.contextLost === true);
    } finally {
      await rig.cleanup();
    }
  });
}

test("a resume of a thread the session holds applies its config, policy and first-prompt instructions, and refuses new MCP servers, which ACP fixes when a session opens", async () => {
  const rig = await openRig({ name: "held resume", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 2, agentArgs: ["--config-options", JSON.stringify(V2_OPTIONS)] });
  try {
    const { session } = await rig.open();
    const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
    const sets = (): Array<{ [key: string]: unknown }> => frameMessages(rig.harness.frames, "client").filter((message) => message["method"] === "session/set_config_option");
    const resumed = await session.resumeThread({ native: { handle: thread.handle! }, config: { model: "claude" }, policy: rig.policy("full_access"), launch: { developerPrompt: ["ARI_HELD_DEVELOPER"] } });
    assert.equal(resumed.id, thread.id);
    assert.equal(sets().length, 1, "the new model reached the agent");
    assert.deepEqual((sets()[0]!["params"] as { configId: string; value: unknown }).configId, "model");
    assert.equal(resumed.appliedConfig?.["model"], "claude");
    const started = await session.startTurn({ threadId: thread.id, clientTurnKey: "after-held-resume", intent: "start", content: [{ type: "text", text: "Go." }] });
    assert.equal(started.status, "accepted");
    const native = await rig.nextTurn();
    const prompt = frameMessages(rig.harness.frames, "client").filter((message) => message["method"] === "session/prompt").at(-1)!;
    assert.match(JSON.stringify(prompt["params"]), /ARI_HELD_DEVELOPER/, "the resume's instructions reach the next prompt");
    await native.complete();
    await assert.rejects(
      session.resumeThread({ native: { handle: thread.handle! }, launch: { mcpServers: [{ name: "late-tools", transport: "stdio", command: "late-tools" }] } }),
      (error) => isAriError(error, "invalid_state") && /MCP servers/.test(error.message),
    );
  } finally {
    await rig.cleanup();
  }
});

test("a v2 agent negotiates v2", async () => {
  const rig = await openRig({ name: "v2", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 2 });
  try {
    const { session } = await rig.open();
    assert.equal((session as AcpSession).protocolVersion, 2);
  } finally {
    await rig.cleanup();
  }
});

test("v2: the prompt response only accepts the prompt; the turn settles on the idle state_update that finishes it", async () => {
  const rig = await openRig({ name: "v2 lifecycle", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 2 });
  try {
    const { session, events, waitFor } = await rig.open();
    const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
    const started = await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Hi" }] });
    assert.equal(started.status, "accepted");
    assert.ok(started.status === "accepted" && started.providerMessageId !== undefined && started.providerMessageId.startsWith("user-"), "the accepted result carries the agent's message id");
    const native = await rig.nextTurn();
    await native.say("Working on it.");
    await sleep(100);
    // The agent has answered session/prompt, yet the turn runs on.
    const promptId = frameMessages(rig.harness.frames, "client").find((message) => message["method"] === "session/prompt")!["id"];
    assert.ok(frameMessages(rig.harness.frames, "agent").some((message) => message["id"] === promptId && "result" in message), "the agent answered session/prompt");
    assert.equal(events.find((event) => event.body.type === "turn.terminal"), undefined);
    await native.complete();
    const terminal = await waitFor((event) => event.body.type === "turn.terminal", "turn.terminal");
    assert.equal(terminal.body.type === "turn.terminal" && terminal.body.status, "completed");
    const idle = rig.harness.frames.findIndex((frame) => {
      const params = (frame.message as { params?: { update?: { sessionUpdate?: string; state?: string } } }).params;
      return params?.update?.sessionUpdate === "state_update" && params.update.state === "idle";
    });
    assert.ok(idle !== -1, "the agent sent an idle state_update");
  } finally {
    await rig.cleanup();
  }
});

test("v2: updates are upserts by id: a tool call is created by its first update and patched by later ones; a whole message replaces its chunks", async () => {
  const rig = await openRig({ name: "v2 upserts", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 2 });
  try {
    const { session, events, waitFor } = await rig.open();
    const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
    await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Hi" }] });
    const native = (await rig.nextTurn()) as FakeNativeTurn;
    const raw = (update: { [key: string]: unknown }): Promise<void> => native.raw(update);
    await raw({ sessionUpdate: "tool_call_update", toolCallId: "t-1", title: "Read config", kind: "read", status: "pending" });
    await raw({ sessionUpdate: "tool_call_update", toolCallId: "t-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "port=8080" } }] });
    await raw({ sessionUpdate: "agent_message", messageId: "m-1", content: [{ type: "text", text: "A" }] });
    await raw({ sessionUpdate: "agent_message_chunk", messageId: "m-1", content: { type: "text", text: "B" } });
    await raw({ sessionUpdate: "agent_message", messageId: "m-1", content: [{ type: "text", text: "C" }] });
    const tool = await waitFor((event) => event.body.type === "item.upsert" && event.body.item.kind === "file_read", "the tool item");
    const toolId = tool.body.type === "item.upsert" ? tool.body.item.id : "";
    await until(() => itemUpserts(events, toolId).find((patch) => patch.status === "completed"), "the tool item to settle");
    const toolPatches = itemUpserts(events, toolId);
    assert.equal(toolPatches.filter((patch) => patch.kind !== undefined).length, 1, "the first update opened the tool item, later ones patched it");
    assert.equal(toolPatches.at(-1)?.output, "port=8080");
    const message = await until(() => {
      const opened = events.find((event) => event.body.type === "item.upsert" && event.body.item.kind === "assistant_message");
      return opened?.body.type === "item.upsert" ? opened.body.item.id : undefined;
    }, "the message item");
    await until(() => itemUpserts(events, message).find((patch) => patch.text === "C"), "the message to be replaced with C");
    const texts = itemUpserts(events, message).map((patch) => patch.text);
    assert.deepEqual(texts, ["A", "AB", "C"], "a whole message sets the text, a chunk appends, the next whole message replaces");
  } finally {
    await rig.cleanup();
  }
});

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: fork constraints are capabilities; by default the driver asks the agent for a fork into another directory, and an agent that refuses one fails only that fork`, async () => {
    const rig = await openRig({ name: "fork", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol, agentArgs: ["--fork"] });
    try {
      const { session, events } = await rig.open();
      assert.equal(session.capabilities().threads.fork.supported, true);
      assert.equal(session.capabilities().threads.fork.crossCwd, true, "the default config asks the agent");
      assert.equal(session.capabilities().threads.fork.fromTurn, false);
      const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
      const sameDirectory = await session.forkThread!({ threadId: thread.id, at: { type: "latest" } });
      assert.notEqual(sameDirectory.id, thread.id);
      assert.equal(sameDirectory.cwd, rig.cwd);
      const forks = (): number => frameMessages(rig.harness.frames, "client").filter((message) => message["method"] === "session/fork").length;
      for (const attempt of [1, 2]) {
        const before = forks();
        // The agent refuses another directory (invalid params): the caller gets the agent's error.
        await assert.rejects(session.forkThread!({ threadId: thread.id, at: { type: "latest" }, cwd: rig.otherCwd }), (error) => isAriError(error, "validation") && /forks only within/.test(error.message));
        assert.equal(forks(), before + 1, `fork ${attempt} into another directory reached the agent`);
        assert.equal(session.capabilities().threads.fork.crossCwd, true, "one refusal does not turn crossCwd off");
      }
      assert.ok(!events.some((event) => event.body.type === "capabilities.updated" && event.body.capabilities.threads.fork.crossCwd === false));
    } finally {
      await rig.cleanup();
    }
  });
}

test("forkAcrossDirectories: false is the user's choice: crossCwd is off, and a fork into another directory is refused before the agent hears of it", async () => {
  const rig = await openRig({ name: "fork refused locally", driver: acpDriver, config: config(2, { forkAcrossDirectories: false }), executable: "fake-acp-agent", protocol: 2, agentArgs: ["--fork", "--fork-cross-cwd"] });
  try {
    const { session } = await rig.open();
    assert.equal(session.capabilities().threads.fork.crossCwd, false);
    const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
    const forks = (): number => frameMessages(rig.harness.frames, "client").filter((message) => message["method"] === "session/fork").length;
    const before = forks();
    await assert.rejects(session.forkThread!({ threadId: thread.id, at: { type: "latest" }, cwd: rig.otherCwd }), (error) => isAriError(error, "unsupported") && error.callError.code === "unsupported" && error.callError.capability === "threads.fork.crossCwd");
    assert.equal(forks(), before);
  } finally {
    await rig.cleanup();
  }
});

test("an agent that forks across directories gets forks into another directory", async () => {
  const rig = await openRig({ name: "fork across", driver: acpDriver, config: config(2, { forkAcrossDirectories: true }), executable: "fake-acp-agent", protocol: 2, agentArgs: ["--fork", "--fork-cross-cwd"] });
  try {
    const { session } = await rig.open();
    const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
    const fork = await session.forkThread!({ threadId: thread.id, at: { type: "latest" }, cwd: rig.otherCwd });
    assert.equal(fork.cwd, rig.otherCwd);
    assert.deepEqual(fork.forkedFrom, { threadId: thread.id });
    assert.equal(session.capabilities().threads.fork.crossCwd, true);
  } finally {
    await rig.cleanup();
  }
});

test("an agent without session/fork declares fork off, and forkThread rejects with unsupported", async () => {
  const rig = await openRig({ name: "no fork", driver: acpDriver, config: config(1, { forkAcrossDirectories: true }), executable: "fake-acp-agent", protocol: 1 });
  try {
    const { session } = await rig.open();
    assert.equal(session.capabilities().threads.fork.supported, false);
    assert.equal(session.capabilities().threads.fork.crossCwd, false);
    const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
    await assert.rejects(session.forkThread!({ threadId: thread.id, at: { type: "latest" } }), (error) => isAriError(error, "unsupported") && error.callError.code === "unsupported" && error.callError.capability === "threads.fork");
  } finally {
    await rig.cleanup();
  }
});

test("config options keep dependsOn on every list the agent sends, including after a change replaces the list", async () => {
  const rig = await openRig({
    name: "dependsOn",
    driver: acpDriver,
    config: config(2, { configDependencies: { model: ["provider"] } }),
    executable: "fake-acp-agent",
    protocol: 2,
    agentArgs: ["--config-options", JSON.stringify(V2_OPTIONS)],
  });
  try {
    const { session, events } = await rig.open();
    const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
    assert.deepEqual(thread.appliedConfig, { provider: "openai", model: "gpt-5" });
    await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Hi" }], config: { provider: "anthropic" } });
    const native = await rig.nextTurn();
    await native.complete();
    const lists = await until(() => {
      const found = events.flatMap((event) => (event.body.type === "config.updated" ? [event.body.options] : []));
      return found.length >= 3 ? found : undefined;
    }, "the agent's lists: from session/new, the set_config_option response and its config_option_update");
    for (const options of lists) {
      const model = options.find((option: ConfigOption) => option.id === "model")!;
      assert.deepEqual(model.dependsOn, ["provider"]);
      assert.equal(model.category, "model");
      assert.equal(options.find((option: ConfigOption) => option.id === "provider")!.dependsOn, undefined);
    }
    assert.equal(lists.at(-1)!.find((option: ConfigOption) => option.id === "provider")!.current, "anthropic");
    const set = frameMessages(rig.harness.frames, "client").find((message) => message["method"] === "session/set_config_option")!;
    assert.deepEqual(set["params"], { sessionId: thread.native.id, configId: "provider", type: "id", value: "anthropic" });
    const plan = await session.planConfigChange({ threadId: thread.id, changes: { model: "claude" } });
    assert.deepEqual(plan, { type: "apply_next_turn" });
    assert.equal((await session.planConfigChange({ threadId: thread.id, changes: { colour: "red" } })).type, "reject");
  } finally {
    await rig.cleanup();
  }
});

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: a permission reply carries the agent's own option id, never its label`, async () => {
    const rig = await openRig({ name: "option ids", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol });
    try {
      const { session, waitFor } = await rig.open();
      const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
      await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Run it" }] });
      const native = await rig.nextTurn();
      const handle = await native.requestApproval({
        kind: "command",
        command: ["make", "test"],
        options: [
          { optionId: "opt-allow-7", label: "Allow this once", decision: "accept" },
          { optionId: "opt-deny-7", label: "Deny", decision: "decline" },
        ],
      });
      const upsert = await waitFor((event) => event.body.type === "request.upsert" && event.body.request.status === "pending", "the pending request");
      const request = upsert.body.type === "request.upsert" ? upsert.body.request : undefined;
      assert.equal(request?.kind, "command");
      assert.deepEqual(request?.subject?.command, ["make", "test"]);
      assert.deepEqual(
        request?.options?.map((option) => [option.optionId, option.decision, option.scope]),
        [
          ["opt-allow-7", "accept", "once"],
          ["opt-deny-7", "decline", "once"],
        ],
      );
      await assert.rejects(session.respond({ requestId: request!.id, responseKey: "label", optionId: "Allow this once" }), (error) => isAriError(error, "validation"));
      await session.respond({ requestId: request!.id, responseKey: "id", optionId: "opt-allow-7" });
      assert.equal(await handle.nextReply(), "opt-allow-7");
      const reply = frameMessages(rig.harness.frames, "client").find((message) => "result" in message && JSON.stringify(message["result"]).includes("outcome"))!;
      assert.deepEqual(reply["result"], { outcome: { outcome: "selected", optionId: "opt-allow-7" } });
      await native.complete();
    } finally {
      await rig.cleanup();
    }
  });
}

test("vendor _meta reaches the host as x:acp.meta events, and updates the driver does not map as x:acp.update", async () => {
  const rig = await openRig({ name: "meta", driver: acpDriver, config: config(1), executable: "fake-acp-agent", protocol: 1, agentArgs: ["--meta"] });
  try {
    const { session, events, waitFor } = await rig.open();
    assert.deepEqual(session.capabilities().extensions, [{ ns: "acp", version: "1" }]);
    const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
    await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Go" }] });
    const native = (await rig.nextTurn()) as FakeNativeTurn;
    await native.runTool({ name: "read_file", input: { path: "README.md" }, output: "# Workspace", path: "README.md" });
    await native.raw({ sessionUpdate: "current_mode_update", currentModeId: "architect" });
    await native.complete();
    await waitFor((event) => event.body.type === "turn.terminal", "turn.terminal");
    const metas = events.flatMap((event) => (event.body.type === "x:acp.meta" ? [event.body.data as { method: string; source: string; updateKind?: string; nativeEntityId?: string; meta: { [key: string]: unknown } }] : []));
    const sources = metas.map((meta) => `${meta.method} ${meta.source}${meta.updateKind === undefined ? "" : ` ${meta.updateKind}`}`);
    for (const expected of ["initialize result", "session/new result", "session/update params tool_call", "session/update update tool_call", "session/prompt result"]) {
      assert.ok(sources.includes(expected), `no x:acp.meta from ${expected}; saw ${sources.join(", ")}`);
    }
    const tool = metas.find((meta) => meta.source === "update" && meta.updateKind === "tool_call")!;
    assert.deepEqual(tool.meta, { "fake.vendor/where": "tool_call" });
    assert.match(tool.nativeEntityId ?? "", /^call-/);
    const passed = events.find((event) => event.body.type === "x:acp.update");
    assert.ok(passed !== undefined && passed.body.type === "x:acp.update");
    assert.deepEqual((passed.body.data as { update: unknown }).update, { sessionUpdate: "current_mode_update", currentModeId: "architect" });
    assert.equal(passed.turnId !== undefined, true);
  } finally {
    await rig.cleanup();
  }
});

/** The effectiveMode each thread.upsert for the thread reported, in order. */
function modeReports(events: readonly AriEvent[], threadId: string): unknown[] {
  return events.flatMap((event) => (event.body.type === "thread.upsert" && event.body.thread.id === threadId && event.body.thread.effectiveMode !== undefined ? [event.body.thread.effectiveMode] : []));
}

test("v1: a policy without a mode leaves the agent's own: the driver answers no request itself, and the thread reports the agent's mode id and each current_mode_update", async () => {
  const modes = { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "architect", name: "Architect" }] };
  const rig = await openRig({ name: "agent mode", driver: acpDriver, config: config(1), executable: "fake-acp-agent", protocol: 1, agentArgs: ["--modes", JSON.stringify(modes)] });
  try {
    const { session, events, waitFor } = await rig.open();
    const thread = await session.createThread({ cwd: rig.cwd, policy: { interaction: "default", cwd: rig.cwd } });
    // ACP has no mode of ARI's, so the driver reports the agent's own id.
    assert.deepEqual(thread.effectiveMode, { mode: "ask", source: "harness" });
    await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Run it" }] });
    const native = (await rig.nextTurn()) as FakeNativeTurn;
    await native.raw({ sessionUpdate: "current_mode_update", currentModeId: "architect" });
    await until(() => (modeReports(events, thread.id).some((mode) => (mode as { mode?: string }).mode === "architect") ? true : undefined), "the architect report");
    assert.deepEqual(modeReports(events, thread.id).at(-1), { mode: "architect", source: "harness" });
    // No mode: the driver answers no permission request itself; the host does.
    const handle = await native.requestApproval({ kind: "command", command: ["make"], options: [{ optionId: "allow", label: "Allow", decision: "accept" }, { optionId: "deny", label: "Deny", decision: "decline" }] });
    const upsert = await waitFor((event) => event.body.type === "request.upsert" && event.body.request.status === "pending", "the pending request");
    await session.respond({ requestId: upsert.body.type === "request.upsert" ? upsert.body.request.id : "", responseKey: "r1", optionId: "allow" });
    assert.equal(await handle.nextReply(), "allow");
    await native.complete();
    await waitFor((event) => event.body.type === "turn.terminal", "turn.terminal");

    // A host's mode is the one the driver enforces, and the thread says the host chose it.
    const hosted = await session.createThread({ cwd: rig.cwd, policy: rig.policy("full_access") });
    assert.deepEqual(hosted.effectiveMode, { mode: "full_access", interaction: "default", source: "host" });
  } finally {
    await rig.cleanup();
  }
});

test("v2: a policy without a mode reports the value of the agent's mode-category option, and each change of it", async () => {
  const options = [...V2_OPTIONS, { configId: "mode", name: "Mode", category: "mode", type: "select", currentValue: "code", options: [{ value: "code", name: "Code" }, { value: "review", name: "Review" }] }];
  const rig = await openRig({ name: "mode option", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 2, agentArgs: ["--config-options", JSON.stringify(options)] });
  try {
    const { session, events } = await rig.open();
    const thread = await session.createThread({ cwd: rig.cwd, policy: { interaction: "default", cwd: rig.cwd } });
    assert.deepEqual(thread.effectiveMode, { mode: "code", source: "harness" });
    await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Go" }], config: { mode: "review" } });
    const native = await rig.nextTurn();
    await until(() => (modeReports(events, thread.id).some((mode) => (mode as { mode?: string }).mode === "review") ? true : undefined), "the review report");
    await native.complete();
  } finally {
    await rig.cleanup();
  }
});

test("v1: a resume in another session with a policy that names no mode enforces none: the thread reports the agent's own mode", async () => {
  const modes = { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] };
  const rig = await openRig({ name: "resume no policy", driver: acpDriver, config: config(1), executable: "fake-acp-agent", protocol: 1, agentArgs: ["--modes", JSON.stringify(modes)] });
  try {
    const first = await rig.open();
    const thread = await first.session.createThread({ cwd: rig.cwd, policy: rig.policy("full_access") });
    await first.session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Hi" }] });
    await (await rig.nextTurn()).complete();
    await first.waitFor((event) => event.body.type === "turn.terminal", "turn.terminal");
    const second = await rig.open();
    // The cwd comes from the policy only: give one without a mode.
    const resumed = await second.session.resumeThread({ native: { handle: thread.handle! }, policy: { interaction: "default", cwd: rig.cwd } });
    assert.deepEqual(resumed.effectiveMode, { mode: "ask", source: "harness" });
  } finally {
    await rig.cleanup();
  }
});

test("policy enforcement is declared client_boundary for every runtime mode", async () => {
  for (const protocol of [1, 2] as const) {
    const rig = await openRig({ name: "policy", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol });
    try {
      const { session } = await rig.open();
      const modes = session.capabilities().runtimePolicy.modes;
      for (const [mode, support] of Object.entries(modes)) assert.equal(support.enforcement, "client_boundary", `mode ${mode}`);
      assert.equal(modes.approval_required.supported, true);
      assert.equal(modes.full_access.supported, true);
    } finally {
      await rig.cleanup();
    }
  }
});

/** An item as a host holds it after applying its upserts in order: an omitted field is unchanged, null clears it, a value replaces it whole. */
function folded(events: readonly AriEvent[], itemId: string): { [field: string]: unknown } {
  const item: { [field: string]: unknown } = {};
  for (const patch of itemUpserts(events, itemId)) {
    for (const [field, value] of Object.entries(patch)) {
      if (value === null) delete item[field];
      else item[field] = value;
    }
  }
  return item;
}

test("switchModel is declared only while the agent offers a model option, and capabilities.updated says when it changes", async () => {
  const plain = await openRig({ name: "no model option", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 2 });
  try {
    const { session } = await plain.open();
    assert.equal(session.capabilities().sessions.switchModel, false, "no thread yet, so no model option");
    const thread = await session.createThread({ cwd: plain.cwd, policy: plain.policy() });
    assert.equal(session.capabilities().sessions.switchModel, false, "the agent offers no model option");
    assert.equal((await session.planConfigChange({ threadId: thread.id, changes: { model: "other" } })).type, "reject");
  } finally {
    await plain.cleanup();
  }
  const offering = await openRig({ name: "model option", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 2, agentArgs: ["--config-options", JSON.stringify(V2_OPTIONS)] });
  try {
    const { session, waitFor } = await offering.open();
    assert.equal(session.capabilities().sessions.switchModel, false);
    const thread = await session.createThread({ cwd: offering.cwd, policy: offering.policy() });
    await waitFor((event) => event.body.type === "capabilities.updated" && event.body.capabilities.sessions.switchModel === true, "capabilities.updated with switchModel true");
    assert.equal(session.capabilities().sessions.switchModel, true);
    assert.deepEqual(await session.planConfigChange({ threadId: thread.id, changes: { model: "claude" } }), { type: "apply_next_turn" });
  } finally {
    await offering.cleanup();
  }
});

test("each ARI session runs its own agent process, and declares sessionModel process_per_session", async () => {
  const rig = await openRig({ name: "session model", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 2 });
  try {
    const first = await rig.open();
    const second = await rig.open();
    assert.equal(rig.harness.spawns.length, 2, "one agent process per session");
    assert.equal(first.session.capabilities().sessionModel, "process_per_session");
    assert.equal(second.session.capabilities().sessionModel, "process_per_session");
  } finally {
    await rig.cleanup();
  }
});

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: one tool update sequence follows the version's rules: a status-only update keeps every field, and null ${protocol === 1 ? "keeps" : "clears"} the title, locations, raw input and raw output`, async () => {
    const rig = await openRig({ name: `v${protocol} tool updates`, driver: acpDriver, config: config(protocol), executable: "fake-acp-agent", protocol });
    try {
      const { session, events, waitFor } = await rig.open();
      const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
      await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Look around" }] });
      const native = (await rig.nextTurn()) as FakeNativeTurn;
      // v1 opens a tool call with `tool_call`; v2 with its first `tool_call_update`.
      const open = protocol === 1 ? "tool_call" : "tool_call_update";
      // An update that changes nothing emits nothing, so each step ends with a marker tool, applied after it.
      let marks = 0;
      const applied = async (update: { [key: string]: unknown }): Promise<{ [field: string]: unknown }> => {
        await native.raw({ sessionUpdate: "tool_call_update", toolCallId: "t-1", ...update });
        marks += 1;
        const mark = `mark-${marks}`;
        await native.raw({ sessionUpdate: open, toolCallId: mark, title: mark, status: "completed" });
        await waitFor((event) => event.body.type === "item.upsert" && event.body.item.native?.id === mark, mark);
        return folded(events, toolId);
      };
      const location = `${rig.cwd}/README.md`;
      await native.raw({ sessionUpdate: open, toolCallId: "t-1", title: "Read README", kind: "read", status: "in_progress", locations: [{ path: location }], rawInput: { path: "README.md" }, rawOutput: "workspace details" });
      const opened = await waitFor((event) => event.body.type === "item.upsert" && event.body.item.kind === "file_read", "the tool item");
      const toolId = opened.body.type === "item.upsert" ? opened.body.item.id : "";
      const everything = { name: "Read README", input: { path: "README.md" }, result: "workspace details" };

      // Both versions: a status-only update changes the status and nothing else.
      let item = await applied({ status: "completed" });
      assert.equal(item["status"], "completed");
      assert.equal(item["title"], "Read README");
      assert.deepEqual(item["paths"], [location]);
      assert.deepEqual(item["tool"], everything);
      assert.equal(item["output"], "workspace details");

      item = await applied({ status: "completed", title: null, locations: null });
      if (protocol === 1) {
        // v1 Tool Calls: "Only the fields being changed need to be included"; null clears nothing.
        assert.equal(item["title"], "Read README", "v1: a null title keeps the title");
        assert.deepEqual(item["paths"], [location], "v1: null locations keep the paths");
      } else {
        // v2 ToolCallUpdate: null clears.
        assert.equal(item["title"], undefined, "v2: a null title clears the title");
        assert.equal(item["paths"], undefined, "v2: null locations clear the paths");
      }
      assert.deepEqual(item["tool"], everything, "omitted raw input and output stay");
      assert.equal(item["output"], "workspace details");

      item = await applied({ rawInput: null, rawOutput: null });
      if (protocol === 1) {
        // v1 Tool Calls: for rawInput and rawOutput, omission and null "both leave the previously reported value unchanged".
        assert.deepEqual(item["tool"], everything, "v1: null raw input and output keep them");
        assert.equal(item["output"], "workspace details");
      } else {
        assert.deepEqual(item["tool"], { name: "Read README" }, "v2: null clears the raw input and output");
        assert.equal(item["output"] ?? "", "", "v2: with no raw output and no content, the output is empty");
      }
      assert.equal(item["status"], "completed");
      await native.complete();
    } finally {
      await rig.cleanup();
    }
  });
}

test("v2: a user_message upsert replaces the user item's content, and a later chunk appends to it (UserMessage)", async () => {
  const rig = await openRig({ name: "v2 user messages", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 2 });
  try {
    const { session, events, waitFor } = await rig.open();
    const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
    const started = await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Begin." }] });
    assert.ok(started.status === "accepted" && started.providerMessageId !== undefined);
    const messageId = started.status === "accepted" ? started.providerMessageId! : "";
    const native = (await rig.nextTurn()) as FakeNativeTurn;
    const userItem = await waitFor((event) => event.body.type === "item.upsert" && event.body.item.kind === "user_message", "the user item");
    const userId = userItem.body.type === "item.upsert" ? userItem.body.item.id : "";
    assert.equal(folded(events, userId)["text"], "Begin.");
    await native.raw({ sessionUpdate: "user_message", messageId, content: [{ type: "text", text: "[redacted]" }] });
    await until(() => (folded(events, userId)["text"] === "[redacted]" ? true : undefined), "the user item to be replaced with [redacted]");
    await native.raw({ sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text: " (edited)" } });
    await until(() => (folded(events, userId)["text"] === "[redacted] (edited)" ? true : undefined), "the chunk to be appended");
    const userItems = new Set(events.flatMap((event) => (event.body.type === "item.upsert" && event.body.item.kind === "user_message" ? [event.body.item.id] : [])));
    assert.equal(userItems.size, 1, "the agent's copy of the prompt is the same item, not a second one");
    await native.complete();
  } finally {
    await rig.cleanup();
  }
});

test("v2: resume applies the agent's current-state snapshot: work already running becomes a provider-initiated turn that the agent's idle settles", async () => {
  const rig = await openRig({ name: "v2 resume snapshot", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 2, agentArgs: ["--resume-state", "running"] });
  try {
    const first = await rig.open();
    const created = await first.session.createThread({ cwd: rig.cwd, policy: rig.policy() });
    await first.session.close();
    const { session, waitFor } = await rig.open();
    const thread = await session.resumeThread({ native: { handle: created.handle! }, policy: rig.policy() });
    const opened = await waitFor((event) => event.body.type === "turn.upsert" && event.body.turn.origin === "provider_initiated", "a provider-initiated turn for the running work");
    const turnId = opened.body.type === "turn.upsert" ? opened.body.turn.id : "";
    assert.equal(opened.threadId, thread.id);
    await rig.harness.sessionUpdate(created.native.id!, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
    const terminal = await waitFor((event) => event.body.type === "turn.terminal" && event.body.turnId === turnId, "the turn to settle on idle");
    assert.equal(terminal.body.type === "turn.terminal" && terminal.body.status, "completed");
  } finally {
    await rig.cleanup();
  }
});

for (const chunks of [false, true] as const) {
  test(`v2: the agent's copy of the first prompt${chunks ? ", in chunks," : ""} leaves the user item with the host's own text; the instructions the driver put before it stay out of the transcript`, async () => {
    const rig = await openRig({ name: "v2 prompt copy", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 2, agentArgs: chunks ? ["--echo-prompt-chunks"] : [] });
    try {
      // The agent takes no system prompt, so every instruction goes in the first prompt (channel first_user_message).
      const { session, events, waitFor } = await rig.open({ launch: { appendSystemPrompt: ["ARI_TRANSCRIPT_SYSTEM"], developerPrompt: ["ARI_TRANSCRIPT_DEVELOPER"] } });
      const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy(), context: { developer: "ARI_TRANSCRIPT_CONTEXT" } });
      const started = await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Begin." }] });
      assert.ok(started.status === "accepted" && started.providerMessageId !== undefined);
      const messageId = started.status === "accepted" ? started.providerMessageId! : "";
      const native = (await rig.nextTurn()) as FakeNativeTurn;
      for (const marker of [/ARI_TRANSCRIPT_SYSTEM/, /ARI_TRANSCRIPT_DEVELOPER/, /ARI_TRANSCRIPT_CONTEXT/]) assert.match(native.prompt, marker, "the agent got the instructions");
      // The agent reported its copy before it answered session/prompt, so the driver has applied it.
      const sentPrompt = frameMessages(rig.harness.frames, "client").find((message) => message["method"] === "session/prompt")!["params"] as { prompt: Array<{ text?: string }> };
      const instructions = sentPrompt.prompt[0]!.text!;
      assert.match(instructions, /ARI_TRANSCRIPT_SYSTEM/);
      const userItem = await waitFor((event) => event.body.type === "item.upsert" && event.body.item.kind === "user_message", "the user item");
      const userId = userItem.body.type === "item.upsert" ? userItem.body.item.id : "";
      assert.deepEqual(itemUpserts(events, userId).map((patch) => patch.text), ["Begin."], "the user item only ever shows the host's text");
      // A correction that still carries the driver's instruction block shows the agent's change without it.
      await native.raw({ sessionUpdate: "user_message", messageId, content: [{ type: "text", text: instructions }, { type: "text", text: "Begin. (checked)" }] });
      await until(() => (folded(events, userId)["text"] === "Begin. (checked)" ? true : undefined), "the corrected user item");
      for (const patch of itemUpserts(events, userId)) assert.doesNotMatch(String(patch.text), /ARI_TRANSCRIPT_/, "no instruction reaches the user item");
      await native.complete();
    } finally {
      await rig.cleanup();
    }
  });
}


test("dispose() ends every session at once: three agents that each take 1 s to end all start ending together", async () => {
  // ari-driver gives a driver's dispose 2 s before it ends the agents itself (docs/wire.md, "Lifetime"); an agent
  // that takes the whole kill grace to end must not hold up the next session's own shutdown.
  const ends = slowEnds(1000);
  const rig = await openRig({ name: "dispose", driver: acpDriver, config: config(2), executable: "fake-acp-agent", protocol: 2, wrapProcess: ends.wrap });
  try {
    for (const key of ["d1", "d2", "d3"]) {
      const { session, waitFor } = await rig.open();
      const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
      await session.startTurn({ threadId: thread.id, clientTurnKey: key, intent: "start", content: [{ type: "text", text: "Hi" }] });
      await (await rig.nextTurn()).complete();
      await waitFor((event) => event.body.type === "turn.terminal", "turn.terminal");
    }
    const started = Date.now();
    await rig.instance.dispose();
    assert.equal(ends.startedAt.length, 3, "each session's agent was ended");
    assert.equal(endsBegunTogether(ends.startedAt, 500), 3, `the three ends began together: ${ends.startedAt.map((time) => time - started).join(", ")} ms after dispose()`);
  } finally {
    await rig.cleanup();
  }
});
