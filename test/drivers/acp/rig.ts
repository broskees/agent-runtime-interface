// A small rig for driver tests outside the conformance kit: one instance of an
// ACP driver on a fake host whose spawns start the SDK-based fake agent, with
// the session's events collected and the wire frames recorded.

import { setTimeout as sleep } from "node:timers/promises";
import { createFakeHost } from "../../../src/conformance/index.ts";
import type { FakeHost, FakeHostOptions, FakeSpawnRequest, HarnessRig, NativeTurn } from "../../../src/conformance/index.ts";
import type { AriEvent, OpenSessionInput, RuntimePolicy, SpawnedProcess } from "../../../src/index.ts";
import type { Instance, Session } from "../../../src/runtime.ts";
import { acpHarness } from "./harness.ts";
import type { AcpHarness, AcpHarnessOptions } from "./harness.ts";

export interface OpenedTestSession {
  readonly session: Session;
  readonly events: AriEvent[];
  /** Resolves with the first event that matches, waiting up to 5 seconds. */
  waitFor(predicate: (event: AriEvent) => boolean, what: string): Promise<AriEvent>;
}

export interface TestRig<Config> {
  readonly harness: AcpHarness<Config>;
  readonly rig: HarnessRig<Config>;
  readonly host: FakeHost<Config>;
  readonly instance: Instance;
  readonly cwd: string;
  readonly otherCwd: string;
  open(input?: OpenSessionInput): Promise<OpenedTestSession>;
  nextTurn(): Promise<NativeTurn>;
  policy(mode?: RuntimePolicy["mode"], cwd?: string): RuntimePolicy;
  cleanup(): Promise<void>;
}

export async function until<T>(read: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function collect(session: Session): OpenedTestSession {
  const events: AriEvent[] = [];
  void (async () => {
    for await (const event of session.events()) events.push(event);
  })().catch(() => undefined);
  return {
    session,
    events,
    waitFor: (predicate, what) => until(() => events.find(predicate), what),
  };
}

export async function openRig<Config>(
  options: AcpHarnessOptions<Config> & {
    readonly fakeHost?: Partial<FakeHostOptions<Config>>;
    readonly instanceId?: string;
    /** `CreateInstanceRequest.environment`; empty when left out. */
    readonly environment?: { readonly [name: string]: string };
    /** Wraps each process the harness spawns for the driver, for tests that change how it behaves. */
    readonly wrapProcess?: (process: SpawnedProcess) => SpawnedProcess;
  },
): Promise<TestRig<Config>> {
  const harness = acpHarness(options);
  const workspace = await harness.workspace();
  const rig = await harness.setup({ scenario: "driver-test", workspace, ambientAuth: "authenticated" });
  const instanceId = options.instanceId ?? "driver-test-instance";
  const hostOptions = (await rig.hostOptions?.(instanceId, { managedProfile: false })) ?? {};
  const host = createFakeHost<Config>({
    label: instanceId,
    config: options.config,
    ...hostOptions,
    ...(options.wrapProcess === undefined || hostOptions.spawn === undefined
      ? {}
      : { spawn: async (request: FakeSpawnRequest) => options.wrapProcess!(await hostOptions.spawn!(request)) }),
    ...(options.fakeHost ?? {}),
  });
  const instance = await options.driver.create(host, { instanceId, config: options.config, environment: { ...(options.environment ?? {}) } });
  const sessions: Session[] = [];
  return {
    harness,
    rig,
    host,
    instance,
    cwd: workspace.cwd,
    otherCwd: workspace.otherCwd ?? workspace.cwd,
    async open(input = {}) {
      const session = await instance.openSession(input);
      sessions.push(session);
      return collect(session);
    },
    nextTurn: () => rig.native.nextTurn(),
    policy: (mode = "approval_required", cwd = workspace.cwd) => ({ mode, interaction: "default", cwd }),
    async cleanup() {
      for (const session of sessions) await session.close().catch(() => undefined);
      await instance.dispose();
      await rig.dispose?.();
      await host.dispose();
      harness.cleanup();
    },
  };
}
