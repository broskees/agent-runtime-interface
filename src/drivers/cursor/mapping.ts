// Pure translations from Cursor to ARI: deterministic ids, failures, and the
// fold that turns one run's interaction updates (what `send({ onDelta })`
// receives) into ARI items, subagents, plans and usage.
//
// Identity. A thread is a Cursor agent (`agent-<uuid>`, strong). A turn is a
// Cursor run (`run.id`, strong). Cursor gives the messages of a run no ids, so
// an item is named by its position in the run (its ordinal: the prompt is 0,
// then every message segment, tool call and summary in the order its first
// stream event arrived) plus a fingerprint of its kind; a tool item also keeps
// Cursor's call id. Cursor raises no requests at all: a local run answers its
// own interaction queries (questions are rejected, plans and mode switches
// approved; @cursor/sdk 1.4.2 dist/esm/977.js, ClientInteractionController),
// so request ids have strength `none` and the driver never makes one. The
// same native stream gives the same ids in any process, so a replay of a
// recorded session gives the ids it gave live.

import { deriveId } from "../../driver-kit/ids.ts";
import { truncateUtf8 } from "../../driver-kit/truncate.ts";
import { callErrors, toCallError } from "../../errors.ts";
import type { NativeRef } from "../../generated/common.ts";
import type { Failure } from "../../generated/errors.ts";
import type { FileChange, ItemKind, ItemPatch, ItemStatus, TodoEntry } from "../../generated/item.ts";
import type { PlanEntry, PlanPatch } from "../../generated/plan.ts";
import type { SubagentPatch, SubagentStatus } from "../../generated/subagent.ts";
import type { UsageSnapshot } from "../../generated/usage.ts";
import type { AriError } from "../../ari-error.ts";
import type { CursorInteractionUpdate, CursorRunError, CursorToolCall, CursorTurnUsage } from "./sdk.ts";

/** Bumped when the driver changes how it derives ids. */
export const IDENTITY_VERSION = 1;

export function threadIdFor(agentId: string): string {
  return deriveId({ kind: "thread", native: { id: agentId, strength: "strong" }, identityVersion: IDENTITY_VERSION });
}

export function turnIdFor(threadId: string, runId: string): string {
  return deriveId({ kind: "turn", native: { id: runId, strength: "strong" }, identityVersion: IDENTITY_VERSION, scope: threadId });
}

/** An item's native reference: its position in the run and its kind, plus Cursor's call id for a tool. */
export function itemNative(ordinal: number, fingerprint: string, callId: string | null = null): NativeRef {
  return { id: callId, strength: "weak", ordinal, fingerprint };
}

export function itemIdFor(turnId: string, native: NativeRef): string {
  return deriveId({ kind: "item", native, identityVersion: IDENTITY_VERSION, scope: turnId });
}

export function subagentIdFor(turnId: string, native: NativeRef): string {
  return deriveId({ kind: "subagent", native, identityVersion: IDENTITY_VERSION, scope: turnId });
}

/** The thread's one plan: the agent's todo list, which every `updateTodos` call replaces whole. */
export function planIdFor(threadId: string): string {
  return deriveId({ kind: "plan", native: { id: null, strength: "none", ordinal: 0, fingerprint: "todos" }, identityVersion: IDENTITY_VERSION, scope: threadId });
}

// ---------------------------------------------------------------------------
// Failures and errors

// The SDK names errors after Cursor's backend codes (RATE_LIMITED, PRO_USER_USAGE_LIMIT, ...)
// or Connect codes (resource_exhausted, unavailable, ...): @cursor/sdk dist/esm/index.js, src/agent/errors.ts.
const USAGE_LIMIT_CODE = /^(?:resource_exhausted|rate_limited(?:_changeable)?|\w*_usage_limit|\w*_rate_limit(?:_exceeded)?|api_key_rate_limit)$/i;
const RETRYABLE_LIMIT_CODE = /rate_limit|rate_limited|resource_exhausted/i;
const AUTH_CODE = /^(?:unauthenticated|permission_denied|not_logged_in|invalid_auth_id|not_high_enough_permissions|agent_requires_login|auth_token_not_found|auth_token_expired|unauthorized|bad_api_key|bad_user_api_key)$/i;
const TRANSPORT_CODE = /^(?:unavailable|deadline_exceeded|timeout|abort_err|connection_stalled|canceled|aborted|data_loss)$/i;
const VALIDATION_CODE = /^(?:invalid_argument|bad_model_name|model_blocked|bad_request|file_not_found|failed_precondition|out_of_range|not_found|deprecated)$/i;

/** The ARI failure for a run that ended with `status: "error"`. Cursor's `RunError` carries no reset time. */
export function failureFromRunError(error: CursorRunError | undefined): Failure {
  const message = error?.message !== undefined && error.message !== "" ? error.message : "Cursor reported an error";
  const code = error?.code;
  const base = code === undefined ? { message } : { message, code };
  if (code !== undefined && USAGE_LIMIT_CODE.test(code)) return { class: "usage_limit", ...base, retryable: RETRYABLE_LIMIT_CODE.test(code) };
  if (code !== undefined && AUTH_CODE.test(code)) return { class: "permission_error", ...base, retryable: false };
  if (code !== undefined && TRANSPORT_CODE.test(code)) return { class: "transport_error", ...base, retryable: true };
  if (code !== undefined && VALIDATION_CODE.test(code)) return { class: "validation_error", ...base, retryable: false };
  return { class: "provider_error", ...base, retryable: false };
}

function errorField(error: unknown, field: string): unknown {
  return typeof error === "object" && error !== null ? (error as { [key: string]: unknown })[field] : undefined;
}

/** An ARI call error for something the SDK threw. `what` names the operation, for messages. */
export function callErrorFromSdk(error: unknown, what: string): AriError {
  if (toCallError(error) !== undefined) return error as AriError;
  const name = errorField(error, "name");
  const code = errorField(error, "code");
  const message = error instanceof Error ? error.message : String(error);
  const detail = `${what}: ${message}`;
  if (name === "AuthenticationError" || (typeof code === "string" && AUTH_CODE.test(code))) return callErrors.authRequired([], detail);
  if (name === "RateLimitError" || (typeof code === "string" && USAGE_LIMIT_CODE.test(code))) return callErrors.usageLimit(null, detail);
  if (name === "AgentNotFoundError" || code === "agent_not_found") return callErrors.notFound({ resource: "Cursor agent", message: detail });
  if (name === "AgentBusyError" || /already has active run/i.test(message)) return callErrors.invalidState("previous_turn_active", detail);
  if (name === "NetworkError" || (typeof code === "string" && TRANSPORT_CODE.test(code))) return callErrors.transport(detail);
  if (name === "ConfigurationError" || name === "UnsupportedRunOperationError") return callErrors.validation([{ message }], detail);
  return callErrors.protocol(typeof code === "string" ? code : "cursor_sdk_error", detail);
}

// ---------------------------------------------------------------------------
// Tool calls

function record(value: unknown): { [key: string]: unknown } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { [key: string]: unknown }) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A tool result: Cursor's `{ status: "success", value } | { status: "error", error }` (tool-call-types.d.ts `ResultSchema`). */
export function toolOutcome(result: unknown): { ok: true; value: unknown } | { ok: false; message: string } | undefined {
  const parsed = record(result);
  if (parsed === undefined) return undefined;
  if (parsed["status"] === "success") return { ok: true, value: parsed["value"] };
  if (parsed["status"] === "error") {
    const error = parsed["error"];
    const message = text(record(error)?.["message"]) ?? text(error) ?? JSON.stringify(error ?? null);
    return { ok: false, message };
  }
  return undefined;
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** The item kind of a Cursor tool, by the `name` of its stream event (the tool call's `type`). */
export function toolKind(name: string): ItemKind {
  switch (name) {
    case "shell":
      return "command_execution";
    case "read":
      return "file_read";
    case "edit":
    case "write":
    case "delete":
      return "file_change";
    case "glob":
    case "grep":
    case "ls":
    case "semSearch":
      return "file_search";
    case "mcp":
      return "mcp_tool_call";
    case "createPlan":
      return "proposed_plan";
    case "updateTodos":
      return "todo_list";
    case "task":
      return "subagent_spawn";
    default:
      return "tool_call";
  }
}

const TODO_STATUSES: { readonly [status: string]: TodoEntry["status"] } = { pending: "pending", inProgress: "in_progress", completed: "completed", cancelled: "cancelled" };

/** Cursor's todos (`UpdateTodosArgs.todos`, statuses pending, inProgress, completed, cancelled). */
export function todosOf(value: unknown): TodoEntry[] | undefined {
  const todos = record(value)?.["todos"];
  if (!Array.isArray(todos)) return undefined;
  return todos.flatMap((todo) => {
    const content = text(record(todo)?.["content"]);
    const status = text(record(todo)?.["status"]);
    return content === undefined ? [] : [{ text: content, status: (status === undefined ? undefined : TODO_STATUSES[status]) ?? status ?? "pending" }];
  });
}

interface ToolFields {
  title?: string;
  command?: string[];
  cwd?: string;
  paths?: string[];
  query?: string;
  changes?: FileChange[];
}

/** What a tool's arguments say about it, as ARI item fields. Cursor's argument shapes are not stable, so every field is read defensively. */
function toolFields(name: string, args: unknown): ToolFields {
  const parsed = record(args) ?? {};
  const path = text(parsed["path"]);
  switch (name) {
    case "shell": {
      const command = text(parsed["command"]);
      const cwd = text(parsed["workingDirectory"]);
      return { ...(command === undefined ? {} : { command: [command], title: command }), ...(cwd === undefined ? {} : { cwd }) };
    }
    case "read":
    case "ls":
      return path === undefined ? {} : { paths: [path], title: path };
    case "edit":
    case "write":
    case "delete":
      return path === undefined ? {} : { paths: [path], title: path, changes: [{ kind: name === "write" ? "add" : name === "delete" ? "delete" : "modify", path }] };
    case "glob": {
      const pattern = text(parsed["globPattern"]) ?? text(parsed["pattern"]);
      const directory = text(parsed["targetDirectory"]) ?? path;
      return { ...(pattern === undefined ? {} : { query: pattern, title: pattern }), ...(directory === undefined ? {} : { paths: [directory] }) };
    }
    case "grep": {
      const pattern = text(parsed["pattern"]);
      return { ...(pattern === undefined ? {} : { query: pattern, title: pattern }), ...(path === undefined ? {} : { paths: [path] }) };
    }
    case "semSearch": {
      const query = text(parsed["query"]);
      return query === undefined ? {} : { query, title: query };
    }
    case "mcp": {
      const tool = text(parsed["toolName"]);
      return tool === undefined ? {} : { title: tool };
    }
    case "task": {
      const description = text(parsed["description"]);
      return description === undefined ? {} : { title: description };
    }
    default:
      return { title: name };
  }
}

/** The text a successful tool produced, by tool. */
function toolOutput(name: string, value: unknown): { output?: string; exitCode?: number; diff?: string } {
  const parsed = record(value);
  switch (name) {
    case "shell": {
      const stdout = text(parsed?.["stdout"]) ?? "";
      const stderr = text(parsed?.["stderr"]) ?? "";
      const exitCode = parsed?.["exitCode"];
      return { output: stderr === "" ? stdout : stdout === "" ? stderr : `${stdout}\n${stderr}`, ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}) };
    }
    case "read":
      return { output: text(parsed?.["content"]) ?? "" };
    case "edit": {
      const diff = text(parsed?.["diffString"]);
      return diff === undefined ? {} : { diff };
    }
    case "write":
    case "delete":
      return {};
    case "mcp": {
      const content = parsed?.["content"];
      const parts = Array.isArray(content) ? content.flatMap((part) => text(record(record(part)?.["text"])?.["text"]) ?? []) : [];
      return { output: parts.join("\n") };
    }
    default: {
      const output = stringify(value);
      return output === undefined ? {} : { output };
    }
  }
}

// ---------------------------------------------------------------------------
// The fold

/** Where the fold's results go: the session emits them as events. */
export interface FoldSink {
  /** An item opens (`opening`, with every required field) or changes. */
  item(patch: ItemPatch, opening: boolean): void;
  delta(itemId: string, field: "text" | "reasoning" | "plan", chunk: string): void;
  subagent(patch: SubagentPatch): void;
  plan(patch: PlanPatch): void;
  usage(usage: UsageSnapshot): void;
}

export interface RunFoldOptions {
  readonly threadId: string;
  readonly turnId: string;
  readonly planId: string;
  /** False when the session was opened with `emitDiffs: false`. */
  readonly emitDiffs: boolean;
  readonly maxToolOutputBytes?: number;
  readonly maxDiffBytes?: number;
  readonly model?: string;
  readonly now: () => string;
}

interface Segment {
  readonly kind: "assistant_message" | "reasoning";
  readonly itemId: string;
}

interface ToolState {
  readonly itemId: string;
  readonly name: string;
  plan: string;
  todos: string;
  readonly subagentId: string | undefined;
}

type SettledStatus = "completed" | "failed" | "interrupted" | "cancelled";

/**
 * Folds one Cursor run into ARI events. The prompt is item 0, opened by the
 * session when it sends the prompt (Cursor sends no update for it); every
 * other item takes the next ordinal when its first update arrives. A text or
 * thinking segment ends at the step's end (`step-completed`), at the turn's
 * end, or when an update of another kind arrives. Nothing here settles the
 * turn: only `run.wait()` does.
 */
export class RunFold {
  readonly #options: RunFoldOptions;
  readonly #sink: FoldSink;
  #nextOrdinal = 1;
  #segment: Segment | undefined;
  readonly #tools = new Map<string, ToolState>();
  readonly #open = new Set<string>();
  readonly #subagents = new Map<string, SubagentStatus>();

  constructor(options: RunFoldOptions, sink: FoldSink) {
    this.#options = options;
    this.#sink = sink;
  }

  /** Opens the prompt as item 0, completed: the host's own words, without any instructions the driver put before them. */
  prompt(textOfPrompt: string): string {
    const native = itemNative(0, "user");
    const id = itemIdFor(this.#options.turnId, native);
    this.#sink.item({ id, kind: "user_message", native, status: "completed", turnId: this.#options.turnId, text: textOfPrompt, startedAt: this.#options.now(), completedAt: this.#options.now() }, true);
    return id;
  }

  consume(update: CursorInteractionUpdate): void {
    switch (update.type) {
      case "user-message-appended": {
        // Cursor appends a user message to a running turn when a steer is delivered.
        this.#closeSegment("completed");
        const native = itemNative(this.#take(), "user");
        const id = itemIdFor(this.#options.turnId, native);
        this.#sink.item({ id, kind: "user_message", native, status: "completed", turnId: this.#options.turnId, text: update.userMessage.text, startedAt: this.#options.now(), completedAt: this.#options.now() }, true);
        return;
      }
      case "text-delta":
        if (update.text !== "") this.#streamInto("assistant_message", "text", update.text);
        return;
      case "thinking-delta":
        if (update.text !== "") this.#streamInto("reasoning", "reasoning", update.text);
        return;
      case "thinking-completed":
        if (this.#segment?.kind === "reasoning") this.#closeSegment("completed");
        return;
      case "tool-call-started":
      case "partial-tool-call":
        this.#onTool(update.callId, update.toolCall, false);
        return;
      case "tool-call-completed":
        this.#onTool(update.callId, update.toolCall, true);
        return;
      case "step-completed":
        this.#closeSegment("completed");
        return;
      case "turn-ended":
        this.#closeSegment("completed");
        if (update.usage !== undefined) this.#sink.usage(usageSnapshot(update.usage, this.#options.model));
        return;
      default:
        return;
    }
  }

  /** Settles everything the run left open, with the turn's own status. Background subagents ended with the run. */
  finish(status: SettledStatus): void {
    this.#closeSegment(status);
    for (const itemId of this.#open) this.#sink.item({ id: itemId, status, completedAt: this.#options.now() }, false);
    this.#open.clear();
    for (const [id, current] of this.#subagents) {
      if (current !== "running") continue;
      const settled: SubagentStatus = status === "completed" ? "completed" : status;
      this.#subagents.set(id, settled);
      this.#sink.subagent({ id, status: settled, completedAt: this.#options.now(), outcome: { status: settled } });
    }
  }

  #take(): number {
    const ordinal = this.#nextOrdinal;
    this.#nextOrdinal += 1;
    return ordinal;
  }

  #streamInto(kind: Segment["kind"], field: "text" | "reasoning", chunk: string): void {
    if (this.#segment?.kind !== kind) {
      this.#closeSegment("completed");
      const native = itemNative(this.#take(), kind === "assistant_message" ? "assistant" : "reasoning");
      const itemId = itemIdFor(this.#options.turnId, native);
      this.#segment = { kind, itemId };
      this.#open.add(itemId);
      this.#sink.item({ id: itemId, kind, native, status: "running", turnId: this.#options.turnId, startedAt: this.#options.now() }, true);
    }
    this.#sink.delta(this.#segment.itemId, field, chunk);
  }

  #closeSegment(status: ItemStatus): void {
    const segment = this.#segment;
    if (segment === undefined) return;
    this.#segment = undefined;
    this.#open.delete(segment.itemId);
    this.#sink.item({ id: segment.itemId, status, completedAt: this.#options.now() }, false);
  }

  #onTool(callId: string, call: CursorToolCall, finished: boolean): void {
    let tool = this.#tools.get(callId);
    const name = call.type;
    const kind = toolKind(name);
    if (tool === undefined) {
      // A tool's first update may be a partial one, while the model still writes its arguments.
      this.#closeSegment("completed");
      const ordinal = this.#take();
      const native = itemNative(ordinal, `tool:${name}`, callId);
      const itemId = itemIdFor(this.#options.turnId, native);
      const subagentId = name === "task" ? subagentIdFor(this.#options.turnId, itemNative(ordinal, "task", text(record(call.args)?.["agentId"]) ?? null)) : undefined;
      tool = { itemId, name, plan: "", todos: "", subagentId };
      this.#tools.set(callId, tool);
      this.#open.add(itemId);
      this.#sink.item(
        {
          id: itemId,
          kind,
          native,
          status: "running",
          turnId: this.#options.turnId,
          startedAt: this.#options.now(),
          ...toolFields(name, call.args),
          ...(kind === "tool_call" || kind === "mcp_tool_call" ? { tool: this.#invocation(name, call.args, undefined) } : {}),
          ...(subagentId === undefined ? {} : { subagentId }),
        },
        true,
      );
      if (subagentId !== undefined) this.#openSubagent(subagentId, itemId, ordinal, call.args);
    } else if (!finished && kind !== "proposed_plan" && kind !== "todo_list") {
      // A later update repeats the arguments, which grow while the model writes them.
      this.#sink.item({ id: tool.itemId, ...toolFields(name, call.args), ...(kind === "tool_call" || kind === "mcp_tool_call" ? { tool: this.#invocation(name, call.args, undefined) } : {}) }, false);
    }
    if (name === "createPlan") this.#streamPlan(tool, text(record(call.args)?.["plan"]));
    if (name === "updateTodos") this.#updateTodos(tool, todosOf(call.args));
    if (finished) this.#finishTool(callId, tool, call);
  }

  #streamPlan(tool: ToolState, plan: string | undefined): void {
    if (plan === undefined || plan === tool.plan) return;
    if (plan.startsWith(tool.plan)) this.#sink.delta(tool.itemId, "plan", plan.slice(tool.plan.length));
    else this.#sink.item({ id: tool.itemId, plan }, false);
    tool.plan = plan;
  }

  #updateTodos(tool: ToolState, todos: TodoEntry[] | undefined): void {
    if (todos === undefined) return;
    const fingerprint = JSON.stringify(todos);
    if (fingerprint === tool.todos) return;
    tool.todos = fingerprint;
    this.#sink.item({ id: tool.itemId, todos }, false);
    const entries: PlanEntry[] = todos.map((todo) => ({ text: todo.text, status: todo.status }));
    this.#sink.plan({ id: this.#options.planId, threadId: this.#options.threadId, turnId: this.#options.turnId, entries, updatedAt: this.#options.now() });
  }

  #finishTool(callId: string, tool: ToolState, call: CursorToolCall): void {
    this.#tools.delete(callId);
    this.#open.delete(tool.itemId);
    const outcome = toolOutcome(call.result);
    const patch: ItemPatch = { id: tool.itemId, status: outcome?.ok === false ? "failed" : "completed", completedAt: this.#options.now() };
    if (outcome?.ok === false) patch.error = { message: outcome.message };
    if (outcome?.ok === true) {
      if (tool.name === "updateTodos") this.#updateTodos(tool, todosOf(outcome.value));
      const produced = toolOutput(tool.name, outcome.value);
      if (produced.output !== undefined) {
        const capped = this.#capped(produced.output, this.#options.maxToolOutputBytes);
        patch.output = capped.text;
        if (capped.truncated) patch.truncated = true;
      }
      if (produced.exitCode !== undefined) patch.exitCode = produced.exitCode;
      if (produced.diff !== undefined && this.#options.emitDiffs) {
        const capped = this.#capped(produced.diff, this.#options.maxDiffBytes);
        patch.changes = (toolFields(tool.name, call.args).changes ?? []).map((change) => ({ ...change, diff: capped.text }));
        if (capped.truncated) patch.truncated = true;
      }
    }
    const kind = toolKind(tool.name);
    if (kind === "tool_call" || kind === "mcp_tool_call") patch.tool = this.#invocation(tool.name, call.args, call.result);
    this.#sink.item(patch, false);
    if (tool.subagentId !== undefined) this.#finishSubagent(tool.subagentId, outcome);
  }

  #invocation(name: string, args: unknown, result: unknown): NonNullable<ItemPatch["tool"]> {
    if (name === "mcp") {
      const parsed = record(args) ?? {};
      const server = text(parsed["providerIdentifier"]);
      return { ...(server === undefined ? {} : { server }), name: text(parsed["toolName"]) ?? "mcp", input: parsed["args"] ?? null, ...(result === undefined ? {} : { result }) };
    }
    return { name, input: args ?? null, ...(result === undefined ? {} : { result }) };
  }

  #openSubagent(subagentId: string, itemId: string, ordinal: number, args: unknown): void {
    const parsed = record(args) ?? {};
    const name = text(record(parsed["subagentType"])?.["name"]) ?? text(parsed["description"]);
    const prompt = text(parsed["prompt"]);
    this.#subagents.set(subagentId, "running");
    this.#sink.subagent({
      id: subagentId,
      native: itemNative(ordinal, "task", text(parsed["agentId"]) ?? null),
      parentThreadId: this.#options.threadId,
      status: "running",
      parentTurnId: this.#options.turnId,
      parentItemId: itemId,
      ...(name === undefined ? {} : { name }),
      ...(prompt === undefined ? {} : { prompt }),
      startedAt: this.#options.now(),
    });
  }

  #finishSubagent(subagentId: string, outcome: ReturnType<typeof toolOutcome>): void {
    if (outcome?.ok === false) {
      this.#subagents.set(subagentId, "failed");
      this.#sink.subagent({ id: subagentId, status: "failed", completedAt: this.#options.now(), outcome: { status: "failed", failure: { class: "provider_error", message: outcome.message, retryable: false } } });
      return;
    }
    // A background subagent keeps running after its task call returns; its result comes back later in the same run.
    if (record(outcome?.value)?.["isBackground"] === true) return;
    this.#subagents.set(subagentId, "completed");
    this.#sink.subagent({ id: subagentId, status: "completed", completedAt: this.#options.now(), outcome: { status: "completed" } });
  }

  #capped(value: string, limit: number | undefined): { text: string; truncated: boolean } {
    return limit === undefined ? { text: value, truncated: false } : truncateUtf8(value, limit);
  }
}

/** A Cursor turn's token usage as an ARI usage snapshot. The total is the SDK's own: input plus output (dist/esm/index.js, usage-types). */
export function usageSnapshot(usage: CursorTurnUsage, model: string | undefined): UsageSnapshot {
  return {
    scope: "turn",
    ...(model === undefined ? {} : { model }),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cacheReadTokens,
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    totalTokens: usage.inputTokens + usage.outputTokens,
  };
}
