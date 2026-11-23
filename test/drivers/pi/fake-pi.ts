// A fake `pi` CLI that speaks Pi's RPC protocol (strict JSONL over stdio) the
// way `@earendil-works/pi-coding-agent` 1.6.0 documents it, for tests of the
// ARI Pi driver. test/drivers/pi/SOURCES.md lists the documents and source
// files each behaviour comes from. It never calls a model.
//
// One self-contained file that imports only Node built-ins, so it runs as its
// own process under Node's type stripping and can be compiled into a
// standalone executable that needs no Node.
//
// What it emulates:
// - `pi --version`, and `pi auth check --provider <p> --json --no-refresh`
//   (prints `{ status, provider, reason? }`, exit 0, 1 or 2).
// - `pi --mode rpc` with `--session-dir`, `--session <path|id>`,
//   `--fork <path|id>` (copies every entry into a new session file in the
//   current directory), `--model`, `--thinking`, `--api-key`,
//   `--append-system-prompt` and `--extension`.
// - Session files in Pi's JSONL format (header, then entries forming a tree by
//   `parentId`). A new session's file is written only once it holds a user or
//   assistant message; `--session <path>` of a missing file starts a new
//   session at that path, as Pi does.
// - RPC commands the driver uses (`prompt`, `steer`, `abort`, `get_state`,
//   `get_entries`, `get_messages`, `get_available_models`, `set_model`,
//   `set_thinking_level`, `compact`, `clear_queue`, `get_commands`) and the
//   events of a run (`agent_start` ... `agent_settled`).
// - The ARI bridge extension (src/drivers/pi/bridge.ts) when `--extension`
//   names it: its `setStatus` with the working directory, its approval
//   dialogs, its `/ari-rewind` and `/ari-context` commands and its MCP
//   registrations. Real Pi runs the bridge itself; this fake does what the
//   bridge would do, and test/drivers/pi/bridge.test.ts checks the bridge
//   against the same expectations.
//
// The fake does nothing on its own. A test drives it over a Node IPC channel
// (the conformance kit's puppet: `say`, `runTool`, `requestApproval`,
// `complete`, ...). Without an IPC channel it runs in autopilot: each prompt
// asks one approval when the bridge's mode needs it, then answers and
// completes.
//
// Control flags only this fake knows (a test appends them; real Pi has none):
// `--fake-ambient-auth=<authenticated|unauthenticated|unknown|unavailable>` and
// `--fake-version=<x.y.z>`.

import * as fs from "node:fs";
import * as path from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Record = { [key: string]: Json };

const FAKE_VERSION_DEFAULT = "1.6.0";
const BRIDGE_FILE_NAME = "ari-pi-bridge.ts";
const BRIDGE_SETTINGS_VARIABLE = "ARI_PI_BRIDGE";

// ---------------------------------------------------------------------------
// Arguments

interface Arguments {
  readonly positional: string[];
  readonly flags: Map<string, string[]>;
  readonly switches: Set<string>;
}

const VALUE_FLAGS = new Set([
  "--mode",
  "--session-dir",
  "--session",
  "--session-id",
  "--fork",
  "--model",
  "--provider",
  "--thinking",
  "--api-key",
  "--append-system-prompt",
  "--system-prompt",
  "--extension",
  "-e",
  "--name",
  "-n",
  "--tools",
  "-t",
]);

function parseArguments(argv: readonly string[]): Arguments {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const equals = argument.indexOf("=");
    if (argument.startsWith("--fake-") && equals > 0) {
      flags.set(argument.slice(0, equals), [argument.slice(equals + 1)]);
      continue;
    }
    if (VALUE_FLAGS.has(argument)) {
      const value = argv[index + 1] ?? "";
      index += 1;
      const name = argument === "-e" ? "--extension" : argument === "-n" ? "--name" : argument === "-t" ? "--tools" : argument;
      flags.set(name, [...(flags.get(name) ?? []), value]);
      continue;
    }
    if (argument.startsWith("-")) switches.add(argument);
    else positional.push(argument);
  }
  return { positional, flags, switches };
}

const args = parseArguments(process.argv.slice(2));
const flag = (name: string): string | undefined => args.flags.get(name)?.at(-1);
const fakeVersion = flag("--fake-version") ?? FAKE_VERSION_DEFAULT;
const ambientAuth = flag("--fake-ambient-auth") ?? "authenticated";

// ---------------------------------------------------------------------------
// Puppet channel (Node IPC). Absent when the fake runs without one.

type PuppetSend = (message: unknown) => void;
const puppetSend: PuppetSend | undefined = typeof process.send === "function" ? (message) => process.send!(message as never) : undefined;

function tell(event: { [key: string]: unknown }): void {
  puppetSend?.(event);
}

// ---------------------------------------------------------------------------
// Models

interface FakeModel {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly input: string[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const MODELS: FakeModel[] = [
  { id: "fake-small", name: "Fake small", api: "fake-messages", provider: "fake", baseUrl: "http://127.0.0.1:9", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 8192, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } },
  { id: "fake-large", name: "Fake large", api: "fake-messages", provider: "fake", baseUrl: "http://127.0.0.1:9", reasoning: true, input: ["text", "image"], contextWindow: 512000, maxTokens: 16384, cost: { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 3 } },
];

function findModel(pattern: string): FakeModel | undefined {
  const [provider, id] = pattern.includes("/") ? [pattern.slice(0, pattern.indexOf("/")), pattern.slice(pattern.indexOf("/") + 1)] : [undefined, pattern];
  return MODELS.find((model) => model.id === id && (provider === undefined || model.provider === provider));
}

function modelRecord(model: FakeModel): Record {
  return { ...model, input: [...model.input], cost: { ...model.cost } };
}

function zeroUsage(): Record {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function usage(output: number): Record {
  return { input: 100, output, cacheRead: 0, cacheWrite: 0, totalTokens: 100 + output, cost: { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0003 } };
}

// ---------------------------------------------------------------------------
// One-shot commands

if (args.switches.has("--version") || args.switches.has("-v")) {
  process.stdout.write(`${fakeVersion}\n`);
  process.exit(0);
}

if (args.positional[0] === "auth" && args.positional[1] === "check") {
  const provider = flag("--provider") ?? (flag("--model") === undefined ? undefined : findModel(flag("--model")!)?.provider);
  if (provider === undefined) {
    process.stderr.write("Error: Unable to resolve an auth provider\n");
    process.exit(2);
  }
  if (ambientAuth === "unavailable") {
    // A check that cannot answer: no result on stdout, an error on stderr.
    process.stderr.write("Error: Failed to resolve credential\n");
    process.exit(1);
  }
  const result =
    ambientAuth === "authenticated"
      ? { status: "ready", provider, authType: "api_key" }
      : ambientAuth === "unauthenticated"
        ? { status: "not_ready", provider, reason: "credentials_not_configured" }
        : { status: "invalid", provider, reason: "invalid_state" };
  process.stdout.write(`${args.switches.has("--json") ? JSON.stringify(result) : result.status}\n`);
  process.exit(result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2);
}

if (flag("--mode") !== "rpc") {
  process.stderr.write("fake pi: only --version, auth check and --mode rpc are emulated\n");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Session files

interface Entry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

interface Header {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

function readJsonl(file: string): Array<{ [key: string]: unknown }> {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { [key: string]: unknown });
}

/** The next session number in `dir`: claimed atomically with an exclusive create, so concurrent fakes never share one. */
function nextSessionNumber(dir: string): number {
  fs.mkdirSync(dir, { recursive: true });
  for (let number = 1; ; number += 1) {
    try {
      fs.closeSync(fs.openSync(path.join(dir, `.fake-pi-session-${number}`), "wx"));
      return number;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }
  }
}

function sessionIdFor(number: number): string {
  return `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
}

class SessionFile {
  header: Header;
  entries: Entry[];
  leafId: string | null;
  /** The session file; empty for an in-memory session (`--no-session`). */
  file: string;
  flushed: boolean;
  /** Ids of user entries that `prompt` created (not steers): the fake's own record, kept beside the file. */
  prompts: Set<string>;

  constructor(header: Header, entries: Entry[], file: string, flushed: boolean, prompts: Set<string>) {
    this.header = header;
    this.entries = entries;
    this.leafId = entries.at(-1)?.id ?? null;
    this.file = file;
    this.flushed = flushed;
    this.prompts = prompts;
  }

  static create(dir: string, cwd: string): SessionFile {
    const id = sessionIdFor(nextSessionNumber(dir));
    const timestamp = new Date().toISOString();
    const file = path.join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
    return new SessionFile({ type: "session", version: 3, id, timestamp, cwd }, [], file, false, new Set());
  }

  /** `--no-session`: nothing is ever written. */
  static inMemory(cwd: string): SessionFile {
    return new SessionFile({ type: "session", version: 3, id: sessionIdFor(0), timestamp: new Date().toISOString(), cwd }, [], "", false, new Set());
  }

  static open(file: string, dir: string, cwd: string): SessionFile {
    if (!fs.existsSync(file)) {
      // Pi: a missing explicit path starts a new session that will be written there.
      const created = SessionFile.create(dir, cwd);
      created.file = file;
      return created;
    }
    const lines = readJsonl(file);
    const header = lines.find((line) => line["type"] === "session") as unknown as Header | undefined;
    if (header === undefined) throw new Error(`Session file is not a valid pi session: ${file}`);
    const entries = lines.filter((line) => line["type"] !== "session") as unknown as Entry[];
    return new SessionFile(header, entries, file, true, readPrompts(file));
  }

  static fork(sourceFile: string, dir: string, cwd: string): SessionFile {
    const source = SessionFile.open(sourceFile, dir, cwd);
    if (!source.flushed) throw new Error(`Cannot fork: source session file is empty or invalid: ${sourceFile}`);
    const id = sessionIdFor(nextSessionNumber(dir));
    const timestamp = new Date().toISOString();
    const file = path.join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
    const header: Header = { type: "session", version: 3, id, timestamp, cwd, parentSession: path.resolve(sourceFile) };
    const fork = new SessionFile(header, source.entries.map((entry) => ({ ...entry })), file, true, new Set(source.prompts));
    fs.writeFileSync(file, [header, ...fork.entries].map((line) => `${JSON.stringify(line)}\n`).join(""), { flag: "wx" });
    fork.savePrompts();
    return fork;
  }

  get hasConversation(): boolean {
    return this.entries.some((entry) => entry.type === "message" && ["user", "assistant"].includes(String((entry["message"] as { role?: unknown }).role)));
  }

  append(fields: { type: string; [key: string]: unknown }): Entry {
    const entry: Entry = { ...fields, id: (this.entries.length + 1).toString(16).padStart(8, "0"), parentId: this.leafId, timestamp: new Date().toISOString() };
    this.entries.push(entry);
    this.leafId = entry.id;
    this.persist(entry);
    return entry;
  }

  persist(entry: Entry): void {
    if (this.file === "") return;
    if (!this.flushed) {
      if (!this.hasConversation) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, [this.header, ...this.entries].map((line) => `${JSON.stringify(line)}\n`).join(""), { flag: "wx" });
      this.flushed = true;
      this.savePrompts();
      return;
    }
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }

  savePrompts(): void {
    if (this.flushed) fs.writeFileSync(`${this.file}.fake-pi.json`, JSON.stringify({ prompts: [...this.prompts] }));
  }

  byId(id: string): Entry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  /** The entries from the root to the leaf: the active branch. */
  activePath(): Entry[] {
    const chain: Entry[] = [];
    let current = this.leafId === null ? undefined : this.byId(this.leafId);
    while (current !== undefined) {
      chain.push(current);
      current = current.parentId === null ? undefined : this.byId(current.parentId);
    }
    return chain.reverse();
  }

  messages(): Json[] {
    return this.activePath().flatMap((entry) => (entry.type === "message" ? [entry["message"] as Json] : []));
  }
}

function readPrompts(file: string): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(`${file}.fake-pi.json`, "utf8")) as { prompts?: string[] };
    return new Set(parsed.prompts ?? []);
  } catch {
    return new Set();
  }
}

function resolveSessionArgument(argument: string, dir: string): string | undefined {
  if (argument.includes("/") || argument.includes("\\") || argument.endsWith(".jsonl")) return path.resolve(argument);
  if (!fs.existsSync(dir)) return undefined;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const header = readJsonl(path.join(dir, name)).find((line) => line["type"] === "session");
    if (header !== undefined && String(header["id"]).startsWith(argument)) return path.join(dir, name);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Startup

const cwd = process.cwd();
// Pi's default is ~/.pi/agent/sessions. The fake never guesses a home: without HOME or --session-dir it refuses.
const homeDirectory = process.env["HOME"];
if (flag("--session-dir") === undefined && (homeDirectory === undefined || homeDirectory === "") && !args.switches.has("--no-session")) {
  process.stderr.write("fake pi: give --session-dir or HOME\n");
  process.exit(2);
}
const sessionDir = path.resolve(flag("--session-dir") ?? path.join(homeDirectory ?? cwd, ".pi", "agent", "sessions"));
let model = findModel(flag("--model") ?? "fake/fake-small");
if (model === undefined) {
  process.stderr.write(`Error: Model not found: ${flag("--model")}\n`);
  process.exit(1);
}
let thinkingLevel = flag("--thinking") ?? "medium";
const appendedSystemPrompts = args.flags.get("--append-system-prompt") ?? [];

let session: SessionFile;
try {
  if (args.switches.has("--no-session")) {
    session = SessionFile.inMemory(cwd);
  } else if (flag("--fork") !== undefined) {
    const source = resolveSessionArgument(flag("--fork")!, sessionDir);
    if (source === undefined) {
      process.stderr.write(`No session found matching '${flag("--fork")}'\n`);
      process.exit(1);
    }
    session = SessionFile.fork(source, sessionDir, cwd);
  } else if (flag("--session") !== undefined) {
    const file = resolveSessionArgument(flag("--session")!, sessionDir);
    if (file === undefined) {
      process.stderr.write(`No session found matching '${flag("--session")}'\n`);
      process.exit(1);
    }
    session = SessionFile.open(file, sessionDir, cwd);
  } else {
    session = SessionFile.create(sessionDir, cwd);
  }
} catch (error) {
  process.stderr.write(`Error: ${(error as Error).message}\n`);
  process.exit(1);
}

/** The ARI bridge, when `--extension` names its file: the fake then does what the bridge does. */
interface BridgeState {
  readonly mode: string;
  /** The MCP servers registered through `/ari-mcp`, by name. */
  readonly mcpServers: string[];
}
const bridgePath = (args.flags.get("--extension") ?? []).find((file) => path.basename(file) === BRIDGE_FILE_NAME && fs.existsSync(file));
const bridge: BridgeState | undefined = (() => {
  if (bridgePath === undefined) return undefined;
  const text = process.env[BRIDGE_SETTINGS_VARIABLE];
  delete process.env[BRIDGE_SETTINGS_VARIABLE];
  try {
    const parsed = JSON.parse(text ?? "") as { mode?: string };
    return { mode: parsed.mode ?? "approval_required", mcpServers: [] };
  } catch {
    return { mode: "approval_required", mcpServers: [] };
  }
})();

tell({ event: "started", pid: process.pid, cwd, argv: process.argv.slice(2), bridge: bridge ?? null, sessionFile: session.file });

// ---------------------------------------------------------------------------
// Output

let heldFrames: Record[] | undefined;

function writeFrame(record: Record): void {
  tell({ event: "frame", direction: "out", record });
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/** Sends a session event, or holds it back while a completion is held. */
function emit(record: Record): void {
  if (heldFrames !== undefined) heldFrames.push(record);
  else writeFrame(record);
}

function respond(id: string | undefined, command: string, data?: Json): void {
  writeFrame({ ...(id === undefined ? {} : { id }), type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
}

function fail(id: string | undefined, command: string, error: string): void {
  writeFrame({ ...(id === undefined ? {} : { id }), type: "response", command, success: false, error });
}

let uiCounter = 0;
function uiId(): string {
  uiCounter += 1;
  return `ui-${session.header.id.slice(-6)}-${uiCounter}`;
}

if (bridge !== undefined) {
  // The bridge's session_start handler.
  writeFrame({ type: "extension_ui_request", id: uiId(), method: "setStatus", statusKey: "ari", statusText: JSON.stringify({ cwd }) });
}

// ---------------------------------------------------------------------------
// Runs

interface PendingDialog {
  readonly method: string;
  readonly replies: string[];
  readonly waiters: Array<(reply: string) => void>;
}

interface Run {
  readonly id: number;
  readonly prompt: string;
  /** True between a `turn_start` and its `turn_end`. */
  llmTurnOpen: boolean;
  /** The messages the run added, for `agent_end`. */
  readonly messages: Json[];
  /** The last message of the run was a finished assistant response without tool calls. */
  endsWithAnswer: boolean;
  /** Steers delivered to this run, and puppet calls waiting for one. */
  readonly steers: string[];
  readonly steerWaiters: Array<(text: string) => void>;
  stop: "cancel" | "exit" | undefined;
  readonly stopWaiters: Array<(kind: "cancel" | "exit") => void>;
  abortCommandId: string | undefined | null;
  ended: boolean;
}

let run: Run | undefined;
let runCounter = 0;
const steeringQueue: string[] = [];
const followUpQueue: string[] = [];
let pendingContext: string[] = [];
const dialogs = new Map<string, PendingDialog>();
let toolCounter = 0;

function stateRecord(): Record {
  return {
    model: modelRecord(model!),
    thinkingLevel,
    isStreaming: run !== undefined && !run.ended,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    ...(session.file === "" ? {} : { sessionFile: session.file }),
    sessionId: session.header.id,
    autoCompactionEnabled: true,
    messageCount: session.messages().length,
    pendingMessageCount: steeringQueue.length + followUpQueue.length,
  };
}

function emitQueue(): void {
  emit({ type: "queue_update", steering: [...steeringQueue], followUp: [...followUpQueue] });
}

function appendMessage(message: Json): void {
  if ((message as Record)["role"] === "user" && !session.entries.some((entry) => entry.type === "message")) {
    // Pi persists the system prompt's sections with the first request of a session.
    session.append({ type: "message", message: { role: "system", content: "", sections: { preamble: "You are the fake Pi agent.", cwd, ...(appendedSystemPrompts.length === 0 ? {} : { append: appendedSystemPrompts.join("\n\n") }) }, timestamp: Date.now() } });
  }
  session.append({ type: "message", message });
}

function userMessage(text: string): Record {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(content: Json[], stopReason: string, extra: Record = {}): Record {
  return { role: "assistant", content, api: model!.api, provider: model!.provider, model: model!.id, usage: usage(content.length * 5), stopReason, timestamp: Date.now(), ...extra };
}

function openLlmTurn(current: Run): void {
  if (current.llmTurnOpen) return;
  current.llmTurnOpen = true;
  emit({ type: "turn_start" });
  // Pi hands queued steering to the model before its next response.
  deliverSteering(current);
}

function closeLlmTurn(current: Run, message: Json, toolResults: Json[]): void {
  emit({ type: "turn_end", message, toolResults });
  current.llmTurnOpen = false;
}

function deliverSteering(current: Run): void {
  while (steeringQueue.length > 0) {
    const text = steeringQueue.shift()!;
    emitQueue();
    const message = userMessage(text);
    emit({ type: "message_start", message });
    emit({ type: "message_end", message });
    appendMessage(message);
    current.messages.push(message);
    current.endsWithAnswer = false;
    current.steers.push(text);
    current.steerWaiters.shift()?.(text);
  }
}

function startRun(text: string, commandId: string | undefined): void {
  runCounter += 1;
  const current: Run = {
    id: runCounter,
    prompt: text,
    llmTurnOpen: false,
    messages: [],
    endsWithAnswer: false,
    steers: [],
    steerWaiters: [],
    stop: undefined,
    stopWaiters: [],
    abortCommandId: null,
    ended: false,
  };
  run = current;
  respond(commandId, "prompt", { disposition: "started" });
  emit({ type: "agent_start" });
  current.llmTurnOpen = true;
  emit({ type: "turn_start" });
  const message = userMessage(text);
  emit({ type: "message_start", message });
  emit({ type: "message_end", message });
  appendMessage(message);
  session.prompts.add(session.leafId!);
  session.savePrompts();
  current.messages.push(message);
  pendingContext = [];
  deliverSteering(current);
  tell({ event: "turn", runId: current.id, prompt: text });
  if (puppetSend === undefined) void autopilot(current);
}

/** Streams one assistant message of text and ends it, as one model response. */
function say(current: Run, text: string): void {
  openLlmTurn(current);
  const usageNow = usage(text.length);
  emit({ type: "message_start", message: assistantMessage([], "pending") });
  emit({ type: "message_update", usage: usageNow, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  const middle = Math.ceil(text.length / 2);
  for (const chunk of [text.slice(0, middle), text.slice(middle)]) {
    if (chunk !== "") emit({ type: "message_update", usage: usageNow, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } });
  }
  emit({ type: "message_update", usage: usageNow, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } });
  const message = assistantMessage([{ type: "text", text }], "stop");
  emit({ type: "message_end", message });
  appendMessage(message);
  current.messages.push(message);
  closeLlmTurn(current, message, []);
  current.endsWithAnswer = true;
}

interface ToolSpec {
  readonly name: string;
  readonly input: Json;
  readonly output: string;
  readonly path?: string;
}

function runTool(current: Run, tool: ToolSpec): void {
  openLlmTurn(current);
  toolCounter += 1;
  const toolCallId = `call_${session.header.id.slice(-6)}_${runCounter}_${toolCounter}`;
  const argsRecord: Record = { ...(typeof tool.input === "object" && tool.input !== null && !Array.isArray(tool.input) ? (tool.input as Record) : { input: tool.input }) };
  if (tool.path !== undefined) argsRecord["path"] = path.join(cwd, tool.path);
  const toolCall = { type: "toolCall", id: toolCallId, name: tool.name, arguments: argsRecord };
  const usageNow = usage(10);
  emit({ type: "message_start", message: assistantMessage([], "pending") });
  emit({ type: "message_update", usage: usageNow, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: toolCallId, toolName: tool.name } });
  emit({ type: "message_update", usage: usageNow, assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall } });
  const message = assistantMessage([toolCall], "toolUse");
  emit({ type: "message_end", message });
  appendMessage(message);
  current.messages.push(message);
  emit({ type: "tool_execution_start", toolCallId, toolName: tool.name, args: argsRecord });
  const result = { content: [{ type: "text", text: tool.output }], details: {} };
  emit({ type: "tool_execution_end", toolCallId, toolName: tool.name, result, isError: false, durationMs: 1 });
  const toolResult = { role: "toolResult", toolCallId, toolName: tool.name, content: [{ type: "text", text: tool.output }], isError: false, timestamp: Date.now() };
  emit({ type: "message_start", message: toolResult });
  emit({ type: "message_end", message: toolResult });
  appendMessage(toolResult);
  current.messages.push(toolResult);
  closeLlmTurn(current, message, [toolResult]);
  current.endsWithAnswer = false;
}

/** Ends a run: a final answer when the last message needs one, then `agent_end` and `agent_settled`. */
function finishRun(current: Run, last: Record | undefined, aborted: boolean): void {
  if (last !== undefined) {
    openLlmTurn(current);
    emit({ type: "message_start", message: assistantMessage([], "pending") });
    emit({ type: "message_end", message: last });
    appendMessage(last);
    current.messages.push(last);
    closeLlmTurn(current, last, []);
  }
  current.ended = true;
  if (run === current) run = undefined;
  emit({ type: "agent_end", messages: current.messages, willRetry: false });
  emit({ type: "agent_settled", aborted });
}

function complete(current: Run): void {
  finishRun(current, current.endsWithAnswer ? undefined : assistantMessage([], "stop"), false);
}

function failRun(current: Run, failure: { kind: string; message: string; resetAt?: string }): void {
  const errorMessage =
    failure.kind === "usage_limit"
      ? `429 ${JSON.stringify({ type: "error", error: { type: "usage_limit_reached", message: failure.message, resets_at: Math.floor(Date.parse(failure.resetAt ?? "") / 1000) } })}`
      : failure.message;
  finishRun(current, assistantMessage([], "error", { errorMessage }), false);
}

function finishCancelled(current: Run): void {
  finishRun(current, assistantMessage([], "aborted", { errorMessage: "Request was aborted" }), true);
  if (current.abortCommandId !== null) respond(current.abortCommandId, "abort");
}

/** The bridge's tool gate: an approval dialog, or (under full access) no dialog and the narrowest accepting option. */
interface ApprovalSpec {
  readonly kind: string;
  readonly command?: string[];
  readonly path?: string;
  readonly options: Array<{ optionId: string; label: string; decision: string }>;
}

const SCOPES: { [decision: string]: string | undefined } = { accept: "once", accept_for_session: "session", accept_always: "session" };
const SCOPE_RANK: { [scope: string]: number } = { once: 0, session: 1, project: 2, global: 3 };

function requestApproval(approval: ApprovalSpec): string {
  const id = uiId();
  const dialog: PendingDialog = { method: "select", replies: [], waiters: [] };
  dialogs.set(id, dialog);
  const accepting = approval.options.filter((option) => SCOPES[option.decision] !== undefined);
  if (bridge?.mode === "full_access") {
    // The bridge asks nothing under full access: the tool runs as if allowed once.
    const narrowest = [...accepting].sort((a, b) => SCOPE_RANK[SCOPES[a.decision]!]! - SCOPE_RANK[SCOPES[b.decision]!]!)[0];
    if (narrowest !== undefined) dialog.replies.push(narrowest.optionId);
    return id;
  }
  const tool = approval.kind === "command" ? "bash" : "edit";
  const input = approval.kind === "command" ? { command: (approval.command ?? []).join(" ") } : { path: path.join(cwd, approval.path ?? "") };
  const options = approval.options.map((option) => ({ id: option.optionId, label: option.label, decision: option.decision, ...(SCOPES[option.decision] === undefined ? {} : { scope: SCOPES[option.decision] }) }));
  const title = JSON.stringify({ ari: "approval", kind: approval.kind === "command" ? "command" : "file_change", tool, input, options });
  emit({ type: "extension_ui_request", id, method: "select", title, options: options.map((option) => option.id) });
  return id;
}

/** A dialog some other extension opens, for tests of how the driver maps them. */
function extensionDialog(request: Record): string {
  const id = uiId();
  dialogs.set(id, { method: String(request["method"]), replies: [], waiters: [] });
  emit({ ...request, type: "extension_ui_request", id });
  return id;
}

function nextReply(id: string): Promise<string> {
  const dialog = dialogs.get(id);
  if (dialog === undefined) return Promise.reject(new Error(`no dialog ${id}`));
  if (dialog.replies.length > 0) return Promise.resolve(dialog.replies[0]!);
  return new Promise((resolve) => dialog.waiters.push(resolve));
}

async function autopilot(current: Run): Promise<void> {
  if (bridge !== undefined && ["approval_required", "auto_accept_edits", "read_only"].includes(bridge.mode)) {
    const id = requestApproval({
      kind: "command",
      command: ["echo", "hello"],
      options: [
        { optionId: "allow-once", label: "Allow once", decision: "accept" },
        { optionId: "decline", label: "Decline", decision: "decline" },
      ],
    });
    await nextReply(id);
  }
  say(current, `Hello from the fake Pi agent. You said: ${current.prompt}`);
  complete(current);
}

// ---------------------------------------------------------------------------
// Commands

function rewind(entryId: string): void {
  const target = session.byId(entryId);
  if (target === undefined) throw new Error(`Entry ${entryId} not found`);
  const isUser = target.type === "message" && (target["message"] as { role?: unknown }).role === "user";
  session.leafId = isUser ? target.parentId : target.id;
  // navigateTree with a label persists the move: the label entry becomes the leaf.
  session.append({ type: "label", targetId: entryId, label: "ari-rewind" });
}

function handleCommand(command: { [key: string]: unknown }): void {
  const id = typeof command["id"] === "string" ? command["id"] : undefined;
  const type = String(command["type"]);
  switch (type) {
    case "prompt": {
      const message = String(command["message"] ?? "");
      if (bridge !== undefined && message.startsWith("/ari-rewind ")) {
        try {
          rewind(message.slice("/ari-rewind ".length).trim());
        } catch (error) {
          // Pi reports a failing extension command as an extension error, and the prompt as handled.
          writeFrame({ type: "extension_error", extensionPath: bridgePath!, event: "command:ari-rewind", error: (error as Error).message });
        }
        respond(id, "prompt", { disposition: "handled" });
        return;
      }
      if (bridge !== undefined && message.startsWith("/ari-mcp ")) {
        const parsed = JSON.parse(message.slice("/ari-mcp ".length)) as { servers?: Array<{ name: string; config: unknown }> };
        for (const server of parsed.servers ?? []) if (!bridge.mcpServers.includes(server.name)) bridge.mcpServers.push(server.name);
        tell({ event: "mcp", servers: parsed.servers ?? [] });
        respond(id, "prompt", { disposition: "handled" });
        return;
      }
      if (bridge !== undefined && message.startsWith("/ari-context ")) {
        const parsed = JSON.parse(message.slice("/ari-context ".length)) as { text?: string };
        if (typeof parsed.text === "string" && parsed.text !== "") pendingContext.push(parsed.text);
        tell({ event: "context", text: parsed.text ?? "" });
        respond(id, "prompt", { disposition: "handled" });
        return;
      }
      if (run !== undefined && !run.ended) {
        const behavior = command["streamingBehavior"];
        if (behavior === "steer") steeringQueue.push(message);
        else if (behavior === "followUp") followUpQueue.push(message);
        else {
          fail(id, "prompt", "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
          return;
        }
        emitQueue();
        respond(id, "prompt", { disposition: "queued" });
        if (behavior === "steer") deliverSteering(run);
        return;
      }
      startRun(message, id);
      return;
    }
    case "steer":
    case "follow_up": {
      const message = String(command["message"] ?? "");
      if (type === "steer") steeringQueue.push(message);
      else followUpQueue.push(message);
      emitQueue();
      respond(id, type, { disposition: "queued" });
      // While a run streams, Pi hands the steer to the model before its next response.
      if (type === "steer" && run !== undefined && !run.ended) deliverSteering(run);
      return;
    }
    case "abort": {
      const current = run;
      if (current === undefined || current.ended) {
        respond(id, "abort");
        return;
      }
      // Pi answers abort once the session is idle again.
      current.abortCommandId = id ?? null;
      current.stop = "cancel";
      for (const waiter of current.stopWaiters.splice(0)) waiter("cancel");
      return;
    }
    case "clear_queue": {
      const data = { steering: steeringQueue.splice(0), followUp: followUpQueue.splice(0) };
      emitQueue();
      respond(id, "clear_queue", data);
      return;
    }
    case "get_state":
      respond(id, "get_state", stateRecord());
      return;
    case "get_messages":
      respond(id, "get_messages", { messages: session.messages() });
      return;
    case "get_entries": {
      const since = command["since"];
      let entries = session.entries;
      if (typeof since === "string") {
        const index = entries.findIndex((entry) => entry.id === since);
        if (index === -1) {
          fail(id, "get_entries", `Entry ${since} not found`);
          return;
        }
        entries = entries.slice(index + 1);
      }
      respond(id, "get_entries", { entries: entries as unknown as Json[], leafId: session.leafId });
      return;
    }
    case "get_available_models":
      respond(id, "get_available_models", { models: MODELS.map(modelRecord) });
      return;
    case "set_model": {
      const found = MODELS.find((candidate) => candidate.provider === command["provider"] && candidate.id === command["modelId"]);
      if (found === undefined) {
        fail(id, "set_model", `Model not found: ${String(command["provider"])}/${String(command["modelId"])}`);
        return;
      }
      model = found;
      session.append({ type: "model_change", provider: found.provider, modelId: found.id });
      respond(id, "set_model", modelRecord(found));
      return;
    }
    case "set_thinking_level": {
      thinkingLevel = String(command["level"]);
      session.append({ type: "thinking_level_change", thinkingLevel });
      emit({ type: "thinking_level_changed", level: thinkingLevel });
      respond(id, "set_thinking_level");
      return;
    }
    case "compact": {
      if (run !== undefined && !run.ended) {
        fail(id, "compact", "Cannot compact while the agent is running");
        return;
      }
      if (session.messages().length === 0) {
        fail(id, "compact", "Nothing to compact");
        return;
      }
      emit({ type: "compaction_start", reason: "manual" });
      const firstKeptEntryId = session.leafId!;
      const result = { summary: "The fake agent summarized the conversation.", firstKeptEntryId, tokensBefore: 1200, estimatedTokensAfter: 300, details: {} };
      session.append({ type: "compaction", summary: result.summary, firstKeptEntryId, tokensBefore: result.tokensBefore });
      emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
      respond(id, "compact", result);
      return;
    }
    case "set_session_name": {
      session.append({ type: "session_info", name: String(command["name"] ?? "") });
      emit({ type: "session_info_changed", name: String(command["name"] ?? "") });
      respond(id, "set_session_name");
      return;
    }
    case "get_commands": {
      const commands =
        bridge === undefined
          ? []
          : ["ari-mcp", "ari-rewind", "ari-context"].map((name) => ({ name, description: `ARI bridge command ${name}`, source: "extension", sourceInfo: { path: bridgePath!, source: "cli", scope: "temporary", origin: "top-level" } }));
      respond(id, "get_commands", { commands });
      return;
    }
    case "extension_ui_response": {
      const dialog = typeof command["id"] === "string" ? dialogs.get(command["id"]) : undefined;
      if (dialog === undefined) return;
      const reply = command["cancelled"] === true ? "cancelled" : typeof command["value"] === "string" ? command["value"] : command["confirmed"] === true ? "confirmed" : "unconfirmed";
      dialog.replies.push(reply);
      for (const waiter of dialog.waiters.splice(0)) waiter(reply);
      return;
    }
    default:
      fail(id, type, `Unknown command: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Strict JSONL reader: split on LF only, drop a trailing CR.

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffered += chunk;
  let newline = buffered.indexOf("\n");
  while (newline !== -1) {
    let line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim() !== "") {
      let command: { [key: string]: unknown };
      try {
        command = JSON.parse(line) as { [key: string]: unknown };
      } catch (error) {
        writeFrame({ type: "response", command: "parse", success: false, error: `Failed to parse command: ${(error as Error).message}` });
        newline = buffered.indexOf("\n");
        continue;
      }
      tell({ event: "frame", direction: "in", record: command });
      try {
        handleCommand(command);
      } catch (error) {
        fail(typeof command["id"] === "string" ? command["id"] : undefined, String(command["type"]), (error as Error).message);
      }
    }
    newline = buffered.indexOf("\n");
  }
});

function shutdown(code: number, stop: "exit"): void {
  if (run !== undefined) for (const waiter of run.stopWaiters.splice(0)) waiter(stop);
  tell({ event: "exiting", code });
  process.exit(code);
}

process.stdin.on("end", () => shutdown(0, "exit"));
process.on("SIGTERM", () => shutdown(143, "exit"));
process.on("SIGHUP", () => shutdown(129, "exit"));

// ---------------------------------------------------------------------------
// The puppet: calls from the test over IPC.

function activeRun(runId: unknown): Run {
  if (run === undefined || run.id !== runId) throw new Error(`run ${String(runId)} is not active`);
  return run;
}

/** A run by id even when it ended natively but its end is held back. */
let heldRun: Run | undefined;

const puppet: { [method: string]: (...params: never[]) => unknown } = {
  say: (runId: number, text: string) => say(activeRun(runId), text),
  runTool: (runId: number, tool: ToolSpec) => runTool(activeRun(runId), tool),
  requestApproval: (runId: number, approval: ApprovalSpec) => {
    activeRun(runId);
    return requestApproval(approval);
  },
  extensionDialog: (runId: number, request: Record) => {
    activeRun(runId);
    return extensionDialog(request);
  },
  nextApprovalReply: (id: string) => nextReply(id),
  approvalReplies: (id: string) => [...(dialogs.get(id)?.replies ?? [])],
  nextSteer: (runId: number) => {
    const current = activeRun(runId);
    const delivered = current.steers.shift();
    if (delivered !== undefined) return delivered;
    return new Promise<string>((resolve) => current.steerWaiters.push(resolve));
  },
  complete: (runId: number) => complete(activeRun(runId)),
  holdCompletion: (runId: number) => {
    const current = activeRun(runId);
    heldFrames = [];
    heldRun = current;
    complete(current);
  },
  releaseCompletion: () => {
    const frames = heldFrames ?? [];
    heldFrames = undefined;
    heldRun = undefined;
    for (const frame of frames) writeFrame(frame);
  },
  fail: (runId: number, failure: { kind: string; message: string; resetAt?: string }) => failRun(activeRun(runId), failure),
  stopRequested: (runId: number) => {
    const current = run !== undefined && run.id === runId ? run : heldRun;
    if (current === undefined) throw new Error(`run ${runId} is not active`);
    if (current.stop !== undefined) return current.stop;
    return new Promise<"cancel" | "exit">((resolve) => current.stopWaiters.push(resolve));
  },
  finishCancelled: (runId: number) => finishCancelled(activeRun(runId)),
  exitProcess: () => {
    tell({ event: "exiting", code: 1 });
    process.exit(1);
  },
  /** What this process holds for a session file, or null when it holds another. */
  inspect: (file: string) => {
    if (session.file === "" || path.resolve(file) !== path.resolve(session.file)) return null;
    return {
      loaded: true,
      cwd: session.header.cwd,
      prompts: promptsOf(session),
      compactions: session.activePath().filter((entry) => entry.type === "compaction").length,
      injectedMessages: [],
      backgroundTasks: [],
      subagents: [],
    };
  },
  context: () => [...pendingContext],
  mcpServers: () => [...(bridge?.mcpServers ?? [])],
};

function promptsOf(file: SessionFile): string[] {
  return file
    .activePath()
    .filter((entry) => entry.type === "message" && file.prompts.has(entry.id))
    .map((entry) => String((entry["message"] as { content?: unknown }).content));
}

if (puppetSend !== undefined) {
  process.on("message", (message: { id: number; method: string; args: unknown[] }) => {
    const handler = puppet[message.method];
    void (async () => {
      try {
        if (handler === undefined) throw new Error(`unknown puppet method ${message.method}`);
        const result = await (handler as (...params: unknown[]) => unknown)(...message.args);
        if (message.id !== 0) puppetSend({ id: message.id, result: result ?? null });
      } catch (error) {
        if (message.id !== 0) puppetSend({ id: message.id, error: (error as Error).message });
      }
    })();
  });
}
