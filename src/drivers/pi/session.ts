// A Pi session: one `pi --mode rpc` process per thread (Pi runs one session
// file per process, and a process keeps the working directory, system prompt
// and runtime mode it started with). Parked or exited processes start again
// with `--session <file>` when the thread is next used.
//
// How the driver keeps Pi's quirks:
// - A turn settles only on `agent_settled` (Pi will not continue on its own)
//   or on the process exiting; never on a timer, and never on `agent_end`,
//   which retries, compaction or queued messages can follow.
// - A steer goes to Pi's `steer` command. Pi queues a steer even when no run
//   is active and delivers it with the next prompt, so after sending it the
//   driver asks `get_state`: a steer still pending in an idle session missed
//   its turn, is removed with `clear_queue`, and the host gets
//   `prompt_required`.
// - Resume, rollback and forks use Pi's session files: `--session <file>`,
//   `/ari-rewind` (the bridge's `navigateTree`, persisted as a label entry),
//   and `--fork <file>` run in the destination directory, because a fork
//   made over RPC keeps the source's working directory.
// - Pi writes a session file only once it holds a message, and
//   `--session <file>` of a missing file starts a new session at that path.
//   So before the driver stops an idle process, the bridge's `/ari-persist`
//   writes Pi's header for a session Pi has not written, and every restart
//   checks that Pi reopened the thread's own session id; a different one is
//   an error, never a silent new thread.
// - The driver opens only session files under its state directory's
//   `sessions`. Pi records `--append-system-prompt` text in the session file
//   it opens, so resuming a file the user's own pi keeps (under ~/.pi) would
//   write host instructions there; such a resume is refused.
// - Extension UI dialogs (`select`, `confirm`, `input`, `editor`) become
//   `Request`s; the bridge's approval dialogs become approvals with their
//   native option ids.

import { callErrors, toCallError } from "../../errors.ts";
import { EventSequencer } from "../../driver-kit/sequencer.ts";
import { truncateUtf8 } from "../../driver-kit/truncate.ts";
import type { Capabilities } from "../../generated/capabilities.ts";
import type { ConfigValues, ContentBlock } from "../../generated/common.ts";
import type { ConfigChangePlan, RuntimePolicy } from "../../generated/config.ts";
import type { AriEvent, AriEventBody } from "../../generated/events.ts";
import type { OpenSessionInput } from "../../generated/instance.ts";
import type { Failure } from "../../generated/errors.ts";
import type { ItemPatch } from "../../generated/item.ts";
import type { Question, Request, RequestOption } from "../../generated/request.ts";
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
import { BRIDGE_SETTINGS_VARIABLE, BRIDGE_STATUS_KEY, CONTEXT_COMMAND, MCP_COMMAND, PERSIST_COMMAND, REWIND_COMMAND, parseApprovalTitle } from "./bridge.ts";
import type { BridgeMode, BridgeSettings } from "./bridge.ts";
import { piCapabilities } from "./capabilities.ts";
import type { PiConfig } from "./config.ts";
import { PiCommandError, PiProcess } from "./rpc.ts";
import type { PiRecord } from "./rpc.ts";
import {
  IDENTITY_VERSION,
  failureFromError,
  itemIdFor,
  messageNative,
  messageText,
  messageThinking,
  readTranscript,
  requestIdFor,
  snapshotTurn,
  threadIdFor,
  toolItemFields,
  toolNative,
  toolResultText,
  transcriptTurns,
  turnIdFor,
  turnNative,
} from "./transcript.ts";
import type { PiMessage, Transcript } from "./transcript.ts";

/** What the instance gives each session. */
export interface PiSessionContext {
  readonly host: HostServices<PiConfig>;
  readonly config: PiConfig;
  /** The `pi` executable `resolveExecutable` found. */
  readonly executable: string;
  /** The bridge extension file under the instance's cache directory. */
  readonly bridgeFile: string;
  /** The instance's own environment, without credential variables. */
  readonly environment: { readonly [name: string]: string };
  /** A managed API key from the instance's secrets, passed with `--api-key`. */
  readonly apiKey: string | undefined;
  /** Context windows by `provider/id`, from the instance's catalog. */
  readonly contextWindows: ReadonlyMap<string, number>;
}

const BRIDGE_MODES: ReadonlySet<string> = new Set<BridgeMode>(["read_only", "approval_required", "auto_accept_edits", "full_access"]);
const SUPPORTED_OPTIONS = new Set(["model", "thinking"]);

interface Envelope {
  threadId?: string;
  turnId?: string;
  hostTag?: string;
}

interface ActiveTurn {
  readonly id: string;
  readonly threadId: string;
  readonly hostTag: string | undefined;
  /** Item ordinals: one per user or assistant message of the turn. */
  messages: number;
  promptSeen: boolean;
  /** The ordinal the user message being streamed got at its `message_start`. */
  userOrdinal: number | undefined;
  assistant: { ordinal: number; textItemId?: string; text: string; reasoningItemId?: string; reasoning: string } | undefined;
  /** Open tool items by Pi's tool call id. */
  readonly tools: Map<string, { itemId: string; name: string }>;
  readonly openItems: Set<string>;
  lastAssistant: PiMessage | undefined;
  compactions: number;
  compactionItemId: string | undefined;
  settled: boolean;
}

/** How a thread's Pi process is started, kept so a parked thread starts the same way again. */
interface Launch {
  readonly cwd: string;
  readonly mode: BridgeMode;
  readonly systemPrompts: readonly string[];
  readonly launchMcpServers: NonNullable<LaunchContext["mcpServers"]>;
  model: string | undefined;
  thinking: string | undefined;
}

interface PiThread {
  thread: Thread;
  policy: RuntimePolicy;
  readonly launch: Launch;
  process: PiProcess | undefined;
  starting: Promise<PiProcess> | undefined;
  /** User-message entries in the session file, in append order: the next prompt's turn ordinal. */
  userMessages: number;
  /** Ordinals of user messages this session saw delivered as steers. */
  readonly steerOrdinals: Set<number>;
  active: ActiveTurn | undefined;
  unloaded: boolean;
}

interface PendingRequest {
  readonly request: Request;
  readonly threadId: string;
  readonly turnId: string | undefined;
  readonly uiRequestId: string;
  readonly reply: (input: RespondInput) => PiRecord;
  inFlight: string | undefined;
  resolved: boolean;
}

/** One process as it starts: records that arrive before its thread is known wait here. */
interface ProcessSlot {
  thread: PiThread | undefined;
  cwd: string | undefined;
  readonly early: PiRecord[];
}

/** A Pi process after its handshake. */
interface Started {
  readonly process: PiProcess;
  readonly slot: ProcessSlot;
  readonly sessionId: string;
  readonly sessionFile: string;
  /** Pi's own working directory, as the bridge reported it. */
  readonly cwd: string;
  readonly applied: ConfigValues;
  readonly transcript: Transcript;
}

function piModelSlug(model: unknown): string | undefined {
  if (typeof model !== "object" || model === null) return undefined;
  const { provider, id } = model as { provider?: unknown; id?: unknown };
  return typeof provider === "string" && typeof id === "string" ? `${provider}/${id}` : undefined;
}

function splitModel(slug: string): { provider: string; modelId: string } {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) throw callErrors.validation([{ message: `a Pi model is "provider/id", got "${slug}"`, path: ["config", "model"] }]);
  return { provider: slug.slice(0, slash), modelId: slug.slice(slash + 1) };
}

/** How long a stopping process may take to answer `/ari-persist` before it is stopped anyway. */
const PERSIST_TIMEOUT_MS = 10_000;

/** The segments of an absolute path with `.` and `..` resolved, or undefined for a relative path. */
function absoluteSegments(file: string): string[] | undefined {
  const slashed = file.replace(/\\/g, "/");
  if (!slashed.startsWith("/") && !/^[A-Za-z]:\//.test(slashed)) return undefined;
  const segments: string[] = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments;
}

/** True when `file` is an absolute path inside `directory`. Pi resolves a relative path against its own directory, so that counts as outside. */
function isInsideDirectory(file: string, directory: string): boolean {
  const inner = absoluteSegments(file);
  const outer = absoluteSegments(directory);
  if (inner === undefined || outer === undefined || inner.length <= outer.length) return false;
  return outer.every((segment, index) => inner[index] === segment);
}

/** Pi reads a `--session` argument as a path when it has a slash or ends in `.jsonl`, and as a session id otherwise (Pi's main.js resolveSessionPath). */
function isSessionPath(argument: string): boolean {
  return argument.includes("/") || argument.includes("\\") || argument.endsWith(".jsonl");
}

/** The session id Pi put in a session file's name (`<timestamp>_<id>.jsonl`, Pi docs session-format.md). */
function sessionIdInFileName(file: string): string | undefined {
  return /_([A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/.exec(file)?.[1];
}

function systemPrompts(launch: LaunchContext | undefined, context: CreateThreadInput["context"] | undefined): string[] {
  // Pi has one host instruction channel, the system prompt (`--append-system-prompt`),
  // so developer text goes there too.
  return [...(launch?.appendSystemPrompt ?? []), ...(launch?.developerPrompt ?? []), ...(context?.system === undefined ? [] : [context.system]), ...(context?.developer === undefined ? [] : [context.developer])];
}

function commandError(error: unknown, what: string): Error {
  if (toCallError(error) !== undefined) return error as Error;
  if (error instanceof PiCommandError) {
    if (/already processing|while the agent is running/i.test(error.message)) return callErrors.invalidState("previous_turn_active", error.message);
    if (/api key|authentication|\/login|not logged in/i.test(error.message)) return callErrors.authRequired([], error.message);
    if (/not found/i.test(error.message)) return callErrors.notFound({ resource: what, message: error.message });
    return callErrors.protocol(`pi refused ${error.command}`, error.message);
  }
  return callErrors.transport(error instanceof Error ? error.message : String(error));
}

export class PiSession implements Session {
  readonly id: string;
  readonly #context: PiSessionContext;
  readonly #input: OpenSessionInput;
  readonly #capabilities: Capabilities = piCapabilities();
  readonly #sequencer: EventSequencer;
  readonly #threads = new Map<string, PiThread>();
  readonly #turnThreads = new Map<string, { threadId: string; ordinal: number }>();
  readonly #requests = new Map<string, PendingRequest>();
  readonly #responses = new Map<string, Promise<void>>();
  readonly #turnKeys = new Map<string, Promise<StartTurnResult>>();
  #handled = 0;
  #closed = false;

  constructor(context: PiSessionContext, input: OpenSessionInput, id: string) {
    this.id = id;
    this.#context = context;
    this.#input = input;
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
    const launch = this.#launchFor(input.cwd, input.policy, input.config, input.launch, input.context);
    const started = await this.#start(launch, []);
    const thread = await this.#register(started, input.policy, launch, input.title === undefined ? {} : { title: input.title });
    if (input.title !== undefined) await started.process.request({ type: "set_session_name", name: input.title }).catch(() => undefined);
    return { ...thread.thread, appliedConfig: started.applied };
  }

  async resumeThread(input: ResumeThreadInput): Promise<AppliedThread> {
    this.#open();
    const target = "handle" in input.native ? input.native.handle : input.native.id;
    if (target === null || target === "") throw callErrors.validation([{ message: "resumeThread needs a native id or handle", path: ["native"] }]);
    // A bare id resolves inside --session-dir only; a path could name a file the user's own pi keeps.
    const sessionsDirectory = `${this.#context.host.paths.stateDir}/sessions`;
    if (isSessionPath(target) && !isInsideDirectory(target, sessionsDirectory)) {
      throw callErrors.validation(
        [{ message: `The Pi driver resumes only session files under ${sessionsDirectory}. Pi writes a thread's launch instructions into the session file it opens, so it will not open ${target}.`, path: ["native", "handle" in input.native ? "handle" : "id"] }],
        "The Pi session file is outside the driver's state directory",
      );
    }
    const known = [...this.#threads.values()].find((candidate) => candidate.thread.handle === target || candidate.thread.native.id === target);
    if (known !== undefined && !known.unloaded && known.process !== undefined) return known.thread;

    const policy = input.policy ?? known?.policy ?? { mode: "approval_required", interaction: "default", cwd: known?.thread.cwd ?? "" };
    const cwd = policy.cwd !== "" ? policy.cwd : (known?.thread.cwd ?? "");
    if (cwd === "") throw callErrors.validation([{ message: "resuming a Pi session this session does not know needs policy.cwd", path: ["policy", "cwd"] }]);
    const launch = this.#launchFor(cwd, policy, input.config, input.launch, undefined);
    // A handle names the file, whose name carries the session id; an id is looked up by Pi.
    const expectedId = "handle" in input.native ? sessionIdInFileName(input.native.handle) : input.native.id;
    let failure: unknown;
    try {
      const started = await this.#start(launch, ["--session", target]);
      if (expectedId === undefined || started.sessionId === expectedId) {
        const thread = await this.#register(started, policy, launch, {});
        return { ...thread.thread, appliedConfig: started.applied };
      }
      // Pi starts a new session at a missing path instead of failing: that is not the one asked for.
      await started.process.close();
      failure = `the session file ${target} does not exist`;
    } catch (error) {
      failure = error;
    }
    if (input.policy === undefined) throw toCallError(failure) !== undefined ? (failure as Error) : callErrors.notFound({ resource: "Pi session", id: target });

    // Fall back to a fresh session, and say so: the old context is gone.
    const fresh = await this.#start(launch, []);
    const threadId = threadIdFor(fresh.sessionId);
    this.#emit(
      {
        type: "session.replaced",
        previousNativeId: target,
        reason: typeof failure === "string" ? `Pi could not resume the session: ${failure}.` : `Pi could not resume the session: ${failure instanceof Error ? failure.message : String(failure)}`,
        contextLost: true,
        showRuntimeNote: true,
      },
      { threadId },
    );
    const thread = await this.#register(fresh, policy, launch, {});
    return { ...thread.thread, appliedConfig: fresh.applied };
  }

  async readSnapshot(threadId: string): Promise<ThreadSnapshot> {
    this.#open();
    const thread = this.#thread(threadId);
    const transcript = await this.#transcript(thread);
    const turns: ThreadSnapshot["turns"] = [];
    const items: ThreadSnapshot["items"] = [];
    for (const rebuilt of transcriptTurns(transcript, thread.steerOrdinals)) {
      const { turn, items: turnItems } = snapshotTurn(thread.thread.id, thread.thread.cwd, rebuilt);
      const running = thread.active?.id === turn.id;
      turns.push(running ? { ...turn, status: "running" } : turn);
      items.push(...turnItems);
    }
    const requests = [...this.#requests.values()].filter((pending) => pending.threadId === threadId && !pending.resolved).map((pending) => pending.request);
    return { thread: thread.thread, turns, items, requests };
  }

  async forkThread(input: ForkThreadInput): Promise<Thread> {
    this.#open();
    if (input.at.type === "item") throw callErrors.unsupported("threads.fork.fromItem");
    const source = this.#thread(input.threadId);
    if (source.active !== undefined) throw callErrors.invalidState("turn_active", "Pi cannot fork a thread while its turn runs");
    const transcript = await this.#transcript(source);
    // A fork from a turn holds the history before that turn; at latest, everything.
    const target = input.at.type === "turn" ? this.#userEntryOf(source, transcript, input.at.turnId) : transcript.leafId;
    const policy = input.policy ?? (input.cwd === undefined ? source.policy : { ...source.policy, cwd: input.cwd });
    // Without a destination, the fork stays where the source works: Pi's own directory, which a resumed session takes from its file.
    const launch = this.#launchFor(input.cwd ?? source.thread.cwd, policy, input.config, { appendSystemPrompt: [...source.launch.systemPrompts], mcpServers: [...source.launch.launchMcpServers] }, undefined);
    // Pi's CLI copies the session into the directory it runs in; RPC's fork would keep the source's directory.
    const started = transcript.userEntries.length === 0 || source.thread.handle === undefined ? await this.#start(launch, []) : await this.#start(launch, ["--fork", source.thread.handle]);
    const forkTranscript = readTranscript(await started.process.request<{ entries: unknown; leafId: unknown }>({ type: "get_entries" }));
    if (target !== null && target !== forkTranscript.leafId && forkTranscript.entries.some((entry) => entry.id === target)) {
      await this.#rewind(started.process, target);
    }
    const forkedFrom = { threadId: source.thread.id, ...(input.at.type === "turn" ? { turnId: input.at.turnId } : {}) };
    const thread = await this.#register(started, policy, launch, { forkedFrom });
    return thread.thread;
  }

  async rollbackThread(input: RollbackThreadInput): Promise<ThreadSnapshot> {
    this.#open();
    const thread = this.#thread(input.threadId);
    if (thread.active !== undefined) throw callErrors.invalidState("turn_active", "Pi cannot roll back a thread while its turn runs");
    const transcript = await this.#transcript(thread);
    const turns = transcriptTurns(transcript, thread.steerOrdinals);
    // Rolling back to a turn keeps it: the leaf moves to just before the next turn's prompt.
    let cut: string | undefined;
    if (input.to.type === "start") cut = turns[0]?.userEntryId;
    else {
      const turnId = input.to.turnId;
      const ordinal = this.#turnThreads.get(turnId)?.ordinal ?? turns.find((turn) => turnIdFor(thread.thread.id, turnNative(turn.ordinal)) === turnId)?.ordinal;
      const index = turns.findIndex((turn) => turn.ordinal === ordinal);
      if (index === -1) throw callErrors.notFound({ resource: "turn", id: turnId });
      cut = turns[index + 1]?.userEntryId;
    }
    if (cut !== undefined) await this.#rewind(await this.#process(thread), cut);
    const snapshot = await this.readSnapshot(thread.thread.id);
    this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id }, retainedNativeTurnIds: [] }, { threadId: thread.thread.id });
    return snapshot;
  }

  async compactThread(threadId: string): Promise<void> {
    this.#open();
    const thread = this.#thread(threadId);
    if (thread.active !== undefined) throw callErrors.invalidState("turn_active", "Pi compacts a thread only between turns");
    const process = await this.#process(thread);
    await process.request({ type: "compact" }).catch((error: unknown) => {
      throw commandError(error, "native session");
    });
  }

  async unloadThread(threadId: string): Promise<void> {
    this.#open();
    const thread = this.#thread(threadId);
    if (thread.active !== undefined) throw callErrors.invalidState("turn_active");
    await this.#park(thread);
    thread.unloaded = true;
    thread.thread = { ...thread.thread, status: "unloaded" };
    this.#emit({ type: "thread.upsert", thread: { id: threadId, status: "unloaded" } }, { threadId });
  }

  canRelease(): boolean {
    if (this.#closed) return false;
    const busy = [...this.#threads.values()].some((thread) => thread.active !== undefined || thread.starting !== undefined);
    const pending = [...this.#requests.values()].some((request) => !request.resolved);
    return !busy && !pending;
  }

  /** Stops every Pi process; each thread starts its process again with `--session` when next used. */
  async release(): Promise<void> {
    this.#open();
    if (!this.canRelease()) throw callErrors.invalidState("release_vetoed", "A turn, a starting process or a request is still pending");
    for (const thread of this.#threads.values()) await this.#park(thread);
  }

  // -------------------------------------------------------------------------
  // Turns

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
    if (input.intent === "queue") return { status: "unsupported", capability: "turns.queue" };
    if (input.intent !== "start" && input.intent !== "steer") return { status: "unsupported", capability: `turns.${input.intent}` };
    if (input.context?.synthetic !== undefined && input.context.synthetic.length > 0) return { status: "unsupported", capability: "context.syntheticContext" };
    if (input.policy !== undefined && input.policy.mode !== thread.policy.mode) return { status: "unsupported", capability: "runtimePolicy.switchInSession" };
    const prompt = await this.#promptOf(input.content);

    if (input.intent === "steer") return this.#steer(thread, input, prompt);

    if (thread.active !== undefined) throw callErrors.invalidState("previous_turn_active", `Thread ${thread.thread.id} already runs turn ${thread.active.id}`);
    const process = await this.#process(thread);
    await this.#applyConfig(thread, process, input.config);
    const instructions = [input.context?.system, input.context?.developer].filter((value): value is string => value !== undefined && value !== "");
    if (instructions.length > 0) await this.#command(process, CONTEXT_COMMAND, JSON.stringify({ text: instructions.join("\n\n") }));

    const ordinal = thread.userMessages;
    let turnId: string | undefined;
    const response = await process
      .request<{ disposition?: unknown }>({ type: "prompt", message: prompt.message, ...(prompt.images.length === 0 ? {} : { images: prompt.images }) }, (record) => {
        // Runs before the run's first event is handled, so the turn exists for it.
        const data = record["data"] as { disposition?: unknown } | undefined;
        if (data?.disposition === "started") turnId = this.#openTurn(thread, turnNative(ordinal), ordinal, "user", input).id;
      })
      .catch((error: unknown) => {
        throw commandError(error, "native session");
      });
    if (response.disposition === "started" && turnId !== undefined) return { status: "accepted", turnId, accepted: "started" };
    if (response.disposition === "handled") {
      // An extension command consumed the prompt: no run, so the turn ends at once.
      this.#handled += 1;
      const turn = this.#openTurn(thread, { id: null, strength: "weak", ordinal, fingerprint: `handled:${this.#handled}` }, ordinal, "user", input);
      this.#settle(thread, turn, "completed");
      return { status: "accepted", turnId: turn.id, accepted: "started" };
    }
    throw callErrors.invalidState("previous_turn_active", "Pi queued the prompt behind a run the driver did not start");
  }

  async #steer(thread: PiThread, input: StartTurnInput, prompt: { message: string; images: unknown[] }): Promise<StartTurnResult> {
    const active = thread.active;
    if (active === undefined || (input.expectedTurnId !== undefined && input.expectedTurnId !== active.id) || thread.process === undefined) return { status: "prompt_required" };
    if (input.context !== undefined && (input.context.system !== undefined || input.context.developer !== undefined)) return { status: "unsupported", capability: "context.instructionChannels" };
    const process = thread.process;
    try {
      await process.request({ type: "steer", message: prompt.message, ...(prompt.images.length === 0 ? {} : { images: prompt.images }) });
      // Pi queues a steer even when no run is active; one still pending in an idle session missed its turn.
      const state = await process.request<{ isStreaming?: unknown; pendingMessageCount?: unknown }>({ type: "get_state" });
      if (state.isStreaming !== true && typeof state.pendingMessageCount === "number" && state.pendingMessageCount > 0) {
        const cleared = await process.request<{ followUp?: unknown }>({ type: "clear_queue" });
        for (const followUp of Array.isArray(cleared.followUp) ? cleared.followUp : []) await process.request({ type: "follow_up", message: String(followUp) });
        return { status: "prompt_required" };
      }
    } catch (error) {
      // The process ended with the turn; a steer for it has nowhere to go.
      if (toCallError(error)?.code === "transport") return { status: "prompt_required" };
      throw commandError(error, "turn");
    }
    return { status: "accepted", turnId: active.id, accepted: "steered" };
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    this.#open();
    const located = this.#turnThreads.get(input.turnId);
    const thread = located === undefined ? undefined : this.#threads.get(located.threadId);
    const turn = thread?.active;
    if (thread === undefined || turn === undefined || turn.id !== input.turnId || thread.process === undefined) return;
    if (input.restartRuntime === true) {
      await this.#park(thread);
      return;
    }
    // Pi answers `abort` once the session is idle again, after `agent_settled`.
    await thread.process.request({ type: "abort" }).catch((error: unknown) => {
      if (toCallError(error)?.code !== "transport") throw commandError(error, "turn");
    });
  }

  respond(input: RespondInput): Promise<void> {
    this.#open();
    // The same (requestId, responseKey) gets the same outcome and reaches Pi once.
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
    const reply = pending.reply(input);
    const thread = this.#threads.get(pending.threadId);
    if (thread?.process === undefined) throw callErrors.invalidState("request_expired", "The Pi process that asked has stopped");
    await thread.process.send(reply);
    pending.resolved = true;
    this.#emit({ type: "request.upsert", request: { id: pending.request.id, status: "resolved" } }, this.#envelope(pending.threadId, pending.turnId));
  }

  async planConfigChange(input: PlanConfigChangeInput): Promise<ConfigChangePlan> {
    this.#thread(input.threadId);
    const unknown = Object.keys(input.changes).filter((key) => !SUPPORTED_OPTIONS.has(key));
    if (unknown.length > 0) return { type: "reject", reason: `Pi has no option ${unknown.join(", ")}` };
    return { type: "apply_next_turn" };
  }

  contextWindow(model: string): number | undefined {
    return this.#context.contextWindows.get(model);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const thread of this.#threads.values()) await this.#park(thread);
    for (const pending of this.#requests.values()) {
      if (pending.resolved) continue;
      pending.resolved = true;
      this.#emit({ type: "request.upsert", request: { id: pending.request.id, status: "expired" } }, this.#envelope(pending.threadId, pending.turnId));
    }
    this.#emit({ type: "session.state", state: "stopped" });
    this.#sequencer.close();
  }

  // -------------------------------------------------------------------------
  // Processes

  #launchFor(cwd: string, policy: RuntimePolicy, config: ConfigValues | undefined, launch: LaunchContext | undefined, context: CreateThreadInput["context"]): Launch {
    if (!BRIDGE_MODES.has(policy.mode)) throw callErrors.unsupported(`runtimePolicy.modes.${policy.mode}`);
    const merged = { ...this.#input.launch, ...launch };
    if ((merged.dynamicTools ?? []).length > 0) throw callErrors.unsupported("tools.dynamicTools");
    const model = typeof config?.["model"] === "string" ? config["model"] : typeof this.#input.config?.["model"] === "string" ? this.#input.config["model"] : this.#context.config.model;
    const thinking = typeof config?.["thinking"] === "string" ? config["thinking"] : typeof this.#input.config?.["thinking"] === "string" ? this.#input.config["thinking"] : this.#context.config.thinking;
    return {
      cwd,
      mode: policy.mode as BridgeMode,
      systemPrompts: [...systemPrompts(this.#input.launch, undefined), ...systemPrompts(launch, context)],
      launchMcpServers: [...(this.#input.launch?.mcpServers ?? []), ...(launch?.mcpServers ?? [])],
      model,
      thinking,
    };
  }

  /** Starts `pi --mode rpc` for a launch and waits for its handshake: the bridge's status and `get_state`. */
  async #start(launch: Launch, sessionArgs: readonly string[]): Promise<Started> {
    const { host, executable, bridgeFile, environment, apiKey } = this.#context;
    const args = ["--mode", "rpc", "--session-dir", `${host.paths.stateDir}/sessions`, ...sessionArgs];
    if (launch.model !== undefined) args.push("--model", launch.model);
    if (launch.thinking !== undefined) args.push("--thinking", launch.thinking);
    if (apiKey !== undefined && launch.model !== undefined) args.push("--api-key", apiKey);
    for (const prompt of launch.systemPrompts) args.push("--append-system-prompt", prompt);
    args.push("--extension", bridgeFile);
    const settings: BridgeSettings = { mode: launch.mode };
    const spawned = await host.process.spawn({
      command: executable,
      args,
      cwd: launch.cwd,
      env: { ...environment, [BRIDGE_SETTINGS_VARIABLE]: JSON.stringify(settings) },
      purpose: "runtime",
      stdin: "pipe",
    });
    const slot: ProcessSlot = { thread: undefined, cwd: undefined, early: [] };
    const process: PiProcess = new PiProcess(spawned, {
      onRecord: (record) => {
        if (record.type === "extension_ui_request" && record["method"] === "setStatus" && record["statusKey"] === BRIDGE_STATUS_KEY) {
          slot.cwd = this.#statusCwd(record["statusText"]) ?? slot.cwd;
          return;
        }
        if (slot.thread === undefined) slot.early.push(record);
        else this.#onRecord(slot.thread, record);
      },
      onExit: (exit, byDriver) => {
        if (slot.thread !== undefined) this.#onExit(slot.thread, process, exit, byDriver);
      },
    });
    const timeoutMs = this.#input.handshakeTimeoutMs ?? 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const state = await Promise.race([
        process.request<{ sessionId?: unknown; sessionFile?: unknown; model?: unknown; thinkingLevel?: unknown }>({ type: "get_state" }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(callErrors.transport(`pi did not answer get_state within ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      // Pi writes the bridge's session_start status before it reads any command.
      if (slot.cwd === undefined) throw callErrors.protocol("bridge_missing", "The ARI bridge extension did not load in pi");
      if (typeof state.sessionId !== "string" || typeof state.sessionFile !== "string") throw callErrors.protocol("no_session_file", "pi reported no persisted session file");
      const transcript = readTranscript(await process.request<{ entries: unknown; leafId: unknown }>({ type: "get_entries" }));
      const model = piModelSlug(state.model);
      const applied: ConfigValues = { ...(model === undefined ? {} : { model }), ...(typeof state.thinkingLevel === "string" ? { thinking: state.thinkingLevel } : {}) };
      return { process, slot, sessionId: state.sessionId, sessionFile: state.sessionFile, cwd: slot.cwd, applied, transcript };
    } catch (error) {
      await process.close();
      throw toCallError(error) !== undefined ? error : commandError(error, "native session");
    } finally {
      clearTimeout(timer);
    }
  }

  #statusCwd(statusText: unknown): string | undefined {
    if (typeof statusText !== "string") return undefined;
    try {
      const parsed = JSON.parse(statusText) as { cwd?: unknown };
      return typeof parsed.cwd === "string" ? parsed.cwd : undefined;
    } catch {
      return undefined;
    }
  }

  /** Makes a started process the runtime of its thread (new or known), and gives it the host's MCP servers. */
  async #register(started: Started, policy: RuntimePolicy, launch: Launch, extra: Pick<Thread, "title" | "forkedFrom">): Promise<PiThread> {
    const id = threadIdFor(started.sessionId);
    let thread = this.#threads.get(id);
    const snapshot: Thread = {
      ...(thread?.thread ?? {}),
      id,
      native: { id: started.sessionId, strength: "strong" },
      cwd: started.cwd,
      status: "idle",
      handle: started.sessionFile,
      identityVersion: IDENTITY_VERSION,
      ...extra,
    };
    if (thread === undefined) {
      thread = { thread: snapshot, policy, launch, process: started.process, starting: undefined, userMessages: 0, steerOrdinals: new Set(), active: undefined, unloaded: false };
      this.#threads.set(id, thread);
    } else {
      thread.thread = snapshot;
      thread.policy = policy;
      thread.process = started.process;
      thread.unloaded = false;
    }
    thread.userMessages = started.transcript.userEntries.length;
    if (typeof started.applied["model"] === "string") thread.launch.model = started.applied["model"];
    started.slot.thread = thread;
    for (const record of started.slot.early.splice(0)) this.#onRecord(thread, record);
    this.#emit({ type: "thread.upsert", thread: snapshot }, { threadId: id });
    await this.#giveMcpServers(thread, started.process);
    return thread;
  }

  async #giveMcpServers(thread: PiThread, process: PiProcess): Promise<void> {
    const servers: Array<{ name: string; config: { [field: string]: unknown } }> = thread.launch.launchMcpServers.map((server) => ({ name: server.name, config: this.#piMcpConfig(server, server.alwaysLoad === true) }));
    try {
      const hostServer = await this.#context.host.hostTools.mcpServerFor(thread.thread.id, { transport: "http" });
      servers.push({ name: hostServer.name, config: this.#piMcpConfig(hostServer.config, hostServer.alwaysLoad === true) });
    } catch (error) {
      this.#context.host.diagnostics.log({ level: "warn", msg: `The host gave no tool server for thread ${thread.thread.id}: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (servers.length > 0) await this.#command(process, MCP_COMMAND, JSON.stringify({ servers }));
  }

  /** An ARI MCP server as Pi's `mcpServers` entry (Pi docs, mcp.md): stdio or streamable HTTP; `alwaysLoad` declares its tools to the model directly. */
  #piMcpConfig(server: { transport: string; command?: string; args?: string[]; env?: { [name: string]: string }; cwd?: string; url?: string; headers?: { [name: string]: string } }, alwaysLoad: boolean): { [field: string]: unknown } {
    if (server.transport === "sse") throw callErrors.unsupported("mcp.acceptsHostServers", "Pi does not support the legacy SSE transport");
    const exposure = alwaysLoad ? { exposure: "direct" } : {};
    if (server.transport === "stdio") {
      return { type: "stdio", command: server.command ?? "", ...(server.args === undefined ? {} : { args: server.args }), ...(server.env === undefined ? {} : { env: server.env }), ...(server.cwd === undefined ? {} : { cwd: server.cwd }), ...exposure };
    }
    return { type: "http", url: server.url ?? "", ...(server.headers === undefined ? {} : { headers: server.headers }), ...exposure };
  }

  /** The thread's running process, starting it again with `--session` when it was parked or exited. */
  async #process(thread: PiThread): Promise<PiProcess> {
    if (thread.process !== undefined && !thread.process.exited) return thread.process;
    if (thread.starting !== undefined) return thread.starting;
    const handle = thread.thread.handle;
    if (handle === undefined) throw callErrors.invalidState("no_session_file");
    const nativeId = thread.thread.native.id;
    thread.starting = (async () => {
      const started = await this.#start(thread.launch, ["--session", handle]);
      if (started.sessionId !== nativeId) {
        // Pi started a new session at a path with no file. Registering it would send this thread's events to another thread.
        await started.process.close();
        throw callErrors.notFound({ resource: "Pi session", id: nativeId ?? handle, message: `Pi no longer has session ${String(nativeId)} at ${handle}; it would have started session ${started.sessionId} there instead` });
      }
      await this.#register(started, thread.policy, thread.launch, {});
      return started.process;
    })();
    try {
      return await thread.starting;
    } finally {
      thread.starting = undefined;
    }
  }

  /** Stops a thread's process. An idle one first has the bridge write the header of a session Pi has not written, so the thread reopens as itself. */
  async #park(thread: PiThread): Promise<void> {
    const process = thread.process;
    thread.process = undefined;
    if (process === undefined) return;
    if (thread.active === undefined && !process.exited) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.#command(process, PERSIST_COMMAND, ""),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(callErrors.transport(`pi did not answer /${PERSIST_COMMAND} within ${PERSIST_TIMEOUT_MS} ms`)), PERSIST_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        this.#context.host.diagnostics.log({ level: "warn", msg: `Pi could not write the header of thread ${thread.thread.id} before stopping: ${error instanceof Error ? error.message : String(error)}` });
      } finally {
        clearTimeout(timer);
      }
    }
    await process.close();
  }

  async #command(process: PiProcess, name: string, argument: string): Promise<void> {
    const response = await process.request<{ disposition?: unknown }>({ type: "prompt", message: argument === "" ? `/${name}` : `/${name} ${argument}` }).catch((error: unknown) => {
      throw commandError(error, "native session");
    });
    if (response.disposition !== "handled") throw callErrors.protocol("bridge_command", `pi did not run the bridge command /${name}`);
  }

  async #rewind(process: PiProcess, entryId: string): Promise<void> {
    await this.#command(process, REWIND_COMMAND, entryId);
  }

  async #transcript(thread: PiThread): Promise<Transcript> {
    const process = await this.#process(thread);
    return readTranscript(
      await process.request<{ entries: unknown; leafId: unknown }>({ type: "get_entries" }).catch((error: unknown) => {
        throw commandError(error, "native session");
      }),
    );
  }

  /** The user-message entry a turn of this thread started with. */
  #userEntryOf(thread: PiThread, transcript: Transcript, turnId: string): string {
    const ordinal = this.#turnThreads.get(turnId)?.ordinal ?? transcriptTurns(transcript, thread.steerOrdinals).find((turn) => turnIdFor(thread.thread.id, turnNative(turn.ordinal)) === turnId)?.ordinal;
    const entry = ordinal === undefined ? undefined : transcript.userEntries[ordinal];
    if (entry === undefined) throw callErrors.notFound({ resource: "turn", id: turnId });
    return entry;
  }

  async #applyConfig(thread: PiThread, process: PiProcess, config: ConfigValues | undefined): Promise<void> {
    if (config === undefined) return;
    const unknown = Object.keys(config).filter((key) => !SUPPORTED_OPTIONS.has(key));
    if (unknown.length > 0) throw callErrors.validation(unknown.map((key) => ({ message: `Pi has no option ${key}`, path: ["config", key] })));
    try {
      const model = config["model"];
      if (typeof model === "string" && model !== thread.launch.model) {
        await process.request({ type: "set_model", ...splitModel(model) });
        thread.launch.model = model;
      }
      const thinking = config["thinking"];
      if (typeof thinking === "string" && thinking !== thread.launch.thinking) {
        await process.request({ type: "set_thinking_level", level: thinking });
        thread.launch.thinking = thinking;
      }
    } catch (error) {
      throw commandError(error, "model");
    }
  }

  /** The prompt text and images for Pi's `prompt` command. Host files reach Pi as paths; an unreadable one is named as such. */
  async #promptOf(content: readonly ContentBlock[]): Promise<{ message: string; images: Array<{ type: "image"; data: string; mimeType: string }> }> {
    const lines: string[] = [];
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const block of content) {
      if (block.type === "text") lines.push(block.text);
      else if (block.type === "image" && block.data !== undefined) images.push({ type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" });
      else if (block.type === "resource_link") lines.push(block.uri);
      else if (block.type === "image" && block.url !== undefined) lines.push(block.url);
      else if ("attachmentRef" in block && block.attachmentRef !== undefined) {
        const resolved = await this.#context.host.attachments.resolve(block.attachmentRef);
        lines.push(resolved === null ? `(attachment ${block.attachmentRef} could not be read)` : resolved.path);
      }
    }
    if (lines.length === 0 && images.length === 0) throw callErrors.validation([{ message: "a turn needs content", path: ["content"] }]);
    return { message: lines.join("\n"), images };
  }

  // -------------------------------------------------------------------------
  // Events from Pi

  #onRecord(thread: PiThread, record: PiRecord): void {
    const turn = thread.active;
    switch (record.type) {
      case "agent_start":
        // A run the driver did not start (an extension sent a message): a provider-initiated turn.
        if (turn === undefined) this.#openTurn(thread, turnNative(thread.userMessages, true), thread.userMessages, "provider_initiated", undefined);
        return;
      case "message_start":
        this.#onMessageStart(thread, record["message"] as PiMessage | undefined);
        return;
      case "message_update":
        this.#onMessageUpdate(thread, record["assistantMessageEvent"] as { type?: unknown; delta?: unknown } | undefined);
        return;
      case "message_end":
        this.#onMessageEnd(thread, record["message"] as PiMessage | undefined);
        return;
      case "tool_execution_start":
        this.#onToolStart(thread, String(record["toolCallId"]), String(record["toolName"]), record["args"]);
        return;
      case "tool_execution_update": {
        const tool = turn?.tools.get(String(record["toolCallId"]));
        if (turn === undefined || tool === undefined) return;
        this.#emit({ type: "item.upsert", item: { id: tool.itemId, output: this.#capped(toolResultText(record["partialResult"])).text } }, this.#turnEnvelope(turn));
        return;
      }
      case "tool_execution_end":
        this.#onToolEnd(thread, String(record["toolCallId"]), record["result"], record["isError"] === true);
        return;
      case "compaction_start":
        if (turn === undefined || turn.compactionItemId !== undefined) return;
        {
          const native = { id: null, strength: "none" as const, ordinal: turn.compactions, fingerprint: "compaction" };
          turn.compactions += 1;
          turn.compactionItemId = itemIdFor(turn.id, native);
          turn.openItems.add(turn.compactionItemId);
          this.#emit({ type: "item.upsert", item: { id: turn.compactionItemId, kind: "compaction", native, status: "running", turnId: turn.id } }, this.#turnEnvelope(turn));
        }
        return;
      case "compaction_end": {
        if (turn === undefined || turn.compactionItemId === undefined) return;
        const result = record["result"] as { summary?: unknown } | undefined;
        const status = record["aborted"] === true ? "cancelled" : result === undefined ? "failed" : "completed";
        turn.openItems.delete(turn.compactionItemId);
        this.#emit({ type: "item.upsert", item: { id: turn.compactionItemId, status, ...(typeof result?.summary === "string" ? { text: result.summary } : {}) } }, this.#turnEnvelope(turn));
        turn.compactionItemId = undefined;
        return;
      }
      case "auto_retry_start":
        this.#emit(
          { type: "retry", attempt: Number(record["attempt"] ?? 1), maxAttempts: typeof record["maxAttempts"] === "number" ? record["maxAttempts"] : null, retryDelayMs: typeof record["delayMs"] === "number" ? record["delayMs"] : null },
          turn === undefined ? { threadId: thread.thread.id } : this.#turnEnvelope(turn),
        );
        return;
      case "agent_settled":
        if (turn !== undefined) this.#settleFromPi(thread, turn, record["aborted"] === true);
        return;
      case "extension_ui_request":
        this.#onUiRequest(thread, record);
        return;
      case "extension_error":
        this.#emit({ type: "notice", level: "warning", code: "pi_extension_error", text: `A Pi extension failed: ${String(record["error"] ?? "unknown error")}` }, { threadId: thread.thread.id });
        return;
      default:
        return;
    }
  }

  #onMessageStart(thread: PiThread, message: PiMessage | undefined): void {
    const turn = thread.active;
    if (turn === undefined || message === undefined) return;
    if (message.role === "user") {
      turn.userOrdinal = turn.messages;
      turn.messages += 1;
    } else if (message.role === "assistant") {
      turn.assistant = { ordinal: turn.messages, text: "", reasoning: "" };
      turn.messages += 1;
    }
  }

  #onMessageUpdate(thread: PiThread, update: { type?: unknown; delta?: unknown } | undefined): void {
    const turn = thread.active;
    const assistant = turn?.assistant;
    if (turn === undefined || assistant === undefined || update === undefined) return;
    const envelope = this.#turnEnvelope(turn);
    if (update.type === "text_start" || update.type === "text_delta") {
      if (assistant.textItemId === undefined) {
        const native = messageNative(assistant.ordinal);
        assistant.textItemId = itemIdFor(turn.id, native);
        turn.openItems.add(assistant.textItemId);
        this.#emit({ type: "item.upsert", item: { id: assistant.textItemId, kind: "assistant_message", native, status: "running", turnId: turn.id } }, envelope);
      }
      if (update.type === "text_delta" && typeof update.delta === "string" && update.delta !== "") {
        assistant.text += update.delta;
        this.#emit({ type: "item.delta", itemId: assistant.textItemId, field: "text", chunk: update.delta }, envelope);
      }
    } else if (update.type === "thinking_start" || update.type === "thinking_delta") {
      if (assistant.reasoningItemId === undefined) {
        const native = messageNative(assistant.ordinal, "thinking");
        assistant.reasoningItemId = itemIdFor(turn.id, native);
        turn.openItems.add(assistant.reasoningItemId);
        this.#emit({ type: "item.upsert", item: { id: assistant.reasoningItemId, kind: "reasoning", native, status: "running", turnId: turn.id } }, envelope);
      }
      if (update.type === "thinking_delta" && typeof update.delta === "string" && update.delta !== "") {
        assistant.reasoning += update.delta;
        this.#emit({ type: "item.delta", itemId: assistant.reasoningItemId, field: "reasoning", chunk: update.delta }, envelope);
      }
    }
  }

  #onMessageEnd(thread: PiThread, message: PiMessage | undefined): void {
    if (message === undefined) return;
    const turn = thread.active;
    if (message.role === "user") {
      // Every user message is an entry of the session file: count it, turn or not.
      const userOrdinal = thread.userMessages;
      thread.userMessages += 1;
      if (turn === undefined) return;
      const ordinal = turn.userOrdinal ?? turn.messages++;
      turn.userOrdinal = undefined;
      if (turn.promptSeen) thread.steerOrdinals.add(userOrdinal);
      turn.promptSeen = true;
      const native = messageNative(ordinal);
      this.#emit({ type: "item.upsert", item: { id: itemIdFor(turn.id, native), kind: "user_message", native, status: "completed", turnId: turn.id, text: messageText(message.content) } }, this.#turnEnvelope(turn));
      return;
    }
    if (message.role !== "assistant" || turn === undefined) return;
    const assistant = turn.assistant ?? { ordinal: turn.messages++, text: "", reasoning: "" };
    turn.assistant = undefined;
    turn.lastAssistant = message;
    const envelope = this.#turnEnvelope(turn);
    const finalText = messageText(message.content);
    const finalThinking = messageThinking(message.content);
    const itemStatus = message.stopReason === "aborted" ? "interrupted" : message.stopReason === "error" ? "failed" : "completed";
    if (assistant.reasoningItemId !== undefined || finalThinking !== "") {
      const native = messageNative(assistant.ordinal, "thinking");
      const id = assistant.reasoningItemId ?? itemIdFor(turn.id, native);
      turn.openItems.delete(id);
      this.#emit({ type: "item.upsert", item: assistant.reasoningItemId === undefined ? { id, kind: "reasoning", native, status: itemStatus, turnId: turn.id, reasoning: finalThinking } : { id, status: itemStatus, reasoning: finalThinking } }, envelope);
    }
    if (assistant.textItemId !== undefined || finalText !== "") {
      const native = messageNative(assistant.ordinal);
      const id = assistant.textItemId ?? itemIdFor(turn.id, native);
      turn.openItems.delete(id);
      this.#emit({ type: "item.upsert", item: assistant.textItemId === undefined ? { id, kind: "assistant_message", native, status: itemStatus, turnId: turn.id, text: finalText } : { id, status: itemStatus, text: finalText } }, envelope);
    }
    const usage = message.usage as { input?: unknown; output?: unknown; cacheRead?: unknown; totalTokens?: unknown; cost?: { total?: unknown } } | undefined;
    if (usage !== undefined) {
      const model = typeof message.provider === "string" && typeof message.model === "string" ? `${message.provider}/${message.model}` : undefined;
      const contextMaxTokens = model === undefined ? undefined : this.#context.contextWindows.get(model);
      this.#emit(
        {
          type: "usage.updated",
          usage: {
            scope: "turn",
            ...(model === undefined ? {} : { model }),
            ...(typeof usage.input === "number" ? { inputTokens: usage.input } : {}),
            ...(typeof usage.output === "number" ? { outputTokens: usage.output } : {}),
            ...(typeof usage.cacheRead === "number" ? { cachedInputTokens: usage.cacheRead } : {}),
            ...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
            ...(typeof usage.cost?.total === "number" ? { costUsd: usage.cost.total } : {}),
            ...(contextMaxTokens === undefined ? {} : { contextMaxTokens }),
          },
        },
        envelope,
      );
    }
  }

  #onToolStart(thread: PiThread, toolCallId: string, toolName: string, args: unknown): void {
    const turn = thread.active;
    if (turn === undefined || turn.tools.has(toolCallId)) return;
    const native = toolNative(toolCallId);
    const itemId = itemIdFor(turn.id, native);
    turn.tools.set(toolCallId, { itemId, name: toolName });
    turn.openItems.add(itemId);
    this.#emit({ type: "item.upsert", item: { id: itemId, native, status: "running", turnId: turn.id, ...toolItemFields(toolName, args, thread.thread.cwd) } }, this.#turnEnvelope(turn));
  }

  #onToolEnd(thread: PiThread, toolCallId: string, result: unknown, isError: boolean): void {
    const turn = thread.active;
    const tool = turn?.tools.get(toolCallId);
    if (turn === undefined || tool === undefined) return;
    turn.tools.delete(toolCallId);
    turn.openItems.delete(tool.itemId);
    const output = this.#capped(toolResultText(result));
    const patch: ItemPatch = { id: tool.itemId, status: isError ? "failed" : "completed", output: output.text, ...(output.truncated ? { truncated: true } : {}) };
    if (isError) patch.error = { message: output.text === "" ? `${tool.name} failed` : output.text };
    this.#emit({ type: "item.upsert", item: patch }, this.#turnEnvelope(turn));
  }

  #capped(text: string): { text: string; truncated: boolean } {
    const limit = this.#input.payloadLimits?.maxToolOutputBytes;
    return limit === undefined ? { text, truncated: false } : truncateUtf8(text, limit);
  }

  #onUiRequest(thread: PiThread, record: PiRecord): void {
    const method = record["method"];
    const uiRequestId = String(record["id"]);
    const turn = thread.active;
    const envelope = turn === undefined ? { threadId: thread.thread.id } : this.#turnEnvelope(turn);
    if (method === "notify") {
      const level = record["notifyType"] === "error" ? "error" : record["notifyType"] === "warning" ? "warning" : "info";
      this.#emit({ type: "notice", level, code: "pi_extension_notice", text: String(record["message"] ?? "") }, envelope);
      return;
    }
    if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return;
    const title = String(record["title"] ?? "");
    const id = requestIdFor(thread.thread.id, uiRequestId);
    const base: Pick<Request, "id" | "native" | "origin" | "allowCustomAnswer" | "allowFeedback" | "response" | "survivesRestart" | "status"> = {
      id,
      native: { id: uiRequestId, strength: "strong" },
      origin: { threadId: thread.thread.id, ...(turn === undefined ? {} : { turnId: turn.id }) },
      allowCustomAnswer: false,
      allowFeedback: false,
      response: { mode: "live" },
      survivesRestart: false,
      status: "pending",
    };
    const descriptor = method === "select" ? parseApprovalTitle(title) : undefined;
    let request: Request;
    let reply: (input: RespondInput) => PiRecord;
    if (descriptor !== undefined) {
      // The bridge's approval: its options are the native option ids Pi's select returns.
      const options: RequestOption[] = descriptor.options.map((option) => ({ optionId: option.id, label: option.label, decision: option.decision, ...(option.scope === undefined ? {} : { scope: option.scope }) }));
      const input = typeof descriptor.input === "object" && descriptor.input !== null ? (descriptor.input as { [key: string]: unknown }) : {};
      const fields = toolItemFields(descriptor.tool, descriptor.input, thread.thread.cwd);
      request = {
        ...base,
        kind: descriptor.kind === "command" || descriptor.kind === "file_change" ? descriptor.kind : "permission",
        subject: {
          cwd: thread.thread.cwd,
          ...(typeof input["command"] === "string" ? { command: [input["command"]] } : {}),
          ...(fields.paths === undefined ? {} : { paths: fields.paths }),
          tool: { name: descriptor.tool, input: descriptor.input ?? null },
        },
        options,
      };
      reply = (answer) => {
        const chosen = options.find((option) => option.optionId === answer.optionId);
        if (chosen === undefined) throw callErrors.validation([{ message: `no option ${String(answer.optionId)}`, path: ["optionId"] }]);
        return { type: "extension_ui_response", id: uiRequestId, value: chosen.optionId };
      };
    } else {
      // Any other extension's dialog is a question; its native answer shape follows the dialog's method.
      const question: Question =
        method === "select"
          ? { id: uiRequestId, type: "single_select", prompt: title, options: (Array.isArray(record["options"]) ? record["options"] : []).map((option) => ({ id: String(option), label: String(option) })), required: true }
          : method === "confirm"
            ? { id: uiRequestId, type: "single_select", prompt: [title, String(record["message"] ?? "")].filter((part) => part !== "").join("\n\n"), options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], required: true }
            : { id: uiRequestId, type: "text", prompt: title, required: true };
      request = { ...base, kind: "user_input", questions: [question] };
      reply = (answer) => {
        const given = answer.answers?.[uiRequestId];
        if (given === undefined) throw callErrors.validation([{ message: `an answer to question ${uiRequestId} is needed`, path: ["answers", uiRequestId] }]);
        if (method === "confirm") return { type: "extension_ui_response", id: uiRequestId, confirmed: given.optionIds?.[0] === "yes" };
        if (method === "select") {
          const choice = given.optionIds?.[0];
          if (choice === undefined || !(question.options ?? []).some((option) => option.id === choice)) throw callErrors.validation([{ message: "choose one of the options", path: ["answers", uiRequestId, "optionIds"] }]);
          return { type: "extension_ui_response", id: uiRequestId, value: choice };
        }
        return { type: "extension_ui_response", id: uiRequestId, value: given.text ?? "" };
      };
    }
    this.#requests.set(id, { request, threadId: thread.thread.id, turnId: turn?.id, uiRequestId, reply, inFlight: undefined, resolved: false });
    this.#emit({ type: "request.upsert", request }, envelope);
  }

  #onExit(thread: PiThread, process: PiProcess, exit: { code: number | null; signal: string | null }, byDriver: boolean): void {
    if (thread.process === process) thread.process = undefined;
    for (const pending of this.#requests.values()) {
      if (pending.threadId !== thread.thread.id || pending.resolved) continue;
      pending.resolved = true;
      this.#emit({ type: "request.upsert", request: { id: pending.request.id, status: "expired" } }, this.#envelope(pending.threadId, pending.turnId));
    }
    const turn = thread.active;
    if (turn === undefined) return;
    const how = exit.code === null ? `signal ${String(exit.signal)}` : `code ${exit.code}`;
    if (byDriver) this.#settle(thread, turn, "interrupted");
    else {
      // The session file keeps what Pi wrote; the next turn starts pi again with --session.
      this.#settle(thread, turn, "failed", { class: "transport_error", message: `pi exited (${how}) during the turn`, retryable: true });
      this.#emit({ type: "notice", level: "error", code: "pi_exited", text: `pi exited (${how})` }, { threadId: thread.thread.id });
    }
  }

  #openTurn(thread: PiThread, native: Turn["native"], ordinal: number, origin: "user" | "provider_initiated", input: StartTurnInput | undefined): ActiveTurn {
    const id = turnIdFor(thread.thread.id, native);
    const turn: ActiveTurn = {
      id,
      threadId: thread.thread.id,
      hostTag: input?.hostTag,
      messages: 0,
      promptSeen: false,
      userOrdinal: undefined,
      assistant: undefined,
      tools: new Map(),
      openItems: new Set(),
      lastAssistant: undefined,
      compactions: 0,
      compactionItemId: undefined,
      settled: false,
    };
    thread.active = turn;
    this.#turnThreads.set(id, { threadId: thread.thread.id, ordinal });
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

  #settleFromPi(thread: PiThread, turn: ActiveTurn, aborted: boolean): void {
    if (aborted) {
      this.#settle(thread, turn, "interrupted");
      return;
    }
    const last = turn.lastAssistant;
    if (last?.stopReason === "error") {
      this.#settle(thread, turn, "failed", failureFromError(typeof last.errorMessage === "string" && last.errorMessage !== "" ? last.errorMessage : "Pi reported an error"));
      return;
    }
    this.#settle(thread, turn, last?.stopReason === "aborted" ? "interrupted" : "completed");
  }

  /** Ends a turn: settles what it left open and cancels its requests, then emits its status and its one `turn.terminal`. */
  #settle(thread: PiThread, turn: ActiveTurn, status: "completed" | "interrupted" | "failed", failure?: Failure): void {
    if (thread.active === turn) thread.active = undefined;
    if (turn.settled) return;
    turn.settled = true;
    thread.thread = { ...thread.thread, status: thread.unloaded ? "unloaded" : "idle" };
    const envelope = this.#turnEnvelope(turn);
    for (const itemId of turn.openItems) this.#emit({ type: "item.upsert", item: { id: itemId, status: status === "completed" ? "completed" : status } }, envelope);
    turn.openItems.clear();
    for (const pending of this.#requests.values()) {
      if (pending.turnId !== turn.id || pending.resolved) continue;
      pending.resolved = true;
      if (thread.process !== undefined) void thread.process.send({ type: "extension_ui_response", id: pending.uiRequestId, cancelled: true }).catch(() => undefined);
      this.#emit({ type: "request.upsert", request: { id: pending.request.id, status: "cancelled" } }, envelope);
    }
    this.#emit({ type: "turn.upsert", turn: { id: turn.id, status, completedAt: new Date().toISOString(), ...(failure === undefined ? {} : { failure }) } }, envelope);
    this.#emit({ type: "turn.terminal", turnId: turn.id, status, ...(failure === undefined ? {} : { failure }), threadDisposition: "reusable" }, envelope);
  }

  // -------------------------------------------------------------------------
  // Helpers

  #open(): void {
    if (this.#closed) throw callErrors.invalidState("session_closed");
  }

  #thread(threadId: string): PiThread {
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
