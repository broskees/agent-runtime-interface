// A fake Claude Agent SDK: the same module surface as
// `@anthropic-ai/claude-agent-sdk` 0.3.330 for the functions the driver
// loads (`query`, `getSessionInfo`, `getSessionMessages`, `listSessions`,
// `deleteSession`, `archiveSession`), typed against the pinned SDK's own
// declarations, so every message it yields and every option, prompt and
// permission result it receives is type-checked against the vendor's types.
// It imports no driver code.
//
// Behaviour follows the SDK's documentation and types (SOURCES.md): a query
// in streaming input mode runs one Claude Code "process" for one session;
// a prompt starts a turn when none runs, folds into the running turn with
// priority "next", interrupts it with priority "now" (the aborted native
// turn ends with terminal_reason "aborted_streaming") and waits with
// priority "later"; `canUseTool` is called for each permission prompt
// unless the permission mode allows the tool (then the tool runs and no
// permission reply exists); `resume` of a session that is
// missing exits, and of one another process holds exits after a startup
// failure result (with CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1); `forkSession`
// copies the transcript up to `resumeSessionAt` into a new session;
// `stopTask` ends a task with a `task_notification` of status "stopped";
// `setModel` and `applyFlagSettings` change the model and effort the
// process runs. Claude Code's goal command and tool follow its 2.1.330
// code: `/goal` records the tagged command and its tagged output in the
// transcript, and SetGoal's result says whether the goal was set or only
// proposed.
//
// The fake does nothing on its own: each turn waits for the conformance
// kit's puppet calls (`NativeTurn`), and each step resolves once its frames
// are queued for the driver.

import type { UUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as ClaudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import type {
  ModelInfo,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { BetaMessage, BetaRawMessageStreamEvent, BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import type { NativeApproval, NativeApprovalHandle, NativeFailure, NativeSessionState, NativeTool, NativeTurn } from "../../../src/conformance/index.ts";

/** The part of the SDK module the driver loads. */
export type FakeSdkModule = Pick<typeof ClaudeAgentSdk, "query" | "getSessionInfo" | "getSessionMessages" | "listSessions" | "deleteSession" | "archiveSession">;

/** How the fake's `claude auth status --json` answers. */
export type FakeAmbientAuth = "authenticated" | "unauthenticated" | "unknown" | "unavailable";

/** The native answer a kit approval option corresponds to: Claude's permission results carry no option ids. */
export type FakeNativeAnswer = { readonly behavior: "allow"; readonly destination?: PermissionUpdate["destination"] } | { readonly behavior: "deny" };

export interface FakeApprovalHandle extends NativeApprovalHandle {
  /** For each kit option id, the permission result that selects it. */
  readonly nativeAnswers: { readonly [optionId: string]: FakeNativeAnswer };
}

export interface FakeTurn extends NativeTurn {
  readonly sessionId: string;
  /** Completes the turn with a structured answer (`outputFormat`), as text generation asks. */
  completeWith(answer: { text?: string; structuredOutput?: unknown }): Promise<void>;
  /** Calls `canUseTool` for an AskUserQuestion and resolves with the permission result the driver returned. */
  askQuestions(questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>): Promise<PermissionResult>;
  /** Calls `canUseTool` for a tool with the given suggestions and context and resolves with the result. */
  ask(toolName: string, input: Record<string, unknown>, extra?: { suggestions?: PermissionUpdate[]; agentID?: string; suppressAlwaysAllowRule?: boolean }): Promise<PermissionResult>;
  /** Streams a rate limit event, as Claude Code does on claude.ai subscriptions. */
  rateLimit(info: { status: "allowed" | "allowed_warning" | "rejected"; resetsAt?: number; rateLimitType?: "five_hour" | "seven_day"; utilization?: number }): Promise<void>;
  /** Claude calls its SetGoal tool; `askUser` (the tool's default) only proposes the goal to the user. */
  proposeGoal(condition: string, options?: { askUser?: boolean }): Promise<void>;
  /** Streams a hook's started and response messages (`includeHookEvents`). */
  runHook(name: string, event: string, output: string): Promise<void>;
  /** The API refuses the credential: an `authentication_failed` assistant error and a 401 result. */
  failAuthentication(): Promise<void>;
  /**
   * Claude runs a Bash command: the `tool_use`, then `canUseTool` (with a
   * suggestion to allow the command in local settings) unless the permission
   * mode runs it unasked, then the tool result: `output` when allowed, the
   * denial message as an error result when denied. Resolves with the
   * permission result, or undefined when Claude Code did not ask.
   */
  runBash(command: string, output: string): Promise<PermissionResult | undefined>;
}

/** Every call the driver made into the fake, oldest first. */
export type FakeCall =
  | { readonly kind: "query"; readonly options: Options; readonly prompt: "stream" | "string" }
  | { readonly kind: "prompt"; readonly sessionId: string; readonly message: SDKUserMessage }
  | { readonly kind: "setMcpServers"; readonly sessionId: string; readonly servers: Parameters<Query["setMcpServers"]>[0] }
  | { readonly kind: "setModel"; readonly sessionId: string; readonly model: string | undefined }
  | { readonly kind: "setPermissionMode"; readonly sessionId: string; readonly mode: Parameters<Query["setPermissionMode"]>[0] }
  | { readonly kind: "applyFlagSettings"; readonly sessionId: string; readonly settings: Parameters<Query["applyFlagSettings"]>[0] }
  | { readonly kind: "rewindFiles"; readonly sessionId: string; readonly userMessageId: string; readonly dryRun: boolean; readonly result: Awaited<ReturnType<Query["rewindFiles"]>> }
  | { readonly kind: "stopTask"; readonly sessionId: string; readonly taskId: string }
  | { readonly kind: "interrupt"; readonly sessionId: string }
  | { readonly kind: "close"; readonly sessionId: string | undefined }
  | { readonly kind: "canUseTool"; readonly sessionId: string; readonly toolName: string; readonly result: PermissionResult };

interface StoredTask {
  readonly id: string;
  readonly title: string;
  readonly type: "local_bash" | "local_agent";
  running: boolean;
}

interface StoredSession {
  readonly id: string;
  readonly cwd: string;
  readonly entries: SessionMessage[];
  /** The prompts that began a turn the puppet drove; a steer or a folded prompt joins its turn instead. */
  readonly turnPrompts: Set<string>;
  readonly tasks: Map<string, StoredTask>;
  title: string | undefined;
  archived: boolean;
  createdAt: number;
  lastModified: number;
  /** The goal Claude Code holds, set by /goal or SetGoal. */
  goal?: string;
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  settled = false;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = (value) => {
        if (this.settled) return;
        this.settled = true;
        resolve(value);
      };
      this.reject = (error) => {
        if (this.settled) return;
        this.settled = true;
        reject(error);
      };
    });
    this.promise.catch(() => undefined);
  }
}

class Waiters<T> {
  readonly #items: T[] = [];
  readonly #waiting: Array<(value: T) => void> = [];
  push(value: T): void {
    const waiter = this.#waiting.shift();
    if (waiter !== undefined) waiter(value);
    else this.#items.push(value);
  }
  next(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.#waiting.push(resolve));
  }
}

const CLAUDE_CODE_VERSION = "2.1.330";
const MODEL = "claude-sonnet-5";

// What Claude Code 2.1.330 says for its goal tool and command (strings in its bundled code).
const SET_GOAL_SET = "The goal is set, without an approval dialog. The user can see it and can clear it with /goal clear. The stop check applies from your next stop.";
const SET_GOAL_PROPOSED =
  'Sent the goal proposal to the user for approval. If they approve, any previously set goal ends, the proposed goal is set, and you will receive a "Goal set" message; until they answer, any previously set goal remains in effect. A decline is not reported.';
const GOAL_CONDITION_LIMIT = 4000;
const GOAL_CLEAR_WORDS = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

function usage(input: number, output: number): BetaUsage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    fallback_credit: null,
    inference_geo: null,
    input_tokens: input,
    iterations: null,
    output_tokens: output,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: "standard",
    speed: "standard",
  };
}

function betaMessage(id: string, content: BetaMessage["content"], stopReason: BetaMessage["stop_reason"]): BetaMessage {
  return { id, container: null, content, context_management: null, diagnostics: null, model: MODEL, role: "assistant", stop_details: null, stop_reason: stopReason, stop_sequence: null, type: "message", usage: usage(10, 5) };
}

function promptText(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The prompt text of a transcript entry, when it is a prompt (not a tool result). */
export function entryPrompt(entry: SessionMessage): string | undefined {
  if (entry.type !== "user" || entry.parent_tool_use_id !== null) return undefined;
  const content = (entry.message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((block) => (block as { type?: unknown }).type === "tool_result")) return undefined;
  return content.flatMap((block) => ((block as { type?: unknown }).type === "text" ? [(block as { text: string }).text] : [])).join("\n\n");
}

/** One fake Claude Code installation: its transcript store, its processes, and the puppet's view of them. */
export class FakeClaudeWorld {
  readonly sessions = new Map<string, StoredSession>();
  readonly locked = new Set<string>();
  readonly queries: FakeQuery[] = [];
  readonly calls: FakeCall[] = [];
  readonly ambientAuth: FakeAmbientAuth;
  /** Mirror transcripts to the query's Claude config directory, as Claude Code writes them; only ever under the OS temp directory. */
  readonly writeTranscripts: boolean;
  /**
   * The mode the user's settings give a query started without `permissionMode`
   * (`permissions.defaultMode`): the SDK's `Options.permissionMode` says Claude
   * Code then starts as `claude -p` does, in that mode.
   */
  userPermissionMode: NonNullable<Options["permissionMode"]> = "default";
  readonly #turns = new Waiters<FakeTurn>();
  #ids = 0;
  #sessionIds = 0;
  readonly sdk: FakeSdkModule;

  constructor(options: { ambientAuth?: FakeAmbientAuth; writeTranscripts?: boolean } = {}) {
    this.ambientAuth = options.ambientAuth ?? "authenticated";
    this.writeTranscripts = options.writeTranscripts === true;
    this.sdk = {
      query: (params) => new FakeQuery(this, params),
      getSessionInfo: async (sessionId, options) => this.#info(sessionId, options?.dir),
      getSessionMessages: async (sessionId, options) => {
        const session = this.sessions.get(sessionId);
        if (session === undefined || (options?.dir !== undefined && options.dir !== session.cwd)) return [];
        return session.entries.map((entry) => structuredClone(entry));
      },
      listSessions: async (options) => {
        const listed = [...this.sessions.values()]
          .filter((session) => session.entries.length > 0 && (options?.dir === undefined || options.dir === session.cwd))
          .sort((a, b) => b.lastModified - a.lastModified)
          .map((session) => this.#info(session.id, undefined)!)
          .filter((info): info is SDKSessionInfo => info !== undefined);
        const offset = options?.offset ?? 0;
        return listed.slice(offset, options?.limit === undefined ? undefined : offset + options.limit);
      },
      deleteSession: async (sessionId, options) => {
        const session = this.sessions.get(sessionId);
        if (session === undefined || (options?.dir !== undefined && options.dir !== session.cwd)) throw new Error(`Session ${sessionId} not found`);
        this.sessions.delete(sessionId);
      },
      archiveSession: async (sessionId, options) => {
        const session = this.sessions.get(sessionId);
        if (session === undefined || (options?.dir !== undefined && options.dir !== session.cwd)) throw new Error(`Session ${sessionId} not found`);
        session.archived = true;
      },
    };
  }

  /** A deterministic UUID: native ids start over in every world. */
  uuid(): UUID {
    this.#ids += 1;
    return `00000000-0000-4000-8000-${String(this.#ids).padStart(12, "0")}`;
  }

  /** A UUID for the driver's `newUuid` seam: Claude takes session and prompt ids the client chooses. */
  newUuid(): string {
    this.#sessionIds += 1;
    return `5e551011-0000-4000-8000-${String(this.#sessionIds).padStart(12, "0")}`;
  }

  #info(sessionId: string, dir: string | undefined): SDKSessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    // Claude Code writes a session's transcript only once it holds a message.
    if (session === undefined || session.entries.length === 0 || (dir !== undefined && dir !== session.cwd)) return undefined;
    const first = session.entries.map(entryPrompt).find((prompt) => prompt !== undefined);
    return {
      sessionId,
      summary: session.title ?? first ?? "",
      lastModified: session.lastModified,
      cwd: session.cwd,
      createdAt: session.createdAt,
      ...(first === undefined ? {} : { firstPrompt: first }),
      ...(session.title === undefined ? {} : { customTitle: session.title }),
      ...(session.archived ? { archived: true } : {}),
    };
  }

  /**
   * What the native `claude` binary prints for `claude auth status --json`:
   * `{ loggedIn, authMethod, apiProvider, ... }`, exit 0 signed in or not. A
   * cloud provider (Bedrock here) authenticates outside Claude Code. An
   * unreadable credential store fails the command.
   */
  authStatus(): { code: number; stdout: string; stderr: string } {
    switch (this.ambientAuth) {
      case "authenticated":
        return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "fake@example.invalid", subscriptionType: "pro" }), stderr: "" };
      case "unauthenticated":
        return { code: 0, stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }), stderr: "" };
      case "unknown":
        return { code: 0, stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "bedrock" }), stderr: "" };
      default:
        return { code: 1, stdout: "", stderr: "Error: could not read the credential store\n" };
    }
  }

  /** Resolves when a query starts a new native turn. */
  nextTurn(): Promise<FakeTurn> {
    return this.#turns.next();
  }

  /** @internal */
  turnStarted(turn: FakeTurn): void {
    this.#turns.push(turn);
  }

  /** The environment each query was started with (`Options.env`). */
  environments(): Array<{ [name: string]: string }> {
    return this.calls.flatMap((call) =>
      call.kind === "query" ? [Object.fromEntries(Object.entries(call.options.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"))] : [],
    );
  }

  /** Every prompt the driver sent, as Claude received it. */
  prompts(): SDKUserMessage[] {
    return this.calls.flatMap((call) => (call.kind === "prompt" ? [call.message] : []));
  }

  inspect(sessionId: string): NativeSessionState | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return undefined;
    const loaded = this.queries.some((query) => query.sessionId === sessionId && query.alive);
    const tasks = [...session.tasks.values()];
    return {
      loaded,
      cwd: session.cwd,
      prompts: session.entries.filter((entry) => session.turnPrompts.has(entry.uuid)).map(entryPrompt).filter((prompt): prompt is string => prompt !== undefined),
      compactions: 0,
      injectedMessages: [],
      backgroundTasks: tasks.filter((task) => task.type === "local_bash").map((task) => ({ title: task.title, running: task.running })),
      subagents: tasks.filter((task) => task.type === "local_agent").map((task) => ({ name: task.title, running: task.running })),
    };
  }

  /** @internal Appends to a session's transcript and mirrors it to disk when asked. */
  append(session: StoredSession, entry: SessionMessage, options: Options): void {
    session.entries.push(entry);
    session.lastModified += 1;
    this.persist(session, options);
  }

  /** @internal Writes the transcript where Claude Code keeps it: <config dir>/projects/<cwd with / as ->/<session>.jsonl. */
  persist(session: StoredSession, options: Options, systemPrompt?: string): void {
    if (!this.writeTranscripts) return;
    const env = options.env ?? {};
    const configDir = env["CLAUDE_CONFIG_DIR"] ?? (env["HOME"] === undefined ? undefined : path.join(env["HOME"], ".claude"));
    if (configDir === undefined) throw new Error("the fake has no HOME or CLAUDE_CONFIG_DIR to keep transcripts in");
    const temp = fs.realpathSync(os.tmpdir());
    const real = fs.existsSync(configDir) ? fs.realpathSync(configDir) : path.resolve(configDir);
    if (!real.startsWith(`${temp}${path.sep}`)) throw new Error(`the fake refuses to write transcripts outside ${temp}: ${configDir}`);
    const directory = path.join(configDir, "projects", session.cwd.replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(directory, { recursive: true });
    const lines = [...(systemPrompt === undefined ? [] : [{ type: "system", subtype: "system_prompt", content: systemPrompt }]), ...session.entries];
    fs.writeFileSync(path.join(directory, `${session.id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  }
}

type PendingPermission = { readonly controller: AbortController };

class FakeNativeTurn implements FakeTurn {
  readonly prompt: string;
  readonly sessionId: string;
  readonly #query: FakeQuery;
  /** The uuid of the prompt the current native turn answers. */
  promptUuid: string | undefined;
  readonly #steers = new Waiters<string>();
  readonly #stop = new Deferred<"cancel" | "exit">();
  ended = false;
  lastText = "";
  readonly pending = new Set<PendingPermission>();

  constructor(query: FakeQuery, message: SDKUserMessage) {
    this.#query = query;
    this.sessionId = query.sessionId!;
    this.prompt = promptText(message);
    this.promptUuid = message.uuid;
  }

  /** @internal A steer reached this turn. */
  steered(text: string): void {
    this.#steers.push(text);
  }

  /** @internal The driver asked to stop. */
  stop(how: "cancel" | "exit"): void {
    this.#stop.resolve(how);
    for (const permission of this.pending) permission.controller.abort();
  }

  #live(): void {
    if (this.ended) throw new Error("the native turn already ended");
    if (!this.#query.alive) throw new Error("the native turn's process is gone");
  }

  async say(text: string): Promise<void> {
    this.#live();
    const query = this.#query;
    const messageId = `msg_${query.world.uuid()}`;
    const middle = Math.ceil(text.length / 2);
    const chunks = text.length > 1 ? [text.slice(0, middle), text.slice(middle)] : [text];
    query.stream({ type: "message_start", message: betaMessage(messageId, [], null) });
    query.stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } });
    for (const chunk of chunks) query.stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } });
    query.stream({ type: "content_block_stop", index: 0 });
    query.assistant(betaMessage(messageId, [{ type: "text", text, citations: null }], null));
    query.stream({ type: "message_delta", context_management: null, delta: { stop_reason: "end_turn", stop_sequence: null, container: null, stop_details: null }, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, iterations: null, fallback_credit: null, output_tokens_details: null } });
    query.stream({ type: "message_stop" });
    this.lastText = text;
  }

  /** The Claude tool a kit tool is: a read of its path, or a shell command. */
  #claudeTool(tool: NativeTool): { name: string; input: Record<string, unknown> } {
    const cwd = this.#query.cwd;
    if (tool.path !== undefined) return { name: "Read", input: { file_path: `${cwd}/${tool.path}` } };
    return { name: "Bash", input: { command: `${tool.name} ${JSON.stringify(tool.input)}` } };
  }

  async runTool(tool: NativeTool): Promise<void> {
    this.#live();
    const claudeTool = this.#claudeTool(tool);
    const toolUseId = this.#query.toolUse(claudeTool.name, claudeTool.input, null);
    this.#query.toolResult(toolUseId, tool.output, false, null);
  }

  async requestApproval(approval: NativeApproval): Promise<FakeApprovalHandle> {
    this.#live();
    const query = this.#query;
    const tool = approval.kind === "command" ? { name: "Bash", input: { command: (approval.command ?? ["true"]).join(" ") } } : { name: "Edit", input: { file_path: `${query.cwd}/${approval.path ?? "file"}`, old_string: "a", new_string: "b" } };
    const toolUseId = query.toolUse(tool.name, tool.input, null);
    const destinations: PermissionUpdate["destination"][] = ["localSettings", "userSettings", "projectSettings"];
    const suggestions: PermissionUpdate[] = [];
    const nativeAnswers: { [optionId: string]: FakeNativeAnswer } = {};
    for (const option of approval.options) {
      if (option.decision === "accept") nativeAnswers[option.optionId] = { behavior: "allow" };
      else if (option.decision === "decline") nativeAnswers[option.optionId] = { behavior: "deny" };
      else {
        const destination = option.decision === "accept_for_session" ? "session" : destinations.shift();
        if (destination === undefined) throw new Error("the fake offers at most three persistent rule destinations");
        suggestions.push({ type: "addRules", rules: [{ toolName: tool.name, ruleContent: `${String(tool.input["command"] ?? tool.input["file_path"])}:${option.optionId}` }], behavior: "allow", destination });
        nativeAnswers[option.optionId] = { behavior: "allow", destination };
      }
    }
    const replies: string[] = [];
    const replied = new Waiters<string>();
    const kitIdFor = (result: PermissionResult): string => {
      const match = Object.entries(nativeAnswers).find(([, answer]) =>
        result.behavior === "deny"
          ? answer.behavior === "deny"
          : answer.behavior === "allow" && (result.updatedPermissions === undefined || result.updatedPermissions.length === 0 ? answer.destination === undefined : answer.destination === result.updatedPermissions[0]!.destination),
      );
      if (match === undefined) throw new Error(`the driver answered with a permission result no option selects: ${JSON.stringify(result)}`);
      return match[0];
    };
    const record = (optionId: string): void => {
      replies.push(optionId);
      replied.push(optionId);
    };
    // The permission mode decides first: bypassPermissions runs everything, acceptEdits runs edits.
    // Claude Code then runs the tool without calling canUseTool, so no reply to any option exists.
    const mode = query.permissionMode;
    if (mode === "bypassPermissions" || (mode === "acceptEdits" && tool.name === "Edit")) {
      query.toolResult(toolUseId, "ok", false, null);
    } else {
      void this.ask(tool.name, tool.input, { suggestions }, toolUseId).then(
        (result) => {
          record(kitIdFor(result));
          query.toolResult(toolUseId, result.behavior === "allow" ? "ok" : result.message, result.behavior === "deny", null);
        },
        () => undefined,
      );
    }
    return {
      nextReply: () => replied.next(),
      replies: async () => [...replies],
      nativeAnswers,
    };
  }

  /** Calls `canUseTool` and resolves with its answer. */
  async ask(toolName: string, input: Record<string, unknown>, extra: { suggestions?: PermissionUpdate[]; agentID?: string; suppressAlwaysAllowRule?: boolean } = {}, toolUseId?: string): Promise<PermissionResult> {
    this.#live();
    const query = this.#query;
    const canUseTool = query.options.canUseTool;
    if (canUseTool === undefined) throw new Error("the driver gave no canUseTool, so Claude Code cannot ask");
    const useId = toolUseId ?? query.toolUse(toolName, input, null);
    const permission: PendingPermission = { controller: new AbortController() };
    this.pending.add(permission);
    const result = await canUseTool(toolName, input, {
      signal: permission.controller.signal,
      toolUseID: useId,
      requestId: `req_${query.world.uuid()}`,
      ...(extra.suggestions === undefined ? {} : { suggestions: extra.suggestions }),
      ...(extra.agentID === undefined ? {} : { agentID: extra.agentID }),
      ...(extra.suppressAlwaysAllowRule === undefined ? {} : { suppressAlwaysAllowRule: extra.suppressAlwaysAllowRule }),
    });
    this.pending.delete(permission);
    if (result === null) throw new Error("the driver answered canUseTool with null but sent no control_response");
    query.world.calls.push({ kind: "canUseTool", sessionId: this.sessionId, toolName, result });
    return result;
  }

  async askQuestions(questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>): Promise<PermissionResult> {
    return this.ask("AskUserQuestion", { questions });
  }

  async runBash(command: string, output: string): Promise<PermissionResult | undefined> {
    this.#live();
    const query = this.#query;
    const input = { command, description: "Run the command the user asked for" };
    const toolUseId = query.toolUse("Bash", input, null);
    if (query.permissionMode === "bypassPermissions") {
      query.toolResult(toolUseId, output, false, null);
      return undefined;
    }
    const suggestions: PermissionUpdate[] = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: command }], behavior: "allow", destination: "localSettings" }];
    const result = await this.ask("Bash", input, { suggestions }, toolUseId);
    query.toolResult(toolUseId, result.behavior === "allow" ? output : result.message, result.behavior === "deny", null);
    return result;
  }

  async startBackgroundTask(task: { readonly title: string }): Promise<void> {
    this.#live();
    const query = this.#query;
    const toolUseId = query.toolUse("Bash", { command: task.title, run_in_background: true }, null);
    const taskId = `bash_${query.world.uuid()}`;
    query.toolResult(toolUseId, `Command running in background with ID: ${taskId}`, false, null);
    query.session!.tasks.set(taskId, { id: taskId, title: task.title, type: "local_bash", running: true });
    query.emit({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, description: task.title, task_type: "local_bash", is_backgrounded: true, uuid: query.world.uuid(), session_id: this.sessionId });
  }

  async spawnSubagent(subagent: { readonly name: string }): Promise<void> {
    this.#live();
    const query = this.#query;
    const toolUseId = query.toolUse("Agent", { description: subagent.name, subagent_type: subagent.name, prompt: `Work on ${subagent.name}`, run_in_background: true }, null);
    const taskId = `agent_${query.world.uuid()}`;
    query.session!.tasks.set(taskId, { id: taskId, title: subagent.name, type: "local_agent", running: true });
    query.emit({
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      tool_use_id: toolUseId,
      description: subagent.name,
      task_type: "local_agent",
      subagent_type: subagent.name,
      is_backgrounded: true,
      spawn_depth: 1,
      prompt: `Work on ${subagent.name}`,
      uuid: query.world.uuid(),
      session_id: this.sessionId,
    });
    query.toolResult(toolUseId, `Agent ${subagent.name} started in the background (task ${taskId}).`, false, null);
  }

  nextSteer(): Promise<string> {
    return this.#steers.next();
  }

  #result(extra: Partial<Extract<SDKResultMessage, { subtype: "success" }>> = {}): Extract<SDKResultMessage, { subtype: "success" }> {
    const query = this.#query;
    return {
      type: "result",
      subtype: "success",
      uuid: query.world.uuid(),
      session_id: this.sessionId,
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 1,
      result: this.lastText,
      stop_reason: "end_turn",
      total_cost_usd: 0.001,
      usage: { ...usage(10, 5), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as Extract<SDKResultMessage, { subtype: "success" }>["usage"],
      modelUsage: {},
      permission_denials: [],
      terminal_reason: "completed",
      ...(this.promptUuid === undefined ? {} : { user_message_uuid: this.promptUuid, user_message_uuids: [this.promptUuid] }),
      ...extra,
    };
  }

  /** Ends the native turn: no more frames for it, the next prompt starts a new one. */
  #end(): void {
    this.ended = true;
    this.#query.turnEnded(this);
  }

  async complete(): Promise<void> {
    this.#live();
    this.#end();
    this.#query.emit(this.#result());
    this.#query.afterTurn();
  }

  async completeWith(answer: { text?: string; structuredOutput?: unknown }): Promise<void> {
    if (answer.text !== undefined) await this.say(answer.text);
    this.#live();
    this.#end();
    this.#query.emit(this.#result(answer.structuredOutput === undefined ? {} : { structured_output: answer.structuredOutput }));
    this.#query.afterTurn();
  }

  async completeHeld(): Promise<{ release(): Promise<void> }> {
    this.#live();
    this.#end();
    const result = this.#result();
    return {
      release: async () => {
        this.#query.emit(result);
        this.#query.afterTurn();
      },
    };
  }

  async fail(failure: NativeFailure): Promise<void> {
    this.#live();
    const query = this.#query;
    let text: string;
    let error: NonNullable<SDKAssistantMessage["error"]>;
    let status: number;
    if (failure.kind === "usage_limit") {
      const resetsAt = Math.floor(Date.parse(failure.resetAt) / 1000);
      query.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour", utilization: 1 }, uuid: query.world.uuid(), session_id: this.sessionId });
      text = `You've hit your limit · ${failure.message}`;
      error = "rate_limit";
      status = 429;
    } else {
      text = `API Error: 500 ${failure.message}`;
      error = "server_error";
      status = 500;
    }
    query.assistant(betaMessage(`msg_${query.world.uuid()}`, [{ type: "text", text, citations: null }], "end_turn"), { error });
    this.lastText = text;
    this.#end();
    query.emit(this.#result({ is_error: true, api_error_status: status, result: text, terminal_reason: "api_error" }));
    query.afterTurn();
  }

  async failAuthentication(): Promise<void> {
    this.#live();
    const query = this.#query;
    const text = "Invalid API key · Please run /login";
    query.assistant(betaMessage(`msg_${query.world.uuid()}`, [{ type: "text", text, citations: null }], "end_turn"), { error: "authentication_failed" });
    this.lastText = text;
    this.#end();
    query.emit(this.#result({ is_error: true, api_error_status: 401, result: text, terminal_reason: "api_error" }));
    query.afterTurn();
  }

  stopRequested(): Promise<"cancel" | "exit"> {
    return this.#stop.promise;
  }

  async finishCancelled(): Promise<void> {
    this.#live();
    this.#end();
    this.#query.emit(this.#result({ result: "", stop_reason: null, terminal_reason: "aborted_streaming" }));
    this.#query.afterTurn();
  }

  async exitProcess(): Promise<void> {
    this.#query.crash(new Error("Claude Code process exited with code 1"));
  }

  async rateLimit(info: { status: "allowed" | "allowed_warning" | "rejected"; resetsAt?: number; rateLimitType?: "five_hour" | "seven_day"; utilization?: number }): Promise<void> {
    this.#live();
    this.#query.emit({ type: "rate_limit_event", rate_limit_info: info, uuid: this.#query.world.uuid(), session_id: this.sessionId });
  }

  async proposeGoal(condition: string, options: { askUser?: boolean } = {}): Promise<void> {
    this.#live();
    const askUser = options.askUser !== false;
    const toolUseId = this.#query.toolUse("SetGoal", { condition, ask_user: askUser }, null);
    // Claude Code 2.1.330's SetGoal results: without ask_user it sets the goal; with it (the default) it only shows the user a proposal.
    if (!askUser) this.#query.session!.goal = condition;
    this.#query.toolResult(toolUseId, askUser ? SET_GOAL_PROPOSED : SET_GOAL_SET, false, null);
  }

  async runHook(name: string, event: string, output: string): Promise<void> {
    this.#live();
    const query = this.#query;
    const hookId = `hook_${query.world.uuid()}`;
    query.emit({ type: "system", subtype: "hook_started", hook_id: hookId, hook_name: name, hook_event: event, uuid: query.world.uuid(), session_id: this.sessionId });
    query.emit({ type: "system", subtype: "hook_response", hook_id: hookId, hook_name: name, hook_event: event, output, stdout: output, stderr: "", exit_code: 0, outcome: "success", uuid: query.world.uuid(), session_id: this.sessionId });
  }
}

/** One `query()`: one Claude Code process. */
export class FakeQuery implements Query {
  readonly world: FakeClaudeWorld;
  readonly options: Options;
  session: StoredSession | undefined;
  sessionId: string | undefined;
  cwd: string;
  permissionMode: NonNullable<Options["permissionMode"]>;
  /** The model the process runs: `Options.model` at start, then each `setModel`. */
  model: string;
  /** The effort level the process runs: `Options.effort` at start, then each `applyFlagSettings` effortLevel. */
  effort: Options["effort"];
  alive = true;
  readonly #out: SDKMessage[] = [];
  #waiter: ((result: IteratorResult<SDKMessage, void>) => void) | undefined;
  #crashed: Error | undefined;
  readonly #init = new Deferred<void>();
  #turn: FakeNativeTurn | undefined;
  readonly #later: SDKUserMessage[] = [];
  #inputEnded = false;
  #initSent = false;
  #rewinds = 0;

  constructor(world: FakeClaudeWorld, params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) {
    this.world = world;
    this.options = params.options ?? {};
    this.cwd = this.options.cwd ?? process.cwd();
    this.permissionMode = this.options.permissionMode ?? world.userPermissionMode;
    this.model = this.options.model ?? MODEL;
    this.effort = this.options.effort;
    world.queries.push(this);
    world.calls.push({ kind: "query", options: this.options, prompt: typeof params.prompt === "string" ? "string" : "stream" });
    this.#startup();
    if (!this.alive) return;
    const prompt = typeof params.prompt === "string" ? (async function* (text: string): AsyncGenerator<SDKUserMessage> {
      yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    })(params.prompt) : params.prompt;
    void this.#read(prompt);
  }

  /** Attaches to a session the way Claude Code's start-up does, or fails the way it fails. */
  #startup(): void {
    const options = this.options;
    if (options.resume !== undefined) {
      const source = this.world.sessions.get(options.resume);
      if (source === undefined || source.entries.length === 0) return this.#refuse(`No conversation found with session ID: ${options.resume}`);
      if (this.world.locked.has(options.resume) && options.forkSession !== true) {
        if (options.env?.["CLAUDE_CODE_STARTUP_FAILURE_RESULTS"] === "1") {
          this.#out.push({
            type: "result",
            subtype: "error_during_execution",
            uuid: this.world.uuid(),
            session_id: options.resume,
            duration_ms: 0,
            duration_api_ms: 0,
            is_error: true,
            num_turns: 0,
            stop_reason: null,
            total_cost_usd: 0,
            usage: { ...usage(0, 0), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as Extract<SDKResultMessage, { subtype: "error_during_execution" }>["usage"],
            modelUsage: {},
            permission_denials: [],
            errors: [`Session ${options.resume} is held by a background session`],
            startup_failure_reason: "session_held_by_background",
          });
        }
        return this.#refuse(`Session ${options.resume} is held by another Claude Code process`);
      }
      if (options.forkSession === true) {
        const id = options.sessionId ?? this.world.uuid();
        if (!UUID_PATTERN.test(id)) return this.#refuse(`Invalid session ID: ${id}`);
        if (this.world.sessions.has(id)) return this.#refuse(`Session ID ${id} is already in use`);
        const end = options.resumeSessionAt === undefined ? source.entries.length - 1 : source.entries.findIndex((entry) => entry.uuid === options.resumeSessionAt);
        if (end < 0) return this.#refuse(`No message found with uuid ${String(options.resumeSessionAt)}`);
        const copied = source.entries.slice(0, end + 1).map((entry) => ({ ...structuredClone(entry), session_id: id }));
        const turnPrompts = new Set(copied.filter((entry) => source.turnPrompts.has(entry.uuid)).map((entry) => entry.uuid));
        const session: StoredSession = { id, cwd: this.cwd, entries: copied, turnPrompts, tasks: new Map(), title: undefined, archived: false, createdAt: Date.now(), lastModified: Date.now() };
        this.world.sessions.set(id, session);
        this.#attach(session);
        this.world.persist(session, options, this.#recordedPrompt());
        return;
      }
      if (options.resumeSessionAt !== undefined) {
        const end = source.entries.findIndex((entry) => entry.uuid === options.resumeSessionAt);
        if (end < 0) return this.#refuse(`No message found with uuid ${options.resumeSessionAt}`);
        for (const dropped of source.entries.splice(end + 1)) source.turnPrompts.delete(dropped.uuid);
      }
      this.#attach(source);
      return;
    }
    const id = options.sessionId ?? this.world.uuid();
    if (!UUID_PATTERN.test(id)) return this.#refuse(`Invalid session ID: ${id}`);
    // An id is in use once its transcript exists or a running process holds it; an id that never got a message is free again after its process ended.
    const existing = this.world.sessions.get(id);
    const held = this.world.queries.some((query) => query !== this && query.alive && query.sessionId === id);
    if ((existing !== undefined && existing.entries.length > 0) || held) return this.#refuse(`Session ID ${id} is already in use`);
    const session: StoredSession = { id, cwd: this.cwd, entries: [], turnPrompts: new Set(), tasks: new Map(), title: options.title, archived: false, createdAt: Date.now(), lastModified: Date.now() };
    if (options.persistSession !== false) this.world.sessions.set(id, session);
    this.#attach(session);
  }

  /** What Claude Code records as the conversation's system prompt (`snapshot`, the default), or undefined when it records none. */
  #recordedPrompt(): string | undefined {
    const prompt = this.options.systemPrompt;
    if (prompt === undefined || typeof prompt === "string" || Array.isArray(prompt)) return typeof prompt === "string" ? prompt : undefined;
    if (prompt.snapshot === false) return undefined;
    return prompt.type === "preset" ? `<claude_code system prompt>${prompt.append === undefined ? "" : `\n${prompt.append}`}` : String(prompt.prompt);
  }

  #attach(session: StoredSession): void {
    this.session = session;
    this.sessionId = session.id;
    this.cwd = session.cwd === this.cwd ? this.cwd : this.cwd;
    this.#init.resolve();
  }

  #refuse(reason: string): void {
    this.alive = false;
    this.#init.reject(new Error(`Claude Code process exited with code 1: ${reason}`));
    this.#crashed = new Error(`Claude Code process exited with code 1: ${reason}`);
  }

  async #read(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const message of prompt) {
      if (!this.alive) return;
      this.world.calls.push({ kind: "prompt", sessionId: this.sessionId!, message });
      this.#onPrompt(message);
    }
    this.#inputEnded = true;
    if (this.#turn === undefined) this.#finish();
  }

  #onPrompt(message: SDKUserMessage): void {
    const session = this.session!;
    if (message.shouldQuery === false) {
      this.world.append(session, this.#entry(message), this.options);
      return;
    }
    const turn = this.#turn;
    if (turn === undefined) return this.#startTurn(message);
    if (message.priority === "later") {
      this.#later.push(message);
      return;
    }
    if (message.priority === "now") {
      // Claude Code stops the running native turn and reads this prompt next, in a new native turn.
      this.emit({
        type: "result",
        subtype: "success",
        uuid: this.world.uuid(),
        session_id: session.id,
        duration_ms: 5,
        duration_api_ms: 4,
        is_error: false,
        num_turns: 1,
        result: "",
        stop_reason: null,
        total_cost_usd: 0.0005,
        usage: { ...usage(5, 1), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as Extract<SDKResultMessage, { subtype: "success" }>["usage"],
        modelUsage: {},
        permission_denials: [],
        terminal_reason: "aborted_streaming",
        ...(turn.promptUuid === undefined ? {} : { user_message_uuid: turn.promptUuid, user_message_uuids: [turn.promptUuid] }),
      });
      for (const permission of turn.pending) permission.controller.abort();
    }
    // A steer (or a "next" prompt) joins the turn the puppet is driving.
    this.world.append(session, this.#entry(message), this.options);
    turn.promptUuid = message.uuid ?? turn.promptUuid;
    turn.steered(promptText(message));
  }

  #entry(message: SDKUserMessage): SessionMessage {
    return { type: "user", uuid: message.uuid ?? this.world.uuid(), session_id: this.sessionId!, message: structuredClone(message.message), parent_tool_use_id: null, parent_agent_id: null };
  }

  #startTurn(message: SDKUserMessage): void {
    const session = this.session!;
    if (!this.#initSent) {
      this.#initSent = true;
      this.emit({
        type: "system",
        subtype: "init",
        apiKeySource: this.options.env?.["ANTHROPIC_API_KEY"] === undefined ? "none" : "ANTHROPIC_API_KEY",
        claude_code_version: CLAUDE_CODE_VERSION,
        cwd: this.cwd,
        tools: ["Bash", "Read", "Edit", "Agent", "SetGoal"],
        mcp_servers: [],
        model: this.model,
        permissionMode: this.permissionMode,
        slash_commands: ["compact", "goal"],
        output_style: "default",
        skills: [],
        plugins: [],
        uuid: this.world.uuid(),
        session_id: session.id,
      });
    }
    const firstMessage = session.entries.length === 0;
    const text = promptText(message);
    const goal = /^\/goal(?:\s|$)/.test(text) ? this.#goalCommand(message, text.slice("/goal".length).trim()) : undefined;
    if (goal === undefined) {
      const entry = this.#entry(message);
      session.turnPrompts.add(entry.uuid);
      this.world.append(session, entry, this.options);
    }
    if (firstMessage) this.world.persist(session, this.options, this.#recordedPrompt());
    if (goal?.modelTurn === false) {
      // Claude Code answers this command itself: the prompt ends with a result and no model turn.
      this.emit({
        type: "result",
        subtype: "success",
        uuid: this.world.uuid(),
        session_id: session.id,
        duration_ms: 1,
        duration_api_ms: 0,
        is_error: false,
        num_turns: 0,
        result: goal.output,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { ...usage(0, 0), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as Extract<SDKResultMessage, { subtype: "success" }>["usage"],
        modelUsage: {},
        permission_denials: [],
        terminal_reason: "completed",
        ...(message.uuid === undefined ? {} : { user_message_uuid: message.uuid, user_message_uuids: [message.uuid] }),
      });
      this.afterTurn();
      return;
    }
    const turn = new FakeNativeTurn(this, message);
    this.#turn = turn;
    this.world.turnStarted(turn);
  }

  /**
   * Claude Code's /goal command, as 2.1.330 runs it. The transcript gets the
   * command as tagged text (under the prompt's uuid) and its output as
   * tagged text, which getSessionMessages returns as two user rows. Only an
   * accepted condition ("Goal set: …") goes on to a model turn. Claude Code
   * also streams the output as an assistant message; the fake leaves that
   * out, because goals are read from the transcript.
   */
  #goalCommand(message: SDKUserMessage, args: string): { output: string; modelTurn: boolean } {
    const session = this.session!;
    let output: string;
    let modelTurn = false;
    if (args === "") {
      output = session.goal === undefined ? "No goal set. Usage: `/goal <condition>`" : `Goal active: ${session.goal} (not yet evaluated)`;
    } else if (GOAL_CLEAR_WORDS.has(args.toLowerCase())) {
      output = session.goal === undefined ? "No goal set" : `Goal cleared: ${session.goal}`;
      session.goal = undefined;
    } else if (args.length > GOAL_CONDITION_LIMIT) {
      output = `Goal condition is limited to ${GOAL_CONDITION_LIMIT} characters (got ${args.length})`;
    } else {
      output = `Goal set: ${args}`;
      session.goal = args;
      modelTurn = true;
    }
    const commandUuid = message.uuid ?? this.world.uuid();
    const row = (uuid: string, content: string): SessionMessage => ({ type: "user", uuid, session_id: session.id, message: { role: "user", content }, parent_tool_use_id: null, parent_agent_id: null });
    session.turnPrompts.add(commandUuid);
    this.world.append(session, row(commandUuid, `<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>${args}</command-args>`), this.options);
    this.world.append(session, row(this.world.uuid(), `<local-command-stdout>${output}</local-command-stdout>`), this.options);
    return { output, modelTurn };
  }

  /** @internal */
  turnEnded(turn: FakeNativeTurn): void {
    if (this.#turn === turn) this.#turn = undefined;
  }

  /** @internal After a result: a "later" prompt starts the next turn, or the input has ended. */
  afterTurn(): void {
    const next = this.#later.shift();
    if (next !== undefined) return this.#startTurn(next);
    if (this.#inputEnded) this.#finish();
  }

  /** @internal */
  emit(message: SDKMessage): void {
    if (!this.alive) return;
    const waiter = this.#waiter;
    if (waiter !== undefined) {
      this.#waiter = undefined;
      waiter({ value: message, done: false });
    } else this.#out.push(message);
  }

  /** @internal */
  stream(event: BetaRawMessageStreamEvent): void {
    this.emit({ type: "stream_event", event, parent_tool_use_id: null, uuid: this.world.uuid(), session_id: this.sessionId! });
  }

  /** @internal An assistant message: on the stream and in the transcript. */
  assistant(message: BetaMessage, extra: { error?: NonNullable<SDKAssistantMessage["error"]>; parent?: string | null } = {}): void {
    const uuid = this.world.uuid();
    const frame: SDKAssistantMessage = { type: "assistant", message, parent_tool_use_id: extra.parent ?? null, uuid, session_id: this.sessionId!, ...(extra.error === undefined ? {} : { error: extra.error }) };
    this.emit(frame);
    this.world.append(this.session!, { type: "assistant", uuid, session_id: this.sessionId!, message: structuredClone(message), parent_tool_use_id: extra.parent ?? null, parent_agent_id: null }, this.options);
  }

  /** @internal A tool call; returns its id. */
  toolUse(name: string, input: Record<string, unknown>, parent: string | null): string {
    const id = `toolu_${this.world.uuid()}`;
    this.assistant(betaMessage(`msg_${this.world.uuid()}`, [{ type: "tool_use", id, name, input }], "tool_use"), { parent });
    return id;
  }

  /** @internal A tool's result, as Claude Code feeds it back. */
  toolResult(toolUseId: string, output: string, isError: boolean, parent: string | null): void {
    const uuid = this.world.uuid();
    const message: SDKUserMessage["message"] = { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: output, is_error: isError }] };
    this.emit({ type: "user", message, parent_tool_use_id: parent, uuid, session_id: this.sessionId!, tool_use_result: { stdout: output, stderr: "", interrupted: false } });
    this.world.append(this.session!, { type: "user", uuid, session_id: this.sessionId!, message: structuredClone(message), parent_tool_use_id: parent, parent_agent_id: null }, this.options);
  }

  /** @internal The process dies. */
  crash(error: Error): void {
    if (!this.alive) return;
    this.#stopTasks();
    this.alive = false;
    this.#crashed = error;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter !== undefined) this.next().then(waiter, () => waiter({ value: undefined, done: true }));
    this.#turn?.stop("exit");
  }

  #stopTasks(): void {
    for (const task of this.session?.tasks.values() ?? []) task.running = false;
  }

  /** The process exits normally once its input ended and no turn runs. */
  #finish(): void {
    if (!this.alive) return;
    this.alive = false;
    this.#stopTasks();
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }

  // AsyncGenerator.

  next(): Promise<IteratorResult<SDKMessage, void>> {
    const message = this.#out.shift();
    if (message !== undefined) return Promise.resolve({ value: message, done: false });
    if (this.#crashed !== undefined) {
      const error = this.#crashed;
      return Promise.reject(error);
    }
    if (!this.alive) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.#waiter = (result) => {
        if (result.done === true && this.#crashed !== undefined) reject(this.#crashed);
        else resolve(result);
      };
    });
  }

  async return(): Promise<IteratorResult<SDKMessage, void>> {
    this.close();
    return { value: undefined, done: true };
  }

  async throw(error: unknown): Promise<IteratorResult<SDKMessage, void>> {
    this.close();
    throw error;
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  // Control requests.

  #requireAlive(what: string): void {
    if (!this.alive) throw new Error(`${what}: the Claude Code process has exited`);
  }

  async interrupt(): Promise<{ still_queued: string[] }> {
    this.#requireAlive("interrupt");
    this.world.calls.push({ kind: "interrupt", sessionId: this.sessionId! });
    this.#turn?.stop("cancel");
    return { still_queued: this.#later.flatMap((message) => (message.uuid === undefined ? [] : [message.uuid])) };
  }

  async setPermissionMode(mode: NonNullable<Options["permissionMode"]>): Promise<void> {
    this.#requireAlive("setPermissionMode");
    this.world.calls.push({ kind: "setPermissionMode", sessionId: this.sessionId!, mode });
    this.permissionMode = mode;
  }

  async setModel(model?: string): Promise<void> {
    this.#requireAlive("setModel");
    this.world.calls.push({ kind: "setModel", sessionId: this.sessionId!, model });
    // No model means Claude Code's default.
    this.model = model ?? MODEL;
  }

  async applyFlagSettings(settings: Parameters<Query["applyFlagSettings"]>[0]): Promise<void> {
    this.#requireAlive("applyFlagSettings");
    this.world.calls.push({ kind: "applyFlagSettings", sessionId: this.sessionId!, settings: structuredClone(settings) });
    // null removes the flag, back to Claude Code's default.
    if (settings.effortLevel !== undefined) this.effort = settings.effortLevel ?? undefined;
  }

  async initializationResult(): Promise<Awaited<ReturnType<Query["initializationResult"]>>> {
    await this.#init.promise;
    return {
      commands: [{ name: "compact", description: "Compact the conversation", argumentHint: "" }],
      agents: [],
      output_style: "default",
      available_output_styles: ["default"],
      models: await this.supportedModels(),
      account: { email: "fake@example.invalid", subscriptionType: "pro", apiProvider: "firstParty" },
      claude_code_version: CLAUDE_CODE_VERSION,
    };
  }

  async supportedModels(): Promise<ModelInfo[]> {
    await this.#init.promise;
    return [
      { value: "default", displayName: "Default (recommended)", description: "The model Claude Code picks" },
      { value: "sonnet", resolvedModel: MODEL, displayName: "Sonnet", description: "Fast and capable", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
      { value: "opus", resolvedModel: "claude-opus-4-8", displayName: "Opus", description: "Most capable", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    ];
  }

  async rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<Awaited<ReturnType<Query["rewindFiles"]>>> {
    this.#requireAlive("rewindFiles");
    if (this.options.enableFileCheckpointing !== true) return { canRewind: false, error: "File checkpointing is not enabled for this session" };
    const known = this.session!.entries.some((entry) => entry.uuid === userMessageId);
    this.#rewinds += 1;
    const result = known
      ? { canRewind: true, filesChanged: [`${this.cwd}/checkpointed-${this.#rewinds}.txt`], insertions: this.#rewinds, deletions: 2 * this.#rewinds }
      : { canRewind: false, error: `No checkpoint for message ${userMessageId}` };
    this.world.calls.push({ kind: "rewindFiles", sessionId: this.sessionId!, userMessageId, dryRun: options?.dryRun === true, result });
    return result;
  }

  async setMcpServers(servers: Parameters<Query["setMcpServers"]>[0]): Promise<Awaited<ReturnType<Query["setMcpServers"]>>> {
    this.#requireAlive("setMcpServers");
    this.world.calls.push({ kind: "setMcpServers", sessionId: this.sessionId!, servers });
    return { added: Object.keys(servers), removed: [], errors: {} };
  }

  async stopTask(taskId: string): Promise<void> {
    this.#requireAlive("stopTask");
    this.world.calls.push({ kind: "stopTask", sessionId: this.sessionId!, taskId });
    const task = this.session!.tasks.get(taskId);
    if (task === undefined || !task.running) return;
    task.running = false;
    this.emit({ type: "system", subtype: "task_notification", task_id: taskId, status: "stopped", output_file: "", summary: `${task.title} stopped`, uuid: this.world.uuid(), session_id: this.sessionId! });
  }

  close(): void {
    if (!this.alive && this.#crashed === undefined) return;
    this.world.calls.push({ kind: "close", sessionId: this.sessionId });
    this.#turn?.stop("exit");
    this.#crashed = undefined;
    this.#out.length = 0;
    this.#finish();
  }

  // Control requests this driver does not use.

  #unused(name: string): never {
    throw new Error(`the fake Claude Agent SDK does not serve Query.${name}`);
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
