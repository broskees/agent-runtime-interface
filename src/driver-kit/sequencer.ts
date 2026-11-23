// The event sequencer: one per session. `emit` stamps each event with the
// session id, the time and the next `seq` (1, 2, 3, ... with no gaps), and
// keeps it. `events()` returns a stream that replays the kept events from
// `fromSeq` (from the first event when it is left out) and then continues
// live, so a host that reconnects with `fromSeq` gets the same events, with
// the same ids, that it would have seen. Several streams may read at once.
//
// The sequencer keeps every event of the session in memory, because any
// `fromSeq` may be asked for. `close()` ends every stream once it has caught
// up; nothing can be emitted after that. A stream also ends when the consumer
// stops iterating or when the `signal` passed to `events()` aborts.

import { callErrors } from "../errors.ts";
import type { AriEvent, AriEventBody, NativeFrame } from "../generated/events.ts";

/** An event before the sequencer stamps it. */
export interface SequencerEventInput {
  readonly body: AriEventBody;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly hostTag?: string;
  readonly native?: NativeFrame;
  /** The event time; defaults to the sequencer's clock. */
  readonly at?: string;
}

export interface EventSequencerOptions {
  readonly sessionId: string;
  /** The current time as an ISO-8601 string. Defaults to the system clock. */
  readonly clock?: () => string;
}

export interface SequencerEventsOptions {
  /** Replay from this `seq`, then continue live. Defaults to 1. */
  readonly fromSeq?: number;
  /** Ends the stream when aborted. */
  readonly signal?: AbortSignal;
}

export class EventSequencer {
  readonly sessionId: string;
  readonly #clock: () => string;
  readonly #log: AriEvent[] = [];
  /** Resolvers of streams waiting for the next event. */
  readonly #waiting = new Set<() => void>();
  #closed = false;

  constructor(options: EventSequencerOptions) {
    this.sessionId = options.sessionId;
    this.#clock = options.clock ?? ((): string => new Date().toISOString());
  }

  /** The `seq` of the last event emitted; 0 before the first. */
  get lastSeq(): number {
    return this.#log.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Stamps and keeps one event, wakes every waiting stream and returns the event. */
  emit(input: SequencerEventInput): AriEvent {
    if (this.#closed) throw new Error(`EventSequencer for session ${this.sessionId} is closed`);
    const event: AriEvent = {
      seq: this.#log.length + 1,
      at: input.at ?? this.#clock(),
      sessionId: this.sessionId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.hostTag === undefined ? {} : { hostTag: input.hostTag }),
      body: input.body,
      ...(input.native === undefined ? {} : { native: input.native }),
    };
    this.#log.push(event);
    this.#wakeAll();
    return event;
  }

  /** Ends every stream once it has read the events already emitted. */
  close(): void {
    this.#closed = true;
    this.#wakeAll();
  }

  /**
   * A stream of this session's events from `fromSeq` on. Throws a
   * `validation` call error when `fromSeq` is not a positive integer.
   */
  events(options: SequencerEventsOptions = {}): AsyncIterableIterator<AriEvent> {
    const fromSeq = options.fromSeq ?? 1;
    if (!Number.isInteger(fromSeq) || fromSeq < 1) {
      throw callErrors.validation([{ message: "fromSeq must be a positive integer", path: ["fromSeq"] }]);
    }
    const signal = options.signal;
    const log = this.#log;
    const waiting = this.#waiting;
    const isClosed = (): boolean => this.#closed;

    let nextIndex = fromSeq - 1;
    let finished = false;
    /** This stream's own waiting resolvers, so finishing wakes only them. */
    const ownWaiting = new Set<() => void>();

    const finish = (): void => {
      finished = true;
      signal?.removeEventListener("abort", finish);
      for (const resolve of ownWaiting) {
        waiting.delete(resolve);
        resolve();
      }
      ownWaiting.clear();
    };
    if (signal?.aborted === true) finished = true;
    else signal?.addEventListener("abort", finish, { once: true });

    const iterator: AsyncIterableIterator<AriEvent> = {
      async next(): Promise<IteratorResult<AriEvent, undefined>> {
        while (!finished) {
          const event = log[nextIndex];
          if (event !== undefined) {
            nextIndex += 1;
            return { done: false, value: event };
          }
          if (isClosed()) break;
          await new Promise<void>((resolve) => {
            const wake = (): void => {
              ownWaiting.delete(wake);
              resolve();
            };
            ownWaiting.add(wake);
            waiting.add(wake);
          });
        }
        finish();
        return { done: true, value: undefined };
      },
      async return(): Promise<IteratorResult<AriEvent, undefined>> {
        finish();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  }

  #wakeAll(): void {
    const waiting = [...this.#waiting];
    this.#waiting.clear();
    for (const wake of waiting) wake();
  }
}
