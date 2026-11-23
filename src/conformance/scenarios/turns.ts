// Scenarios 1 to 7: the event grammar, the four ways a turn ends, authoritative
// settlement, and a steer that arrives after its turn ended.

import { hasCapability } from "../../capabilities.ts";
import { isFailure } from "../../errors.ts";
import { TERMINAL_ITEM_STATUSES } from "../../host/event-grammar.ts";
import type { TurnTerminalBody } from "../../generated/events.ts";
import type { StartTurnResult } from "../../generated/session.ts";
import type { OpenedSession, ScenarioContext } from "../context.ts";
import type { HarnessRig } from "../harness.ts";
import { brief, realSleep } from "../util.ts";
import { approval, approvalKind, assistantText, isToolItem, pendingRequestOffering, supervisedMode } from "./scenario.ts";
import type { Scenario } from "./scenario.ts";
import { describeError } from "./sessions.ts";

/** Checks that nothing the turn opened is still open at its `turn.terminal`. */
function checkNothingLeftOpen(context: ScenarioContext, opened: OpenedSession, turnId: string): void {
  const open = context.openItemsAtTerminal(opened, turnId);
  context.check(open.length === 0, `items ${open.join(", ")} were still open when turn ${turnId} ended; a turn that ends settles its items first`);
}

/**
 * A turn that ended with `threadDisposition: "reusable"` must leave a thread
 * that takes the next turn: the terminal event alone is not the result.
 */
async function checkThreadReusable(context: ScenarioContext, opened: OpenedSession, rig: HarnessRig<unknown>, threadId: string, turnId: string, terminal: TurnTerminalBody): Promise<void> {
  if (terminal.threadDisposition !== "reusable") return;
  const said = `turn ${turnId} ended ${brief(terminal.status)} with threadDisposition "reusable"`;
  let next: StartTurnResult;
  try {
    next = await context.startTurn(opened, threadId, "Next task.");
  } catch (error) {
    context.fail(`${said}, but the thread refused the next turn: ${describeError(error)}`);
  }
  context.check(next.status === "accepted", `${said}, but the thread answered the next turn with ${brief(next)}`);
  const native = await context.wait(rig.native.nextTurn(), `the native agent to receive the turn after ${turnId}`);
  await context.wait(native.complete(), "the native agent to complete the next turn");
  const after = await context.terminal(opened, next.turnId);
  context.check(after.status === "completed", `${said}, but the next turn on the thread ended ${brief(after.status)}`);
}

async function openThread(context: ScenarioContext, rig?: HarnessRig<unknown>) {
  const usedRig = rig ?? (await context.rig());
  const created = await context.instance(usedRig);
  const opened = await context.openSession(created);
  const thread = await context.createThread(opened);
  return { rig: usedRig, created, opened, thread };
}

export const grammarScenario: Scenario = {
  id: 1,
  key: "grammar",
  title: "EventGrammar invariants hold in strict mode over every stream the other scenarios produce",
  async run(context: ScenarioContext) {
    const { rig, opened, thread } = await openThread(context);
    const capabilities = opened.capabilities();

    // A rich turn: streamed text, a tool, an approval when the driver has them, and completion.
    const first = await context.beginTurn(opened, rig, thread.id, "Inspect the workspace.");
    await context.wait(first.native.say("Looking around the workspace."), "the native agent to stream text");
    await context.wait(first.native.runTool({ name: "list_files", input: { path: "." }, output: "README.md", path: "README.md" }), "the native agent to run a tool");
    const approvals =
      (hasCapability(capabilities, "approvals.command") || hasCapability(capabilities, "approvals.fileChange")) &&
      hasCapability(capabilities, "requests.responseModes", "live") &&
      supervisedMode(capabilities) !== undefined;
    if (approvals) {
      const handle = await context.wait(
        first.native.requestApproval(
          approval(approvalKind(context, capabilities), [
            { optionId: "grammar-approve", label: "Approve", decision: "accept" },
            { optionId: "grammar-reject", label: "Reject", decision: "decline" },
          ]),
        ),
        "the native agent to ask for an approval",
      );
      const request = await pendingRequestOffering(context, opened, "grammar-approve");
      await context.wait(opened.session.respond({ requestId: request.id, responseKey: "grammar-1", optionId: "grammar-approve" }), "respond");
      await context.wait(handle.nextReply(), "the native agent to get the approval reply");
    }
    await context.wait(first.native.say("All done."), "the native agent to stream text");
    await context.wait(first.native.complete(), "the native agent to complete the turn");
    await context.terminal(opened, first.turnId);

    // A second turn the host stops.
    const second = await context.beginTurn(opened, rig, thread.id, "Start something long.");
    await context.wait(second.native.say("Starting."), "the native agent to stream text");
    const interrupting = opened.session.interruptTurn({ turnId: second.turnId });
    const stop = await context.wait(second.native.stopRequested(), "the native agent to be asked to stop");
    if (stop === "cancel") await context.wait(second.native.finishCancelled(), "the native agent to report the cancel");
    await context.wait(interrupting, "interruptTurn");
    await context.terminal(opened, second.turnId);
    await opened.close();

    const violations = context.suite.violations;
    if (violations.length > 0) {
      const shown = violations
        .slice(0, 5)
        .map(({ scenario, sessionId, violation }) => `${violation.reason} [${violation.rule}] at seq ${violation.event.seq} of session ${sessionId} in scenario ${scenario}`);
      context.fail(`${violations.length} stream(s) broke the event grammar: ${shown.join("; ")}`);
    }
    context.note(`${context.suite.streams} session stream(s) checked in strict mode`);
  },
};

export const completedScenario: Scenario = {
  id: 2,
  key: "turn-completed",
  title: "A turn ends by completion",
  async run(context: ScenarioContext) {
    const { rig, opened, thread } = await openThread(context);
    const { turnId, native } = await context.beginTurn(opened, rig, thread.id, "Say hello.");
    await context.wait(native.say("Hello there."), "the native agent to stream its reply");
    // Once the driver has reported the message as settled, the turn is still the provider's to end.
    await context.until(() => {
      for (const item of context.reduced(opened).items.values()) {
        if (item.kind === "assistant_message" && item.turnId === turnId && TERMINAL_ITEM_STATUSES.has(item.status)) return true;
      }
      return undefined;
    }, "the driver to report the assistant message as settled");
    context.check(
      opened.events.terminal(turnId) === undefined,
      `the driver settled turn ${turnId} when its assistant message ended, before the provider completed the turn`,
    );
    await context.wait(native.complete(), "the native agent to complete the turn");
    const terminal = await context.terminal(opened, turnId);
    context.check(terminal.status === "completed", `turn.terminal has status ${brief(terminal.status)} after the provider completed the turn; expected "completed"`);
    context.check(terminal.threadDisposition === "reusable", `a completed turn left the thread ${brief(terminal.threadDisposition)}; expected "reusable"`);
    const text = assistantText(context, opened, turnId);
    context.check(text === "Hello there.", `the turn's assistant text is ${brief(text)}; the provider said "Hello there."`);
    checkNothingLeftOpen(context, opened, turnId);
    await checkThreadReusable(context, opened, rig, thread.id, turnId, terminal);
  },
};

export const interruptedScenario: Scenario = {
  id: 3,
  key: "turn-interrupted",
  title: "A turn ends by interrupt (Stop)",
  async run(context: ScenarioContext) {
    const { rig, opened, thread } = await openThread(context);
    const { turnId, native } = await context.beginTurn(opened, rig, thread.id, "Write a long essay.");
    await context.wait(native.say("Once upon a time"), "the native agent to stream text");
    const interrupting = opened.session.interruptTurn({ turnId });
    const stop = await context.wait(native.stopRequested(), "the native agent to be asked to stop the turn");
    if (stop === "cancel") await context.wait(native.finishCancelled(), "the native agent to report the cancel");
    else context.note("the driver stopped the turn by ending the native process");
    await context.wait(interrupting, "interruptTurn");
    const terminal = await context.terminal(opened, turnId);
    context.check(terminal.status === "interrupted", `turn.terminal has status ${brief(terminal.status)} after Stop; expected "interrupted"`);
    checkNothingLeftOpen(context, opened, turnId);
    await checkThreadReusable(context, opened, rig, thread.id, turnId, terminal);
  },
};

export const failedScenario: Scenario = {
  id: 4,
  key: "turn-failed",
  title: "A turn ends by provider failure, with a failure class",
  async run(context: ScenarioContext) {
    const rig = await context.rig();
    const created = await context.instance(rig);
    {
      const opened = await context.openSession(created);
      const thread = await context.createThread(opened);
      const { turnId, native } = await context.beginTurn(opened, rig, thread.id, "Do the thing.");
      await context.wait(native.say("Working"), "the native agent to stream text");
      await context.wait(native.fail({ kind: "provider_error", message: "The provider had an internal error." }), "the native agent to fail the turn");
      const terminal = await context.terminal(opened, turnId);
      context.check(terminal.status === "failed", `turn.terminal has status ${brief(terminal.status)} after a provider error; expected "failed"`);
      context.check(terminal.failure !== undefined, "turn.terminal of a failed turn carries no failure");
      context.check(isFailure(terminal.failure), `turn.terminal's failure is not a valid Failure: ${brief(terminal.failure)}`);
      context.check(terminal.failure.class === "provider_error", `a provider error was classified as ${brief(terminal.failure.class)}; expected "provider_error"`);
      checkNothingLeftOpen(context, opened, turnId);
      await checkThreadReusable(context, opened, rig, thread.id, turnId, terminal);
      await opened.close();
    }
    if (context.skipCheck("turn-failed.usage_limit", "a usage-limit failure")) return;
    {
      const opened = await context.openSession(created);
      const thread = await context.createThread(opened);
      const resetAt = new Date(Math.ceil((Date.now() + 3_600_000) / 1000) * 1000).toISOString();
      const { turnId, native } = await context.beginTurn(opened, rig, thread.id, "Do another thing.");
      await context.wait(native.fail({ kind: "usage_limit", message: "You have reached your usage limit.", resetAt }), "the native agent to fail the turn on a usage limit");
      const terminal = await context.terminal(opened, turnId);
      context.check(terminal.status === "failed", `turn.terminal has status ${brief(terminal.status)} after a usage limit; expected "failed"`);
      context.check(isFailure(terminal.failure), `turn.terminal's failure is not a valid Failure: ${brief(terminal.failure)}`);
      context.check(terminal.failure.class === "usage_limit", `a usage limit was classified as ${brief(terminal.failure.class)}; expected "usage_limit"`);
      context.check(
        terminal.failure.resetAt !== undefined && Date.parse(terminal.failure.resetAt) === Date.parse(resetAt),
        `the usage-limit failure resets at ${brief(terminal.failure.resetAt)}; the provider said ${resetAt}`,
      );
      checkNothingLeftOpen(context, opened, turnId);
    }
  },
};

export const processExitScenario: Scenario = {
  id: 5,
  key: "process-exit",
  title: "A turn ends by process exit",
  async run(context: ScenarioContext) {
    const { rig, opened, thread } = await openThread(context);
    const { turnId, native } = await context.beginTurn(opened, rig, thread.id, "Run until you crash.");
    await context.wait(native.say("Running"), "the native agent to stream text");
    await context.wait(native.exitProcess(), "the native agent's process to exit");
    const terminal = await context.terminal(opened, turnId, `turn.terminal for turn ${turnId} after the native process exited`);
    context.check(terminal.status === "failed", `turn.terminal has status ${brief(terminal.status)} after the native process exited; expected "failed"`);
    context.check(isFailure(terminal.failure), `turn.terminal after a process exit carries no valid failure: ${brief(terminal.failure)}`);
    checkNothingLeftOpen(context, opened, turnId);
    await checkThreadReusable(context, opened, rig, thread.id, turnId, terminal);
  },
};

/** The pause the settlement scenario puts between a tool result and the completion: more than 36 seconds. */
export const SETTLEMENT_PAUSE_MS = 36_500;

export const settlementScenario: Scenario = {
  id: 6,
  key: "settlement",
  title: "Authoritative settlement: no turn.terminal during a pause of at least 36 seconds after a tool result",
  async run(context: ScenarioContext) {
    // The clock goes in before the rig exists, so a timer the driver makes at any point (at create, when the session opens) is on it.
    await context.withClock(async (clock) => {
      const { rig, opened, thread } = await openThread(context);
      const { turnId, native } = await context.beginTurn(opened, rig, thread.id, "Run the slow tool.");
      await context.wait(native.runTool({ name: "slow_tool", input: { seconds: 40 }, output: "slow tool finished" }), "the native agent to run a tool");
      await context.until(() => {
        const state = context.reduced(opened);
        for (const item of state.items.values()) {
          if (isToolItem(item) && TERMINAL_ITEM_STATUSES.has(item.status) && (item.turnId === turnId || item.turnId === undefined)) return true;
        }
        return undefined;
      }, "the driver to report the tool result as a settled item");

      const pauseStart = clock.now();
      await clock.pass(SETTLEMENT_PAUSE_MS);
      await realSleep(20);
      clock.tick();
      // Anything that settled the turn before the provider completed it, from the turn's start on.
      const early = opened.events.events.find((event) => {
        const body = event.body;
        if (body.type === "turn.terminal") return body.turnId === turnId;
        return body.type === "turn.upsert" && body.turn.id === turnId && ["completed", "failed", "interrupted", "cancelled"].includes(String(body.turn.status));
      });
      if (early !== undefined) {
        const offset = (Date.parse(early.at) - pauseStart) / 1000;
        const when = offset < 0.05 ? "as soon as the tool result arrived" : `about ${offset.toFixed(1)} s into a ${SETTLEMENT_PAUSE_MS / 1000} s pause after the tool result`;
        context.fail(`the driver settled turn ${turnId} (${early.body.type}) ${when}, before the provider completed it: settlement must come from the provider, never from a quiet timer`);
      }

      await context.wait(native.say("The slow tool is done."), "the native agent to stream text");
      await context.wait(native.complete(), "the native agent to complete the turn");
      const terminal = await context.terminal(opened, turnId);
      context.check(terminal.status === "completed", `turn.terminal has status ${brief(terminal.status)}; expected "completed"`);
      context.note(`${((clock.now() - pauseStart) / 1000).toFixed(1)} s of ${clock.mode} time passed between the tool result and the completion`);
    });
  },
};

export const steerAfterEndScenario: Scenario = {
  id: 7,
  key: "steer-after-end",
  title: "A steer that arrives after the turn ended returns prompt_required",
  async run(context: ScenarioContext) {
    const { rig, opened, thread } = await openThread(context);
    context.requireCapability(opened.capabilities(), "turns.steer");

    const first = await context.simpleTurn(opened, rig, thread.id, "First task.");
    const late = await context.startTurn(opened, thread.id, "Also check the tests.", { intent: "steer", expectedTurnId: first.turnId });
    context.check(late.status === "prompt_required", `a steer after turn ${first.turnId} ended returned ${brief(late)}; expected { status: "prompt_required" }`);

    // The race: the provider has ended the turn, but the driver has not heard yet when the steer arrives.
    // The driver still sees an active turn and steers it; the provider refuses; the host must get prompt_required.
    const second = await context.beginTurn(opened, rig, thread.id, "Second task.");
    await context.wait(second.native.say("Finishing."), "the native agent to stream text");
    const completeHeld = second.native.completeHeld?.bind(second.native);
    if (completeHeld === undefined) {
      if (!context.skipCheck("steer-after-end.race", "a steer that races the end of its turn")) {
        context.fail("the harness's native turn has no completeHeld; add it, or give a reason under steer-after-end.race");
      }
      await context.wait(second.native.complete(), "the native agent to complete the turn");
    } else {
      const held = await context.wait(completeHeld(), "the native agent to end the turn without telling the driver yet");
      const race = `a steer that raced the end of turn ${second.turnId} (the provider had ended it, the driver had not heard yet)`;
      let raced: StartTurnResult;
      try {
        raced = await context.startTurn(opened, thread.id, "A late steer.", { intent: "steer", expectedTurnId: second.turnId });
      } catch (error) {
        context.fail(`${race} failed with ${describeError(error)}; expected { status: "prompt_required" }`);
      }
      context.check(raced.status === "prompt_required", `${race} returned ${brief(raced)}; expected { status: "prompt_required" }`);
      await context.wait(held.release(), "the native agent to report the completion it held back");
    }
    await context.terminal(opened, second.turnId);

    // No untracked turn: the next prompt the provider sees is the host's own start.
    const third = await context.beginTurn(opened, rig, thread.id, "Third task.");
    for (const steerText of ["Also check the tests.", "A late steer."]) {
      context.check(!third.native.prompt.includes(steerText), `the provider received the refused steer ${brief(steerText)} as a turn`);
    }
    await context.wait(third.native.complete(), "the native agent to complete the turn");
    await context.terminal(opened, third.turnId);
    const known = new Set([first.turnId, second.turnId, third.turnId]);
    const untracked = opened.events.filter((event) => event.body.type === "turn.upsert" && !known.has(event.body.turn.id));
    context.check(untracked.length === 0, `the driver started turns the host never asked for: ${untracked.map((event) => (event.body as { turn: { id: string } }).turn.id).join(", ")}`);
  },
};
