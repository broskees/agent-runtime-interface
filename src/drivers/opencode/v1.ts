// OpenCode 1.x, through `@opencode-ai/sdk/v2` (the API of OpenCode 1.19.6,
// vendor-schemas/opencode/1.19.6/openapi.json). A 1.x server serves each
// directory as its own instance: every call names the directory, and events
// stream per directory from `GET /event`.
//
// Facts from the 1.19.6 source the runtime relies on:
// - `session.prompt_async` answers 204 at once; the run reports
//   `session.status` busy, then `session.status` idle followed by
//   `session.idle` when it ends (`session/status.ts` `set`). The idle is the
//   authoritative end of a turn.
// - A run that fails publishes `session.error` and leaves the error on the
//   assistant message; an aborted run's message carries `MessageAbortedError`
//   (`session/processor.ts`).
// - Text and reasoning parts open with `message.part.updated`, stream with
//   `message.part.delta` (`field: "text"`) and close with a
//   `message.part.updated` that has `time.end`.
// - A prompt sent while a run is active joins that run at its next step, and
//   one sent after it ended starts a new run (`session/prompt.ts` `loop`,
//   `effect/runner.ts` `ensureRunning`): there is no way to refuse a late
//   steer, so the driver declares steering off for 1.x.

import { callErrors } from "../../errors.ts";
import type { CatalogModel, McpEntry, NativeError, NativeEvent, NativeMessage, NativeQuestion, NativeRule, NativeRuntime, NativeSessionInfo, NativeToolState, PromptInput } from "./native.ts";
import { fromV1Rules, toV1Rules } from "./rules.ts";
import type { V1Client, V1Result, V1Sdk } from "./sdk.ts";
import type { ServerEndpoint } from "./server.ts";

type Json = { readonly [key: string]: unknown };

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The SDK's result as data, or an ARI call error that says what the server answered. */
function data(result: V1Result, what: string): unknown {
  if (result.error === undefined && (result.response === undefined || result.response.status < 400)) return result.data;
  const status = result.response?.status;
  const body = result.error;
  const message = isObject(body) ? (str(body["message"]) ?? str((body["data"] as Json | undefined)?.["message"]) ?? JSON.stringify(body)) : String(body);
  if (status === 404) throw callErrors.notFound({ resource: what, message: `OpenCode has no ${what}: ${message}` });
  if (status === 401) throw callErrors.authRequired([], `The OpenCode server refused the request: ${message}`);
  if (status === 400) throw callErrors.validation([{ message, path: [] }], `OpenCode refused ${what}: ${message}`);
  throw callErrors.protocol("opencode_error", `OpenCode answered ${status ?? "an error"} for ${what}: ${message}`);
}

/** A 1.x error object (`ProviderAuthError`, `APIError`, `MessageAbortedError`, ...) as a neutral error. */
export function v1Error(error: unknown, base: number | undefined): NativeError | undefined {
  if (!isObject(error)) return undefined;
  const name = str(error["name"]) ?? "UnknownError";
  const details = isObject(error["data"]) ? error["data"] : {};
  const message = str(details["message"]) ?? name;
  if (name === "MessageAbortedError") return { kind: "aborted", message, code: name };
  if (name === "ProviderAuthError") return { kind: "auth", message, code: name };
  if (name === "APIError" && details["statusCode"] === 429) {
    const headers = isObject(details["responseHeaders"]) ? details["responseHeaders"] : {};
    const retryAfter = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
    let resetAt: string | undefined;
    if (typeof retryAfter === "string") {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && retryAfter.trim() !== "" && base !== undefined) resetAt = new Date(base + seconds * 1000).toISOString();
      else if (!Number.isNaN(Date.parse(retryAfter))) resetAt = new Date(Date.parse(retryAfter)).toISOString();
    }
    return { kind: "usage_limit", message, code: name, ...(resetAt === undefined ? {} : { resetAt }) };
  }
  return { kind: "provider", message, code: name };
}

function toolState(part: Json): NativeToolState | undefined {
  const callId = str(part["callID"]);
  const tool = str(part["tool"]);
  const state = isObject(part["state"]) ? part["state"] : undefined;
  const status = str(state?.["status"]);
  if (callId === undefined || tool === undefined || state === undefined || (status !== "pending" && status !== "running" && status !== "completed" && status !== "error")) return undefined;
  const metadata = isObject(state["metadata"]) ? state["metadata"] : {};
  const output = status === "completed" ? str(state["output"]) : str(metadata["output"]);
  const childSessionId = str(metadata["sessionId"]) ?? str(metadata["sessionID"]);
  return {
    callId,
    tool,
    status,
    input: state["input"] ?? {},
    ...(output === undefined ? {} : { output }),
    ...(status === "error" && str(state["error"]) !== undefined ? { error: str(state["error"])! } : {}),
    ...(str(state["title"]) === undefined ? {} : { title: str(state["title"])! }),
    ...(childSessionId === undefined ? {} : { childSessionId }),
  };
}

function sessionInfo(value: unknown): NativeSessionInfo {
  if (!isObject(value) || typeof value["id"] !== "string" || typeof value["directory"] !== "string") throw callErrors.protocol("bad_session", "OpenCode answered without a session");
  return {
    id: value["id"],
    directory: value["directory"],
    ...(typeof value["parentID"] === "string" ? { parentId: value["parentID"] } : {}),
    ...(typeof value["title"] === "string" ? { title: value["title"] } : {}),
  };
}

function questions(value: unknown): NativeQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown, index) => {
    if (!isObject(entry)) return [];
    const options = Array.isArray(entry["options"]) ? entry["options"].flatMap((option: unknown) => (isObject(option) && typeof option["label"] === "string" ? [{ id: option["label"], label: option["label"], ...(typeof option["description"] === "string" ? { description: option["description"] } : {}) }] : [])) : [];
    return [
      {
        id: String(index),
        prompt: str(entry["question"]) ?? "",
        ...(typeof entry["header"] === "string" ? { header: entry["header"] } : {}),
        kind: options.length === 0 ? ("text" as const) : entry["multiple"] === true ? ("multi_select" as const) : ("single_select" as const),
        options,
        allowCustom: entry["custom"] !== false,
      },
    ];
  });
}

function splitModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw callErrors.validation([{ message: `an OpenCode model is "provider/model", got "${model}"`, path: ["config", "model"] }]);
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/** Tracks what a 1.x event stream says about each session, to turn it into neutral events. */
class V1Translator {
  /** Kind of each part by id (deltas carry only `field: "text"`). */
  readonly #partKinds = new Map<string, "text" | "reasoning">();
  readonly #userMessages = new Set<string>();
  readonly #announcedUsers = new Set<string>();
  /** The error each session's current run ended with, from `session.error` or the assistant message. */
  readonly #errors = new Map<string, NativeError>();
  readonly #busy = new Set<string>();

  translate(event: unknown): NativeEvent[] {
    if (!isObject(event)) return [];
    const type = str(event["type"]);
    const properties = isObject(event["properties"]) ? event["properties"] : {};
    const sessionId = str(properties["sessionID"]);
    switch (type) {
      case "session.status": {
        const status = isObject(properties["status"]) ? properties["status"] : {};
        if (sessionId === undefined) return [];
        if (status["type"] === "busy") {
          if (this.#busy.has(sessionId)) return [];
          this.#busy.add(sessionId);
          this.#errors.delete(sessionId);
          return [{ type: "busy", sessionId }];
        }
        if (status["type"] === "retry") {
          const next = typeof status["next"] === "number" ? status["next"] : undefined;
          return [{ type: "retry", sessionId, attempt: typeof status["attempt"] === "number" ? status["attempt"] : 1, retryDelayMs: next === undefined ? null : Math.max(0, next - Date.now()) }];
        }
        return [];
      }
      case "session.idle": {
        if (sessionId === undefined) return [];
        this.#busy.delete(sessionId);
        const error = this.#errors.get(sessionId);
        this.#errors.delete(sessionId);
        if (error === undefined) return [{ type: "idle", sessionId, outcome: "completed" }];
        return [{ type: "idle", sessionId, outcome: error.kind === "aborted" ? "interrupted" : "failed", error }];
      }
      case "session.error": {
        const error = v1Error(properties["error"], undefined);
        if (sessionId === undefined || error === undefined) return [];
        if (!this.#errors.has(sessionId) || error.kind !== "provider") this.#errors.set(sessionId, error);
        return [{ type: "error", sessionId, error }];
      }
      case "message.updated": {
        const info = isObject(properties["info"]) ? properties["info"] : {};
        const id = str(info["id"]);
        const owner = str(info["sessionID"]) ?? sessionId;
        if (id === undefined || owner === undefined) return [];
        if (info["role"] === "user") {
          this.#userMessages.add(id);
          return [];
        }
        const events: NativeEvent[] = [];
        const time = isObject(info["time"]) ? info["time"] : {};
        const error = v1Error(info["error"], typeof time["completed"] === "number" ? time["completed"] : typeof time["created"] === "number" ? time["created"] : undefined);
        if (error !== undefined) this.#errors.set(owner, error);
        if (typeof time["completed"] === "number" && isObject(info["tokens"])) {
          const tokens = info["tokens"];
          const model = typeof info["providerID"] === "string" && typeof info["modelID"] === "string" ? `${info["providerID"]}/${info["modelID"]}` : undefined;
          events.push({
            type: "usage",
            sessionId: owner,
            ...(model === undefined ? {} : { model }),
            ...(typeof tokens["input"] === "number" ? { inputTokens: tokens["input"] } : {}),
            ...(typeof tokens["output"] === "number" ? { outputTokens: tokens["output"] } : {}),
            ...(typeof info["cost"] === "number" ? { costUsd: info["cost"] } : {}),
          });
        }
        return events;
      }
      case "message.part.updated": {
        const part = isObject(properties["part"]) ? properties["part"] : {};
        const owner = str(part["sessionID"]) ?? sessionId;
        const messageId = str(part["messageID"]);
        const partId = str(part["id"]);
        if (owner === undefined || messageId === undefined || partId === undefined) return [];
        const partType = str(part["type"]);
        if (partType === "text" || partType === "reasoning") {
          const text = str(part["text"]) ?? "";
          if (this.#userMessages.has(messageId)) {
            if (partType !== "text" || part["synthetic"] === true || this.#announcedUsers.has(messageId)) return [];
            this.#announcedUsers.add(messageId);
            return [{ type: "user", sessionId: owner, messageId, text, steer: false }];
          }
          this.#partKinds.set(partId, partType);
          const time = isObject(part["time"]) ? part["time"] : {};
          return [{ type: "part", sessionId: owner, messageId, partId, field: partType, text, done: typeof time["end"] === "number" }];
        }
        if (partType === "tool") {
          const state = toolState(part);
          return state === undefined ? [] : [{ type: "tool", sessionId: owner, messageId, state }];
        }
        if (partType === "compaction") return [{ type: "compaction", sessionId: owner, status: "started" }];
        return [];
      }
      case "message.part.delta": {
        const messageId = str(properties["messageID"]);
        const partId = str(properties["partID"]);
        const delta = str(properties["delta"]);
        if (sessionId === undefined || messageId === undefined || partId === undefined || delta === undefined || properties["field"] !== "text") return [];
        if (this.#userMessages.has(messageId)) return [];
        return [{ type: "part", sessionId, messageId, partId, field: this.#partKinds.get(partId) ?? "text", delta, done: false }];
      }
      case "permission.asked": {
        const requestId = str(properties["id"]);
        if (sessionId === undefined || requestId === undefined) return [];
        const tool = isObject(properties["tool"]) ? properties["tool"] : undefined;
        return [
          {
            type: "permission",
            sessionId,
            requestId,
            action: str(properties["permission"]) ?? "permission",
            resources: Array.isArray(properties["patterns"]) ? properties["patterns"].filter((entry): entry is string => typeof entry === "string") : [],
            always: Array.isArray(properties["always"]) ? properties["always"].filter((entry): entry is string => typeof entry === "string") : [],
            metadata: isObject(properties["metadata"]) ? properties["metadata"] : {},
            ...(str(tool?.["callID"]) === undefined ? {} : { callId: str(tool?.["callID"])! }),
          },
        ];
      }
      case "permission.replied": {
        const requestId = str(properties["requestID"]);
        return sessionId === undefined || requestId === undefined ? [] : [{ type: "permission.replied", sessionId, requestId, reply: str(properties["reply"]) ?? "" }];
      }
      case "question.asked": {
        const requestId = str(properties["id"]);
        if (sessionId === undefined || requestId === undefined) return [];
        return [{ type: "question", sessionId, requestId, title: "", questions: questions(properties["questions"]) }];
      }
      case "question.replied":
      case "question.rejected": {
        const requestId = str(properties["requestID"]);
        return sessionId === undefined || requestId === undefined ? [] : [{ type: "question.closed", sessionId, requestId }];
      }
      case "session.created": {
        const info = properties["info"];
        return isObject(info) && typeof info["id"] === "string" && typeof info["directory"] === "string" ? [{ type: "session", info: sessionInfo(info) }] : [];
      }
      case "session.compacted":
        return sessionId === undefined ? [] : [{ type: "compaction", sessionId, status: "ended" }];
      case "todo.updated": {
        if (sessionId === undefined || !Array.isArray(properties["todos"])) return [];
        const todos = properties["todos"].flatMap((todo: unknown) =>
          isObject(todo) && typeof todo["content"] === "string" ? [{ ...(typeof todo["id"] === "string" ? { id: todo["id"] } : {}), text: todo["content"], status: str(todo["status"]) ?? "pending" }] : [],
        );
        return [{ type: "todos", sessionId, todos }];
      }
      default:
        return [];
    }
  }
}

/** One message of `session.messages` as a neutral history message. */
function historyMessage(entry: unknown): NativeMessage | undefined {
  if (!isObject(entry) || !isObject(entry["info"])) return undefined;
  const info = entry["info"];
  const parts = Array.isArray(entry["parts"]) ? entry["parts"].filter(isObject) : [];
  const id = str(info["id"]);
  const role = info["role"];
  if (id === undefined || (role !== "user" && role !== "assistant")) return undefined;
  const time = isObject(info["time"]) ? info["time"] : {};
  const text = parts
    .filter((part) => part["type"] === "text" && part["synthetic"] !== true)
    .map((part) => str(part["text"]) ?? "")
    .join("");
  const reasoning = parts
    .filter((part) => part["type"] === "reasoning")
    .map((part) => str(part["text"]) ?? "")
    .join("");
  const textParts = parts.flatMap((part) =>
    (part["type"] === "text" && part["synthetic"] !== true) || part["type"] === "reasoning" ? [{ id: str(part["id"]) ?? "", field: part["type"] === "text" ? ("text" as const) : ("reasoning" as const), text: str(part["text"]) ?? "" }] : [],
  );
  const tools = parts.flatMap((part) => {
    if (part["type"] !== "tool") return [];
    const state = toolState(part);
    return state === undefined ? [] : [state];
  });
  const error = role === "assistant" ? v1Error(info["error"], typeof time["completed"] === "number" ? time["completed"] : undefined) : undefined;
  const model = role === "assistant" && typeof info["providerID"] === "string" && typeof info["modelID"] === "string" ? `${info["providerID"]}/${info["modelID"]}` : undefined;
  return { id, role, text, reasoning, parts: role === "assistant" ? textParts : [], tools, time: typeof time["created"] === "number" ? time["created"] : 0, ...(model === undefined ? {} : { model }), ...(error === undefined ? {} : { error }) };
}

/** An OpenCode 1.x server as a `NativeRuntime`. */
export class V1Runtime implements NativeRuntime {
  readonly generation = 1 as const;
  readonly version: string;
  readonly #client: V1Client;

  constructor(sdk: V1Sdk, endpoint: ServerEndpoint) {
    this.version = endpoint.version;
    this.#client = sdk.createOpencodeClient({ baseUrl: endpoint.url, ...(endpoint.authorization === undefined ? {} : { headers: { authorization: endpoint.authorization } }) });
  }

  async watch(directory: string, onEvent: (event: NativeEvent) => void, onEnd: (error: unknown) => void): Promise<{ close(): void }> {
    const controller = new AbortController();
    const translator = new V1Translator();
    let failure: unknown;
    const subscription = await this.#client.event.subscribe({ directory }, { signal: controller.signal, sseMaxRetryAttempts: 1, onSseError: (error) => (failure = error) });
    const iterator = subscription.stream[Symbol.asyncIterator]();
    // The server's first event confirms the subscription; events published before it would be lost.
    let resolveConnected: () => void = () => undefined;
    let rejectConnected: (error: unknown) => void = () => undefined;
    const connected = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });
    void (async () => {
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
        failure ??= error;
      }
      const reason = failure ?? callErrors.transport("The OpenCode event stream ended");
      rejectConnected(reason);
      if (!controller.signal.aborted) onEnd(reason);
    })();
    await connected;
    return { close: () => controller.abort() };
  }

  async createSession(input: { directory: string; title?: string; rules: readonly NativeRule[] }): Promise<NativeSessionInfo> {
    return sessionInfo(data(await this.#client.session.create({ directory: input.directory, ...(input.title === undefined ? {} : { title: input.title }), permission: toV1Rules(input.rules) }), "session"));
  }

  async getSession(sessionId: string, directory: string | undefined): Promise<NativeSessionInfo | undefined> {
    const result = await this.#client.session.get({ sessionID: sessionId, ...(directory === undefined ? {} : { directory }) });
    if (result.response?.status === 404) return undefined;
    return sessionInfo(data(result, `session ${sessionId}`));
  }

  async setRules(sessionId: string, directory: string, rules: readonly NativeRule[]): Promise<void> {
    data(await this.#client.session.update({ sessionID: sessionId, directory, permission: toV1Rules(rules) }), `session ${sessionId}`);
  }

  async getRules(sessionId: string, directory: string): Promise<readonly NativeRule[]> {
    const session = data(await this.#client.session.get({ sessionID: sessionId, directory }), `session ${sessionId}`);
    return fromV1Rules(isObject(session) ? session["permission"] : undefined);
  }

  /**
   * The message a staged revert starts at. 1.x keeps reverted messages until
   * the next prompt or summary removes them (`session/revert.ts` `cleanup`),
   * and a fork copies them too (`session/session.ts` `fork`).
   */
  async #revertedFrom(sessionId: string, directory: string): Promise<string | undefined> {
    const session = data(await this.#client.session.get({ sessionID: sessionId, directory }), `session ${sessionId}`);
    const revert = isObject(session) && isObject(session["revert"]) ? session["revert"] : undefined;
    return str(revert?.["messageID"]);
  }

  async messages(sessionId: string, directory: string): Promise<NativeMessage[]> {
    const reverted = await this.#revertedFrom(sessionId, directory);
    const listed = data(await this.#client.session.messages({ sessionID: sessionId, directory }), `session ${sessionId}`);
    const messages = (Array.isArray(listed) ? listed : []).flatMap((entry) => {
      const message = historyMessage(entry);
      return message === undefined ? [] : [message];
    });
    const cut = reverted === undefined ? -1 : messages.findIndex((message) => message.id === reverted);
    return cut === -1 ? messages : messages.slice(0, cut);
  }

  async prompt(input: PromptInput): Promise<{ messageId?: string }> {
    const model = splitModel(input.model);
    data(
      await this.#client.session.promptAsync({
        sessionID: input.sessionId,
        directory: input.directory,
        parts: [{ type: "text", text: input.text }, ...input.files.map((file) => ({ type: "file" as const, mime: file.mime, url: file.url, filename: file.name }))],
        ...(input.system === undefined ? {} : { system: input.system }),
        ...(model === undefined ? {} : { model }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
      }),
      `session ${input.sessionId}`,
    );
    // 204: the user message's id arrives with its events.
    return {};
  }

  async interrupt(sessionId: string, directory: string): Promise<void> {
    data(await this.#client.session.abort({ sessionID: sessionId, directory }), `session ${sessionId}`);
  }

  async replyPermission(_sessionId: string, directory: string, requestId: string, reply: "once" | "always" | "reject"): Promise<void> {
    data(await this.#client.permission.reply({ requestID: requestId, directory, reply }), `permission request ${requestId}`);
  }

  async replyQuestion(_sessionId: string, directory: string, requestId: string, answers: ReadonlyArray<readonly string[]> | undefined): Promise<void> {
    if (answers === undefined) {
      data(await this.#client.question.reject({ requestID: requestId, directory }), `question ${requestId}`);
      return;
    }
    data(await this.#client.question.reply({ requestID: requestId, directory, answers: answers.map((answer) => [...answer]) }), `question ${requestId}`);
  }

  async fork(sessionId: string, directory: string, beforeMessageId: string | undefined): Promise<NativeSessionInfo> {
    const before = beforeMessageId ?? (await this.#revertedFrom(sessionId, directory));
    return sessionInfo(data(await this.#client.session.fork({ sessionID: sessionId, directory, ...(before === undefined ? {} : { messageID: before }) }), `session ${sessionId}`));
  }

  async revert(sessionId: string, directory: string, messageId: string): Promise<void> {
    data(await this.#client.session.revert({ sessionID: sessionId, directory, messageID: messageId }), `session ${sessionId}`);
  }

  async compact(sessionId: string, directory: string, model: string | undefined): Promise<void> {
    const split = splitModel(model);
    data(await this.#client.session.summarize({ sessionID: sessionId, directory, ...(split === undefined ? {} : { providerID: split.providerID, modelID: split.modelID }) }), `session ${sessionId}`);
  }

  async addMcp(entry: McpEntry): Promise<void> {
    const config = entry.config.type === "local" ? { type: "local" as const, command: [...entry.config.command], ...(entry.config.environment === undefined ? {} : { environment: { ...entry.config.environment } }) } : { type: "remote" as const, url: entry.config.url, ...(entry.config.headers === undefined ? {} : { headers: { ...entry.config.headers } }) };
    data(await this.#client.mcp.add({ directory: entry.directory, name: entry.name, config }), `MCP server ${entry.name}`);
  }

  /** 1.x has no route that removes a server added at runtime; disconnecting stops its tools. */
  async removeMcp(name: string, directory: string): Promise<void> {
    data(await this.#client.mcp.disconnect({ name, directory }), `MCP server ${name}`);
  }

  async models(directory: string): Promise<{ models: CatalogModel[]; defaultModel?: string }> {
    const listed = data(await this.#client.config.providers({ directory }), "providers");
    const providers = isObject(listed) && Array.isArray(listed["providers"]) ? listed["providers"].filter(isObject) : [];
    const models: CatalogModel[] = [];
    for (const provider of providers) {
      const providerId = str(provider["id"]);
      const entries = isObject(provider["models"]) ? Object.values(provider["models"]).filter(isObject) : [];
      for (const model of entries) {
        const modelId = str(model["id"]);
        if (providerId === undefined || modelId === undefined) continue;
        const limit = isObject(model["limit"]) ? model["limit"] : {};
        const context = typeof limit["context"] === "number" && Number.isInteger(limit["context"]) && limit["context"] > 0 ? limit["context"] : undefined;
        models.push({ id: `${providerId}/${modelId}`, label: str(model["name"]) ?? modelId, ...(context === undefined ? {} : { contextWindow: context }) });
      }
    }
    const defaults = isObject(listed) && isObject(listed["default"]) ? listed["default"] : {};
    const first = Object.entries(defaults).find(([, value]) => typeof value === "string");
    return { models, ...(first === undefined ? {} : { defaultModel: `${first[0]}/${String(first[1])}` }) };
  }
}
