// Virtual time for the scenarios that need long pauses: the settlement
// scenario puts 36 seconds between a tool result and the completion, and the
// auth scenario waits for a runtime auth poison to expire.
//
// While installed, a `VirtualClock` replaces the ordinary timers of this
// JavaScript realm: `globalThis.setTimeout`, `clearTimeout`, `setInterval`,
// `clearInterval`, `Date` (`new Date()` and `Date.now()`) and
// `performance.now()`. Time stands still until the kit moves it. So a driver
// that settles a turn from an ordinary quiet timer (a `setTimeout` it re-arms
// on every frame, or a `setInterval` that compares `Date.now()` against the
// last frame) sees its timer fire when the kit moves time past it, and is
// caught without the test waiting 36 real seconds.
//
// Virtual time never runs slower than real time: `followRealTime()` moves it
// on by the real time that passed, so a driver that waits a few real
// milliseconds (a retry back-off, a debounce) still gets its timer while the
// kit waits for something. Only `pass()` moves it faster.
//
// What it does not reach: `setImmediate`, `queueMicrotask` and
// `process.nextTick` stay real, so I/O and promises keep running. Timers a
// driver made before the clock was installed, timers it takes from
// `node:timers` or `node:timers/promises` directly, `AbortSignal.timeout`,
// and anything in another process keep real time. The scenarios that need
// long pauses install the clock before they ask the harness for a rig, so
// every timer the driver makes for that scenario is virtual. A harness whose
// driver keeps time some other way sets `time: "real"`, and the scenarios
// then wait for real.

import { realNow, realSleep } from "./util.ts";

type TimerCallback = (...args: unknown[]) => void;

interface VirtualTimer {
  readonly id: number;
  due: number;
  readonly callback: TimerCallback;
  readonly args: readonly unknown[];
  /** Set for `setInterval` timers: the period in milliseconds. */
  readonly interval: number | undefined;
}

interface SavedGlobals {
  readonly setTimeout: unknown;
  readonly clearTimeout: unknown;
  readonly setInterval: unknown;
  readonly clearInterval: unknown;
  readonly Date: DateConstructor;
  readonly performanceNow: PropertyDescriptor | undefined;
}

/** The handle `setTimeout` returns while virtual time is installed. It has the methods Node's `Timeout` has. */
export interface VirtualTimerHandle {
  ref(): VirtualTimerHandle;
  unref(): VirtualTimerHandle;
  hasRef(): boolean;
  refresh(): VirtualTimerHandle;
  [Symbol.toPrimitive](): number;
}

/** How many timers `runDue` runs at most in one call, so an interval of 0 cannot loop forever. */
const MAX_TIMERS_PER_RUN = 10_000;

/** Virtual timer ids start here, far above the ids the real timers hand out, so the two never collide. */
const FIRST_TIMER_ID = 1_000_000_000;

export class VirtualClock {
  #now: number;
  readonly #timers = new Map<number, VirtualTimer>();
  /** Ids of timers cleared with `clearTimeout` or `clearInterval`. */
  readonly #cancelled = new Set<number>();
  readonly #handleIds = new WeakMap<object, number>();
  #nextId = FIRST_TIMER_ID;
  #saved: SavedGlobals | undefined;
  #installedAtReal = 0;
  #installedAtVirtual = 0;
  /** The real time `followRealTime` last caught up to. */
  #followedReal = realNow();

  /** Starts at `startMs` milliseconds since the epoch; defaults to the real time now. */
  constructor(startMs: number = realNow()) {
    this.#now = startMs;
  }

  /** The virtual time in milliseconds since the epoch. */
  now(): number {
    return this.#now;
  }

  get installed(): boolean {
    return this.#saved !== undefined;
  }

  /** Timers waiting to run. */
  get pendingTimers(): number {
    return this.#timers.size;
  }

  /** Replaces the global timers, `Date` and `performance.now` with virtual ones. */
  install(): void {
    if (this.#saved !== undefined) return;
    const global = globalThis as unknown as { [name: string]: unknown };
    const performanceObject = (globalThis as { performance?: { now?: () => number } }).performance;
    this.#saved = {
      setTimeout: global["setTimeout"],
      clearTimeout: global["clearTimeout"],
      setInterval: global["setInterval"],
      clearInterval: global["clearInterval"],
      Date: globalThis.Date,
      performanceNow: performanceObject === undefined ? undefined : Object.getOwnPropertyDescriptor(performanceObject, "now"),
    };
    this.#installedAtReal = performanceObject?.now?.() ?? 0;
    this.#installedAtVirtual = this.#now;
    this.#followedReal = realNow();

    global["setTimeout"] = (callback: unknown, delay?: unknown, ...args: unknown[]) => this.#schedule(callback, delay, args, false);
    global["setInterval"] = (callback: unknown, delay?: unknown, ...args: unknown[]) => this.#schedule(callback, delay, args, true);
    // A handle the real timers made (before install) is cleared by the real function.
    const realClearTimeout = this.#saved.clearTimeout as (handle: unknown) => void;
    const realClearInterval = this.#saved.clearInterval as (handle: unknown) => void;
    global["clearTimeout"] = (handle: unknown) => {
      if (!this.#cancel(handle)) realClearTimeout(handle);
    };
    global["clearInterval"] = (handle: unknown) => {
      if (!this.#cancel(handle)) realClearInterval(handle);
    };
    global["Date"] = this.#virtualDate(this.#saved.Date);
    if (performanceObject !== undefined) {
      Object.defineProperty(performanceObject, "now", {
        configurable: true,
        writable: true,
        value: () => this.#installedAtReal + (this.#now - this.#installedAtVirtual),
      });
    }
  }

  /** Puts the real globals back. Timers still pending are dropped. */
  uninstall(): void {
    const saved = this.#saved;
    if (saved === undefined) return;
    const global = globalThis as unknown as { [name: string]: unknown };
    global["setTimeout"] = saved.setTimeout;
    global["clearTimeout"] = saved.clearTimeout;
    global["setInterval"] = saved.setInterval;
    global["clearInterval"] = saved.clearInterval;
    global["Date"] = saved.Date;
    const performanceObject = (globalThis as { performance?: object }).performance;
    if (performanceObject !== undefined) {
      if (saved.performanceNow === undefined) delete (performanceObject as { now?: unknown }).now;
      else Object.defineProperty(performanceObject, "now", saved.performanceNow);
    }
    this.#timers.clear();
    this.#saved = undefined;
  }

  /** Runs every timer due at or before the current virtual time, earliest first. Returns how many ran. */
  runDue(): number {
    let ran = 0;
    for (;;) {
      const timer = this.#earliest();
      if (timer === undefined || timer.due > this.#now) return ran;
      this.#fire(timer);
      ran += 1;
      if (ran >= MAX_TIMERS_PER_RUN) return ran;
    }
  }

  /** Moves virtual time forward by `ms`, running each timer at its due time on the way. */
  advanceBy(ms: number): void {
    const target = this.#now + Math.max(0, ms);
    let ran = 0;
    for (;;) {
      const timer = this.#earliest();
      if (timer === undefined || timer.due > target) break;
      this.#now = Math.max(this.#now, timer.due);
      this.#fire(timer);
      ran += 1;
      if (ran >= MAX_TIMERS_PER_RUN) break;
    }
    this.#now = target;
  }

  /** Moves virtual time forward by the real time that passed since the last call (or since install), running timers on the way. */
  followRealTime(): void {
    const real = realNow();
    const elapsed = real - this.#followedReal;
    this.#followedReal = real;
    this.advanceBy(elapsed);
  }

  /**
   * Lets `ms` of virtual time pass in steps of `stepMs`, yielding to real I/O
   * after each step so a driver can react to the timers that fired. The real
   * time the steps take is not added on top.
   */
  async pass(ms: number, stepMs = 250): Promise<void> {
    let remaining = ms;
    while (remaining > 0) {
      const step = Math.min(stepMs, remaining);
      this.advanceBy(step);
      remaining -= step;
      await realSleep(0);
      this.runDue();
      await realSleep(0);
    }
    this.#followedReal = realNow();
  }

  #earliest(): VirtualTimer | undefined {
    let earliest: VirtualTimer | undefined;
    for (const timer of this.#timers.values()) {
      if (earliest === undefined || timer.due < earliest.due || (timer.due === earliest.due && timer.id < earliest.id)) earliest = timer;
    }
    return earliest;
  }

  #fire(timer: VirtualTimer): void {
    if (timer.interval === undefined) this.#timers.delete(timer.id);
    else timer.due += timer.interval;
    try {
      timer.callback(...timer.args);
    } catch (error) {
      // A real timer callback that throws is an uncaught exception; keep that.
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  #schedule(callback: unknown, delay: unknown, args: readonly unknown[], repeat: boolean): VirtualTimerHandle {
    if (typeof callback !== "function") throw new TypeError("The callback argument must be of type function");
    const ms = Number(delay);
    const wait = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const id = this.#nextId;
    this.#nextId += 1;
    const timer: VirtualTimer = {
      id,
      due: this.#now + wait,
      callback: callback as TimerCallback,
      args,
      interval: repeat ? Math.max(1, wait) : undefined,
    };
    this.#timers.set(id, timer);
    const timers = this.#timers;
    const cancelled = this.#cancelled;
    const clock = this;
    const handle: VirtualTimerHandle = {
      ref: () => handle,
      unref: () => handle,
      hasRef: () => true,
      // As Node's `refresh()`: restarts the timer, and runs a timer that already fired again; a cleared timer stays cleared.
      refresh() {
        if (cancelled.has(id)) return handle;
        timer.due = clock.#now + wait;
        timers.set(id, timer);
        return handle;
      },
      [Symbol.toPrimitive]: () => id,
    };
    this.#handleIds.set(handle, id);
    return handle;
  }

  /** Cancels a virtual timer; false when `handle` is not one this clock made. */
  #cancel(handle: unknown): boolean {
    const id = typeof handle === "object" && handle !== null ? this.#handleIds.get(handle) : Number(handle);
    if (id === undefined || !(id >= FIRST_TIMER_ID && id < this.#nextId)) return false;
    this.#timers.delete(id);
    this.#cancelled.add(id);
    return true;
  }

  /** A `Date` whose `new Date()` and `Date.now()` read virtual time; every other use is the real `Date`. */
  #virtualDate(RealDate: DateConstructor): DateConstructor {
    const clock = this;
    function VirtualDate(this: unknown, ...args: unknown[]): unknown {
      if (new.target === undefined) return new RealDate(clock.#now).toString();
      if (args.length === 0) return new RealDate(clock.#now);
      return new (RealDate as unknown as new (...values: unknown[]) => Date)(...args);
    }
    VirtualDate.prototype = RealDate.prototype;
    VirtualDate.now = (): number => clock.#now;
    VirtualDate.parse = RealDate.parse.bind(RealDate);
    VirtualDate.UTC = RealDate.UTC.bind(RealDate);
    return VirtualDate as unknown as DateConstructor;
  }
}
