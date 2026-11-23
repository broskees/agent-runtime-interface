// The reference driver: a complete, honest ARI driver for the reference agent
// (protocol.ts). It is a stdio driver like the Pi, ACP and Codex drivers: it
// spawns the agent through `host.process.spawn` and speaks NDJSON JSON-RPC
// with it. With the in-memory harness, the "process" is a pair of queues and
// the whole driver runs in memory; the conformance kit runs all 15 scenarios
// against it, and a host can use it to try ARI without any vendor.
//
// What it shows a driver author:
// - ids derive from native ids only (`deriveId`), so replays and a
//   workspace reached through a symlink give the same ids;
// - a turn settles only on the agent's `turn_ended` or on process exit,
//   never on a timer;
// - a steer after the turn ended returns `prompt_required`;
// - a native approval's options keep their native ids and their real reach;
// - resuming a locked or missing native session falls back to a fresh one
//   and says so with `session.replaced`;
// - auth has five states, and a runtime auth failure poisons only its own
//   scope for 30 seconds;
// - `probe()` only runs `reference-agent --version` (and `--auth-status` when
//   deep);
// - every capability it declares off rejects with `unsupported`.
//
// Config `profile: "full"` declares and implements every optional feature the
// agent has; `"minimal"` declares them off (and has no `auth`), which shows
// the other half of capability honesty. `fullAccessReplies` says who answers
// a native approval under `full_access`: the driver itself, with the
// narrowest accepting option, or the host.

import { callErrors, toCallError } from "../../errors.ts";
import { deriveId } from "../../driver-kit/ids.ts";
import { JsonRpcError, JsonRpcPeer } from "../../driver-kit/json-rpc.ts";
import { encodeNdjson, readNdjson } from "../../driver-kit/ndjson.ts";
import { EventSequencer } from "../../driver-kit/sequencer.ts";
import { truncateUtf8 } from "../../driver-kit/truncate.ts";
import type { BackgroundTaskSummary } from "../../generated/background.ts";
import type { Capabilities } from "../../generated/capabilities.ts";
import type { JsonSchema } from "../../generated/common.ts";
import type { CliLaunchManifest } from "../../generated/driver.ts";
import type { AriEvent, AriEventBody } from "../../generated/events.ts";
import type { AuthMethod, AuthState, InstanceStatus, OpenSessionInput, ProbeResult } from "../../generated/instance.ts";
import type { Item } from "../../generated/item.ts";
import type { ApprovalDecision, ApprovalScope, Request, RequestOption } from "../../generated/request.ts";
import type { AppliedThread, RespondInput, StartTurnInput, StartTurnResult } from "../../generated/session.ts";
import type { Thread, ThreadSnapshot, Turn } from "../../generated/thread.ts";
import type { Driver, HostServices, Instance, Session, SpawnedProcess } from "../../runtime.ts";
import { ARI_VERSION } from "../../version.ts";
import { REFERENCE_ERRORS } from "./protocol.ts";
import type { ReferenceOptionKind, ReferencePermissionRequest, ReferenceSessionUpdate, StoredSession, StoredTurn } from "./protocol.ts";

export interface ReferenceDriverConfig {
  /** The reference agent executable. */
  readonly command: string;
  readonly profile: "full" | "minimal";
  readonly fullAccessReplies: "driver" | "host";
}

/** How long a runtime auth failure poisons its scope. */
export const REFERENCE_POISON_MS = 30_000;

const IDENTITY_VERSION = 1;
const SECRET_NAMESPACE = "reference";
const SECRET_KEY = "api-key";
const API_KEY_VARIABLE = "REFERENCE_AGENT_API_KEY";

const MODELS = [
  { id: "reference-small", label: "Reference small", contextWindow: 128_000 },
  { id: "reference-large", label: "Reference large", contextWindow: 512_000 },
];

const AUTH_METHODS: AuthMethod[] = [
  { id: "api-key", kind: "api_key", label: "API key", fields: [{ id: "apiKey", label: "API key", secret: true, required: true }] },
];

export const REFERENCE_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    command: { type: "string", description: "The reference agent executable." },
    profile: { enum: ["full", "minimal"], description: "full: every optional feature on; minimal: all off." },
    fullAccessReplies: { enum: ["driver", "host"], description: "Who answers native approvals under full_access." },
  },
  required: ["command", "profile", "fullAccessReplies"],
};

export const REFERENCE_CLI_MANIFEST: CliLaunchManifest = {
  binary: "reference-agent",
  envScrubPrefixes: ["REFERENCE_AGENT_"],
  args: { fresh: [], resume: ["--resume", "{sessionId}"] },
};

/** The capabilities each profile declares. */
export function referenceCapabilities(profile: ReferenceDriverConfig["profile"]): Capabilities {
  const full = profile === "full";
  return {
    ariVersion: ARI_VERSION,
    sessions: {
      multipleThreads: full,
      switchModel: true,
      switchRuntimeMode: false,
      pendingRequestsSurviveRestart: false,
      release: full,
      feedbackUpload: full,
      contextUsageReuse: full,
    },
    threads: {
      createEmpty: true,
      readSnapshot: full,
      rollback: full,
      compact: full,
      injectHistory: full,
      unload: full,
      exposesNativeIds: true,
      fork: { supported: full, fromTurn: full, fromItem: false, fromSubagent: false, crossCwd: full },
    },
    turns: {
      interrupt: true,
      steer: full,
      queue: full,
      emitsStarted: true,
      terminalStatus: "strong",
      multiNativeTurnsPerRequest: false,
      steeringInterruptsTools: false,
    },
    streaming: { assistantText: true, reasoning: false, toolOutput: false, planText: false },
    tools: { mcp: false, dynamicTools: false, mcpApps: full, exposesToolItemIds: true },
    approvals: { command: full, fileRead: false, fileChange: full, permission: false, fromSubagents: false },
    planning: { todoList: false, proposedPlan: false, planUpdates: false, structuredQuestions: false },
    subagents: { supported: full, exposesThreadIds: false, lifecycle: full, wait: false, stop: full },
    context: { instructionChannels: [], syntheticContext: false, summaries: false, handoffSummaries: false },
    checkpointing: { workspace: false, conversationRollback: full, rollbackReturnsSnapshot: full },
    identity: { threadIds: "strong", turnIds: "strong", itemIds: "strong", requestIds: "strong", identityVersion: IDENTITY_VERSION },
    runtimePolicy: {
      modes: {
        read_only: { supported: false, enforcement: "client_boundary" },
        approval_required: { supported: true, enforcement: "client_boundary" },
        auto_accept_edits: { supported: false, enforcement: "client_boundary" },
        auto: { supported: false, enforcement: "client_boundary" },
        full_access: { supported: full, enforcement: "client_boundary" },
      },
      interactionModes: ["default"],
      switchInSession: false,
    },
    requests: {
      responseModes: ["live"],
      allowCustomAnswer: false,
      approvalScopes: full
        ? [
            { decision: "accept", scope: "once" },
            { decision: "accept_for_session", scope: "session" },
            { decision: "accept_always", scope: "project" },
          ]
        : [],
    },
    background: { list: full, stop: full, await: full, tasksEndWithProcess: true },
    mcp: { acceptsHostServers: [], scope: "session" },
    sessionModel: "process_per_instance",
    externallyOwned: false,
    diffs: { emits: false, canDisable: false },
    contextWindowReporting: full,
    extensions: full ? [{ ns: "reference.echo", version: "1" }] : [],
  };
}

const OPTION_MEANING: { readonly [kind in ReferenceOptionKind]: { decision: ApprovalDecision; scope: ApprovalScope } } = {
  allow_once: { decision: "accept", scope: "once" },
  allow_session: { decision: "accept_for_session", scope: "session" },
  allow_always: { decision: "accept_always", scope: "project" },
  reject_once: { decision: "decline", scope: "once" },
};

const SCOPE_RANK: { readonly [scope: string]: number } = { once: 0, session: 1, project: 2, global: 3 };

function strong(id: string): { id: string; strength: "strong" } {
  return { id, strength: "strong" };
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Maps an agent error to a call error. */
function callErrorFrom(error: unknown, what: string): Error {
  if (toCallError(error) !== undefined) return error as Error;
  if (error instanceof JsonRpcError) {
    if (error.code === REFERENCE_ERRORS.notFound) return callErrors.notFound({ resource: what, message: error.message });
    if (error.code === REFERENCE_ERRORS.turnActive) return callErrors.invalidState("previous_turn_active", error.message);
    if (error.code === REFERENCE_ERRORS.locked) return callErrors.invalidState("session_locked", error.message);
    return callErrors.protocol(`agent error ${error.code}`, error.message);
  }
  return callErrors.transport(error instanceof Error ? error.message : String(error));
}

/** Runs `reference-agent <args>` to completion and returns its stdout and exit code. */
async function runOnce(host: HostServices<ReferenceDriverConfig>, command: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  const child = await host.process.spawn({ command, args, purpose: "probe", stdin: "ignore", timeoutMs: 10_000 });
  const decoder = new TextDecoder();
  let stdout = "";
  const drain = async (): Promise<void> => {
    for await (const chunk of child.stderr) void chunk;
  };
  const errors = drain();
  for await (const chunk of child.stdout) stdout += decoder.decode(chunk, { stream: true });
  await errors;
  const exit = await child.exited;
  return { code: exit.code, stdout };
}

/** The connection to one running agent process. */
class AgentConnection {
  readonly peer: JsonRpcPeer;
  readonly #process: SpawnedProcess;
  #closedByDriver = false;

  constructor(
    process: SpawnedProcess,
    handlers: {
      readonly onUpdate: (update: ReferenceSessionUpdate) => void;
      readonly onPermission: (request: ReferencePermissionRequest, signal: AbortSignal) => Promise<{ optionId: string }>;
      readonly onExit: (code: number | null, signal: string | null, byDriver: boolean) => void;
    },
  ) {
    this.#process = process;
    const peer = new JsonRpcPeer({
      send: (message) => process.write(encodeNdjson(message)),
      onNotification: (method, params) => {
        if (method === "session/update") handlers.onUpdate(params as ReferenceSessionUpdate);
      },
      onRequest: (method, params, context) => {
        if (method === "permission/request") return handlers.onPermission(params as ReferencePermissionRequest, context.signal);
        throw new JsonRpcError(-32601, `Method not found: ${method}`);
      },
    });
    this.peer = peer;
    void (async () => {
      for await (const chunk of process.stderr) void chunk;
    })();
    void (async () => {
      for await (const record of readNdjson(process.stdout)) {
        if (record.ok) peer.receive(record.value);
      }
      const exit = await process.exited;
      peer.close();
      handlers.onExit(exit.code, exit.signal, this.#closedByDriver);
    })();
  }

  request<T>(method: string, params: unknown): Promise<T> {
    return this.peer.request<T>(method, params);
  }

  async close(): Promise<void> {
    this.#closedByDriver = true;
    this.peer.close();
    await this.#process.kill();
    await this.#process.exited;
  }
}

interface TurnState {
  readonly id: string;
  readonly nativeId: string;
  readonly threadId: string;
  readonly hostTag: string | undefined;
  /** Native item ids that opened and have not settled. */
  readonly openItems: Set<string>;
  readonly toolNames: Map<string, { name: string; input: unknown }>;
  settled: boolean;
}

interface ThreadState {
  thread: Thread;
  readonly nativeId: string;
  readonly policy: StartTurnInput["policy"] & object;
  active: TurnState | undefined;
  /** Host context for prompts sent but not yet started, by native turn id or in order for starts. */
  readonly pendingStarts: Array<{ clientTurnKey: string; hostTag: string | undefined }>;
  readonly queued: Map<string, { clientTurnKey: string; hostTag: string | undefined }>;
  unloaded: boolean;
}

interface PendingRequest {
  readonly request: Request;
  readonly turnId: string;
  readonly reply: (optionId: string) => void;
  readonly abandon: () => void;
  inFlight: string | undefined;
  resolved: boolean;
}

class ReferenceSession implements Session {
  readonly id: string;
  readonly #host: HostServices<ReferenceDriverConfig>;
  readonly #config: ReferenceDriverConfig;
  readonly #input: OpenSessionInput;
  readonly #capabilities: Capabilities;
  readonly #sequencer: EventSequencer;
  readonly #threads = new Map<string, ThreadState>();
  readonly #threadsByNative = new Map<string, string>();
  /** Every turn this session saw, by native turn id and by ARI turn id. */
  readonly #turnsByNative = new Map<string, TurnState>();
  readonly #turnsById = new Map<string, TurnState>();
  readonly #requests = new Map<string, PendingRequest>();
  readonly #responses = new Map<string, Promise<void>>();
  readonly #turnKeys = new Map<string, Promise<StartTurnResult>>();
  readonly #tasks = new Map<string, { nativeId: string; threadId: string; title: string; status: string; turnId: string }>();
  readonly #subagents = new Map<string, { nativeId: string; threadId: string }>();
  #connection: Promise<AgentConnection> | undefined;
  #closed = false;

  constructor(host: HostServices<ReferenceDriverConfig>, config: ReferenceDriverConfig, input: OpenSessionInput, id: string) {
    this.id = id;
    this.#host = host;
    this.#config = config;
    this.#input = input;
    this.#capabilities = referenceCapabilities(config.profile);
    this.#sequencer = new EventSequencer({ sessionId: id });
  }

  get #full(): boolean {
    return this.#config.profile === "full";
  }

  /** Spawns the agent and announces the session. */
  async open(): Promise<void> {
    await this.#agent();
    this.#emit({ type: "capabilities.updated", capabilities: this.#capabilities });
    this.#emit({ type: "session.state", state: "ready" });
  }

  capabilities(): Capabilities {
    return this.#capabilities;
  }

  events(options?: { fromSeq?: number }): AsyncIterable<AriEvent> {
    return this.#sequencer.events(options?.fromSeq === undefined ? {} : { fromSeq: options.fromSeq });
  }

  async createThread(input: Parameters<Session["createThread"]>[0]): Promise<AppliedThread> {
    this.#open();
    if (!this.#full && [...this.#threads.values()].some((thread) => !thread.unloaded)) throw callErrors.unsupported("sessions.multipleThreads");
    const agent = await this.#agent();
    const created = await agent.request<{ sessionId: string; cwd: string }>("session/new", { cwd: input.cwd }).catch((error: unknown) => {
      throw callErrorFrom(error, "session");
    });
    const thread = this.#register(created.sessionId, created.cwd, input.policy, input.title);
    return { ...thread, appliedConfig: { model: (input.config?.["model"] as string | undefined) ?? MODELS[0]!.id } };
  }

  async resumeThread(input: Parameters<Session["resumeThread"]>[0]): Promise<AppliedThread> {
    this.#open();
    const nativeId = "handle" in input.native ? input.native.handle : input.native.id;
    if (nativeId === null) throw callErrors.validation([{ message: "resumeThread needs a native id or handle", path: ["native"] }]);
    const known = this.#threadsByNative.get(nativeId);
    const knownState = known === undefined ? undefined : this.#threads.get(known);
    // A thread this session holds loaded needs nothing; an unloaded one loads its native session again below.
    if (knownState !== undefined && !knownState.unloaded) return knownState.thread;
    const agent = await this.#agent();
    const policy = input.policy ?? knownState?.policy ?? { mode: "approval_required", interaction: "default", cwd: "" };
    try {
      const loaded = await agent.request<{ sessionId: string; cwd: string }>("session/load", { sessionId: nativeId });
      return this.#register(loaded.sessionId, loaded.cwd, { ...policy, cwd: policy.cwd === "" ? loaded.cwd : policy.cwd });
    } catch (error) {
      const locked = error instanceof JsonRpcError && error.code === REFERENCE_ERRORS.locked;
      const missing = error instanceof JsonRpcError && error.code === REFERENCE_ERRORS.notFound;
      if ((!locked && !missing) || input.policy === undefined) throw callErrorFrom(error, "native session");
      // Fall back to a fresh native session, and say so: the old context is gone.
      const fresh = await agent.request<{ sessionId: string; cwd: string }>("session/new", { cwd: input.policy.cwd });
      const threadId = deriveId({ kind: "thread", native: strong(fresh.sessionId), identityVersion: IDENTITY_VERSION });
      this.#emit(
        {
          type: "session.replaced",
          previousNativeId: nativeId,
          reason: locked ? "The native session is open in another process." : "The native session no longer exists.",
          contextLost: true,
          showRuntimeNote: true,
        },
        { threadId },
      );
      return this.#register(fresh.sessionId, fresh.cwd, input.policy);
    }
  }

  async readSnapshot(threadId: string): Promise<ThreadSnapshot> {
    this.#require("threads.readSnapshot");
    const thread = this.#thread(threadId);
    const stored = await this.#request<StoredSession>("session/snapshot", { sessionId: thread.nativeId }, "native session");
    return this.#snapshot(thread, stored);
  }

  async forkThread(input: Parameters<NonNullable<Session["forkThread"]>>[0]): Promise<Thread> {
    this.#require("threads.fork");
    if (input.at.type === "item") throw callErrors.unsupported("threads.fork.fromItem");
    const source = this.#thread(input.threadId);
    const atTurnId = input.at.type === "turn" ? this.#nativeTurnId(source, input.at.turnId) : undefined;
    // The agent forks into another directory itself, and resolves that directory the way it resolves a new session's.
    const fork = await this.#request<{ sessionId: string; cwd: string }>("session/fork", { sessionId: source.nativeId, atTurnId, cwd: input.cwd }, "turn");
    const policy = input.policy ?? (input.cwd === undefined ? source.policy : { ...source.policy, cwd: fork.cwd });
    const thread = this.#register(fork.sessionId, fork.cwd, policy, undefined, {
      threadId: source.thread.id,
      ...(input.at.type === "turn" ? { turnId: input.at.turnId } : {}),
    });
    return thread;
  }

  async rollbackThread(input: Parameters<NonNullable<Session["rollbackThread"]>>[0]): Promise<ThreadSnapshot> {
    this.#require("threads.rollback");
    const thread = this.#thread(input.threadId);
    const toTurnId = input.to.type === "turn" ? this.#nativeTurnId(thread, input.to.turnId) : undefined;
    const stored = await this.#request<StoredSession>("session/rollback", { sessionId: thread.nativeId, toTurnId }, "turn");
    this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id }, retainedNativeTurnIds: stored.turns.map((turn) => turn.turnId) }, { threadId: thread.thread.id });
    return this.#snapshot(thread, stored);
  }

  async compactThread(threadId: string): Promise<void> {
    this.#require("threads.compact");
    await this.#request("session/compact", { sessionId: this.#thread(threadId).nativeId }, "native session");
  }

  async injectHistory(input: Parameters<NonNullable<Session["injectHistory"]>>[0]): Promise<{ consumed: boolean }> {
    this.#require("threads.injectHistory");
    if (input.summary !== "") throw callErrors.unsupported("context.handoffSummaries");
    const messages = input.messages.map((message) => ({
      role: message.role,
      text: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
    }));
    await this.#request("session/inject", { sessionId: this.#thread(input.threadId).nativeId, messages }, "native session");
    return { consumed: true };
  }

  async unloadThread(threadId: string): Promise<void> {
    this.#require("threads.unload");
    const thread = this.#thread(threadId);
    if (thread.active !== undefined) throw callErrors.invalidState("turn_active");
    await this.#request("session/unload", { sessionId: thread.nativeId }, "native session");
    thread.unloaded = true;
    thread.thread = { ...thread.thread, status: "unloaded" };
    this.#emit({ type: "thread.upsert", thread: { id: threadId, status: "unloaded" } }, { threadId });
  }

  canRelease(): boolean {
    if (!this.#full) return false;
    const busy = [...this.#threads.values()].some((thread) => thread.active !== undefined || thread.queued.size > 0);
    const pending = [...this.#requests.values()].some((request) => !request.resolved);
    const working = [...this.#tasks.values()].some((task) => task.status === "running");
    return !busy && !pending && !working;
  }

  async release(): Promise<void> {
    this.#require("sessions.release");
    if (!this.canRelease()) throw callErrors.invalidState("release_vetoed", "Turns, requests or background tasks are still running");
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection !== undefined) await (await connection).close();
  }

  startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    this.#open();
    // A retry with the same clientTurnKey never sends twice.
    const prior = this.#turnKeys.get(input.clientTurnKey);
    if (prior !== undefined) return prior;
    const started = this.#startTurn(input);
    this.#turnKeys.set(input.clientTurnKey, started);
    started.catch(() => this.#turnKeys.delete(input.clientTurnKey));
    return started;
  }

  async #startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const thread = this.#thread(input.threadId);
    const text = input.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    const context = { clientTurnKey: input.clientTurnKey, hostTag: input.hostTag };

    if (input.intent === "steer") {
      if (!this.#full) return { status: "unsupported", capability: "turns.steer" };
      const active = thread.active;
      if (active === undefined || (input.expectedTurnId !== undefined && input.expectedTurnId !== active.id)) return { status: "prompt_required" };
      try {
        await (await this.#agent()).request("session/steer", { sessionId: thread.nativeId, turnId: active.nativeId, text });
      } catch (error) {
        // The turn ended natively before the steer arrived.
        if (error instanceof JsonRpcError && error.code === REFERENCE_ERRORS.noActiveTurn) return { status: "prompt_required" };
        throw callErrorFrom(error, "turn");
      }
      return { status: "accepted", turnId: active.id, accepted: "steered" };
    }
    if (input.intent === "queue" && !this.#full) return { status: "unsupported", capability: "turns.queue" };
    if (input.intent !== "start" && input.intent !== "queue") return { status: "unsupported", capability: `turns.${input.intent}` };

    const agent = await this.#agent();
    if (input.intent === "queue" && thread.active !== undefined) {
      const queued = await agent.request<{ turnId: string; queued: boolean }>("session/prompt", { sessionId: thread.nativeId, text, queue: true }).catch((error: unknown) => {
        throw callErrorFrom(error, "native session");
      });
      thread.queued.set(queued.turnId, context);
      return { status: "accepted", turnId: this.#turnId(thread.thread.id, queued.turnId), accepted: "queued" };
    }
    if (thread.active !== undefined) throw callErrors.invalidState("previous_turn_active");
    thread.pendingStarts.push(context);
    try {
      const started = await agent.request<{ turnId: string; queued: boolean }>("session/prompt", { sessionId: thread.nativeId, text });
      return { status: "accepted", turnId: this.#turnId(thread.thread.id, started.turnId), accepted: "started" };
    } catch (error) {
      const index = thread.pendingStarts.indexOf(context);
      if (index !== -1) thread.pendingStarts.splice(index, 1);
      throw callErrorFrom(error, "native session");
    }
  }

  async interruptTurn(input: { turnId: string; restartRuntime?: boolean }): Promise<void> {
    this.#open();
    const turn = this.#turnsById.get(input.turnId);
    if (turn === undefined || turn.settled) return;
    const thread = this.#thread(turn.threadId);
    if (thread.active !== turn) return;
    await this.#request("session/cancel", { sessionId: thread.nativeId, turnId: turn.nativeId }, "turn");
  }

  respond(input: RespondInput): Promise<void> {
    this.#open();
    // The same (requestId, responseKey) gets the same outcome, and reaches the agent once.
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
    if (input.custom !== undefined) throw callErrors.unsupported("requests.allowCustomAnswer");
    const option = (pending.request.options ?? []).find((candidate) => candidate.optionId === input.optionId);
    if (option === undefined) throw callErrors.validation([{ message: `no option ${String(input.optionId)}`, path: ["optionId"] }]);
    pending.reply(option.optionId);
    pending.resolved = true;
    this.#emit({ type: "request.upsert", request: { id: pending.request.id, status: "resolved" } }, { threadId: pending.request.origin.threadId, turnId: pending.turnId });
  }

  async planConfigChange(input: { threadId: string; changes: { [key: string]: unknown } }) {
    this.#thread(input.threadId);
    const unknown = Object.keys(input.changes).filter((key) => key !== "model");
    if (unknown.length > 0) return { type: "reject" as const, reason: `unknown options: ${unknown.join(", ")}` };
    return { type: "apply_next_turn" as const };
  }

  contextWindow(model: string): number | undefined {
    this.#require("contextWindowReporting");
    return MODELS.find((candidate) => candidate.id === model)?.contextWindow;
  }

  canReuseContextUsage(previousModel: string, nextModel: string): boolean {
    this.#require("sessions.contextUsageReuse");
    return previousModel === nextModel;
  }

  async stopSubagent(input: { subagentId: string }): Promise<{ status: string }> {
    this.#require("subagents.stop");
    const subagent = this.#subagents.get(input.subagentId);
    if (subagent === undefined) throw callErrors.notFound({ resource: "subagent", id: input.subagentId });
    return this.#request<{ status: string }>("subagent/stop", { subagentId: subagent.nativeId }, "subagent");
  }

  async uploadFeedback(input: { threadId: string; reason?: string }): Promise<{ feedbackId: string }> {
    this.#require("sessions.feedbackUpload");
    return this.#request<{ feedbackId: string }>("feedback/upload", { sessionId: this.#thread(input.threadId).nativeId, reason: input.reason }, "native session");
  }

  async ext(ns: string, method: string, params: unknown): Promise<unknown> {
    if (!this.#capabilities.extensions.some((extension) => extension.ns === ns)) throw callErrors.unsupported(`extensions.${ns}`);
    if (method !== "echo") throw callErrors.notFound({ resource: "extension method", id: `${ns}.${method}` });
    return this.#request("ext/echo", { params }, "extension method");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection !== undefined) await (await connection.catch(() => undefined))?.close();
    for (const pending of this.#requests.values()) if (!pending.resolved) pending.abandon();
    this.#sequencer.close();
  }

  /** Background tasks and MCP apps exist only in the full profile, so the members are attached there. */
  attachOptionalGroups(): void {
    if (!this.#full) return;
    const session = this as Session;
    session.backgroundTasks = {
      list: async (threadId) => {
        const thread = this.#thread(threadId);
        const listed = await this.#request<{ tasks: Array<{ taskId: string; title: string; status: string; turnId: string }> }>("tasks/list", { sessionId: thread.nativeId }, "native session");
        return listed.tasks.map((task) => {
          const id = this.#taskId(threadId, task.taskId);
          return { id, kind: "terminal", status: task.status, title: task.title, threadId, turnId: this.#turnId(threadId, task.turnId) };
        });
      },
      stop: async (input) => {
        const task = this.#tasks.get(input.taskId);
        if (task === undefined) throw callErrors.notFound({ resource: "background task", id: input.taskId });
        await this.#request("tasks/stop", { sessionId: this.#thread(input.threadId).nativeId, taskId: task.nativeId }, "background task");
      },
      await: async (input) => {
        const natives = input.taskIds.flatMap((taskId) => {
          const task = this.#tasks.get(taskId);
          return task === undefined ? [] : [task.nativeId];
        });
        const result = await this.#request<{ matched: string[] }>("tasks/await", { sessionId: this.#thread(input.threadId).nativeId, taskIds: natives }, "background task");
        return { matched: result.matched.map((nativeId) => this.#taskId(input.threadId, nativeId)) };
      },
    };
    session.mcpApps = {
      listTools: async (threadId, server) => {
        this.#thread(threadId);
        return (await this.#request<{ tools: Array<{ name: string; description?: string }> }>("mcp/listTools", { server }, "MCP server")).tools;
      },
      callTool: async (threadId, server, tool, args) => {
        this.#thread(threadId);
        return this.#request<{ content: unknown[] }>("mcp/callTool", { server, tool, args }, "MCP tool");
      },
      readResource: async (threadId, server, uri) => {
        this.#thread(threadId);
        return this.#request<{ contents: unknown[] }>("mcp/readResource", { server, uri }, "MCP resource");
      },
    };
  }

  // Internals.

  #open(): void {
    if (this.#closed) throw callErrors.invalidState("session_closed");
  }

  #require(path: string): void {
    if (!this.#full) throw callErrors.unsupported(path);
  }

  #emit(body: AriEventBody, envelope: { threadId?: string; turnId?: string; hostTag?: string } = {}): void {
    if (this.#sequencer.closed) return;
    this.#sequencer.emit({ body, ...envelope });
  }

  #thread(threadId: string): ThreadState {
    const thread = this.#threads.get(threadId);
    if (thread === undefined) throw callErrors.notFound({ resource: "thread", id: threadId });
    return thread;
  }

  #turnId(threadId: string, nativeTurnId: string): string {
    return deriveId({ kind: "turn", native: strong(nativeTurnId), identityVersion: IDENTITY_VERSION, scope: threadId });
  }

  #itemId(turnId: string, nativeItemId: string): string {
    return deriveId({ kind: "item", native: strong(nativeItemId), identityVersion: IDENTITY_VERSION, scope: turnId });
  }

  #taskId(threadId: string, nativeTaskId: string): string {
    const id = deriveId({ kind: "task", native: strong(nativeTaskId), identityVersion: IDENTITY_VERSION, scope: threadId });
    return id;
  }

  #nativeTurnId(thread: ThreadState, turnId: string): string {
    const turn = this.#turnsById.get(turnId);
    if (turn !== undefined && turn.threadId === thread.thread.id) return turn.nativeId;
    throw callErrors.notFound({ resource: "turn", id: turnId });
  }

  async #request<T>(method: string, params: unknown, what: string): Promise<T> {
    this.#open();
    const agent = await this.#agent();
    return agent.request<T>(method, params).catch((error: unknown) => {
      throw callErrorFrom(error, what);
    });
  }

  /** The agent connection, spawning the agent (and reloading this session's threads) when there is none. */
  #agent(): Promise<AgentConnection> {
    this.#connection ??= this.#spawn().catch((error: unknown) => {
      this.#connection = undefined;
      throw error;
    });
    return this.#connection;
  }

  async #spawn(): Promise<AgentConnection> {
    const env: { [name: string]: string } = {};
    const key = await this.#host.secrets.get(SECRET_NAMESPACE, SECRET_KEY);
    if (key !== null) env[API_KEY_VARIABLE] = decode(key);
    const process = await this.#host.process.spawn({
      command: this.#config.command,
      args: ["--session-dir", `${this.#host.paths.stateDir}/sessions`],
      env,
      purpose: "runtime",
      stdin: "pipe",
    });
    let connection: AgentConnection;
    connection = new AgentConnection(process, {
      onUpdate: (update) => this.#onUpdate(update),
      onPermission: (request, signal) => this.#onPermission(request, signal),
      onExit: (code, signal, byDriver) => this.#onExit(connection, code, signal, byDriver),
    });
    const timeoutMs = this.#input.handshakeTimeoutMs ?? 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connection.request("initialize", {}),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(callErrors.transport(`the reference agent did not answer initialize within ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      await connection.close();
      throw callErrorFrom(error, "agent");
    } finally {
      clearTimeout(timer);
    }
    // A respawned agent reloads the threads this session holds.
    for (const thread of this.#threads.values()) {
      if (thread.unloaded) continue;
      await connection.request("session/load", { sessionId: thread.nativeId }).catch(() => undefined);
    }
    return connection;
  }

  #register(nativeId: string, cwd: string, policy: StartTurnInput["policy"] & object, title?: string, forkedFrom?: Thread["forkedFrom"]): Thread {
    const id = deriveId({ kind: "thread", native: strong(nativeId), identityVersion: IDENTITY_VERSION });
    const thread: Thread = {
      id,
      native: strong(nativeId),
      cwd,
      status: "idle",
      handle: nativeId,
      identityVersion: IDENTITY_VERSION,
      ...(title === undefined ? {} : { title }),
      ...(forkedFrom === undefined ? {} : { forkedFrom }),
    };
    this.#threads.set(id, { thread, nativeId, policy, active: undefined, pendingStarts: [], queued: new Map(), unloaded: false });
    this.#threadsByNative.set(nativeId, id);
    this.#emit({ type: "thread.upsert", thread }, { threadId: id });
    return thread;
  }

  #snapshot(thread: ThreadState, stored: StoredSession): ThreadSnapshot {
    const turns: Turn[] = [];
    const items: Item[] = [];
    const statuses: { [status: string]: Turn["status"] } = { running: "running", queued: "pending", completed: "completed", cancelled: "interrupted", failed: "failed" };
    for (const storedTurn of stored.turns) {
      const turnId = this.#turnId(thread.thread.id, storedTurn.turnId);
      turns.push({ id: turnId, threadId: thread.thread.id, native: strong(storedTurn.turnId), origin: "user", status: statuses[storedTurn.status] ?? "completed" });
      items.push(this.#promptItem(turnId, storedTurn));
      for (const item of storedTurn.items) {
        const base = { id: this.#itemId(turnId, item.id), native: strong(item.id), status: item.status, turnId };
        items.push(
          item.kind === "message"
            ? { ...base, kind: "assistant_message", text: item.text ?? "" }
            : { ...base, kind: "tool_call", tool: { name: item.name ?? "tool", input: item.input }, ...(item.output === undefined ? {} : { output: item.output }), ...(item.path === undefined ? {} : { paths: [item.path] }) },
        );
      }
    }
    return { thread: thread.thread, turns, items, requests: [] };
  }

  #promptItem(turnId: string, turn: Pick<StoredTurn, "turnId" | "prompt">): Item {
    const nativeId = `${turn.turnId}:prompt`;
    return { id: this.#itemId(turnId, nativeId), kind: "user_message", native: strong(nativeId), status: "completed", turnId, text: turn.prompt };
  }

  #onUpdate(params: ReferenceSessionUpdate): void {
    const threadId = this.#threadsByNative.get(params.sessionId);
    const thread = threadId === undefined ? undefined : this.#threads.get(threadId);
    if (thread === undefined) return;
    const update = params.update;
    if (update.type === "turn_started") {
      const host = thread.queued.get(update.turnId) ?? thread.pendingStarts.shift();
      thread.queued.delete(update.turnId);
      const id = this.#turnId(thread.thread.id, update.turnId);
      const turn: TurnState = { id, nativeId: update.turnId, threadId: thread.thread.id, hostTag: host?.hostTag, openItems: new Set(), toolNames: new Map(), settled: false };
      this.#turnsByNative.set(update.turnId, turn);
      this.#turnsById.set(id, turn);
      thread.active = turn;
      const envelope = { threadId: thread.thread.id, turnId: id, ...(turn.hostTag === undefined ? {} : { hostTag: turn.hostTag }) };
      this.#emit(
        {
          type: "turn.upsert",
          turn: {
            id,
            threadId: thread.thread.id,
            native: strong(update.turnId),
            origin: "user",
            status: "running",
            ...(host === undefined ? {} : { clientTurnKey: host.clientTurnKey }),
            ...(host?.hostTag === undefined ? {} : { hostTag: host.hostTag }),
          },
        },
        envelope,
      );
      this.#emit({ type: "item.upsert", item: this.#promptItem(id, { turnId: update.turnId, prompt: update.prompt }) }, envelope);
      return;
    }
    const turn = params.turnId === undefined ? undefined : this.#turnsByNative.get(params.turnId);
    if (turn === undefined) return;
    const envelope = { threadId: turn.threadId, turnId: turn.id, ...(turn.hostTag === undefined ? {} : { hostTag: turn.hostTag }) };
    switch (update.type) {
      case "message_delta": {
        const itemId = this.#itemId(turn.id, update.messageId);
        if (!turn.openItems.has(update.messageId)) {
          turn.openItems.add(update.messageId);
          this.#emit({ type: "item.upsert", item: { id: itemId, kind: "assistant_message", native: strong(update.messageId), status: "running", turnId: turn.id } }, envelope);
        }
        this.#emit({ type: "item.delta", itemId, field: "text", chunk: update.text }, envelope);
        return;
      }
      case "message_done": {
        const itemId = this.#itemId(turn.id, update.messageId);
        const opened = turn.openItems.delete(update.messageId);
        this.#emit(
          {
            type: "item.upsert",
            item: opened
              ? { id: itemId, status: "completed", text: update.text }
              : { id: itemId, kind: "assistant_message", native: strong(update.messageId), status: "completed", turnId: turn.id, text: update.text },
          },
          envelope,
        );
        return;
      }
      case "tool_started": {
        turn.openItems.add(update.toolCallId);
        turn.toolNames.set(update.toolCallId, { name: update.name, input: update.input });
        this.#emit(
          {
            type: "item.upsert",
            item: {
              id: this.#itemId(turn.id, update.toolCallId),
              kind: "tool_call",
              native: strong(update.toolCallId),
              status: "running",
              turnId: turn.id,
              tool: { name: update.name, input: update.input },
              ...(update.path === undefined ? {} : { paths: [update.path] }),
            },
          },
          envelope,
        );
        return;
      }
      case "tool_done": {
        turn.openItems.delete(update.toolCallId);
        const limit = this.#input.payloadLimits?.maxToolOutputBytes;
        const output = limit === undefined ? { text: update.output, truncated: false } : truncateUtf8(update.output, limit);
        const tool = turn.toolNames.get(update.toolCallId) ?? { name: "tool", input: undefined };
        this.#emit(
          {
            type: "item.upsert",
            item: {
              id: this.#itemId(turn.id, update.toolCallId),
              status: "completed",
              output: output.text,
              tool: { ...tool, result: output.text },
              ...(output.truncated ? { truncated: true } : {}),
            },
          },
          envelope,
        );
        return;
      }
      case "task_started": {
        const id = this.#taskId(turn.threadId, update.taskId);
        this.#tasks.set(id, { nativeId: update.taskId, threadId: turn.threadId, title: update.title, status: "running", turnId: turn.id });
        this.#emitBackground();
        return;
      }
      case "task_finished": {
        const id = this.#taskId(turn.threadId, update.taskId);
        const task = this.#tasks.get(id);
        if (task !== undefined) task.status = update.status;
        this.#emitBackground();
        return;
      }
      case "subagent_started": {
        const id = deriveId({ kind: "subagent", native: strong(update.subagentId), identityVersion: IDENTITY_VERSION, scope: turn.threadId });
        this.#subagents.set(id, { nativeId: update.subagentId, threadId: turn.threadId });
        this.#emit(
          { type: "subagent.upsert", subagent: { id, native: strong(update.subagentId), parentThreadId: turn.threadId, parentTurnId: turn.id, status: "running", name: update.name } },
          envelope,
        );
        return;
      }
      case "subagent_finished": {
        const id = deriveId({ kind: "subagent", native: strong(update.subagentId), identityVersion: IDENTITY_VERSION, scope: turn.threadId });
        this.#emit({ type: "subagent.upsert", subagent: { id, status: update.status } }, { threadId: turn.threadId });
        return;
      }
      case "turn_ended": {
        if (update.stopReason === "end_turn") this.#settle(turn, "completed");
        else if (update.stopReason === "cancelled") this.#settle(turn, "interrupted");
        else {
          const error = update.error;
          const failure =
            error?.kind === "usage_limit"
              ? { class: "usage_limit", message: error.message, retryable: true, ...(error.resetAt === undefined ? {} : { resetAt: error.resetAt }) }
              : { class: "provider_error", message: error?.message ?? "The agent failed the turn.", retryable: true };
          this.#settle(turn, "failed", failure);
        }
        return;
      }
      default:
        return;
    }
  }

  #emitBackground(): void {
    const tasks = [...this.#tasks.entries()]
      .filter(([, task]) => task.status === "running")
      .map(([id, task]): BackgroundTaskSummary => ({ id, kind: "terminal", status: task.status, title: task.title, threadId: task.threadId, turnId: task.turnId }));
    this.#emit({ type: "background.updated", tasks });
  }

  /** Ends a turn: settles what it left open, then emits its status and its one `turn.terminal`. */
  #settle(turn: TurnState, status: "completed" | "interrupted" | "failed", failure?: { class: string; message: string; retryable: boolean; resetAt?: string }, disposition: "reusable" | "broken" = "reusable"): void {
    const thread = this.#threads.get(turn.threadId);
    if (thread?.active === turn) thread.active = undefined;
    if (turn.settled) return;
    turn.settled = true;
    const envelope = { threadId: turn.threadId, turnId: turn.id, ...(turn.hostTag === undefined ? {} : { hostTag: turn.hostTag }) };
    for (const nativeItemId of turn.openItems) {
      this.#emit({ type: "item.upsert", item: { id: this.#itemId(turn.id, nativeItemId), status: status === "completed" ? "completed" : status } }, envelope);
    }
    turn.openItems.clear();
    for (const pending of this.#requests.values()) {
      if (pending.turnId !== turn.id || pending.resolved) continue;
      pending.resolved = true;
      pending.abandon();
      this.#emit({ type: "request.upsert", request: { id: pending.request.id, status: "cancelled" } }, envelope);
    }
    this.#emit({ type: "turn.upsert", turn: { id: turn.id, status, ...(failure === undefined ? {} : { failure }) } }, envelope);
    this.#emit({ type: "turn.terminal", turnId: turn.id, status, ...(failure === undefined ? {} : { failure }), threadDisposition: disposition }, envelope);
  }

  #onPermission(native: ReferencePermissionRequest, signal: AbortSignal): Promise<{ optionId: string }> {
    const threadId = this.#threadsByNative.get(native.sessionId);
    const thread = threadId === undefined ? undefined : this.#threads.get(threadId);
    const turn = this.#turnsByNative.get(native.turnId);
    if (thread === undefined || turn === undefined || turn.settled) return Promise.reject(new JsonRpcError(REFERENCE_ERRORS.notFound, "no such turn"));
    const options: RequestOption[] = native.options.map((option) => ({ optionId: option.optionId, label: option.name, ...OPTION_MEANING[option.kind] }));
    const request: Request = {
      id: deriveId({ kind: "request", native: strong(native.permissionId), identityVersion: IDENTITY_VERSION, scope: thread.thread.id }),
      native: strong(native.permissionId),
      kind: native.kind,
      origin: { threadId: thread.thread.id, turnId: turn.id },
      subject: {
        cwd: thread.thread.cwd,
        ...(native.command === undefined ? {} : { command: [...native.command] }),
        ...(native.path === undefined ? {} : { paths: [native.path] }),
      },
      options,
      allowCustomAnswer: false,
      allowFeedback: false,
      response: { mode: "live" },
      survivesRestart: false,
      status: "pending",
    };
    const envelope = { threadId: thread.thread.id, turnId: turn.id, ...(turn.hostTag === undefined ? {} : { hostTag: turn.hostTag }) };

    // Under full_access this driver may answer itself, and then only with the narrowest accepting option.
    if (thread.policy.mode === "full_access" && this.#config.fullAccessReplies === "driver") {
      const narrowest = options
        .filter((option) => option.decision === "accept" || option.decision === "accept_for_session" || option.decision === "accept_always")
        .sort((a, b) => (SCOPE_RANK[a.scope ?? "global"] ?? 4) - (SCOPE_RANK[b.scope ?? "global"] ?? 4))[0];
      if (narrowest !== undefined) {
        this.#emit({ type: "request.upsert", request: { ...request, status: "resolved" } }, envelope);
        return Promise.resolve({ optionId: narrowest.optionId });
      }
    }

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        request,
        turnId: turn.id,
        reply: (optionId) => resolve({ optionId }),
        abandon: () => reject(new JsonRpcError(REFERENCE_ERRORS.notFound, "the request was abandoned")),
        inFlight: undefined,
        resolved: false,
      };
      this.#requests.set(request.id, pending);
      signal.addEventListener("abort", () => pending.abandon(), { once: true });
      this.#emit({ type: "request.upsert", request }, envelope);
    });
  }

  #onExit(connection: AgentConnection, code: number | null, signal: string | null, byDriver: boolean): void {
    void connection;
    if (byDriver) return;
    this.#connection = undefined;
    const message = `The reference agent exited (${code === null ? `signal ${String(signal)}` : `code ${code}`}).`;
    for (const thread of this.#threads.values()) {
      const active = thread.active;
      if (active !== undefined) this.#settle(active, "failed", { class: "transport_error", message, retryable: true }, "broken");
      thread.queued.clear();
      thread.pendingStarts.length = 0;
    }
    this.#emit({ type: "notice", level: "error", code: "agent_exited", text: message });
  }
}

class ReferenceInstance implements Instance {
  readonly id: string;
  readonly continuationKey = "reference";
  readonly bindingKey: string;
  readonly #host: HostServices<ReferenceDriverConfig>;
  readonly #config: ReferenceDriverConfig;
  readonly #sessions = new Set<ReferenceSession>();
  /** When each scope's runtime auth poison ends, in milliseconds since the epoch. */
  readonly #poison = new Map<string, number>();
  #sessionCount = 0;
  #flows = 0;
  auth?: Instance["auth"];

  constructor(host: HostServices<ReferenceDriverConfig>, config: ReferenceDriverConfig, instanceId: string) {
    this.id = instanceId;
    this.#host = host;
    this.#config = config;
    this.bindingKey = `reference:${config.command}:${config.profile}`;
    if (config.profile === "full") this.auth = this.#authGroup();
  }

  catalog = {
    list: async () => ({ models: MODELS.map((model) => ({ ...model })), defaultModelId: MODELS[0]!.id }),
  };

  async status(): Promise<InstanceStatus> {
    const probe = await this.probe();
    if (!probe.installed) return { state: "unavailable", installed: false, ...(probe.error === undefined ? {} : { error: probe.error }) };
    const auth = await this.auth?.state();
    return { state: "ready", installed: true, ...(probe.version === undefined ? {} : { version: probe.version }), ...(auth === undefined ? {} : { auth }) };
  }

  async *statusChanges(): AsyncGenerator<InstanceStatus, void, undefined> {
    yield await this.status();
  }

  /** Runs only `reference-agent --version`, and `--auth-status` when deep. Nothing else. */
  async probe(options?: { deep?: boolean }): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    const path = await this.#host.process.resolveExecutable(this.#config.command);
    if (path === null) {
      return { ok: false, installed: false, error: callErrors.driverUnavailable({ binary: this.#config.command }).callError, checkedAt };
    }
    const version = await runOnce(this.#host, this.#config.command, ["--version"]);
    const found = /reference-agent (\S+)/.exec(version.stdout)?.[1];
    const result: ProbeResult = { ok: version.code === 0, installed: true, ...(found === undefined ? {} : { version: found }), checkedAt };
    if (options?.deep === true && this.auth !== undefined) return { ...result, auth: await this.#baseState() };
    return result;
  }

  async openSession(input: OpenSessionInput): Promise<Session> {
    if (this.auth !== undefined) {
      const state = await this.auth.state();
      if (state.status === "unauthenticated") throw callErrors.authRequired(AUTH_METHODS, "Sign in to the reference agent first");
    }
    this.#sessionCount += 1;
    const id = deriveId({ kind: "session", native: { id: null, strength: "none", ordinal: this.#sessionCount }, identityVersion: IDENTITY_VERSION, scope: this.id });
    const session = new ReferenceSession(this.#host, this.#config, input, id);
    session.attachOptionalGroups();
    await session.open();
    this.#sessions.add(session);
    return session;
  }

  async dispose(): Promise<void> {
    for (const session of this.#sessions) await session.close();
    this.#sessions.clear();
  }

  /** The verdict before any runtime poison: a stored key is configured; otherwise the ambient account's check. */
  async #baseState(): Promise<AuthState> {
    const key = await this.#host.secrets.get(SECRET_NAMESPACE, SECRET_KEY);
    if (key !== null) return { status: "configured", evidence: "passive", scope: "managed_profile" };
    let check: { code: number | null; stdout: string };
    try {
      check = await runOnce(this.#host, this.#config.command, ["--auth-status"]);
    } catch {
      return { status: "unavailable", evidence: "active", scope: "ambient" };
    }
    if (check.code !== 0) return { status: "unavailable", evidence: "active", scope: "ambient" };
    let answer: { status?: string; account?: { email?: string } };
    try {
      answer = JSON.parse(check.stdout) as typeof answer;
    } catch {
      return { status: "unavailable", evidence: "active", scope: "ambient" };
    }
    if (answer.status === "signed_in") return { status: "authenticated", evidence: "active", scope: "ambient", ...(answer.account?.email === undefined ? {} : { account: { email: answer.account.email } }) };
    if (answer.status === "signed_out") return { status: "unauthenticated", evidence: "active", scope: "ambient" };
    return { status: "unknown", evidence: "passive", scope: "ambient" };
  }

  async #state(): Promise<AuthState> {
    const base = await this.#baseState();
    const until = this.#poison.get(base.scope);
    if (until === undefined || until <= Date.now()) return base;
    return { status: "unauthenticated", evidence: "runtime_poison", scope: base.scope, poisonExpiresAt: new Date(until).toISOString() };
  }

  #authGroup(): NonNullable<Instance["auth"]> {
    return {
      methods: () => AUTH_METHODS.map((method) => ({ ...method })),
      state: () => this.#state(),
      reportRuntimeFailure: async () => {
        const base = await this.#baseState();
        this.#poison.set(base.scope, Date.now() + REFERENCE_POISON_MS);
        return this.#state();
      },
      start: async (input) => {
        if (input.methodId !== "api-key") throw callErrors.notFound({ resource: "auth method", id: input.methodId });
        this.#flows += 1;
        return { flowId: `flow-${this.#flows}`, methodId: input.methodId, fields: AUTH_METHODS[0]!.fields ?? [] };
      },
      respond: async (input) => {
        const apiKey = input.values["apiKey"];
        if (apiKey === undefined || apiKey === "") throw callErrors.validation([{ message: "apiKey is required", path: ["values", "apiKey"] }]);
        await this.#host.secrets.set(SECRET_NAMESPACE, SECRET_KEY, new TextEncoder().encode(apiKey));
        return this.#state();
      },
      complete: async () => {
        throw callErrors.invalidState("no_callback_flow", "API key sign-in has no callback");
      },
      cancel: async () => this.#state(),
      logout: async () => {
        await this.#host.secrets.delete(SECRET_NAMESPACE, SECRET_KEY);
      },
    };
  }
}

/** The reference driver. */
export const referenceDriver: Driver<ReferenceDriverConfig> = {
  kind: "reference",
  ariVersion: ARI_VERSION,
  metadata: { displayName: "Reference agent", docsUrl: "https://ari.invalid/docs/conformance", multipleInstances: true, hasDefaultInstance: false },
  configSchema: REFERENCE_CONFIG_SCHEMA,
  defaultConfig: () => ({ command: "reference-agent", profile: "full", fullAccessReplies: "driver" }),
  cliManifest: REFERENCE_CLI_MANIFEST,
  async create(host, input) {
    return new ReferenceInstance(host, input.config, input.instanceId);
  },
};
