// A fake Codex CLI for the Codex driver's tests. It answers the three
// commands the driver runs: `codex --version`, `codex login status` and
// `codex app-server`. The app-server is in memory (behind a `SpawnedProcess`
// made of queues) and speaks the app-server JSON-RPC protocol of the vendored
// schema (Codex tag rust-v0.172.0): NDJSON frames without a "jsonrpc" member,
// server request ids from 0, `turn/started` after the `turn/start` answer,
// `serverRequest/resolved` after each answered server request, and so on, as
// the recorded app-server transcripts listed in SOURCES.md show.
//
// Every frame it sends and every frame the driver sends is checked against
// the vendored schema (`CodexFrameValidator`); `world.validator.problems`
// lists any that does not validate.
//
// The fake does nothing on its own. Each turn waits for its puppet: the
// conformance kit's `NativeTurn` steps, plus Codex-only steps the quirk tests
// use (async questions, goal turns Codex starts itself, file changes with
// diffs, plan updates, rate-limit updates, structured questions).
//
// Native threads live in a store per Codex home (`CODEX_HOME`, else the
// ambient home), shared by every app-server process of one world, so a
// thread survives a process exit and a second process can resume it. A
// thread loaded by a live process holds its writer lock: another process
// cannot resume it, as with Codex's rollout writer locks.

import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { createMemoryProcess } from "../../../src/conformance/index.ts";
import type { FakeSpawnRequest, NativeActivity, NativeApproval, NativeApprovalHandle, NativeFailure, NativeSessionState, NativeTool, NativeTurn } from "../../../src/conformance/index.ts";
import type { MemoryProcess } from "../../../src/conformance/index.ts";
import { AsyncQueue } from "../../../src/conformance/util.ts";
import { decisionOptionId } from "../../../src/drivers/codex/index.ts";
import type {
  CommandExecutionApprovalDecision,
  RateLimitSnapshot,
  SandboxPolicy,
  Thread,
  ThreadGoal,
  ThreadItem,
  Turn,
  UserInput,
} from "../../../src/drivers/codex/generated/protocol.ts";
import type { SpawnedProcess } from "../../../src/index.ts";
import { CodexFrameValidator } from "./schema-validator.ts";

export const FAKE_CODEX_VERSION = "0.172.0";
export const FAKE_MCP_SERVER = "fake-tools";
export const FAKE_MCP_TOOL = "echo";
export const FAKE_MCP_RESOURCE = "fake://readme";

type JsonObject = { [key: string]: unknown };
type AmbientAuth = "authenticated" | "unauthenticated" | "unknown" | "unavailable";

const LOCKED_MESSAGE = (threadId: string) => `error resuming thread: thread ${threadId} already has an active writer`;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}

function inputText(input: readonly UserInput[]): string {
  return input.flatMap((entry) => ("type" in entry && entry.type === "text" ? [entry.text] : [])).join("\n");
}

class RpcFailure extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

interface StoredTurn {
  readonly id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed";
  readonly items: ThreadItem[];
  readonly startedAt: number;
  completedAt: number | null;
  error: { message: string; codexErrorInfo?: string } | null;
  /** The prompt of the turn: its first user message. */
  readonly prompt: string | undefined;
}

export interface StoredThread {
  readonly id: string;
  cwd: string;
  readonly createdAt: number;
  updatedAt: number;
  readonly turns: StoredTurn[];
  compactions: number;
  readonly injected: string[];
  archived: boolean;
  readonly forkedFromId: string | null;
  readonly parentThreadId: string | null;
  readonly agentNickname: string | null;
  goal: ThreadGoal | undefined;
  readState: { revision: number; unread: boolean };
  readonly terminals: Array<{ processId: string; command: string; cwd: string; itemId: string; running: boolean }>;
  readonly subagents: Array<{ name: string; childThreadId: string; running: boolean }>;
  /** What the client sent when it started, resumed or forked the thread, newest last. */
  readonly launches: JsonObject[];
}

/** The threads under one Codex home. */
export class FakeCodexStore {
  readonly home: string;
  readonly threads = new Map<string, StoredThread>();
  readonly locked = new Set<string>();
  account: { type: "apiKey" } | { type: "chatgpt"; email: string | null; planType: "plus" } | undefined;
  #threadCount = 0;
  #turnCount = 0;
  #itemCount = 0;

  constructor(home: string) {
    this.home = home;
  }

  newThreadId(): string {
    this.#threadCount += 1;
    return `019a0000-0000-7000-8000-${String(this.#threadCount).padStart(12, "0")}`;
  }

  newTurnId(): string {
    this.#turnCount += 1;
    return `019a0000-0000-7000-9000-${String(this.#turnCount).padStart(12, "0")}`;
  }

  newItemId(prefix: string): string {
    this.#itemCount += 1;
    return `${prefix}_${String(this.#itemCount).padStart(4, "0")}`;
  }
}

/** One turn as the puppet drives it. */
export interface FakeTurn {
  readonly id: string;
  readonly threadId: string;
  readonly server: FakeAppServer;
  readonly stored: StoredTurn;
  /** Started by `turn/start`; false for a turn Codex started on its own. */
  readonly byClient: boolean;
  readonly params: JsonObject;
  readonly steers: AsyncQueue<string>;
  stop: ((how: "cancel" | "exit") => void) | undefined;
  stopRequest: Promise<"cancel" | "exit">;
  /** Completed natively; the `turn/completed` frame waits for `release`. */
  held: boolean;
}

interface PendingServerRequest {
  readonly method: string;
  readonly threadId: string | undefined;
  readonly resolve: (result: unknown) => void;
}

/** The Codex-only puppet steps, on top of the kit's `NativeTurn`. */
export interface CodexNativeTurn extends NativeTurn {
  readonly nativeTurnId: string;
  readonly nativeThreadId: string;
  /** The params of the `turn/start` that started this turn (empty for a turn Codex started itself). */
  readonly startParams: JsonObject;
  /** An agent message that asks async questions: Codex reads the answers from the next user message. */
  askAsync(text: string, questions: ReadonlyArray<{ title: string; options?: string[] }>): Promise<void>;
  /** A file change with its diff. */
  changeFiles(changes: ReadonlyArray<{ path: string; kind: "add" | "delete" | "update"; diff: string }>): Promise<string>;
  /** A `turn/plan/updated`. */
  updatePlan(steps: ReadonlyArray<{ step: string; status: "pending" | "inProgress" | "completed" }>, explanation?: string): Promise<void>;
  /** A command approval with these Codex decisions; resolves with the decision the client chose. */
  commandApproval(command: string, decisions: readonly CommandExecutionApprovalDecision[], options?: { kind?: "command" | "humanCommand" }): Promise<{ decision: Promise<unknown> }>;
  /** A file-change approval for an item `changeFiles` reported; resolves with the client's decision. */
  fileChangeApproval(itemId: string): Promise<{ decision: Promise<unknown> }>;
  /** A blocking `item/tool/requestUserInput`; resolves with the client's answers. */
  requestUserInput(questions: ReadonlyArray<{ id: string; question: string; options?: string[] }>): Promise<{ answers: Promise<unknown> }>;
  /** A dynamic tool call to the client; resolves with the client's result. */
  callDynamicTool(tool: string, args: unknown): Promise<unknown>;
  /** A `thread/tokenUsage/updated`. */
  reportUsage(totalTokens: number, contextWindow: number): Promise<void>;
}

/** One `codex app-server` process. */
export class FakeAppServer {
  readonly world: FakeCodexWorld;
  readonly store: FakeCodexStore;
  readonly memory: MemoryProcess;
  readonly environment: { readonly [name: string]: string };
  readonly loaded = new Set<string>();
  readonly #pending = new Map<number, PendingServerRequest>();
  #nextServerRequest = 0;
  #initialized = false;
  optOut: readonly string[] = [];
  /** Every client request this process handled, in order. */
  readonly requests: Array<{ method: string; params: unknown }> = [];

  constructor(world: FakeCodexWorld, store: FakeCodexStore, environment: { readonly [name: string]: string }) {
    this.world = world;
    this.store = store;
    this.environment = environment;
    let partial = "";
    this.memory = createMemoryProcess({
      onStdin: (text) => {
        partial += text;
        let newline = partial.indexOf("\n");
        while (newline !== -1) {
          const line = partial.slice(0, newline);
          partial = partial.slice(newline + 1);
          if (line.trim() !== "") this.#receive(JSON.parse(line) as unknown);
          newline = partial.indexOf("\n");
        }
      },
      onStdinClosed: () => this.exit(0, null),
      onKill: (signal) => this.exit(null, signal),
    });
  }

  get alive(): boolean {
    return !this.memory.exited;
  }

  /** Ends the process: its loaded threads lose their writer, its turns stop. */
  exit(code: number | null, signal: string | null): void {
    if (this.memory.exited) return;
    for (const turn of this.world.activeTurns()) {
      if (turn.server !== this) continue;
      turn.stored.status = "interrupted";
      turn.stored.completedAt = seconds();
      turn.stop?.("exit");
      this.world.endTurn(turn);
    }
    // Background terminals die with the process.
    for (const threadId of this.loaded) for (const terminal of this.store.threads.get(threadId)?.terminals ?? []) terminal.running = false;
    this.loaded.clear();
    this.memory.exit(code, signal);
  }

  #write(frame: JsonObject): void {
    if (!this.alive) return;
    this.memory.stdout(`${JSON.stringify(frame)}\n`);
  }

  notify(method: string, params: JsonObject): void {
    if (this.optOut.includes(method)) return;
    const frame = { method, params };
    this.world.validator.checkCall("from_codex", frame);
    this.#write(frame);
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.#nextServerRequest;
    this.#nextServerRequest += 1;
    const frame = { id, method, params };
    this.world.validator.checkCall("from_codex", frame);
    return new Promise((resolve) => {
      this.#pending.set(id, { method, threadId: typeof params["threadId"] === "string" ? params["threadId"] : undefined, resolve });
      this.#write(frame);
    });
  }

  #receive(frame: unknown): void {
    if (!isObject(frame)) return;
    if (typeof frame["method"] === "string") {
      this.world.validator.checkCall("to_codex", frame);
      if (!("id" in frame)) {
        if (frame["method"] === "initialized") this.#initialized = true;
        return;
      }
      const id = frame["id"] as number | string;
      const method = frame["method"];
      const params = (frame["params"] ?? {}) as JsonObject;
      this.requests.push({ method, params });
      this.world.requests.push({ method, params, server: this });
      const fail = (error: unknown): void => {
        const failure = error instanceof RpcFailure ? error : new RpcFailure(-32603, error instanceof Error ? error.message : String(error));
        const response = { id, error: { code: failure.code, message: failure.message, ...(failure.data === undefined ? {} : { data: failure.data }) } };
        this.world.validator.checkResponse("from_codex", response, method);
        this.#write(response);
      };
      const answer = (result: unknown): void => {
        const after = result instanceof Answer ? result.after : undefined;
        const value = result instanceof Answer ? result.value : result;
        const response = { id, result: value };
        this.world.validator.checkResponse("from_codex", response, method);
        this.#write(response);
        after?.();
      };
      let result: unknown;
      try {
        result = this.#handle(method, params);
      } catch (error) {
        fail(error);
        return;
      }
      // Most answers go out at once, in order; sign-in waits for its local listener.
      if (result instanceof Promise) result.then(answer, fail);
      else answer(result);
      return;
    }
    if ("id" in frame) {
      const pending = this.#pending.get(frame["id"] as number);
      if (pending === undefined) return;
      this.#pending.delete(frame["id"] as number);
      this.world.validator.checkResponse("to_codex", frame, pending.method);
      pending.resolve("result" in frame ? frame["result"] : { error: frame["error"] });
      if (pending.threadId !== undefined) this.notify("serverRequest/resolved", { threadId: pending.threadId, requestId: frame["id"] as number });
    }
  }

  thread(threadId: string): StoredThread {
    const thread = this.store.threads.get(threadId);
    if (thread === undefined) throw new RpcFailure(-32600, `thread not found: ${threadId}`);
    return thread;
  }

  #loadedThread(threadId: string): StoredThread {
    const thread = this.thread(threadId);
    if (!this.loaded.has(threadId)) throw new RpcFailure(-32600, `thread not found: ${threadId}`);
    return thread;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  #handle(method: string, params: JsonObject): unknown {
    switch (method) {
      case "initialize": {
        const capabilities = (params["capabilities"] ?? {}) as JsonObject;
        this.optOut = Array.isArray(capabilities["optOutNotificationMethods"]) ? (capabilities["optOutNotificationMethods"] as string[]) : [];
        return { userAgent: `codex_cli_rs/${FAKE_CODEX_VERSION} (fake)`, codexHome: this.store.home, platformFamily: "unix", platformOs: "linux" };
      }
      case "account/read":
        return { account: this.store.account ?? null, requiresOpenaiAuth: true };
      case "account/login/start":
        return this.#login(params);
      case "account/login/cancel":
        return { status: this.world.cancelLogin(params["loginId"] as string) ? "canceled" : "notFound" };
      case "account/logout":
        this.store.account = undefined;
        return {};
      case "account/rateLimits/read":
        return { rateLimits: this.world.rateLimits };
      case "account/rateLimitResetCredit/consume":
        return { outcome: "reset" };
      case "model/list":
        return {
          data: [
            { id: "fake-large", model: "fake-large", displayName: "Fake large", description: "The default fake model.", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "medium", description: "Balanced" }] },
            { id: "fake-small", model: "fake-small", displayName: "Fake small", description: "", hidden: false, isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }] },
          ],
          nextCursor: null,
        };
      case "thread/start":
        return this.#startThread(params);
      case "thread/resume":
        return this.#resumeThread(params);
      case "thread/fork":
        return this.#forkThread(params);
      case "thread/read": {
        const thread = this.thread(params["threadId"] as string);
        const result = { thread: this.world.threadObject(thread, params["includeTurns"] === true), readState: this.world.readState(thread) };
        this.world.recordExtension("thread/read", params, result);
        return result;
      }
      case "thread/turns/list": {
        const thread = this.thread(params["threadId"] as string);
        const turns = thread.turns.map((turn) => this.world.turnObject(turn, "full"));
        return { data: params["sortDirection"] === "asc" ? turns : turns.reverse(), nextCursor: null };
      }
      case "thread/list":
        return this.#listThreads(params);
      case "thread/archive":
        this.thread(params["threadId"] as string).archived = true;
        return {};
      case "thread/delete":
        this.thread(params["threadId"] as string);
        this.store.threads.delete(params["threadId"] as string);
        return {};
      case "thread/unsubscribe": {
        const threadId = params["threadId"] as string;
        if (!this.loaded.has(threadId)) return { status: "notLoaded" };
        this.loaded.delete(threadId);
        return new Answer({ status: "unsubscribed" }, () => this.notify("thread/closed", { threadId }));
      }
      case "thread/revert": {
        const thread = this.#loadedThread(params["threadId"] as string);
        const index = thread.turns.findIndex((turn) => turn.id === params["beforeTurnId"]);
        if (index === -1) throw new RpcFailure(-32600, `turn not found: ${String(params["beforeTurnId"])}`);
        thread.turns.splice(index);
        return { thread: this.world.threadObject(thread, false) };
      }
      case "thread/compact/start": {
        const thread = this.#loadedThread(params["threadId"] as string);
        return new Answer({}, () => this.#compact(thread));
      }
      case "thread/inject_items": {
        const thread = this.#loadedThread(params["threadId"] as string);
        for (const item of params["items"] as JsonObject[]) {
          const content = (item["content"] ?? []) as Array<{ text?: string }>;
          thread.injected.push(content.map((part) => part.text ?? "").join("\n"));
        }
        return {};
      }
      case "thread/goal/set": {
        const thread = this.#loadedThread(params["threadId"] as string);
        const now = seconds();
        const previous = thread.goal;
        const goal: ThreadGoal = {
          threadId: thread.id,
          objective: (params["objective"] as string | undefined) ?? previous?.objective ?? "",
          status: (params["status"] as ThreadGoal["status"] | undefined) ?? previous?.status ?? "active",
          tokensUsed: previous?.tokensUsed ?? 1200 + this.world.goalCounter(),
          timeUsedSeconds: previous?.timeUsedSeconds ?? 7,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          ...("tokenBudget" in params ? { tokenBudget: params["tokenBudget"] as number | null } : previous?.tokenBudget === undefined ? {} : { tokenBudget: previous.tokenBudget }),
        };
        thread.goal = goal;
        const result = { goal };
        this.world.recordExtension("thread/goal/set", params, result);
        return new Answer(result, () => this.notify("thread/goal/updated", { threadId: thread.id, goal }));
      }
      case "thread/goal/get": {
        const thread = this.thread(params["threadId"] as string);
        const result = { goal: thread.goal ?? null };
        this.world.recordExtension("thread/goal/get", params, result);
        return result;
      }
      case "thread/goal/clear": {
        const thread = this.thread(params["threadId"] as string);
        const cleared = thread.goal !== undefined;
        thread.goal = undefined;
        return new Answer({ cleared }, () => this.notify("thread/goal/cleared", { threadId: thread.id }));
      }
      case "thread/backgroundTerminals/list": {
        const thread = this.#loadedThread(params["threadId"] as string);
        return { data: thread.terminals.filter((terminal) => terminal.running).map(({ running: _running, ...terminal }) => terminal), nextCursor: null };
      }
      case "thread/backgroundTerminals/terminate": {
        const thread = this.#loadedThread(params["threadId"] as string);
        const terminal = thread.terminals.find((candidate) => candidate.processId === params["processId"] && candidate.running);
        if (terminal !== undefined) terminal.running = false;
        return { terminated: terminal !== undefined };
      }
      case "thread/memory/read": {
        const thread = this.#loadedThread(params["threadId"] as string);
        const result = { summary: `Memory summary ${this.world.memoryCounter()} for ${thread.id}` };
        this.world.recordExtension("thread/memory/read", params, result);
        return result;
      }
      case "thread/readState/update": {
        const thread = this.#loadedThread(params["threadId"] as string);
        const current = this.world.readState(thread);
        if (params["expectedRevision"] !== current.revision) throw new RpcFailure(-32600, "read state conflict", { reason: "readStateConflict", readState: current });
        thread.readState = { revision: thread.readState.revision + 1, unread: (params["operation"] as { type: string }).type === "unread" };
        const readState = this.world.readState(thread);
        return new Answer({ readState }, () => this.notify("thread/readState/changed", { threadId: thread.id, readState }));
      }
      case "review/start":
        return this.#startReview(params);
      case "turn/start":
        return this.#startTurn(params);
      case "turn/steer":
        return this.#steer(params);
      case "turn/interrupt":
        return this.#interrupt(params);
      case "mcpServerStatus/list": {
        const tools = { [FAKE_MCP_TOOL]: { name: FAKE_MCP_TOOL, description: "Echoes its arguments, numbering each call.", inputSchema: { type: "object", properties: { text: { type: "string" } } } } };
        const status = { name: FAKE_MCP_SERVER, authStatus: "unsupported", tools, resources: [{ name: "readme", uri: FAKE_MCP_RESOURCE, mimeType: "text/plain" }], resourceTemplates: [] };
        const data = params["serverName"] === undefined || params["serverName"] === FAKE_MCP_SERVER ? [status] : [];
        if (data.length > 0) this.world.activityLog.mcp.push({ operation: "listTools", server: FAKE_MCP_SERVER, output: [{ name: FAKE_MCP_TOOL, description: tools[FAKE_MCP_TOOL].description, inputSchema: tools[FAKE_MCP_TOOL].inputSchema }] });
        return { data, nextCursor: null };
      }
      case "mcpServer/tool/call": {
        if (params["server"] !== FAKE_MCP_SERVER || params["tool"] !== FAKE_MCP_TOOL) throw new RpcFailure(-32600, `unknown tool ${String(params["server"])}/${String(params["tool"])}`);
        const call = this.world.mcpCounter();
        const result = { content: [{ type: "text", text: `echo #${call}: ${JSON.stringify(params["arguments"] ?? {})}` }], isError: false };
        this.world.activityLog.mcp.push({ operation: "callTool", server: FAKE_MCP_SERVER, tool: FAKE_MCP_TOOL, args: params["arguments"] ?? {}, output: result });
        return result;
      }
      case "mcpServer/resource/read": {
        if (params["server"] !== FAKE_MCP_SERVER || params["uri"] !== FAKE_MCP_RESOURCE) throw new RpcFailure(-32600, `unknown resource ${String(params["uri"])}`);
        const read = this.world.mcpCounter();
        const contents = [{ uri: FAKE_MCP_RESOURCE, mimeType: "text/plain", text: `readme read #${read}` }];
        this.world.activityLog.mcp.push({ operation: "readResource", server: FAKE_MCP_SERVER, uri: FAKE_MCP_RESOURCE, output: { contents } });
        return { contents };
      }
      case "feedback/upload": {
        const threadId = (params["threadId"] as string | undefined) ?? this.store.newThreadId();
        this.world.activityLog.feedback.push({ feedbackId: threadId, ...(typeof params["reason"] === "string" ? { reason: params["reason"] } : {}) });
        return { threadId };
      }
      default:
        throw new RpcFailure(-32601, `method not found: ${method}`);
    }
  }

  #login(params: JsonObject): unknown {
    const type = params["type"];
    if (type === "apiKey") {
      this.store.account = { type: "apiKey" };
      this.world.logins.push({ type: "apiKey", params });
      return { type: "apiKey" };
    }
    if (type === "chatgptAuthTokens") {
      this.store.account = { type: "chatgpt", email: null, planType: "plus" };
      this.world.logins.push({ type: "chatgptAuthTokens", params });
      return { type: "chatgptAuthTokens" };
    }
    if (type === "chatgptDeviceCode") {
      const loginId = `device-${this.world.loginCount + 1}`;
      this.world.loginStarted(loginId, this, "device");
      return { type: "chatgptDeviceCode", loginId, userCode: "FAKE-1234", verificationUrl: "https://auth.openai.com/codex/device" };
    }
    if (type === "chatgpt") {
      return this.world.loginListener().then((listener) => {
        const port = (listener.address() as AddressInfo).port;
        const loginId = `login-${this.world.loginCount + 1}`;
        this.world.loginStarted(loginId, this, "browser");
        const redirect = `http://127.0.0.1:${port}/auth/callback`;
        return { type: "chatgpt", loginId, authUrl: `https://auth.openai.com/oauth/authorize?client_id=app_fake&redirect_uri=${encodeURIComponent(redirect)}&state=${loginId}` };
      });
    }
    throw new RpcFailure(-32602, `unsupported login type ${String(type)}`);
  }

  #sandbox(params: JsonObject): SandboxPolicy {
    const mode = params["sandbox"];
    if (mode === "read-only") return { type: "readOnly" };
    if (mode === "danger-full-access") return { type: "dangerFullAccess" };
    return { type: "workspaceWrite" };
  }

  #threadResponse(thread: StoredThread, params: JsonObject, withTurns: boolean): JsonObject {
    return {
      thread: this.world.threadObject(thread, withTurns),
      model: (params["model"] as string | undefined) ?? "fake-large",
      modelProvider: "openai",
      cwd: thread.cwd,
      approvalPolicy: params["approvalPolicy"] ?? "on-request",
      approvalsReviewer: params["approvalsReviewer"] ?? "user",
      sandbox: this.#sandbox(params),
    };
  }

  #startThread(params: JsonObject): unknown {
    const cwd = this.world.realpath((params["cwd"] as string | undefined) ?? "/");
    const now = seconds();
    const thread: StoredThread = {
      id: this.store.newThreadId(),
      cwd,
      createdAt: now,
      updatedAt: now,
      turns: [],
      compactions: 0,
      injected: [],
      archived: false,
      forkedFromId: null,
      parentThreadId: null,
      agentNickname: null,
      goal: undefined,
      readState: { revision: 1, unread: false },
      terminals: [],
      subagents: [],
      launches: [params],
    };
    this.store.threads.set(thread.id, thread);
    this.world.noteThread(thread.id);
    this.loaded.add(thread.id);
    return new Answer(this.#threadResponse(thread, params, false), () => this.notify("thread/started", { thread: this.world.threadObject(thread, false) }));
  }

  #resumeThread(params: JsonObject): unknown {
    const threadId = params["threadId"] as string;
    const thread = this.store.threads.get(threadId);
    if (thread === undefined) throw new RpcFailure(-32600, `no rollout found for thread id ${threadId}`);
    const heldElsewhere = this.world.servers.some((server) => server !== this && server.alive && server.loaded.has(threadId));
    if (this.store.locked.has(threadId) || heldElsewhere) throw new RpcFailure(-32603, LOCKED_MESSAGE(threadId));
    if (typeof params["cwd"] === "string") thread.cwd = this.world.realpath(params["cwd"]);
    thread.launches.push(params);
    this.loaded.add(threadId);
    return this.#threadResponse(thread, params, params["excludeTurns"] !== true);
  }

  #forkThread(params: JsonObject): unknown {
    const source = this.thread(params["threadId"] as string);
    let turns = source.turns;
    if (typeof params["lastTurnId"] === "string") {
      const index = turns.findIndex((turn) => turn.id === params["lastTurnId"]);
      if (index === -1) throw new RpcFailure(-32600, `turn not found: ${params["lastTurnId"]}`);
      if (turns[index]!.status === "inProgress") throw new RpcFailure(-32600, "cannot fork through a turn in progress");
      turns = turns.slice(0, index + 1);
    } else if (typeof params["beforeTurnId"] === "string") {
      const index = turns.findIndex((turn) => turn.id === params["beforeTurnId"]);
      turns = index === -1 ? turns : turns.slice(0, index);
    }
    const now = seconds();
    const thread: StoredThread = {
      id: this.store.newThreadId(),
      cwd: typeof params["cwd"] === "string" ? this.world.realpath(params["cwd"]) : source.cwd,
      createdAt: now,
      updatedAt: now,
      turns: turns.filter((turn) => turn.status !== "inProgress").map((turn) => ({ ...turn, items: [...turn.items] })),
      compactions: 0,
      injected: [],
      archived: false,
      forkedFromId: source.id,
      parentThreadId: null,
      agentNickname: null,
      goal: undefined,
      readState: { revision: 1, unread: false },
      terminals: [],
      subagents: [],
      launches: [params],
    };
    this.store.threads.set(thread.id, thread);
    this.loaded.add(thread.id);
    return new Answer(this.#threadResponse(thread, params, false), () => this.notify("thread/started", { thread: this.world.threadObject(thread, false) }));
  }

  #listThreads(params: JsonObject): unknown {
    let threads = [...this.store.threads.values()].filter((thread) => thread.parentThreadId === null);
    const cwd = params["cwd"];
    if (typeof cwd === "string") threads = threads.filter((thread) => thread.cwd === this.world.realpath(cwd));
    if (Array.isArray(cwd)) threads = threads.filter((thread) => (cwd as string[]).map((entry) => this.world.realpath(entry)).includes(thread.cwd));
    threads = threads.filter((thread) => thread.archived === (params["archived"] === true));
    if (typeof params["searchTerm"] === "string") threads = threads.filter((thread) => (thread.turns[0]?.prompt ?? "").includes(params["searchTerm"] as string));
    for (const key of ["excludedThreadIds", "includedThreadIds"] as const) {
      const ids = params[key];
      if (Array.isArray(ids) && ids.length > 100) throw new RpcFailure(-32602, `${key} takes at most 100 thread ids`);
    }
    if (Array.isArray(params["excludedThreadIds"])) threads = threads.filter((thread) => !(params["excludedThreadIds"] as string[]).includes(thread.id));
    if (Array.isArray(params["includedThreadIds"])) threads = threads.filter((thread) => (params["includedThreadIds"] as string[]).includes(thread.id));
    const limit = typeof params["limit"] === "number" ? params["limit"] : 25;
    const start = typeof params["cursor"] === "string" ? Number(params["cursor"]) : 0;
    const page = threads.slice(start, start + limit);
    return { data: page.map((thread) => this.world.threadObject(thread, false)), nextCursor: start + limit < threads.length ? String(start + limit) : null };
  }

  #startTurn(params: JsonObject): unknown {
    const thread = this.#loadedThread(params["threadId"] as string);
    if (this.world.activeTurns().some((turn) => turn.threadId === thread.id && !turn.held)) throw new RpcFailure(-32600, "a turn is already running on this thread");
    const turn = this.world.beginTurn(this, thread, inputText(params["input"] as UserInput[]), true, params);
    return new Answer({ turn: this.world.turnObject(turn.stored, "notLoaded", true) }, () => this.world.announceTurn(turn));
  }

  #steer(params: JsonObject): unknown {
    const thread = this.#loadedThread(params["threadId"] as string);
    const active = this.world.activeTurns().find((turn) => turn.threadId === thread.id && !turn.held);
    if (active === undefined) throw new RpcFailure(-32600, "no active turn to steer");
    if (active.id !== params["expectedTurnId"]) throw new RpcFailure(-32600, `expected active turn id \`${String(params["expectedTurnId"])}\` but found \`${active.id}\``);
    const text = inputText(params["input"] as UserInput[]);
    return new Answer({ turnId: active.id }, () => {
      const item: ThreadItem = { type: "userMessage", id: this.store.newItemId("user"), content: [{ type: "text", text, text_elements: [] }] };
      this.world.emitItem(active, item);
      active.steers.push(text);
    });
  }

  #interrupt(params: JsonObject): unknown {
    const threadId = params["threadId"] as string;
    const active = this.world.activeTurns().find((turn) => turn.threadId === threadId && turn.id === params["turnId"] && !turn.held);
    if (active === undefined) throw new RpcFailure(-32600, "no active turn to interrupt");
    // A subagent's turn stops at once; the kit decides when a root turn reports its cancel.
    const thread = this.thread(threadId);
    if (thread.parentThreadId !== null) return new Answer({}, () => this.world.finishTurn(active, "interrupted"));
    return new Answer({}, () => active.stop?.("cancel"));
  }

  #compact(thread: StoredThread): void {
    const turnId = this.store.newTurnId();
    const now = seconds();
    const turn: Turn = { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: now, completedAt: null, durationMs: null };
    this.notify("turn/started", { threadId: thread.id, turn });
    const item: ThreadItem = { type: "contextCompaction", id: this.store.newItemId("compact") };
    this.notify("item/started", { threadId: thread.id, turnId, item, startedAtMs: Date.now() });
    this.notify("item/completed", { threadId: thread.id, turnId, item, completedAtMs: Date.now() });
    thread.compactions += 1;
    this.notify("thread/compacted", { threadId: thread.id, turnId });
    this.notify("turn/completed", { threadId: thread.id, turn: { ...turn, status: "completed", completedAt: seconds(), durationMs: 0 } });
  }

  #startReview(params: JsonObject): unknown {
    const thread = this.#loadedThread(params["threadId"] as string);
    const turnId = this.store.newTurnId();
    const now = seconds();
    const turn: Turn = { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null };
    const stored: StoredTurn = { id: turnId, status: "inProgress", items: [], startedAt: now, completedAt: null, error: null, prompt: undefined };
    thread.turns.push(stored);
    return new Answer({ reviewThreadId: thread.id, turn }, () => {
      this.notify("turn/started", { threadId: thread.id, turn: { ...turn, startedAt: now } });
      const entered: ThreadItem = { type: "enteredReviewMode", id: this.store.newItemId("review"), review: "current changes" };
      const exited: ThreadItem = { type: "exitedReviewMode", id: this.store.newItemId("review"), review: "No issues found." };
      for (const item of [entered, exited]) {
        this.notify("item/started", { threadId: thread.id, turnId, item, startedAtMs: Date.now() });
        this.notify("item/completed", { threadId: thread.id, turnId, item, completedAtMs: Date.now() });
        stored.items.push(item);
      }
      stored.status = "completed";
      stored.completedAt = seconds();
      this.notify("turn/completed", { threadId: thread.id, turn: { ...turn, status: "completed", startedAt: now, completedAt: stored.completedAt, durationMs: 0 } });
    });
  }
}

/** A result plus frames to send right after it. */
class Answer {
  readonly value: unknown;
  readonly after: () => void;
  constructor(value: unknown, after: () => void) {
    this.value = value;
    this.after = after;
  }
}

export interface FakeCodexOptions {
  readonly ambientAuth?: AmbientAuth;
  /** Turns a given path into the one the OS resolves (symbolic links followed). */
  readonly realpath: (path: string) => string;
  /** What `codex --version` reports. */
  readonly version?: string;
}

/** Everything one rig's fake Codex holds: stores, processes, the puppet queue and what was served. */
export class FakeCodexWorld {
  readonly validator = new CodexFrameValidator();
  readonly servers: FakeAppServer[] = [];
  readonly stores = new Map<string, FakeCodexStore>();
  readonly turnQueue = new AsyncQueue<CodexNativeTurn>();
  readonly requests: Array<{ method: string; params: unknown; server: FakeAppServer }> = [];
  readonly spawns: FakeSpawnRequest[] = [];
  readonly activityLog: { feedback: Array<{ feedbackId: string; reason?: string }>; mcp: NativeActivity["mcp"][number][]; extensions: Array<{ method: string; params: JsonObject; result: unknown }> } = {
    feedback: [],
    mcp: [],
    extensions: [],
  };
  rateLimits: RateLimitSnapshot = { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: 1_900_500_000 } };
  readonly options: FakeCodexOptions;
  readonly #turns = new Map<string, FakeTurn>();
  readonly #logins = new Map<string, { server: FakeAppServer; kind: string }>();
  #loginServer: Promise<http.Server> | undefined;
  #loginCount = 0;
  #mcpCount = 0;
  #goalCount = 0;
  #memoryCount = 0;
  #processCount = 0;
  /** The first thread any process started, in order. */
  readonly threadOrder: string[] = [];

  constructor(options: FakeCodexOptions) {
    this.options = options;
  }

  realpath(value: string): string {
    return this.options.realpath(value);
  }

  storeFor(environment: { readonly [name: string]: string }): FakeCodexStore {
    const home = environment["CODEX_HOME"] ?? `${environment["HOME"] ?? "/home/ambient"}/.codex`;
    let store = this.stores.get(home);
    if (store === undefined) {
      store = new FakeCodexStore(home);
      this.stores.set(home, store);
    }
    return store;
  }

  mcpCounter(): number {
    this.#mcpCount += 1;
    return this.#mcpCount;
  }

  goalCounter(): number {
    this.#goalCount += 1;
    return this.#goalCount;
  }

  memoryCounter(): number {
    this.#memoryCount += 1;
    return this.#memoryCount;
  }

  noteThread(threadId: string): void {
    this.threadOrder.push(threadId);
  }

  recordExtension(method: string, params: JsonObject, result: unknown): void {
    this.activityLog.extensions.push({ method, params, result });
  }

  /** Starts the fake `codex` command a spawn asks for. */
  spawn(request: FakeSpawnRequest): SpawnedProcess {
    this.spawns.push(request);
    const args = request.args ?? [];
    if (args[0] === "app-server") {
      const server = new FakeAppServer(this, this.storeFor(request.environment), request.environment);
      this.servers.push(server);
      this.#processCount += 1;
      return server.memory.process;
    }
    const memory = createMemoryProcess({ onStdin: () => undefined, onStdinClosed: () => undefined, onKill: (signal) => memory.exit(null, signal) });
    queueMicrotask(() => {
      if (args[0] === "--version") {
        memory.stdout(`codex-cli ${this.options.version ?? FAKE_CODEX_VERSION}\n`);
        memory.exit(0, null);
      } else if (args[0] === "login" && args[1] === "status") {
        // codex-rs/cli/src/login.rs prints these to stderr.
        switch (this.options.ambientAuth ?? "authenticated") {
          case "authenticated":
            memory.stderr("Logged in using ChatGPT\n");
            memory.exit(0, null);
            return;
          case "unauthenticated":
            memory.stderr("Not logged in\n");
            memory.exit(1, null);
            return;
          case "unknown":
            memory.stderr("Signed in through an external credential helper\n");
            memory.exit(0, null);
            return;
          default:
            memory.stderr("Error checking login status: the credential store is unavailable\n");
            memory.exit(1, null);
        }
      } else {
        memory.stderr(`error: unrecognized arguments ${args.join(" ")}\n`);
        memory.exit(2, null);
      }
    });
    return memory.process;
  }

  get processCount(): number {
    return this.#processCount;
  }

  // Threads and turns.

  threadObject(thread: StoredThread, withTurns: boolean): Thread {
    const loaded = this.servers.some((server) => server.alive && server.loaded.has(thread.id));
    return {
      id: thread.id,
      sessionId: thread.id,
      cwd: thread.cwd,
      cliVersion: FAKE_CODEX_VERSION,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      ephemeral: false,
      modelProvider: "openai",
      preview: thread.turns[0]?.prompt ?? "",
      projectId: null,
      source: thread.parentThreadId === null ? "appServer" : { subAgent: { thread_spawn: { depth: 1, parent_thread_id: thread.parentThreadId, agent_nickname: thread.agentNickname } } },
      status: { type: loaded ? "idle" : "notLoaded" },
      turns: withTurns ? thread.turns.map((turn) => this.turnObject(turn, "full")) : [],
      forkedFromId: thread.forkedFromId,
      parentThreadId: thread.parentThreadId,
      agentNickname: thread.agentNickname,
    };
  }

  turnObject(turn: StoredTurn, view: "full" | "notLoaded" | "summary", fresh = false): Turn {
    return {
      id: turn.id,
      items: view === "notLoaded" ? [] : view === "summary" ? turn.items.filter((item) => item.type === "agentMessage").slice(-1) : [...turn.items],
      itemsView: view,
      status: turn.status,
      error: turn.error,
      startedAt: fresh ? null : turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.completedAt === null ? null : (turn.completedAt - turn.startedAt) * 1000,
    };
  }

  readState(thread: StoredThread): { revision: string; firstUnread: { type: "threadStart" } | null } {
    return { revision: `rev-${thread.id}-${thread.readState.revision}`, firstUnread: thread.readState.unread ? { type: "threadStart" } : null };
  }

  activeTurns(): FakeTurn[] {
    return [...this.#turns.values()];
  }

  turn(nativeTurnId: string): FakeTurn | undefined {
    return this.#turns.get(nativeTurnId);
  }

  endTurn(turn: FakeTurn): void {
    this.#turns.delete(turn.id);
  }

  /** A new turn on `thread` in `server`: the client's (`turn/start`) or one Codex starts itself. */
  beginTurn(server: FakeAppServer, thread: StoredThread, prompt: string, byClient: boolean, params: JsonObject): FakeTurn {
    const stored: StoredTurn = { id: server.store.newTurnId(), status: "inProgress", items: [], startedAt: seconds(), completedAt: null, error: null, prompt: prompt === "" ? undefined : prompt };
    thread.turns.push(stored);
    thread.updatedAt = seconds();
    let stop: (how: "cancel" | "exit") => void = () => undefined;
    const stopRequest = new Promise<"cancel" | "exit">((resolve) => {
      stop = resolve;
    });
    const turn: FakeTurn = { id: stored.id, threadId: thread.id, server, stored, byClient, params, steers: new AsyncQueue<string>(), stop, stopRequest, held: false };
    this.#turns.set(turn.id, turn);
    return turn;
  }

  /** Sends `turn/started` and the prompt's user message, and hands the turn to the puppet. */
  announceTurn(turn: FakeTurn): void {
    const server = turn.server;
    server.notify("thread/status/changed", { threadId: turn.threadId, status: { type: "active", activeFlags: [] } });
    server.notify("turn/started", { threadId: turn.threadId, turn: this.turnObject(turn.stored, "notLoaded") });
    if (turn.stored.prompt !== undefined) {
      const item: ThreadItem = { type: "userMessage", id: server.store.newItemId("user"), content: [{ type: "text", text: turn.stored.prompt, text_elements: [] }] };
      this.emitItem(turn, item);
    }
    this.turnQueue.push(this.#puppet(turn));
  }

  emitItem(turn: FakeTurn, item: ThreadItem, open = true): void {
    turn.server.notify("item/started", { threadId: turn.threadId, turnId: turn.id, item, startedAtMs: Date.now() });
    if (!open) return;
    turn.server.notify("item/completed", { threadId: turn.threadId, turnId: turn.id, item, completedAtMs: Date.now() });
    turn.stored.items.push(item);
  }

  /** Ends a turn natively and tells the client (unless held). */
  finishTurn(turn: FakeTurn, status: "completed" | "interrupted" | "failed", error?: { message: string; codexErrorInfo?: string }): void {
    turn.stored.status = status;
    turn.stored.completedAt = seconds();
    turn.stored.error = error ?? null;
    this.endTurn(turn);
    // A subagent's thread stops working when its turn ends.
    const child = turn.server.store.threads.get(turn.threadId);
    if (child?.parentThreadId !== null && child?.parentThreadId !== undefined) {
      const entry = turn.server.store.threads.get(child.parentThreadId)?.subagents.find((subagent) => subagent.childThreadId === child.id);
      if (entry !== undefined) entry.running = false;
    }
    if (turn.held) return;
    turn.server.notify("thread/status/changed", { threadId: turn.threadId, status: { type: "idle" } });
    turn.server.notify("turn/completed", { threadId: turn.threadId, turn: this.turnObject(turn.stored, "summary") });
  }

  /** Codex starts the next turn of a goal run on its own. */
  continueGoal(nativeThreadId: string): CodexNativeTurn {
    const server = this.servers.find((candidate) => candidate.alive && candidate.loaded.has(nativeThreadId));
    if (server === undefined) throw new Error(`no live app-server holds thread ${nativeThreadId}`);
    const thread = server.thread(nativeThreadId);
    const turn = this.beginTurn(server, thread, "", false, {});
    server.notify("thread/status/changed", { threadId: turn.threadId, status: { type: "active", activeFlags: [] } });
    server.notify("turn/started", { threadId: turn.threadId, turn: this.turnObject(turn.stored, "notLoaded") });
    return this.#puppet(turn);
  }

  /** Codex changes a goal on its own (for example when the objective is met). */
  setGoalStatus(nativeThreadId: string, status: ThreadGoal["status"]): void {
    for (const server of this.servers) {
      if (!server.alive || !server.loaded.has(nativeThreadId)) continue;
      const thread = server.thread(nativeThreadId);
      if (thread.goal === undefined) throw new Error(`thread ${nativeThreadId} has no goal`);
      thread.goal = { ...thread.goal, status, updatedAt: seconds(), tokensUsed: thread.goal.tokensUsed + 100 };
      server.notify("thread/goal/updated", { threadId: nativeThreadId, goal: thread.goal });
    }
  }

  /** Codex asks the client for fresh ChatGPT tokens; resolves with the client's answer. */
  requestTokenRefresh(): Promise<unknown> {
    const server = this.servers.find((candidate) => candidate.alive);
    if (server === undefined) throw new Error("no live app-server");
    return server.request("account/chatgptAuthTokens/refresh", { reason: "unauthorized", previousAccountId: null });
  }

  /** Sends `account/rateLimits/updated` from every live app-server. */
  updateRateLimits(snapshot: RateLimitSnapshot): void {
    this.rateLimits = snapshot;
    for (const server of this.servers) if (server.alive) server.notify("account/rateLimits/updated", { rateLimits: snapshot });
  }

  // Sign-in.

  /** Every sign-in an app-server took with credentials (`apiKey`, `chatgptAuthTokens`), oldest first. */
  readonly logins: Array<{ type: string; params: JsonObject }> = [];

  cancelLogin(loginId: string): boolean {
    return this.#logins.delete(loginId);
  }

  // Puppet.

  #puppet(turn: FakeTurn): CodexNativeTurn {
    const server = turn.server;
    const store = server.store;
    const world = this;
    const thread = server.thread(turn.threadId);
    const approvals = (kitOptions: NativeApproval["options"], command: string[]): { decisions: CommandExecutionApprovalDecision[]; nativeIds: { [kit: string]: string }; kitFor: Map<string, string> } => {
      let always = 0;
      const decisions: CommandExecutionApprovalDecision[] = [];
      const nativeIds: { [kit: string]: string } = {};
      const kitFor = new Map<string, string>();
      for (const option of kitOptions) {
        let decision: CommandExecutionApprovalDecision;
        if (option.decision === "accept") decision = "accept";
        else if (option.decision === "accept_for_session") decision = "acceptForSession";
        else if (option.decision === "decline") decision = "decline";
        else {
          // Each "always" is a command-prefix rule: the whole command first, then shorter prefixes.
          decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: command.slice(0, Math.max(1, command.length - always)) } };
          always += 1;
        }
        decisions.push(decision);
        nativeIds[option.optionId] = decisionOptionId(decision);
        kitFor.set(decisionOptionId(decision), option.optionId);
      }
      return { decisions, nativeIds, kitFor };
    };
    const live = (): void => {
      if (!server.alive) throw new Error("the app-server process is gone");
    };
    const puppet: CodexNativeTurn = {
      prompt: turn.stored.prompt ?? "",
      nativeTurnId: turn.id,
      nativeThreadId: turn.threadId,
      startParams: turn.params,
      say: async (text) => {
        live();
        const id = store.newItemId("msg");
        const started: ThreadItem = { type: "agentMessage", id, text: "", phase: "final_answer" };
        server.notify("item/started", { threadId: turn.threadId, turnId: turn.id, item: started, startedAtMs: Date.now() });
        const half = Math.ceil(text.length / 2);
        for (const chunk of [text.slice(0, half), text.slice(half)]) {
          if (chunk !== "") server.notify("item/agentMessage/delta", { threadId: turn.threadId, turnId: turn.id, itemId: id, delta: chunk });
        }
        const done: ThreadItem = { type: "agentMessage", id, text, phase: "final_answer" };
        server.notify("item/completed", { threadId: turn.threadId, turnId: turn.id, item: done, completedAtMs: Date.now() });
        turn.stored.items.push(done);
      },
      runTool: async (tool: NativeTool) => {
        live();
        const id = store.newItemId("call");
        const command = `${tool.name} ${JSON.stringify(tool.input)}`;
        const actions = tool.path === undefined ? [{ type: "unknown" as const, command }] : [{ type: "read" as const, command, name: path.basename(tool.path), path: path.join(thread.cwd, tool.path) }];
        const started: ThreadItem = { type: "commandExecution", id, command, commandActions: actions, cwd: thread.cwd, status: "inProgress", source: "agent" };
        server.notify("item/started", { threadId: turn.threadId, turnId: turn.id, item: started, startedAtMs: Date.now() });
        server.notify("item/commandExecution/outputDelta", { threadId: turn.threadId, turnId: turn.id, itemId: id, delta: tool.output });
        const done: ThreadItem = { ...started, status: "completed", aggregatedOutput: tool.output, exitCode: 0, durationMs: 5 } as ThreadItem;
        server.notify("item/completed", { threadId: turn.threadId, turnId: turn.id, item: done, completedAtMs: Date.now() });
        turn.stored.items.push(done);
      },
      requestApproval: async (approval: NativeApproval): Promise<NativeApprovalHandle> => {
        live();
        const replies: string[] = [];
        const waiters: Array<(reply: string) => void> = [];
        const record = (kitId: string): void => {
          replies.push(kitId);
          for (const waiter of waiters.splice(0)) waiter(kitId);
        };
        const itemId = store.newItemId("call");
        const command = [...(approval.command ?? ["git", "status"])];
        const mapped = approvals(approval.options, command);
        let pending: Promise<unknown>;
        if (approval.kind === "command") {
          pending = server.request("item/commandExecution/requestApproval", {
            threadId: turn.threadId,
            turnId: turn.id,
            itemId,
            command: command.join(" "),
            cwd: thread.cwd,
            availableDecisions: mapped.decisions,
            startedAtMs: Date.now(),
          });
        } else {
          const changes = [{ path: path.join(thread.cwd, approval.path ?? "README.md"), kind: { type: "update" as const, move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new\n" }];
          const item: ThreadItem = { type: "fileChange", id: itemId, changes, status: "inProgress" };
          server.notify("item/started", { threadId: turn.threadId, turnId: turn.id, item, startedAtMs: Date.now() });
          pending = server.request("item/fileChange/requestApproval", { threadId: turn.threadId, turnId: turn.id, itemId, startedAtMs: Date.now() });
        }
        void pending.then((result) => {
          const decision = isObject(result) ? result["decision"] : undefined;
          const kitId = decision === undefined ? undefined : mapped.kitFor.get(decisionOptionId(decision as CommandExecutionApprovalDecision));
          if (kitId !== undefined) record(kitId);
        });
        return {
          nextReply: () => (replies.length > 0 ? Promise.resolve(replies[0]!) : new Promise<string>((resolve) => waiters.push(resolve))),
          replies: async () => [...replies],
          nativeOptionIds: mapped.nativeIds,
        };
      },
      startBackgroundTask: async (task) => {
        live();
        const id = store.newItemId("exec");
        const processId = `proc-${store.newItemId("pty")}`;
        thread.terminals.push({ processId, command: task.title, cwd: thread.cwd, itemId: id, running: true });
        const item: ThreadItem = { type: "commandExecution", id, command: task.title, commandActions: [{ type: "unknown", command: task.title }], cwd: thread.cwd, status: "inProgress", processId, source: "unifiedExecStartup" };
        server.notify("item/started", { threadId: turn.threadId, turnId: turn.id, item, startedAtMs: Date.now() });
      },
      spawnSubagent: async (subagent) => {
        live();
        const childId = store.newThreadId();
        const now = seconds();
        const child: StoredThread = {
          id: childId,
          cwd: thread.cwd,
          createdAt: now,
          updatedAt: now,
          turns: [],
          compactions: 0,
          injected: [],
          archived: false,
          forkedFromId: null,
          parentThreadId: thread.id,
          agentNickname: subagent.name,
          goal: undefined,
          readState: { revision: 1, unread: false },
          terminals: [],
          subagents: [],
          launches: [],
        };
        store.threads.set(childId, child);
        server.loaded.add(childId);
        thread.subagents.push({ name: subagent.name, childThreadId: childId, running: true });
        server.notify("thread/started", { thread: world.threadObject(child, false) });
        const activity: ThreadItem = { type: "subAgentActivity", id: store.newItemId("call"), kind: "started", agentThreadId: childId, agentPath: `/root/${subagent.name}` };
        world.emitItem(turn, activity);
        const childTurn = world.beginTurn(server, child, `Work as ${subagent.name}.`, false, {});
        server.notify("thread/status/changed", { threadId: childId, status: { type: "active", activeFlags: [] } });
        server.notify("turn/started", { threadId: childId, turn: world.turnObject(childTurn.stored, "notLoaded") });
      },
      nextSteer: async () => {
        const next = await turn.steers.next();
        if (next.done === true) throw new Error("the turn ended without a steer");
        return next.value;
      },
      complete: async () => {
        live();
        world.finishTurn(turn, "completed");
      },
      completeHeld: async () => {
        live();
        turn.held = true;
        world.finishTurn(turn, "completed");
        return {
          release: async () => {
            turn.held = false;
            server.notify("thread/status/changed", { threadId: turn.threadId, status: { type: "idle" } });
            server.notify("turn/completed", { threadId: turn.threadId, turn: world.turnObject(turn.stored, "summary") });
          },
        };
      },
      fail: async (failure: NativeFailure) => {
        live();
        if (failure.kind === "usage_limit") {
          const resetsAt = Math.floor(Date.parse(failure.resetAt) / 1000);
          const snapshot: RateLimitSnapshot = { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt }, rateLimitReachedType: "rate_limit_reached" };
          world.rateLimits = snapshot;
          server.notify("account/rateLimits/updated", { rateLimits: snapshot });
          const error = { message: failure.message, codexErrorInfo: "usageLimitExceeded" };
          server.notify("error", { threadId: turn.threadId, turnId: turn.id, error, willRetry: false });
          world.finishTurn(turn, "failed", error);
          return;
        }
        const error = { message: failure.message, codexErrorInfo: "internalServerError" };
        server.notify("error", { threadId: turn.threadId, turnId: turn.id, error, willRetry: false });
        world.finishTurn(turn, "failed", error);
      },
      stopRequested: () => turn.stopRequest,
      finishCancelled: async () => {
        live();
        world.finishTurn(turn, "interrupted");
      },
      exitProcess: async () => {
        server.exit(1, null);
      },
      askAsync: async (text, questions) => {
        live();
        const item: ThreadItem = { type: "agentMessage", id: store.newItemId("msg"), text, phase: "final_answer", delivery: "async", questions: questions.map((question) => ({ title: question.title, ...(question.options === undefined ? {} : { options: [...question.options] }) })) };
        world.emitItem(turn, item);
      },
      changeFiles: async (changes) => {
        live();
        const id = store.newItemId("patch");
        const native = changes.map((change) => ({ path: path.join(thread.cwd, change.path), kind: change.kind === "update" ? { type: "update" as const, move_path: null } : { type: change.kind }, diff: change.diff }));
        const started: ThreadItem = { type: "fileChange", id, changes: native, status: "inProgress" };
        server.notify("item/started", { threadId: turn.threadId, turnId: turn.id, item: started, startedAtMs: Date.now() });
        const done: ThreadItem = { type: "fileChange", id, changes: native, status: "completed" };
        server.notify("item/completed", { threadId: turn.threadId, turnId: turn.id, item: done, completedAtMs: Date.now() });
        turn.stored.items.push(done);
        return id;
      },
      updatePlan: async (steps, explanation) => {
        live();
        server.notify("turn/plan/updated", { threadId: turn.threadId, turnId: turn.id, plan: steps.map((step) => ({ ...step })), ...(explanation === undefined ? {} : { explanation }) });
      },
      commandApproval: async (command, decisions, options) => {
        live();
        const itemId = store.newItemId("call");
        const decision = server.request("item/commandExecution/requestApproval", {
          threadId: turn.threadId,
          turnId: turn.id,
          itemId,
          command,
          cwd: thread.cwd,
          availableDecisions: [...decisions],
          startedAtMs: Date.now(),
          ...(options?.kind === undefined ? {} : { kind: options.kind, approvalId: `approval-${itemId}` }),
        });
        return { decision: decision.then((result) => (isObject(result) ? result["decision"] : result)) };
      },
      fileChangeApproval: async (itemId) => {
        live();
        const decision = server.request("item/fileChange/requestApproval", { threadId: turn.threadId, turnId: turn.id, itemId, startedAtMs: Date.now() });
        return { decision: decision.then((result) => (isObject(result) ? result["decision"] : result)) };
      },
      requestUserInput: async (questions) => {
        live();
        const answers = server.request("item/tool/requestUserInput", {
          threadId: turn.threadId,
          turnId: turn.id,
          itemId: store.newItemId("call"),
          isBlocking: true,
          questions: questions.map((question) => ({ id: question.id, header: "Question", question: question.question, isOther: true, options: question.options === undefined ? null : question.options.map((label) => ({ label, description: "" })) })),
        });
        return { answers };
      },
      callDynamicTool: async (tool, args) => {
        live();
        return server.request("item/tool/call", { threadId: turn.threadId, turnId: turn.id, callId: store.newItemId("call"), tool, arguments: args });
      },
      reportUsage: async (totalTokens, contextWindow) => {
        live();
        const breakdown = { inputTokens: totalTokens - 10, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens };
        server.notify("thread/tokenUsage/updated", { threadId: turn.threadId, turnId: turn.id, tokenUsage: { last: breakdown, total: breakdown, modelContextWindow: contextWindow } });
      },
    };
    return puppet;
  }

  // Inspection.

  inspect(nativeThreadId: string): NativeSessionState | undefined {
    for (const store of this.stores.values()) {
      const thread = store.threads.get(nativeThreadId);
      if (thread === undefined) continue;
      return {
        loaded: this.servers.some((server) => server.alive && server.loaded.has(nativeThreadId)),
        cwd: thread.cwd,
        prompts: thread.turns.flatMap((turn) => (turn.prompt === undefined ? [] : [turn.prompt])),
        compactions: thread.compactions,
        injectedMessages: [...thread.injected],
        backgroundTasks: thread.terminals.map((terminal) => ({ title: terminal.command, running: terminal.running })),
        subagents: thread.subagents.map((subagent) => ({ name: subagent.name, running: subagent.running })),
      };
    }
    return undefined;
  }

  lock(nativeThreadId: string): void {
    for (const store of this.stores.values()) if (store.threads.has(nativeThreadId)) store.locked.add(nativeThreadId);
  }

  /** Ends every process. */
  dispose(): void {
    this.turnQueue.end();
    for (const server of this.servers) server.exit(null, "SIGKILL");
    void this.#loginServer?.then((server) => server.close());
  }

  /** The local listener Codex's ChatGPT sign-in redirects the browser to. */
  loginListener(): Promise<http.Server> {
    this.#loginServer ??= new Promise((resolve) => {
      const server = http.createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const state = url.searchParams.get("state") ?? "";
        const login = this.#logins.get(state);
        if (url.pathname !== "/auth/callback" || login === undefined || url.searchParams.get("code") === null) {
          response.writeHead(400).end("bad callback");
          return;
        }
        this.#logins.delete(state);
        login.server.store.account = { type: "chatgpt", email: "someone@example.com", planType: "plus" };
        response.writeHead(200).end("Signed in. You can close this page.");
        login.server.notify("account/login/completed", { loginId: state, success: true, error: null });
        login.server.notify("account/updated", { authMode: "chatgpt", planType: "plus" });
      });
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
    return this.#loginServer;
  }

  loginStarted(loginId: string, server: FakeAppServer, kind: string): void {
    this.#loginCount += 1;
    this.#logins.set(loginId, { server, kind });
  }

  get loginCount(): number {
    return this.#loginCount;
  }
}
