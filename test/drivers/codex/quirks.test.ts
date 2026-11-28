// Codex's quirks, each kept by the driver: questions answered by message,
// goal runs Codex starts itself, race-safe steering, interrupts Codex answers
// only once the turn aborted, approvals whose decisions have no ids, opting
// out of diffs, rate limits, background terminals, fork, compaction, MCP
// apps, feedback, native session filters and the codex.* extensions. Each
// case is the sequence pinned Codex (rust-v0.172.0) produces, except the one
// named a synthetic robustness check.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { EventGrammar } from "../../../src/host/event-grammar.ts";
import { RequestLedger } from "../../../src/host/request-ledger.ts";
import { isAriError } from "../../../src/index.ts";
import type { AriEvent, Request } from "../../../src/index.ts";
import { codexRig, policy } from "./rig.ts";
import type { CodexTestRig, OpenedCodexSession } from "./rig.ts";

let rig: CodexTestRig | undefined;
afterEach(async () => {
  await rig?.cleanup();
  rig = undefined;
});

function strictGrammar(events: readonly AriEvent[]): void {
  const grammar = new EventGrammar({ mode: "strict" });
  for (const event of events) grammar.observe(event);
}

function lastRequest(opened: OpenedCodexSession, id: string): Request | undefined {
  let found: Request | undefined;
  for (const body of opened.bodies("request.upsert")) {
    if (body.request.id !== id) continue;
    found = found === undefined ? (body.request as Request) : ({ ...found, ...body.request } as Request);
  }
  return found;
}

/** The process id Codex lists for the thread's terminal. */
function listedProcessId(current: CodexTestRig, nativeThreadId: string): string {
  return current.world.storedThread(nativeThreadId)!.terminals[0]!.processId;
}

async function terminal(opened: OpenedCodexSession, turnId: string) {
  return opened.until(() => opened.bodies("turn.terminal").find((body) => body.turnId === turnId), `turn.terminal of ${turnId}`);
}

describe("a history resume", () => {
  test("reads the stored thread without a writer: no thread/resume, no MCP config, no policy and no replacement; the thread stays unloaded and its turns read back", async () => {
    rig = await codexRig();
    const first = await rig.open();
    const thread = await first.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const started = await first.session.startTurn({ threadId: thread.id, clientTurnKey: "h-1", intent: "start", content: [{ type: "text", text: "Remember 7." }] });
    const native = await rig.nextTurn();
    await native.complete();
    await terminal(first, (started as { turnId: string }).turnId);
    await first.session.close();

    const second = await rig.open();
    const resumes = rig.requests("thread/resume").length;
    const starts = rig.requests("thread/start").length;
    const mcpServers = () => rig!.host.calls.filter((call) => call.operation === "hostTools.mcpServerFor").length;
    const servers = mcpServers();
    const resumed = await second.session.resumeThread({ native: { handle: thread.handle! }, purpose: "history" });
    assert.equal(resumed.id, thread.id);
    assert.equal(resumed.status, "unloaded");
    assert.equal(rig.requests("thread/resume").length, resumes, "a history read never opens the thread for writing");
    assert.equal(mcpServers(), servers, "a history read gives Codex no MCP server");
    const snapshot = await second.session.readSnapshot!(resumed.id);
    assert.equal(snapshot.turns.length, 1);
    await assert.rejects(second.session.startTurn({ threadId: resumed.id, clientTurnKey: "h-2", intent: "start", content: [{ type: "text", text: "Again." }] }), (error: unknown) => isAriError(error, "invalid_state"));

    // A thread Codex does not have is not found: a history read never starts a new one.
    await assert.rejects(second.session.resumeThread({ native: { handle: "019a0000-0000-7000-8000-000000000000" }, purpose: "history", policy: policy(rig.cwd) }), (error: unknown) => isAriError(error, "not_found"));
    assert.equal(rig.requests("thread/start").length, starts, "no thread was created");
    assert.equal(second.bodies("session.replaced").length, 0);
  });
});

describe("codex quirks", () => {
  test("async questions are message-mode requests that survive their turn's end and a restart, until a user message answers them", async () => {
    rig = await codexRig();
    const first = await rig.open();
    const thread = await first.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const started = await first.session.startTurn({ threadId: thread.id, clientTurnKey: "q-1", intent: "start", content: [{ type: "text", text: "Plan the release." }] });
    assert.equal(started.status, "accepted");
    const turnId = (started as { turnId: string }).turnId;
    const native = await rig.nextTurn();
    await native.askAsync("Before I go on:", [{ title: "Which branch?", options: ["main", "release"] }]);
    const asked = await first.until(() => first.bodies("request.upsert").find((body) => body.request.response?.mode === "message")?.request as Request | undefined, "the async question");
    assert.equal(asked.kind, "user_input");
    assert.equal(asked.survivesRestart, true);
    assert.equal(asked.status, "pending");
    assert.deepEqual(asked.questions?.map((question) => [question.prompt, question.options?.map((option) => option.id)]), [["Which branch?", ["main", "release"]]]);

    // The turn ends: the question stays pending.
    await native.complete();
    await terminal(first, turnId);
    assert.equal(lastRequest(first, asked.id)?.status, "pending");

    // The provider's process dies: still pending, while live requests would expire.
    rig.world.servers.at(-1)!.exit(1, null);
    await first.until(() => first.bodies("notice").find((body) => body.code === "codex.exited"), "the exit notice");
    assert.equal(lastRequest(first, asked.id)?.status, "pending");
    const ledger = new RequestLedger();
    for (const event of first.events) ledger.observe(event);
    ledger.endSession();
    assert.equal(ledger.get(asked.id)?.status, "pending", "the host's ledger keeps a survivesRestart request pending across the session's end");
    await first.session.close();
    assert.equal(lastRequest(first, asked.id)?.status, "pending");

    // A new session after the restart resumes the thread and raises the same question again.
    const second = await rig.open();
    const resumed = await second.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd) });
    assert.equal(resumed.id, thread.id);
    const again = await second.until(() => lastRequest(second, asked.id), "the question after the restart");
    assert.equal(again.status, "pending");
    assert.deepEqual(again.response, { mode: "message" });

    // The host answers: the driver links the answer and hands back the user message to send.
    const answered = await second.session.respond({ requestId: asked.id, responseKey: "answer-1", answers: { "0": { optionIds: ["release"] } } });
    assert.ok(answered !== undefined && answered.followUpPrompt !== undefined);
    assert.match((answered.followUpPrompt[0] as { text: string }).text, /Which branch\?\nrelease/);
    await second.until(() => (lastRequest(second, asked.id)?.status === "resolved" ? true : undefined), "the answered question to resolve");
    const follow = await second.session.startTurn({ threadId: thread.id, clientTurnKey: "q-2", intent: "start", content: answered.followUpPrompt });
    const answerTurn = await rig.nextTurn();
    assert.match(answerTurn.prompt, /release/);
    await answerTurn.complete();
    await terminal(second, (follow as { turnId: string }).turnId);
    await second.session.close();

    // Once a user message followed it, a later resume does not raise it again.
    const third = await rig.open();
    await third.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd) });
    assert.equal(lastRequest(third, asked.id), undefined);
    strictGrammar(first.events);
    strictGrammar(second.events);
  });

  test("an active goal set on an idle thread: Codex starts its turns itself, a host turn/start that meets one is steered into it, and ari.goal lists them all", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const set = (await opened.session.ext!("ari.goal", "set", { threadId: thread.id, objective: "Ship the release." })) as { status: string; derived: boolean; turnIds: string[] };
    assert.equal(set.status, "active");
    assert.equal(set.derived, false);
    assert.deepEqual(rig.requests("thread/goal/set").at(-1), { threadId: thread.native.id, objective: "Ship the release.", status: "active" });

    // Codex starts the first goal turn on its own, with no turn/start.
    const first = await rig.nextAutonomousTurn();
    const firstId = await opened.until(() => opened.bodies("turn.upsert").find((body) => body.turn.native?.id === first.nativeTurnId)?.turn.id, "the turn Codex started for the goal");
    await first.say("Step one done.");
    // The host's next turn/start races Codex's next goal turn, and Codex wins: its turn/started arrives before the
    // turn/start answer, which names Codex's turn because Codex added the host's message to it.
    rig.world.continueGoalAtNextTurnStart(thread.native.id!);
    await first.complete();
    await terminal(opened, firstId);
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "host-1", intent: "start", hostTag: "goal-run-1", content: [{ type: "text", text: "Also update the changelog." }] });
    const second = await rig.nextAutonomousTurn();
    const secondId = await opened.until(() => opened.bodies("turn.upsert").find((body) => body.turn.native?.id === second.nativeTurnId)?.turn.id, "the second goal turn");
    assert.deepEqual(started, { status: "accepted", turnId: secondId, accepted: "steered" });
    assert.equal(await second.nextSteer!(), "Also update the changelog.");
    await second.complete();
    await terminal(opened, secondId);

    const third = await rig.nextAutonomousTurn();
    const thirdId = await opened.until(() => opened.bodies("turn.upsert").find((body) => body.turn.native?.id === third.nativeTurnId)?.turn.id, "the third goal turn");
    await third.reachGoal();
    await third.complete();
    await terminal(opened, thirdId);

    const starts = opened.bodies("turn.upsert").filter((body) => body.turn.origin !== undefined).map((body) => body.turn);
    assert.deepEqual(starts.map((turn) => [turn.id, turn.origin, turn.clientTurnKey, turn.parentTurnId]), [
      [firstId, "provider_initiated", undefined, undefined],
      [secondId, "provider_initiated", undefined, firstId],
      [thirdId, "provider_initiated", undefined, firstId],
    ]);
    assert.deepEqual(
      opened.bodies("turn.terminal").map((body) => [body.turnId, body.status]),
      [firstId, secondId, thirdId].map((id) => [id, "completed"]),
    );
    const goal = await opened.until(() => {
      const last = opened.bodies("x:ari.goal.updated").at(-1) as { data: { status: string; turnIds: string[]; objective: string } | null; fallback?: { text?: string } } | undefined;
      return last?.data?.status === "completed" ? last : undefined;
    }, "the goal to complete");
    assert.deepEqual(goal.data!.turnIds, [firstId, secondId, thirdId]);
    assert.match(goal.fallback?.text ?? "", /Goal completed: Ship the release\./);
    assert.ok(opened.bodies("x:codex.goal.updated").length > 0);
    assert.equal(rig.world.activeTurns().length, 0, "Codex starts no turn after the goal is met");
    strictGrammar(opened.events);
  });

  test("ari.goal get after a goal run completed lists the run's turns, as the completion event did", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    await opened.session.ext!("ari.goal", "set", { threadId: thread.id, objective: "Tidy the repository." });
    const ids: string[] = [];
    for (const last of [false, true]) {
      const turn = await rig.nextAutonomousTurn();
      if (last) await turn.reachGoal();
      await turn.complete();
      const id = await opened.until(() => opened.bodies("turn.upsert").find((body) => body.turn.native?.id === turn.nativeTurnId)?.turn.id, "a goal turn");
      await terminal(opened, id);
      ids.push(id);
    }
    const completed = await opened.until(() => {
      const last = opened.bodies("x:ari.goal.updated").at(-1) as { data: { status: string; turnIds: string[] } | null } | undefined;
      return last?.data?.status === "completed" ? last.data : undefined;
    }, "the goal to complete");
    assert.deepEqual(completed.turnIds, ids);
    const got = (await opened.session.ext!("ari.goal", "get", { threadId: thread.id })) as { status: string; turnIds: string[] };
    assert.equal(got.status, "completed");
    assert.deepEqual(got.turnIds, ids, "the run's turns outlive the end of the run");
    // A new goal opens a new run, which starts empty.
    const set = (await opened.session.ext!("ari.goal", "set", { threadId: thread.id, objective: "Write the release notes." })) as { turnIds: string[] };
    assert.deepEqual(set.turnIds, []);
    const next = await rig.nextAutonomousTurn();
    await next.reachGoal();
    await next.complete();
    const nextId = await opened.until(() => opened.bodies("turn.upsert").find((body) => body.turn.native?.id === next.nativeTurnId)?.turn.id, "the new goal's turn");
    await terminal(opened, nextId);
    assert.deepEqual(((await opened.session.ext!("ari.goal", "get", { threadId: thread.id })) as { turnIds: string[] }).turnIds, [nextId]);
  });

  test("createThread runs the thread in its own cwd, also when policy.cwd names another directory", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    // Codex has one working directory per thread: createThread's cwd. Its sandbox roots are that directory and policy.additionalRoots.
    const thread = await opened.session.createThread({ cwd: rig.otherCwd, policy: policy(rig.cwd) });
    assert.equal(rig.requests("thread/start").at(-1)!["cwd"], rig.otherCwd);
    assert.equal(thread.cwd, rig.otherCwd);
    assert.equal(rig.world.inspect(thread.native.id!)!.cwd, rig.otherCwd);
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "c-1", intent: "start", content: [{ type: "text", text: "Where am I?" }] });
    await (await rig.nextTurn()).complete();
    await terminal(opened, (started as { turnId: string }).turnId);
    assert.equal(rig.world.inspect(thread.native.id!)!.cwd, rig.otherCwd);
  });

  test("a goal set during a host turn: that turn leads the run, and the turns Codex starts after it carry its hostTag and parentTurnId", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "goal-1", intent: "start", hostTag: "goal-run-1", content: [{ type: "text", text: "Work on the release." }] });
    const rootId = (started as { turnId: string }).turnId;
    const host = await rig.nextTurn();
    await opened.session.ext!("ari.goal", "set", { threadId: thread.id, objective: "Ship the release." });
    await host.say("Step one done.");
    await host.complete();
    await terminal(opened, rootId);
    const later: string[] = [];
    for (const step of ["two", "three"]) {
      const turn = await rig.nextAutonomousTurn();
      await turn.say(`Step ${step} done.`);
      if (step === "three") await turn.reachGoal();
      await turn.complete();
      const id = await opened.until(() => opened.bodies("turn.upsert").find((body) => body.turn.native?.id === turn.nativeTurnId)?.turn.id, `the turn Codex started for step ${step}`);
      await terminal(opened, id);
      later.push(id);
    }
    const starts = opened.bodies("turn.upsert").filter((body) => body.turn.origin !== undefined).map((body) => body.turn);
    const root = starts.find((turn) => turn.id === rootId)!;
    assert.deepEqual([root.origin, root.clientTurnKey, root.hostTag], ["user", "goal-1", "goal-run-1"]);
    for (const id of later) {
      const turn = starts.find((candidate) => candidate.id === id)!;
      assert.deepEqual([turn.origin, turn.hostTag, turn.parentTurnId, turn.clientTurnKey], ["provider_initiated", "goal-run-1", rootId, undefined]);
    }
    const goal = await opened.until(() => {
      const last = opened.bodies("x:ari.goal.updated").at(-1) as { data: { status: string; turnIds: string[] } | null } | undefined;
      return last?.data?.status === "completed" ? last : undefined;
    }, "the goal to complete");
    assert.deepEqual(goal.data!.turnIds, [rootId, ...later]);
    strictGrammar(opened.events);
  });

  test("interruptTurn returns only once Codex answered turn/interrupt, which it does when the turn has aborted", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "i-1", intent: "start", content: [{ type: "text", text: "Long task." }] });
    const turnId = (started as { turnId: string }).turnId;
    const native = await rig.nextTurn();
    let returned = false;
    const interrupting = opened.session.interruptTurn({ turnId }).then(() => {
      returned = true;
    });
    assert.equal(await native.stopRequested(), "cancel");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(returned, false, "Codex holds the answer until the turn aborts");
    await native.finishCancelled();
    await interrupting;
    assert.equal((await terminal(opened, turnId)).status, "interrupted");
  });

  test("steering sends expectedTurnId, and a steer Codex refuses because the turn ended returns prompt_required", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "s-1", intent: "start", content: [{ type: "text", text: "Refactor the parser." }] });
    const turnId = (started as { turnId: string }).turnId;
    const native = await rig.nextTurn();
    const steerText = native.nextSteer!();
    const steered = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "s-2", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "Keep the old API." }] });
    assert.deepEqual(steered, { status: "accepted", turnId, accepted: "steered" });
    assert.equal(await steerText, "Keep the old API.");
    assert.equal(rig.requests("turn/steer").at(-1)!["expectedTurnId"], native.nativeTurnId);

    // Codex ends the turn; the driver has not heard yet. Codex refuses the steer, and the host must start a new turn.
    const held = await native.completeHeld!();
    const late = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "s-3", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "One more thing." }] });
    assert.deepEqual(late, { status: "prompt_required" });
    assert.equal(rig.requests("turn/steer").length, 2, "the late steer reached Codex, which refused it");
    await held.release();
    await terminal(opened, turnId);

    // After the turn ended, a steer goes nowhere.
    const afterEnd = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "s-4", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "Too late." }] });
    assert.deepEqual(afterEnd, { status: "prompt_required" });
    assert.equal(rig.requests("turn/steer").length, 2);
    // A steer naming another turn than the active one is not sent either.
    const next = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "s-5", intent: "start", content: [{ type: "text", text: "Next task." }] });
    await rig.nextTurn();
    const wrong = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "s-6", intent: "steer", expectedTurnId: turnId, content: [{ type: "text", text: "For the old turn." }] });
    assert.deepEqual(wrong, { status: "prompt_required" });
    assert.notEqual((next as { turnId: string }).turnId, turnId);
  });

  test("the approvals pinned Codex produces keep each decision as its own option, and the reply is the exact decision chosen", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "a-1", intent: "start", content: [{ type: "text", text: "Check the status." }] });
    const native = await rig.nextTurn();
    const pending = (seen: Set<string>) => opened.until(() => opened.bodies("request.upsert").find((body) => body.request.status === "pending" && !seen.has(body.request.id))?.request as Request | undefined, "an approval");
    const seen = new Set<string>();

    // An ordinary command approval: accept, one exec-policy amendment, cancel (protocol/src/approvals.rs:379–411).
    const prefix = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } };
    const command = await native.commandApproval("git status", ["accept", prefix, "cancel"]);
    const commandRequest = await pending(seen);
    seen.add(commandRequest.id);
    assert.equal(commandRequest.kind, "command");
    assert.deepEqual(commandRequest.options?.map((option) => [option.optionId, option.decision, option.scope]), [
      ["accept", "accept", "once"],
      ['acceptWithExecpolicyAmendment:["git","status"]', "accept_always", "global"],
      ["cancel", "cancel", undefined],
    ]);
    await opened.session.respond({ requestId: commandRequest.id, responseKey: "r-1", optionId: commandRequest.options![1]!.optionId });
    assert.deepEqual(await command.decision, prefix);

    // A network approval: two broader accepting decisions, a session grant and an allow rule (approvals.rs:385–397).
    const allow = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "registry.npmjs.org", action: "allow" as const } } };
    const network = await native.commandApproval("", ["accept", "acceptForSession", allow, "cancel"], { network: { host: "registry.npmjs.org" } });
    const networkRequest = await pending(seen);
    seen.add(networkRequest.id);
    assert.equal(networkRequest.questions, undefined, "two accepting options stay an approval, not a question");
    assert.deepEqual(networkRequest.options?.map((option) => [option.optionId, option.decision, option.scope]), [
      ["accept", "accept", "once"],
      ["acceptForSession", "accept_for_session", "session"],
      ['applyNetworkPolicyAmendment:["allow","registry.npmjs.org"]', "accept_always", "global"],
      ["cancel", "cancel", undefined],
    ]);
    await opened.session.respond({ requestId: networkRequest.id, responseKey: "r-2", optionId: networkRequest.options![2]!.optionId });
    assert.deepEqual(await network.decision, allow);
  });

  test("synthetic robustness, not ordinary Codex output: a schema-valid approval with two exec-policy prefixes keeps both, and the reply is the second", async () => {
    // The ordinary pinned producer offers at most one prefix amendment (protocol/src/approvals.rs:405–411); the schema allows a list of any decisions.
    rig = await codexRig();
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "a-1", intent: "start", content: [{ type: "text", text: "Check the status." }] });
    const native = await rig.nextTurn();
    const sessionGrant = "acceptForSession" as const;
    const longPrefix = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } };
    const shortPrefix = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git"] } };
    const approval = await native.commandApproval("git status", ["accept", sessionGrant, longPrefix, shortPrefix, "decline", "cancel"]);
    const request = await opened.until(() => opened.bodies("request.upsert").find((body) => body.request.status === "pending")?.request as Request | undefined, "the approval");
    assert.equal(request.kind, "command");
    assert.equal(request.questions, undefined);
    assert.deepEqual(request.subject?.command, ["git status"]);
    const options = request.options ?? [];
    assert.deepEqual(
      options.map((option) => [option.decision, option.scope]),
      [
        ["accept", "once"],
        ["accept_for_session", "session"],
        ["accept_always", "global"],
        ["accept_always", "global"],
        ["decline", undefined],
        ["cancel", undefined],
      ],
    );
    assert.equal(new Set(options.map((option) => option.optionId)).size, 6, "each decision keeps its own native option id");
    // The second "always" option: the reply must be that exact decision, not the first one with the same ARI decision.
    await opened.session.respond({ requestId: request.id, responseKey: "r-1", optionId: options[3]!.optionId });
    assert.deepEqual(await approval.decision, shortPrefix);
    await opened.until(() => (lastRequest(opened, request.id)?.status === "resolved" ? true : undefined), "the approval to resolve");
  });

  test("a human command checkpoint under full_access still reaches the person: fullAccessOverride is ask_rule", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd, "full_access") });
    assert.equal(rig.requests("thread/start").at(-1)!["approvalPolicy"], "never");
    await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "h-1", intent: "start", content: [{ type: "text", text: "Deploy." }] });
    const native = await rig.nextTurn();
    const approval = await native.commandApproval("deploy --prod", ["accept", "decline", "cancel"], { kind: "humanCommand" });
    const request = await opened.until(() => opened.bodies("request.upsert").find((body) => body.request.status === "pending")?.request as Request | undefined, "the checkpoint");
    assert.equal(request.fullAccessOverride, "ask_rule");
    assert.deepEqual(request.options?.map((option) => option.optionId), ["accept", "decline", "cancel"]);
    await opened.session.respond({ requestId: request.id, responseKey: "h", optionId: "decline" });
    assert.equal(await approval.decision, "decline");
  });

  test("emitDiffs: false suppresses provider diffs in file changes and approval subjects; the default keeps them", async () => {
    rig = await codexRig();
    for (const emitDiffs of [true, false]) {
      const opened = await rig.open(emitDiffs ? {} : { emitDiffs: false });
      assert.deepEqual(opened.session.capabilities().diffs, { emits: true, canDisable: true });
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      await opened.session.startTurn({ threadId: thread.id, clientTurnKey: `d-${emitDiffs}`, intent: "start", content: [{ type: "text", text: "Edit the README." }] });
      const native = await rig.nextTurn();
      const itemId = await native.changeFiles([{ path: "README.md", kind: "update", diff: "@@ -1 +1 @@\n-# Old\n+# New\n" }]);
      const approval = await native.fileChangeApproval(itemId);
      const request = await opened.until(() => opened.bodies("request.upsert").find((body) => body.request.kind === "file_change")?.request as Request | undefined, "the file-change approval");
      const changes = await opened.until(() => opened.bodies("item.upsert").find((body) => body.item.kind === "file_change" && body.item.status === "completed")?.item.changes ?? undefined, "the settled file change");
      assert.deepEqual(changes.map((change) => change.path), [`${rig.cwd}/README.md`]);
      if (emitDiffs) {
        assert.equal(changes[0]!.diff, "@@ -1 +1 @@\n-# Old\n+# New\n");
        assert.match(request.subject?.diff ?? "", /\+# New/);
      } else {
        assert.equal(changes[0]!.diff, undefined, "a file change carries no diff when the host turned diffs off");
        assert.equal(request.subject?.diff, undefined);
      }
      await opened.session.respond({ requestId: request.id, responseKey: "d", optionId: "accept" });
      assert.equal(await approval.decision, "accept");
      await native.complete();
      await opened.session.close();
    }
    // The driver never takes Codex's aggregated turn diff: it opts out of turn/diff/updated on every connection.
    for (const server of rig.world.servers) assert.ok(server.optOut.includes("turn/diff/updated"));
  });

  test("rate-limit updates become limits.updated, and limits.current reads Codex's snapshot", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    rig.world.updateRateLimits({ primary: { usedPercent: 80, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: resetsAt + 86_400 }, credits: { hasCredits: true, unlimited: false, balance: "12.5" } });
    const first = await opened.until(() => opened.bodies("limits.updated").at(0)?.limits, "limits.updated");
    assert.deepEqual(first, {
      windows: [
        { window: "5h", utilization: 0.8, resetsAt: new Date(resetsAt * 1000).toISOString() },
        { window: "weekly", utilization: 0.4, resetsAt: new Date((resetsAt + 86_400) * 1000).toISOString() },
        { window: "credits", remaining: 12.5 },
      ],
      limited: false,
    });
    rig.world.updateRateLimits({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt }, rateLimitReachedType: "rate_limit_reached" });
    const reached = await opened.until(() => opened.bodies("limits.updated").at(1)?.limits, "the second limits.updated");
    assert.equal(reached.limited, true);
    assert.equal(reached.resetsAt, new Date(resetsAt * 1000).toISOString());
    const current = await rig.instance.limits!.current();
    assert.deepEqual(current, reached);
    assert.equal(rig.requests("account/rateLimits/read").length, 1);
  });

  test("background terminals are listed, awaited and stopped through backgroundTasks", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "b-1", intent: "start", content: [{ type: "text", text: "Start the dev server." }] });
    const native = await rig.nextTurn();
    await native.startBackgroundTask!({ title: "npm run dev" });
    await native.complete();
    await terminal(opened, (started as { turnId: string }).turnId);
    const announced = await opened.until(() => opened.bodies("background.updated").find((body) => body.tasks.length > 0)?.tasks, "background.updated");
    assert.deepEqual(announced.map((task) => [task.kind, task.status, task.title]), [["terminal", "running", "npm run dev"]]);
    const listed = await opened.session.backgroundTasks!.list(thread.id);
    assert.deepEqual(listed.map((task) => [task.id, task.title, task.command]), [[announced[0]!.id, "npm run dev", ["npm run dev"]]]);
    assert.deepEqual(await opened.session.backgroundTasks!.await({ threadId: thread.id, taskIds: [listed[0]!.id, "task_unknown"], awaited: true }), { matched: [listed[0]!.id] });
    assert.equal(opened.session.canRelease(), false, "a running terminal vetoes release");
    await opened.session.backgroundTasks!.stop({ threadId: thread.id, taskId: listed[0]!.id });
    // Codex parses the process id as an i32 before it terminates anything (thread_processor.rs:2707–2721).
    const processId = rig.requests("thread/backgroundTerminals/terminate").at(-1)!["processId"];
    assert.equal(processId, rig.requests("thread/backgroundTerminals/list").length > 0 ? listedProcessId(rig, thread.native.id!) : undefined);
    assert.match(String(processId), /^\d+$/);
    assert.deepEqual(rig.world.inspect(thread.native.id!)!.backgroundTasks, [{ title: "npm run dev", running: false }]);
    assert.deepEqual(await opened.session.backgroundTasks!.list(thread.id), []);
    assert.deepEqual(opened.bodies("background.updated").at(-1)!.tasks, []);
  });

  test("fork (from a turn and into another directory), compaction, MCP apps and feedback upload reach Codex and return what it produced", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const turnIds: string[] = [];
    for (const prompt of ["First.", "Second."]) {
      const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: prompt, intent: "start", content: [{ type: "text", text: prompt }] });
      const native = await rig.nextTurn();
      await native.complete();
      turnIds.push((started as { turnId: string }).turnId);
      await terminal(opened, turnIds.at(-1)!);
    }
    const nativeTurns = rig.world.inspect(thread.native.id!)!;
    assert.deepEqual(nativeTurns.prompts, ["First.", "Second."]);

    const fork = await opened.session.forkThread!({ threadId: thread.id, at: { type: "turn", turnId: turnIds[0]! } });
    const forkRequest = rig.requests("thread/fork").at(-1)!;
    assert.equal(forkRequest["threadId"], thread.native.id);
    assert.equal(typeof forkRequest["lastTurnId"], "string");
    assert.deepEqual(rig.world.inspect(fork.native.id!)!.prompts, ["First."]);
    assert.deepEqual(fork.forkedFrom, { threadId: thread.id, turnId: turnIds[0] });
    const elsewhere = await opened.session.forkThread!({ threadId: thread.id, at: { type: "latest" }, cwd: rig.otherCwd });
    assert.equal(elsewhere.cwd, rig.otherCwd);
    assert.equal(rig.world.inspect(elsewhere.native.id!)!.cwd, rig.otherCwd);
    await assert.rejects(opened.session.forkThread!({ threadId: thread.id, at: { type: "item", itemId: "item_x" } }), (error) => isAriError(error, "unsupported"));

    await opened.session.compactThread!(thread.id);
    assert.equal(rig.requests("thread/compact/start").length, 1);
    assert.equal(rig.world.inspect(thread.native.id!)!.compactions, 1);
    assert.ok(opened.bodies("item.upsert").some((body) => body.item.kind === "compaction"));

    const tools = await opened.session.mcpApps!.listTools(thread.id, "fake-tools");
    assert.deepEqual(tools.map((tool) => tool.name), ["echo"]);
    const called = await opened.session.mcpApps!.callTool(thread.id, "fake-tools", "echo", { text: "hi" });
    assert.deepEqual(called, rig.world.activityLog.mcp.findLast((entry) => entry.operation === "callTool")!.output);
    assert.deepEqual(rig.requests("mcpServer/tool/call").at(-1), { threadId: thread.native.id, server: "fake-tools", tool: "echo", arguments: { text: "hi" } });
    const resource = await opened.session.mcpApps!.readResource(thread.id, "fake-tools", "fake://readme");
    assert.deepEqual(resource, rig.world.activityLog.mcp.findLast((entry) => entry.operation === "readResource")!.output);

    const feedback = await opened.session.uploadFeedback!({ threadId: thread.id, reason: "wrong file" });
    assert.equal(feedback.feedbackId, thread.native.id);
    assert.deepEqual(rig.requests("feedback/upload").at(-1), { classification: "other", threadId: thread.native.id, includeLogs: false, reason: "wrong file" });
    strictGrammar(opened.events);
  });

  test("native session listing passes every x:codex.* filter to thread/list for Codex to validate, keeps ARI's own cwd and cursor, and keeps Codex's 100-id cap", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    const threads = [];
    for (const prompt of ["alpha task", "beta task", "alpha again"]) {
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: prompt, intent: "start", content: [{ type: "text", text: prompt }] });
      await (await rig.nextTurn()).complete();
      await terminal(opened, (started as { turnId: string }).turnId);
      threads.push(thread);
    }
    const page = await rig.instance.nativeSessions!.list({ cwd: rig.cwd, "x:codex.searchTerm": "alpha", "x:codex.limit": 10, "x:codex.excludedThreadIds": [threads[2]!.native.id!], "x:codex.sortKey": "created_at" } as never);
    assert.deepEqual(rig.requests("thread/list").at(-1), { cwd: rig.cwd, searchTerm: "alpha", limit: 10, excludedThreadIds: [threads[2]!.native.id], sortKey: "created_at" });
    assert.deepEqual(page.items.map((item) => [item.id, item.handle, item.title]), [[threads[0]!.native.id, threads[0]!.native.id, "alpha task"]]);
    assert.equal((page.items[0] as { [key: string]: unknown })["x:codex.modelProvider"], "openai");
    assert.equal(page.nextCursor, null);
    // Filters the pinned protocol has and the driver never listed, and one it does not have: all reach Codex, which validates them.
    const section = await rig.instance.nativeSessions!.list({ cwd: rig.cwd, "x:codex.sectionId": null, "x:codex.attachedToThreadId": threads[0]!.native.id!, "x:codex.includeAttachedThreads": true, "x:codex.bogus": true } as never);
    assert.deepEqual(rig.requests("thread/list").at(-1), { cwd: rig.cwd, sectionId: null, attachedToThreadId: threads[0]!.native.id, includeAttachedThreads: true, bogus: true });
    assert.ok(Array.isArray(section.items));
    // cwd and cursor are ARI's own fields.
    for (const key of ["x:codex.cwd", "x:codex.cursor"]) {
      await assert.rejects(rig.instance.nativeSessions!.list({ cwd: rig.cwd, [key]: "elsewhere" } as never), (error) => isAriError(error, "validation") && error.message.includes(key));
    }
    await assert.rejects(rig.instance.nativeSessions!.list({ cwd: rig.cwd, "x:other.filter": true } as never), (error) => isAriError(error, "validation"));
    const tooMany = Array.from({ length: 101 }, (_, index) => `thread-${index}`);
    await assert.rejects(rig.instance.nativeSessions!.list({ cwd: rig.cwd, "x:codex.excludedThreadIds": tooMany } as never), (error) => isAriError(error, "validation"));
    await rig.instance.nativeSessions!.archive!(threads[1]!.native.id!);
    assert.deepEqual(rig.requests("thread/archive").at(-1), { threadId: threads[1]!.native.id });
    const archived = await rig.instance.nativeSessions!.list({ cwd: rig.cwd, "x:codex.archived": true } as never);
    assert.deepEqual(archived.items.map((item) => item.id), [threads[1]!.native.id]);
    await rig.instance.nativeSessions!.delete!(threads[2]!.native.id!);
    assert.deepEqual(rig.requests("thread/delete").at(-1), { threadId: threads[2]!.native.id });
  });

  test("codex.review runs a review turn; codex.readState and codex.memory reach Codex; each extension is listed with a version", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    assert.deepEqual(
      opened.session.capabilities().extensions,
      ["ari.goal", "codex.goal", "codex.review", "codex.readState", "codex.memory"].map((ns) => ({ ns, version: "1" })),
    );
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const review = (await opened.session.ext!("codex.review", "start", { threadId: thread.id, target: { type: "uncommittedChanges" } })) as { threadId: string; turnId: string };
    assert.equal(review.threadId, thread.id);
    assert.deepEqual(rig.requests("review/start").at(-1), { threadId: thread.native.id, target: { type: "uncommittedChanges" }, delivery: "inline" });
    const settled = await terminal(opened, review.turnId);
    assert.equal(settled.status, "completed");
    assert.deepEqual(
      opened.bodies("item.upsert").filter((body) => body.item.kind === "review" && body.item.status === "completed").map((body) => body.item.text),
      ["current changes", "No issues found."],
    );

    const read = (await opened.session.ext!("codex.readState", "read", { threadId: thread.id })) as { readState: { revision: string } };
    const updated = (await opened.session.ext!("codex.readState", "update", { threadId: thread.id, expectedRevision: read.readState.revision, operation: "unread" })) as { readState: { revision: string; firstUnread: unknown } };
    assert.deepEqual(updated.readState.firstUnread, { type: "threadStart" });
    const changed = await opened.until(() => opened.bodies("x:codex.readState.changed").at(-1), "x:codex.readState.changed");
    assert.equal((changed as unknown as { fallback?: { title: string } }).fallback?.title, "Read state changed");
    await assert.rejects(opened.session.ext!("codex.readState", "update", { threadId: thread.id, expectedRevision: read.readState.revision, operation: "read" }), (error) => isAriError(error, "invalid_state"));

    const memory = (await opened.session.ext!("codex.memory", "read", { threadId: thread.id })) as { threadId: string; summary: string };
    assert.equal(memory.threadId, thread.id);
    assert.match(memory.summary, /^Memory summary \d+ for /);
    await assert.rejects(opened.session.ext!("codex.unknown", "x", { threadId: thread.id }), (error) => isAriError(error, "unsupported"));
    await assert.rejects(opened.session.ext!("codex.memory", "write", { threadId: thread.id }), (error) => isAriError(error, "not_found"));
  });
});
