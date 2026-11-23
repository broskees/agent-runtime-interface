// The replay recorder: records a session into the fixture format of
// spec/v1/fixture.schema.json, and reads fixtures back.
//
// `recorder.recordSession(session)` returns a `Session` that behaves exactly
// like `session` and records, in the order they happen:
//
// - each call to a session member, as a `call` entry with the wire method name
//   from methods.json (`session/<member>`, for example
//   `session/backgroundTasks.list`) and the wire params without `sessionId`
//   (positional arguments become named fields: `readSnapshot(threadId)` is
//   recorded as `{ threadId }`);
// - its outcome, as a `result` entry (`null` for a call that returns nothing)
//   or an `error` entry carrying the call error;
// - each event the host reads through `events()`, as an `event` entry. An event
//   is recorded once per `seq`, so a reconnect with `fromSeq` that replays
//   events does not record them twice. `events()` itself is not a call entry.
//
// Values are recorded in their JSON form at the moment they pass, so later
// changes to the objects do not change the fixture. `fixture()` returns the
// recording; `serializeFixture` writes it as JSON text. Nothing here touches
// the file system, so `ari/host` stays browser-safe: the host writes the text
// wherever it keeps fixtures.
//
// `parseFixture` reads a fixture back. It refuses a fixture whose persistence
// major version is higher than this package's, naming both versions, and
// validates the rest against the schema.

import { callErrors, toCallError } from "../errors.ts";
import type { Capabilities } from "../generated/capabilities.ts";
import type { AriEvent } from "../generated/events.ts";
import { FixtureSchema } from "../generated/fixture.ts";
import type { Fixture, FixtureDriver, FixtureEntry } from "../generated/fixture.ts";
import type { Session } from "../runtime.ts";
import { ARI_VERSION, GRAMMAR_VERSIONS, PERSISTENCE_VERSION } from "../version.ts";

export interface ReplayRecorderOptions {
  readonly name?: string;
  readonly description?: string;
  readonly driver?: FixtureDriver;
  /** The current time as an ISO-8601 string. Defaults to the system clock. */
  readonly clock?: () => string;
}

/** A value's JSON wire form: what `JSON.stringify` would send, with `undefined` as `null`. */
function toWire(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

export class ReplayRecorder {
  readonly #options: ReplayRecorderOptions;
  readonly #clock: () => string;
  readonly #entries: FixtureEntry[] = [];
  readonly #recordedSeqs = new Set<number>();
  readonly #recordedAt: string;
  #nextCallId = 1;
  #sessionId: string | undefined;
  #capabilities: Capabilities | undefined;

  constructor(options: ReplayRecorderOptions = {}) {
    this.#options = options;
    this.#clock = options.clock ?? ((): string => new Date().toISOString());
    this.#recordedAt = this.#clock();
  }

  /** Records one event, unless an event with the same `seq` was already recorded. */
  recordEvent(event: AriEvent): void {
    if (this.#recordedSeqs.has(event.seq)) return;
    this.#recordedSeqs.add(event.seq);
    this.#entries.push({ type: "event", event: toWire(event) as AriEvent });
  }

  /** Records `invoke`'s call and its outcome, synchronous or not, and returns its result unchanged. */
  recordCall<Result>(method: string, params: unknown, invoke: () => Result): Result {
    const callId = this.#nextCallId;
    this.#nextCallId += 1;
    this.#entries.push({ type: "call", callId, method, params: toWire(params), at: this.#clock() });
    let result: Result;
    try {
      result = invoke();
    } catch (error) {
      this.#recordError(callId, error);
      throw error;
    }
    if (!isPromiseLike(result)) {
      this.#entries.push({ type: "result", callId, result: toWire(result), at: this.#clock() });
      return result;
    }
    return Promise.resolve(result).then(
      (value) => {
        this.#entries.push({ type: "result", callId, result: toWire(value), at: this.#clock() });
        return value;
      },
      (error: unknown) => {
        this.#recordError(callId, error);
        throw error;
      },
    ) as Result;
  }

  #recordError(callId: number, error: unknown): void {
    const callError = toCallError(error);
    const message = error instanceof Error ? error.message : String(error);
    this.#entries.push(
      callError === undefined
        ? { type: "error", callId, message, at: this.#clock() }
        : { type: "error", callId, message, callError, at: this.#clock() },
    );
  }

  /** Returns a session that records every call made through it and every event read from it. */
  recordSession(session: Session): Session {
    this.#sessionId = session.id;
    this.#capabilities = toWire(session.capabilities()) as Capabilities;
    const call = <Result>(member: string, params: unknown, invoke: () => Result): Result =>
      this.recordCall(`session/${member}`, params, invoke);
    const recorder = this;

    const recorded: Session = {
      get id() {
        return session.id;
      },
      capabilities: () => call("capabilities", {}, () => session.capabilities()),
      events: (options) => {
        const source = session.events(options);
        return (async function* recordedEvents(): AsyncGenerator<AriEvent, void, undefined> {
          for await (const event of source) {
            recorder.recordEvent(event);
            yield event;
          }
        })();
      },
      createThread: (input) => call("createThread", input, () => session.createThread(input)),
      resumeThread: (input) => call("resumeThread", input, () => session.resumeThread(input)),
      canRelease: () => call("canRelease", {}, () => session.canRelease()),
      release: () => call("release", {}, () => session.release()),
      startTurn: (input) => call("startTurn", input, () => session.startTurn(input)),
      interruptTurn: (input) => call("interruptTurn", input, () => session.interruptTurn(input)),
      respond: (input) => call("respond", input, () => session.respond(input)),
      planConfigChange: (input) => call("planConfigChange", input, () => session.planConfigChange(input)),
      close: () => call("close", {}, () => session.close()),
    };

    const { readSnapshot, forkThread, rollbackThread, compactThread, injectHistory, unloadThread } = session;
    if (readSnapshot !== undefined) {
      recorded.readSnapshot = (threadId) => call("readSnapshot", { threadId }, () => readSnapshot.call(session, threadId));
    }
    if (forkThread !== undefined) {
      recorded.forkThread = (input) => call("forkThread", input, () => forkThread.call(session, input));
    }
    if (rollbackThread !== undefined) {
      recorded.rollbackThread = (input) => call("rollbackThread", input, () => rollbackThread.call(session, input));
    }
    if (compactThread !== undefined) {
      recorded.compactThread = (threadId) => call("compactThread", { threadId }, () => compactThread.call(session, threadId));
    }
    if (injectHistory !== undefined) {
      recorded.injectHistory = (input) => call("injectHistory", input, () => injectHistory.call(session, input));
    }
    if (unloadThread !== undefined) {
      recorded.unloadThread = (threadId) => call("unloadThread", { threadId }, () => unloadThread.call(session, threadId));
    }

    const backgroundTasks = session.backgroundTasks;
    if (backgroundTasks !== undefined) {
      recorded.backgroundTasks = {
        list: (threadId, options) =>
          call("backgroundTasks.list", { threadId, ...options }, () => backgroundTasks.list(threadId, options)),
        stop: (input) => call("backgroundTasks.stop", input, () => backgroundTasks.stop(input)),
        await: (input) => call("backgroundTasks.await", input, () => backgroundTasks.await(input)),
      };
    }

    const { stopSubagent, uploadFeedback, ext, contextWindow, canReuseContextUsage } = session;
    if (stopSubagent !== undefined) {
      recorded.stopSubagent = (input) => call("stopSubagent", input, () => stopSubagent.call(session, input));
    }

    const mcpApps = session.mcpApps;
    if (mcpApps !== undefined) {
      recorded.mcpApps = {
        listTools: (threadId, server) => call("mcpApps.listTools", { threadId, server }, () => mcpApps.listTools(threadId, server)),
        callTool: (threadId, server, tool, args) =>
          call("mcpApps.callTool", { threadId, server, tool, args }, () => mcpApps.callTool(threadId, server, tool, args)),
        readResource: (threadId, server, uri) =>
          call("mcpApps.readResource", { threadId, server, uri }, () => mcpApps.readResource(threadId, server, uri)),
      };
    }

    if (uploadFeedback !== undefined) {
      recorded.uploadFeedback = (input) => call("uploadFeedback", input, () => uploadFeedback.call(session, input));
    }
    if (ext !== undefined) {
      recorded.ext = (ns, method, params) => call("ext", { ns, method, params }, () => ext.call(session, ns, method, params));
    }
    if (contextWindow !== undefined) {
      recorded.contextWindow = (model, cwd) => call("contextWindow", { model, cwd }, () => contextWindow.call(session, model, cwd));
    }
    if (canReuseContextUsage !== undefined) {
      recorded.canReuseContextUsage = (previousModel, nextModel) =>
        call("canReuseContextUsage", { previousModel, nextModel }, () => canReuseContextUsage.call(session, previousModel, nextModel));
    }

    return recorded;
  }

  /** The recording so far, in the fixture format. */
  fixture(): Fixture {
    const { name, description, driver } = this.#options;
    return {
      format: "ari.fixture",
      persistence: { major: PERSISTENCE_VERSION.major, minor: PERSISTENCE_VERSION.minor },
      ariVersion: ARI_VERSION,
      grammarVersion: GRAMMAR_VERSIONS[1],
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      recordedAt: this.#recordedAt,
      ...(driver === undefined ? {} : { driver: { ...driver } }),
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(this.#capabilities === undefined ? {} : { capabilities: this.#capabilities }),
      entries: [...this.#entries],
    };
  }
}

/** A fixture as JSON text: two-space indented, ending in a newline. */
export function serializeFixture(fixture: Fixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/**
 * Reads a fixture from JSON text or parsed JSON. Throws a `validation` call
 * error when its persistence major version is newer than this package's (the
 * message names both versions) or when it does not match the fixture schema.
 */
export function parseFixture(input: string | unknown): Fixture {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  const persistence = (value as { persistence?: { major?: unknown; minor?: unknown } } | null)?.persistence;
  if (typeof persistence?.major === "number" && persistence.major > PERSISTENCE_VERSION.major) {
    const found = `${persistence.major}.${String(persistence.minor ?? 0)}`;
    const supported = `${PERSISTENCE_VERSION.major}.${PERSISTENCE_VERSION.minor}`;
    throw callErrors.validation(
      [{ message: `persistence version ${found} is newer than the supported ${supported}`, path: ["persistence", "major"] }],
      `Fixture persistence version ${found} is newer than the supported persistence version ${supported}`,
    );
  }
  return FixtureSchema.parse(value);
}

/** The fixture's events, in recorded order. */
export function fixtureEvents(fixture: Fixture): AriEvent[] {
  return fixture.entries.flatMap((entry) => (entry.type === "event" ? [entry.event] : []));
}

/** Replays the fixture's events as a session event stream. */
export async function* replayEvents(fixture: Fixture): AsyncGenerator<AriEvent, void, undefined> {
  for (const event of fixtureEvents(fixture)) yield event;
}
