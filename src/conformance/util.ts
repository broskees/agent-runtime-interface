// Small helpers the conformance kit shares. Nothing here imports a Node
// built-in, so the kit stays browser-safe.
//
// The kit keeps its own deadlines on the real clock. It captures the real
// `setTimeout`, `clearTimeout` and `Date.now` when this module loads, before
// a virtual clock (see virtual-clock.ts) can replace the globals, so a
// deadline still fires while virtual time stands still.

import { canonicalJson } from "../driver-kit/ids.ts";

const realSetTimeout: (callback: () => void, ms: number) => unknown = globalThis.setTimeout.bind(globalThis) as never;
const realClearTimeout: (handle: unknown) => void = globalThis.clearTimeout.bind(globalThis) as never;
const realDateNow: () => number = Date.now.bind(Date);

/** Milliseconds since the epoch on the real clock, whatever a virtual clock has done to `Date`. */
export function realNow(): number {
  return realDateNow();
}

/** Waits `ms` milliseconds of real time. */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });
}

/** A scenario step that did not hold. Its message is what the report shows. */
export class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformanceFailure";
  }
}

/** Settles with `promise`, or rejects with a `ConformanceFailure` naming `description` after `ms` of real time. */
export function withDeadline<T>(promise: Promise<T>, ms: number, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = realSetTimeout(() => {
      reject(new ConformanceFailure(`timed out after ${ms} ms waiting for ${description}`));
    }, ms);
    promise.then(
      (value) => {
        realClearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        realClearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** A first-in, first-out queue that one consumer reads as an async iterable. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T, undefined>) => void> = [];
  #ended = false;

  get ended(): boolean {
    return this.#ended;
  }

  push(item: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(item);
    else waiter({ done: false, value: item });
  }

  /** Ends the queue once the items already pushed are read. */
  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<T, undefined>> {
    if (this.#items.length > 0) return Promise.resolve({ done: false, value: this.#items.shift() as T });
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    return {
      next: () => this.next(),
      return: async () => {
        this.end();
        return { done: true, value: undefined };
      },
    };
  }
}

/** True when `a` and `b` have the same JSON form, ignoring object key order and `undefined` fields. */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** A short JSON rendering of `value` for failure messages. */
export function brief(value: unknown, limit = 240): string {
  let text: string;
  try {
    text = JSON.stringify(value, (_key, field: unknown) => (field instanceof Uint8Array ? `<${field.length} bytes>` : field)) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** The last segment of a path, split on `/` and `\`. */
export function baseName(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] ?? path;
}
