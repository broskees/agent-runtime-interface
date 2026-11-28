// The capability guard: wraps a `Session` so that a call whose capability is
// off rejects with `unsupported{capability}` and never reaches the driver.
// `startTurn` is the one exception in form: it resolves to
// `{ status: "unsupported", capability }`, the variant its result type carries
// for this. The guard reads `session.capabilities()` on every call, so a
// `capabilities.updated` change applies at once. Members the driver leaves out
// stay absent; every other member passes through unchanged.
//
// It gates 36 capability paths of spec/v1/capabilities.schema.json.
//
// 17 back a whole call (the `capability` fields of spec/v1/methods.json, plus
// two whose description names the call):
//   readSnapshot                     threads.readSnapshot
//   forkThread                       threads.fork
//   rollbackThread                   threads.rollback, checkpointing.conversationRollback
//   compactThread                    threads.compact
//   injectHistory                    threads.injectHistory
//   unloadThread                     threads.unload
//   backgroundTasks.list/stop/await  background.list, background.stop, background.await
//   stopSubagent                     subagents.stop
//   mcpApps.*                        tools.mcpApps
//   uploadFeedback                   sessions.feedbackUpload
//   ext(ns, ...)                     extensions.<ns> (`ns` listed in capabilities.extensions)
//   contextWindow                    contextWindowReporting (synchronous: throws)
//   canReuseContextUsage             sessions.contextUsageReuse (synchronous: throws)
//   release                          sessions.release
//
// 19 are triggered by a call's arguments or by what the guard knows of the
// thread:
//   threads.fork.fromTurn            forkThread `at: { type: "turn" }`
//   threads.fork.fromItem            forkThread `at: { type: "item" }`
//   threads.fork.fromSubagent        forkThread from a subagent's thread
//   threads.fork.crossCwd            forkThread `cwd` other than the source thread's
//   turns.steer, turns.queue         startTurn `intent: "steer"` or `"queue"`
//   context.syntheticContext         startTurn `context.synthetic`
//   context.instructionChannels      host instructions: `context.system` or
//                                    `context.developer` on createThread or
//                                    startTurn, `launch.appendSystemPrompt` or
//                                    `launch.developerPrompt` on createThread or
//                                    resumeThread (any listed channel will do)
//   context.handoffSummaries         injectHistory with a non-empty `summary`
//   tools.dynamicTools               `launch.dynamicTools`
//   tools.mcp                        `launch.mcpServers`
//   mcp.acceptsHostServers           each launch MCP server's `transport` listed
//   runtimePolicy.modes.<mode>       `policy.mode` on createThread, resumeThread,
//                                    forkThread or startTurn (a policy without
//                                    `mode` keeps the harness's own and needs none)
//   runtimePolicy.interactionModes   `policy.interaction` listed
//   sessions.switchRuntimeMode       startTurn `policy.mode` other than the thread's
//   runtimePolicy.switchInSession    startTurn `policy` mode or interaction other
//                                    than the thread's
//   requests.allowCustomAnswer       respond `custom`
//   requests.approvalScopes          respond `scope` listed among the scopes
//   sessions.multipleThreads         createThread, or resumeThread of another
//                                    thread, while the session holds a thread
//
// What the guard knows of threads. Each fact about a thread (`cwd`,
// `subagentId`, `status`, `native`, `handle`) keeps the `seq` it came from.
// A `thread.upsert` event read through the guard's `events()` sets a fact only
// when its `seq` is higher than the fact's, so a replayed or backfilled older
// event never overwrites a newer fact, while a backfilled window still adds
// threads and facts nothing newer set. A `subagent.upsert` naming a `threadId`
// marks that thread as a subagent's. A thread a call returns (createThread,
// resumeThread, forkThread, readSnapshot, rollbackThread, an unloadThread
// that succeeded) counts as at least as new as every event read so far.
// Policies come only from calls: the `policy` of createThread, resumeThread
// and forkThread, and of each startTurn the driver accepted. A thread whose
// policy named no mode runs the harness's own, which the guard does not know:
// a startTurn that names a mode for it is a switch. A startTurn whose policy
// names no mode changes no mode.
//
// Where the guard lacks a fact it decides this way. A fork that names a `cwd`
// for a thread whose directory it does not know counts as cross-directory
// (leave `cwd` out to fork in place). A thread it does not know is not taken
// for a subagent's thread, and a thread whose policy it does not know has no
// switch to detect. A thread "held" by the session is a known thread that is
// not a subagent's and whose status is not `closed` or `unloaded`.

import { hasCapability } from "../capabilities.ts";
import { callErrors } from "../errors.ts";
import type { Capabilities } from "../generated/capabilities.ts";
import type { RuntimePolicy } from "../generated/config.ts";
import type { AriEvent } from "../generated/events.ts";
import type {
  ForkThreadInput,
  InstructionContext,
  LaunchContext,
  ResumeThreadInput,
  StartTurnInput,
  StartTurnResult,
  TurnContext,
} from "../generated/session.ts";
import type { Session } from "../runtime.ts";

/** The capability path a `forkThread` call needs, which depends on where it forks from. */
export function forkCapabilityPath(input: Pick<ForkThreadInput, "at">): string {
  if (input.at.type === "turn") return "threads.fork.fromTurn";
  if (input.at.type === "item") return "threads.fork.fromItem";
  return "threads.fork";
}

/** The capability path a `startTurn` intent needs, or undefined for `start`, which every driver supports. */
export function startTurnCapabilityPath(input: Pick<StartTurnInput, "intent">): string | undefined {
  if (input.intent === "steer") return "turns.steer";
  if (input.intent === "queue") return "turns.queue";
  return undefined;
}

/**
 * True when a fork names a `cwd` that is not the source thread's known
 * directory. An unknown source directory counts as different, so the guard
 * never lets a possibly cross-directory fork through.
 */
export function forkChangesDirectory(input: Pick<ForkThreadInput, "cwd">, sourceCwd: string | undefined): boolean {
  return input.cwd !== undefined && input.cwd !== sourceCwd;
}

/** One capability a call needs: its path, and how to tell it is on when `hasCapability` alone cannot. */
interface Requirement {
  readonly path: string;
  readonly isOn?: (capabilities: Capabilities) => boolean;
  readonly message?: string;
}

/** The first requirement whose capability is off, or undefined when all are on. */
function firstUnmet(capabilities: Capabilities, requirements: readonly Requirement[]): Requirement | undefined {
  return requirements.find((requirement) => !(requirement.isOn?.(capabilities) ?? hasCapability(capabilities, requirement.path)));
}

function hasText(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function hasEntries(values: readonly unknown[] | undefined): boolean {
  return values !== undefined && values.length > 0;
}

function policyRequirements(policy: RuntimePolicy | undefined): Requirement[] {
  if (policy === undefined) return [];
  return [
    ...(policy.mode === undefined ? [] : [{ path: `runtimePolicy.modes.${policy.mode}` }]),
    {
      path: "runtimePolicy.interactionModes",
      isOn: (capabilities) => hasCapability(capabilities, "runtimePolicy.interactionModes", policy.interaction),
      message: `Interaction mode ${policy.interaction} is not supported`,
    },
  ];
}

function instructionRequirements(context: InstructionContext | TurnContext | undefined, launch: LaunchContext | undefined): Requirement[] {
  const hasInstructions =
    hasText(context?.system) || hasText(context?.developer) || hasEntries(launch?.appendSystemPrompt) || hasEntries(launch?.developerPrompt);
  return hasInstructions ? [{ path: "context.instructionChannels" }] : [];
}

function launchToolRequirements(launch: LaunchContext | undefined): Requirement[] {
  const requirements: Requirement[] = [];
  if (hasEntries(launch?.dynamicTools)) requirements.push({ path: "tools.dynamicTools" });
  const servers = launch?.mcpServers ?? [];
  if (servers.length > 0) requirements.push({ path: "tools.mcp" });
  for (const server of servers) {
    requirements.push({
      path: "mcp.acceptsHostServers",
      isOn: (capabilities) => hasCapability(capabilities, "mcp.acceptsHostServers", server.transport),
      message: `MCP server ${server.name} uses transport ${server.transport}, which the provider does not accept`,
    });
  }
  return requirements;
}

/** Statuses after which a thread no longer occupies the session. */
const RELEASED_THREAD_STATUSES: ReadonlySet<string> = new Set(["closed", "unloaded"]);

/** The thread facts the guard tracks. */
const THREAD_FACTS = ["cwd", "subagentId", "status", "native", "handle"] as const;
type ThreadFact = (typeof THREAD_FACTS)[number];

/** What the guard knows of the session's threads, each fact stamped with the `seq` it came from. */
class ThreadRegistry {
  readonly #facts = new Map<string, Map<ThreadFact, { value: unknown; seq: number }>>();
  /** The highest event `seq` read through the guard so far. */
  #highestSeq = 0;

  /** Learns from one event read through the guard. */
  observe(event: AriEvent): void {
    this.#highestSeq = Math.max(this.#highestSeq, event.seq);
    const body = event.body;
    if (body.type === "thread.upsert") {
      this.#learn(body.thread.id, body.thread, event.seq, false);
    } else if (body.type === "subagent.upsert" && typeof body.subagent.threadId === "string") {
      this.#learn(body.subagent.threadId, { subagentId: body.subagent.id }, event.seq, false);
    }
  }

  /** Learns from a thread a call returned, or a fact a successful call established. */
  observeResult(threadId: string, facts: { readonly [fact: string]: unknown }): void {
    this.#learn(threadId, facts, this.#highestSeq, true);
  }

  cwd(threadId: string): string | undefined {
    const cwd = this.#fact(threadId, "cwd");
    return typeof cwd === "string" ? cwd : undefined;
  }

  isSubagentThread(threadId: string): boolean {
    return typeof this.#fact(threadId, "subagentId") === "string";
  }

  /** Known threads that occupy the session: not a subagent's, and not closed or unloaded. */
  heldThreadIds(): string[] {
    return [...this.#facts.keys()].filter((threadId) => {
      const status = this.#fact(threadId, "status");
      return !this.isSubagentThread(threadId) && !(typeof status === "string" && RELEASED_THREAD_STATUSES.has(status));
    });
  }

  /** True when `target` (a resumeThread `native`) names this known thread, by handle or by native id. */
  isTarget(threadId: string, target: ResumeThreadInput["native"]): boolean {
    if ("handle" in target) return this.#fact(threadId, "handle") === target.handle;
    const native = this.#fact(threadId, "native") as { id?: unknown } | undefined;
    return target.id !== null && native?.id === target.id;
  }

  #fact(threadId: string, fact: ThreadFact): unknown {
    return this.#facts.get(threadId)?.get(fact)?.value;
  }

  /** Sets each tracked fact `facts` carries, unless a fact from a later seq (or, for events, the same seq) is already known. */
  #learn(threadId: string, facts: { readonly [fact: string]: unknown }, seq: number, orSameSeq: boolean): void {
    const known = this.#facts.get(threadId) ?? new Map<ThreadFact, { value: unknown; seq: number }>();
    this.#facts.set(threadId, known);
    for (const fact of THREAD_FACTS) {
      const value = facts[fact];
      if (value === undefined) continue;
      const current = known.get(fact);
      if (current !== undefined && !(seq > current.seq || (orSameSeq && seq === current.seq))) continue;
      known.set(fact, { value: value === null ? undefined : value, seq });
    }
  }
}

/** Passes `events` through, telling `onEvent` about each one. Cancelling the outer stream cancels the inner one at once. */
function observeEvents(events: AsyncIterable<AriEvent>, onEvent: (event: AriEvent) => void): AsyncIterable<AriEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<AriEvent> {
      const inner = events[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<AriEvent>> {
          const result = await inner.next();
          if (result.done !== true) onEvent(result.value);
          return result;
        },
        async return(value?: unknown): Promise<IteratorResult<AriEvent>> {
          if (inner.return !== undefined) return inner.return(value);
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** Returns a `Session` that refuses calls whose capability is off. */
export function guardSession(session: Session): Session {
  const threads = new ThreadRegistry();
  /** The runtime policy each thread last ran under, as far as the guard's own calls tell. */
  const policies = new Map<string, Pick<RuntimePolicy, "mode" | "interaction">>();

  const rememberThread = <Thread extends { id: string }>(thread: Thread): Thread => {
    threads.observeResult(thread.id, thread);
    return thread;
  };

  /** Rejects with `unsupported` naming the first unmet requirement; otherwise runs `call`. */
  const gated = <Result>(requirements: readonly Requirement[], call: () => Promise<Result>): Promise<Result> => {
    const unmet = firstUnmet(session.capabilities(), requirements);
    if (unmet !== undefined) return Promise.reject(callErrors.unsupported(unmet.path, unmet.message));
    return call();
  };

  /** sessions.multipleThreads when the session already holds a thread that `isSame` does not match. */
  const secondThreadRequirements = (isSame: (threadId: string) => boolean): Requirement[] =>
    threads.heldThreadIds().some((threadId) => !isSame(threadId)) ? [{ path: "sessions.multipleThreads" }] : [];

  const switchRequirements = (threadId: string, policy: RuntimePolicy | undefined): Requirement[] => {
    const known = policies.get(threadId);
    if (policy === undefined || known === undefined) return [];
    const requirements: Requirement[] = [];
    const switchesMode = policy.mode !== undefined && policy.mode !== known.mode;
    if (switchesMode) requirements.push({ path: "sessions.switchRuntimeMode" });
    if (switchesMode || policy.interaction !== known.interaction) requirements.push({ path: "runtimePolicy.switchInSession" });
    return requirements;
  };

  /** What a turn's accepted policy leaves the thread running: a policy without a mode keeps the thread's. */
  const afterTurn = (threadId: string, policy: RuntimePolicy): Pick<RuntimePolicy, "mode" | "interaction"> => {
    const mode = policy.mode ?? policies.get(threadId)?.mode;
    return mode === undefined ? { interaction: policy.interaction } : { mode, interaction: policy.interaction };
  };

  const guarded: Session = {
    get id() {
      return session.id;
    },
    capabilities: () => session.capabilities(),
    events: (options) => observeEvents(session.events(options), (event) => threads.observe(event)),
    createThread: (input) =>
      gated(
        [
          ...secondThreadRequirements(() => false),
          ...policyRequirements(input.policy),
          ...instructionRequirements(input.context, input.launch),
          ...launchToolRequirements(input.launch),
        ],
        async () => {
          const thread = rememberThread(await session.createThread(input));
          policies.set(thread.id, input.policy);
          return thread;
        },
      ),
    resumeThread: (input) =>
      gated(
        [
          ...secondThreadRequirements((threadId) => threads.isTarget(threadId, input.native)),
          ...policyRequirements(input.policy),
          ...instructionRequirements(undefined, input.launch),
          ...launchToolRequirements(input.launch),
        ],
        async () => {
          const thread = rememberThread(await session.resumeThread(input));
          if (input.policy !== undefined) policies.set(thread.id, input.policy);
          return thread;
        },
      ),
    canRelease: () => session.canRelease(),
    release: () => gated([{ path: "sessions.release" }], () => session.release()),
    startTurn: async (input): Promise<StartTurnResult> => {
      const intentPath = startTurnCapabilityPath(input);
      const unmet = firstUnmet(session.capabilities(), [
        ...(intentPath === undefined ? [] : [{ path: intentPath }]),
        ...policyRequirements(input.policy),
        ...switchRequirements(input.threadId, input.policy),
        ...instructionRequirements(input.context, undefined),
        ...(hasEntries(input.context?.synthetic) ? [{ path: "context.syntheticContext" }] : []),
      ]);
      if (unmet !== undefined) return { status: "unsupported", capability: unmet.path };
      const result = await session.startTurn(input);
      if (result.status === "accepted" && input.policy !== undefined) policies.set(input.threadId, afterTurn(input.threadId, input.policy));
      return result;
    },
    interruptTurn: (input) => session.interruptTurn(input),
    respond: (input) =>
      gated(
        [
          ...(input.custom === undefined ? [] : [{ path: "requests.allowCustomAnswer" }]),
          ...(input.scope === undefined
            ? []
            : [
                {
                  path: "requests.approvalScopes",
                  isOn: (capabilities: Capabilities) => capabilities.requests.approvalScopes.some((reach) => reach.scope === input.scope),
                  message: `Approval scope ${input.scope} is not one the provider offers`,
                },
              ]),
        ],
        () => session.respond(input),
      ),
    planConfigChange: (input) => session.planConfigChange(input),
    close: () => session.close(),
  };

  const { readSnapshot, forkThread, rollbackThread, compactThread, injectHistory, unloadThread } = session;
  if (readSnapshot !== undefined) {
    guarded.readSnapshot = (threadId) =>
      gated([{ path: "threads.readSnapshot" }], async () => {
        const snapshot = await readSnapshot.call(session, threadId);
        rememberThread(snapshot.thread);
        return snapshot;
      });
  }
  if (forkThread !== undefined) {
    guarded.forkThread = (input) =>
      gated(
        [
          { path: "threads.fork" },
          { path: forkCapabilityPath(input) },
          ...(threads.isSubagentThread(input.threadId) ? [{ path: "threads.fork.fromSubagent" }] : []),
          ...(forkChangesDirectory(input, threads.cwd(input.threadId)) ? [{ path: "threads.fork.crossCwd" }] : []),
          ...policyRequirements(input.policy),
        ],
        async () => {
          const thread = rememberThread(await forkThread.call(session, input));
          if (input.policy !== undefined) policies.set(thread.id, input.policy);
          return thread;
        },
      );
  }
  if (rollbackThread !== undefined) {
    guarded.rollbackThread = (input) =>
      gated([{ path: "threads.rollback" }, { path: "checkpointing.conversationRollback" }], async () => {
        const snapshot = await rollbackThread.call(session, input);
        rememberThread(snapshot.thread);
        return snapshot;
      });
  }
  if (compactThread !== undefined) {
    guarded.compactThread = (threadId) => gated([{ path: "threads.compact" }], () => compactThread.call(session, threadId));
  }
  if (injectHistory !== undefined) {
    guarded.injectHistory = (input) =>
      gated([{ path: "threads.injectHistory" }, ...(hasText(input.summary) ? [{ path: "context.handoffSummaries" }] : [])], () =>
        injectHistory.call(session, input),
      );
  }
  if (unloadThread !== undefined) {
    guarded.unloadThread = (threadId) =>
      gated([{ path: "threads.unload" }], async () => {
        await unloadThread.call(session, threadId);
        threads.observeResult(threadId, { status: "unloaded" });
      });
  }

  const backgroundTasks = session.backgroundTasks;
  if (backgroundTasks !== undefined) {
    guarded.backgroundTasks = {
      list: (threadId, options) => gated([{ path: "background.list" }], () => backgroundTasks.list(threadId, options)),
      stop: (input) => gated([{ path: "background.stop" }], () => backgroundTasks.stop(input)),
      await: (input) => gated([{ path: "background.await" }], () => backgroundTasks.await(input)),
    };
  }

  const { stopSubagent, uploadFeedback, ext, contextWindow, canReuseContextUsage } = session;
  if (stopSubagent !== undefined) {
    guarded.stopSubagent = (input) => gated([{ path: "subagents.stop" }], () => stopSubagent.call(session, input));
  }

  const mcpApps = session.mcpApps;
  if (mcpApps !== undefined) {
    const appsGate = [{ path: "tools.mcpApps" }];
    guarded.mcpApps = {
      listTools: (threadId, server) => gated(appsGate, () => mcpApps.listTools(threadId, server)),
      callTool: (threadId, server, tool, args) => gated(appsGate, () => mcpApps.callTool(threadId, server, tool, args)),
      readResource: (threadId, server, uri) => gated(appsGate, () => mcpApps.readResource(threadId, server, uri)),
    };
  }

  if (uploadFeedback !== undefined) {
    guarded.uploadFeedback = (input) => gated([{ path: "sessions.feedbackUpload" }], () => uploadFeedback.call(session, input));
  }
  if (ext !== undefined) {
    guarded.ext = (ns, method, params) =>
      gated(
        [{ path: `extensions.${ns}`, isOn: (capabilities) => capabilities.extensions.some((extension) => extension.ns === ns) }],
        () => ext.call(session, ns, method, params),
      );
  }
  if (contextWindow !== undefined) {
    guarded.contextWindow = (model, cwd) => {
      if (!hasCapability(session.capabilities(), "contextWindowReporting")) throw callErrors.unsupported("contextWindowReporting");
      return contextWindow.call(session, model, cwd);
    };
  }
  if (canReuseContextUsage !== undefined) {
    guarded.canReuseContextUsage = (previousModel, nextModel) => {
      if (!hasCapability(session.capabilities(), "sessions.contextUsageReuse")) throw callErrors.unsupported("sessions.contextUsageReuse");
      return canReuseContextUsage.call(session, previousModel, nextModel);
    };
  }

  return guarded;
}
