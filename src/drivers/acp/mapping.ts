// Pure translations between ACP frames (both protocol versions) and ARI
// values. Nothing here keeps state or talks to the agent.

import type { ContentBlock, ImageContent } from "../../generated/common.ts";
import type { ConfigOption, ConfigOptionCategory, SlashCommand } from "../../generated/config.ts";
import type { FileChange, ItemKind, ItemStatus, TodoEntry } from "../../generated/item.ts";
import type { ApprovalDecision, ApprovalScope, RequestKind, RequestOption } from "../../generated/request.ts";
import type { LaunchMcpServer } from "../../generated/session.ts";
import type * as V1 from "./generated/v1.ts";
import type * as V2 from "./generated/v2.ts";

export type AcpVersion = 1 | 2;

/** A tool call as both versions report it (v2 `tool_call_update` is a superset of v1 `tool_call`). */
export type AcpToolCall = V1.ToolCallUpdate | V2.ToolCallUpdate;

/** ACP tool kinds to ARI item kinds. Kinds ACP may add later fall back to the generic `tool_call`. */
const TOOL_ITEM_KINDS: { readonly [kind: string]: ItemKind } = {
  read: "file_read",
  edit: "file_change",
  delete: "file_change",
  move: "file_change",
  search: "file_search",
  execute: "command_execution",
  fetch: "web_search",
};

export function toolItemKind(kind: string | null | undefined): ItemKind {
  return (kind === null || kind === undefined ? undefined : TOOL_ITEM_KINDS[kind]) ?? "tool_call";
}

/** ACP tool call statuses to ARI item statuses. `paused` waits for something to resume it. */
export function toolItemStatus(status: string | null | undefined): ItemStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "paused":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

export const TERMINAL_ITEM_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** What a permission request is about, from the tool call it guards. */
export function requestKindForTool(kind: string | null | undefined): RequestKind {
  switch (kind) {
    case "execute":
      return "command";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "read":
      return "file_read";
    default:
      return "permission";
  }
}

/**
 * ACP permission option kinds to ARI decisions, with the real reach of each.
 * ACP says an `allow_always` choice is remembered but not for how long or how
 * widely, so the driver states the widest reach a remembered choice can have
 * on a local agent, the project, and never claims less.
 */
const OPTION_MEANING: { readonly [kind: string]: { readonly decision: ApprovalDecision; readonly scope: ApprovalScope } } = {
  allow_once: { decision: "accept", scope: "once" },
  allow_always: { decision: "accept_always", scope: "project" },
  reject_once: { decision: "decline", scope: "once" },
  reject_always: { decision: "decline", scope: "project" },
};

export function requestOptions(options: ReadonlyArray<V1.PermissionOption | V2.PermissionOption>): RequestOption[] {
  return options.map((option) => {
    const meaning = OPTION_MEANING[option.kind];
    // An option kind this driver does not know is never taken for an approval.
    return meaning === undefined
      ? { optionId: option.optionId, label: option.name, decision: "other" }
      : { optionId: option.optionId, label: option.name, decision: meaning.decision, scope: meaning.scope };
  });
}

const SCOPE_RANK: { readonly [scope: string]: number } = { once: 0, session: 1, project: 2, global: 3 };
const ACCEPTING: ReadonlySet<string> = new Set(["accept", "accept_for_session", "accept_always"]);

/** The accepting option with the narrowest real reach, for an automatic reply under `full_access`. */
export function narrowestAccepting(options: readonly RequestOption[]): RequestOption | undefined {
  return options
    .filter((option) => ACCEPTING.has(option.decision))
    .sort((a, b) => (SCOPE_RANK[a.scope ?? "global"] ?? 4) - (SCOPE_RANK[b.scope ?? "global"] ?? 4))[0];
}

/** The text of ACP content blocks; other block types are left out. */
export function contentText(blocks: ReadonlyArray<V1.ContentBlock | V2.ContentBlock> | null | undefined): string {
  if (blocks === null || blocks === undefined) return "";
  return blocks.map((block) => (block.type === "text" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "")).join("");
}

/** The text a tool call's content items carry. */
export function toolContentText(content: ReadonlyArray<V1.ToolCallContent | V2.ToolCallContent> | null | undefined): string {
  if (content === null || content === undefined) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (entry.type !== "content") continue;
    const block = (entry as { content?: { type?: string; text?: unknown } }).content;
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

/** File changes a tool call's diff content describes. `withDiffs` adds the diff text, which a host may turn off. */
export function toolFileChanges(content: ReadonlyArray<V1.ToolCallContent | V2.ToolCallContent> | null | undefined, withDiffs: boolean): FileChange[] {
  if (content === null || content === undefined) return [];
  const changes: FileChange[] = [];
  for (const entry of content) {
    if (entry.type !== "diff") continue;
    const diff = entry as { path?: unknown; oldText?: unknown; newText?: unknown; changes?: unknown; patch?: { text?: unknown } | null };
    if (typeof diff.path === "string") {
      // v1: one path with old and new text.
      const kind = diff.oldText === null || diff.oldText === undefined ? "add" : "modify";
      const text = withDiffs ? simpleDiff(diff.path, typeof diff.oldText === "string" ? diff.oldText : "", typeof diff.newText === "string" ? diff.newText : "") : undefined;
      changes.push({ kind, path: diff.path, ...(text === undefined ? {} : { diff: text }) });
      continue;
    }
    if (Array.isArray(diff.changes)) {
      // v2: structured changes, with optional git patch text for all of them.
      const patch = withDiffs && typeof diff.patch?.text === "string" ? diff.patch.text : undefined;
      for (const change of diff.changes as Array<{ operation?: unknown; path?: unknown; oldPath?: unknown }>) {
        if (typeof change.path !== "string") continue;
        changes.push({
          kind: typeof change.operation === "string" ? change.operation : "modify",
          path: change.path,
          ...(typeof change.oldPath === "string" ? { oldPath: change.oldPath } : {}),
          ...(patch === undefined ? {} : { diff: patch }),
        });
      }
    }
  }
  return changes;
}

/** A minimal unified diff of whole-text replacement, for v1 diffs that carry old and new text but no patch. */
function simpleDiff(path: string, oldText: string, newText: string): string {
  const removed = oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
  const added = newText === "" ? [] : newText.replace(/\n$/, "").split("\n");
  const header = `--- ${oldText === "" ? "/dev/null" : path}\n+++ ${path}\n@@ -${removed.length === 0 ? 0 : 1},${removed.length} +${added.length === 0 ? 0 : 1},${added.length} @@\n`;
  return header + [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n") + "\n";
}

/** Plan entries as ARI todos. ACP plan entries have no ids, so todos carry none. */
export function todos(entries: ReadonlyArray<V1.PlanEntry | V2.PlanEntry>): TodoEntry[] {
  return entries.map((entry) => ({ text: entry.content, status: entry.status }));
}

const CATEGORY: { readonly [category: string]: ConfigOptionCategory } = {
  mode: "mode",
  model: "model",
  thought_level: "reasoning",
  model_config: "other",
};

type AcpConfigOption = V1.SessionConfigOption | V2.SessionConfigOption;

/** The id of an ACP config option: `id` in v1, `configId` in v2. */
export function configOptionId(option: AcpConfigOption): string {
  const record = option as { id?: unknown; configId?: unknown };
  return typeof record.configId === "string" ? record.configId : String(record.id);
}

/**
 * An ACP session config option as an ARI config option. ACP states no
 * dependencies between options, so `dependsOn` comes from the driver's
 * config (`configDependencies`), and it is applied to every list the agent
 * sends, so an option keeps its dependencies when the agent replaces the list.
 */
export function configOption(option: AcpConfigOption, dependencies: { readonly [optionId: string]: readonly string[] }): ConfigOption {
  const id = configOptionId(option);
  const record = option as { type?: unknown; currentValue?: unknown; options?: unknown; category?: unknown; name: string };
  const values: Array<{ id: string; label: string; description?: string }> = [];
  if (Array.isArray(record.options)) {
    for (const entry of record.options as Array<{ value?: unknown; name?: unknown; description?: unknown; options?: unknown }>) {
      // Grouped options carry their own `options`; ungrouped ones are values.
      const members = Array.isArray(entry.options) ? (entry.options as Array<{ value?: unknown; name?: unknown; description?: unknown }>) : [entry];
      for (const member of members) {
        if (typeof member.value !== "string") continue;
        values.push({ id: member.value, label: typeof member.name === "string" ? member.name : member.value, ...(typeof member.description === "string" ? { description: member.description } : {}) });
      }
    }
  }
  const category = typeof record.category === "string" ? (CATEGORY[record.category] ?? "other") : "other";
  const dependsOn = dependencies[id];
  return {
    id,
    category,
    label: record.name,
    type: record.type === "boolean" ? "boolean" : record.type === "select" ? "select" : String(record.type ?? "select"),
    ...(values.length > 0 ? { values } : {}),
    current: (record.currentValue ?? null) as ConfigOption["current"],
    // Each ACP session has its own options, and an ACP session is an ARI thread.
    scope: "thread",
    ...(dependsOn === undefined || dependsOn.length === 0 ? {} : { dependsOn: [...dependsOn] }),
    // The driver sets changed options with session/set_config_option before the next prompt.
    changeEffect: "next_turn",
  };
}

/** ACP slash commands as ARI slash commands. */
export function slashCommands(commands: ReadonlyArray<V1.AvailableCommand | V2.AvailableCommand>): SlashCommand[] {
  return commands.map((command) => {
    const input = (command as { input?: { hint?: unknown } | null }).input;
    return {
      name: command.name,
      ...(command.description === "" ? {} : { description: command.description }),
      ...(typeof input?.hint === "string" ? { argumentHint: input.hint } : {}),
    };
  });
}

/** Which MCP transports the agent accepts for host-provided servers. */
export function acceptedMcpTransports(version: AcpVersion, capabilities: V1.AgentCapabilities | V2.AgentCapabilities | undefined): Array<"stdio" | "http" | "sse"> {
  if (version === 1) {
    const mcp = (capabilities as V1.AgentCapabilities | undefined)?.mcpCapabilities;
    // v1 agents must all accept stdio servers.
    return ["stdio", ...(mcp?.http === true ? (["http"] as const) : []), ...(mcp?.sse === true ? (["sse"] as const) : [])];
  }
  const mcp = (capabilities as V2.AgentCapabilities | undefined)?.session?.mcp;
  return [...(mcp?.stdio === null || mcp?.stdio === undefined ? [] : (["stdio"] as const)), ...(mcp?.http === null || mcp?.http === undefined ? [] : (["http"] as const))];
}

/** Host MCP servers as ACP `McpServer` entries, under exactly the names the host gave. */
export function mcpServers(version: AcpVersion, servers: readonly LaunchMcpServer[]): Array<V1.McpServer | V2.McpServer> {
  return servers.map((server) => {
    const env = Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }));
    const headers = Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value }));
    if (server.transport === "stdio") {
      const stdio = { name: server.name, command: server.command ?? "", args: [...(server.args ?? [])], env };
      return version === 2 ? { type: "stdio", ...stdio } : stdio;
    }
    return { type: server.transport, name: server.name, url: server.url ?? "", headers } as V1.McpServer | V2.McpServer;
  });
}

/** Whether the agent accepts image prompt blocks. */
export function acceptsImages(version: AcpVersion, capabilities: V1.AgentCapabilities | V2.AgentCapabilities | undefined): boolean {
  if (version === 1) return (capabilities as V1.AgentCapabilities | undefined)?.promptCapabilities?.image === true;
  const image = (capabilities as V2.AgentCapabilities | undefined)?.session?.prompt?.image;
  return image !== null && image !== undefined;
}

/** An ARI image block as an ACP image block, when it carries its bytes. */
export function imageBlock(block: ImageContent): V1.ContentBlock | undefined {
  if (block.data === undefined) return undefined;
  return { type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" } as V1.ContentBlock;
}

/** The plain text of ARI content blocks. */
export function promptText(content: readonly ContentBlock[]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}
