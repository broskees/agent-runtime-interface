// A small rig for the Muse driver's own tests: the real driver with the real
// SDK `Connection`, a fake host that records every host call, and the fake
// `muse` CLI, with helpers to read a session's events and the requests the
// fake hosts received.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFakeHost } from "../../../src/conformance/index.ts";
import type { FakeHost, FakeHostOptions } from "../../../src/conformance/index.ts";
import { createMuseDriver } from "../../../src/drivers/muse/index.ts";
import type { MuseDriverConfig, MuseDriverOptions } from "../../../src/drivers/muse/index.ts";
import type { AriEvent, Instance, OpenSessionInput, RuntimePolicy, Session } from "../../../src/index.ts";
import { FakeMuseWorld } from "./fake-muse.ts";
import type { FakeMuseOptions, FakeMuseTurn } from "./fake-muse.ts";
import { seededMinter } from "./harness.ts";

export interface MuseTestRig {
  readonly world: FakeMuseWorld;
  readonly host: FakeHost<MuseDriverConfig>;
  readonly instance: Instance;
  readonly root: string;
  readonly home: string;
  readonly cwd: string;
  readonly otherCwd: string;
  open(input?: OpenSessionInput): Promise<OpenedMuseSession>;
  nextTurn(): Promise<FakeMuseTurn>;
  /** Requests the fake hosts received for `method`, oldest first. */
  requests(method: string): Array<{ [key: string]: unknown }>;
  cleanup(): Promise<void>;
}

export interface OpenedMuseSession {
  readonly session: Session;
  readonly events: AriEvent[];
  bodies<Type extends string>(type: Type): Array<Extract<AriEvent["body"], { type: Type }>>;
}

export function policy(cwd: string, mode: RuntimePolicy["mode"] = "approval_required"): RuntimePolicy {
  return { mode, interaction: "default", cwd };
}

export async function until<T>(find: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export async function museRig(
  options: {
    readonly fake?: FakeMuseOptions;
    readonly missingBinary?: boolean;
    readonly host?: Partial<FakeHostOptions<MuseDriverConfig>>;
    readonly environment?: { [name: string]: string };
    readonly config?: Partial<MuseDriverConfig>;
    readonly driver?: MuseDriverOptions;
  } = {},
): Promise<MuseTestRig> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-muse-rig-")));
  const cwd = path.join(root, "project");
  const otherCwd = path.join(root, "other");
  const home = path.join(root, "home");
  const paths = { stateDir: path.join(root, "state"), cacheDir: path.join(root, "cache"), tmpDir: path.join(root, "tmp") };
  for (const directory of [cwd, otherCwd, home, ...Object.values(paths)]) fs.mkdirSync(directory, { recursive: true });
  const world = new FakeMuseWorld(options.fake ?? {});
  const driver = createMuseDriver({ mintCommandId: seededMinter(), ...options.driver });
  const config: MuseDriverConfig = { ...driver.defaultConfig(), ...options.config };
  const host = createFakeHost<MuseDriverConfig>({
    config,
    paths,
    ambientEnvironment: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), PATH: "/usr/bin" },
    spawn: async (request) => world.spawn(request),
    resolveExecutable: async (name) => (options.missingBinary !== true && path.basename(name) === "muse" ? "/usr/local/bin/muse" : null),
    ...options.host,
  });
  const instance = await driver.create(host, { instanceId: "muse-test", config, environment: options.environment ?? {} });
  const sessions: Session[] = [];
  return {
    world,
    host,
    instance,
    root,
    home,
    cwd,
    otherCwd,
    async open(input = {}) {
      const session = await instance.openSession(input);
      sessions.push(session);
      const events: AriEvent[] = [];
      void (async () => {
        for await (const event of session.events()) events.push(event);
      })();
      return {
        session,
        events,
        bodies: <Type extends string>(type: Type) => events.map((event) => event.body).filter((body): body is Extract<AriEvent["body"], { type: Type }> => body.type === type),
      };
    },
    async nextTurn() {
      const next = await Promise.race([world.turnQueue.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for a native turn")), 5000))]);
      if (next.done === true) throw new Error("the fake was disposed");
      return next.value;
    },
    requests: (method) => world.received(method),
    async cleanup() {
      for (const session of sessions) await session.close().catch(() => undefined);
      await instance.dispose();
      world.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
