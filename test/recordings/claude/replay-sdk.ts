// The Claude replay SDK: the module shape of `@anthropic-ai/claude-agent-sdk`
// 0.3.330 for the parts the driver loads (`query` and the five session
// functions), typed by the pinned SDK's own declarations and served from a
// recording. It imports no driver code and no fake.
//
// Every call the driver makes becomes an outbound frame, which goes through
// the replay's sanitiser and then to the sequencer, which matches it against
// the next recorded frame. The sequencer hands back each recorded inbound
// frame when it is due: a message into its query's stream, the end or error
// of a stream, the result of a call, a `canUseTool` call into the driver's
// callback, the abort of one, or a line for the driver's `stderr` callback.
// Inbound frames get the replay's own workspace where the recording says
// <WORKSPACE>.
//
// Each inbound frame is reported taken only when the driver takes it: a
// stream item when the driver's `next()` returns it, a result when the
// driver's call settles with it, a callback when it is called. A query's
// stream gives nothing after its end or error, so an extra recorded end or
// message, or a stream the driver never reads, stays untaken and fails
// `finish()`.

import type {
  CanUseTool,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Frame, Recording } from "../format.ts";
import { restoreWorkspace } from "../sanitiser.ts";
import type { Sanitiser } from "../sanitiser.ts";
import { ReplaySequencer } from "../sequencer.ts";
import type { NativeProgress } from "../scenarios.ts";
import { CLAUDE_IGNORED_FIELDS, errorFrom, errorJson, jsonSafe, pullPrompts, queryOptionsFrame } from "./frames.ts";
import type { ClaudeSdkModule } from "./frames.ts";

export interface ClaudeReplay {
  readonly sdk: ClaudeSdkModule;
  readonly sequencer: ReplaySequencer;
  /** What the scenario runner watches: drift, and where replay stands when it stalls. */
  readonly progress: NativeProgress;
}

interface PendingCall {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

class ReplayState {
  readonly sequencer: ReplaySequencer;
  readonly #sanitise: Sanitiser;
  readonly #workspace: string;
  readonly queries = new Map<string, ReplayQuery>();
  readonly #pending = new Map<number, PendingCall>();
  readonly #permissions = new Map<string, AbortController>();
  #queryCount = 0;
  #callCount = 0;

  constructor(recording: Recording, workspace: string, sanitise: Sanitiser) {
    this.#sanitise = sanitise;
    this.#workspace = workspace;
    this.sequencer = new ReplaySequencer({ recording, ignored: CLAUDE_IGNORED_FIELDS, deliver: (frame, line) => this.#deliver(frame, line) });
  }

  /** Sends an outbound frame, in the recording's placeholder form, to the sequencer. */
  send(frame: Frame): void {
    this.sequencer.send(this.#sanitise(frame));
  }

  #restore<T>(value: T): T {
    return restoreWorkspace(value, this.#workspace);
  }

  #query(frame: Frame): ReplayQuery {
    const query = this.queries.get(String(frame["query"]));
    if (query === undefined) throw new Error(`the frame names query ${JSON.stringify(frame["query"])}, which the driver has not started`);
    return query;
  }

  #deliver(frame: Frame, line: number): void {
    const taken = (): void => this.sequencer.taken(line);
    switch (frame.kind) {
      case "message":
        this.#query(frame).push({ kind: "message", message: this.#restore(frame["message"]) as SDKMessage, taken });
        return;
      case "end":
        this.#query(frame).push({ kind: "end", taken });
        return;
      case "error":
        this.#query(frame).push({ kind: "error", error: errorFrom(frame["error"]), taken });
        return;
      case "result": {
        const id = Number(frame["id"]);
        const pending = this.#pending.get(id);
        if (pending === undefined) throw new Error(`no call with id ${id} is waiting for this result`);
        this.#pending.delete(id);
        // The driver is awaiting this call: settling it hands the driver the result.
        taken();
        if (frame["error"] !== undefined) pending.reject(errorFrom(frame["error"]));
        else pending.resolve(this.#restore(frame["value"]));
        return;
      }
      case "can_use_tool": {
        const query = this.#query(frame);
        const canUseTool = query.options.canUseTool;
        if (canUseTool === undefined) throw new Error(`the recording calls canUseTool, but the driver gave query ${query.id} none`);
        const id = String(frame["id"]);
        const controller = new AbortController();
        this.#permissions.set(id, controller);
        const options = this.#restore(frame["options"]) as Omit<Parameters<CanUseTool>[2], "signal">;
        // Called after this delivery returns: the sequencer must not be re-entered.
        queueMicrotask(() => {
          taken();
          canUseTool(String(frame["toolName"]), this.#restore(frame["input"]) as Record<string, unknown>, { ...options, signal: controller.signal }).then(
            (result: PermissionResult | null) => this.#answer({ dir: "out", kind: "permission", id, query: query.id, result: jsonSafe(result) }),
            (error: unknown) => this.#answer({ dir: "out", kind: "permission", id, query: query.id, error: errorJson(error) }),
          );
        });
        return;
      }
      case "can_use_tool_abort": {
        const controller = this.#permissions.get(String(frame["id"]));
        if (controller === undefined) throw new Error(`no canUseTool call ${JSON.stringify(frame["id"])} to abort`);
        queueMicrotask(() => {
          taken();
          controller.abort();
        });
        return;
      }
      case "stderr": {
        const query = this.#query(frame);
        const stderr = query.options.stderr;
        if (stderr === undefined) throw new Error(`the recording writes to stderr, but the driver gave query ${query.id} no stderr callback`);
        const data = this.#restore(String(frame["data"]));
        queueMicrotask(() => {
          taken();
          stderr(data);
        });
        return;
      }
      default:
        throw new Error(`the Claude replay does not deliver inbound frames of kind ${JSON.stringify(frame.kind)}`);
    }
  }

  #answer(frame: Frame): void {
    try {
      this.send(frame);
    } catch {
      // The sequencer keeps the drift; the scenario runner reports it.
    }
  }

  nextQueryId(): string {
    this.#queryCount += 1;
    return `q${this.#queryCount}`;
  }

  /** A call that answers with a promise: an outbound `call` frame, then the recorded `result`. */
  call(queryId: string | null, method: string, args: unknown[]): Promise<unknown> {
    this.#callCount += 1;
    const id = this.#callCount;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      try {
        this.send({ dir: "out", kind: "call", id, query: queryId, method, args: jsonSafe(args) });
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** `Query.close()`: an outbound `call` frame with no result. */
  close(queryId: string): void {
    this.#callCount += 1;
    this.send({ dir: "out", kind: "call", id: this.#callCount, query: queryId, method: "close", args: [] });
  }
}

/** One recorded item of a query's stream, with how to report that the driver took it. */
type StreamItem =
  | { readonly kind: "message"; readonly message: SDKMessage; readonly taken: () => void }
  | { readonly kind: "end"; readonly taken: () => void }
  | { readonly kind: "error"; readonly error: Error; readonly taken: () => void };

/** One replayed `query()`. Members the driver does not call throw. */
class ReplayQuery implements Query {
  readonly id: string;
  readonly options: Options;
  readonly #state: ReplayState;
  readonly #items: StreamItem[] = [];
  /** Set once the driver took the stream's end or error, or stopped reading: nothing more is handed out. */
  #closed = false;
  #wake: (() => void) | undefined;

  constructor(state: ReplayState, id: string, options: Options) {
    this.#state = state;
    this.id = id;
    this.options = options;
  }

  push(item: StreamItem): void {
    this.#items.push(item);
    this.#wake?.();
  }

  async next(): Promise<IteratorResult<SDKMessage, void>> {
    for (;;) {
      if (this.#closed) return { value: undefined, done: true };
      const item = this.#items.shift();
      if (item !== undefined) {
        item.taken();
        if (item.kind === "message") return { value: item.message, done: false };
        this.#closed = true;
        if (item.kind === "error") throw item.error;
        return { value: undefined, done: true };
      }
      await new Promise<void>((resolve) => {
        this.#wake = () => {
          this.#wake = undefined;
          resolve();
        };
      });
    }
  }

  /** The driver stops reading: what the recording still holds for this stream is never taken. */
  #stop(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async return(): Promise<IteratorResult<SDKMessage, void>> {
    this.#stop();
    return { value: undefined, done: true };
  }

  async throw(error: unknown): Promise<IteratorResult<SDKMessage, void>> {
    this.#stop();
    throw error;
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#stop();
  }

  // Control requests the driver calls.

  // The arguments go out exactly as the driver passed them, as the tap records them.
  #call<T>(method: string, args: unknown[]): Promise<T> {
    return this.#state.call(this.id, method, args) as Promise<T>;
  }
  interrupt(...args: Parameters<Query["interrupt"]>): ReturnType<Query["interrupt"]> {
    return this.#call("interrupt", args);
  }
  setPermissionMode(...args: [mode: PermissionMode]): Promise<void> {
    return this.#call("setPermissionMode", args);
  }
  setModel(...args: Parameters<Query["setModel"]>): Promise<void> {
    return this.#call("setModel", args);
  }
  setMcpServers(...args: Parameters<Query["setMcpServers"]>): ReturnType<Query["setMcpServers"]> {
    return this.#call("setMcpServers", args);
  }
  applyFlagSettings(...args: Parameters<Query["applyFlagSettings"]>): Promise<void> {
    return this.#call("applyFlagSettings", args);
  }
  stopTask(...args: Parameters<Query["stopTask"]>): Promise<void> {
    return this.#call("stopTask", args);
  }
  rewindFiles(...args: Parameters<Query["rewindFiles"]>): ReturnType<Query["rewindFiles"]> {
    return this.#call("rewindFiles", args);
  }
  initializationResult(...args: Parameters<Query["initializationResult"]>): ReturnType<Query["initializationResult"]> {
    return this.#call("initializationResult", args);
  }
  supportedModels(...args: Parameters<Query["supportedModels"]>): Promise<ModelInfo[]> {
    return this.#call("supportedModels", args);
  }
  close(): void {
    this.#state.close(this.id);
  }

  // Control requests the driver does not use.

  #unused(name: string): never {
    throw new Error(`the Claude replay SDK does not serve Query.${name}`);
  }
  setMcpPermissionModeOverride(): Promise<{ warning?: string }> {
    return this.#unused("setMcpPermissionModeOverride");
  }
  setMaxThinkingTokens(): Promise<void> {
    return this.#unused("setMaxThinkingTokens");
  }
  updateSettings(): Promise<void> {
    return this.#unused("updateSettings");
  }
  reinitialize(): ReturnType<Query["reinitialize"]> {
    return this.#unused("reinitialize");
  }
  supportedCommands(): ReturnType<Query["supportedCommands"]> {
    return this.#unused("supportedCommands");
  }
  supportedAgents(): ReturnType<Query["supportedAgents"]> {
    return this.#unused("supportedAgents");
  }
  mcpServerStatus(): ReturnType<Query["mcpServerStatus"]> {
    return this.#unused("mcpServerStatus");
  }
  getContextUsage(): ReturnType<Query["getContextUsage"]> {
    return this.#unused("getContextUsage");
  }
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): ReturnType<Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]> {
    return this.#unused("usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET");
  }
  readFile(): ReturnType<Query["readFile"]> {
    return this.#unused("readFile");
  }
  reloadPlugins(): ReturnType<Query["reloadPlugins"]> {
    return this.#unused("reloadPlugins");
  }
  reloadSkills(): ReturnType<Query["reloadSkills"]> {
    return this.#unused("reloadSkills");
  }
  reloadOutputStyles(): ReturnType<Query["reloadOutputStyles"]> {
    return this.#unused("reloadOutputStyles");
  }
  accountInfo(): ReturnType<Query["accountInfo"]> {
    return this.#unused("accountInfo");
  }
  seedReadState(): Promise<void> {
    return this.#unused("seedReadState");
  }
  reconnectMcpServer(): Promise<void> {
    return this.#unused("reconnectMcpServer");
  }
  toggleMcpServer(): Promise<void> {
    return this.#unused("toggleMcpServer");
  }
  readMcpResource(): ReturnType<Query["readMcpResource"]> {
    return this.#unused("readMcpResource");
  }
  streamInput(): Promise<void> {
    return this.#unused("streamInput");
  }
  backgroundTasks(): Promise<boolean> {
    return this.#unused("backgroundTasks");
  }
}

/** A replay SDK over `recording`. `workspace` is this replay's temp workspace; `sanitise` is this replay's sanitiser. */
export function createClaudeReplaySdk(recording: Recording, options: { readonly workspace: string; readonly sanitise: Sanitiser }): ClaudeReplay {
  const state = new ReplayState(recording, options.workspace, options.sanitise);
  const sdk: ClaudeSdkModule = {
    query: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
      const id = state.nextQueryId();
      const queryOptions = params.options ?? {};
      const streaming = typeof params.prompt !== "string";
      const query = new ReplayQuery(state, id, queryOptions);
      state.queries.set(id, query);
      state.send({ dir: "out", kind: "query", query: id, prompt: streaming ? "stream" : { text: params.prompt }, options: queryOptionsFrame(queryOptions) });
      if (typeof params.prompt !== "string") {
        // Nobody reads the prompts on: the recording already holds what Claude Code did with them.
        pullPrompts(params.prompt, (message) => {
          try {
            state.send({ dir: "out", kind: "prompt", query: id, message: jsonSafe(message) });
          } catch {
            // The sequencer keeps the drift; the scenario runner reports it.
          }
        });
      }
      return query;
    },
    getSessionInfo: (...args) => state.call(null, "getSessionInfo", args) as Promise<SDKSessionInfo | undefined>,
    getSessionMessages: (...args) => state.call(null, "getSessionMessages", args) as Promise<SessionMessage[]>,
    listSessions: (...args) => state.call(null, "listSessions", args) as Promise<SDKSessionInfo[]>,
    deleteSession: (...args) => state.call(null, "deleteSession", args) as Promise<void>,
    archiveSession: (...args) => state.call(null, "archiveSession", args) as Promise<void>,
  };
  state.sequencer.start();
  return {
    sdk,
    sequencer: state.sequencer,
    progress: {
      failure: () => state.sequencer.failure,
      describe: (what) => state.sequencer.describe(what),
      onChange: (listener) => state.sequencer.onChange(listener),
    },
  };
}
