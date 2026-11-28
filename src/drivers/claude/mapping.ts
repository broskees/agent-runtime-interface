// Pure translations between the Claude Agent SDK's shapes and ARI's: ids,
// permission modes, tool items, approval options, failures, limits, usage and
// MCP server configs. Nothing here touches the SDK or the host.

import { deriveId } from "../../driver-kit/ids.ts";
import type { NativeRef } from "../../generated/common.ts";
import type { EffectiveMode, RuntimePolicy } from "../../generated/config.ts";
import type { Failure } from "../../generated/errors.ts";
import type { FileChange, ItemKind, ItemPatch, TodoEntry } from "../../generated/item.ts";
import type { Question, RequestKind, RequestOption } from "../../generated/request.ts";
import type { McpServerConfig } from "../../generated/session.ts";
import type { LimitStatus, LimitWindow, UsageSnapshot } from "../../generated/usage.ts";
import type {
  ClaudeMcpServerConfig,
  ClaudePermissionDestination,
  ClaudePermissionMode,
  ClaudePermissionResult,
  ClaudePermissionUpdate,
  ClaudeRateLimitInfo,
  ClaudeResultMessage,
} from "./sdk.ts";

/** Bumped when the driver changes how it derives ids. */
export const CLAUDE_IDENTITY_VERSION = 1;

export function strongRef(id: string): NativeRef {
  return { id, strength: "strong" };
}

/** A thread's id: its Claude session id. */
export function threadIdFor(sessionId: string): string {
  return deriveId({ kind: "thread", native: strongRef(sessionId), identityVersion: CLAUDE_IDENTITY_VERSION });
}

/** A turn the host started: the uuid of the prompt the driver sent, which the transcript keeps. */
export function turnIdFor(threadId: string, promptUuid: string): string {
  return deriveId({ kind: "turn", native: strongRef(promptUuid), identityVersion: CLAUDE_IDENTITY_VERSION, scope: threadId });
}

/** A turn Claude started on its own (for example after a background task finished): no prompt of ours, so an ordinal. */
export function providerTurnRef(ordinal: number, firstFrameUuid: string): NativeRef {
  return { id: null, strength: "weak", ordinal, fingerprint: firstFrameUuid };
}

export function providerTurnIdFor(threadId: string, native: NativeRef): string {
  return deriveId({ kind: "turn", native, identityVersion: CLAUDE_IDENTITY_VERSION, scope: threadId });
}

/** An item: a tool_use id, or an assistant message id plus the block's index in it. */
export function itemIdFor(threadId: string, nativeId: string): string {
  return deriveId({ kind: "item", native: strongRef(nativeId), identityVersion: CLAUDE_IDENTITY_VERSION, scope: threadId });
}

/** The user message the driver sent for a turn. */
export function promptItemIdFor(threadId: string, promptUuid: string): string {
  return itemIdFor(threadId, `prompt:${promptUuid}`);
}

export function requestIdFor(threadId: string, requestId: string): string {
  return deriveId({ kind: "request", native: strongRef(requestId), identityVersion: CLAUDE_IDENTITY_VERSION, scope: threadId });
}

export function taskIdFor(threadId: string, taskId: string): string {
  return deriveId({ kind: "task", native: strongRef(taskId), identityVersion: CLAUDE_IDENTITY_VERSION, scope: threadId });
}

export function subagentIdFor(threadId: string, taskId: string): string {
  return deriveId({ kind: "subagent", native: strongRef(taskId), identityVersion: CLAUDE_IDENTITY_VERSION, scope: threadId });
}

// Policy.

/**
 * The Claude Code permission mode for an ARI policy. Plan interaction wins
 * over the runtime mode. Undefined when the policy names no mode and no plan:
 * the driver then sends none, and Claude Code starts in the mode the user's
 * settings give it (`permissions.defaultMode`, else its own default).
 */
export function permissionModeFor(policy: Pick<RuntimePolicy, "mode" | "interaction">): ClaudePermissionMode | undefined {
  if (policy.interaction === "plan") return "plan";
  if (policy.mode === undefined) return undefined;
  switch (policy.mode) {
    case "approval_required":
      return "default";
    case "auto_accept_edits":
      return "acceptEdits";
    case "auto":
      return "auto";
    case "full_access":
      return "bypassPermissions";
    default:
      return "default";
  }
}

/** A Claude Code permission mode in ARI terms: the inverse of `permissionModeFor`. `dontAsk` has no ARI mode and keeps its name. */
const ARI_MODES: { readonly [mode: string]: Pick<EffectiveMode, "mode" | "interaction"> } = {
  default: { mode: "approval_required", interaction: "default" },
  acceptEdits: { mode: "auto_accept_edits", interaction: "default" },
  auto: { mode: "auto", interaction: "default" },
  bypassPermissions: { mode: "full_access", interaction: "default" },
  dontAsk: { mode: "dontAsk", interaction: "default" },
  plan: { interaction: "plan" },
};

/**
 * The mode a thread runs in: what Claude Code last reported (`system/init`
 * at the start of each turn, or a `system/status` that carries one), else
 * the host's policy. Under the harness's own mode nothing is known until
 * Claude Code reports, except a plan interaction the driver asked for. Plan
 * mode has no runtime mode of its own; a host's mode stays the one it chose.
 */
export function effectiveModeFor(policy: Pick<RuntimePolicy, "mode" | "interaction">, reported: string | undefined): EffectiveMode {
  const source = policy.mode === undefined ? "harness" : "host";
  const hostMode = policy.mode === undefined ? {} : { mode: policy.mode };
  if (reported === undefined) {
    if (policy.mode !== undefined) return { ...hostMode, interaction: policy.interaction, source };
    return policy.interaction === "plan" ? { interaction: "plan", source } : { source };
  }
  const mapped = Object.hasOwn(ARI_MODES, reported) ? ARI_MODES[reported]! : { mode: reported };
  return { ...(mapped.mode === undefined ? hostMode : {}), ...mapped, source };
}

// Tools.

const FILE_CHANGE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/** `mcp__<server>__<tool>`: the server and tool names. */
export function mcpToolParts(name: string): { server: string; tool: string } {
  const rest = name.slice("mcp__".length);
  const split = rest.indexOf("__");
  return split < 0 ? { server: rest, tool: "" } : { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

export function toolItemKind(name: string): ItemKind {
  if (name === "Bash" || name === "PowerShell") return "command_execution";
  if (name === "Read") return "file_read";
  if (FILE_CHANGE_TOOLS.has(name)) return "file_change";
  if (name === "Glob" || name === "Grep") return "file_search";
  if (name === "WebSearch") return "web_search";
  if (name === "TodoWrite") return "todo_list";
  if (name === "ExitPlanMode") return "proposed_plan";
  if (name === "Agent" || name === "Task") return "subagent_spawn";
  if (isMcpTool(name)) return "mcp_tool_call";
  return "tool_call";
}

export function asRecord(value: unknown): { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { [key: string]: unknown }) : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Absolute paths stay; a relative one is joined to the thread's directory the way Claude Code resolves it. */
function absolute(path: string, cwd: string): string {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? path : `${cwd.replace(/\/+$/, "")}/${path}`;
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

/** The kind-specific fields of a tool item, from the tool's input. */
export function toolItemFields(name: string, input: unknown, cwd: string): Omit<ItemPatch, "id"> {
  const fields = asRecord(input);
  const kind = toolItemKind(name);
  const base: Omit<ItemPatch, "id"> = { kind, title: name, tool: { name, input: input as never } };
  switch (kind) {
    case "command_execution": {
      const command = asString(fields["command"]);
      return { ...base, ...(command === undefined ? {} : { command: [command] }), cwd };
    }
    case "file_read": {
      const path = asString(fields["file_path"]);
      return { ...base, ...(path === undefined ? {} : { paths: [absolute(path, cwd)] }) };
    }
    case "file_change": {
      const path = asString(fields["file_path"]) ?? asString(fields["notebook_path"]);
      if (path === undefined) return base;
      const change: FileChange = { kind: name === "Write" ? "add" : "modify", path: absolute(path, cwd) };
      return { ...base, paths: [change.path], changes: [change] };
    }
    case "file_search": {
      const pattern = asString(fields["pattern"]);
      const path = asString(fields["path"]);
      return { ...base, ...(pattern === undefined ? {} : { query: pattern }), ...(path === undefined ? {} : { paths: [absolute(path, cwd)] }) };
    }
    case "web_search": {
      const query = asString(fields["query"]);
      return { ...base, ...(query === undefined ? {} : { query }) };
    }
    case "todo_list": {
      const todos = Array.isArray(fields["todos"]) ? fields["todos"] : [];
      const entries: TodoEntry[] = todos.flatMap((entry) => {
        const todo = asRecord(entry);
        const content = asString(todo["content"]);
        if (content === undefined) return [];
        const status = asString(todo["status"]);
        return [{ text: content, status: status !== undefined && TODO_STATUSES.has(status) ? status : "pending" } as TodoEntry];
      });
      return { ...base, todos: entries };
    }
    case "proposed_plan": {
      const plan = asString(fields["plan"]);
      return { ...base, ...(plan === undefined ? {} : { plan }) };
    }
    case "mcp_tool_call": {
      const parts = mcpToolParts(name);
      return { ...base, title: `${parts.server}: ${parts.tool}`, tool: { server: parts.server, name: parts.tool, input: input as never } };
    }
    default:
      return base;
  }
}

/** The text of a tool_result's content: a string, or the text blocks joined. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const item = asRecord(block);
      return item["type"] === "text" && typeof item["text"] === "string" ? item["text"] : "";
    })
    .join("");
}

// Requests.

export function requestKindFor(toolName: string): RequestKind {
  if (toolName === "AskUserQuestion") return "user_input";
  const kind = toolItemKind(toolName);
  if (kind === "command_execution") return "command";
  if (kind === "file_change") return "file_change";
  if (kind === "file_read" || kind === "file_search") return "file_read";
  return "permission";
}

/** What reach a suggestion's destination really has. */
export function scopeOfDestination(destination: ClaudePermissionDestination): "session" | "project" | "global" {
  switch (destination) {
    case "session":
    case "cliArg":
      return "session";
    case "localSettings":
    case "projectSettings":
      return "project";
    default:
      return "global";
  }
}

const DESTINATION_ORDER: readonly ClaudePermissionDestination[] = ["session", "cliArg", "localSettings", "projectSettings", "userSettings"];

const DESTINATION_LABELS: { readonly [destination in ClaudePermissionDestination]: string } = {
  session: "Allow for this session",
  cliArg: "Allow for this session",
  localSettings: "Always allow in this project, on this machine",
  projectSettings: "Always allow in this project, for everyone using its settings",
  userSettings: "Always allow, in every project",
};

/** The native option ids: Claude's answers have no ids, so each is named after the answer it sends. */
export const CLAUDE_OPTION_ALLOW = "allow";
export const CLAUDE_OPTION_DENY = "deny";
export const CLAUDE_OPTION_DENY_INTERRUPT = "deny:interrupt";
export function allowWithRulesOptionId(destination: ClaudePermissionDestination): string {
  return `allow:${destination}`;
}

/** One answer an approval can get: the option the host sees and the permission result Claude gets. */
export interface ClaudeApprovalAnswer {
  readonly option: RequestOption;
  answer(feedback: string | undefined): ClaudePermissionResult;
}

/**
 * The options of a permission prompt. Claude offers allow, deny, and
 * `suggestions`: rule changes that stop the prompt coming back. The driver
 * groups the suggestions by where they persist; each group is one option
 * whose scope is that destination's real reach (session, project or every
 * project). `suppressAlwaysAllowRule` means no persistent choice may be
 * offered, so only session-scoped suggestions stay.
 */
export function approvalAnswers(suggestions: readonly ClaudePermissionUpdate[] | undefined, suppressAlwaysAllowRule: boolean): ClaudeApprovalAnswer[] {
  const answers: ClaudeApprovalAnswer[] = [
    {
      option: { optionId: CLAUDE_OPTION_ALLOW, label: "Allow once", decision: "accept", scope: "once" },
      answer: () => ({ behavior: "allow", decisionClassification: "user_temporary" }),
    },
  ];
  const byDestination = new Map<ClaudePermissionDestination, ClaudePermissionUpdate[]>();
  for (const suggestion of suggestions ?? []) {
    const scope = scopeOfDestination(suggestion.destination);
    if (suppressAlwaysAllowRule && scope !== "session") continue;
    const group = byDestination.get(suggestion.destination) ?? [];
    group.push(suggestion);
    byDestination.set(suggestion.destination, group);
  }
  for (const destination of DESTINATION_ORDER) {
    const group = byDestination.get(destination);
    if (group === undefined) continue;
    const scope = scopeOfDestination(destination);
    answers.push({
      option: { optionId: allowWithRulesOptionId(destination), label: DESTINATION_LABELS[destination], decision: scope === "session" ? "accept_for_session" : "accept_always", scope },
      answer: () => ({ behavior: "allow", updatedPermissions: group.map((update) => structuredClone(update)), decisionClassification: scope === "session" ? "user_temporary" : "user_permanent" }),
    });
  }
  answers.push(
    {
      option: { optionId: CLAUDE_OPTION_DENY, label: "Deny", decision: "decline" },
      answer: (feedback) => ({ behavior: "deny", message: feedback ?? "The user denied this tool call.", decisionClassification: "user_reject" }),
    },
    {
      option: { optionId: CLAUDE_OPTION_DENY_INTERRUPT, label: "Deny and stop", decision: "cancel" },
      answer: (feedback) => ({ behavior: "deny", message: feedback ?? "The user denied this tool call and stopped the turn.", interrupt: true, decisionClassification: "user_reject" }),
    },
  );
  return answers;
}

/** The questions of an AskUserQuestion call. Question ids are their positions; option ids are the labels Claude expects back. */
export function questionsFrom(input: unknown): Question[] {
  const questions = Array.isArray(asRecord(input)["questions"]) ? (asRecord(input)["questions"] as unknown[]) : [];
  return questions.map((entry, index) => {
    const question = asRecord(entry);
    const options = Array.isArray(question["options"]) ? (question["options"] as unknown[]) : [];
    return {
      id: `q${index}`,
      type: question["multiSelect"] === true ? "multi_select" : "single_select",
      prompt: asString(question["question"]) ?? "",
      ...(asString(question["header"]) === undefined ? {} : { header: asString(question["header"])! }),
      options: options.map((option) => {
        const label = asString(asRecord(option)["label"]) ?? "";
        const description = asString(asRecord(option)["description"]);
        return { id: label, label, ...(description === undefined ? {} : { description }) };
      }),
      required: true,
      allowCustom: true,
    };
  });
}

// Failures, limits and usage.

/** Assistant message errors (`SDKAssistantMessageError`) that mean the account cannot be used. */
const AUTH_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error", "cloud_credential_error"]);
const VALIDATION_ERRORS = new Set(["invalid_request", "model_not_found", "max_output_tokens"]);

/** Claude Code's usage-limit messages (`USAGE_LIMIT_ERROR_PREFIXES` in the SDK). */
const USAGE_LIMIT_PREFIXES = ["You've hit your", "You've reached your", "You're out of usage credits", "Your org is out of usage", "You're out of extra usage"];

export function isoFromEpochSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export interface TurnFailureEvidence {
  /** The `error` of the turn's last assistant message, if any. */
  readonly assistantError?: string | undefined;
  /** The text of that message. */
  readonly assistantText?: string | undefined;
  /** The latest `rejected` rate limit seen during the turn. */
  readonly rejectedLimit?: ClaudeRateLimitInfo | undefined;
}

/** True when a result ended the turn by Stop or a steer, not by completing or failing. */
export function isAbortedResult(result: ClaudeResultMessage): boolean {
  if (result.terminal_reason === "aborted_streaming" || result.terminal_reason === "aborted_tools") return true;
  return result.subtype !== "success" && (result.errors ?? []).some((error) => /interrupt|abort/i.test(error));
}

/** The failure a result reports, or undefined when the turn completed. */
export function failureFromResult(result: ClaudeResultMessage, evidence: TurnFailureEvidence): Failure | undefined {
  const failed = result.is_error || result.subtype !== "success";
  if (!failed && evidence.rejectedLimit === undefined) return undefined;
  const message =
    (result.subtype === "success" ? result.result : (result.errors ?? []).join("\n")) || evidence.assistantText || `Claude Code ended the turn with ${result.subtype}`;
  const limited =
    evidence.rejectedLimit !== undefined ||
    evidence.assistantError === "rate_limit" ||
    result.api_error_status === 429 ||
    USAGE_LIMIT_PREFIXES.some((prefix) => message.startsWith(prefix) || (evidence.assistantText ?? "").startsWith(prefix));
  if (limited) {
    const resetsAt = evidence.rejectedLimit?.resetsAt;
    return {
      class: "usage_limit",
      message,
      code: evidence.assistantError ?? "rate_limit",
      retryable: true,
      ...(resetsAt === undefined ? {} : { resetAt: isoFromEpochSeconds(resetsAt) }),
    };
  }
  if ((evidence.assistantError !== undefined && AUTH_ERRORS.has(evidence.assistantError)) || result.api_error_status === 401 || result.api_error_status === 403) {
    return { class: "permission_error", message, code: evidence.assistantError ?? `http_${String(result.api_error_status)}`, retryable: false };
  }
  if (evidence.assistantError !== undefined && VALIDATION_ERRORS.has(evidence.assistantError)) {
    return { class: "validation_error", message, code: evidence.assistantError, retryable: false };
  }
  const code = evidence.assistantError ?? result.terminal_reason ?? result.subtype;
  return { class: "provider_error", message, code, retryable: evidence.assistantError === "overloaded" || evidence.assistantError === "server_error" };
}

/** True when a failure came from the account's credentials. */
export function isAuthFailure(failure: Failure | undefined): boolean {
  return failure?.class === "permission_error";
}

const LIMIT_WINDOWS: { readonly [type: string]: LimitWindow["window"] } = {
  five_hour: "5h",
  seven_day: "weekly",
  seven_day_opus: "x:claude.seven_day_opus",
  seven_day_sonnet: "x:claude.seven_day_sonnet",
  seven_day_overage_included: "x:claude.seven_day_overage_included",
  overage: "credits",
};

/** One window's latest state, as the instance keeps it. */
export interface ClaudeLimitWindowState {
  readonly window: LimitWindow;
  readonly rejected: boolean;
}

/** A rate limit event (`SDKRateLimitInfo`) as one window's state. */
export function limitWindowFrom(info: ClaudeRateLimitInfo): ClaudeLimitWindowState {
  const window = LIMIT_WINDOWS[info.rateLimitType ?? "five_hour"] ?? `x:claude.${info.rateLimitType ?? "unknown"}`;
  return {
    window: {
      window,
      ...(info.utilization === undefined ? {} : { utilization: info.utilization }),
      ...(info.resetsAt === undefined ? {} : { resetsAt: isoFromEpochSeconds(info.resetsAt) }),
    },
    rejected: info.status === "rejected",
  };
}

/** The limit status of every window seen: limited while any is rejected, resetting when the last rejected one resets. */
export function limitStatusFrom(windows: Iterable<ClaudeLimitWindowState>): LimitStatus {
  const all = [...windows];
  const rejected = all.filter((state) => state.rejected);
  const resets = rejected.map((state) => state.window.resetsAt).filter((resetsAt): resetsAt is string => resetsAt !== undefined);
  const resetsAt = resets.length === 0 ? undefined : resets.reduce((latest, next) => (Date.parse(next) > Date.parse(latest) ? next : latest));
  return { windows: all.map((state) => state.window), limited: rejected.length > 0, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

export function usageFromResult(result: ClaudeResultMessage, model: string | undefined): UsageSnapshot {
  const cached = (result.usage.cache_read_input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0);
  return {
    scope: "turn",
    ...(model === undefined ? {} : { model }),
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    cachedInputTokens: cached,
    totalTokens: result.usage.input_tokens + result.usage.output_tokens + cached,
    costUsd: result.total_cost_usd,
  };
}

// MCP.

/**
 * An ARI MCP server as Claude Code's config. Claude Code's stdio config has
 * no working directory, so a stdio server that names one is refused rather
 * than started somewhere else.
 */
export function claudeMcpConfig(server: McpServerConfig, alwaysLoad: boolean): ClaudeMcpServerConfig {
  const load = alwaysLoad ? { alwaysLoad: true } : {};
  if (server.transport === "stdio") {
    if (server.command === undefined || server.command === "") throw new TypeError(`MCP server ${server.name} has no command`);
    if (server.cwd !== undefined) throw new TypeError(`MCP server ${server.name} sets a working directory, which Claude Code's stdio config cannot carry`);
    return { type: "stdio", command: server.command, ...(server.args === undefined ? {} : { args: [...server.args] }), ...(server.env === undefined ? {} : { env: { ...server.env } }), ...load };
  }
  if (server.transport === "http" || server.transport === "sse") {
    if (server.url === undefined || server.url === "") throw new TypeError(`MCP server ${server.name} has no url`);
    const headers = server.headers === undefined ? {} : { headers: { ...server.headers } };
    return server.transport === "http" ? { type: "http", url: server.url, ...headers, ...load } : { type: "sse", url: server.url, ...headers, ...load };
  }
  throw new TypeError(`MCP server ${server.name} uses transport ${server.transport}, which Claude Code does not support`);
}
