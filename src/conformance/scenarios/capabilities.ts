// Scenario 14: capability honesty. For each capability-gated Session member
// (the `capability` fields of spec/v1/methods.json, the two the capability
// guard adds, the fork variants and the startTurn intents), a member the
// driver declares off must reject with `unsupported{capability}` (or be left
// out), and a member it declares on must work. The kit calls the driver's
// own session, without `ari/host`'s guard in front, because the driver itself
// must be honest.
//
// "Works" means the member had its effect, and its result is the one the
// native side produced: a well-shaped answer that did nothing fails. Where
// the effect shows on the ARI side, the kit checks it there: a snapshot holds
// the turns that ran, a fork runs a turn, an awaited task matches. Where only
// the native side can show it, the harness reads it: the native session
// with `NativeAgent.inspectSession` (a fork's history and directory,
// compaction, injected history, rollback, unload, release, stopped tasks and
// subagents), and what the agent served with `NativeAgent.activity`
// (feedback uploads, MCP app calls, extension calls). docs/conformance.md
// lists the checks that still rest on shape alone, with the reason.

import { hasCapability } from "../../capabilities.ts";
import { toCallError } from "../../errors.ts";
import type { Capabilities } from "../../generated/capabilities.ts";
import type { AppliedThread } from "../../generated/session.ts";
import type { Thread } from "../../generated/thread.ts";
import {
  AwaitBackgroundTasksResultSchema,
  InjectHistoryResultSchema,
  McpCallResultSchema,
  McpResourceContentsSchema,
  McpToolSchema,
  UploadFeedbackResultSchema,
} from "../../generated/session.ts";
import { SubagentOutcomeSchema } from "../../generated/subagent.ts";
import { TaskInfoSchema } from "../../generated/background.ts";
import { ThreadSchema, ThreadSnapshotSchema } from "../../generated/thread.ts";
import type { Session } from "../../runtime.ts";
import type { OpenedSession, ScenarioContext } from "../context.ts";
import type { HarnessRig, NativeActivity, NativeTurn } from "../harness.ts";
import { canonicalJson } from "../../driver-kit/ids.ts";
import { brief, sameJson } from "../util.ts";
import { checkRunsTurn, describeError, inspectOrReason, nativeSession } from "./sessions.ts";
import type { InspectSession } from "./sessions.ts";
import type { Scenario } from "./scenario.ts";

/**
 * The gated Session members the scenario checks, with the capability paths
 * that gate each. A member is on when every path is on. Kept in step with
 * spec/v1/methods.json by a committed test.
 */
export const GATED_MEMBERS: ReadonlyArray<{ readonly member: string; readonly capabilities: readonly string[] }> = [
  { member: "readSnapshot", capabilities: ["threads.readSnapshot"] },
  { member: "forkThread", capabilities: ["threads.fork"] },
  { member: "rollbackThread", capabilities: ["threads.rollback", "checkpointing.conversationRollback"] },
  { member: "compactThread", capabilities: ["threads.compact"] },
  { member: "injectHistory", capabilities: ["threads.injectHistory"] },
  { member: "unloadThread", capabilities: ["threads.unload"] },
  { member: "release", capabilities: ["sessions.release"] },
  { member: "backgroundTasks.list", capabilities: ["background.list"] },
  { member: "backgroundTasks.stop", capabilities: ["background.stop"] },
  { member: "backgroundTasks.await", capabilities: ["background.await"] },
  { member: "stopSubagent", capabilities: ["subagents.stop"] },
  { member: "mcpApps.listTools", capabilities: ["tools.mcpApps"] },
  { member: "mcpApps.callTool", capabilities: ["tools.mcpApps"] },
  { member: "mcpApps.readResource", capabilities: ["tools.mcpApps"] },
  { member: "contextWindow", capabilities: ["contextWindowReporting"] },
  { member: "canReuseContextUsage", capabilities: ["sessions.contextUsageReuse"] },
  { member: "uploadFeedback", capabilities: ["sessions.feedbackUpload"] },
  { member: "ext", capabilities: ["extensions"] },
];

/** Members of `session` by dotted path; undefined when the member or its group is left out. */
function memberOf(session: Session, member: string): unknown {
  let node: unknown = session;
  for (const segment of member.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as { [key: string]: unknown })[segment];
  }
  return node;
}

/** What the scenario found for each member, for the report's note. */
class Tally {
  readonly works: string[] = [];
  readonly rejects: string[] = [];
  readonly absent: string[] = [];
  /** Declared on, but not exercised for a harness reason the notes give. */
  readonly skipped: string[] = [];
}

/** What an `on` check returns when a harness reason kept it from exercising the member. */
const SKIPPED = "skipped";

/** Fails unless `call` rejects (or throws, or resolves to the startTurn variant) with `unsupported` naming one of `accepted`. */
async function expectUnsupported(context: ScenarioContext, what: string, accepted: readonly string[], call: () => unknown): Promise<void> {
  let outcome: unknown;
  try {
    outcome = await context.wait(Promise.resolve().then(call), what);
  } catch (error) {
    const callError = toCallError(error);
    if (callError?.code === "unsupported" && accepted.includes(callError.capability)) return;
    context.fail(`${what}: the driver declares ${accepted.join(" or ")} off, and the call failed with ${describeError(error)} instead of unsupported{capability: "${accepted[0]}"}`);
  }
  const result = outcome as { status?: unknown; capability?: unknown } | undefined;
  if (result?.status === "unsupported" && typeof result.capability === "string" && accepted.includes(result.capability)) return;
  context.fail(`${what}: the driver declares ${accepted.join(" or ")} off, but the call returned ${brief(outcome)}; it must reject with unsupported{capability: "${accepted[0]}"}`);
}

/** Fails when `call` rejects or its result fails `valid`. */
async function expectWorks<T>(context: ScenarioContext, what: string, path: string, call: () => Promise<T> | T, valid?: (value: T) => string | undefined): Promise<T> {
  let value: T;
  try {
    value = await context.wait(Promise.resolve().then(call), what);
  } catch (error) {
    context.fail(`${what}: the driver declares ${path} on, but the call failed: ${describeError(error)}`);
  }
  const problem = valid?.(value);
  if (problem !== undefined) context.fail(`${what}: ${problem}`);
  return value;
}

function schemaCheck(schema: { is(value: unknown): boolean; name: string }): (value: unknown) => string | undefined {
  return (value) => (schema.is(value) ? undefined : `the result is not a valid ${schema.name}: ${brief(value)}`);
}

interface Checker {
  readonly context: ScenarioContext;
  readonly opened: OpenedSession;
  readonly capabilities: Capabilities;
  readonly tally: Tally;
}

/** Runs the off or on check for one gated member. `off` gets the paths it may name. */
async function checkMember(
  checker: Checker,
  member: string,
  paths: readonly string[],
  off: () => unknown,
  on: () => Promise<void | typeof SKIPPED>,
): Promise<void> {
  const { opened, capabilities, tally } = checker;
  const context: ScenarioContext = checker.context;
  const isOn = paths.every((path) => hasCapability(capabilities, path));
  const present = memberOf(opened.session, member) !== undefined;
  if (isOn) {
    context.check(present, `the driver declares ${paths.join(" and ")} on but leaves out ${member}`);
    if ((await on()) === SKIPPED) tally.skipped.push(member);
    else tally.works.push(member);
    return;
  }
  if (!present) {
    tally.absent.push(member);
    return;
  }
  await expectUnsupported(context, member, paths, off);
  tally.rejects.push(member);
}

/** Skips a check for a harness reason, or fails because the harness lacks what the check needs. */
function needs(context: ScenarioContext, key: string, what: string, missing: string): boolean {
  if (context.skipCheck(key, what)) return false;
  context.fail(`${what} cannot be checked: ${missing}; add it to the harness, or give a reason under ${key}`);
}

async function checkIntents(checker: Checker, rig: HarnessRig<unknown>, thread: AppliedThread, active: { turnId: string; native: NativeTurn }): Promise<string | undefined> {
  const { opened, capabilities, tally } = checker;
  const context: ScenarioContext = checker.context;
  let queuedTurnId: string | undefined;

  if (hasCapability(capabilities, "turns.steer")) {
    if (active.native.nextSteer === undefined) {
      needs(context, "capability-honesty.turns.steer", "steering", "the native turn has no nextSteer");
      tally.skipped.push("startTurn steer");
    } else {
      const steered = active.native.nextSteer();
      const result = await context.startTurn(opened, thread.id, "Also add tests.", { intent: "steer", expectedTurnId: active.turnId });
      context.check(result.status === "accepted", `startTurn steer: the driver declares turns.steer on, but steering an active turn returned ${brief(result)}`);
      // The host files the steer under the turn id it gets back, so it must be the steered turn's.
      context.check(
        result.turnId === active.turnId && result.accepted === "steered",
        `startTurn steer: steering turn ${active.turnId} returned ${brief(result)}; expected the steered turn's id with accepted "steered"`,
      );
      const text = await context.wait(steered, "the native agent to receive the steer");
      context.check(text.includes("Also add tests."), `the provider received steer text ${brief(text)}; the host sent "Also add tests."`);
      tally.works.push("startTurn steer");
    }
  } else {
    await expectUnsupported(context, "startTurn steer", ["turns.steer"], () =>
      opened.session.startTurn({ threadId: thread.id, clientTurnKey: context.unique("steer-off"), intent: "steer", expectedTurnId: active.turnId, content: [{ type: "text", text: "Steer." }] }),
    );
    tally.rejects.push("startTurn steer");
  }

  if (hasCapability(capabilities, "turns.queue")) {
    const result = await context.startTurn(opened, thread.id, "Queued follow-up.", { intent: "queue" });
    context.check(result.status === "accepted", `startTurn queue: the driver declares turns.queue on, but queueing behind an active turn returned ${brief(result)}`);
    context.check(result.accepted === "queued", `startTurn queue: queueing behind the active turn ${active.turnId} returned ${brief(result)}; expected accepted "queued"`);
    queuedTurnId = result.turnId;
    tally.works.push("startTurn queue");
  } else {
    await expectUnsupported(context, "startTurn queue", ["turns.queue"], () =>
      opened.session.startTurn({ threadId: thread.id, clientTurnKey: context.unique("queue-off"), intent: "queue", content: [{ type: "text", text: "Queued." }] }),
    );
    tally.rejects.push("startTurn queue");
  }
  return queuedTurnId;
}

/** Capabilities whose effect only the native session shows; declaring one needs `NativeAgent.inspectSession` or a harness reason. */
const NATIVE_EFFECT_CAPABILITIES = [
  "threads.fork",
  "threads.compact",
  "threads.injectHistory",
  "threads.rollback",
  "threads.unload",
  "sessions.release",
  "background.stop",
  "subagents.stop",
];

/** Subagent statuses that mean the subagent is no longer working. */
const SETTLED_SUBAGENT_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** The background task and the subagent the kit starts in the first turn. */
const TASK_TITLE = "watch the tests";
const SUBAGENT_NAME = "reviewer";

/** How a thread names its native session: its handle, else its native id. */
function nativeKey(thread: Thread): string {
  return thread.handle ?? thread.native.id ?? `ari:${thread.id}`;
}

/** The entries of `after` that `before` does not account for, one for one by equal JSON: what was served in between. */
function newEntries<T>(before: readonly T[], after: readonly T[]): T[] {
  const unmatched = before.map((entry) => canonicalJson(entry));
  const fresh: T[] = [];
  for (const entry of after) {
    const index = unmatched.indexOf(canonicalJson(entry));
    if (index === -1) fresh.push(entry);
    else unmatched.splice(index, 1);
  }
  return fresh;
}

export const capabilityHonestyScenario: Scenario = {
  id: 14,
  key: "capability-honesty",
  title: "Capability honesty: each gated method the driver declares unsupported returns unsupported{capability}; each it declares supported works",
  async run(context: ScenarioContext) {
    const rig = await context.rig();
    const created = await context.instance(rig);
    const opened = await context.openSession(created);
    const capabilities = opened.capabilities();
    const session = opened.session;
    const tally = new Tally();
    const checker: Checker = { context, opened, capabilities, tally };
    const thread = await context.createThread(opened);

    // Effects only the native side shows need the harness to read it.
    const inspect: InspectSession | undefined = NATIVE_EFFECT_CAPABILITIES.some((path) => hasCapability(capabilities, path))
      ? inspectOrReason(
          context,
          rig,
          "capability-honesty.native-effects",
          "the native effects of thread operations (fork history and directory, compaction, injected history, rollback, unload, release, stopped tasks and subagents)",
        )
      : rig.native.inspectSession?.bind(rig.native);
    const activity = rig.native.activity?.bind(rig.native);
    if (activity === undefined && (hasCapability(capabilities, "sessions.feedbackUpload") || hasCapability(capabilities, "tools.mcpApps") || capabilities.extensions.length > 0)) {
      needs(context, "capability-honesty.native-activity", "what the native agent served for feedback uploads, MCP apps and extensions", "the native agent has no activity");
    }
    /** Runs `call` and returns its value with what the native agent served meanwhile; `served` is undefined without `activity`. */
    const during = async <T>(call: () => Promise<T>): Promise<{ value: T; served: NativeActivity | undefined }> => {
      const before = activity === undefined ? undefined : await context.wait(activity(), "the native agent's activity");
      const value = await call();
      if (activity === undefined || before === undefined) return { value, served: undefined };
      const after = await context.wait(activity(), "the native agent's activity");
      return { value, served: { feedback: newEntries(before.feedback, after.feedback), mcp: newEntries(before.mcp, after.mcp), extensions: newEntries(before.extensions, after.extensions) } };
    };

    // A turn kept open for the steer and queue intents, background work and a subagent.
    const active = await context.beginTurn(opened, rig, thread.id, "Start the build.");
    await context.wait(active.native.say("Building."), "the native agent to stream text");
    const wantsTask = ["background.list", "background.stop", "background.await"].some((path) => hasCapability(capabilities, path));
    let taskStarted = false;
    if (wantsTask) {
      if (active.native.startBackgroundTask === undefined) needs(context, "capability-honesty.background", "background tasks", "the native turn has no startBackgroundTask");
      else {
        await context.wait(active.native.startBackgroundTask({ title: TASK_TITLE }), "the native agent to start background work");
        taskStarted = true;
      }
    }
    let subagentId: string | undefined;
    if (hasCapability(capabilities, "subagents.stop")) {
      if (active.native.spawnSubagent === undefined) needs(context, "capability-honesty.stopSubagent", "stopping a subagent", "the native turn has no spawnSubagent");
      else {
        await context.wait(active.native.spawnSubagent({ name: SUBAGENT_NAME }), "the native agent to spawn a subagent");
        subagentId = await context.until(() => {
          for (const subagent of context.reduced(opened).subagents.values()) return subagent.id;
          return undefined;
        }, "subagent.upsert for the native subagent");
      }
    }
    const queuedTurnId = await checkIntents(checker, rig, thread, active);
    await context.wait(active.native.complete(), "the native agent to complete the turn");
    await context.terminal(opened, active.turnId);
    if (queuedTurnId !== undefined) {
      const queued = await context.wait(rig.native.nextTurn(), "the native agent to start the queued turn");
      context.check(queued.prompt.includes("Queued follow-up."), `the provider started ${brief(queued.prompt)} where the queued prompt was "Queued follow-up."`);
      await context.wait(queued.complete(), "the native agent to complete the queued turn");
      await context.terminal(opened, queuedTurnId, `turn.terminal for the queued turn ${queuedTurnId}`);
    }
    // Three turns on the thread, so a fork from the second has history before it, the turn itself, and a turn after it.
    const secondPrompt = queuedTurnId === undefined ? "Second task." : "Queued follow-up.";
    const secondTurnId = queuedTurnId ?? (await context.simpleTurn(opened, rig, thread.id, secondPrompt)).turnId;
    const thirdTurnId = (await context.simpleTurn(opened, rig, thread.id, "Third task.")).turnId;
    const ranTurnIds = [active.turnId, secondTurnId, thirdTurnId];
    const promptOf = new Map([
      [active.turnId, "Start the build."],
      [secondTurnId, secondPrompt],
      [thirdTurnId, "Third task."],
    ]);
    const state = context.reduced(opened);
    const itemId = [...state.items.values()].find((item) => item.turnId === secondTurnId)?.id ?? "ari-conformance-item";

    // Background tasks and subagents.
    const tasks = session.backgroundTasks;
    let listedTaskId: string | undefined;
    /** The running task's id: from the list when the driver lists tasks, else from its background.updated events. */
    const knownTaskId = (): string | undefined => listedTaskId ?? context.reduced(opened).backgroundTasks[0]?.id;
    /** The task to exercise, or SKIPPED for a harness reason. */
    const exercisedTask = (): string | typeof SKIPPED => {
      if (!taskStarted) return SKIPPED;
      const taskId = knownTaskId();
      if (taskId !== undefined) return taskId;
      needs(context, "capability-honesty.background", "background tasks", "background.list is off and no background.updated event named the running task");
      return SKIPPED;
    };
    await checkMember(
      checker,
      "backgroundTasks.list",
      ["background.list"],
      () => tasks!.list(thread.id),
      async () => {
        const listed = await expectWorks(context, "backgroundTasks.list", "background.list", () => tasks!.list(thread.id), (value) =>
          Array.isArray(value) && value.every((task) => TaskInfoSchema.is(task)) ? undefined : `not a list of TaskInfo: ${brief(value)}`,
        );
        if (!taskStarted) return SKIPPED;
        context.check(listed.length > 0, "backgroundTasks.list returned no task while the native agent runs background work");
        listedTaskId = listed[0]!.id;
        return undefined;
      },
    );
    await checkMember(
      checker,
      "backgroundTasks.await",
      ["background.await"],
      () => tasks!.await({ threadId: thread.id, taskIds: [knownTaskId() ?? "ari-conformance-task"], awaited: true }),
      async () => {
        const taskId = exercisedTask();
        if (taskId === SKIPPED) return SKIPPED;
        const result = await expectWorks(
          context,
          "backgroundTasks.await",
          "background.await",
          () => tasks!.await({ threadId: thread.id, taskIds: [taskId], awaited: true }),
          schemaCheck(AwaitBackgroundTasksResultSchema),
        );
        context.check(result.matched.includes(taskId), `backgroundTasks.await: matched ${brief(result.matched)}; the host awaited the running task ${taskId}`);
        return undefined;
      },
    );
    await checkMember(
      checker,
      "backgroundTasks.stop",
      ["background.stop"],
      () => tasks!.stop({ threadId: thread.id, taskId: knownTaskId() ?? "ari-conformance-task" }),
      async () => {
        const taskId = exercisedTask();
        if (taskId === SKIPPED) return SKIPPED;
        await expectWorks(context, "backgroundTasks.stop", "background.stop", () => tasks!.stop({ threadId: thread.id, taskId }));
        if (hasCapability(capabilities, "background.list")) {
          const after = await context.wait(tasks!.list(thread.id), "backgroundTasks.list after backgroundTasks.stop");
          const still = after.find((task) => task.id === taskId);
          context.check(still === undefined || still.status !== "running", `backgroundTasks.stop: task ${taskId} still runs after stop: ${brief(still)}`);
        } else {
          await context.until(
            () => !context.reduced(opened).backgroundTasks.some((task) => task.id === taskId),
            `background task ${taskId} to leave the running tasks after backgroundTasks.stop`,
          );
        }
        if (inspect !== undefined) {
          const native = await nativeSession(context, inspect, thread, "backgroundTasks.stop");
          const task = native.backgroundTasks.find((entry) => entry.title === TASK_TITLE);
          context.check(task !== undefined, `backgroundTasks.stop: the native agent reports no background task ${brief(TASK_TITLE)}; it has ${brief(native.backgroundTasks)}`);
          context.check(!task.running, `backgroundTasks.stop: the native agent still runs ${brief(TASK_TITLE)} after stop`);
        }
        return undefined;
      },
    );
    await checkMember(
      checker,
      "stopSubagent",
      ["subagents.stop"],
      () => session.stopSubagent!({ subagentId: subagentId ?? "ari-conformance-subagent" }),
      async () => {
        if (subagentId === undefined) return SKIPPED;
        const stopping = subagentId;
        await expectWorks(context, "stopSubagent", "subagents.stop", () => session.stopSubagent!({ subagentId: stopping }), (value) =>
          value === undefined || value === null || SubagentOutcomeSchema.is(value) ? undefined : `not a SubagentOutcome: ${brief(value)}`,
        );
        await context.until(
          () => SETTLED_SUBAGENT_STATUSES.has(String(context.reduced(opened).subagents.get(stopping)?.status)),
          `subagent ${stopping} to stop after stopSubagent (its status to become completed, failed, cancelled or interrupted)`,
        );
        if (inspect !== undefined) {
          const native = await nativeSession(context, inspect, thread, "stopSubagent");
          const subagent = native.subagents.find((entry) => entry.name === SUBAGENT_NAME);
          context.check(subagent !== undefined, `stopSubagent: the native agent reports no subagent ${brief(SUBAGENT_NAME)}; it has ${brief(native.subagents)}`);
          context.check(!subagent.running, `stopSubagent: the native agent still runs subagent ${brief(SUBAGENT_NAME)} after stopSubagent`);
        }
        return undefined;
      },
    );

    // Thread operations on the finished turns.
    await checkMember(
      checker,
      "readSnapshot",
      ["threads.readSnapshot"],
      () => session.readSnapshot!(thread.id),
      async () => {
        const snapshot = await expectWorks(context, "readSnapshot", "threads.readSnapshot", () => session.readSnapshot!(thread.id), schemaCheck(ThreadSnapshotSchema));
        context.check(snapshot.thread.id === thread.id, `readSnapshot(${thread.id}) returned thread ${snapshot.thread.id}`);
        const missing = ranTurnIds.filter((turnId) => !snapshot.turns.some((turn) => turn.id === turnId));
        context.check(missing.length === 0, `readSnapshot: the snapshot of thread ${thread.id} lacks turn${missing.length === 1 ? "" : "s"} ${missing.join(", ")} that ran on it`);
        // The turns' content is part of the snapshot too: each turn's prompt is in one of its items.
        for (const [turnId, prompt] of promptOf) {
          const carried = snapshot.items.some((item) => item.turnId === turnId && typeof item.text === "string" && item.text.includes(prompt));
          context.check(carried, `readSnapshot: the snapshot of thread ${thread.id} has no item carrying the prompt ${brief(prompt)} of turn ${turnId}`);
        }
      },
    );

    // Forks: each is a new thread on its own native session that carries the source's history, and runs a turn.
    const sourceKey = nativeKey(thread);
    let sourcePrompts: readonly string[] = [];
    if (inspect !== undefined && hasCapability(capabilities, "threads.fork")) {
      sourcePrompts = (await nativeSession(context, inspect, thread, "the source thread of the forks")).prompts;
      context.check(sourcePrompts.length === ranTurnIds.length, `the native agent reports the prompts ${brief(sourcePrompts)} for thread ${thread.id}, which ran ${ranTurnIds.length} turns`);
    }
    /** `allowed` lists the histories a correct fork may hold; `describe` says what they are. */
    const checkFork = async (what: string, fork: Thread, allowed: ReadonlyArray<readonly string[]>, describe: string): Promise<void> => {
      context.check(fork.id !== thread.id, `${what}: the driver returned the source thread ${thread.id} instead of a new thread`);
      context.check(nativeKey(fork) !== sourceKey, `${what}: the fork ${fork.id} names the source thread's native session ${sourceKey}`);
      if (inspect !== undefined) {
        const native = await nativeSession(context, inspect, fork, what);
        context.check(allowed.some((prompts) => sameJson(prompts, native.prompts)), `${what}: the fork's native session holds the prompts ${brief(native.prompts)}; ${describe}`);
      }
      await checkRunsTurn(context, opened, rig, fork, `${what}: the fork ${fork.id}`, inspect);
    };
    const latestHistory = { allowed: [sourcePrompts], describe: `the source held ${brief(sourcePrompts)}` };
    // The proposal does not say whether a fork from a turn includes that turn, so both readings pass; neither drops the history before it.
    const fromSecondHistory = {
      allowed: [sourcePrompts.slice(0, 1), sourcePrompts.slice(0, 2)],
      describe: `a fork from the second of ${ranTurnIds.length} turns holds the prompts before it ${brief(sourcePrompts.slice(0, 1))} or up to and including it ${brief(sourcePrompts.slice(0, 2))}`,
    };
    await checkMember(
      checker,
      "forkThread",
      ["threads.fork"],
      () => session.forkThread!({ threadId: thread.id, at: { type: "latest" } }),
      async () => {
        const fork = await expectWorks(context, "forkThread at latest", "threads.fork", () => session.forkThread!({ threadId: thread.id, at: { type: "latest" } }), schemaCheck(ThreadSchema));
        await checkFork("forkThread at latest", fork, latestHistory.allowed, latestHistory.describe);
      },
    );
    if (hasCapability(capabilities, "threads.fork") && session.forkThread !== undefined) {
      const fork = session.forkThread.bind(session);
      for (const [variant, path, at] of [
        ["fromTurn", "threads.fork.fromTurn", { type: "turn", turnId: secondTurnId }],
        ["fromItem", "threads.fork.fromItem", { type: "item", itemId }],
      ] as const) {
        if (hasCapability(capabilities, path)) {
          const forked = await expectWorks(context, `forkThread ${variant}`, path, () => fork({ threadId: thread.id, at }), schemaCheck(ThreadSchema));
          await checkFork(`forkThread ${variant}`, forked, fromSecondHistory.allowed, fromSecondHistory.describe);
          tally.works.push(`forkThread ${variant}`);
        } else {
          await expectUnsupported(context, `forkThread ${variant}`, [path], () => fork({ threadId: thread.id, at }));
          tally.rejects.push(`forkThread ${variant}`);
        }
      }
      const otherCwd = context.workspace.otherCwd;
      if (hasCapability(capabilities, "threads.fork.crossCwd")) {
        if (otherCwd === undefined) {
          needs(context, "capability-honesty.forkThread.crossCwd", "forking into another directory", "the workspace has no otherCwd");
          tally.skipped.push("forkThread crossCwd");
        } else {
          const forked = await expectWorks(context, "forkThread crossCwd", "threads.fork.crossCwd", () => fork({ threadId: thread.id, at: { type: "latest" }, cwd: otherCwd }), schemaCheck(ThreadSchema));
          context.check(forked.cwd === otherCwd, `forkThread crossCwd: the host asked for ${otherCwd}, and the fork reports cwd ${forked.cwd}`);
          if (inspect !== undefined) {
            const native = await nativeSession(context, inspect, forked, "forkThread crossCwd");
            context.check(native.cwd === otherCwd, `forkThread crossCwd: the host asked for ${otherCwd}, and the fork's native session works in ${native.cwd}`);
          }
          await checkFork("forkThread crossCwd", forked, latestHistory.allowed, latestHistory.describe);
          tally.works.push("forkThread crossCwd");
        }
      } else {
        const elsewhere = otherCwd ?? `${thread.cwd}-ari-conformance-elsewhere`;
        await expectUnsupported(context, "forkThread crossCwd", ["threads.fork.crossCwd"], () => fork({ threadId: thread.id, at: { type: "latest" }, cwd: elsewhere }));
        tally.rejects.push("forkThread crossCwd");
      }
    }
    await checkMember(
      checker,
      "compactThread",
      ["threads.compact"],
      () => session.compactThread!(thread.id),
      async () => {
        const before = inspect === undefined ? undefined : await nativeSession(context, inspect, thread, "compactThread");
        await expectWorks(context, "compactThread", "threads.compact", () => session.compactThread!(thread.id));
        if (inspect === undefined || before === undefined) return;
        const after = await nativeSession(context, inspect, thread, "compactThread");
        context.check(after.compactions > before.compactions, `compactThread: the native session holds ${after.compactions} compactions after the call, as many as before: compaction had no effect`);
      },
    );
    const history = {
      threadId: thread.id,
      messages: [
        { role: "user", content: [{ type: "text" as const, text: "Earlier, I asked about the parser." }] },
        { role: "assistant", content: [{ type: "text" as const, text: "It tokenizes, then builds a tree." }] },
      ],
      summary: "",
    };
    await checkMember(
      checker,
      "injectHistory",
      ["threads.injectHistory"],
      () => session.injectHistory!(history),
      async () => {
        const before = inspect === undefined ? undefined : await nativeSession(context, inspect, thread, "injectHistory");
        await expectWorks(context, "injectHistory", "threads.injectHistory", () => session.injectHistory!(history), schemaCheck(InjectHistoryResultSchema));
        if (inspect === undefined || before === undefined) return;
        const after = await nativeSession(context, inspect, thread, "injectHistory");
        const received = after.injectedMessages.slice(before.injectedMessages.length);
        const texts = history.messages.map((message) => message.content.map((block) => block.text).join("\n"));
        // Each message the host injected reaches the agent, in order; a provider may wrap them, so containment is enough.
        const delivered = received.length === texts.length && texts.every((text, index) => received[index]!.includes(text));
        context.check(delivered, `injectHistory: the native session received ${brief(received)}; the host injected ${brief(texts)}`);
      },
    );
    await checkMember(
      checker,
      "uploadFeedback",
      ["sessions.feedbackUpload"],
      () => session.uploadFeedback!({ threadId: thread.id, reason: "conformance check" }),
      async () => {
        const { value: result, served } = await during(() =>
          expectWorks(context, "uploadFeedback", "sessions.feedbackUpload", () => session.uploadFeedback!({ threadId: thread.id, reason: "conformance check" }), schemaCheck(UploadFeedbackResultSchema)),
        );
        if (served === undefined) return;
        if (served.feedback.length === 0) context.fail(`uploadFeedback: the native agent received no feedback upload during the call; the driver answered ${brief(result)}`);
        context.check(
          served.feedback.some((entry) => entry.feedbackId === result.feedbackId),
          `uploadFeedback: the driver answered ${brief(result)}, but the native agent answered with feedback id ${brief(served.feedback.map((entry) => entry.feedbackId))}`,
        );
      },
    );

    // MCP apps: each call reaches the native server and returns what it produced.
    const app = rig.exercise?.mcpApp;
    const apps = session.mcpApps;
    for (const member of ["mcpApps.listTools", "mcpApps.callTool", "mcpApps.readResource"] as const) {
      const server = app?.server ?? "ari-conformance-server";
      const calls = {
        "mcpApps.listTools": () => apps!.listTools(thread.id, server),
        "mcpApps.callTool": () => apps!.callTool(thread.id, server, app?.tool ?? "ping", { ...(app?.args ?? {}) }),
        "mcpApps.readResource": () => apps!.readResource(thread.id, server, app?.resourceUri ?? "ari-conformance://resource"),
      };
      const validators = {
        "mcpApps.listTools": (value: unknown) => (Array.isArray(value) && value.every((tool) => McpToolSchema.is(tool)) ? undefined : `not a list of McpTool: ${brief(value)}`),
        "mcpApps.callTool": schemaCheck(McpCallResultSchema),
        "mcpApps.readResource": schemaCheck(McpResourceContentsSchema),
      };
      await checkMember(checker, member, ["tools.mcpApps"], calls[member], async () => {
        if (app === undefined) {
          needs(context, "capability-honesty.mcpApps", "MCP apps", "the rig gives no exercise.mcpApp");
          return SKIPPED;
        }
        const { value, served } = await during(() => expectWorks(context, member, "tools.mcpApps", calls[member] as () => Promise<unknown>, validators[member]));
        if (member === "mcpApps.listTools") {
          const names = (value as ReadonlyArray<{ name: string }>).map((tool) => tool.name);
          context.check(names.includes(app.tool), `mcpApps.listTools: the tools of ${server} ${brief(names)} lack the tool ${brief(app.tool)}`);
          if (served === undefined) return undefined;
          const lists = served.mcp.flatMap((entry) => (entry.operation === "listTools" && entry.server === server ? [entry.output.map((tool) => (tool as { name: string }).name)] : []));
          if (lists.length === 0) context.fail(`mcpApps.listTools: the native agent served no tool list for ${server} during the call`);
          context.check(
            lists.some((list) => sameJson([...list].sort(), [...names].sort())),
            `mcpApps.listTools: the driver listed ${brief(names)}; the native server listed ${brief(lists[0])}`,
          );
        } else if (member === "mcpApps.callTool") {
          if (served === undefined) return undefined;
          const runs = served.mcp.flatMap((entry) => (entry.operation === "callTool" && entry.server === server && entry.tool === app.tool ? [entry] : []));
          if (runs.length === 0) context.fail(`mcpApps.callTool: the native agent ran no call of tool ${brief(app.tool)} on ${server} during the call`);
          const run = runs.find((entry) => sameJson(entry.args, app.args));
          context.check(run !== undefined, `mcpApps.callTool: the native tool got the arguments ${brief(runs[0]!.args)}; the host passed ${brief(app.args)}`);
          context.check(sameJson(run.output, value), `mcpApps.callTool: the driver answered ${brief(value)}; the native tool produced ${brief(run.output)}`);
        } else {
          if (served === undefined) return undefined;
          const reads = served.mcp.flatMap((entry) => (entry.operation === "readResource" && entry.server === server && entry.uri === app.resourceUri ? [entry] : []));
          if (reads.length === 0) context.fail(`mcpApps.readResource: the native agent served no read of ${app.resourceUri} from ${server} during the call`);
          context.check(
            reads.some((entry) => sameJson(entry.output, value)),
            `mcpApps.readResource: the driver answered ${brief(value)}; the native server produced ${brief(reads[0]!.output)}`,
          );
        }
        return undefined;
      });
    }

    // Extensions: each declared namespace reaches the agent and returns its result; an undeclared one is unsupported.
    const ext = session.ext?.bind(session);
    for (const declared of capabilities.extensions) {
      context.check(ext !== undefined, `the driver declares extension ${declared.ns} but leaves out ext`);
      const call = rig.exercise?.extensionCalls?.[declared.ns];
      if (call === undefined) {
        needs(context, `capability-honesty.ext.${declared.ns}`, `extension ${declared.ns}`, "the rig gives no exercise.extensionCalls entry for it");
        tally.skipped.push(`ext ${declared.ns}`);
        continue;
      }
      const what = `ext ${declared.ns}.${call.method}`;
      const { value, served } = await during(() => expectWorks(context, what, `extensions (${declared.ns})`, () => ext(declared.ns, call.method, call.params)));
      if (served !== undefined) {
        if (served.extensions.length === 0) context.fail(`${what}: the native agent received no extension call during the call`);
        const match = served.extensions.find((entry) => sameJson(entry.params, call.params));
        context.check(match !== undefined, `${what}: the native agent got the params ${brief(served.extensions[0]!.params)}; the host passed ${brief(call.params)}`);
        context.check(sameJson(match.result, value), `${what}: the driver answered ${brief(value)}; the native agent produced ${brief(match.result)}`);
      }
      tally.works.push(`ext ${declared.ns}`);
    }
    if (ext === undefined) tally.absent.push("ext");
    else {
      const undeclared = "ari.conformance-undeclared";
      await expectUnsupported(context, `ext ${undeclared}`, [`extensions.${undeclared}`, "extensions"], () => ext(undeclared, "ping", {}));
      tally.rejects.push("ext (undeclared namespace)");
    }

    // Synchronous queries. The proposal fixes their types only: a session's effective window may differ from the
    // catalog's, and a driver may refuse to reuse usage even for one model name (a rolling alias), so both are checked for shape.
    const catalog = await context.wait(created.instance.catalog.list(), "catalog.list()");
    const model = rig.exercise?.model ?? catalog.defaultModelId ?? catalog.models[0]?.id ?? "ari-conformance-model";
    await checkMember(
      checker,
      "contextWindow",
      ["contextWindowReporting"],
      () => session.contextWindow!(model),
      async () => {
        await expectWorks(context, "contextWindow", "contextWindowReporting", () => session.contextWindow!(model), (value) =>
          value === undefined || (Number.isInteger(value) && value > 0) ? undefined : `not a positive integer or undefined: ${brief(value)}`,
        );
      },
    );
    await checkMember(
      checker,
      "canReuseContextUsage",
      ["sessions.contextUsageReuse"],
      () => session.canReuseContextUsage!(model, model),
      async () => {
        await expectWorks(context, "canReuseContextUsage", "sessions.contextUsageReuse", () => session.canReuseContextUsage!(model, model), (value) =>
          typeof value === "boolean" ? undefined : `not a boolean: ${brief(value)}`,
        );
      },
    );

    // Rollback and unload change the thread, so they come last.
    await checkMember(
      checker,
      "rollbackThread",
      ["threads.rollback", "checkpointing.conversationRollback"],
      () => session.rollbackThread!({ threadId: thread.id, to: { type: "start" } }),
      async () => {
        const snapshot = await expectWorks(context, "rollbackThread", "threads.rollback", () => session.rollbackThread!({ threadId: thread.id, to: { type: "start" } }), schemaCheck(ThreadSnapshotSchema));
        context.check(snapshot.turns.length === 0, `rollbackThread: the snapshot after a rollback to the start still lists ${snapshot.turns.length} turns`);
        if (inspect === undefined) return;
        const native = await nativeSession(context, inspect, thread, "rollbackThread");
        context.check(native.prompts.length === 0, `rollbackThread: the native session still holds the prompts ${brief(native.prompts)} after a rollback to the start`);
      },
    );
    await checkMember(
      checker,
      "unloadThread",
      ["threads.unload"],
      () => session.unloadThread!(thread.id),
      async () => {
        await expectWorks(context, "unloadThread", "threads.unload", () => session.unloadThread!(thread.id));
        if (inspect !== undefined) {
          const native = await nativeSession(context, inspect, thread, "unloadThread");
          context.check(!native.loaded, `unloadThread: the native session behind thread ${thread.id} is still loaded after unloadThread`);
        }
        // Unloading keeps the thread: resuming it brings it back for a turn. The proposal does not say which Session
        // reattaches, so the same session and a fresh one from the same instance both count.
        const target = thread.handle !== undefined ? { handle: thread.handle } : thread.native;
        let resumedIn: OpenedSession = opened;
        let resumed: Thread;
        try {
          resumed = await context.wait(session.resumeThread({ native: target, policy: context.policy(capabilities, thread.cwd) }), "resumeThread of the unloaded thread in the same session");
        } catch (sameSession) {
          resumedIn = await context.openSession(created);
          try {
            resumed = await context.wait(
              resumedIn.session.resumeThread({ native: target, policy: context.policy(resumedIn.capabilities(), thread.cwd) }),
              "resumeThread of the unloaded thread in a fresh session",
            );
          } catch (freshSession) {
            context.fail(`unloadThread: the unloaded thread ${thread.id} could not be resumed in the same session (${describeError(sameSession)}) or in a fresh one (${describeError(freshSession)})`);
          }
          context.note(`the unloaded thread was resumed in a fresh session; the same session refused: ${describeError(sameSession)}`);
        }
        await checkRunsTurn(context, resumedIn, rig, resumed, `unloadThread: the unloaded thread ${thread.id}, once resumed,`, inspect);
      },
    );

    // Release, in a session where it must be allowed: one finished turn, nothing running, nothing pending.
    await checkMember(
      checker,
      "release",
      ["sessions.release"],
      () => session.release(),
      async () => {
        const quiet = await context.openSession(created);
        const quietThread = await context.createThread(quiet);
        await context.simpleTurn(quiet, rig, quietThread.id, "One small task.");
        const releasable = quiet.session.canRelease();
        context.check(typeof releasable === "boolean", `canRelease() returned ${brief(releasable)}`);
        try {
          await context.until(() => quiet.session.canRelease(), "canRelease() to allow a release in a quiet session");
        } catch {
          context.fail(
            `release: the driver declares sessions.release on, but canRelease() stayed false for ${context.timeoutMs} ms in a session with no turn, request or background task running, so release can never be exercised`,
          );
        }
        await expectWorks(context, "release", "sessions.release", () => quiet.session.release());
        if (inspect !== undefined) {
          const native = await nativeSession(context, inspect, quietThread, "release");
          context.check(!native.loaded, `release: the native session behind thread ${quietThread.id} is still loaded after release()`);
        }
        // Release parks the runtime without destroying the thread: the next turn brings it back.
        await checkRunsTurn(context, quiet, rig, quietThread, `release: the released thread ${quietThread.id}`, inspect);
        await quiet.close();
      },
    );

    context.note(
      `works: ${tally.works.join(", ") || "none"}; unsupported: ${tally.rejects.join(", ") || "none"}; left out: ${tally.absent.join(", ") || "none"}; not exercised: ${tally.skipped.join(", ") || "none"}`,
    );
  },
};
