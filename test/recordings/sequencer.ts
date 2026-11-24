// The replay sequencer: walks a recording in order. Each outbound frame the
// driver sends must equal the next recorded frame, apart from the fields the
// driver's kit lists as ignored (docs/recordings.md, "Fields replay
// ignores"). Each recorded inbound frame is delivered as soon as every frame
// before it has happened: the outbound ones matched, the inbound ones
// delivered. It knows nothing of the transport: a replay SDK or a replay
// HTTP server hands it frames and receives deliveries.
//
// Every failure names the recording file, the line, and both frames. The
// first failure sticks: later sends rethrow it, so a driver that swallows an
// error still fails the replay.

import type { Frame, Recording } from "./format.ts";

/** One field replay leaves out of the comparison, with why. `field` is a dotted path inside frames of `kind`. */
export interface IgnoredField {
  readonly driver: string;
  readonly kind: string;
  readonly field: string;
  readonly reason: string;
}

export class ReplayDriftError extends Error {
  readonly file: string;
  readonly line: number;
  constructor(file: string, line: number, message: string) {
    super(`${file}:${line}: ${message}`);
    this.name = "ReplayDriftError";
    this.file = file;
    this.line = line;
  }
}

const SHOWN_CHARACTERS = 6000;

/** A frame as an error shows it: its JSON, cut after a few thousand characters. */
export function showFrame(frame: Frame | undefined): string {
  if (frame === undefined) return "(none)";
  const json = JSON.stringify(frame);
  return json.length <= SHOWN_CHARACTERS ? json : `${json.slice(0, SHOWN_CHARACTERS)}… (${json.length - SHOWN_CHARACTERS} more characters)`;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value === "object" && value !== null) {
    const out: { [key: string]: unknown } = {};
    for (const key of Object.keys(value).sort()) out[key] = sorted((value as { [key: string]: unknown })[key]);
    return out;
  }
  return value;
}

/** A copy of `frame` without the ignored fields of its kind. */
export function withoutIgnored(frame: Frame, ignored: readonly IgnoredField[]): Frame {
  const copy = JSON.parse(JSON.stringify(frame)) as { [key: string]: unknown };
  for (const entry of ignored) {
    if (entry.kind !== frame.kind) continue;
    const parts = entry.field.split(".");
    let target: unknown = copy;
    for (const part of parts.slice(0, -1)) target = typeof target === "object" && target !== null ? (target as { [key: string]: unknown })[part] : undefined;
    if (typeof target === "object" && target !== null) delete (target as { [key: string]: unknown })[parts[parts.length - 1]!];
  }
  return copy as Frame;
}

/** The first path where two JSON values differ, or undefined when they are equal. */
export function firstDifference(expected: unknown, actual: unknown, at = ""): { path: string; expected: unknown; actual: unknown } | undefined {
  if (JSON.stringify(sorted(expected)) === JSON.stringify(sorted(actual))) return undefined;
  const bothObjects = typeof expected === "object" && expected !== null && typeof actual === "object" && actual !== null && Array.isArray(expected) === Array.isArray(actual);
  if (!bothObjects) return { path: at === "" ? "(the whole frame)" : at, expected, actual };
  const keys = new Set([...Object.keys(expected as object), ...Object.keys(actual as object)]);
  for (const key of [...keys].sort()) {
    const inner = firstDifference((expected as { [key: string]: unknown })[key], (actual as { [key: string]: unknown })[key], at === "" ? key : `${at}.${key}`);
    if (inner !== undefined) return inner;
  }
  return { path: at === "" ? "(the whole frame)" : at, expected, actual };
}

export interface ReplaySequencerOptions {
  readonly recording: Recording;
  /** The fields to leave out of the comparison; only those of the recording's driver apply. */
  readonly ignored: readonly IgnoredField[];
  /** Hands one recorded inbound frame to the driver's side. It must not call back into `send` synchronously. */
  readonly deliver: (frame: Frame, line: number) => void;
}

export class ReplaySequencer {
  readonly recording: Recording;
  readonly #ignored: readonly IgnoredField[];
  readonly #deliver: (frame: Frame, line: number) => void;
  #position = 0;
  #failure: Error | undefined;
  #lastLine: number | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #matched: Frame[] = [];

  constructor(options: ReplaySequencerOptions) {
    this.recording = options.recording;
    this.#ignored = options.ignored.filter((entry) => entry.driver === options.recording.header.driver);
    this.#deliver = options.deliver;
  }

  /** The first failure, if any. */
  get failure(): Error | undefined {
    return this.#failure;
  }

  /** The recorded outbound frames matched so far, in order. */
  matchedOutbound(): readonly Frame[] {
    return this.#matched;
  }

  /** Calls `listener` after every step and on failure; returns a function that removes it. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #fail(error: Error): Error {
    this.#failure ??= error;
    this.#changed();
    return this.#failure;
  }

  #frameAt(position: number): { line: number; frame: Frame } | undefined {
    return this.recording.frames[position];
  }

  #last(): { line: number; frame: Frame } | undefined {
    return this.#position === 0 ? undefined : this.#frameAt(this.#position - 1);
  }

  /** Delivers the leading inbound frames. */
  start(): void {
    this.#deliverDue();
  }

  #deliverDue(): void {
    for (;;) {
      if (this.#failure !== undefined) return;
      const next = this.#frameAt(this.#position);
      if (next === undefined || next.frame.dir !== "in") break;
      this.#position += 1;
      this.#lastLine = next.line;
      try {
        this.#deliver(next.frame, next.line);
      } catch (error) {
        this.#fail(new ReplayDriftError(this.recording.file, next.line, `replay could not deliver the recorded frame: ${error instanceof Error ? error.message : String(error)}\n  recorded (line ${next.line}): ${showFrame(next.frame)}`));
        return;
      }
    }
    this.#changed();
  }

  /** The driver sent `actual`. Throws a ReplayDriftError when it is not the next recorded frame. */
  send(actual: Frame): void {
    if (this.#failure !== undefined) throw this.#failure;
    const file = this.recording.file;
    const next = this.#frameAt(this.#position);
    if (next === undefined) {
      const last = this.#last();
      throw this.#fail(
        new ReplayDriftError(
          file,
          (last?.line ?? 1) + 1,
          `replay drift: the driver sent a frame after the last recorded one\n  last recorded (line ${last?.line ?? 1}): ${showFrame(last?.frame)}\n  sent: ${showFrame(actual)}`,
        ),
      );
    }
    const expected = withoutIgnored(next.frame, this.#ignored);
    const got = withoutIgnored(actual, this.#ignored);
    const difference =
      next.frame.dir !== "out"
        ? { path: "dir", expected: next.frame.dir, actual: actual.dir }
        : expected.kind !== got.kind
          ? { path: "kind", expected: expected.kind, actual: got.kind }
          : firstDifference(expected, got);
    if (difference !== undefined) {
      throw this.#fail(
        new ReplayDriftError(
          file,
          next.line,
          `replay drift: the driver sent a frame other than the next recorded one (first difference at ${difference.path}: recorded ${JSON.stringify(difference.expected)}, sent ${JSON.stringify(difference.actual)})\n  recorded (line ${next.line}): ${showFrame(next.frame)}\n  sent: ${showFrame(actual)}`,
        ),
      );
    }
    this.#position += 1;
    this.#lastLine = next.line;
    this.#matched.push(next.frame);
    this.#deliverDue();
  }

  /** True when every recorded frame has been matched or delivered. */
  done(): boolean {
    return this.#position >= this.recording.frames.length;
  }

  /** Where replay stands, for a report that the scenario stopped making progress. */
  describe(what: string): string {
    const next = this.#frameAt(this.#position);
    const last = this.#last();
    const line = next?.line ?? (last?.line ?? 1) + 1;
    return `${this.recording.file}:${line}: replay stalled: ${what}\n  next recorded (line ${next?.line ?? "end"}): ${showFrame(next?.frame)}\n  last replayed (line ${last?.line ?? "none"}): ${showFrame(last?.frame)}`;
  }

  /** Throws a ReplayDriftError unless every recorded frame was replayed. Call it when the scenario has ended. */
  finish(): void {
    if (this.#failure !== undefined) throw this.#failure;
    const next = this.#frameAt(this.#position);
    if (next === undefined) return;
    const last = this.#last();
    const left = this.recording.frames.length - this.#position;
    throw this.#fail(
      new ReplayDriftError(
        this.recording.file,
        next.line,
        `replay drift: the scenario ended with ${left} recorded frame(s) not replayed\n  next recorded (line ${next.line}): ${showFrame(next.frame)}\n  last replayed (line ${last?.line ?? "none"}): ${showFrame(last?.frame)}`,
      ),
    );
  }

  /** The line of the frame replayed last. */
  get lastLine(): number | undefined {
    return this.#lastLine;
  }
}
