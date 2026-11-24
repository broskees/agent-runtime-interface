// How Pi's native data becomes ARI ids, items and failures, for live events
// and for snapshots rebuilt from a session file alike.
//
// Identity (all ids come from `deriveId`, so they follow from native data):
// - thread: Pi's session id (strong).
// - turn: Pi has no turn id. A turn is named by the position of its prompt
//   among every user-message entry of the session file in append order
//   (weak, ordinal only). Entries are append-only, so a position never
//   changes and is never reused, even after a rollback leaves entries on an
//   abandoned branch. A run Pi starts without a prompt from the driver adds
//   the fingerprint `provider_initiated`.
// - item: messages by their position among the turn's user and assistant
//   messages (none, ordinal); reasoning adds the fingerprint `thinking`; tool
//   calls by Pi's tool call id (strong).
// - request: Pi's extension UI request id (strong).

import { deriveId } from "../../driver-kit/ids.ts";
import type { Failure } from "../../generated/errors.ts";
import type { Item } from "../../generated/item.ts";
import type { Turn } from "../../generated/thread.ts";

export const IDENTITY_VERSION = 1;

export function threadIdFor(sessionId: string): string {
  return deriveId({ kind: "thread", native: { id: sessionId, strength: "strong" }, identityVersion: IDENTITY_VERSION });
}

export function turnNative(ordinal: number, providerInitiated = false): Turn["native"] {
  return { id: null, strength: "weak", ordinal, ...(providerInitiated ? { fingerprint: "provider_initiated" } : {}) };
}

export function turnIdFor(threadId: string, native: Turn["native"]): string {
  return deriveId({ kind: "turn", native, identityVersion: IDENTITY_VERSION, scope: threadId });
}

export function messageNative(ordinal: number, part?: "thinking"): Item["native"] {
  return { id: null, strength: "none", ordinal, ...(part === undefined ? {} : { fingerprint: part }) };
}

export function itemIdFor(turnId: string, native: Item["native"]): string {
  return deriveId({ kind: "item", native, identityVersion: IDENTITY_VERSION, scope: turnId });
}

export function toolNative(toolCallId: string): Item["native"] {
  return { id: toolCallId, strength: "strong" };
}

export function requestIdFor(threadId: string, uiRequestId: string): string {
  return deriveId({ kind: "request", native: { id: uiRequestId, strength: "strong" }, identityVersion: IDENTITY_VERSION, scope: threadId });
}

// ---------------------------------------------------------------------------
// Pi's message and entry shapes (Pi docs: message-types.md, session-format.md)

export interface PiMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
  readonly toolCallId?: unknown;
  readonly toolName?: unknown;
  readonly isError?: unknown;
  readonly usage?: unknown;
  readonly model?: unknown;
  readonly provider?: unknown;
}

export interface PiEntry {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly message?: PiMessage;
  readonly [field: string]: unknown;
}

/** The text of a message's content: a string, or its text blocks joined. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" ? [String((block as { text?: unknown }).text ?? "")] : [])).join("");
}

/** The text of a message's thinking blocks. */
export function messageThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "thinking" ? [String((block as { thinking?: unknown }).thinking ?? "")] : [])).join("");
}

/** The tool calls of an assistant message. */
export function messageToolCalls(content: unknown): Array<{ id: string; name: string; arguments: unknown }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (typeof block !== "object" || block === null || (block as { type?: unknown }).type !== "toolCall") return [];
    const call = block as { id?: unknown; name?: unknown; arguments?: unknown };
    return typeof call.id === "string" && typeof call.name === "string" ? [{ id: call.id, name: call.name, arguments: call.arguments }] : [];
  });
}

function isRole(entry: PiEntry, role: string): boolean {
  return entry.type === "message" && entry.message?.role === role;
}

// ---------------------------------------------------------------------------
// Tool items

/** Joins a path the model gave to the working directory, the way Pi's tools resolve it. */
export function resolveToolPath(cwd: string, given: string): string {
  if (given.startsWith("/") || /^[A-Za-z]:[\\/]/.test(given)) return given;
  const relative = given.startsWith("./") ? given.slice(2) : given;
  if (relative === "" || relative === ".") return cwd;
  return `${cwd.endsWith("/") ? cwd.slice(0, -1) : cwd}/${relative}`;
}

/** The item fields for a Pi tool call (built-in tools from Pi docs cli.md "Tools"; MCP tools are `mcp__<server>__<tool>`, mcp.md). */
export function toolItemFields(toolName: string, args: unknown, cwd: string): Pick<Item, "kind" | "title" | "command" | "cwd" | "paths" | "tool"> {
  const input = typeof args === "object" && args !== null ? (args as { [key: string]: unknown }) : {};
  const paths = typeof input["path"] === "string" ? [resolveToolPath(cwd, input["path"])] : undefined;
  const withPaths = paths === undefined ? {} : { paths };
  if (toolName === "bash" && typeof input["command"] === "string") {
    return { kind: "command_execution", title: input["command"], command: [input["command"]], cwd, tool: { name: toolName, input: args ?? null } };
  }
  if (toolName === "read") return { kind: "file_read", title: toolName, ...withPaths, tool: { name: toolName, input: args ?? null } };
  if (toolName === "edit" || toolName === "write") return { kind: "file_change", title: toolName, ...withPaths, tool: { name: toolName, input: args ?? null } };
  if (toolName === "grep" || toolName === "find" || toolName === "ls") return { kind: "file_search", title: toolName, ...withPaths, tool: { name: toolName, input: args ?? null } };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp !== null) return { kind: "mcp_tool_call", title: toolName, ...withPaths, tool: { server: mcp[1]!, name: mcp[2]!, input: args ?? null } };
  return { kind: "tool_call", title: toolName, ...withPaths, tool: { name: toolName, input: args ?? null } };
}

/** The text of a tool result (`AgentToolResult` or a tool result message): its text blocks. */
export function toolResultText(result: unknown): string {
  if (typeof result !== "object" || result === null) return typeof result === "string" ? result : "";
  return messageText((result as { content?: unknown }).content);
}

// ---------------------------------------------------------------------------
// Failures

/**
 * Pi reports a provider failure as the assistant message's `errorMessage`,
 * the provider's own text (Pi docs, message-types.md). Quota and plan limits
 * use the wording Pi's own retry classifier treats as non-retryable
 * (`@earendil-works/pi-ai` utils/retry.js); a reset time is read from the
 * provider's `resets_at` (epoch seconds) or an ISO time after "reset".
 */
const USAGE_LIMIT = /usage[ _]limit|insufficient_quota|quota exceeded|out of budget|billing|GoUsageLimitError|FreeUsageLimitError|"code"\s*:\s*"?1308(?![0-9])/i;
const PERMISSION = /(?<![a-z0-9])(?:401|403)(?![a-z0-9])|unauthorized|forbidden|invalid api key|authentication failed/i;

export function failureFromError(message: string): Failure {
  if (USAGE_LIMIT.test(message)) {
    const resetAt = resetTime(message);
    return { class: "usage_limit", message, retryable: true, ...(resetAt === undefined ? {} : { resetAt }) };
  }
  if (PERMISSION.test(message)) return { class: "permission_error", message, retryable: false };
  return { class: "provider_error", message, retryable: true };
}

function resetTime(message: string): string | undefined {
  const epoch = /"?resets_?at"?\s*[:=]\s*"?(\d{9,13})/i.exec(message);
  if (epoch !== null) {
    const value = Number(epoch[1]);
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  const iso = /reset[a-z_ ]*["':=\s]+(\d{4}-\d\d-\d\dT[0-9:.]+(?:Z|[+-]\d\d:?\d\d)?)/i.exec(message);
  if (iso !== null && Number.isFinite(Date.parse(iso[1]!))) return new Date(Date.parse(iso[1]!)).toISOString();
  return undefined;
}

// ---------------------------------------------------------------------------
// Transcripts: a session file as `get_entries` returns it

export interface Transcript {
  /** Every entry in append order, abandoned branches included. */
  readonly entries: readonly PiEntry[];
  readonly leafId: string | null;
  /** The entries from the root to the leaf. */
  readonly path: readonly PiEntry[];
  /** The id of each user-message entry, by its position in append order. */
  readonly userEntries: readonly string[];
}

export function readTranscript(data: { entries?: unknown; leafId?: unknown }): Transcript {
  const entries = (Array.isArray(data.entries) ? data.entries : []).filter(
    (entry): entry is PiEntry => typeof entry === "object" && entry !== null && typeof (entry as PiEntry).id === "string" && typeof (entry as PiEntry).type === "string",
  );
  const leafId = typeof data.leafId === "string" ? data.leafId : null;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: PiEntry[] = [];
  for (let current = leafId === null ? undefined : byId.get(leafId); current !== undefined; current = current.parentId === null ? undefined : byId.get(current.parentId)) {
    path.push(current);
  }
  path.reverse();
  return { entries, leafId, path, userEntries: entries.filter((entry) => isRole(entry, "user")).map((entry) => entry.id) };
}

/** One turn rebuilt from a transcript, with the entries that belong to it. */
export interface TranscriptTurn {
  readonly ordinal: number;
  readonly userEntryId: string;
  readonly entries: PiEntry[];
}

/**
 * The turns on the active branch. A user message starts a turn unless it is a
 * steer: one the session saw delivered as a steer (`steerOrdinals`), or, for
 * history the session did not see, one that follows a tool result (Pi hands
 * steers to the model between a tool's result and its next response, Pi docs
 * rpc-commands.md "steer"). A steer delivered right after a final answer
 * cannot be told from a new prompt in a stored file, so it shows as a turn.
 */
export function transcriptTurns(transcript: Transcript, steerOrdinals: ReadonlySet<number>): TranscriptTurn[] {
  const ordinals = new Map(transcript.userEntries.map((id, ordinal) => [id, ordinal]));
  const turns: TranscriptTurn[] = [];
  let previousMessage: PiEntry | undefined;
  for (const entry of transcript.path) {
    if (isRole(entry, "user")) {
      const ordinal = ordinals.get(entry.id)!;
      const afterTool = previousMessage !== undefined && (isRole(previousMessage, "toolResult") || previousMessage.message?.stopReason === "toolUse");
      const steer = turns.length > 0 && (steerOrdinals.has(ordinal) || afterTool);
      if (!steer) {
        turns.push({ ordinal, userEntryId: entry.id, entries: [entry] });
        previousMessage = entry;
        continue;
      }
    }
    turns.at(-1)?.entries.push(entry);
    if (entry.type === "message") previousMessage = entry;
  }
  return turns;
}

/** The turn and items of one rebuilt turn, with the ids live events gave them. */
export function snapshotTurn(threadId: string, cwd: string, rebuilt: TranscriptTurn): { turn: Turn; items: Item[] } {
  const native = turnNative(rebuilt.ordinal);
  const turnId = turnIdFor(threadId, native);
  const items: Item[] = [];
  const tools = new Map<string, Item>();
  let messageOrdinal = 0;
  let last: PiMessage | undefined;
  for (const entry of rebuilt.entries) {
    const message = entry.message;
    if (entry.type !== "message" || message === undefined) continue;
    if (message.role === "user") {
      const itemNative = messageNative(messageOrdinal);
      messageOrdinal += 1;
      items.push({ id: itemIdFor(turnId, itemNative), kind: "user_message", native: itemNative, status: "completed", turnId, text: messageText(message.content) });
    } else if (message.role === "assistant") {
      const ordinal = messageOrdinal;
      messageOrdinal += 1;
      last = message;
      const thinking = messageThinking(message.content);
      if (thinking !== "") {
        const itemNative = messageNative(ordinal, "thinking");
        items.push({ id: itemIdFor(turnId, itemNative), kind: "reasoning", native: itemNative, status: "completed", turnId, reasoning: thinking });
      }
      const text = messageText(message.content);
      if (text !== "") {
        const itemNative = messageNative(ordinal);
        items.push({ id: itemIdFor(turnId, itemNative), kind: "assistant_message", native: itemNative, status: "completed", turnId, text });
      }
      for (const call of messageToolCalls(message.content)) {
        const itemNative = toolNative(call.id);
        const item: Item = { id: itemIdFor(turnId, itemNative), native: itemNative, status: "completed", turnId, ...toolItemFields(call.name, call.arguments, cwd) };
        tools.set(call.id, item);
        items.push(item);
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const item = tools.get(message.toolCallId);
      if (item !== undefined) {
        const output = toolResultText(message);
        Object.assign(item, { output, status: message.isError === true ? "failed" : "completed", ...(item.tool === undefined ? {} : { tool: { ...item.tool, result: output } }) });
      }
    }
  }
  const status: Turn["status"] = last?.stopReason === "aborted" ? "interrupted" : last?.stopReason === "error" ? "failed" : "completed";
  const failure = status === "failed" ? failureFromError(typeof last?.errorMessage === "string" ? last.errorMessage : "Pi reported an error") : undefined;
  const turn: Turn = { id: turnId, threadId, native, origin: "user", status, ...(failure === undefined ? {} : { failure }) };
  return { turn, items };
}
