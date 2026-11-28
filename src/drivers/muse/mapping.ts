// Pure translations between the Muse Session Protocol (MSP) and ARI: ids,
// items, approval options, questions, failures, usage and limits. Nothing here
// talks to a process.
//
// Muse's identifiers are strong: the session id (a UUIDv7 the driver mints and
// sends on `session/start`), the turn id (the `commandId` of the `turn/start`
// that minted it), the item id, the approval id and the user-input id. Every
// ARI id is derived from them with the driver kit's `deriveId`.

import { deriveId } from "../../driver-kit/ids.ts";
import type { NativeRef } from "../../generated/common.ts";
import type { RuntimePolicy } from "../../generated/config.ts";
import type { Failure } from "../../generated/errors.ts";
import type { Item } from "../../generated/item.ts";
import type { Question, Request, RequestOption } from "../../generated/request.ts";
import type { LimitStatus, LimitWindow, UsageSnapshot } from "../../generated/usage.ts";
import type {
  MuseApprovalChoice,
  MuseApprovalMode,
  MuseApprovalRequest,
  MuseItem,
  MuseSubscriptionUsage,
  MuseTokenUsage,
  MuseTurnCompleted,
  MuseUserInputQuestion,
  MuseUserInputRequest,
} from "./sdk.ts";

/** Bumped when the driver changes how it derives ids. */
export const MUSE_IDENTITY_VERSION = 1;

export function strongRef(id: string): NativeRef {
  return { id, strength: "strong" };
}

/** A thread is one Muse session; its id comes from the session id alone, so any Session or instance resumes it under the same id. */
export function threadIdFor(nativeSessionId: string): string {
  return deriveId({ kind: "thread", native: strongRef(nativeSessionId), identityVersion: MUSE_IDENTITY_VERSION });
}

export function turnIdFor(threadId: string, nativeTurnId: string): string {
  return deriveId({ kind: "turn", native: strongRef(nativeTurnId), identityVersion: MUSE_IDENTITY_VERSION, scope: threadId });
}

export function itemIdFor(threadId: string, nativeItemId: string): string {
  return deriveId({ kind: "item", native: strongRef(nativeItemId), identityVersion: MUSE_IDENTITY_VERSION, scope: threadId });
}

/** Approvals and user-input prompts have their own ids; the prefix keeps the two id spaces apart. */
export function requestIdFor(threadId: string, kind: "approval" | "userInput", nativeId: string): string {
  return deriveId({ kind: "request", native: strongRef(`${kind}:${nativeId}`), identityVersion: MUSE_IDENTITY_VERSION, scope: threadId });
}

export function subagentIdFor(threadId: string, nativeSubagentId: string): string {
  return deriveId({ kind: "subagent", native: strongRef(nativeSubagentId), identityVersion: MUSE_IDENTITY_VERSION, scope: threadId });
}

/** Muse keeps one todo list per session and replaces it whole, so a thread has one plan. */
export function planIdFor(threadId: string): string {
  return deriveId({ kind: "plan", native: { id: null, strength: "none", ordinal: 0 }, identityVersion: MUSE_IDENTITY_VERSION, scope: threadId });
}

// Runtime policy.

/**
 * The two ARI runtime modes Muse has a native match for, as Muse's approval
 * mode, permission profile and `muse serve` flags. A policy without a mode
 * has none of them: Muse then applies the host configuration's own.
 */
export interface MusePolicy {
  readonly approvalMode?: MuseApprovalMode;
  readonly permissionProfile?: string;
  readonly serveArgs: readonly string[];
}

export const MUSE_SUPPORTED_MODES = ["approval_required", "full_access"] as const;

/**
 * `approval_required` asks for every action Muse's policy does not already
 * allow (`promptUnmatched`, profile `:ask-me`); `full_access` allows all
 * (`allowAll`, profile `:unrestricted`) and runs without Muse's sandbox. The
 * profiles are selected explicitly, so Muse's own default cannot put an AI
 * reviewer in front of the user's approvals.
 */
export function musePolicy(policy: RuntimePolicy): MusePolicy | undefined {
  if (policy.mode === undefined) return { serveArgs: [] };
  if (policy.mode === "approval_required") return { approvalMode: "promptUnmatched", permissionProfile: ":ask-me", serveArgs: [] };
  if (policy.mode === "full_access") return { approvalMode: "allowAll", permissionProfile: ":unrestricted", serveArgs: ["--disable-sandbox"] };
  return undefined;
}

// Items.

const SETTLED_ITEM_STATUS: { readonly [status: string]: Item["status"] } = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  rejected: "failed",
  timedOut: "failed",
};

/** MSP item status to ARI: anything but `inProgress` is terminal, and an unknown terminal is a failure. */
export function itemStatus(status: string): Item["status"] {
  if (status === "inProgress") return "running";
  return SETTLED_ITEM_STATUS[status] ?? "failed";
}

function parseArgs(args: string | undefined): { [key: string]: unknown } | undefined {
  if (args === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { [key: string]: unknown }) : undefined;
  } catch {
    // Model-authored arguments may be streamed or not quite JSON.
    return undefined;
  }
}

function stringArg(args: { [key: string]: unknown } | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** A path a tool named, as an absolute path in the thread's working directory. */
export function absolutePath(cwd: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  const trimmed = path.replace(/^\.\/+/, "");
  if (trimmed === "" || trimmed === ".") return cwd;
  return `${cwd.replace(/\/+$/, "")}/${trimmed}`;
}

export interface ItemContext {
  readonly threadId: string;
  readonly turnId: string | undefined;
  readonly cwd: string;
  /** The ARI subagent id for a `subagent` item's native subagent id. */
  readonly subagentId: (nativeSubagentId: string) => string;
}

/**
 * The ARI item for a Muse item at its current revision. Tool calls are
 * classified by tool name the way Muse names its tools: shell tools are
 * commands, read tools with a path are file reads, write and edit tools with a
 * path are file changes, web tools are web searches; any other tool is a
 * generic `tool_call`. Kinds ARI has no core kind for keep their Muse data as
 * `x:muse.<kind>`.
 */
export function itemFromMuse(item: MuseItem, context: ItemContext): Item {
  const base: Item = {
    id: itemIdFor(context.threadId, item.itemId),
    kind: "tool_call",
    native: strongRef(item.itemId),
    status: itemStatus(item.status),
    ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
    ...(item.truncated === true ? { truncated: true } : {}),
  };
  const failed = item.failureReason === undefined || base.status !== "failed" ? {} : { error: { message: item.failureReason } };
  switch (item.kind) {
    case "userMessage":
      return { ...base, kind: "user_message", text: item.text ?? "" };
    case "agentMessage":
      return { ...base, kind: "assistant_message", text: item.text ?? "" };
    case "reasoning": {
      const summary = (item.summary ?? []).join("\n\n");
      return { ...base, kind: "reasoning", reasoning: summary === "" ? (item.text ?? "") : summary };
    }
    case "userShell":
      return {
        ...base,
        kind: "command_execution",
        command: [item.commandText ?? ""],
        cwd: context.cwd,
        output: item.visibleOutput ?? "",
        ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
        ...failed,
      };
    case "subagent":
      return {
        ...base,
        kind: "subagent_spawn",
        ...(item.subagentId === undefined ? {} : { subagentId: context.subagentId(item.subagentId) }),
        ...(item.objective === undefined ? {} : { text: item.objective }),
        ...failed,
      };
    case "compaction":
      return { ...base, kind: "compaction", ...(item.outcome === undefined ? {} : { text: item.outcome }) };
    case "systemNotice":
      return { ...base, kind: "system_notice", text: item.text ?? item.fallbackText ?? "" };
    case "toolCall":
      return { ...base, ...toolItem(item, context.cwd), ...failed };
    default:
      return {
        ...base,
        kind: `x:muse.${item.kind}`,
        data: item as unknown as Item["data"],
        fallback: { title: item.kind, ...(item.fallbackText === undefined ? {} : { text: item.fallbackText }) },
      };
  }
}

function toolItem(item: MuseItem, cwd: string): Partial<Item> {
  const name = item.tool ?? "tool";
  const args = parseArgs(item.args);
  const output = item.visibleOutput ?? "";
  if (/shell|bash|exec_command/i.test(name)) {
    const command = stringArg(args, "command", "cmd");
    return { kind: "command_execution", command: [command ?? item.args ?? ""], cwd, output, ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }) };
  }
  const path = stringArg(args, "file_path", "path", "filePath");
  if (path !== undefined && /write|edit|patch/i.test(name)) return { kind: "file_change", changes: [{ kind: "modify", path: absolutePath(cwd, path) }], output };
  if (path !== undefined && /read|list|view|cat/i.test(name)) return { kind: "file_read", paths: [absolutePath(cwd, path)], output };
  if (/web|browse|fetch/i.test(name)) {
    const query = stringArg(args, "query", "url", "pattern");
    return { kind: "web_search", ...(query === undefined ? {} : { query }), output };
  }
  return { kind: "tool_call", tool: { name, input: args ?? item.args ?? null }, output };
}

/** The ARI delta field for an MSP delta field path: `text`, `output` and `summary.<n>` (reasoning summary parts). */
export function deltaField(kind: string, field: string | undefined): "text" | "output" | "reasoning" | undefined {
  const path = field ?? "text";
  if (path === "output") return "output";
  if (path.startsWith("summary.")) return "reasoning";
  if (path === "text") return kind === "reasoning" ? "reasoning" : "text";
  return undefined;
}

// Approvals.

/**
 * The ARI decision and real reach of a Muse approval choice. A
 * `localPersistent` grant is saved in Muse's local policy store: a shell
 * command-prefix rule applies within the workspace root (`project`); the
 * driver cannot see how far another saved rule reaches, so it says `global`.
 */
export function choiceOption(choice: MuseApprovalChoice, subjectKind: string): RequestOption {
  const option = (decision: RequestOption["decision"], scope: RequestOption["scope"]): RequestOption => ({ optionId: choice.choiceId, label: choice.label, decision, scope });
  const persistent = subjectKind === "shell" ? "project" : "global";
  switch (choice.decision) {
    case "approved":
      return option("accept", "once");
    case "approvedForSession":
      return option("accept_for_session", "session");
    case "approvedPolicyAmendment":
      return option("accept_always", choice.scope === "session" ? "session" : persistent);
    case "denied":
      return option("decline", "once");
    case "deniedPolicyAmendment":
      return option("decline", choice.scope === "session" ? "session" : choice.scope === "once" ? "once" : persistent);
    case "abort":
      return option("cancel", "once");
    default:
      return { optionId: choice.choiceId, label: choice.label, decision: "other", scope: choice.scope === "session" ? "session" : choice.scope === "once" ? "once" : persistent };
  }
}

/** The ARI request kind of a Muse approval subject. */
export function approvalKind(subject: MuseApprovalRequest["subject"]): Request["kind"] {
  if (subject.kind === "shell") return "command";
  if (subject.kind === "fileAccess") return subject.access === "read" ? "file_read" : "file_change";
  return "permission";
}

export function approvalSubject(approval: MuseApprovalRequest, cwd: string): NonNullable<Request["subject"]> {
  const subject = approval.subject;
  const input = parseArgs(approval.rawArgs) ?? approval.rawArgs;
  return {
    ...(subject.command === undefined ? {} : { command: [subject.command] }),
    ...(subject.workspaceRoot === undefined ? {} : { cwd: subject.workspaceRoot }),
    ...(subject.path === undefined ? {} : { paths: [absolutePath(cwd, subject.path)] }),
    tool: { name: subject.toolName ?? approval.toolName, input },
  };
}

// Questions.

export function questionFromMuse(question: MuseUserInputQuestion): Question {
  return {
    id: question.id,
    type: question.selection.mode === "multiple" ? "multi_select" : "single_select",
    prompt: question.question,
    ...(question.header === "" ? {} : { header: question.header }),
    // An answer selects an option by its exact label, so the label is the option id.
    options: question.options.map((option) => ({ id: option.label, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })),
    required: true,
    allowCustom: true,
  };
}

export function questionsFromMuse(request: MuseUserInputRequest): Question[] {
  return request.questions.map(questionFromMuse);
}

// Failures, usage and limits.

function isoFromMillis(ms: number): string | undefined {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The ARI failure for a failed `turn/completed`. A quota error is a usage limit with the provider's reset time. */
/** The failure of a turn Muse ended other than completed or cancelled: from its `turn/completed`, or from a `lastTurn`. */
export function failureFromMuse(completed: Pick<MuseTurnCompleted, "reason" | "error">): Failure {
  const error = completed.error;
  const message = error?.message ?? completed.reason ?? "Muse failed the turn.";
  if (error?.quota !== undefined) {
    const resetAt = isoFromMillis(error.quota.resetsAtMs);
    return { class: "usage_limit", message, code: error.quota.limitKind, retryable: true, ...(resetAt === undefined ? {} : { resetAt }) };
  }
  if (error === undefined) return { class: "provider_error", message, retryable: false };
  if (error.kind === "authRequired") return { class: "permission_error", message, code: error.kind, retryable: false };
  if (error.kind === "contextOverflow" || error.kind === "configError") return { class: "validation_error", message, code: error.kind, retryable: error.retryable };
  return { class: "provider_error", message, code: error.kind, retryable: error.retryable };
}

export function usageFromMuse(usage: MuseTokenUsage, scope: UsageSnapshot["scope"], model: string | undefined): UsageSnapshot {
  const cached = usage.cacheReadTokens ?? usage.cachedTokens;
  return {
    scope,
    ...(model === undefined ? {} : { model }),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: cached,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
  };
}

/** ARI limit windows for Muse's last-observed subscription usage. Muse reports percentages, which may exceed 100. */
export function limitsFromMuse(usage: MuseSubscriptionUsage): LimitStatus {
  const minutes = usage.window.windowDurationMins;
  const windowName: LimitWindow["window"] = minutes === 300 ? "5h" : minutes === 1440 ? "daily" : `x:muse.${minutes}m`;
  const windows: LimitWindow[] = [];
  const add = (window: LimitWindow["window"], usedPercent: number, resetsAtMs: number): void => {
    const resetsAt = isoFromMillis(resetsAtMs);
    windows.push({ window, utilization: Math.min(1, Math.max(0, usedPercent / 100)), ...(resetsAt === undefined ? {} : { resetsAt }) });
  };
  add(windowName, usage.window.usedPercent, usage.window.resetsAtMs);
  add("weekly", usage.weekly.usedPercent, usage.weekly.resetsAtMs);
  const limited = [
    { used: usage.window.usedPercent, resetsAtMs: usage.window.resetsAtMs },
    { used: usage.weekly.usedPercent, resetsAtMs: usage.weekly.resetsAtMs },
  ].filter((window) => window.used >= 100);
  const resetsAt = limited.length === 0 ? undefined : isoFromMillis(Math.max(...limited.map((window) => window.resetsAtMs)));
  return { windows, limited: limited.length > 0, ...(resetsAt === undefined ? {} : { resetsAt }) };
}
