// One ARI session on one `codex app-server` process. The app-server holds any
// number of threads; this session maps its JSON-RPC traffic onto ARI events
// and calls.
//
// Rules this file keeps (each is a Codex quirk a naive driver gets wrong):
//
// - A turn settles only on Codex's `turn/completed`, or when the process
//   exits. No timer settles a turn.
// - Codex starts goal turns on its own: at once when an active goal is set on
//   an idle thread, and after each completed turn while the goal stays
//   active. A `turn/started` for a turn the host did not start is
//   `origin: "provider_initiated"`; while a goal run is open, it carries the
//   run's `hostTag` and `parentTurnId`, and the shared `ari.goal` extension
//   lists it in `turnIds`. Only the `turn/start` answer names the host's turn:
//   a `turn/started` that arrives first while the goal is active is Codex's
//   own, and when the answer then names that turn, Codex added the host's
//   message to it (`accepted: "steered"`).
// - Async questions arrive inside an `agentMessage` item (`delivery:
//   "async"`), not as a server request. They become `message`-mode requests
//   with `survivesRestart: true`; they stay pending when their turn ends or
//   the process exits, and come back on resume while no later user message
//   answered them.
// - A steer names the turn it means (`expectedTurnId`). When Codex refuses it
//   because that turn already ended, the host gets `prompt_required`.
// - Codex approval decisions have no ids. A decision's canonical text is its
//   native option id, so two "always" decisions (a session grant and an
//   exec-policy amendment) stay two options of one approval.
// - Thread ids come from Codex, so the host's per-thread tool server
//   (`hostTools.mcpServerFor`) is known only after `thread/start` or
//   `thread/fork`. Codex takes MCP servers only in the `config` of
//   `thread/start`, `thread/fork` and a cold `thread/resume` (it ignores a
//   resume's overrides while the thread is loaded), and it cannot resume a
//   thread before the thread has a rollout. `thread/archive` gives a fresh
//   thread its empty rollout and shuts it down, so a new or forked thread is
//   archived, unarchived and resumed with the host's server before its first
//   turn (`#attachHostTools`). The driver writes no file.

import { callErrors } from "../../errors.ts";
import { JsonRpcError } from "../../driver-kit/json-rpc.ts";
import { EventSequencer } from "../../driver-kit/sequencer.ts";
import type { TaskInfo } from "../../generated/background.ts";
import type { Capabilities } from "../../generated/capabilities.ts";
import type { ContentBlock } from "../../generated/common.ts";
import type { ConfigChangePlan, RuntimePolicy } from "../../generated/config.ts";
import type { AriEvent, AriEventBody } from "../../generated/events.ts";
import type { AriGoal } from "../../generated/extensions/ari.goal.ts";
import type { CodexGoal, CodexReadState, CodexReadStateResult } from "../../generated/extensions/codex.ts";
import type { OpenSessionInput } from "../../generated/instance.ts";
import type { Item } from "../../generated/item.ts";
import type { Plan } from "../../generated/plan.ts";
import type { Question, Request, RequestOption } from "../../generated/request.ts";
import type {
  AppliedThread,
  CreateThreadInput,
  ForkThreadInput,
  InjectHistoryInput,
  InjectHistoryResult,
  InterruptTurnInput,
  LaunchContext,
  McpCallResult,
  McpResourceContents,
  McpTool,
  PlanConfigChangeInput,
  RespondInput,
  RespondResult,
  ResumeThreadInput,
  RollbackThreadInput,
  StartTurnInput,
  StartTurnResult,
} from "../../generated/session.ts";
import type { SubagentOutcome } from "../../generated/subagent.ts";
import type { Thread, ThreadSnapshot, Turn } from "../../generated/thread.ts";
import type { LimitStatus } from "../../generated/usage.ts";
import type { HostServices, Session } from "../../runtime.ts";
import { CodexConnection, callErrorFromCodex } from "./connection.ts";
import type {
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  FileChangeRequestApprovalParams,
  FileUpdateChange,
  McpServerElicitationRequestParams,
  PermissionsRequestApprovalParams,
  ServerRequestResolvedNotification,
  ThreadGoal,
  ThreadItem,
  ThreadReadState,
  ThreadStartParams,
  ToolRequestUserInputParams,
  Turn as CodexTurn,
  TurnError,
  UserInput,
} from "./generated/protocol.ts";
import {
  DEFAULT_COMMAND_DECISIONS,
  FILE_CHANGE_DECISIONS,
  approvalOption,
  codexPolicy,
  decisionFromOptionId,
  failureFromCodex,
  isoFromMillis,
  isoFromSeconds,
  itemFromCodex,
  itemIdFor,
  limitsFromCodex,
  planIdFor,
  requestIdFor,
  strongRef,
  subagentIdFor,
  taskIdFor,
  textOf,
  threadIdFor,
  todoItemIdFor,
  turnIdFor,
  turnStatusFromCodex,
  usageFromCodex,
  userInputText,
} from "./mapping.ts";

/** The extension namespaces this driver serves, each at version 1. */
export const CODEX_EXTENSIONS = ["ari.goal", "codex.goal", "codex.review", "codex.readState", "codex.memory"] as const;

/** What a session needs from its instance. */
export interface CodexSessionRuntime {
  readonly host: HostServices<unknown>;
  readonly instanceId: string;
  readonly capabilities: Capabilities;
  readonly defaultModel?: string;
  readonly defaultEffort?: string;
  /** The `codex app-server` spawn request: command, args, env (with the instance's CODEX_HOME when it has a managed profile). */
  spawnRequest(): Promise<import("../../generated/host.ts").SpawnRequest>;
  /** Signs the fresh app-server in with the instance's managed credential, if it has one. */
  signIn(connection: CodexConnection): Promise<void>;
  /** Answers Codex's request for refreshed ChatGPT tokens with the latest ones handed over. */
  refreshTokens(): Promise<{ accessToken: string; chatgptAccountId: string; chatgptPlanType?: string | null }>;
  /** Codex reported new rate limits. */
  onLimits(limits: LimitStatus): void;
}

interface PendingStart {
  readonly clientTurnKey?: string;
  readonly hostTag?: string;
  /** The request's answer will name the turn (`turn/start`, `review/start`); a compaction's turn is the next `turn/started`. */
  readonly answerNamesTurn: boolean;
  readonly settled?: () => void;
}

interface TurnState {
  readonly id: string;
  readonly nativeId: string;
  readonly threadId: string;
  readonly origin: "user" | "provider_initiated";
  readonly hostTag: string | undefined;
  /** Open items by native id. */
  readonly openItems: Map<string, Item>;
  /** File changes Codex reported per native item id, for approval subjects. */
  readonly fileChanges: Map<string, FileUpdateChange[]>;
  todoOpen: boolean;
  settled: boolean;
  lastError: TurnError | undefined;
  retries: number;
  readonly done: Promise<void>;
  readonly finish: () => void;
}

interface GoalRun {
  hostTag: string | undefined;
  rootTurnId: string | undefined;
  readonly turnIds: string[];
}

interface ThreadState {
  thread: Thread;
  readonly nativeId: string;
  policy: RuntimePolicy;
  model: string | undefined;
  readonly launch: LaunchContext | undefined;
  readonly instructions: string | undefined;
  active: TurnState | undefined;
  pendingStart: PendingStart | undefined;
  /** Loaded in the current app-server process. */
  loaded: boolean;
  /** The host unloaded it; only `resumeThread` brings it back. */
  unloaded: boolean;
  goal: ThreadGoal | undefined;
  /** Bumped by each goal notification, so an older call's answer does not overwrite a newer goal. */
  goalSeq: number;
  goalRun: GoalRun | undefined;
  /** Native turn ids in order, as far as this session saw them. */
  readonly turnOrder: string[];
}

interface PendingRequest {
  readonly request: Request;
  /** The JSON-RPC id of the server request, for `serverRequest/resolved`. */
  readonly rpcId: string | number | null;
  readonly threadId: string;
  readonly turnId: string | undefined;
  /** Answers the native request; undefined for message-mode requests. */
  readonly reply: ((input: RespondInput) => void) | undefined;
  readonly abandon: () => void;
  inFlight: string | undefined;
  resolved: boolean;
}

interface SubagentState {
  readonly id: string;
  readonly childNativeId: string;
  readonly parentThreadId: string;
  name: string | undefined;
  status: string;
  activeChildTurn: string | undefined;
}

/** What a server request handler knows about the request. */
interface RequestContext {
  readonly signal: AbortSignal;
  readonly id: string | number | null;
}

const SETTLED_ITEM_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinInstructions(parts: ReadonlyArray<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined && part.trim() !== "");
  return present.length === 0 ? undefined : present.join("\n\n");
}

/** Codex config overrides that register each MCP server under its given name. */
export function mcpServerConfig(servers: ReadonlyArray<{ name: string; transport: string; command?: string; args?: string[]; env?: { [key: string]: string }; cwd?: string; url?: string; headers?: { [key: string]: string } }>): {
  [key: string]: unknown;
} {
  const config: { [key: string]: unknown } = {};
  for (const server of servers) {
    if (server.transport === "stdio") {
      if (server.command === undefined) throw callErrors.validation([{ message: `MCP server ${server.name} has no command`, path: ["mcpServers"] }]);
      config[`mcp_servers.${server.name}`] = {
        command: server.command,
        ...(server.args === undefined ? {} : { args: [...server.args] }),
        ...(server.env === undefined ? {} : { env: { ...server.env } }),
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      };
    } else if (server.transport === "http") {
      if (server.url === undefined) throw callErrors.validation([{ message: `MCP server ${server.name} has no url`, path: ["mcpServers"] }]);
      config[`mcp_servers.${server.name}`] = { url: server.url, ...(server.headers === undefined ? {} : { http_headers: { ...server.headers } }) };
    } else {
      throw callErrors.unsupported(`mcp.acceptsHostServers.${server.transport}`, `Codex does not accept ${server.transport} MCP servers`);
    }
  }
  return config;
}

export class CodexSession implements Session {
  readonly id: string;
  readonly #runtime: CodexSessionRuntime;
  readonly #input: OpenSessionInput;
  readonly #emitDiffs: boolean;
  readonly #sequencer: EventSequencer;
  readonly #threads = new Map<string, ThreadState>();
  readonly #threadsByNative = new Map<string, string>();
  readonly #turnsByNative = new Map<string, TurnState>();
  readonly #turnsById = new Map<string, TurnState>();
  readonly #requests = new Map<string, PendingRequest>();
  readonly #responses = new Map<string, Promise<RespondResult | void>>();
  readonly #turnKeys = new Map<string, Promise<StartTurnResult>>();
  readonly #tasks = new Map<string, { readonly processId: string; readonly threadId: string; readonly title: string; running: boolean }>();
  readonly #subagents = new Map<string, SubagentState>();
  readonly #subagentsByChild = new Map<string, SubagentState>();
  readonly #contextWindows = new Map<string, number>();
  #latestLimits: LimitStatus | undefined;
  #connection: Promise<CodexConnection> | undefined;
  /** The process this session talks to now; an exit of an older one changes nothing. */
  #current: CodexConnection | undefined;
  #closed = false;

  constructor(runtime: CodexSessionRuntime, input: OpenSessionInput, id: string) {
    this.id = id;
    this.#runtime = runtime;
    this.#input = input;
    this.#emitDiffs = input.emitDiffs !== false;
    this.#sequencer = new EventSequencer({ sessionId: id });
  }

  /** Starts the app-server and announces the session. */
  async open(): Promise<void> {
    await this.#agent();
    this.#emit({ type: "capabilities.updated", capabilities: this.#runtime.capabilities });
    this.#emit({ type: "session.state", state: "ready" });
  }

  capabilities(): Capabilities {
    return this.#runtime.capabilities;
  }

  events(options?: { fromSeq?: number }): AsyncIterable<AriEvent> {
    return this.#sequencer.events(options?.fromSeq === undefined ? {} : { fromSeq: options.fromSeq });
  }

  // Threads.

  async createThread(input: CreateThreadInput): Promise<AppliedThread> {
    this.#open();
    const connection = await this.#agent();
    const model = (input.config?.["model"] as string | undefined) ?? this.#runtime.defaultModel;
    const instructions = joinInstructions([...(input.launch?.appendSystemPrompt ?? []), ...(input.launch?.developerPrompt ?? []), input.context?.system, input.context?.developer]);
    const started = await this.#startNative(connection, { policy: input.policy, model, launch: input.launch, instructions, ephemeral: input.persistSession === false });
    const thread = this.#register(started.nativeId, started.cwd, { ...input.policy, cwd: started.cwd }, started.model, input.launch, instructions, input.title);
    return { ...thread, appliedConfig: { model: started.model, ...(started.reasoningEffort === undefined ? {} : { reasoningEffort: started.reasoningEffort }) } };
  }

  /** Starts a native thread, then gives it the host's tool server (`#attachHostTools`) unless it is ephemeral. */
  async #startNative(
    connection: CodexConnection,
    spec: { policy: RuntimePolicy; model: string | undefined; launch: LaunchContext | undefined; instructions: string | undefined; ephemeral: boolean },
  ): Promise<{ nativeId: string; cwd: string; model: string; reasoningEffort?: string }> {
    const policy = codexPolicy(spec.policy);
    const config = mcpServerConfig(spec.launch?.mcpServers ?? []);
    const params: ThreadStartParams = {
      cwd: spec.policy.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      approvalsReviewer: policy.approvalsReviewer,
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.instructions === undefined ? {} : { developerInstructions: spec.instructions }),
      ...(Object.keys(config).length === 0 ? {} : { config }),
      ...(spec.launch?.dynamicTools === undefined || spec.launch.dynamicTools.length === 0
        ? {}
        : { dynamicTools: spec.launch.dynamicTools.map((tool) => ({ type: "function" as const, name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema })) }),
      ...(spec.ephemeral ? { ephemeral: true } : {}),
    };
    const started = await connection.client.threadStart(params).catch((error: unknown) => {
      throw callErrorFromCodex(error, "thread");
    });
    const effort = started.reasoningEffort === null || started.reasoningEffort === undefined ? {} : { reasoningEffort: started.reasoningEffort };
    // An ephemeral thread never has a rollout to resume: it gets only the launch context's MCP servers.
    if (spec.ephemeral) return { nativeId: started.thread.id, cwd: started.cwd, model: started.model, ...effort };
    const attached = await this.#attachHostTools(connection, started.thread.id, { ...spec.policy, cwd: started.cwd }, spec.launch, spec.model, spec.instructions);
    return { nativeId: started.thread.id, cwd: attached.cwd, model: attached.model, ...effort };
  }

  /**
   * Gives a thread Codex just started or forked the host's tool server for its
   * ARI thread id, before any turn runs. Codex ignores a resume's `config`
   * while the thread is loaded (app-server thread_processor.rs:4900–4955) and
   * refuses to resume a thread before its first turn wrote a rollout
   * (tests/suite/v2/thread_resume.rs:521–566). `thread/archive` writes the
   * empty rollout without a turn and shuts the thread down
   * (thread_processor.rs:1895–1904, 1242–1267), so: archive, unarchive, and a
   * cold resume with the launch servers and the host's server.
   */
  async #attachHostTools(
    connection: CodexConnection,
    nativeId: string,
    policy: RuntimePolicy,
    launch: LaunchContext | undefined,
    model: string | undefined,
    instructions: string | undefined,
  ): Promise<{ cwd: string; model: string }> {
    await connection.client.threadArchive({ threadId: nativeId }).catch((error: unknown) => {
      throw callErrorFromCodex(error, "thread");
    });
    await connection.client.threadUnarchive({ threadId: nativeId }).catch((error: unknown) => {
      throw callErrorFromCodex(error, "thread");
    });
    const resumed = await this.#resumeNative(connection, nativeId, threadIdFor(nativeId), policy, launch, model === undefined ? undefined : { model }, instructions).catch((error: unknown) => {
      throw callErrorFromCodex(error, "thread");
    });
    return { cwd: resumed.cwd, model: resumed.model };
  }

  async resumeThread(input: ResumeThreadInput): Promise<AppliedThread> {
    this.#open();
    const nativeId = "handle" in input.native ? input.native.handle : input.native.id;
    if (nativeId === null) throw callErrors.validation([{ message: "resumeThread needs a native id or handle", path: ["native"] }]);
    const known = this.#threadsByNative.get(nativeId);
    const knownState = known === undefined ? undefined : this.#threads.get(known);
    if (knownState !== undefined && !knownState.unloaded && knownState.loaded) return knownState.thread;
    const connection = await this.#agent();
    const policyInput = input.policy ?? knownState?.policy;
    const threadId = threadIdFor(nativeId);
    try {
      const resumed = await this.#resumeNative(connection, nativeId, threadId, policyInput, input.launch ?? knownState?.launch, input.config);
      const thread = this.#register(resumed.nativeId, resumed.cwd, policyInput === undefined ? { mode: "approval_required", interaction: "default", cwd: resumed.cwd } : { ...policyInput, cwd: policyInput.cwd === "" ? resumed.cwd : policyInput.cwd }, resumed.model, input.launch ?? knownState?.launch, resumed.instructions);
      await this.#replayHistory(connection, this.#threads.get(thread.id)!, input.quiet === true);
      return { ...thread, appliedConfig: { model: resumed.model } };
    } catch (error) {
      const message = error instanceof JsonRpcError ? error.message : "";
      const locked = /already has an active writer/i.test(message);
      const missing = /no rollout found|thread not found/i.test(message);
      if ((!locked && !missing) || input.policy === undefined) throw callErrorFromCodex(error, "native session");
      // Fall back to a fresh native session with the failed resume's launch context, and say so: the old context is gone.
      const launch = input.launch ?? knownState?.launch;
      const instructions = joinInstructions([...(launch?.appendSystemPrompt ?? []), ...(launch?.developerPrompt ?? [])]);
      const model = typeof input.config?.["model"] === "string" ? input.config["model"] : this.#runtime.defaultModel;
      const fresh = await this.#startNative(connection, { policy: input.policy, model, launch, instructions, ephemeral: false });
      this.#emit(
        {
          type: "session.replaced",
          previousNativeId: nativeId,
          reason: locked ? "The Codex thread is open for writing in another process." : "Codex has no saved thread with that id.",
          contextLost: true,
          showRuntimeNote: true,
        },
        { threadId: threadIdFor(fresh.nativeId) },
      );
      return this.#register(fresh.nativeId, fresh.cwd, { ...input.policy, cwd: fresh.cwd }, fresh.model, launch, instructions);
    }
  }

  async readSnapshot(threadId: string): Promise<ThreadSnapshot> {
    this.#open();
    const thread = this.#thread(threadId);
    const connection = await this.#agent();
    const turns = await this.#nativeTurns(connection, thread.nativeId);
    return this.#snapshot(thread, turns);
  }

  async forkThread(input: ForkThreadInput): Promise<Thread> {
    this.#open();
    if (input.at.type === "item") throw callErrors.unsupported("threads.fork.fromItem");
    const source = this.#thread(input.threadId);
    const connection = await this.#agent();
    await this.#ensureLoaded(connection, source);
    const lastTurnId = input.at.type === "turn" ? this.#nativeTurnId(source, input.at.turnId) : undefined;
    const policyInput = input.policy ?? (input.cwd === undefined ? source.policy : { ...source.policy, cwd: input.cwd });
    const policy = codexPolicy(policyInput);
    const model = typeof input.config?.["model"] === "string" ? input.config["model"] : undefined;
    const launchServers = mcpServerConfig(source.launch?.mcpServers ?? []);
    const forked = await connection.client
      .threadFork({
        threadId: source.nativeId,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        approvalsReviewer: policy.approvalsReviewer,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(lastTurnId === undefined ? {} : { lastTurnId }),
        ...(source.instructions === undefined ? {} : { developerInstructions: source.instructions }),
        ...(model === undefined ? {} : { model }),
        ...(Object.keys(launchServers).length === 0 ? {} : { config: launchServers }),
      })
      .catch((error: unknown) => {
        throw callErrorFromCodex(error, "thread");
      });
    // The fork has a new id, so the host's tool server for it can follow only now.
    const attached = await this.#attachHostTools(connection, forked.thread.id, { ...policyInput, cwd: forked.cwd }, source.launch, model, source.instructions);
    return this.#register(forked.thread.id, attached.cwd, { ...policyInput, cwd: attached.cwd }, attached.model, source.launch, source.instructions, undefined, {
      threadId: source.thread.id,
      ...(input.at.type === "turn" ? { turnId: input.at.turnId } : {}),
    });
  }

  async rollbackThread(input: RollbackThreadInput): Promise<ThreadSnapshot> {
    this.#open();
    const thread = this.#thread(input.threadId);
    if (thread.active !== undefined) throw callErrors.invalidState("turn_active", "Stop the active turn before rolling back");
    const connection = await this.#agent();
    await this.#ensureLoaded(connection, thread);
    const turns = await this.#nativeTurns(connection, thread.nativeId);
    let keep: number;
    if (input.to.type === "start") keep = 0;
    else {
      const native = this.#nativeTurnId(thread, input.to.turnId);
      const index = turns.findIndex((turn) => turn.id === native);
      if (index === -1) throw callErrors.notFound({ resource: "turn", id: input.to.turnId });
      keep = index + 1;
    }
    let remaining = turns;
    if (keep < turns.length) {
      // Codex keeps the history before `beforeTurnId`, so the turn after the target is the one to name.
      await connection.client.threadRevert({ threadId: thread.nativeId, beforeTurnId: turns[keep]!.id }).catch((error: unknown) => {
        throw callErrorFromCodex(error, "turn");
      });
      remaining = await this.#nativeTurns(connection, thread.nativeId);
    }
    thread.turnOrder.splice(0, thread.turnOrder.length, ...remaining.map((turn) => turn.id));
    this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id }, retainedNativeTurnIds: remaining.map((turn) => turn.id) }, { threadId: thread.thread.id });
    return this.#snapshot(thread, remaining);
  }

  async compactThread(threadId: string): Promise<void> {
    this.#open();
    const thread = this.#thread(threadId);
    if (thread.active !== undefined) throw callErrors.invalidState("turn_active", "Codex compacts between turns");
    const connection = await this.#agent();
    await this.#ensureLoaded(connection, thread);
    // Codex runs the compaction as a turn of its own; the call resolves once that turn ends.
    const done = this.#expectHostTurn(thread, { answerNamesTurn: false });
    await connection.client.threadCompactStart({ threadId: thread.nativeId }).catch((error: unknown) => {
      thread.pendingStart = undefined;
      throw callErrorFromCodex(error, "thread");
    });
    await done;
  }

  async injectHistory(input: InjectHistoryInput): Promise<InjectHistoryResult> {
    this.#open();
    const thread = this.#thread(input.threadId);
    const connection = await this.#agent();
    await this.#ensureLoaded(connection, thread);
    const items: unknown[] = [];
    if (input.summary.trim() !== "") items.push({ type: "message", role: "developer", content: [{ type: "input_text", text: input.summary }] });
    for (const message of input.messages) {
      const text = textOf(message.content);
      const role = message.role === "assistant" ? "assistant" : message.role === "system" ? "developer" : "user";
      items.push({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
    }
    await connection.client.threadInjectItems({ threadId: thread.nativeId, items }).catch((error: unknown) => {
      throw callErrorFromCodex(error, "thread");
    });
    return { consumed: true };
  }

  async unloadThread(threadId: string): Promise<void> {
    this.#open();
    const thread = this.#thread(threadId);
    if (thread.active !== undefined) throw callErrors.invalidState("turn_active", "Stop the active turn before unloading the thread");
    if (thread.loaded) {
      const connection = await this.#agent();
      await connection.client.threadUnsubscribe({ threadId: thread.nativeId }).catch((error: unknown) => {
        throw callErrorFromCodex(error, "thread");
      });
    }
    thread.loaded = false;
    thread.unloaded = true;
    thread.thread = { ...thread.thread, status: "unloaded" };
    this.#emit({ type: "thread.upsert", thread: { id: threadId, status: "unloaded" } }, { threadId });
  }

  // Parking.

  canRelease(): boolean {
    if (this.#closed) return false;
    const busy = [...this.#threads.values()].some((thread) => thread.active !== undefined || thread.pendingStart !== undefined);
    const pending = [...this.#requests.values()].some((request) => !request.resolved && request.reply !== undefined);
    const working = [...this.#tasks.values()].some((task) => task.running);
    return !busy && !pending && !working;
  }

  async release(): Promise<void> {
    this.#open();
    if (!this.canRelease()) throw callErrors.invalidState("release_vetoed", "Turns, requests or background terminals are still running");
    const connection = this.#connection;
    this.#connection = undefined;
    for (const thread of this.#threads.values()) thread.loaded = false;
    if (connection !== undefined) await (await connection.catch(() => undefined))?.close();
  }

  // Turns.

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
    if (thread.unloaded) throw callErrors.invalidState("thread_unloaded", "Resume the thread first");
    if (input.intent === "queue") return { status: "unsupported", capability: "turns.queue" };
    if (input.intent !== "start" && input.intent !== "steer") return { status: "unsupported", capability: `turns.${input.intent}` };
    const connection = await this.#agent();
    await this.#ensureLoaded(connection, thread);
    const userInput = await this.#userInput(input.content);

    if (input.intent === "steer") {
      const active = thread.active;
      if (active === undefined || (input.expectedTurnId !== undefined && input.expectedTurnId !== active.id)) return { status: "prompt_required" };
      try {
        await connection.client.turnSteer({ threadId: thread.nativeId, expectedTurnId: active.nativeId, input: userInput });
      } catch (error) {
        // Codex already ended the turn (or another turn is active): the host must start a new turn.
        if (error instanceof JsonRpcError && /no active turn|expected active turn id/i.test(error.message)) return { status: "prompt_required" };
        throw callErrorFromCodex(error, "turn");
      }
      return { status: "accepted", turnId: active.id, accepted: "steered" };
    }

    if (thread.active !== undefined || thread.pendingStart !== undefined) throw callErrors.invalidState("previous_turn_active", "A turn is still running on this thread");
    const policy = input.policy === undefined ? undefined : codexPolicy(input.policy);
    if (input.policy !== undefined) thread.policy = input.policy;
    const model = typeof input.config?.["model"] === "string" ? input.config["model"] : undefined;
    const effort = typeof input.config?.["reasoningEffort"] === "string" ? input.config["reasoningEffort"] : this.#runtime.defaultEffort;
    if (model !== undefined) thread.model = model;
    const additionalContext: { [key: string]: { kind: "application" | "untrusted"; value: string; name?: string } } = {};
    const turnInstructions = joinInstructions([input.context?.system, input.context?.developer]);
    if (turnInstructions !== undefined) additionalContext["host.instructions"] = { kind: "application", value: turnInstructions };
    for (const synthetic of input.context?.synthetic ?? []) additionalContext[synthetic.key] = { kind: "untrusted", name: synthetic.key, value: synthetic.text };
    const marker = { clientTurnKey: input.clientTurnKey, ...(input.hostTag === undefined ? {} : { hostTag: input.hostTag }), answerNamesTurn: true };
    this.#expectHostTurn(thread, marker);
    const pending = thread.pendingStart;
    try {
      const response = await connection.client.turnStart({
        threadId: thread.nativeId,
        input: userInput,
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(policy === undefined ? {} : { approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer, sandboxPolicy: policy.sandboxPolicy, cwd: input.policy!.cwd }),
        ...(Object.keys(additionalContext).length === 0 ? {} : { additionalContext }),
      });
      const known = this.#turnsByNative.get(response.turn.id);
      if (known !== undefined && known.origin === "provider_initiated") {
        // Codex had started a goal turn of its own and added the host's message to it.
        if (thread.pendingStart === pending) thread.pendingStart = undefined;
        return { status: "accepted", turnId: known.id, accepted: "steered" };
      }
      const turn = known ?? this.#beginTurn(thread, response.turn, true);
      return { status: "accepted", turnId: turn.id, accepted: "started" };
    } catch (error) {
      if (thread.pendingStart === pending) thread.pendingStart = undefined;
      throw callErrorFromCodex(error, "thread");
    }
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    this.#open();
    const turn = this.#turnsById.get(input.turnId);
    if (turn === undefined || turn.settled) return;
    const thread = this.#thread(turn.threadId);
    const connection = await this.#agent();
    try {
      // Codex answers once the turn completed or aborted.
      await connection.client.turnInterrupt({ threadId: thread.nativeId, turnId: turn.nativeId });
    } catch (error) {
      // The turn already ended (another one may be running): nothing to stop.
      if (error instanceof JsonRpcError && /no active turn|expected active turn id/i.test(error.message)) return;
      // Stop must end the turn even when Codex cannot be asked: restart the runtime.
      await this.#restart();
      this.#settle(turn, "interrupted");
      return;
    }
    if (input.restartRuntime === true) {
      await turn.done;
      await this.#restart();
    }
  }

  // Requests.

  respond(input: RespondInput): Promise<RespondResult | void> {
    this.#open();
    const key = `${input.requestId}\u0000${input.responseKey}`;
    const prior = this.#responses.get(key);
    if (prior !== undefined) return prior;
    const pending = this.#requests.get(input.requestId);
    let outcome: Promise<RespondResult | void>;
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

  async #answer(pending: PendingRequest, input: RespondInput): Promise<RespondResult | void> {
    const request = pending.request;
    if (request.response.mode === "message") {
      // Codex reads the answer from the next user message; the host sends it as a normal turn.
      const text = this.#answerText(request, input);
      this.#resolve(pending, "resolved");
      return { followUpPrompt: [{ type: "text", text }] };
    }
    if (input.optionId !== undefined && !(request.options ?? []).some((option) => option.optionId === input.optionId)) {
      throw callErrors.validation([{ message: `no option ${input.optionId}`, path: ["optionId"] }]);
    }
    if (input.optionId === undefined && input.answers === undefined) throw callErrors.validation([{ message: "respond needs optionId or answers", path: [] }]);
    pending.reply!(input);
    this.#resolve(pending, "resolved");
  }

  #answerText(request: Request, input: RespondInput): string {
    const lines: string[] = [];
    for (const question of request.questions ?? []) {
      const answer = input.answers?.[question.id];
      const chosen = [...(answer?.optionIds ?? []), ...(answer?.text === undefined ? [] : [answer.text])];
      lines.push(`${question.prompt}\n${chosen.length === 0 ? "(no answer)" : chosen.join(", ")}`);
    }
    if (input.custom !== undefined) lines.push(input.custom);
    return lines.join("\n\n");
  }

  #resolve(pending: PendingRequest, status: "resolved" | "cancelled" | "expired"): void {
    if (pending.resolved) return;
    pending.resolved = true;
    this.#emit({ type: "request.upsert", request: { id: pending.request.id, status } }, { threadId: pending.threadId, ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }) });
  }

  // Background terminals and subagents.

  async #refreshTerminals(threadId: string): Promise<Array<{ task: TaskInfo; processId: string }>> {
    const thread = this.#thread(threadId);
    const connection = await this.#agent();
    await this.#ensureLoaded(connection, thread);
    const listed: Array<{ task: TaskInfo; processId: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await connection.client.threadBackgroundTerminalsList({ threadId: thread.nativeId, ...(cursor === undefined ? {} : { cursor }) }).catch((error: unknown) => {
        throw callErrorFromCodex(error, "thread");
      });
      for (const terminal of page.data) {
        const id = taskIdFor(threadId, terminal.processId);
        listed.push({ processId: terminal.processId, task: { id, kind: "terminal", status: "running", title: terminal.command, threadId, command: [terminal.command], cwd: terminal.cwd } });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    for (const [, task] of this.#tasks) if (task.threadId === threadId) task.running = false;
    for (const entry of listed) this.#tasks.set(entry.task.id, { processId: entry.processId, threadId, title: entry.task.title ?? "", running: true });
    return listed;
  }

  #emitBackground(): void {
    const tasks = [...this.#tasks.entries()]
      .filter(([, task]) => task.running)
      .map(([id, task]) => ({ id, kind: "terminal" as const, status: "running" as const, title: task.title, threadId: task.threadId }));
    this.#emit({ type: "background.updated", tasks });
  }

  /** Background terminals, MCP apps and the subagent stop exist on every Codex session, so they are plain members. */
  backgroundTasks: NonNullable<Session["backgroundTasks"]> = {
    list: async (threadId) => {
      this.#open();
      return (await this.#refreshTerminals(threadId)).map((entry) => entry.task);
    },
    stop: async (input) => {
      this.#open();
      const thread = this.#thread(input.threadId);
      let task = this.#tasks.get(input.taskId);
      if (task === undefined) {
        await this.#refreshTerminals(input.threadId);
        task = this.#tasks.get(input.taskId);
      }
      if (task === undefined) throw callErrors.notFound({ resource: "background task", id: input.taskId });
      const connection = await this.#agent();
      const result = await connection.client.threadBackgroundTerminalsTerminate({ threadId: thread.nativeId, processId: task.processId }).catch((error: unknown) => {
        throw callErrorFromCodex(error, "background task");
      });
      if (!result.terminated) throw callErrors.notFound({ resource: "background task", id: input.taskId, message: "Codex has no running terminal with that id" });
      task.running = false;
      this.#emitBackground();
    },
    await: async (input) => {
      this.#open();
      const running = new Set((await this.#refreshTerminals(input.threadId)).map((entry) => entry.task.id));
      return { matched: input.taskIds.filter((taskId) => running.has(taskId)) };
    },
  };

  async stopSubagent(input: { subagentId: string; requestedAt?: string }): Promise<SubagentOutcome | void> {
    this.#open();
    const subagent = this.#subagents.get(input.subagentId);
    if (subagent === undefined) throw callErrors.notFound({ resource: "subagent", id: input.subagentId });
    if (subagent.activeChildTurn === undefined) return { status: subagent.status };
    const connection = await this.#agent();
    await connection.client.turnInterrupt({ threadId: subagent.childNativeId, turnId: subagent.activeChildTurn }).catch((error: unknown) => {
      if (error instanceof JsonRpcError && /no active turn/i.test(error.message)) return;
      throw callErrorFromCodex(error, "subagent");
    });
    return { status: "interrupted" };
  }

  mcpApps: NonNullable<Session["mcpApps"]> = {
    listTools: async (threadId, server) => {
      this.#open();
      const thread = this.#thread(threadId);
      const connection = await this.#agent();
      await this.#ensureLoaded(connection, thread);
      const listed = await connection.client.mcpServerStatusList({ threadId: thread.nativeId, serverName: server }).catch((error: unknown) => {
        throw callErrorFromCodex(error, "MCP server");
      });
      const status = listed.data.find((entry) => entry.name === server);
      if (status === undefined) throw callErrors.notFound({ resource: "MCP server", id: server });
      return Object.values(status.tools).map((tool): McpTool => ({
        name: tool.name,
        ...(tool.title === null || tool.title === undefined ? {} : { title: tool.title }),
        ...(tool.description === null || tool.description === undefined ? {} : { description: tool.description }),
        ...(isObject(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
        ...(isObject(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
        ...(isObject(tool.annotations) ? { annotations: tool.annotations } : {}),
      }));
    },
    callTool: async (threadId, server, tool, args) => {
      this.#open();
      const thread = this.#thread(threadId);
      const connection = await this.#agent();
      await this.#ensureLoaded(connection, thread);
      const result = await connection.client.mcpServerToolCall({ threadId: thread.nativeId, server, tool, arguments: args }).catch((error: unknown) => {
        throw callErrorFromCodex(error, "MCP tool");
      });
      const mapped: McpCallResult = { content: result.content };
      if (result.structuredContent !== undefined && result.structuredContent !== null) mapped.structuredContent = result.structuredContent;
      if (result.isError !== undefined && result.isError !== null) mapped.isError = result.isError;
      return mapped;
    },
    readResource: async (threadId, server, uri) => {
      this.#open();
      const thread = this.#thread(threadId);
      const connection = await this.#agent();
      await this.#ensureLoaded(connection, thread);
      const result = await connection.client.mcpServerResourceRead({ threadId: thread.nativeId, server, uri }).catch((error: unknown) => {
        throw callErrorFromCodex(error, "MCP resource");
      });
      const contents: McpResourceContents = { contents: result.contents };
      return contents;
    },
  };

  // Config.

  async planConfigChange(input: PlanConfigChangeInput): Promise<ConfigChangePlan> {
    this.#thread(input.threadId);
    const unknown = Object.keys(input.changes).filter((key) => key !== "model" && key !== "reasoningEffort");
    if (unknown.length > 0) return { type: "reject", reason: `Codex has no session option ${unknown.join(", ")}` };
    // Codex takes the model and effort on every turn/start.
    return { type: "apply_next_turn" };
  }

  contextWindow(model: string): number | undefined {
    return this.#contextWindows.get(model);
  }

  canReuseContextUsage(previousModel: string, nextModel: string): boolean {
    return previousModel === nextModel;
  }

  async uploadFeedback(input: { threadId: string; reason?: string }): Promise<{ feedbackId: string }> {
    this.#open();
    const thread = this.#thread(input.threadId);
    const connection = await this.#agent();
    const uploaded = await connection.client
      .feedbackUpload({ classification: "other", threadId: thread.nativeId, includeLogs: false, ...(input.reason === undefined ? {} : { reason: input.reason }) })
      .catch((error: unknown) => {
        throw callErrorFromCodex(error, "thread");
      });
    // Codex files an upload under the conversation id it reports back.
    return { feedbackId: uploaded.threadId };
  }

  // Extensions.

  async ext(ns: string, method: string, params: unknown): Promise<unknown> {
    this.#open();
    if (!(CODEX_EXTENSIONS as readonly string[]).includes(ns)) throw callErrors.unsupported(`extensions.${ns}`);
    const args = isObject(params) ? params : {};
    const threadId = typeof args["threadId"] === "string" ? args["threadId"] : undefined;
    if (threadId === undefined) throw callErrors.validation([{ message: `${ns}.${method} needs a threadId`, path: ["threadId"] }]);
    const thread = this.#thread(threadId);
    const connection = await this.#agent();
    await this.#ensureLoaded(connection, thread);
    const failed = (what: string) => (error: unknown) => {
      throw callErrorFromCodex(error, what);
    };
    if (ns === "ari.goal" || ns === "codex.goal") {
      let goal: ThreadGoal | null | undefined;
      // A goal notification that arrived meanwhile is newer than the call's answer.
      const seq = thread.goalSeq;
      if (method === "get") goal = (await connection.client.threadGoalGet({ threadId: thread.nativeId }).catch(failed("goal"))).goal;
      else if (method === "set") {
        const objective = typeof args["objective"] === "string" ? args["objective"] : undefined;
        if (ns === "ari.goal" && objective === undefined) throw callErrors.validation([{ message: "ari.goal set needs an objective", path: ["objective"] }]);
        const status = ns === "ari.goal" ? "active" : typeof args["status"] === "string" ? (args["status"] as ThreadGoal["status"]) : undefined;
        // An active goal opens a run. Codex counts a running turn toward the goal (ext/goal/src/runtime.rs:223–239), so that turn leads the run.
        if (status === "active") {
          const current = thread.active;
          thread.goalRun = current === undefined ? { hostTag: undefined, rootTurnId: undefined, turnIds: [] } : { hostTag: current.hostTag, rootTurnId: current.id, turnIds: [current.id] };
        }
        goal = (
          await connection.client
            .threadGoalSet({
              threadId: thread.nativeId,
              ...(objective === undefined ? {} : { objective }),
              ...(status === undefined ? {} : { status }),
              ...(ns === "codex.goal" && "tokenBudget" in args ? { tokenBudget: args["tokenBudget"] as number | null } : {}),
            })
            .catch(failed("goal"))
        ).goal;
        if (thread.goalSeq === seq) thread.goal = goal ?? undefined;
        // The goal as set: the turns Codex starts for it are reported by x:ari.goal.updated.
        if (goal !== null && goal !== undefined && ns === "ari.goal") return { ...this.#ariGoal(thread, goal), turnIds: [] };
      } else if (method === "clear") {
        const cleared = await connection.client.threadGoalClear({ threadId: thread.nativeId }).catch(failed("goal"));
        if (thread.goalSeq === seq) {
          thread.goal = undefined;
          thread.goalRun = undefined;
        }
        return ns === "codex.goal" ? { cleared: cleared.cleared } : null;
      } else throw callErrors.notFound({ resource: "extension method", id: `${ns}.${method}` });
      if (goal === null || goal === undefined) return null;
      return ns === "ari.goal" ? this.#ariGoal(thread, goal) : this.#codexGoal(thread, goal);
    }
    if (ns === "codex.review") {
      if (method !== "start") throw callErrors.notFound({ resource: "extension method", id: `${ns}.${method}` });
      if (!isObject(args["target"])) throw callErrors.validation([{ message: "codex.review start needs a target", path: ["target"] }]);
      if (thread.active !== undefined) throw callErrors.invalidState("previous_turn_active", "A turn is still running on this thread");
      this.#expectHostTurn(thread, { answerNamesTurn: true });
      try {
        const started = await connection.client.reviewStart({ threadId: thread.nativeId, target: args["target"] as never, delivery: "inline" });
        const turn = this.#turnsByNative.get(started.turn.id) ?? this.#beginTurn(thread, started.turn, true);
        return { threadId: thread.thread.id, turnId: turn.id };
      } catch (error) {
        thread.pendingStart = undefined;
        throw callErrorFromCodex(error, "thread");
      }
    }
    if (ns === "codex.readState") {
      if (method === "read") {
        const read = await connection.client.threadRead({ threadId: thread.nativeId, includeTurns: false }).catch(failed("thread"));
        return this.#readState(thread, read.readState);
      }
      if (method === "update") {
        const operation = args["operation"];
        if ((operation !== "read" && operation !== "unread") || typeof args["expectedRevision"] !== "string") {
          throw callErrors.validation([{ message: "codex.readState update needs expectedRevision and an operation of read or unread", path: ["operation"] }]);
        }
        const updated = await connection.client
          .threadReadStateUpdate({ threadId: thread.nativeId, expectedRevision: args["expectedRevision"], operation: { type: operation } })
          .catch(failed("thread"));
        return this.#readState(thread, updated.readState);
      }
      throw callErrors.notFound({ resource: "extension method", id: `${ns}.${method}` });
    }
    // codex.memory
    if (method !== "read") throw callErrors.notFound({ resource: "extension method", id: `${ns}.${method}` });
    const memory = await connection.client.threadMemoryRead({ threadId: thread.nativeId }).catch(failed("thread"));
    return { threadId: thread.thread.id, summary: memory.summary ?? null };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection !== undefined) await (await connection.catch(() => undefined))?.close();
    for (const thread of this.#threads.values()) if (thread.active !== undefined) this.#settle(thread.active, "interrupted");
    for (const pending of this.#requests.values()) {
      if (pending.resolved || pending.reply === undefined) continue;
      pending.abandon();
      this.#resolve(pending, "expired");
    }
    this.#emit({ type: "session.state", state: "stopped" });
    this.#sequencer.close();
  }

  // Internals: connection.

  #open(): void {
    if (this.#closed) throw callErrors.invalidState("session_closed");
  }

  #agent(): Promise<CodexConnection> {
    this.#connection ??= this.#spawn().catch((error: unknown) => {
      this.#connection = undefined;
      throw error;
    });
    return this.#connection;
  }

  async #spawn(): Promise<CodexConnection> {
    let connection: CodexConnection | undefined;
    const spawn = await this.#runtime.spawnRequest();
    connection = await CodexConnection.start(this.#runtime.host, {
      spawn,
      // The driver never uses the aggregated turn diff: file changes carry their own diffs.
      optOutNotificationMethods: ["turn/diff/updated"],
      handshakeTimeoutMs: this.#input.handshakeTimeoutMs ?? 120_000,
      handlers: {
        onNotification: (method, params) => this.#onNotification(method, params),
        onRequest: (method, params, context) => this.#onRequest(method, params, context),
        onExit: (_exit, byDriver) => this.#onExit(connection, byDriver),
      },
    });
    this.#current = connection;
    await this.#runtime.signIn(connection);
    return connection;
  }

  async #restart(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    for (const thread of this.#threads.values()) thread.loaded = false;
    if (connection !== undefined) await (await connection.catch(() => undefined))?.close();
  }

  /** Loads a thread into the current process when a release, a restart or a crash dropped it. */
  async #ensureLoaded(connection: CodexConnection, thread: ThreadState): Promise<void> {
    if (thread.loaded || thread.unloaded) return;
    await this.#resumeNative(connection, thread.nativeId, thread.thread.id, thread.policy, thread.launch, undefined).catch((error: unknown) => {
      throw callErrorFromCodex(error, "native session");
    });
    thread.loaded = true;
  }

  async #resumeNative(
    connection: CodexConnection,
    nativeId: string,
    threadId: string,
    policyInput: RuntimePolicy | undefined,
    launch: LaunchContext | undefined,
    config: { [key: string]: unknown } | undefined,
    instructionsOverride?: string,
  ): Promise<{ nativeId: string; cwd: string; model: string; instructions: string | undefined }> {
    const policy = policyInput === undefined ? undefined : codexPolicy(policyInput);
    const instructions = instructionsOverride ?? joinInstructions([...(launch?.appendSystemPrompt ?? []), ...(launch?.developerPrompt ?? [])]);
    // The thread id is known here, so the host's tool server for it can be passed under the name the host chose.
    const hostServer = await this.#runtime.host.hostTools.mcpServerFor(threadId, { transport: "http" });
    const mcp = mcpServerConfig([...(launch?.mcpServers ?? []), hostServer.config.name === hostServer.name ? hostServer.config : { ...hostServer.config, name: hostServer.name }]);
    const model = typeof config?.["model"] === "string" ? config["model"] : undefined;
    const resumed = await connection.client.threadResume({
      threadId: nativeId,
      excludeTurns: true,
      ...(policy === undefined ? {} : { approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer, sandbox: policy.sandbox }),
      ...(policyInput?.cwd === undefined || policyInput.cwd === "" ? {} : { cwd: policyInput.cwd }),
      ...(model === undefined ? {} : { model }),
      ...(instructions === undefined ? {} : { developerInstructions: instructions }),
      config: mcp,
    });
    return { nativeId: resumed.thread.id, cwd: resumed.cwd, model: resumed.model, instructions };
  }

  async #nativeTurns(connection: CodexConnection, nativeThreadId: string): Promise<CodexTurn[]> {
    const turns: CodexTurn[] = [];
    let cursor: string | undefined;
    do {
      const page = await connection.client
        .threadTurnsList({ threadId: nativeThreadId, itemsView: "full", sortDirection: "asc", ...(cursor === undefined ? {} : { cursor }) })
        .catch((error: unknown) => {
          throw callErrorFromCodex(error, "thread");
        });
      turns.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return turns;
  }

  /** Replays a resumed thread's stored turns (unless `quiet`) and re-raises its async questions that no later user message answered. */
  async #replayHistory(connection: CodexConnection, thread: ThreadState, quiet: boolean): Promise<void> {
    const turns = await this.#nativeTurns(connection, thread.nativeId);
    thread.turnOrder.splice(0, thread.turnOrder.length, ...turns.map((turn) => turn.id));
    const openQuestions: Array<{ turn: CodexTurn; item: Extract<ThreadItem, { type: "agentMessage" }> }> = [];
    for (const turn of turns) {
      const turnId = turnIdFor(thread.thread.id, turn.id);
      if (!quiet && !this.#turnsByNative.has(turn.id)) {
        const envelope = { threadId: thread.thread.id, turnId };
        const status = turnStatusFromCodex(turn.status);
        const startedAt = isoFromSeconds(turn.startedAt);
        const completedAt = isoFromSeconds(turn.completedAt);
        this.#emit(
          {
            type: "turn.upsert",
            turn: {
              id: turnId,
              threadId: thread.thread.id,
              native: strongRef(turn.id),
              origin: "user",
              status,
              ...(startedAt === undefined ? {} : { startedAt }),
              ...(completedAt === undefined ? {} : { completedAt }),
            },
          },
          envelope,
        );
        for (const item of turn.items) {
          if (item.type === "subAgentActivity") continue;
          this.#emit({ type: "item.upsert", item: itemFromCodex(item, this.#itemContext(turnId)) }, envelope);
        }
      }
      for (const item of turn.items) {
        if (item.type === "userMessage") openQuestions.length = 0;
        if (item.type === "agentMessage" && item.delivery === "async" && (item.questions?.length ?? 0) > 0) openQuestions.push({ turn, item });
      }
    }
    for (const { turn, item } of openQuestions) this.#asyncQuestion(thread, turnIdFor(thread.thread.id, turn.id), item);
  }

  // Internals: threads and turns.

  #thread(threadId: string): ThreadState {
    const thread = this.#threads.get(threadId);
    if (thread === undefined) throw callErrors.notFound({ resource: "thread", id: threadId });
    return thread;
  }

  #nativeTurnId(thread: ThreadState, turnId: string): string {
    const turn = this.#turnsById.get(turnId);
    if (turn !== undefined && turn.threadId === thread.thread.id) return turn.nativeId;
    const native = thread.turnOrder.find((candidate) => turnIdFor(thread.thread.id, candidate) === turnId);
    if (native !== undefined) return native;
    throw callErrors.notFound({ resource: "turn", id: turnId });
  }

  #register(
    nativeId: string,
    cwd: string,
    policy: RuntimePolicy,
    model: string | undefined,
    launch: LaunchContext | undefined,
    instructions: string | undefined,
    title?: string,
    forkedFrom?: Thread["forkedFrom"],
  ): Thread {
    const id = threadIdFor(nativeId);
    const existing = this.#threads.get(id);
    const thread: Thread = {
      id,
      native: strongRef(nativeId),
      cwd,
      status: "idle",
      handle: nativeId,
      identityVersion: 1,
      ...(title === undefined ? {} : { title }),
      ...(forkedFrom === undefined ? {} : { forkedFrom }),
    };
    if (existing !== undefined) {
      existing.thread = thread;
      existing.loaded = true;
      existing.unloaded = false;
      existing.policy = policy;
      if (model !== undefined) existing.model = model;
    } else {
      this.#threads.set(id, {
        thread,
        nativeId,
        policy,
        model,
        launch,
        instructions,
        active: undefined,
        pendingStart: undefined,
        loaded: true,
        unloaded: false,
        goal: undefined,
        goalSeq: 0,
        goalRun: undefined,
        turnOrder: [],
      });
    }
    this.#threadsByNative.set(nativeId, id);
    this.#emit({ type: "thread.upsert", thread }, { threadId: id });
    return thread;
  }

  /** Marks the next turn Codex starts on `thread` as one the host asked for, and returns a promise that settles when that turn ends. */
  #expectHostTurn(thread: ThreadState, host: { clientTurnKey?: string; hostTag?: string; answerNamesTurn: boolean }): Promise<void> {
    let settled: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    thread.pendingStart = { ...host, settled };
    return done;
  }

  #itemContext(turnId: string): { turnId: string; emitDiffs: boolean; maxToolOutputBytes?: number; maxDiffBytes?: number } {
    const limits = this.#input.payloadLimits;
    return {
      turnId,
      emitDiffs: this.#emitDiffs,
      ...(limits?.maxToolOutputBytes === undefined ? {} : { maxToolOutputBytes: limits.maxToolOutputBytes }),
      ...(limits?.maxDiffBytes === undefined ? {} : { maxDiffBytes: limits.maxDiffBytes }),
    };
  }

  /**
   * Starts an ARI turn for a native turn of `thread`: the host's, or one Codex
   * started on its own. `named` is true when the host request's answer named
   * this turn. A `turn/started` that arrives while the host's request awaits
   * its answer is the host's turn only when no goal is active: Codex starts
   * turns on its own only for a goal.
   */
  #beginTurn(thread: ThreadState, native: CodexTurn, named = false): TurnState {
    const id = turnIdFor(thread.thread.id, native.id);
    const pending = thread.pendingStart;
    const autonomous = pending === undefined || (!named && pending.answerNamesTurn && thread.goal?.status === "active");
    const host = autonomous ? undefined : pending;
    if (host !== undefined) thread.pendingStart = undefined;
    const origin: "user" | "provider_initiated" = autonomous ? "provider_initiated" : "user";
    let hostTag = host?.hostTag;
    let parentTurnId: string | undefined;
    const run = thread.goalRun;
    if (autonomous) {
      if (run !== undefined) {
        hostTag = run.hostTag;
        parentTurnId = run.rootTurnId;
        run.rootTurnId ??= id;
        run.turnIds.push(id);
      }
    } else if (thread.goal?.status === "active") {
      // A host turn on a thread whose goal is active joins the open goal run, or opens one.
      if (run === undefined) thread.goalRun = { hostTag, rootTurnId: id, turnIds: [id] };
      else {
        run.rootTurnId ??= id;
        run.hostTag ??= hostTag;
        run.turnIds.push(id);
      }
    }
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const settled = host?.settled;
    const turn: TurnState = {
      id,
      nativeId: native.id,
      threadId: thread.thread.id,
      origin,
      hostTag,
      openItems: new Map(),
      fileChanges: new Map(),
      todoOpen: false,
      settled: false,
      lastError: undefined,
      retries: 0,
      done,
      finish: () => {
        finish();
        settled?.();
      },
    };
    this.#turnsByNative.set(native.id, turn);
    this.#turnsById.set(id, turn);
    if (!thread.turnOrder.includes(native.id)) thread.turnOrder.push(native.id);
    thread.active = turn;
    const startedAt = isoFromSeconds(native.startedAt);
    this.#emit(
      {
        type: "turn.upsert",
        turn: {
          id,
          threadId: thread.thread.id,
          native: strongRef(native.id),
          origin,
          status: "running",
          ...(host?.clientTurnKey === undefined ? {} : { clientTurnKey: host.clientTurnKey }),
          ...(hostTag === undefined ? {} : { hostTag }),
          ...(parentTurnId === undefined ? {} : { parentTurnId }),
          ...(startedAt === undefined ? {} : { startedAt }),
          ...(thread.model === undefined ? {} : { model: thread.model }),
        },
      },
      this.#envelope(turn),
    );
    if (thread.goalRun !== undefined && thread.goal !== undefined && thread.goalRun.turnIds.includes(id)) this.#emitGoal(thread);
    return turn;
  }

  #envelope(turn: TurnState): { threadId: string; turnId: string; hostTag?: string } {
    return { threadId: turn.threadId, turnId: turn.id, ...(turn.hostTag === undefined ? {} : { hostTag: turn.hostTag }) };
  }

  /** Ends a turn: settles what it left open, cancels its live requests, then emits its status and its one `turn.terminal`. */
  #settle(turn: TurnState, status: "completed" | "interrupted" | "failed", failure?: import("../../generated/errors.ts").Failure): void {
    const thread = this.#threads.get(turn.threadId);
    if (thread?.active === turn) thread.active = undefined;
    if (turn.settled) return;
    turn.settled = true;
    const envelope = this.#envelope(turn);
    const itemStatus = status === "completed" ? "completed" : status;
    for (const item of turn.openItems.values()) this.#emit({ type: "item.upsert", item: { id: item.id, status: itemStatus } }, envelope);
    turn.openItems.clear();
    for (const pending of this.#requests.values()) {
      if (pending.turnId !== turn.id || pending.resolved || pending.reply === undefined) continue;
      pending.abandon();
      this.#resolve(pending, "cancelled");
    }
    this.#emit({ type: "turn.upsert", turn: { id: turn.id, status, completedAt: new Date().toISOString(), ...(failure === undefined ? {} : { failure }) } }, envelope);
    this.#emit({ type: "turn.terminal", turnId: turn.id, status, ...(failure === undefined ? {} : { failure }), threadDisposition: "reusable" }, envelope);
    turn.finish();
  }

  // Internals: notifications.

  #onNotification(method: string, params: unknown): void {
    if (!isObject(params)) return;
    const threadKey = typeof params["threadId"] === "string" ? params["threadId"] : undefined;
    const threadId = threadKey === undefined ? undefined : this.#threadsByNative.get(threadKey);
    const thread = threadId === undefined ? undefined : this.#threads.get(threadId);
    switch (method) {
      case "thread/started": {
        const native = params["thread"] as { id: string; parentThreadId?: string | null; agentNickname?: string | null };
        const subagent = this.#subagentsByChild.get(native.id);
        if (subagent !== undefined && native.agentNickname !== null && native.agentNickname !== undefined) subagent.name = native.agentNickname;
        return;
      }
      case "turn/started": {
        const native = params["turn"] as CodexTurn;
        if (thread === undefined) {
          const subagent = threadKey === undefined ? undefined : this.#subagentsByChild.get(threadKey);
          if (subagent !== undefined) subagent.activeChildTurn = native.id;
          return;
        }
        if (this.#turnsByNative.has(native.id)) return;
        this.#beginTurn(thread, native);
        return;
      }
      case "turn/completed": {
        const native = params["turn"] as CodexTurn;
        if (thread === undefined) {
          const subagent = threadKey === undefined ? undefined : this.#subagentsByChild.get(threadKey);
          if (subagent !== undefined) {
            subagent.activeChildTurn = undefined;
            this.#subagentStatus(subagent, native.status === "inProgress" ? "running" : native.status);
          }
          return;
        }
        const turn = this.#turnsByNative.get(native.id) ?? this.#beginTurn(thread, native);
        for (const item of native.items) this.#itemCompleted(turn, item);
        const status = turnStatusFromCodex(native.status);
        if (status === "failed") this.#settle(turn, "failed", failureFromCodex(native.error ?? turn.lastError, this.#resetAt()));
        else if (status === "interrupted") this.#settle(turn, "interrupted");
        else this.#settle(turn, "completed");
        void this.#afterTurn(turn.threadId);
        return;
      }
      case "item/started":
      case "item/completed": {
        const turn = this.#turnsByNative.get(params["turnId"] as string);
        const item = params["item"] as ThreadItem;
        if (item.type === "subAgentActivity" || item.type === "collabAgentToolCall") this.#subagentItem(thread, turn, item);
        if (turn === undefined || turn.settled || item.type === "subAgentActivity") return;
        if (method === "item/started") this.#itemStarted(turn, item);
        else this.#itemCompleted(turn, item);
        return;
      }
      case "item/agentMessage/delta":
        this.#delta(params, "text");
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        this.#delta(params, "reasoning");
        return;
      case "item/plan/delta":
        this.#delta(params, "plan");
        return;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        this.#delta(params, "output");
        return;
      case "turn/plan/updated": {
        const turn = this.#turnsByNative.get(params["turnId"] as string);
        if (thread === undefined || turn === undefined || turn.settled) return;
        const steps = params["plan"] as Array<{ step: string; status: string }>;
        const explanation = typeof params["explanation"] === "string" ? params["explanation"] : undefined;
        const status = (native: string): "pending" | "in_progress" | "completed" => (native === "inProgress" ? "in_progress" : native === "completed" ? "completed" : "pending");
        const plan: Plan = {
          id: planIdFor(thread.thread.id, turn.nativeId),
          threadId: thread.thread.id,
          turnId: turn.id,
          entries: steps.map((step) => ({ text: step.step, status: status(step.status) })),
          ...(explanation === undefined ? {} : { explanation }),
          updatedAt: new Date().toISOString(),
        };
        this.#emit({ type: "plan.upsert", plan }, this.#envelope(turn));
        const todoId = todoItemIdFor(turn.id, turn.nativeId);
        const todos = steps.map((step) => ({ text: step.step, status: status(step.status) }));
        if (!turn.todoOpen) {
          turn.todoOpen = true;
          const todo: Item = { id: todoId, kind: "todo_list", native: strongRef(`${turn.nativeId}:todo`), status: "running", turnId: turn.id, todos };
          turn.openItems.set(`${turn.nativeId}:todo`, todo);
          this.#emit({ type: "item.upsert", item: todo }, this.#envelope(turn));
        } else this.#emit({ type: "item.upsert", item: { id: todoId, todos } }, this.#envelope(turn));
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = params["tokenUsage"] as import("./generated/protocol.ts").ThreadTokenUsage;
        const model = thread?.model;
        if (model !== undefined && usage.modelContextWindow !== null && usage.modelContextWindow !== undefined) this.#contextWindows.set(model, usage.modelContextWindow);
        const turn = this.#turnsByNative.get(params["turnId"] as string);
        this.#emit({ type: "usage.updated", usage: usageFromCodex(usage, model) }, turn === undefined ? (threadId === undefined ? {} : { threadId }) : this.#envelope(turn));
        return;
      }
      case "account/rateLimits/updated": {
        const limits = limitsFromCodex(params["rateLimits"] as import("./generated/protocol.ts").RateLimitSnapshot);
        this.#latestLimits = limits;
        this.#runtime.onLimits(limits);
        this.#emit({ type: "limits.updated", limits });
        return;
      }
      case "error": {
        const turn = this.#turnsByNative.get(params["turnId"] as string);
        const error = params["error"] as TurnError;
        if (turn === undefined) {
          this.#emit({ type: "notice", level: "error", text: error.message });
          return;
        }
        turn.lastError = error;
        if (params["willRetry"] === true) {
          turn.retries += 1;
          this.#emit({ type: "retry", attempt: turn.retries, maxAttempts: null, retryDelayMs: null }, this.#envelope(turn));
        }
        return;
      }
      case "warning":
      case "configWarning":
      case "deprecationNotice": {
        const text = typeof params["message"] === "string" ? params["message"] : typeof params["summary"] === "string" ? params["summary"] : JSON.stringify(params);
        this.#emit({ type: "notice", level: "warning", code: `codex.${method}`, text }, threadId === undefined ? {} : { threadId });
        return;
      }
      case "model/rerouted": {
        const turn = this.#turnsByNative.get(params["turnId"] as string);
        if (thread !== undefined && typeof params["toModel"] === "string") thread.model = params["toModel"];
        this.#emit({ type: "notice", level: "info", code: "codex.model_rerouted", text: `Codex moved this turn from ${String(params["fromModel"])} to ${String(params["toModel"])}.` }, turn === undefined ? {} : this.#envelope(turn));
        return;
      }
      case "thread/status/changed": {
        if (thread === undefined) return;
        const status = (params["status"] as { type: string }).type;
        if (status === "notLoaded") thread.loaded = false;
        return;
      }
      case "thread/closed":
        if (thread !== undefined) thread.loaded = false;
        return;
      case "thread/goal/updated": {
        if (thread === undefined) return;
        thread.goalSeq += 1;
        thread.goal = params["goal"] as ThreadGoal;
        this.#emitGoal(thread);
        // A goal that is no longer active ends its run; Codex starts no more turns for it.
        if (thread.goal.status !== "active") thread.goalRun = undefined;
        return;
      }
      case "thread/goal/cleared": {
        if (thread === undefined) return;
        thread.goalSeq += 1;
        thread.goal = undefined;
        this.#emitGoal(thread);
        thread.goalRun = undefined;
        return;
      }
      case "thread/readState/changed": {
        if (thread === undefined) return;
        const data = this.#readState(thread, (params["readState"] as ThreadReadState | null | undefined) ?? null);
        this.#emit({ type: "x:codex.readState.changed", data, fallback: { title: "Read state changed", text: data.readState?.firstUnread === null || data.readState?.firstUnread === undefined ? "Read" : "Unread" } }, { threadId: thread.thread.id });
        return;
      }
      case "serverRequest/resolved": {
        const resolved = params as unknown as ServerRequestResolvedNotification;
        for (const pending of this.#requests.values()) {
          if (pending.resolved || pending.reply === undefined || pending.threadId !== threadId) continue;
          if (pending.rpcId === resolved.requestId) this.#resolve(pending, "resolved");
        }
        return;
      }
      default:
        return;
    }
  }

  #delta(params: { [key: string]: unknown }, field: "text" | "reasoning" | "plan" | "output"): void {
    const turn = this.#turnsByNative.get(params["turnId"] as string);
    if (turn === undefined || turn.settled) return;
    const item = turn.openItems.get(params["itemId"] as string);
    if (item === undefined || typeof params["delta"] !== "string") return;
    this.#emit({ type: "item.delta", itemId: item.id, field, chunk: params["delta"], ...(field === "output" ? { stream: "stdout" as const } : {}) }, this.#envelope(turn));
  }

  #itemStarted(turn: TurnState, native: ThreadItem): void {
    if (native.type === "fileChange") turn.fileChanges.set(native.id, native.changes);
    if (turn.openItems.has(native.id)) return;
    const item = itemFromCodex(native, this.#itemContext(turn.id), "running");
    turn.openItems.set(native.id, item);
    this.#emit({ type: "item.upsert", item }, this.#envelope(turn));
  }

  #itemCompleted(turn: TurnState, native: ThreadItem): void {
    if (native.type === "subAgentActivity") return;
    if (native.type === "fileChange") turn.fileChanges.set(native.id, native.changes);
    const item = itemFromCodex(native, this.#itemContext(turn.id));
    const wasOpen = turn.openItems.delete(native.id);
    // turn/completed repeats a summary of items already settled; settle each item once.
    if (!wasOpen && this.#settledItems.has(item.id)) return;
    const status = SETTLED_ITEM_STATUSES.has(String(item.status)) ? item.status : "completed";
    this.#settledItems.add(item.id);
    this.#emit({ type: "item.upsert", item: { ...item, status } }, this.#envelope(turn));
    const thread = this.#threads.get(turn.threadId);
    if (thread !== undefined && native.type === "agentMessage" && native.delivery === "async" && (native.questions?.length ?? 0) > 0) this.#asyncQuestion(thread, turn.id, native);
  }

  readonly #settledItems = new Set<string>();

  /** An async question: a message-mode request the host answers with a normal user message. It outlives its turn and the process. */
  #asyncQuestion(thread: ThreadState, turnId: string, item: Extract<ThreadItem, { type: "agentMessage" }>): void {
    const nativeKey = `async:${item.id}`;
    const id = requestIdFor(thread.thread.id, nativeKey);
    const existing = this.#requests.get(id);
    if (existing !== undefined && !existing.resolved) return;
    const questions: Question[] = (item.questions ?? []).map((question, index) => ({
      id: String(index),
      type: (question.options?.length ?? 0) > 0 ? "single_select" : "text",
      prompt: question.title,
      ...((question.options?.length ?? 0) > 0 ? { options: question.options!.map((label) => ({ id: label, label })) } : {}),
      allowCustom: true,
    }));
    const request: Request = {
      id,
      native: strongRef(nativeKey),
      kind: "user_input",
      origin: { threadId: thread.thread.id, turnId, itemId: itemIdFor(turnId, item.id) },
      questions,
      allowCustomAnswer: true,
      allowFeedback: false,
      response: { mode: "message" },
      survivesRestart: true,
      status: "pending",
    };
    this.#requests.set(id, { request, rpcId: null, threadId: thread.thread.id, turnId, reply: undefined, abandon: () => undefined, inFlight: undefined, resolved: false });
    this.#emit({ type: "request.upsert", request }, { threadId: thread.thread.id, turnId });
  }

  #subagentItem(thread: ThreadState | undefined, turn: TurnState | undefined, item: ThreadItem): void {
    if (thread === undefined) return;
    if (item.type === "subAgentActivity") {
      const subagent = this.#subagentFor(thread, turn, item.agentThreadId, item.agentPath.split("/").filter((part) => part !== "").pop());
      const statuses: { [kind: string]: string } = { started: "running", interacted: "running", interrupted: "interrupted", completed: "completed" };
      this.#subagentStatus(subagent, statuses[item.kind] ?? "running");
      return;
    }
    if (item.type !== "collabAgentToolCall") return;
    for (const child of item.receiverThreadIds) {
      if (item.tool !== "spawnAgent" && !this.#subagentsByChild.has(child)) continue;
      const subagent = this.#subagentFor(thread, turn, child, undefined);
      const state = item.agentsStates[child];
      if (state !== undefined) this.#subagentStatus(subagent, state.status === "pendingInit" ? "pending" : state.status === "running" ? "running" : String(state.status));
    }
  }

  #subagentFor(thread: ThreadState, turn: TurnState | undefined, childNativeId: string, name: string | undefined): SubagentState {
    let subagent = this.#subagentsByChild.get(childNativeId);
    if (subagent === undefined) {
      subagent = { id: subagentIdFor(thread.thread.id, childNativeId), childNativeId, parentThreadId: thread.thread.id, name, status: "pending", activeChildTurn: undefined };
      this.#subagentsByChild.set(childNativeId, subagent);
      this.#subagents.set(subagent.id, subagent);
      this.#emit(
        {
          type: "subagent.upsert",
          subagent: {
            id: subagent.id,
            native: strongRef(childNativeId),
            parentThreadId: thread.thread.id,
            status: "running",
            ...(turn === undefined ? {} : { parentTurnId: turn.id }),
            ...(name === undefined ? {} : { name }),
            startedAt: new Date().toISOString(),
          },
        },
        turn === undefined ? { threadId: thread.thread.id } : this.#envelope(turn),
      );
      subagent.status = "running";
    } else if (name !== undefined && subagent.name === undefined) subagent.name = name;
    return subagent;
  }

  #subagentStatus(subagent: SubagentState, status: string): void {
    if (subagent.status === status) return;
    subagent.status = status;
    const settled = ["completed", "failed", "interrupted", "cancelled", "shutdown", "errored", "notFound"].includes(status);
    this.#emit(
      { type: "subagent.upsert", subagent: { id: subagent.id, status: status === "shutdown" ? "completed" : status === "errored" || status === "notFound" ? "failed" : status, ...(settled ? { completedAt: new Date().toISOString() } : {}) } },
      { threadId: subagent.parentThreadId },
    );
  }

  /** After a turn: report background terminals that outlive it. */
  async #afterTurn(threadId: string): Promise<void> {
    try {
      if (this.#closed || this.#connection === undefined) return;
      const before = new Set([...this.#tasks.entries()].filter(([, task]) => task.running).map(([id]) => id));
      const listed = await this.#refreshTerminals(threadId);
      const after = new Set(listed.map((entry) => entry.task.id));
      if (before.size === after.size && [...before].every((id) => after.has(id))) return;
      this.#emitBackground();
    } catch {
      // A process that went away has no terminals left; its exit handler reports that.
    }
  }

  #resetAt(): string | undefined {
    return this.#latestLimits?.resetsAt;
  }

  // Internals: server requests.

  #onRequest(method: string, params: unknown, context: { readonly signal: AbortSignal; readonly id: string | number | null }): unknown {
    if (!isObject(params)) throw new JsonRpcError(-32602, "params must be an object");
    switch (method) {
      case "item/commandExecution/requestApproval":
        return this.#commandApproval(params as unknown as CommandExecutionRequestApprovalParams, context);
      case "item/fileChange/requestApproval":
        return this.#fileChangeApproval(params as unknown as FileChangeRequestApprovalParams, context);
      case "item/permissions/requestApproval":
        return this.#permissionsApproval(params as unknown as PermissionsRequestApprovalParams, context);
      case "item/tool/requestUserInput":
        return this.#userInputRequest(params as unknown as ToolRequestUserInputParams, context);
      case "mcpServer/elicitation/request":
        return this.#elicitation(params as unknown as McpServerElicitationRequestParams, context);
      case "item/tool/call":
        return this.#dynamicToolCall(params as unknown as DynamicToolCallParams);
      case "account/chatgptAuthTokens/refresh":
        return this.#runtime.refreshTokens().catch((error: unknown) => {
          throw new JsonRpcError(-32603, error instanceof Error ? error.message : String(error));
        });
      default:
        throw new JsonRpcError(-32601, `The ARI Codex driver does not handle ${method}`);
    }
  }

  /** Holds a native server request open as an ARI request until the host answers, the turn ends or the process goes. */
  #pendingRequest<Response>(
    request: Omit<Request, "status">,
    threadId: string,
    turnId: string | undefined,
    context: RequestContext,
    encode: (input: RespondInput) => Response,
    abandoned: Response,
  ): Promise<Response> {
    return new Promise<Response>((resolve) => {
      const pending: PendingRequest = {
        request: { ...request, status: "pending" },
        rpcId: context.id,
        threadId,
        turnId,
        reply: (input) => resolve(encode(input)),
        abandon: () => resolve(abandoned),
        inFlight: undefined,
        resolved: false,
      };
      this.#requests.set(request.id, pending);
      context.signal.addEventListener(
        "abort",
        () => {
          if (pending.resolved) return;
          pending.abandon();
          this.#resolve(pending, "expired");
        },
        { once: true },
      );
      this.#emit({ type: "request.upsert", request: pending.request }, { threadId, ...(turnId === undefined ? {} : { turnId }) });
    });
  }

  /** The thread and turn of a native request, or undefined when it comes from a thread this session does not expose (a subagent's). */
  #origin(nativeThreadId: string, nativeTurnId: string | null | undefined): { thread: ThreadState; turn: TurnState | undefined } | undefined {
    const threadId = this.#threadsByNative.get(nativeThreadId);
    const thread = threadId === undefined ? undefined : this.#threads.get(threadId);
    if (thread === undefined) return undefined;
    const turn = nativeTurnId === null || nativeTurnId === undefined ? undefined : this.#turnsByNative.get(nativeTurnId);
    return { thread, turn };
  }

  /** Under `full_access` Codex asks only for a managed human checkpoint (`humanCommand`), which a person must answer: the host must not auto-reply. */
  #fullAccessOverride(thread: ThreadState, human: boolean): { fullAccessOverride?: "ask_rule" } {
    return human && thread.policy.mode === "full_access" ? { fullAccessOverride: "ask_rule" } : {};
  }

  #commandApproval(params: CommandExecutionRequestApprovalParams, context: RequestContext): Promise<{ decision: CommandExecutionApprovalDecision }> {
    const origin = this.#origin(params.threadId, params.turnId);
    // Approvals from subagent threads cannot reach the host (approvals.fromSubagents is off): decline them.
    if (origin === undefined) return Promise.resolve({ decision: "decline" });
    const human = params.kind === "humanCommand";
    const decisions = human ? (["accept", "decline", "cancel"] as const) : (params.availableDecisions ?? DEFAULT_COMMAND_DECISIONS);
    const options: RequestOption[] = decisions.map((decision) => approvalOption(decision));
    const nativeKey = `command:${params.approvalId ?? params.itemId}`;
    const turnId = origin.turn?.id;
    return this.#pendingRequest(
      {
        id: requestIdFor(origin.thread.thread.id, nativeKey),
        native: strongRef(nativeKey),
        kind: "command",
        origin: { threadId: origin.thread.thread.id, ...(turnId === undefined ? {} : { turnId, itemId: itemIdFor(turnId, params.itemId) }) },
        subject: {
          ...(params.command === null || params.command === undefined ? {} : { command: [params.command] }),
          ...(params.cwd === null || params.cwd === undefined ? {} : { cwd: params.cwd }),
        },
        options,
        allowCustomAnswer: false,
        allowFeedback: false,
        response: { mode: "live" },
        survivesRestart: false,
        ...this.#fullAccessOverride(origin.thread, human),
      },
      origin.thread.thread.id,
      turnId,
      context,
      (input) => ({ decision: input.optionId === undefined ? "decline" : (decisionFromOptionId(input.optionId, decisions as readonly CommandExecutionApprovalDecision[]) ?? "decline") }),
      { decision: "cancel" },
    );
  }

  #fileChangeApproval(params: FileChangeRequestApprovalParams, context: RequestContext): Promise<{ decision: "accept" | "acceptForSession" | "decline" | "cancel" }> {
    const origin = this.#origin(params.threadId, params.turnId);
    if (origin === undefined) return Promise.resolve({ decision: "decline" });
    const changes = origin.turn?.fileChanges.get(params.itemId) ?? [];
    const nativeKey = `fileChange:${params.itemId}`;
    const turnId = origin.turn?.id;
    const diff = changes.map((change) => change.diff).join("\n");
    return this.#pendingRequest(
      {
        id: requestIdFor(origin.thread.thread.id, nativeKey),
        native: strongRef(nativeKey),
        kind: "file_change",
        origin: { threadId: origin.thread.thread.id, ...(turnId === undefined ? {} : { turnId, itemId: itemIdFor(turnId, params.itemId) }) },
        subject: {
          cwd: origin.thread.thread.cwd,
          ...(changes.length === 0 ? {} : { paths: changes.map((change) => change.path) }),
          ...(this.#emitDiffs && diff !== "" ? { diff } : {}),
        },
        options: FILE_CHANGE_DECISIONS.map((decision) => approvalOption(decision)),
        allowCustomAnswer: false,
        allowFeedback: false,
        response: { mode: "live" },
        survivesRestart: false,
      },
      origin.thread.thread.id,
      turnId,
      context,
      (input) => ({ decision: input.optionId === undefined ? "decline" : (decisionFromOptionId(input.optionId, FILE_CHANGE_DECISIONS) ?? "decline") }),
      { decision: "cancel" },
    );
  }

  #permissionsApproval(params: PermissionsRequestApprovalParams, context: RequestContext): Promise<unknown> {
    const origin = this.#origin(params.threadId, params.turnId);
    if (origin === undefined) return Promise.resolve({ permissions: {} });
    const nativeKey = `permissions:${params.itemId}`;
    const turnId = origin.turn?.id;
    const requested = params.permissions as { [key: string]: unknown };
    return this.#pendingRequest(
      {
        id: requestIdFor(origin.thread.thread.id, nativeKey),
        native: strongRef(nativeKey),
        kind: "permission",
        origin: { threadId: origin.thread.thread.id, ...(turnId === undefined ? {} : { turnId, itemId: itemIdFor(turnId, params.itemId) }) },
        subject: { cwd: params.cwd, tool: { name: "permissions", input: requested } },
        options: [
          { optionId: "turn", label: "Allow for this turn", decision: "accept", scope: "once" },
          { optionId: "session", label: "Allow for this session", decision: "accept_for_session", scope: "session" },
          { optionId: "deny", label: "Deny", decision: "decline" },
        ],
        allowCustomAnswer: false,
        allowFeedback: false,
        response: { mode: "live" },
        survivesRestart: false,
      },
      origin.thread.thread.id,
      turnId,
      context,
      (input) => (input.optionId === "turn" || input.optionId === "session" ? { permissions: requested, scope: input.optionId } : { permissions: {} }),
      { permissions: {} },
    );
  }

  #userInputRequest(params: ToolRequestUserInputParams, context: RequestContext): Promise<unknown> {
    const origin = this.#origin(params.threadId, params.turnId);
    if (origin === undefined) return Promise.resolve({ answers: {} });
    const nativeKey = `userInput:${params.itemId}`;
    const turnId = origin.turn?.id;
    const questions: Question[] = params.questions.map((question) => ({
      id: question.id,
      type: question.isSecret === true ? "secret" : (question.options?.length ?? 0) > 0 ? "single_select" : "text",
      prompt: question.question,
      header: question.header,
      // Codex answers a choice with its label, so the label is the native option id.
      ...((question.options?.length ?? 0) > 0 ? { options: question.options!.map((option) => ({ id: option.label, label: option.label, ...(option.description === "" ? {} : { description: option.description }) })) } : {}),
      ...(question.isOther === true ? { allowCustom: true } : {}),
    }));
    return this.#pendingRequest(
      {
        id: requestIdFor(origin.thread.thread.id, nativeKey),
        native: strongRef(nativeKey),
        kind: "user_input",
        origin: { threadId: origin.thread.thread.id, ...(turnId === undefined ? {} : { turnId, itemId: itemIdFor(turnId, params.itemId) }) },
        questions,
        allowCustomAnswer: params.questions.some((question) => question.isOther === true),
        allowFeedback: false,
        response: { mode: "live" },
        survivesRestart: false,
      },
      origin.thread.thread.id,
      turnId,
      context,
      (input) => {
        const answers: { [id: string]: { answers: string[] } } = {};
        for (const question of params.questions) {
          const answer = input.answers?.[question.id];
          answers[question.id] = { answers: [...(answer?.optionIds ?? []), ...(answer?.text === undefined ? [] : [answer.text])] };
        }
        return { answers };
      },
      { answers: {} },
    );
  }

  #elicitation(params: McpServerElicitationRequestParams, context: RequestContext): Promise<unknown> {
    const origin = this.#origin(params.threadId, params.turnId);
    if (origin === undefined) return Promise.resolve({ action: "decline" });
    const turnId = origin.turn?.id;
    const nativeKey = `elicitation:${params.serverName}:${"elicitationId" in params ? params.elicitationId : "message" in params ? params.message : params.challenge}`;
    const questions: Question[] = [];
    if (params.mode === "form") {
      const required = new Set(params.requestedSchema.required ?? []);
      for (const [name, schema] of Object.entries(params.requestedSchema.properties)) {
        const field = schema as { type?: string; title?: string | null; description?: string | null; enum?: string[]; oneOf?: Array<{ const: string; title: string }>; format?: string | null };
        const choices = field.enum ?? field.oneOf?.map((option) => option.const);
        questions.push({
          id: name,
          type: choices !== undefined ? "single_select" : field.type === "boolean" ? "single_select" : field.format === "uri" ? "url" : "text",
          prompt: field.title ?? field.description ?? name,
          ...(choices !== undefined ? { options: choices.map((choice) => ({ id: choice, label: choice })) } : field.type === "boolean" ? { options: [{ id: "true", label: "Yes" }, { id: "false", label: "No" }] } : {}),
          required: required.has(name),
        });
      }
    } else if (params.mode === "url") {
      questions.push({ id: "url", type: "url", prompt: params.message, url: params.url });
    }
    const title = "message" in params ? params.message : params.title;
    return this.#pendingRequest(
      {
        id: requestIdFor(origin.thread.thread.id, nativeKey),
        native: strongRef(nativeKey),
        kind: "mcp_elicitation",
        origin: { threadId: origin.thread.thread.id, ...(turnId === undefined ? {} : { turnId }) },
        subject: { tool: { server: params.serverName, name: title } },
        options: [
          { optionId: "accept", label: "Submit", decision: "accept", scope: "once" },
          { optionId: "decline", label: "Decline", decision: "decline" },
          { optionId: "cancel", label: "Cancel", decision: "cancel" },
        ],
        ...(questions.length === 0 ? {} : { questions }),
        allowCustomAnswer: false,
        allowFeedback: false,
        response: { mode: "live" },
        survivesRestart: false,
      },
      origin.thread.thread.id,
      turnId,
      context,
      (input) => {
        const action = input.optionId === "decline" || input.optionId === "cancel" ? input.optionId : "accept";
        if (action !== "accept") return { action };
        const content: { [key: string]: unknown } = {};
        for (const question of questions) {
          const answer = input.answers?.[question.id];
          const value = answer?.text ?? answer?.optionIds?.[0];
          if (value === undefined) continue;
          content[question.id] = value === "true" ? true : value === "false" ? false : value;
        }
        return { action, content };
      },
      { action: "cancel" },
    );
  }

  async #dynamicToolCall(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const origin = this.#origin(params.threadId, params.turnId);
    const callDynamicTool = this.#runtime.host.hostTools.callDynamicTool;
    if (origin === undefined || callDynamicTool === undefined) return { success: false, contentItems: [{ type: "inputText", text: "The host offers no dynamic tools to this thread." }] };
    const result = await callDynamicTool({ threadId: origin.thread.thread.id, ...(origin.turn === undefined ? {} : { turnId: origin.turn.id }), callId: params.callId, name: params.tool, input: params.arguments });
    const contentItems = result.content.flatMap((block): DynamicToolCallResponse["contentItems"] => {
      if (block.type === "text") return [{ type: "inputText", text: block.text }];
      if (block.type === "image" && block.url !== undefined) return [{ type: "inputImage", imageUrl: block.url }];
      if (block.type === "image" && block.data !== undefined) return [{ type: "inputImage", imageUrl: `data:${block.mimeType ?? "image/png"};base64,${block.data}` }];
      return [];
    });
    return { success: result.isError !== true, contentItems };
  }

  // Internals: process exit.

  #onExit(connection: CodexConnection | undefined, byDriver: boolean): void {
    if (byDriver || connection === undefined || connection !== this.#current) return;
    this.#current = undefined;
    this.#connection = undefined;
    for (const thread of this.#threads.values()) thread.loaded = false;
    const message = "The codex app-server exited.";
    for (const thread of this.#threads.values()) {
      if (thread.active !== undefined) this.#settle(thread.active, "failed", { class: "transport_error", message, retryable: true });
      thread.pendingStart?.settled?.();
      thread.pendingStart = undefined;
    }
    // Live requests die with the process; message-mode questions do not.
    for (const pending of this.#requests.values()) {
      if (pending.resolved || pending.reply === undefined) continue;
      pending.abandon();
      this.#resolve(pending, "expired");
    }
    // Background terminals end with the process.
    if ([...this.#tasks.values()].some((task) => task.running)) {
      for (const task of this.#tasks.values()) task.running = false;
      this.#emitBackground();
    }
    this.#emit({ type: "notice", level: "error", code: "codex.exited", text: message });
  }

  // Internals: content and extensions.

  async #userInput(content: readonly ContentBlock[]): Promise<UserInput[]> {
    const input: UserInput[] = [];
    for (const block of content) {
      if (block.type === "text") input.push({ type: "text", text: block.text, text_elements: [] });
      else if (block.type === "image") {
        if (block.url !== undefined) input.push({ type: "image", url: block.url } as UserInput);
        else if (block.data !== undefined) input.push({ type: "image", url: `data:${block.mimeType ?? "image/png"};base64,${block.data}` } as UserInput);
        else if (block.attachmentRef !== undefined) {
          const resolved = await this.#runtime.host.attachments.resolve(block.attachmentRef);
          if (resolved === null) input.push({ type: "text", text: `[The image attachment ${block.attachmentRef} could not be read.]`, text_elements: [] });
          else input.push({ type: "localImage", path: resolved.path });
        }
      } else if (block.type === "file") {
        const resolved = await this.#runtime.host.attachments.resolve(block.attachmentRef);
        if (resolved === null) input.push({ type: "text", text: `[The attached file ${block.name ?? block.attachmentRef} could not be read.]`, text_elements: [] });
        else input.push({ type: "text", text: `[Attached file ${block.name ?? resolved.path}: ${resolved.path}]`, text_elements: [] });
      } else if (block.type === "resource_link") input.push({ type: "text", text: block.uri, text_elements: [] });
    }
    return input;
  }

  #codexGoal(thread: ThreadState, goal: ThreadGoal): CodexGoal {
    return {
      threadId: thread.thread.id,
      objective: goal.objective,
      status: goal.status,
      tokenBudget: goal.tokenBudget ?? null,
      tokensUsed: goal.tokensUsed,
      timeUsedSeconds: goal.timeUsedSeconds,
      createdAt: isoFromSeconds(goal.createdAt) ?? new Date(0).toISOString(),
      updatedAt: isoFromSeconds(goal.updatedAt) ?? new Date(0).toISOString(),
    };
  }

  #ariGoal(thread: ThreadState, goal: ThreadGoal): AriGoal {
    const statuses: { [status: string]: string } = { active: "active", paused: "paused", complete: "completed", blocked: "blocked", usageLimited: "usage_limited", budgetLimited: "budget_limited" };
    return {
      threadId: thread.thread.id,
      objective: goal.objective,
      status: statuses[goal.status] ?? goal.status,
      derived: false,
      turnIds: [...(thread.goalRun?.turnIds ?? [])],
      updatedAt: isoFromSeconds(goal.updatedAt) ?? new Date().toISOString(),
    };
  }

  #emitGoal(thread: ThreadState): void {
    const goal = thread.goal;
    const envelope = { threadId: thread.thread.id };
    if (goal === undefined) {
      this.#emit({ type: "x:ari.goal.updated", data: null, fallback: { title: "Goal cleared" } }, envelope);
      this.#emit({ type: "x:codex.goal.updated", data: { threadId: thread.thread.id, goal: null }, fallback: { title: "Goal cleared" } }, envelope);
      return;
    }
    const ari = this.#ariGoal(thread, goal);
    const text = `Goal ${String(ari.status)}: ${goal.objective}`;
    this.#emit({ type: "x:ari.goal.updated", data: ari, fallback: { title: "Goal", text } }, envelope);
    this.#emit({ type: "x:codex.goal.updated", data: { threadId: thread.thread.id, goal: this.#codexGoal(thread, goal) }, fallback: { title: "Goal", text } }, envelope);
  }

  #readState(thread: ThreadState, readState: ThreadReadState | null | undefined): CodexReadStateResult {
    if (readState === null || readState === undefined) return { threadId: thread.thread.id, readState: null };
    const first = readState.firstUnread;
    const mapped: CodexReadState = {
      revision: readState.revision,
      firstUnread: first === null || first === undefined ? null : first.type === "turn" ? { type: "turn", turnId: turnIdFor(thread.thread.id, first.turnId) } : { type: first.type },
    };
    return { threadId: thread.thread.id, readState: mapped };
  }

  #snapshot(thread: ThreadState, turns: readonly CodexTurn[]): ThreadSnapshot {
    const ariTurns: Turn[] = [];
    const items: Item[] = [];
    for (const native of turns) {
      const turnId = turnIdFor(thread.thread.id, native.id);
      const live = this.#turnsByNative.get(native.id);
      const startedAt = isoFromSeconds(native.startedAt);
      const completedAt = isoFromSeconds(native.completedAt);
      ariTurns.push({
        id: turnId,
        threadId: thread.thread.id,
        native: strongRef(native.id),
        // Turns this session did not see start are taken as the host's; Codex keeps no origin in its history.
        origin: live?.origin ?? "user",
        status: turnStatusFromCodex(native.status),
        ...(live?.hostTag === undefined ? {} : { hostTag: live.hostTag }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(completedAt === undefined ? {} : { completedAt }),
        ...(native.status === "failed" ? { failure: failureFromCodex(native.error, undefined) } : {}),
      });
      for (const item of native.items) if (item.type !== "subAgentActivity") items.push(itemFromCodex(item, this.#itemContext(turnId)));
    }
    const requests = [...this.#requests.values()].filter((pending) => pending.threadId === thread.thread.id && !pending.resolved).map((pending) => pending.request);
    return { thread: thread.thread, turns: ariTurns, items, requests, nativePayload: { turnCount: turns.length } };
  }

  #emit(body: AriEventBody, envelope: { threadId?: string; turnId?: string; hostTag?: string } = {}): void {
    if (this.#sequencer.closed) return;
    this.#sequencer.emit({ body, ...envelope });
  }
}

