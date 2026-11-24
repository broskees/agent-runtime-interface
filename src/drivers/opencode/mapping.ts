// Pure translations between OpenCode and ARI: deterministic ids, tool items,
// approval options and failures. Nothing here talks to a server.
//
// Ids: OpenCode names sessions, messages, parts, tool calls and requests, so
// every ARI id is derived from a strong native id. A turn is named by its
// prompt's message id, as the server assigned it (1.x reports the user message
// in its events, 2.x in the answer to `session.prompt` and in
// `session.inbox.enqueued`). Turn and item ids are scoped by their thread,
// because a fork may copy messages.

import { deriveId } from "../../driver-kit/ids.ts";
import type { Failure } from "../../generated/errors.ts";
import type { ItemPatch } from "../../generated/item.ts";
import type { RequestKind, RequestOption } from "../../generated/request.ts";
import { IDENTITY_VERSION } from "./capabilities.ts";
import type { NativeError, NativeToolState } from "./native.ts";
import { sanitizeMcpName } from "./rules.ts";

export function threadIdFor(sessionId: string): string {
  return deriveId({ kind: "thread", native: { id: sessionId, strength: "strong" }, identityVersion: IDENTITY_VERSION });
}

export function turnIdFor(threadId: string, messageId: string): string {
  return deriveId({ kind: "turn", native: { id: messageId, strength: "strong" }, identityVersion: IDENTITY_VERSION, scope: threadId });
}

/** A turn OpenCode ran without a prompt from this driver: named by its order among such turns of the thread. */
export function providerTurnIdFor(threadId: string, ordinal: number): string {
  return deriveId({ kind: "turn", native: { id: null, strength: "weak", ordinal, fingerprint: "provider_initiated" }, identityVersion: IDENTITY_VERSION, scope: threadId });
}

export function itemIdFor(threadId: string, nativeId: string): string {
  return deriveId({ kind: "item", native: { id: nativeId, strength: "strong" }, identityVersion: IDENTITY_VERSION, scope: threadId });
}

export function requestIdFor(threadId: string, nativeId: string): string {
  return deriveId({ kind: "request", native: { id: nativeId, strength: "strong" }, identityVersion: IDENTITY_VERSION, scope: threadId });
}

export function subagentIdFor(childSessionId: string): string {
  return deriveId({ kind: "subagent", native: { id: childSessionId, strength: "strong" }, identityVersion: IDENTITY_VERSION });
}

function field(input: unknown, ...names: string[]): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  for (const name of names) {
    const value = (input as { [key: string]: unknown })[name];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** Item kind and payload fields of an OpenCode tool, by its name and input. */
export function toolItemFields(state: NativeToolState, cwd: string, mcpServers: ReadonlySet<string>, subagentId: string | undefined): Pick<ItemPatch, "kind" | "command" | "cwd" | "paths" | "changes" | "query" | "tool" | "title" | "subagentId"> {
  const input = state.input;
  const title = state.title === undefined ? {} : { title: state.title };
  switch (state.tool) {
    case "bash":
    case "shell": {
      const command = field(input, "command");
      return { kind: "command_execution", ...(command === undefined ? {} : { command: [command] }), cwd: field(input, "workdir", "cwd") ?? cwd, ...title };
    }
    case "read": {
      const path = field(input, "filePath", "path");
      return { kind: "file_read", ...(path === undefined ? {} : { paths: [path] }), ...title };
    }
    case "edit":
    case "write":
    case "apply_patch":
    case "patch": {
      const path = field(input, "filePath", "path");
      return { kind: "file_change", changes: path === undefined ? [] : [{ kind: state.tool === "write" ? "add" : "modify", path }], ...title };
    }
    case "glob":
    case "grep":
    case "list": {
      const query = field(input, "pattern", "path") ?? "";
      return { kind: "file_search", query, ...title };
    }
    case "websearch": {
      return { kind: "web_search", query: field(input, "query") ?? "", ...title };
    }
    case "task":
    case "subagent":
      return { kind: "subagent_spawn", ...(subagentId === undefined ? {} : { subagentId }), ...title };
    default:
      break;
  }
  // MCP tools are named `<server>_<tool>` with both parts sanitized (1.x `mcp/catalog.ts`, 2.x `tool/mcp.ts`).
  for (const server of mcpServers) {
    const prefix = `${sanitizeMcpName(server)}_`;
    if (state.tool.startsWith(prefix)) return { kind: "mcp_tool_call", tool: { server, name: state.tool.slice(prefix.length), input: input ?? null }, ...title };
  }
  return { kind: "tool_call", tool: { name: state.tool, input: input ?? null }, ...title };
}

/** The request kind of an OpenCode permission. 1.x names shell commands `bash`, 2.x `shell`. */
export function requestKindOf(action: string): RequestKind {
  if (action === "bash" || action === "shell") return "command";
  if (action === "edit") return "file_change";
  if (action === "read") return "file_read";
  return "permission";
}

/**
 * OpenCode's three replies to a permission request (1.x `permission.reply`
 * `reply`, 2.x `Permission.Reply`), as ARI options. The option id is the
 * reply itself. "Always" saves a rule for the whole project, and says so.
 */
export function permissionOptions(action: string, always: readonly string[]): RequestOption[] {
  const reach = always.length === 0 || always.every((pattern) => pattern === "*") ? `every ${action} request` : always.join(", ");
  return [
    { optionId: "once", label: "Allow once", decision: "accept", scope: "once" },
    { optionId: "always", label: `Always allow ${reach} in this project`, decision: "accept_always", scope: "project", warning: "OpenCode keeps this grant for every session of the project." },
    { optionId: "reject", label: "Reject", decision: "decline" },
  ];
}

export function failureOf(error: NativeError | undefined, fallback: string): Failure {
  if (error === undefined) return { class: "provider_error", message: fallback, retryable: false };
  if (error.kind === "usage_limit") return { class: "usage_limit", message: error.message, ...(error.code === undefined ? {} : { code: error.code }), retryable: true, ...(error.resetAt === undefined ? {} : { resetAt: error.resetAt }) };
  if (error.kind === "auth") return { class: "permission_error", message: error.message, ...(error.code === undefined ? {} : { code: error.code }), retryable: false };
  return { class: "provider_error", message: error.message, ...(error.code === undefined ? {} : { code: error.code }), retryable: false };
}
