// A fake OpenCode: `opencode --version` and `opencode serve` for OpenCode
// 1.19.6 (1.x) or 2.1.2 (2.x), speaking each server's HTTP API on a loopback
// port. It imports no driver code. Its behaviour follows the pinned source
// (test/drivers/opencode/SOURCES.md lists each fact and where it comes from),
// and every request it receives and every response and event it sends is
// checked: requests and responses against the vendored OpenAPI document of
// its version, 1.x events against that document's `Event` schema, 2.x events
// against `OpenCodeEvent` of `@opencode/protocol` 2.1.2. Each mismatch is
// recorded in `world.violations`; tests assert there are none. The events and
// response bodies it builds are also typed by the pinned SDKs
// (`@opencode-ai/sdk` 1.19.6 `Event`, `Session`, `Message`, `Part`, ...;
// `@opencode/client` 2.1.2 `OpenCodeEvent`, `SessionInfo`, ...), so the type
// check rejects a shape the SDKs do not have.
//
// One `FakeWorld` is one machine's OpenCode database: sessions outlive any
// server process, and every fake server of a rig reads the same sessions. Each
// server keeps what OpenCode keeps in memory: its MCP entries per directory,
// its pending permission requests and questions, its 1.x "always" grants and
// its runs. Nothing happens on its own: a run waits for the puppet (the
// conformance kit's `NativeTurn`), which emits the events OpenCode would.

import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryProcess } from "../../../src/conformance/index.ts";
import type { FakeSpawnRequest, NativeApproval, NativeApprovalHandle, NativeFailure, NativeTool, NativeTurn } from "../../../src/conformance/index.ts";
import type { SpawnedProcess } from "../../../src/index.ts";
import { AsyncQueue } from "../../../src/conformance/util.ts";
import { OpenApiValidator } from "./openapi.ts";
import type { MatchedOperation } from "./openapi.ts";
import { v2EventChecker } from "./v2-events.ts";
import type * as V1 from "@opencode-ai/sdk/v2";
import type * as V2 from "@opencode/client";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VENDOR_SCHEMAS = path.resolve(HERE, "../../../vendor-schemas/opencode");

export type Generation = 1 | 2;
export const FAKE_VERSIONS: { readonly [generation in Generation]: string } = { 1: "1.19.6", 2: "2.1.2" };

type Json = { [key: string]: unknown };

// Every event the fake sends is typed by the pinned SDK of its generation.
type V1EventType = V1.Event["type"];
type V1Properties<T extends V1EventType> = Extract<V1.Event, { type: T }>["properties"];
type V2EventType = V2.OpenCodeEvent["type"];
type V2Data<T extends V2EventType> = Extract<V2.OpenCodeEvent, { type: T }>["data"];
type V1Error = NonNullable<V1.AssistantMessage["error"]>;
type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" };

/** OpenCode's wildcard match (1.x and 2.x `util/wildcard.ts`). */
export function wildcard(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(input.replaceAll("\\", "/"));
}

/** The last matching rule wins; no match asks (1.x `permission/index.ts`, 2.x `core/src/permission.ts` `evaluate`). */
export function evaluate(action: string, resource: string, ...rulesets: Rule[][]): Rule["effect"] {
  return rulesets.flat().findLast((rule) => wildcard(action, rule.action) && wildcard(resource, rule.resource))?.effect ?? "ask";
}

/**
 * The rules of OpenCode 1.19.6's `general` subagent (1.19.6 `agent/agent.ts`:
 * the defaults, then `todowrite: deny`; the external-directory allow list of
 * OpenCode's own directories is left out). A 1.x child session is evaluated
 * with these before its own rules.
 */
export const V1_GENERAL_AGENT_RULES: readonly Rule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "doom_loop", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "plan_enter", resource: "*", effect: "deny" },
  { action: "plan_exit", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "todowrite", resource: "*", effect: "deny" },
];

/**
 * A 1.x child session's own rules (1.19.6 `tool/task.ts` and
 * `agent/subagent-permissions.ts`): the parent session's deny and
 * `external_directory` rules, then a deny of `task` for a subagent whose agent
 * has no `task` rule. Nothing else of the parent's reaches the child.
 */
export function v1ChildRules(parent: readonly Rule[]): Rule[] {
  return [...parent.filter((rule) => rule.action === "external_directory" || rule.effect === "deny").map((rule) => ({ ...rule })), { action: "task", resource: "*", effect: "deny" }];
}

/** A 2.x message cursor (2.1.2 `server/src/handlers/message.ts`): the anchor message, the order, and the direction, as base64url JSON. */
interface MessageCursor {
  readonly id: string;
  readonly order: "asc" | "desc";
  readonly direction: "previous" | "next";
}

function encodeCursor(cursor: MessageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(input: string): MessageCursor {
  const value = JSON.parse(Buffer.from(input, "base64url").toString("utf8")) as { id?: unknown; order?: unknown; direction?: unknown };
  if (typeof value.id !== "string" || (value.order !== "asc" && value.order !== "desc") || (value.direction !== "previous" && value.direction !== "next")) throw new Error("not a cursor");
  return { id: value.id, order: value.order, direction: value.direction };
}

/** The 2.x default page of `GET /api/session/{id}/message` (2.1.2 `DefaultMessagesLimit`). */
export const V2_DEFAULT_MESSAGES_LIMIT = 50;

interface FakePart {
  readonly id: string;
  readonly kind: "text" | "reasoning";
  text: string;
  start: number;
  end?: number;
}

interface FakeTool {
  readonly id: string;
  readonly callId: string;
  readonly tool: string;
  readonly input: Json;
  status: "pending" | "running" | "completed" | "error";
  output?: string;
  start: number;
  end?: number;
}

interface FakeMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly created: number;
  completed?: number;
  text: string;
  steer: boolean;
  readonly parentId?: string;
  readonly content: Array<FakePart | FakeTool>;
  error?: { readonly v1: V1Error; readonly v2: V2.SessionStructuredError };
  finish?: "stop";
  system?: string;
}

export interface FakeSession {
  readonly id: string;
  readonly directory: string;
  readonly created: number;
  updated: number;
  title: string;
  readonly parentId?: string;
  rules: Rule[];
  messages: FakeMessage[];
  /** 1.x: a staged revert, applied by the next prompt or summary. */
  revert?: string;
  compactions: number;
  readonly instructions: Map<string, string>;
  model: { providerID: string; id: string };
  agent: string;
  readonly forkedFrom?: string;
  /** 2.x: where a fork's copy of its source ends (2.1.2 `SessionFork.Boundary`). */
  readonly forkBoundary?: { readonly type: "before" | "through"; readonly messageID: string };
}

/** What a 2.x `permission.evaluate` plugin hook sees (2.1.2 `core/src/permission.ts` `evaluateInput`); it may change the effect. */
export interface PermissionHookInput {
  readonly sessionId: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly effect: "allow" | "ask";
}

export interface Frame {
  readonly server: number;
  readonly direction: "request" | "response" | "event";
  readonly operation: string;
  readonly status?: number;
  readonly body?: unknown;
}

const MODEL = { providerID: "fake", id: "fake-small" } as const;

export class FakeWorld {
  readonly generation: Generation;
  readonly version: string;
  readonly validator: OpenApiValidator;
  readonly sessions = new Map<string, FakeSession>();
  readonly violations: string[] = [];
  readonly frames: Frame[] = [];
  readonly servers = new Set<FakeServer>();
  readonly turns = new AsyncQueue<FakeRun>();
  /** 2.x saved "always" grants, by directory (the project), as OpenCode keeps them in its database. */
  readonly saved = new Map<string, Rule[]>();
  /** A 2.x plugin's `permission.evaluate` hook, as a user's OpenCode config may install one; undefined keeps the effect. */
  permissionHook: ((input: PermissionHookInput) => "allow" | "ask" | "deny" | undefined) | undefined;
  /** Every `opencode` spawn: its arguments and environment. */
  readonly spawns: Array<{ readonly args: readonly string[]; readonly env: { readonly [name: string]: string }; readonly cwd?: string }> = [];
  #counter = 0;
  #serverCount = 0;
  #eventChecker: ((value: unknown) => string[]) | undefined;
  /** What `inspectSession` and the ext activity read: every session read, as the harness maps it. */
  readonly sessionReads: Array<{ readonly sessionId: string; readonly rules: Rule[] }> = [];

  constructor(generation: Generation) {
    this.generation = generation;
    this.version = FAKE_VERSIONS[generation];
    this.validator = new OpenApiValidator(path.join(VENDOR_SCHEMAS, this.version, "openapi.json"), `opencode-${this.version}`);
  }

  async ready(): Promise<void> {
    if (this.generation === 2) this.#eventChecker = await v2EventChecker();
  }

  nextId(prefix: string): string {
    this.#counter += 1;
    return `${prefix}_${this.#counter.toString(16).padStart(12, "0")}fake`;
  }

  nextServer(): number {
    this.#serverCount += 1;
    return this.#serverCount;
  }

  violation(text: string): void {
    this.violations.push(text);
  }

  checkEvent(event: unknown): void {
    const problems = this.generation === 1 ? this.validator.checkComponent("Event", event) : (this.#eventChecker?.(event) ?? ["the 2.x event checker was not loaded"]);
    for (const problem of problems) this.violation(`event ${String((event as Json)["type"])}: ${problem}`);
  }

  /** The history OpenCode shows for a session: a staged 1.x revert hides what it will remove. */
  visibleMessages(session: FakeSession): FakeMessage[] {
    if (session.revert === undefined) return session.messages;
    const cut = session.messages.findIndex((message) => message.id === session.revert);
    return cut === -1 ? session.messages : session.messages.slice(0, cut);
  }

  /** Applies a staged 1.x revert (`session/revert.ts` `cleanup`). */
  cleanup(session: FakeSession): void {
    if (session.revert === undefined) return;
    session.messages = this.visibleMessages(session);
    session.revert = undefined;
  }

  /** Which live server holds a session loaded. */
  loadedBy(sessionId: string): FakeServer | undefined {
    for (const server of this.servers) if (server.alive && server.known.has(sessionId)) return server;
    return undefined;
  }
}

interface Subscriber {
  readonly directory: string | undefined;
  readonly response: http.ServerResponse;
}

interface PendingPermission {
  readonly id: string;
  readonly sessionId: string;
  readonly action: string;
  readonly resources: string[];
  readonly always: string[];
  readonly run: FakeRun;
  readonly handle: FakeApprovalHandle;
}

interface PendingQuestion {
  readonly id: string;
  readonly sessionId: string;
  readonly run: FakeRun;
}

class FakeApprovalHandle implements NativeApprovalHandle {
  readonly nativeOptionIds: { [optionId: string]: string };
  readonly #kitIdFor: Map<string, string>;
  readonly #replies: string[] = [];
  readonly #waiters: Array<(reply: string) => void> = [];

  constructor(approval: NativeApproval) {
    // OpenCode's replies are `once`, `always` and `reject`; each kit option is the reply its decision means.
    this.nativeOptionIds = Object.fromEntries(approval.options.map((option) => [option.optionId, option.decision === "decline" ? "reject" : option.decision === "accept" ? "once" : "always"]));
    this.#kitIdFor = new Map(approval.options.map((option) => [this.nativeOptionIds[option.optionId]!, option.optionId]));
  }

  got(reply: string): void {
    const kitId = this.#kitIdFor.get(reply) ?? reply;
    this.#replies.push(kitId);
    this.#waiters.shift()?.(kitId);
  }

  nextReply(): Promise<string> {
    const index = this.#waiters.length;
    if (this.#replies.length > index) return Promise.resolve(this.#replies[index]!);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async replies(): Promise<readonly string[]> {
    return [...this.#replies];
  }
}

function httpDate(iso: string): string {
  return new Date(iso).toUTCString();
}

/** One run of the agent loop for one session, driven by the puppet. */
export class FakeRun implements NativeTurn {
  readonly prompt: string;
  readonly server: FakeServer;
  readonly session: FakeSession;
  readonly userMessageId: string;
  #assistant: FakeMessage | undefined;
  ended = false;
  #stop: ((how: "cancel" | "exit") => void) | undefined;
  #stopped: "cancel" | "exit" | undefined;
  readonly #steers = new AsyncQueue<string>();
  #held: Array<() => void> | undefined;

  constructor(server: FakeServer, session: FakeSession, prompt: string, userMessageId: string) {
    this.server = server;
    this.session = session;
    this.prompt = prompt;
    this.userMessageId = userMessageId;
  }

  get world(): FakeWorld {
    return this.server.world;
  }

  /** Emits a 1.x event now, or holds it while a completion is held back. */
  #v1<T extends V1EventType>(type: T, properties: V1Properties<T>): void {
    this.#later(() => this.server.publishV1(this.session, type, properties));
  }

  /** Emits a 2.x event now, or holds it while a completion is held back. */
  #v2<T extends V2EventType>(type: T, data: V2Data<T>, durable = false, created?: number): void {
    this.#later(() => this.server.publishV2(this.session, type, data, durable, created));
  }

  #later(send: () => void): void {
    if (this.#held !== undefined) this.#held.push(send);
    else send();
  }

  #assistantMessage(): FakeMessage {
    if (this.#assistant !== undefined) return this.#assistant;
    const now = Date.now();
    const message: FakeMessage = { id: this.world.nextId("msg"), role: "assistant", created: now, text: "", steer: false, parentId: this.userMessageId, content: [] };
    this.session.messages.push(message);
    this.#assistant = message;
    if (this.world.generation === 1) this.#v1("message.updated", { sessionID: this.session.id, info: this.server.v1Message(this.session, message) });
    else this.#v2("session.step.started", { sessionID: this.session.id, assistantMessageID: message.id, agent: this.session.agent, model: { ...this.session.model }, started: now }, true);
    return message;
  }

  async say(text: string): Promise<void> {
    const message = this.#assistantMessage();
    const part: FakePart = { id: this.world.nextId("prt"), kind: "text", text: "", start: Date.now() };
    message.content.push(part);
    const ordinal = message.content.length - 1;
    const chunks = text.length <= 4 ? [text] : [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
    if (this.world.generation === 1) {
      // A text part opens empty, streams deltas, and closes with its full text and end time (1.x `session/processor.ts`).
      this.#v1("message.part.updated", { sessionID: this.session.id, part: this.server.v1Part(this.session, message, part), time: Date.now() });
      for (const chunk of chunks) {
        part.text += chunk;
        this.#v1("message.part.delta", { sessionID: this.session.id, messageID: message.id, partID: part.id, field: "text", delta: chunk });
      }
      part.end = Date.now();
      this.#v1("message.part.updated", { sessionID: this.session.id, part: this.server.v1Part(this.session, message, part), time: Date.now() });
    } else {
      this.#v2("session.text.started", { sessionID: this.session.id, assistantMessageID: message.id, ordinal }, true);
      for (const chunk of chunks) {
        part.text += chunk;
        this.#v2("session.text.delta", { sessionID: this.session.id, assistantMessageID: message.id, ordinal, delta: chunk });
      }
      part.end = Date.now();
      this.#v2("session.text.ended", { sessionID: this.session.id, assistantMessageID: message.id, ordinal, text: part.text }, true);
    }
  }

  /** Streams reasoning: 1.x a `reasoning` part, 2.x `session.reasoning.*` (as text, by the part's ordinal). */
  async think(text: string): Promise<void> {
    const message = this.#assistantMessage();
    const part: FakePart = { id: this.world.nextId("prt"), kind: "reasoning", text: "", start: Date.now() };
    message.content.push(part);
    const ordinal = message.content.length - 1;
    if (this.world.generation === 1) {
      this.#v1("message.part.updated", { sessionID: this.session.id, part: this.server.v1Part(this.session, message, part), time: Date.now() });
      part.text = text;
      this.#v1("message.part.delta", { sessionID: this.session.id, messageID: message.id, partID: part.id, field: "text", delta: text });
      part.end = Date.now();
      this.#v1("message.part.updated", { sessionID: this.session.id, part: this.server.v1Part(this.session, message, part), time: Date.now() });
      return;
    }
    this.#v2("session.reasoning.started", { sessionID: this.session.id, assistantMessageID: message.id, ordinal }, true);
    part.text = text;
    this.#v2("session.reasoning.delta", { sessionID: this.session.id, assistantMessageID: message.id, ordinal, delta: text });
    part.end = Date.now();
    this.#v2("session.reasoning.ended", { sessionID: this.session.id, assistantMessageID: message.id, ordinal, text }, true);
  }

  /** A permission request for any OpenCode permission (`read`, `webfetch`, an MCP tool, ...), as the tool that needs it asks. */
  async requestPermission(action: string, resource: string, metadata: { [key: string]: string }): Promise<NativeApprovalHandle> {
    return this.server.askPermission(this, action, resource, metadata);
  }

  /** The kit's neutral tool as the OpenCode tool that does it. */
  #nativeTool(tool: NativeTool): { name: string; input: Json } {
    const absolute = tool.path === undefined ? undefined : path.join(this.session.directory, tool.path);
    if (tool.name === "read_file") return { name: "read", input: { filePath: absolute ?? this.session.directory } };
    if (tool.name === "list_files") return { name: "glob", input: { pattern: "*", path: this.session.directory } };
    return { name: tool.name, input: typeof tool.input === "object" && tool.input !== null ? (tool.input as Json) : {} };
  }

  async runTool(tool: NativeTool): Promise<void> {
    const message = this.#assistantMessage();
    const native = this.#nativeTool(tool);
    const entry: FakeTool = { id: this.world.nextId("prt"), callId: this.world.nextId("call"), tool: native.name, input: native.input, status: "pending", start: Date.now() };
    message.content.push(entry);
    if (this.world.generation === 1) {
      this.#v1("message.part.updated", { sessionID: this.session.id, part: this.server.v1Tool(this.session, message, entry), time: Date.now() });
      entry.status = "running";
      this.#v1("message.part.updated", { sessionID: this.session.id, part: this.server.v1Tool(this.session, message, entry), time: Date.now() });
      entry.status = "completed";
      entry.output = tool.output;
      entry.end = Date.now();
      this.#v1("message.part.updated", { sessionID: this.session.id, part: this.server.v1Tool(this.session, message, entry), time: Date.now() });
    } else {
      this.#v2("session.tool.input.started", { sessionID: this.session.id, assistantMessageID: message.id, id: entry.callId, name: entry.tool }, true);
      entry.status = "running";
      this.#v2("session.tool.called", { sessionID: this.session.id, assistantMessageID: message.id, id: entry.callId, input: entry.input, executed: true }, true);
      entry.status = "completed";
      entry.output = tool.output;
      entry.end = Date.now();
      this.#v2("session.tool.success", { sessionID: this.session.id, assistantMessageID: message.id, id: entry.callId, content: [{ type: "text", text: tool.output }], executed: true }, true);
    }
  }

  async requestApproval(approval: NativeApproval): Promise<NativeApprovalHandle> {
    return this.server.ask(this, approval);
  }

  /**
   * A shell command whose output arrives while it runs: 1.x streams it in the
   * running part's `metadata.output` (1.x `tool/shell.ts`); 2.x reports it only
   * with the result.
   */
  async runCommand(command: string, output: string): Promise<void> {
    const message = this.#assistantMessage();
    const v1 = this.world.generation === 1;
    const entry: FakeTool = { id: this.world.nextId("prt"), callId: this.world.nextId("call"), tool: v1 ? "bash" : "shell", input: { command, description: command }, status: "pending", start: Date.now() };
    message.content.push(entry);
    if (v1) {
      this.#v1("message.part.updated", { sessionID: this.session.id, part: this.server.v1Tool(this.session, message, entry), time: Date.now() });
      entry.status = "running";
      const half = output.slice(0, Math.ceil(output.length / 2));
      const streaming: V1.ToolPart = { ...this.server.v1Tool(this.session, message, entry), state: { status: "running", input: entry.input, title: command, metadata: { output: half, description: command }, time: { start: entry.start } } };
      this.#v1("message.part.updated", { sessionID: this.session.id, part: streaming, time: Date.now() });
      entry.status = "completed";
      entry.output = output;
      entry.end = Date.now();
      this.#v1("message.part.updated", { sessionID: this.session.id, part: this.server.v1Tool(this.session, message, entry), time: Date.now() });
      return;
    }
    this.#v2("session.tool.input.started", { sessionID: this.session.id, assistantMessageID: message.id, id: entry.callId, name: entry.tool }, true);
    entry.status = "running";
    this.#v2("session.tool.called", { sessionID: this.session.id, assistantMessageID: message.id, id: entry.callId, input: entry.input, executed: true }, true);
    entry.status = "completed";
    entry.output = output;
    entry.end = Date.now();
    this.#v2("session.tool.success", { sessionID: this.session.id, assistantMessageID: message.id, id: entry.callId, content: [{ type: "text", text: output }], executed: true }, true);
  }

  /** A question from the agent (OpenCode's `question` tool), answered through the driver. */
  async askQuestion(question: { readonly text: string; readonly options: readonly string[] }): Promise<{ answers(): Promise<unknown> }> {
    return this.server.question(this, question);
  }

  /** A subagent: OpenCode's `task` tool runs a child session of this one, which ends when the tool does. */
  async runSubagent(name: string): Promise<{ readonly childId: string; finish(): Promise<void> }> {
    return this.server.subagent(this, name);
  }

  /** 1.x: the agent's todo list changed (`todo.updated`, written by the `todowrite` tool). */
  async todos(entries: ReadonlyArray<{ readonly content: string; readonly status: string }>): Promise<void> {
    this.#v1("todo.updated", { sessionID: this.session.id, todos: entries.map((entry) => ({ content: entry.content, status: entry.status, priority: "medium" })) });
  }

  /** A permission request from a subagent's own session, while this run waits for the subagent. */
  async requestApprovalFrom(childSessionId: string, approval: NativeApproval): Promise<NativeApprovalHandle> {
    return this.server.askFrom(childSessionId, this, approval);
  }

  /** Any OpenCode permission request (`read`, `webfetch`, ...) from a subagent's own session. */
  async requestPermissionFrom(childSessionId: string, action: string, resource: string, metadata: { [key: string]: string }): Promise<NativeApprovalHandle> {
    return this.server.askPermissionFrom(childSessionId, this, action, resource, metadata);
  }

  nextSteer(): Promise<string> {
    return this.#steers.next().then((next) => {
      if (next.done === true) throw new Error("the run ended");
      return next.value;
    });
  }

  /** A steer joined this run (2.x inbox delivery at the next step). */
  steered(text: string): void {
    this.#steers.push(text);
  }

  #end(how: "succeeded" | { v1: V1Error; v2: V2.SessionStructuredError; at?: number } | "interrupted"): void {
    const message = this.#assistantMessage();
    message.completed = Date.now();
    if (how === "succeeded") message.finish = "stop";
    else if (how === "interrupted") message.error = { v1: { name: "MessageAbortedError", data: { message: "The operation was aborted." } }, v2: { type: "aborted", message: "The operation was aborted." } };
    else message.error = how;
    this.ended = true;
    this.server.endRun(this);
    const id = this.session.id;
    if (this.world.generation === 1) {
      if (message.error !== undefined) this.#v1("session.error", { sessionID: id, error: message.error.v1 });
      this.#v1("message.updated", { sessionID: id, info: this.server.v1Message(this.session, message) });
      // `SessionStatus.set` idle publishes the status and then `session.idle` (1.x `session/status.ts`).
      this.#v1("session.status", { sessionID: id, status: { type: "idle" } });
      this.#v1("session.idle", { sessionID: id });
    } else {
      if (how === "succeeded") {
        this.#v2("session.step.ended", { sessionID: id, assistantMessageID: message.id, finish: "stop", cost: 0, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }, true);
        this.#v2("session.execution.succeeded", { sessionID: id }, true);
      } else if (how === "interrupted") this.#v2("session.execution.interrupted", { sessionID: id, reason: "user" }, true);
      // OpenCode builds the structured error (its retryAfterMs counts from then) and publishes it at once.
      else this.#v2("session.execution.failed", { sessionID: id, error: how.v2 }, true, how.at);
    }
    this.#steers.end();
  }

  async complete(): Promise<void> {
    this.#end("succeeded");
  }

  async completeHeld(): Promise<{ release(): Promise<void> }> {
    // The run ends natively at once; the events that say so wait.
    this.#held = [];
    this.#end("succeeded");
    return {
      release: async () => {
        const held = this.#held ?? [];
        this.#held = undefined;
        for (const send of held) send();
      },
    };
  }

  async fail(failure: NativeFailure): Promise<void> {
    const created = Date.now();
    if (failure.kind === "usage_limit") {
      // 1.x carries the provider's response headers on APIError; 2.x a structured error with retryAfterMs from now.
      this.#end({
        v1: { name: "APIError", data: { message: failure.message, statusCode: 429, isRetryable: false, responseHeaders: { "retry-after": httpDate(failure.resetAt) } } },
        v2: { type: "provider.rate-limit", message: failure.message, status: 429, retryAfterMs: Math.max(0, Date.parse(failure.resetAt) - created) },
        at: created,
      });
      return;
    }
    this.#end({ v1: { name: "APIError", data: { message: failure.message, statusCode: 500, isRetryable: false } }, v2: { type: "provider.unknown", message: failure.message, status: 500 } });
  }

  stopRequested(): Promise<"cancel" | "exit"> {
    if (this.#stopped !== undefined) return Promise.resolve(this.#stopped);
    return new Promise((resolve) => {
      this.#stop = resolve;
    });
  }

  requestStop(how: "cancel" | "exit"): void {
    if (this.#stopped !== undefined) return;
    this.#stopped = how;
    this.#stop?.(how);
  }

  async finishCancelled(): Promise<void> {
    this.#end("interrupted");
  }

  async exitProcess(): Promise<void> {
    await this.server.exit(1);
  }
}

/** One `opencode serve` process. */
export class FakeServer {
  readonly world: FakeWorld;
  readonly number: number;
  readonly password: string | undefined;
  readonly known = new Set<string>();
  /** The MCP entries each directory's instance (1.x) or location (2.x) serves, by name. */
  readonly mcp = new Map<string, Map<string, Json>>();
  /** 1.x: every name ever added in a directory. Disconnecting keeps the config (1.19.6 `mcp/index.ts` `disconnect`). */
  readonly #mcpConfigured = new Map<string, Set<string>>();
  /** Operations whose requests the server drops without answering, as a server that went away would. */
  readonly dropRequests = new Set<string>();
  readonly #subscribers = new Set<Subscriber>();
  readonly #permissions = new Map<string, PendingPermission>();
  readonly #questions = new Map<string, PendingQuestion>();
  /** 1.x "always" grants, by directory (the instance), kept in memory. */
  readonly #approved = new Map<string, Rule[]>();
  readonly #runs = new Map<string, FakeRun>();
  readonly #inbox = new Map<string, { sessionId: string; text: string; steer: boolean }>();
  #http: http.Server | undefined;
  #exit: ((code: number | null, signal: string | null) => void) | undefined;
  alive = true;
  url = "";

  constructor(world: FakeWorld, password: string | undefined) {
    this.world = world;
    this.number = world.nextServer();
    this.password = password;
  }

  async listen(onExit: (code: number | null, signal: string | null) => void): Promise<string> {
    this.#exit = onExit;
    this.#http = http.createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        this.world.violation(`the fake server failed: ${error instanceof Error ? error.stack : String(error)}`);
        if (!response.headersSent) response.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => this.#http!.listen(0, "127.0.0.1", resolve));
    const address = this.#http.address() as { port: number };
    this.url = `http://127.0.0.1:${address.port}`;
    this.world.servers.add(this);
    return this.url;
  }

  /** The process ends: open runs stop, streams close, the in-memory state is gone. */
  async exit(code: number | null, signal: string | null = null): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    for (const run of this.#runs.values()) run.requestStop("exit");
    this.#runs.clear();
    for (const subscriber of this.#subscribers) subscriber.response.destroy();
    this.#subscribers.clear();
    const server = this.#http;
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.#exit?.(code, signal);
  }

  // ---------------------------------------------------------------------------
  // Shapes

  v1Session(session: FakeSession): V1.Session {
    return {
      id: session.id,
      slug: session.id.slice(4, 12),
      projectID: "global",
      directory: session.directory,
      ...(session.parentId === undefined ? {} : { parentID: session.parentId }),
      title: session.title,
      version: this.world.version,
      time: { created: session.created, updated: session.updated },
      permission: session.rules.map((rule) => ({ permission: rule.action, pattern: rule.resource, action: rule.effect })),
      ...(session.revert === undefined ? {} : { revert: { messageID: session.revert } }),
    };
  }

  v2Session(session: FakeSession): V2.SessionInfo {
    return {
      id: session.id,
      ...(session.parentId === undefined ? {} : { parentID: session.parentId }),
      ...(session.forkedFrom === undefined || session.forkBoundary === undefined ? {} : { fork: { sessionID: session.forkedFrom, boundary: { ...session.forkBoundary } } }),
      projectID: "global",
      agent: session.agent,
      model: { ...session.model },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: session.created, updated: session.updated },
      title: session.title,
      permissions: session.rules.map((rule) => ({ ...rule })),
      location: { directory: session.directory },
    };
  }

  v1Message(session: FakeSession, message: FakeMessage): V1.Message {
    if (message.role === "user") {
      return { id: message.id, sessionID: session.id, role: "user", time: { created: message.created }, agent: session.agent, model: { providerID: session.model.providerID, modelID: session.model.id }, ...(message.system === undefined ? {} : { system: message.system }) };
    }
    return {
      id: message.id,
      sessionID: session.id,
      role: "assistant",
      time: { created: message.created, ...(message.completed === undefined ? {} : { completed: message.completed }) },
      ...(message.error === undefined ? {} : { error: message.error.v1 }),
      parentID: message.parentId ?? "msg_none",
      modelID: session.model.id,
      providerID: session.model.providerID,
      mode: session.agent,
      agent: session.agent,
      path: { cwd: session.directory, root: session.directory },
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(message.finish === undefined ? {} : { finish: message.finish }),
    };
  }

  v1Part(session: FakeSession, message: FakeMessage, part: FakePart): V1.TextPart | V1.ReasoningPart {
    return { id: part.id, sessionID: session.id, messageID: message.id, type: part.kind, text: part.text, time: { start: part.start, ...(part.end === undefined ? {} : { end: part.end }) } };
  }

  v1Tool(session: FakeSession, message: FakeMessage, tool: FakeTool): V1.ToolPart {
    const state: V1.ToolState =
      tool.status === "pending"
        ? { status: "pending", input: {}, raw: "" }
        : tool.status === "running"
          ? { status: "running", input: tool.input, time: { start: tool.start } }
          : tool.status === "completed"
            ? { status: "completed", input: tool.input, output: tool.output ?? "", title: tool.tool, metadata: {}, time: { start: tool.start, end: tool.end ?? tool.start } }
            : { status: "error", input: tool.input, error: tool.output ?? "failed", time: { start: tool.start, end: tool.end ?? tool.start } };
    return { id: tool.id, sessionID: session.id, messageID: message.id, type: "tool", callID: tool.callId, tool: tool.tool, state };
  }

  v1Parts(session: FakeSession, message: FakeMessage): V1.Part[] {
    if (message.role === "user") return [{ id: `prt_${message.id.slice(4)}`, sessionID: session.id, messageID: message.id, type: "text", text: message.text }];
    return message.content.map((entry) => ("kind" in entry ? this.v1Part(session, message, entry) : this.v1Tool(session, message, entry)));
  }

  v2Message(session: FakeSession, message: FakeMessage): V2.SessionMessageUser | V2.SessionMessageAssistant {
    if (message.role === "user") return { id: message.id, ...(message.steer ? { metadata: { "ari.steer": true } } : {}), time: { created: message.created }, text: message.text, type: "user" };
    return {
      id: message.id,
      time: { created: message.created, ...(message.completed === undefined ? {} : { completed: message.completed }) },
      type: "assistant",
      agent: session.agent,
      model: { ...session.model },
      content: message.content.map((entry): V2.SessionMessageAssistant["content"][number] =>
        "kind" in entry
          ? { type: entry.kind, text: entry.text }
          : {
              type: "tool",
              id: entry.callId,
              name: entry.tool,
              state: entry.status === "completed" ? { status: "completed", input: entry.input as { [key: string]: V2.JsonValue }, content: [{ type: "text", text: entry.output ?? "" }] } : { status: "running", input: entry.input as { [key: string]: V2.JsonValue }, metadata: {} },
              time: { created: entry.start, ...(entry.end === undefined ? {} : { completed: entry.end }) },
            },
      ),
      ...(message.finish === undefined ? {} : { finish: message.finish }),
      ...(message.error === undefined ? {} : { error: message.error.v2 }),
    };
  }

  // ---------------------------------------------------------------------------
  // Events

  /** Sends a 1.x event, typed by `@opencode-ai/sdk` 1.19.6's `Event`, to the subscribers of the session's directory. */
  publishV1<T extends V1EventType>(session: FakeSession, type: T, properties: V1Properties<T>): void {
    this.#send(session, { id: this.world.nextId("evt"), type, properties } as unknown as V1.Event);
  }

  /** Sends a 2.x event, typed by `@opencode/client` 2.1.2's `OpenCodeEvent`, to every subscriber. */
  publishV2<T extends V2EventType>(session: FakeSession, type: T, data: V2Data<T>, durable = false, created = Date.now()): void {
    const event = {
      id: this.world.nextId("evt"),
      created,
      type,
      ...(durable ? { durable: { aggregateID: session.id, seq: this.#seq(session.id), version: type === "session.tool.success" || type === "session.tool.failed" || type === "session.forked" ? 2 : 1 } } : {}),
      location: { directory: session.directory },
      data,
    };
    this.#send(session, event as unknown as V2.OpenCodeEvent);
  }

  #send(session: FakeSession, event: V1.Event | V2.OpenCodeEvent): void {
    if (!this.alive) return;
    this.world.checkEvent(event);
    this.world.frames.push({ server: this.number, direction: "event", operation: event.type, body: event });
    const frame = `event: message\ndata: ${JSON.stringify(event)}\n\n`;
    for (const subscriber of this.#subscribers) {
      if (this.world.generation === 1 && subscriber.directory !== session.directory) continue;
      subscriber.response.write(frame);
    }
  }

  readonly #seqs = new Map<string, number>();
  #seq(aggregate: string): number {
    const next = (this.#seqs.get(aggregate) ?? 0) + 1;
    this.#seqs.set(aggregate, next);
    return next;
  }

  // ---------------------------------------------------------------------------
  // Runs, permissions, questions, subagents

  /** A user prompt is admitted; a run starts unless one runs (1.x joins it at the next step; 2.x inbox). */
  #startRun(session: FakeSession, text: string, system: string | undefined, delivery: "prompt" | "steer"): { messageId: string; joined: boolean } {
    const now = Date.now();
    const message: FakeMessage = { id: this.world.nextId("msg"), role: "user", created: now, text, steer: delivery === "steer", content: [], ...(system === undefined ? {} : { system }) };
    const running = this.#runs.get(session.id);
    if (delivery === "steer") {
      // 2.x: a steer with `resume: false` waits in the inbox; a running execution takes it at its next step.
      this.#inbox.set(message.id, { sessionId: session.id, text, steer: true });
      this.publishV2(session, "session.inbox.enqueued", { sessionID: session.id, inboxID: message.id, item: { type: "user", payload: { text, metadata: { "ari.steer": true } }, delivery: "steer" } }, true);
      if (running !== undefined && !running.ended) {
        this.#inbox.delete(message.id);
        session.messages.push(message);
        this.publishV2(session, "session.inbox.delivered", { sessionID: session.id, inboxID: message.id }, true);
        running.steered(text);
        return { messageId: message.id, joined: true };
      }
      return { messageId: message.id, joined: false };
    }
    session.messages.push(message);
    session.updated = now;
    if (this.world.generation === 1) {
      this.publishV1(session, "message.updated", { sessionID: session.id, info: this.v1Message(session, message) });
      this.publishV1(session, "message.part.updated", { sessionID: session.id, part: this.v1Parts(session, message)[0]!, time: now });
      if (running !== undefined && !running.ended) return { messageId: message.id, joined: true };
      this.publishV1(session, "session.status", { sessionID: session.id, status: { type: "busy" } });
    } else {
      this.publishV2(session, "session.inbox.enqueued", { sessionID: session.id, inboxID: message.id, item: { type: "user", payload: { text }, delivery: "steer" } }, true);
      this.publishV2(session, "session.execution.started", { sessionID: session.id }, true);
      this.publishV2(session, "session.inbox.delivered", { sessionID: session.id, inboxID: message.id }, true);
    }
    const run = new FakeRun(this, session, text, message.id);
    this.#runs.set(session.id, run);
    this.world.turns.push(run);
    return { messageId: message.id, joined: false };
  }

  endRun(run: FakeRun): void {
    if (this.#runs.get(run.session.id) === run) this.#runs.delete(run.session.id);
    // Pending requests of the run are dropped with it.
    for (const [id, pending] of this.#permissions) if (pending.run === run) this.#permissions.delete(id);
    for (const [id, pending] of this.#questions) if (pending.run === run) this.#questions.delete(id);
  }

  /**
   * How this server decides a permission request of `session`, in OpenCode's
   * own order. 1.x (1.19.6 `permission/index.ts` `ask`): for each resource,
   * the agent's rules, the session's, then the instance's in-memory "always"
   * grants, the last match winning; a deny anywhere denies, an ask anywhere
   * asks. 2.x (2.1.2 `core/src/permission.ts` `evaluateInput`): a resource the
   * session's rules deny denies before any saved grant is read; otherwise the
   * session's rules and the project's saved grants, then the plugin hook.
   * The fake models agent rules only for a 1.x child session (the `general`
   * subagent's); everywhere else no rule matching means ask.
   */
  decide(session: FakeSession, action: string, resources: readonly string[]): Rule["effect"] {
    if (this.world.generation === 1) {
      const agent = session.parentId === undefined ? [] : [...V1_GENERAL_AGENT_RULES];
      const granted = this.#approved.get(session.directory) ?? [];
      const effects = resources.map((resource) => evaluate(action, resource, agent, session.rules, granted));
      return effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow";
    }
    if (resources.some((resource) => evaluate(action, resource, session.rules) === "deny")) return "deny";
    const saved = this.world.saved.get(session.directory) ?? [];
    const effect = resources.map((resource) => evaluate(action, resource, session.rules, saved)).includes("ask") ? "ask" : "allow";
    return this.world.permissionHook?.({ sessionId: session.id, action, resources, effect }) ?? effect;
  }

  /**
   * 1.x: whether the model of `session` is shown the tool asking `permission`
   * at all. 1.19.6 leaves out a tool whose last matching agent or session rule
   * denies every resource (`permission/index.ts` `disabled`, used by
   * `session/llm/request.ts` and code mode); "always" grants play no part.
   */
  v1Hidden(session: FakeSession, permission: string): boolean {
    const agent = session.parentId === undefined ? [] : [...V1_GENERAL_AGENT_RULES];
    const rule = [...agent, ...session.rules].findLast((candidate) => wildcard(permission, candidate.action));
    return rule?.resource === "*" && rule.effect === "deny";
  }

  /** Asks the host, as OpenCode does when `decide` says ask; the puppet asking for anything else is a mistake in the test. */
  #askAs(session: FakeSession, run: FakeRun, handle: FakeApprovalHandle, action: string, resources: string[], always: string[], metadata: { [key: string]: string }): FakeApprovalHandle {
    const effect = this.decide(session, action, resources);
    if (effect !== "ask") {
      this.world.violation(`the puppet asked for an approval OpenCode's rules answer with ${effect}: ${action} ${resources.join(", ")} in session ${session.id}`);
      return handle;
    }
    const id = this.world.nextId("per");
    this.#permissions.set(id, { id, sessionId: session.id, action, resources, always, run, handle });
    if (this.world.generation === 1) this.publishV1(session, "permission.asked", { id, sessionID: session.id, permission: action, patterns: resources, metadata, always });
    else this.publishV2(session, "permission.asked", { id, sessionID: session.id, action, resources, save: always, metadata });
    return handle;
  }

  ask(run: FakeRun, approval: NativeApproval): FakeApprovalHandle {
    const session = run.session;
    const v1 = this.world.generation === 1;
    const action = approval.kind === "command" ? (v1 ? "bash" : "shell") : "edit";
    const target = approval.kind === "command" ? (approval.command ?? []).join(" ") : path.join(session.directory, approval.path ?? "");
    const always = approval.kind === "command" ? [`${(approval.command ?? [])[0] ?? ""} *`] : [target];
    const metadata: { [key: string]: string } = approval.kind === "command" ? { command: target } : { filepath: target };
    return this.#askAs(session, run, new FakeApprovalHandle(approval), action, [target], always, metadata);
  }

  askPermission(run: FakeRun, action: string, resource: string, metadata: { [key: string]: string }): FakeApprovalHandle {
    return this.#askAs(run.session, run, new FakeApprovalHandle({ kind: "command", options: [] }), action, [resource], [resource], metadata);
  }

  question(run: FakeRun, question: { readonly text: string; readonly options: readonly string[] }): { answers(): Promise<unknown> } {
    const session = run.session;
    let resolveAnswers: (value: unknown) => void = () => undefined;
    const answered = new Promise<unknown>((resolve) => {
      resolveAnswers = resolve;
    });
    if (this.world.generation === 1) {
      const id = this.world.nextId("que");
      this.#questions.set(id, { id, sessionId: session.id, run });
      this.#answerWaiters.set(id, resolveAnswers);
      this.publishV1(session, "question.asked", { id, sessionID: session.id, questions: [{ question: question.text, header: "Question", options: question.options.map((label) => ({ label, description: label })), custom: true }] });
    } else {
      const id = this.world.nextId("frm");
      this.#questions.set(id, { id, sessionId: session.id, run });
      this.#answerWaiters.set(id, resolveAnswers);
      this.publishV2(session, "form.created", { form: { id, sessionID: session.id, title: question.text, fields: [{ key: "choice", type: "string", title: question.text, options: question.options.map((value) => ({ value, label: value })), custom: true }] } });
    }
    return { answers: () => answered };
  }

  readonly #answerWaiters = new Map<string, (value: unknown) => void>();

  async subagent(run: FakeRun, name: string): Promise<{ readonly childId: string; finish(): Promise<void> }> {
    const parent = run.session;
    const now = Date.now();
    // The child's own rules, fixed when OpenCode creates it: 2.x copies the parent's (2.1.2 `core/src/session.ts` `create`), 1.x keeps only its denies and directory rules (1.19.6 `tool/task.ts`).
    const rules = this.world.generation === 1 ? v1ChildRules(parent.rules) : parent.rules.map((rule) => ({ ...rule }));
    const child: FakeSession = { id: this.world.nextId("ses"), directory: parent.directory, created: now, updated: now, title: name, parentId: parent.id, rules, messages: [], compactions: 0, instructions: new Map(), model: { ...parent.model }, agent: "general" };
    this.world.sessions.set(child.id, child);
    this.known.add(child.id);
    if (this.world.generation === 1) {
      this.publishV1(child, "session.created", { sessionID: child.id, info: this.v1Session(child) });
      this.publishV1(child, "session.status", { sessionID: child.id, status: { type: "busy" } });
    } else {
      this.publishV2(child, "session.created", { sessionID: child.id, projectID: "global", location: { directory: child.directory }, parentID: parent.id, slug: child.id.slice(4, 12), title: name, permissions: rules.map((rule) => ({ ...rule })), version: this.world.version }, true);
      this.publishV2(child, "session.execution.started", { sessionID: child.id }, true);
    }
    return {
      childId: child.id,
      finish: async () => {
        if (this.world.generation === 1) {
          this.publishV1(child, "session.status", { sessionID: child.id, status: { type: "idle" } });
          this.publishV1(child, "session.idle", { sessionID: child.id });
        } else this.publishV2(child, "session.execution.succeeded", { sessionID: child.id }, true);
      },
    };
  }

  /** A subagent's permission request (it comes from the child session). */
  askFrom(sessionId: string, run: FakeRun, approval: NativeApproval): FakeApprovalHandle {
    const session = this.world.sessions.get(sessionId)!;
    const action = this.world.generation === 1 ? "bash" : "shell";
    const target = (approval.command ?? ["true"]).join(" ");
    return this.#askAs(session, run, new FakeApprovalHandle(approval), action, [target], [target], { command: target });
  }

  askPermissionFrom(sessionId: string, run: FakeRun, action: string, resource: string, metadata: { [key: string]: string }): FakeApprovalHandle {
    const session = this.world.sessions.get(sessionId)!;
    return this.#askAs(session, run, new FakeApprovalHandle({ kind: "command", options: [] }), action, [resource], [resource], metadata);
  }

  #reply(id: string, reply: "once" | "always" | "reject"): boolean {
    const pending = this.#permissions.get(id);
    if (pending === undefined) return false;
    this.#permissions.delete(id);
    const session = this.world.sessions.get(pending.sessionId)!;
    if (this.world.generation === 1) this.publishV1(session, "permission.replied", { sessionID: pending.sessionId, requestID: id, reply });
    else this.publishV2(session, "permission.replied", { sessionID: pending.sessionId, requestID: id, reply });
    if (reply === "always") {
      // 1.x keeps the grant for the directory's instance; 2.x saves it for the project (both reach every session there).
      const grants = pending.always.map((resource) => ({ action: pending.action, resource, effect: "allow" as const }));
      const store = this.world.generation === 1 ? this.#approved : this.world.saved;
      store.set(session.directory, [...(store.get(session.directory) ?? []), ...grants]);
    }
    pending.handle.got(reply);
    return true;
  }

  // ---------------------------------------------------------------------------
  // HTTP

  async #handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.url);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    const hasBody = raw !== "";
    if (hasBody) {
      try {
        body = JSON.parse(raw);
      } catch {
        this.world.violation(`${request.method} ${url.pathname}: the body is not JSON`);
      }
    }
    const method = request.method ?? "GET";
    // Both generations accept only HTTP Basic auth with the user name `opencode` when a password is set.
    if (this.password !== undefined) {
      const expected = `Basic ${Buffer.from(`opencode:${this.password}`, "utf8").toString("base64")}`;
      if (request.headers.authorization !== expected) {
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify(this.world.generation === 1 ? { name: "UnauthorizedError", data: { message: "Unauthorized" } } : { _tag: "UnauthorizedError", message: "Unauthorized" }));
        return;
      }
    }
    // A GET the server's API does not have reaches its web app, which answers HTML (2.1.2 answered
    // `GET /global/health` with its HTML page when run by hand); clients that probe the other
    // generation's info route see that.
    if (method === "GET" && this.world.validator.match(method, url.pathname) === undefined && (url.pathname === "/api/info" || url.pathname === "/global/health")) {
      this.world.frames.push({ server: this.number, direction: "request", operation: `web app ${url.pathname}` });
      response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><html><head><title>OpenCode</title></head></html>");
      return;
    }
    const { matched, problems } = this.world.validator.checkRequest(method, url, body, hasBody);
    for (const problem of problems) this.world.violation(problem);
    this.world.frames.push({ server: this.number, direction: "request", operation: matched?.operationId ?? `${method} ${url.pathname}`, body: { path: url.pathname, query: Object.fromEntries(url.searchParams), body } });
    if (matched === undefined) {
      response.writeHead(404).end();
      return;
    }
    if (this.dropRequests.has(matched.operationId)) {
      request.socket.destroy();
      return;
    }
    if (matched.operationId === "event.subscribe" || matched.operationId === "v2.event.subscribe") {
      this.#subscribe(url, response);
      return;
    }
    const answer = this.world.generation === 1 ? this.#routeV1(matched, url, body as Json | undefined) : this.#routeV2(matched, url, body as Json | undefined);
    const hasAnswerBody = answer.body !== undefined;
    for (const problem of this.world.validator.checkResponse(matched, answer.status, answer.body, hasAnswerBody)) this.world.violation(problem);
    this.world.frames.push({ server: this.number, direction: "response", operation: matched.operationId, status: answer.status, body: answer.body });
    if (!hasAnswerBody) response.writeHead(answer.status).end();
    else response.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
    answer.after?.();
  }

  #subscribe(url: URL, response: http.ServerResponse): void {
    const directory = this.world.generation === 1 ? (url.searchParams.get("directory") ?? undefined) : undefined;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" });
    const subscriber: Subscriber = { directory, response };
    this.#subscribers.add(subscriber);
    response.on("close", () => this.#subscribers.delete(subscriber));
    // The first event of every stream (1.x `handlers/event.ts`, 2.x `groups/event`).
    const connected = this.world.generation === 1 ? { id: this.world.nextId("evt"), type: "server.connected", properties: {} } : { id: this.world.nextId("evt"), type: "server.connected", data: {} };
    this.world.checkEvent(connected);
    response.write(`event: message\ndata: ${JSON.stringify(connected)}\n\n`);
  }

  #notFound(what: string): { status: number; body: unknown } {
    return this.world.generation === 1 ? { status: 404, body: { name: "NotFoundError", data: { message: `${what} not found` } } } : { status: 404, body: { _tag: "SessionNotFoundError", sessionID: what, message: `Session not found: ${what}` } };
  }

  #session(id: string): FakeSession | undefined {
    const session = this.world.sessions.get(id);
    if (session !== undefined) this.known.add(id);
    return session;
  }

  #createSession(directory: string, title: string | undefined, rules: Rule[], extra: Partial<FakeSession> = {}): FakeSession {
    const now = Date.now();
    const id = this.world.nextId("ses");
    const session: FakeSession = { id, directory, created: now, updated: now, title: title ?? `New session - ${new Date(now).toISOString()}`, rules, messages: [], compactions: 0, instructions: new Map(), model: { ...MODEL }, agent: "build", ...extra };
    this.world.sessions.set(id, session);
    this.known.add(id);
    return session;
  }

  /**
   * A fork copies the messages before the boundary into a new session. 1.x
   * (1.19.6 `Session.fork`) copies everything when the message is unknown and
   * forks an empty session too. 2.x (2.1.2 `core/src/session.ts` `fork`,
   * `server/src/handlers/session.ts`) refuses an unknown `before` as
   * `MessageNotFoundError` and a session without messages as `InvalidRequestError`
   * `empty_session`, and the fork takes the parent's rules and instruction entries.
   */
  #fork(source: FakeSession, before: string | undefined): FakeSession | { status: number; body: unknown } {
    const index = before === undefined ? -1 : source.messages.findIndex((message) => message.id === before);
    const v2 = this.world.generation === 2;
    if (v2 && before !== undefined && index === -1) return { status: 404, body: { _tag: "MessageNotFoundError", sessionID: source.id, messageID: before, message: `Message not found: ${before}` } };
    if (v2 && source.messages.length === 0) return { status: 400, body: { _tag: "InvalidRequestError", message: `Cannot fork empty session: ${source.id}`, kind: "empty_session" } };
    const kept = index < 0 ? source.messages : source.messages.slice(0, index);
    const boundary = v2 ? { forkBoundary: before === undefined ? { type: "through" as const, messageID: source.messages.at(-1)!.id } : { type: "before" as const, messageID: before } } : {};
    const fork = this.#createSession(source.directory, `${source.title} (fork #1)`, v2 ? source.rules.map((rule) => ({ ...rule })) : [], { forkedFrom: source.id, model: { ...source.model }, agent: source.agent, ...boundary });
    if (v2) for (const [key, value] of source.instructions) fork.instructions.set(key, value);
    const ids = new Map<string, string>();
    for (const message of kept) {
      const id = this.world.nextId("msg");
      ids.set(message.id, id);
      fork.messages.push({ ...message, id, content: message.content.map((entry) => ({ ...entry })), ...(message.parentId === undefined ? {} : { parentId: ids.get(message.parentId) ?? message.parentId }) });
    }
    return fork;
  }

  #routeV1(matched: MatchedOperation, url: URL, body: Json | undefined): { status: number; body?: unknown; after?: () => void } {
    const sessionId = matched.pathParams["sessionID"];
    const directory = url.searchParams.get("directory") ?? process.cwd();
    switch (matched.operationId) {
      case "global.health":
        return { status: 200, body: { healthy: true, version: this.world.version } satisfies V1.GlobalHealthResponses[200] };
      case "session.create": {
        const rules = Array.isArray(body?.["permission"]) ? (body["permission"] as Json[]).map((rule) => ({ action: String(rule["permission"]), resource: String(rule["pattern"]), effect: rule["action"] as Rule["effect"] })) : [];
        const session = this.#createSession(directory, typeof body?.["title"] === "string" ? body["title"] : undefined, rules);
        this.publishV1(session, "session.created", { sessionID: session.id, info: this.v1Session(session) });
        return { status: 200, body: this.v1Session(session) };
      }
      case "session.get": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(`Session ${sessionId}`);
        this.world.sessionReads.push({ sessionId: session.id, rules: session.rules.map((rule) => ({ ...rule })) });
        return { status: 200, body: this.v1Session(session) };
      }
      case "session.update": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(`Session ${sessionId}`);
        if (Array.isArray(body?.["permission"])) session.rules = (body["permission"] as Json[]).map((rule) => ({ action: String(rule["permission"]), resource: String(rule["pattern"]), effect: rule["action"] as Rule["effect"] }));
        session.updated = Date.now();
        this.publishV1(session, "session.updated", { sessionID: session.id, info: this.v1Session(session) });
        return { status: 200, body: this.v1Session(session) };
      }
      case "session.messages": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(`Session ${sessionId}`);
        // Without `limit`, 1.19.6 pages through the whole history and answers it oldest first (`session/session.ts` `messages`).
        // With `limit` it answers one newest-first page and a `Link` header, which the fake does not serve.
        if (url.searchParams.has("limit") || url.searchParams.has("before")) this.world.violation("the fake serves the 1.x message list only without limit and before");
        return { status: 200, body: session.messages.map((message) => ({ info: this.v1Message(session, message), parts: this.v1Parts(session, message) })) satisfies V1.SessionMessagesResponses[200] };
      }
      case "session.prompt_async": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(`Session ${sessionId}`);
        this.world.cleanup(session);
        const parts = Array.isArray(body?.["parts"]) ? (body["parts"] as Json[]) : [];
        const text = parts.filter((part) => part["type"] === "text").map((part) => String(part["text"] ?? "")).join("\n");
        if (typeof body?.["model"] === "object" && body["model"] !== null) {
          const model = body["model"] as Json;
          session.model = { providerID: String(model["providerID"]), id: String(model["modelID"]) };
        }
        if (typeof body?.["agent"] === "string") session.agent = body["agent"];
        const system = typeof body?.["system"] === "string" ? body["system"] : undefined;
        // 204 at once; the run reports itself through events (1.x `handlers/session.ts` `promptAsync`).
        return { status: 204, after: () => void this.#startRun(session, text, system, "prompt") };
      }
      case "session.abort": {
        const run = sessionId === undefined ? undefined : this.#runs.get(sessionId);
        run?.requestStop("cancel");
        return { status: 200, body: true };
      }
      case "session.fork": {
        const source = this.#session(sessionId!);
        if (source === undefined) return this.#notFound(`Session ${sessionId}`);
        const fork = this.#fork(source, typeof body?.["messageID"] === "string" ? body["messageID"] : undefined);
        if (!("id" in fork)) return fork;
        this.publishV1(fork, "session.created", { sessionID: fork.id, info: this.v1Session(fork) });
        return { status: 200, body: this.v1Session(fork) };
      }
      case "session.revert": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(`Session ${sessionId}`);
        if (this.#runs.has(session.id)) return { status: 409, body: { name: "SessionBusyError", data: { message: `Session ${session.id} is busy` } } };
        session.revert = String(body?.["messageID"]);
        return { status: 200, body: this.v1Session(session) };
      }
      case "session.summarize": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(`Session ${sessionId}`);
        this.world.cleanup(session);
        // A summary is a run of its own: busy, the compaction, idle; the call answers when it is done (1.x `handlers/session.ts` `summarize`).
        session.compactions += 1;
        this.publishV1(session, "session.status", { sessionID: session.id, status: { type: "busy" } });
        this.publishV1(session, "session.compacted", { sessionID: session.id });
        this.publishV1(session, "session.status", { sessionID: session.id, status: { type: "idle" } });
        this.publishV1(session, "session.idle", { sessionID: session.id });
        return { status: 200, body: true };
      }
      case "permission.reply": {
        const reply = body?.["reply"];
        if (reply !== "once" && reply !== "always" && reply !== "reject") return { status: 400, body: { _tag: "BadRequest" } };
        if (!this.#reply(matched.pathParams["requestID"]!, reply)) return { status: 404, body: { name: "PermissionNotFoundError", data: { message: "not found" } } };
        return { status: 200, body: true };
      }
      case "question.reply":
      case "question.reject": {
        const id = matched.pathParams["requestID"]!;
        const pending = this.#questions.get(id);
        if (pending === undefined) return { status: 404, body: { name: "QuestionNotFoundError", data: { message: "not found" } } };
        this.#questions.delete(id);
        const session = this.world.sessions.get(pending.sessionId)!;
        if (matched.operationId === "question.reply") this.publishV1(session, "question.replied", { sessionID: session.id, requestID: id, answers: (body?.["answers"] ?? []) as string[][] });
        else this.publishV1(session, "question.rejected", { sessionID: session.id, requestID: id });
        this.#answerWaiters.get(id)?.(matched.operationId === "question.reply" ? body?.["answers"] : null);
        return { status: 200, body: true };
      }
      case "mcp.add": {
        const entries = this.mcp.get(directory) ?? new Map<string, Json>();
        const name = String(body?.["name"]);
        entries.set(name, (body?.["config"] ?? {}) as Json);
        this.mcp.set(directory, entries);
        this.#mcpConfigured.set(directory, new Set([...(this.#mcpConfigured.get(directory) ?? []), name]));
        return { status: 200, body: Object.fromEntries([...entries.keys()].map((name) => [name, { status: "connected" as const }])) satisfies V1.McpAddResponses[200] };
      }
      case "mcp.disconnect": {
        // 1.19.6 `MCP.disconnect` needs a configured server; it closes the client and keeps the config.
        const name = matched.pathParams["name"]!;
        if (!(this.#mcpConfigured.get(directory)?.has(name) ?? false)) return { status: 404, body: { _tag: "McpServerNotFoundError", name, message: `MCP server not found: ${name}` } };
        this.mcp.get(directory)?.delete(name);
        return { status: 200, body: true };
      }
      case "config.providers":
        return { status: 200, body: { providers: [this.#v1Provider()], default: { fake: "fake-small" } } satisfies V1.ConfigProvidersResponses[200] };
      default:
        this.world.violation(`the fake does not serve ${matched.operationId}`);
        return { status: 400, body: { _tag: "BadRequest" } };
    }
  }

  #v1Provider(): V1.Provider {
    const model = (id: string, name: string, context: number): V1.Model => ({
      id,
      providerID: "fake",
      api: { id, url: "http://127.0.0.1/fake", npm: "@ai-sdk/openai-compatible" },
      name,
      family: "fake",
      capabilities: { temperature: true, reasoning: false, attachment: false, toolcall: true, input: { text: true, audio: false, image: false, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context, output: 4096 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
      variants: {},
    });
    return { id: "fake", name: "Fake", source: "custom", env: [], options: {}, models: { "fake-small": model("fake-small", "Fake Small", 128000), "fake-large": model("fake-large", "Fake Large", 200000) } };
  }

  /**
   * One page of a 2.x session's messages, as 2.1.2 serves it
   * (`server/src/handlers/message.ts`, `core/src/session/store.ts` `messages`):
   * newest first unless `order` says otherwise, 50 messages unless `limit`
   * says otherwise, and a `next` cursor after the last message of every
   * non-empty page, so the page after the oldest message is empty. A cursor
   * keeps its page's order and may not be combined with `order`; one whose
   * message is gone yields an empty page. The fake's messages are in the order
   * OpenCode stored them, its `seq`.
   */
  #messagePage(session: FakeSession, url: URL): { status: number; body: unknown } {
    const cursorText = url.searchParams.get("cursor") ?? undefined;
    const orderText = url.searchParams.get("order") ?? undefined;
    if (cursorText !== undefined && orderText !== undefined) return { status: 400, body: { _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" } };
    let cursor: MessageCursor | undefined;
    if (cursorText !== undefined) {
      try {
        cursor = decodeCursor(cursorText);
      } catch {
        return { status: 400, body: { _tag: "InvalidCursorError", message: "Invalid cursor" } };
      }
    }
    if (orderText !== undefined && orderText !== "asc" && orderText !== "desc") return { status: 400, body: { _tag: "InvalidRequestError", message: `order is asc or desc, got ${orderText}`, field: "order" } };
    const limitText = url.searchParams.get("limit");
    const limit = limitText === null ? V2_DEFAULT_MESSAGES_LIMIT : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { status: 400, body: { _tag: "InvalidRequestError", message: `limit is an integer from 1 to 200, got ${String(limitText)}`, field: "limit" } };
    const type = url.searchParams.get("type") ?? undefined;
    const order: "asc" | "desc" = cursor?.order ?? (orderText as "asc" | "desc" | undefined) ?? "desc";
    const direction = cursor?.direction ?? "next";
    const walk = direction === "previous" ? (order === "asc" ? "desc" : "asc") : order;
    const seqs = session.messages.map((message, seq) => ({ message, seq }));
    const anchor = cursor === undefined ? undefined : seqs.find((entry) => entry.message.id === cursor.id);
    let rows: typeof seqs = [];
    if (cursor === undefined || anchor !== undefined) {
      rows = seqs.filter((entry) => (type === undefined || entry.message.role === type) && (anchor === undefined || (walk === "asc" ? entry.seq > anchor.seq : entry.seq < anchor.seq)));
      if (walk === "desc") rows.reverse();
      rows = rows.slice(0, limit);
      if (direction === "previous") rows.reverse();
    }
    const first = rows[0]?.message;
    const last = rows.at(-1)?.message;
    const pageCursor = {
      ...(first === undefined ? {} : { previous: encodeCursor({ id: first.id, order, direction: "previous" }) }),
      ...(last === undefined ? {} : { next: encodeCursor({ id: last.id, order, direction: "next" }) }),
    };
    return { status: 200, body: { data: rows.map((entry) => this.v2Message(session, entry.message)), cursor: pageCursor } satisfies V2.MessageListOutput };
  }

  #routeV2(matched: MatchedOperation, url: URL, body: Json | undefined): { status: number; body?: unknown; after?: () => void } {
    const sessionId = matched.pathParams["sessionID"];
    switch (matched.operationId) {
      case "server.info":
        return { status: 200, body: { version: this.world.version, pid: 4242, urls: [this.url], paths: { tmp: "/tmp/opencode" } } satisfies V2.ServerInfo };
      case "session.create": {
        const location = (body?.["location"] ?? {}) as Json;
        const rules = Array.isArray(body?.["permissions"]) ? (body["permissions"] as Rule[]).map((rule) => ({ ...rule })) : [];
        const model = (body?.["model"] ?? undefined) as Json | undefined;
        const session = this.#createSession(String(location["directory"] ?? process.cwd()), typeof body?.["title"] === "string" ? body["title"] : undefined, rules, {
          ...(model === undefined || model === null ? {} : { model: { providerID: String(model["providerID"]), id: String(model["id"]) } }),
          ...(typeof body?.["agent"] === "string" ? { agent: body["agent"] } : {}),
        });
        this.publishV2(session, "session.created", { sessionID: session.id, projectID: "global", location: { directory: session.directory }, slug: session.id.slice(4, 12), title: session.title, permissions: rules, version: this.world.version }, true);
        return { status: 200, body: { data: this.v2Session(session) } };
      }
      case "session.get": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(sessionId!);
        this.world.sessionReads.push({ sessionId: session.id, rules: session.rules.map((rule) => ({ ...rule })) });
        return { status: 200, body: { data: this.v2Session(session) } };
      }
      case "session.update": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(sessionId!);
        if (Array.isArray(body?.["permissions"])) {
          session.rules = (body["permissions"] as Rule[]).map((rule) => ({ ...rule }));
          this.publishV2(session, "session.permissions", { sessionID: session.id, permissions: session.rules }, true);
        }
        return { status: 204 };
      }
      case "session.active":
        return { status: 200, body: { data: Object.fromEntries([...this.#runs.entries()].filter(([, run]) => !run.ended).map(([id]) => [id, { type: "running" as const }])) satisfies V2.SessionActiveOutput } };
      case "session.prompt": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(sessionId!);
        const text = String(body?.["text"] ?? "");
        const steer = body?.["delivery"] === "steer" && body["resume"] === false;
        const system = [...session.instructions.values()].join("\n\n");
        const started = this.#startRun(session, text, system === "" ? undefined : system, steer ? "steer" : "prompt");
        const metadata = steer ? { metadata: { "ari.steer": true } } : {};
        return { status: 200, body: { data: { id: started.messageId, sessionID: session.id, time: { created: Date.now() }, type: "user", payload: { text, ...metadata }, delivery: "steer" } satisfies V2.SessionPromptOutput } };
      }
      case "session.switchModel": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(sessionId!);
        const model = (body?.["model"] ?? {}) as Json;
        session.model = { providerID: String(model["providerID"]), id: String(model["id"]) };
        return { status: 204 };
      }
      case "session.switchAgent": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(sessionId!);
        session.agent = String(body?.["agent"]);
        return { status: 204 };
      }
      case "session.interrupt": {
        const run = sessionId === undefined ? undefined : this.#runs.get(sessionId);
        run?.requestStop("cancel");
        return { status: 200, body: { interrupted: run !== undefined && !run.ended } satisfies V2.SessionInterruptOutput };
      }
      case "session.fork": {
        const source = this.#session(sessionId!);
        if (source === undefined) return this.#notFound(sessionId!);
        const fork = this.#fork(source, typeof body?.["before"] === "string" ? body["before"] : undefined);
        if (!("id" in fork)) return fork;
        // A fork is published as `session.forked`, not `session.created` (2.1.2 `schema/src/session-event.ts` `Forked`).
        this.publishV2(fork, "session.forked", { sessionID: fork.id, parentID: source.id, boundary: { ...fork.forkBoundary! } }, true);
        return { status: 200, body: { data: this.v2Session(fork) } };
      }
      case "session.compact": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(sessionId!);
        const id = this.world.nextId("msg");
        // A compaction is admitted to the inbox and runs as an execution of its own.
        return {
          status: 200,
          body: { data: { id, sessionID: session.id, time: { created: Date.now() }, type: "compaction", payload: {}, delivery: "steer" } satisfies V2.SessionCompactOutput },
          after: () => {
            session.compactions += 1;
            this.publishV2(session, "session.execution.started", { sessionID: session.id }, true);
            this.publishV2(session, "session.compaction.started", { sessionID: session.id, reason: "manual", inputID: id }, true);
            this.publishV2(session, "session.compaction.ended", { sessionID: session.id, reason: "manual", text: "Summary of the conversation." }, true);
            this.publishV2(session, "session.execution.succeeded", { sessionID: session.id }, true);
          },
        };
      }
      case "session.revert.stage": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(sessionId!);
        if (this.#runs.has(session.id)) return { status: 409, body: { _tag: "SessionBusyError", sessionID: session.id, message: "busy" } };
        session.revert = String(body?.["messageID"]);
        return { status: 200, body: { data: { messageID: session.revert } satisfies V2.SessionRevertStageOutput } };
      }
      case "session.revert.commit": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(sessionId!);
        this.world.cleanup(session);
        return { status: 204 };
      }
      case "session.inbox.cancel": {
        const id = matched.pathParams["inboxID"]!;
        const entry = this.#inbox.get(id);
        if (entry === undefined) return { status: 409, body: { _tag: "ConflictError", message: "The inbox item was delivered" } };
        this.#inbox.delete(id);
        const session = this.world.sessions.get(entry.sessionId)!;
        this.publishV2(session, "session.inbox.cancelled", { sessionID: session.id, inboxID: id }, true);
        return { status: 204 };
      }
      case "experimental.session.instructions.entry.put":
      case "experimental.session.instructions.entry.remove": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(sessionId!);
        if (matched.operationId.endsWith(".put")) session.instructions.set(matched.pathParams["key"]!, String(body?.["value"] ?? ""));
        else session.instructions.delete(matched.pathParams["key"]!);
        return { status: 204 };
      }
      case "session.form.reply":
      case "session.form.cancel": {
        const id = matched.pathParams["formID"]!;
        const pending = this.#questions.get(id);
        if (pending === undefined) return { status: 404, body: { _tag: "FormNotFoundError", formID: id, message: "not found" } };
        this.#questions.delete(id);
        const session = this.world.sessions.get(pending.sessionId)!;
        if (matched.operationId === "session.form.reply") this.publishV2(session, "form.replied", { id, sessionID: session.id, answer: (body?.["answer"] ?? {}) as Extract<V2.OpenCodeEvent, { type: "form.replied" }>["data"]["answer"] });
        else this.publishV2(session, "form.cancelled", { id, sessionID: session.id });
        this.#answerWaiters.get(id)?.(matched.operationId === "session.form.reply" ? body?.["answer"] : null);
        return { status: 204 };
      }
      case "session.message.list": {
        const session = this.#session(sessionId!);
        if (session === undefined) return this.#notFound(sessionId!);
        return this.#messagePage(session, url);
      }
      case "session.permission.reply": {
        const decision = body?.["decision"];
        if (decision !== "once" && decision !== "always" && decision !== "reject") return { status: 400, body: { _tag: "InvalidRequestError", message: "bad decision" } };
        if (!this.#reply(matched.pathParams["requestID"]!, decision)) return { status: 404, body: { _tag: "PermissionNotFoundError", requestID: matched.pathParams["requestID"], message: "not found" } };
        return { status: 204 };
      }
      case "experimental.mcp.add":
      case "experimental.mcp.remove": {
        const directory = url.searchParams.get("location[directory]") ?? process.cwd();
        const entries = this.mcp.get(directory) ?? new Map<string, Json>();
        const server = matched.pathParams["server"]!;
        // `MCP.add` replaces any entry of that name in the location; `MCP.remove` needs one (2.1.2 `core/src/mcp/index.ts`).
        if (matched.operationId === "experimental.mcp.add") entries.set(server, (body?.["config"] ?? {}) as Json);
        else if (!entries.delete(server)) return { status: 404, body: { _tag: "McpServerNotFoundError", server, message: `MCP server not found: ${server}` } };
        this.mcp.set(directory, entries);
        return { status: 204 };
      }
      case "model.list": {
        const directory = url.searchParams.get("location[directory]") ?? process.cwd();
        const model = (id: string, name: string, context: number): V2.ModelInfo => ({
          id,
          modelID: id,
          providerID: "fake",
          name,
          capabilities: { tools: true, input: ["text"], output: ["text"], temperature: true },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context, output: 4096 },
        });
        return { status: 200, body: { location: { directory }, data: [model("fake-small", "Fake Small", 128000), model("fake-large", "Fake Large", 200000)] } satisfies V2.ModelListOutput };
      }
      default:
        this.world.violation(`the fake does not serve ${matched.operationId}`);
        return { status: 400, body: { _tag: "InvalidRequestError", message: `not served: ${matched.operationId}` } };
    }
  }
}

/**
 * Starts the fake as `opencode`: `--version` prints the version the way each
 * generation does, `serve` starts a fake server and prints where it listens.
 */
export async function spawnFakeOpencode(world: FakeWorld, request: FakeSpawnRequest): Promise<SpawnedProcess> {
  const args = request.args ?? [];
  world.spawns.push({ args: [...args], env: { ...request.environment }, ...(request.cwd === undefined ? {} : { cwd: request.cwd }) });
  let server: FakeServer | undefined;
  const memory = createMemoryProcess({
    onStdin: () => undefined,
    onStdinClosed: () => undefined,
    onKill: (signal) => {
      if (server !== undefined) void server.exit(null, signal);
      else memory.exit(null, signal);
    },
  });
  if (args[0] === "--version" || args[0] === "-v") {
    queueMicrotask(() => {
      // 1.x prints the bare version (1.x `cli` `--version`); 2.1.2 prints `opencode v2.1.2` (run by hand).
      memory.stdout(world.generation === 1 ? `${world.version}\n` : `opencode v${world.version}\n`);
      memory.exit(0, null);
    });
    return memory.process;
  }
  if (args[0] === "serve") {
    const password = world.generation === 1 ? request.environment["OPENCODE_SERVER_PASSWORD"] : request.environment["OPENCODE_PASSWORD"];
    server = new FakeServer(world, password);
    const url = await server.listen((code, signal) => memory.exit(code, signal));
    // 1.x `cli/cmd/serve.ts`; 2.1.2 printed `Server listening on <url>` (run by hand).
    if (world.generation === 1 && password === undefined) memory.stdout("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\n");
    memory.stdout(world.generation === 1 ? `opencode server listening on ${url}\n` : `Server listening on ${url}\n`);
    return memory.process;
  }
  queueMicrotask(() => {
    memory.stderr(`fake opencode: unknown command ${args.join(" ")}\n`);
    memory.exit(1, null);
  });
  return memory.process;
}

/** An external server: started by the test, not by the driver. */
export async function startExternalServer(world: FakeWorld, password: string | undefined): Promise<FakeServer> {
  const server = new FakeServer(world, password);
  await server.listen(() => undefined);
  return server;
}
