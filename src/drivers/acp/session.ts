// An ARI session over one ACP agent process. One ACP session is one ARI
// thread; the process can hold several.
//
// The two protocol versions differ most in how a turn ends:
// - v1: `session/prompt` stays pending for the whole turn, and its response's
//   `stopReason` ends the turn.
// - v2: the `session/prompt` response only means the prompt was accepted
//   (inserted); the turn ends on the `state_update` that reports `idle` after
//   the turn's foreground work was reported `running` or `requires_action`.
// Updates are applied as upserts in both: an assistant message is one item
// whose text grows with its chunks, and a tool call is one item patched by id.
//
// Settlement is always the agent's: the prompt response (v1), the idle state
// (v2), or the process exiting. Nothing here settles a turn on a timer.

import { callErrors, toCallError } from "../../errors.ts";
import { JsonRpcError } from "../../driver-kit/json-rpc.ts";
import type { JsonRpcId, JsonRpcRequestContext } from "../../driver-kit/json-rpc.ts";
import { EventSequencer } from "../../driver-kit/sequencer.ts";
import { deriveId } from "../../driver-kit/ids.ts";
import { truncateUtf8 } from "../../driver-kit/truncate.ts";
import type { Capabilities } from "../../generated/capabilities.ts";
import type { ContentBlock, NativeRef } from "../../generated/common.ts";
import type { ConfigValues } from "../../generated/common.ts";
import type { ConfigOption, RuntimePolicy } from "../../generated/config.ts";
import type { Failure } from "../../generated/errors.ts";
import type { AriEvent, AriEventBody } from "../../generated/events.ts";
import type { OpenSessionInput } from "../../generated/instance.ts";
import type { ItemKind, ItemPatch } from "../../generated/item.ts";
import type { Request } from "../../generated/request.ts";
import type {
  AppliedThread,
  CreateThreadInput,
  ForkThreadInput,
  InterruptTurnInput,
  LaunchContext,
  LaunchMcpServer,
  PlanConfigChangeInput,
  RespondInput,
  ResumeThreadInput,
  StartTurnInput,
  StartTurnResult,
} from "../../generated/session.ts";
import type { ConfigChangePlan } from "../../generated/config.ts";
import type { ProcessExit } from "../../generated/host.ts";
import type { Thread } from "../../generated/thread.ts";
import type { HostServices, Session } from "../../runtime.ts";
import { ACP_EXTENSION, ACP_IDENTITY_VERSION, acpCapabilities, agentTakesSystemPrompt, v1ResumeMethod } from "./capabilities.ts";
import { ACP_ERRORS, AcpConnection, callErrorFrom } from "./connection.ts";
import type { AcpLaunch } from "./connection.ts";
import type * as V1 from "./generated/v1.ts";
import type * as V2 from "./generated/v2.ts";
import {
  TERMINAL_ITEM_STATUSES,
  acceptsImages,
  configOption,
  configOptionId,
  contentText,
  imageBlock,
  mcpServers,
  narrowestAccepting,
  promptText,
  requestKindForTool,
  requestOptions,
  slashCommands,
  todos,
  toolContentText,
  toolFileChanges,
  toolItemKind,
  toolItemStatus,
} from "./mapping.ts";
import type { AcpToolCall, AcpVersion } from "./mapping.ts";

/** What a driver built on the ACP base gives each session. */
export interface AcpSessionSettings {
  readonly maxProtocolVersion: AcpVersion;
  readonly forkAcrossDirectories: boolean;
  readonly configDependencies: { readonly [optionId: string]: readonly string[] };
  /** Builds the command for one agent process; called again when the process must be restarted. */
  readonly launch: () => Promise<AcpLaunch>;
  /** The canonical form of a directory, so a workspace reached through a symbolic link gives the same thread. */
  readonly canonicalPath: (directory: string) => Promise<string>;
  /** A flavor's changes to the declared capabilities. */
  readonly adjustCapabilities?: (capabilities: Capabilities) => Capabilities;
  /** Config values a flavor sets from a thread's runtime policy, for agents that enforce a mode through a config option. */
  readonly policyConfig?: (policy: RuntimePolicy) => ConfigValues;
  /** Told the config options each time the agent sends a new list. */
  readonly onConfigOptions?: (options: readonly ConfigOption[]) => void;
  /** Told the protocol version an agent answered `initialize` with, including one the driver refuses. */
  readonly onProtocolAnswer?: (protocolVersion: unknown) => void;
}

type AcpConfigOption = V1.SessionConfigOption | V2.SessionConfigOption;
type ToolCallContent = V1.ToolCallContent | V2.ToolCallContent;
type SystemPrompt = V1.SystemPrompt | V2.SystemPrompt;
type FileChanges = ReturnType<typeof toolFileChanges>;

/** How host instructions reach the agent for one thread: on the request that opens its session, or in its first prompt. */
interface Instructions {
  readonly systemPrompt: SystemPrompt | undefined;
  readonly firstMessage: string[];
}

interface MessageState {
  readonly itemId: string;
  readonly field: "text" | "reasoning";
  text: string;
  settled: boolean;
}

/** A tool call as the agent's updates left it (`#tool` gives the rules for each protocol version). */
interface ToolState {
  readonly itemId: string;
  readonly kind: ItemKind;
  name: string;
  input: unknown;
  /** The agent's `rawOutput`; undefined when it sent none or cleared it. */
  rawOutput: unknown;
  output: string;
  truncated: boolean;
  content: ToolCallContent[];
  changes: FileChanges;
  settled: boolean;
}

interface UserMessageState {
  readonly itemId: string;
  /** What the ARI item shows. */
  text: string;
  /** The agent's text for the message: a `user_message` with `content` replaces it, a chunk appends to it. */
  native: string;
  /** A `user_message` set the whole content, so the native text is no longer a copy still arriving in chunks. */
  replaced: boolean;
  /** For the turn's prompt: what the driver sent and what the host wrote, so the agent's copy shows only the host's words. */
  readonly prompt?: SentPrompt;
}

/** A prompt as the driver sent it: the instructions it put first (the `first_user_message` channel), then the host's content. */
interface SentPrompt {
  /** The text of every block sent, instructions included, as `contentText` joins them. */
  readonly sent: string;
  /** The instruction block's text; empty when the prompt carried none. */
  readonly instructions: string;
  /** The host's own text, which the user item shows. */
  readonly hostText: string;
}

interface TurnState {
  readonly id: string;
  readonly threadId: string;
  readonly hostTag: string | undefined;
  readonly policy: RuntimePolicy;
  settled: boolean;
  /** v2: a `running` or `requires_action` state was seen for this turn, so an `idle` state ends it. */
  sawActive: boolean;
  status: "running" | "waiting";
  readonly messages: Map<string, MessageState>;
  /** The key of the message without an ACP message id that chunks currently extend. */
  anonymousRun: string | undefined;
  readonly tools: Map<string, ToolState>;
  readonly plans: Map<string, { readonly itemId: string; settled: boolean }>;
  /** The user item the driver opened for the host's prompt, until the agent's own message for it (v2 `user_message`) claims it. */
  unclaimedPrompt: UserMessageState | undefined;
  /** v2 user messages by the agent's message id. */
  readonly userMessages: Map<string, UserMessageState>;
  nextItemOrdinal: number;
  nextRequestOrdinal: number;
}

interface ThreadState {
  thread: Thread;
  readonly nativeId: string;
  readonly cwd: string;
  policy: RuntimePolicy;
  readonly mcp: readonly LaunchMcpServer[];
  /** Host instructions for the first prompt (the `first_user_message` channel), sent once. */
  pendingInstructions: string[];
  /** The system prompt the session was opened with, sent again when the agent loads the session after a restart. */
  systemPrompt: SystemPrompt | undefined;
  readonly options: Map<string, { readonly acp: AcpConfigOption; readonly ari: ConfigOption }>;
  active: TurnState | undefined;
  /** The connection generation that has this ACP session loaded. */
  generation: number;
  nextTurnOrdinal: number;
}

interface PendingRequest {
  readonly request: Request;
  readonly threadId: string;
  readonly turnId: string | undefined;
  readonly rpcId: JsonRpcId | null;
  readonly reply: (response: V1.RequestPermissionResponse | V2.RequestPermissionResponse) => void;
  inFlight: string | undefined;
  resolved: boolean;
}

const CANCELLED_OUTCOME = { outcome: { outcome: "cancelled" as const } };

function strong(id: string): NativeRef {
  return { id, strength: "strong" };
}

function failureFromError(error: unknown, fallback: string): Failure {
  if (error instanceof JsonRpcError) {
    return { class: "provider_error", message: error.message === "" ? fallback : error.message, code: String(error.code), retryable: true };
  }
  const callError = toCallError(error);
  if (callError?.code === "transport") return { class: "transport_error", message: callError.message, retryable: true };
  return { class: "provider_error", message: error instanceof Error ? error.message : fallback, retryable: true };
}

/** How a turn ends for an ACP stop reason. v1 and v2 share the names; v2 adds `error`. */
function stopOutcome(stopReason: string | null | undefined, error: { code?: unknown; message?: unknown } | null | undefined): { status: "completed" | "interrupted" | "failed"; failure?: Failure; notice?: string } {
  switch (stopReason) {
    case "end_turn":
      return { status: "completed" };
    case "cancelled":
      return { status: "interrupted" };
    case "error":
      return {
        status: "failed",
        failure: {
          class: "provider_error",
          message: typeof error?.message === "string" && error.message !== "" ? error.message : "The agent reported an error.",
          ...(typeof error?.code === "number" ? { code: String(error.code) } : {}),
          retryable: true,
        },
      };
    case "max_tokens":
      return { status: "completed", notice: "The agent stopped at its token limit." };
    case "max_turn_requests":
      return { status: "completed", notice: "The agent stopped at its limit of model requests for one turn." };
    case "refusal":
      return { status: "completed", notice: "The agent refused to continue." };
    default:
      // ACP: an idle state may omit the reason; the turn ended, but nobody said why.
      return { status: "completed", notice: `The agent ended the turn without a known stop reason (${String(stopReason)}).` };
  }
}

/**
 * ACP v1 tool updates carry only the fields that changed, and `null` changes nothing. ACP v1 Tool Calls
 * (https://agentclientprotocol.com/protocol/v1/tool-calls.md) says: "Only the fields being changed need to be
 * included"; for `rawInput` and `rawOutput`, "On a tool call update, both [omission and `null`] leave the previously
 * reported value unchanged"; for `name`, "Omission and `null` both leave the existing name unchanged". v1 defines no
 * way to clear a field: clearing with `null` arrived with v2, whose `tool_call_update` is "Now an explicit upsert with
 * omit/`null`/value patch semantics" (v2 migration guide). So a v1 update drops its `null` fields before it is applied
 * as a patch; `[]` still replaces a collection.
 */
function v1ToolUpdate(update: AcpToolCall): AcpToolCall {
  return Object.fromEntries(Object.entries(update).filter(([, value]) => value !== null)) as unknown as AcpToolCall;
}

/**
 * The text a user item shows. For the turn's prompt, the agent's copy of what the driver sent (whole, or the chunks
 * so far) shows the host's own text: the instructions the driver put before it are not the user's words. A copy the
 * agent changed, such as a redaction, shows the agent's text, still without the driver's instruction prefix.
 */
function userItemText(message: UserMessageState): string {
  const prompt = message.prompt;
  if (prompt === undefined) return message.native;
  if (message.native === prompt.sent || (!message.replaced && prompt.sent.startsWith(message.native))) return prompt.hostText;
  if (prompt.instructions !== "" && message.native.startsWith(prompt.instructions)) return message.native.slice(prompt.instructions.length).replace(/^\s+/, "");
  return message.native;
}

export class AcpSession implements Session {
  readonly id: string;
  readonly #host: HostServices<unknown>;
  readonly #settings: AcpSessionSettings;
  readonly #input: OpenSessionInput;
  readonly #sequencer: EventSequencer;
  readonly #threads = new Map<string, ThreadState>();
  readonly #threadsByNative = new Map<string, string>();
  readonly #turnsById = new Map<string, TurnState>();
  readonly #requests = new Map<string, PendingRequest>();
  readonly #requestsByRpcId = new Map<string, PendingRequest>();
  readonly #responses = new Map<string, Promise<void>>();
  readonly #turnKeys = new Map<string, Promise<StartTurnResult>>();
  /** Native sessions whose history the agent is replaying for `session/load`; their updates are not live output. */
  readonly #replaying = new Set<string>();
  /**
   * v2: native sessions being resumed whose current-state snapshot arrived (it ends any replay). The snapshot and the
   * live updates after it wait here until the session's thread is registered, then are applied in order.
   */
  readonly #resumed = new Map<string, Array<V1.SessionNotification | V2.UpdateSessionNotification>>();
  #capabilities: Capabilities | undefined;
  #forkAcrossDirectories: boolean;
  #connection: Promise<AcpConnection> | undefined;
  #current: AcpConnection | undefined;
  #generation = 0;
  #closed = false;

  constructor(host: HostServices<unknown>, settings: AcpSessionSettings, input: OpenSessionInput, id: string) {
    this.id = id;
    this.#host = host;
    this.#settings = settings;
    this.#input = input;
    this.#forkAcrossDirectories = settings.forkAcrossDirectories;
    this.#sequencer = new EventSequencer({ sessionId: id });
  }

  /** Starts the agent, then announces the session's capabilities. */
  async open(): Promise<void> {
    await this.#agent();
    this.#emit({ type: "capabilities.updated", capabilities: this.capabilities() });
    this.#emit({ type: "session.state", state: "ready" });
  }

  /** The protocol version the agent negotiated. */
  get protocolVersion(): AcpVersion {
    if (this.#current === undefined) throw callErrors.invalidState("agent_not_running");
    return this.#current.version;
  }

  capabilities(): Capabilities {
    if (this.#capabilities === undefined) throw callErrors.invalidState("session_not_open");
    return this.#capabilities;
  }

  events(options?: { fromSeq?: number }): AsyncIterable<AriEvent> {
    return this.#sequencer.events(options?.fromSeq === undefined ? {} : { fromSeq: options.fromSeq });
  }

  async createThread(input: CreateThreadInput): Promise<AppliedThread> {
    this.#open();
    const agent = await this.#agent();
    const cwd = await this.#settings.canonicalPath(input.cwd);
    const launch = this.#launchFor(input.launch);
    const servers = this.#mcpFor(launch);
    const instructions = this.#instructions(agent, launch, input.context);
    const created = await this.#newNative(agent, cwd, servers, instructions.systemPrompt);
    const state = this.#register(created.sessionId, cwd, input.policy, servers, input.title);
    this.#giveInstructions(state, instructions);
    this.#passMeta(created._meta, "session/new", "result", created.sessionId);
    this.#setOptions(state, created.configOptions ?? undefined);
    const commands = (created as V2.NewSessionResponse).availableCommands;
    if (commands !== undefined) this.#emit({ type: "commands.updated", commands: slashCommands(commands) }, { threadId: state.thread.id });
    await this.#applyConfig(state, this.#withPolicy(input.policy, input.config));
    return { ...state.thread, appliedConfig: this.#currentConfig(state) };
  }

  async resumeThread(input: ResumeThreadInput): Promise<AppliedThread> {
    this.#open();
    const nativeId = "handle" in input.native ? input.native.handle : input.native.id;
    if (nativeId === null || nativeId === "") throw callErrors.validation([{ message: "resumeThread needs a native session id or handle", path: ["native"] }]);
    const agent = await this.#agent();
    const knownId = this.#threadsByNative.get(nativeId);
    const known = knownId === undefined ? undefined : this.#threads.get(knownId);
    const held = known !== undefined && known.generation === this.#generation;
    // A history read changes nothing. ACP opens a session only live (`session/resume`, `session/load`), so it has no read-only history.
    if (input.purpose === "history") {
      if (held) return { ...known.thread, appliedConfig: this.#currentConfig(known) };
      throw callErrors.unsupported("resumeThread.purpose.history", "An ACP agent opens a session only to run it (session/resume or session/load), so the driver cannot read its history without a live runtime");
    }
    if (held) return this.#resumeHeld(agent, known, input);
    const givenCwd = input.policy?.cwd ?? known?.cwd;
    if (givenCwd === undefined || givenCwd === "") {
      throw callErrors.validation([{ message: "an ACP agent resumes a session in a directory: pass policy.cwd", path: ["policy", "cwd"] }]);
    }
    const cwd = await this.#settings.canonicalPath(givenCwd);
    const policy: RuntimePolicy = input.policy ?? known?.policy ?? { mode: "approval_required", interaction: "default", cwd };
    const launch = this.#launchFor(input.launch);
    const servers = this.#mcpFor(launch);
    // The host's launch instructions reach a resumed session as they reach a new one: `system` on the request that
    // opens it (session/resume and session/load take a system prompt too), the rest in its first prompt.
    const instructions = this.#instructions(agent, launch, undefined);
    let reason: string;
    try {
      const resumed = await this.#resumeNative(agent, nativeId, cwd, servers, instructions.systemPrompt ?? known?.systemPrompt);
      const state = known ?? this.#register(nativeId, cwd, { ...policy, cwd }, servers, undefined);
      state.generation = this.#generation;
      this.#giveInstructions(state, instructions);
      if (known !== undefined) this.#emit({ type: "thread.upsert", thread: state.thread }, { threadId: state.thread.id });
      this.#applyResumed(state);
      this.#passMeta(resumed?._meta, "session/resume", "result", nativeId);
      this.#setOptions(state, resumed?.configOptions ?? undefined);
      await this.#applyConfig(state, this.#withPolicy(input.policy, input.config));
      return { ...state.thread, appliedConfig: this.#currentConfig(state) };
    } catch (error) {
      // Only a session the agent reports missing is replaced. ACP has no error for a session another process holds,
      // so any other refusal (and an agent that cannot resume at all) goes to the caller.
      if (!(error instanceof JsonRpcError) || error.code !== ACP_ERRORS.resourceNotFound) throw callErrorFrom(error, "session/resume");
      reason = error.message;
    }
    // The agent has no such session: start a fresh one, and say so, because the old context is gone.
    const fresh = await this.#newNative(agent, cwd, servers, instructions.systemPrompt);
    const threadId = deriveId({ kind: "thread", native: strong(fresh.sessionId), identityVersion: ACP_IDENTITY_VERSION });
    this.#emit(
      { type: "session.replaced", previousNativeId: nativeId, reason: `The ACP agent could not resume session ${nativeId}: ${reason}`, contextLost: true, showRuntimeNote: true },
      { threadId },
    );
    const state = this.#register(fresh.sessionId, cwd, { ...policy, cwd }, servers, undefined);
    this.#giveInstructions(state, instructions);
    this.#setOptions(state, fresh.configOptions ?? undefined);
    await this.#applyConfig(state, this.#withPolicy(policy, input.config));
    return { ...state.thread, appliedConfig: this.#currentConfig(state) };
  }

  /**
   * A resume of a session this ARI session holds open. Its config and policy
   * take effect as on a turn (`session/set_config_option`); its first-prompt
   * instructions go at the top of the next prompt. ACP fixes a session's MCP
   * servers and system prompt when it opens it, so a resume that brings other
   * ones is refused, as is any change while a turn runs.
   */
  async #resumeHeld(agent: AcpConnection, thread: ThreadState, input: ResumeThreadInput): Promise<AppliedThread> {
    const launch = input.launch === undefined ? undefined : this.#launchFor(input.launch);
    const instructions = launch === undefined ? undefined : this.#instructions(agent, launch, undefined);
    if (launch !== undefined && JSON.stringify(this.#mcpFor(launch)) !== JSON.stringify(thread.mcp)) {
      throw callErrors.invalidState("session_open", `ACP fixes a session's MCP servers when it opens it, and session ${thread.nativeId} is open: a resume cannot change them`);
    }
    if (instructions?.systemPrompt !== undefined && JSON.stringify(instructions.systemPrompt) !== JSON.stringify(thread.systemPrompt)) {
      throw callErrors.invalidState("session_open", `ACP takes a session's system prompt when it opens it, and session ${thread.nativeId} is open: a resume cannot change it`);
    }
    const changes = input.config !== undefined || input.policy !== undefined || (instructions?.firstMessage.length ?? 0) > 0;
    if (changes && thread.active !== undefined) throw callErrors.invalidState("turn_active", `Thread ${thread.thread.id} runs a turn; resume it with new settings once the turn ends`);
    if (instructions !== undefined) this.#giveInstructions(thread, instructions);
    if (input.policy !== undefined) thread.policy = { ...input.policy, cwd: thread.cwd };
    await this.#applyConfig(thread, this.#withPolicy(input.policy, input.config));
    return { ...thread.thread, appliedConfig: this.#currentConfig(thread) };
  }

  async forkThread(input: ForkThreadInput): Promise<Thread> {
    this.#open();
    const capabilities = this.capabilities();
    if (!capabilities.threads.fork.supported) throw callErrors.unsupported("threads.fork");
    if (input.at.type === "turn") throw callErrors.unsupported("threads.fork.fromTurn");
    if (input.at.type === "item") throw callErrors.unsupported("threads.fork.fromItem");
    const source = this.#thread(input.threadId);
    const cwd = input.cwd === undefined ? source.cwd : await this.#settings.canonicalPath(input.cwd);
    const crossesDirectory = cwd !== source.cwd;
    if (crossesDirectory && !capabilities.threads.fork.crossCwd) throw callErrors.unsupported("threads.fork.crossCwd");
    const agent = await this.#agent();
    await this.#ensureLoaded(agent, source);
    const params = { sessionId: source.nativeId, cwd, mcpServers: mcpServers(agent.version, source.mcp) };
    let forked: V1.ForkSessionResponse | V2.ForkSessionResponse;
    try {
      forked = agent.version === 1 ? await agent.requestV1("session/fork", params as V1.ForkSessionRequest) : await agent.requestV2("session/fork", params as V2.ForkSessionRequest);
    } catch (error) {
      if (crossesDirectory && error instanceof JsonRpcError) {
        // ACP lets an agent refuse a fork into another directory. From now on the session declares it.
        this.#forkAcrossDirectories = false;
        this.#refreshCapabilities();
        throw callErrors.unsupported("threads.fork.crossCwd", `The ACP agent refused to fork into ${cwd}: ${error.message}`);
      }
      throw callErrorFrom(error, "session/fork");
    }
    const policy = input.policy ?? { ...source.policy, cwd };
    const state = this.#register(forked.sessionId, cwd, policy, source.mcp, undefined, { threadId: source.thread.id });
    this.#passMeta(forked._meta, "session/fork", "result", forked.sessionId);
    this.#setOptions(state, forked.configOptions ?? undefined);
    await this.#applyConfig(state, this.#withPolicy(policy, input.config));
    return state.thread;
  }

  canRelease(): boolean {
    return false;
  }

  async release(): Promise<void> {
    throw callErrors.unsupported("sessions.release");
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
    if (input.intent !== "start") return { status: "unsupported", capability: `turns.${input.intent}` };
    if ((input.context?.synthetic ?? []).length > 0) return { status: "unsupported", capability: "context.syntheticContext" };
    if (thread.active !== undefined) throw callErrors.invalidState("previous_turn_active", "A turn is still running on this thread");
    const agent = await this.#agent();
    await this.#ensureLoaded(agent, thread);
    const policy = input.policy ?? thread.policy;
    await this.#applyConfig(thread, this.#withPolicy(input.policy, input.config));
    const instructions = [...thread.pendingInstructions, ...[input.context?.system, input.context?.developer].filter((text): text is string => text !== undefined && text !== "")];
    const blocks = await this.#promptBlocks(agent, input.content);
    const prompt = instructions.length === 0 ? blocks : [{ type: "text" as const, text: instructions.join("\n\n") }, ...blocks];
    thread.pendingInstructions = [];
    const sent: SentPrompt = { sent: contentText(prompt), instructions: instructions.join("\n\n"), hostText: promptText(input.content) };
    const turn = this.#openTurn(thread, "user", { clientTurnKey: input.clientTurnKey, hostTag: input.hostTag, policy, prompt: sent });

    if (agent.version === 1) {
      // v1: the response to session/prompt is the end of the turn.
      agent.requestV1("session/prompt", { sessionId: thread.nativeId, prompt: prompt as V1.ContentBlock[] }).then(
        (response) => {
          this.#passMeta(response._meta, "session/prompt", "result", thread.nativeId);
          this.#finish(turn, response.stopReason, undefined);
        },
        (error: unknown) => {
          if (turn.settled) return;
          this.#settle(turn, "failed", failureFromError(error, "The agent failed the turn."));
        },
      );
      return { status: "accepted", turnId: turn.id, accepted: "started" };
    }

    // v2: the response only says the prompt was accepted; the turn ends on the idle state.
    try {
      const response = await agent.requestV2("session/prompt", { sessionId: thread.nativeId, prompt: prompt as V2.ContentBlock[], idempotencyKey: input.clientTurnKey });
      this.#passMeta(response._meta, "session/prompt", "result", thread.nativeId);
      return { status: "accepted", turnId: turn.id, accepted: "started", providerMessageId: response.messageId };
    } catch (error) {
      // An error response means the agent never inserted the prompt.
      if (!turn.settled) this.#settle(turn, "failed", failureFromError(error, "The agent did not accept the prompt."));
      throw callErrorFrom(error, "session/prompt");
    }
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    this.#open();
    const turn = this.#turnsById.get(input.turnId);
    if (turn === undefined || turn.settled) return;
    const thread = this.#thread(turn.threadId);
    const agent = this.#current;
    if (agent === undefined) return;
    if (input.restartRuntime === true) {
      // Stop by ending the process; the threads load again on the next call.
      this.#current = undefined;
      this.#connection = undefined;
      await agent.close();
      this.#settle(turn, "interrupted");
      return;
    }
    if (agent.version === 1) {
      await agent.notifyV1("session/cancel", { sessionId: thread.nativeId });
      // ACP v1: after session/cancel the client answers every pending permission request of the session as cancelled.
      for (const pending of [...this.#requests.values()]) if (pending.threadId === thread.thread.id && !pending.resolved) this.#abandon(pending);
      return;
    }
    // ACP v2: the agent cancels the permission requests the cancelled work no longer needs.
    await agent.notifyV2("session/cancel", { sessionId: thread.nativeId });
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
    // Reply with the agent's own option id, never a label.
    const option = (pending.request.options ?? []).find((candidate) => candidate.optionId === input.optionId);
    if (option === undefined) throw callErrors.validation([{ message: `the request offers no option ${String(input.optionId)}`, path: ["optionId"] }]);
    pending.resolved = true;
    pending.reply({ outcome: { outcome: "selected", optionId: option.optionId } });
    this.#forgetRequest(pending);
    this.#emit(
      { type: "request.upsert", request: { id: pending.request.id, status: "resolved" } },
      { threadId: pending.threadId, ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }) },
    );
  }

  async planConfigChange(input: PlanConfigChangeInput): Promise<ConfigChangePlan> {
    const thread = this.#thread(input.threadId);
    const unknown = Object.keys(input.changes).filter((key) => !thread.options.has(key));
    if (unknown.length > 0) return { type: "reject", reason: `The agent offers no config option ${unknown.join(", ")}` };
    return { type: "apply_next_turn" };
  }

  async ext(ns: string, method: string, params: unknown): Promise<unknown> {
    this.#open();
    if (ns !== ACP_EXTENSION.ns) throw callErrors.unsupported(`extensions.${ns}`);
    if (!method.startsWith("_")) throw callErrors.validation([{ message: "ACP extension methods start with _", path: ["method"] }]);
    const agent = await this.#agent();
    return agent.extension(method, params).catch((error: unknown) => {
      throw callErrorFrom(error, method);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of [...this.#requests.values()]) if (!pending.resolved) this.#abandon(pending);
    const connection = this.#connection;
    this.#connection = undefined;
    this.#current = undefined;
    if (connection !== undefined) await (await connection.catch(() => undefined))?.close();
    this.#sequencer.close();
  }

  // Internals.

  #open(): void {
    if (this.#closed) throw callErrors.invalidState("session_closed");
  }

  #emit(body: AriEventBody, envelope: { threadId?: string; turnId?: string; hostTag?: string } = {}): void {
    if (this.#sequencer.closed) return;
    this.#sequencer.emit({ body, ...envelope });
  }

  #turnEnvelope(turn: TurnState): { threadId: string; turnId: string; hostTag?: string } {
    return { threadId: turn.threadId, turnId: turn.id, ...(turn.hostTag === undefined ? {} : { hostTag: turn.hostTag }) };
  }

  #thread(threadId: string): ThreadState {
    const thread = this.#threads.get(threadId);
    if (thread === undefined) throw callErrors.notFound({ resource: "thread", id: threadId });
    return thread;
  }

  #refreshCapabilities(): void {
    if (this.#current === undefined) return;
    const offersModel = [...this.#threads.values()].some((thread) => [...thread.options.values()].some((entry) => entry.ari.category === "model"));
    const base = acpCapabilities(this.#current.handshake, { forkAcrossDirectories: this.#forkAcrossDirectories, offersModel });
    const next = this.#settings.adjustCapabilities?.(base) ?? base;
    const changed = this.#capabilities !== undefined && JSON.stringify(next) !== JSON.stringify(this.#capabilities);
    this.#capabilities = next;
    if (changed) this.#emit({ type: "capabilities.updated", capabilities: next });
  }

  #launchFor(threadLaunch: LaunchContext | undefined): LaunchContext {
    const session = this.#input.launch ?? {};
    const thread = threadLaunch ?? {};
    return {
      appendSystemPrompt: [...(session.appendSystemPrompt ?? []), ...(thread.appendSystemPrompt ?? [])],
      developerPrompt: [...(session.developerPrompt ?? []), ...(thread.developerPrompt ?? [])],
      mcpServers: [...(session.mcpServers ?? []), ...(thread.mcpServers ?? [])],
      dynamicTools: [...(session.dynamicTools ?? []), ...(thread.dynamicTools ?? [])],
    };
  }

  /** The host's MCP servers, checked against the transports the agent accepts. Their names stay exactly as the host chose them. */
  #mcpFor(launch: LaunchContext): LaunchMcpServer[] {
    if ((launch.dynamicTools ?? []).length > 0) throw callErrors.unsupported("tools.dynamicTools");
    const servers = launch.mcpServers ?? [];
    const accepted = this.capabilities().mcp.acceptsHostServers;
    for (const server of servers) {
      if (!accepted.includes(server.transport)) {
        throw callErrors.unsupported("mcp.acceptsHostServers", `The ACP agent does not accept ${server.transport} MCP servers (server ${server.name})`);
      }
    }
    return [...servers];
  }

  async #promptBlocks(agent: AcpConnection, content: readonly ContentBlock[]): Promise<Array<V1.ContentBlock | V2.ContentBlock>> {
    const blocks: Array<V1.ContentBlock | V2.ContentBlock> = [];
    const images = acceptsImages(agent.version, agent.handshake.agentCapabilities);
    for (const block of content) {
      if (block.type === "text") blocks.push({ type: "text", text: block.text });
      else if (block.type === "resource_link") {
        blocks.push({
          type: "resource_link",
          uri: block.uri,
          name: block.name ?? block.uri,
          ...(block.mimeType === undefined ? {} : { mimeType: block.mimeType }),
          ...(block.description === undefined ? {} : { description: block.description }),
          ...(block.size === undefined ? {} : { size: block.size }),
        } as V1.ContentBlock);
      } else if (block.type === "image" && images && block.data !== undefined) {
        const image = imageBlock(block);
        if (image !== undefined) blocks.push(image);
      } else if (block.type === "image" && block.url !== undefined) {
        blocks.push({ type: "resource_link", uri: block.url, name: "image", ...(block.mimeType === undefined ? {} : { mimeType: block.mimeType }) } as V1.ContentBlock);
      } else {
        // A file, or an image the host stores: the agent gets a link to the host's copy. A path grants no access by itself.
        const ref = block.type === "file" ? block.attachmentRef : block.type === "image" ? block.attachmentRef : undefined;
        if (ref === undefined) throw callErrors.validation([{ message: "an image needs data, url or attachmentRef", path: ["content"] }]);
        const resolved = await this.#host.attachments.resolve(ref);
        if (resolved === null) throw callErrors.attachmentUnreadable(ref, `The host cannot provide attachment ${ref}`);
        const name = block.type === "file" ? (block.name ?? resolved.path.split("/").pop() ?? ref) : (resolved.path.split("/").pop() ?? ref);
        blocks.push({ type: "resource_link", uri: `file://${resolved.path}`, name, mimeType: resolved.mime, size: resolved.size } as V1.ContentBlock);
      }
    }
    return blocks;
  }

  async #newNative(agent: AcpConnection, cwd: string, servers: readonly LaunchMcpServer[], systemPrompt: SystemPrompt | undefined): Promise<V1.NewSessionResponse | V2.NewSessionResponse> {
    const params = { cwd, mcpServers: mcpServers(agent.version, servers), ...(systemPrompt === undefined ? {} : { systemPrompt }) };
    try {
      return agent.version === 1 ? await agent.requestV1("session/new", params as V1.NewSessionRequest) : await agent.requestV2("session/new", params as V2.NewSessionRequest);
    } catch (error) {
      throw callErrorFrom(error, "session/new");
    }
  }

  /**
   * Loads a stored native session into the running agent, without replaying its history as live output. A v2 agent's
   * current-state snapshot, and what follows it, is held for `#applyResumed` once the caller has registered the thread.
   */
  async #resumeNative(
    agent: AcpConnection,
    nativeId: string,
    cwd: string,
    servers: readonly LaunchMcpServer[],
    systemPrompt: SystemPrompt | undefined,
  ): Promise<{ _meta?: { [key: string]: unknown } | null; configOptions?: AcpConfigOption[] | null } | undefined> {
    const params = { sessionId: nativeId, cwd, mcpServers: mcpServers(agent.version, servers), ...(systemPrompt === undefined ? {} : { systemPrompt }) };
    this.#replaying.add(nativeId);
    try {
      if (agent.version === 2) return await agent.requestV2("session/resume", params as V2.ResumeSessionRequest);
      const method = v1ResumeMethod(agent.handshake);
      if (method === undefined) throw callErrors.unsupported("acp.session/resume", "The ACP agent cannot resume or load sessions");
      if (method === "session/resume") return await agent.requestV1("session/resume", params as V1.ResumeSessionRequest);
      return (await agent.requestV1("session/load", params as V1.LoadSessionRequest)) ?? undefined;
    } catch (error) {
      this.#resumed.delete(nativeId);
      throw error;
    } finally {
      this.#replaying.delete(nativeId);
    }
  }

  /** Applies, in order, what a v2 agent sent from its resume snapshot on, now that the session's thread is registered. */
  #applyResumed(thread: ThreadState): void {
    const held = this.#resumed.get(thread.nativeId);
    if (held === undefined) return;
    this.#resumed.delete(thread.nativeId);
    const version = this.#current?.version ?? this.#settings.maxProtocolVersion;
    for (const params of held) this.#onUpdate(version, params);
  }

  /** How the host's instructions reach the agent: `system` on the request that opens the session when the agent takes a system prompt, the rest in the first prompt. */
  #instructions(agent: AcpConnection, launch: LaunchContext, context: { readonly system?: string; readonly developer?: string } | undefined): Instructions {
    const systemTexts = [...(launch.appendSystemPrompt ?? []), ...(context?.system === undefined ? [] : [context.system])].filter((text) => text !== "");
    const developerTexts = [...(launch.developerPrompt ?? []), ...(context?.developer === undefined ? [] : [context.developer])].filter((text) => text !== "");
    if (!agentTakesSystemPrompt(agent.handshake)) return { systemPrompt: undefined, firstMessage: [...systemTexts, ...developerTexts] };
    const systemPrompt: SystemPrompt | undefined = systemTexts.length === 0 ? undefined : { mode: "append", content: [{ type: "text", text: systemTexts.join("\n\n") }] };
    return { systemPrompt, firstMessage: developerTexts };
  }

  /** Keeps a thread's system prompt for reloads, and queues its first-message instructions once. */
  #giveInstructions(thread: ThreadState, instructions: Instructions): void {
    thread.systemPrompt = instructions.systemPrompt ?? thread.systemPrompt;
    thread.pendingInstructions = [...new Set([...thread.pendingInstructions, ...instructions.firstMessage])];
  }

  /** Loads a thread's session again after the agent process was restarted. */
  async #ensureLoaded(agent: AcpConnection, thread: ThreadState): Promise<void> {
    if (thread.generation === this.#generation) return;
    try {
      await this.#resumeNative(agent, thread.nativeId, thread.cwd, thread.mcp, thread.systemPrompt);
    } catch (error) {
      throw callErrors.invalidState("native_session_lost", `The ACP agent could not load session ${thread.nativeId} again after a restart: ${error instanceof Error ? error.message : String(error)}`);
    }
    thread.generation = this.#generation;
    this.#applyResumed(thread);
  }

  #register(nativeId: string, cwd: string, policy: RuntimePolicy, servers: readonly LaunchMcpServer[], title: string | undefined, forkedFrom?: Thread["forkedFrom"]): ThreadState {
    const id = deriveId({ kind: "thread", native: strong(nativeId), identityVersion: ACP_IDENTITY_VERSION });
    const thread: Thread = {
      id,
      native: strong(nativeId),
      cwd,
      status: "idle",
      handle: nativeId,
      identityVersion: ACP_IDENTITY_VERSION,
      ...(title === undefined ? {} : { title }),
      ...(forkedFrom === undefined ? {} : { forkedFrom }),
    };
    const state: ThreadState = {
      thread,
      nativeId,
      cwd,
      policy,
      mcp: servers,
      pendingInstructions: [],
      systemPrompt: undefined,
      options: new Map(),
      active: undefined,
      generation: this.#generation,
      nextTurnOrdinal: 0,
    };
    this.#threads.set(id, state);
    this.#threadsByNative.set(nativeId, id);
    this.#emit({ type: "thread.upsert", thread }, { threadId: id });
    return state;
  }

  #setOptions(thread: ThreadState, options: readonly AcpConfigOption[] | undefined): void {
    if (options === undefined) return;
    thread.options.clear();
    for (const option of options) thread.options.set(configOptionId(option), { acp: option, ari: configOption(option, this.#settings.configDependencies) });
    const mapped = [...thread.options.values()].map((entry) => entry.ari);
    this.#settings.onConfigOptions?.(mapped);
    this.#emit({ type: "config.updated", options: mapped }, { threadId: thread.thread.id });
    // switchModel follows whether the agent offers a model option.
    this.#refreshCapabilities();
  }

  /** The host's config values, after the values a flavor derives from the policy (the host's own values win). */
  #withPolicy(policy: RuntimePolicy | undefined, config: ConfigValues | undefined): ConfigValues | undefined {
    const derived = policy === undefined ? undefined : this.#settings.policyConfig?.(policy);
    if (derived === undefined) return config;
    return { ...derived, ...(config ?? {}) };
  }

  #currentConfig(thread: ThreadState): ConfigValues {
    const values: ConfigValues = {};
    for (const [id, entry] of thread.options) values[id] = entry.ari.current;
    return values;
  }

  /** Sets the config values the agent offers as options, with session/set_config_option. */
  async #applyConfig(thread: ThreadState, config: ConfigValues | undefined): Promise<void> {
    if (config === undefined) return;
    const agent = await this.#agent();
    for (const [configId, value] of Object.entries(config)) {
      const entry = thread.options.get(configId);
      if (entry === undefined || JSON.stringify(entry.ari.current) === JSON.stringify(value)) continue;
      const boolean = entry.ari.type === "boolean";
      if (boolean ? typeof value !== "boolean" : typeof value !== "string") {
        throw callErrors.validation([{ message: `config option ${configId} takes a ${boolean ? "boolean" : "value id"}`, path: ["config", configId] }]);
      }
      try {
        const response =
          agent.version === 1
            ? await agent.requestV1("session/set_config_option", (boolean ? { sessionId: thread.nativeId, configId, type: "boolean", value } : { sessionId: thread.nativeId, configId, value }) as V1.SetSessionConfigOptionRequest)
            : await agent.requestV2("session/set_config_option", (boolean ? { sessionId: thread.nativeId, configId, type: "boolean", value } : { sessionId: thread.nativeId, configId, type: "id", value }) as V2.SetSessionConfigOptionRequest);
        this.#passMeta(response._meta, "session/set_config_option", "result", thread.nativeId);
        this.#setOptions(thread, response.configOptions ?? undefined);
      } catch (error) {
        throw callErrorFrom(error, "session/set_config_option");
      }
    }
  }

  #openTurn(thread: ThreadState, origin: "user" | "provider_initiated", host: { clientTurnKey?: string; hostTag?: string | undefined; policy: RuntimePolicy; prompt?: SentPrompt }): TurnState {
    const ordinal = thread.nextTurnOrdinal;
    thread.nextTurnOrdinal += 1;
    // ACP has no turn ids: a turn is its position in this session's thread.
    const native: NativeRef = { id: null, strength: "none", ordinal };
    const id = deriveId({ kind: "turn", native, identityVersion: ACP_IDENTITY_VERSION, scope: `${this.id}/${thread.thread.id}` });
    const turn: TurnState = {
      id,
      threadId: thread.thread.id,
      hostTag: host.hostTag,
      policy: host.policy,
      settled: false,
      sawActive: false,
      status: "running",
      messages: new Map(),
      anonymousRun: undefined,
      tools: new Map(),
      plans: new Map(),
      unclaimedPrompt: undefined,
      userMessages: new Map(),
      nextItemOrdinal: 1,
      nextRequestOrdinal: 0,
    };
    thread.active = turn;
    this.#turnsById.set(id, turn);
    const envelope = this.#turnEnvelope(turn);
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
          ...(host.clientTurnKey === undefined ? {} : { clientTurnKey: host.clientTurnKey }),
          ...(host.hostTag === undefined ? {} : { hostTag: host.hostTag }),
        },
      },
      envelope,
    );
    if (host.prompt !== undefined) {
      const promptNative: NativeRef = { id: null, strength: "none", ordinal: 0 };
      const promptId = deriveId({ kind: "item", native: promptNative, identityVersion: ACP_IDENTITY_VERSION, scope: id });
      turn.unclaimedPrompt = { itemId: promptId, text: host.prompt.hostText, native: "", replaced: false, prompt: host.prompt };
      this.#emit({ type: "item.upsert", item: { id: promptId, kind: "user_message", native: promptNative, status: "completed", turnId: id, text: host.prompt.hostText } }, envelope);
    }
    return turn;
  }

  /** Ends a turn: settles what it left open, then emits its status and its one `turn.terminal`. */
  #settle(turn: TurnState, status: "completed" | "interrupted" | "failed", failure?: Failure, disposition: "reusable" | "broken" = "reusable"): void {
    const thread = this.#threads.get(turn.threadId);
    if (thread?.active === turn) thread.active = undefined;
    if (turn.settled) return;
    turn.settled = true;
    const envelope = this.#turnEnvelope(turn);
    const itemStatus = status === "completed" ? "completed" : status;
    this.#endMessages(turn);
    for (const tool of turn.tools.values()) {
      if (tool.settled) continue;
      tool.settled = true;
      this.#emit({ type: "item.upsert", item: { id: tool.itemId, status: itemStatus } }, envelope);
    }
    for (const plan of turn.plans.values()) {
      if (plan.settled) continue;
      plan.settled = true;
      this.#emit({ type: "item.upsert", item: { id: plan.itemId, status: itemStatus } }, envelope);
    }
    for (const pending of [...this.#requests.values()]) if (pending.turnId === turn.id && !pending.resolved) this.#abandon(pending);
    this.#emit({ type: "turn.upsert", turn: { id: turn.id, status, completedAt: new Date().toISOString(), ...(failure === undefined ? {} : { failure }) } }, envelope);
    this.#emit({ type: "turn.terminal", turnId: turn.id, status, ...(failure === undefined ? {} : { failure }), threadDisposition: disposition }, envelope);
  }

  #finish(turn: TurnState, stopReason: string | null | undefined, error: { code?: unknown; message?: unknown } | null | undefined): void {
    if (turn.settled) return;
    const outcome = stopOutcome(stopReason, error);
    if (outcome.notice !== undefined) this.#emit({ type: "notice", level: "warning", code: `acp.stop.${String(stopReason)}`, text: outcome.notice }, this.#turnEnvelope(turn));
    this.#settle(turn, outcome.status, outcome.failure);
  }

  #itemId(turn: TurnState, native: NativeRef): string {
    return deriveId({ kind: "item", native, identityVersion: ACP_IDENTITY_VERSION, scope: turn.id });
  }

  /** Settles every message of the turn: ACP has no end-of-message signal, so the next other update, or the turn's end, ends them. */
  #endMessages(turn: TurnState, except?: string): void {
    for (const [key, message] of turn.messages) {
      if (key === except || message.settled) continue;
      message.settled = true;
      this.#emit({ type: "item.upsert", item: { id: message.itemId, status: "completed", [message.field]: message.text } }, this.#turnEnvelope(turn));
    }
    if (except === undefined || except !== turn.anonymousRun) turn.anonymousRun = undefined;
  }

  #message(turn: TurnState, kind: "assistant_message" | "reasoning", messageId: string | null | undefined): { key: string; message: MessageState | undefined; native: NativeRef } {
    const label = kind === "assistant_message" ? "agent_message" : "agent_thought";
    if (messageId !== null && messageId !== undefined && messageId !== "") {
      // Message ids are unique per message type, so the type goes into the reference.
      const key = `${label}:${messageId}`;
      return { key, message: turn.messages.get(key), native: { id: messageId, strength: "weak", fingerprint: label } };
    }
    const runKey = turn.anonymousRun;
    if (runKey !== undefined && runKey.startsWith(`${label}#`)) {
      const message = turn.messages.get(runKey);
      if (message !== undefined && !message.settled) return { key: runKey, message, native: { id: null, strength: "none", ordinal: 0 } };
    }
    const ordinal = turn.nextItemOrdinal;
    turn.nextItemOrdinal += 1;
    return { key: `${label}#${ordinal}`, message: undefined, native: { id: null, strength: "none", ordinal } };
  }

  #messageChunk(turn: TurnState, kind: "assistant_message" | "reasoning", messageId: string | null | undefined, text: string): void {
    const { key, message, native } = this.#message(turn, kind, messageId);
    this.#endMessages(turn, key);
    if (messageId === null || messageId === undefined || messageId === "") turn.anonymousRun = key;
    const envelope = this.#turnEnvelope(turn);
    const field = kind === "assistant_message" ? "text" : "reasoning";
    if (message === undefined) {
      const itemId = this.#itemId(turn, native);
      turn.messages.set(key, { itemId, field, text, settled: false });
      this.#emit({ type: "item.upsert", item: { id: itemId, kind, native, status: "running", turnId: turn.id, [field]: text } }, envelope);
      return;
    }
    message.text += text;
    // A chunk after the message settled is an upsert of its whole text, never a delta.
    if (message.settled) this.#emit({ type: "item.upsert", item: { id: message.itemId, [field]: message.text } }, envelope);
    else this.#emit({ type: "item.delta", itemId: message.itemId, field, chunk: text }, envelope);
  }

  /** v2 whole-message upsert: its content replaces what the chunks built, and the message is complete. */
  #wholeMessage(turn: TurnState, kind: "assistant_message" | "reasoning", messageId: string, content: Array<V2.ContentBlock> | null | undefined): void {
    const { key, message, native } = this.#message(turn, kind, messageId);
    this.#endMessages(turn, key);
    const envelope = this.#turnEnvelope(turn);
    const field = kind === "assistant_message" ? "text" : "reasoning";
    const text = content === undefined ? message?.text ?? "" : contentText(content);
    if (message === undefined) {
      const itemId = this.#itemId(turn, native);
      turn.messages.set(key, { itemId, field, text, settled: true });
      this.#emit({ type: "item.upsert", item: { id: itemId, kind, native, status: "completed", turnId: turn.id, [field]: text } }, envelope);
      return;
    }
    message.text = text;
    const settles = !message.settled;
    message.settled = true;
    this.#emit({ type: "item.upsert", item: { id: message.itemId, [field]: text, ...(settles ? { status: "completed" } : {}) } }, envelope);
  }

  /** The item's `tool` field, whole: an ARI patch replaces it, so it always carries the stored input and result. */
  #toolInvocation(tool: ToolState): { name: string; input?: unknown; result?: unknown } {
    return { name: tool.name, ...(tool.input === undefined ? {} : { input: tool.input }), ...(tool.rawOutput === undefined ? {} : { result: tool.rawOutput }) };
  }

  /**
   * A tool call update, applied as an ACP v2 patch (`ToolCallUpdate`): an omitted field keeps its value, `null` clears
   * it, a value replaces it, and `[]` clears a collection. A v1 update arrives here without its `null` fields
   * (`v1ToolUpdate`), so under v1 only a value or `[]` changes anything.
   */
  #tool(turn: TurnState, update: AcpToolCall, appendContent?: ToolCallContent): void {
    this.#endMessages(turn);
    const envelope = this.#turnEnvelope(turn);
    const limit = this.#input.payloadLimits?.maxToolOutputBytes;
    const withDiffs = this.#input.emitDiffs !== false;
    let tool = turn.tools.get(update.toolCallId);
    const content = appendContent !== undefined ? [...(tool?.content ?? []), appendContent] : update.content === undefined ? (tool?.content ?? []) : (update.content ?? []);
    const rawOutput = update.rawOutput === undefined ? tool?.rawOutput : (update.rawOutput ?? undefined);
    const outputText = rawOutput === undefined ? toolContentText(content) : typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
    const output = limit === undefined ? { text: outputText, truncated: false } : truncateUtf8(outputText, limit);
    const changes = toolFileChanges(content, withDiffs);
    const paths = update.locations === undefined ? undefined : (update.locations ?? []).map((location) => location.path);
    if (tool === undefined) {
      const kind = toolItemKind(update.kind);
      const native = strong(update.toolCallId);
      tool = {
        itemId: this.#itemId(turn, native),
        kind,
        name: update.title ?? update.name ?? "tool",
        input: update.rawInput ?? undefined,
        rawOutput,
        output: output.text,
        truncated: output.truncated,
        content: [...content],
        changes,
        settled: false,
      };
      turn.tools.set(update.toolCallId, tool);
      const status = toolItemStatus(update.status);
      tool.settled = TERMINAL_ITEM_STATUSES.has(status);
      this.#emit(
        {
          type: "item.upsert",
          item: {
            id: tool.itemId,
            kind,
            native,
            status,
            turnId: turn.id,
            ...(update.title === undefined || update.title === null ? {} : { title: update.title }),
            tool: this.#toolInvocation(tool),
            ...(output.text === "" ? {} : { output: output.text }),
            ...(output.truncated ? { truncated: true } : {}),
            ...(paths === undefined || paths.length === 0 ? {} : { paths }),
            ...(changes.length === 0 ? {} : { changes }),
          },
        },
        envelope,
      );
      return;
    }
    const patch: ItemPatch = { id: tool.itemId };
    let toolChanged = false;
    if (update.title !== undefined) {
      // A new title also names the tool; a cleared title leaves the name it had.
      patch.title = update.title;
      if (update.title !== null && update.title !== tool.name) {
        tool.name = update.title;
        toolChanged = true;
      }
    }
    if (update.rawInput !== undefined) {
      tool.input = update.rawInput ?? undefined;
      toolChanged = true;
    }
    if (update.rawOutput !== undefined) {
      tool.rawOutput = rawOutput;
      toolChanged = true;
    }
    if (toolChanged) patch.tool = this.#toolInvocation(tool);
    tool.content = [...content];
    if (output.text !== tool.output) {
      tool.output = output.text;
      patch.output = output.text;
    }
    if (output.truncated !== tool.truncated) {
      tool.truncated = output.truncated;
      patch.truncated = output.truncated;
    }
    if (paths !== undefined) patch.paths = paths.length === 0 ? null : paths;
    if (JSON.stringify(changes) !== JSON.stringify(tool.changes)) {
      tool.changes = changes;
      patch.changes = changes.length === 0 ? null : changes;
    }
    if (update.status !== undefined && update.status !== null && !tool.settled) {
      const status = toolItemStatus(update.status);
      patch.status = status;
      tool.settled = TERMINAL_ITEM_STATUSES.has(status);
    }
    if (Object.keys(patch).length > 1) this.#emit({ type: "item.upsert", item: patch }, envelope);
  }

  /**
   * v2 user message upserts (`UserMessage`): a `user_message` with `content` replaces the message, a chunk appends to
   * it, and a new message id starts empty. The first one in a turn the host started is the agent's copy of the prompt
   * the driver sent, so it updates that turn's user item (`userItemText` keeps the driver's instructions out of it);
   * later ones open their own user items.
   */
  #userMessage(turn: TurnState, update: { sessionUpdate: string; messageId?: unknown; content?: unknown }): void {
    const messageId = typeof update.messageId === "string" ? update.messageId : undefined;
    if (messageId === undefined) return;
    const envelope = this.#turnEnvelope(turn);
    let message = turn.userMessages.get(messageId);
    if (message === undefined && turn.unclaimedPrompt !== undefined) {
      message = turn.unclaimedPrompt;
      turn.unclaimedPrompt = undefined;
      turn.userMessages.set(messageId, message);
    }
    const opened = message === undefined;
    if (message === undefined) {
      this.#endMessages(turn);
      message = { itemId: this.#itemId(turn, { id: messageId, strength: "weak", fingerprint: "user_message" }), text: "", native: "", replaced: false };
      turn.userMessages.set(messageId, message);
    }
    if (update.sessionUpdate === "user_message") {
      if (update.content !== undefined) {
        message.native = contentText((update.content ?? []) as V2.ContentBlock[]);
        message.replaced = true;
      }
    } else message.native += contentText([update.content as V2.ContentBlock]);
    const text = userItemText(message);
    if (opened) {
      message.text = text;
      const native: NativeRef = { id: messageId, strength: "weak", fingerprint: "user_message" };
      this.#emit({ type: "item.upsert", item: { id: message.itemId, kind: "user_message", native, status: "completed", turnId: turn.id, text } }, envelope);
      return;
    }
    if (text === message.text) return;
    message.text = text;
    this.#emit({ type: "item.upsert", item: { id: message.itemId, text } }, envelope);
  }

  #plan(turn: TurnState, planId: string | null, kind: "todo_list" | "proposed_plan", payload: { todos?: ReturnType<typeof todos>; plan?: string }, removed = false): void {
    this.#endMessages(turn);
    const envelope = this.#turnEnvelope(turn);
    const key = planId ?? "";
    let plan = turn.plans.get(key);
    if (plan === undefined) {
      if (removed) return;
      const native: NativeRef = planId === null ? { id: null, strength: "none", ordinal: turn.nextItemOrdinal++ } : { id: planId, strength: "weak", fingerprint: "plan" };
      plan = { itemId: this.#itemId(turn, native), settled: false };
      turn.plans.set(key, plan);
      this.#emit({ type: "item.upsert", item: { id: plan.itemId, kind, native, status: "running", turnId: turn.id, ...payload } }, envelope);
      return;
    }
    if (removed && !plan.settled) {
      plan.settled = true;
      this.#emit({ type: "item.upsert", item: { id: plan.itemId, status: "cancelled" } }, envelope);
      return;
    }
    this.#emit({ type: "item.upsert", item: { id: plan.itemId, ...payload } }, envelope);
  }

  #passMeta(meta: unknown, method: string, source: string, nativeSessionId?: string, extra: { updateKind?: string; nativeEntityId?: string; threadId?: string; turnId?: string } = {}): void {
    if (meta === null || meta === undefined || typeof meta !== "object" || Array.isArray(meta)) return;
    const version = this.#current?.version ?? this.#settings.maxProtocolVersion;
    const { threadId, turnId, ...fields } = extra;
    this.#emit(
      {
        type: "x:acp.meta",
        data: { protocolVersion: version, method, source, ...(nativeSessionId === undefined ? {} : { nativeSessionId }), ...fields, meta: meta },
        fallback: { title: "Agent metadata", text: `Vendor _meta on ${method} (${source})` },
      },
      { ...(threadId === undefined ? {} : { threadId }), ...(turnId === undefined ? {} : { turnId }) },
    );
  }

  #passUpdate(nativeSessionId: string, update: unknown, envelope: { threadId?: string; turnId?: string }): void {
    const version = this.#current?.version ?? this.#settings.maxProtocolVersion;
    const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
    this.#emit(
      { type: "x:acp.update", data: { protocolVersion: version, nativeSessionId, update: update }, fallback: { title: "Agent update", text: `An ACP ${String(kind)} update` } },
      envelope,
    );
  }

  #onNotification(connection: AcpConnection, method: string, params: unknown): void {
    if (connection !== this.#current) return;
    if (method === "session/update") {
      this.#onUpdate(connection.version, params as V1.SessionNotification | V2.UpdateSessionNotification);
      return;
    }
    if (method === "$/cancel_request") {
      // The agent no longer needs an answer to one of its requests (v2 cancels permission requests this way).
      const requestId = (params as { requestId?: unknown } | null)?.requestId;
      const pending = this.#requestsByRpcId.get(String(requestId));
      if (pending !== undefined && !pending.resolved) this.#abandon(pending);
      return;
    }
    if (method.startsWith("_")) {
      const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
      this.#passUpdate(typeof sessionId === "string" ? sessionId : "", { extensionNotification: method, params }, {});
    }
  }

  #onUpdate(version: AcpVersion, params: V1.SessionNotification | V2.UpdateSessionNotification): void {
    const held = this.#resumed.get(params.sessionId);
    if (held !== undefined) {
      held.push(params);
      return;
    }
    if (version === 2 && this.#replaying.has(params.sessionId) && (params.update as { sessionUpdate?: unknown }).sessionUpdate === "state_update") {
      // ACP v2: resume sends the session's current state after any replay and before its response. It and the
      // updates after it are live; they wait until the thread is registered (`#applyResumed`).
      this.#replaying.delete(params.sessionId);
      this.#resumed.set(params.sessionId, [params]);
      return;
    }
    const threadId = this.#threadsByNative.get(params.sessionId);
    const thread = threadId === undefined ? undefined : this.#threads.get(threadId);
    const update = params.update as { sessionUpdate: string; _meta?: unknown; toolCallId?: unknown; messageId?: unknown };
    const turn = thread?.active;
    const envelope = turn !== undefined ? this.#turnEnvelope(turn) : thread !== undefined ? { threadId: thread.thread.id } : {};
    const entity = typeof update.toolCallId === "string" ? update.toolCallId : typeof update.messageId === "string" ? update.messageId : undefined;
    this.#passMeta(params._meta, "session/update", "params", params.sessionId, { updateKind: update.sessionUpdate, ...envelope });
    this.#passMeta(update._meta, "session/update", "update", params.sessionId, { updateKind: update.sessionUpdate, ...(entity === undefined ? {} : { nativeEntityId: entity }), ...envelope });
    if (thread === undefined) {
      // A session this ARI session does not hold, such as an agent's child session.
      this.#passUpdate(params.sessionId, params.update, {});
      return;
    }
    // History the agent replays for session/load is not live output.
    if (this.#replaying.has(params.sessionId)) return;

    switch (update.sessionUpdate) {
      case "user_message_chunk":
      case "user_message":
        // v1 has no message upserts: the agent echoes the prompt, which the driver reported when the turn started.
        if (version === 1) return;
        break;
      case "available_commands_update": {
        const commands = (params.update as { availableCommands: Array<V1.AvailableCommand | V2.AvailableCommand> }).availableCommands;
        this.#emit({ type: "commands.updated", commands: slashCommands(commands) }, { threadId: thread.thread.id });
        return;
      }
      case "config_option_update":
        this.#setOptions(thread, (params.update as { configOptions: AcpConfigOption[] }).configOptions);
        return;
      case "session_info_update": {
        const title = (params.update as { title?: unknown }).title;
        if (typeof title === "string") {
          thread.thread = { ...thread.thread, title };
          this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id, title } }, { threadId: thread.thread.id });
        }
        return;
      }
      case "state_update":
        if (version === 2) {
          this.#onState(thread, params.update as V2.StateUpdate);
          return;
        }
        break;
      default:
        break;
    }

    if (turn === undefined) {
      this.#passUpdate(params.sessionId, params.update, envelope);
      return;
    }
    switch (update.sessionUpdate) {
      case "user_message_chunk":
      case "user_message":
        this.#userMessage(turn, params.update as { sessionUpdate: string; messageId?: unknown; content?: unknown });
        return;
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const chunk = params.update as V1.ContentChunk | V2.ContentChunk;
        const text = contentText([chunk.content]);
        this.#messageChunk(turn, update.sessionUpdate === "agent_message_chunk" ? "assistant_message" : "reasoning", chunk.messageId, text);
        return;
      }
      case "agent_message":
      case "agent_thought": {
        const message = params.update as V2.AgentMessage;
        this.#wholeMessage(turn, update.sessionUpdate === "agent_message" ? "assistant_message" : "reasoning", message.messageId, message.content);
        return;
      }
      case "tool_call":
      case "tool_call_update":
        // v1: `null` leaves a field as it was; v2: `null` clears it.
        this.#tool(turn, version === 1 ? v1ToolUpdate(params.update as AcpToolCall) : (params.update as AcpToolCall));
        return;
      case "tool_call_content_chunk": {
        const chunk = params.update as V2.ToolCallContentChunk;
        this.#tool(turn, { toolCallId: chunk.toolCallId }, chunk.content as ToolCallContent);
        return;
      }
      case "plan":
        this.#plan(turn, null, "todo_list", { todos: todos((params.update as V1.Plan).entries) });
        return;
      case "plan_update": {
        const plan = (params.update as V1.PlanUpdate | V2.PlanUpdate).plan as { type?: string; planId?: string; entries?: V2.PlanEntry[]; content?: string };
        if (plan.type === "markdown") this.#plan(turn, plan.planId ?? null, "proposed_plan", { plan: plan.content ?? "" });
        else this.#plan(turn, plan.planId ?? null, "todo_list", { todos: todos(plan.entries ?? []) });
        return;
      }
      case "plan_removed":
        this.#plan(turn, (params.update as { planId?: string }).planId ?? null, "todo_list", {}, true);
        return;
      case "usage_update": {
        this.#endMessages(turn);
        const usage = params.update as V1.UsageUpdate | V2.UsageUpdate;
        const cost = usage.cost as { amount?: unknown; currency?: unknown } | null | undefined;
        this.#emit(
          {
            type: "usage.updated",
            usage: {
              scope: "thread",
              contextUsedTokens: usage.used,
              contextMaxTokens: usage.size,
              ...(cost !== null && cost !== undefined && cost.currency === "USD" && typeof cost.amount === "number" ? { costUsd: cost.amount } : {}),
            },
          },
          envelope,
        );
        return;
      }
      case "notice": {
        this.#endMessages(turn);
        const notice = params.update as V1.Notice;
        const level = notice.severity === "error" ? "error" : notice.severity === "warning" ? "warning" : "info";
        this.#emit({ type: "notice", level, text: notice.description === undefined || notice.description === null ? notice.title : `${notice.title}: ${notice.description}` }, envelope);
        return;
      }
      default:
        this.#passUpdate(params.sessionId, params.update, envelope);
        return;
    }
  }

  /** v2 foreground state: `running` and `requires_action` mean work is active, `idle` ends the turn that work belonged to. */
  #onState(thread: ThreadState, state: V2.StateUpdate): void {
    let turn = thread.active;
    if (state.state === "running" || state.state === "requires_action") {
      // Work the agent started on its own (a goal, a follow-up on background work) is a turn the provider started.
      turn ??= this.#openTurn(thread, "provider_initiated", { policy: thread.policy });
      turn.sawActive = true;
      const status = state.state === "running" ? "running" : "waiting";
      if (turn.status !== status) {
        turn.status = status;
        this.#emit({ type: "turn.upsert", turn: { id: turn.id, status } }, this.#turnEnvelope(turn));
      }
      return;
    }
    if (state.state === "idle") {
      // Only an idle state after this turn's work was active ends it; an idle snapshot before that is an earlier state repeated.
      if (turn === undefined || !turn.sawActive) return;
      const idle = state as { stopReason?: string | null; error?: { code?: unknown; message?: unknown } | null };
      this.#finish(turn, idle.stopReason, idle.error);
    }
  }

  #onRequest(connection: AcpConnection, method: string, params: unknown, context: JsonRpcRequestContext): unknown {
    if (connection !== this.#current) throw new JsonRpcError(-32603, "The session closed this connection");
    if (method === "session/request_permission") return this.#onPermission(connection.version, params as V1.RequestPermissionRequest | V2.RequestPermissionRequest, context);
    // The driver offers no client file system, terminal or elicitation, and handles no extension requests.
    throw new JsonRpcError(-32601, `Method not found: ${method}`);
  }

  #onPermission(version: AcpVersion, params: V1.RequestPermissionRequest | V2.RequestPermissionRequest, context: JsonRpcRequestContext): Promise<V1.RequestPermissionResponse | V2.RequestPermissionResponse> {
    const threadId = this.#threadsByNative.get(params.sessionId);
    const thread = threadId === undefined ? undefined : this.#threads.get(threadId);
    if (thread === undefined) return Promise.resolve(CANCELLED_OUTCOME);
    const turn = thread.active;
    let toolCall: AcpToolCall | undefined;
    let command: string[] | undefined;
    let cwd = thread.cwd;
    let title: string | undefined;
    if (version === 1) toolCall = (params as V1.RequestPermissionRequest).toolCall;
    else {
      const v2 = params as V2.RequestPermissionRequest;
      title = v2.title;
      const subject = v2.subject as { type?: string; toolCall?: V2.ToolCallUpdate; command?: unknown; cwd?: unknown; toolCallId?: unknown } | null | undefined;
      if (subject?.type === "tool_call") toolCall = subject.toolCall;
      if (subject?.type === "command") {
        if (typeof subject.command === "string") command = [subject.command];
        if (typeof subject.cwd === "string") cwd = subject.cwd;
        if (typeof subject.toolCallId === "string") toolCall = { toolCallId: subject.toolCallId };
      }
    }
    const known = toolCall === undefined || turn === undefined ? undefined : turn.tools.get(toolCall.toolCallId);
    const rawCommand = (toolCall?.rawInput as { command?: unknown } | undefined)?.command;
    if (command === undefined && typeof rawCommand === "string") command = [rawCommand];
    if (command === undefined && Array.isArray(rawCommand) && rawCommand.every((part) => typeof part === "string")) command = [...(rawCommand as string[])];
    const toolKind = toolCall?.kind ?? undefined;
    const knownKind = known?.kind === "command_execution" ? "execute" : known?.kind === "file_change" ? "edit" : known?.kind === "file_read" ? "read" : undefined;
    const kind = toolKind === undefined && knownKind === undefined && command !== undefined ? "command" : requestKindForTool(toolKind ?? knownKind);
    const options = requestOptions(params.options);
    const scope = turn?.id ?? thread.thread.id;
    const ordinal = turn === undefined ? 0 : turn.nextRequestOrdinal++;
    // ACP permission requests have no id of their own; the tool call they guard and their order identify them.
    const native: NativeRef = { id: toolCall?.toolCallId ?? null, strength: "weak", ordinal };
    const paths = (toolCall?.locations ?? []).map((location) => location.path);
    const request: Request = {
      id: deriveId({ kind: "request", native, identityVersion: ACP_IDENTITY_VERSION, scope }),
      native,
      kind,
      origin: { threadId: thread.thread.id, ...(turn === undefined ? {} : { turnId: turn.id }), ...(known === undefined ? {} : { itemId: known.itemId }) },
      subject: {
        cwd,
        ...(command === undefined ? {} : { command }),
        ...(paths.length === 0 ? {} : { paths }),
        ...(toolCall === undefined ? {} : { tool: { name: toolCall.title ?? known?.name ?? title ?? "tool", ...(toolCall.rawInput === undefined ? {} : { input: toolCall.rawInput }) } }),
      },
      options,
      allowCustomAnswer: false,
      allowFeedback: false,
      response: { mode: "live" },
      survivesRestart: false,
      status: "pending",
    };
    const envelope = turn === undefined ? { threadId: thread.thread.id } : this.#turnEnvelope(turn);
    this.#passMeta(params._meta, "session/request_permission", "params", params.sessionId, envelope);
    for (const option of params.options) this.#passMeta(option._meta, "session/request_permission", "option", params.sessionId, { nativeEntityId: option.optionId, ...envelope });

    // Under full_access the driver answers itself, with the narrowest accepting option only.
    const policy = turn?.policy ?? thread.policy;
    if (policy.mode === "full_access") {
      const narrowest = narrowestAccepting(options);
      if (narrowest !== undefined) {
        this.#emit({ type: "request.upsert", request: { ...request, status: "resolved" } }, envelope);
        return Promise.resolve({ outcome: { outcome: "selected", optionId: narrowest.optionId } });
      }
    }

    return new Promise((resolve) => {
      const pending: PendingRequest = { request, threadId: thread.thread.id, turnId: turn?.id, rpcId: context.id, reply: resolve, inFlight: undefined, resolved: false };
      this.#requests.set(request.id, pending);
      if (context.id !== null) this.#requestsByRpcId.set(String(context.id), pending);
      context.signal.addEventListener("abort", () => this.#abandon(pending), { once: true });
      this.#emit({ type: "request.upsert", request }, envelope);
    });
  }

  #forgetRequest(pending: PendingRequest): void {
    if (pending.rpcId !== null) this.#requestsByRpcId.delete(String(pending.rpcId));
  }

  /** Answers a request the host can no longer answer as cancelled, and says so. */
  #abandon(pending: PendingRequest): void {
    if (pending.resolved) return;
    pending.resolved = true;
    pending.reply(CANCELLED_OUTCOME);
    this.#forgetRequest(pending);
    this.#emit(
      { type: "request.upsert", request: { id: pending.request.id, status: "cancelled" } },
      { threadId: pending.threadId, ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }) },
    );
  }

  /** The agent connection, starting the agent when none runs. */
  #agent(): Promise<AcpConnection> {
    this.#connection ??= this.#spawn().catch((error: unknown) => {
      this.#connection = undefined;
      throw error;
    });
    return this.#connection;
  }

  async #spawn(): Promise<AcpConnection> {
    const launch = await this.#settings.launch();
    let connection: AcpConnection | undefined;
    const opened = await AcpConnection.open(
      this.#host,
      launch,
      {
        maxProtocolVersion: this.#settings.maxProtocolVersion,
        timeoutMs: this.#input.handshakeTimeoutMs ?? 120_000,
        ...(this.#settings.onProtocolAnswer === undefined ? {} : { onAnswer: this.#settings.onProtocolAnswer }),
      },
      {
        onNotification: (method, params) => {
          if (connection !== undefined) this.#onNotification(connection, method, params);
        },
        onRequest: (method, params, context) => {
          if (connection === undefined) throw new JsonRpcError(-32603, "The connection is not ready");
          return this.#onRequest(connection, method, params, context);
        },
        onExit: (exit, byDriver) => {
          if (connection !== undefined) this.#onExit(connection, exit, byDriver);
        },
      },
    );
    connection = opened;
    this.#generation += 1;
    this.#current = opened;
    this.#refreshCapabilities();
    this.#passMeta(opened.handshake.meta, "initialize", "result");
    return opened;
  }

  #onExit(connection: AcpConnection, exit: ProcessExit, byDriver: boolean): void {
    if (byDriver || connection !== this.#current) return;
    this.#current = undefined;
    this.#connection = undefined;
    const message = `The ACP agent exited (${exit.code === null ? `signal ${String(exit.signal)}` : `code ${exit.code}`}).`;
    for (const thread of this.#threads.values()) {
      const active = thread.active;
      if (active !== undefined) this.#settle(active, "failed", { class: "transport_error", message, retryable: true }, "broken");
    }
    for (const pending of [...this.#requests.values()]) if (!pending.resolved) this.#abandon(pending);
    this.#emit({ type: "notice", level: "error", code: "acp.agent_exited", text: message });
  }
}

