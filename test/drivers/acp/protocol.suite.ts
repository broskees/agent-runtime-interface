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
  test(`v${protocol}: fork constraints are capabilities; an agent that refuses another directory turns crossCwd off`, async () => {
    const rig = await openRig({ name: "fork", driver: acpDriver, config: config(2, { forkAcrossDirectories: true }), executable: "fake-acp-agent", protocol, agentArgs: ["--fork"] });
    try {
      const { session, events, waitFor } = await rig.open();
      assert.equal(session.capabilities().threads.fork.supported, true);
      assert.equal(session.capabilities().threads.fork.crossCwd, true, "declared from the driver's config");
      assert.equal(session.capabilities().threads.fork.fromTurn, false);
      const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
      const sameDirectory = await session.forkThread!({ threadId: thread.id, at: { type: "latest" } });
      assert.notEqual(sameDirectory.id, thread.id);
      assert.equal(sameDirectory.cwd, rig.cwd);
      await assert.rejects(session.forkThread!({ threadId: thread.id, at: { type: "latest" }, cwd: rig.otherCwd }), (error) => isAriError(error, "unsupported") && error.callError.code === "unsupported" && error.callError.capability === "threads.fork.crossCwd");
      assert.equal(session.capabilities().threads.fork.crossCwd, false, "the refusal is now declared");
      await waitFor((event) => event.body.type === "capabilities.updated" && event.body.capabilities.threads.fork.crossCwd === false, "capabilities.updated with crossCwd false");
      // Declared off, a fork into another directory is refused before the agent hears of it.
      const forks = (): number => frameMessages(rig.harness.frames, "client").filter((message) => message["method"] === "session/fork").length;
      const before = forks();
      await assert.rejects(session.forkThread!({ threadId: thread.id, at: { type: "latest" }, cwd: rig.otherCwd }), (error) => isAriError(error, "unsupported"));
      assert.equal(forks(), before);
      assert.ok(events.length > 0);
    } finally {
      await rig.cleanup();
    }
  });
}

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
