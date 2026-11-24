// The Claude quirks the driver keeps: permission prompts from canUseTool are
// live requests answered through respond; a fork from a turn uses the SDK's
// forkSession and resumeSessionAt options; model, permission mode and MCP
// server changes go through the query's control methods; stopTask backs
// backgroundTasks.stop; steering interrupts the running native turn;
// ari.goal is filled from the transcript and marked derived; MCP servers
// with alwaysLoad keep it; claude.hooks and claude.fileCheckpoints are
// listed extensions that work.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import type { Request } from "../../../src/generated/request.ts";
import { CLAUDE_CAPABILITIES, CLAUDE_EXTENSIONS, subagentIdFor } from "../../../src/drivers/claude/index.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { openClaudeRig, until } from "./rig.ts";
import type { ClaudeRig } from "./rig.ts";

function requests(rig: ClaudeRig): Request[] {
  const latest = new Map<string, Request>();
  for (const event of rig.log.events) {
    if (event.body.type !== "request.upsert") continue;
    const patch = event.body.request;
    latest.set(patch.id, { ...(latest.get(patch.id) ?? ({} as Request)), ...(patch as Request) });
  }
  return [...latest.values()];
}

describe("claude driver quirks", () => {
  test("the SDK is loaded with a dynamic import() of the optional peer, never a static import", () => {
    const sources = fs.readdirSync(path.join(REPO_ROOT, "src", "drivers", "claude")).map((name) => fs.readFileSync(path.join(REPO_ROOT, "src", "drivers", "claude", name), "utf8"));
    for (const source of sources) assert.doesNotMatch(source, /^\s*import\s[^;]*from\s+["']@anthropic-ai\//m);
    const loader = fs.readFileSync(path.join(REPO_ROOT, "src", "drivers", "claude", "sdk.ts"), "utf8");
    assert.match(loader, /const SDK_SPECIFIER = "@anthropic-ai\/claude-agent-sdk";/);
    assert.match(loader, /await import\(SDK_SPECIFIER\)/);
  });

  test("canUseTool prompts become live requests; respond sends the chosen permission result back", async () => {
    const rig = await openClaudeRig();
    try {
      const thread = await rig.thread();
      const { turnId, native } = await rig.turn(thread.id, "Run the tests.");
      const answer = native.ask("Bash", { command: "npm test" }, {
        suggestions: [
          { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" },
          { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "session" },
        ],
      });
      const request = await until(() => requests(rig).find((candidate) => candidate.status === "pending"), "the request");
      assert.equal(request.kind, "command");
      assert.deepEqual(request.response, { mode: "live" });
      assert.equal(request.survivesRestart, false);
      assert.equal(request.origin.turnId, turnId);
      assert.deepEqual(request.subject?.command, ["npm test"]);
      assert.deepEqual(
        request.options?.map((option) => [option.optionId, option.decision, option.scope ?? null]),
        [
          ["allow", "accept", "once"],
          ["allow:session", "accept_for_session", "session"],
          ["allow:localSettings", "accept_always", "project"],
          ["deny", "decline", null],
          ["deny:interrupt", "cancel", null],
        ],
      );
      await rig.session.respond({ requestId: request.id, responseKey: "r1", optionId: "allow:localSettings" });
      const result = await answer;
      assert.deepEqual(result, {
        behavior: "allow",
        updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }],
        decisionClassification: "user_permanent",
      });
      await until(() => requests(rig).find((candidate) => candidate.id === request.id && candidate.status === "resolved"), "the request to resolve");
      // The same response key gives the same outcome; another key for a resolved request is refused.
      assert.equal(await rig.session.respond({ requestId: request.id, responseKey: "r1", optionId: "allow:localSettings" }), undefined);
      await assert.rejects(rig.session.respond({ requestId: request.id, responseKey: "r2", optionId: "deny" }), (error: { callError?: { code: string } }) => error.callError?.code === "invalid_state");

      // A denial with feedback carries the host's words to Claude.
      const denied = native.ask("Edit", { file_path: `${rig.cwd}/a.ts`, old_string: "a", new_string: "b" });
      const second = await until(() => requests(rig).find((candidate) => candidate.status === "pending"), "the second request");
      assert.equal(second.kind, "file_change");
      assert.deepEqual(second.subject?.paths, [`${rig.cwd}/a.ts`]);
      await rig.session.respond({ requestId: second.id, responseKey: "r3", optionId: "deny", feedback: "Not that file." });
      assert.deepEqual(await denied, { behavior: "deny", message: "Not that file.", decisionClassification: "user_reject" });

      // A prompt from inside a subagent names it, and a rule that must not persist offers no persistent choice.
      await native.spawnSubagent!({ name: "researcher" });
      const subagentTask = [...rig.world.sessions.get(thread.handle!)!.tasks.values()][0]!;
      const fromSubagent = native.ask("Read", { file_path: `${rig.cwd}/b.ts` }, {
        agentID: subagentTask.id,
        suppressAlwaysAllowRule: true,
        suggestions: [{ type: "addRules", rules: [{ toolName: "Read" }], behavior: "allow", destination: "userSettings" }],
      });
      const third = await until(() => requests(rig).find((candidate) => candidate.status === "pending"), "the subagent's request");
      assert.equal(third.kind, "file_read");
      assert.equal(third.origin.subagentId, subagentIdFor(thread.id, subagentTask.id));
      assert.deepEqual(third.options?.map((option) => option.optionId), ["allow", "deny", "deny:interrupt"]);
      await rig.session.respond({ requestId: third.id, responseKey: "r4", optionId: "allow" });
      assert.deepEqual(await fromSubagent, { behavior: "allow", decisionClassification: "user_temporary" });
      await native.complete();
      await rig.terminal(turnId);
    } finally {
      await rig.cleanup();
    }
  });

  test("AskUserQuestion arrives as a user_input request with Claude's questions, and the answers go back as updatedInput", async () => {
    const rig = await openClaudeRig();
    try {
      const thread = await rig.thread();
      const { turnId, native } = await rig.turn(thread.id, "Set up the project.");
      const answered = native.askQuestions([
        { question: "Which package manager?", header: "Tooling", options: [{ label: "pnpm", description: "Fast" }, { label: "npm", description: "Default" }], multiSelect: false },
        { question: "Which checks?", header: "Checks", options: [{ label: "lint", description: "" }, { label: "test", description: "" }], multiSelect: true },
      ]);
      const request = await until(() => requests(rig).find((candidate) => candidate.status === "pending"), "the question request");
      assert.equal(request.kind, "user_input");
      assert.equal(request.allowCustomAnswer, true);
      assert.deepEqual(request.questions?.map((question) => [question.id, question.type, question.prompt, question.options?.map((option) => option.id)]), [
        ["q0", "single_select", "Which package manager?", ["pnpm", "npm"]],
        ["q1", "multi_select", "Which checks?", ["lint", "test"]],
      ]);
      await rig.session.respond({ requestId: request.id, responseKey: "q", answers: { q0: { optionIds: ["pnpm"] }, q1: { optionIds: ["lint", "test"] } } });
      const result = await answered;
      assert.equal(result.behavior, "allow");
      assert.deepEqual((result as unknown as { updatedInput: { answers: unknown } }).updatedInput.answers, { "Which package manager?": "pnpm", "Which checks?": "lint, test" });
      await native.complete();
      await rig.terminal(turnId);
    } finally {
      await rig.cleanup();
    }
  });

  test("a fork from a turn starts a query with resume, forkSession and resumeSessionAt at that turn's last transcript entry", async () => {
    const rig = await openClaudeRig();
    try {
      const thread = await rig.thread();
      const first = await rig.simpleTurn(thread.id, "First task.", "First answer.");
      await rig.simpleTurn(thread.id, "Second task.", "Second answer.");
      const fork = await rig.session.forkThread!({ threadId: thread.id, at: { type: "turn", turnId: first } });
      const options = rig.world.calls.flatMap((call) => (call.kind === "query" ? [call.options] : [])).at(-1)!;
      const source = rig.world.sessions.get(thread.handle!)!;
      const firstAnswer = source.entries.find((entry) => entry.type === "assistant" && JSON.stringify(entry.message).includes("First answer."))!;
      assert.equal(options.resume, thread.handle);
      assert.equal(options.forkSession, true);
      assert.equal(options.resumeSessionAt, firstAnswer.uuid);
      assert.equal(options.sessionId, fork.handle);
      assert.notEqual(fork.id, thread.id);
      assert.deepEqual(fork.forkedFrom, { threadId: thread.id, turnId: first });
      assert.deepEqual(rig.world.inspect(fork.handle!)?.prompts, ["First task."]);
      await rig.simpleTurn(fork.id, "Continue in the fork.");
      assert.deepEqual(rig.world.inspect(fork.handle!)?.prompts, ["First task.", "Continue in the fork."]);
      assert.deepEqual(rig.world.inspect(thread.handle!)?.prompts, ["First task.", "Second task."]);
      // A fork at the latest point copies everything; a fork into another directory is refused before anything starts.
      const latest = await rig.session.forkThread!({ threadId: thread.id, at: { type: "latest" } });
      assert.deepEqual(rig.world.inspect(latest.handle!)?.prompts, ["First task.", "Second task."]);
      const queries = rig.world.queries.length;
      await assert.rejects(rig.session.forkThread!({ threadId: thread.id, at: { type: "latest" }, cwd: rig.otherCwd }), (error: { callError?: { code: string; capability?: string } }) => error.callError?.capability === "threads.fork.crossCwd");
      assert.equal(rig.world.queries.length, queries);
    } finally {
      await rig.cleanup();
    }
  });

  test("model, effort, permission mode and MCP server changes use the query's control methods", async () => {
    const rig = await openClaudeRig({ open: { launch: { mcpServers: [{ name: "docs", transport: "http", url: "http://127.0.0.1:9/mcp", alwaysLoad: true }] } } });
    try {
      const thread = await rig.thread();
      const handle = thread.handle!;
      const setServers = () => rig.world.calls.filter((call) => call.kind === "setMcpServers" && call.sessionId === handle);
      assert.equal(setServers().length, 1);
      await rig.simpleTurn(thread.id, "Hello.");
      const { turnId, native } = await rig.turn(thread.id, "Now with another model.", { config: { model: "opus", effort: "high" }, policy: { ...rig.policy("full_access") } });
      assert.deepEqual(rig.world.calls.filter((call) => call.kind === "setModel").map((call) => (call.kind === "setModel" ? call.model : undefined)), ["opus"]);
      assert.deepEqual(rig.world.calls.filter((call) => call.kind === "setPermissionMode").map((call) => (call.kind === "setPermissionMode" ? call.mode : undefined)), ["bypassPermissions"]);
      assert.deepEqual(rig.world.calls.filter((call) => call.kind === "applyFlagSettings").map((call) => (call.kind === "applyFlagSettings" ? call.settings : undefined)), [{ effortLevel: "high" }]);
      await native.complete();
      await rig.terminal(turnId);
      // The plan says when a change takes effect, without applying it.
      assert.deepEqual(await rig.session.planConfigChange({ threadId: thread.id, changes: { model: "sonnet" } }), { type: "apply_next_turn" });
      assert.equal((await rig.session.planConfigChange({ threadId: thread.id, changes: { sandbox: "x" } })).type, "reject");
      // A resume of the live thread with a new launch replaces its MCP servers through setMcpServers.
      await rig.session.resumeThread({ native: { handle }, launch: { mcpServers: [{ name: "search", transport: "stdio", command: "search-mcp", alwaysLoad: true }] } });
      const latest = setServers().at(-1);
      assert.ok(latest?.kind === "setMcpServers");
      assert.deepEqual(Object.keys(latest.servers).sort(), ["docs", "search", `host-tools-${thread.id}`].sort());
      assert.deepEqual(latest.servers["search"], { type: "stdio", command: "search-mcp", alwaysLoad: true });
      assert.deepEqual(latest.servers["docs"], { type: "http", url: "http://127.0.0.1:9/mcp", alwaysLoad: true });
      assert.equal(setServers().length, 2);
    } finally {
      await rig.cleanup();
    }
  });

  test("LaunchContext.mcpServers with alwaysLoad reach the SDK with alwaysLoad, before the thread's first prompt", async () => {
    const rig = await openClaudeRig({ host: { mcpServerName: () => "host-orchestration" } });
    try {
      const thread = await rig.thread({ launch: { mcpServers: [{ name: "orchestrator", transport: "stdio", command: "orchestrate", args: ["--thread"], alwaysLoad: true }, { name: "lazy", transport: "sse", url: "http://127.0.0.1:9/sse" }] } });
      await rig.simpleTurn(thread.id, "Use the tools.");
      const index = rig.world.calls.findIndex((call) => call.kind === "setMcpServers");
      const firstPrompt = rig.world.calls.findIndex((call) => call.kind === "prompt");
      assert.ok(index >= 0 && index < firstPrompt, "setMcpServers came after the first prompt");
      const call = rig.world.calls[index]!;
      assert.ok(call.kind === "setMcpServers");
      assert.deepEqual(call.servers, {
        orchestrator: { type: "stdio", command: "orchestrate", args: ["--thread"], alwaysLoad: true },
        lazy: { type: "sse", url: "http://127.0.0.1:9/sse" },
        "host-orchestration": { type: "http", url: `http://127.0.0.1/ari-conformance/mcp/${encodeURIComponent(thread.id)}`, alwaysLoad: true },
      });
    } finally {
      await rig.cleanup();
    }
  });

  test("stopTask backs backgroundTasks.stop and stopSubagent", async () => {
    const rig = await openClaudeRig();
    try {
      const thread = await rig.thread();
      const { turnId, native } = await rig.turn(thread.id, "Start the server.");
      await native.startBackgroundTask!({ title: "npm run dev" });
      await native.spawnSubagent!({ name: "reviewer" });
      await native.complete();
      await rig.terminal(turnId);
      const tasks = await rig.session.backgroundTasks!.list(thread.id);
      assert.deepEqual(tasks.map((task) => [task.kind, task.status, task.title]), [["terminal", "running", "npm run dev"]]);
      const withSubagents = await rig.session.backgroundTasks!.list(thread.id, { includeSubagents: true });
      assert.equal(withSubagents.length, 2);
      assert.equal(rig.session.canRelease(), false);
      await rig.session.backgroundTasks!.stop({ threadId: thread.id, taskId: tasks[0]!.id });
      const stops = rig.world.calls.filter((call) => call.kind === "stopTask");
      assert.equal(stops.length, 1);
      assert.match(stops[0]!.kind === "stopTask" ? stops[0]!.taskId : "", /^bash_/);
      assert.deepEqual(rig.world.inspect(thread.handle!)?.backgroundTasks, [{ title: "npm run dev", running: false }]);
      assert.equal((await rig.session.backgroundTasks!.list(thread.id))[0]!.status, "stopped");
      const subagent = withSubagents.find((task) => task.kind === "subagent")!;
      const outcome = await rig.session.stopSubagent!({ subagentId: subagent.subagentId! });
      assert.equal(outcome?.status, "cancelled");
      assert.deepEqual(rig.world.inspect(thread.handle!)?.subagents, [{ name: "reviewer", running: false }]);
      assert.equal(rig.world.calls.filter((call) => call.kind === "stopTask").length, 2);
      const settled = rig.log.filter((event) => event.body.type === "subagent.upsert").at(-1);
      assert.ok(settled?.body.type === "subagent.upsert" && settled.body.subagent.status === "cancelled");
      assert.equal(rig.session.canRelease(), true);
    } finally {
      await rig.cleanup();
    }
  });

  test("capabilities declare that steering interrupts tools, and a steer is a prompt with priority now inside the same host turn", async () => {
    assert.equal(CLAUDE_CAPABILITIES.turns.steeringInterruptsTools, true);
    assert.equal(CLAUDE_CAPABILITIES.turns.steer, true);
    const rig = await openClaudeRig();
    try {
      const thread = await rig.thread();
      const { turnId, native } = await rig.turn(thread.id, "Refactor the parser.");
      await native.runTool({ name: "read_file", input: {}, output: "x", path: "parser.ts" });
      const steered = await rig.session.startTurn({ threadId: thread.id, clientTurnKey: "steer-1", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "Keep the public API." }] });
      assert.deepEqual({ status: steered.status, turnId: steered.status === "accepted" ? steered.turnId : undefined, accepted: steered.status === "accepted" ? steered.accepted : undefined }, { status: "accepted", turnId, accepted: "steered" });
      assert.equal(await native.nextSteer!(), "Keep the public API.");
      const sent = rig.world.prompts().at(-1)!;
      assert.equal(sent.priority, "now");
      // Claude ended the native turn to read the steer (terminal_reason aborted_streaming); the host's turn goes on.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(rig.log.find((event) => event.body.type === "turn.terminal"), undefined);
      await native.say("Kept it.");
      await native.complete();
      const terminal = await rig.terminal(turnId);
      assert.equal(terminal.status, "completed");
      // A steer for a turn that ended is refused for the host to send a new turn.
      assert.deepEqual(await rig.session.startTurn({ threadId: thread.id, clientTurnKey: "steer-2", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "Late." }] }), { status: "prompt_required" });
      const snapshot = await rig.session.readSnapshot!(thread.id);
      assert.deepEqual(snapshot.turns.map((turn) => turn.id), [turnId]);
      assert.deepEqual(snapshot.items.filter((item) => item.kind === "user_message").map((item) => item.text), ["Refactor the parser.", "Keep the public API."]);
    } finally {
      await rig.cleanup();
    }
  });

  test("ari.goal is filled from the transcript and marked derived", async () => {
    const rig = await openClaudeRig();
    try {
      const thread = await rig.thread();
      const { turnId, native } = await rig.turn(thread.id, "Make the tests pass.");
      await native.proposeGoal("all tests in test/auth pass");
      const updated = await until(() => rig.log.find((event) => event.body.type === "x:ari.goal.updated"), "x:ari.goal.updated");
      assert.deepEqual((updated.body as { data: unknown }).data, { threadId: thread.id, objective: "all tests in test/auth pass", status: "active", derived: true, turnIds: [turnId], updatedAt: ((updated.body as { data: { updatedAt: string } }).data).updatedAt });
      await native.complete();
      await rig.terminal(turnId);
      const second = await rig.simpleTurn(thread.id, "Keep going.");
      // A fresh session reads the same goal back from the transcript alone.
      const { session } = await rig.openAnother();
      const resumed = await session.resumeThread({ native: { handle: thread.handle! }, policy: rig.policy() });
      assert.deepEqual(await session.ext!("ari.goal", "get", { threadId: resumed.id }), { threadId: thread.id, objective: "all tests in test/auth pass", status: "active", derived: true, turnIds: [turnId, second] });
      await assert.rejects(session.ext!("ari.goal", "set", { threadId: resumed.id, objective: "x" }), (error: { callError?: { code: string; capability?: string } }) => error.callError?.capability === "extensions.ari.goal.set");
      // A /goal prompt sets the goal, and /goal clear clears it.
      const { native: goalTurn } = await rig.turn(thread.id, "/goal the build is green");
      await goalTurn.complete();
      assert.equal(((await rig.session.ext!("ari.goal", "get", { threadId: thread.id })) as { objective: string }).objective, "the build is green");
      const { native: clearTurn } = await rig.turn(thread.id, "/goal clear");
      await clearTurn.complete();
      assert.equal(await rig.session.ext!("ari.goal", "get", { threadId: thread.id }), null);
    } finally {
      await rig.cleanup();
    }
  });

  test("claude.hooks and claude.fileCheckpoints are listed extensions: hooks are set with applyFlagSettings and reported as x:claude.hook events; files rewind with rewindFiles", async () => {
    assert.deepEqual(CLAUDE_EXTENSIONS, ["claude.hooks", "claude.fileCheckpoints", "ari.goal"]);
    assert.deepEqual(CLAUDE_CAPABILITIES.extensions, [
      { ns: "claude.hooks", version: "1" },
      { ns: "claude.fileCheckpoints", version: "1" },
      { ns: "ari.goal", version: "1" },
    ]);
    const rig = await openClaudeRig();
    try {
      const thread = await rig.thread();
      const options = rig.world.calls.find((call) => call.kind === "query")!;
      assert.ok(options.kind === "query" && options.options.enableFileCheckpointing === true && options.options.includeHookEvents === true);
      const hooks = { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command" as const, command: "npm run lint" }] }] };
      assert.equal(await rig.session.ext!("claude.hooks", "set", { threadId: thread.id, hooks }), null);
      assert.deepEqual(rig.world.calls.filter((call) => call.kind === "applyFlagSettings").map((call) => (call.kind === "applyFlagSettings" ? call.settings : undefined)), [{ hooks }]);
      const { turnId, native } = await rig.turn(thread.id, "Edit the file.");
      await native.runHook("lint", "PostToolUse", "lint passed");
      const hookEvents = await until(() => {
        const found = rig.log.filter((event) => event.body.type === "x:claude.hook");
        return found.length === 2 ? found : undefined;
      }, "two x:claude.hook events");
      assert.deepEqual(hookEvents.map((event) => ((event.body as { data: { phase: string } }).data.phase)), ["started", "response"]);
      assert.equal(hookEvents[1]!.turnId, turnId);
      await native.complete();
      await rig.terminal(turnId);
      const rewound = await rig.session.ext!("claude.fileCheckpoints", "rewind", { threadId: thread.id, turnId, dryRun: true });
      const call = rig.world.calls.find((candidate) => candidate.kind === "rewindFiles");
      assert.ok(call?.kind === "rewindFiles");
      assert.equal(call.dryRun, true);
      assert.equal(call.userMessageId, rig.world.prompts().find((prompt) => prompt.message.content !== undefined && JSON.stringify(prompt.message.content).includes("Edit the file."))!.uuid);
      assert.deepEqual(rewound, call.result);
      await assert.rejects(rig.session.ext!("claude.other", "x", {}), (error: { callError?: { capability?: string } }) => error.callError?.capability === "extensions.claude.other");
    } finally {
      await rig.cleanup();
    }
  });

  test("rate limit events become limits.updated and the instance's limits; a usage limit fails the turn with its reset time", async () => {
    const rig = await openClaudeRig();
    try {
      const thread = await rig.thread();
      const { turnId, native } = await rig.turn(thread.id, "Work.");
      await native.rateLimit({ status: "allowed_warning", resetsAt: 1_900_000_000, rateLimitType: "seven_day", utilization: 0.8 });
      const limits = await until(() => rig.log.find((event) => event.body.type === "limits.updated"), "limits.updated");
      assert.deepEqual((limits.body as { limits: unknown }).limits, { windows: [{ window: "weekly", utilization: 0.8, resetsAt: new Date(1_900_000_000_000).toISOString() }], limited: false });
      const resetAt = new Date(1_900_003_600_000).toISOString();
      await native.fail({ kind: "usage_limit", message: "resets soon", resetAt });
      const terminal = await rig.terminal(turnId);
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.failure?.class, "usage_limit");
      assert.equal(terminal.failure?.resetAt, resetAt);
      const current = await rig.instance.limits!.current();
      assert.equal(current.limited, true);
      assert.equal(current.resetsAt, resetAt);
      assert.deepEqual(current.windows.map((window) => window.window).sort(), ["5h", "weekly"]);
    } finally {
      await rig.cleanup();
    }
  });
});
