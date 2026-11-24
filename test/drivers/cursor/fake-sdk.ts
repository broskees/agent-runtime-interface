// A fake of the Cursor TypeScript SDK (@cursor/sdk 1.4.2) that never reaches
// Cursor's hosted service. It imports nothing from the driver.
//
// Half of it is the real SDK. Agents are created and resumed by the real
// `Agent.create` and `Agent.resume`, offline: the real SDK validates the
// options (tool names, MCP servers, local settings), writes the agent's rows
// into the real `JsonlLocalAgentStore` the driver passes, refuses an agent
// its store does not hold for that working directory with its real
// `AgentNotFoundError`, and resolves the model against the catalog that
// setup-env.ts puts in CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON. The fake only
// picks deterministic agent ids (the real SDK draws random UUIDs), so two
// rigs that do the same things get the same ids. The stored sign-in is read
// by the real `FileCredentialStore`, from a file in the world's own
// directory. The errors the fake throws are the SDK's own classes.
//
// The other half replaces what would reach Cursor's models: `send()`,
// `summarize()`, `Cursor.me()` and `Cursor.models.list()`. A run is driven
// from a test, step by step: each step is an `InteractionUpdate`, checked
// with the SDK's own `InteractionUpdateSchema`, and turned into the stream's
// `SDKMessage`s exactly as the SDK's local `send()` does (dist/esm/index.js,
// `sendImpl`: user-message-appended, text-delta, thinking-delta,
// thinking-completed, tool-call-started, partial-tool-call,
// tool-call-completed, summary-started, summary-completed and turn-ended
// become messages; the other updates do not). A run's lifecycle follows the
// SDK's local `Run` (index.js `class Tr`): the stream starts with a RUNNING
// status, `cancel()` marks the run cancelled, pushes a CANCELLED status and
// aborts it, `wait()` resolves when the run ended, `steer()` answers
// `revert_to_followup` once the run's turn ended (977.js, the local
// executor's `steer`) and `complete_delivered` while it runs, after which
// Cursor appends the steer as a user message.
//
// Which run a `send()` gets is the real SDK's decision, made on the real
// store: the fake calls the real handle's storage preflight
// (index.js `getRunForSend`) and marks the run starting and terminal in the
// real store as `sendImpl` and `Run.cancel` do. So `Agent.create` reserves a
// queued first run that only the handle it returned can take; any other
// handle (a resumed one) gets a follow-up run, which the store refuses with
// "already has active run" while the agent's active run is not terminal
// (the reservation of a creating handle that closed before it sent, or a run
// still going); `send({ local: { force: true } })` expires that run first.
// The fake's run ids stay its own deterministic ones; the store's are random.
//
// Like the SDK, the fake writes the conversation's transcript and the
// descriptor of every inline MCP server under Cursor's data directory,
// `$CURSOR_DATA_DIR/projects/<workspace>` or `~/.cursor/projects/<workspace>`
// (977.js `LocalTranscriptWriter` and `McpFileSystemWriter`).

import * as Real from "@cursor/sdk";
import type {
  AgentConversationTurn,
  AgentOptions,
  AgentUsage,
  ConversationTurn,
  CursorRequestOptions,
  InteractionUpdate,
  LocalAgentStore,
  ModelSelection,
  Run,
  RunError,
  RunOperation,
  RunResult,
  RunStatus,
  SDKAgent,
  SDKArtifact,
  SDKMessage,
  SDKModel,
  SDKUser,
  SDKUserMessage,
  SdkCredentialStore,
  SendOptions,
  SteerAckOutcome,
  TokenUsage,
  ToolCall,
} from "@cursor/sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The part of the SDK module the fake provides, typed by the SDK itself. */
export interface FakeCursorSdkModule {
  readonly Agent: { readonly create: typeof Real.Agent.create; readonly resume: typeof Real.Agent.resume };
  readonly Cursor: { readonly me: typeof Real.Cursor.me; readonly models: { readonly list: typeof Real.Cursor.models.list } };
  readonly FileCredentialStore: new () => SdkCredentialStore;
  readonly JsonlLocalAgentStore: typeof Real.JsonlLocalAgentStore;
}

/** How `Cursor.me()` answers for the stored sign-in: the native side of the ambient account. */
export type FakeAmbientAuth = "authenticated" | "unauthenticated" | "unknown" | "unavailable";

export interface FakeCursorWorldOptions {
  /** A directory of the world's own: the stored sign-in lives here, not in the user's home. */
  readonly root: string;
  readonly ambientAuth?: FakeAmbientAuth;
  /** API keys Cursor accepts besides the stored sign-in's. */
  readonly acceptedKeys?: readonly string[];
  /** The models `Cursor.models.list()` returns; also what setup-env.ts put in the SDK's local catalog. */
  readonly models?: readonly SDKModel[];
}

/** The key the stored sign-in holds. */
export const FAKE_AMBIENT_KEY = "crsr_fake_ambient_login_key";

class Deferred<T> {
  settled = false;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  readonly promise = new Promise<T>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
}

/** An unbounded queue read by one async consumer. */
class Queue<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T, undefined>) => void> = [];
  #ended = false;

  push(item: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(item);
    else waiter({ done: false, value: item });
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<T, undefined>> {
    if (this.#items.length > 0) return Promise.resolve({ done: false, value: this.#items.shift() as T });
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

/** Cursor's directory name for a workspace path (dist/esm/index.js, workspace-paths `r_`). */
export function cursorWorkspaceFolder(workspace: string): string {
  return workspace.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

/** Cursor's file name for a conversation id (workspace-paths `sh`). */
function conversationFileName(id: string): string {
  let name = encodeURIComponent(id).replace(/%/g, "_");
  if (name.length > 200) name = name.slice(0, 200);
  return name;
}

/** Cursor's folder name for an MCP server (977.js `My`). */
function serverFolderName(name: string): string {
  const cleaned = name.replace(/\s/g, "_").replace(/[^a-zA-Z0-9_.-]/g, "").replace(/\.+/g, ".");
  return cleaned === "." || cleaned === ".." ? cleaned.replace(/\./g, "_") : cleaned.length === 0 ? "_" : cleaned;
}

/** Cursor's data directory: `$CURSOR_DATA_DIR`, else `~/.cursor` (977.js `ko`). */
export function cursorDataDirectory(): string {
  const configured = process.env["CURSOR_DATA_DIR"];
  return configured !== undefined && configured.trim() !== "" ? configured : path.join(os.homedir(), ".cursor");
}

/** The SDK's conversion of one interaction update into a stream message (dist/esm/index.js, `sendImpl`). */
export function toSdkMessage(update: InteractionUpdate, agentId: string, runId: string): SDKMessage | undefined {
  switch (update.type) {
    case "user-message-appended":
      return { type: "user", agent_id: agentId, run_id: runId, message: { role: "user", content: [{ type: "text", text: update.userMessage.text }] } };
    case "text-delta":
      return { type: "assistant", agent_id: agentId, run_id: runId, message: { role: "assistant", content: [{ type: "text", text: update.text }] } };
    case "thinking-delta":
      return { type: "thinking", agent_id: agentId, run_id: runId, text: update.text };
    case "thinking-completed":
      return { type: "thinking", agent_id: agentId, run_id: runId, text: "", thinking_duration_ms: update.thinkingDurationMs };
    case "tool-call-started":
    case "partial-tool-call":
    case "tool-call-completed": {
      const call = update.toolCall as ToolCall & { name?: unknown; truncated?: unknown };
      const name = typeof call.name === "string" ? call.name : call.type;
      const truncated = typeof call.truncated === "object" && call.truncated !== null ? (call.truncated as { args?: boolean; result?: boolean }) : undefined;
      return {
        type: "tool_call",
        agent_id: agentId,
        run_id: runId,
        call_id: update.callId,
        name,
        status: update.type === "tool-call-completed" ? "completed" : "running",
        ...("args" in call ? { args: call.args } : {}),
        ...(call.result === undefined ? {} : { result: call.result }),
        ...(truncated === undefined ? {} : { truncated }),
      };
    }
    case "summary-started":
      return { type: "summary", agent_id: agentId, run_id: runId, status: "running" };
    case "summary-completed":
      return { type: "summary", agent_id: agentId, run_id: runId, status: update.failed === true ? "error" : "completed", ...(update.fallback === true ? { fallback: true } : {}) };
    case "turn-ended": {
      const usage = update.usage;
      if (usage === undefined) return undefined;
      // The SDK's own total in 1.4.2: input plus output (dist/esm/index.js, usage-types `qI`).
      return { type: "usage", agent_id: agentId, run_id: runId, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, totalTokens: usage.inputTokens + usage.outputTokens, ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }) } };
    }
    default:
      return undefined;
  }
}

/**
 * The real local agent's storage preflight and run bookkeeping, which the
 * fake calls so the persisted run reservation behaves as the pinned SDK's
 * (index.js, class `Qr`: `getRunForSend`, and `platform.store`, the local
 * agent store's `markRunStarting` and `markRunTerminal`). Not public API.
 */
interface RealLocalAgent {
  getRunForSend(options: SendOptions, model: ModelSelection, requestId: string): Promise<{ readonly runId: string }>;
  readonly platform: {
    readonly store: {
      markRunStarting(agentId: string, runId: string, options: { requestId: string }): Promise<void>;
      markRunTerminal(agentId: string, runId: string, options: { status: PersistedTerminal }): Promise<void>;
    };
  };
}

/** The lifecycle statuses `markRunTerminal` takes. */
type PersistedTerminal = "FINISHED" | "ERROR" | "CANCELLED";

function realLocalAgent(agent: SDKAgent): RealLocalAgent {
  const candidate = agent as unknown as Partial<RealLocalAgent>;
  if (typeof candidate.getRunForSend !== "function" || typeof candidate.platform?.store?.markRunTerminal !== "function") {
    throw new Error("The SDK's local agent has no getRunForSend or platform.store: the fake follows @cursor/sdk 1.4.2's internals, which changed");
  }
  return candidate as RealLocalAgent;
}

/** One agent as the fake's Cursor holds it. */
export interface FakeAgentRecord {
  readonly agentId: string;
  readonly cwd: string;
  /** The real store the agent's rows are in. */
  readonly store: LocalAgentStore | undefined;
  /** The text of every run's prompt, oldest first: the conversation's history. */
  readonly prompts: string[];
  /** Assistant text of each finished run, for the transcript. */
  readonly replies: string[];
  compactions: number;
  finishedRuns: number;
  activeRun: FakeRun | undefined;
  readonly handles: Set<FakeSdkAgent>;
  readonly subagents: Array<{ name: string; running: boolean }>;
}

/** What one `send()` asked for, for tests. */
export interface FakeSend {
  readonly agentId: string;
  readonly runId: string;
  readonly message: string | SDKUserMessage;
  readonly options: SendOptions | undefined;
  /** The API key the run used, resolved the SDK's way: the agent's `apiKey`, else CURSOR_API_KEY, else the stored sign-in. */
  readonly apiKey: string | undefined;
}

/**
 * One Cursor, offline: its agents, their runs and the steps of each run a
 * test drives. Each conformance rig gets a fresh world.
 */
export class FakeCursorWorld {
  readonly module: FakeCursorSdkModule;
  readonly agents = new Map<string, FakeAgentRecord>();
  /** Every `Agent.create` options object, as the driver passed it. */
  readonly creations: AgentOptions[] = [];
  /** Every `Agent.resume`, as the driver called it. */
  readonly resumes: Array<{ readonly agentId: string; readonly options: Partial<AgentOptions> | undefined }> = [];
  readonly sends: FakeSend[] = [];
  /** Every API key the SDK resolved for a call: what authenticated it. */
  readonly keysUsed: Array<{ readonly call: string; readonly apiKey: string | undefined }> = [];
  readonly steers: Array<{ readonly runId: string; readonly text: string; readonly outcome: SteerAckOutcome }> = [];
  readonly authPath: string;
  ambientAuth: FakeAmbientAuth;
  readonly #acceptedKeys: Set<string>;
  readonly #models: readonly SDKModel[];
  readonly #runs = new Queue<FakeRun>();
  #agentCount = 0;
  #runCount = 0;

  constructor(options: FakeCursorWorldOptions) {
    this.authPath = path.join(options.root, "cursor-sdk-auth.json");
    this.ambientAuth = options.ambientAuth ?? "authenticated";
    this.#acceptedKeys = new Set(options.acceptedKeys ?? []);
    this.#models = options.models ?? JSON.parse(process.env["CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON"] ?? "[]");
    const world = this;
    const authPath = this.authPath;
    class WorldCredentialStore extends Real.FileCredentialStore {
      constructor() {
        super(authPath);
      }
    }
    this.module = {
      Agent: {
        create: (options: AgentOptions) => world.#create(options),
        resume: (agentId: string, options?: Partial<AgentOptions>) => world.#resume(agentId, options),
      },
      Cursor: {
        me: (options?: CursorRequestOptions) => world.#me(options),
        models: { list: (options?: CursorRequestOptions) => world.#listModels(options) },
      },
      FileCredentialStore: WorldCredentialStore,
      JsonlLocalAgentStore: Real.JsonlLocalAgentStore,
    };
  }

  /** Stores (or removes) the SDK sign-in the way `Cursor.auth.login()` stores one, with the real credential store. */
  async storeSignIn(signedIn: boolean, expiresAtMs?: number): Promise<void> {
    const store = new Real.FileCredentialStore(this.authPath);
    if (!signedIn) {
      await store.clear();
      return;
    }
    await store.save({ version: 1, backendUrl: "https://api2.cursor.sh", apiKey: FAKE_AMBIENT_KEY, email: "user@example.com", createdAtMs: 1_790_000_000_000, ...(expiresAtMs === undefined ? {} : { apiKeyExpiresAtMs: expiresAtMs }) });
  }

  acceptKey(apiKey: string): void {
    this.#acceptedKeys.add(apiKey);
  }

  /** The next run the driver started. */
  async nextRun(): Promise<FakeRun> {
    const next = await this.#runs.next();
    if (next.done === true) throw new Error("The fake Cursor world was closed");
    return next.value;
  }

  agentFor(agentId: string): FakeAgentRecord | undefined {
    return this.agents.get(agentId);
  }

  close(): void {
    this.#runs.end();
  }

  // -------------------------------------------------------------------------
  // The SDK surface

  async #create(options: AgentOptions): Promise<SDKAgent> {
    this.creations.push(options);
    if (options.cloud !== undefined || options.local === undefined) throw new Real.ConfigurationError("The fake Cursor SDK runs local agents only");
    this.#agentCount += 1;
    const agentId = `agent-00000000-0000-4000-8000-${String(this.#agentCount).padStart(12, "0")}`;
    this.keysUsed.push({ call: "Agent.create", apiKey: this.#resolveKey(options.apiKey) });
    const real = await Real.Agent.create({ ...options, agentId });
    const record = this.#record(agentId, options.local.cwd, options.local.store);
    return new FakeSdkAgent(this, record, real, options);
  }

  async #resume(agentId: string, options: Partial<AgentOptions> | undefined): Promise<SDKAgent> {
    this.resumes.push({ agentId, options });
    this.keysUsed.push({ call: "Agent.resume", apiKey: this.#resolveKey(options?.apiKey) });
    // The real SDK finds the agent in the store for this working directory, or throws AgentNotFoundError.
    const real = await Real.Agent.resume(agentId, options);
    // An agent the store holds that the fake did not create (a test made it with the real SDK) is one Cursor holds too.
    const record = this.agents.get(agentId) ?? this.#record(agentId, options?.local?.cwd, options?.local?.store);
    return new FakeSdkAgent(this, record, real, { ...options });
  }

  #record(agentId: string, cwd: string | undefined, store: LocalAgentStore | undefined): FakeAgentRecord {
    const record: FakeAgentRecord = { agentId, cwd: cwd ?? process.cwd(), store, prompts: [], replies: [], compactions: 0, finishedRuns: 0, activeRun: undefined, handles: new Set(), subagents: [] };
    this.agents.set(agentId, record);
    return record;
  }

  /** Cursor loses the agent: its rows leave the real store, so `Agent.resume` throws AgentNotFoundError. */
  async forget(agentId: string): Promise<void> {
    const store = this.agents.get(agentId)?.store;
    if (store === undefined) throw new Error(`The fake holds no store for agent ${agentId}`);
    await store.runs.delete({ filter: { agentIds: [agentId] } });
    await store.agents.delete({ filter: { agentIds: [agentId] } });
    this.agents.delete(agentId);
  }

  /** The agent's run rows in the real store, oldest first: what the SDK's preflight decides by. */
  async persistedRuns(agentId: string): Promise<Array<{ readonly status: string; readonly error: string | null | undefined }>> {
    const store = this.agents.get(agentId)?.store;
    if (store === undefined) throw new Error(`The fake holds no store for agent ${agentId}`);
    const rows = [];
    let cursor: string | undefined;
    do {
      const page = await store.runs.list({ filter: { agentIds: [agentId], ...(cursor === undefined ? {} : { cursor }) } });
      rows.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return rows.sort((a, b) => a.turnNumber - b.turnNumber).map((row) => ({ status: row.status, error: row.error }));
  }

  async #me(options: CursorRequestOptions | undefined): Promise<SDKUser> {
    const apiKey = this.#resolveKey(options?.apiKey);
    this.keysUsed.push({ call: "Cursor.me", apiKey });
    if (apiKey === FAKE_AMBIENT_KEY) {
      if (this.ambientAuth === "unavailable") throw new Real.NetworkError("Service unavailable", { code: "unavailable", isRetryable: true, operation: "Cursor.me" });
      if (this.ambientAuth === "unknown") throw new Real.UnknownAgentError("The backend could not resolve the key", { code: "unknown", operation: "Cursor.me" });
      if (this.ambientAuth === "authenticated") return { apiKeyName: "SDK login", userId: 1, userEmail: "user@example.com", createdAt: "2026-11-01T00:00:00.000Z" };
    } else if (apiKey !== undefined && this.#acceptedKeys.has(apiKey)) {
      return { apiKeyName: "instance key", createdAt: "2026-11-01T00:00:00.000Z" };
    }
    throw new Real.AuthenticationError("Invalid API key", { code: "unauthenticated", status: 401, operation: "Cursor.me" });
  }

  async #listModels(options: CursorRequestOptions | undefined): Promise<SDKModel[]> {
    const apiKey = this.#resolveKey(options?.apiKey);
    this.keysUsed.push({ call: "Cursor.models.list", apiKey });
    if (apiKey === undefined || (apiKey !== FAKE_AMBIENT_KEY && !this.#acceptedKeys.has(apiKey))) throw new Real.AuthenticationError("Invalid API key", { code: "unauthenticated", status: 401 });
    return this.#models.map((model) => ({ ...model }));
  }

  /** The SDK's key resolution: the explicit key, else CURSOR_API_KEY, else the stored sign-in (dist/esm/index.js `Lc`). */
  #resolveKey(explicit: string | undefined): string | undefined {
    if (explicit !== undefined) return explicit;
    const environment = process.env["CURSOR_API_KEY"];
    if (environment !== undefined) return environment;
    try {
      const stored = JSON.parse(fs.readFileSync(this.authPath, "utf8")) as { apiKey?: unknown };
      return typeof stored.apiKey === "string" ? stored.apiKey : undefined;
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Runs

  /** The local `send()`: checks the options as the SDK does, takes a run as the SDK's store decides, then starts a run a test drives. */
  async startRun(agent: FakeSdkAgent, message: string | SDKUserMessage, options: SendOptions | undefined): Promise<FakeRun> {
    if (options?.cloud !== undefined) throw new Real.ConfigurationError("Cloud send options are only supported for cloud SDK agents. Create the agent with cloud options or use local.* send options.", { isRetryable: false });
    const model = options?.model ?? agent.model;
    if (model === undefined) throw new Real.ConfigurationError('Local SDK agents require an explicit `model`. Pass `model: { id: "<model-id>" }` to Agent.create() or to send(), or run this agent in cloud mode.', { isRetryable: false });
    if (!this.#models.some((candidate) => candidate.id === model.id || candidate.aliases?.includes(model.id) === true)) {
      throw new Real.ConfigurationError(`Cannot use this model: ${model.id}. Available models: ${this.#models.map((candidate) => candidate.id).join(", ")}. Use Cursor.models.list() to discover valid selections.`, { isRetryable: false });
    }
    if (typeof message !== "string" && (message.images ?? []).some((image) => "url" in image)) throw new Real.ConfigurationError("URL images are only supported for cloud SDK agents", { isRetryable: false });
    if (options?.mode !== undefined && options.mode !== "agent" && options.mode !== "plan") throw new Real.ConfigurationError(`Unknown mode ${String(options.mode)}`);
    const record = agent.record;
    const runId = this.#nextRunId();
    const persist = await this.#reserve(agent, options ?? {}, model, runId, "agent.send");
    const apiKey = this.#resolveKey(agent.options.apiKey);
    this.keysUsed.push({ call: "agent.send", apiKey });
    this.sends.push({ agentId: record.agentId, runId, message, options, apiKey });
    const text = typeof message === "string" ? message : message.text;
    record.prompts.push(text);
    const servers = options?.mcpServers ?? agent.options.mcpServers ?? {};
    this.#writeMcpDescriptors(record, Object.keys(servers));
    const run = new FakeRun(this, record, runId, text, model, apiKey !== undefined && (apiKey === FAKE_AMBIENT_KEY || this.#acceptedKeys.has(apiKey)), options?.onDelta, persist, agent.options.tools);
    record.activeRun = run;
    this.#runs.push(run);
    return run;
  }

  /**
   * A deterministic run id, taken before any await, so runs started at the
   * same time get distinct ids as the store's random ones are. A run the store
   * then refuses leaves its number unused.
   */
  #nextRunId(): string {
    this.#runCount += 1;
    return `run-00000000-0000-4000-9000-${String(this.#runCount).padStart(12, "0")}`;
  }

  /**
   * The SDK's storage preflight (index.js `sendImpl`, `getRunForSend`), on the
   * real store: the handle's reserved first run, else a follow-up run, which the
   * store refuses while the agent's active run is not terminal. Marks the run
   * starting, and returns how to mark it terminal.
   */
  async #reserve(agent: FakeSdkAgent, options: SendOptions, model: ModelSelection, runId: string, operation: string): Promise<(status: PersistedTerminal) => Promise<void>> {
    const requestId = runId.replace(/^run-/, "");
    let persisted: { readonly runId: string };
    try {
      persisted = await agent.real.getRunForSend(options, model, requestId);
    } catch (error) {
      // `send` turns the store's plain Error into the SDK's UnknownAgentError (index.js errors `Nt`).
      throw new Real.UnknownAgentError(error instanceof Error ? error.message : String(error), { operation, cause: error, isRetryable: false });
    }
    const store = agent.real.platform.store;
    await store.markRunStarting(agent.agentId, persisted.runId, { requestId });
    return (status) => store.markRunTerminal(agent.agentId, persisted.runId, { status });
  }

  /** `agent.summarize()`: a run that summarizes the saved conversation, which Cursor completes on its own. It takes a run as `send()` does, never forced. */
  async summarize(agent: FakeSdkAgent): Promise<FakeRun> {
    const record = agent.record;
    if (record.finishedRuns === 0) throw new Real.ConfigurationError(`Agent ${record.agentId} has no saved conversation to summarize yet.`, { isRetryable: false });
    const model = agent.model ?? { id: "composer-2.5" };
    const runId = this.#nextRunId();
    const persist = await this.#reserve(agent, {}, model, runId, "agent.summarize");
    const run = new FakeRun(this, record, runId, "", model, true, undefined, persist, agent.options.tools);
    record.activeRun = run;
    void (async () => {
      await run.update({ type: "summary-started" });
      await run.update({ type: "summary", summary: "The conversation so far, summarized." });
      await run.update({ type: "summary-completed" });
      record.compactions += 1;
      run.finish("The conversation so far, summarized.");
    })();
    return run;
  }

  /** Writes the conversation's transcript where Cursor's local transcript writer does. */
  writeTranscript(record: FakeAgentRecord): void {
    const name = conversationFileName(record.agentId);
    const directory = path.join(cursorDataDirectory(), "projects", cursorWorkspaceFolder(record.cwd), "agent-transcripts", name);
    const lines: string[] = [];
    record.prompts.forEach((prompt, index) => {
      lines.push(JSON.stringify({ role: "user", message: { content: [{ type: "text", text: prompt }] } }));
      const reply = record.replies[index];
      if (reply !== undefined && reply !== "") lines.push(JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: reply }] } }));
    });
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${name}.jsonl`), `${lines.join("\n")}\n`);
  }

  /** Writes each MCP server's descriptor where Cursor's MCP file system writer does. The fake reaches no server, so each one's status is an error. */
  #writeMcpDescriptors(record: FakeAgentRecord, servers: readonly string[]): void {
    for (const server of servers) {
      const directory = path.join(cursorDataDirectory(), "projects", cursorWorkspaceFolder(record.cwd), "mcps", serverFolderName(server));
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "SERVER_METADATA.json"), JSON.stringify({ serverIdentifier: server, serverName: server }, null, 2));
      fs.writeFileSync(path.join(directory, "STATUS.md"), "The MCP server could not be reached.");
    }
  }
}

/** An agent handle: the real SDK's agent for its lifecycle, the fake's runs for its work. */
export class FakeSdkAgent implements SDKAgent {
  readonly agentId: string;
  readonly record: FakeAgentRecord;
  readonly options: Partial<AgentOptions>;
  /** The real SDK's handle, whose storage preflight decides which run a send gets. */
  readonly real: RealLocalAgent;
  readonly #world: FakeCursorWorld;
  readonly #real: SDKAgent;
  #model: ModelSelection | undefined;
  closed = false;

  constructor(world: FakeCursorWorld, record: FakeAgentRecord, real: SDKAgent, options: Partial<AgentOptions>) {
    this.#world = world;
    this.#real = real;
    this.real = realLocalAgent(real);
    this.record = record;
    this.agentId = record.agentId;
    this.options = options;
    this.#model = options.model;
    record.handles.add(this);
  }

  get model(): ModelSelection | undefined {
    return this.#model;
  }

  async send(message: string | SDKUserMessage, options?: SendOptions): Promise<Run> {
    // A closed handle reacquires its local executor on the next send, as the SDK's does.
    this.closed = false;
    this.record.handles.add(this);
    const run = await this.#world.startRun(this, message, options);
    if (options?.model !== undefined) this.#model = options.model;
    return run;
  }

  async summarize(): Promise<Run> {
    return this.#world.summarize(this);
  }

  close(): void {
    this.closed = true;
    this.record.handles.delete(this);
    this.#real.close();
  }

  async reload(): Promise<void> {
    await this.#real.reload();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.closed = true;
    this.record.handles.delete(this);
    await this.#real[Symbol.asyncDispose]();
  }

  async listArtifacts(): Promise<SDKArtifact[]> {
    return [];
  }

  async downloadArtifact(): Promise<Buffer> {
    throw new Real.ConfigurationError("Artifacts are not implemented for local SDK agents yet", { isRetryable: false });
  }

  async getUsage(): Promise<AgentUsage> {
    throw new Real.FeatureUnavailableError("Usage for local agents is not enabled for this account", { code: "feature_unavailable" });
  }
}

/** One run: its stream, its result and the controls a test drives it with. */
export class FakeRun implements Run {
  readonly id: string;
  readonly agentId: string;
  readonly requestId: string;
  readonly createdAt = 1_790_000_000_000;
  readonly prompt: string;
  readonly model: ModelSelection;
  readonly #world: FakeCursorWorld;
  readonly #record: FakeAgentRecord;
  readonly #authorized: boolean;
  readonly #onDelta: SendOptions["onDelta"];
  readonly #persist: (status: PersistedTerminal) => Promise<void>;
  /** The built-in tools the run's handle offers (`AgentOptions.tools`); undefined for Cursor's default set. */
  readonly #tools: ReadonlySet<string> | undefined;
  readonly #messages = new Queue<SDKMessage>();
  readonly #done = new Deferred<{ status: "finished" | "error" | "cancelled"; result?: string; error?: RunError }>();
  readonly #listeners = new Set<(status: RunStatus) => void>();
  readonly #stop = new Deferred<"cancel" | "exit">();
  readonly #steers: string[] = [];
  readonly #steerWaiters: Array<(text: string) => void> = [];
  readonly #turns: ConversationTurn[] = [];
  #status: RunStatus = "running";
  #steps = 0;
  /** True once the run's turn ended on Cursor's side, whether or not the driver has heard. */
  #ended = false;
  /** True once the run ended; `wait()` resolves when the store has its terminal status. */
  #over = false;
  #usage: TokenUsage | undefined;
  #result: string | undefined;
  #error: RunError | undefined;

  constructor(
    world: FakeCursorWorld,
    record: FakeAgentRecord,
    runId: string,
    prompt: string,
    model: ModelSelection,
    authorized: boolean,
    onDelta: SendOptions["onDelta"],
    persist: (status: PersistedTerminal) => Promise<void>,
    tools: readonly string[] | undefined,
  ) {
    this.#world = world;
    this.#onDelta = onDelta;
    this.#persist = persist;
    this.#tools = tools === undefined ? undefined : new Set(tools);
    this.#record = record;
    this.id = runId;
    this.agentId = record.agentId;
    this.requestId = runId.replace(/^run-/, "");
    this.prompt = prompt;
    this.model = model;
    this.#authorized = authorized;
    this.#messages.push({ type: "status", agent_id: this.agentId, run_id: this.id, status: "RUNNING" });
    if (!authorized) queueMicrotask(() => this.fail({ message: "Invalid API key", code: "unauthenticated" }));
  }

  get status(): RunStatus {
    return this.#status;
  }

  get result(): string | undefined {
    return this.#result;
  }

  get error(): RunError | undefined {
    return this.#status === "error" ? this.#error : undefined;
  }

  get usage(): TokenUsage | undefined {
    return this.#usage;
  }

  get durationMs(): number | undefined {
    return this.#status === "running" ? undefined : 1200;
  }

  get git(): undefined {
    return undefined;
  }

  /** True when the key the run authenticated with is one Cursor accepts. */
  get authorized(): boolean {
    return this.#authorized;
  }

  supports(operation: RunOperation): boolean {
    return operation === "stream" || operation === "wait" || operation === "conversation" || operation === "cancel";
  }

  unsupportedReason(operation: RunOperation): string | undefined {
    return this.supports(operation) ? undefined : `Unknown run operation "${operation}"`;
  }

  async *stream(): AsyncGenerator<SDKMessage, void> {
    for (;;) {
      const next = await this.#messages.next();
      if (next.done === true) return;
      yield next.value;
    }
  }

  async conversation(): Promise<ConversationTurn[]> {
    await this.#done.promise;
    return this.#turns.map((turn) => structuredClone(turn));
  }

  async wait(): Promise<RunResult> {
    const outcome = await this.#done.promise;
    return {
      id: this.id,
      requestId: this.requestId,
      status: outcome.status,
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      ...(outcome.status === "error" && outcome.error !== undefined ? { error: outcome.error } : {}),
      model: this.model,
      durationMs: 1200,
      ...(this.#usage === undefined ? {} : { usage: this.#usage }),
    };
  }

  /** As the SDK's local `Run.cancel` (index.js `class Tr`): cancelled at once, a CANCELLED status, the executor aborted, the run cancelled in the store. */
  async cancel(): Promise<void> {
    if (this.#status !== "running") return;
    this.#setStatus("cancelled");
    this.#messages.push({ type: "status", agent_id: this.agentId, run_id: this.id, status: "CANCELLED" });
    this.#stop.resolve("cancel");
    await this.#persist("CANCELLED");
  }

  async steer(text: string): Promise<SteerAckOutcome> {
    const outcome: SteerAckOutcome = text.trim() === "" || this.#ended || this.#status !== "running" ? "revert_to_followup" : "complete_delivered";
    this.#world.steers.push({ runId: this.id, text, outcome });
    if (outcome !== "complete_delivered") return outcome;
    const waiter = this.#steerWaiters.shift();
    if (waiter === undefined) this.#steers.push(text);
    else waiter(text);
    // Cursor appends a delivered steer to the running turn as a user message.
    await this.update({ type: "user-message-appended", userMessage: { type: "user_message", session_id: this.agentId, text } });
    return outcome;
  }

  onDidChangeStatus(listener: (status: RunStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Controls a test drives the run with

  /**
   * Sends one interaction update, checked with the SDK's own schema, as the
   * SDK's local executor does: the accumulator records it, `onDelta` gets it
   * (and is awaited) unless it is a summary update, then its stream message,
   * if it has one, is pushed (index.js `sendImpl` and run-interaction-accumulator `apply`).
   */
  async update(update: InteractionUpdate): Promise<void> {
    if (this.#over) throw new Error(`run ${this.id} already ended`);
    Real.InteractionUpdateSchema.parse(update);
    this.#accumulate(update);
    if (update.type !== "summary" && update.type !== "summary-started" && update.type !== "summary-completed") await this.#onDelta?.({ update });
    const message = toSdkMessage(update, this.agentId, this.id);
    if (message !== undefined) this.#messages.push(message);
  }

  /** Streams assistant text in two chunks, as Cursor streams tokens, and ends the step. */
  async say(text: string): Promise<void> {
    const middle = Math.ceil(text.length / 2);
    for (const chunk of [text.slice(0, middle), text.slice(middle)]) {
      if (chunk === "") continue;
      await this.update({ type: "text-delta", text: chunk });
      await this.update({ type: "token-delta", tokens: Math.max(1, Math.round(chunk.length / 4)) });
    }
    this.#steps += 1;
    await this.update({ type: "step-completed", stepId: this.#steps, stepDurationMs: 40 });
  }

  /** Thinks, in one chunk, then ends the thought. */
  async think(text: string): Promise<void> {
    await this.update({ type: "thinking-delta", text });
    await this.update({ type: "thinking-completed", thinkingDurationMs: 12 });
  }

  /**
   * Runs one tool: zero or more partial updates while the model writes the
   * arguments, its start, then its completion with the result. The tool must
   * be one the agent offers.
   */
  async runTool(callId: string, call: ToolCall, partials: readonly ToolCall[] = []): Promise<void> {
    const allowed = this.#tools;
    if (allowed !== undefined && !allowed.has(call.type)) throw new Error(`the agent does not offer the ${call.type} tool (tools: ${[...allowed].join(", ")})`);
    for (const partial of partials) await this.update({ type: "partial-tool-call", callId, toolCall: partial, modelCallId: `${callId}-model` });
    const { result, ...started } = call as ToolCall & { result?: unknown };
    void result;
    await this.update({ type: "tool-call-started", callId, toolCall: started as ToolCall, modelCallId: `${callId}-model` });
    await this.update({ type: "tool-call-completed", callId, toolCall: call, modelCallId: `${callId}-model` });
  }

  /** The text of the next steer this run took. */
  nextSteer(): Promise<string> {
    const steer = this.#steers.shift();
    if (steer !== undefined) return Promise.resolve(steer);
    return new Promise((resolve) => this.#steerWaiters.push(resolve));
  }

  /** Resolves when the driver cancelled the run. */
  stopRequested(): Promise<"cancel" | "exit"> {
    return this.#stop.promise;
  }

  /** The run's turn ends on Cursor's side: no steer reaches it any more. */
  async endTurn(usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): Promise<void> {
    await this.update({ type: "turn-ended", ...(usage === undefined ? {} : { usage }) });
    this.#ended = true;
  }

  /**
   * The run finishes: a FINISHED status, then the stream ends and `wait()`
   * resolves with the text of the run's last assistant message as `result`
   * (index.js `sendImpl` and `finalAssistantText`, `class Tr`).
   */
  finish(result?: string): void {
    this.#ended = true;
    const text = result ?? this.#finalAssistantText();
    this.#record.replies.push(text ?? "");
    this.#record.finishedRuns += 1;
    this.#messages.push({ type: "status", agent_id: this.agentId, run_id: this.id, status: "FINISHED" });
    this.#world.writeTranscript(this.#record);
    this.#settle({ status: "finished", ...(text === undefined ? {} : { result: text }) }, "finished");
  }

  /** The run fails: an ERROR status with the message, then `wait()` gives the error (index.js `sendImpl`). */
  fail(error: RunError): void {
    this.#ended = true;
    this.#record.replies.push("");
    this.#messages.push({ type: "status", agent_id: this.agentId, run_id: this.id, status: "ERROR", message: error.message });
    this.#world.writeTranscript(this.#record);
    this.#settle({ status: "error", error }, "error");
  }

  /** The executor stops after `cancel()`: the run ends cancelled. */
  finishCancelled(): void {
    this.#ended = true;
    this.#record.replies.push(this.#finalAssistantText() ?? "");
    this.#settle({ status: "cancelled" }, "cancelled");
  }

  #finalAssistantText(): string | undefined {
    for (const turn of [...this.#turns].reverse()) {
      if (turn.type !== "agentConversationTurn") continue;
      const step = [...turn.turn.steps].reverse().find((candidate) => candidate.type === "assistantMessage");
      if (step !== undefined && step.type === "assistantMessage") return step.message.text;
    }
    return undefined;
  }

  /** Ends the run. As the SDK's `sendImpl`, the store gets the run's terminal status before `wait()` resolves. */
  #settle(outcome: { status: "finished" | "error" | "cancelled"; result?: string; error?: RunError }, status: RunStatus): void {
    if (this.#over) return;
    this.#over = true;
    if (this.#status === "running") this.#setStatus(status);
    if (outcome.result !== undefined) this.#result = outcome.result;
    if (outcome.error !== undefined) this.#error = outcome.error;
    this.#messages.end();
    if (this.#record.activeRun === this) this.#record.activeRun = undefined;
    const final = this.#status === "cancelled" ? { status: "cancelled" as const } : outcome;
    const persisted: PersistedTerminal = this.#status === "cancelled" ? "CANCELLED" : this.#status === "error" ? "ERROR" : "FINISHED";
    const resolve = () => {
      this.#done.settled = true;
      this.#done.resolve(final);
    };
    this.#persist(persisted).then(resolve, resolve);
  }

  #setStatus(status: RunStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }

  /** The SDK's conversation accumulator (index.js run-interaction-accumulator). */
  #accumulate(update: InteractionUpdate): void {
    const current = (): AgentConversationTurn => {
      const last = this.#turns.at(-1);
      if (last !== undefined && last.type === "agentConversationTurn") return last.turn;
      const turn: AgentConversationTurn = { steps: [] };
      this.#turns.push({ type: "agentConversationTurn", turn });
      return turn;
    };
    switch (update.type) {
      case "user-message-appended":
        this.#turns.push({ type: "agentConversationTurn", turn: { userMessage: { text: update.userMessage.text }, steps: [] } });
        return;
      case "text-delta": {
        const turn = current();
        const last = turn.steps.at(-1);
        if (last?.type === "assistantMessage") turn.steps[turn.steps.length - 1] = { type: "assistantMessage", message: { text: `${last.message.text}${update.text}` } };
        else turn.steps.push({ type: "assistantMessage", message: { text: update.text } });
        return;
      }
      case "thinking-delta": {
        const turn = current();
        const last = turn.steps.at(-1);
        if (last?.type === "thinkingMessage") turn.steps[turn.steps.length - 1] = { type: "thinkingMessage", message: { ...last.message, text: `${last.message.text}${update.text}` } };
        else turn.steps.push({ type: "thinkingMessage", message: { text: update.text } });
        return;
      }
      case "tool-call-completed":
        current().steps.push({ type: "toolCall", message: update.toolCall });
        return;
      case "turn-ended": {
        const usage = update.usage;
        if (usage === undefined) return;
        const previous = this.#usage;
        this.#usage = {
          inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
          outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
          cacheReadTokens: (previous?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
          cacheWriteTokens: (previous?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
          totalTokens: (previous?.totalTokens ?? 0) + usage.inputTokens + usage.outputTokens,
        };
        return;
      }
      default:
        return;
    }
  }
}
