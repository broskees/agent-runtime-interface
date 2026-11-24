// Resuming, releasing and unloading Cursor threads, against a fake whose
// runs are taken the way the pinned SDK's store takes them.
//
// - Cursor's store reserves a queued first run at `Agent.create` that only
//   the handle it returned can take; a resumed handle gets a follow-up run,
//   which the store refuses while that reservation is queued. An empty thread
//   must still run after release, unload, a closed session or a restart.
// - A resume asks for a policy and launch context. What Cursor can apply
//   reaches it on the next run; what it cannot is refused, never ignored.
// - The driver resumes only agents its own instance created: it writes host
//   launch text into the next prompt, which must never reach a conversation
//   the user made.

import "./setup-env.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import * as Real from "@cursor/sdk";
import { READ_ONLY_TOOLS } from "../../../src/drivers/cursor/index.ts";
import type { AriEvent, Session } from "../../../src/index.ts";
import type { LaunchMcpServer } from "../../../src/generated/session.ts";
import { isAriError } from "../../../src/index.ts";
import { instanceDirectories } from "../../helpers/conformance.ts";
import type { FakeRun } from "./fake-sdk.ts";
import { MANAGED_KEY } from "./harness.ts";
import { openCursorRig, policy } from "./rig.ts";
import type { CursorTestRig } from "./rig.ts";

const rigs: CursorTestRig[] = [];
after(async () => {
  for (const rig of rigs.reverse()) await rig.close();
});

async function rig(options: Parameters<typeof openCursorRig>[0] = {}): Promise<CursorTestRig> {
  const opened = await openCursorRig(options);
  rigs.push(opened);
  return opened;
}

async function runTurn(target: CursorTestRig, session: Session, events: AriEvent[], threadId: string, text: string): Promise<void> {
  const { turnId, run } = await target.turn(session, threadId, text);
  await run.say("Done.");
  await run.endTurn();
  run.finish();
  assert.equal((await target.terminal(events, turnId)).status, "completed");
}

function server(name: string, url = `http://127.0.0.1:9/${name}`): LaunchMcpServer {
  return { name, transport: "http", url };
}

function runServers(target: CursorTestRig): string[] {
  return Object.keys(target.world.sends.at(-1)?.options?.mcpServers ?? {}).sort();
}

test("the fake takes runs as Cursor's store does: a resumed handle cannot send while the creating handle's first run is reserved, unless it forces", async () => {
  const target = await rig();
  const store = new target.world.module.JsonlLocalAgentStore(path.join(target.root, "probe-store"));
  const options = { apiKey: MANAGED_KEY, model: { id: "composer-2.5" }, local: { cwd: target.cwd, store } };
  const created = await target.world.module.Agent.create(options);
  assert.deepEqual(await target.world.persistedRuns(created.agentId), [{ status: "queued", error: null }]);
  created.close();
  const resumed = await target.world.module.Agent.resume(created.agentId, options);
  await assert.rejects(resumed.send("Hello."), (error: unknown) => error instanceof Real.UnknownAgentError && /already has active run/.test(error.message));
  assert.equal(target.world.sends.length, 0, "a refused send starts no run");
  const run = await resumed.send("Hello.", { local: { force: true } });
  assert.deepEqual(await target.world.persistedRuns(created.agentId), [
    { status: "expired", error: "force_send" },
    { status: "running", error: null },
  ]);
  await assert.rejects(resumed.send("Again."), /already has active run/);
  (run as FakeRun).finish();
  await run.wait();
  assert.deepEqual((await target.world.persistedRuns(created.agentId)).at(-1), { status: "finished", error: null });
  resumed.close();
});

test("an empty thread runs after release, after unload, in a later session and after a host restart", async () => {
  const target = await rig();
  const { session, events } = await target.open();
  const released = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  await session.release();
  await runTurn(target, session, events, released.id, "After release.");
  // The send that took over expired the reservation the closed handle left; then the run finished.
  assert.deepEqual(await target.world.persistedRuns(released.native.id!), [
    { status: "expired", error: "force_send" },
    { status: "finished", error: null },
  ]);

  const unloaded = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  await session.unloadThread!(unloaded.id);
  await runTurn(target, session, events, unloaded.id, "After unload.");

  const closed = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  const restarted = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  await session.close();
  const later = await target.open();
  await later.session.resumeThread({ native: { handle: closed.handle! }, policy: policy(target.cwd) });
  await runTurn(target, later.session, later.events, closed.id, "In a later session.");

  // A restarted host: a new instance on the same state directory and the same Cursor.
  const again = await rig({ share: { root: target.root, world: target.world } });
  const afterRestart = await again.open();
  await afterRestart.session.resumeThread({ native: { handle: restarted.handle! }, policy: policy(target.cwd) });
  await runTurn(again, afterRestart.session, afterRestart.events, restarted.id, "After a restart.");
});

test("a run another session of the instance is running is never expired: the other session's turn is refused until it ends", async () => {
  const target = await rig();
  const first = await target.open();
  const thread = await first.session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  const { turnId, run } = await target.turn(first.session, thread.id, "Long task.");
  const second = await target.open();
  await second.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(target.cwd) });
  await assert.rejects(
    second.session.startTurn({ threadId: thread.id, clientTurnKey: "second-1", intent: "start", content: [{ type: "text", text: "Me too." }] }),
    (error: unknown) => isAriError(error, "invalid_state"),
  );
  assert.equal(run.status, "running");
  assert.deepEqual((await target.world.persistedRuns(thread.native.id!)).map((row) => row.status), ["running"]);
  await run.endTurn();
  run.finish();
  await target.terminal(first.events, turnId);
  await runTurn(target, second.session, second.events, thread.id, "Now me.");
});

test("resuming a loaded full_access thread as read_only reopens its agent with Cursor's reading tools, and the next turn has no shell", async () => {
  const target = await rig();
  const { session, events } = await target.open();
  const thread = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd, "full_access") });
  await runTurn(target, session, events, thread.id, "Do anything.");
  const resumes = target.world.resumes.length;
  await session.resumeThread({ native: { handle: thread.handle! }, policy: policy(target.cwd, "read_only") });
  assert.equal(target.world.resumes.length, resumes + 1, "the agent is reopened");
  assert.deepEqual(target.world.resumes.at(-1)?.options?.tools, [...READ_ONLY_TOOLS]);
  const { turnId, run } = await target.turn(session, thread.id, "Look only.");
  await assert.rejects(run.runTool("tool_x", { type: "shell", args: { command: "rm -rf /" } }), /does not offer the shell tool/);
  await run.endTurn();
  run.finish();
  await target.terminal(events, turnId);
  // And back: full_access is Cursor's default set again.
  await session.resumeThread({ native: { handle: thread.handle! }, policy: policy(target.cwd, "full_access") });
  assert.equal(target.world.resumes.at(-1)?.options?.tools, undefined);
});

test("a resume asking for what Cursor cannot apply is refused, and the thread keeps its policy", async () => {
  const target = await rig();
  const { session, events } = await target.open();
  const thread = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd, "full_access") });
  await runTurn(target, session, events, thread.id, "Start.");
  const resume = (input: Partial<Parameters<Session["resumeThread"]>[0]>) => session.resumeThread({ native: { handle: thread.handle! }, ...input });

  // Cursor has no approval flow.
  await assert.rejects(resume({ policy: policy(target.cwd, "approval_required") }), (error: unknown) => isAriError(error, "unsupported"));
  // Cursor keeps a local agent in the directory it was created in.
  fs.mkdirSync(path.join(target.root, "elsewhere"), { recursive: true });
  await assert.rejects(resume({ policy: policy(path.join(target.root, "elsewhere")) }), (error: unknown) => isAriError(error, "invalid_state"));
  // A mode change reopens the agent, which waits for the running turn.
  const { turnId, run } = await target.turn(session, thread.id, "Busy.");
  await assert.rejects(resume({ policy: policy(target.cwd, "read_only") }), (error: unknown) => isAriError(error, "invalid_state"));
  await assert.rejects(resume({ launch: { dynamicTools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }] } }), (error: unknown) => isAriError(error, "unsupported"));
  await run.runTool("tool_shell", { type: "shell", args: { command: "true" } });
  await run.endTurn();
  run.finish();
  await target.terminal(events, turnId);

  const next = await target.turn(session, thread.id, "Still full access.");
  await next.run.runTool("tool_shell_2", { type: "shell", args: { command: "true" } });
  await next.run.endTurn();
  next.run.finish();
  assert.equal((await target.terminal(events, next.turnId)).status, "completed");
});

test("a resume's launch MCP servers reach the next run: on a loaded thread, after release and after unload; a server the resume names again takes its new definition", async () => {
  const target = await rig({ host: { mcpServerName: () => "host-tools" } });
  const { session, events } = await target.open();
  const thread = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd), launch: { mcpServers: [server("original-docs")] } });
  await runTurn(target, session, events, thread.id, "One.");
  assert.deepEqual(runServers(target), ["host-tools", "original-docs"]);

  await session.resumeThread({ native: { handle: thread.handle! }, launch: { mcpServers: [server("loaded-docs")] } });
  await runTurn(target, session, events, thread.id, "Two.");
  assert.deepEqual(runServers(target), ["host-tools", "loaded-docs", "original-docs"]);

  await session.release();
  await session.resumeThread({ native: { handle: thread.handle! }, launch: { mcpServers: [server("released-docs")] } });
  await runTurn(target, session, events, thread.id, "Three.");
  assert.deepEqual(runServers(target), ["host-tools", "loaded-docs", "original-docs", "released-docs"]);
  assert.deepEqual(Object.keys(target.world.resumes.at(-1)?.options?.mcpServers ?? {}).sort(), ["loaded-docs", "original-docs", "released-docs"]);

  await session.unloadThread!(thread.id);
  await session.resumeThread({ native: { handle: thread.handle! }, launch: { mcpServers: [server("unloaded-docs"), server("original-docs", "http://127.0.0.1:9/moved")] } });
  await runTurn(target, session, events, thread.id, "Four.");
  assert.deepEqual(runServers(target), ["host-tools", "loaded-docs", "original-docs", "released-docs", "unloaded-docs"]);
  assert.deepEqual(target.world.sends.at(-1)?.options?.mcpServers?.["original-docs"], { type: "http", url: "http://127.0.0.1:9/moved" });
});

test("resumeThread refuses a Cursor agent its instance did not create, and leaves that conversation untouched", async () => {
  const target = await rig();
  // The user makes an agent with Cursor's own SDK, in the very store the instance uses.
  const storeDirectory = path.join(instanceDirectories(target.root, "cursor-test").stateDir, "cursor-agents");
  const store = new Real.JsonlLocalAgentStore(storeDirectory);
  const userAgent = await Real.Agent.create({ apiKey: "crsr_user_own_key", model: { id: "composer-2.5" }, local: { cwd: target.cwd, store }, agentId: "agent-made-by-the-user" });
  userAgent.close();
  const snapshot = () => Object.fromEntries(fs.readdirSync(storeDirectory).map((name) => [name, fs.readFileSync(path.join(storeDirectory, name), "utf8")]));
  const before = snapshot();

  const { session, events } = await target.open({ launch: { developerPrompt: ["HOST-LAUNCH-MARKER"] } });
  for (const native of [{ id: "agent-made-by-the-user", strength: "strong" as const }, { handle: "agent-made-by-the-user" }]) {
    await assert.rejects(session.resumeThread({ native, policy: policy(target.cwd) }), (error: unknown) => isAriError(error, "validation"));
  }
  assert.equal(target.world.sends.length, 0, "nothing was sent to the user's agent");
  assert.equal(events.some((event) => event.body.type === "session.replaced"), false, "the refusal replaces nothing");
  assert.equal(events.some((event) => event.body.type === "thread.upsert"), false, "the refusal makes no thread");
  assert.deepEqual(snapshot(), before, "the user's agent and its runs are as they were");

  // An agent the instance did create resumes as before, and so does one Cursor no longer holds: a fresh agent, said so.
  const own = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  await session.close();
  const second = await target.open();
  assert.equal((await second.session.resumeThread({ native: { handle: own.handle! }, policy: policy(target.cwd) })).id, own.id);
  const replaced = await second.session.resumeThread({ native: { id: "agent-nobody-has", strength: "strong" }, policy: policy(target.cwd) });
  assert.notEqual(replaced.native.id, "agent-nobody-has");
  await target.until(second.events, (event) => (event.body.type === "session.replaced" ? event : undefined), "session.replaced");
});
