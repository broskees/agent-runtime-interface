// Stream plumbing shared by both ends of `ari/wire`.
//
// `WireQueue` is the consumer's end of one stream: items pushed in order, read
// once as an async iterator, ended normally or with an error.
//
// `StreamRouter` hands notifications to the queue of the stream they name.
// The producer of a stream sends its items only after the response that
// carries the stream's id, but the consumer learns that id only when its
// request promise settles, a few microtasks after the response was read; the
// next frames may already be read by then. So the router holds items for an
// id it does not know yet and hands them over, in order, when the consumer
// attaches. Items for an id the consumer already let go of are dropped.

import type { AriError } from "../ari-error.ts";

/** A first-in, first-out queue that one consumer reads as an async iterator. */
export class WireQueue<T> implements AsyncIterableIterator<T, undefined> {
  readonly #items: T[] = [];
  readonly #waiters: Array<{ resolve: (result: IteratorResult<T, undefined>) => void; reject: (error: unknown) => void }> = [];
  readonly #onReturn: (() => void) | undefined;
  #ended = false;
  #error: unknown = undefined;
  #failed = false;

  /** `onReturn` runs once when the consumer stops reading early. */
  constructor(onReturn?: () => void) {
    this.#onReturn = onReturn;
  }

  get ended(): boolean {
    return this.#ended;
  }

  push(item: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(item);
    else waiter.resolve({ done: false, value: item });
  }

  /** Ends the queue once the items already pushed are read; with `error`, the read after them throws it. */
  end(error?: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    if (error !== undefined) {
      this.#failed = true;
      this.#error = error;
    }
    for (const waiter of this.#waiters.splice(0)) {
      if (this.#failed) waiter.reject(this.#error);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  next(): Promise<IteratorResult<T, undefined>> {
    if (this.#items.length > 0) return Promise.resolve({ done: false, value: this.#items.shift() as T });
    if (this.#ended) {
      if (this.#failed) {
        // The error is thrown once; later reads see a finished stream.
        const error = this.#error;
        this.#failed = false;
        return Promise.reject(error);
      }
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  async return(): Promise<IteratorResult<T, undefined>> {
    const wasOpen = !this.#ended;
    this.#items.length = 0;
    this.#failed = false;
    this.end();
    if (wasOpen) this.#onReturn?.();
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

/** Where the router hands one stream's items. */
export interface StreamSink<T> {
  item(value: T): void;
  /** The stream ended: normally, or with `error` when the producer failed or the connection closed. */
  end(error?: AriError): void;
}

type Held<T> = { readonly kind: "item"; readonly value: T } | { readonly kind: "end"; readonly error?: AriError };

/** Most streams the router holds items for before their consumer attaches, and most items per stream. */
const MAX_EARLY_STREAMS = 1024;
const MAX_EARLY_ITEMS = 100_000;

/** Routes stream notifications by id, holding items that arrive before their consumer attaches. */
export class StreamRouter<T> {
  readonly #sinks = new Map<string, StreamSink<T>>();
  readonly #early = new Map<string, Held<T>[]>();
  readonly #finished = new Set<string>();
  readonly #onOverflow: (id: string) => void;
  #closedWith: AriError | undefined;

  /** `onOverflow` is told when items for an unknown id pile up past the limits; they are dropped. */
  constructor(onOverflow: (id: string) => void = () => undefined) {
    this.#onOverflow = onOverflow;
  }

  item(id: string, value: T): void {
    const sink = this.#sinks.get(id);
    if (sink !== undefined) sink.item(value);
    else this.#hold(id, { kind: "item", value });
  }

  end(id: string, error?: AriError): void {
    const sink = this.#sinks.get(id);
    if (sink === undefined) {
      this.#hold(id, error === undefined ? { kind: "end" } : { kind: "end", error });
      return;
    }
    this.#sinks.delete(id);
    this.#finished.add(id);
    sink.end(error);
  }

  /** Starts handing the stream's items to `sink`, first those that arrived before. */
  attach(id: string, sink: StreamSink<T>): void {
    if (this.#closedWith !== undefined) {
      sink.end(this.#closedWith);
      return;
    }
    const held = this.#early.get(id) ?? [];
    this.#early.delete(id);
    if (this.#finished.has(id)) {
      sink.end();
      return;
    }
    this.#sinks.set(id, sink);
    for (const entry of held) {
      if (entry.kind === "item") sink.item(entry.value);
      else {
        this.end(id, entry.error);
        return;
      }
    }
  }

  /** Stops handing the stream's items anywhere; later ones are dropped. */
  detach(id: string): void {
    this.#sinks.delete(id);
    this.#early.delete(id);
    this.#finished.add(id);
  }

  /** Ends every attached stream with `error` and refuses later ones. */
  closeAll(error: AriError): void {
    this.#closedWith = error;
    this.#early.clear();
    const sinks = [...this.#sinks.values()];
    this.#sinks.clear();
    for (const sink of sinks) sink.end(error);
  }

  #hold(id: string, entry: Held<T>): void {
    if (this.#finished.has(id) || this.#closedWith !== undefined) return;
    let held = this.#early.get(id);
    if (held === undefined) {
      if (this.#early.size >= MAX_EARLY_STREAMS) {
        this.#onOverflow(id);
        return;
      }
      held = [];
      this.#early.set(id, held);
    }
    if (held.length >= MAX_EARLY_ITEMS) {
      this.#onOverflow(id);
      return;
    }
    held.push(entry);
  }
}

/** Base64 text of `bytes`, without Node's `Buffer`. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}

/** The bytes of base64 `text`, without Node's `Buffer`. Throws a `TypeError` for text that is not base64. */
export function base64ToBytes(text: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new TypeError("not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
