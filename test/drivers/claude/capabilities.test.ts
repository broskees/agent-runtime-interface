// Capability honesty for the Claude driver: all 44 optional members of the
// Session and Instance interfaces (inventories D and E) with the driver's
// outcome for each. A member the driver leaves out is absent (and its
// capability, if any, is off); auth.complete, which the auth group must
// carry, rejects with unsupported; each member the driver supports is
// exercised here against the fake SDK, with a check of its native effect.
// docs/drivers/claude.md gives the reason for each member left out.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hasCapability } from "../../../src/capabilities.ts";
import { CLAUDE_CAPABILITIES } from "../../../src/drivers/claude/index.ts";
import { OPTIONAL_INSTANCE_MEMBERS, OPTIONAL_SESSION_MEMBERS, memberAt } from "../../../src/wire/methods.ts";
import { openClaudeRig, until } from "./rig.ts";

/** The driver's outcome for each optional member. */
export const CLAUDE_OPTIONAL_MEMBERS: { readonly [member: string]: "supported" | "absent" | "rejects" } = {
  // Session (inventory D).
  "Session.readSnapshot": "supported",
  "Session.forkThread": "supported",
  "Session.rollbackThread": "absent",
  "Session.compactThread": "absent",
  "Session.injectHistory": "absent",
  "Session.unloadThread": "supported",
  "Session.backgroundTasks.list": "supported",
  "Session.backgroundTasks.stop": "supported",
  "Session.backgroundTasks.await": "supported",
  "Session.stopSubagent": "supported",
  "Session.mcpApps.listTools": "absent",
  "Session.mcpApps.callTool": "absent",
  "Session.mcpApps.readResource": "absent",
  "Session.contextWindow": "absent",
  "Session.canReuseContextUsage": "absent",
  "Session.uploadFeedback": "absent",
  "Session.ext": "supported",
  // Instance (inventory E).
  "Instance.invalidateCaches": "supported",
  "Instance.maintenance.advisory": "supported",
  "Instance.maintenance.install": "absent",
  "Instance.maintenance.update": "absent",
  "Instance.auth.methods": "supported",
  "Instance.auth.state": "supported",
  "Instance.auth.reportRuntimeFailure": "supported",
  "Instance.auth.start": "supported",
  "Instance.auth.complete": "rejects",
  "Instance.auth.respond": "supported",
  "Instance.auth.cancel": "supported",
  "Instance.auth.logout": "supported",
  "Instance.auth.transferProfile": "absent",
  "Instance.auth.transferSession": "absent",
  "Instance.catalog.refresh": "supported",
  "Instance.workspace.snapshot": "absent",
  "Instance.limits.current": "supported",
  "Instance.limits.accountKey": "supported",
  "Instance.limits.consumeResetCredit": "absent",
  "Instance.usageHistory.scan": "absent",
  "Instance.textGeneration.generate": "supported",
  "Instance.nativeSessions.list": "supported",
  "Instance.nativeSessions.delete": "supported",
  "Instance.nativeSessions.archive": "supported",
  "Instance.subProviders.list": "absent",
  "Instance.subProviders.set": "absent",
  "Instance.subProviders.disable": "absent",
};

describe("claude driver: capability honesty for the 44 optional members", () => {
  test("the table lists exactly the 44 optional members; absent ones are left out and their capabilities are off; auth.complete rejects with unsupported", async () => {
    const expected = [...Object.keys(OPTIONAL_SESSION_MEMBERS).map((member) => `Session.${member}`), ...OPTIONAL_INSTANCE_MEMBERS.map((member) => `Instance.${member}`)].sort();
    assert.equal(expected.length, 44);
    assert.deepEqual(Object.keys(CLAUDE_OPTIONAL_MEMBERS).sort(), expected);
    const rig = await openClaudeRig();
    try {
      for (const [qualified, outcome] of Object.entries(CLAUDE_OPTIONAL_MEMBERS)) {
        const [owner, ...rest] = qualified.split(".");
        const member = rest.join(".");
        const target = owner === "Session" ? rig.session : rig.instance;
        const found = memberAt(target, member);
        if (outcome === "absent") assert.equal(found, undefined, `${qualified} is present but the driver declares it left out`);
        else assert.equal(typeof found, "function", `${qualified} is missing`);
        if (owner === "Session") {
          const capability = (OPTIONAL_SESSION_MEMBERS as { readonly [member: string]: string })[member]!;
          assert.equal(hasCapability(CLAUDE_CAPABILITIES, capability), outcome === "supported", `${qualified}: capability ${capability} disagrees with the outcome ${outcome}`);
        }
      }
      await assert.rejects(rig.instance.auth!.complete({ flowId: "x", callbackUrl: "http://localhost/" }), (error: { callError?: { code: string; capability?: string } }) => error.callError?.code === "unsupported" && error.callError.capability === "auth.complete");
      // Dynamic tools are declared off and refused, at open and per thread, before anything starts.
      const tool = { name: "host_tool", inputSchema: { type: "object" } };
      await assert.rejects(rig.instance.openSession({ launch: { dynamicTools: [tool] } }), (error: { callError?: { capability?: string } }) => error.callError?.capability === "tools.dynamicTools");
      const queries = rig.world.queries.length;
      await assert.rejects(rig.thread({ launch: { dynamicTools: [tool] } }), (error: { callError?: { capability?: string } }) => error.callError?.capability === "tools.dynamicTools");
      assert.equal(rig.world.queries.length, queries);
      assert.equal(hasCapability(CLAUDE_CAPABILITIES, "tools.dynamicTools"), false);
      // Capabilities behind members that are left out are off too.
      for (const path of ["threads.rollback", "checkpointing.conversationRollback", "threads.compact", "threads.injectHistory", "tools.mcpApps", "contextWindowReporting", "sessions.contextUsageReuse", "sessions.feedbackUpload"]) {
        assert.equal(hasCapability(CLAUDE_CAPABILITIES, path), false, path);
      }
    } finally {
      await rig.cleanup();
    }
  });

  test("readSnapshot, forkThread, unloadThread and ext work and change the native session", async () => {
    const rig = await openClaudeRig();
    try {
      const thread = await rig.thread();
      const first = await rig.simpleTurn(thread.id, "One.", "First reply.");
      const second = await rig.simpleTurn(thread.id, "Two.", "Second reply.");
      const snapshot = await rig.session.readSnapshot!(thread.id);
      assert.equal(snapshot.thread.id, thread.id);
      assert.deepEqual(snapshot.turns.map((turn) => [turn.id, turn.status]), [[first, "completed"], [second, "completed"]]);
      assert.deepEqual(snapshot.items.filter((item) => item.kind === "user_message").map((item) => [item.turnId, item.text]), [[first, "One."], [second, "Two."]]);
      assert.deepEqual(snapshot.items.filter((item) => item.kind === "assistant_message").map((item) => [item.turnId, item.text]), [[first, "First reply."], [second, "Second reply."]]);
      // The snapshot's item ids are the ones the live events gave.
      const liveIds = new Set(rig.log.filter((event) => event.body.type === "item.upsert").map((event) => (event.body as { item: { id: string } }).item.id));
      for (const item of snapshot.items) assert.ok(liveIds.has(item.id), `snapshot item ${item.id} (${item.kind}) never appeared live`);

      const fork = await rig.session.forkThread!({ threadId: thread.id, at: { type: "turn", turnId: first } });
      assert.deepEqual(rig.world.inspect(fork.handle!)?.prompts, ["One."]);

      await rig.session.unloadThread!(thread.id);
      assert.equal(rig.world.inspect(thread.handle!)?.loaded, false);
      const resumed = await rig.session.resumeThread({ native: { handle: thread.handle! }, policy: rig.policy() });
      assert.equal(resumed.id, thread.id);
      assert.equal(rig.world.inspect(thread.handle!)?.loaded, true);
      await rig.simpleTurn(thread.id, "Three.");
      assert.deepEqual(rig.world.inspect(thread.handle!)?.prompts, ["One.", "Two.", "Three."]);

      assert.deepEqual(await rig.session.ext!("ari.goal", "get", { threadId: thread.id }), null);
      const rewound = (await rig.session.ext!("claude.fileCheckpoints", "rewind", { threadId: thread.id, turnId: second })) as { canRewind: boolean };
      assert.equal(rewound.canRewind, true);
      await assert.rejects(rig.session.ext!("x.unknown", "m", {}), (error: { callError?: { capability?: string } }) => error.callError?.capability === "extensions.x.unknown");
    } finally {
      await rig.cleanup();
    }
  });

  test("backgroundTasks.list, .stop and .await and stopSubagent work on the native tasks", async () => {
    const rig = await openClaudeRig();
    try {
      const thread = await rig.thread();
      const { turnId, native } = await rig.turn(thread.id, "Start work.");
      await native.startBackgroundTask!({ title: "watch tests" });
      await native.spawnSubagent!({ name: "helper" });
      await native.complete();
      await rig.terminal(turnId);
      const listed = await rig.session.backgroundTasks!.list(thread.id, { includeSubagents: true });
      assert.deepEqual(listed.map((task) => [task.kind, task.status]), [["terminal", "running"], ["subagent", "running"]]);
      const terminal = listed[0]!;
      assert.deepEqual(await rig.session.backgroundTasks!.await({ threadId: thread.id, taskIds: [terminal.id, "task_unknown"], awaited: true }), { matched: [terminal.id] });
      assert.equal((await rig.session.backgroundTasks!.list(thread.id))[0]!.awaited, true);
      await rig.session.backgroundTasks!.stop({ threadId: thread.id, taskId: terminal.id });
      assert.deepEqual(rig.world.inspect(thread.handle!)?.backgroundTasks, [{ title: "watch tests", running: false }]);
      const background = await until(() => rig.log.filter((event) => event.body.type === "background.updated").at(-1), "background.updated");
      assert.deepEqual((background.body as { tasks: Array<{ kind: string }> }).tasks.map((task) => task.kind), ["subagent"]);
      const outcome = await rig.session.stopSubagent!({ subagentId: listed[1]!.subagentId! });
      assert.equal(outcome?.status, "cancelled");
      assert.deepEqual(rig.world.inspect(thread.handle!)?.subagents, [{ name: "helper", running: false }]);
    } finally {
      await rig.cleanup();
    }
  });

  test("invalidateCaches, catalog.refresh and maintenance.advisory: the catalog comes from a query that is closed at once", async () => {
    const rig = await openClaudeRig();
    try {
      const catalog = await rig.instance.catalog.list();
      assert.equal(catalog.defaultModelId, "default");
      assert.deepEqual(catalog.models.map((model) => model.id), ["default", "sonnet", "opus"]);
      assert.deepEqual(catalog.models[2]!.options?.[0]?.values?.map((value) => value.id), ["low", "medium", "high", "xhigh", "max"]);
      const catalogQueries = () => rig.world.queries.filter((query) => Array.isArray(query.options.tools) && query.options.tools.length === 0);
      assert.equal(catalogQueries().length, 1);
      const query = catalogQueries()[0]!;
      assert.equal(query.alive, false);
      assert.deepEqual([query.options.settingSources, query.options.strictMcpConfig, query.options.persistSession], [[], true, false]);
      await rig.instance.catalog.list();
      assert.equal(catalogQueries().length, 1);
      await rig.instance.catalog.refresh!();
      assert.equal(catalogQueries().length, 2);
      await rig.instance.invalidateCaches!();
      await rig.instance.catalog.list();
      assert.equal(catalogQueries().length, 3);
      assert.equal(await rig.instance.maintenance!.advisory(), null);
    } finally {
      await rig.cleanup();
    }
  });

  test("auth: methods, state, an API key through start and respond, cancel, logout, and a runtime poison of the failing scope", async () => {
    const rig = await openClaudeRig({ ambientAuth: "unauthenticated" });
    try {
      const auth = rig.instance.auth!;
      assert.deepEqual(auth.methods().map((method) => [method.id, method.kind]), [["api-key", "api_key"], ["claude-login", "terminal_cli"]]);
      assert.deepEqual(await auth.state(), { status: "unauthenticated", evidence: "active", scope: "ambient" });
      const cancelled = await auth.start({ ownerSessionId: rig.session.id, methodId: "api-key", callback: { mode: "client" } });
      await auth.cancel(cancelled.flowId);
      await assert.rejects(auth.respond!({ flowId: cancelled.flowId, values: { apiKey: "sk-ant-x" } }), (error: { callError?: { code: string } }) => error.callError?.code === "not_found");
      const login = await auth.start({ ownerSessionId: rig.session.id, methodId: "claude-login", callback: { mode: "client" } });
      assert.match(login.instructions ?? "", /claude auth login/);
      const flow = await auth.start({ ownerSessionId: rig.session.id, methodId: "api-key", callback: { mode: "client" } });
      assert.deepEqual(flow.fields?.map((field) => field.id), ["apiKey"]);
      assert.deepEqual(await auth.respond!({ flowId: flow.flowId, values: { apiKey: "sk-ant-managed" } }), { status: "configured", evidence: "passive", scope: "managed_profile" });
      assert.deepEqual(rig.host.storedSecrets().map((secret) => [secret.namespace, secret.key, new TextDecoder().decode(secret.value)]), [["claude", "api-key", "sk-ant-managed"]]);
      assert.deepEqual(auth.credentialBinding, { owner: "host", key: "claude/api-key" });
      // A thread started now runs with the stored key and none inherited.
      const thread = await rig.thread();
      assert.equal(rig.world.environments().at(-1)?.["ANTHROPIC_API_KEY"], "sk-ant-managed");
      const poisoned = await auth.reportRuntimeFailure!({ code: "authentication_failed", message: "401" });
      assert.deepEqual([poisoned.status, poisoned.evidence, poisoned.scope], ["unauthenticated", "runtime_poison", "managed_profile"]);
      await auth.logout!();
      assert.deepEqual(rig.host.storedSecrets(), []);
      assert.deepEqual(await auth.state(), { status: "unauthenticated", evidence: "active", scope: "ambient" });
      assert.equal(thread.status, "idle");
    } finally {
      await rig.cleanup();
    }
  });

  test("an authentication failure in a turn fails it as a permission error and poisons the scope that failed", async () => {
    const rig = await openClaudeRig({ managedKey: "sk-ant-bad" });
    try {
      assert.deepEqual(await rig.instance.auth!.state(), { status: "configured", evidence: "passive", scope: "managed_profile" });
      const thread = await rig.thread();
      const { turnId, native } = await rig.turn(thread.id, "Hello.");
      await native.failAuthentication();
      const terminal = await rig.terminal(turnId);
      assert.deepEqual([terminal.status, terminal.failure?.class, terminal.failure?.code, terminal.threadDisposition], ["failed", "permission_error", "authentication_failed", "reusable"]);
      await new Promise((resolve) => setImmediate(resolve));
      const poisoned = await rig.instance.auth!.state();
      assert.deepEqual([poisoned.status, poisoned.evidence, poisoned.scope], ["unauthenticated", "runtime_poison", "managed_profile"]);
      assert.ok(Date.parse(poisoned.poisonExpiresAt!) > Date.now());
    } finally {
      await rig.cleanup();
    }
  });

  test("limits.current and limits.accountKey report the account's rate limit windows", async () => {
    const rig = await openClaudeRig();
    try {
      assert.deepEqual(await rig.instance.limits!.current(), { windows: [], limited: false });
      assert.match(rig.instance.limits!.accountKey(), /ambient$/);
      const thread = await rig.thread();
      const { turnId, native } = await rig.turn(thread.id, "Work.");
      await native.rateLimit({ status: "rejected", resetsAt: 1_900_000_000, rateLimitType: "five_hour", utilization: 1 });
      await native.complete();
      await rig.terminal(turnId);
      assert.deepEqual(await rig.instance.limits!.current(), { windows: [{ window: "5h", utilization: 1, resetsAt: new Date(1_900_000_000_000).toISOString() }], limited: true, resetsAt: new Date(1_900_000_000_000).toISOString() });
    } finally {
      await rig.cleanup();
    }
  });

  test("textGeneration.generate runs Claude Code without tools, MCP servers or settings, as text or against a schema", async () => {
    const rig = await openClaudeRig();
    try {
      assert.deepEqual(rig.instance.textGeneration!.guarantees, { toolsDisabled: "native" });
      const text = rig.instance.textGeneration!.generate({ kind: "commit_message", input: { diff: "+a" } });
      const turn = await rig.world.nextTurn();
      assert.match(turn.prompt, /"diff": "\+a"/);
      await turn.completeWith({ text: "Add a" });
      assert.equal(await text, "Add a");
      const options = rig.world.queries.at(-1)!.options;
      assert.deepEqual([options.tools, options.mcpServers, options.strictMcpConfig, options.settingSources, options.persistSession, options.maxTurns], [[], {}, true, [], false, 1]);
      assert.match(String(options.systemPrompt), /git commit message/);
      const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
      const structured = rig.instance.textGeneration!.generate({ kind: "title", input: "the thread", schema });
      const second = await rig.world.nextTurn();
      await second.completeWith({ structuredOutput: { title: "A title" } });
      assert.deepEqual(await structured, { title: "A title" });
      assert.deepEqual(rig.world.queries.at(-1)!.options.outputFormat, { type: "json_schema", schema });
    } finally {
      await rig.cleanup();
    }
  });

  test("nativeSessions.list, .archive and .delete use the SDK's session functions", async () => {
    const rig = await openClaudeRig();
    try {
      const thread = await rig.thread();
      await rig.simpleTurn(thread.id, "Remember me.");
      const other = await rig.thread();
      await rig.simpleTurn(other.id, "And me.");
      const page = await rig.instance.nativeSessions!.list({ cwd: rig.cwd });
      assert.deepEqual(page.items.map((item) => item.id).sort(), [thread.handle, other.handle].sort());
      assert.equal(page.nextCursor, null);
      assert.equal(page.items.find((item) => item.id === thread.handle)?.title, "Remember me.");
      assert.deepEqual(page.items.find((item) => item.id === thread.handle)?.native, { id: thread.handle, strength: "strong" });
      assert.deepEqual((await rig.instance.nativeSessions!.list({ cwd: rig.otherCwd })).items, []);
      await rig.instance.nativeSessions!.archive!(other.handle!);
      assert.equal(rig.world.sessions.get(other.handle!)?.archived, true);
      // A session one of this instance's sessions has open cannot be deleted under it.
      await assert.rejects(rig.instance.nativeSessions!.delete!(thread.handle!), (error: { callError?: { code: string } }) => error.callError?.code === "invalid_state");
      await rig.session.unloadThread!(thread.id);
      await rig.instance.nativeSessions!.delete!(thread.handle!);
      assert.equal(rig.world.sessions.has(thread.handle!), false);
    } finally {
      await rig.cleanup();
    }
  });

  test("a session nativeSessions.list returns that ARI did not create resumes with only the host's LaunchContext, and runs a turn", async () => {
    const rig = await openClaudeRig();
    try {
      // A conversation started straight through the SDK, as the user's own Claude Code would.
      const nativeId = "a1234567-0000-4000-8000-123456789abc";
      const conversation = rig.world.sdk.query({ prompt: "A conversation ARI never saw.", options: { cwd: rig.cwd, sessionId: nativeId } });
      const drained = (async () => {
        for await (const _message of conversation) void _message;
      })();
      const nativeTurn = await rig.world.nextTurn();
      await nativeTurn.say("Native reply.");
      await nativeTurn.complete();
      await drained;

      const listed = (await rig.instance.nativeSessions!.list({ cwd: rig.cwd })).items.find((item) => item.id === nativeId);
      assert.ok(listed?.handle !== undefined, "nativeSessions.list returns the conversation");
      const thread = await rig.session.resumeThread({ native: { handle: listed.handle }, policy: rig.policy(), launch: { appendSystemPrompt: ["HOST-LAUNCH-MARKER"] } });
      assert.equal(thread.native.id, nativeId);
      const options = rig.world.queries.at(-1)!.options;
      assert.equal(options.resume, nativeId);
      assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code", snapshot: false, append: "HOST-LAUNCH-MARKER" });
      await rig.simpleTurn(thread.id, "Carry on.");
      assert.equal(rig.log.find((event) => event.body.type === "session.replaced"), undefined, "the conversation itself was resumed, not replaced");
    } finally {
      await rig.cleanup();
    }
  });
});
