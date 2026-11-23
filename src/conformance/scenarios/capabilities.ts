// Scenario 14: capability honesty. For each capability-gated Session member
// (the `capability` fields of spec/v1/methods.json, the two the capability
// guard adds, the fork variants and the startTurn intents), a member the
// driver declares off must reject with `unsupported{capability}` (or be left
// out), and a member it declares on must work. The kit calls the driver's
// own session, without `ari/host`'s guard in front, because the driver itself
// must be honest.

import { hasCapability } from "../../capabilities.ts";
import { toCallError } from "../../errors.ts";
import type { Capabilities } from "../../generated/capabilities.ts";
import type { AppliedThread } from "../../generated/session.ts";
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
import type { HarnessRig, NativeTurn } from "../harness.ts";
import { brief } from "../util.ts";
import { describeError } from "./sessions.ts";
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

    // A turn kept open for the steer and queue intents, background work and a subagent.
    const active = await context.beginTurn(opened, rig, thread.id, "Start the build.");
    await context.wait(active.native.say("Building."), "the native agent to stream text");
    const wantsTask = ["background.list", "background.stop", "background.await"].some((path) => hasCapability(capabilities, path));
    let taskStarted = false;
    if (wantsTask) {
      if (active.native.startBackgroundTask === undefined) needs(context, "capability-honesty.background", "background tasks", "the native turn has no startBackgroundTask");
      else {
        await context.wait(active.native.startBackgroundTask({ title: "watch the tests" }), "the native agent to start background work");
        taskStarted = true;
      }
    }
    let subagentId: string | undefined;
    if (hasCapability(capabilities, "subagents.stop")) {
      if (active.native.spawnSubagent === undefined) needs(context, "capability-honesty.stopSubagent", "stopping a subagent", "the native turn has no spawnSubagent");
      else {
        await context.wait(active.native.spawnSubagent({ name: "reviewer" }), "the native agent to spawn a subagent");
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
    const state = context.reduced(opened);
    const itemId = [...state.items.values()].find((item) => item.turnId === active.turnId)?.id ?? "ari-conformance-item";

    // Background tasks and subagents.
    const tasks = session.backgroundTasks;
    let taskId = "ari-conformance-task";
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
        taskId = listed[0]!.id;
        return undefined;
      },
    );
    await checkMember(
      checker,
      "backgroundTasks.await",
      ["background.await"],
      () => tasks!.await({ threadId: thread.id, taskIds: [taskId], awaited: true }),
      async () => {
        if (!taskStarted) return SKIPPED;
        await expectWorks(context, "backgroundTasks.await", "background.await", () => tasks!.await({ threadId: thread.id, taskIds: [taskId], awaited: true }), schemaCheck(AwaitBackgroundTasksResultSchema));
      },
    );
    await checkMember(
      checker,
      "backgroundTasks.stop",
      ["background.stop"],
      () => tasks!.stop({ threadId: thread.id, taskId }),
      async () => {
        if (!taskStarted) return SKIPPED;
        await expectWorks(context, "backgroundTasks.stop", "background.stop", () => tasks!.stop({ threadId: thread.id, taskId }));
      },
    );
    await checkMember(
      checker,
      "stopSubagent",
      ["subagents.stop"],
      () => session.stopSubagent!({ subagentId: subagentId ?? "ari-conformance-subagent" }),
      async () => {
        if (subagentId === undefined) return SKIPPED;
        await expectWorks(context, "stopSubagent", "subagents.stop", () => session.stopSubagent!({ subagentId: subagentId! }), (value) =>
          value === undefined || value === null || SubagentOutcomeSchema.is(value) ? undefined : `not a SubagentOutcome: ${brief(value)}`,
        );
      },
    );

    // Thread operations on the finished turn.
    await checkMember(
      checker,
      "readSnapshot",
      ["threads.readSnapshot"],
      () => session.readSnapshot!(thread.id),
      async () => {
        const snapshot = await expectWorks(context, "readSnapshot", "threads.readSnapshot", () => session.readSnapshot!(thread.id), schemaCheck(ThreadSnapshotSchema));
        context.check(snapshot.thread.id === thread.id, `readSnapshot(${thread.id}) returned thread ${snapshot.thread.id}`);
      },
    );
    await checkMember(
      checker,
      "forkThread",
      ["threads.fork"],
      () => session.forkThread!({ threadId: thread.id, at: { type: "latest" } }),
      async () => {
        const fork = await expectWorks(context, "forkThread at latest", "threads.fork", () => session.forkThread!({ threadId: thread.id, at: { type: "latest" } }), schemaCheck(ThreadSchema));
        context.check(fork.id !== thread.id, `forkThread returned the source thread ${thread.id} instead of a new thread`);
      },
    );
    if (hasCapability(capabilities, "threads.fork") && session.forkThread !== undefined) {
      const fork = session.forkThread.bind(session);
      for (const [variant, path, at] of [
        ["fromTurn", "threads.fork.fromTurn", { type: "turn", turnId: active.turnId }],
        ["fromItem", "threads.fork.fromItem", { type: "item", itemId }],
      ] as const) {
        if (hasCapability(capabilities, path)) {
          await expectWorks(context, `forkThread ${variant}`, path, () => fork({ threadId: thread.id, at }), schemaCheck(ThreadSchema));
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
          await expectWorks(context, "forkThread crossCwd", "threads.fork.crossCwd", () => fork({ threadId: thread.id, at: { type: "latest" }, cwd: otherCwd }), schemaCheck(ThreadSchema));
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
        await expectWorks(context, "compactThread", "threads.compact", () => session.compactThread!(thread.id));
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
        await expectWorks(context, "injectHistory", "threads.injectHistory", () => session.injectHistory!(history), schemaCheck(InjectHistoryResultSchema));
      },
    );
    await checkMember(
      checker,
      "uploadFeedback",
      ["sessions.feedbackUpload"],
      () => session.uploadFeedback!({ threadId: thread.id, reason: "conformance check" }),
      async () => {
        await expectWorks(context, "uploadFeedback", "sessions.feedbackUpload", () => session.uploadFeedback!({ threadId: thread.id, reason: "conformance check" }), schemaCheck(UploadFeedbackResultSchema));
      },
    );

    // MCP apps.
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
        await expectWorks(context, member, "tools.mcpApps", calls[member] as () => Promise<unknown>, validators[member]);
        return undefined;
      });
    }

    // Extensions: each declared namespace works; an undeclared one is unsupported.
    const ext = session.ext?.bind(session);
    for (const declared of capabilities.extensions) {
      context.check(ext !== undefined, `the driver declares extension ${declared.ns} but leaves out ext`);
      const call = rig.exercise?.extensionCalls?.[declared.ns];
      if (call === undefined) {
        needs(context, `capability-honesty.ext.${declared.ns}`, `extension ${declared.ns}`, "the rig gives no exercise.extensionCalls entry for it");
        tally.skipped.push(`ext ${declared.ns}`);
        continue;
      }
      await expectWorks(context, `ext ${declared.ns}.${call.method}`, `extensions (${declared.ns})`, () => ext(declared.ns, call.method, call.params));
      tally.works.push(`ext ${declared.ns}`);
    }
    if (ext === undefined) tally.absent.push("ext");
    else {
      const undeclared = "ari.conformance-undeclared";
      await expectUnsupported(context, `ext ${undeclared}`, [`extensions.${undeclared}`, "extensions"], () => ext(undeclared, "ping", {}));
      tally.rejects.push("ext (undeclared namespace)");
    }

    // Synchronous members.
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
        await expectWorks(context, "rollbackThread", "threads.rollback", () => session.rollbackThread!({ threadId: thread.id, to: { type: "start" } }), schemaCheck(ThreadSnapshotSchema));
      },
    );
    let unloaded = false;
    await checkMember(
      checker,
      "unloadThread",
      ["threads.unload"],
      () => session.unloadThread!(thread.id),
      async () => {
        await expectWorks(context, "unloadThread", "threads.unload", () => session.unloadThread!(thread.id));
        unloaded = true;
      },
    );

    // Release parks the runtime; the session must still work afterwards.
    await checkMember(
      checker,
      "release",
      ["sessions.release"],
      () => session.release(),
      async () => {
        const releasable = session.canRelease();
        context.check(typeof releasable === "boolean", `canRelease() returned ${brief(releasable)}`);
        if (!releasable) {
          context.note("release() not called: canRelease() vetoed it with nothing running");
          return SKIPPED;
        }
        await expectWorks(context, "release", "sessions.release", () => session.release());
        // The parked runtime comes back for the next turn, on the same thread unless it was unloaded.
        const target = unloaded ? (await context.createThread(opened)).id : thread.id;
        await context.simpleTurn(opened, rig, target, "Still there?");
      },
    );

    context.note(
      `works: ${tally.works.join(", ") || "none"}; unsupported: ${tally.rejects.join(", ") || "none"}; left out: ${tally.absent.join(", ") || "none"}; not exercised: ${tally.skipped.join(", ") || "none"}`,
    );
  },
};
