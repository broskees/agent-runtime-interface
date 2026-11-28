// A fake `muse` CLI: `muse --version` and `muse serve`, the Muse Session
// Protocol (MSP) host, in memory behind the conformance kit's memory process.
// It stands in for Muse Code (which needs a Muse account) so no test reaches a
// Muse service. The driver under test talks to it through the real
// `@muse-code/sdk` `Connection`.
//
// It imports no driver code. Every frame it builds is typed by the pinned
// SDK's own wire types (@muse-code/sdk 1.4.25, dist/src/msp.js), and every
// frame either side writes is recorded in frames.ts's `FRAME_LOG`, which
// type-checks them against the same types when the test file ends.
//
// Behaviour follows the SDK's documentation and the MSP golden transcripts at
// the SDK repository's 1.4.25 mirror commit (test/drivers/muse/SOURCES.md):
// - the handshake answers `initialize` with the stable schema fingerprint and
//   grants `sessionMcp` when asked (session-start, handshake transcripts);
// - one host is one connection and one process; a loaded session is leased to
//   exactly one host, and another host's `session/resume` fails `sessionInUse`
//   (-32021); an unknown session fails `sessionNotFound` (-32020)
//   (msp-concepts/sessions-and-turns);
// - `session/start` takes the client's `sessionId` and broadcasts
//   `session/started` before its answer (session-start transcript);
// - a fresh turn's id is its `turn/start` `commandId`; a busy session queues
//   by default and starts the queued turn when the running one ends
//   (text-run-single-turn, pending-command-ack-launch,
//   turn-interrupt-queued-successor transcripts);
// - `turn/started`, the `userMessage` item, item start, deltas and completion,
//   then `turn/completed`; failures arrive only as a failed `turn/completed`
//   with a `TurnError` (provider-failure-turn transcript);
// - approvals: the `toolCall` item, `approval/requested`, the
//   `approval/request` server request answered with `{}`, `approval/decide`
//   with the server's `choiceId` and current requirement, `approval/resolved`,
//   then the item settles (approval-round-trip, approval-deny-round-trip);
// - questions: `userInput/requested` and `userInput/request`,
//   `userInput/answer`, `userInput/settled` (userinput-answer-round-trip);
// - `session/resume` lists the unsettled approvals and questions of the
//   session's running turn in `pendingRequests` and re-issues each as its
//   server request right after the answer (the SDK README: "An approval still
//   pending when you resume a session arrives right after the resume reply";
//   userinput-answer-round-trip lines 6-9, a resume of a running session that
//   no live host holds). `parkedSession` stores that starting state;
// - `session/read` and `session/resume` restate the last `turn/completed` as
//   `lastTurn` (msp.d.ts `LastTurn`: "so a reopened session can report a
//   failed last turn");
// - a steer whose turn already ended is refused with -32030 `commandRejected`,
//   reason `already_terminal` (the SDK's facade-control-verbs test "a durably
//   rejected steer retires to the composer"); `refuseSteer` makes the session
//   runtime refuse a steer of the running turn, for example with the
//   retryable `runtime_busy` the SDK changelog documents for `turn/steer`,
//   and `refuseUnqueue` the same for `turn/unqueue`; `stall` holds a request,
//   or its answer, until a test releases it (the SDK sets no deadline on an
//   answer);
// - `turn/interrupt` and `turn/cancel` answer at admission and the turn ends
//   with a `cancelled` terminal (cancel-mid-turn transcript);
// - `session/compact` acks `accepted` and folds a `compaction` item, or acks
//   `noop` with a reason (compact-command transcripts);
// - closing stdin drains: a running turn ends `cancelled`, the session closes
//   with reason `hostShutdown`, leases are released and the process exits 0;
//   a killed or crashed host writes nothing (sessions-and-turns).
//
// What the SDK leaves open, and the fake decides: the fake asks for an
// approval whenever the kit's puppet asks, whatever the approval mode: which
// calls Muse's policy settles without asking is not public.

import type {
  ApprovalChoice,
  ApprovalMode,
  ApprovalSubject,
  ApprovalRequestParams,
  ErrorKind,
  ErrorObject,
  InitializeResult,
  Item,
  LastTurn,
  ModelCatalogEntry,
  MspMethodMap,
  MspNotificationMap,
  MspServerRequestMap,
  PendingRequestPointer,
  Session as MspSession,
  SessionMcpServerConfig,
  SourceRange,
  SubscriptionUsage,
  TokenUsage,
  TurnInputPart,
  UserInputAnswer,
  UserInputQuestion,
  UserInputRequestParams,
} from "@muse-code/sdk/dist/src/msp.js";
import { EXPECTED_SCHEMA_COMPATIBILITY_EPOCH, EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";
import { createMemoryProcess } from "../../../src/conformance/index.ts";
import type { AmbientAuthArrangement, FakeSpawnRequest, NativeApproval, NativeApprovalHandle, NativeFailure, NativeSessionState, NativeTool, NativeTurn } from "../../../src/conformance/index.ts";
import type { MemoryProcess } from "../../../src/conformance/index.ts";
import type { SpawnedProcess } from "../../../src/index.ts";
import { FRAME_LOG, HOSTS_STARTED } from "./frames.ts";
import type { FrameLog, RecordedFrame } from "./frames.ts";

/** The Muse Code version the fake reports: the release the pinned SDK pairs with. */
export const FAKE_MUSE_VERSION = "1.4.25";

/** The catalog `model/list` serves. */
export const FAKE_MODELS: ModelCatalogEntry[] = [
  {
    modelId: "muse-large-2",
    displayLabel: "Muse Large 2",
    providerId: "meta",
    profileId: null,
    releaseDate: "2026-06-01",
    description: null,
    contextLimit: 200000,
    outputLimit: 64000,
    cost: null,
    isActive: false,
    isDefault: true,
    defaultReasoningEffort: "medium",
    variants: ["low", "medium", "high"],
  },
  {
    modelId: "muse-small-1",
    displayLabel: "Muse Small 1",
    providerId: "meta",
    profileId: null,
    releaseDate: "2026-03-01",
    description: "A smaller model.",
    contextLimit: 100000,
    outputLimit: 32000,
    cost: null,
    isActive: false,
    isDefault: false,
    defaultReasoningEffort: "low",
    variants: ["low", "medium"],
  },
];

type MethodName = keyof MspMethodMap;
type Params<M extends MethodName> = MspMethodMap[M]["params"];
type Result<M extends MethodName> = MspMethodMap[M]["result"];

/** A typed MSP error answer. */
class MspFault extends Error {
  readonly error: ErrorObject;
  constructor(code: number, kind: ErrorKind, message: string, data: Omit<NonNullable<ErrorObject["data"]>, "kind"> = {}) {
    super(message);
    this.error = { code, message, data: { kind, ...data } };
  }
}

/** A queue the puppet reads turns from. */
class AsyncQueue<T> {
  readonly #items: T[] = [];
  readonly #waiting: Array<(value: IteratorResult<T, undefined>) => void> = [];
  #ended = false;

  push(item: T): void {
    const waiter = this.#waiting.shift();
    if (waiter !== undefined) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<T, undefined>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiting.push(resolve));
  }
}

/** A promise with its resolver. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface FakeApproval {
  readonly params: ApprovalRequestParams;
  readonly item: Item;
  resolved: boolean;
  readonly replies: string[];
  readonly firstReply: { promise: Promise<string>; resolve: (value: string) => void };
}

interface FakeQuestion {
  readonly params: UserInputRequestParams;
  readonly item: Item;
  settled: boolean;
  readonly answered: { promise: Promise<UserInputAnswer[]>; resolve: (value: UserInputAnswer[]) => void };
}

/** One run (turn) of a session, from its `turn/start` to its terminal. */
interface FakeRun {
  readonly turnId: string;
  readonly commandId: string;
  readonly prompt: string;
  readonly input: TurnInputPart[];
  readonly displayText: string | undefined;
  readonly reasoningEffort: string | undefined;
  /** Muse ended the turn; its `turn/completed` may still be held back. */
  ended: boolean;
  readonly steers: string[];
  readonly steerWaiters: Array<(text: string) => void>;
  readonly stop: { promise: Promise<"cancel" | "exit">; resolve: (value: "cancel" | "exit") => void };
  readonly openItems: Map<string, Item>;
  readonly approvals: Map<string, FakeApproval>;
  readonly questions: Map<string, FakeQuestion>;
  usage: TokenUsage;
}

/** One stored Muse session. */
export interface StoredSession {
  readonly sessionId: string;
  workspaceRoot: string;
  readonly createdAt: string;
  updatedAt: string;
  modelId: string;
  providerId: string;
  approvalMode: ApprovalMode;
  permissionProfile: string | undefined;
  /** The per-session MCP servers of the last start or resume. */
  mcpServers: Record<string, SessionMcpServerConfig>;
  /** The `config` member of every start and resume, in order. */
  readonly configs: unknown[];
  readonly items: Item[];
  /** The prompt of each turn the session ran, oldest first (steers are not turns). */
  readonly turnPrompts: string[];
  turnCount: number;
  compactions: number;
  cursor: number;
  owner: FakeMuseHost | undefined;
  /** Another process holds the session's lease (the puppet's `lockSession`). */
  foreignLock: boolean;
  active: FakeRun | undefined;
  readonly queue: FakeRun[];
  lastRunId: string | undefined;
  /** The last `turn/completed` the session folded, as `session/read` and `session/resume` restate it. */
  lastTurn: LastTurn | undefined;
}

/** A session `parkedSession` stored: its turn waits on one request. */
export interface ParkedSession {
  readonly sessionId: string;
  readonly turnId: string;
  /** The approval id or user-input id the turn waits on. */
  readonly requestId: string;
  /** The answers Muse got to the question. */
  answers(): Promise<UserInputAnswer[]>;
  /** The choice Muse got for the approval. */
  nextReply(): Promise<string>;
}

/** A fresh run: a turn from its `turn/start` (or a parked turn) to its terminal. */
function newRun(commandId: string, input: TurnInputPart[], displayText: string | undefined, reasoningEffort: string | undefined): FakeRun {
  return {
    turnId: commandId,
    commandId,
    // Multiple text parts are joined in order into the turn's prompt.
    prompt: input.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n"),
    input,
    displayText,
    reasoningEffort,
    ended: false,
    steers: [],
    steerWaiters: [],
    stop: deferred<"cancel" | "exit">(),
    openItems: new Map(),
    approvals: new Map(),
    questions: new Map(),
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
  };
}

/** The session's next view cursor. */
function nextCursor(session: StoredSession): string {
  session.cursor += 1;
  return `v10:${session.sessionId}:${session.cursor}`;
}

export interface FakeMuseOptions {
  readonly ambientAuth?: AmbientAuthArrangement;
  readonly version?: string;
  /** Whether `initialize` grants `sessionMcp` when asked. Defaults to true. */
  readonly grantSessionMcp?: boolean;
  /** What `usage/read` reports; absent means nothing observed yet. */
  readonly subscriptionUsage?: SubscriptionUsage;
  /** Where frames are recorded; defaults to the test process's `FRAME_LOG`. */
  readonly log?: FrameLog;
}

/** Every `muse` process and stored session of one rig. */
export class FakeMuseWorld {
  readonly sessions = new Map<string, StoredSession>();
  readonly hosts: FakeMuseHost[] = [];
  readonly turnQueue = new AsyncQueue<FakeMuseTurn>();
  /** Every request a host received, oldest first: method and params. */
  readonly requests: Array<{ method: string; params: unknown }> = [];
  /** The environment and arguments of every `muse` process. */
  readonly launches: Array<{ args: readonly string[]; cwd: string | undefined; environment: { readonly [name: string]: string } }> = [];
  readonly options: FakeMuseOptions;
  readonly log: FrameLog;
  /**
   * Asked for each `turn/steer` of a running turn: a refusal it returns is the
   * session runtime refusing the steer (-32030 `commandRejected` with that
   * reason and retryability), and nothing is written; undefined takes it.
   */
  refuseSteer: (() => { reason: string; retryable: boolean } | undefined) | undefined;
  /** The approval mode the host's configuration gives a session started without one (`SessionStartParams.approvalMode`: "server default when omitted"). */
  defaultApprovalMode: ApprovalMode = "promptUnmatched";
  /** The same for each `turn/unqueue` of a queued turn (the SDK's `Session.run` documents a busy unqueue, `runtime_busy`). */
  refuseUnqueue: (() => { reason: string; retryable: boolean } | undefined) | undefined;
  /**
   * Asked for each request a host receives: `"request"` holds the request
   * unread until `releaseStalled()` (a stalled host); `"reply"` handles it but
   * holds its answer, and the frames the answer comes before, until then. The
   * SDK sets no deadline on an answer, so a held one keeps its call waiting.
   */
  stall: ((method: string) => "request" | "reply" | undefined) | undefined;
  readonly #stalled: Array<() => void> = [];
  readonly #commands = new Map<string, { signature: string; answer: unknown }>();
  #ids = 0;

  constructor(options: FakeMuseOptions = {}) {
    this.options = options;
    this.log = options.log ?? FRAME_LOG;
  }

  /** A fresh UUIDv7-shaped id, deterministic per world. */
  mint(): string {
    this.#ids += 1;
    return `0198f0ac-0000-7000-8000-${this.#ids.toString(16).padStart(12, "0")}`;
  }

  /** Holds a stalled request or answer until `releaseStalled`. */
  holdStalled(resume: () => void): void {
    this.#stalled.push(resume);
  }

  /** Handles the stalled requests and writes the held answers, oldest first. */
  releaseStalled(): void {
    for (const resume of this.#stalled.splice(0)) resume();
  }

  /** A one-record source range on `kind` stream `streamId`. */
  sourceRange(kind: string, streamId: string): SourceRange {
    const id = this.mint();
    const sequence = Number.parseInt(id.slice(-12), 16);
    return { stream: { kind, id: streamId }, first: { id, sequence }, last: { id, sequence } };
  }

  /**
   * Stores a session that no host holds, whose turn waits on a question or an
   * approval: the state the pinned userinput-answer-round-trip transcript
   * resumes (a `running` session, its `activeTurnId`, the turn's user message
   * and its open tool call, one pending request). The next host that resumes
   * it lists the request in `pendingRequests`, re-issues it right after the
   * answer, and hands the turn to the puppet.
   */
  parkedSession(spec: { workspaceRoot: string; prompt: string; waitsOn: "question" | "approval" }): ParkedSession {
    const sessionId = this.mint();
    const now = new Date().toISOString();
    const session: StoredSession = {
      sessionId,
      workspaceRoot: spec.workspaceRoot,
      createdAt: now,
      updatedAt: now,
      modelId: FAKE_MODELS[0]!.modelId,
      providerId: "meta",
      approvalMode: "promptUnmatched",
      permissionProfile: ":ask-me",
      mcpServers: {},
      configs: [],
      items: [],
      turnPrompts: [spec.prompt],
      turnCount: 0,
      compactions: 0,
      cursor: 0,
      owner: undefined,
      foreignLock: false,
      active: undefined,
      queue: [],
      lastRunId: undefined,
      lastTurn: undefined,
    };
    const run = newRun(this.mint(), [{ type: "text", text: spec.prompt }], undefined, undefined);
    session.active = run;
    session.items.push({ itemId: this.mint(), kind: "userMessage", turnId: run.turnId, revision: 1, status: "completed", recordedAt: now, text: spec.prompt, commandId: run.commandId });
    const requestId = this.mint();
    const parked: ParkedSession = {
      sessionId,
      turnId: run.turnId,
      requestId,
      answers: () => run.questions.get(requestId)!.answered.promise,
      nextReply: () => run.approvals.get(requestId)!.firstReply.promise,
    };
    if (spec.waitsOn === "question") {
      const item: Item = { itemId: this.mint(), kind: "toolCall", turnId: run.turnId, revision: 1, status: "inProgress", recordedAt: now, tool: "request_user_input", callId: `call_${requestId.slice(-6)}`, args: JSON.stringify({ questions: [{ id: "db_choice", question: "Which database?" }] }) };
      session.items.push(item);
      run.openItems.set(item.itemId, item);
      const params: UserInputRequestParams = {
        sessionId,
        userInputId: requestId,
        turnId: run.turnId,
        itemId: item.itemId,
        toolCallId: item.callId!,
        toolName: "request_user_input",
        questions: [
          {
            id: "db_choice",
            header: "Database",
            question: "Which database should the new service use?",
            selection: { mode: "single" },
            options: [
              { label: "Postgres", description: "Matches the other services." },
              { label: "SQLite", description: "Zero-ops, single node only." },
            ],
          },
        ],
        autoResolutionMs: 120000,
        sourceRange: this.sourceRange("session", sessionId),
        viewCursor: nextCursor(session),
      };
      run.questions.set(requestId, { params, item, settled: false, answered: deferred<UserInputAnswer[]>() });
    } else {
      const args = JSON.stringify({ command: "npm test" });
      const item: Item = { itemId: this.mint(), kind: "toolCall", turnId: run.turnId, revision: 1, status: "inProgress", recordedAt: now, tool: "shell", callId: `call_${requestId.slice(-6)}`, args, approvalId: requestId };
      session.items.push(item);
      run.openItems.set(item.itemId, item);
      const params: ApprovalRequestParams = {
        sessionId,
        approvalId: requestId,
        turnId: run.turnId,
        taskId: this.mint(),
        itemId: item.itemId,
        toolCallId: item.callId!,
        toolName: "shell",
        rawArgs: args,
        subject: { kind: "shell", command: "npm test", stages: [], workspaceRoot: spec.workspaceRoot },
        currentRequirementId: { approvalId: requestId, sourceIndex: 0 },
        availableChoices: [
          { choiceId: "allow_once", label: "Allow once", decision: "approved", scope: "once" },
          { choiceId: "deny", label: "Deny", decision: "denied", scope: "once", acceptsFeedback: true },
        ],
        protectedWrite: false,
        judgeEscalated: false,
        sourceRange: this.sourceRange("approval.review", requestId),
        viewCursor: nextCursor(session),
      };
      run.approvals.set(requestId, { params, item, resolved: false, replies: [], firstReply: deferred<string>() });
    }
    this.sessions.set(sessionId, session);
    return parked;
  }

  /** What one invocation of the `muse` CLI does. */
  spawn(request: FakeSpawnRequest): SpawnedProcess {
    const args = request.args ?? [];
    this.launches.push({ args, cwd: request.cwd, environment: request.environment });
    if (args[0] === "--version") {
      const process = createMemoryProcess({ onStdin: () => undefined, onStdinClosed: () => undefined, onKill: () => process.exit(null, "SIGTERM") });
      queueMicrotask(() => {
        process.stdout(`muse ${this.options.version ?? FAKE_MUSE_VERSION}\n`);
        process.exit(0, null);
      });
      return process.process;
    }
    if (args[0] === "serve") {
      const host = new FakeMuseHost(this, request.environment);
      this.hosts.push(host);
      HOSTS_STARTED.count += 1;
      return host.process.process;
    }
    const process = createMemoryProcess({ onStdin: () => undefined, onStdinClosed: () => undefined, onKill: () => process.exit(null, "SIGTERM") });
    queueMicrotask(() => {
      process.stderr(`error: unrecognized subcommand '${args[0] ?? ""}'\n`);
      process.exit(2, null);
    });
    return process.process;
  }

  /** Remembers a command's payload and answer, so a replay returns a value-identical ack and a reused id with another payload is refused. */
  dedupe<T>(commandId: string, method: string, params: unknown, run: () => T): T {
    const { commandId: _id, ...rest } = params as { commandId?: string };
    const signature = JSON.stringify([method, rest]);
    const known = this.#commands.get(commandId);
    if (known !== undefined) {
      if (known.signature !== signature) throw new MspFault(-32030, "commandRejected", `commandId ${commandId} was reused with a different payload`, { commandId, reason: "command_id_conflict" });
      return known.answer as T;
    }
    const answer = run();
    this.#commands.set(commandId, { signature, answer });
    return answer;
  }

  /** Marks a stored session as leased by another process. */
  lock(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) session.foreignLock = true;
  }

  /** The native side's view of a session, for `NativeAgent.inspectSession`. */
  inspect(sessionId: string): NativeSessionState | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return undefined;
    return {
      loaded: session.owner !== undefined && !session.owner.process.exited,
      cwd: session.workspaceRoot,
      prompts: [...session.turnPrompts],
      compactions: session.compactions,
      injectedMessages: [],
      backgroundTasks: [],
      subagents: [],
    };
  }

  /** Requests the hosts received for `method`, oldest first. */
  received(method: string): Array<{ [key: string]: unknown }> {
    return this.requests.filter((request) => request.method === method).map((request) => (request.params ?? {}) as { [key: string]: unknown });
  }

  dispose(): void {
    for (const host of this.hosts) host.process.exit(null, "SIGKILL");
    this.turnQueue.end();
  }
}

/** One `muse serve` process: one MSP connection. */
export class FakeMuseHost {
  readonly world: FakeMuseWorld;
  readonly environment: { readonly [name: string]: string };
  readonly process: MemoryProcess;
  #buffer = "";
  #initialized = false;
  #answeredInitialize = false;
  #granted: string[] = [];
  #nextServerRequest = 0;
  readonly #serverRequests = new Map<number, string>();
  readonly #owned = new Set<StoredSession>();

  constructor(world: FakeMuseWorld, environment: { readonly [name: string]: string }) {
    this.world = world;
    this.environment = environment;
    this.process = createMemoryProcess({
      onStdin: (text) => this.#onStdin(text),
      onStdinClosed: () => this.#drain(),
      onKill: (signal) => this.die(null, signal),
    });
  }

  /** The host ends without writing anything: a crash or a kill. The OS releases its leases. */
  die(code: number | null, signal: string | null): void {
    if (this.process.exited) return;
    for (const session of this.#owned) {
      const run = session.active;
      if (run !== undefined) {
        run.ended = true;
        run.stop.resolve("exit");
        session.lastRunId = run.turnId;
      }
      session.active = undefined;
      session.queue.length = 0;
      session.owner = undefined;
    }
    this.#owned.clear();
    this.process.exit(code, signal);
  }

  /** Stdin closed: an orderly drain. A running turn ends cancelled, each session closes, leases are released, the process exits 0. */
  #drain(): void {
    for (const session of [...this.#owned]) {
      const run = session.active;
      if (run !== undefined && !run.ended) {
        run.stop.resolve("exit");
        this.endRun(session, run, { terminal: "cancelled", reason: "host shutdown" });
      }
      session.queue.length = 0;
      this.notify("session/closed", { sessionId: session.sessionId, reason: "hostShutdown", viewCursor: this.cursor(session) });
      session.owner = undefined;
    }
    this.#owned.clear();
    this.process.exit(0, null);
  }

  // Frames.

  #record(frame: RecordedFrame): void {
    this.world.log.record(frame);
  }

  #write(frame: unknown, recorded: Omit<RecordedFrame, "frame">): void {
    if (this.process.exited) return;
    this.#record({ ...recorded, frame });
    this.process.stdout(`${JSON.stringify(frame)}\n`);
  }

  notify<M extends keyof MspNotificationMap>(method: M, params: MspNotificationMap[M]): void {
    this.#write({ jsonrpc: "2.0", method, params, emittedAtMs: Date.now() }, { direction: "server", shape: "notification", method });
  }

  serverRequest<M extends keyof MspServerRequestMap>(method: M, params: MspServerRequestMap[M]["params"]): void {
    this.#nextServerRequest += 1;
    const id = this.#nextServerRequest;
    this.#serverRequests.set(id, method);
    this.#write({ jsonrpc: "2.0", id, method, params }, { direction: "server", shape: "request", method });
  }

  #onStdin(text: string): void {
    this.#buffer += text;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      this.#onLine(line);
    }
  }

  #onLine(line: string): void {
    let frame: { [key: string]: unknown };
    try {
      frame = JSON.parse(line) as { [key: string]: unknown };
    } catch {
      this.#write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error", data: { kind: "parseError" } } }, { direction: "server", shape: "error", method: "(parse)" });
      return;
    }
    const method = typeof frame["method"] === "string" ? frame["method"] : undefined;
    const id = frame["id"];
    if (method === undefined) {
      // A response to one of the host's server requests.
      const answered = typeof id === "number" ? this.#serverRequests.get(id) : undefined;
      if (typeof id === "number") this.#serverRequests.delete(id);
      this.#record({ direction: "client", shape: "error" in frame ? "error" : "result", method: answered ?? "(unknown)", frame });
      return;
    }
    if (id === undefined) {
      this.#record({ direction: "client", shape: "notification", method, frame });
      if (method === "initialized" && this.#answeredInitialize) this.#initialized = true;
      return;
    }
    this.#record({ direction: "client", shape: "request", method, frame });
    const params = frame["params"];
    this.world.requests.push({ method, params });
    const stall = this.world.stall?.(method);
    if (stall === "request") {
      this.world.holdStalled(() => this.#answer(method, id, params, false));
      return;
    }
    this.#answer(method, id, params, stall === "reply");
  }

  /** Handles one request and writes its answer, then the frames the answer comes before; with `hold`, the writing waits for `releaseStalled`. */
  #answer(method: string, id: unknown, params: unknown, hold: boolean): void {
    let write: () => void;
    try {
      const result = this.#handle(method, params as never);
      const after = this.#after;
      write = () => {
        this.#write({ jsonrpc: "2.0", id, result }, { direction: "server", shape: "result", method });
        after?.();
      };
    } catch (error) {
      const fault = error instanceof MspFault ? error : new MspFault(-32603, "internal", error instanceof Error ? error.message : String(error));
      write = () => this.#write({ jsonrpc: "2.0", id, error: fault.error }, { direction: "server", shape: "error", method });
    } finally {
      this.#after = undefined;
    }
    if (hold) this.world.holdStalled(write);
    else write();
  }

  /** Frames a command sends after its answer, as Muse writes view events after the ack. */
  #after: (() => void) | undefined;

  #then(after: () => void): void {
    const previous = this.#after;
    this.#after = () => {
      previous?.();
      after();
    };
  }

  // Requests.

  #handle(method: string, params: never): unknown {
    if (method === "initialize") return this.#initialize(params);
    if (!this.#initialized) throw new MspFault(-32600, "notInitialized", "initialize the connection first");
    switch (method) {
      case "session/start":
        return this.#sessionStart(params);
      case "session/resume":
        return this.#sessionResume(params);
      case "session/read":
        return this.#sessionRead(params);
      case "session/setApprovalMode":
        return this.#setApprovalMode(params);
      case "session/setModel":
        return this.#setModel(params);
      case "session/compact":
        return this.#compact(params);
      case "model/list":
        return this.#modelList(params);
      case "usage/read":
        return this.#usageRead();
      case "turn/start":
        return this.#turnStart(params);
      case "turn/steer":
        return this.#turnSteer(params);
      case "turn/interrupt":
        return this.#turnStop("turn/interrupt", params);
      case "turn/cancel":
        return this.#turnStop("turn/cancel", params);
      case "turn/unqueue":
        return this.#turnUnqueue(params);
      case "approval/decide":
        return this.#approvalDecide(params);
      case "userInput/answer":
        return this.#userInputAnswer(params);
      default:
        throw new MspFault(-32601, "methodNotFound", `the fake Muse host does not serve ${method}`);
    }
  }

  #initialize(params: Params<"initialize">): Result<"initialize"> {
    if (this.#answeredInitialize) throw new MspFault(-32600, "alreadyInitialized", "initialize may be sent once");
    this.#answeredInitialize = true;
    const requested = params.capabilities?.requestedCapabilities ?? [];
    this.#granted = this.world.options.grantSessionMcp === false ? [] : requested.filter((name) => name === "sessionMcp");
    const result: InitializeResult = {
      experimentalApi: false,
      grantedCapabilities: this.#granted,
      museHome: `${this.environment["HOME"] ?? "/home/fake"}/.muse`,
      platformFamily: "unix",
      platformOs: "linux",
      schema: { version: 1, fingerprint: EXPECTED_SCHEMA_FINGERPRINT, compatibilityEpoch: EXPECTED_SCHEMA_COMPATIBILITY_EPOCH },
      serverInfo: { name: "muse-session-server", version: this.world.options.version ?? FAKE_MUSE_VERSION },
      sessionDurability: "durable",
      userAgent: `muse-session-server/${this.world.options.version ?? FAKE_MUSE_VERSION} (linux; x86_64)`,
    };
    return result;
  }

  #session(sessionId: string): StoredSession {
    const session = this.world.sessions.get(sessionId);
    if (session === undefined) throw new MspFault(-32020, "sessionNotFound", `no session ${sessionId}`, { sessionId });
    if (session.owner !== this) throw new MspFault(-32024, "sessionNotLoaded", `session ${sessionId} is not loaded on this host`, { sessionId });
    return session;
  }

  cursor(session: StoredSession): string {
    return nextCursor(session);
  }

  #sourceRange(kind: string, streamId: string): SourceRange {
    return this.world.sourceRange(kind, streamId);
  }

  #sessionObject(session: StoredSession): MspSession {
    return {
      sessionId: session.sessionId,
      status: session.owner === undefined ? "notLoaded" : session.active !== undefined ? "running" : "idle",
      activeTurnId: session.active?.turnId ?? null,
      turnCount: session.turnCount,
      path: `${this.environment["HOME"] ?? "/home/fake"}/.muse/sessions/${session.sessionId}/session.jsonl`,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      workspaceRoot: session.workspaceRoot,
      providerId: session.providerId,
      modelId: session.modelId,
      approvalMode: { mode: session.approvalMode, source: "startup", lastCommandId: null },
      forkedFrom: null,
    };
  }

  #config(config: Params<"session/start">["config"], session: StoredSession): void {
    session.configs.push(config ?? null);
    if (config?.mcpServers !== undefined && !this.#granted.includes("sessionMcp")) {
      throw new MspFault(-32010, "capabilityRequired", "per-session MCP servers need the sessionMcp grant", { capability: "sessionMcp" });
    }
    session.mcpServers = { ...(config?.mcpServers ?? {}) };
  }

  #sessionStart(params: Params<"session/start">): Result<"session/start"> {
    return this.world.dedupe(params.commandId, "session/start", params, () => {
      const sessionId = params.sessionId ?? this.world.mint();
      if (this.world.sessions.has(sessionId)) throw new MspFault(-32030, "commandRejected", `session ${sessionId} exists`, { commandId: params.commandId, reason: "session_id_conflict" });
      const now = new Date().toISOString();
      const session: StoredSession = {
        sessionId,
        workspaceRoot: params.workspaceRoot ?? this.environment["PWD"] ?? "/",
        createdAt: now,
        updatedAt: now,
        modelId: params.modelId ?? FAKE_MODELS[0]!.modelId,
        providerId: params.providerId ?? "meta",
        approvalMode: params.approvalMode ?? this.world.defaultApprovalMode,
        permissionProfile: params.permissionProfile,
        mcpServers: {},
        configs: [],
        items: [],
        turnPrompts: [],
        turnCount: 0,
        compactions: 0,
        cursor: 0,
        owner: this,
        foreignLock: false,
        active: undefined,
        queue: [],
        lastRunId: undefined,
        lastTurn: undefined,
      };
      this.#config(params.config, session);
      this.world.sessions.set(sessionId, session);
      this.#owned.add(session);
      this.notify("session/started", { session: this.#sessionObject(session) });
      return { session: this.#sessionObject(session), viewCursor: this.cursor(session) };
    });
  }

  #sessionResume(params: Params<"session/resume">): Result<"session/resume"> {
    const session = this.world.sessions.get(params.sessionId);
    if (session === undefined) throw new MspFault(-32020, "sessionNotFound", `no session ${params.sessionId}`, { sessionId: params.sessionId });
    if (session.foreignLock || (session.owner !== undefined && session.owner !== this && !session.owner.process.exited)) {
      throw new MspFault(-32021, "sessionInUse", `session ${params.sessionId} is held by another host`, { sessionId: params.sessionId });
    }
    this.#config(params.config, session);
    const adopting = session.owner !== this;
    session.owner = this;
    this.#owned.add(session);
    if (params.permissionProfile !== undefined) session.permissionProfile = params.permissionProfile;
    if (params.modelId !== undefined) session.modelId = params.modelId;
    const run = session.active;
    // A running turn no live host held continues on this host, and the puppet gets it.
    if (run !== undefined && adopting) this.world.turnQueue.push(new FakeMuseTurn(this, session, run));
    const approvals = run === undefined ? [] : [...run.approvals.values()].filter((approval) => !approval.resolved);
    const questions = run === undefined ? [] : [...run.questions.values()].filter((question) => !question.settled);
    // The full payloads arrive again as server requests right after the answer (no view notification comes with them).
    this.#then(() => {
      for (const approval of approvals) this.serverRequest("approval/request", approval.params);
      for (const question of questions) this.serverRequest("userInput/request", question.params);
    });
    return {
      session: this.#sessionObject(session),
      viewCursor: this.cursor(session),
      history: params.excludeItems === true ? { mode: "none", items: null, snapshot: null, noneReason: "excluded" } : { mode: "inline", items: structuredClone(session.items), snapshot: null },
      pendingRequests: this.#pendingPointers(session),
      ...(session.lastTurn === undefined ? {} : { lastTurn: structuredClone(session.lastTurn) }),
    };
  }

  /** The late-joiner pointers at the running turn's unsettled approvals and questions. */
  #pendingPointers(session: StoredSession): PendingRequestPointer[] {
    const run = session.active;
    if (run === undefined) return [];
    return [
      ...[...run.approvals.values()].filter((approval) => !approval.resolved).map((approval): PendingRequestPointer => ({ kind: "approval", approvalId: approval.params.approvalId, viewCursor: approval.params.viewCursor })),
      ...[...run.questions.values()].filter((question) => !question.settled).map((question): PendingRequestPointer => ({ kind: "userInput", userInputId: question.params.userInputId, viewCursor: question.params.viewCursor })),
    ];
  }

  #sessionRead(params: Params<"session/read">): Result<"session/read"> {
    const session = this.world.sessions.get(params.sessionId);
    if (session === undefined) throw new MspFault(-32020, "sessionNotFound", `no session ${params.sessionId}`, { sessionId: params.sessionId });
    const excluded = params.excludeItems !== false;
    return {
      session: this.#sessionObject(session),
      viewCursor: `v10:${session.sessionId}:${session.cursor}`,
      history: excluded ? { mode: "none", items: null, snapshot: null, noneReason: "excluded" } : { mode: "inline", items: structuredClone(session.items), snapshot: null },
      // A read re-issues nothing (msp.d.ts `PendingRequestPointer`).
      pendingRequests: this.#pendingPointers(session),
      ...(session.lastTurn === undefined ? {} : { lastTurn: structuredClone(session.lastTurn) }),
    };
  }

  #setApprovalMode(params: Params<"session/setApprovalMode">): Result<"session/setApprovalMode"> {
    const session = this.#session(params.sessionId);
    const changed = session.approvalMode !== params.mode;
    session.approvalMode = params.mode;
    if (changed) {
      this.#then(() =>
        this.notify("session/approvalModeChanged", {
          sessionId: session.sessionId,
          mode: params.mode,
          clientName: "ari",
          commandId: params.commandId,
          source: "approvalReconfigure",
          sourceRange: this.#sourceRange("session", session.sessionId),
          viewCursor: this.cursor(session),
        }),
      );
    }
    return { applyOutcome: changed ? "completed" : "noop", commandId: params.commandId, effectiveMode: { mode: params.mode, source: changed ? "approvalReconfigure" : "startup", lastCommandId: changed ? params.commandId : null }, status: "accepted" };
  }

  #setModel(params: Params<"session/setModel">): Result<"session/setModel"> {
    const session = this.#session(params.sessionId);
    if (!FAKE_MODELS.some((model) => model.modelId === params.model.modelId)) throw new MspFault(-32030, "commandRejected", `unknown model ${params.model.modelId}`, { commandId: params.commandId, reason: "model_unknown" });
    session.modelId = params.model.modelId;
    this.#then(() =>
      this.notify("session/modelChanged", {
        sessionId: session.sessionId,
        modelId: params.model.modelId,
        providerId: params.model.providerId ?? session.providerId,
        source: "user",
        sourceRange: this.#sourceRange("session", session.sessionId),
        viewCursor: this.cursor(session),
      }),
    );
    return { commandId: params.commandId, status: "accepted" };
  }

  #compact(params: Params<"session/compact">): Result<"session/compact"> {
    const session = this.#session(params.sessionId);
    const turnId = params.turnId ?? session.active?.turnId ?? session.lastRunId;
    if (turnId === undefined) throw new MspFault(-32030, "commandRejected", "no run to compact", { commandId: params.commandId, reason: "missing_run" });
    if (session.items.length === 0) return { commandId: params.commandId, status: "noop", reason: "no_compactable_history" };
    session.compactions += 1;
    const itemId = this.world.mint();
    this.#then(() => {
      const started: Item = { itemId, kind: "compaction", turnId, revision: 1, status: "inProgress", recordedAt: new Date().toISOString(), trigger: "manual" };
      this.notify("item/started", { sessionId: session.sessionId, item: started, sourceRange: this.#sourceRange("run", turnId), viewCursor: this.cursor(session) });
      const completed: Item = { ...started, revision: 2, status: "completed", outcome: "compacted", strategyId: "summary-v2", summarizedThrough: `run:${turnId}:seq:${session.cursor}`, tokensBefore: 1200, tokensAfter: 300 };
      this.#storeItem(session, completed);
      this.notify("item/completed", { sessionId: session.sessionId, item: completed, sourceRange: this.#sourceRange("run", turnId), viewCursor: this.cursor(session) });
    });
    return { commandId: params.commandId, status: "accepted" };
  }

  #modelList(params: Params<"model/list">): Result<"model/list"> {
    const active = params.sessionId === undefined ? undefined : this.world.sessions.get(params.sessionId)?.modelId;
    return { models: FAKE_MODELS.map((model) => ({ ...model, isActive: model.modelId === active })), profileId: null, providerId: "meta", source: "fakeCatalog" };
  }

  #usageRead(): Result<"usage/read"> {
    const usage = this.world.options.subscriptionUsage;
    return usage === undefined ? {} : { usage };
  }

  /** Whether a model call can authenticate: a managed key in the environment, or a signed-in ambient account. */
  #signedIn(): boolean {
    if (this.environment["META_API_KEY"] !== undefined) return true;
    return this.world.options.ambientAuth !== "unauthenticated";
  }

  #turnStart(params: Params<"turn/start">): Result<"turn/start"> {
    const session = this.#session(params.sessionId);
    if (params.input.length === 0) throw new MspFault(-32602, "invalidParams", "input must not be empty");
    return this.world.dedupe(params.commandId, "turn/start", params, () => {
      const run = newRun(params.commandId, params.input, params.displayText, params.reasoningEffort);
      if (session.active !== undefined) {
        if (params.ifBusy === "steer") {
          this.#steer(session, session.active, params.input, params.commandId);
          return { commandId: params.commandId, disposition: "steered", startedNewTurn: false, status: "accepted", turnId: session.active.turnId };
        }
        session.queue.push(run);
        return { commandId: params.commandId, disposition: "queued", startedNewTurn: false, status: "accepted", turnId: run.turnId };
      }
      session.active = run;
      this.#then(() => this.#launch(session, run));
      return { commandId: params.commandId, disposition: "started", startedNewTurn: true, status: "accepted", turnId: run.turnId };
    });
  }

  /** The run begins: `turn/started`, then its user message; the puppet gets the turn. */
  #launch(session: StoredSession, run: FakeRun): void {
    session.active = run;
    session.updatedAt = new Date().toISOString();
    this.notify("turn/started", { sessionId: session.sessionId, turnId: run.turnId, commandId: run.commandId, sourceRange: this.#sourceRange("run", run.turnId), viewCursor: this.cursor(session) });
    const message: Item = {
      itemId: this.world.mint(),
      kind: "userMessage",
      turnId: run.turnId,
      revision: 1,
      status: "completed",
      recordedAt: new Date().toISOString(),
      text: run.prompt,
      commandId: run.commandId,
      ...(run.displayText === undefined ? {} : { displayText: run.displayText }),
    };
    this.#storeItem(session, message);
    this.notify("item/completed", { sessionId: session.sessionId, item: message, sourceRange: this.#sourceRange("run", run.turnId), viewCursor: this.cursor(session) });
    session.turnPrompts.push(run.prompt);
    if (!this.#signedIn()) {
      this.endRun(session, run, { terminal: "failed", error: { kind: "authRequired", message: "Not signed in. Run muse login.", retryable: false } });
      return;
    }
    this.world.turnQueue.push(new FakeMuseTurn(this, session, run));
  }

  #steer(session: StoredSession, run: FakeRun, input: TurnInputPart[], commandId: string): void {
    const text = input.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n");
    this.#then(() => {
      const message: Item = { itemId: this.world.mint(), kind: "userMessage", turnId: run.turnId, revision: 1, status: "completed", recordedAt: new Date().toISOString(), text, commandId, steered: true };
      this.#storeItem(session, message);
      this.notify("item/completed", { sessionId: session.sessionId, item: message, sourceRange: this.#sourceRange("run", run.turnId), viewCursor: this.cursor(session) });
      const waiter = run.steerWaiters.shift();
      if (waiter !== undefined) waiter(text);
      else run.steers.push(text);
    });
  }

  #turnSteer(params: Params<"turn/steer">): Result<"turn/steer"> {
    const session = this.#session(params.sessionId);
    return this.world.dedupe(params.commandId, "turn/steer", params, () => {
      const run = session.active;
      if (run === undefined || run.ended || run.turnId !== params.expectedTurnId) {
        throw new MspFault(-32030, "commandRejected", "turn already finished", { commandId: params.commandId, reason: "already_terminal" });
      }
      const refusal = this.world.refuseSteer?.();
      if (refusal !== undefined) throw new MspFault(-32030, "commandRejected", `the session runtime refused the steer (${refusal.reason})`, { commandId: params.commandId, reason: refusal.reason, retryable: refusal.retryable });
      this.#steer(session, run, params.input, params.commandId);
      return { commandId: params.commandId, status: "accepted", turnId: run.turnId };
    });
  }

  #turnStop(method: "turn/interrupt" | "turn/cancel", params: Params<"turn/interrupt">): Result<"turn/interrupt"> {
    const session = this.#session(params.sessionId);
    const run = session.active;
    if (run === undefined || run.ended || (params.turnId !== undefined && params.turnId !== run.turnId)) {
      throw new MspFault(-32030, "commandRejected", `turn ${params.turnId ?? "(current)"} is not running`, { commandId: params.commandId, reason: "turn_not_running" });
    }
    void method;
    run.stop.resolve("cancel");
    return { commandId: params.commandId, status: "accepted", turnId: run.turnId };
  }

  #turnUnqueue(params: Params<"turn/unqueue">): Result<"turn/unqueue"> {
    const session = this.#session(params.sessionId);
    const index = session.queue.findIndex((run) => run.turnId === params.turnId);
    if (index < 0) throw new MspFault(-32030, "commandRejected", `turn ${params.turnId} is not queued`, { commandId: params.commandId, reason: "not_queued" });
    const refusal = this.world.refuseUnqueue?.();
    if (refusal !== undefined) throw new MspFault(-32030, "commandRejected", `the session runtime refused the unqueue (${refusal.reason})`, { commandId: params.commandId, reason: refusal.reason, retryable: refusal.retryable });
    const [run] = session.queue.splice(index, 1);
    this.#then(() =>
      this.notify("turn/unqueued", { sessionId: session.sessionId, turnId: run!.turnId, commandId: run!.commandId, sourceRange: this.#sourceRange("session", session.sessionId), viewCursor: this.cursor(session) }),
    );
    return { commandId: params.commandId, status: "accepted", turnId: run!.turnId };
  }

  #approvalDecide(params: Params<"approval/decide">): Result<"approval/decide"> {
    const session = this.#session(params.sessionId);
    const found = [session.active, ...session.queue].flatMap((run) => (run === undefined ? [] : [[run, run.approvals.get(params.approvalId)] as const])).find(([, approval]) => approval !== undefined);
    if (found === undefined) throw new MspFault(-32050, "approvalNotFound", `no approval ${params.approvalId}`, { approvalId: params.approvalId });
    const [run, approval] = found as readonly [FakeRun, FakeApproval];
    return this.world.dedupe(params.commandId, "approval/decide", params, () => {
      if (approval.resolved) throw new MspFault(-32051, "approvalAlreadyResolved", `approval ${params.approvalId} is resolved`, { approvalId: params.approvalId });
      const requirement = approval.params.currentRequirementId;
      if (params.requirementId.approvalId !== requirement.approvalId || params.requirementId.sourceIndex !== requirement.sourceIndex) {
        throw new MspFault(-32053, "approvalRequirementStale", "stale requirement", { approvalId: params.approvalId, currentRequirementId: requirement });
      }
      const choice = approval.params.availableChoices.find((candidate) => candidate.choiceId === params.choiceId);
      if (choice === undefined) throw new MspFault(-32052, "approvalChoiceInvalid", `choice ${params.choiceId} was not offered`, { approvalId: params.approvalId, choiceId: params.choiceId });
      if (params.feedback !== undefined && params.feedback !== null && choice.acceptsFeedback !== true) throw new MspFault(-32602, "invalidParams", "this choice takes no feedback");
      approval.resolved = true;
      approval.replies.push(choice.choiceId);
      approval.firstReply.resolve(choice.choiceId);
      const allowed = choice.decision.startsWith("approved");
      this.#then(() => {
        this.notify("approval/resolved", {
          sessionId: session.sessionId,
          approvalId: params.approvalId,
          itemId: approval.item.itemId,
          turnId: run.turnId,
          decision: choice.decision,
          policyResult: allowed ? "allow" : "deny",
          resolvedBy: "user",
          decidedByCommandId: params.commandId,
          decidedAt: new Date().toISOString(),
          stageEvidence: [],
          ...(choice.decision === "approvedPolicyAmendment" ? { amendment: { durability: choice.scope === "session" ? "session" : "localPersistent", rulePreview: choice.rulePreview ?? choice.label } } : {}),
          sourceRange: this.#sourceRange("approval.review", approval.params.approvalId),
          viewCursor: this.cursor(session),
        });
        const settled: Item = allowed
          ? { ...approval.item, revision: approval.item.revision + 1, status: "completed", visibleOutput: "done\n", truncated: false }
          : { ...approval.item, revision: approval.item.revision + 1, status: "rejected", failureReason: "approval denied", visibleOutput: "tool denied", truncated: false };
        this.settleItem(session, run, settled);
      });
      return { approvalId: params.approvalId, commandId: params.commandId, status: "accepted", terminal: true };
    });
  }

  #userInputAnswer(params: Params<"userInput/answer">): Result<"userInput/answer"> {
    const session = this.#session(params.sessionId);
    const found = [session.active, ...session.queue].flatMap((run) => (run === undefined ? [] : [[run, run.questions.get(params.userInputId)] as const])).find(([, question]) => question !== undefined);
    if (found === undefined) throw new MspFault(-32055, "userInputNotFound", `no prompt ${params.userInputId}`, { userInputId: params.userInputId });
    const [run, question] = found as readonly [FakeRun, FakeQuestion];
    return this.world.dedupe(params.commandId, "userInput/answer", params, () => {
      if (question.settled) throw new MspFault(-32056, "userInputAlreadySettled", `prompt ${params.userInputId} is settled`, { userInputId: params.userInputId });
      for (const asked of question.params.questions) {
        const answer = params.answers.find((candidate) => candidate.questionId === asked.id);
        const labels = answer?.selectedLabels ?? (answer?.selectedLabel === undefined ? [] : [answer.selectedLabel]);
        const valid = answer !== undefined && (labels.length > 0 || (answer.freeText !== undefined && answer.freeText !== "")) && labels.every((label) => asked.options.some((option) => option.label === label));
        if (!valid) throw new MspFault(-32057, "userInputAnswerInvalid", `question ${asked.id} has no valid answer`, { userInputId: params.userInputId });
      }
      question.settled = true;
      question.answered.resolve(params.answers);
      this.#then(() => {
        this.notify("userInput/settled", {
          sessionId: session.sessionId,
          userInputId: params.userInputId,
          outcome: "answered",
          answers: params.answers,
          clarification: null,
          reason: null,
          decidedByCommandId: params.commandId,
          decidedAt: new Date().toISOString(),
          sourceRange: this.#sourceRange("session", session.sessionId),
          viewCursor: this.cursor(session),
        });
        const output = params.answers.map((answer) => answer.selectedLabel ?? answer.selectedLabels?.join(", ") ?? answer.freeText ?? "").join("\n");
        this.settleItem(session, run, { ...question.item, revision: question.item.revision + 1, status: "completed", visibleOutput: output, truncated: false });
      });
      return { commandId: params.commandId, status: "accepted", userInputId: params.userInputId };
    });
  }

  // Items and runs, for the puppet.

  #storeItem(session: StoredSession, item: Item): void {
    const index = session.items.findIndex((stored) => stored.itemId === item.itemId);
    if (index >= 0) session.items[index] = item;
    else session.items.push(item);
  }

  openItem(session: StoredSession, run: FakeRun, item: Item): void {
    run.openItems.set(item.itemId, item);
    this.#storeItem(session, item);
    this.notify("item/started", { sessionId: session.sessionId, item, sourceRange: this.#sourceRange("run", run.turnId), viewCursor: this.cursor(session) });
  }

  delta(session: StoredSession, item: Item, field: string, text: string): void {
    this.notify("item/delta", { sessionId: session.sessionId, itemId: item.itemId, field, delta: text, viewCursor: this.cursor(session) });
  }

  settleItem(session: StoredSession, run: FakeRun, item: Item): void {
    run.openItems.delete(item.itemId);
    this.#storeItem(session, item);
    this.notify("item/completed", { sessionId: session.sessionId, item, sourceRange: this.#sourceRange("run", run.turnId), viewCursor: this.cursor(session) });
  }

  askApproval(session: StoredSession, run: FakeRun, params: Omit<ApprovalRequestParams, "sessionId" | "sourceRange" | "viewCursor">, item: Item): FakeApproval {
    const full: ApprovalRequestParams = { ...params, sessionId: session.sessionId, sourceRange: this.#sourceRange("approval.review", params.approvalId), viewCursor: this.cursor(session) };
    const approval: FakeApproval = { params: full, item, resolved: false, replies: [], firstReply: deferred<string>() };
    run.approvals.set(params.approvalId, approval);
    this.notify("approval/requested", full);
    this.serverRequest("approval/request", full);
    return approval;
  }

  askQuestions(session: StoredSession, run: FakeRun, params: Omit<UserInputRequestParams, "sessionId" | "sourceRange" | "viewCursor">, item: Item): FakeQuestion {
    const full: UserInputRequestParams = { ...params, sessionId: session.sessionId, sourceRange: this.#sourceRange("session", session.sessionId), viewCursor: this.cursor(session) };
    const question: FakeQuestion = { params: full, item, settled: false, answered: deferred<UserInputAnswer[]>() };
    run.questions.set(params.userInputId, question);
    this.notify("userInput/requested", full);
    this.serverRequest("userInput/request", full);
    return question;
  }

  /** A model call of the run finished: `session/tokenUsage`. */
  tokenUsage(session: StoredSession, run: FakeRun, usage: TokenUsage): void {
    run.usage = {
      inputTokens: run.usage.inputTokens + usage.inputTokens,
      outputTokens: run.usage.outputTokens + usage.outputTokens,
      cachedTokens: run.usage.cachedTokens + usage.cachedTokens,
      reasoningTokens: run.usage.reasoningTokens + usage.reasoningTokens,
    };
    const promptTokens = usage.inputTokens;
    this.notify("session/tokenUsage", {
      sessionId: session.sessionId,
      turnId: run.turnId,
      modelId: session.modelId,
      promptTokens,
      totalTokens: promptTokens + usage.outputTokens,
      usage,
      cumulative: { promptTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens, totalTokens: run.usage.inputTokens + run.usage.outputTokens },
      sourceRange: this.#sourceRange("run", run.turnId),
      viewCursor: this.cursor(session),
    });
  }

  /** Ends a run natively; with `hold`, the `turn/completed` frame waits until the returned function runs. */
  endRun(session: StoredSession, run: FakeRun, outcome: { terminal: "completed" | "failed" | "cancelled"; reason?: string; error?: MspNotificationMap["turn/completed"]["error"] }, hold = false): () => void {
    run.ended = true;
    if (session.active === run) session.active = undefined;
    session.lastRunId = run.turnId;
    if (outcome.terminal === "completed") session.turnCount += 1;
    const finish = (): void => {
      session.lastTurn = { turnId: run.turnId, terminal: outcome.terminal, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }), ...(outcome.error === undefined ? {} : { error: outcome.error }) };
      for (const item of [...run.openItems.values()]) {
        const status = outcome.terminal === "completed" ? "completed" : outcome.terminal === "cancelled" ? "cancelled" : "failed";
        this.settleItem(session, run, { ...item, revision: item.revision + 1, status, ...(status === "completed" ? {} : { failureReason: outcome.reason ?? "turn ended" }) });
      }
      this.notify("turn/completed", {
        sessionId: session.sessionId,
        turnId: run.turnId,
        terminal: outcome.terminal,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        usage: run.usage,
        durationMs: 1000,
        sourceRange: this.#sourceRange("run", run.turnId),
        viewCursor: this.cursor(session),
      });
      // A queued submit launches at the boundary.
      const next = session.queue.shift();
      if (next !== undefined && !this.process.exited) this.#launch(session, next);
    };
    if (hold) return finish;
    finish();
    return () => undefined;
  }
}

/** The kit's puppet over one fake Muse run. */
export class FakeMuseTurn implements NativeTurn {
  readonly host: FakeMuseHost;
  readonly session: StoredSession;
  readonly run: FakeRun;
  readonly prompt: string;

  constructor(host: FakeMuseHost, session: StoredSession, run: FakeRun) {
    this.host = host;
    this.session = session;
    this.run = run;
    this.prompt = run.prompt;
  }

  get turnId(): string {
    return this.run.turnId;
  }

  /** The input parts the run got, as the driver sent them. */
  get input(): readonly TurnInputPart[] {
    return this.run.input;
  }

  get displayText(): string | undefined {
    return this.run.displayText;
  }

  #world(): FakeMuseWorld {
    return this.host.world;
  }

  async say(text: string): Promise<void> {
    const item: Item = { itemId: this.#world().mint(), kind: "agentMessage", turnId: this.run.turnId, revision: 1, status: "inProgress", text: "", messagePhase: "finalAnswer" };
    this.host.openItem(this.session, this.run, item);
    const middle = Math.ceil(text.length / 2);
    for (const chunk of [text.slice(0, middle), text.slice(middle)]) if (chunk !== "") this.host.delta(this.session, item, "text", chunk);
    this.host.settleItem(this.session, this.run, { ...item, revision: 2, status: "completed", text, recordedAt: new Date().toISOString() });
  }

  async think(text: string): Promise<void> {
    const item: Item = { itemId: this.#world().mint(), kind: "reasoning", turnId: this.run.turnId, revision: 1, status: "inProgress", summary: [""] };
    this.host.openItem(this.session, this.run, item);
    this.host.delta(this.session, item, "summary.0", text);
    this.host.settleItem(this.session, this.run, { ...item, revision: 2, status: "completed", summary: [text] });
  }

  async runTool(tool: NativeTool): Promise<void> {
    const item: Item = { itemId: this.#world().mint(), kind: "toolCall", turnId: this.run.turnId, revision: 1, status: "inProgress", tool: tool.name, callId: `call_${this.#world().mint().slice(-6)}`, args: JSON.stringify(tool.input), recordedAt: new Date().toISOString() };
    this.host.openItem(this.session, this.run, item);
    if (tool.output !== "") this.host.delta(this.session, item, "output", tool.output);
    this.host.settleItem(this.session, this.run, { ...item, revision: 2, status: "completed", visibleOutput: tool.output, truncated: false, recordedAt: new Date().toISOString() });
  }

  /** Muse's choice for an ARI approval option: its decision and declared grant duration; the kit's option id is kept as the server-minted `choiceId`. */
  static choice(option: NativeApproval["options"][number]): ApprovalChoice {
    switch (option.decision) {
      case "accept":
        return { choiceId: option.optionId, label: option.label, decision: "approved", scope: "once" };
      case "accept_for_session":
        return { choiceId: option.optionId, label: option.label, decision: "approvedForSession", scope: "session" };
      case "accept_always":
        return { choiceId: option.optionId, label: option.label, decision: "approvedPolicyAmendment", scope: "localPersistent", rulePreview: `always allow (${option.label})` };
      default:
        return { choiceId: option.optionId, label: option.label, decision: "denied", scope: "once", acceptsFeedback: true };
    }
  }

  async requestApproval(approval: NativeApproval): Promise<NativeApprovalHandle> {
    const command = approval.command?.join(" ") ?? "";
    const path = approval.path === undefined ? undefined : approval.path.startsWith("/") ? approval.path : `${this.session.workspaceRoot}/${approval.path}`;
    if (approval.kind === "command") {
      return this.approvalFor({ toolName: "shell", args: { command }, subject: { kind: "shell", command, stages: [], workspaceRoot: this.session.workspaceRoot }, options: approval.options });
    }
    return this.approvalFor({ toolName: "write_file", args: { path: approval.path ?? "" }, subject: { kind: "fileAccess", toolName: "write_file", path: path ?? this.session.workspaceRoot, access: "write" }, options: approval.options });
  }

  /** An approval for any MSP subject (a file read, a network host, a tool), on a `toolCall` item of this run. */
  async approvalFor(spec: { toolName: string; args: unknown; subject: ApprovalSubject; options: NativeApproval["options"] }): Promise<NativeApprovalHandle> {
    const world = this.#world();
    const approvalId = world.mint();
    const args = JSON.stringify(spec.args);
    const item: Item = { itemId: world.mint(), kind: "toolCall", turnId: this.run.turnId, revision: 1, status: "inProgress", tool: spec.toolName, callId: `call_${approvalId.slice(-6)}`, args, approvalId, recordedAt: new Date().toISOString() };
    this.host.openItem(this.session, this.run, item);
    const fake = this.host.askApproval(
      this.session,
      this.run,
      {
        approvalId,
        turnId: this.run.turnId,
        taskId: world.mint(),
        itemId: item.itemId,
        toolCallId: item.callId!,
        toolName: spec.toolName,
        rawArgs: args,
        subject: spec.subject,
        currentRequirementId: { approvalId, sourceIndex: 0 },
        availableChoices: spec.options.map((option) => FakeMuseTurn.choice(option)),
        protectedWrite: false,
        judgeEscalated: false,
      },
      item,
    );
    return { nextReply: () => fake.firstReply.promise, replies: async () => [...fake.replies] };
  }

  /** Asks the user questions through `request_user_input`; resolves with the answers Muse got. */
  async askQuestions(questions: UserInputQuestion[]): Promise<{ answers(): Promise<UserInputAnswer[]> }> {
    const world = this.#world();
    const userInputId = world.mint();
    const item: Item = { itemId: world.mint(), kind: "toolCall", turnId: this.run.turnId, revision: 1, status: "inProgress", tool: "request_user_input", callId: `call_${userInputId.slice(-6)}`, args: JSON.stringify({ questions: questions.map((question) => ({ id: question.id, question: question.question })) }) };
    this.host.openItem(this.session, this.run, item);
    const fake = this.host.askQuestions(this.session, this.run, { userInputId, turnId: this.run.turnId, itemId: item.itemId, toolCallId: item.callId!, toolName: "request_user_input", questions, autoResolutionMs: 120000 }, item);
    return { answers: () => fake.answered.promise };
  }

  /** A subagent the run spawned: its `subagent` item opens, and with `result` it settles. */
  async subagent(spec: { role: string; objective: string; result?: string; failed?: boolean }): Promise<{ subagentId: string; finish(result: string, failed?: boolean): Promise<void> }> {
    const world = this.#world();
    const subagentId = world.mint();
    const item: Item = { itemId: world.mint(), kind: "subagent", turnId: this.run.turnId, revision: 1, status: "inProgress", subagentId, childSessionId: world.mint(), role: spec.role, objective: spec.objective, controlStatus: "running", depth: 1 };
    this.host.openItem(this.session, this.run, item);
    let revision = 1;
    const finish = async (result: string, failed = false): Promise<void> => {
      revision += 1;
      this.host.settleItem(this.session, this.run, {
        ...item,
        revision,
        status: failed ? "failed" : "completed",
        controlStatus: "closed",
        result: { summary: result, artifactRefs: [], evidenceRefs: [] },
        ...(failed ? { failureReason: result } : {}),
      });
    };
    if (spec.result !== undefined) await finish(spec.result, spec.failed);
    return { subagentId, finish };
  }

  /** A subagent's approval, shown on this (parent) session. */
  async subagentApproval(subagentId: string, approval: NativeApproval): Promise<NativeApprovalHandle> {
    const world = this.#world();
    const approvalId = world.mint();
    const command = approval.command?.join(" ") ?? "";
    const childRun = world.mint();
    const item: Item = { itemId: world.mint(), kind: "toolCall", turnId: childRun, revision: 1, status: "inProgress", tool: "shell", callId: `call_${approvalId.slice(-6)}`, args: JSON.stringify({ command }), approvalId };
    const fake = this.host.askApproval(
      this.session,
      this.run,
      {
        approvalId,
        turnId: childRun,
        taskId: world.mint(),
        itemId: item.itemId,
        toolCallId: item.callId!,
        toolName: "shell",
        rawArgs: item.args!,
        subject: { kind: "shell", command, stages: [], workspaceRoot: this.session.workspaceRoot },
        currentRequirementId: { approvalId, sourceIndex: 0 },
        availableChoices: approval.options.map((option) => FakeMuseTurn.choice(option)),
        protectedWrite: false,
        judgeEscalated: false,
        subagentOrigin: { subagentId, childSessionId: world.mint(), childRunId: childRun },
      },
      item,
    );
    return { nextReply: () => fake.firstReply.promise, replies: async () => [...fake.replies] };
  }

  /** The todo list was replaced (`session/todoListChanged`). */
  async todoList(items: Array<{ text: string; status: "pending" | "inProgress" | "completed" | "cancelled" }>): Promise<void> {
    this.host.notify("session/todoListChanged", {
      sessionId: this.session.sessionId,
      items,
      revision: 1,
      sourceTool: "write_todos",
      sourceRange: { stream: { kind: "run", id: this.run.turnId }, first: { id: this.#world().mint(), sequence: 1 }, last: { id: this.#world().mint(), sequence: 1 } },
      viewCursor: this.host.cursor(this.session),
    });
  }

  /** One model call of the turn finished. */
  async modelCall(usage: TokenUsage): Promise<void> {
    this.host.tokenUsage(this.session, this.run, usage);
  }

  /** Context occupancy changed (`session/contextUsage`). */
  async contextUsage(usedTokens: number, windowTokens: number): Promise<void> {
    this.host.notify("session/contextUsage", {
      sessionId: this.session.sessionId,
      usedTokens,
      windowTokens,
      pressure: "normal",
      sourceRange: { stream: { kind: "run", id: this.run.turnId }, first: { id: this.#world().mint(), sequence: 1 }, last: { id: this.#world().mint(), sequence: 1 } },
      viewCursor: this.host.cursor(this.session),
    });
  }

  /** The account's subscription usage changed (`usage/changed`, no session). */
  async subscriptionUsage(usage: SubscriptionUsage): Promise<void> {
    this.host.notify("usage/changed", usage);
  }

  nextSteer(): Promise<string> {
    const queued = this.run.steers.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.run.steerWaiters.push(resolve));
  }

  async complete(): Promise<void> {
    if (this.run.usage.outputTokens === 0) this.host.tokenUsage(this.session, this.run, { inputTokens: 120, outputTokens: 30, cachedTokens: 40, reasoningTokens: 5 });
    this.host.endRun(this.session, this.run, { terminal: "completed" });
  }

  async completeHeld(): Promise<{ release(): Promise<void> }> {
    const release = this.host.endRun(this.session, this.run, { terminal: "completed" }, true);
    return { release: async () => release() };
  }

  async fail(failure: NativeFailure): Promise<void> {
    if (failure.kind === "usage_limit") {
      const resetsAtMs = Date.parse(failure.resetAt);
      this.host.endRun(this.session, this.run, { terminal: "failed", reason: failure.message, error: { kind: "modelError", message: failure.message, retryable: true, quota: { limitKind: "tierLimit", resetsAtMs } } });
      return;
    }
    this.host.endRun(this.session, this.run, { terminal: "failed", reason: failure.message, error: { kind: "modelError", message: failure.message, retryable: true } });
  }

  stopRequested(): Promise<"cancel" | "exit"> {
    return this.run.stop.promise;
  }

  async finishCancelled(): Promise<void> {
    this.host.endRun(this.session, this.run, { terminal: "cancelled", reason: "cancelled by the user" });
  }

  async exitProcess(): Promise<void> {
    this.host.die(1, null);
  }
}
