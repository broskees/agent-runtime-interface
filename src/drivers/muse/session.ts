// One ARI session over Muse. Each thread is one Muse session in its own
// `muse serve` host (process per thread): the host's sandbox flag is fixed at
// launch and follows the thread's runtime mode, and a host that dies takes
// only its own thread's turn with it.
//
// Rules this file keeps (each is a Muse quirk a naive driver gets wrong):
//
// - A turn settles only on Muse's `turn/completed` (or `turn/unqueued` for a
//   queued turn taken back), or when its host exits. No timer settles a turn.
// - The driver mints the session id and every turn id through the SDK
//   connection's single minter (`mintCommandId`): a fresh turn's id is the
//   `commandId` of its `turn/start`. So the ARI thread id is known before
//   `session/start`, and the host's per-thread tool server
//   (`hostTools.mcpServerFor`) goes into `session/start` and `session/resume`
//   as a per-session MCP server under the name the host chose. The driver
//   writes no file.
// - A steer names the turn it means (`expectedTurnId`). Muse refuses a steer
//   whose turn already ended (`commandRejected`, reason `already_terminal`);
//   the host then gets `prompt_required`. A steer the busy session runtime
//   refuses (`runtime_busy`) wrote nothing, so it goes out again under its
//   first `commandId` until Muse takes it or the turn ends, as the SDK's own
//   `Session.run` resends a busy unqueue, for at most `MUSE_BUSY_LIMIT_MS`.
//   Any other refusal is an error. The SDK puts no deadline on an answer, so
//   every wait for one also ends at the turn's end.
// - Approval choices carry Muse's own `choiceId`, which is the native option
//   id; `approval/decide` sends it with the approval's current requirement.
// - Approvals and questions arrive both as view notifications
//   (`approval/requested`, `userInput/requested`) and, for a client that
//   must answer, as server requests (`approval/request`, `userInput/request`);
//   after a resume only the server request comes, right after the
//   `session/resume` answer, for the running turn the answer names. The driver
//   keeps one request per approval id or user-input id and answers each server
//   request with the empty presentation receipt.
// - Muse records no terminal per stored turn; `session/read` and
//   `session/resume` restate only the last one (`lastTurn`). A turn is
//   reported failed from that, or from the `turn/completed` this session saw.
// - A `LaunchContext` given to `resumeThread` replaces the thread's: its
//   instructions go before the next turn's text, and new MCP servers reload
//   the session on a new host (refused while a turn or request is open).
// - Host instructions (`launch` and `context`) reach Muse through the
//   `first_user_message` channel: a text part before the host's own text, with
//   the host's own text as `displayText`.

import { callErrors } from "../../errors.ts";
import { EventSequencer } from "../../driver-kit/sequencer.ts";
import type { Capabilities } from "../../generated/capabilities.ts";
import type { ContentBlock } from "../../generated/common.ts";
import type { ConfigChangePlan, RuntimePolicy } from "../../generated/config.ts";
import type { Failure } from "../../generated/errors.ts";
import type { AriEvent, AriEventBody } from "../../generated/events.ts";
import type { SpawnRequest } from "../../generated/host.ts";
import type { OpenSessionInput } from "../../generated/instance.ts";
import type { Item } from "../../generated/item.ts";
import type { PlanEntry } from "../../generated/plan.ts";
import type { Request } from "../../generated/request.ts";
import type {
  AppliedThread,
  CreateThreadInput,
  InterruptTurnInput,
  LaunchContext,
  PlanConfigChangeInput,
  RespondInput,
  RespondResult,
  ResumeThreadInput,
  StartTurnInput,
  StartTurnResult,
} from "../../generated/session.ts";
import type { Subagent } from "../../generated/subagent.ts";
import type { Thread, ThreadSnapshot, Turn } from "../../generated/thread.ts";
import type { LimitStatus, UsageSnapshot } from "../../generated/usage.ts";
import type { HostServices, Session } from "../../runtime.ts";
import { MuseHost, callErrorFromMuse } from "./host.ts";
import {
  MUSE_SUPPORTED_MODES,
  approvalKind,
  approvalSubject,
  choiceOption,
  deltaField,
  failureFromMuse,
  itemFromMuse,
  itemIdFor,
  limitsFromMuse,
  musePolicy,
  planIdFor,
  questionsFromMuse,
  requestIdFor,
  strongRef,
  subagentIdFor,
  threadIdFor,
  turnIdFor,
  usageFromMuse,
} from "./mapping.ts";
import type { MusePolicy } from "./mapping.ts";
import type {
  MuseApprovalRequest,
  MuseApprovalUpdated,
  MuseInputPart,
  MuseItem,
  MuseLastTurn,
  MuseMcpServerConfig,
  MuseModelEntry,
  MuseNotifications,
  MuseReasoningEffort,
  MuseSdk,
  MuseSessionConfig,
  MuseTurnCompleted,
  MuseTurnStartParams,
  MuseUserInputAnswer,
  MuseUserInputRequest,
  MuseWireNotification,
  MuseWireRequest,
} from "./sdk.ts";

/** What a session needs from its instance. */
export interface MuseSessionRuntime {
  readonly host: HostServices<unknown>;
  readonly sdk: MuseSdk;
  readonly capabilities: Capabilities;
  readonly binaryPath: string;
  readonly extraArgs: readonly string[];
  readonly defaultModel?: string;
  readonly providerId?: string;
  readonly defaultEffort?: string;
  /** The environment additions for every `muse serve`: the managed key, when the instance has one. */
  environment(): Promise<{ [name: string]: string }>;
  /** The SDK connection's command id minter; undefined uses the SDK's own UUIDv7 minter. */
  readonly mintCommandId?: () => string;
  /** Muse reported new subscription usage. */
  onLimits(limits: LimitStatus): void;
  /** Muse reported a model catalog (`model/list`). */
  onModels(models: readonly MuseModelEntry[]): void;
  contextWindow(model: string): number | undefined;
}


interface TurnState {
  readonly id: string;
  readonly nativeId: string;
  readonly threadId: string;
  readonly origin: "user" | "provider_initiated";
  readonly clientTurnKey: string | undefined;
  readonly hostTag: string | undefined;
  /** `unseen`: not announced yet; `pending`: announced as queued; `running`: started. */
  phase: "unseen" | "pending" | "running";
  settled: boolean;
  /** How the turn ended, once it settled. */
  outcome: { readonly status: Turn["status"]; readonly failure?: Failure } | undefined;
  /** The `commandId`s of the steers Muse took into the turn: its steered user messages carry them. */
  readonly steers: Set<string>;
  interruptRequested: boolean;
  usage: UsageSnapshot | undefined;
  readonly openItems: Set<string>;
  readonly done: Promise<void>;
  readonly finish: () => void;
}

interface ItemRecord {
  readonly ariId: string;
  /** The Muse item kind. */
  readonly kind: string;
  /** The ARI kind the item opened with; it never changes. */
  readonly ariKind: string;
  revision: number;
  open: boolean;
  readonly turnId: string | undefined;
}

interface ThreadState {
  thread: Thread;
  readonly nativeId: string;
  /** What the thread's host runs with; each resume replaces them, and an automatic resume reads them. */
  cwd: string;
  policy: RuntimePolicy;
  muse: MusePolicy;
  launch: LaunchContext | undefined;
  model: string | undefined;
  /** Host instructions not yet sent: they go before the host's text in the next turn. */
  instructions: string | undefined;
  host: MuseHost | undefined;
  loading: Promise<MuseHost> | undefined;
  /** The host unloaded it; only `resumeThread` brings it back. */
  unloaded: boolean;
  active: TurnState | undefined;
  readonly queued: Map<string, TurnState>;
  readonly items: Map<string, ItemRecord>;
}

interface PendingRequest {
  request: Request;
  readonly threadId: string;
  readonly turnId: string | undefined;
  native: { readonly type: "approval"; value: MuseApprovalRequest } | { readonly type: "userInput"; value: MuseUserInputRequest };
  resolved: boolean;
  inFlight: string | undefined;
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinInstructions(parts: ReadonlyArray<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined && part.trim() !== "");
  return present.length === 0 ? undefined : present.join("\n\n");
}

function launchInstructions(launch: LaunchContext | undefined, context: { system?: string; developer?: string } | undefined): string | undefined {
  return joinInstructions([...(launch?.appendSystemPrompt ?? []), ...(launch?.developerPrompt ?? []), context?.system, context?.developer]);
}

/** Muse's per-session MCP servers for the host's launch servers and its per-thread tool server, under the host's names. */
export function museMcpServers(servers: ReadonlyArray<{ name: string; transport: string; command?: string; args?: string[]; env?: { [key: string]: string }; cwd?: string; url?: string; headers?: { [key: string]: string } }>): {
  [name: string]: MuseMcpServerConfig;
} {
  const config: { [name: string]: MuseMcpServerConfig } = {};
  for (const server of servers) {
    if (server.transport === "stdio") {
      if (server.command === undefined) throw callErrors.validation([{ message: `MCP server ${server.name} has no command`, path: ["mcpServers"] }]);
      if (server.cwd !== undefined) throw callErrors.validation([{ message: `MCP server ${server.name}: Muse's per-session stdio servers take no working directory`, path: ["mcpServers"] }]);
      config[server.name] = {
        transport: "stdio",
        command: server.command,
        ...(server.args === undefined ? {} : { args: [...server.args] }),
        ...(server.env === undefined ? {} : { env: { ...server.env } }),
      };
    } else if (server.transport === "http") {
      if (server.url === undefined) throw callErrors.validation([{ message: `MCP server ${server.name} has no url`, path: ["mcpServers"] }]);
      config[server.name] = { transport: "streamableHttp", url: server.url, ...(server.headers === undefined ? {} : { headers: { ...server.headers } }) };
    } else {
      throw callErrors.unsupported(`mcp.acceptsHostServers.${server.transport}`, `Muse does not accept ${server.transport} MCP servers`);
    }
  }
  return config;
}

const TODO_STATUSES: { readonly [status: string]: PlanEntry["status"] } = { pending: "pending", inProgress: "in_progress", completed: "completed", cancelled: "cancelled" };

/**
 * The SDK connection's backoff before it resends a command Muse admitted
 * nothing of (`defaultRetryDelay` in the SDK's dist/src/connection/connection.js,
 * which its package does not export): a random wait under a ceiling that
 * starts at 50 ms and doubles up to 2 s.
 */
function busyDelay(attempt: number): Promise<"slept"> {
  const ceilingMs = Math.min(2_000, 50 * 2 ** Math.max(0, attempt - 1));
  return new Promise((resolve) => setTimeout(() => resolve("slept"), Math.floor(Math.random() * (ceilingMs + 1))));
}

/**
 * How long the driver keeps sending a command again while the busy session
 * runtime refuses it (`runtime_busy`), from the first refusal: 30 s, at least
 * 15 sends at the backoff's 2 s ceiling. After that the call fails with
 * `invalid_state` `runtime_busy`, and the host may try again.
 */
const MUSE_BUSY_LIMIT_MS = 30_000;

/** The busy limit of one command: `reached` resolves `MUSE_BUSY_LIMIT_MS` after the first `start()`, and never before it. */
class BusyLimit {
  readonly reached: Promise<"limit">;
  #reach: (value: "limit") => void = () => undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.reached = new Promise((resolve) => {
      this.#reach = resolve;
    });
  }

  start(): void {
    if (this.#timer === undefined) this.#timer = setTimeout(() => this.#reach("limit"), MUSE_BUSY_LIMIT_MS);
  }

  clear(): void {
    clearTimeout(this.#timer);
  }
}

/** A Muse command's answer as a value: taken, or refused with its error. */
type MuseReply = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

function replyOf(sent: Promise<unknown>): Promise<MuseReply> {
  return sent.then(
    (): MuseReply => ({ ok: true }),
    (error: unknown): MuseReply => ({ ok: false, error }),
  );
}

/** Resolves "ended" once the turn settled (after its `turn.terminal`). The SDK puts no deadline on a command's answer, so every wait for one also races this. */
function ended(turn: TurnState): Promise<"ended"> {
  return turn.done.then(() => "ended" as const);
}

/**
 * How a stored turn that is not running ended: as this session saw it end;
 * else from Muse's `lastTurn`, which restates only the last turn; else
 * completed, because Muse stores no terminal for older turns.
 */
function storedOutcome(nativeTurn: string, lastTurn: MuseLastTurn | undefined, seen: TurnState | undefined): { status: Turn["status"]; failure?: Failure } {
  if (seen?.outcome !== undefined) return seen.outcome;
  if (lastTurn === undefined || lastTurn.turnId !== nativeTurn || lastTurn.terminal === "completed") return { status: "completed" };
  if (lastTurn.terminal === "cancelled") return { status: "cancelled" };
  return { status: "failed", failure: failureFromMuse(lastTurn) };
}

export class MuseSession implements Session {
  readonly id: string;
  readonly #runtime: MuseSessionRuntime;
  readonly #input: OpenSessionInput;
  readonly #sequencer: EventSequencer;
  readonly #threads = new Map<string, ThreadState>();
  readonly #threadsByNative = new Map<string, ThreadState>();
  /** Frames of a native session whose thread is still being opened, replayed once it is registered. */
  readonly #opening = new Map<string, MuseWireNotification[]>();
  readonly #turnsByNative = new Map<string, TurnState>();
  readonly #turnsById = new Map<string, TurnState>();
  readonly #requests = new Map<string, PendingRequest>();
  readonly #responses = new Map<string, Promise<RespondResult | void>>();
  readonly #turnKeys = new Map<string, Promise<StartTurnResult>>();
  readonly #subagents = new Map<string, Subagent>();
  #modelsRead = false;
  #closed = false;

  constructor(runtime: MuseSessionRuntime, input: OpenSessionInput, id: string) {
    this.id = id;
    this.#runtime = runtime;
    this.#input = input;
    this.#sequencer = new EventSequencer({ sessionId: id });
  }

  /** Announces the session. Muse hosts start per thread, so nothing runs yet. */
  open(): void {
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
    const muse = this.#policy(input.policy);
    const cwd = await this.#canonical(input.cwd);
    const launch = input.launch ?? this.#input.launch;
    const model = typeof input.config?.["model"] === "string" ? input.config["model"] : this.#runtime.defaultModel;
    const host = await this.#startHost(cwd, muse);
    try {
      const started = await this.#startNative(host, { cwd, policy: { ...input.policy, cwd }, muse, launch, model, instructions: launchInstructions(launch, input.context), ...(input.title === undefined ? {} : { title: input.title }) });
      return started.thread;
    } catch (error) {
      await host.close();
      throw error;
    }
  }

  /** Starts a fresh Muse session on `host` and registers its thread. */
  async #startNative(
    host: MuseHost,
    spec: { cwd: string; policy: RuntimePolicy; muse: MusePolicy; launch: LaunchContext | undefined; model: string | undefined; instructions: string | undefined; title?: string },
  ): Promise<{ thread: AppliedThread; model: string | undefined }> {
    const nativeId = host.mintCommandId();
    const threadId = threadIdFor(nativeId);
    const config = await this.#sessionConfig(host, threadId, spec.launch);
    this.#opening.set(nativeId, []);
    try {
      const started = await host
        .command("session/start", {
          sessionId: nativeId,
          workspaceRoot: spec.cwd,
          approvalMode: spec.muse.approvalMode,
          permissionProfile: spec.muse.permissionProfile,
          ...(spec.model === undefined ? {} : { modelId: spec.model }),
          ...(this.#runtime.providerId === undefined ? {} : { providerId: this.#runtime.providerId }),
          ...(config === undefined ? {} : { config }),
        })
        .catch((error: unknown) => {
          throw callErrorFromMuse(this.#runtime.sdk, error, "session");
        });
      if (started.session.sessionId !== nativeId) throw callErrors.protocol("session identity", `Muse started session ${started.session.sessionId} where the driver asked for ${nativeId}`);
      const model = started.session.modelId ?? spec.model;
      const state = this.#register(nativeId, host, { cwd: spec.cwd, policy: spec.policy, muse: spec.muse, launch: spec.launch, model, instructions: spec.instructions, ...(spec.title === undefined ? {} : { title: spec.title }) });
      void this.#readModels(host, nativeId);
      return { thread: { ...state.thread, ...(model === undefined ? {} : { appliedConfig: { model } }) }, model };
    } finally {
      this.#flushOpening(nativeId);
    }
  }

  async resumeThread(input: ResumeThreadInput): Promise<AppliedThread> {
    this.#open();
    const nativeId = "handle" in input.native ? input.native.handle : input.native.id;
    if (nativeId === null || nativeId === "") throw callErrors.validation([{ message: "resumeThread needs a native id or handle", path: ["native"] }]);
    const known = this.#threadsByNative.get(nativeId);
    if (input.purpose === "history") return this.#readHistory(nativeId, known, input);
    if (known !== undefined && !known.unloaded) {
      // A loaded thread takes the resume's settings, or the resume is refused, as on a turn: Muse switches no runtime mode in a session.
      if (input.policy !== undefined) {
        if (musePolicy(input.policy) === undefined) throw callErrors.unsupported(`runtimePolicy.modes.${input.policy.mode}`);
        if (input.policy.mode !== known.policy.mode) throw callErrors.unsupported("sessions.switchRuntimeMode", `Muse sets a session's permission profile when it loads it; thread ${known.thread.id} runs ${known.policy.mode}`);
      }
      if (input.launch !== undefined) await this.#replaceLaunch(known, input.launch);
      const host = await this.#ensureHost(known);
      const model = typeof input.config?.["model"] === "string" ? input.config["model"] : undefined;
      if (model !== undefined && model !== known.model) {
        await host.command("session/setModel", { sessionId: known.nativeId, model: { modelId: model, ...(this.#runtime.providerId === undefined ? {} : { providerId: this.#runtime.providerId }) } }).catch((error: unknown) => {
          throw callErrorFromMuse(this.#runtime.sdk, error, "model");
        });
        known.model = model;
      }
      if (input.policy !== undefined) known.policy = { ...input.policy, cwd: known.cwd };
      return { ...known.thread, ...(known.model === undefined ? {} : { appliedConfig: { model: known.model } }) };
    }
    const policyInput = input.policy ?? known?.policy;
    if (policyInput === undefined) throw callErrors.validation([{ message: `resumeThread of ${nativeId} needs policy.cwd: this session has not seen the thread`, path: ["policy"] }]);
    const muse = this.#policy(policyInput);
    const cwd = await this.#canonical(policyInput.cwd === "" && known !== undefined ? known.cwd : policyInput.cwd);
    const launch = input.launch ?? known?.launch ?? this.#input.launch;
    const instructions = launchInstructions(launch, undefined);
    const model = typeof input.config?.["model"] === "string" ? input.config["model"] : (known?.model ?? this.#runtime.defaultModel);
    const host = await this.#startHost(cwd, muse);
    try {
      const resumed = await this.#resumeNative(host, nativeId, muse, launch, model, input.quiet === true, { cwd, policy: { ...policyInput, cwd }, instructions });
      return resumed;
    } catch (error) {
      const kind = host.errorKind(error);
      const locked = kind === "sessionInUse";
      const missing = kind === "sessionNotFound" || kind === "notFound";
      if ((!locked && !missing) || input.policy === undefined || host.exited) {
        await host.close();
        throw callErrorFromMuse(this.#runtime.sdk, error, "native session");
      }
      // Fall back to a fresh Muse session with the failed resume's launch context, and say so: the old context is gone.
      try {
        const fresh = await this.#startNative(host, { cwd, policy: { ...policyInput, cwd }, muse, launch, model, instructions });
        this.#emit(
          {
            type: "session.replaced",
            previousNativeId: nativeId,
            reason: locked ? "Another Muse host holds the session's lease." : "Muse has no stored session with that id.",
            contextLost: true,
            showRuntimeNote: true,
          },
          { threadId: fresh.thread.id },
        );
        return fresh.thread;
      } catch (fallback) {
        await host.close();
        throw fallback;
      }
    }
  }

  /**
   * A `purpose: "history"` resume: a short-lived host checks the stored
   * session with `session/read`, which takes no lease and loads nothing, so
   * no writer starts and no MCP server reaches Muse. A session Muse does not
   * have is `not_found`, never replaced. Nothing is replayed as events; the
   * thread stays unloaded and `readSnapshot` reads it. A thread the session
   * holds is reported as it is.
   */
  async #readHistory(nativeId: string, known: ThreadState | undefined, input: ResumeThreadInput): Promise<AppliedThread> {
    if (known !== undefined) return known.thread;
    const policyInput = input.policy;
    if (policyInput === undefined) throw callErrors.validation([{ message: `resumeThread of ${nativeId} needs policy.cwd: this session has not seen the thread`, path: ["policy"] }]);
    const muse = this.#policy(policyInput);
    const cwd = await this.#canonical(policyInput.cwd);
    const host = await this.#startHost(cwd, muse);
    try {
      const read = await host.request("session/read", { sessionId: nativeId, excludeItems: true }).catch((error: unknown) => {
        throw callErrorFromMuse(this.#runtime.sdk, error, "native session");
      });
      const launch = input.launch ?? this.#input.launch;
      const root = read.session.workspaceRoot ?? cwd;
      const state = this.#register(nativeId, host, { cwd: root, policy: { ...policyInput, cwd: root }, muse, launch, model: read.session.modelId ?? undefined, instructions: launchInstructions(launch, undefined) });
      state.host = undefined;
      state.unloaded = true;
      state.thread = { ...state.thread, status: "unloaded" };
      this.#emit({ type: "thread.upsert", thread: { id: state.thread.id, status: "unloaded" } }, { threadId: state.thread.id });
      return { ...state.thread, ...(state.model === undefined ? {} : { appliedConfig: { model: state.model } }) };
    } finally {
      await host.close();
    }
  }

  /**
   * Gives a loaded thread a new LaunchContext. Its instructions go before the
   * next turn's text. Muse takes per-session MCP servers only when it loads a
   * session, so new servers park the host and the next load (`#ensureHost`)
   * sends them; while a turn or request is open that would end it, so the
   * change is refused and nothing is kept.
   */
  async #replaceLaunch(thread: ThreadState, launch: LaunchContext): Promise<void> {
    const servers = (context: LaunchContext | undefined): string => JSON.stringify(museMcpServers(context?.mcpServers ?? []));
    const newServers = servers(launch) !== servers(thread.launch);
    if (newServers && (thread.active !== undefined || thread.queued.size > 0)) throw callErrors.invalidState("previous_turn_active", "Muse takes new MCP servers only when it loads the session, and a turn is still running on this thread");
    if (newServers && this.#pendingFor(thread)) throw callErrors.invalidState("requests_pending", "Muse takes new MCP servers only when it loads the session, and a request on this thread is still pending");
    const instructions = launchInstructions(launch, undefined);
    if (instructions !== launchInstructions(thread.launch, undefined)) thread.instructions = instructions;
    thread.launch = launch;
    if (newServers) await this.#park(thread);
  }

  /** Loads a stored Muse session on `host` (`session/resume`), registers its thread and replays its history unless quiet. */
  async #resumeNative(
    host: MuseHost,
    nativeId: string,
    muse: MusePolicy,
    launch: LaunchContext | undefined,
    model: string | undefined,
    quiet: boolean,
    spec: { cwd: string; policy: RuntimePolicy; instructions: string | undefined },
  ): Promise<AppliedThread> {
    const threadId = threadIdFor(nativeId);
    const config = await this.#sessionConfig(host, threadId, launch);
    this.#opening.set(nativeId, []);
    try {
      const resumed = await host.command("session/resume", {
        sessionId: nativeId,
        excludeItems: quiet,
        permissionProfile: muse.permissionProfile,
        ...(model === undefined ? {} : { modelId: model }),
        ...(config === undefined ? {} : { config }),
      });
      await host.command("session/setApprovalMode", { sessionId: nativeId, mode: muse.approvalMode }).catch((error: unknown) => {
        throw callErrorFromMuse(this.#runtime.sdk, error, "session");
      });
      const cwd = resumed.session.workspaceRoot ?? spec.cwd;
      const state = this.#register(nativeId, host, { cwd, policy: { ...spec.policy, cwd }, muse, launch, model: resumed.session.modelId ?? model, instructions: spec.instructions });
      if (!quiet) this.#replay(state, resumed.history.items ?? resumed.history.snapshot?.state.items ?? [], resumed.session.activeTurnId, resumed.lastTurn);
      // The turn Muse still runs, history or not: its open requests come again right after this answer (`pendingRequests`), and they belong to it.
      const activeTurnId = resumed.session.activeTurnId;
      if (activeTurnId !== null) {
        const turn = this.#turnsByNative.get(activeTurnId) ?? this.#newTurn(state, activeTurnId, "user", undefined, undefined);
        if (!turn.settled) this.#begin(turn);
      }
      void this.#readModels(host, nativeId);
      const applied = state.model ?? model;
      return { ...state.thread, ...(applied === undefined ? {} : { appliedConfig: { model: applied } }) };
    } finally {
      this.#flushOpening(nativeId);
    }
  }

  async readSnapshot(threadId: string): Promise<ThreadSnapshot> {
    this.#open();
    const thread = this.#thread(threadId);
    // `session/read` takes no lease and loads nothing, so an unloaded thread is read through a short-lived host.
    const borrowed = thread.host === undefined || thread.host.exited;
    const host = borrowed ? await this.#startHost(thread.cwd, thread.muse) : thread.host!;
    try {
      const read = await host.request("session/read", { sessionId: thread.nativeId, excludeItems: false }).catch((error: unknown) => {
        throw callErrorFromMuse(this.#runtime.sdk, error, "native session");
      });
      const items = read.history.items ?? read.history.snapshot?.state.items ?? [];
      const turns: Turn[] = [];
      const seen = new Set<string>();
      const mapped: Item[] = [];
      for (const item of items) {
        const nativeTurn = item.turnId ?? undefined;
        const turnId = nativeTurn === undefined ? undefined : turnIdFor(thread.thread.id, nativeTurn);
        if (nativeTurn !== undefined && turnId !== undefined && !seen.has(nativeTurn)) {
          seen.add(nativeTurn);
          const known = this.#turnsByNative.get(nativeTurn);
          const ended = read.session.activeTurnId === nativeTurn ? undefined : storedOutcome(nativeTurn, read.lastTurn, known);
          turns.push({
            id: turnId,
            threadId: thread.thread.id,
            native: strongRef(nativeTurn),
            origin: known?.origin ?? "user",
            status: ended === undefined ? "running" : ended.status,
            ...(ended?.failure === undefined ? {} : { failure: ended.failure }),
          });
        }
        mapped.push(this.#mapItem(thread, item, turnId));
      }
      const requests = [...this.#requests.values()].filter((pending) => pending.threadId === thread.thread.id && !pending.resolved).map((pending) => pending.request);
      const subagents = [...this.#subagents.values()].filter((subagent) => subagent.parentThreadId === thread.thread.id);
      return { thread: thread.thread, turns, items: mapped, requests, ...(subagents.length === 0 ? {} : { subagents }) };
    } finally {
      if (borrowed) await host.close();
    }
  }

  /** Muse's `session/fork` cuts only at a running turn's boundary; the driver offers no fork (docs/drivers/muse.md). */
  async forkThread(): Promise<Thread> {
    throw callErrors.unsupported("threads.fork", "The Muse driver does not fork threads");
  }

  /** MSP has no conversation rollback. */
  async rollbackThread(): Promise<ThreadSnapshot> {
    throw callErrors.unsupported("threads.rollback", "Muse cannot roll back a conversation");
  }

  async compactThread(threadId: string): Promise<void> {
    this.#open();
    const thread = this.#thread(threadId);
    const host = await this.#ensureHost(thread);
    const result = await host.command("session/compact", { sessionId: thread.nativeId }).catch((error: unknown) => {
      throw callErrorFromMuse(this.#runtime.sdk, error, "session");
    });
    if (result.status === "noop") throw callErrors.invalidState(result.reason ?? "noop", `Muse had nothing to compact${result.reason === undefined ? "" : ` (${result.reason})`}`);
  }

  async unloadThread(threadId: string): Promise<void> {
    this.#open();
    const thread = this.#thread(threadId);
    if (thread.active !== undefined || thread.queued.size > 0) throw callErrors.invalidState("previous_turn_active", "A turn is still running on this thread");
    if (this.#pendingFor(thread)) throw callErrors.invalidState("requests_pending", "A request on this thread is still pending");
    await this.#park(thread);
    thread.unloaded = true;
    thread.thread = { ...thread.thread, status: "unloaded" };
    this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id, status: "unloaded" } }, { threadId: thread.thread.id });
  }

  // Parking.

  canRelease(): boolean {
    if (this.#closed) return false;
    for (const thread of this.#threads.values()) {
      if (thread.active !== undefined || thread.queued.size > 0 || thread.loading !== undefined) return false;
      if (this.#pendingFor(thread)) return false;
    }
    return true;
  }

  async release(): Promise<void> {
    this.#open();
    if (!this.canRelease()) throw callErrors.invalidState("release_vetoed", "Turns or requests are still running");
    // Each thread's host drains and exits; its next turn loads the session again.
    for (const thread of this.#threads.values()) await this.#park(thread);
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
    if (input.intent !== "start" && input.intent !== "steer" && input.intent !== "queue") return { status: "unsupported", capability: `turns.${input.intent}` };
    if (input.policy !== undefined) {
      if (musePolicy(input.policy) === undefined) return { status: "unsupported", capability: `runtimePolicy.modes.${input.policy.mode}` };
      if (input.policy.mode !== thread.policy.mode) return { status: "unsupported", capability: "sessions.switchRuntimeMode" };
    }
    // Any effort the host names goes to Muse in turn/start, which takes or refuses it.
    const effort = typeof input.config?.["reasoningEffort"] === "string" ? input.config["reasoningEffort"] : this.#runtime.defaultEffort;
    const turnInstructions = joinInstructions([input.context?.system, input.context?.developer]);

    if (input.intent === "steer") {
      const active = thread.active;
      if (active === undefined || active.settled || (input.expectedTurnId !== undefined && input.expectedTurnId !== active.id)) return { status: "prompt_required" };
      const host = thread.host;
      if (host === undefined || host.exited) return { status: "prompt_required" };
      const parts = await this.#inputParts(input.content, turnInstructions);
      const steered: StartTurnResult = { status: "accepted", turnId: active.id, accepted: "steered" };
      // One commandId for every send: a busy refusal wrote nothing, so the resend is the same command.
      const commandId = host.mintCommandId();
      const params = { sessionId: thread.nativeId, expectedTurnId: active.nativeId, input: parts };
      const limit = new BusyLimit();
      try {
        for (let attempt = 1; ; attempt += 1) {
          const reply = replyOf(host.command("turn/steer", params, commandId));
          const answered = await Promise.race([reply, ended(active), limit.reached]);
          if (answered === "ended" || answered === "limit") {
            // No answer yet. Muse's steered message, which it writes after the answer, still shows it took the steer.
            if (active.steers.has(commandId)) return steered;
            this.#noticeLateSteer(reply, active);
            if (answered === "ended") return { status: "prompt_required" };
            throw callErrors.invalidState("runtime_busy", `Muse's session runtime stayed busy for ${MUSE_BUSY_LIMIT_MS / 1000} s and did not take the steer`);
          }
          if (answered.ok) return steered;
          const data = host.errorKind(answered.error) === "commandRejected" ? host.errorData(answered.error) : {};
          // The turn already ended (Muse says so, or this session saw it end): the host must start a new turn.
          if (data["reason"] === "already_terminal" || active.settled) return { status: "prompt_required" };
          // Only the busy session runtime's refusal is resent; any other refusal is the host's to see.
          if (data["reason"] !== "runtime_busy" || data["retryable"] === false || host.exited) throw callErrorFromMuse(this.#runtime.sdk, answered.error, "turn");
          limit.start();
          const waited = await Promise.race([busyDelay(attempt), ended(active), limit.reached]);
          // The turn ended while Muse was busy: the steer was never taken.
          if (active.settled || host.exited) return { status: "prompt_required" };
          if (waited === "limit") throw callErrors.invalidState("runtime_busy", `Muse's session runtime stayed busy for ${MUSE_BUSY_LIMIT_MS / 1000} s and did not take the steer`);
        }
      } finally {
        limit.clear();
      }
    }

    const busy = thread.active !== undefined || thread.queued.size > 0;
    if (busy && input.intent === "start") throw callErrors.invalidState("previous_turn_active", "A turn is still running on this thread");
    const host = await this.#ensureHost(thread);
    const model = typeof input.config?.["model"] === "string" ? input.config["model"] : undefined;
    if (model !== undefined && model !== thread.model) {
      await host.command("session/setModel", { sessionId: thread.nativeId, model: { modelId: model, ...(this.#runtime.providerId === undefined ? {} : { providerId: this.#runtime.providerId }) } }).catch((error: unknown) => {
        throw callErrorFromMuse(this.#runtime.sdk, error, "model");
      });
      thread.model = model;
    }
    const instructions = joinInstructions([thread.instructions, turnInstructions]);
    const parts = await this.#inputParts(input.content, instructions);
    const displayText = input.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    const nativeId = host.mintCommandId();
    const turn = this.#newTurn(thread, nativeId, "user", input.clientTurnKey, input.hostTag);
    try {
      const params: MuseTurnStartParams = {
        sessionId: thread.nativeId,
        input: parts,
        ...(instructions === undefined || displayText === "" ? {} : { displayText }),
        ...(input.intent === "queue" ? { ifBusy: "queue" as const } : {}),
        ...(effort === undefined ? {} : { reasoningEffort: effort as MuseReasoningEffort }),
      };
      const response = await host.command("turn/start", params, nativeId);
      thread.instructions = undefined;
      if (response.turnId !== nativeId) {
        // Muse put the input in a turn it already runs.
        this.#dropTurn(turn);
        const owner = this.#turnsByNative.get(response.turnId);
        if (owner === undefined) throw callErrors.protocol("turn identity", `Muse admitted turn ${nativeId} as ${response.turnId}`);
        return { status: "accepted", turnId: owner.id, accepted: "steered" };
      }
      if (response.disposition === "queued") {
        // The active turn may already have ended and Muse started this one before its answer arrived.
        if (turn.phase === "unseen") this.#announce(turn, "pending");
        if (turn.phase === "pending" && !turn.settled) thread.queued.set(nativeId, turn);
        return { status: "accepted", turnId: turn.id, accepted: "queued" };
      }
      this.#begin(turn);
      return { status: "accepted", turnId: turn.id, accepted: "started" };
    } catch (error) {
      if (turn.phase === "unseen") this.#dropTurn(turn);
      throw callErrorFromMuse(this.#runtime.sdk, error, "turn");
    }
  }

  /**
   * A steer call that settled before Muse answered (at the turn's end or the
   * busy limit): if the answer then says Muse took the steer, the host hears
   * it once, as a warning notice on the turn. The call keeps its one answer.
   */
  #noticeLateSteer(reply: Promise<MuseReply>, turn: TurnState): void {
    void reply.then((late) => {
      if (!late.ok) return;
      this.#emit({ type: "notice", level: "warning", code: "muse.steer_taken_late", text: `Muse took a steer into turn ${turn.id} after the steer call had settled without it.` }, this.#envelope(turn));
    });
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    this.#open();
    const turn = this.#turnsById.get(input.turnId);
    if (turn === undefined || turn.settled) return;
    const thread = this.#thread(turn.threadId);
    const host = thread.host;
    if (host === undefined || host.exited) {
      this.#settle(turn, "interrupted");
      return;
    }
    turn.interruptRequested = true;
    // One commandId for every send of the unqueue: a busy refusal wrote nothing, so the resend is the same command.
    const unqueueId = host.mintCommandId();
    const limit = new BusyLimit();
    const stillBusy = (): Error => callErrors.invalidState("runtime_busy", `Muse's session runtime stayed busy for ${MUSE_BUSY_LIMIT_MS / 1000} s and did not take the unqueue; the turn is still queued`);
    try {
      for (let attempt = 1; ; attempt += 1) {
        const queued = turn.phase === "pending";
        const sent = queued ? host.command("turn/unqueue", { sessionId: thread.nativeId, turnId: turn.nativeId }, unqueueId) : host.command("turn/interrupt", { sessionId: thread.nativeId, turnId: turn.nativeId });
        // The busy limit bounds only the unqueue; a turn Muse started is interrupted, and its end bounds that wait.
        const answered = await Promise.race([replyOf(sent), ended(turn), ...(queued ? [limit.reached] : [])]);
        // The turn ended, however: nothing is left to stop.
        if (answered === "ended") break;
        if (answered === "limit") throw stillBusy();
        if (answered.ok) break;
        if (turn.settled) return;
        const kind = host.errorKind(answered.error);
        const data = kind === "commandRejected" ? host.errorData(answered.error) : {};
        // The busy session runtime did not take the unqueue: send it again, as the SDK's `Session.run` does, until Muse takes it or starts the turn (then the next pass interrupts it).
        if (queued && data["reason"] === "runtime_busy" && data["retryable"] !== false && !host.exited) {
          limit.start();
          const waited = await Promise.race([busyDelay(attempt), ended(turn), limit.reached]);
          if (turn.settled) return;
          if (waited === "limit") throw stillBusy();
          continue;
        }
        // The turn already ended: nothing to stop.
        if (kind === "commandRejected" || kind === "notFound") return;
        // Stop must end the turn even when Muse cannot be asked: end the host.
        await this.#park(thread);
        this.#settle(turn, "interrupted");
        return;
      }
    } finally {
      limit.clear();
    }
    if (input.restartRuntime === true) {
      await turn.done;
      await this.#park(thread);
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

  async #answer(pending: PendingRequest, input: RespondInput): Promise<void> {
    const thread = this.#thread(pending.threadId);
    const host = thread.host;
    if (host === undefined || host.exited) throw callErrors.invalidState("thread_not_loaded", "The Muse host that asked has exited");
    if (pending.native.type === "approval") {
      const approval = pending.native.value;
      if (input.optionId === undefined) throw callErrors.validation([{ message: "an approval needs optionId", path: ["optionId"] }]);
      const choice = approval.availableChoices.find((candidate) => candidate.choiceId === input.optionId);
      if (choice === undefined) throw callErrors.validation([{ message: `no option ${input.optionId}`, path: ["optionId"] }]);
      const feedback = input.feedback !== undefined && choice.acceptsFeedback === true ? { feedback: input.feedback } : {};
      try {
        const decided = await host.command("approval/decide", { sessionId: thread.nativeId, approvalId: approval.approvalId, requirementId: approval.currentRequirementId, choiceId: choice.choiceId, ...feedback });
        if (decided.terminal) this.#resolveRequest(pending, "resolved");
        else pending.inFlight = undefined;
      } catch (error) {
        if (host.errorKind(error) === "approvalAlreadyResolved") this.#resolveRequest(pending, "resolved");
        throw callErrorFromMuse(this.#runtime.sdk, error, "approval");
      }
      return;
    }
    const prompt = pending.native.value;
    const answers: MuseUserInputAnswer[] = [];
    for (const question of prompt.questions) {
      const answer = input.answers?.[question.id];
      const labels = answer?.optionIds ?? [];
      for (const label of labels) {
        if (!question.options.some((option) => option.label === label)) throw callErrors.validation([{ message: `question ${question.id} has no option ${label}`, path: ["answers", question.id, "optionIds"] }]);
      }
      const text = answer?.text ?? (labels.length === 0 ? input.custom : undefined);
      if (labels.length === 0 && (text === undefined || text === "")) throw callErrors.validation([{ message: `Muse needs an answer to question ${question.id}`, path: ["answers", question.id] }]);
      if (question.selection.mode === "single" && labels.length > 1) throw callErrors.validation([{ message: `question ${question.id} takes one option`, path: ["answers", question.id, "optionIds"] }]);
      answers.push({
        questionId: question.id,
        ...(labels.length === 0 ? {} : question.selection.mode === "single" ? { selectedLabel: labels[0]! } : { selectedLabels: [...labels] }),
        ...(text === undefined || text === "" ? {} : labels.length === 0 ? { freeText: text } : { note: text }),
      });
    }
    try {
      await host.command("userInput/answer", { sessionId: thread.nativeId, userInputId: prompt.userInputId, answers });
    } catch (error) {
      if (host.errorKind(error) === "userInputAlreadySettled") this.#resolveRequest(pending, "resolved");
      throw callErrorFromMuse(this.#runtime.sdk, error, "question");
    }
    this.#resolveRequest(pending, "resolved");
  }

  #resolveRequest(pending: PendingRequest, status: "resolved" | "cancelled" | "expired"): void {
    if (pending.resolved) return;
    pending.resolved = true;
    pending.request = { ...pending.request, status };
    this.#emit({ type: "request.upsert", request: { id: pending.request.id, status } }, this.#requestEnvelope(pending));
  }

  #requestEnvelope(pending: PendingRequest): { threadId: string; turnId?: string } {
    return { threadId: pending.threadId, ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }) };
  }

  // Config.

  async planConfigChange(input: PlanConfigChangeInput): Promise<ConfigChangePlan> {
    this.#thread(input.threadId);
    const unknown = Object.keys(input.changes).filter((key) => key !== "model" && key !== "reasoningEffort");
    if (unknown.length > 0) return { type: "reject", reason: `Muse has no session option ${unknown.join(", ")}` };
    const effort = input.changes["reasoningEffort"];
    if (effort !== undefined && typeof effort !== "string") return { type: "reject", reason: `A Muse reasoning effort is a string, not ${JSON.stringify(effort)}` };
    // The driver sends `session/setModel` before the next `turn/start`, and the effort with it, for Muse to take or refuse.
    return { type: "apply_next_turn" };
  }

  contextWindow(model: string): number | undefined {
    return this.#runtime.contextWindow(model);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const thread of this.#threads.values()) await this.#park(thread);
    for (const thread of this.#threads.values()) {
      for (const turn of [thread.active, ...thread.queued.values()]) if (turn !== undefined) this.#settle(turn, "interrupted");
    }
    for (const pending of this.#requests.values()) if (!pending.resolved) this.#resolveRequest(pending, "expired");
    this.#emit({ type: "session.state", state: "stopped" });
    this.#sequencer.close();
  }

  // Internals: hosts.

  #open(): void {
    if (this.#closed) throw callErrors.invalidState("session_closed");
  }

  #thread(threadId: string): ThreadState {
    const thread = this.#threads.get(threadId);
    if (thread === undefined) throw callErrors.notFound({ resource: "thread", id: threadId });
    return thread;
  }

  #policy(policy: RuntimePolicy): MusePolicy {
    const muse = musePolicy(policy);
    if (muse === undefined) throw callErrors.unsupported(`runtimePolicy.modes.${policy.mode}`, `Muse supports the runtime modes ${MUSE_SUPPORTED_MODES.join(" and ")}`);
    if (policy.interaction !== "default") throw callErrors.unsupported("runtimePolicy.interactionModes", "Muse has no plan interaction mode");
    return muse;
  }

  /** The canonical path of `cwd`: Muse wants canonical workspace roots, and a symbolic link must give the same thread. */
  async #canonical(cwd: string): Promise<string> {
    const fs = await import("node:fs/promises");
    return fs.realpath(cwd).catch(() => cwd);
  }

  async #spawnRequest(cwd: string, muse: MusePolicy): Promise<SpawnRequest> {
    return {
      command: this.#runtime.binaryPath,
      args: ["serve", ...this.#runtime.extraArgs, ...muse.serveArgs],
      cwd,
      env: await this.#runtime.environment(),
      purpose: "runtime",
      stdin: "pipe",
    };
  }

  /** Starts a `muse serve` host whose frames route to the threads of this session by session id. */
  async #startHost(cwd: string, muse: MusePolicy): Promise<MuseHost> {
    let started: MuseHost | undefined;
    const host = await MuseHost.start(this.#runtime.host, {
      sdk: this.#runtime.sdk,
      spawn: await this.#spawnRequest(cwd, muse),
      handshakeTimeoutMs: this.#input.handshakeTimeoutMs ?? 120_000,
      ...(this.#runtime.mintCommandId === undefined ? {} : { mintCommandId: this.#runtime.mintCommandId }),
      handlers: {
        onNotification: (notification) => this.#onNotification(notification),
        onServerRequest: (request) => this.#onServerRequest(request),
        onExit: (exit, byDriver) => {
          if (started !== undefined) this.#onExit(started, byDriver, exit.code === null ? `signal ${String(exit.signal)}` : `code ${exit.code}`);
        },
      },
    });
    started = host;
    return host;
  }

  /** The loaded host of `thread`, loading the session again (`session/resume`) when the host was parked or died. */
  async #ensureHost(thread: ThreadState): Promise<MuseHost> {
    if (thread.host !== undefined && !thread.host.exited) return thread.host;
    if (thread.loading !== undefined) return thread.loading;
    const loading = (async () => {
      const host = await this.#startHost(thread.cwd, thread.muse);
      try {
        const config = await this.#sessionConfig(host, thread.thread.id, thread.launch);
        await host.command("session/resume", {
          sessionId: thread.nativeId,
          excludeItems: true,
          permissionProfile: thread.muse.permissionProfile,
          ...(thread.model === undefined ? {} : { modelId: thread.model }),
          ...(config === undefined ? {} : { config }),
        });
        await host.command("session/setApprovalMode", { sessionId: thread.nativeId, mode: thread.muse.approvalMode });
      } catch (error) {
        await host.close();
        throw callErrorFromMuse(this.#runtime.sdk, error, "native session");
      }
      thread.host = host;
      return host;
    })();
    thread.loading = loading;
    try {
      return await loading;
    } finally {
      thread.loading = undefined;
    }
  }

  /** Muse's session config for a thread: the host's launch MCP servers and its per-thread tool server, under the host's names. */
  async #sessionConfig(host: MuseHost, threadId: string, launch: LaunchContext | undefined): Promise<MuseSessionConfig | undefined> {
    const hostServer = await this.#runtime.host.hostTools.mcpServerFor(threadId, { transport: "http" });
    const servers = [...(launch?.mcpServers ?? []), hostServer.config.name === hostServer.name ? hostServer.config : { ...hostServer.config, name: hostServer.name }];
    if (!host.sessionMcp) throw callErrors.unsupported("mcp.acceptsHostServers", "This muse serve did not grant per-session MCP servers (sessionMcp)");
    return { mcpServers: museMcpServers(servers) };
  }

  /** Reads the model catalog once per session, for `contextWindow`. */
  async #readModels(host: MuseHost, nativeId: string): Promise<void> {
    if (this.#modelsRead) return;
    this.#modelsRead = true;
    try {
      const listed = await host.request("model/list", { sessionId: nativeId });
      this.#runtime.onModels(listed.models);
    } catch {
      this.#modelsRead = false;
    }
  }

  /** Stops a thread's host in order: stdin closes, the host drains and releases its lease. */
  async #park(thread: ThreadState): Promise<void> {
    const loading = thread.loading;
    if (loading !== undefined) await loading.catch(() => undefined);
    const host = thread.host;
    thread.host = undefined;
    if (host !== undefined) await host.close();
  }

  #onExit(host: MuseHost, byDriver: boolean, how: string): void {
    for (const thread of this.#threads.values()) {
      if (thread.host !== host) continue;
      thread.host = undefined;
      if (byDriver) continue;
      const failure: Failure = { class: "transport_error", message: `muse serve exited (${how})`, retryable: true };
      for (const turn of [thread.active, ...thread.queued.values()]) if (turn !== undefined) this.#settle(turn, "failed", failure);
      for (const pending of this.#requests.values()) if (pending.threadId === thread.thread.id && !pending.resolved) this.#resolveRequest(pending, "expired");
    }
  }

  #pendingFor(thread: ThreadState): boolean {
    return [...this.#requests.values()].some((pending) => pending.threadId === thread.thread.id && !pending.resolved);
  }

  // Internals: threads and turns.

  #register(
    nativeId: string,
    host: MuseHost,
    spec: { cwd: string; policy: RuntimePolicy; muse: MusePolicy; launch: LaunchContext | undefined; model: string | undefined; instructions: string | undefined; title?: string },
  ): ThreadState {
    const id = threadIdFor(nativeId);
    const thread: Thread = {
      id,
      native: strongRef(nativeId),
      cwd: spec.cwd,
      status: "idle",
      handle: nativeId,
      ...(spec.title === undefined ? {} : { title: spec.title }),
      identityVersion: this.#runtime.capabilities.identity.identityVersion,
    };
    const existing = this.#threads.get(id);
    if (existing !== undefined) {
      // The resume's own settings replace the old ones, so an automatic resume later sends what this one did.
      existing.thread = thread;
      existing.host = host;
      existing.cwd = spec.cwd;
      existing.policy = spec.policy;
      existing.muse = spec.muse;
      existing.launch = spec.launch;
      existing.unloaded = false;
      existing.instructions = spec.instructions;
      existing.model = spec.model;
    } else {
      const state: ThreadState = {
        thread,
        nativeId,
        cwd: spec.cwd,
        policy: spec.policy,
        muse: spec.muse,
        launch: spec.launch,
        model: spec.model,
        instructions: spec.instructions,
        host,
        loading: undefined,
        unloaded: false,
        active: undefined,
        queued: new Map(),
        items: new Map(),
      };
      this.#threads.set(id, state);
      this.#threadsByNative.set(nativeId, state);
    }
    this.#emit({ type: "thread.upsert", thread }, { threadId: id });
    return this.#threads.get(id)!;
  }

  #flushOpening(nativeId: string): void {
    const held = this.#opening.get(nativeId);
    this.#opening.delete(nativeId);
    if (held === undefined || !this.#threadsByNative.has(nativeId)) return;
    for (const notification of held) this.#onNotification(notification);
  }

  /** Replays a resumed session's stored items as settled turns, so the host sees its history; the last turn ends as Muse's `lastTurn` says. */
  #replay(thread: ThreadState, items: readonly MuseItem[], activeTurnId: string | null, lastTurn: MuseLastTurn | undefined): void {
    for (const item of items) {
      const nativeTurn = item.turnId ?? undefined;
      let turnId: string | undefined;
      if (nativeTurn !== undefined) {
        const known = this.#turnsByNative.get(nativeTurn);
        if (known !== undefined) turnId = known.id;
        else {
          const turn = this.#newTurn(thread, nativeTurn, "user", undefined, undefined);
          if (nativeTurn === activeTurnId) this.#begin(turn);
          else {
            const outcome = storedOutcome(nativeTurn, lastTurn, undefined);
            this.#announce(turn, outcome.status, outcome.failure);
            turn.settled = true;
            turn.outcome = outcome;
            turn.finish();
          }
          turnId = turn.id;
        }
      }
      this.#upsertItem(thread, item, turnId);
    }
  }

  #newTurn(thread: ThreadState, nativeId: string, origin: "user" | "provider_initiated", clientTurnKey: string | undefined, hostTag: string | undefined): TurnState {
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const turn: TurnState = {
      id: turnIdFor(thread.thread.id, nativeId),
      nativeId,
      threadId: thread.thread.id,
      origin,
      clientTurnKey,
      hostTag,
      phase: "unseen",
      settled: false,
      outcome: undefined,
      steers: new Set(),
      interruptRequested: false,
      usage: undefined,
      openItems: new Set(),
      done,
      finish,
    };
    this.#turnsByNative.set(nativeId, turn);
    this.#turnsById.set(turn.id, turn);
    return turn;
  }

  #dropTurn(turn: TurnState): void {
    if (this.#turnsByNative.get(turn.nativeId) === turn) this.#turnsByNative.delete(turn.nativeId);
    if (this.#turnsById.get(turn.id) === turn) this.#turnsById.delete(turn.id);
  }

  #envelope(turn: TurnState): { threadId: string; turnId: string; hostTag?: string } {
    return { threadId: turn.threadId, turnId: turn.id, ...(turn.hostTag === undefined ? {} : { hostTag: turn.hostTag }) };
  }

  /** Emits the upsert that starts `turn` in the event stream, with `status` (and the failure of a replayed failed turn). */
  #announce(turn: TurnState, status: Turn["status"], failure?: Failure): void {
    const thread = this.#threads.get(turn.threadId);
    turn.phase = status === "pending" ? "pending" : "running";
    this.#emit(
      {
        type: "turn.upsert",
        turn: {
          id: turn.id,
          threadId: turn.threadId,
          native: strongRef(turn.nativeId),
          origin: turn.origin,
          status,
          ...(turn.clientTurnKey === undefined ? {} : { clientTurnKey: turn.clientTurnKey }),
          ...(turn.hostTag === undefined ? {} : { hostTag: turn.hostTag }),
          ...(status === "running" ? { startedAt: new Date().toISOString() } : {}),
          ...(thread?.model === undefined ? {} : { model: thread.model }),
          ...(failure === undefined ? {} : { failure }),
        },
      },
      this.#envelope(turn),
    );
  }

  /** Marks `turn` running: announces it, or moves it from queued to running. */
  #begin(turn: TurnState): void {
    if (turn.settled) return;
    const thread = this.#threads.get(turn.threadId);
    if (turn.phase === "unseen") this.#announce(turn, "running");
    else if (turn.phase === "pending") {
      turn.phase = "running";
      this.#emit({ type: "turn.upsert", turn: { id: turn.id, status: "running", startedAt: new Date().toISOString() } }, this.#envelope(turn));
    }
    if (thread !== undefined) {
      thread.queued.delete(turn.nativeId);
      thread.active = turn;
      if (thread.thread.status !== "running") {
        thread.thread = { ...thread.thread, status: "running" };
        this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id, status: "running" } }, { threadId: thread.thread.id });
      }
    }
  }

  /** Ends a turn: settles what it left open, cancels its live requests, then emits its status and its one `turn.terminal`. */
  #settle(turn: TurnState, status: "completed" | "interrupted" | "cancelled" | "failed", failure?: Failure): void {
    if (turn.settled) return;
    const thread = this.#threads.get(turn.threadId);
    if (turn.phase === "unseen") this.#announce(turn, "running");
    turn.settled = true;
    turn.outcome = { status, ...(failure === undefined ? {} : { failure }) };
    const envelope = this.#envelope(turn);
    const itemStatus = status === "completed" ? "completed" : status;
    for (const itemId of turn.openItems) this.#emit({ type: "item.upsert", item: { id: itemId, status: itemStatus } }, envelope);
    turn.openItems.clear();
    if (thread !== undefined) for (const record of thread.items.values()) if (record.turnId === turn.id) record.open = false;
    for (const pending of this.#requests.values()) {
      if (pending.turnId !== turn.id || pending.resolved) continue;
      this.#resolveRequest(pending, "cancelled");
    }
    this.#emit(
      {
        type: "turn.upsert",
        turn: { id: turn.id, status, completedAt: new Date().toISOString(), ...(failure === undefined ? {} : { failure }), ...(turn.usage === undefined ? {} : { usage: turn.usage }) },
      },
      envelope,
    );
    this.#emit({ type: "turn.terminal", turnId: turn.id, status, ...(failure === undefined ? {} : { failure }), threadDisposition: "reusable" }, envelope);
    if (thread !== undefined) {
      thread.queued.delete(turn.nativeId);
      if (thread.active === turn) thread.active = undefined;
      if (thread.active === undefined && thread.thread.status === "running") {
        thread.thread = { ...thread.thread, status: "idle" };
        this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id, status: "idle" } }, { threadId: thread.thread.id });
      }
    }
    turn.finish();
  }

  // Internals: frames.

  #onServerRequest(request: MuseWireRequest): Promise<Record<string, unknown>> {
    if (request.method === "approval/request" || request.method === "userInput/request") {
      const method = request.method === "approval/request" ? "approval/requested" : "userInput/requested";
      this.#onNotification({ method, ...(request.params === undefined ? {} : { params: request.params }) });
      // The presentation receipt: the decision travels as `approval/decide` or `userInput/answer`.
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`The ARI Muse driver does not handle ${request.method}`));
  }

  #onNotification(notification: MuseWireNotification): void {
    if (this.#closed && notification.method !== "turn/completed") return;
    const params = notification.params;
    if (!isObject(params)) return;
    if (notification.method === "usage/changed") {
      const limits = limitsFromMuse(params as unknown as MuseNotifications["usage/changed"]);
      this.#runtime.onLimits(limits);
      this.#emit({ type: "limits.updated", limits });
      return;
    }
    const nativeSession = typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
    if (nativeSession === undefined) return;
    const held = this.#opening.get(nativeSession);
    if (held !== undefined) {
      held.push(notification);
      return;
    }
    const thread = this.#threadsByNative.get(nativeSession);
    if (thread === undefined) return;
    switch (notification.method) {
      case "turn/started": {
        const started = params as unknown as MuseNotifications["turn/started"];
        const turn = this.#turnsByNative.get(started.turnId) ?? this.#newTurn(thread, started.turnId, "provider_initiated", undefined, undefined);
        this.#begin(turn);
        return;
      }
      case "turn/completed": {
        const completed = params as unknown as MuseTurnCompleted;
        const turn = this.#turnsByNative.get(completed.turnId);
        if (turn === undefined || turn.settled) return;
        if (completed.usage !== undefined) {
          turn.usage = usageFromMuse(completed.usage, "turn", thread.model);
          this.#emit({ type: "usage.updated", usage: turn.usage }, this.#envelope(turn));
        }
        if (completed.terminal === "completed") this.#settle(turn, "completed");
        else if (completed.terminal === "cancelled") this.#settle(turn, turn.interruptRequested ? "interrupted" : "cancelled");
        else this.#settle(turn, "failed", failureFromMuse(completed));
        return;
      }
      case "turn/unqueued": {
        const turn = this.#turnsByNative.get((params as unknown as MuseNotifications["turn/unqueued"]).turnId);
        if (turn !== undefined) this.#settle(turn, turn.interruptRequested ? "interrupted" : "cancelled");
        return;
      }
      case "item/started":
      case "item/updated":
      case "item/completed": {
        const item = (params as unknown as MuseNotifications["item/started"]).item;
        const turn = item.turnId === undefined || item.turnId === null ? undefined : this.#turnsByNative.get(item.turnId);
        if (turn !== undefined && item.kind === "userMessage" && item.steered === true && typeof item.commandId === "string") turn.steers.add(item.commandId);
        if (turn !== undefined && turn.phase !== "running" && !turn.settled) this.#begin(turn);
        this.#upsertItem(thread, item, turn?.id);
        return;
      }
      case "item/delta": {
        const delta = params as unknown as MuseNotifications["item/delta"];
        const record = thread.items.get(delta.itemId);
        if (record === undefined || !record.open) return;
        const field = deltaField(record.kind, delta.field);
        if (field === undefined || delta.delta === "") return;
        this.#emit({ type: "item.delta", itemId: record.ariId, field, chunk: delta.delta }, { threadId: thread.thread.id, ...(record.turnId === undefined ? {} : { turnId: record.turnId }) });
        return;
      }
      case "approval/requested":
        this.#onApproval(thread, params as unknown as MuseApprovalRequest);
        return;
      case "approval/updated":
        this.#onApprovalUpdated(thread, params as unknown as MuseApprovalUpdated);
        return;
      case "approval/resolved": {
        const pending = this.#requests.get(requestIdFor(thread.thread.id, "approval", (params as unknown as MuseNotifications["approval/resolved"]).approvalId));
        if (pending !== undefined) this.#resolveRequest(pending, "resolved");
        return;
      }
      case "userInput/requested":
        this.#onUserInput(thread, params as unknown as MuseUserInputRequest);
        return;
      case "userInput/settled": {
        const settled = params as unknown as MuseNotifications["userInput/settled"];
        const pending = this.#requests.get(requestIdFor(thread.thread.id, "userInput", settled.userInputId));
        if (pending === undefined) return;
        const status = settled.outcome === "timedOut" ? "expired" : settled.outcome === "cancelled" || settled.outcome === "aborted" || settled.outcome === "interrupted" ? "cancelled" : "resolved";
        this.#resolveRequest(pending, status);
        return;
      }
      case "session/tokenUsage": {
        const usage = params as unknown as MuseNotifications["session/tokenUsage"];
        const turn = this.#turnsByNative.get(usage.turnId);
        if (turn === undefined || turn.phase === "unseen") return;
        const call = usageFromMuse(usage.usage, "turn", usage.modelId ?? thread.model);
        const previous = turn.usage;
        turn.usage = {
          ...call,
          inputTokens: (previous?.inputTokens ?? 0) + (call.inputTokens ?? 0),
          outputTokens: (previous?.outputTokens ?? 0) + (call.outputTokens ?? 0),
          cachedInputTokens: (previous?.cachedInputTokens ?? 0) + (call.cachedInputTokens ?? 0),
          reasoningTokens: (previous?.reasoningTokens ?? 0) + (call.reasoningTokens ?? 0),
          totalTokens: (previous?.totalTokens ?? 0) + (call.totalTokens ?? 0),
        };
        this.#emit({ type: "usage.updated", usage: turn.usage }, this.#envelope(turn));
        return;
      }
      case "session/contextUsage": {
        const context = params as unknown as MuseNotifications["session/contextUsage"];
        this.#emit(
          { type: "usage.updated", usage: { scope: "thread", contextUsedTokens: context.usedTokens, ...(context.windowTokens === undefined ? {} : { contextMaxTokens: context.windowTokens }), ...(thread.model === undefined ? {} : { model: thread.model }) } },
          { threadId: thread.thread.id },
        );
        return;
      }
      case "session/todoListChanged": {
        const todos = params as unknown as MuseNotifications["session/todoListChanged"];
        const turn = thread.active;
        this.#emit(
          {
            type: "plan.upsert",
            plan: {
              id: planIdFor(thread.thread.id),
              threadId: thread.thread.id,
              entries: todos.items.map((entry) => ({ text: entry.text, status: TODO_STATUSES[entry.status] ?? entry.status })),
              ...(turn === undefined ? {} : { turnId: turn.id }),
              updatedAt: new Date().toISOString(),
            },
          },
          turn === undefined ? { threadId: thread.thread.id } : this.#envelope(turn),
        );
        return;
      }
      case "session/modelChanged":
        thread.model = (params as unknown as MuseNotifications["session/modelChanged"]).modelId;
        return;
      default:
        return;
    }
  }

  #mapItem(thread: ThreadState, item: MuseItem, turnId: string | undefined): Item {
    const mapped = itemFromMuse(item, { threadId: thread.thread.id, turnId, cwd: thread.cwd, subagentId: (native) => subagentIdFor(thread.thread.id, native) });
    // The user's own words: the driver sent host instructions before them and the host's text as `displayText`.
    if (item.kind === "userMessage" && item.displayText !== undefined) return { ...mapped, text: item.displayText };
    return mapped;
  }

  /** Applies a Muse item at a higher revision: opens it, updates it, or settles it. */
  #upsertItem(thread: ThreadState, item: MuseItem, turnId: string | undefined): void {
    const record = thread.items.get(item.itemId);
    if (record !== undefined && record.revision >= item.revision) return;
    const mapped = this.#mapItem(thread, item, turnId);
    const open = mapped.status === "running";
    const envelope = { threadId: thread.thread.id, ...(turnId === undefined ? {} : { turnId }) };
    const turn = turnId === undefined ? undefined : this.#turnsById.get(turnId);
    if (record === undefined) {
      thread.items.set(item.itemId, { ariId: mapped.id, kind: item.kind, ariKind: mapped.kind, revision: item.revision, open, turnId });
      this.#emit({ type: "item.upsert", item: mapped }, envelope);
    } else {
      // An item keeps the kind it opened with (tool arguments can stream in later), and a settled item stays settled: only its payload may change.
      const { kind: _kind, native: _native, ...full } = mapped;
      const patch = mapped.kind === record.ariKind ? full : { id: mapped.id, status: mapped.status, ...(mapped.output === undefined ? {} : { output: mapped.output }), ...(mapped.text === undefined ? {} : { text: mapped.text }) };
      const body = record.open ? patch : (({ status: _status, ...rest }) => rest)(patch);
      record.revision = item.revision;
      record.open = record.open && open;
      this.#emit({ type: "item.upsert", item: body }, envelope);
    }
    if (open && turn !== undefined && !turn.settled) turn.openItems.add(mapped.id);
    else turn?.openItems.delete(mapped.id);
    if (item.kind === "subagent" && item.subagentId !== undefined) this.#subagent(thread, item, turnId, mapped.id);
  }

  #subagent(thread: ThreadState, item: MuseItem, turnId: string | undefined, itemId: string): void {
    const id = subagentIdFor(thread.thread.id, item.subagentId!);
    const status: Subagent["status"] = item.status === "inProgress" ? "running" : (itemFromMuse(item, { threadId: thread.thread.id, turnId, cwd: thread.cwd, subagentId: () => id }).status as Subagent["status"]);
    const settled = status !== "running";
    const outcome = settled
      ? { status, ...(item.result?.summary === undefined ? {} : { summary: item.result.summary }), ...(status === "failed" ? { failure: { class: "provider_error", message: item.failureReason ?? item.result?.errorKind ?? "The Muse subagent failed.", retryable: false } } : {}) }
      : undefined;
    const known = this.#subagents.get(id);
    const subagent: Subagent = {
      id,
      native: strongRef(item.subagentId!),
      parentThreadId: thread.thread.id,
      status,
      ...(turnId === undefined ? {} : { parentTurnId: turnId }),
      parentItemId: itemId,
      ...(item.role === undefined && item.agentPath === undefined ? {} : { name: item.role ?? item.agentPath! }),
      ...(item.objective === undefined ? {} : { prompt: item.objective }),
      ...(outcome === undefined ? {} : { outcome: outcome as NonNullable<Subagent["outcome"]> }),
    };
    if (known !== undefined && known.status !== "running" && known.status === subagent.status) return;
    this.#subagents.set(id, subagent);
    this.#emit({ type: "subagent.upsert", subagent }, { threadId: thread.thread.id, ...(turnId === undefined ? {} : { turnId }) });
  }

  #onApproval(thread: ThreadState, approval: MuseApprovalRequest): void {
    const id = requestIdFor(thread.thread.id, "approval", approval.approvalId);
    const existing = this.#requests.get(id);
    if (existing !== undefined) {
      if (existing.native.type === "approval") existing.native = { type: "approval", value: approval };
      return;
    }
    // A subagent's approval belongs to the child's run, not to a turn of this thread.
    const turn = approval.subagentOrigin === undefined ? this.#turnsByNative.get(approval.turnId) : undefined;
    const turnId = turn !== undefined && turn.phase !== "unseen" ? turn.id : undefined;
    const item = thread.items.get(approval.itemId);
    const options = approval.availableChoices.map((choice) => choiceOption(choice, approval.subject.kind));
    const request: Request = {
      id,
      native: strongRef(approval.approvalId),
      kind: approvalKind(approval.subject),
      origin: {
        threadId: thread.thread.id,
        ...(turnId === undefined ? {} : { turnId }),
        ...(item === undefined ? {} : { itemId: item.ariId }),
        ...(approval.subagentOrigin === undefined ? {} : { subagentId: subagentIdFor(thread.thread.id, approval.subagentOrigin.subagentId) }),
      },
      subject: approvalSubject(approval, thread.cwd),
      options,
      allowCustomAnswer: false,
      allowFeedback: approval.availableChoices.some((choice) => choice.acceptsFeedback === true),
      response: { mode: "live" },
      survivesRestart: false,
      status: "pending",
    };
    const pending: PendingRequest = { request, threadId: thread.thread.id, turnId, native: { type: "approval", value: approval }, resolved: false, inFlight: undefined };
    this.#requests.set(id, pending);
    this.#emit({ type: "request.upsert", request }, this.#requestEnvelope(pending));
  }

  #onApprovalUpdated(thread: ThreadState, updated: MuseApprovalUpdated): void {
    const pending = this.#requests.get(requestIdFor(thread.thread.id, "approval", updated.approvalId));
    if (pending === undefined || pending.resolved || pending.native.type !== "approval") return;
    const value: MuseApprovalRequest = { ...pending.native.value, availableChoices: updated.availableChoices, currentRequirementId: updated.currentRequirementId, subject: updated.subject };
    pending.native = { type: "approval", value };
    const options = updated.availableChoices.map((choice) => choiceOption(choice, updated.subject.kind));
    pending.request = { ...pending.request, options, subject: approvalSubject(value, thread.cwd) };
    this.#emit({ type: "request.upsert", request: { id: pending.request.id, options, subject: pending.request.subject ?? null } }, this.#requestEnvelope(pending));
  }

  #onUserInput(thread: ThreadState, prompt: MuseUserInputRequest): void {
    const id = requestIdFor(thread.thread.id, "userInput", prompt.userInputId);
    if (this.#requests.has(id)) return;
    const turn = this.#turnsByNative.get(prompt.turnId);
    const turnId = turn !== undefined && turn.phase !== "unseen" ? turn.id : undefined;
    const item = thread.items.get(prompt.itemId);
    const request: Request = {
      id,
      native: strongRef(prompt.userInputId),
      kind: "user_input",
      origin: { threadId: thread.thread.id, ...(turnId === undefined ? {} : { turnId }), ...(item === undefined ? {} : { itemId: item.ariId }) },
      questions: questionsFromMuse(prompt),
      allowCustomAnswer: true,
      allowFeedback: false,
      response: { mode: "live" },
      survivesRestart: false,
      status: "pending",
    };
    const pending: PendingRequest = { request, threadId: thread.thread.id, turnId, native: { type: "userInput", value: prompt }, resolved: false, inFlight: undefined };
    this.#requests.set(id, pending);
    this.#emit({ type: "request.upsert", request }, this.#requestEnvelope(pending));
  }

  /** Muse turn input for host content, with host instructions as a first text part. */
  async #inputParts(content: readonly ContentBlock[], instructions: string | undefined): Promise<MuseInputPart[]> {
    const parts: MuseInputPart[] = instructions === undefined ? [] : [{ type: "text", text: instructions }];
    for (const block of content) {
      if (block.type === "text") parts.push({ type: "text", text: block.text });
      else if (block.type === "image") {
        if (block.data !== undefined) parts.push({ type: "image", base64Data: block.data, mediaType: block.mimeType ?? "image/png" });
        else if (block.attachmentRef !== undefined) {
          const resolved = await this.#runtime.host.attachments.resolve(block.attachmentRef);
          if (resolved === null) parts.push({ type: "text", text: `[The image attachment ${block.attachmentRef} could not be read.]` });
          else {
            const fs = await import("node:fs/promises");
            const bytes = await fs.readFile(resolved.path);
            parts.push({ type: "image", base64Data: bytes.toString("base64"), mediaType: block.mimeType ?? resolved.mime });
          }
        } else if (block.url !== undefined) parts.push({ type: "text", text: `[Image: ${block.url}]` });
      } else if (block.type === "file") {
        const resolved = await this.#runtime.host.attachments.resolve(block.attachmentRef);
        if (resolved === null) parts.push({ type: "text", text: `[The attached file ${block.name ?? block.attachmentRef} could not be read.]` });
        else parts.push({ type: "text", text: `[Attached file ${block.name ?? resolved.path}: ${resolved.path}]` });
      } else if (block.type === "resource_link") parts.push({ type: "text", text: block.uri });
    }
    if (parts.length === 0) throw callErrors.validation([{ message: "a Muse turn needs text or an image", path: ["content"] }]);
    return parts;
  }

  #emit(body: AriEventBody, envelope: { threadId?: string; turnId?: string; hostTag?: string } = {}): void {
    if (this.#sequencer.closed) return;
    this.#sequencer.emit({ body, ...envelope });
  }
}
