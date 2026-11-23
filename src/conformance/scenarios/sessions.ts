// Scenarios 9, 11 and 13: resuming native sessions, a workspace reached
// through a symbolic link, and replaying events from a sequence number.

import { toCallError } from "../../errors.ts";
import type { NativeRef } from "../../generated/common.ts";
import type { AriEvent, SessionReplacedBody } from "../../generated/events.ts";
import type { ResumeThreadInput } from "../../generated/session.ts";
import type { Thread } from "../../generated/thread.ts";
import type { CreatedInstance, OpenedSession, ScenarioContext } from "../context.ts";
import type { HarnessRig } from "../harness.ts";
import { brief, sameJson } from "../util.ts";
import type { Scenario } from "./scenario.ts";

/** How to name a thread's native session in `resumeThread`: its handle when it has one, else its native reference. */
function resumeTarget(thread: Thread): ResumeThreadInput["native"] {
  return thread.handle !== undefined ? { handle: thread.handle } : thread.native;
}

/** A call error as `code: message`, or the error's message. */
export function describeError(error: unknown): string {
  const callError = toCallError(error);
  if (callError !== undefined) return `${callError.code}: ${callError.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Runs one turn on `threadId`, failing with `what` and the reason when the thread cannot run it. */
export async function checkRunsTurn(context: ScenarioContext, opened: OpenedSession, rig: HarnessRig<unknown>, threadId: string, what: string): Promise<void> {
  let status: string;
  try {
    status = (await context.simpleTurn(opened, rig, threadId, "What do you know so far?")).terminal.status;
  } catch (error) {
    context.fail(`${what} could not run a turn: ${describeError(error)}`);
  }
  context.check(status === "completed", `${what} ended a turn ${brief(status)}`);
}

async function expectReplaced(
  context: ScenarioContext,
  rig: HarnessRig<unknown>,
  created: CreatedInstance,
  native: ResumeThreadInput["native"],
  cwd: string,
  previousIds: ReadonlyArray<string | null | undefined>,
  what: string,
): Promise<void> {
  const opened = await context.openSession(created);
  const policy = context.policy(opened.capabilities(), cwd);
  let thread: Thread;
  try {
    thread = await context.wait(opened.session.resumeThread({ native, policy }), `resumeThread of a ${what} native session`);
  } catch (error) {
    context.fail(
      `resumeThread of a ${what} native session rejected (${describeError(error)}) instead of falling back to a fresh native session and emitting session.replaced with contextLost: true`,
    );
  }
  const replaced = await context.until(
    () => opened.events.find((event) => event.body.type === "session.replaced"),
    `session.replaced after resuming a ${what} native session (the driver returned thread ${thread.id})`,
  );
  const body = replaced.body as SessionReplacedBody;
  context.check(body.contextLost === true, `session.replaced after resuming a ${what} native session has contextLost ${brief(body.contextLost)}; the old context is gone, so it must be true`);
  if (body.previousNativeId !== undefined) {
    context.check(previousIds.includes(body.previousNativeId), `session.replaced names previousNativeId ${brief(body.previousNativeId)}; the host asked to resume ${brief(previousIds.filter((id) => id))}`);
  }
  const asked = "id" in native ? native.id : null;
  context.check(asked === null || thread.native.id !== asked, `the fresh thread claims the ${what} native session's id ${brief(asked)}`);
  // The event is not the result: the replacement must be a thread the host can use.
  await checkRunsTurn(context, opened, rig, thread.id, `the replacement thread ${thread.id} after resuming a ${what} native session`);
  await opened.close();
}

export const sessionReplacedScenario: Scenario = {
  id: 9,
  key: "session-replaced",
  title: "Resuming a locked or missing native session emits session.replaced with contextLost: true",
  async run(context: ScenarioContext) {
    const rig = await context.rig();
    const created = await context.instance(rig);
    const first = await context.openSession(created);
    const thread = await context.createThread(first);
    await context.simpleTurn(first, rig, thread.id, "Remember the number 7.");
    await first.close();

    // A resume that can succeed keeps the thread and replaces nothing.
    const normal = await context.openSession(created);
    const resumed = await context.wait(
      normal.session.resumeThread({ native: resumeTarget(thread), policy: context.policy(normal.capabilities(), thread.cwd) }),
      "resumeThread of an available native session",
    );
    context.check(resumed.id === thread.id, `resuming thread ${thread.id} returned thread ${resumed.id}`);
    context.check(
      normal.events.find((event) => event.body.type === "session.replaced") === undefined,
      "resuming an available native session emitted session.replaced",
    );
    await checkRunsTurn(context, normal, rig, resumed.id, `the thread ${resumed.id} resumed from an available native session`);
    await normal.close();

    const previousIds = [thread.native.id, thread.handle];
    if (rig.native.lockSession === undefined) {
      if (!context.skipCheck("session-replaced.locked", "resuming a locked native session")) {
        context.fail("the harness's native agent has no lockSession; add it, or give a reason under session-replaced.locked");
      }
    } else {
      await context.wait(rig.native.lockSession(thread), "the native agent to lock the session");
      await expectReplaced(context, rig, created, resumeTarget(thread), thread.cwd, previousIds, "locked");
    }

    const missing: ResumeThreadInput["native"] = rig.missingSession ?? ({ id: "ari-conformance-missing-session", strength: "strong" } satisfies NativeRef);
    const missingIds = "handle" in missing ? [missing.handle] : [missing.id];
    await expectReplaced(context, rig, created, missing, context.workspace.cwd, missingIds, "missing");
  },
};

/** The ids and paths an event carries, for comparing two runs. */
function idsAndPaths(event: AriEvent): unknown {
  const body = event.body;
  const projection: { [key: string]: unknown } = { type: body.type, threadId: event.threadId, turnId: event.turnId };
  switch (body.type) {
    case "thread.upsert":
      projection["thread"] = { id: body.thread.id, cwd: body.thread.cwd, parentThreadId: body.thread.parentThreadId, subagentId: body.thread.subagentId };
      break;
    case "turn.upsert":
      projection["turn"] = { id: body.turn.id, threadId: body.turn.threadId, parentTurnId: body.turn.parentTurnId };
      break;
    case "item.upsert":
      projection["item"] = {
        id: body.item.id,
        turnId: body.item.turnId,
        parentItemId: body.item.parentItemId,
        cwd: body.item.cwd,
        paths: body.item.paths,
        changes: body.item.changes?.map((change) => ({ path: change.path, oldPath: change.oldPath })),
      };
      break;
    case "item.delta":
      projection["itemId"] = body.itemId;
      break;
    case "request.upsert":
      projection["request"] = { id: body.request.id, origin: body.request.origin, cwd: body.request.subject?.cwd, paths: body.request.subject?.paths };
      break;
    case "subagent.upsert":
      projection["subagent"] = { id: body.subagent.id, parentThreadId: body.subagent.parentThreadId, threadId: body.subagent.threadId };
      break;
    case "plan.upsert":
      projection["plan"] = { id: body.plan.id };
      break;
    case "turn.terminal":
      projection["settled"] = body.turnId;
      break;
    default:
      break;
  }
  return projection;
}

async function runInWorkspace(context: ScenarioContext, cwd: string): Promise<{ thread: Thread; projection: unknown[]; paths: string[] }> {
  const rig = await context.rig();
  const created = await context.instance(rig, { instanceId: "conformance-symlinked-workspace" });
  const opened = await context.openSession(created);
  const thread = await context.createThread(opened, { cwd });
  const { turnId, native } = await context.beginTurn(opened, rig, thread.id, "Read the README.");
  await context.wait(native.runTool({ name: "read_file", input: { path: "README.md" }, output: "# Workspace", path: "README.md" }), "the native agent to run a tool");
  await context.wait(native.say("It is a workspace."), "the native agent to stream text");
  await context.wait(native.complete(), "the native agent to complete the turn");
  await context.terminal(opened, turnId);
  await opened.close();
  const paths = opened.events.events.flatMap((event) => (event.body.type === "item.upsert" ? [...(event.body.item.paths ?? [])] : []));
  return { thread, projection: opened.events.events.map(idsAndPaths), paths };
}

export const symlinkedWorkspaceScenario: Scenario = {
  id: 11,
  key: "symlinked-workspace",
  title: "A workspace reached through a symlink gives the same IDs and paths as its real path",
  async run(context: ScenarioContext) {
    const link = context.workspace.symlinkedCwd;
    if (link === undefined) context.fail("the harness's workspace has no symlinkedCwd; give one, or a reason under symlinked-workspace");
    const real = await runInWorkspace(context, context.workspace.cwd);
    // Equal ids and paths prove nothing if the driver ignored the directory both times: the thread must be where the host asked.
    context.check(real.thread.cwd === context.workspace.cwd, `the thread created in ${context.workspace.cwd} reports cwd ${real.thread.cwd}; the host asked for ${context.workspace.cwd}`);
    // A driver whose provider reports no tool paths has none to check here.
    const outside = real.paths.filter((path) => !path.startsWith(`${context.workspace.cwd}/`));
    context.check(outside.length === 0, `the tool that read README.md in ${context.workspace.cwd} reported paths ${brief(outside)} outside it`);
    const viaLink = await runInWorkspace(context, link);
    context.check(viaLink.thread.id === real.thread.id, `the thread created in ${link} has id ${viaLink.thread.id}; through the real path ${context.workspace.cwd} it is ${real.thread.id}`);
    context.check(viaLink.thread.cwd === real.thread.cwd, `the thread created in ${link} reports cwd ${viaLink.thread.cwd}; through the real path it reports ${real.thread.cwd}`);
    const length = Math.max(real.projection.length, viaLink.projection.length);
    for (let index = 0; index < length; index += 1) {
      if (!sameJson(real.projection[index], viaLink.projection[index])) {
        context.fail(
          `event ${index + 1} differs between the real path and the symlinked path: ${brief(real.projection[index])} against ${brief(viaLink.projection[index])}`,
        );
      }
    }
    context.note(`compared ${length} events' ids and paths between ${context.workspace.cwd} and ${link}`);
  },
};

async function take(context: ScenarioContext, iterator: AsyncIterator<AriEvent>, count: number, what: string): Promise<AriEvent[]> {
  const events: AriEvent[] = [];
  while (events.length < count) {
    const result = await context.wait(iterator.next(), `${what} (${events.length} of ${count} events read)`);
    if (result.done === true) context.fail(`${what} ended after ${events.length} of ${count} events`);
    events.push(result.value);
  }
  return events;
}

function compareEvents(context: ScenarioContext, expected: readonly AriEvent[], actual: readonly AriEvent[], fromSeq: number): void {
  for (let index = 0; index < expected.length; index += 1) {
    if (!sameJson(expected[index], actual[index])) {
      context.fail(`events({ fromSeq: ${fromSeq} }) gave ${brief(actual[index])} where the live stream had ${brief(expected[index])}`);
    }
  }
}

export const replayFromSeqScenario: Scenario = {
  id: 13,
  key: "replay-from-seq",
  title: "Reconnecting with fromSeq gives identical events and IDs",
  async run(context: ScenarioContext) {
    const rig = await context.rig();
    const created = await context.instance(rig);
    const opened = await context.openSession(created);
    const thread = await context.createThread(opened);
    const { turnId, native } = await context.beginTurn(opened, rig, thread.id, "Explain the code.");
    await context.wait(native.say("First, the parser. "), "the native agent to stream text");
    await context.wait(native.runTool({ name: "read_file", input: { path: "src/parser.ts" }, output: "export function parse() {}", path: "src/parser.ts" }), "the native agent to run a tool");
    await context.wait(native.say("Then the printer."), "the native agent to stream text");
    await context.wait(native.complete(), "the native agent to complete the turn");
    await context.terminal(opened, turnId);

    const live = [...opened.events.events];
    const whole = opened.session.events({ fromSeq: 1 })[Symbol.asyncIterator]();
    compareEvents(context, live, await take(context, whole, live.length, "events({ fromSeq: 1 })"), 1);
    void whole.return?.();

    const middle = Math.floor(live.length / 2) + 1;
    const fromMiddle = opened.session.events({ fromSeq: middle })[Symbol.asyncIterator]();
    compareEvents(context, live.slice(middle - 1), await take(context, fromMiddle, live.length - middle + 1, `events({ fromSeq: ${middle} })`), middle);

    // The replayed stream goes on live with the same events as the original stream.
    await context.simpleTurn(opened, rig, thread.id, "Continue.");
    const later = opened.events.events.slice(live.length);
    compareEvents(context, later, await take(context, fromMiddle, later.length, `events({ fromSeq: ${middle} }) after the replay`), live.length + 1);
    void fromMiddle.return?.();
    context.note(`replayed ${live.length} events from seq 1 and ${live.length - middle + 1} from seq ${middle}, then ${later.length} live`);
  },
};
