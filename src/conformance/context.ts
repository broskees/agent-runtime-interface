// What a scenario works with: rigs, instances and sessions it opens (all
// cleaned up when it ends), an event collector per session that runs the
// strict EventGrammar, waits bounded by real-time deadlines, the scenario's
// clock, and the rules for "not applicable".
//
// A scenario is not applicable only when a declared capability (or the
// absence of an optional member, which is how a driver declares it lacks a
// feature) rules it out, or when the harness gives a one-line reason under the
// scenario's key. A check inside a scenario may be skipped only for a harness
// reason under the check's key; the report lists it as a note. Anything else
// a scenario cannot do is a failure.

import { hasCapability } from "../capabilities.ts";
import type { Capabilities } from "../generated/capabilities.ts";
import type { ConfigValues } from "../generated/common.ts";
import type { RuntimeMode, RuntimePolicy } from "../generated/config.ts";
import type { AriEvent, TurnTerminalBody } from "../generated/events.ts";
import type { Fixture } from "../generated/fixture.ts";
import type { EnvPolicy } from "../generated/host.ts";
import type { OpenSessionInput } from "../generated/instance.ts";
import type { AppliedThread, StartTurnInput, StartTurnResult } from "../generated/session.ts";
import type { Thread } from "../generated/thread.ts";
import { EventGrammar, EventGrammarError, TERMINAL_ITEM_STATUSES } from "../host/event-grammar.ts";
import { reduceEvents } from "../host/reducer.ts";
import type { ReducedSession } from "../host/reducer.ts";
import { ReplayRecorder } from "../host/replay-recorder.ts";
import type { Instance, Session } from "../runtime.ts";
import { createFakeHost } from "./fake-host.ts";
import type { FakeHost } from "./fake-host.ts";
import type { ConformanceHarness, ConformanceWorkspace, HarnessRig, NativeTurn, RigRequest } from "./harness.ts";
import type { RecordedViolation } from "./report.ts";
import { VirtualClock } from "./virtual-clock.ts";
import { ConformanceFailure, brief, realNow, realSleep, withDeadline } from "./util.ts";

/** Thrown to end a scenario as not applicable. */
export class ScenarioNotApplicable extends Error {
  readonly by: "capability" | "harness";

  constructor(by: "capability" | "harness", reason: string) {
    super(reason);
    this.name = "ScenarioNotApplicable";
    this.by = by;
  }
}

/** A scenario's clock: virtual time it moves itself, or real time it waits out. */
export interface ScenarioClock {
  readonly mode: "virtual" | "real";
  now(): number;
  /** Lets `ms` pass. */
  pass(ms: number): Promise<void>;
  /** Moves virtual time on by the real time that passed and runs the timers that are due; nothing in real mode. */
  tick(): void;
}

/** Reads one session's events from `seq` 1, checking each against the strict EventGrammar. */
export class EventCollector {
  readonly events: AriEvent[] = [];
  readonly #grammar = new EventGrammar({ mode: "strict" });
  #grammarBroken = false;
  #ended = false;
  #error: unknown;
  readonly #iterator: AsyncIterator<AriEvent>;
  readonly #done: Promise<void>;

  constructor(stream: AsyncIterable<AriEvent>, onViolation: (error: EventGrammarError) => void) {
    this.#iterator = stream[Symbol.asyncIterator]();
    this.#done = this.#read(onViolation);
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** The error that ended the stream, if one did. */
  get error(): unknown {
    return this.#error;
  }

  find(predicate: (event: AriEvent) => boolean): AriEvent | undefined {
    return this.events.find(predicate);
  }

  filter(predicate: (event: AriEvent) => boolean): AriEvent[] {
    return this.events.filter(predicate);
  }

  /** The `turn.terminal` body for `turnId`, once it arrived. */
  terminal(turnId: string): TurnTerminalBody | undefined {
    for (const event of this.events) {
      if (event.body.type === "turn.terminal" && event.body.turnId === turnId) return event.body as TurnTerminalBody;
    }
    return undefined;
  }

  /** Stops reading, waiting up to `ms` of real time for the stream to end on its own. */
  async stop(ms = 1000): Promise<void> {
    await Promise.race([this.#done, realSleep(ms)]);
    if (!this.#ended) void this.#iterator.return?.().catch(() => undefined);
  }

  async #read(onViolation: (error: EventGrammarError) => void): Promise<void> {
    try {
      for (;;) {
        const result = await this.#iterator.next();
        if (result.done === true) break;
        const event = result.value;
        this.events.push(event);
        if (this.#grammarBroken) continue;
        try {
          this.#grammar.observe(event);
        } catch (error) {
          if (!(error instanceof EventGrammarError)) throw error;
          this.#grammarBroken = true;
          onViolation(error);
        }
      }
    } catch (error) {
      this.#error = error;
    } finally {
      this.#ended = true;
    }
  }
}

/** A session a scenario opened: the driver's session wrapped by the replay recorder, and its event collector. */
export interface OpenedSession {
  readonly session: Session;
  readonly events: EventCollector;
  capabilities(): Capabilities;
  /** Closes the session and keeps its fixture. Safe to call twice. */
  close(): Promise<void>;
}

/** An instance a scenario created, with the fake host it got. */
export interface CreatedInstance {
  readonly instance: Instance;
  readonly host: FakeHost;
  readonly instanceId: string;
  /** The driver's `kind`, recorded in fixtures. */
  readonly driverKind: string;
}

export interface InstanceOptions {
  readonly managedProfile?: boolean;
  readonly instanceId?: string;
  /** `CreateInstanceRequest.environment`. */
  readonly environment?: { readonly [name: string]: string };
  /** Added to the host's ambient environment. */
  readonly ambientEnvironment?: { readonly [name: string]: string };
  /** The host's environment policy, in place of the one the rig's `hostOptions` give (by default, none: the host strips nothing). */
  readonly envPolicy?: EnvPolicy;
}

const MODE_PREFERENCE: readonly RuntimeMode[] = ["approval_required", "auto_accept_edits", "auto", "read_only", "full_access"];

/** What one run of the suite shares across its scenarios. */
export interface SuiteState {
  /** Grammar violations seen on any stream so far. */
  readonly violations: RecordedViolation[];
  /** How many session streams the suite has checked. */
  streams: number;
}

export interface ScenarioContextOptions {
  readonly harness: ConformanceHarness<unknown>;
  readonly workspace: ConformanceWorkspace;
  readonly scenarioKey: string;
  readonly timeoutMs: number;
  readonly suite: SuiteState;
}

export class ScenarioContext {
  readonly harness: ConformanceHarness<unknown>;
  readonly workspace: ConformanceWorkspace;
  readonly key: string;
  readonly timeoutMs: number;
  readonly notes: string[] = [];
  readonly fixtures: Fixture[] = [];
  readonly suite: SuiteState;
  readonly #cleanups: Array<() => Promise<void>> = [];
  #clock: ScenarioClock | undefined;
  #counter = 0;

  constructor(options: ScenarioContextOptions) {
    this.harness = options.harness;
    this.workspace = options.workspace;
    this.key = options.scenarioKey;
    this.timeoutMs = options.timeoutMs;
    this.suite = options.suite;
  }

  /** A name unique within this scenario run. */
  unique(prefix: string): string {
    this.#counter += 1;
    return `${prefix}-${this.#counter}`;
  }

  note(text: string): void {
    this.notes.push(text);
  }

  fail(message: string): never {
    throw new ConformanceFailure(message);
  }

  check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new ConformanceFailure(message);
  }

  /** The harness's one-line reason for `key`, if it gave one. A reason that is empty or spans lines is a failure. */
  harnessReason(key: string): string | undefined {
    const reason = this.harness.notApplicable?.[key];
    if (reason === undefined) return undefined;
    if (reason.trim() === "" || /[\r\n]/.test(reason)) {
      this.fail(`the harness's reason for "${key}" must be one non-empty line`);
    }
    return reason.trim();
  }

  /** Skips a check when the harness gives a reason under `key`, noting it; returns false when the check must run. */
  skipCheck(key: string, what: string): boolean {
    const reason = this.harnessReason(key);
    if (reason === undefined) return false;
    this.note(`${what} not checked (${key}): ${reason}`);
    return true;
  }

  /** Ends the scenario as not applicable when the capability at `path` is off. */
  requireCapability(capabilities: Capabilities, path: string, expected?: unknown): void {
    if (hasCapability(capabilities, path, expected)) return;
    const wanted = expected === undefined ? "" : ` with ${JSON.stringify(expected)}`;
    throw new ScenarioNotApplicable("capability", `the driver declares capability ${path}${wanted} off`);
  }

  /** Ends the scenario as not applicable because the driver leaves out an optional member. */
  notApplicableByAbsence(member: string): never {
    throw new ScenarioNotApplicable("capability", `the driver leaves out the optional member ${member}`);
  }

  /** Registers a cleanup; cleanups run last-first when the scenario ends. */
  defer(cleanup: () => Promise<void> | void): void {
    this.#cleanups.push(async () => {
      await cleanup();
    });
  }

  /** Runs every cleanup, noting failures instead of throwing. */
  async cleanup(): Promise<void> {
    while (this.#cleanups.length > 0) {
      const cleanup = this.#cleanups.pop()!;
      try {
        await withDeadline(cleanup(), this.timeoutMs, "cleanup");
      } catch (error) {
        this.note(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.#clock = undefined;
  }

  /**
   * Waits until `check` returns a value other than `undefined` or `false`,
   * polling every few real milliseconds and running due virtual timers.
   * Fails after `timeoutMs` of real time.
   */
  async until<T>(check: () => T | undefined | false, description: string, timeoutMs = this.timeoutMs): Promise<T> {
    const deadline = realNow() + timeoutMs;
    for (;;) {
      this.#clock?.tick();
      const value = check();
      if (value !== undefined && value !== false) return value;
      if (realNow() > deadline) this.fail(`timed out after ${timeoutMs} ms waiting for ${description}`);
      await realSleep(2);
    }
  }

  /** Waits for `promise` with the scenario's deadline, running due virtual timers meanwhile. */
  async wait<T>(promise: Promise<T>, description: string, timeoutMs = this.timeoutMs): Promise<T> {
    let state: { settled: false } | { settled: true; ok: true; value: T } | { settled: true; ok: false; error: unknown } = { settled: false };
    promise.then(
      (value) => {
        state = { settled: true, ok: true, value };
      },
      (error: unknown) => {
        state = { settled: true, ok: false, error };
      },
    );
    await this.until(() => state.settled, description, timeoutMs);
    const settled = state as unknown as { settled: true; ok: true; value: T } | { settled: true; ok: false; error: unknown };
    if (!settled.ok) throw settled.error;
    return settled.value;
  }

  /**
   * Runs `body` with the harness's clock: virtual time installed for its
   * duration, or real time. Call it before asking for the rig, so every timer
   * the driver makes for the check (even one it makes when the session opens)
   * is on the clock.
   */
  async withClock<T>(body: (clock: ScenarioClock) => Promise<T>): Promise<T> {
    if (this.harness.time === "real") {
      const clock: ScenarioClock = { mode: "real", now: () => realNow(), pass: (ms) => realSleep(ms), tick: () => undefined };
      this.#clock = clock;
      try {
        return await body(clock);
      } finally {
        this.#clock = undefined;
      }
    }
    const virtual = new VirtualClock();
    const clock: ScenarioClock = {
      mode: "virtual",
      now: () => virtual.now(),
      pass: (ms) => virtual.pass(ms),
      tick: () => virtual.followRealTime(),
    };
    virtual.install();
    this.#clock = clock;
    try {
      return await body(clock);
    } finally {
      this.#clock = undefined;
      virtual.uninstall();
    }
  }

  /** A fresh rig from the harness. */
  async rig(request: Partial<Pick<RigRequest, "ambientAuth">> = {}): Promise<HarnessRig<unknown>> {
    const rig = await this.wait(
      this.harness.setup({ scenario: this.key, workspace: this.workspace, ambientAuth: request.ambientAuth ?? "authenticated" }),
      "the harness to set up a rig",
    );
    this.defer(() => rig.dispose?.());
    return rig;
  }

  /** Creates an instance of the rig's driver with its own fake host. */
  async instance(rig: HarnessRig<unknown>, options: InstanceOptions = {}): Promise<CreatedInstance> {
    const instanceId = options.instanceId ?? this.unique(`conformance-${this.key}`);
    const config = rig.config ?? rig.driver.defaultConfig();
    const hostOptions = (await rig.hostOptions?.(instanceId, { managedProfile: options.managedProfile ?? false })) ?? {};
    const host = createFakeHost<unknown>({
      label: instanceId,
      config,
      ...hostOptions,
      ...(options.envPolicy === undefined ? {} : { envPolicy: options.envPolicy }),
      ambientEnvironment: { ...(hostOptions.ambientEnvironment ?? {}), ...(options.ambientEnvironment ?? {}) },
    });
    this.defer(() => host.dispose());
    const instance = await this.wait(
      rig.driver.create(host, { instanceId, config, environment: { ...(options.environment ?? {}) } }),
      "driver.create",
    );
    this.defer(async () => {
      await instance.dispose();
    });
    return { instance, host: host as FakeHost, instanceId, driverKind: rig.driver.kind };
  }

  /** Opens a session, records it as a fixture and starts collecting its events. */
  async openSession(created: CreatedInstance, input: OpenSessionInput = {}): Promise<OpenedSession> {
    const raw = await this.wait(created.instance.openSession(input), "openSession");
    const recorder = new ReplayRecorder({
      name: `${this.key}: ${raw.id}`,
      description: `Recorded by the ARI conformance kit (${this.harness.name}).`,
      driver: { kind: created.driverKind, identityVersion: raw.capabilities().identity.identityVersion },
    });
    const session = recorder.recordSession(raw);
    const events = new EventCollector(session.events(), (error) => {
      this.suite.violations.push({ scenario: this.key, sessionId: raw.id, violation: error.violation });
    });
    this.suite.streams += 1;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        try {
          await this.wait(session.close(), "session.close");
        } finally {
          await events.stop();
          this.fixtures.push(recorder.fixture());
        }
      })();
      return closing;
    };
    this.defer(close);
    return { session, events, capabilities: () => raw.capabilities(), close };
  }

  /**
   * The policy scenarios use: `mode` if given, else the first mode the session
   * supports. `mode: null` leaves the mode out, so the harness keeps its own.
   */
  policy(capabilities: Capabilities, cwd: string, mode?: RuntimeMode | null): RuntimePolicy {
    if (mode === null) return { interaction: "default", cwd };
    const chosen = mode ?? MODE_PREFERENCE.find((candidate) => hasCapability(capabilities, `runtimePolicy.modes.${candidate}`)) ?? "approval_required";
    return { mode: chosen, interaction: "default", cwd };
  }

  /**
   * Creates a thread with `policy` (`mode: null` leaves the mode to the
   * harness) and checks the mode it reports: a host's mode as the host chose
   * it, or the harness's own, never one the driver made up.
   */
  async createThread(opened: OpenedSession, options: { cwd?: string; mode?: RuntimeMode | null; config?: ConfigValues } = {}): Promise<AppliedThread> {
    const cwd = options.cwd ?? this.workspace.cwd;
    const policy = this.policy(opened.capabilities(), cwd, options.mode);
    const input = options.config === undefined ? { cwd, policy } : { cwd, policy, config: options.config };
    const thread = await this.wait(opened.session.createThread(input), "createThread");
    this.checkEffectiveMode(thread.effectiveMode, policy, `the thread createThread returned`);
    return thread;
  }

  /**
   * Checks a thread's `effectiveMode` against the policy that created it:
   * source `host` and the host's mode when the policy named one, source
   * `harness` when it left the mode out.
   */
  checkEffectiveMode(effective: Thread["effectiveMode"], policy: RuntimePolicy, what: string): void {
    if (policy.mode === undefined) {
      this.check(
        effective?.source === "harness",
        `${what} has effectiveMode ${brief(effective)}; the host left policy.mode out, so it must say source "harness" (with the harness's mode, or no mode while the driver does not know it)`,
      );
      return;
    }
    this.check(
      effective?.source === "host" && effective.mode === policy.mode,
      `${what} has effectiveMode ${brief(effective)}; the host chose policy.mode ${brief(policy.mode)}, so it must say mode ${brief(policy.mode)} with source "host"`,
    );
  }

  /** Calls `startTurn` with a text prompt and a unique `clientTurnKey`. */
  startTurn(opened: OpenedSession, threadId: string, text: string, extra: Partial<StartTurnInput> = {}): Promise<StartTurnResult> {
    return this.wait(
      opened.session.startTurn({ threadId, clientTurnKey: this.unique(`${this.key}-turn`), intent: "start", content: [{ type: "text", text }], ...extra }),
      `startTurn (${extra.intent ?? "start"})`,
    );
  }

  /** Starts a turn, checks it was accepted as started, and waits for the native agent to receive it. */
  async beginTurn(opened: OpenedSession, rig: HarnessRig<unknown>, threadId: string, text: string): Promise<{ turnId: string; native: NativeTurn }> {
    const result = await this.startTurn(opened, threadId, text);
    this.check(result.status === "accepted", `startTurn did not accept a new turn: ${brief(result)}`);
    const native = await this.wait(rig.native.nextTurn(), "the native agent to receive the prompt");
    this.check(native.prompt.includes(text), `the native agent received prompt ${brief(native.prompt)}, expected ${brief(text)}`);
    await this.until(() => opened.events.find((event) => event.body.type === "turn.upsert" && event.body.turn.id === result.turnId), `turn.upsert for turn ${result.turnId}`);
    return { turnId: result.turnId, native };
  }

  /** Waits for the turn's `turn.terminal`. */
  terminal(opened: OpenedSession, turnId: string, description = `turn.terminal for turn ${turnId}`): Promise<TurnTerminalBody> {
    return this.until(() => opened.events.terminal(turnId), description);
  }

  /** One turn the native agent answers with `reply` and completes. */
  async simpleTurn(opened: OpenedSession, rig: HarnessRig<unknown>, threadId: string, text: string, reply = "Done."): Promise<{ turnId: string; terminal: TurnTerminalBody }> {
    const { turnId, native } = await this.beginTurn(opened, rig, threadId, text);
    await this.wait(native.say(reply), "the native agent to stream its reply");
    await this.wait(native.complete(), "the native agent to complete the turn");
    const terminal = await this.terminal(opened, turnId);
    return { turnId, terminal };
  }

  /** The session's state folded from its events so far. */
  reduced(opened: OpenedSession): ReducedSession {
    return reduceEvents(opened.events.events);
  }

  /** Items of `turnId` still open when its `turn.terminal` arrived. */
  openItemsAtTerminal(opened: OpenedSession, turnId: string): string[] {
    const status = new Map<string, string>();
    for (const event of opened.events.events) {
      const body = event.body;
      if (body.type === "turn.terminal" && body.turnId === turnId) break;
      if (body.type !== "item.upsert") continue;
      const belongs = event.turnId === turnId || body.item.turnId === turnId || status.has(body.item.id);
      if (!belongs) continue;
      if (body.item.status !== undefined) status.set(body.item.id, body.item.status);
      else if (!status.has(body.item.id)) status.set(body.item.id, "unknown");
    }
    return [...status].filter(([, value]) => !TERMINAL_ITEM_STATUSES.has(value)).map(([id]) => id);
  }
}
