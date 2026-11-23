// A JSON-RPC 2.0 peer (https://www.jsonrpc.org/specification). Both sides of
// a stdio connection send requests, so one peer is client and server at once:
//
// - `request` sends a request with a fresh numeric id and settles when the
//   response with that id arrives: with its `result`, or rejected with a
//   `JsonRpcError` carrying the error's `code`, `message` and `data`.
// - `notify` sends a notification, which gets no response.
// - `receive` takes one decoded message from the other side: a response is
//   matched to its pending call by id; a request runs `onRequest` and its
//   return value (or thrown `JsonRpcError`) is sent back as the response; a
//   notification runs `onNotification`. A request with no handler is answered
//   with "Method not found" (-32601); a handler that throws anything other than
//   a `JsonRpcError` is answered with "Internal error" (-32603).
// - `close` rejects every pending call, aborts the signals of requests still
//   being handled and refuses new calls. It runs when the `signal` option
//   aborts, too.
//
// Batches (a JSON array of messages) are not supported: a batch is answered
// with one "Invalid Request" error (-32600) whose id is null. Messages that
// are not JSON-RPC 2.0, and responses that match no pending call, go to
// `onProtocolError`. The peer only frames calls; writing to and reading from
// the transport (for example with the NDJSON helpers) is the caller's job.

import { callErrors } from "../errors.ts";

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId | null; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId | null; readonly error: JsonRpcErrorObject };

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** The error codes JSON-RPC 2.0 defines. */
export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** A JSON-RPC error: thrown by a request handler to answer with it, and the rejection of a call the other side answered with an error. */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }

  toJSON(): JsonRpcErrorObject {
    return this.data === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, data: this.data };
  }
}

export interface JsonRpcRequestContext {
  readonly id: JsonRpcId | null;
  /** Aborts when the peer closes before the handler finishes. */
  readonly signal: AbortSignal;
}

export interface JsonRpcPeerOptions {
  /** Writes one message to the other side. A rejection fails the call that sent it. */
  readonly send: (message: JsonRpcMessage) => void | Promise<void>;
  /** Answers a request from the other side. Throw a `JsonRpcError` to answer with an error. */
  readonly onRequest?: (method: string, params: unknown, context: JsonRpcRequestContext) => unknown;
  readonly onNotification?: (method: string, params: unknown) => void;
  /** Told about messages that are not JSON-RPC 2.0, responses for no pending call, and responses that could not be sent. */
  readonly onProtocolError?: (problem: { readonly message: string; readonly payload: unknown }) => void;
  /** Closes the peer when aborted. */
  readonly signal?: AbortSignal;
}

export interface JsonRpcCallOptions {
  /** Rejects the call with the signal's reason when aborted; a late response is then ignored. */
  readonly signal?: AbortSignal;
}

interface PendingCall {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
}

type JsonObject = { readonly [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId | null {
  return typeof value === "string" || typeof value === "number" || value === null;
}

export class JsonRpcPeer {
  readonly #options: JsonRpcPeerOptions;
  readonly #pending = new Map<JsonRpcId, PendingCall>();
  readonly #handling = new Set<AbortController>();
  #nextId = 1;
  #closeError: Error | undefined;

  constructor(options: JsonRpcPeerOptions) {
    this.#options = options;
    const signal = options.signal;
    if (signal?.aborted === true) this.close();
    else signal?.addEventListener("abort", () => this.close(), { once: true });
  }

  get closed(): boolean {
    return this.#closeError !== undefined;
  }

  /** The number of calls still waiting for a response. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Sends a request and resolves with its result. */
  request<Result = unknown>(method: string, params?: unknown, options: JsonRpcCallOptions = {}): Promise<Result> {
    if (this.#closeError !== undefined) return Promise.reject(this.#closeError);
    const signal = options.signal;
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<Result>((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(id);
        reject(signal?.reason);
      };
      const release = (): void => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (result) => {
          release();
          resolve(result as Result);
        },
        reject: (error) => {
          release();
          reject(error);
        },
      });
      const message: JsonRpcRequest = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
      this.#send(message).catch((error: unknown) => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        pending.reject(error);
      });
    });
  }

  /** Sends a notification. */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.#closeError !== undefined) throw this.#closeError;
    await this.#send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  /** Handles one message from the other side. Never throws. */
  receive(message: unknown): void {
    if (this.#closeError !== undefined) return;
    if (Array.isArray(message)) {
      this.#respondError(null, JSON_RPC_ERROR_CODES.invalidRequest, "Invalid Request: batches are not supported");
      return;
    }
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      this.#protocolError("not a JSON-RPC 2.0 message", message);
      if (isObject(message) && "method" in message) {
        this.#respondError(isId(message.id) ? message.id : null, JSON_RPC_ERROR_CODES.invalidRequest, "Invalid Request");
      }
      return;
    }
    if ("method" in message) {
      this.#receiveCall(message);
      return;
    }
    if ("id" in message && ("result" in message || "error" in message)) {
      this.#receiveResponse(message);
      return;
    }
    this.#protocolError("not a JSON-RPC 2.0 message", message);
  }

  /**
   * Closes the peer: every pending call rejects with `error` (a `transport`
   * call error by default), handlers still running see their signal abort,
   * and later calls reject with the same error. Closing twice does nothing.
   */
  close(error?: Error): void {
    if (this.#closeError !== undefined) return;
    const reason = error ?? callErrors.transport("JSON-RPC connection closed");
    this.#closeError = reason;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const call of pending) call.reject(reason);
    for (const controller of this.#handling) controller.abort(reason);
    this.#handling.clear();
  }

  #receiveCall(message: JsonObject): void {
    const { method, params } = message;
    const isRequest = "id" in message;
    if (typeof method !== "string" || (isRequest && !isId(message.id))) {
      this.#protocolError("invalid request", message);
      if (isRequest) this.#respondError(isId(message.id) ? message.id : null, JSON_RPC_ERROR_CODES.invalidRequest, "Invalid Request");
      return;
    }
    if (!isRequest) {
      this.#options.onNotification?.(method, params);
      return;
    }
    const id = message.id as JsonRpcId | null;
    const handler = this.#options.onRequest;
    if (handler === undefined) {
      this.#respondError(id, JSON_RPC_ERROR_CODES.methodNotFound, "Method not found");
      return;
    }
    const controller = new AbortController();
    this.#handling.add(controller);
    Promise.resolve()
      .then(() => handler(method, params, { id, signal: controller.signal }))
      .then(
        (result) => {
          if (!this.#handling.delete(controller)) return;
          this.#respond({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
        },
        (error: unknown) => {
          if (!this.#handling.delete(controller)) return;
          if (error instanceof JsonRpcError) this.#respond({ jsonrpc: "2.0", id, error: error.toJSON() });
          else this.#respondError(id, JSON_RPC_ERROR_CODES.internalError, error instanceof Error ? error.message : "Internal error");
        },
      );
  }

  #receiveResponse(message: JsonObject): void {
    const id = message.id;
    const pending = isId(id) && id !== null ? this.#pending.get(id) : undefined;
    if (pending === undefined) {
      this.#protocolError(`response for id ${JSON.stringify(id)}, which matches no pending call`, message);
      return;
    }
    this.#pending.delete(id as JsonRpcId);
    if ("error" in message) {
      const error = isObject(message.error) ? message.error : {};
      const code = typeof error.code === "number" ? error.code : JSON_RPC_ERROR_CODES.internalError;
      const text = typeof error.message === "string" ? error.message : "Unknown error";
      pending.reject(new JsonRpcError(code, text, error.data));
      return;
    }
    pending.resolve(message.result);
  }

  #respondError(id: JsonRpcId | null, code: number, message: string): void {
    this.#respond({ jsonrpc: "2.0", id, error: { code, message } });
  }

  #respond(response: JsonRpcResponse): void {
    if (this.#closeError !== undefined) return;
    this.#send(response).catch((error: unknown) => {
      this.#protocolError(`could not send the response: ${error instanceof Error ? error.message : String(error)}`, response);
    });
  }

  #send(message: JsonRpcMessage): Promise<void> {
    return Promise.resolve().then(() => this.#options.send(message));
  }

  #protocolError(message: string, payload: unknown): void {
    this.#options.onProtocolError?.({ message, payload });
  }
}
