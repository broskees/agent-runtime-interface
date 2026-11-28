// How the Muse driver maps Muse's protocol: session start, turn steer,
// approval decision and user-input answer calls are `createThread`,
// `startTurn` with `intent: "steer"` and `respond`; fork and rollback reject
// with `unsupported`; usage is reported. Also the Muse quirks the driver keeps:
// a host per thread, queued turns, subagents and their approvals, the todo
// list, a dead host, unload, release, snapshots and model changes. Every frame
// of this file is type-checked against the SDK's wire types when it ends.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { VirtualClock } from "../../../src/conformance/index.ts";
import { isAriError } from "../../../src/index.ts";
import type { Session, StartTurnResult, Thread } from "../../../src/index.ts";
import { MUSE_CAPABILITIES, threadIdFor, turnIdFor } from "../../../src/drivers/muse/index.ts";
import type { FakeMuseTurn } from "./fake-muse.ts";
import { museRig, policy, until } from "./rig.ts";
import type { MuseTestRig, OpenedMuseSession } from "./rig.ts";

async function start(rig: MuseTestRig, session: Session, thread: Thread, text: string, extra: Partial<Parameters<Session["startTurn"]>[0]> = {}): Promise<{ result: StartTurnResult; native: FakeMuseTurn }> {
  const result = await session.startTurn({ threadId: thread.id, clientTurnKey: `${text}-${Math.random()}`, intent: "start", content: [{ type: "text", text }], ...extra });
  const native = await rig.nextTurn();
  return { result, native };
}

async function terminal(opened: OpenedMuseSession, turnId: string): Promise<Extract<OpenedMuseSession["events"][number]["body"], { type: "turn.terminal" }>> {
  return until(() => opened.bodies("turn.terminal").find((body) => body.turnId === turnId), `turn.terminal for ${turnId}`);
}

/** What `pending` settled with within `ms` real milliseconds, or "still pending". */
async function within<T>(pending: Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | "still pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<"still pending">((resolve) => {
    timer = setTimeout(() => resolve("still pending"), ms);
  });
  try {
    return await Promise.race([pending.then((value) => ({ value }), (error: unknown) => ({ error })), waited]);
  } finally {
    clearTimeout(timer);
  }
}

/** Records how `pending` settles, without waiting for it; the returned function reads it (undefined while pending). */
function watch<T>(pending: Promise<T>): () => { value: T } | { error: unknown } | undefined {
  let outcome: { value: T } | { error: unknown } | undefined;
  pending.then(
    (value) => (outcome = { value }),
    (error: unknown) => (outcome = { error }),
  );
  return () => outcome;
}

function turnIdOf(result: StartTurnResult): string {
  assert.equal(result.status, "accepted");
  return (result as { turnId: string }).turnId;
}

describe("muse driver: Muse's protocol", () => {
  test("createThread is session/start with the driver's session id, the canonical workspace root, the policy's approval mode and profile, and the host's per-thread tool server", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const [started] = rig.requests("session/start");
      assert.ok(started !== undefined);
      assert.equal(thread.native.id, started["sessionId"]);
      assert.equal(thread.id, threadIdFor(started["sessionId"] as string));
      assert.equal(thread.handle, started["sessionId"]);
      assert.equal(started["workspaceRoot"], rig.cwd);
      assert.equal(started["approvalMode"], "promptUnmatched");
      assert.equal(started["permissionProfile"], ":ask-me");
      const mcpCall = rig.host.calls.find((call) => call.operation === "hostTools.mcpServerFor");
      assert.ok(mcpCall !== undefined && mcpCall.args[0] === thread.id, "the driver asks the host for the thread's tool server before session/start");
      assert.deepEqual(Object.keys((started["config"] as { mcpServers: object }).mcpServers), [`host-tools-${thread.id}`]);
      assert.deepEqual(rig.world.launches.at(-1)?.args, ["serve"]);
      assert.equal(rig.world.launches.at(-1)?.cwd, rig.cwd);
      assert.equal(rig.world.inspect(thread.native.id!)?.loaded, true);

      // full_access selects allowAll and :unrestricted, and runs that thread's host without Muse's sandbox.
      const free = await opened.session.createThread({ cwd: rig.otherCwd, policy: policy(rig.otherCwd, "full_access") });
      const second = rig.requests("session/start").at(-1)!;
      assert.equal(second["approvalMode"], "allowAll");
      assert.equal(second["permissionProfile"], ":unrestricted");
      assert.deepEqual(rig.world.launches.at(-1)?.args, ["serve", "--disable-sandbox"]);
      // One host per thread.
      assert.equal(rig.world.hosts.filter((host) => !host.process.exited).length, 2);
      assert.notEqual(free.native.id, thread.native.id);
      // A mode Muse has no match for is refused before anything starts.
      await assert.rejects(opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd, "auto_accept_edits") }), (error) => isAriError(error, "unsupported") && error.callError.code === "unsupported" && error.callError.capability === "runtimePolicy.modes.auto_accept_edits");
    } finally {
      await rig.cleanup();
    }
  });

  test("startTurn is turn/start whose commandId is the turn id; intent steer is turn/steer naming the running turn; a late steer returns prompt_required", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const { result, native } = await start(rig, opened.session, thread, "Build it.");
      const turnId = turnIdOf(result);
      assert.equal(result.status === "accepted" && result.accepted, "started");
      const [sent] = rig.requests("turn/start");
      assert.equal(sent!["commandId"], native.turnId);
      assert.deepEqual(sent!["input"], [{ type: "text", text: "Build it." }]);
      assert.equal(opened.bodies("turn.upsert").find((body) => body.turn.id === turnId)?.turn.native?.id, native.turnId);

      const steering = native.nextSteer();
      const steered = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "steer-1", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "Also add tests." }] });
      assert.deepEqual(steered, { status: "accepted", turnId, accepted: "steered" });
      assert.equal(await steering, "Also add tests.");
      const [steer] = rig.requests("turn/steer");
      assert.equal(steer!["expectedTurnId"], native.turnId);
      assert.deepEqual(steer!["input"], [{ type: "text", text: "Also add tests." }]);
      // Muse's copy of the steer is a steered user message in the running turn.
      await until(() => opened.bodies("item.upsert").find((body) => body.item.kind === "user_message" && body.item.text === "Also add tests."), "the steered user message");

      await native.complete();
      await terminal(opened, turnId);
      const late = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "steer-2", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "Too late." }] });
      assert.deepEqual(late, { status: "prompt_required" });
      assert.equal(rig.requests("turn/steer").length, 1, "a steer the driver knows is late sends nothing");

      // A steer Muse refuses because its turn already ended (`already_terminal`) is prompt_required too.
      const second = await start(rig, opened.session, thread, "Again.");
      const held = await second.native.completeHeld();
      const raced = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "steer-3", intent: "steer", expectedTurnId: turnIdOf(second.result), content: [{ type: "text", text: "Race." }] });
      assert.deepEqual(raced, { status: "prompt_required" });
      assert.equal(rig.requests("turn/steer").length, 2, "the raced steer reached Muse, which refused it");
      await held.release();
      await terminal(opened, turnIdOf(second.result));
    } finally {
      await rig.cleanup();
    }
  });

  test("a steer the busy session runtime refuses (runtime_busy, retryable) goes out again under its commandId until Muse takes it, or is prompt_required once the turn ends; any other refusal is an error, not prompt_required", async () => {
    const busy = { reason: "runtime_busy", retryable: true };
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const { result, native } = await start(rig, opened.session, thread, "Build it.");
      const turnId = turnIdOf(result);

      // Busy twice, then taken: one steer, sent three times under one commandId, reaches the turn once.
      let refusals = 0;
      rig.world.refuseSteer = () => (++refusals <= 2 ? busy : undefined);
      const steering = native.nextSteer();
      const steered = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "busy-1", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "Also add tests." }] });
      assert.deepEqual(steered, { status: "accepted", turnId, accepted: "steered" });
      assert.equal(await steering, "Also add tests.");
      const sent = rig.requests("turn/steer");
      assert.equal(sent.length, 3);
      assert.equal(new Set(sent.map((steer) => steer["commandId"])).size, 1, "every resend carries the first commandId");
      assert.equal(opened.bodies("item.upsert").filter((body) => body.item.kind === "user_message" && body.item.text === "Also add tests.").length, 1);

      // Another refusal is surfaced as Muse gave it; the turn still runs, so it is not prompt_required.
      rig.world.refuseSteer = () => ({ reason: "input_rejected", retryable: false });
      await assert.rejects(
        opened.session.startTurn({ threadId: thread.id, clientTurnKey: "busy-2", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "Refused." }] }),
        (error) => isAriError(error, "invalid_state") && error.callError.code === "invalid_state" && error.callError.reason === "input_rejected",
      );
      assert.equal(rig.requests("turn/steer").length, 4, "a refusal that is not runtime_busy is not resent");

      // Busy until the turn ends: the steer was never taken, so the host must prompt again.
      rig.world.refuseSteer = () => busy;
      const before = rig.requests("turn/steer").length;
      const waiting = opened.session.startTurn({ threadId: thread.id, clientTurnKey: "busy-3", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "Never taken." }] });
      await until(() => (rig.requests("turn/steer").length >= before + 2 ? true : undefined), "two busy refusals of the steer");
      await native.complete();
      assert.deepEqual(await waiting, { status: "prompt_required" });
      await terminal(opened, turnId);
      assert.equal(opened.bodies("item.upsert").some((body) => body.item.kind === "user_message" && body.item.text === "Never taken."), false);
    } finally {
      rig.world.refuseSteer = undefined;
      await rig.cleanup();
    }
  });

  test("a steer whose resend Muse never answers settles when the turn ends: prompt_required; a reply that later says Muse took it becomes a notice, not a second answer", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const { result, native } = await start(rig, opened.session, thread, "Build it.");
      const turnId = turnIdOf(result);
      // Busy once; Muse takes the resend, but its answer (and the steered message after it) does not come.
      let steers = 0;
      rig.world.stall = (method) => (method === "turn/steer" && ++steers === 2 ? "reply" : undefined);
      rig.world.refuseSteer = () => (steers === 1 ? { reason: "runtime_busy", retryable: true } : undefined);
      const steering = opened.session.startTurn({ threadId: thread.id, clientTurnKey: "stalled-1", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "Late." }] });
      const answered = watch(steering);
      await until(() => (rig.requests("turn/steer").length === 2 ? true : undefined), "the resend of the busy steer");
      await native.complete();
      await terminal(opened, turnId);
      assert.deepEqual(await within(steering, 1000), { value: { status: "prompt_required" } }, "the turn's end settles the steer");

      // The held answer arrives: Muse took the steer after all. That is a notice on the turn; the call keeps its one answer.
      rig.world.releaseStalled();
      const notice = await until(() => opened.bodies("notice").find((body) => body.code === "muse.steer_taken_late"), "the notice for the late steer");
      assert.equal(notice.level, "warning");
      assert.match(notice.text, new RegExp(turnId));
      const noticeEvent = opened.events.find((event) => event.body === notice);
      assert.equal(noticeEvent?.turnId, turnId);
      await until(() => opened.bodies("item.upsert").find((body) => body.item.kind === "user_message" && body.item.text === "Late."), "Muse's steered message");
      assert.deepEqual(answered(), { value: { status: "prompt_required" } });
      assert.equal(opened.bodies("notice").filter((body) => body.code === "muse.steer_taken_late").length, 1);
    } finally {
      rig.world.stall = undefined;
      rig.world.refuseSteer = undefined;
      await rig.cleanup();
    }
  });

  test("a steer the session runtime refuses as busy for 30 s while the turn keeps running settles at that limit with invalid_state runtime_busy", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const { result, native } = await start(rig, opened.session, thread, "Build it.");
      const turnId = turnIdOf(result);
      rig.world.refuseSteer = () => ({ reason: "runtime_busy", retryable: true });
      // Virtual time from here: the driver's backoff and limit timers are the clock's.
      const clock = new VirtualClock();
      clock.install();
      const steered = watch(opened.session.startTurn({ threadId: thread.id, clientTurnKey: "busy-forever", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "Never taken." }] }));
      try {
        await clock.pass(29_000, 100);
        assert.equal(steered(), undefined, "29 s in, the driver still sends the steer again");
        assert.ok(rig.requests("turn/steer").length >= 10, `the steer went out ${rig.requests("turn/steer").length} times`);
        await clock.pass(2_000, 100);
      } finally {
        clock.uninstall();
      }
      const outcome = steered();
      assert.ok(outcome !== undefined && "error" in outcome, "the steer settled at the limit with an error");
      assert.ok(isAriError(outcome.error, "invalid_state") && outcome.error.callError.code === "invalid_state" && outcome.error.callError.reason === "runtime_busy");
      // The turn still runs, and ends normally.
      rig.world.refuseSteer = undefined;
      await native.complete();
      assert.equal((await terminal(opened, turnId)).status, "completed");
    } finally {
      rig.world.refuseSteer = undefined;
      await rig.cleanup();
    }
  });

  test("respond answers an approval with approval/decide: Muse's choiceId and the current requirement; each choice keeps its decision and real reach", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const { result, native } = await start(rig, opened.session, thread, "Run the tests.");
      const turnId = turnIdOf(result);
      const handle = await native.requestApproval({
        kind: "command",
        command: ["npm", "test"],
        options: [
          { optionId: "allow_once", label: "Allow once", decision: "accept" },
          { optionId: "allow_session", label: "Allow for this session", decision: "accept_for_session" },
          { optionId: "allow_prefix", label: "Always allow npm test", decision: "accept_always" },
          { optionId: "deny", label: "Deny", decision: "decline" },
        ],
      });
      const request = await until(() => opened.bodies("request.upsert").find((body) => body.request.kind === "command")?.request, "the approval request");
      assert.equal(request.origin?.turnId, turnId);
      assert.deepEqual(request.subject?.command, ["npm test"]);
      assert.deepEqual(
        request.options?.map((option) => [option.optionId, option.decision, option.scope]),
        [
          ["allow_once", "accept", "once"],
          ["allow_session", "accept_for_session", "session"],
          ["allow_prefix", "accept_always", "project"],
          ["deny", "decline", "once"],
        ],
      );
      assert.equal(request.response?.mode, "live");
      assert.equal(request.allowFeedback, true);
      // The approval arrived both as approval/requested and as the approval/request server request; it is one request.
      assert.equal(opened.bodies("request.upsert").filter((body) => body.request.id === request.id && body.request.status === "pending").length, 1);

      await opened.session.respond({ requestId: request.id!, responseKey: "r1", optionId: "allow_prefix" });
      assert.equal(await handle.nextReply(), "allow_prefix");
      const [decide] = rig.requests("approval/decide");
      assert.equal(decide!["choiceId"], "allow_prefix");
      assert.deepEqual(decide!["requirementId"], { approvalId: request.native!.id, sourceIndex: 0 });
      await until(() => opened.bodies("request.upsert").find((body) => body.request.id === request.id && body.request.status === "resolved"), "the request to resolve");
      // An answer to a resolved request is refused; the same key gets the first outcome.
      await assert.rejects(opened.session.respond({ requestId: request.id!, responseKey: "r2", optionId: "deny" }), (error) => isAriError(error, "invalid_state"));
      await opened.session.respond({ requestId: request.id!, responseKey: "r1", optionId: "allow_prefix" });
      assert.equal(rig.requests("approval/decide").length, 1);
      await native.complete();
      await terminal(opened, turnId);
    } finally {
      await rig.cleanup();
    }
  });

  test("respond answers a question with userInput/answer: a single label, several labels, free text", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const { result, native } = await start(rig, opened.session, thread, "Plan the service.");
      const asked = await native.askQuestions([
        { id: "db", header: "Database", question: "Which database?", options: [{ label: "Postgres", description: "Matches the rest." }, { label: "SQLite" }], selection: { mode: "single" } },
        { id: "envs", header: "Envs", question: "Which environments?", options: [{ label: "dev" }, { label: "prod" }, { label: "test" }], selection: { mode: "multiple", minSelections: 1 } },
        { id: "name", header: "Name", question: "What is it called?", options: [{ label: "api" }, { label: "svc" }], selection: { mode: "single" } },
      ]);
      const request = await until(() => opened.bodies("request.upsert").find((body) => body.request.kind === "user_input")?.request, "the question request");
      assert.equal(request.origin?.turnId, turnIdOf(result));
      assert.deepEqual(
        request.questions?.map((question) => [question.id, question.type, question.prompt, question.options?.map((option) => option.id)]),
        [
          ["db", "single_select", "Which database?", ["Postgres", "SQLite"]],
          ["envs", "multi_select", "Which environments?", ["dev", "prod", "test"]],
          ["name", "single_select", "What is it called?", ["api", "svc"]],
        ],
      );
      await opened.session.respond({ requestId: request.id!, responseKey: "a1", answers: { db: { optionIds: ["Postgres"] }, envs: { optionIds: ["dev", "prod"] }, name: { text: "billing" } } });
      assert.deepEqual(await asked.answers(), [
        { questionId: "db", selectedLabel: "Postgres" },
        { questionId: "envs", selectedLabels: ["dev", "prod"] },
        { questionId: "name", freeText: "billing" },
      ]);
      assert.equal(rig.requests("userInput/answer")[0]!["userInputId"], request.native!.id);
      await until(() => opened.bodies("request.upsert").find((body) => body.request.id === request.id && body.request.status === "resolved"), "the question to resolve");
      // A custom answer (requests.allowCustomAnswer) is free text for each question left unanswered.
      const second = await native.askQuestions([{ id: "why", header: "Why", question: "Why Postgres?", options: [{ label: "Speed" }, { label: "Habit" }], selection: { mode: "single" } }]);
      const followUp = await until(() => opened.bodies("request.upsert").find((body) => body.request.kind === "user_input" && body.request.id !== request.id)?.request, "the second question");
      assert.equal(followUp.allowCustomAnswer, true);
      await opened.session.respond({ requestId: followUp.id!, responseKey: "a2", custom: "It matches the other services." });
      assert.deepEqual(await second.answers(), [{ questionId: "why", freeText: "It matches the other services." }]);
      await native.complete();
      await terminal(opened, turnIdOf(result));
    } finally {
      await rig.cleanup();
    }
  });

  test("approval subjects: a shell command is a command request, a file read is file_read, a write is file_change, a network host is permission", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const { result, native } = await start(rig, opened.session, thread, "Look around.");
      const options = [
        { optionId: "yes", label: "Allow once", decision: "accept" as const },
        { optionId: "no", label: "Deny", decision: "decline" as const },
      ];
      const asked = [
        { want: "command", handle: await native.approvalFor({ toolName: "shell", args: { command: "ls" }, subject: { kind: "shell", command: "ls", stages: [] }, options }) },
        { want: "file_read", handle: await native.approvalFor({ toolName: "read_file", args: { path: "secrets.env" }, subject: { kind: "fileAccess", toolName: "read_file", path: "secrets.env", access: "read" }, options }) },
        { want: "file_change", handle: await native.approvalFor({ toolName: "write_file", args: { path: "a.txt" }, subject: { kind: "fileAccess", toolName: "write_file", path: "a.txt", access: "write" }, options }) },
        { want: "permission", handle: await native.approvalFor({ toolName: "web_fetch", args: { url: "https://example.com" }, subject: { kind: "network", toolName: "web_fetch", host: "example.com", port: 443, protocol: "https" }, options }) },
      ];
      const requests = await until(() => {
        const found = opened.bodies("request.upsert").filter((body) => body.request.status === "pending");
        return found.length === 4 ? found.map((body) => body.request) : undefined;
      }, "four approvals");
      assert.deepEqual(requests.map((request) => request.kind), asked.map((entry) => entry.want));
      assert.deepEqual(requests[1]!.subject?.paths, [`${rig.cwd}/secrets.env`]);
      assert.equal(requests[3]!.subject?.tool?.name, "web_fetch");
      for (const [index, request] of requests.entries()) {
        await opened.session.respond({ requestId: request.id!, responseKey: `k${index}`, optionId: index % 2 === 0 ? "yes" : "no" });
        assert.equal(await asked[index]!.handle.nextReply(), index % 2 === 0 ? "yes" : "no");
      }
      await native.complete();
      await terminal(opened, turnIdOf(result));
    } finally {
      await rig.cleanup();
    }
  });

  test("streaming: assistant text, reasoning summary and tool output reach item.delta on text, reasoning and output", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const { result, native } = await start(rig, opened.session, thread, "Think, then run.");
      await native.think("Checking the tests first.");
      await native.runTool({ name: "shell", input: { command: "npm test" }, output: "3 passing" });
      await native.say("All good.");
      await native.complete();
      await terminal(opened, turnIdOf(result));
      const deltas = opened.bodies("item.delta").map((body) => [body.field, body.chunk]);
      assert.deepEqual(deltas, [
        ["reasoning", "Checking the tests first."],
        ["output", "3 passing"],
        ["text", "All g"],
        ["text", "ood."],
      ]);
      const items = new Map(opened.bodies("item.upsert").filter((body) => body.item.kind !== undefined).map((body) => [body.item.id, body.item.kind]));
      assert.deepEqual([...items.values()], ["user_message", "reasoning", "command_execution", "assistant_message"]);
      const command = opened.bodies("item.upsert").find((body) => body.item.kind === "command_execution")!.item;
      assert.deepEqual(command.command, ["npm test"]);
      assert.equal(command.cwd, rig.cwd);
    } finally {
      await rig.cleanup();
    }
  });

  test("forkThread and rollbackThread reject with unsupported, naming the capability", async () => {
    const rig = await museRig();
    try {
      assert.equal(MUSE_CAPABILITIES.threads.fork.supported, false);
      assert.equal(MUSE_CAPABILITIES.threads.rollback, false);
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      await assert.rejects(opened.session.forkThread!({ threadId: thread.id, at: { type: "latest" } }), (error) => isAriError(error, "unsupported") && error.callError.code === "unsupported" && error.callError.capability === "threads.fork");
      await assert.rejects(opened.session.rollbackThread!({ threadId: thread.id, to: { type: "start" } }), (error) => isAriError(error, "unsupported") && error.callError.code === "unsupported" && error.callError.capability === "threads.rollback");
      assert.equal(rig.world.requests.filter((request) => request.method === "session/fork").length, 0);
    } finally {
      await rig.cleanup();
    }
  });

  test("usage: each model call and the turn's total are usage.updated, context occupancy is thread usage, subscription usage is limits", async () => {
    const usage = { observedAtMs: Date.parse("2026-11-23T10:00:00Z"), tier: "pro", window: { usedPercent: 120, windowDurationMins: 300, resetsAtMs: Date.parse("2026-11-23T15:00:00Z") }, weekly: { usedPercent: 40, resetsAtMs: Date.parse("2026-11-30T00:00:00Z") } };
    const rig = await museRig({ fake: { subscriptionUsage: usage } });
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const { result, native } = await start(rig, opened.session, thread, "Count tokens.");
      const turnId = turnIdOf(result);
      await native.modelCall({ inputTokens: 100, outputTokens: 20, cachedTokens: 30, reasoningTokens: 4 });
      await native.modelCall({ inputTokens: 50, outputTokens: 10, cachedTokens: 0, reasoningTokens: 1 });
      await native.contextUsage(4000, 200000);
      await native.subscriptionUsage(usage);
      await native.complete();
      await terminal(opened, turnId);
      const turnUsage = opened.events.filter((event) => event.body.type === "usage.updated" && event.turnId === turnId).map((event) => (event.body as { usage: { inputTokens?: number; outputTokens?: number; scope?: string } }).usage);
      assert.deepEqual(turnUsage.map((entry) => [entry.scope, entry.inputTokens, entry.outputTokens]), [
        ["turn", 100, 20],
        ["turn", 150, 30],
        ["turn", 150, 30],
      ]);
      assert.deepEqual(opened.bodies("usage.updated").find((body) => body.usage.scope === "thread")?.usage, { scope: "thread", contextUsedTokens: 4000, contextMaxTokens: 200000, model: "muse-large-2" });
      const settled = opened.bodies("turn.upsert").find((body) => body.turn.id === turnId && body.turn.status === "completed");
      assert.equal(settled?.turn.usage?.outputTokens, 30);
      const limits = opened.bodies("limits.updated")[0]?.limits;
      assert.deepEqual(limits, {
        windows: [
          { window: "5h", utilization: 1, resetsAt: "2026-11-23T15:00:00.000Z" },
          { window: "weekly", utilization: 0.4, resetsAt: "2026-11-30T00:00:00.000Z" },
        ],
        limited: true,
        resetsAt: "2026-11-23T15:00:00.000Z",
      });
      assert.deepEqual(await rig.instance.limits!.current(), limits);
      assert.equal(rig.requests("usage/read").length, 1);
    } finally {
      await rig.cleanup();
    }
  });

  test("a queued turn: turn/start with ifBusy queue answers with the turn's own id; it is pending until Muse starts it; Stop on it is turn/unqueue", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const first = await start(rig, opened.session, thread, "First.");
      const queued = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "q1", intent: "queue", content: [{ type: "text", text: "Queued." }] });
      assert.equal(queued.status === "accepted" && queued.accepted, "queued");
      const queuedId = turnIdOf(queued);
      assert.equal(rig.requests("turn/start").at(-1)!["ifBusy"], "queue");
      await until(() => opened.bodies("turn.upsert").find((body) => body.turn.id === queuedId && body.turn.status === "pending"), "the queued turn to be pending");
      await first.native.complete();
      await terminal(opened, turnIdOf(first.result));
      const second = await rig.nextTurn();
      assert.equal(second.prompt, "Queued.");
      await until(() => opened.bodies("turn.upsert").find((body) => body.turn.id === queuedId && body.turn.status === "running"), "the queued turn to run");
      // A third queued behind the second, then taken back.
      const third = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "q2", intent: "queue", content: [{ type: "text", text: "Never mind." }] });
      await opened.session.interruptTurn({ turnId: turnIdOf(third) });
      assert.equal(rig.requests("turn/unqueue")[0]!["turnId"], rig.requests("turn/start").at(-1)!["commandId"]);
      assert.equal((await terminal(opened, turnIdOf(third))).status, "interrupted");
      await second.complete();
      await terminal(opened, queuedId);
      // A start while a turn runs is refused; Muse would queue it, but the host asked to start.
      const fourth = await start(rig, opened.session, thread, "Fourth.");
      await assert.rejects(opened.session.startTurn({ threadId: thread.id, clientTurnKey: "s5", intent: "start", content: [{ type: "text", text: "Fifth." }] }), (error) => isAriError(error, "invalid_state"));
      await fourth.native.complete();
    } finally {
      await rig.cleanup();
    }
  });

  test("Stop on a queued turn the busy session runtime will not unqueue (runtime_busy) sends turn/unqueue again under its commandId until Muse takes it, or turn/interrupt once Muse starts the turn", async () => {
    const busy = { reason: "runtime_busy", retryable: true };
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const first = await start(rig, opened.session, thread, "First.");

      // Busy twice, then taken back.
      let refusals = 0;
      rig.world.refuseUnqueue = () => (++refusals <= 2 ? busy : undefined);
      const taken = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "q1", intent: "queue", content: [{ type: "text", text: "Never mind." }] });
      await opened.session.interruptTurn({ turnId: turnIdOf(taken) });
      const unqueues = rig.requests("turn/unqueue");
      assert.equal(unqueues.length, 3);
      assert.equal(new Set(unqueues.map((unqueue) => unqueue["commandId"])).size, 1, "every resend carries the first commandId");
      assert.equal((await terminal(opened, turnIdOf(taken))).status, "interrupted");

      // Busy until Muse starts the queued turn: then Stop is turn/interrupt on it.
      rig.world.refuseUnqueue = () => busy;
      const late = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "q2", intent: "queue", content: [{ type: "text", text: "Too late to take back." }] });
      const stopping = opened.session.interruptTurn({ turnId: turnIdOf(late) });
      await until(() => (rig.requests("turn/unqueue").length >= 5 ? true : undefined), "two busy refusals of the unqueue");
      await first.native.complete();
      const launched = await rig.nextTurn();
      assert.equal(launched.prompt, "Too late to take back.");
      assert.equal(await launched.stopRequested(), "cancel");
      await launched.finishCancelled();
      await stopping;
      assert.equal(rig.requests("turn/interrupt").at(-1)?.["turnId"], launched.turnId);
      assert.equal((await terminal(opened, turnIdOf(late))).status, "interrupted");
    } finally {
      rig.world.refuseUnqueue = undefined;
      await rig.cleanup();
    }
  });

  test("Stop on a queued turn whose unqueue resend Muse never answers settles when the turn ends", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const first = await start(rig, opened.session, thread, "First.");
      const queued = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "q1", intent: "queue", content: [{ type: "text", text: "Queued." }] });
      const queuedId = turnIdOf(queued);
      // Busy once; the resend stalls unread, so Muse still has the turn queued.
      let unqueues = 0;
      rig.world.stall = (method) => (method === "turn/unqueue" && ++unqueues === 2 ? "request" : undefined);
      rig.world.refuseUnqueue = () => (unqueues === 1 ? { reason: "runtime_busy", retryable: true } : undefined);
      const stopping = opened.session.interruptTurn({ turnId: queuedId });
      await until(() => (rig.requests("turn/unqueue").length === 2 ? true : undefined), "the resend of the busy unqueue");
      await first.native.complete();
      const launched = await rig.nextTurn();
      await launched.complete();
      await terminal(opened, queuedId);
      assert.deepEqual(await within(stopping, 1000), { value: undefined }, "the turn's end settles Stop");
      rig.world.releaseStalled();
    } finally {
      rig.world.stall = undefined;
      rig.world.refuseUnqueue = undefined;
      await rig.cleanup();
    }
  });

  test("Stop on a queued turn the session runtime refuses to unqueue as busy for 30 s settles at that limit with invalid_state runtime_busy; the turn stays queued", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const first = await start(rig, opened.session, thread, "First.");
      const queued = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "q1", intent: "queue", content: [{ type: "text", text: "Queued." }] });
      const queuedId = turnIdOf(queued);
      rig.world.refuseUnqueue = () => ({ reason: "runtime_busy", retryable: true });
      // Virtual time from here: the driver's backoff and limit timers are the clock's.
      const clock = new VirtualClock();
      clock.install();
      const stopped = watch(opened.session.interruptTurn({ turnId: queuedId }));
      try {
        await clock.pass(29_000, 100);
        assert.equal(stopped(), undefined, "29 s in, the driver still sends the unqueue again");
        assert.ok(rig.requests("turn/unqueue").length >= 10, `the unqueue went out ${rig.requests("turn/unqueue").length} times`);
        await clock.pass(2_000, 100);
      } finally {
        clock.uninstall();
      }
      const outcome = stopped();
      assert.ok(outcome !== undefined && "error" in outcome, "Stop settled at the limit with an error");
      assert.ok(isAriError(outcome.error, "invalid_state") && outcome.error.callError.code === "invalid_state" && outcome.error.callError.reason === "runtime_busy");
      assert.equal(opened.bodies("turn.terminal").some((body) => body.turnId === queuedId), false, "the queued turn did not end");
      // Once the runtime takes it, Stop works.
      rig.world.refuseUnqueue = undefined;
      await opened.session.interruptTurn({ turnId: queuedId });
      assert.equal((await terminal(opened, queuedId)).status, "interrupted");
      await first.native.complete();
    } finally {
      rig.world.refuseUnqueue = undefined;
      await rig.cleanup();
    }
  });

  test("subagents and their approvals, and the todo list: subagent.upsert with a subagent_spawn item, a subagent's approval with origin.subagentId and no turn, plan.upsert", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const { result, native } = await start(rig, opened.session, thread, "Review the code.");
      const turnId = turnIdOf(result);
      const child = await native.subagent({ role: "reviewer", objective: "Review src/" });
      const running = await until(() => opened.bodies("subagent.upsert").find((body) => body.subagent.status === "running")?.subagent, "the subagent");
      assert.equal(running.parentThreadId, thread.id);
      assert.equal(running.parentTurnId, turnId);
      assert.equal(running.name, "reviewer");
      assert.equal(running.prompt, "Review src/");
      assert.equal(running.native?.id, child.subagentId);
      const spawnItem = opened.bodies("item.upsert").find((body) => body.item.kind === "subagent_spawn")?.item;
      assert.equal(spawnItem?.subagentId, running.id);
      assert.equal(running.parentItemId, spawnItem?.id);

      const approval = await native.subagentApproval(child.subagentId, { kind: "command", command: ["rm", "-rf", "build"], options: [{ optionId: "ok", label: "Allow", decision: "accept" }, { optionId: "no", label: "Deny", decision: "decline" }] });
      const request = await until(() => opened.bodies("request.upsert").find((body) => body.request.origin?.subagentId !== undefined)?.request, "the subagent's approval");
      assert.equal(request.origin?.subagentId, running.id);
      assert.equal(request.origin?.turnId, undefined);
      await opened.session.respond({ requestId: request.id!, responseKey: "k", optionId: "no" });
      assert.equal(await approval.nextReply(), "no");

      await child.finish("Looks good.");
      const done = await until(() => opened.bodies("subagent.upsert").find((body) => body.subagent.id === running.id && body.subagent.status === "completed")?.subagent, "the subagent to finish");
      assert.equal(done.outcome?.summary, "Looks good.");

      await native.todoList([
        { text: "Read the code", status: "completed" },
        { text: "Write the review", status: "inProgress" },
      ]);
      const plan = await until(() => opened.bodies("plan.upsert")[0]?.plan, "the plan");
      assert.equal(plan.threadId, thread.id);
      assert.equal(plan.turnId, turnId);
      assert.deepEqual(plan.entries, [
        { text: "Read the code", status: "completed" },
        { text: "Write the review", status: "in_progress" },
      ]);
      await native.complete();
      await terminal(opened, turnId);
    } finally {
      await rig.cleanup();
    }
  });

  test("a host that dies fails its turn with transport_error, and the next turn loads the session again on a new host with session/resume", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const { result, native } = await start(rig, opened.session, thread, "Crash.");
      await native.exitProcess();
      const ended = await terminal(opened, turnIdOf(result));
      assert.equal(ended.status, "failed");
      assert.equal(ended.failure?.class, "transport_error");
      assert.equal(ended.threadDisposition, "reusable");
      const again = await start(rig, opened.session, thread, "Again.");
      assert.equal(rig.world.hosts.length, 2);
      const [resumed] = rig.requests("session/resume");
      assert.equal(resumed!["sessionId"], thread.native.id);
      assert.equal(resumed!["excludeItems"], true);
      assert.deepEqual(Object.keys((resumed!["config"] as { mcpServers: object }).mcpServers), [`host-tools-${thread.id}`]);
      assert.equal(rig.requests("session/setApprovalMode")[0]!["mode"], "promptUnmatched");
      await again.native.complete();
      await terminal(opened, turnIdOf(again.result));
      assert.deepEqual(rig.world.inspect(thread.native.id!)?.prompts, ["Crash.", "Again."]);
    } finally {
      await rig.cleanup();
    }
  });

  test("a history resume reads the stored session with session/read: no session/resume, no lease, no session/start; the thread stays unloaded and a missing session is not_found", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const first = await start(rig, opened.session, thread, "Remember 7.");
      await first.native.complete();
      await terminal(opened, turnIdOf(first.result));
      await opened.session.close();

      const reader = await rig.open();
      const resumes = rig.requests("session/resume").length;
      const starts = rig.requests("session/start").length;
      const read = await reader.session.resumeThread({ native: thread.native, policy: policy(rig.cwd), purpose: "history" });
      assert.equal(read.id, thread.id);
      assert.equal(read.status, "unloaded");
      assert.equal(rig.requests("session/resume").length, resumes, "a history read never loads the session");
      assert.equal(rig.world.inspect(thread.native.id!)?.loaded, false, "no host holds the session's lease");
      const snapshot = await reader.session.readSnapshot!(read.id);
      assert.equal(snapshot.turns.length, 1);
      await assert.rejects(reader.session.startTurn({ threadId: read.id, clientTurnKey: "x", intent: "start", content: [{ type: "text", text: "x" }] }), (error) => isAriError(error, "invalid_state"));

      await assert.rejects(reader.session.resumeThread({ native: { handle: "muse-missing-session" }, policy: policy(rig.cwd), purpose: "history" }), (error) => isAriError(error, "not_found"));
      assert.equal(rig.requests("session/start").length, starts, "no session was started");
      assert.equal(reader.bodies("session.replaced").length, 0);
    } finally {
      await rig.cleanup();
    }
  });

  test("a resume of a loaded thread applies a new model with session/setModel and refuses a runtime mode Muse cannot switch in a session", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const models = rig.requests("session/setModel").length;
      const resumed = await opened.session.resumeThread({ native: thread.native, config: { model: "muse-small-1" } });
      assert.equal(resumed.id, thread.id);
      assert.equal(rig.requests("session/setModel").length, models + 1, "the new model reached Muse");
      assert.equal(resumed.appliedConfig?.["model"], "muse-small-1");
      await assert.rejects(opened.session.resumeThread({ native: thread.native, policy: policy(rig.cwd, "full_access") }), (error) => isAriError(error, "unsupported"));
    } finally {
      await rig.cleanup();
    }
  });

  test("unloadThread drains the thread's host and releases its lease; resumeThread loads it again; release parks every host and the next turn resumes", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const first = await start(rig, opened.session, thread, "Remember 7.");
      await first.native.complete();
      await terminal(opened, turnIdOf(first.result));
      await opened.session.unloadThread!(thread.id);
      assert.equal(rig.world.inspect(thread.native.id!)?.loaded, false);
      await until(() => opened.bodies("thread.upsert").find((body) => body.thread.id === thread.id && body.thread.status === "unloaded"), "the thread to be unloaded");
      await assert.rejects(opened.session.startTurn({ threadId: thread.id, clientTurnKey: "x", intent: "start", content: [{ type: "text", text: "x" }] }), (error) => isAriError(error, "invalid_state"));
      const resumed = await opened.session.resumeThread({ native: thread.native, policy: policy(rig.cwd) });
      assert.equal(resumed.id, thread.id);
      assert.equal(rig.world.inspect(thread.native.id!)?.loaded, true);
      await until(() => opened.bodies("thread.upsert").filter((body) => body.thread.id === thread.id).at(-1)?.thread.status === "idle" || undefined, "the thread to be idle again");
      await opened.session.unloadThread!(thread.id);

      // A fresh session resumes the stored session and replays its history as settled turns.
      const fresh = await rig.open();
      const again = await fresh.session.resumeThread({ native: thread.native, policy: policy(rig.cwd) });
      assert.equal(again.id, thread.id);
      const replayed = await until(() => fresh.bodies("turn.upsert").find((body) => body.turn.native?.id === first.native.turnId)?.turn, "the replayed turn");
      assert.equal(replayed.id, turnIdOf(first.result));
      assert.equal(replayed.status, "completed");
      await until(() => fresh.bodies("item.upsert").find((body) => body.item.kind === "user_message" && body.item.text === "Remember 7."), "the replayed prompt");

      assert.equal(fresh.session.canRelease(), true);
      await fresh.session.release();
      assert.equal(rig.world.inspect(thread.native.id!)?.loaded, false);
      const after = await start(rig, fresh.session, thread, "What was the number?");
      assert.equal(rig.world.inspect(thread.native.id!)?.loaded, true);
      assert.equal(fresh.session.canRelease(), false);
      await after.native.complete();
      await terminal(fresh, turnIdOf(after.result));
      assert.deepEqual(rig.world.inspect(thread.native.id!)?.prompts, ["Remember 7.", "What was the number?"]);
    } finally {
      await rig.cleanup();
    }
  });

  test("a resumed session's outstanding question and approval come again as server requests right after session/resume; the driver adopts each on the running turn, answers it, and sees the turn end", async () => {
    const rig = await museRig();
    try {
      // The question, resumed without history (excludeItems), as the pinned userinput-answer-round-trip transcript resumes it.
      const asked = rig.world.parkedSession({ workspaceRoot: rig.cwd, prompt: "Choose the database for the new service", waitsOn: "question" });
      const opened = await rig.open();
      const thread = await opened.session.resumeThread({ native: { handle: asked.sessionId }, policy: policy(rig.cwd), quiet: true });
      const turnId = turnIdFor(thread.id, asked.turnId);
      const running = await until(() => opened.bodies("turn.upsert").find((body) => body.turn.id === turnId)?.turn, "the resumed running turn");
      assert.equal(running.status, "running");
      const question = await until(() => opened.bodies("request.upsert").find((body) => body.request.kind === "user_input")?.request, "the re-issued question");
      assert.equal(question.origin?.turnId, turnId);
      assert.deepEqual(question.questions?.map((entry) => entry.id), ["db_choice"]);
      assert.equal(opened.session.canRelease(), false, "a resumed turn that waits on the host keeps the session");
      const native = await rig.nextTurn();
      assert.equal(native.turnId, asked.turnId);
      await opened.session.respond({ requestId: question.id, responseKey: "db-1", answers: { db_choice: { optionIds: ["Postgres"] } } });
      assert.deepEqual(await asked.answers(), [{ questionId: "db_choice", selectedLabel: "Postgres" }]);
      await native.complete();
      assert.equal((await terminal(opened, turnId)).status, "completed");
      assert.equal(opened.bodies("request.upsert").filter((body) => body.request.id === question.id).at(-1)?.request.status, "resolved");

      // The approval, resumed with its history replayed, as the SDK README describes.
      const approval = rig.world.parkedSession({ workspaceRoot: rig.cwd, prompt: "Run the tests.", waitsOn: "approval" });
      const other = await opened.session.resumeThread({ native: { handle: approval.sessionId }, policy: policy(rig.cwd) });
      const approvalTurn = turnIdFor(other.id, approval.turnId);
      const asking = await until(() => opened.bodies("request.upsert").find((body) => body.request.kind === "command")?.request, "the re-issued approval");
      assert.equal(asking.origin?.turnId, approvalTurn);
      assert.deepEqual(asking.options?.map((option) => option.optionId), ["allow_once", "deny"]);
      const approvalNative = await rig.nextTurn();
      await opened.session.respond({ requestId: asking.id, responseKey: "ok-1", optionId: "allow_once" });
      assert.equal(await approval.nextReply(), "allow_once");
      await approvalNative.complete();
      assert.equal((await terminal(opened, approvalTurn)).status, "completed");
    } finally {
      await rig.cleanup();
    }
  });

  test("a failed turn is failed, with its failure, in readSnapshot and in a resume's replay: from what the session saw, and in a fresh session from Muse's lastTurn", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const first = await start(rig, opened.session, thread, "Fail first.");
      await first.native.say("Trying.");
      await first.native.fail({ kind: "provider_error", message: "Upstream model unavailable" });
      await terminal(opened, turnIdOf(first.result));
      const second = await start(rig, opened.session, thread, "Then work.");
      await second.native.say("Done.");
      await second.native.complete();
      await terminal(opened, turnIdOf(second.result));
      const third = await start(rig, opened.session, thread, "Fail last.");
      await third.native.say("Trying again.");
      await third.native.fail({ kind: "provider_error", message: "Upstream model down" });
      await terminal(opened, turnIdOf(third.result));
      const lastId = turnIdOf(third.result);

      const snapshot = await opened.session.readSnapshot!(thread.id);
      assert.deepEqual(
        snapshot.turns.map((turn) => [turn.id, turn.status]),
        [
          [turnIdOf(first.result), "failed"],
          [turnIdOf(second.result), "completed"],
          [lastId, "failed"],
        ],
      );
      assert.equal(snapshot.turns[0]?.failure?.message, "Upstream model unavailable");
      assert.equal(snapshot.turns[2]?.failure?.class, "provider_error");
      assert.equal(snapshot.turns[2]?.failure?.message, "Upstream model down");

      // A fresh session knows what Muse restates: the last turn's terminal.
      await opened.session.unloadThread!(thread.id);
      const fresh = await rig.open();
      const again = await fresh.session.resumeThread({ native: thread.native, policy: policy(rig.cwd) });
      const replayed = await until(() => fresh.bodies("turn.upsert").find((body) => body.turn.id === lastId)?.turn, "the replayed last turn");
      assert.equal(replayed.status, "failed");
      assert.equal(replayed.failure?.message, "Upstream model down");
      const read = await fresh.session.readSnapshot!(again.id);
      assert.deepEqual(read.turns.at(-1)?.status, "failed");
      assert.equal(read.turns.at(-1)?.failure?.class, "provider_error");
      assert.equal(read.turns.at(-1)?.failure?.message, "Upstream model down");
    } finally {
      await rig.cleanup();
    }
  });

  test("readSnapshot is session/read with items, through a short-lived host when the thread is unloaded; compactThread is session/compact", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      // Nothing to compact yet: Muse answers noop.
      await assert.rejects(opened.session.compactThread!(thread.id), (error) => isAriError(error, "invalid_state"));
      const first = await start(rig, opened.session, thread, "Read README.md.");
      await first.native.runTool({ name: "read_file", input: { path: "README.md" }, output: "# Project" });
      await first.native.say("It is a project.");
      await first.native.complete();
      await terminal(opened, turnIdOf(first.result));
      const snapshot = await opened.session.readSnapshot!(thread.id);
      assert.deepEqual(snapshot.turns.map((turn) => [turn.id, turn.status]), [[turnIdOf(first.result), "completed"]]);
      assert.deepEqual(snapshot.items.map((item) => item.kind), ["user_message", "file_read", "assistant_message"]);
      assert.deepEqual(snapshot.items[1]?.paths, [`${rig.cwd}/README.md`]);
      assert.equal(snapshot.items[0]?.text, "Read README.md.");
      await opened.session.compactThread!(thread.id);
      assert.equal(rig.world.inspect(thread.native.id!)?.compactions, 1);
      await opened.session.unloadThread!(thread.id);
      const hosts = rig.world.hosts.length;
      const unloaded = await opened.session.readSnapshot!(thread.id);
      assert.equal(unloaded.items.length, snapshot.items.length + 1, "the compaction item is in the stored view");
      assert.equal(rig.world.hosts.length, hosts + 1);
      assert.equal(rig.world.hosts.at(-1)?.process.exited, true, "the borrowed host was closed");
      assert.equal(rig.world.inspect(thread.native.id!)?.loaded, false, "session/read takes no lease");
    } finally {
      await rig.cleanup();
    }
  });

  test("a model change is session/setModel before the next turn; planConfigChange plans apply_next_turn; the catalog is model/list", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      assert.deepEqual(await opened.session.planConfigChange({ threadId: thread.id, changes: { model: "muse-small-1" } }), { type: "apply_next_turn" });
      assert.equal((await opened.session.planConfigChange({ threadId: thread.id, changes: { sandbox: "off" } })).type, "reject");
      const turn = await start(rig, opened.session, thread, "Small model.", { config: { model: "muse-small-1", reasoningEffort: "low" } });
      const [setModel] = rig.requests("session/setModel");
      assert.deepEqual(setModel!["model"], { modelId: "muse-small-1" });
      assert.equal(rig.requests("turn/start").at(-1)!["reasoningEffort"], "low");
      assert.equal(rig.world.sessions.get(thread.native.id!)?.modelId, "muse-small-1");
      await turn.native.complete();
      await terminal(opened, turnIdOf(turn.result));
      const catalog = await rig.instance.catalog.list();
      assert.equal(catalog.defaultModelId, "muse-large-2");
      assert.deepEqual(catalog.models.map((model) => [model.id, model.contextWindow]), [
        ["muse-large-2", 200000],
        ["muse-small-1", 100000],
      ]);
      assert.equal(opened.session.contextWindow!("muse-small-1"), 100000);
      await assert.rejects(opened.session.startTurn({ threadId: thread.id, clientTurnKey: "bad", intent: "start", content: [{ type: "text", text: "x" }], config: { reasoningEffort: "turbo" } }), (error) => isAriError(error, "validation"));
    } finally {
      await rig.cleanup();
    }
  });
});
