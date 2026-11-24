// An OpenCode instance and sessions wired to the fake OpenCode of one
// generation, for the driver's own tests outside the conformance kit. It
// reuses the conformance harness's spawn and a fake host that records every
// host-service call. `close()` fails the test when the fake recorded a frame
// that does not match the pinned OpenCode schemas.

import assert from "node:assert/strict";
import { createFakeHost } from "../../../src/conformance/index.ts";
import type { FakeHost, FakeHostOptions } from "../../../src/conformance/index.ts";
import { createOpencodeDriver } from "../../../src/drivers/opencode/index.ts";
import type { OpencodeConfig, OpencodeSdkLoaders } from "../../../src/drivers/opencode/index.ts";
import type { AriEvent, Driver, Instance, Session, Thread, TurnTerminalBody } from "../../../src/index.ts";
import type { FakeRun, FakeWorld, Generation } from "./fake-opencode.ts";
import { opencodeHarness, sessionState } from "./harness.ts";
import type { OpencodeHarness } from "./harness.ts";

export interface OpencodeTestRig {
  readonly harness: OpencodeHarness;
  readonly world: FakeWorld;
  readonly host: FakeHost<OpencodeConfig>;
  readonly driver: Driver<OpencodeConfig>;
  readonly instance: Instance;
  readonly config: OpencodeConfig;
  readonly cwd: string;
  readonly otherCwd: string;
  nextTurn(): Promise<FakeRun>;
  inspect(thread: Thread): ReturnType<typeof sessionState>;
  /** Opens a session and records its events. */
  open(input?: Parameters<Instance["openSession"]>[0]): Promise<{ session: Session; events: AriEvent[] }>;
  /** Waits until an event matches. */
  until<T>(events: readonly AriEvent[], find: (event: AriEvent) => T | undefined, what: string): Promise<T>;
  terminal(events: readonly AriEvent[], turnId: string): Promise<TurnTerminalBody>;
  /** Closes everything and asserts the fake saw only frames that match the pinned schemas. */
  close(): Promise<void>;
}

export interface OpencodeTestRigOptions {
  readonly generation: Generation;
  readonly external?: boolean;
  readonly config?: Partial<OpencodeConfig>;
  readonly host?: Partial<FakeHostOptions<OpencodeConfig>>;
  readonly loadSdk?: OpencodeSdkLoaders;
}

export async function openOpencodeTestRig(options: OpencodeTestRigOptions): Promise<OpencodeTestRig> {
  const harness = opencodeHarness({ generation: options.generation, ...(options.external === true ? { external: true } : {}), ...(options.loadSdk === undefined ? {} : { loadSdk: options.loadSdk }) });
  const workspace = await harness.workspace();
  const rig = await harness.setup({ scenario: "driver-test", workspace, ambientAuth: "authenticated" });
  const world = harness.worlds.at(-1)!;
  const config: OpencodeConfig = { ...(rig.config ?? rig.driver.defaultConfig()), ...options.config };
  const hostOptions = await rig.hostOptions!("opencode-test", { managedProfile: false });
  const host = createFakeHost<OpencodeConfig>({ ...hostOptions, config, envScrubPrefixes: rig.driver.cliManifest?.envScrubPrefixes ?? [], label: "opencode-test", ...options.host });
  const driver = options.loadSdk === undefined ? rig.driver : createOpencodeDriver({ loadSdk: options.loadSdk });
  const instance = await driver.create(host, { instanceId: "opencode-test", config, environment: {} });
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
    world,
    host,
    driver,
    instance,
    config,
    cwd: workspace.cwd,
    otherCwd: workspace.otherCwd!,
    nextTurn: async () => (await rig.native.nextTurn()) as FakeRun,
    inspect: (thread) => sessionState(world, thread.handle ?? thread.native.id ?? ""),
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
      assert.deepEqual([...new Set(world.violations)], [], "the fake OpenCode saw frames that do not match the pinned schemas");
    },
  };
}

/** A policy for `cwd` in a mode. */
export function policy(cwd: string, mode: "approval_required" | "full_access" | "read_only" | "auto_accept_edits" = "approval_required") {
  return { mode, interaction: "default" as const, cwd };
}
