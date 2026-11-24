// A Pi instance and session wired to fake `pi` processes, for the driver's own
// tests outside the conformance kit. It reuses the conformance harness's
// spawn (a real child process per `pi`) and a fake host that records every
// host-service call.

import { createFakeHost } from "../../../src/conformance/index.ts";
import type { FakeHost, FakeHostOptions } from "../../../src/conformance/index.ts";
import { piDriver } from "../../../src/drivers/pi/index.ts";
import type { PiConfig } from "../../../src/drivers/pi/index.ts";
import type { AriEvent, Instance, Session, Thread, TurnTerminalBody } from "../../../src/index.ts";
import { piHarness } from "./harness.ts";
import type { PiHarness, PiNativeTurn } from "./harness.ts";

export interface PiTestRig {
  readonly harness: PiHarness;
  readonly host: FakeHost<PiConfig>;
  readonly instance: Instance;
  readonly cwd: string;
  readonly otherCwd: string;
  nextTurn(): Promise<PiNativeTurn>;
  inspect(thread: Thread): ReturnType<NonNullable<Awaited<ReturnType<PiHarness["setup"]>>["native"]["inspectSession"]>>;
  /** Opens a session and records its events. */
  open(input?: Parameters<Instance["openSession"]>[0]): Promise<{ session: Session; events: AriEvent[] }>;
  /** Waits until an event matches. */
  until<T>(events: readonly AriEvent[], find: (event: AriEvent) => T | undefined, what: string): Promise<T>;
  terminal(events: readonly AriEvent[], turnId: string): Promise<TurnTerminalBody>;
  close(): Promise<void>;
}

export interface PiTestRigOptions {
  readonly config?: Partial<PiConfig>;
  readonly host?: Partial<FakeHostOptions<PiConfig>>;
  readonly managedProfile?: boolean;
  readonly fakeVersion?: string;
}

export async function openPiTestRig(options: PiTestRigOptions = {}): Promise<PiTestRig> {
  const harness = piHarness(options.fakeVersion === undefined ? {} : { fakeVersion: options.fakeVersion });
  const workspace = await harness.workspace();
  const rig = await harness.setup({ scenario: "driver-test", workspace, ambientAuth: "authenticated" });
  const config: PiConfig = { ...(rig.config ?? piDriver.defaultConfig()), ...options.config };
  const hostOptions = await rig.hostOptions!("pi-test", { managedProfile: options.managedProfile ?? false });
  const host = createFakeHost<PiConfig>({ ...hostOptions, config, envScrubPrefixes: piDriver.cliManifest?.envScrubPrefixes ?? [], label: "pi-test", ...options.host });
  const instance = await piDriver.create(host, { instanceId: "pi-test", config, environment: {} });
  const sessions: Session[] = [];
  const until = async <T>(events: readonly AriEvent[], find: (event: AriEvent) => T | undefined, what: string): Promise<T> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      for (const event of events) {
        const found = find(event);
        if (found !== undefined) return found;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return {
    harness,
    host,
    instance,
    cwd: workspace.cwd,
    otherCwd: workspace.otherCwd!,
    nextTurn: async () => (await rig.native.nextTurn()) as PiNativeTurn,
    inspect: (thread) => rig.native.inspectSession!(thread),
    async open(input = {}) {
      const session = await instance.openSession(input);
      sessions.push(session);
      const events: AriEvent[] = [];
      void (async () => {
        for await (const event of session.events()) events.push(event);
      })();
      return { session, events };
    },
    until,
    terminal: (events, turnId) => until(events, (event) => (event.body.type === "turn.terminal" && event.body.turnId === turnId ? event.body : undefined), `turn.terminal of ${turnId}`),
    async close() {
      for (const session of sessions) await session.close().catch(() => undefined);
      await instance.dispose();
      await rig.dispose?.();
      harness.cleanup();
    },
  };
}

/** A policy for `cwd` in a mode. */
export function policy(cwd: string, mode: "approval_required" | "full_access" | "read_only" | "auto_accept_edits" = "approval_required") {
  return { mode, interaction: "default" as const, cwd };
}
