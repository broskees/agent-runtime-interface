// An OpenCode session: ARI threads are OpenCode sessions on a 1.x or 2.x
// server (see pool.ts for who runs which server), driven through the neutral
// `NativeRuntime` of native.ts.
//
// How the driver keeps OpenCode's quirks:
// - A turn settles only on the server's authoritative end of the run (1.x
//   `session.idle`, 2.x `session.execution.succeeded|failed|interrupted`) or
//   on the server process exiting; never on a timer.
// - Runtime modes are the session's own permission rules, which OpenCode
//   enforces natively; host MCP entries of other threads on the same server
//   are denied by the same rules (rules.ts), in the thread's session and in
//   each of its subagents' sessions, which OpenCode gave a copy of the rules
//   once, when it created them.
// - "Always" replies reach the whole project, so the option says so
//   (`scope: "project"`). Under `full_access` the thread's rules allow
//   everything; a request that still comes says why (`#fullAccessOverride`).
// - Host instructions travel in OpenCode's system channel: 1.x
//   `session.prompt_async` `system` on every prompt, 2.x the session's
//   instruction entry `ari`. Nothing is written to OpenCode's config files.
//   A resume that brings a LaunchContext replaces the thread's; one that
//   brings none keeps it.
// - 2.x steering joins the running execution and never starts one; a steer
//   that missed its execution is taken back and the host gets
//   `prompt_required`. 1.x has no such call, so 1.x steering is off.

import { callErrors, toCallError } from "../../errors.ts";
import { EventSequencer } from "../../driver-kit/sequencer.ts";
import { truncateUtf8 } from "../../driver-kit/truncate.ts";
import type { Capabilities } from "../../generated/capabilities.ts";
import type { ConfigValues, ContentBlock } from "../../generated/common.ts";
import type { ConfigChangePlan, RuntimeMode, RuntimePolicy } from "../../generated/config.ts";
import type { AriEvent, AriEventBody } from "../../generated/events.ts";
import type { McpServerConfig } from "../../generated/session.ts";
import type { OpenSessionInput } from "../../generated/instance.ts";
import type { Failure } from "../../generated/errors.ts";
import { OpencodePermissionRulesGetParamsSchema, OpencodePermissionRulesSetParamsSchema } from "../../generated/extensions/opencode.ts";
import type { Item, ItemPatch } from "../../generated/item.ts";
import type { Question, Request } from "../../generated/request.ts";
import type {
  AppliedThread,
  CreateThreadInput,
  ForkThreadInput,
  InterruptTurnInput,
  LaunchContext,
  PlanConfigChangeInput,
  RespondInput,
  ResumeThreadInput,
  RollbackThreadInput,
  StartTurnInput,
  StartTurnResult,
} from "../../generated/session.ts";
import type { Thread, ThreadSnapshot, Turn } from "../../generated/thread.ts";
import type { HostServices, Session } from "../../runtime.ts";
import { IDENTITY_VERSION, PERMISSION_RULES_EXTENSION, opencodeCapabilities } from "./capabilities.ts";
import type { ServerShape } from "./capabilities.ts";
import type { OpencodeConfig } from "./config.ts";
import { failureOf, itemIdFor, permissionOptions, providerTurnIdFor, requestIdFor, requestKindOf, subagentIdFor, threadIdFor, toolItemFields, turnIdFor } from "./mapping.ts";
import type { McpEntry, NativeError, NativeEvent, NativeMessage, NativeQuestion, NativeRule, NativeToolState } from "./native.ts";
import type { Detected, Link, ServerPool } from "./pool.ts";
import { mcpConfigKey } from "./pool.ts";
import { childRules, grantCouldReachMcpResources, isolationRules, lastMatchingEffect, sessionRules } from "./rules.ts";

/** What the instance gives each session. */
export interface OpencodeSessionContext {
  readonly host: HostServices<OpencodeConfig>;
  readonly config: OpencodeConfig;
  readonly pool: ServerPool;
  readonly detected: Detected;
  readonly shape: ServerShape;
  /** Context windows by `provider/model`, from the instance's catalog. */
  readonly contextWindows: ReadonlyMap<string, number>;
}

const SUPPORTED_MODES: ReadonlySet<string> = new Set<RuntimeMode>(["read_only", "approval_required", "auto_accept_edits", "full_access"]);
const SUPPORTED_OPTIONS = new Set(["model", "agent"]);

interface Envelope {
  threadId?: string;
  turnId?: string;
  hostTag?: string;
}

interface Launch {
  /** Host instructions of the session's and the thread's LaunchContext; a resume that brings a LaunchContext replaces them. */
  readonly launchPrompts: readonly string[];
  /** Host instructions the thread was created with (`createThread` `context`); they stay with the thread. */
  readonly contextPrompts: readonly string[];
  readonly mcpServers: NonNullable<LaunchContext["mcpServers"]>;
  model: string | undefined;
  agent: string | undefined;
}

interface ActiveTurn {
  readonly id: string;
  readonly threadId: string;
  readonly hostTag: string | undefined;
  /** The prompt's message id; undefined for a turn OpenCode ran on its own. */
  readonly promptMessageId: string | undefined;
  readonly steerMessageIds: Set<string>;
  /** Text and reasoning items by native part id. */
  readonly parts: Map<string, { itemId: string; text: string; field: "text" | "reasoning" }>;
  /** Tool items by call id. */
  readonly tools: Map<string, { itemId: string; opened: boolean }>;
  readonly openItems: Set<string>;
  todoItemId: string | undefined;
  /** The error the run reported before it ended. */
  error: NativeError | undefined;
  settled: boolean;
}

interface OcThread {
  thread: Thread;
  readonly sessionId: string;
  readonly directory: string;
  /** Undefined for a thread resumed without a policy: its session keeps the rules OpenCode saved for it (`savedRules`). */
  policy: RuntimePolicy | undefined;
  /** The rules OpenCode held for the session when a resume without a policy found it; they stay in place of a mode's. */
  savedRules: readonly NativeRule[];
  launch: Launch;
  hostRules: NativeRule[];
  /** Host MCP entries this thread put on its server. */
  mcpNames: Set<string>;
  link: Link | undefined;
  linking: Promise<Link> | undefined;
  active: ActiveTurn | undefined;
  compacting: { resolve(): void; reject(error: unknown): void } | undefined;
  unloaded: boolean;
  /** Read by a `purpose: "history"` resume: the driver wrote nothing to its session, and it runs no turn until an interactive resume. */
  history: boolean;
  /** A prompt sent and not yet admitted: its turn opens when the server names its message. */
  pendingPrompt: { readonly input: StartTurnInput; resolve(turn: ActiveTurn): void; reject(error: unknown): void } | undefined;
  /** Steers sent and not yet admitted: their user messages belong to the running turn. */
  pendingSteers: number;
  /** Set for a subagent's own session. */
  readonly parent: { readonly threadId: string; readonly subagentId: string } | undefined;
  /** A subagent's: the rules OpenCode gave its session when it created it, which the driver extends with the current isolation denies. */
  createdRules: readonly NativeRule[] | undefined;
  providerTurns: number;
}

interface PendingRequest {
  readonly request: Request;
  readonly threadId: string;
  readonly turnId: string | undefined;
  /** The native session that asked (a subagent's, for a request from a subagent). */
  readonly sessionId: string;
  readonly nativeId: string;
  readonly kind: "permission" | "question";
  readonly questions: readonly NativeQuestion[];
  inFlight: string | undefined;
  resolved: boolean;
}

/**
 * The directory as the operating system names it, symbolic links followed, so
 * a thread started through a link reports the same directory (and ids) as one
 * started through the real path. OpenCode uses the directory it is given. A
 * directory this machine cannot see (an external server elsewhere) is kept as
 * given.
 */
async function canonicalDirectory(directory: string): Promise<string> {
  try {
    const fs = await import("node:fs/promises");
    return await fs.realpath(directory);
  } catch {
    return directory;
  }
}

// OpenCode has one host instruction channel, the system prompt, so developer text goes there too.
function launchPrompts(launch: LaunchContext | undefined): string[] {
  return [...(launch?.appendSystemPrompt ?? []), ...(launch?.developerPrompt ?? [])];
}

function contextPrompts(context: CreateThreadInput["context"] | undefined): string[] {
  return [...(context?.system === undefined ? [] : [context.system]), ...(context?.developer === undefined ? [] : [context.developer])];
}

/** An ARI MCP server as OpenCode's MCP config (1.x `McpLocalConfig`/`McpRemoteConfig`, 2.x `Mcp.LocalConfig`/`Mcp.RemoteConfig`). */
function mcpConfig(server: Pick<McpServerConfig, "transport" | "command" | "args" | "env" | "url" | "headers">): McpEntry["config"] {
  if (server.transport === "stdio") return { type: "local", command: [server.command ?? "", ...(server.args ?? [])], ...(server.env === undefined ? {} : { environment: { ...server.env } }) };
  if (server.transport === "http") return { type: "remote", url: server.url ?? "", ...(server.headers === undefined ? {} : { headers: { ...server.headers } }) };
  throw callErrors.unsupported("mcp.acceptsHostServers", `OpenCode does not take ${server.transport} MCP servers from the driver`);
}

export class OpencodeSession implements Session {
  readonly id: string;
  readonly #context: OpencodeSessionContext;
  readonly #input: OpenSessionInput;
  readonly #capabilities: Capabilities;
  readonly #sequencer: EventSequencer;
  readonly #threads = new Map<string, OcThread>();
  readonly #bySession = new Map<string, OcThread>();
  readonly #turnThreads = new Map<string, string>();
  readonly #requests = new Map<string, PendingRequest>();
  readonly #responses = new Map<string, Promise<void>>();
  readonly #turnKeys = new Map<string, Promise<StartTurnResult>>();
  /** Event streams by server and directory. */
  readonly #watches = new Map<string, Promise<{ close(): void }>>();
  /** Servers the driver is stopping on purpose. */
  readonly #stopping = new Set<Link["endpoint"]>();
  readonly #watchedExits = new Set<Link["endpoint"]>();
  #closed = false;

  constructor(context: OpencodeSessionContext, input: OpenSessionInput, id: string) {
    this.id = id;
    this.#context = context;
    this.#input = input;
    this.#capabilities = opencodeCapabilities(context.shape);
    this.#sequencer = new EventSequencer({ sessionId: id });
    this.#emit({ type: "capabilities.updated", capabilities: this.#capabilities });
    this.#emit({ type: "session.state", state: "ready" });
  }

  capabilities(): Capabilities {
    return this.#capabilities;
  }

  events(options?: { fromSeq?: number }): AsyncIterable<AriEvent> {
    return this.#sequencer.events(options?.fromSeq === undefined ? {} : { fromSeq: options.fromSeq });
  }

  // -------------------------------------------------------------------------
  // Threads

  async createThread(input: CreateThreadInput): Promise<AppliedThread> {
    this.#open();
    this.#checkMode(input.policy);
    const launch = this.#launchFor(input.config, input.launch, input.context);
    const cwd = await canonicalDirectory(input.cwd);
    const link = await this.#newLink(cwd);
    let registered: OcThread | undefined;
    try {
      await this.#watch(link, cwd);
      // Other threads' entries are denied from the start; this thread's own come right after.
      const others = this.#context.pool.othersOn(link.endpoint, "");
      const created = await link.runtime.createSession({
        directory: cwd,
        ...(input.title === undefined ? {} : { title: input.title }),
        rules: sessionRules(input.policy.mode, link.runtime.generation, [], others),
        ...(launch.model === undefined ? {} : { model: launch.model }),
        ...(launch.agent === undefined ? {} : { agent: launch.agent }),
      });
      const thread = this.#register(created.id, created.directory || cwd, input.policy, launch, link, { ...(input.title === undefined ? {} : { title: input.title }) }, undefined);
      registered = thread;
      await this.#giveMcpServers(thread);
      return { ...thread.thread, appliedConfig: this.#applied(thread) };
    } catch (error) {
      if (registered !== undefined) await this.#forget(registered, link);
      if (this.#dedicated()) await this.#stopLink(link);
      throw error;
    }
  }

  async resumeThread(input: ResumeThreadInput): Promise<AppliedThread> {
    this.#open();
    const target = "handle" in input.native ? input.native.handle : input.native.id;
    if (target === null || target === "") throw callErrors.validation([{ message: "resumeThread needs a native id or handle", path: ["native"] }]);
    const known = this.#threads.get(threadIdFor(target));
    const history = input.purpose === "history";
    if (known !== undefined && !known.unloaded && known.link !== undefined) {
      // A subagent's thread lives as long as its parent's run; OpenCode drives it.
      if (known.parent !== undefined) return { ...known.thread, appliedConfig: this.#applied(known) };
      // A history read changes nothing: it reports what the thread runs with.
      if (history) return { ...known.thread, appliedConfig: this.#applied(known) };
      return this.#resumeHeld(known, input);
    }
    const policy = input.policy ?? known?.policy;
    if (policy !== undefined && !history) this.#checkMode(policy);
    const directory = policy?.cwd !== undefined && policy.cwd !== "" ? await canonicalDirectory(policy.cwd) : known?.directory;
    if (directory === undefined && this.#context.shape.generation === 1) {
      throw callErrors.validation([{ message: "resuming an OpenCode 1.x session this session does not know needs policy.cwd", path: ["policy", "cwd"] }]);
    }
    const launch = this.#resumedLaunch(input, known);
    // A thread a history read left on a live server keeps that server (a 1.x thread's own).
    const link = known?.link !== undefined && known.link.endpoint.alive ? known.link : await this.#newLink(directory);
    try {
      const found = await link.runtime.getSession(target, directory);
      if (found !== undefined && history) return this.#historyThread(found, directory, launch, link, known);
      if (found === undefined && history) throw callErrors.notFound({ resource: "OpenCode session", id: target });
      if (found !== undefined) {
        const cwd = found.directory || directory || "";
        await this.#watch(link, cwd);
        // Without a policy the session keeps the rules it was saved with; the driver adds only the denies of other threads' entries.
        const savedRules = policy === undefined && (known === undefined || known.history) ? await link.runtime.getRules(found.id, cwd) : undefined;
        const thread = this.#register(found.id, cwd, policy, launch, link, {}, undefined);
        if (savedRules !== undefined) thread.savedRules = savedRules;
        if (known !== undefined) thread.hostRules = known.hostRules;
        await this.#applyRules(thread, this.#context.pool.othersOn(link.endpoint, thread.thread.id));
        await this.#giveMcpServers(thread);
        return { ...thread.thread, appliedConfig: this.#applied(thread) };
      }
      if (input.policy === undefined || directory === undefined) throw callErrors.notFound({ resource: "OpenCode session", id: target });
      // The session is gone: fall back to a fresh one, and say so.
      await this.#watch(link, directory);
      const created = await link.runtime.createSession({
        directory,
        rules: sessionRules(input.policy.mode, link.runtime.generation, [], this.#context.pool.othersOn(link.endpoint, "")),
        ...(launch.model === undefined ? {} : { model: launch.model }),
        ...(launch.agent === undefined ? {} : { agent: launch.agent }),
      });
      this.#emit({ type: "session.replaced", previousNativeId: target, reason: `OpenCode has no session ${target}; a fresh session replaces it.`, contextLost: true, showRuntimeNote: true }, { threadId: threadIdFor(created.id) });
      const thread = this.#register(created.id, created.directory || directory, input.policy, launch, link, {}, undefined);
      await this.#giveMcpServers(thread);
      return { ...thread.thread, appliedConfig: this.#applied(thread) };
    } catch (error) {
      if (this.#dedicated() && ![...this.#threads.values()].some((thread) => thread.link === link)) await this.#stopLink(link);
      throw error;
    }
  }

  /**
   * A `purpose: "history"` resume of a session the server has: the thread is
   * registered unloaded, with no policy, and the driver writes nothing to the
   * session (no rules, no MCP entries, no instructions). It reads through the
   * server (`readSnapshot`); an interactive resume makes it usable.
   */
  #historyThread(found: { id: string; directory: string }, directory: string | undefined, launch: Launch, link: Link, known: OcThread | undefined): AppliedThread {
    const thread = this.#register(found.id, found.directory || directory || "", undefined, launch, link, {}, undefined);
    if (known !== undefined) thread.hostRules = known.hostRules;
    thread.history = true;
    thread.unloaded = true;
    thread.thread = { ...thread.thread, status: "unloaded" };
    this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id, status: "unloaded" } }, { threadId: thread.thread.id });
    return { ...thread.thread, appliedConfig: this.#applied(thread) };
  }

  /**
   * A resume of a thread this session holds on a live server: the thread takes
   * what the resume brings (a LaunchContext, config, a policy) from its next
   * turn, as a fresh resume would; its MCP entries follow the new launch.
   */
  async #resumeHeld(known: OcThread, input: ResumeThreadInput): Promise<AppliedThread> {
    const policy = input.policy === undefined ? undefined : { ...input.policy, cwd: known.directory };
    if (policy !== undefined) {
      this.#checkMode(policy);
      if (policy.mode !== known.policy?.mode && !this.#capabilities.runtimePolicy.switchInSession) throw callErrors.unsupported("runtimePolicy.switchInSession");
    }
    if (input.config !== undefined) this.#applyConfig(known, input.config);
    // Set first: a server that has to start again gives the thread the new launch's entries.
    known.launch = this.#resumedLaunch(input, known);
    const link = await this.#linkOf(known);
    if (policy !== undefined && policy.mode !== known.policy?.mode) {
      known.policy = policy;
      await this.#applyRules(known, this.#context.pool.othersOn(link.endpoint, known.thread.id));
    }
    if (input.launch !== undefined) await this.#giveMcpServers(known);
    return { ...known.thread, appliedConfig: this.#applied(known) };
  }

  async readSnapshot(threadId: string): Promise<ThreadSnapshot> {
    this.#open();
    const thread = this.#thread(threadId);
    const link = await this.#linkOf(thread);
    const history = await link.runtime.messages(thread.sessionId, thread.directory);
    const turns: Turn[] = [];
    const items: Item[] = [];
    for (const rebuilt of this.#historyTurns(thread, history)) {
      const running = thread.active?.id === rebuilt.turn.id;
      turns.push(running ? { ...rebuilt.turn, status: "running" } : rebuilt.turn);
      items.push(...rebuilt.items);
    }
    const requests = [...this.#requests.values()].filter((pending) => pending.threadId === threadId && !pending.resolved).map((pending) => pending.request);
    return { thread: thread.thread, turns, items, requests };
  }

  async forkThread(input: ForkThreadInput): Promise<Thread> {
    this.#open();
    if (input.at.type === "item") throw callErrors.unsupported("threads.fork.fromItem");
    if (input.cwd !== undefined && input.cwd !== this.#thread(input.threadId).directory) throw callErrors.unsupported("threads.fork.crossCwd");
    const source = this.#thread(input.threadId);
    if (source.active !== undefined) throw callErrors.invalidState("turn_active", "OpenCode cannot fork a session while its turn runs");
    const link = await this.#linkOf(source);
    let before: string | undefined;
    if (input.at.type === "turn") {
      const history = await link.runtime.messages(source.sessionId, source.directory);
      before = this.#promptOf(source, history, input.at.turnId);
    }
    const forked = await link.runtime.fork(source.sessionId, source.directory, before);
    const policy = input.policy ?? source.policy;
    if (policy !== undefined) this.#checkMode(policy);
    const launch: Launch = { launchPrompts: [...source.launch.launchPrompts], contextPrompts: [...source.launch.contextPrompts], mcpServers: [...source.launch.mcpServers], model: source.launch.model, agent: source.launch.agent };
    if (typeof input.config?.["model"] === "string") launch.model = input.config["model"];
    // A 1.x fork gets a server of its own, like every 1.x thread.
    const forkLink = this.#dedicated() ? await this.#newLink(source.directory) : link;
    await this.#watch(forkLink, source.directory);
    const thread = this.#register(forked.id, forked.directory || source.directory, policy, launch, forkLink, { forkedFrom: { threadId: source.thread.id, ...(input.at.type === "turn" ? { turnId: input.at.turnId } : {}) } }, undefined);
    thread.hostRules = [...source.hostRules];
    // A fork of a thread without a policy keeps the source's saved rules, as its session does.
    if (policy === undefined) thread.savedRules = source.savedRules;
    await this.#applyRules(thread, this.#context.pool.othersOn(forkLink.endpoint, thread.thread.id));
    await this.#giveMcpServers(thread);
    return thread.thread;
  }

  async rollbackThread(input: RollbackThreadInput): Promise<ThreadSnapshot> {
    this.#open();
    const thread = this.#thread(input.threadId);
    if (thread.active !== undefined) throw callErrors.invalidState("turn_active", "OpenCode cannot roll back a session while its turn runs");
    const link = await this.#linkOf(thread);
    const history = await link.runtime.messages(thread.sessionId, thread.directory);
    const prompts = this.#historyTurns(thread, history);
    let cut: string | undefined;
    if (input.to.type === "start") cut = prompts[0]?.promptId;
    else {
      const turnId = input.to.turnId;
      const index = prompts.findIndex((entry) => entry.turn.id === turnId);
      if (index === -1) throw callErrors.notFound({ resource: "turn", id: turnId });
      // Rolling back to a turn keeps it: OpenCode drops the messages from the next turn's prompt on.
      cut = prompts[index + 1]?.promptId;
    }
    if (cut !== undefined) await link.runtime.revert(thread.sessionId, thread.directory, cut);
    const snapshot = await this.readSnapshot(thread.thread.id);
    this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id }, retainedNativeTurnIds: snapshot.turns.flatMap((turn) => (turn.native.id === null ? [] : [turn.native.id])) }, { threadId: thread.thread.id });
    return snapshot;
  }

  async compactThread(threadId: string): Promise<void> {
    this.#open();
    const thread = this.#thread(threadId);
    if (thread.active !== undefined || thread.compacting !== undefined) throw callErrors.invalidState("turn_active", "OpenCode compacts a session only between turns");
    const link = await this.#linkOf(thread);
    let model = thread.launch.model;
    if (model === undefined && link.runtime.generation === 1) model = await this.#lastModel(thread, link);
    // Compaction is a run of its own (1.x `session.summarize` runs the loop; 2.x admits a compaction to the inbox): it ends on the server's idle.
    const done = new Promise<void>((resolve, reject) => {
      thread.compacting = { resolve, reject };
    });
    try {
      await link.runtime.compact(thread.sessionId, thread.directory, model);
      await done;
    } finally {
      thread.compacting = undefined;
    }
  }

  async unloadThread(threadId: string): Promise<void> {
    this.#open();
    if (!this.#dedicated()) throw callErrors.unsupported("threads.unload");
    const thread = this.#thread(threadId);
    if (thread.active !== undefined) throw callErrors.invalidState("turn_active");
    await this.#park(thread);
    thread.unloaded = true;
    thread.thread = { ...thread.thread, status: "unloaded" };
    this.#emit({ type: "thread.upsert", thread: { id: threadId, status: "unloaded" } }, { threadId });
  }

  canRelease(): boolean {
    if (this.#closed || !this.#dedicated()) return false;
    const busy = [...this.#threads.values()].some((thread) => thread.active !== undefined || thread.linking !== undefined || thread.compacting !== undefined);
    const pending = [...this.#requests.values()].some((request) => !request.resolved);
    return !busy && !pending;
  }

  /** Stops every thread's 1.x server; each starts again when its thread is next used. */
  async release(): Promise<void> {
    this.#open();
    if (!this.#dedicated()) throw callErrors.unsupported("sessions.release");
    if (!this.canRelease()) throw callErrors.invalidState("release_vetoed", "A turn, a starting server or a request is still pending");
    for (const thread of this.#threads.values()) await this.#park(thread);
  }

  // -------------------------------------------------------------------------
  // Turns

  startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    this.#open();
    const prior = this.#turnKeys.get(input.clientTurnKey);
    if (prior !== undefined) return prior;
    const started = this.#startTurn(input);
    this.#turnKeys.set(input.clientTurnKey, started);
    started.catch(() => this.#turnKeys.delete(input.clientTurnKey));
    return started;
  }

  async #startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const thread = this.#thread(input.threadId);
    if (thread.history) throw callErrors.invalidState("thread_unloaded", `Thread ${thread.thread.id} was read for its history; resume it for interactive use first`);
    if (input.intent === "queue") return { status: "unsupported", capability: "turns.queue" };
    if (input.intent === "steer" && !this.#capabilities.turns.steer) return { status: "unsupported", capability: "turns.steer" };
    if (input.intent !== "start" && input.intent !== "steer") return { status: "unsupported", capability: `turns.${input.intent}` };
    if (input.context?.synthetic !== undefined && input.context.synthetic.length > 0) return { status: "unsupported", capability: "context.syntheticContext" };
    if (input.policy !== undefined && input.policy.mode !== thread.policy?.mode) {
      if (!this.#capabilities.runtimePolicy.switchInSession) return { status: "unsupported", capability: "runtimePolicy.switchInSession" };
      if (!SUPPORTED_MODES.has(input.policy.mode)) return { status: "unsupported", capability: `runtimePolicy.modes.${input.policy.mode}` };
    }
    const prompt = await this.#promptContent(input.content);
    if (input.intent === "steer") return this.#steer(thread, input, prompt);

    if (thread.active !== undefined || thread.compacting !== undefined) throw callErrors.invalidState("previous_turn_active", `Thread ${thread.thread.id} already runs a turn`);
    this.#applyConfig(thread, input.config);
    const link = await this.#linkOf(thread);
    if (input.policy !== undefined && input.policy.mode !== thread.policy?.mode) {
      thread.policy = input.policy;
      await this.#applyRules(thread, this.#context.pool.othersOn(link.endpoint, thread.thread.id));
    }
    if (thread.pendingPrompt !== undefined) throw callErrors.invalidState("previous_turn_active", `Thread ${thread.thread.id} is starting a turn`);
    let resolveTurn: (turn: ActiveTurn) => void = () => undefined;
    let rejectTurn: (error: unknown) => void = () => undefined;
    const admitted = new Promise<ActiveTurn>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    thread.pendingPrompt = { input, resolve: resolveTurn, reject: rejectTurn };
    const timeoutMs = this.#input.handshakeTimeoutMs ?? 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sent = await link.runtime.prompt({
        sessionId: thread.sessionId,
        directory: thread.directory,
        text: prompt.text,
        files: prompt.files,
        system: this.#system(thread, input.context),
        model: thread.launch.model,
        agent: thread.launch.agent,
      });
      // 2.x names the message in its answer; 1.x only in the user message's event.
      if (sent.messageId !== undefined) this.#admit(thread, sent.messageId, prompt.text);
      const turn = await Promise.race([
        admitted,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(callErrors.transport(`OpenCode did not report the prompt within ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      return { status: "accepted", turnId: turn.id, accepted: "started" };
    } catch (error) {
      if (thread.pendingPrompt?.input === input) thread.pendingPrompt = undefined;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The server admitted the pending prompt as `messageId`: its turn opens now, named by it. */
  #admit(thread: OcThread, messageId: string, text: string): void {
    const pending = thread.pendingPrompt;
    if (pending === undefined) return;
    thread.pendingPrompt = undefined;
    const turn = this.#openTurn(thread, turnIdFor(thread.thread.id, messageId), { id: messageId, strength: "strong" }, messageId, "user", pending.input);
    this.#userItem(thread, turn, messageId, text);
    pending.resolve(turn);
  }

  async #steer(thread: OcThread, input: StartTurnInput, prompt: { text: string; files: Array<{ url: string; name: string; mime: string }> }): Promise<StartTurnResult> {
    const active = thread.active;
    if (active === undefined || (input.expectedTurnId !== undefined && input.expectedTurnId !== active.id) || thread.link === undefined) return { status: "prompt_required" };
    const runtime = thread.link.runtime;
    if (runtime.steer === undefined) return { status: "unsupported", capability: "turns.steer" };
    thread.pendingSteers += 1;
    try {
      const steered = await runtime.steer({
        sessionId: thread.sessionId,
        directory: thread.directory,
        text: prompt.text,
        files: prompt.files,
        system: this.#system(thread, input.context),
        model: thread.launch.model,
        agent: thread.launch.agent,
      });
      if (!steered.joined) return { status: "prompt_required" };
      if (steered.messageId !== undefined && !active.settled) this.#userItem(thread, active, steered.messageId, prompt.text);
    } catch (error) {
      if (toCallError(error)?.code === "transport") return { status: "prompt_required" };
      throw error;
    } finally {
      thread.pendingSteers -= 1;
    }
    return { status: "accepted", turnId: active.id, accepted: "steered" };
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    this.#open();
    const threadId = this.#turnThreads.get(input.turnId);
    const thread = threadId === undefined ? undefined : this.#threads.get(threadId);
    const turn = thread?.active;
    if (thread === undefined || turn === undefined || turn.id !== input.turnId || thread.link === undefined) return;
    if (input.restartRuntime === true && this.#dedicated()) {
      await this.#park(thread);
      return;
    }
    // The run ends with the server's interrupted outcome, which settles the turn.
    await thread.link.runtime.interrupt(thread.sessionId, thread.directory).catch((error: unknown) => {
      if (toCallError(error)?.code !== "transport") throw error;
    });
  }

  respond(input: RespondInput): Promise<void> {
    this.#open();
    // The same (requestId, responseKey) gets the same outcome and reaches OpenCode once.
    const key = `${input.requestId}\u0000${input.responseKey}`;
    const prior = this.#responses.get(key);
    if (prior !== undefined) return prior;
    const pending = this.#requests.get(input.requestId);
    let outcome: Promise<void>;
    if (pending === undefined) outcome = Promise.reject(callErrors.notFound({ resource: "request", id: input.requestId }));
    else if (pending.resolved || (pending.inFlight !== undefined && pending.inFlight !== input.responseKey)) {
      outcome = Promise.reject(callErrors.invalidState("request_resolved", `Request ${input.requestId} was already answered`));
    } else {
      pending.inFlight = input.responseKey;
      outcome = this.#answer(pending, input);
      outcome.catch(() => {
        if (!pending.resolved) pending.inFlight = undefined;
      });
    }
    this.#responses.set(key, outcome);
    return outcome;
  }

  async #answer(pending: PendingRequest, input: RespondInput): Promise<void> {
    const thread = this.#threads.get(pending.threadId);
    const link = thread?.link;
    if (thread === undefined || link === undefined) throw callErrors.invalidState("request_expired", "The OpenCode server that asked has stopped");
    const directory = (this.#bySession.get(pending.sessionId) ?? thread).directory;
    if (pending.kind === "permission") {
      const reply = input.optionId;
      if (reply !== "once" && reply !== "always" && reply !== "reject") throw callErrors.validation([{ message: `choose one of the options once, always or reject; got ${String(reply)}`, path: ["optionId"] }]);
      await link.runtime.replyPermission(pending.sessionId, directory, pending.nativeId, reply);
    } else {
      const answers =
        input.answers === undefined
          ? undefined
          : pending.questions.map((question) => {
              const given = input.answers?.[question.id];
              const chosen = (given?.optionIds ?? []).map((id) => question.options.find((option) => option.id === id)?.id ?? id);
              return given?.text !== undefined && given.text !== "" ? [...chosen, given.text] : chosen;
            });
      if (input.custom !== undefined && answers !== undefined && answers.length > 0) answers[0] = [...(answers[0] ?? []), input.custom];
      await link.runtime.replyQuestion(pending.sessionId, directory, pending.nativeId, answers, pending.questions);
    }
    pending.resolved = true;
    this.#emit({ type: "request.upsert", request: { id: pending.request.id, status: "resolved" } }, this.#envelope(pending.threadId, pending.turnId));
  }

  async planConfigChange(input: PlanConfigChangeInput): Promise<ConfigChangePlan> {
    this.#thread(input.threadId);
    const unknown = Object.keys(input.changes).filter((key) => !SUPPORTED_OPTIONS.has(key));
    if (unknown.length > 0) return { type: "reject", reason: `OpenCode has no option ${unknown.join(", ")}` };
    return { type: "apply_next_turn" };
  }

  contextWindow(model: string): number | undefined {
    return this.#context.contextWindows.get(model);
  }

  /** `opencode.permissionRules` (spec/v1/extensions/opencode.schema.json): `get` reads a thread's own rules from the server; `set` replaces the host's rules in them. */
  async ext(ns: string, method: string, params: unknown): Promise<unknown> {
    this.#open();
    if (ns !== PERMISSION_RULES_EXTENSION) throw callErrors.unsupported(`extensions.${ns}`);
    if (method === "get") {
      const input = OpencodePermissionRulesGetParamsSchema.parse(params);
      const thread = this.#thread(input.threadId);
      const link = await this.#linkOf(thread);
      return { rules: await link.runtime.getRules(thread.sessionId, thread.directory) };
    }
    if (method === "set") {
      const input = OpencodePermissionRulesSetParamsSchema.parse(params);
      const thread = this.#thread(input.threadId);
      const rules: NativeRule[] = input.rules.map((rule, index) => {
        const effect = (["allow", "deny", "ask"] as const).find((known) => known === rule.effect);
        if (effect === undefined) throw callErrors.validation([{ message: "OpenCode rules allow, deny or ask", path: ["params", "rules", index, "effect"] }]);
        return { action: rule.action, resource: rule.resource, effect };
      });
      const link = await this.#linkOf(thread);
      thread.hostRules = rules;
      await this.#applyRules(thread, this.#context.pool.othersOn(link.endpoint, thread.thread.id));
      return { rules: await link.runtime.getRules(thread.sessionId, thread.directory) };
    }
    throw callErrors.unsupported(`extensions.${ns}.${method}`, `${ns} has the methods get and set`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const watch of this.#watches.values()) void watch.then((handle) => handle.close()).catch(() => undefined);
    this.#watches.clear();
    const failures: unknown[] = [];
    for (const thread of this.#threads.values()) {
      if (thread.parent !== undefined) continue;
      const link = thread.link;
      if (link === undefined) continue;
      if (this.#dedicated()) {
        await this.#context.pool.unregister(link.endpoint, thread.thread.id);
        await this.#stopLink(link);
        continue;
      }
      // A shared server outlives the session: take this thread's entries off it.
      try {
        await this.#takeOff(thread, link);
      } catch (error) {
        failures.push(error);
        this.#context.host.diagnostics.log({ level: "error", msg: `OpenCode did not confirm removing the MCP entries of thread ${thread.thread.id}; the other threads keep denying them: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    for (const pending of this.#requests.values()) {
      if (pending.resolved) continue;
      pending.resolved = true;
      this.#emit({ type: "request.upsert", request: { id: pending.request.id, status: "expired" } }, this.#envelope(pending.threadId, pending.turnId));
    }
    for (const thread of this.#threads.values()) {
      if (thread.active !== undefined) this.#settle(thread, thread.active, "interrupted");
    }
    this.#emit({ type: "session.state", state: "stopped" });
    this.#sequencer.close();
    if (failures.length > 0) throw failures[0];
  }

  // -------------------------------------------------------------------------
  // Servers and threads

  /** True when each thread runs on a server of its own (1.x, started by the driver). */
  #dedicated(): boolean {
    return this.#context.shape.generation === 1 && !this.#context.shape.external;
  }

  async #newLink(cwd: string | undefined): Promise<Link> {
    const timeoutMs = this.#input.handshakeTimeoutMs ?? 120_000;
    const link = await this.#context.pool.linkFor(this.#context.detected, this.#context.shape, cwd, timeoutMs);
    this.#watchExit(link);
    return link;
  }

  /** The thread's server, starting it again (with its MCP entries and rules) when it was parked or died. */
  async #linkOf(thread: OcThread): Promise<Link> {
    const parent = thread.parent === undefined ? undefined : this.#threads.get(thread.parent.threadId);
    if (parent !== undefined) return this.#linkOf(parent);
    if (thread.link !== undefined && thread.link.endpoint.alive) return thread.link;
    if (thread.linking !== undefined) return thread.linking;
    thread.linking = (async () => {
      const link = await this.#newLink(thread.directory);
      const found = await link.runtime.getSession(thread.sessionId, thread.directory);
      if (found === undefined) {
        if (this.#dedicated()) await this.#stopLink(link);
        throw callErrors.notFound({ resource: "OpenCode session", id: thread.sessionId, message: `OpenCode no longer has session ${thread.sessionId}` });
      }
      await this.#watch(link, thread.directory);
      thread.link = link;
      // A thread a history read registered stays as it is: only an interactive resume gives it rules and MCP entries.
      if (thread.history) return link;
      thread.unloaded = false;
      if (thread.thread.status === "unloaded") {
        thread.thread = { ...thread.thread, status: "idle" };
        this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id, status: "idle" } }, { threadId: thread.thread.id });
      }
      await this.#applyRules(thread, this.#context.pool.othersOn(link.endpoint, thread.thread.id));
      await this.#giveMcpServers(thread);
      return link;
    })();
    try {
      return await thread.linking;
    } finally {
      thread.linking = undefined;
    }
  }

  #watchKey(link: Link, directory: string): string {
    return link.runtime.generation === 1 ? `${link.endpoint.url}\u0000${directory}` : link.endpoint.url;
  }

  /** Subscribes to the server's events for a directory once per session; resolves when the server confirmed. */
  async #watch(link: Link, directory: string): Promise<void> {
    const key = this.#watchKey(link, directory);
    let watch = this.#watches.get(key);
    if (watch === undefined) {
      watch = link.runtime.watch(
        directory,
        (event) => this.#onNative(event),
        (error) => {
          this.#watches.delete(key);
          this.#onStreamEnd(link, error);
        },
      );
      this.#watches.set(key, watch);
      watch.catch(() => this.#watches.delete(key));
    }
    await watch;
  }

  #watchExit(link: Link): void {
    if (link.endpoint.external || this.#watchedExits.has(link.endpoint)) return;
    this.#watchedExits.add(link.endpoint);
    void link.endpoint.exited.then(() => this.#onExit(link));
  }

  /** A server the driver started ended: its threads lose their link; a running turn fails unless the driver stopped it. */
  #onExit(link: Link): void {
    const byDriver = this.#stopping.delete(link.endpoint);
    for (const [key, watch] of this.#watches) {
      if (key === link.endpoint.url || key.startsWith(`${link.endpoint.url}\u0000`)) {
        this.#watches.delete(key);
        void watch.then((handle) => handle.close()).catch(() => undefined);
      }
    }
    for (const thread of this.#threads.values()) {
      if (thread.link !== link) continue;
      thread.link = undefined;
      void this.#context.pool.unregister(link.endpoint, thread.thread.id);
      thread.mcpNames = new Set();
      this.#expireRequests(thread.thread.id);
      thread.compacting?.reject(callErrors.transport("The OpenCode server exited during compaction"));
      const turn = thread.active;
      if (turn === undefined) continue;
      if (byDriver || this.#closed) this.#settle(thread, turn, "interrupted");
      else {
        this.#settle(thread, turn, "failed", { class: "transport_error", message: "The OpenCode server exited during the turn", retryable: true });
        this.#emit({ type: "notice", level: "error", code: "opencode_exited", text: "The OpenCode server exited" }, { threadId: thread.thread.id });
      }
    }
  }

  /** The event stream of a server ended while it still runs (an external server went away): its turns fail. */
  #onStreamEnd(link: Link, error: unknown): void {
    if (this.#closed || (!link.endpoint.external && !link.endpoint.alive)) return;
    for (const thread of this.#threads.values()) {
      if (thread.link !== link || thread.active === undefined) continue;
      // Nobody here can start an external server again: the thread waits for whoever runs it.
      this.#settle(thread, thread.active, "failed", { class: "transport_error", message: `The OpenCode event stream ended: ${error instanceof Error ? error.message : String(error)}`, retryable: true }, link.endpoint.external ? "broken" : "reusable");
    }
  }

  async #stopLink(link: Link): Promise<void> {
    if (link.endpoint.external || !link.endpoint.alive) return;
    this.#stopping.add(link.endpoint);
    await link.endpoint.stop();
  }

  /** Stops a thread's own 1.x server. OpenCode keeps the session in its database, so the next use starts a server and finds it again. */
  async #park(thread: OcThread): Promise<void> {
    const link = thread.link;
    if (link === undefined) return;
    await this.#stopLink(link);
    thread.link = undefined;
  }

  #register(sessionId: string, directory: string, policy: RuntimePolicy | undefined, launch: Launch, link: Link, extra: Pick<Thread, "title" | "forkedFrom">, parent: OcThread["parent"]): OcThread {
    const id = threadIdFor(sessionId);
    const existing = this.#threads.get(id);
    const snapshot: Thread = {
      ...(existing?.thread ?? {}),
      id,
      native: { id: sessionId, strength: "strong" },
      cwd: directory,
      status: "idle",
      handle: sessionId,
      identityVersion: IDENTITY_VERSION,
      ...(parent === undefined ? {} : { parentThreadId: parent.threadId, subagentId: parent.subagentId }),
      ...extra,
    };
    const thread: OcThread = existing ?? {
      thread: snapshot,
      sessionId,
      directory,
      policy,
      savedRules: [],
      launch,
      hostRules: [],
      mcpNames: new Set(),
      link,
      linking: undefined,
      active: undefined,
      compacting: undefined,
      unloaded: false,
      history: false,
      pendingPrompt: undefined,
      pendingSteers: 0,
      parent,
      createdRules: undefined,
      providerTurns: 0,
    };
    thread.thread = snapshot;
    thread.policy = policy;
    thread.link = link;
    thread.unloaded = false;
    thread.history = false;
    thread.launch = launch;
    this.#threads.set(id, thread);
    this.#bySession.set(sessionId, thread);
    this.#emit({ type: "thread.upsert", thread: snapshot }, { threadId: id });
    return thread;
  }

  /**
   * Writes the thread's permission rules: its mode, the host's rules, and the
   * denies of every other thread's MCP entries. A thread resumed without a
   * policy has no mode: its saved rules stand in its place, less the denies
   * the driver writes itself (those of other threads' entries, which come
   * last anyway, and any of the thread's own entries an earlier run left).
   * OpenCode copied the thread's rules into each subagent session when it
   * created it (2.1.2 `core/src/session.ts` `create`; 1.19.6 `tool/task.ts`
   * keeps the denies), and never again, so the subagents get the current
   * denies too.
   */
  async #applyRules(thread: OcThread, others: string[]): Promise<void> {
    const link = thread.link;
    if (link === undefined) return;
    const generation = link.runtime.generation;
    if (thread.policy !== undefined) await link.runtime.setRules(thread.sessionId, thread.directory, sessionRules(thread.policy.mode, generation, thread.hostRules, others));
    else {
      const own = this.#context.pool.entriesOf(link.endpoint, thread.thread.id).keys();
      const written = new Set([...isolationRules(others, generation), ...isolationRules(own, generation)].map((rule) => JSON.stringify([rule.action, rule.resource, rule.effect])));
      const saved = thread.savedRules.filter((rule) => !written.has(JSON.stringify([rule.action, rule.resource, rule.effect])));
      await link.runtime.setRules(thread.sessionId, thread.directory, [...saved, ...thread.hostRules, ...isolationRules(others, generation)]);
    }
    for (const child of this.#threads.values()) {
      if (child.parent?.threadId !== thread.thread.id || child.createdRules === undefined) continue;
      await link.runtime.setRules(child.sessionId, child.directory, childRules(child.createdRules, link.runtime.generation, others));
    }
  }

  /** A subagent's session from now on gets every deny its thread gets, on top of the rules OpenCode gave it. */
  async #isolateChild(root: OcThread, child: OcThread, link: Link): Promise<void> {
    child.createdRules = await link.runtime.getRules(child.sessionId, child.directory);
    await link.runtime.setRules(child.sessionId, child.directory, childRules(child.createdRules, link.runtime.generation, this.#context.pool.othersOn(link.endpoint, root.thread.id)));
  }

  /** Takes an entry off the server; one OpenCode no longer has is gone already. */
  async #removeEntry(link: Link, name: string, directory: string): Promise<void> {
    try {
      await link.runtime.removeMcp(name, directory);
    } catch (error) {
      if (toCallError(error)?.code === "not_found") return;
      throw error;
    }
  }

  /**
   * Takes the thread's MCP entries off a shared server, then lets the other
   * threads stop denying them. An entry another thread in the directory holds
   * stays. A removal OpenCode does not confirm throws before any deny is
   * dropped, so the other threads keep denying an entry that may remain.
   */
  async #takeOff(thread: OcThread, link: Link): Promise<void> {
    const pool = this.#context.pool;
    for (const name of pool.entriesOf(link.endpoint, thread.thread.id).keys()) {
      if (pool.heldByOthers(link.endpoint, thread.thread.id, thread.directory, name)) continue;
      await this.#removeEntry(link, name, thread.directory);
    }
    await pool.unregister(link.endpoint, thread.thread.id);
  }

  /** Drops a thread whose creation failed after OpenCode made its session: its entries come off the server, and it is closed. */
  async #forget(thread: OcThread, link: Link): Promise<void> {
    if (!this.#dedicated()) await this.#takeOff(thread, link).catch((error: unknown) => this.#context.host.diagnostics.log({ level: "error", msg: `OpenCode did not confirm removing the MCP entries of thread ${thread.thread.id}: ${error instanceof Error ? error.message : String(error)}` }));
    else await this.#context.pool.unregister(link.endpoint, thread.thread.id);
    this.#threads.delete(thread.thread.id);
    this.#bySession.delete(thread.sessionId);
    this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id, status: "closed" } }, { threadId: thread.thread.id });
  }

  /**
   * Gives the thread the host's tool server for it, plus the launch's MCP
   * servers, under the names the host chose. Every other thread on the same
   * server is told to deny them before they are added.
   */
  async #giveMcpServers(thread: OcThread): Promise<void> {
    const link = thread.link;
    if (link === undefined || thread.parent !== undefined) return;
    const entries: McpEntry[] = thread.launch.mcpServers.map((server) => ({ name: server.name, directory: thread.directory, config: mcpConfig(server) }));
    try {
      const hostServer = await this.#context.host.hostTools.mcpServerFor(thread.thread.id, { transport: "http" });
      entries.push({ name: hostServer.name, directory: thread.directory, config: mcpConfig(hostServer.config) });
    } catch (error) {
      this.#context.host.diagnostics.log({ level: "warn", msg: `The host gave no tool server for thread ${thread.thread.id}: ${error instanceof Error ? error.message : String(error)}` });
    }
    const pool = this.#context.pool;
    const wanted = new Map(entries.map((entry) => [entry.name, mcpConfigKey(entry.config)]));
    const onOthers = async (updated: string[]): Promise<void> => {
      if (!this.#closed && thread.link === link) await this.#applyRules(thread, updated);
    };
    // Every other thread denies an entry before it is added, and keeps denying one this thread drops until OpenCode confirms it is gone.
    // `register` rewrites the other threads' rules; this thread's are written here, after each registration, from the list it returns.
    const held = pool.entriesOf(link.endpoint, thread.thread.id);
    const dropped = [...held.keys()].filter((name) => !wanted.has(name));
    await this.#applyRules(thread, await pool.register(link.endpoint, thread.thread.id, thread.directory, new Map([...[...held].filter(([name]) => !wanted.has(name)), ...wanted]), onOthers));
    for (const entry of entries) await link.runtime.addMcp(entry);
    for (const name of dropped) {
      if (!pool.heldByOthers(link.endpoint, thread.thread.id, thread.directory, name)) await this.#removeEntry(link, name, thread.directory);
    }
    // A dropped entry another thread still holds stays on the server as that thread's: from here on this thread and its subagents are denied it.
    if (dropped.length > 0) await this.#applyRules(thread, await pool.register(link.endpoint, thread.thread.id, thread.directory, wanted, onOthers));
    thread.mcpNames = new Set(wanted.keys());
  }

  /**
   * A thread's launch: the session's LaunchContext and the thread's own, its
   * creation `context`, and its model and agent. For a thread the session
   * already holds (`base`), its creation context, model and agent carry over
   * unless `config` changes them.
   */
  #launchFor(config: ConfigValues | undefined, launch: LaunchContext | undefined, context: CreateThreadInput["context"], base?: Launch): Launch {
    const merged = { ...this.#input.launch, ...launch };
    if ((merged.dynamicTools ?? []).length > 0) throw callErrors.unsupported("tools.dynamicTools");
    const pick = (key: "model" | "agent"): string | undefined => {
      const given = config?.[key];
      if (typeof given === "string") return given;
      if (base?.[key] !== undefined) return base[key];
      const session = this.#input.config?.[key];
      return typeof session === "string" ? session : this.#context.config[key];
    };
    const mcpServers = [...(this.#input.launch?.mcpServers ?? []), ...(launch?.mcpServers ?? [])];
    // Refused before any session exists: a transport OpenCode cannot take.
    for (const server of mcpServers) mcpConfig(server);
    return {
      launchPrompts: [...launchPrompts(this.#input.launch), ...launchPrompts(launch)],
      contextPrompts: context === undefined ? [...(base?.contextPrompts ?? [])] : contextPrompts(context),
      mcpServers,
      model: pick("model"),
      agent: pick("agent"),
    };
  }

  /** The launch a resume gives a thread: a thread the session holds keeps its own unless the resume brings a LaunchContext, which replaces the LaunchContext part. */
  #resumedLaunch(input: ResumeThreadInput, known: OcThread | undefined): Launch {
    if (known === undefined || input.launch !== undefined) return this.#launchFor(input.config, input.launch, undefined, known?.launch);
    const model = input.config?.["model"];
    const agent = input.config?.["agent"];
    return { ...known.launch, model: typeof model === "string" ? model : known.launch.model, agent: typeof agent === "string" ? agent : known.launch.agent };
  }

  #checkMode(policy: RuntimePolicy): void {
    if (!SUPPORTED_MODES.has(policy.mode)) throw callErrors.unsupported(`runtimePolicy.modes.${policy.mode}`);
    if (policy.interaction !== "default") throw callErrors.unsupported("runtimePolicy.interactionModes");
  }

  #applyConfig(thread: OcThread, config: ConfigValues | undefined): void {
    if (config === undefined) return;
    const unknown = Object.keys(config).filter((key) => !SUPPORTED_OPTIONS.has(key));
    if (unknown.length > 0) throw callErrors.validation(unknown.map((key) => ({ message: `OpenCode has no option ${key}`, path: ["config", key] })));
    if (typeof config["model"] === "string") thread.launch.model = config["model"];
    if (typeof config["agent"] === "string") thread.launch.agent = config["agent"];
  }

  #applied(thread: OcThread): ConfigValues {
    return { ...(thread.launch.model === undefined ? {} : { model: thread.launch.model }), ...(thread.launch.agent === undefined ? {} : { agent: thread.launch.agent }) };
  }

  /** The thread's host instructions plus this turn's, as one system text. */
  #system(thread: OcThread, context: StartTurnInput["context"]): string | undefined {
    const parts = [...thread.launch.launchPrompts, ...thread.launch.contextPrompts, ...contextPrompts(context)].filter((part) => part !== "");
    return parts.length === 0 ? undefined : parts.join("\n\n");
  }

  /** The model that last answered in the thread: 1.x needs one to summarize. */
  async #lastModel(thread: OcThread, link: Link): Promise<string | undefined> {
    const history = await link.runtime.messages(thread.sessionId, thread.directory);
    return history.findLast((message) => message.model !== undefined)?.model;
  }

  /** The prompt text and files. Host files reach OpenCode as `file://` URLs; an unreadable one is named as such. */
  async #promptContent(content: readonly ContentBlock[]): Promise<{ text: string; files: Array<{ url: string; name: string; mime: string }> }> {
    const lines: string[] = [];
    const files: Array<{ url: string; name: string; mime: string }> = [];
    for (const block of content) {
      if (block.type === "text") lines.push(block.text);
      else if (block.type === "image" && block.data !== undefined) files.push({ url: `data:${block.mimeType ?? "image/png"};base64,${block.data}`, name: "image", mime: block.mimeType ?? "image/png" });
      else if (block.type === "image" && block.url !== undefined) lines.push(block.url);
      else if (block.type === "resource_link") lines.push(block.uri);
      else if ("attachmentRef" in block && block.attachmentRef !== undefined) {
        const resolved = await this.#context.host.attachments.resolve(block.attachmentRef);
        if (resolved === null) lines.push(`(attachment ${block.attachmentRef} could not be read)`);
        else files.push({ url: `file://${resolved.path.split("/").map(encodeURIComponent).join("/")}`, name: resolved.path.split("/").pop() ?? block.attachmentRef, mime: resolved.mime });
      }
    }
    if (lines.length === 0 && files.length === 0) throw callErrors.validation([{ message: "a turn needs content", path: ["content"] }]);
    return { text: lines.join("\n"), files };
  }

  /** History as turns: each prompt the driver sent starts one; steers and assistant messages belong to the turn before. */
  #historyTurns(thread: OcThread, history: readonly NativeMessage[]): Array<{ turn: Turn; items: Item[]; promptId: string }> {
    const turns: Array<{ turn: Turn; items: Item[]; promptId: string; last: NativeMessage | undefined }> = [];
    for (const message of history) {
      if (message.role === "user" && message.steer !== true) {
        const id = turnIdFor(thread.thread.id, message.id);
        turns.push({
          turn: { id, threadId: thread.thread.id, native: { id: message.id, strength: "strong" }, origin: "user", status: "completed", startedAt: new Date(message.time).toISOString() },
          items: [],
          promptId: message.id,
          last: undefined,
        });
      }
      const current = turns.at(-1);
      if (current === undefined) continue;
      if (message.role === "user") {
        current.items.push({ id: itemIdFor(thread.thread.id, message.id), kind: "user_message", native: { id: message.id, strength: "strong" }, status: "completed", turnId: current.turn.id, text: message.text });
        continue;
      }
      current.last = message;
      for (const part of message.parts) {
        current.items.push({ id: itemIdFor(thread.thread.id, part.id), kind: part.field === "text" ? "assistant_message" : "reasoning", native: { id: part.id, strength: "strong" }, status: "completed", turnId: current.turn.id, ...(part.field === "text" ? { text: part.text } : { reasoning: part.text }) });
      }
      for (const tool of message.tools) {
        current.items.push({
          id: itemIdFor(thread.thread.id, tool.callId),
          native: { id: tool.callId, strength: "strong" },
          status: tool.status === "completed" ? "completed" : tool.status === "error" ? "failed" : "running",
          turnId: current.turn.id,
          ...this.#toolFields(thread, tool),
          ...(tool.output === undefined ? {} : { output: tool.output }),
          ...(tool.error === undefined ? {} : { error: { message: tool.error } }),
        } as Item);
      }
    }
    return turns.map(({ turn, items, promptId, last }) => {
      const error = last?.error;
      if (error === undefined) return { turn, items, promptId };
      return { turn: error.kind === "aborted" ? { ...turn, status: "interrupted" } : { ...turn, status: "failed", failure: failureOf(error, "OpenCode reported an error") }, items, promptId };
    });
  }

  #promptOf(thread: OcThread, history: readonly NativeMessage[], turnId: string): string {
    const found = this.#historyTurns(thread, history).find((entry) => entry.turn.id === turnId);
    if (found === undefined) throw callErrors.notFound({ resource: "turn", id: turnId });
    return found.promptId;
  }

  #toolFields(thread: OcThread, tool: NativeToolState) {
    const mcp = new Set([...thread.mcpNames, ...thread.launch.mcpServers.map((server) => server.name)]);
    return toolItemFields(tool, thread.directory, mcp, tool.childSessionId === undefined ? undefined : subagentIdFor(tool.childSessionId));
  }

  // -------------------------------------------------------------------------
  // Events from OpenCode

  #onNative(event: NativeEvent): void {
    if (this.#closed) return;
    if (event.type === "session") {
      this.#onSessionCreated(event.info);
      return;
    }
    const thread = this.#bySession.get(event.sessionId);
    // Another client's session on a shared server, or one this session does not hold.
    if (thread === undefined) return;
    if (thread.parent !== undefined) {
      this.#onSubagentEvent(thread, event);
      return;
    }
    switch (event.type) {
      case "busy":
        if (thread.active === undefined && thread.compacting === undefined && thread.pendingPrompt === undefined) {
          thread.providerTurns += 1;
          this.#openTurn(thread, providerTurnIdFor(thread.thread.id, thread.providerTurns), { id: null, strength: "weak", ordinal: thread.providerTurns, fingerprint: "provider_initiated" }, undefined, "provider_initiated", undefined);
        }
        return;
      case "idle": {
        if (thread.compacting !== undefined && thread.active === undefined) {
          thread.compacting.resolve();
          return;
        }
        const turn = thread.active;
        if (turn === undefined) return;
        if (event.outcome === "completed") this.#settle(thread, turn, "completed");
        else if (event.outcome === "interrupted") this.#settle(thread, turn, "interrupted");
        else this.#settle(thread, turn, "failed", failureOf(event.error ?? turn.error, "OpenCode reported an error"));
        return;
      }
      case "error":
        if (thread.active !== undefined) thread.active.error = event.error;
        else if (event.error.kind !== "aborted") this.#emit({ type: "notice", level: "error", code: event.error.code ?? "opencode_error", text: event.error.message }, { threadId: thread.thread.id });
        return;
      case "user":
        this.#onUser(thread, event.messageId, event.text, event.steer);
        return;
      case "part":
        this.#onPart(thread, event);
        return;
      case "tool":
        this.#onTool(thread, event.state);
        return;
      case "permission":
        this.#onPermission(thread, thread, event);
        return;
      case "permission.replied":
      case "question.closed":
        this.#onRequestClosed(thread, event.requestId);
        return;
      case "question":
        this.#onQuestion(thread, thread, event);
        return;
      case "compaction":
        return;
      case "retry":
        if (thread.active !== undefined) this.#emit({ type: "retry", attempt: event.attempt, maxAttempts: null, retryDelayMs: event.retryDelayMs }, this.#turnEnvelope(thread.active));
        return;
      case "todos":
        this.#onTodos(thread, event.todos);
        return;
      case "usage": {
        const turn = thread.active;
        const contextMaxTokens = event.model === undefined ? undefined : this.#context.contextWindows.get(event.model);
        this.#emit(
          {
            type: "usage.updated",
            usage: {
              scope: "turn",
              ...(event.model === undefined ? {} : { model: event.model }),
              ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
              ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
              ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
              ...(contextMaxTokens === undefined ? {} : { contextMaxTokens }),
            },
          },
          turn === undefined ? { threadId: thread.thread.id } : this.#turnEnvelope(turn),
        );
        return;
      }
      default:
        return;
    }
  }

  /** A child session of a thread is a subagent (OpenCode's `task` tool runs one). */
  #onSessionCreated(info: { id: string; directory: string; parentId?: string; title?: string }): void {
    if (info.parentId === undefined || this.#bySession.has(info.id)) return;
    const parent = this.#bySession.get(info.parentId);
    if (parent === undefined) return;
    const root = parent.parent === undefined ? parent : (this.#threads.get(parent.parent.threadId) ?? parent);
    const subagentId = subagentIdFor(info.id);
    const turn = root.active;
    const link = parent.link ?? root.link;
    if (link === undefined) return;
    const child = this.#register(info.id, info.directory || parent.directory, parent.policy, { launchPrompts: [], contextPrompts: [], mcpServers: [], model: parent.launch.model, agent: undefined }, link, {}, { threadId: root.thread.id, subagentId });
    child.thread = { ...child.thread, status: "running" };
    void this.#isolateChild(root, child, link).catch((error: unknown) => {
      const text = `The subagent ${subagentId} keeps the rules OpenCode gave it; the driver could not add the current MCP isolation denies: ${error instanceof Error ? error.message : String(error)}`;
      this.#context.host.diagnostics.log({ level: "error", msg: text });
      this.#emit({ type: "notice", level: "error", code: "opencode_subagent_rules", text }, { threadId: root.thread.id });
    });
    this.#emit(
      {
        type: "subagent.upsert",
        subagent: {
          id: subagentId,
          native: { id: info.id, strength: "strong" },
          parentThreadId: root.thread.id,
          threadId: child.thread.id,
          status: "running",
          ...(turn === undefined ? {} : { parentTurnId: turn.id }),
          ...(info.title === undefined ? {} : { name: info.title }),
          startedAt: new Date().toISOString(),
        },
      },
      turn === undefined ? { threadId: root.thread.id } : this.#turnEnvelope(turn),
    );
  }

  #onSubagentEvent(child: OcThread, event: NativeEvent): void {
    const root = this.#threads.get(child.parent!.threadId);
    if (root === undefined) return;
    const envelope = root.active === undefined ? { threadId: root.thread.id } : this.#turnEnvelope(root.active);
    switch (event.type) {
      case "idle": {
        const status = event.outcome === "completed" ? "completed" : event.outcome === "interrupted" ? "interrupted" : "failed";
        child.thread = { ...child.thread, status: "idle" };
        this.#emit({ type: "thread.upsert", thread: { id: child.thread.id, status: "idle" } }, { threadId: child.thread.id });
        this.#emit(
          { type: "subagent.upsert", subagent: { id: child.parent!.subagentId, status, completedAt: new Date().toISOString(), ...(status === "failed" ? { outcome: { status, failure: failureOf(event.error, "The subagent failed") } } : { outcome: { status } }) } },
          envelope,
        );
        return;
      }
      case "permission":
        this.#onPermission(root, child, event);
        return;
      case "question":
        this.#onQuestion(root, child, event);
        return;
      case "permission.replied":
      case "question.closed":
        this.#onRequestClosed(root, event.requestId);
        return;
      default:
        void envelope;
        return;
    }
  }

  #onUser(thread: OcThread, messageId: string, text: string, steer: boolean): void {
    if (!steer && thread.pendingPrompt !== undefined && thread.active === undefined) {
      this.#admit(thread, messageId, text);
      return;
    }
    const turn = thread.active;
    if (turn === undefined) return;
    if (steer && thread.pendingSteers > 0) turn.steerMessageIds.add(messageId);
    if (messageId !== turn.promptMessageId && !turn.steerMessageIds.has(messageId)) return;
    this.#userItem(thread, turn, messageId, text);
  }

  /** The user message item of a prompt or steer, once. */
  #userItem(thread: OcThread, turn: ActiveTurn, messageId: string, text: string): void {
    if (messageId !== turn.promptMessageId) turn.steerMessageIds.add(messageId);
    if (turn.parts.has(messageId)) return;
    const itemId = itemIdFor(thread.thread.id, messageId);
    turn.parts.set(messageId, { itemId, text, field: "text" });
    this.#emit({ type: "item.upsert", item: { id: itemId, kind: "user_message", native: { id: messageId, strength: "strong" }, status: "completed", turnId: turn.id, text } }, this.#turnEnvelope(turn));
  }

  #onPart(thread: OcThread, event: Extract<NativeEvent, { type: "part" }>): void {
    const turn = thread.active;
    if (turn === undefined) return;
    const envelope = this.#turnEnvelope(turn);
    let part = turn.parts.get(event.partId);
    if (part === undefined) {
      part = { itemId: itemIdFor(thread.thread.id, event.partId), text: "", field: event.field };
      turn.parts.set(event.partId, part);
      turn.openItems.add(part.itemId);
      this.#emit({ type: "item.upsert", item: { id: part.itemId, kind: event.field === "text" ? "assistant_message" : "reasoning", native: { id: event.partId, strength: "strong" }, status: "running", turnId: turn.id } }, envelope);
    }
    if (!turn.openItems.has(part.itemId)) return;
    if (event.delta !== undefined && event.delta !== "") {
      part.text += event.delta;
      this.#emit({ type: "item.delta", itemId: part.itemId, field: event.field, chunk: event.delta }, envelope);
    }
    if (event.done) {
      const text = event.text ?? part.text;
      part.text = text;
      turn.openItems.delete(part.itemId);
      this.#emit({ type: "item.upsert", item: { id: part.itemId, status: "completed", ...(event.field === "text" ? { text } : { reasoning: text }) } }, envelope);
    }
  }

  #onTool(thread: OcThread, state: NativeToolState): void {
    const turn = thread.active;
    if (turn === undefined) return;
    const envelope = this.#turnEnvelope(turn);
    let tool = turn.tools.get(state.callId);
    const fields = this.#toolFields(thread, state);
    if (tool === undefined) {
      tool = { itemId: itemIdFor(thread.thread.id, state.callId), opened: true };
      turn.tools.set(state.callId, tool);
      turn.openItems.add(tool.itemId);
      this.#emit({ type: "item.upsert", item: { id: tool.itemId, native: { id: state.callId, strength: "strong" }, status: state.status === "pending" ? "pending" : "running", turnId: turn.id, ...fields } }, envelope);
      if (state.status === "pending" || state.status === "running") {
        if (state.output !== undefined) this.#emit({ type: "item.upsert", item: { id: tool.itemId, output: this.#capped(state.output).text } }, envelope);
        return;
      }
    }
    if (!turn.openItems.has(tool.itemId)) return;
    if (state.status === "pending" || state.status === "running") {
      const patch: ItemPatch = { id: tool.itemId, status: "running", ...fields };
      if (state.output !== undefined) patch.output = this.#capped(state.output).text;
      this.#emit({ type: "item.upsert", item: patch }, envelope);
      return;
    }
    turn.openItems.delete(tool.itemId);
    const output = this.#capped(state.output ?? state.error ?? "");
    const patch: ItemPatch = { id: tool.itemId, status: state.status === "completed" ? "completed" : "failed", output: output.text, ...(output.truncated ? { truncated: true } : {}) };
    if (fields.tool !== undefined && fields.tool !== null) patch.tool = { ...fields.tool, ...(state.status === "completed" ? { result: state.output ?? null } : { error: state.error ?? "failed" }) };
    if (state.status === "error") patch.error = { message: state.error ?? `${state.tool} failed` };
    this.#emit({ type: "item.upsert", item: patch }, envelope);
  }

  #onTodos(thread: OcThread, todos: Extract<NativeEvent, { type: "todos" }>["todos"]): void {
    const turn = thread.active;
    if (turn === undefined) return;
    const envelope = this.#turnEnvelope(turn);
    const entries = todos.map((todo) => ({ ...(todo.id === undefined ? {} : { id: todo.id }), text: todo.text, status: todo.status }));
    if (turn.todoItemId === undefined) {
      const nativeId = `${turn.promptMessageId ?? turn.id}#todos`;
      turn.todoItemId = itemIdFor(thread.thread.id, nativeId);
      turn.openItems.add(turn.todoItemId);
      this.#emit({ type: "item.upsert", item: { id: turn.todoItemId, kind: "todo_list", native: { id: nativeId, strength: "strong" }, status: "running", turnId: turn.id, todos: entries } }, envelope);
      return;
    }
    this.#emit({ type: "item.upsert", item: { id: turn.todoItemId, todos: entries } }, envelope);
  }

  #onPermission(root: OcThread, asker: OcThread, event: Extract<NativeEvent, { type: "permission" }>): void {
    const turn = root.active;
    const id = requestIdFor(root.thread.id, event.requestId);
    if (this.#requests.has(id)) return;
    const metadata = event.metadata;
    const command = typeof metadata["command"] === "string" ? [metadata["command"]] : undefined;
    const path = typeof metadata["filepath"] === "string" ? metadata["filepath"] : typeof metadata["filePath"] === "string" ? metadata["filePath"] : undefined;
    const kind = requestKindOf(event.action);
    const toolItem = event.callId === undefined ? undefined : turn?.tools.get(event.callId)?.itemId;
    const request: Request = {
      id,
      native: { id: event.requestId, strength: "strong" },
      kind,
      origin: { threadId: root.thread.id, ...(turn === undefined ? {} : { turnId: turn.id }), ...(toolItem === undefined ? {} : { itemId: toolItem }), ...(asker.parent === undefined ? {} : { subagentId: asker.parent.subagentId }) },
      subject: {
        cwd: asker.directory,
        ...(command === undefined ? {} : { command }),
        ...(path !== undefined ? { paths: [path] } : kind === "file_change" || kind === "file_read" ? { paths: [...event.resources] } : {}),
        tool: { name: event.action, input: { resources: [...event.resources], ...metadata } },
      },
      options: this.#permissionOptions(event),
      allowCustomAnswer: false,
      allowFeedback: false,
      response: { mode: "live" },
      survivesRestart: false,
      status: "pending",
    };
    const override = root.policy?.mode === "full_access" ? this.#fullAccessOverride(root, asker, event) : undefined;
    if (override !== undefined) request.fullAccessOverride = override;
    this.#requests.set(id, { request, threadId: root.thread.id, turnId: turn?.id, sessionId: asker.sessionId, nativeId: event.requestId, kind: "permission", questions: [], inFlight: undefined, resolved: false });
    this.#emit({ type: "request.upsert", request }, turn === undefined ? { threadId: root.thread.id } : this.#turnEnvelope(turn));
  }

  /**
   * OpenCode's replies as options. A shared 1.x server keeps an "always"
   * grant in memory for every session of the directory and checks it after
   * their own rules (1.19.6 `permission/index.ts` `ask`), so a grant that can
   * match another thread's MCP resources (`read` of `mcp:<server>:*`, which
   * an ordinary file read's `*` does) would reopen them for every thread.
   * There the driver offers "always" only for a grant that cannot
   * (`grantCouldReachMcpResources`).
   */
  #permissionOptions(event: Extract<NativeEvent, { type: "permission" }>) {
    const options = permissionOptions(event.action, event.always);
    const shared1x = this.#context.shape.generation === 1 && !this.#dedicated();
    if (!shared1x || !grantCouldReachMcpResources(event.action, event.always)) return options;
    return options.filter((option) => option.optionId !== "always");
  }

  /**
   * Why OpenCode asked a full_access thread, whose own rules allow everything
   * (`* allow` after the agent's): a rule the host set asks (`ask_rule`); or
   * the asker is a 1.x subagent, whose session OpenCode gives its own agent's
   * rules plus only the thread's denies (1.19.6 `agent/subagent-permissions.ts`),
   * so that agent's defaults asked and the thread's full_access answers it
   * (undefined: the host's auto-reply picks once); or else OpenCode checked on
   * its own, as a plugin's `permission.evaluate` hook can (2.1.2
   * `core/src/permission.ts` `evaluateInput`), which must reach the user
   * (`provider_check`).
   */
  #fullAccessOverride(root: OcThread, asker: OcThread, event: Extract<NativeEvent, { type: "permission" }>): "ask_rule" | "provider_check" | undefined {
    if (event.resources.some((resource) => lastMatchingEffect(event.action, resource, root.hostRules) === "ask")) return "ask_rule";
    if (asker.parent !== undefined && this.#context.shape.generation === 1) return undefined;
    return "provider_check";
  }

  #onQuestion(root: OcThread, asker: OcThread, event: Extract<NativeEvent, { type: "question" }>): void {
    const turn = root.active;
    const id = requestIdFor(root.thread.id, event.requestId);
    if (this.#requests.has(id)) return;
    const questions: Question[] = event.questions.map((question) => ({
      id: question.id,
      type: question.kind,
      prompt: question.prompt === "" ? event.title : question.prompt,
      ...(question.header === undefined ? {} : { header: question.header }),
      ...(question.options.length === 0 ? {} : { options: question.options.map((option) => ({ id: option.id, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })) }),
      required: true,
      allowCustom: question.allowCustom,
    }));
    const request: Request = {
      id,
      native: { id: event.requestId, strength: "strong" },
      kind: "user_input",
      origin: { threadId: root.thread.id, ...(turn === undefined ? {} : { turnId: turn.id }), ...(asker.parent === undefined ? {} : { subagentId: asker.parent.subagentId }) },
      questions,
      allowCustomAnswer: event.questions.some((question) => question.allowCustom),
      allowFeedback: false,
      response: { mode: "live" },
      survivesRestart: false,
      status: "pending",
    };
    this.#requests.set(id, { request, threadId: root.thread.id, turnId: turn?.id, sessionId: asker.sessionId, nativeId: event.requestId, kind: "question", questions: event.questions, inFlight: undefined, resolved: false });
    this.#emit({ type: "request.upsert", request }, turn === undefined ? { threadId: root.thread.id } : this.#turnEnvelope(turn));
  }

  /** OpenCode answered a request itself (an "always" grant covered it, or another client replied). */
  #onRequestClosed(root: OcThread, nativeId: string): void {
    const id = requestIdFor(root.thread.id, nativeId);
    const pending = this.#requests.get(id);
    if (pending === undefined || pending.resolved || pending.inFlight !== undefined) return;
    pending.resolved = true;
    this.#emit({ type: "request.upsert", request: { id, status: "resolved" } }, this.#envelope(pending.threadId, pending.turnId));
  }

  #expireRequests(threadId: string): void {
    for (const pending of this.#requests.values()) {
      if (pending.threadId !== threadId || pending.resolved) continue;
      pending.resolved = true;
      this.#emit({ type: "request.upsert", request: { id: pending.request.id, status: "expired" } }, this.#envelope(pending.threadId, pending.turnId));
    }
  }

  #openTurn(thread: OcThread, id: string, native: Turn["native"], promptMessageId: string | undefined, origin: "user" | "provider_initiated", input: StartTurnInput | undefined): ActiveTurn {
    const turn: ActiveTurn = {
      id,
      threadId: thread.thread.id,
      hostTag: input?.hostTag,
      promptMessageId,
      steerMessageIds: new Set(),
      parts: new Map(),
      tools: new Map(),
      openItems: new Set(),
      todoItemId: undefined,
      error: undefined,
      settled: false,
    };
    thread.active = turn;
    this.#turnThreads.set(id, thread.thread.id);
    thread.thread = { ...thread.thread, status: "running" };
    this.#emit(
      {
        type: "turn.upsert",
        turn: {
          id,
          threadId: thread.thread.id,
          native,
          origin,
          status: "running",
          startedAt: new Date().toISOString(),
          ...(input === undefined ? {} : { clientTurnKey: input.clientTurnKey }),
          ...(input?.hostTag === undefined ? {} : { hostTag: input.hostTag }),
          ...(thread.launch.model === undefined ? {} : { model: thread.launch.model }),
        },
      },
      this.#turnEnvelope(turn),
    );
    return turn;
  }

  /** Ends a turn: settles what it left open and cancels its requests, then emits its status and its one `turn.terminal`. */
  #settle(thread: OcThread, turn: ActiveTurn, status: "completed" | "interrupted" | "failed", failure?: Failure, disposition: "reusable" | "broken" = "reusable"): void {
    if (thread.active === turn) thread.active = undefined;
    if (turn.settled) return;
    turn.settled = true;
    thread.thread = { ...thread.thread, status: thread.unloaded ? "unloaded" : "idle" };
    const envelope = this.#turnEnvelope(turn);
    for (const itemId of turn.openItems) this.#emit({ type: "item.upsert", item: { id: itemId, status } }, envelope);
    turn.openItems.clear();
    for (const pending of this.#requests.values()) {
      if (pending.turnId !== turn.id || pending.resolved) continue;
      pending.resolved = true;
      this.#emit({ type: "request.upsert", request: { id: pending.request.id, status: "cancelled" } }, envelope);
    }
    this.#emit({ type: "turn.upsert", turn: { id: turn.id, status, completedAt: new Date().toISOString(), ...(failure === undefined ? {} : { failure }) } }, envelope);
    this.#emit({ type: "turn.terminal", turnId: turn.id, status, ...(failure === undefined ? {} : { failure }), threadDisposition: disposition }, envelope);
  }

  #capped(text: string): { text: string; truncated: boolean } {
    const limit = this.#input.payloadLimits?.maxToolOutputBytes;
    return limit === undefined ? { text, truncated: false } : truncateUtf8(text, limit);
  }

  // -------------------------------------------------------------------------
  // Helpers

  #open(): void {
    if (this.#closed) throw callErrors.invalidState("session_closed");
  }

  #thread(threadId: string): OcThread {
    const thread = this.#threads.get(threadId);
    if (thread === undefined) throw callErrors.notFound({ resource: "thread", id: threadId });
    return thread;
  }

  #turnEnvelope(turn: ActiveTurn): Envelope {
    return { threadId: turn.threadId, turnId: turn.id, ...(turn.hostTag === undefined ? {} : { hostTag: turn.hostTag }) };
  }

  #envelope(threadId: string, turnId: string | undefined): Envelope {
    return { threadId, ...(turnId === undefined ? {} : { turnId }) };
  }

  #emit(body: AriEventBody, envelope: Envelope = {}): void {
    if (this.#sequencer.closed) return;
    this.#sequencer.emit({ body, ...envelope });
  }
}
