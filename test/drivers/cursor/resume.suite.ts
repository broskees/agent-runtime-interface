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
import { spawnSync } from "node:child_process";
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

/** Polls `check` every 2 ms; false once `timeoutMs` passed without it holding. */
async function eventually(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return true;
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

  // A restarted host: the old instance is gone, and a new one opens the same state directory and the same Cursor.
  await target.instance.dispose();
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

test("a resumed handle's forced send never expires the run the creating handle takes meanwhile: one of the two turns is refused", async () => {
  const target = await rig();
  const creator = await target.open();
  const thread = await creator.session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  const resumer = await target.open();
  await resumer.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(target.cwd) });

  // The resumed session's send pauses inside the SDK, before Cursor's store reserves its run
  // (the SDK resolves the model first); every later send goes straight through.
  const original = target.world.startRun.bind(target.world);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reached: string[] = [];
  let paused = false;
  target.world.startRun = async (agent, message, options) => {
    reached.push(typeof message === "string" ? message : message.text);
    if (!paused) {
      paused = true;
      await gate;
    }
    return original(agent, message, options);
  };
  const start = (session: Session, key: string, text: string) => session.startTurn({ threadId: thread.id, clientTurnKey: key, intent: "start", content: [{ type: "text", text }] });
  const resumedTurn = start(resumer.session, "resumed-1", "From the resumed handle.");
  assert.ok(await eventually(() => reached.includes("From the resumed handle."), 10_000), "the resumed handle's send reached the SDK");
  let creatorSettled = false;
  const creatorTurn = start(creator.session, "creator-1", "From the creating handle.");
  creatorTurn.then(
    () => (creatorSettled = true),
    () => (creatorSettled = true),
  );
  // Before the paused send goes on, the creating handle's turn gets every chance to reach Cursor:
  // a driver that lets it through has sent it well within a second.
  if (await eventually(() => reached.includes("From the creating handle."), 1000)) await eventually(() => creatorSettled, 10_000);
  release();

  const accepted = await resumedTurn;
  assert.equal(accepted.status, "accepted");
  await assert.rejects(creatorTurn, (error: unknown) => isAriError(error, "invalid_state"), "the creating handle's turn waits for the resumed one and is refused");
  target.world.startRun = original;
  assert.deepEqual(target.world.sends.map((send) => send.message), ["From the resumed handle."], "only one send reached Cursor");
  // The forced send expired only the reservation nobody had taken; the run it started is live.
  assert.deepEqual(await target.world.persistedRuns(thread.native.id!), [
    { status: "expired", error: "force_send" },
    { status: "running", error: null },
  ]);
  const run = await target.nextRun();
  await run.endTurn();
  run.finish();
  assert.equal((await target.terminal(resumer.events, (accepted as { turnId: string }).turnId)).status, "completed");
  assert.deepEqual((await target.world.persistedRuns(thread.native.id!)).map((row) => row.status), ["expired", "finished"]);
  // Once the run ended, the creating handle's session runs the next turn.
  await runTurn(target, creator.session, creator.events, thread.id, "Now the creating handle.");
});

test("two turns started at once on two threads get two run ids, as Cursor's store gives", async () => {
  const target = await rig();
  const { session, events } = await target.open();
  const threads = [await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) }), await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) })];
  const started = await Promise.all(threads.map((thread, index) => session.startTurn({ threadId: thread.id, clientTurnKey: `parallel-${index}`, intent: "start", content: [{ type: "text", text: `Turn ${index}.` }] })));
  assert.deepEqual(started.map((result) => result.status), ["accepted", "accepted"]);
  const runs = [await target.nextRun(), await target.nextRun()];
  assert.notEqual(runs[0]!.id, runs[1]!.id);
  const natives = events.flatMap((event) => (event.body.type === "turn.upsert" && event.body.turn.native !== undefined ? [event.body.turn.native.id] : []));
  assert.equal(new Set(natives).size, 2, `each turn names its own native run: ${natives.join(", ")}`);
  for (const run of runs) {
    await run!.endTurn();
    run!.finish();
  }
  for (const result of started) await target.terminal(events, (result as { turnId: string }).turnId);
});

test("a replacement for a lost thread gets every host instruction the thread was given, each once, at the top of its first prompt", async () => {
  const target = await rig();
  const sentTexts = () => target.world.sends.map((send) => (typeof send.message === "string" ? send.message : send.message.text));
  const { session, events } = await target.open({ launch: { developerPrompt: ["SESSION-MARKER"] } });

  // An empty thread: none of its instructions ever reached Cursor.
  const empty = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd), launch: { appendSystemPrompt: ["CREATE-APPEND-MARKER"] }, context: { developer: "CREATE-DEVELOPER-MARKER" } });
  await session.release();
  await target.world.forget(empty.native.id!);
  const replacement = await session.resumeThread({ native: { handle: empty.handle! }, policy: policy(target.cwd), launch: { appendSystemPrompt: ["RESUME-MARKER"] } });
  assert.notEqual(replacement.id, empty.id);
  await target.until(events, (event) => (event.body.type === "session.replaced" && event.threadId === replacement.id ? event : undefined), "session.replaced");
  await runTurn(target, session, events, replacement.id, "Work.");
  assert.equal(sentTexts().at(-1), "SESSION-MARKER\n\nCREATE-APPEND-MARKER\n\nCREATE-DEVELOPER-MARKER\n\nRESUME-MARKER\n\nWork.");
  await runTurn(target, session, events, replacement.id, "More.");
  assert.equal(sentTexts().at(-1), "More.", "the next prompt carries none of them again");

  // A thread whose conversation Cursor lost: the fresh agent never saw any of its instructions either.
  const used = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd), context: { developer: "USED-DEVELOPER-MARKER" } });
  await runTurn(target, session, events, used.id, "First.");
  assert.equal(sentTexts().at(-1), "SESSION-MARKER\n\nUSED-DEVELOPER-MARKER\n\nFirst.");
  await session.unloadThread!(used.id);
  await target.world.forget(used.native.id!);
  const fresh = await session.resumeThread({ native: { handle: used.handle! }, policy: policy(target.cwd), launch: { developerPrompt: ["USED-RESUME-MARKER"] } });
  await runTurn(target, session, events, fresh.id, "Again.");
  assert.equal(sentTexts().at(-1), "SESSION-MARKER\n\nUSED-DEVELOPER-MARKER\n\nUSED-RESUME-MARKER\n\nAgain.");
});

test("a second instance on the same state directory is refused with invalid_state while the first holds it, and opens once the first is gone", async () => {
  const target = await rig();
  const first = await target.open();
  const thread = await first.session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  const { turnId, run } = await target.turn(first.session, thread.id, "Long task.");
  const second = await rig({ share: { root: target.root, world: target.world } });
  await assert.rejects(second.instance.openSession({}), (error: unknown) => isAriError(error, "invalid_state"));
  assert.deepEqual((await target.world.persistedRuns(thread.native.id!)).map((row) => row.status), ["running"], "the first instance's run is untouched");
  await run.endTurn();
  run.finish();
  await target.terminal(first.events, turnId);
  await target.instance.dispose();
  const opened = await second.open();
  await opened.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(target.cwd) });
  await runTurn(second, opened.session, opened.events, thread.id, "After the first instance.");
});

test("a lock file a dead process left on the state directory does not stop the instance", async () => {
  const target = await rig();
  const stateDir = instanceDirectories(target.root, "cursor-test").stateDir;
  const exited = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(exited.status, 0);
  fs.writeFileSync(path.join(stateDir, "cursor-instance.lock"), `${JSON.stringify({ pid: exited.pid })}\n`);
  const { session, events } = await target.open();
  const thread = await session.createThread({ cwd: target.cwd, policy: policy(target.cwd) });
  await runTurn(target, session, events, thread.id, "Works.");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "cursor-instance.lock"), "utf8")), { pid: process.pid });
  await target.instance.dispose();
  assert.equal(fs.existsSync(path.join(stateDir, "cursor-instance.lock")), false, "dispose removes the lock file");
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
