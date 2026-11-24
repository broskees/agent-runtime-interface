// One `ari/wire` connection: newline-delimited JSON-RPC 2.0 over a byte
// transport, used by both ends (the driver side in `serveDriver` and the host
// side in `connectDriver`). It adds to the driver kit's JSON-RPC peer what
// ARI's wire rules need:
//
// - Every incoming request and notification must be a method of
//   spec/v1/methods.json going this way, with params valid against its
//   schema. An unknown method is answered -32601, invalid params -32602, both
//   with a `CallError` in `data`, as every rejected call is.
// - A rejected call carries its `CallError` in the JSON-RPC error's `data`
//   (code -32000). A handler that throws something that is not a call error
//   is answered -32603 with a `protocol` call error, so the other side always
//   gets a call error. On the calling side, the error becomes an `AriError`
//   again.
// - Streams: a request that starts a stream answers `{ streamId }`; the
//   producer sends the items as the method's notification only after that
//   response, and ends with `stream/end`. `stream/cancel` stops a stream; the
//   producer answers, then sends `stream/end`. The consumer side holds items
//   that arrive before it learned the stream's id (see streams.ts).
// - When the other side goes away (the input ends or a write fails), the
//   connection closes: every pending call rejects with a `transport` call
//   error, and every stream it consumes ends with it.

import { AriError } from "../ari-error.ts";
import { JSON_RPC_ERROR_CODES, JsonRpcError, JsonRpcPeer } from "../driver-kit/json-rpc.ts";
import type { JsonRpcId, JsonRpcMessage, JsonRpcRequestContext } from "../driver-kit/json-rpc.ts";
import { encodeNdjson, readNdjson } from "../driver-kit/ndjson.ts";
import { callErrors } from "../errors.ts";
import { CallErrorSchema } from "../generated/errors.ts";
import type { CallError } from "../generated/errors.ts";
import { methodUnavailable } from "./handshake.ts";
import type { NegotiatedVersions } from "./handshake.ts";
import { STREAM_ITEM_NOTIFICATIONS, wireMethod } from "./methods.ts";
import { StreamRouter, WireQueue } from "./streams.ts";

/** A byte stream in each direction, such as a child process's stdio. */
export interface WireTransport {
  /** What the other side sends. Ends when it closes the connection. */
  readonly input: AsyncIterable<Uint8Array | string>;
  /** Sends one frame: a complete NDJSON record. Frames must reach the other side in the order of the calls. */
  write(frame: string): void | Promise<void>;
  /** Closes this side's output. */
  close(): void | Promise<void>;
}

/** The JSON-RPC error code of a rejected ARI call; `data` holds the `CallError`. */
export const ARI_CALL_ERROR_CODE = -32000;

/** The call error that `error` carries, whether it is an `AriError` (from any copy of this package) or call error data. */
export function callErrorOf(error: unknown): CallError | undefined {
  if (error instanceof AriError) return error.callError;
  if (typeof error === "object" && error !== null) {
    const carried = (error as { callError?: unknown }).callError;
    if (CallErrorSchema.is(carried)) return carried;
  }
  if (CallErrorSchema.is(error)) return error;
  return undefined;
}

/** The JSON-RPC error that answers a call that threw `error`. */
export function toJsonRpcError(error: unknown): JsonRpcError {
  if (error instanceof JsonRpcError) return error;
  const callError = callErrorOf(error);
  if (callError !== undefined) return new JsonRpcError(ARI_CALL_ERROR_CODE, callError.message, callError);
  const text = error instanceof Error ? `${error.name}: ${error.message}` : `Non-error thrown: ${String(error)}`;
  return new JsonRpcError(JSON_RPC_ERROR_CODES.internalError, text, { code: "protocol", message: text, detail: "uncaught_error" });
}

/** The error a call rejects with when the other side answered with `error`: an `AriError` for any JSON-RPC error. */
export function fromJsonRpcError(error: unknown): unknown {
  if (!(error instanceof JsonRpcError)) return error;
  if (CallErrorSchema.is(error.data)) return new AriError(error.data);
  return callErrors.protocol(`json_rpc_error_${error.code}`, `The other side answered with JSON-RPC error ${error.code}: ${error.message}`);
}

export type WireRequestContext = JsonRpcRequestContext;

export interface WireConnectionOptions {
  /** Which end this is; it accepts the methods sent to it, and the `both` ones. */
  readonly side: "driver" | "host";
  /** Answers a request other than `stream/cancel`. Throw a call error to reject it. */
  readonly onRequest: (method: string, params: unknown, context: WireRequestContext) => unknown;
  /** Handles a notification that is not a stream item or `stream/end`. */
  readonly onNotification?: (method: string, params: unknown) => void;
  /** Told about frames that break the protocol; they are dropped. */
  readonly onProblem?: (message: string) => void;
  /** Describes why the connection closed when the other side went away. */
  readonly describeClose?: () => string;
}

export interface ConsumeOptions<T> {
  /** Sees each item before the consumer does. */
  readonly observe?: (item: T) => void;
  /** When the connection closes while the stream is open: items to deliver before the stream ends normally. Without it, the stream ends with the connection's error. */
  readonly finalItems?: (error: AriError) => readonly T[];
}

interface Producing {
  readonly iterator: AsyncIterator<unknown>;
  /** Stops the pump; it then sends `stream/end` unless the connection closed. */
  cancel(): void;
  readonly cancelled: Promise<void>;
}

function idKey(id: JsonRpcId | null): string | undefined {
  if (id === null) return undefined;
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class WireConnection {
  readonly #transport: WireTransport;
  readonly #options: WireConnectionOptions;
  readonly #peer: JsonRpcPeer;
  readonly #router: StreamRouter<unknown>;
  readonly #producing = new Map<string, Producing>();
  /** Runs once the response to an incoming request id has been handed to the transport. */
  readonly #afterResponse = new Map<string, () => void>();
  readonly #closeListeners = new Set<(error: AriError) => void>();
  readonly #streamPrefix: string;
  readonly done: Promise<AriError>;
  #resolveDone: (error: AriError) => void = () => undefined;
  #nextStream = 1;
  #closeError: AriError | undefined;
  #negotiated: NegotiatedVersions | undefined;
  #started = false;

  constructor(transport: WireTransport, options: WireConnectionOptions) {
    this.#transport = transport;
    this.#options = options;
    this.#streamPrefix = options.side === "driver" ? "d" : "h";
    this.done = new Promise((resolve) => {
      this.#resolveDone = resolve;
    });
    this.#router = new StreamRouter((id) => this.#problem(`dropped items for unknown stream ${id}: too many held`));
    this.#peer = new JsonRpcPeer({
      send: (message) => this.#send(message),
      onRequest: (method, params, context) => this.#receiveRequest(method, params, context),
      onNotification: (method, params) => this.#receiveNotification(method, params),
      onProtocolError: (problem) => this.#problem(problem.message),
    });
  }

  /** Starts reading the transport. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#read();
  }

  get closed(): boolean {
    return this.#closeError !== undefined;
  }

  /** The error the connection closed with, once closed. */
  get closeError(): AriError | undefined {
    return this.#closeError;
  }

  get negotiated(): NegotiatedVersions | undefined {
    return this.#negotiated;
  }

  /** Records the handshake's outcome; refused methods are rejected in both directions from now on. */
  setNegotiated(negotiated: NegotiatedVersions): void {
    this.#negotiated = negotiated;
  }

  /** Runs `listener` once when the connection closes (at once if it already has). */
  onClose(listener: (error: AriError) => void): void {
    if (this.#closeError !== undefined) listener(this.#closeError);
    else this.#closeListeners.add(listener);
  }

  /** Sends a request and resolves with its result; a rejection is an `AriError`. */
  async request<T>(method: string, params: unknown): Promise<T> {
    this.#checkAvailable(method);
    try {
      return await this.#peer.request<T>(method, params);
    } catch (error) {
      throw fromJsonRpcError(error);
    }
  }

  /** Sends a notification. Rejects with the `transport` error once closed. */
  async notify(method: string, params: unknown): Promise<void> {
    this.#checkAvailable(method);
    await this.#peer.notify(method, params);
  }

  /**
   * Runs `action` once the successful response to the request of `context`
   * has been handed to the transport, so whatever it sends arrives after that
   * response. It never runs when the request fails.
   */
  afterResponse(context: WireRequestContext, action: () => void): void {
    const key = idKey(context.id);
    if (key === undefined) throw new TypeError("only a request with an id gets a response");
    this.#afterResponse.set(key, action);
  }

  /**
   * Starts a stream that answers the request of `context`: returns its id for
   * the result, and sends each item of `source` as `notification` once the
   * response has gone out, then `stream/end`.
   */
  produce(context: WireRequestContext, source: AsyncIterable<unknown>, notification: string): string {
    const field = STREAM_ITEM_NOTIFICATIONS[notification];
    if (field === undefined) throw new TypeError(`${notification} is not a stream item notification`);
    const streamId = `${this.#streamPrefix}${this.#nextStream}`;
    this.#nextStream += 1;
    // The iterator is made now, so a source whose stream starts "from now" starts at the request.
    const iterator = source[Symbol.asyncIterator]();
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    const entry: Producing = { iterator, cancel: () => cancel(), cancelled };
    this.#producing.set(streamId, entry);
    this.afterResponse(context, () => void this.#pump(streamId, entry, notification, field));
    return streamId;
  }

  /** The consumer's end of stream `streamId`, whose id the other side just sent. */
  consume<T>(streamId: string, options: ConsumeOptions<T> = {}): WireQueue<T> {
    const queue = new WireQueue<T>(() => {
      this.#router.detach(streamId);
      if (!this.closed) void this.request("stream/cancel", { streamId }).catch(() => undefined);
    });
    this.#router.attach(streamId, {
      item: (value) => {
        options.observe?.(value as T);
        queue.push(value as T);
      },
      end: (error) => {
        if (error !== undefined && error === this.#closeError && options.finalItems !== undefined) {
          for (const item of options.finalItems(error)) {
            options.observe?.(item);
            queue.push(item);
          }
          queue.end();
          return;
        }
        queue.end(error);
      },
    });
    return queue;
  }

  /** A stream that starts with `method` when first read and is consumed as `consume` does. */
  openStream<T>(method: string, params: unknown, options: ConsumeOptions<T> = {}): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<T, undefined> => {
        let queue: WireQueue<T> | undefined;
        let starting: Promise<WireQueue<T>> | undefined;
        let stopped = false;
        const start = (): Promise<WireQueue<T>> => {
          starting ??= this.request<{ streamId: string }>(method, params).then((started) => {
            const opened = this.consume<T>(started.streamId, options);
            if (stopped) void opened.return();
            queue = opened;
            return opened;
          });
          return starting;
        };
        return {
          next: async () => {
            if (stopped) return { done: true, value: undefined };
            return (await start()).next();
          },
          return: async () => {
            stopped = true;
            if (queue !== undefined) await queue.return();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  /** Closes the connection: pending calls reject with `error`, streams end, the transport closes. Closing twice does nothing. */
  close(error: AriError = callErrors.transport("The ari/wire connection was closed")): void {
    if (this.#closeError !== undefined) return;
    this.#closeError = error;
    this.#peer.close(error);
    for (const entry of this.#producing.values()) entry.cancel();
    this.#afterResponse.clear();
    this.#router.closeAll(error);
    for (const listener of this.#closeListeners) {
      try {
        listener(error);
      } catch (thrown) {
        this.#problem(`a close listener threw: ${String(thrown)}`);
      }
    }
    this.#closeListeners.clear();
    try {
      void Promise.resolve(this.#transport.close()).catch(() => undefined);
    } catch {
      // The transport is gone already.
    }
    this.#resolveDone(error);
  }

  /** Refuses a method the handshake refused or does not know; only `initialize` itself comes before the handshake. */
  #checkAvailable(method: string): void {
    const negotiated = this.#negotiated;
    if (negotiated === undefined || method === "initialize") return;
    if (negotiated.methodVersions[method] === undefined) throw methodUnavailable(method, negotiated);
  }

  #accepts(direction: string): boolean {
    if (direction === "both") return true;
    return this.#options.side === "driver" ? direction === "host_to_driver" : direction === "driver_to_host";
  }

  #receiveRequest(method: string, params: unknown, context: WireRequestContext): unknown {
    const entry = wireMethod(method);
    if (entry === undefined || entry.kind !== "request" || !this.#accepts(entry.direction)) {
      const error = callErrors.unsupported(method, `Method not found: ${method}`);
      throw new JsonRpcError(JSON_RPC_ERROR_CODES.methodNotFound, error.message, error.callError);
    }
    if (!entry.params.is(params)) {
      let error: unknown;
      try {
        entry.params.parse(params);
      } catch (thrown) {
        error = thrown;
      }
      const callError = callErrorOf(error) ?? callErrors.validation([], `Invalid params for ${method}`).callError;
      throw new JsonRpcError(JSON_RPC_ERROR_CODES.invalidParams, `Invalid params for ${method}: ${callError.message}`, callError);
    }
    try {
      this.#checkAvailable(method);
    } catch (error) {
      throw toJsonRpcError(error);
    }
    if (method === "stream/cancel") return this.#cancelProducing((params as { streamId: string }).streamId, context);
    return Promise.resolve()
      .then(() => this.#options.onRequest(method, params, context))
      .catch((error: unknown) => {
        throw toJsonRpcError(error);
      });
  }

  #receiveNotification(method: string, params: unknown): void {
    const entry = wireMethod(method);
    if (entry === undefined || entry.kind !== "notification" || !this.#accepts(entry.direction)) {
      this.#problem(`unknown notification ${method}`);
      return;
    }
    const negotiated = this.#negotiated;
    if (negotiated !== undefined && negotiated.methodVersions[method] === undefined) {
      this.#problem(`dropped notification ${method}, which this connection refused`);
      return;
    }
    if (!entry.params.is(params)) {
      this.#problem(`invalid params for notification ${method}`);
      // A broken stream item would leave a gap; end the stream instead.
      const raw: unknown = params;
      if (isObject(raw) && typeof raw.streamId === "string" && (method === "stream/end" || method in STREAM_ITEM_NOTIFICATIONS)) {
        this.#router.end(raw.streamId, callErrors.protocol("invalid_stream_item", `The other side sent invalid params for ${method}`));
      }
      return;
    }
    const record = params as { readonly [key: string]: unknown };
    if (method === "stream/end") {
      const error = record.error === undefined ? undefined : new AriError(record.error as CallError);
      this.#router.end(record.streamId as string, error);
      return;
    }
    const field = STREAM_ITEM_NOTIFICATIONS[method];
    if (field !== undefined) {
      this.#router.item(record.streamId as string, record[field]);
      return;
    }
    this.#options.onNotification?.(method, params);
  }

  #cancelProducing(streamId: string, context: WireRequestContext): null {
    const entry = this.#producing.get(streamId);
    if (entry === undefined) return null;
    const key = idKey(context.id);
    // Answer first, then end the stream.
    if (key === undefined) entry.cancel();
    else this.#afterResponse.set(key, () => entry.cancel());
    return null;
  }

  async #pump(streamId: string, entry: Producing, notification: string, field: string): Promise<void> {
    let failure: CallError | undefined;
    let finished = false;
    try {
      for (;;) {
        if (this.closed) break;
        const result = await Promise.race([entry.iterator.next(), entry.cancelled.then(() => undefined)]);
        if (result === undefined) break;
        if (result.done === true) {
          finished = true;
          break;
        }
        if (this.closed) break;
        await this.notify(notification, { streamId, [field]: result.value });
      }
    } catch (error) {
      if (!this.closed) failure = callErrorOf(error) ?? callErrors.protocol("stream_failed", error instanceof Error ? error.message : String(error)).callError;
    }
    this.#producing.delete(streamId);
    if (!finished) {
      try {
        void Promise.resolve(entry.iterator.return?.()).catch(() => undefined);
      } catch {
        // The source could not be stopped; it ends on its own.
      }
    }
    if (this.closed) return;
    await this.notify("stream/end", failure === undefined ? { streamId } : { streamId, error: failure }).catch(() => undefined);
  }

  #send(message: JsonRpcMessage): Promise<void> {
    let frame: string;
    try {
      frame = encodeNdjson(message);
    } catch (error) {
      if (!("id" in message) || !("result" in message)) throw error;
      // A result with no JSON form still gets an answer, so the caller never waits forever.
      const text = `The result of the call has no JSON form: ${(error as Error).message}`;
      frame = encodeNdjson({ jsonrpc: "2.0", id: message.id, error: { code: JSON_RPC_ERROR_CODES.internalError, message: text, data: { code: "protocol", message: text, detail: "unserializable_result" } } });
    }
    let written: Promise<void>;
    try {
      written = Promise.resolve(this.#transport.write(frame));
    } catch (error) {
      written = Promise.reject(error);
    }
    written.catch((error: unknown) => {
      this.close(callErrors.transport(`Writing to the ari/wire connection failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    if ("id" in message && !("method" in message)) {
      const key = idKey(message.id);
      const after = key === undefined ? undefined : this.#afterResponse.get(key);
      if (key !== undefined && after !== undefined) {
        this.#afterResponse.delete(key);
        if ("result" in message) after();
      }
    }
    return written;
  }

  async #read(): Promise<void> {
    try {
      for await (const record of readNdjson(this.#transport.input)) {
        if (this.closed) return;
        if (!record.ok) {
          this.#problem(`a frame is not JSON: ${record.error}`);
          void this.#sendRaw({ jsonrpc: "2.0", id: null, error: { code: JSON_RPC_ERROR_CODES.parseError, message: `Parse error: ${record.error}` } });
          continue;
        }
        this.#peer.receive(record.value);
      }
      this.close(callErrors.transport(this.#options.describeClose?.() ?? "The other side closed the ari/wire connection"));
    } catch (error) {
      this.close(callErrors.transport(`Reading the ari/wire connection failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  async #sendRaw(message: unknown): Promise<void> {
    if (this.closed) return;
    try {
      await this.#transport.write(encodeNdjson(message));
    } catch {
      // The read loop or the next write reports the broken transport.
    }
  }

  #problem(message: string): void {
    this.#options.onProblem?.(message);
  }
}
