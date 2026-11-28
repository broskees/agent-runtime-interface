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
import { PERMISSION_RULES_EXTENSION, grantCouldReachMcpResources, sanitizeMcpName } from "../../../src/drivers/opencode/index.ts";
import { fullAccessAutoReply } from "../../../src/host/approval-reviewer.ts";
import { isAriError, toCallError } from "../../../src/index.ts";
import type { AriEvent, Request, Session, Subagent } from "../../../src/index.ts";
import { evaluate, wildcard } from "./fake-opencode.ts";
import type { FakeServer, FakeSession, Generation } from "./fake-opencode.ts";
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

const nameOf = (threadId: string): string => `host-tools-${threadId}`;

/** The live server that holds the rig's directory's MCP entries. */
function liveServer(rig: OpencodeTestRig): FakeServer {
  const alive = [...rig.world.servers].filter((server) => server.alive);
  return alive.find((server) => server.mcp.has(rig.cwd)) ?? alive[0]!;
}

/**
 * Whether OpenCode lets `session` reach the MCP entry `name`, by OpenCode's
 * own rule order (`FakeServer.decide`): call one of its tools, list its
 * resources, read one. 1.x asks `read` for `mcp:<server>:*` to list and
 * `mcp:<server>:<uri>` to read (1.19.6 `session/tools.ts`) and hides a tool
 * that a rule for every resource denies; 2.x asks
 * `opencode_list_mcp_resources` for the server and `opencode_read_mcp_resource`
 * for `<server>:<uri>` (2.1.2 `core/src/tool/plugin/mcp-resource.ts`).
 */
function reaches(rig: OpencodeTestRig, server: FakeServer, session: FakeSession, name: string): { tool: boolean; list: boolean; read: boolean } {
  const tool = `${sanitizeMcpName(name)}_echo`;
  if (rig.world.generation === 1) {
    return {
      tool: !server.v1Hidden(session, tool) && server.decide(session, tool, ["*"]) !== "deny",
      list: server.decide(session, "read", [`mcp:${name}:*`]) !== "deny",
      read: server.decide(session, "read", [`mcp:${name}:file:///notes.md`]) !== "deny",
    };
  }
  return {
    tool: server.decide(session, tool, ["*"]) !== "deny",
    list: server.decide(session, "opencode_list_mcp_resources", [name]) !== "deny",
    read: server.decide(session, "opencode_read_mcp_resource", [`${name}:file:///notes.md`]) !== "deny",
  };
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
  test("closing a 1.x session cancels its live event subscription without abort errors or stopping the external server", async () => {
    const rig = await rigFor(1, true);
    const opened = await rig.open();
    await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const server = liveServer(rig);
    assert.equal(server.subscriberCount, 1);
    await opened.session.close();
    const deadline = Date.now() + 5_000;
    while (server.subscriberCount > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(server.subscriberCount, 0, "closing the session closes the HTTP event stream");
    assert.equal(server.alive, true);
  });

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
    test(`${generation}.x${external ? " external" : ""}: each thread gets its own host-named entry and is denied every action that reaches another thread's, in OpenCode's own rule order`, async () => {
      const rig = await rigFor(generation, external);
      const one = await rig.open();
      const two = await rig.open();
      const a = await one.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const b = await one.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const c = await two.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      // The fake host names each thread's tool server host-tools-<thread id>; the driver must use exactly that name.
      const named = rig.host.calls.filter((call) => call.operation === "hostTools.mcpServerFor").map((call) => (call.args as [string])[0]);
      assert.deepEqual(new Set(named), new Set([a.id, b.id, c.id]));
      const server = liveServer(rig);
      const entries = server.mcp.get(rig.cwd)!;
      assert.deepEqual(new Set(entries.keys()), new Set([a, b, c].map((thread) => nameOf(thread.id))), "the server holds one entry per thread, under the host's names");
      for (const thread of [a, b, c]) {
        const session = rig.world.sessions.get(thread.native.id!)!;
        for (const other of [a, b, c]) {
          const reach = reaches(rig, server, session, nameOf(other.id));
          if (other.id === thread.id) assert.deepEqual(reach, { tool: true, list: true, read: true }, `thread ${thread.id} is denied its own entry`);
          else assert.deepEqual(reach, { tool: false, list: false, read: false }, `thread ${thread.id} can reach thread ${other.id}'s entry`);
        }
        // The deny rules come last, so neither the mode nor the host's rules can open another thread's entry.
        const denies = session.rules.filter((rule) => rule.effect === "deny" && (rule.action.startsWith("host-tools-") || rule.resource.includes("host-tools-")));
        assert.ok(denies.length >= 2 * (generation === 2 ? 3 : 2));
        assert.deepEqual(session.rules.slice(-denies.length), denies);
      }
      // The first thread was told about the later ones: its rules were rewritten when they arrived.
      const updates = rig.world.frames.filter((frame) => frame.direction === "request" && frame.operation === "session.update");
      assert.ok(updates.length >= 2);
      if (generation === 2) {
        // A saved "always" grant for another thread's entry does not reopen it: 2.x checks the session's denies before saved grants.
        const sessionA = rig.world.sessions.get(a.native.id!)!;
        assert.equal(server.decide(sessionA, "webfetch", ["https://example.com"]), "ask", "before the grant, an ordinary request asks");
        rig.world.saved.set(rig.cwd, [
          { action: `${sanitizeMcpName(nameOf(c.id))}_*`, resource: "*", effect: "allow" },
          { action: "opencode_list_mcp_resources", resource: nameOf(c.id), effect: "allow" },
          { action: "opencode_read_mcp_resource", resource: `${nameOf(c.id)}:*`, effect: "allow" },
          { action: "webfetch", resource: "*", effect: "allow" },
        ]);
        assert.equal(server.decide(sessionA, "webfetch", ["https://example.com"]), "allow", "the saved grants are in effect");
        assert.deepEqual(reaches(rig, server, sessionA, nameOf(c.id)), { tool: false, list: false, read: false }, "the saved grants do not reopen another thread's entry");
        rig.world.saved.delete(rig.cwd);
      }
      // A closed session takes its entries off the shared server before the others stop denying them.
      const before = rig.world.frames.length;
      await two.session.close();
      assert.equal(entries.has(nameOf(c.id)), false);
      const after = rig.world.frames.slice(before).filter((frame) => frame.direction === "request");
      const removal = after.findIndex((frame) => frame.operation === (generation === 1 ? "mcp.disconnect" : "experimental.mcp.remove"));
      const relaxed = after.findIndex((frame) => frame.operation === "session.update");
      assert.ok(removal !== -1 && relaxed !== -1 && removal < relaxed, "the entry was removed before any other thread's deny was dropped");
      assert.deepEqual(reaches(rig, server, rig.world.sessions.get(a.native.id!)!, nameOf(c.id)), { tool: true, list: true, read: true }, "the remaining threads no longer deny the removed entry");
    });
  }

  test("2.x: a removal OpenCode does not confirm keeps the other threads' denies, and close() reports it", async () => {
    const rig = await rigFor(2);
    const one = await rig.open();
    const two = await rig.open();
    const a = await one.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const c = await two.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const server = liveServer(rig);
    server.dropRequests.add("experimental.mcp.remove");
    await assert.rejects(two.session.close(), "close() reports the removal that failed");
    server.dropRequests.delete("experimental.mcp.remove");
    assert.ok(server.mcp.get(rig.cwd)!.has(nameOf(c.id)), "the entry is still on the server");
    assert.deepEqual(reaches(rig, server, rig.world.sessions.get(a.native.id!)!, nameOf(c.id)), { tool: false, list: false, read: false }, "so the other thread still denies it");
  });

  test("2.x: two threads that ask for different MCP servers under one name are refused; the first keeps its entry", async () => {
    const rig = await openOpencodeTestRig({ generation: 2, host: { mcpServerName: () => "workspace-tools" } });
    rigs.push(rig);
    const one = await rig.open();
    const two = await rig.open();
    const a = await one.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const server = liveServer(rig);
    const first = JSON.stringify(server.mcp.get(rig.cwd)!.get("workspace-tools"));
    const sessions = rig.world.sessions.size;
    await assert.rejects(two.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) }), (error: unknown) => {
      assert.ok(isAriError(error, "invalid_state"), String(error));
      assert.equal((toCallError(error) as { reason?: string }).reason, "mcp_name_conflict");
      return true;
    });
    assert.equal(JSON.stringify(server.mcp.get(rig.cwd)!.get("workspace-tools")), first, "the first thread's entry was not replaced");
    assert.ok(first.includes(encodeURIComponent(a.id)), "and it is still the first thread's server");
    // OpenCode made the second thread's session before the driver learnt its host name; nothing else of it remains.
    assert.ok(rig.world.sessions.size <= sessions + 1);
    const adds = rig.world.frames.filter((frame) => frame.direction === "request" && frame.operation === "experimental.mcp.add" && (frame.body as { path: string }).path.endsWith("/workspace-tools"));
    assert.equal(adds.length, 1, "no second entry was added under the name");
  });

  test("2.x: threads that ask for the same MCP server under one name share its entry until the last one leaves", async () => {
    const launch = { mcpServers: [{ name: "shared-tools", transport: "http" as const, url: "http://127.0.0.1:1/shared" }] };
    const rig = await rigFor(2);
    const one = await rig.open({ launch });
    const two = await rig.open({ launch });
    const three = await rig.open();
    const a = await one.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const b = await two.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const c = await three.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const server = liveServer(rig);
    const entries = server.mcp.get(rig.cwd)!;
    assert.ok(entries.has("shared-tools"));
    for (const holder of [a, b]) assert.equal(reaches(rig, server, rig.world.sessions.get(holder.native.id!)!, "shared-tools").tool, true);
    assert.equal(reaches(rig, server, rig.world.sessions.get(c.native.id!)!, "shared-tools").tool, false, "a thread that did not ask for it is denied it");
    await one.session.close();
    assert.ok(entries.has("shared-tools"), "the entry stays while another thread holds it");
    assert.equal(reaches(rig, server, rig.world.sessions.get(c.native.id!)!, "shared-tools").tool, false);
    await two.session.close();
    assert.equal(entries.has("shared-tools"), false, "the last holder took it off");
  });

  for (const [generation, external] of [
    [2, false],
    [2, true],
    [1, true],
  ] as const) {
    test(`${generation}.x${external ? " external" : ""}: a thread that drops a shared entry on resume is denied it from then on, and so are its subagents, while the other holder keeps it`, async () => {
      const shared = { name: "shared-tools", transport: "http" as const, url: "http://127.0.0.1:1/shared" };
      const rig = await rigFor(generation, external);
      const one = await rig.open();
      const two = await rig.open();
      const a = await one.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), launch: { mcpServers: [shared] } });
      const d = await two.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), launch: { mcpServers: [shared] } });
      const server = liveServer(rig);
      // A subagent of a's that OpenCode created while a still held the entry.
      const started = await one.session.startTurn({ threadId: a.id, clientTurnKey: "delegate", intent: "start", content: [{ type: "text", text: "Delegate." }] });
      assert.equal(started.status, "accepted");
      if (started.status !== "accepted") return;
      const native = await rig.nextTurn();
      const child = await native.runSubagent("helper");
      const childSession = rig.world.sessions.get(child.childId)!;
      await rig.until(one.events, () => (rig.world.frames.some((frame) => frame.direction === "request" && frame.operation === "session.update" && JSON.stringify(frame.body).includes(child.childId)) ? true : undefined), "the driver to write the subagent's rules");
      await child.finish();
      await native.complete();
      await rig.terminal(one.events, started.turnId);
      const sessionA = () => rig.world.sessions.get(a.native.id!)!;
      assert.deepEqual(reaches(rig, server, sessionA(), shared.name), { tool: true, list: true, read: true }, "while a holds the entry it reaches it");
      assert.deepEqual(reaches(rig, server, childSession, shared.name), { tool: true, list: true, read: true });

      // a resumes with a LaunchContext that no longer lists the entry; d still holds it.
      await one.session.resumeThread({ native: { handle: a.handle! }, policy: policy(rig.cwd), launch: { appendSystemPrompt: ["No shared tools now."] } });
      assert.ok(server.mcp.get(rig.cwd)!.has(shared.name), "the entry stays for d");
      assert.deepEqual(reaches(rig, server, sessionA(), shared.name), { tool: false, list: false, read: false }, "a is denied what is now only d's entry");
      assert.deepEqual(reaches(rig, server, childSession, shared.name), { tool: false, list: false, read: false }, "and so is a's subagent");
      assert.deepEqual(reaches(rig, server, rig.world.sessions.get(d.native.id!)!, shared.name), { tool: true, list: true, read: true }, "d keeps it");
      assert.deepEqual(reaches(rig, server, sessionA(), nameOf(a.id)), { tool: true, list: true, read: true }, "a keeps its own host entry");

      // Asking for a different server under the name d holds is refused, and d's entry is unchanged.
      const before = JSON.stringify(server.mcp.get(rig.cwd)!.get(shared.name));
      await assert.rejects(one.session.resumeThread({ native: { handle: a.handle! }, policy: policy(rig.cwd), launch: { mcpServers: [{ ...shared, url: "http://127.0.0.1:1/other" }] } }), (error: unknown) => isAriError(error, "invalid_state") && (toCallError(error) as { reason?: string }).reason === "mcp_name_conflict");
      assert.equal(JSON.stringify(server.mcp.get(rig.cwd)!.get(shared.name)), before);
      assert.deepEqual(reaches(rig, server, sessionA(), shared.name), { tool: false, list: false, read: false }, "the refused resume opened nothing");
    });
  }

  test("1.x external: a shared 1.x server keeps an always grant for every session of the directory, checked after their own rules, so a file read (always *) offers no always, and once or reject widens nothing", async () => {
    const rig = await rigFor(1, true);
    const one = await rig.open();
    const two = await rig.open();
    const a = await one.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const c = await two.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const server = liveServer(rig);
    const both = () => [reaches(rig, server, rig.world.sessions.get(c.native.id!)!, nameOf(a.id)), reaches(rig, server, rig.world.sessions.get(a.native.id!)!, nameOf(c.id))];
    assert.deepEqual(both(), [
      { tool: false, list: false, read: false },
      { tool: false, list: false, read: false },
    ]);
    const started = await one.session.startTurn({ threadId: a.id, clientTurnKey: "read", intent: "start", content: [{ type: "text", text: "Read the env file." }] });
    assert.equal(started.status, "accepted");
    if (started.status !== "accepted") return;
    const native = await rig.nextTurn();
    // 1.19.6 `tool/read.ts` asks `read` for the file with always ["*"]: a grant that would match mcp:<any server>:*.
    const first = await native.requestPermission("read", ".env", {});
    const read = await rig.until(one.events, () => pendingRequest(one.events), "the file read request");
    assert.deepEqual(read.subject?.tool?.input, { resources: [".env"] });
    assert.deepEqual(
      read.options?.map((option) => option.optionId),
      ["once", "reject"],
      "no always that would reach another thread's entry",
    );
    await one.session.respond({ requestId: read.id, responseKey: "once", optionId: "once" });
    assert.equal(await first.nextReply(), "once");
    const second = await native.requestPermission("read", "secrets.env", {});
    const again = await rig.until(one.events, () => {
      for (const event of one.events) if (event.body.type === "request.upsert" && event.body.request.status === "pending" && event.body.request.id !== read.id) return event.body.request as Request;
      return undefined;
    }, "the second read request");
    await one.session.respond({ requestId: again.id, responseKey: "reject", optionId: "reject" });
    assert.equal(await second.nextReply(), "reject");
    assert.deepEqual(both(), [
      { tool: false, list: false, read: false },
      { tool: false, list: false, read: false },
    ], "after once and reject no thread reaches another's entry");
    // An always whose patterns cannot match mcp:<server>:* is still offered: an external directory's glob.
    const outside = await native.requestPermission("external_directory", "/elsewhere/*", { filepath: "/elsewhere/notes.md" });
    const directory = await rig.until(one.events, () => {
      for (const event of one.events) if (event.body.type === "request.upsert" && event.body.request.status === "pending" && event.body.request.id !== read.id && event.body.request.id !== again.id) return event.body.request as Request;
      return undefined;
    }, "the external directory request");
    assert.deepEqual(
      directory.options?.map((option) => option.optionId),
      ["once", "always", "reject"],
    );
    await one.session.respond({ requestId: directory.id, responseKey: "always", optionId: "always" });
    assert.equal(await outside.nextReply(), "always");
    assert.deepEqual(both(), [
      { tool: false, list: false, read: false },
      { tool: false, list: false, read: false },
    ], "that grant reaches no MCP entry");
    await native.complete();
    await rig.terminal(one.events, started.turnId);
  });

  test("1.x: which always grants could override another thread's MCP resource deny (read of mcp:<server>:*)", () => {
    for (const [permission, patterns, could] of [
      ["read", ["*"], true],
      ["read", ["*.env"], true],
      ["read", ["?"], true],
      ["read", ["m*"], true],
      ["read", ["mcp:host-tools-a:*"], true],
      ["read", ["src/*"], false],
      ["read", ["notes.md"], false],
      ["read", [], false],
      ["external_directory", ["/elsewhere/*"], false],
      ["webfetch", ["*"], false],
      ["edit", ["*"], false],
    ] as const) {
      assert.equal(grantCouldReachMcpResources(permission, patterns), could, `${permission} ${JSON.stringify(patterns)}`);
      // A grant the driver lets through matches no MCP resource by OpenCode's own wildcard match (the answer may err only the other way: `?` is withheld though it matches no such resource).
      if (!could && permission === "read") for (const pattern of patterns) for (const resource of ["mcp:x:*", "mcp:x:file:///notes.md", "mcp:host-tools-a:src/notes.md"]) assert.equal(wildcard(resource, pattern), false, `${pattern} matches ${resource}`);
    }
  });

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

  for (const [generation, external] of [
    [2, false],
    [1, true],
  ] as const) {
    test(`${generation}.x${external ? " external" : ""}: a running subagent is denied an entry that arrived after OpenCode copied its parent's rules`, async () => {
      const rig = await rigFor(generation, external);
      const one = await rig.open();
      const two = await rig.open();
      const a = await one.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const started = await one.session.startTurn({ threadId: a.id, clientTurnKey: "delegate", intent: "start", content: [{ type: "text", text: "Delegate." }] });
      assert.equal(started.status, "accepted");
      const native = await rig.nextTurn();
      const child = await native.runSubagent("helper");
      await rig.until(one.events, (event) => (event.body.type === "subagent.upsert" && event.body.subagent.native?.id === child.childId ? true : undefined), "the subagent");
      // A thread that arrives now: OpenCode gave the child its rules before this entry existed.
      const c = await two.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const server = liveServer(rig);
      const childSession = rig.world.sessions.get(child.childId)!;
      await rig.until(one.events, () => (reaches(rig, server, childSession, nameOf(c.id)).tool ? undefined : true), "the subagent's rules to deny the new entry");
      assert.deepEqual(reaches(rig, server, childSession, nameOf(c.id)), { tool: false, list: false, read: false });
      assert.equal(reaches(rig, server, childSession, nameOf(a.id)).tool, true, "the subagent keeps its parent's own entry");
      await child.finish();
      await native.complete();
      await rig.terminal(one.events, (started as { turnId: string }).turnId);
    });
  }

  test("1.x external: a shared 1.x server keeps an always grant for every session of the directory, after their own rules, so an MCP resource read offers no always", async () => {
    const rig = await rigFor(1, true);
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "resource", intent: "start", content: [{ type: "text", text: "Read the resource." }] });
    assert.equal(started.status, "accepted");
    const native = await rig.nextTurn();
    const pattern = `mcp:${nameOf(thread.id)}:file:///notes.md`;
    const handle = await native.requestPermission("read", pattern, { server: nameOf(thread.id) });
    const request = await rig.until(opened.events, () => pendingRequest(opened.events), "the resource read request");
    assert.deepEqual(
      request.options?.map((option) => option.optionId),
      ["once", "reject"],
    );
    await opened.session.respond({ requestId: request.id, responseKey: "read", optionId: "once" });
    assert.equal(await handle.nextReply(), "once");
    await native.complete();
  });
});

describe("a resume without a policy keeps the session's saved rules", () => {
  test("2.x: a cold resume without a policy invents no mode: the saved rules stay as they were, and only the denies of other threads' entries are added", async () => {
    const rig = await rigFor(2);
    const first = await rig.open();
    const a = await first.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    await first.session.close();
    // The rules OpenCode saved for the session, which ARI did not write: an allow of one command and a deny.
    const saved = [
      { action: "shell", resource: "git *", effect: "allow" as const },
      { action: "webfetch", resource: "*", effect: "deny" as const },
    ];
    // A deny of the thread's own host entry that an earlier run wrote while another thread held the name.
    const staleOwnDeny = { action: `${sanitizeMcpName(nameOf(a.id))}_*`, resource: "*", effect: "deny" as const };
    rig.world.sessions.get(a.native.id!)!.rules = [...saved, staleOwnDeny].map((rule) => ({ ...rule }));
    // Another thread on the same server holds an entry of its own.
    const other = await rig.open();
    const c = await other.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });

    const resumer = await rig.open();
    const resumed = await resumer.session.resumeThread({ native: { handle: a.handle! } });
    assert.equal(resumed.id, a.id);
    const session = rig.world.sessions.get(a.native.id!)!;
    assert.deepEqual(session.rules.slice(0, saved.length), saved, "the saved rules stay first and unchanged");
    const added = session.rules.slice(saved.length);
    assert.ok(added.length > 0, "the other thread's entry is denied");
    assert.ok(
      added.every((rule) => rule.effect === "deny" && (rule.action.includes(sanitizeMcpName(nameOf(c.id))) || rule.resource.includes(nameOf(c.id)))),
      `only denies of the other thread's entry were added: ${JSON.stringify(added)}`,
    );
    const server = liveServer(rig);
    assert.equal(server.decide(session, "shell", ["git status"]), "allow", "the saved allow still holds; no approval_required rule asks instead");
    assert.equal(server.decide(session, "webfetch", ["https://example.com"]), "deny", "the saved deny still holds");
    assert.deepEqual(reaches(rig, server, session, nameOf(c.id)), { tool: false, list: false, read: false }, "the other thread's entry stays out of reach");
    assert.deepEqual(reaches(rig, server, session, nameOf(a.id)), { tool: true, list: true, read: true }, "the thread reaches its own entry");
    await runTurn(rig, resumer, resumed.id, "After the resume.");
  });
});

describe("a history resume writes nothing", () => {
  for (const generation of [1, 2] as const) {
    test(`${generation}.x: a history resume reads the session without rewriting its rules or adding MCP entries, leaves the thread unloaded, and never creates a session`, async () => {
      const rig = await rigFor(generation);
      const first = await rig.open();
      const a = await first.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), launch: { mcpServers: [{ name: "workspace-tools", transport: "http", url: "http://127.0.0.1:1/workspace" }] } });
      await runTurn(rig, first, a.id, "Remember 7.");
      await first.session.close();
      const saved = rig.world.sessions.get(a.native.id!)!.rules.map((rule) => ({ ...rule }));
      const writes = new Set(["session.update", "experimental.mcp.add", "mcp.add", "session.create"]);
      const before = rig.world.frames.filter((frame) => frame.direction === "request" && writes.has(frame.operation)).length;

      const reader = await rig.open();
      // 1.x finds a session it has not seen only in a directory: the policy names it, and a history read uses nothing else of it.
      const resumed = await reader.session.resumeThread({ native: { handle: a.handle! }, purpose: "history", ...(generation === 1 ? { policy: policy(rig.cwd, "full_access") } : {}) });
      assert.equal(resumed.id, a.id);
      assert.equal(resumed.status, "unloaded");
      const snapshot = await reader.session.readSnapshot!(resumed.id);
      assert.equal(snapshot.turns.length, 1);
      const after = rig.world.frames.filter((frame) => frame.direction === "request" && writes.has(frame.operation));
      assert.equal(after.length, before, `a history read wrote ${after.slice(before).map((frame) => frame.operation).join(", ")}`);
      assert.deepEqual(rig.world.sessions.get(a.native.id!)!.rules, saved, "the session's rules are as OpenCode saved them");
      await assert.rejects(reader.session.startTurn({ threadId: resumed.id, clientTurnKey: "after-history", intent: "start", content: [{ type: "text", text: "Again." }] }), (error: unknown) => isAriError(error, "invalid_state"));

      // An interactive resume then makes it usable, on the server the history read used.
      const alive = [...rig.world.servers].filter((server) => server.alive).length;
      const interactive = await reader.session.resumeThread({ native: { handle: a.handle! }, policy: policy(rig.cwd) });
      assert.equal(interactive.status, "idle");
      assert.equal([...rig.world.servers].filter((server) => server.alive).length, alive, "no second server for the thread");
      await runTurn(rig, reader, interactive.id, "Now interactive.");

      // A session OpenCode does not have is not found: a history read never replaces it.
      const sessions = rig.world.sessions.size;
      await assert.rejects(reader.session.resumeThread({ native: { handle: "ses_missing" }, purpose: "history", policy: policy(rig.cwd) }), (error: unknown) => isAriError(error, "not_found"));
      assert.equal(rig.world.sessions.size, sessions, "no session was created");
      assert.ok(!reader.events.some((event) => event.body.type === "session.replaced"));
    });
  }
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

  test("1.x: under full_access a subagent still asks (OpenCode gives it its own agent's rules), and the host's auto-reply reaches OpenCode as once", async () => {
    const rig = await rigFor(1);
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd, "full_access") });
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "full-sub", intent: "start", content: [{ type: "text", text: "Delegate." }] });
    assert.equal(started.status, "accepted");
    const native = await rig.nextTurn();
    const child = await native.runSubagent("helper");
    // The general subagent asks before reading a .env file (1.19.6 `agent/agent.ts`); the thread's * allow never reached it.
    const file = `${rig.cwd}/secrets.env`;
    const handle = await native.requestPermissionFrom(child.childId, "read", file, { filePath: file });
    const request = await rig.until(opened.events, () => pendingRequest(opened.events), "the subagent's request");
    assert.equal(request.fullAccessOverride, undefined, "no rule of the host's asked: the auto-reply may answer");
    const reply = fullAccessAutoReply(request, "auto");
    assert.equal(reply?.optionId, "once", "the narrowest accepting option");
    await opened.session.respond(reply!);
    assert.equal(await handle.nextReply(), "once");
    const sent = rig.world.frames.filter((frame) => frame.direction === "request" && frame.operation === "permission.reply").at(-1);
    assert.deepEqual((sent?.body as { body: unknown }).body, { reply: "once" }, "OpenCode got once");
    await child.finish();
    await native.complete();
  });

  test("2.x: under full_access a subagent copies the thread's * allow, so it asks nothing; a plugin that asks anyway marks the request provider_check", async () => {
    const rig = await rigFor(2);
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd, "full_access") });
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "full-sub", intent: "start", content: [{ type: "text", text: "Delegate." }] });
    assert.equal(started.status, "accepted");
    const native = await rig.nextTurn();
    const child = await native.runSubagent("helper");
    const server = liveServer(rig);
    const childSession = rig.world.sessions.get(child.childId)!;
    for (const action of ["shell", "edit", "read", "webfetch"]) assert.equal(server.decide(childSession, action, [`${rig.cwd}/secrets.env`]), "allow", action);
    await child.finish();
    // A plugin's permission.evaluate hook (2.1.2 `core/src/permission.ts`) may still ask; that is OpenCode's own check, so it reaches the user.
    rig.world.permissionHook = (input) => (input.action === "webfetch" ? "ask" : undefined);
    const handle = await native.requestPermission("webfetch", "https://example.com", { url: "https://example.com" });
    const request = await rig.until(opened.events, () => pendingRequest(opened.events), "the plugin's request");
    assert.equal(request.fullAccessOverride, "provider_check");
    assert.equal(fullAccessAutoReply(request, "auto"), undefined);
    await opened.session.respond({ requestId: request.id, responseKey: "user", optionId: "once" });
    assert.equal(await handle.nextReply(), "once");
    rig.world.permissionHook = undefined;
    await native.complete();
  });
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
      // A request OpenCode's subagent makes in either generation: reading a .env file asks (1.19.6 `agent/agent.ts`; under approval_required 2.x copies rules that do not decide it).
      const file = `${rig.cwd}/secrets.env`;
      const handle = await native.requestPermissionFrom(child.childId, "read", file, { filePath: file });
      const request = await rig.until(opened.events, () => pendingRequest(opened.events), "the subagent's request");
      assert.equal(request.origin.subagentId, subagent.id);
      assert.equal(request.origin.threadId, thread.id);
      await opened.session.respond({ requestId: request.id, responseKey: "sub", optionId: "once" });
      assert.equal(await handle.nextReply(), "once");
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

  for (const generation of [1, 2] as const) {
    test(`${generation}.x: reasoning streams as a reasoning item; read and other permissions are file_read and permission requests`, async () => {
      const rig = await rigFor(generation);
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "r1", intent: "start", content: [{ type: "text", text: "Think first." }] });
      assert.equal(started.status, "accepted");
      if (started.status !== "accepted") return;
      const native = await rig.nextTurn();
      await native.think("Considering the options.");
      const reasoning = await rig.until(opened.events, (event) => (event.body.type === "item.upsert" && event.body.item.reasoning === "Considering the options." ? event.body.item : undefined), "the reasoning item");
      const opening = opened.events.find((event) => event.body.type === "item.upsert" && event.body.item.id === reasoning.id && event.body.item.kind !== undefined);
      assert.equal(opening?.body.type === "item.upsert" ? opening.body.item.kind : undefined, "reasoning");
      assert.ok(opened.events.some((event) => event.body.type === "item.delta" && event.body.itemId === reasoning.id && event.body.field === "reasoning"));

      const file = `${rig.cwd}/secrets.env`;
      const read = await native.requestPermission("read", file, { filePath: file });
      const readRequest = await rig.until(opened.events, () => pendingRequest(opened.events), "the read request");
      assert.equal(readRequest.kind, "file_read");
      assert.deepEqual(readRequest.subject?.paths, [file]);
      await opened.session.respond({ requestId: readRequest.id, responseKey: "read", optionId: "reject" });
      assert.equal(await read.nextReply(), "reject");
      const fetchHandle = await native.requestPermission("webfetch", "https://example.com", { url: "https://example.com" });
      const fetchRequest = await rig.until(opened.events, () => {
        for (const event of opened.events) if (event.body.type === "request.upsert" && event.body.request.status === "pending" && event.body.request.id !== readRequest.id) return event.body.request as Request;
        return undefined;
      }, "the webfetch request");
      assert.equal(fetchRequest.kind, "permission");
      assert.equal(fetchRequest.subject?.tool?.name, "webfetch");
      await opened.session.respond({ requestId: fetchRequest.id, responseKey: "fetch", optionId: "once" });
      assert.equal(await fetchHandle.nextReply(), "once");
      await native.complete();
      assert.equal((await rig.terminal(opened.events, started.turnId)).status, "completed");
    });

    test(`${generation}.x: a stdio MCP server becomes OpenCode's local config, an HTTP one its remote config`, async () => {
      const rig = await rigFor(generation);
      const opened = await rig.open({ launch: { mcpServers: [{ name: "local-tools", transport: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "t" } }] } });
      await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const server = [...rig.world.servers].find((candidate) => candidate.alive && candidate.mcp.has(rig.cwd))!;
      const entries = server.mcp.get(rig.cwd)!;
      assert.deepEqual(entries.get("local-tools"), { type: "local", command: ["node", "server.js"], environment: { TOKEN: "t" } });
      const host = [...entries.entries()].find(([name]) => name.startsWith("host-tools-"))?.[1] as { type?: unknown } | undefined;
      assert.equal(host?.type, "remote");
      const sessions = rig.world.sessions.size;
      await assert.rejects(opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), launch: { mcpServers: [{ name: "old-sse", transport: "sse", url: "http://127.0.0.1:1/sse" }] } }), (error: unknown) => isAriError(error, "unsupported"));
      assert.equal(rig.world.sessions.size, sessions, "the refused thread left no session behind");
    });

    test(`${generation}.x: a free-text answer reaches OpenCode with the chosen options`, async () => {
      const rig = await rigFor(generation);
      const opened = await rig.open();
      assert.equal(opened.session.capabilities().requests.allowCustomAnswer, true);
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "q2", intent: "start", content: [{ type: "text", text: "Ask me." }] });
      assert.equal(started.status, "accepted");
      const native = await rig.nextTurn();
      const asked = await native.askQuestion({ text: "Which colour?", options: ["red", "blue"] });
      const request = await rig.until(opened.events, () => pendingRequest(opened.events), "the question");
      assert.equal(request.allowCustomAnswer, true);
      const question = request.questions![0]!;
      await opened.session.respond({ requestId: request.id, responseKey: "q", answers: { [question.id]: { text: "teal" } } });
      assert.deepEqual(await asked.answers(), generation === 1 ? [["teal"]] : { choice: "teal" });
      await native.complete();
    });
  }

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
