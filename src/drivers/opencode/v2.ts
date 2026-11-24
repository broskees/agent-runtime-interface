// OpenCode 2.x, through `@opencode/client` (the API of OpenCode 2.1.2,
// vendor-schemas/opencode/2.1.2/openapi.json, fetched from the server's own
// `GET /openapi.json`). One 2.x server serves every directory; sessions name
// their directory once, at creation, and events stream from `GET /api/event`.
//
// Facts from the 2.1.2 source the runtime relies on:
// - Work happens in executions: `session.execution.started`, then exactly one
//   of `succeeded`, `failed` or `interrupted` per busy period
//   (`core/src/session/execution.ts`). That terminal is the authoritative end
//   of a turn.
// - A prompt is admitted to the session's inbox and wakes the execution
//   unless `resume: false` (`core/src/session/session.ts` `prompt`). With
//   `delivery: "steer"` and `resume: false`, a prompt joins a running
//   execution at its next step and never starts one, so a steer that arrives
//   after the execution ended stays pending; the runtime then cancels it and
//   reports that it missed its turn.
// - Text and reasoning stream as `session.text.*` / `session.reasoning.*`
//   events named by the assistant message and the part's ordinal; tools as
//   `session.tool.*` events named by the tool call id.

import { callErrors } from "../../errors.ts";
import type { CatalogModel, McpEntry, NativeError, NativeEvent, NativeMessage, NativeQuestion, NativeRule, NativeRuntime, NativeSessionInfo, NativeToolState, PromptInput } from "./native.ts";
import { fromV2Rules } from "./rules.ts";
import type { V2Client, V2Sdk } from "./sdk.ts";
import type { ServerEndpoint } from "./server.ts";

type Json = { readonly [key: string]: unknown };

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Marks a user message the driver sent as a steer, so history rebuilds it as part of the turn it joined. */
export const STEER_METADATA_KEY = "ari.steer";

/** Calls the client and turns what it throws into ARI call errors. */
async function call<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw v2CallError(error, what);
  }
}

function v2CallError(error: unknown, what: string): Error {
  const tag = isObject(error) ? str(error["_tag"]) : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (tag === "SessionNotFoundError" || tag === "MessageNotFoundError" || tag === "PermissionNotFoundError" || tag === "FormNotFoundError" || tag === "McpServerNotFoundError") {
    return callErrors.notFound({ resource: what, message: `OpenCode has no ${what}: ${message}` });
  }
  if (tag === "UnauthorizedError") return callErrors.authRequired([], `The OpenCode server refused the request: ${message}`);
  if (tag === "InvalidRequestError") return callErrors.validation([{ message, path: [] }], `OpenCode refused ${what}: ${message}`);
  if (tag === "SessionBusyError" || tag === "ConflictError") return callErrors.invalidState("session_busy", `OpenCode refused ${what}: ${message}`);
  const reason = isObject(error) ? str(error["reason"]) : undefined;
  if (reason === "Transport") return callErrors.transport(`Could not reach the OpenCode server for ${what}: ${message}`);
  return callErrors.protocol("opencode_error", `OpenCode failed ${what}: ${message}`);
}

/** A 2.x structured error (`{ type, message, status?, retryAfterMs? }`) as a neutral error; `at` is when the server published it. */
export function v2Error(error: unknown, at: number | undefined): NativeError {
  if (!isObject(error)) return { kind: "provider", message: "OpenCode reported an error" };
  const type = str(error["type"]) ?? "unknown";
  const message = str(error["message"]) ?? type;
  const status = typeof error["status"] === "number" ? error["status"] : undefined;
  const retryAfterMs = typeof error["retryAfterMs"] === "number" ? error["retryAfterMs"] : undefined;
  // OpenCode types an empty balance as provider.quota with HTTP 402; that never resets.
  if (type === "provider.rate-limit" || (type === "provider.quota" && status !== 402)) {
    return { kind: "usage_limit", message, code: type, ...(retryAfterMs === undefined || at === undefined ? {} : { resetAt: new Date(at + retryAfterMs).toISOString() }) };
  }
  if (type === "provider.auth" || status === 401) return { kind: "auth", message, code: type };
  return { kind: "provider", message, code: type };
}

function toolText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((entry: unknown) => (isObject(entry) && entry["type"] === "text" && typeof entry["text"] === "string" ? [entry["text"]] : [])).join("\n");
  return text;
}

function sessionInfo(value: unknown): NativeSessionInfo {
  if (!isObject(value) || typeof value["id"] !== "string") throw callErrors.protocol("bad_session", "OpenCode answered without a session");
  const location = isObject(value["location"]) ? value["location"] : {};
  return {
    id: value["id"],
    directory: str(location["directory"]) ?? "",
    ...(typeof value["parentID"] === "string" ? { parentId: value["parentID"] } : {}),
    ...(typeof value["title"] === "string" ? { title: value["title"] } : {}),
  };
}

function formQuestions(fields: unknown): NativeQuestion[] {
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((field: unknown): NativeQuestion[] => {
    if (!isObject(field) || typeof field["key"] !== "string" || field["hidden"] === true) return [];
    const options = Array.isArray(field["options"])
      ? field["options"].flatMap((option: unknown) => (isObject(option) && typeof option["value"] === "string" ? [{ id: option["value"], label: str(option["label"]) ?? option["value"], ...(typeof option["description"] === "string" ? { description: option["description"] } : {}) }] : []))
      : [];
    const prompt = [str(field["title"]), str(field["description"])].filter((part): part is string => part !== undefined && part !== "").join("\n\n");
    if (field["type"] === "multiselect") return [{ id: field["key"], prompt, kind: "multi_select" as const, options, allowCustom: field["custom"] === true }];
    if (field["type"] === "string") return [{ id: field["key"], prompt, kind: options.length > 0 ? ("single_select" as const) : ("text" as const), options, allowCustom: options.length === 0 || field["custom"] === true }];
    return [];
  });
}

/** Follows the 2.x event stream and turns it into neutral events. */
class V2Translator {
  readonly #toolNames = new Map<string, string>();
  readonly #toolMessages = new Map<string, string>();

  translate(event: unknown): NativeEvent[] {
    if (!isObject(event)) return [];
    const type = str(event["type"]);
    const created = typeof event["created"] === "number" ? event["created"] : undefined;
    const payload = isObject(event["data"]) ? event["data"] : {};
    const sessionId = str(payload["sessionID"]);
    switch (type) {
      case "session.execution.started":
        return sessionId === undefined ? [] : [{ type: "busy", sessionId }];
      case "session.execution.succeeded":
        return sessionId === undefined ? [] : [{ type: "idle", sessionId, outcome: "completed" }];
      case "session.execution.failed":
        return sessionId === undefined ? [] : [{ type: "idle", sessionId, outcome: "failed", error: v2Error(payload["error"], created) }];
      case "session.execution.interrupted":
        return sessionId === undefined ? [] : [{ type: "idle", sessionId, outcome: "interrupted", error: { kind: "aborted", message: `OpenCode interrupted the execution (${str(payload["reason"]) ?? "user"})` } }];
      case "session.inbox.enqueued": {
        const inboxId = str(payload["inboxID"]);
        const item = isObject(payload["item"]) ? payload["item"] : {};
        const itemPayload = isObject(item["payload"]) ? item["payload"] : {};
        const metadata = isObject(itemPayload["metadata"]) ? itemPayload["metadata"] : {};
        if (sessionId === undefined || inboxId === undefined || item["type"] !== "user") return [];
        // Admission names the prompt; it comes before the execution it wakes.
        return [{ type: "user", sessionId, messageId: inboxId, text: str(itemPayload["text"]) ?? "", steer: metadata[STEER_METADATA_KEY] === true }];
      }
      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended":
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended": {
        const messageId = str(payload["assistantMessageID"]);
        const ordinal = typeof payload["ordinal"] === "number" ? payload["ordinal"] : undefined;
        if (sessionId === undefined || messageId === undefined || ordinal === undefined) return [];
        const field = type.startsWith("session.text.") ? ("text" as const) : ("reasoning" as const);
        const partId = `${messageId}#${field}${ordinal}`;
        if (type.endsWith(".delta")) return [{ type: "part", sessionId, messageId, partId, field, delta: str(payload["delta"]) ?? "", done: false }];
        if (type.endsWith(".ended")) return [{ type: "part", sessionId, messageId, partId, field, text: str(payload["text"]) ?? "", done: true }];
        return [{ type: "part", sessionId, messageId, partId, field, text: "", done: false }];
      }
      case "session.tool.input.started": {
        const id = str(payload["id"]);
        const messageId = str(payload["assistantMessageID"]);
        if (sessionId === undefined || id === undefined || messageId === undefined) return [];
        const name = str(payload["name"]) ?? "tool";
        this.#toolNames.set(id, name);
        this.#toolMessages.set(id, messageId);
        return [{ type: "tool", sessionId, messageId, state: { callId: id, tool: name, status: "pending", input: {} } }];
      }
      case "session.tool.called":
      case "session.tool.success":
      case "session.tool.failed": {
        const id = str(payload["id"]);
        const messageId = str(payload["assistantMessageID"]) ?? (id === undefined ? undefined : this.#toolMessages.get(id));
        if (sessionId === undefined || id === undefined || messageId === undefined) return [];
        const tool = this.#toolNames.get(id) ?? "tool";
        const metadata = isObject(payload["metadata"]) ? payload["metadata"] : {};
        const childSessionId = str(metadata["sessionID"]) ?? str(metadata["sessionId"]);
        if (type === "session.tool.called") return [{ type: "tool", sessionId, messageId, state: { callId: id, tool, status: "running", input: payload["input"] ?? {} } }];
        if (type === "session.tool.success") {
          const output = toolText(payload["content"]);
          return [{ type: "tool", sessionId, messageId, state: { callId: id, tool, status: "completed", input: {}, ...(output === undefined ? {} : { output }), ...(childSessionId === undefined ? {} : { childSessionId }) } }];
        }
        const error = v2Error(payload["error"], created);
        return [{ type: "tool", sessionId, messageId, state: { callId: id, tool, status: "error", input: {}, error: error.message } }];
      }
      case "permission.asked": {
        const requestId = str(payload["id"]);
        if (sessionId === undefined || requestId === undefined) return [];
        const source = isObject(payload["source"]) ? payload["source"] : {};
        return [
          {
            type: "permission",
            sessionId,
            requestId,
            action: str(payload["action"]) ?? "permission",
            resources: Array.isArray(payload["resources"]) ? payload["resources"].filter((entry): entry is string => typeof entry === "string") : [],
            always: Array.isArray(payload["save"]) ? payload["save"].filter((entry): entry is string => typeof entry === "string") : [],
            metadata: isObject(payload["metadata"]) ? payload["metadata"] : {},
            ...(source["type"] === "tool" && typeof source["id"] === "string" ? { callId: source["id"] } : {}),
          },
        ];
      }
      case "permission.replied": {
        const requestId = str(payload["requestID"]);
        return sessionId === undefined || requestId === undefined ? [] : [{ type: "permission.replied", sessionId, requestId, reply: str(payload["reply"]) ?? "" }];
      }
      case "form.created": {
        const form = isObject(payload["form"]) ? payload["form"] : {};
        const formSession = str(form["sessionID"]);
        const formId = str(form["id"]);
        if (formSession === undefined || formId === undefined) return [];
        return [{ type: "question", sessionId: formSession, requestId: formId, title: str(form["title"]) ?? "", questions: formQuestions(form["fields"]) }];
      }
      case "form.replied":
      case "form.cancelled": {
        const formId = str(payload["id"]);
        return sessionId === undefined || formId === undefined ? [] : [{ type: "question.closed", sessionId, requestId: formId }];
      }
      case "session.created": {
        const location = isObject(payload["location"]) ? payload["location"] : {};
        if (sessionId === undefined) return [];
        return [{ type: "session", info: { id: sessionId, directory: str(location["directory"]) ?? "", ...(typeof payload["parentID"] === "string" ? { parentId: payload["parentID"] } : {}) } }];
      }
      case "session.compaction.started":
        return sessionId === undefined ? [] : [{ type: "compaction", sessionId, status: "started" }];
      case "session.compaction.ended":
      case "session.compaction.failed":
        return sessionId === undefined ? [] : [{ type: "compaction", sessionId, status: "ended" }];
      case "session.retry.scheduled": {
        if (sessionId === undefined) return [];
        const at = typeof payload["at"] === "number" ? payload["at"] : undefined;
        return [{ type: "retry", sessionId, attempt: typeof payload["attempt"] === "number" ? payload["attempt"] : 1, retryDelayMs: at === undefined || created === undefined ? null : Math.max(0, at - created) }];
      }
      case "session.step.ended": {
        if (sessionId === undefined) return [];
        const tokens = isObject(payload["tokens"]) ? payload["tokens"] : {};
        return [
          {
            type: "usage",
            sessionId,
            ...(typeof tokens["input"] === "number" ? { inputTokens: tokens["input"] } : {}),
            ...(typeof tokens["output"] === "number" ? { outputTokens: tokens["output"] } : {}),
            ...(typeof payload["cost"] === "number" ? { costUsd: payload["cost"] } : {}),
          },
        ];
      }
      default:
        return [];
    }
  }
}

function historyMessage(value: unknown): NativeMessage | undefined {
  if (!isObject(value) || typeof value["id"] !== "string") return undefined;
  const time = isObject(value["time"]) ? value["time"] : {};
  const at = typeof time["created"] === "number" ? time["created"] : 0;
  if (value["type"] === "user") {
    const metadata = isObject(value["metadata"]) ? value["metadata"] : {};
    return { id: value["id"], role: "user", text: str(value["text"]) ?? "", reasoning: "", parts: [], tools: [], time: at, ...(metadata[STEER_METADATA_KEY] === true ? { steer: true } : {}) };
  }
  if (value["type"] !== "assistant") return undefined;
  const content = Array.isArray(value["content"]) ? value["content"].filter(isObject) : [];
  const tools: NativeToolState[] = content.flatMap((part) => {
    if (part["type"] !== "tool" || typeof part["id"] !== "string" || typeof part["name"] !== "string") return [];
    const state = isObject(part["state"]) ? part["state"] : {};
    const status = state["status"] === "completed" ? "completed" : state["status"] === "error" ? "error" : state["status"] === "running" ? "running" : "pending";
    const output = toolText(state["content"]);
    const error = status === "error" ? v2Error(state["error"], undefined).message : undefined;
    return [{ callId: part["id"], tool: part["name"], status, input: state["input"] ?? {}, ...(output === undefined ? {} : { output }), ...(error === undefined ? {} : { error }) }];
  });
  const error = value["error"] === undefined ? undefined : v2Error(value["error"], typeof time["completed"] === "number" ? time["completed"] : undefined);
  const messageId = value["id"];
  // Live events name a text or reasoning part by its ordinal: its place in the message's content.
  const parts = content.flatMap((part, ordinal) => (part["type"] === "text" || part["type"] === "reasoning" ? [{ id: `${messageId}#${String(part["type"])}${ordinal}`, field: part["type"] === "text" ? ("text" as const) : ("reasoning" as const), text: str(part["text"]) ?? "" }] : []));
  return {
    id: value["id"],
    role: "assistant",
    text: content
      .filter((part) => part["type"] === "text")
      .map((part) => str(part["text"]) ?? "")
      .join(""),
    reasoning: content
      .filter((part) => part["type"] === "reasoning")
      .map((part) => str(part["text"]) ?? "")
      .join(""),
    parts,
    tools,
    time: at,
    ...(isObject(value["model"]) && typeof value["model"]["providerID"] === "string" && typeof value["model"]["id"] === "string" ? { model: `${value["model"]["providerID"]}/${value["model"]["id"]}` } : {}),
    ...(error === undefined ? {} : { error }),
  };
}

function modelRef(model: string | undefined): { id: string; providerID: string } | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw callErrors.validation([{ message: `an OpenCode model is "provider/model", got "${model}"`, path: ["config", "model"] }]);
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

/** The instruction entry key the driver keeps a thread's host instructions under. */
export const INSTRUCTIONS_KEY = "ari";

/** An OpenCode 2.x server as a `NativeRuntime`. One runtime is shared by every session of an instance. */
export class V2Runtime implements NativeRuntime {
  readonly generation = 2 as const;
  readonly version: string;
  readonly #client: V2Client;
  /** The model and agent each session last used, so a prompt switches only on a change. */
  readonly #selected = new Map<string, { model?: string; agent?: string }>();
  /** The instructions each session holds, so the entry is written only on a change. */
  readonly #instructions = new Map<string, string>();

  constructor(sdk: V2Sdk, endpoint: ServerEndpoint) {
    this.version = endpoint.version;
    this.#client = sdk.OpenCode.make({ baseUrl: endpoint.url, ...(endpoint.authorization === undefined ? {} : { headers: { authorization: endpoint.authorization } }) });
  }

  /** 2.x streams every directory's events from one endpoint; `directory` is not needed. */
  async watch(_directory: string, onEvent: (event: NativeEvent) => void, onEnd: (error: unknown) => void): Promise<{ close(): void }> {
    const controller = new AbortController();
    const translator = new V2Translator();
    const iterator = this.#client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    let resolveConnected: () => void = () => undefined;
    let rejectConnected: (error: unknown) => void = () => undefined;
    const connected = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });
    void (async () => {
      let failure: unknown;
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done === true) break;
          const event = next.value;
          if (isObject(event) && event["type"] === "server.connected") {
            resolveConnected();
            continue;
          }
          for (const translated of translator.translate(event)) onEvent(translated);
        }
      } catch (error) {
        failure = error;
      }
      const reason = failure ?? callErrors.transport("The OpenCode event stream ended");
      rejectConnected(reason);
      if (!controller.signal.aborted) onEnd(reason);
    })();
    await connected;
    return { close: () => controller.abort() };
  }

  async createSession(input: { directory: string; title?: string; rules: readonly NativeRule[]; model?: string; agent?: string }): Promise<NativeSessionInfo> {
    const model = modelRef(input.model);
    const created = sessionInfo(
      await call("session", () =>
        this.#client.session.create({
          location: { directory: input.directory },
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          ...(model === undefined ? {} : { model }),
          permissions: input.rules.map((rule) => ({ ...rule })),
        }),
      ),
    );
    this.#selected.set(created.id, { ...(input.model === undefined ? {} : { model: input.model }), ...(input.agent === undefined ? {} : { agent: input.agent }) });
    return created;
  }

  async getSession(sessionId: string): Promise<NativeSessionInfo | undefined> {
    try {
      return sessionInfo(await this.#client.session.get({ sessionID: sessionId }));
    } catch (error) {
      if (isObject(error) && error["_tag"] === "SessionNotFoundError") return undefined;
      throw v2CallError(error, `session ${sessionId}`);
    }
  }

  async setRules(sessionId: string, _directory: string, rules: readonly NativeRule[]): Promise<void> {
    await call(`session ${sessionId}`, () => this.#client.session.update({ sessionID: sessionId, permissions: rules.map((rule) => ({ ...rule })) }));
  }

  async getRules(sessionId: string): Promise<readonly NativeRule[]> {
    const session = await call(`session ${sessionId}`, () => this.#client.session.get({ sessionID: sessionId }));
    return fromV2Rules(isObject(session) ? session["permissions"] : undefined);
  }

  async messages(sessionId: string): Promise<NativeMessage[]> {
    const page = await call(`session ${sessionId}`, () => this.#client.message.list({ sessionID: sessionId }));
    const data = isObject(page) && Array.isArray(page["data"]) ? page["data"] : [];
    return data.flatMap((entry) => {
      const message = historyMessage(entry);
      return message === undefined ? [] : [message];
    });
  }

  /** Keeps a session's model, agent and host instructions as the prompt asks, changing each only when it differs. */
  async #prepare(input: PromptInput): Promise<void> {
    const selected = this.#selected.get(input.sessionId) ?? {};
    const model = modelRef(input.model);
    if (model !== undefined && input.model !== selected.model) {
      await call(`session ${input.sessionId}`, () => this.#client.session.switchModel({ sessionID: input.sessionId, model }));
      selected.model = input.model;
    }
    if (input.agent !== undefined && input.agent !== selected.agent) {
      const agent = input.agent;
      await call(`session ${input.sessionId}`, () => this.#client.session.switchAgent({ sessionID: input.sessionId, agent }));
      selected.agent = agent;
    }
    this.#selected.set(input.sessionId, selected);
    const instructions = input.system ?? "";
    if (instructions !== (this.#instructions.get(input.sessionId) ?? "")) {
      if (instructions === "") await call(`session ${input.sessionId}`, () => this.#client.session.instructions.entry.remove({ sessionID: input.sessionId, key: INSTRUCTIONS_KEY }));
      else await call(`session ${input.sessionId}`, () => this.#client.session.instructions.entry.put({ sessionID: input.sessionId, key: INSTRUCTIONS_KEY, value: instructions }));
      this.#instructions.set(input.sessionId, instructions);
    }
  }

  async prompt(input: PromptInput): Promise<{ messageId?: string }> {
    await this.#prepare(input);
    const admitted = await call(`session ${input.sessionId}`, () =>
      this.#client.session.prompt({
        sessionID: input.sessionId,
        text: input.text,
        ...(input.files.length === 0 ? {} : { files: input.files.map((file) => ({ uri: file.url, name: file.name })) }),
      }),
    );
    const messageId = isObject(admitted) ? str(admitted["id"]) : undefined;
    return messageId === undefined ? {} : { messageId };
  }

  async steer(input: PromptInput): Promise<{ joined: boolean; messageId?: string }> {
    const admitted = await call(`session ${input.sessionId}`, () =>
      this.#client.session.prompt({
        sessionID: input.sessionId,
        text: input.text,
        ...(input.files.length === 0 ? {} : { files: input.files.map((file) => ({ uri: file.url, name: file.name })) }),
        metadata: { [STEER_METADATA_KEY]: true },
        delivery: "steer",
        resume: false,
      }),
    );
    const messageId = isObject(admitted) ? str(admitted["id"]) : undefined;
    if (messageId === undefined) throw callErrors.protocol("bad_inbox_item", "OpenCode admitted the steer without an id");
    const active = await call("active sessions", () => this.#client.session.active());
    if (isObject(active) && isObject(active[input.sessionId])) return { joined: true, messageId };
    // No execution is running: the steer would wait for the next prompt. Take it back.
    try {
      await this.#client.session.inbox.cancel({ sessionID: input.sessionId, inboxID: messageId });
    } catch (error) {
      // Already delivered: an execution took it after all.
      if (isObject(error) && (error["_tag"] === "ConflictError" || error["_tag"] === "SessionBusyError")) return { joined: true, messageId };
      throw v2CallError(error, `inbox item ${messageId}`);
    }
    return { joined: false, messageId };
  }

  async interrupt(sessionId: string): Promise<void> {
    await call(`session ${sessionId}`, () => this.#client.session.interrupt({ sessionID: sessionId }));
  }

  async replyPermission(sessionId: string, _directory: string, requestId: string, reply: "once" | "always" | "reject"): Promise<void> {
    await call(`permission request ${requestId}`, () => this.#client.permission.reply({ sessionID: sessionId, requestID: requestId, decision: reply }));
  }

  async replyQuestion(sessionId: string, _directory: string, requestId: string, answers: ReadonlyArray<readonly string[]> | undefined, questions: readonly NativeQuestion[]): Promise<void> {
    if (answers === undefined) {
      await call(`form ${requestId}`, () => this.#client.session.form.cancel({ sessionID: sessionId, formID: requestId }));
      return;
    }
    const answer: { [key: string]: string | string[] } = {};
    questions.forEach((question, index) => {
      const given = answers[index] ?? [];
      answer[question.id] = question.kind === "multi_select" ? [...given] : (given[0] ?? "");
    });
    await call(`form ${requestId}`, () => this.#client.session.form.reply({ sessionID: sessionId, formID: requestId, answer }));
  }

  async fork(sessionId: string, _directory: string, beforeMessageId: string | undefined): Promise<NativeSessionInfo> {
    const forked = sessionInfo(await call(`session ${sessionId}`, () => this.#client.session.fork({ sessionID: sessionId, ...(beforeMessageId === undefined ? {} : { before: beforeMessageId }) })));
    const selected = this.#selected.get(sessionId);
    if (selected !== undefined) this.#selected.set(forked.id, { ...selected });
    return forked;
  }

  async revert(sessionId: string, _directory: string, messageId: string): Promise<void> {
    await call(`session ${sessionId}`, () => this.#client.session.revert.stage({ sessionID: sessionId, messageID: messageId }));
    await call(`session ${sessionId}`, () => this.#client.session.revert.commit({ sessionID: sessionId }));
  }

  async compact(sessionId: string): Promise<void> {
    await call(`session ${sessionId}`, () => this.#client.session.compact({ sessionID: sessionId }));
  }

  async addMcp(entry: McpEntry): Promise<void> {
    await call(`MCP server ${entry.name}`, () => this.#client.mcp.add({ server: entry.name, location: { directory: entry.directory }, config: entry.config }));
  }

  async removeMcp(name: string, directory: string): Promise<void> {
    await call(`MCP server ${name}`, () => this.#client.mcp.remove({ server: name, location: { directory } }));
  }

  async models(directory: string): Promise<{ models: CatalogModel[]; defaultModel?: string }> {
    const listed = await call("models", () => this.#client.model.list({ location: { directory } }));
    const data = isObject(listed) && Array.isArray(listed["data"]) ? listed["data"].filter(isObject) : [];
    const models = data.flatMap((model) => {
      if (model["enabled"] === false || typeof model["providerID"] !== "string" || typeof model["modelID"] !== "string") return [];
      const limit = isObject(model["limit"]) ? model["limit"] : {};
      const context = typeof limit["context"] === "number" && Number.isInteger(limit["context"]) && limit["context"] > 0 ? limit["context"] : undefined;
      return [{ id: `${model["providerID"]}/${model["modelID"]}`, label: str(model["name"]) ?? String(model["modelID"]), ...(context === undefined ? {} : { contextWindow: context }) }];
    });
    return { models };
  }
}
