// OpenCode's quirks, kept: the runtime follows the server's version (1.x or
// 2.x) and declares the session model it really runs; an external server is
// externally owned and never stopped; MCP registrations are per directory, so
// on a shared server each thread gets its own host-named entry and a deny
// rule for every other thread's entry; "always" reaches the whole project and
// says so, while full_access gives OpenCode an allow-all rule so nothing is
// asked (and a host auto-reply would pick "once"); `opencode.permissionRules`
// is a listed extension. Plus subagents, questions, todo lists and steering.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { PERMISSION_RULES_EXTENSION, sanitizeMcpName } from "../../../src/drivers/opencode/index.ts";
import { fullAccessAutoReply } from "../../../src/host/approval-reviewer.ts";
import { isAriError, toCallError } from "../../../src/index.ts";
import type { AriEvent, Request, Session, Subagent } from "../../../src/index.ts";
import { evaluate } from "./fake-opencode.ts";
import type { Generation } from "./fake-opencode.ts";
import { openOpencodeTestRig, policy } from "./rig.ts";
import type { OpencodeTestRig } from "./rig.ts";

const rigs: OpencodeTestRig[] = [];
after(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});

async function rigFor(generation: Generation, external = false): Promise<OpencodeTestRig> {
  const rig = await openOpencodeTestRig({ generation, external });
  rigs.push(rig);
  return rig;
}

function pendingRequest(events: readonly AriEvent[]): Request | undefined {
  for (const event of events) if (event.body.type === "request.upsert" && event.body.request.status === "pending" && event.body.request.kind !== undefined) return event.body.request as Request;
  return undefined;
}

async function runTurn(rig: OpencodeTestRig, opened: { session: Session; events: AriEvent[] }, threadId: string, text: string): Promise<string> {
  const started = await opened.session.startTurn({ threadId, clientTurnKey: text, intent: "start", content: [{ type: "text", text }] });
  assert.equal(started.status, "accepted");
  if (started.status !== "accepted") throw new Error("not accepted");
  const native = await rig.nextTurn();
  await native.say("Done.");
  await native.complete();
  assert.equal((await rig.terminal(opened.events, started.turnId)).status, "completed");
  return started.turnId;
}

describe("the runtime follows the server's version", () => {
  test("OpenCode 1.19.6: the 1.x API, one server per thread, process_per_thread", async () => {
    const rig = await rigFor(1);
    const opened = await rig.open();
    assert.equal(opened.session.capabilities().sessionModel, "process_per_thread");
    assert.equal(opened.session.capabilities().externallyOwned, false);
    const first = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const second = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    await runTurn(rig, opened, first.id, "First thread.");
    await runTurn(rig, opened, second.id, "Second thread.");
    const serves = rig.world.spawns.filter((spawn) => spawn.args[0] === "serve");
    assert.equal(serves.length, 3, "one server for the catalog, then one per thread");
    assert.ok(rig.world.spawns.some((spawn) => spawn.args[0] === "--version"));
    assert.ok(serves.every((spawn) => spawn.env["OPENCODE_SERVER_PASSWORD"] !== undefined && spawn.env["OPENCODE_PASSWORD"] === undefined), "1.x servers get OPENCODE_SERVER_PASSWORD");
    const operations = new Set(rig.world.frames.map((frame) => frame.operation));
    for (const operation of ["session.create", "session.prompt_async", "event.subscribe"]) assert.ok(operations.has(operation), operation);
    assert.ok(![...operations].some((operation) => operation.startsWith("v2.")), "no 2.x-only operation reached a 1.x server");
    const servers = [...rig.world.servers].filter((server) => server.known.has(first.native.id!) || server.known.has(second.native.id!));
    assert.ok(servers.every((server) => !(server.known.has(first.native.id!) && server.known.has(second.native.id!))), "the two threads never share a server");
  });

  test("OpenCode 2.1.2: the 2.x API, one server per instance shared by every session, process_per_instance", async () => {
    const rig = await rigFor(2);
    const one = await rig.open();
    const two = await rig.open();
    assert.equal(one.session.capabilities().sessionModel, "process_per_instance");
    const a = await one.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const b = await two.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    await runTurn(rig, one, a.id, "First session.");
    await runTurn(rig, two, b.id, "Second session.");
    const serves = rig.world.spawns.filter((spawn) => spawn.args[0] === "serve");
    assert.equal(serves.length, 1, "one 2.x server serves the instance");
    assert.ok(serves[0]!.env["OPENCODE_PASSWORD"] !== undefined, "2.x servers get OPENCODE_PASSWORD");
    const operations = new Set(rig.world.frames.map((frame) => frame.operation));
    for (const operation of ["session.create", "session.prompt", "event.subscribe", "session.execution.succeeded"]) assert.ok(operations.has(operation), operation);
    // Closing a session leaves the instance's server running for the other.
    await one.session.close();
    assert.equal([...rig.world.servers].filter((server) => server.alive).length, 1);
    await runTurn(rig, two, b.id, "Still served.");
  });

  for (const generation of [1, 2] as const) {
    test(`an external ${generation}.x server: detected by its info route, externally owned, never started and never stopped`, async () => {
      const rig = await rigFor(generation, true);
      const external = [...rig.world.servers][0]!;
      const opened = await rig.open();
      const capabilities = opened.session.capabilities();
      assert.equal(capabilities.sessionModel, "external");
      assert.equal(capabilities.externallyOwned, true);
      assert.equal(capabilities.sessions.release, false);
      assert.equal(capabilities.threads.unload, false);
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      await runTurn(rig, opened, thread.id, "On someone else's server.");
      assert.equal(rig.world.spawns.length, 0, "the driver spawned nothing");
      assert.equal(rig.host.calls.filter((call) => call.operation === "process.spawn").length, 0);
      await opened.session.close();
      await rig.instance.dispose();
      assert.equal(external.alive, true, "closing the session and disposing the instance left the external server running");
      const answer = await fetch(`${external.url}/${generation === 1 ? "global/health" : "api/info"}`, { headers: { authorization: `Basic ${Buffer.from("opencode:external-password").toString("base64")}` } });
      assert.equal(answer.status, 200);
      await answer.body?.cancel();
      // A probe of the other generation's info route got OpenCode's web app (HTML), which detection skips.
      if (generation === 1) assert.ok(rig.world.frames.some((frame) => frame.operation === "web app /api/info"));
    });
  }
});

describe("MCP isolation on a shared server", () => {
  for (const [generation, external] of [
    [2, false],
    [2, true],
    [1, true],
  ] as const) {
    test(`${generation}.x${external ? " external" : ""}: each thread gets its own host-named entry and denies every other thread's`, async () => {
      const rig = await rigFor(generation, external);
      const one = await rig.open();
      const two = await rig.open();
      const a = await one.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const b = await one.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const c = await two.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      // The fake host names each thread's tool server host-tools-<thread id>; the driver must use exactly that name.
      const named = rig.host.calls.filter((call) => call.operation === "hostTools.mcpServerFor").map((call) => (call.args as [string])[0]);
      assert.deepEqual(new Set(named), new Set([a.id, b.id, c.id]));
      const server = [...rig.world.servers].find((candidate) => candidate.alive)!;
      const entries = server.mcp.get(rig.cwd)!;
      const nameOf = (threadId: string) => `host-tools-${threadId}`;
      assert.deepEqual(new Set(entries.keys()), new Set([a, b, c].map((thread) => nameOf(thread.id))), "the server holds one entry per thread, under the host's names");
      for (const thread of [a, b, c]) {
        const session = rig.world.sessions.get(thread.native.id!)!;
        for (const other of [a, b, c]) {
          const tool = `${sanitizeMcpName(nameOf(other.id))}_echo`;
          const effect = evaluate(tool, "*", session.rules);
          if (other.id === thread.id) assert.notEqual(effect, "deny", `thread ${thread.id} is denied its own tools`);
          else assert.equal(effect, "deny", `thread ${thread.id} can reach thread ${other.id}'s entry`);
        }
        // The deny rules come last, so neither the mode nor the host's rules can open another thread's entry.
        const denies = session.rules.filter((rule) => rule.effect === "deny" && rule.action.startsWith("host-tools-"));
        assert.deepEqual(session.rules.slice(-denies.length), denies);
      }
      // The first thread was told about the later ones: its rules were rewritten when they arrived.
      const updates = rig.world.frames.filter((frame) => frame.direction === "request" && frame.operation === "session.update");
      assert.ok(updates.length >= 2);
      // A saved "always" grant for another thread's tool does not reopen it (2.x checks the session's denies first).
      if (generation === 2) {
        rig.world.saved.set(rig.cwd, [{ action: `${sanitizeMcpName(nameOf(c.id))}_*`, resource: "*", effect: "allow" }]);
        const session = rig.world.sessions.get(a.native.id!)!;
        assert.equal(evaluate(`${sanitizeMcpName(nameOf(c.id))}_echo`, "*", session.rules), "deny");
      }
      // A closed session takes its entries off the shared server, and the others stop denying them.
      await two.session.close();
      assert.equal(entries.has(nameOf(c.id)), false);
      const left = rig.world.sessions.get(a.native.id!)!;
      assert.notEqual(evaluate(`${sanitizeMcpName(nameOf(c.id))}_echo`, "*", left.rules), "deny");
    });
  }

  test("host names that OpenCode's tool names cannot keep apart are refused", async () => {
    const rig = await openOpencodeTestRig({ generation: 2, host: { mcpServerName: (threadId) => (threadId.endsWith("0") || threadId.endsWith("2") || threadId.endsWith("4") || threadId.endsWith("6") || threadId.endsWith("8") || threadId.endsWith("a") || threadId.endsWith("c") || threadId.endsWith("e") ? "tools" : "tools_more") } });
    rigs.push(rig);
    const opened = await rig.open();
    const created: string[] = [];
    let refused: unknown;
    for (let index = 0; index < 6 && refused === undefined; index += 1) {
      try {
        created.push((await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) })).id);
      } catch (error) {
        refused = error;
      }
    }
    assert.ok(refused !== undefined, "a thread whose host name is another's prefix was refused");
    assert.match(String((refused as Error).message), /cannot be kept apart/);
  });
});

describe("approvals never widen", () => {
  for (const generation of [1, 2] as const) {
    test(`${generation}.x: "always" says it reaches the project, a full_access auto-reply would pick "once", and full_access asks nothing`, async () => {
      const rig = await rigFor(generation);
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Run git status." }] });
      assert.equal(started.status, "accepted");
      const native = await rig.nextTurn();
      const handle = await native.requestApproval({
        kind: "command",
        command: ["git", "status"],
        options: [
          { optionId: "allow-once", label: "Allow once", decision: "accept" },
          { optionId: "allow-always", label: "Always allow", decision: "accept_always" },
          { optionId: "deny", label: "Reject", decision: "decline" },
        ],
      });
      const request = await rig.until(opened.events, () => pendingRequest(opened.events), "a pending request");
      assert.equal(request.kind, "command");
      assert.deepEqual(request.subject?.command, ["git status"]);
      assert.deepEqual(
        request.options?.map((option) => [option.optionId, option.decision, option.scope ?? null]),
        [
          ["once", "accept", "once"],
          ["always", "accept_always", "project"],
          ["reject", "decline", null],
        ],
      );
      assert.equal(fullAccessAutoReply(request, "auto")?.optionId, "once", "the narrowest accepting option is once");
      await opened.session.respond({ requestId: request.id, responseKey: "r1", optionId: "always" });
      assert.equal(await handle.nextReply(), "allow-always", "the agent got the always reply the host chose");
      await native.complete();

      // Under full_access the session's rules allow everything, so OpenCode asks nothing.
      const full = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd, "full_access") });
      const rules = rig.world.sessions.get(full.native.id!)!.rules;
      for (const action of [generation === 1 ? "bash" : "shell", "edit", "read", "webfetch"]) assert.equal(evaluate(action, "anything", rules), "allow", action);
      // A host rule that still asks makes OpenCode ask under full access; the driver marks that request so no auto-reply answers it.
      await opened.session.ext!(PERMISSION_RULES_EXTENSION, "set", { threadId: full.id, rules: [{ action: generation === 1 ? "bash" : "shell", resource: "*", effect: "ask" }] });
      const fullStarted = await opened.session.startTurn({ threadId: full.id, clientTurnKey: "k2", intent: "start", content: [{ type: "text", text: "Deploy." }] });
      assert.equal(fullStarted.status, "accepted");
      const fullNative = await rig.nextTurn();
      await fullNative.requestApproval({ kind: "command", command: ["deploy"], options: [{ optionId: "allow", label: "Allow", decision: "accept" }] });
      const asked = await rig.until(opened.events, () => {
        for (const event of opened.events) if (event.threadId === full.id && event.body.type === "request.upsert" && event.body.request.status === "pending") return event.body.request as Request;
        return undefined;
      }, "the full_access request");
      assert.equal(asked.fullAccessOverride, "ask_rule");
      assert.equal(fullAccessAutoReply(asked, "auto"), undefined);
      await fullNative.finishCancelled();
    });
  }
});

describe("the opencode.permissionRules extension", () => {
  for (const generation of [1, 2] as const) {
    test(`${generation}.x: listed, get reads the server's rules, set keeps the host's rules between the mode's and the isolation denies`, async () => {
      const rig = await rigFor(generation);
      const opened = await rig.open();
      assert.deepEqual(opened.session.capabilities().extensions, [{ ns: PERMISSION_RULES_EXTENSION, version: "1" }]);
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const read = (await opened.session.ext!(PERMISSION_RULES_EXTENSION, "get", { threadId: thread.id })) as { rules: Array<{ action: string; effect: string }> };
      assert.deepEqual(read.rules, rig.world.sessions.get(thread.native.id!)!.rules);
      const set = (await opened.session.ext!(PERMISSION_RULES_EXTENSION, "set", { threadId: thread.id, rules: [{ action: "webfetch", resource: "*", effect: "deny" }] })) as { rules: Array<{ action: string; effect: string }> };
      const index = set.rules.findIndex((rule) => rule.action === "webfetch");
      assert.ok(index > 0, "the host's rule follows the mode's rules");
      assert.equal(evaluate("webfetch", "https://example.com", rig.world.sessions.get(thread.native.id!)!.rules), "deny");
      await assert.rejects(opened.session.ext!(PERMISSION_RULES_EXTENSION, "set", { threadId: thread.id, rules: [{ action: "x" }] }), (error: unknown) => isAriError(error, "validation"));
      await assert.rejects(opened.session.ext!("opencode.other", "get", {}), (error: unknown) => isAriError(error, "unsupported") && (toCallError(error) as { capability?: string }).capability === "extensions.opencode.other");
    });
  }
});

describe("subagents, questions, todo lists and steering", () => {
  for (const generation of [1, 2] as const) {
    test(`${generation}.x: a child session is a subagent with its own thread, and its approvals name it`, async () => {
      const rig = await rigFor(generation);
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "s1", intent: "start", content: [{ type: "text", text: "Delegate." }] });
      assert.equal(started.status, "accepted");
      if (started.status !== "accepted") return;
      const native = await rig.nextTurn();
      const child = await native.runSubagent("explore the repository");
      const subagent = await rig.until(opened.events, (event) => (event.body.type === "subagent.upsert" && event.body.subagent.status === "running" ? (event.body.subagent as Subagent) : undefined), "a running subagent");
      assert.equal(subagent.parentThreadId, thread.id);
      assert.equal(subagent.parentTurnId, started.turnId);
      assert.equal(subagent.native.id, child.childId);
      assert.ok(subagent.threadId !== undefined && subagent.threadId !== thread.id);
      const handle = await native.requestApprovalFrom(child.childId, { kind: "command", command: ["ls"], options: [{ optionId: "ok", label: "OK", decision: "accept" }] });
      const request = await rig.until(opened.events, () => pendingRequest(opened.events), "the subagent's request");
      assert.equal(request.origin.subagentId, subagent.id);
      assert.equal(request.origin.threadId, thread.id);
      await opened.session.respond({ requestId: request.id, responseKey: "sub", optionId: "once" });
      assert.equal(await handle.nextReply(), "ok");
      await child.finish();
      await rig.until(opened.events, (event) => (event.body.type === "subagent.upsert" && event.body.subagent.id === subagent.id && event.body.subagent.status === "completed" ? true : undefined), "the subagent to complete");
      await native.complete();
      assert.equal((await rig.terminal(opened.events, started.turnId)).status, "completed");
    });

    test(`${generation}.x: OpenCode's questions are user_input requests answered in OpenCode's shape`, async () => {
      const rig = await rigFor(generation);
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "q1", intent: "start", content: [{ type: "text", text: "Ask me." }] });
      assert.equal(started.status, "accepted");
      const native = await rig.nextTurn();
      const asked = await native.askQuestion({ text: "Which colour?", options: ["red", "blue"] });
      const request = await rig.until(opened.events, () => pendingRequest(opened.events), "the question");
      assert.equal(request.kind, "user_input");
      const question = request.questions![0]!;
      assert.deepEqual(
        question.options?.map((option) => option.label),
        ["red", "blue"],
      );
      await opened.session.respond({ requestId: request.id, responseKey: "q", answers: { [question.id]: { optionIds: [question.options![1]!.id] } } });
      assert.deepEqual(await asked.answers(), generation === 1 ? [["blue"]] : { choice: "blue" });
      await native.complete();
    });
  }

  for (const generation of [1, 2] as const) {
    test(`${generation}.x: a shell command is a command_execution item${generation === 1 ? " whose output streams while it runs" : ""}`, async () => {
      const rig = await rigFor(generation);
      const opened = await rig.open();
      assert.equal(opened.session.capabilities().streaming.toolOutput, generation === 1);
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "c1", intent: "start", content: [{ type: "text", text: "Test it." }] });
      assert.equal(started.status, "accepted");
      if (started.status !== "accepted") return;
      const native = await rig.nextTurn();
      await native.runCommand("npm test", "12 passing\n0 failing");
      await native.complete();
      await rig.terminal(opened.events, started.turnId);
      const upserts = opened.events.flatMap((event) => (event.body.type === "item.upsert" ? [event.body.item] : []));
      // The tool opens pending, before OpenCode has its input; the command arrives with the call.
      const opening = upserts.find((item) => item.kind === "command_execution")!;
      assert.deepEqual(upserts.filter((item) => item.id === opening.id && item.command !== undefined).at(-1)?.command, ["npm test"]);
      const outputs = upserts.filter((item) => item.id === opening.id && item.output !== undefined).map((item) => item.output);
      if (generation === 1) assert.deepEqual(outputs, ["12 passing", "12 passing\n0 failing"], "the running output arrived before the result");
      else assert.deepEqual(outputs, ["12 passing\n0 failing"]);
      assert.equal(upserts.filter((item) => item.id === opening.id).at(-1)?.status, "completed");
    });
  }

  test("1.x: a subagent's thread can be forked", async () => {
    const rig = await rigFor(1);
    const opened = await rig.open();
    assert.equal(opened.session.capabilities().threads.fork.fromSubagent, true);
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "f1", intent: "start", content: [{ type: "text", text: "Delegate." }] });
    assert.equal(started.status, "accepted");
    if (started.status !== "accepted") return;
    const native = await rig.nextTurn();
    const child = await native.runSubagent("helper");
    const subagent = await rig.until(opened.events, (event) => (event.body.type === "subagent.upsert" && event.body.subagent.threadId !== undefined ? (event.body.subagent as Subagent) : undefined), "the subagent");
    await child.finish();
    await native.complete();
    await rig.terminal(opened.events, started.turnId);
    const fork = await opened.session.forkThread!({ threadId: subagent.threadId!, at: { type: "latest" } });
    assert.notEqual(fork.id, subagent.threadId);
    assert.equal(fork.forkedFrom?.threadId, subagent.threadId);
    assert.equal(rig.world.sessions.get(fork.native.id!)?.forkedFrom, child.childId, "OpenCode forked the subagent's own session");
  });

  test("1.x: the todo list is a todo_list item of the turn", async () => {
    const rig = await rigFor(1);
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "t1", intent: "start", content: [{ type: "text", text: "Plan it." }] });
    assert.equal(started.status, "accepted");
    const native = await rig.nextTurn();
    await native.todos([
      { content: "Write the parser", status: "in_progress" },
      { content: "Test it", status: "pending" },
    ]);
    const todos = await rig.until(opened.events, (event) => (event.body.type === "item.upsert" && event.body.item.kind === "todo_list" ? event.body.item.todos : undefined), "the todo list");
    assert.deepEqual(
      todos?.map((todo) => [todo.text, todo.status]),
      [
        ["Write the parser", "in_progress"],
        ["Test it", "pending"],
      ],
    );
    await native.complete();
  });

  test("2.x: a steer joins the running execution; one that misses it is taken back and answers prompt_required", async () => {
    const rig = await rigFor(2);
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "st1", intent: "start", content: [{ type: "text", text: "Build it." }] });
    assert.equal(started.status, "accepted");
    if (started.status !== "accepted") return;
    const native = await rig.nextTurn();
    const steered = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "st2", intent: "steer", expectedTurnId: started.turnId, content: [{ type: "text", text: "Use TypeScript." }] });
    assert.deepEqual(steered, { status: "accepted", turnId: started.turnId, accepted: "steered" });
    assert.equal(await native.nextSteer(), "Use TypeScript.");
    const held = await native.completeHeld();
    const late = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "st3", intent: "steer", expectedTurnId: started.turnId, content: [{ type: "text", text: "Too late." }] });
    assert.deepEqual(late, { status: "prompt_required" });
    assert.ok(rig.world.frames.some((frame) => frame.operation === "session.inbox.cancel" && frame.direction === "request"), "the missed steer was cancelled in OpenCode's inbox");
    await held.release();
    assert.equal((await rig.terminal(opened.events, started.turnId)).status, "completed");
    const session = rig.world.sessions.get(thread.native.id!)!;
    assert.deepEqual(
      session.messages.filter((message) => message.role === "user").map((message) => [message.text, message.steer]),
      [
        ["Build it.", false],
        ["Use TypeScript.", true],
      ],
    );
    // The snapshot keeps the steer in the turn it joined.
    const snapshot = await opened.session.readSnapshot!(thread.id);
    assert.equal(snapshot.turns.length, 1);
    assert.deepEqual(
      snapshot.items.filter((item) => item.kind === "user_message").map((item) => item.text),
      ["Build it.", "Use TypeScript."],
    );
  });
});
