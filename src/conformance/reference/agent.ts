// The reference agent: the native side of the reference driver. It speaks the
// protocol of protocol.ts over a byte stream and does nothing on its own: each
// turn waits for the conformance kit's puppet calls (`say`, `runTool`,
// `complete`, ...). The same class runs in memory (the in-memory harness
// wires it to a `SpawnedProcess` made of queues) and as a real child process
// (a harness wires it to the child's stdin and stdout and relays the puppet
// calls over IPC).

import { JsonRpcError, JsonRpcPeer } from "../../driver-kit/json-rpc.ts";
import { NdjsonDecoder, encodeNdjson } from "../../driver-kit/ndjson.ts";
import type { NativeApproval, NativeFailure, NativeTool } from "../harness.ts";
import { AsyncQueue } from "../util.ts";
import { REFERENCE_AGENT_VERSION, REFERENCE_ERRORS } from "./protocol.ts";
import type {
  ReferenceAmbientAuth,
  ReferenceOptionKind,
  ReferencePermissionRequest,
  ReferenceSessionUpdate,
  ReferenceUpdate,
  StoredItem,
  StoredSession,
  StoredTurn,
} from "./protocol.ts";
import type { ReferenceStore } from "./store.ts";

/** How the agent reaches the outside world: its stdout, stderr and exit. */
export interface ReferenceAgentIo {
  out(text: string): void;
  err(text: string): void;
  exit(code: number | null, signal: string | null): void;
}

export interface ReferenceAgentOptions {
  readonly argv: readonly string[];
  readonly env: { readonly [name: string]: string };
  readonly io: ReferenceAgentIo;
  /** The store for a session directory. */
  readonly storeFor: (directory: string) => ReferenceStore;
  /** The canonical form of a path, as the operating system resolves it. */
  readonly realpath: (path: string) => string;
  /** What `--auth-status` answers. */
  readonly ambientAuth: ReferenceAmbientAuth;
  /** Told about every turn the agent starts, so a puppet can drive it. */
  readonly onTurn: (turn: { readonly turnId: string; readonly prompt: string }) => void;
}

const DEFAULT_SESSION_DIRECTORY = "/reference-agent/sessions";

const OPTION_KINDS: { readonly [decision: string]: ReferenceOptionKind } = {
  accept: "allow_once",
  accept_for_session: "allow_session",
  accept_always: "allow_always",
  decline: "reject_once",
};

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function joinPath(directory: string, path: string): string {
  if (path.startsWith("/")) return path;
  return directory.endsWith("/") ? `${directory}${path}` : `${directory}/${path}`;
}

interface Approval {
  readonly replies: string[];
  readonly waiters: Array<(optionId: string) => void>;
}

export class ReferenceAgent {
  readonly environment: { readonly [name: string]: string };
  readonly #options: ReferenceAgentOptions;
  readonly #decoder = new NdjsonDecoder();
  readonly #store: ReferenceStore;
  readonly #peer: JsonRpcPeer;
  readonly #sessions = new Map<string, StoredSession>();
  /** The running turn of each session. */
  readonly #active = new Map<string, string>();
  /** The session each turn belongs to. */
  readonly #turnSessions = new Map<string, string>();
  readonly #cancelled = new Set<string>();
  readonly #stopWaiters = new Map<string, Array<(how: "cancel" | "exit") => void>>();
  readonly #steers = new Map<string, AsyncQueue<string>>();
  readonly #approvals = new Map<string, Approval>();
  readonly #subagents = new Map<string, { readonly sessionId: string; readonly turnId: string; status: string }>();
  #exited = false;

  constructor(options: ReferenceAgentOptions) {
    this.#options = options;
    this.environment = { ...options.env };
    this.#store = options.storeFor(argument(options.argv, "--session-dir") ?? DEFAULT_SESSION_DIRECTORY);
    this.#peer = new JsonRpcPeer({
      send: (message) => {
        if (!this.#exited) options.io.out(encodeNdjson(message));
      },
      onRequest: (method, params) => this.#handle(method, params as { [key: string]: unknown }),
    });
  }

  get exited(): boolean {
    return this.#exited;
  }

  /** Runs a one-shot command (`--version`, `--auth-status`), or does nothing and waits for protocol frames. */
  start(): void {
    const { argv, io } = this.#options;
    if (argv.includes("--version")) {
      io.out(`reference-agent ${REFERENCE_AGENT_VERSION}\n`);
      this.#exit(0, null);
      return;
    }
    if (argv.includes("--auth-status")) {
      const answers: { [state: string]: unknown } = {
        authenticated: { status: "signed_in", account: { email: "ambient@reference.invalid" } },
        unauthenticated: { status: "signed_out" },
        unknown: { status: "unknown" },
      };
      const answer = answers[this.#options.ambientAuth];
      if (answer === undefined) {
        io.err("reference-agent: the sign-in check could not reach the account service\n");
        this.#exit(1, null);
      } else {
        io.out(encodeNdjson(answer));
        this.#exit(0, null);
      }
    }
  }

  /** Bytes or text from the driver, on the agent's stdin. */
  receive(chunk: Uint8Array | string): void {
    if (this.#exited) return;
    for (const record of this.#decoder.push(chunk)) {
      if (record.ok) this.#peer.receive(record.value);
    }
  }

  /** The driver closed the agent's stdin: the agent exits. */
  closeStdin(): void {
    if (!this.#exited) this.#exit(0, null);
  }

  /** The process was killed. */
  kill(signal: string): void {
    if (!this.#exited) this.#exit(null, signal);
  }

  // The puppet: each call makes the agent act on one of its turns.

  async say(turnId: string, text: string): Promise<void> {
    const { session, turn } = this.#turn(turnId);
    const messageId = this.#store.nextId("msg");
    const item: StoredItem = { id: messageId, kind: "message", text, status: "running" };
    turn.items.push(item);
    const split = Math.ceil(text.length / 2);
    for (const chunk of [text.slice(0, split), text.slice(split)]) {
      if (chunk !== "") this.#update(session, turnId, { type: "message_delta", messageId, text: chunk });
    }
    item.status = "completed";
    this.#save(session);
    this.#update(session, turnId, { type: "message_done", messageId, text });
  }

  async runTool(turnId: string, tool: NativeTool): Promise<void> {
    const { session, turn } = this.#turn(turnId);
    const toolCallId = this.#store.nextId("tool");
    const path = tool.path === undefined ? undefined : joinPath(session.cwd, tool.path);
    const item: StoredItem = { id: toolCallId, kind: "tool", name: tool.name, input: tool.input, status: "running", ...(path === undefined ? {} : { path }) };
    turn.items.push(item);
    this.#update(session, turnId, { type: "tool_started", toolCallId, name: tool.name, input: tool.input, ...(path === undefined ? {} : { path }) });
    item.output = tool.output;
    item.status = "completed";
    this.#save(session);
    this.#update(session, turnId, { type: "tool_done", toolCallId, output: tool.output });
  }

  /** Asks the driver for an approval; returns the approval's id for `approvalReplies`. */
  async requestApproval(turnId: string, approval: NativeApproval): Promise<string> {
    const { session } = this.#turn(turnId);
    const permissionId = this.#store.nextId("perm");
    const entry: Approval = { replies: [], waiters: [] };
    this.#approvals.set(permissionId, entry);
    const request: ReferencePermissionRequest = {
      sessionId: session.sessionId,
      turnId,
      permissionId,
      kind: approval.kind,
      ...(approval.command === undefined ? {} : { command: approval.command }),
      ...(approval.path === undefined ? {} : { path: joinPath(session.cwd, approval.path) }),
      options: approval.options.map((option) => ({ optionId: option.optionId, name: option.label, kind: OPTION_KINDS[option.decision] ?? "reject_once" })),
    };
    this.#peer.request<{ optionId: string }>("permission/request", request).then(
      (reply) => {
        entry.replies.push(reply.optionId);
        for (const waiter of entry.waiters.splice(0)) waiter(reply.optionId);
      },
      () => undefined,
    );
    return permissionId;
  }

  approvalReplies(approvalId: string): string[] {
    return [...(this.#approvals.get(approvalId)?.replies ?? [])];
  }

  nextApprovalReply(approvalId: string): Promise<string> {
    const entry = this.#approvals.get(approvalId);
    if (entry === undefined) return Promise.reject(new Error(`no approval ${approvalId}`));
    const first = entry.replies[0];
    if (first !== undefined) return Promise.resolve(first);
    return new Promise((resolve) => entry.waiters.push(resolve));
  }

  async startBackgroundTask(turnId: string, title: string): Promise<void> {
    const { session } = this.#turn(turnId);
    const taskId = this.#store.nextId("task");
    session.tasks.push({ taskId, title, turnId, status: "running" });
    this.#save(session);
    this.#update(session, turnId, { type: "task_started", taskId, title });
  }

  async spawnSubagent(turnId: string, name: string): Promise<void> {
    const { session } = this.#turn(turnId);
    const subagentId = this.#store.nextId("subagent");
    this.#subagents.set(subagentId, { sessionId: session.sessionId, turnId, status: "running" });
    this.#update(session, turnId, { type: "subagent_started", subagentId, name });
  }

  nextSteer(turnId: string): Promise<string> {
    return this.#steerQueue(turnId)
      .next()
      .then((result) => (result.done === true ? Promise.reject(new Error(`turn ${turnId} ended without a steer`)) : result.value));
  }

  async complete(turnId: string): Promise<void> {
    this.#end(turnId, "completed", { type: "turn_ended", turnId, stopReason: "end_turn" });
  }

  async fail(turnId: string, failure: NativeFailure): Promise<void> {
    const error = failure.kind === "usage_limit" ? { kind: failure.kind, message: failure.message, resetAt: failure.resetAt } : { kind: failure.kind, message: failure.message };
    this.#end(turnId, "failed", { type: "turn_ended", turnId, stopReason: "error", error });
  }

  stopRequested(turnId: string): Promise<"cancel" | "exit"> {
    if (this.#exited) return Promise.resolve("exit");
    if (this.#cancelled.has(turnId)) return Promise.resolve("cancel");
    return new Promise((resolve) => {
      const waiters = this.#stopWaiters.get(turnId) ?? [];
      waiters.push(resolve);
      this.#stopWaiters.set(turnId, waiters);
    });
  }

  async finishCancelled(turnId: string): Promise<void> {
    this.#end(turnId, "cancelled", { type: "turn_ended", turnId, stopReason: "cancelled" });
  }

  /** The agent's process dies with exit code 1. */
  exitProcess(): void {
    if (!this.#exited) this.#exit(1, null);
  }

  #exit(code: number | null, signal: string | null): void {
    this.#exited = true;
    for (const waiters of this.#stopWaiters.values()) for (const waiter of waiters) waiter("exit");
    this.#stopWaiters.clear();
    for (const queue of this.#steers.values()) queue.end();
    this.#peer.close();
    this.#options.io.exit(code, signal);
  }

  #turn(turnId: string): { session: StoredSession; turn: StoredTurn } {
    const sessionId = this.#turnSessions.get(turnId);
    const session = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    const turn = session?.turns.find((candidate) => candidate.turnId === turnId);
    if (session === undefined || turn === undefined) throw new Error(`the reference agent has no turn ${turnId}`);
    if (this.#exited) throw new Error("the reference agent has exited");
    return { session, turn };
  }

  #steerQueue(turnId: string): AsyncQueue<string> {
    let queue = this.#steers.get(turnId);
    if (queue === undefined) {
      queue = new AsyncQueue<string>();
      this.#steers.set(turnId, queue);
    }
    return queue;
  }

  #update(session: StoredSession, turnId: string | undefined, update: ReferenceUpdate): void {
    const params: ReferenceSessionUpdate = turnId === undefined ? { sessionId: session.sessionId, update } : { sessionId: session.sessionId, turnId, update };
    void this.#peer.notify("session/update", params);
  }

  #save(session: StoredSession): void {
    this.#store.save(session);
  }

  #end(turnId: string, status: StoredTurn["status"], update: ReferenceUpdate): void {
    const { session, turn } = this.#turn(turnId);
    turn.status = status;
    for (const item of turn.items) item.status = "completed";
    this.#active.delete(session.sessionId);
    this.#steers.get(turnId)?.end();
    this.#save(session);
    this.#update(session, turnId, update);
    const queued = session.turns.find((candidate) => candidate.status === "queued");
    if (queued !== undefined) this.#begin(session, queued);
  }

  #begin(session: StoredSession, turn: StoredTurn): void {
    turn.status = "running";
    this.#active.set(session.sessionId, turn.turnId);
    this.#save(session);
    this.#update(session, turn.turnId, { type: "turn_started", turnId: turn.turnId, prompt: turn.prompt });
    this.#options.onTurn({ turnId: turn.turnId, prompt: turn.prompt });
  }

  #session(params: { [key: string]: unknown }): StoredSession {
    const session = this.#sessions.get(String(params["sessionId"]));
    if (session === undefined) throw new JsonRpcError(REFERENCE_ERRORS.notFound, `no session ${String(params["sessionId"])} is loaded`);
    return session;
  }

  #open(session: StoredSession): { sessionId: string; cwd: string } {
    this.#sessions.set(session.sessionId, session);
    for (const turn of session.turns) this.#turnSessions.set(turn.turnId, session.sessionId);
    return { sessionId: session.sessionId, cwd: session.cwd };
  }

  #handle(method: string, params: { [key: string]: unknown }): unknown {
    switch (method) {
      case "initialize":
        return { agent: "reference-agent", version: REFERENCE_AGENT_VERSION };
      case "session/new": {
        const session: StoredSession = {
          sessionId: this.#store.nextId("session"),
          cwd: this.#options.realpath(String(params["cwd"])),
          turns: [],
          tasks: [],
          injectedMessages: 0,
          compactions: 0,
        };
        this.#save(session);
        return this.#open(session);
      }
      case "session/load": {
        const sessionId = String(params["sessionId"]);
        if (this.#store.isLocked(sessionId)) throw new JsonRpcError(REFERENCE_ERRORS.locked, `session ${sessionId} is already open in another process`);
        const stored = this.#sessions.get(sessionId) ?? this.#store.load(sessionId);
        if (stored === undefined) throw new JsonRpcError(REFERENCE_ERRORS.notFound, `no session ${sessionId}`);
        return this.#open(stored);
      }
      case "session/prompt": {
        const session = this.#session(params);
        const active = this.#active.get(session.sessionId);
        const queue = params["queue"] === true;
        if (active !== undefined && !queue) throw new JsonRpcError(REFERENCE_ERRORS.turnActive, `turn ${active} is still running`);
        const turn: StoredTurn = { turnId: this.#store.nextId("turn"), prompt: String(params["text"]), status: "queued", items: [] };
        session.turns.push(turn);
        this.#turnSessions.set(turn.turnId, session.sessionId);
        if (active === undefined) this.#begin(session, turn);
        else this.#save(session);
        return { turnId: turn.turnId, queued: active !== undefined };
      }
      case "session/steer": {
        const session = this.#session(params);
        const turnId = String(params["turnId"]);
        if (this.#active.get(session.sessionId) !== turnId) throw new JsonRpcError(REFERENCE_ERRORS.noActiveTurn, `turn ${turnId} is not running`);
        this.#steerQueue(turnId).push(String(params["text"]));
        return {};
      }
      case "session/cancel": {
        const turnId = String(params["turnId"]);
        this.#cancelled.add(turnId);
        for (const waiter of this.#stopWaiters.get(turnId) ?? []) waiter("cancel");
        this.#stopWaiters.delete(turnId);
        return {};
      }
      case "session/snapshot":
        return this.#session(params);
      case "session/fork": {
        const source = this.#session(params);
        const atTurnId = params["atTurnId"] === undefined ? undefined : String(params["atTurnId"]);
        const cut = atTurnId === undefined ? source.turns.length : source.turns.findIndex((turn) => turn.turnId === atTurnId) + 1;
        if (cut === 0) throw new JsonRpcError(REFERENCE_ERRORS.notFound, `no turn ${String(atTurnId)}`);
        const fork: StoredSession = {
          sessionId: this.#store.nextId("session"),
          cwd: source.cwd,
          turns: JSON.parse(JSON.stringify(source.turns.slice(0, cut).filter((turn) => turn.status !== "queued" && turn.status !== "running"))) as StoredTurn[],
          tasks: [],
          injectedMessages: source.injectedMessages,
          compactions: source.compactions,
        };
        this.#save(fork);
        return this.#open(fork);
      }
      case "session/rollback": {
        const session = this.#session(params);
        const toTurnId = params["toTurnId"] === undefined ? undefined : String(params["toTurnId"]);
        const keep = toTurnId === undefined ? 0 : session.turns.findIndex((turn) => turn.turnId === toTurnId) + 1;
        session.turns = session.turns.slice(0, keep);
        this.#save(session);
        return session;
      }
      case "session/compact": {
        const session = this.#session(params);
        session.compactions += 1;
        this.#save(session);
        return {};
      }
      case "session/inject": {
        const session = this.#session(params);
        session.injectedMessages += Array.isArray(params["messages"]) ? params["messages"].length : 0;
        this.#save(session);
        return {};
      }
      case "session/unload":
        this.#session(params);
        this.#sessions.delete(String(params["sessionId"]));
        return {};
      case "tasks/list":
        return { tasks: this.#session(params).tasks };
      case "tasks/stop": {
        const session = this.#session(params);
        const task = session.tasks.find((candidate) => candidate.taskId === params["taskId"]);
        if (task === undefined) throw new JsonRpcError(REFERENCE_ERRORS.notFound, `no task ${String(params["taskId"])}`);
        if (task.status === "running") {
          task.status = "stopped";
          this.#save(session);
          this.#update(session, task.turnId, { type: "task_finished", taskId: task.taskId, status: "stopped" });
        }
        return {};
      }
      case "tasks/await": {
        const session = this.#session(params);
        const wanted = Array.isArray(params["taskIds"]) ? params["taskIds"].map(String) : [];
        return { matched: session.tasks.filter((task) => wanted.includes(task.taskId)).map((task) => task.taskId) };
      }
      case "subagent/stop": {
        const subagentId = String(params["subagentId"]);
        const subagent = this.#subagents.get(subagentId);
        if (subagent === undefined) throw new JsonRpcError(REFERENCE_ERRORS.notFound, `no subagent ${subagentId}`);
        if (subagent.status === "running") {
          subagent.status = "cancelled";
          const session = this.#sessions.get(subagent.sessionId);
          if (session !== undefined) this.#update(session, subagent.turnId, { type: "subagent_finished", subagentId, status: "cancelled" });
        }
        return { status: subagent.status };
      }
      case "mcp/listTools":
        return { tools: [{ name: "echo", description: "Returns its input." }] };
      case "mcp/callTool":
        return { content: [{ type: "text", text: JSON.stringify(params["args"] ?? {}) }] };
      case "mcp/readResource":
        return { contents: [{ uri: String(params["uri"]), text: "# Reference agent\n" }] };
      case "feedback/upload":
        this.#session(params);
        return { feedbackId: this.#store.nextId("feedback") };
      case "ext/echo":
        return params["params"] ?? null;
      default:
        throw new JsonRpcError(-32601, `Method not found: ${method}`);
    }
  }
}
