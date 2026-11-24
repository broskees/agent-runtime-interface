// The fallback planner: when a provider cannot do something natively, the host
// does it with the calls the provider does support. `planFallback` returns the
// plan as data and executes nothing; the host runs the steps with its own
// session, transcript and checkpoints. Drivers never fall back silently: they
// answer `unsupported` (or `prompt_required`) and the host decides.
//
// Situations it plans for:
//
//   steer, outcome "unsupported"      the provider cannot steer the active turn.
//       With turns.queue on: queue the message natively (start_turn, intent
//       "queue"). Otherwise: wait for the active turn's turn.terminal, then
//       start a normal turn. A host that prefers to cut the active turn short
//       can interrupt it first; that choice is host policy, not a plan step.
//   steer, outcome "prompt_required"  the turn ended before the steer arrived:
//       send the same content as a normal turn (start_turn, intent "start").
//   fork                              native forkThread when threads.fork
//       allows this fork point, directory and (for a subagent's thread)
//       threads.fork.fromSubagent; otherwise read the history up to the fork
//       point, create a thread and seed it with that history.
//   rollback                          native rollbackThread when
//       threads.rollback and checkpointing.conversationRollback are on;
//       otherwise a native fork at the target turn when the fork rules above
//       allow it; otherwise a new thread seeded with the history up to the
//       target. The host then continues in the new thread.
//
// Room for the new thread. With sessions.multipleThreads off, a Session that
// holds a thread refuses createThread, and the Session holding the source
// holds the source (or, for a subagent's thread, its parent's thread). So a
// plan that creates a thread first makes room for it:
//   fork      opens a fresh Session on the same Instance and creates the
//             thread there, so the source stays loaded and usable, as a fork
//             promises.
//   rollback  unloads the source when threads.unload is on and the source is
//             not a subagent's thread (the host is leaving the source anyway);
//             otherwise opens a fresh Session, because unloading a subagent's
//             thread would still leave its parent's thread in the Session.
// The history is read before that step, while the source is still loaded.
//
// These are the same capability rules the capability guard enforces, so a plan
// never calls something the guard would refuse.
//
// History comes from `readSnapshot` when threads.readSnapshot is on, and from
// the host's own transcript otherwise. A new thread is seeded with
// `injectHistory` when threads.injectHistory is on; otherwise the host sends
// the history as part of the first user message of the new thread.
// Rolling back workspace files is always the host's job (its own checkpoints)
// and is not part of these plans.

import { hasCapability } from "../capabilities.ts";
import type { Capabilities } from "../generated/capabilities.ts";
import type { ForkPoint, RollbackTarget } from "../generated/thread.ts";
import { forkCapabilityPath, forkChangesDirectory } from "./capability-guard.ts";

/** What went wrong, or what the host wants to do. */
export type FallbackRequest =
  | {
      readonly kind: "steer";
      /** What `startTurn` with `intent: "steer"` answered. */
      readonly outcome: "unsupported" | "prompt_required";
      readonly threadId: string;
      /** The turn the host meant to steer. */
      readonly turnId: string;
    }
  | {
      readonly kind: "fork";
      readonly threadId: string;
      readonly at: ForkPoint;
      /** The new thread's working directory, when it differs from the source's. */
      readonly cwd?: string;
      /** The source thread's working directory. */
      readonly sourceCwd?: string;
      /** True when the source thread is a subagent's (its `subagentId` is set). */
      readonly subagentThread?: boolean;
    }
  | {
      readonly kind: "rollback";
      readonly threadId: string;
      readonly to: RollbackTarget;
      readonly cwd?: string;
      /** True when the thread is a subagent's (its `subagentId` is set). */
      readonly subagentThread?: boolean;
    };

/** One step of a plan. The host performs each step in order. */
export type FallbackStep =
  /** Call `startTurn` on `threadId` with the original content and this intent. */
  | { readonly action: "start_turn"; readonly threadId: string; readonly intent: "start" | "queue" }
  /** Hold the message until the session emits `turn.terminal` for `turnId`. */
  | { readonly action: "wait_for_turn_terminal"; readonly turnId: string }
  /** Call the session's native `forkThread`. */
  | { readonly action: "fork_thread"; readonly threadId: string; readonly at: ForkPoint; readonly cwd?: string }
  /** Call the session's native `rollbackThread`. */
  | { readonly action: "rollback_thread"; readonly threadId: string; readonly to: RollbackTarget }
  /** Collect `threadId`'s history up to `upTo` from `source`. */
  | {
      readonly action: "read_history";
      readonly threadId: string;
      readonly source: "provider_snapshot" | "host_transcript";
      readonly upTo: ForkPoint | RollbackTarget;
    }
  /** Call `unloadThread` on `threadId`, so the Session holds no thread and a later `createThread` is allowed. */
  | { readonly action: "unload_thread"; readonly threadId: string }
  /**
   * Open a fresh Session on the same Instance (`Instance.openSession`) and run
   * the remaining steps in it. The Session that holds the source stays as it is.
   */
  | { readonly action: "open_session" }
  /** Call `createThread`; `cwd` is the new thread's directory when the plan fixes it. */
  | { readonly action: "create_thread"; readonly cwd?: string }
  /** Seed the new thread with the history read earlier. */
  | { readonly action: "seed_history"; readonly method: "inject_history" | "first_user_message" }
  /** Continue the host's conversation in the thread the previous steps produced, in place of `threadId`. */
  | { readonly action: "switch_thread"; readonly fromThreadId: string };

export interface FallbackPlan {
  /** True when the plan is a single native call the capabilities allow. */
  readonly native: boolean;
  readonly steps: readonly FallbackStep[];
  /** Why this plan, in one sentence. */
  readonly reason: string;
}

/** Plans how the host gets `request` done with what `capabilities` allow. Executes nothing. */
export function planFallback(capabilities: Capabilities, request: FallbackRequest): FallbackPlan {
  switch (request.kind) {
    case "steer":
      return planSteer(capabilities, request);
    case "fork":
      return planFork(capabilities, request);
    case "rollback":
      return planRollback(capabilities, request);
  }
}

function planSteer(capabilities: Capabilities, request: Extract<FallbackRequest, { kind: "steer" }>): FallbackPlan {
  if (request.outcome === "prompt_required") {
    return {
      native: false,
      steps: [{ action: "start_turn", threadId: request.threadId, intent: "start" }],
      reason: `Turn ${request.turnId} ended before the steer arrived, so the message goes out as a normal turn.`,
    };
  }
  if (hasCapability(capabilities, "turns.queue")) {
    return {
      native: false,
      steps: [{ action: "start_turn", threadId: request.threadId, intent: "queue" }],
      reason: "The provider cannot steer but queues natively, so the message runs after the active turn.",
    };
  }
  return {
    native: false,
    steps: [
      { action: "wait_for_turn_terminal", turnId: request.turnId },
      { action: "start_turn", threadId: request.threadId, intent: "start" },
    ],
    reason: "The provider can neither steer nor queue, so the host holds the message until the active turn settles.",
  };
}

/**
 * The steps that let `createThread` through when the Session cannot hold
 * another thread: none with sessions.multipleThreads on; otherwise unload the
 * source when `mayUnloadSource` and threads.unload allow it, else open a fresh
 * Session.
 */
function roomSteps(capabilities: Capabilities, sourceThreadId: string, mayUnloadSource: boolean): FallbackStep[] {
  if (hasCapability(capabilities, "sessions.multipleThreads")) return [];
  if (mayUnloadSource && hasCapability(capabilities, "threads.unload")) return [{ action: "unload_thread", threadId: sourceThreadId }];
  return [{ action: "open_session" }];
}

function createThreadStep(cwd: string | undefined): FallbackStep {
  return cwd === undefined ? { action: "create_thread" } : { action: "create_thread", cwd };
}

function historySteps(
  capabilities: Capabilities,
  threadId: string,
  upTo: ForkPoint | RollbackTarget,
  cwd: string | undefined,
  room: readonly FallbackStep[],
): FallbackStep[] {
  return [
    {
      action: "read_history",
      threadId,
      source: hasCapability(capabilities, "threads.readSnapshot") ? "provider_snapshot" : "host_transcript",
      upTo,
    },
    ...room,
    createThreadStep(cwd),
    {
      action: "seed_history",
      method: hasCapability(capabilities, "threads.injectHistory") ? "inject_history" : "first_user_message",
    },
  ];
}

function canForkNatively(
  capabilities: Capabilities,
  at: ForkPoint,
  cwd: string | undefined,
  sourceCwd: string | undefined,
  subagentThread: boolean | undefined,
): boolean {
  if (!hasCapability(capabilities, "threads.fork")) return false;
  if (!hasCapability(capabilities, forkCapabilityPath({ at }))) return false;
  if (subagentThread === true && !hasCapability(capabilities, "threads.fork.fromSubagent")) return false;
  return !forkChangesDirectory({ cwd }, sourceCwd) || hasCapability(capabilities, "threads.fork.crossCwd");
}

function planFork(capabilities: Capabilities, request: Extract<FallbackRequest, { kind: "fork" }>): FallbackPlan {
  if (canForkNatively(capabilities, request.at, request.cwd, request.sourceCwd, request.subagentThread)) {
    const step: FallbackStep =
      request.cwd === undefined
        ? { action: "fork_thread", threadId: request.threadId, at: request.at }
        : { action: "fork_thread", threadId: request.threadId, at: request.at, cwd: request.cwd };
    return { native: true, steps: [step], reason: "The provider forks natively from this point." };
  }
  const room = roomSteps(capabilities, request.threadId, false);
  return {
    native: false,
    steps: historySteps(capabilities, request.threadId, request.at, request.cwd ?? request.sourceCwd, room),
    reason:
      room.length === 0
        ? "The provider cannot make this fork, so the host seeds a new thread with the history up to the fork point."
        : "The provider cannot make this fork and a Session holds one thread, so the host seeds a new thread in a fresh Session with the history up to the fork point.",
  };
}

function planRollback(capabilities: Capabilities, request: Extract<FallbackRequest, { kind: "rollback" }>): FallbackPlan {
  if (hasCapability(capabilities, "threads.rollback") && hasCapability(capabilities, "checkpointing.conversationRollback")) {
    return {
      native: true,
      steps: [{ action: "rollback_thread", threadId: request.threadId, to: request.to }],
      reason: "The provider rolls back natively.",
    };
  }
  const switchBack: FallbackStep = { action: "switch_thread", fromThreadId: request.threadId };
  const room = roomSteps(capabilities, request.threadId, request.subagentThread !== true);
  if (request.to.type === "start") {
    return {
      native: false,
      steps: [...room, createThreadStep(request.cwd), switchBack],
      reason: "The provider cannot roll back; rolling back to the start is a fresh thread.",
    };
  }
  const at: ForkPoint = { type: "turn", turnId: request.to.turnId };
  if (canForkNatively(capabilities, at, undefined, undefined, request.subagentThread)) {
    return {
      native: false,
      steps: [{ action: "fork_thread", threadId: request.threadId, at }, switchBack],
      reason: "The provider cannot roll back but forks from a turn, so the host continues in a fork at the target turn.",
    };
  }
  return {
    native: false,
    steps: [...historySteps(capabilities, request.threadId, request.to, request.cwd, room), switchBack],
    reason: "The provider can neither roll back nor fork from a turn, so the host seeds a new thread with the history up to the target turn.",
  };
}
