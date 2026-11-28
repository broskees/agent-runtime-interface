// Pure translations between the Codex app-server protocol and ARI: ids,
// items, approval options, runtime policy, failures, limits and usage. No
// state and no I/O, so each rule can be read and tested on its own.

import { deriveId } from "../../driver-kit/ids.ts";
import { truncateUtf8 } from "../../driver-kit/truncate.ts";
import type { ContentBlock, NativeRef } from "../../generated/common.ts";
import type { RuntimePolicy } from "../../generated/config.ts";
import type { Failure } from "../../generated/errors.ts";
import type { FileChange, Item, ItemStatus } from "../../generated/item.ts";
import type { ApprovalDecision, ApprovalScope, RequestOption } from "../../generated/request.ts";
import type { TurnStatus } from "../../generated/thread.ts";
import type { LimitStatus, LimitWindow, UsageSnapshot } from "../../generated/usage.ts";
import type {
  AskForApproval,
  ApprovalsReviewer,
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  RateLimitSnapshot,
  RateLimitWindow,
  SandboxMode,
  SandboxPolicy,
  ThreadItem,
  ThreadTokenUsage,
  TurnError,
  UserInput,
} from "./generated/protocol.ts";

/** Bumped when the way this driver derives ids changes. */
export const CODEX_IDENTITY_VERSION = 1;

function strong(id: string): NativeRef {
  return { id, strength: "strong" };
}

export { strong as strongRef };

export function threadIdFor(nativeThreadId: string): string {
  return deriveId({ kind: "thread", native: strong(nativeThreadId), identityVersion: CODEX_IDENTITY_VERSION });
}

export function turnIdFor(threadId: string, nativeTurnId: string): string {
  return deriveId({ kind: "turn", native: strong(nativeTurnId), identityVersion: CODEX_IDENTITY_VERSION, scope: threadId });
}

export function itemIdFor(turnId: string, nativeItemId: string): string {
  return deriveId({ kind: "item", native: strong(nativeItemId), identityVersion: CODEX_IDENTITY_VERSION, scope: turnId });
}

/** A request's native key is the server request kind and the item it is about, which stay the same across reconnects (JSON-RPC ids do not). */
export function requestIdFor(threadId: string, nativeKey: string): string {
  return deriveId({ kind: "request", native: strong(nativeKey), identityVersion: CODEX_IDENTITY_VERSION, scope: threadId });
}

export function subagentIdFor(parentThreadId: string, childNativeThreadId: string): string {
  return deriveId({ kind: "subagent", native: strong(childNativeThreadId), identityVersion: CODEX_IDENTITY_VERSION, scope: parentThreadId });
}

export function taskIdFor(threadId: string, processId: string): string {
  return deriveId({ kind: "task", native: strong(processId), identityVersion: CODEX_IDENTITY_VERSION, scope: threadId });
}

export function planIdFor(threadId: string, nativeTurnId: string): string {
  return deriveId({ kind: "plan", native: strong(nativeTurnId), identityVersion: CODEX_IDENTITY_VERSION, scope: threadId });
}

export function todoItemIdFor(turnId: string, nativeTurnId: string): string {
  return itemIdFor(turnId, `${nativeTurnId}:todo`);
}

/** Codex counts some timestamps in seconds and some in milliseconds. */
export function isoFromSeconds(seconds: number | null | undefined): string | undefined {
  return seconds === null || seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
}

export function isoFromMillis(millis: number | null | undefined): string | undefined {
  return millis === null || millis === undefined ? undefined : new Date(millis).toISOString();
}

// Runtime policy.

export interface CodexPolicy {
  readonly approvalPolicy: AskForApproval;
  /** Undefined when a named `permissions` profile takes its place: Codex refuses both on one request. */
  readonly sandbox?: SandboxMode;
  /** Undefined when a named `permissions` profile takes its place: Codex refuses both on one request. */
  readonly sandboxPolicy?: SandboxPolicy;
  /** A named permissions profile, from `policy.native.permissions`. */
  readonly permissions?: string | null;
  /**
   * Always named: Codex keeps a thread's reviewer when a resume, a fork or a
   * turn leaves it out (app-server thread_processor.rs:4782–4791, 5788–5794),
   * so only an explicit reviewer moves a thread into or out of `auto`.
   */
  readonly approvalsReviewer: ApprovalsReviewer;
}

/**
 * ARI's runtime modes in Codex terms. Codex enforces all of them itself: the
 * sandbox limits what commands can touch, the approval policy says when it
 * asks, and the reviewer says who answers (`auto_review` in `auto`, the user
 * otherwise). `policy.native` may override any of the four fields, and may
 * name a permissions profile (`permissions`), which Codex takes on start,
 * resume, fork and turn instead of a sandbox. A profile wins over the
 * sandbox the mode sets, which is then not sent; a sandbox `native` names
 * itself is sent with it, for Codex to judge.
 */
export function codexPolicy(policy: RuntimePolicy): CodexPolicy {
  const writableRoots = policy.additionalRoots ?? [];
  const workspaceWrite: SandboxPolicy = { type: "workspaceWrite", ...(writableRoots.length === 0 ? {} : { writableRoots: [...writableRoots] }) };
  let mapped: CodexPolicy;
  switch (policy.mode) {
    case "read_only":
      mapped = { approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly" }, approvalsReviewer: "user" };
      break;
    case "auto_accept_edits":
      mapped = { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: workspaceWrite, approvalsReviewer: "user" };
      break;
    case "auto":
      mapped = { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: workspaceWrite, approvalsReviewer: "auto_review" };
      break;
    case "full_access":
      mapped = { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" };
      break;
    default:
      // approval_required, and any mode this driver does not know: ask before anything that is not trusted.
      mapped = { approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: workspaceWrite, approvalsReviewer: "user" };
  }
  const native = policy.native;
  if (typeof native !== "object" || native === null || Array.isArray(native)) return mapped;
  const overrides = native as Partial<CodexPolicy>;
  const profile = typeof overrides.permissions === "string";
  const sandbox = overrides.sandbox ?? (profile ? undefined : mapped.sandbox);
  const sandboxPolicy = overrides.sandboxPolicy ?? (profile ? undefined : mapped.sandboxPolicy);
  return {
    approvalPolicy: overrides.approvalPolicy ?? mapped.approvalPolicy,
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    approvalsReviewer: overrides.approvalsReviewer ?? mapped.approvalsReviewer,
    ...(overrides.permissions === undefined ? {} : { permissions: overrides.permissions }),
  };
}

// Content.

export function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

export function userInputText(input: readonly UserInput[]): string {
  return input.flatMap((entry) => ("type" in entry && entry.type === "text" ? [entry.text] : [])).join("\n");
}

// Items.

export interface ItemContext {
  readonly turnId: string;
  readonly emitDiffs: boolean;
  readonly maxToolOutputBytes?: number;
  readonly maxDiffBytes?: number;
}

function bounded(text: string, limit: number | undefined): { text: string; truncated: boolean } {
  return limit === undefined ? { text, truncated: false } : truncateUtf8(text, limit);
}

function commandStatus(status: string): ItemStatus {
  if (status === "inProgress") return "running";
  if (status === "declined") return "cancelled";
  return status;
}

function fileChangeKind(type: string): string {
  if (type === "add" || type === "delete") return type;
  return "modify";
}

/** The full ARI item for a Codex thread item. `status` overrides the item's own status (a started item is running). */
export function itemFromCodex(native: ThreadItem, context: ItemContext, status?: ItemStatus): Item {
  const base = { id: itemIdFor(context.turnId, native.id), native: strong(native.id), turnId: context.turnId };
  const started = isoFromMillis(native.startedAtMs);
  const completed = isoFromMillis(native.completedAtMs);
  const times = { ...(started === undefined ? {} : { startedAt: started }), ...(completed === undefined ? {} : { completedAt: completed }) };
  const done: ItemStatus = status ?? "completed";
  switch (native.type) {
    case "userMessage": {
      const content: ContentBlock[] = native.content.flatMap((entry): ContentBlock[] => {
        if ("type" in entry && entry.type === "text") return [{ type: "text", text: entry.text }];
        if ("url" in entry && typeof entry.url === "string") return [{ type: "image", url: entry.url }];
        return [];
      });
      return { ...base, ...times, kind: "user_message", status: done, text: userInputText(native.content), content };
    }
    case "agentMessage":
      return { ...base, ...times, kind: "assistant_message", status: done, text: native.text };
    case "reasoning": {
      const reasoning = [...(native.summary ?? []), ...(native.content ?? [])].join("\n");
      return { ...base, ...times, kind: "reasoning", status: done, ...(reasoning === "" ? {} : { reasoning }) };
    }
    case "plan":
      return { ...base, ...times, kind: "proposed_plan", status: done, plan: native.text };
    case "commandExecution": {
      const output = native.aggregatedOutput === null || native.aggregatedOutput === undefined ? undefined : bounded(native.aggregatedOutput, context.maxToolOutputBytes);
      // Codex parses each command into actions; the ones that read, list or search a path name it.
      const paths = native.commandActions.flatMap((action) => ("path" in action && typeof action.path === "string" && action.path !== "" ? [action.path] : []));
      return {
        ...base,
        ...times,
        kind: "command_execution",
        status: status ?? commandStatus(native.status),
        command: [native.command],
        cwd: native.cwd,
        ...(native.exitCode === null || native.exitCode === undefined ? {} : { exitCode: native.exitCode }),
        ...(native.durationMs === null || native.durationMs === undefined ? {} : { durationMs: native.durationMs }),
        ...(output === undefined ? {} : { output: output.text }),
        ...(output?.truncated === true ? { truncated: true } : {}),
        ...(paths.length === 0 ? {} : { paths }),
      };
    }
    case "fileChange": {
      let truncated = false;
      const changes = native.changes.map((change): FileChange => {
        const movedTo = change.kind.type === "update" ? change.kind.move_path : undefined;
        const entry: FileChange = movedTo === null || movedTo === undefined ? { kind: fileChangeKind(change.kind.type), path: change.path } : { kind: "move", path: movedTo, oldPath: change.path };
        if (!context.emitDiffs) return entry;
        const diff = bounded(change.diff, context.maxDiffBytes);
        if (diff.truncated) truncated = true;
        return { ...entry, diff: diff.text };
      });
      return {
        ...base,
        ...times,
        kind: "file_change",
        status: status ?? commandStatus(native.status),
        changes,
        paths: changes.map((change) => change.path),
        ...(truncated ? { truncated: true } : {}),
      };
    }
    case "mcpToolCall":
      return {
        ...base,
        ...times,
        kind: "mcp_tool_call",
        status: status ?? commandStatus(native.status),
        tool: {
          server: native.server,
          name: native.tool,
          input: native.arguments,
          ...(native.result === null || native.result === undefined ? {} : { result: native.result }),
          ...(native.error === null || native.error === undefined ? {} : { error: native.error.message }),
        },
      };
    case "dynamicToolCall":
      return {
        ...base,
        ...times,
        kind: "dynamic_tool_call",
        status: status ?? (native.status === "inProgress" ? "running" : native.status),
        tool: { name: native.tool, input: native.arguments, ...(native.contentItems === null || native.contentItems === undefined ? {} : { result: native.contentItems }) },
      };
    case "collabAgentToolCall":
      return {
        ...base,
        ...times,
        kind: native.tool === "spawnAgent" ? "subagent_spawn" : "tool_call",
        status: status ?? (native.status === "inProgress" ? "running" : native.status),
        tool: { name: `agents.${native.tool}`, input: { receiverThreadIds: native.receiverThreadIds, ...(native.prompt === null || native.prompt === undefined ? {} : { prompt: native.prompt }) } },
      };
    case "webSearch":
      return { ...base, ...times, kind: "web_search", status: done, query: native.query };
    case "imageView":
      return { ...base, ...times, kind: "file_read", status: done, paths: [native.path] };
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { ...base, ...times, kind: "review", status: done, text: native.review, title: native.type === "enteredReviewMode" ? "Review started" : "Review finished" };
    case "contextCompaction":
      return { ...base, ...times, kind: "compaction", status: done };
    case "hookPrompt":
      return { ...base, ...times, kind: "system_notice", status: done, text: native.fragments.map((fragment) => fragment.text).join("\n") };
    default: {
      // Item types without an ARI kind keep their data under an `x:codex.*` kind, with a plain-text fallback.
      const type = (native as { type: string }).type;
      return { ...base, ...times, kind: `x:codex.${type}`, status: done, data: native, fallback: { title: `Codex ${type}` } };
    }
  }
}

// Approvals.

/** The native option id of a Codex approval decision: the decision itself, as canonical text. Codex decisions have no other id. */
export function decisionOptionId(decision: CommandExecutionApprovalDecision | FileChangeApprovalDecision): string {
  if (typeof decision === "string") return decision;
  if ("acceptWithExecpolicyAmendment" in decision) return `acceptWithExecpolicyAmendment:${JSON.stringify(decision.acceptWithExecpolicyAmendment.execpolicy_amendment)}`;
  return `applyNetworkPolicyAmendment:${JSON.stringify([decision.applyNetworkPolicyAmendment.network_policy_amendment.action, decision.applyNetworkPolicyAmendment.network_policy_amendment.host])}`;
}

/** The decision a native option id stands for, or undefined when it is not one of `available`. */
export function decisionFromOptionId<Decision extends CommandExecutionApprovalDecision | FileChangeApprovalDecision>(optionId: string, available: readonly Decision[]): Decision | undefined {
  return available.find((decision) => decisionOptionId(decision) === optionId);
}

/**
 * One ARI option per Codex decision, with the decision's real reach:
 * `accept` once, `acceptForSession` for this session, an exec-policy
 * amendment for every later command with that prefix (Codex saves the rule in
 * the user's rules file, so for every project), a network amendment for that
 * host everywhere.
 */
export function approvalOption(decision: CommandExecutionApprovalDecision | FileChangeApprovalDecision): RequestOption {
  const optionId = decisionOptionId(decision);
  const option = (label: string, ariDecision: ApprovalDecision, scope?: ApprovalScope): RequestOption => ({ optionId, label, decision: ariDecision, ...(scope === undefined ? {} : { scope }) });
  if (decision === "accept") return option("Allow once", "accept", "once");
  if (decision === "acceptForSession") return option("Allow for this session", "accept_for_session", "session");
  if (decision === "decline") return option("Decline", "decline");
  if (decision === "cancel") return option("Decline and stop the turn", "cancel");
  if (typeof decision === "object" && "acceptWithExecpolicyAmendment" in decision) {
    return option(`Always allow commands that start with \`${decision.acceptWithExecpolicyAmendment.execpolicy_amendment.join(" ")}\``, "accept_always", "global");
  }
  if (typeof decision === "object" && "applyNetworkPolicyAmendment" in decision) {
    const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
    return option(`${amendment.action === "allow" ? "Always allow" : "Always block"} network access to ${amendment.host}`, amendment.action === "allow" ? "accept_always" : "decline", "global");
  }
  return option(String(decision), "other");
}

/** What Codex offers when a command approval lists no `availableDecisions`. */
export const DEFAULT_COMMAND_DECISIONS: readonly CommandExecutionApprovalDecision[] = ["accept", "acceptForSession", "decline", "cancel"];
export const FILE_CHANGE_DECISIONS: readonly FileChangeApprovalDecision[] = ["accept", "acceptForSession", "decline", "cancel"];

// Turn outcomes.

export function turnStatusFromCodex(status: string): TurnStatus {
  if (status === "inProgress") return "running";
  return status;
}

/** Codex error kinds that mean the account ran out of its allowance. */
const USAGE_LIMIT_ERRORS = new Set(["usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded", "apiKeySpendLimitExceeded", "projectSpendLimitExceeded", "organizationSpendLimitExceeded"]);

function errorInfoName(info: TurnError["codexErrorInfo"]): string | undefined {
  if (info === null || info === undefined) return undefined;
  if (typeof info === "string") return info;
  const keys = Object.keys(info);
  return keys[0];
}

/** The ARI failure for a failed Codex turn. `resetAt` is the earliest reset Codex reported in its latest rate-limit snapshot. */
export function failureFromCodex(error: TurnError | null | undefined, resetAt: string | undefined): Failure {
  const message = error?.message ?? "Codex failed the turn.";
  const kind = errorInfoName(error?.codexErrorInfo);
  if (kind !== undefined && USAGE_LIMIT_ERRORS.has(kind)) return { class: "usage_limit", message, code: kind, retryable: true, ...(resetAt === undefined ? {} : { resetAt }) };
  if (kind === "unauthorized") return { class: "permission_error", message, code: kind, retryable: false };
  if (kind === "badRequest" || kind === "contextWindowExceeded") return { class: "validation_error", message, code: kind, retryable: false };
  if (kind === "httpConnectionFailed" || kind === "responseStreamConnectionFailed" || kind === "responseStreamDisconnected") return { class: "transport_error", message, code: kind, retryable: true };
  return { class: "provider_error", message, ...(kind === undefined ? {} : { code: kind }), retryable: kind === "serverOverloaded" || kind === "internalServerError" };
}

// Limits and usage.

function windowName(window: RateLimitWindow, fallback: string): LimitWindow["window"] {
  const minutes = window.windowDurationMins;
  if (minutes === 300) return "5h";
  if (minutes === 1440) return "daily";
  if (minutes === 10_080) return "weekly";
  return minutes === null || minutes === undefined ? `x:codex.${fallback}` : `x:codex.${minutes}m`;
}

/** ARI limit windows for a Codex rate-limit snapshot. */
export function limitsFromCodex(snapshot: RateLimitSnapshot): LimitStatus {
  const windows: LimitWindow[] = [];
  for (const [name, window] of [
    ["primary", snapshot.primary],
    ["secondary", snapshot.secondary],
  ] as const) {
    if (window === null || window === undefined) continue;
    const resetsAt = isoFromSeconds(window.resetsAt);
    windows.push({ window: windowName(window, name), utilization: Math.min(1, Math.max(0, window.usedPercent / 100)), ...(resetsAt === undefined ? {} : { resetsAt }) });
  }
  if (snapshot.credits !== null && snapshot.credits !== undefined && !snapshot.credits.unlimited) {
    const balance = snapshot.credits.balance === null || snapshot.credits.balance === undefined ? undefined : Number(snapshot.credits.balance);
    windows.push({ window: "credits", ...(balance === undefined || !Number.isFinite(balance) ? {} : { remaining: balance }) });
  }
  const reached = snapshot.rateLimitReachedType !== null && snapshot.rateLimitReachedType !== undefined;
  const limited = reached || windows.some((window) => (window.utilization ?? 0) >= 1);
  const resets = windows.filter((window) => window.resetsAt !== undefined && (!limited || (window.utilization ?? 0) >= 1 || reached)).map((window) => window.resetsAt!).sort();
  return { windows, limited, ...(limited && resets.length > 0 ? { resetsAt: resets[0]! } : {}) };
}

export function usageFromCodex(usage: ThreadTokenUsage, model: string | undefined): UsageSnapshot {
  const last = usage.last;
  return {
    scope: "turn",
    ...(model === undefined ? {} : { model }),
    inputTokens: last.inputTokens,
    outputTokens: last.outputTokens,
    cachedInputTokens: last.cachedInputTokens,
    reasoningTokens: last.reasoningOutputTokens,
    totalTokens: last.totalTokens,
    // The last request's tokens are what the context holds now; `total` sums every request of the thread.
    contextUsedTokens: last.totalTokens,
    ...(usage.modelContextWindow === null || usage.modelContextWindow === undefined ? {} : { contextMaxTokens: usage.modelContextWindow }),
  };
}
