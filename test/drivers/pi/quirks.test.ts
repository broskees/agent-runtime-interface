// The Pi quirks the driver keeps (proposal §1.3 Pi row): the user's own `pi` in
// RPC mode with strict JSONL framing; resume, rollback and forks through Pi's
// session files, with a fork into another directory run by Pi's CLI there and
// a resumed session in the directory its file records, also when the host
// resumes by bare session id from another directory; a thread Pi has not
// written yet that comes back as itself after its process stops, and a
// missing session file that is never swapped silently for a new session;
// prompts as Pi records them (a text block, then images); host tools only
// through a namespaced MCP bridge named by the host; and Pi's extension UI
// dialogs as requests.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { isAriError } from "../../../src/index.ts";
import type { AriEvent, Request } from "../../../src/index.ts";
import { FAKE_PI } from "./harness.ts";
import { checkRunsAgainstPiTypes } from "./pi-types.ts";
import { openPiTestRig, policy } from "./rig.ts";
import type { PiTestRig } from "./rig.ts";

const rigs: PiTestRig[] = [];
after(async () => {
  for (const rig of rigs) await rig.close();
});

async function rig(options?: Parameters<typeof openPiTestRig>[0]): Promise<PiTestRig> {
  const opened = await openPiTestRig(options);
  rigs.push(opened);
  return opened;
}

function pendingRequest(events: readonly AriEvent[], threadId: string, after: ReadonlySet<string> = new Set()): Request | undefined {
  const requests = new Map<string, Request>();
  for (const event of events) {
    if (event.body.type !== "request.upsert") continue;
    const previous = requests.get(event.body.request.id);
    requests.set(event.body.request.id, { ...(previous ?? {}), ...event.body.request } as Request);
  }
  return [...requests.values()].find((request) => request.status === "pending" && request.origin.threadId === threadId && !after.has(request.id));
}

function assistantText(events: readonly AriEvent[], turnId: string): string {
  const items = new Map<string, { kind?: string; text?: string }>();
  for (const event of events) {
    if (event.body.type === "item.upsert" && event.turnId === turnId) items.set(event.body.item.id, { ...items.get(event.body.item.id), ...(event.body.item as { kind?: string; text?: string }) });
  }
  return [...items.values()].filter((item) => item.kind === "assistant_message").map((item) => item.text ?? "").join("");
}

async function simpleTurn(opened: PiTestRig, session: Awaited<ReturnType<PiTestRig["open"]>>, threadId: string, text: string): Promise<string> {
  const started = await session.session.startTurn({ threadId, clientTurnKey: `key-${text}`, intent: "start", content: [{ type: "text", text }] });
  assert.equal(started.status, "accepted");
  if (started.status !== "accepted") throw new Error("not accepted");
  const native = await opened.nextTurn();
  assert.equal(native.prompt, text);
  await native.say(`Done: ${text}`);
  await native.complete();
  const terminal = await opened.terminal(session.events, started.turnId);
  assert.equal(terminal.status, "completed");
  return started.turnId;
}

test("the driver runs the user's own pi, found through resolveExecutable, in RPC mode with strict JSONL framing", async () => {
  const opened = await rig();
  const session = await opened.open();
  const thread = await session.session.createThread({ cwd: opened.cwd, policy: policy(opened.cwd) });

  const lookups = opened.host.calls.filter((call) => call.operation === "process.resolveExecutable").map((call) => call.args[0]);
  assert.ok(lookups.includes("pi"), `the driver looked up ${JSON.stringify(lookups)}, not the user's pi`);
  const runtime = opened.host.spawns.find((spawn) => spawn.args?.includes("--mode"));
  assert.ok(runtime !== undefined);
  assert.equal(runtime.command, FAKE_PI, "the driver runs the executable the host resolved");
  assert.deepEqual(runtime.args?.slice(0, 2), ["--mode", "rpc"]);

  // U+2028 and U+2029 are valid inside JSON strings; a reader that splits on them (Node's readline) corrupts the frame.
  const said = "Line one\u2028line two\u2029line three";
  const started = await session.session.startTurn({ threadId: thread.id, clientTurnKey: "framing", intent: "start", content: [{ type: "text", text: "Use separators." }] });
  assert.equal(started.status, "accepted");
  if (started.status !== "accepted") return;
  const native = await opened.nextTurn();
  await native.say(said);
  await native.complete();
  await opened.terminal(session.events, started.turnId);
  assert.equal(assistantText(session.events, started.turnId), said);
});

test("resume and rollback use Pi's session files, and a rollback survives a restart", async () => {
  const opened = await rig();
  const first = await opened.open();
  const thread = await first.session.createThread({ cwd: opened.cwd, policy: policy(opened.cwd) });
  const firstTurn = await simpleTurn(opened, first, thread.id, "First.");
  await simpleTurn(opened, first, thread.id, "Second.");
  assert.deepEqual((await opened.inspect(thread))?.prompts, ["First.", "Second."]);

  // Rolling back to the first turn keeps it and drops the second, in the same session file.
  const snapshot = await first.session.rollbackThread!({ threadId: thread.id, to: { type: "turn", turnId: firstTurn } });
  assert.deepEqual(
    snapshot.turns.map((turn) => turn.id),
    [firstTurn],
  );
  assert.deepEqual((await opened.inspect(thread))?.prompts, ["First."]);
  const rewinds = opened.harness.frames.filter((frame) => frame.direction === "in" && String(frame.record["message"] ?? "").startsWith("/ari-rewind "));
  assert.equal(rewinds.length, 1, "the rollback moved Pi's leaf with the bridge's /ari-rewind");
  const stored = fs.readFileSync(thread.handle!, "utf8");
  assert.match(stored, /"type":"label"/, "Pi persisted the leaf move as a label entry");
  await first.session.close();

  // A new session resumes the file with --session, and the rollback held.
  const second = await opened.open();
  const resumed = await second.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(opened.cwd) });
  assert.equal(resumed.id, thread.id);
  const resumeSpawn = opened.host.spawns.at(-1)!;
  assert.deepEqual(resumeSpawn.args?.slice(resumeSpawn.args.indexOf("--session"), resumeSpawn.args.indexOf("--session") + 2), ["--session", thread.handle]);
  assert.equal(
    second.events.some((event) => event.body.type === "session.replaced"),
    false,
  );
  assert.deepEqual((await opened.inspect(resumed))?.prompts, ["First."]);
  await simpleTurn(opened, second, resumed.id, "Third.");
  assert.deepEqual((await opened.inspect(resumed))?.prompts, ["First.", "Third."]);
  const rebuilt = await second.session.readSnapshot!(resumed.id);
  assert.equal(rebuilt.turns[0]?.id, firstTurn, "turn ids rebuilt from the session file match the live ones");
});

test("a fork into another directory runs Pi's CLI there, and a fork from a turn keeps the history before it", async () => {
  const opened = await rig();
  const session = await opened.open();
  const thread = await session.session.createThread({ cwd: opened.cwd, policy: policy(opened.cwd) });
  await simpleTurn(opened, session, thread.id, "One.");
  const second = await simpleTurn(opened, session, thread.id, "Two.");
  await simpleTurn(opened, session, thread.id, "Three.");

  const before = opened.harness.invocations.length;
  const fork = await session.session.forkThread!({ threadId: thread.id, at: { type: "latest" }, cwd: opened.otherCwd });
  const call = opened.harness.invocations.slice(before).find((invocation) => invocation.argv.includes("--fork"));
  assert.ok(call !== undefined, "the fork ran pi --fork");
  assert.equal(call.cwd, opened.otherCwd, "pi --fork ran in the destination directory");
  assert.equal(call.argv[call.argv.indexOf("--fork") + 1], thread.handle);
  assert.equal(fork.cwd, opened.otherCwd);
  const forked = await opened.inspect(fork);
  assert.equal(forked?.cwd, opened.otherCwd, "Pi's forked session works in the destination directory");
  assert.deepEqual(forked?.prompts, ["One.", "Two.", "Three."]);
  assert.notEqual(fork.handle, thread.handle);

  const fromTurn = await session.session.forkThread!({ threadId: thread.id, at: { type: "turn", turnId: second } });
  assert.equal(fromTurn.cwd, opened.cwd);
  assert.deepEqual((await opened.inspect(fromTurn))?.prompts, ["One."]);
  assert.deepEqual((await opened.inspect(thread))?.prompts, ["One.", "Two.", "Three."], "forking leaves the source untouched");
});

test("host tools reach Pi only through the bridge's MCP registration, under the names the host chose", async () => {
  const opened = await rig({ host: { mcpServerName: (threadId) => `acme-tools-${threadId.slice(-8)}` } });
  const session = await opened.open({ launch: { mcpServers: [{ name: "acme-docs", transport: "stdio", command: "docs-mcp", alwaysLoad: true }] } });
  const thread = await session.session.createThread({ cwd: opened.cwd, policy: policy(opened.cwd) });

  const asked = opened.host.calls.filter((call) => call.operation === "hostTools.mcpServerFor");
  assert.deepEqual(
    asked.map((call) => call.args[0]),
    [thread.id],
  );
  const hostName = `acme-tools-${thread.id.slice(-8)}`;
  const registrations = opened.harness.frames.filter((frame) => frame.direction === "in" && String(frame.record["message"] ?? "").startsWith("/ari-mcp "));
  assert.equal(registrations.length, 1);
  const registered = JSON.parse(String(registrations[0]!.record["message"]).slice("/ari-mcp ".length)) as { servers: Array<{ name: string; config: { type?: string; exposure?: string } }> };
  assert.deepEqual(
    registered.servers.map((server) => server.name),
    ["acme-docs", hostName],
  );
  assert.equal(registered.servers[0]!.config.exposure, "direct", "alwaysLoad keeps the tools declared to the model");
  const native = opened.harness.invocations.at(-1)!;
  assert.ok(native.bridge !== null, "the bridge extension was loaded");
  // No other channel carries MCP servers: no argument names them, and no mcp.json is written.
  for (const spawn of opened.host.spawns) {
    assert.ok(!(spawn.args ?? []).some((argument) => argument.includes(hostName) || argument.includes("mcp.json")), `pi was started with ${JSON.stringify(spawn.args)}`);
  }
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "mcp.json") found.push(full);
    }
  };
  walk(opened.harness.root);
  assert.deepEqual(found, []);
});

test("Pi extension UI dialogs arrive as requests, and answers go back in Pi's own reply shapes", async () => {
  const opened = await rig();
  const session = await opened.open();
  const thread = await session.session.createThread({ cwd: opened.cwd, policy: policy(opened.cwd) });
  const started = await session.session.startTurn({ threadId: thread.id, clientTurnKey: "dialogs", intent: "start", content: [{ type: "text", text: "Ask me things." }] });
  assert.equal(started.status, "accepted");
  if (started.status !== "accepted") return;
  const native = await opened.nextTurn();
  const seen = new Set<string>();

  const next = async (what: string): Promise<Request> => {
    const request = await opened.until(session.events, () => pendingRequest(session.events, thread.id, seen), what);
    seen.add(request.id);
    return request;
  };

  // select: one question whose options are Pi's option strings; the reply is the chosen string.
  const select = await native.extensionDialog({ method: "select", title: "Pick a colour", options: ["red", "blue"] });
  const selectRequest = await next("the select request");
  assert.equal(selectRequest.kind, "user_input");
  const question = selectRequest.questions?.[0];
  assert.equal(question?.type, "single_select");
  assert.deepEqual(
    question?.options?.map((option) => option.id),
    ["red", "blue"],
  );
  await session.session.respond({ requestId: selectRequest.id, responseKey: "r1", answers: { [question!.id]: { optionIds: ["blue"] } } });
  assert.equal(await select.nextReply(), "blue");

  // confirm: yes or no; Pi gets { confirmed }.
  const confirm = await native.extensionDialog({ method: "confirm", title: "Clear the cache?", message: "This cannot be undone." });
  const confirmRequest = await next("the confirm request");
  assert.match(confirmRequest.questions?.[0]?.prompt ?? "", /Clear the cache\?\n\nThis cannot be undone\./);
  await session.session.respond({ requestId: confirmRequest.id, responseKey: "r2", answers: { [confirmRequest.questions![0]!.id]: { optionIds: ["yes"] } } });
  assert.equal(await confirm.nextReply(), "confirmed");

  // input and editor: free text; Pi gets { value }.
  const input = await native.extensionDialog({ method: "input", title: "Branch name?", placeholder: "main" });
  const inputRequest = await next("the input request");
  assert.equal(inputRequest.questions?.[0]?.type, "text");
  await session.session.respond({ requestId: inputRequest.id, responseKey: "r3", answers: { [inputRequest.questions![0]!.id]: { text: "feature/pi" } } });
  assert.equal(await input.nextReply(), "feature/pi");
  const editor = await native.extensionDialog({ method: "editor", title: "Edit the message", prefill: "Draft" });
  const editorRequest = await next("the editor request");
  await session.session.respond({ requestId: editorRequest.id, responseKey: "r4", answers: { [editorRequest.questions![0]!.id]: { text: "Final text" } } });
  assert.equal(await editor.nextReply(), "Final text");

  // The bridge's approval: an approval with native option ids, not a question.
  const approval = await native.requestApproval({
    kind: "command",
    command: ["npm", "test"],
    options: [
      { optionId: "allow-once", label: "Allow once", decision: "accept" },
      { optionId: "decline", label: "Decline", decision: "decline" },
    ],
  });
  const approvalRequest = await next("the approval request");
  assert.equal(approvalRequest.kind, "command");
  assert.equal(approvalRequest.questions, undefined);
  assert.deepEqual(approvalRequest.subject?.command, ["npm test"]);
  await session.session.respond({ requestId: approvalRequest.id, responseKey: "r5", optionId: "decline" });
  assert.equal(await approval.nextReply(), "decline");

  // notify is a notice; a dialog still open when the turn ends is cancelled in Pi too.
  await native.extensionDialog({ method: "notify", message: "Heads up", notifyType: "warning" });
  await opened.until(session.events, (event) => (event.body.type === "notice" && event.body.text === "Heads up" ? event.body : undefined), "the notice");
  const left = await native.extensionDialog({ method: "input", title: "Never answered" });
  const leftRequest = await next("the unanswered request");
  await native.complete();
  await opened.terminal(session.events, started.turnId);
  assert.equal(await left.nextReply(), "cancelled");
  assert.ok(session.events.some((event) => event.body.type === "request.upsert" && event.body.request.id === leftRequest.id && event.body.request.status === "cancelled"));
});

/** The JSON lines of a session file. */
function storedLines(file: string): Array<{ type?: string; id?: string; cwd?: string; message?: { role?: string; content?: unknown } }> {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type?: string });
}

/** The ids of every thread the session has announced. */
function announcedThreads(events: readonly AriEvent[]): string[] {
  return [...new Set(events.flatMap((event) => (event.body.type === "thread.upsert" ? [event.body.thread.id] : [])))];
}

test("a resumed session works in the directory its file records, wherever pi starts; a fork without a destination stays there", async () => {
  const opened = await rig();
  const first = await opened.open();
  const thread = await first.session.createThread({ cwd: opened.cwd, policy: policy(opened.cwd) });
  await simpleTurn(opened, first, thread.id, "Here.");
  await first.session.close();

  // Pi's --session takes the cwd from the file's header; the policy's directory only decides where pi is started.
  const second = await opened.open();
  const resumed = await second.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(opened.otherCwd) });
  assert.equal(resumed.id, thread.id);
  assert.equal(opened.harness.invocations.at(-1)?.cwd, opened.otherCwd, "pi was started in the policy's directory");
  assert.equal(resumed.cwd, opened.cwd, "the resumed thread works in the directory its session file records");
  assert.equal((await opened.inspect(resumed))?.cwd, opened.cwd);

  const started = await second.session.startTurn({ threadId: resumed.id, clientTurnKey: "read-notes", intent: "start", content: [{ type: "text", text: "Read the notes." }] });
  assert.equal(started.status, "accepted");
  if (started.status !== "accepted") return;
  const native = await opened.nextTurn();
  await native.runTool({ name: "read", input: {}, output: "notes", path: "notes.txt" });
  await native.complete();
  await opened.terminal(second.events, started.turnId);
  const paths = second.events.flatMap((event) => (event.body.type === "item.upsert" && event.turnId === started.turnId ? (event.body.item.paths ?? []) : []));
  assert.deepEqual(paths, [path.join(opened.cwd, "notes.txt")], "Pi's tool paths are under the stored directory");

  const fork = await second.session.forkThread!({ threadId: resumed.id, at: { type: "latest" } });
  assert.equal(fork.cwd, opened.cwd, "a fork without a destination works where its source works");
  assert.equal(opened.harness.invocations.at(-1)?.cwd, opened.cwd, "pi --fork ran in the source's own directory");
});

test("a resume by bare session id gives Pi the session's file, so it works from any requested directory", async () => {
  const opened = await rig();
  const first = await opened.open();
  const thread = await first.session.createThread({ cwd: opened.cwd, policy: policy(opened.cwd) });
  await simpleTurn(opened, first, thread.id, "Made here.");
  await first.session.close();

  // Pi asks on stdin before it opens, by id, a session made in another directory; the driver must not let it.
  const second = await opened.open();
  const resumed = await second.session.resumeThread({ native: { id: thread.native.id!, strength: "strong" }, policy: policy(opened.otherCwd) });
  assert.equal(resumed.id, thread.id);
  assert.equal(resumed.native.id, thread.native.id);
  assert.equal(resumed.cwd, opened.cwd, "the session works where it was made");
  assert.equal(
    second.events.some((event) => event.body.type === "session.replaced"),
    false,
  );
  const resumeArgs = opened.host.spawns.at(-1)?.args ?? [];
  assert.equal(resumeArgs[resumeArgs.indexOf("--session") + 1], thread.handle, "pi got the session's file, not its id");
  assert.equal(opened.harness.invocations.at(-1)?.cwd, opened.otherCwd);
  await simpleTurn(opened, second, resumed.id, "Back from elsewhere.");
  assert.deepEqual((await opened.inspect(resumed))?.prompts, ["Made here.", "Back from elsewhere."]);

  // An id no session file holds never reaches Pi: the driver starts a fresh session and says the old one is gone.
  const unknownId = "00000000-0000-4000-8000-00000000eeee";
  const spawnsBefore = opened.host.spawns.length;
  const fresh = await second.session.resumeThread({ native: { id: unknownId, strength: "strong" }, policy: policy(opened.otherCwd) });
  assert.notEqual(fresh.native.id, unknownId);
  const replaced = second.events.find((event) => event.body.type === "session.replaced");
  assert.equal((replaced?.body as { previousNativeId?: string } | undefined)?.previousNativeId, unknownId);
  assert.equal((replaced?.body as { contextLost?: boolean } | undefined)?.contextLost, true);
  for (const spawned of opened.host.spawns.slice(spawnsBefore)) assert.ok(!(spawned.args ?? []).includes(unknownId), `pi was started with ${JSON.stringify(spawned.args)}`);
});

test("a prompt reaches Pi as its text and images, and Pi records a text block followed by the images", async () => {
  const opened = await rig();
  const session = await opened.open();
  const thread = await session.session.createThread({ cwd: opened.cwd, policy: policy(opened.cwd) });
  const image = { type: "image" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", mimeType: "image/png" };
  const started = await session.session.startTurn({ threadId: thread.id, clientTurnKey: "picture", intent: "start", content: [{ type: "text", text: "What is this?" }, image] });
  assert.equal(started.status, "accepted");
  if (started.status !== "accepted") return;
  const native = await opened.nextTurn();
  await native.say("A single pixel.");
  await native.complete();
  await opened.terminal(session.events, started.turnId);

  const expected = [{ type: "text", text: "What is this?" }, image];
  const command = opened.harness.frames.find((frame) => frame.direction === "in" && frame.record["type"] === "prompt" && frame.record["message"] === "What is this?");
  assert.deepEqual(command?.record["images"], [image], "the driver sent the image with Pi's prompt command");
  const userEvents = opened.harness.frames.filter((frame) => frame.direction === "out" && (frame.record["type"] === "message_start" || frame.record["type"] === "message_end") && (frame.record["message"] as { role?: unknown }).role === "user");
  assert.equal(userEvents.length, 2);
  for (const event of userEvents) assert.deepEqual((event.record["message"] as { content?: unknown }).content, expected);
  const stored = storedLines(thread.handle!).filter((line) => line.type === "message" && line.message?.role === "user");
  assert.deepEqual(
    stored.map((line) => line.message?.content),
    [expected],
  );
  const userItem = session.events.find((event) => event.body.type === "item.upsert" && event.turnId === started.turnId && event.body.item.kind === "user_message");
  assert.equal((userItem?.body as { item?: { text?: string } } | undefined)?.item?.text, "What is this?");
});

test("after release, the first turn of a thread Pi has not written yet runs on that thread and reaches its terminal", async () => {
  const opened = await rig();
  const session = await opened.open();
  const thread = await session.session.createThread({ cwd: opened.cwd, policy: policy(opened.cwd) });
  assert.equal(fs.existsSync(thread.handle!), false, "Pi writes no file for a session without messages");

  await session.session.release();
  // The bridge wrote Pi's own header before the process stopped, so --session reopens this session.
  assert.deepEqual(
    storedLines(thread.handle!).map((line) => [line.type, line.id]),
    [["session", thread.native.id]],
  );

  const started = await session.session.startTurn({ threadId: thread.id, clientTurnKey: "after-release", intent: "start", content: [{ type: "text", text: "After release." }] });
  assert.equal(started.status, "accepted");
  if (started.status !== "accepted") return;
  assert.deepEqual(announcedThreads(session.events), [thread.id], "no other thread took over the thread's events");
  const native = await opened.nextTurn();
  await native.say("Still here.");
  await native.complete();
  const terminal = await opened.terminal(session.events, started.turnId);
  assert.equal(terminal.status, "completed");
  const terminalEvent = session.events.find((event) => event.body.type === "turn.terminal" && event.body.turnId === started.turnId);
  assert.equal(terminalEvent?.threadId, thread.id);
  assert.equal(storedLines(thread.handle!)[0]?.id, thread.native.id, "the file still holds the thread's own session");
  assert.deepEqual((await opened.inspect(thread))?.prompts, ["After release."]);
});

test("when a thread's session file is gone, pi starting a new session there is an error, not a new thread", async () => {
  const opened = await rig();
  const session = await opened.open();
  const thread = await session.session.createThread({ cwd: opened.cwd, policy: policy(opened.cwd) });
  await simpleTurn(opened, session, thread.id, "Kept.");
  await session.session.release();
  fs.rmSync(thread.handle!);
  const eventsBefore = session.events.length;

  await assert.rejects(session.session.startTurn({ threadId: thread.id, clientTurnKey: "gone", intent: "start", content: [{ type: "text", text: "Anyone there?" }] }), (error: unknown) => {
    assert.ok(isAriError(error, "not_found"), `rejected with ${String(error)}`);
    assert.match(String((error as Error).message), new RegExp(thread.native.id!));
    return true;
  });
  const later = session.events.slice(eventsBefore);
  assert.deepEqual(
    later.filter((event) => event.body.type === "thread.upsert" || event.body.type === "turn.upsert"),
    [],
    "no thread or turn was announced for the session pi started instead",
  );
  assert.equal(fs.existsSync(thread.handle!), false, "pi wrote nothing at the thread's path");
});

test("resuming a session file that does not exist never returns another session as the one asked for", async () => {
  const opened = await rig();
  const session = await opened.open();
  const missingId = "00000000-0000-4000-8000-00000000ffff";
  const handle = path.join(opened.host.paths.stateDir, "sessions", `2026-11-23T00-00-00-000Z_${missingId}.jsonl`);

  // Without a policy the driver has no directory to start a fresh session in, so it starts nothing.
  const spawnsBefore = opened.host.spawns.length;
  await assert.rejects(session.session.resumeThread({ native: { handle } }), (error: unknown) => isAriError(error, "validation"));
  assert.equal(opened.host.spawns.length, spawnsBefore);
  // With one, the driver starts a fresh session and says the old context is gone.
  const fresh = await session.session.resumeThread({ native: { handle }, policy: policy(opened.cwd) });
  assert.notEqual(fresh.native.id, missingId);
  const replaced = session.events.find((event) => event.body.type === "session.replaced");
  assert.equal((replaced?.body as { previousNativeId?: string } | undefined)?.previousNativeId, handle);
  assert.equal((replaced?.body as { contextLost?: boolean } | undefined)?.contextLost, true);
  assert.equal(replaced?.threadId, fresh.id);
  assert.notEqual(fresh.handle, handle);

  // The first turn of the returned thread settles on it.
  const started = await session.session.startTurn({ threadId: fresh.id, clientTurnKey: "fresh", intent: "start", content: [{ type: "text", text: "Fresh start." }] });
  assert.equal(started.status, "accepted");
  if (started.status !== "accepted") return;
  const native = await opened.nextTurn();
  await native.complete();
  const terminal = await opened.terminal(session.events, started.turnId);
  assert.equal(terminal.status, "completed");
  assert.equal(session.events.find((event) => event.body.type === "turn.terminal" && event.body.turnId === started.turnId)?.threadId, fresh.id);
  assert.equal(storedLines(fresh.handle!)[0]?.id, fresh.native.id);
  assert.equal(fs.existsSync(handle), false, "nothing was written at the missing path");
});

test("every frame and session file line of these tests matches Pi's published types", () => {
  const checked = checkRunsAgainstPiTypes(rigs.map((rig) => rig.harness));
  assert.ok(checked.frames > 0);
  assert.deepEqual(checked.diagnostics, []);
});
