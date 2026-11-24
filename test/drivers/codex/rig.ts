// A small rig for the Codex driver's own tests: the real driver, a fake host
// that records every host call, and the fake Codex CLI, with helpers to read
// a session's events and the frames that crossed the wire.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFakeHost } from "../../../src/conformance/index.ts";
import type { FakeHost, FakeHostOptions } from "../../../src/conformance/index.ts";
import { codexDriver } from "../../../src/drivers/codex/index.ts";
import type { CodexDriverConfig } from "../../../src/drivers/codex/index.ts";
import type { AriEvent, Instance, OpenSessionInput, RuntimePolicy, Session, SpawnedProcess } from "../../../src/index.ts";
import { FakeCodexWorld } from "./fake-app-server.ts";
import type { CodexNativeTurn } from "./fake-app-server.ts";

export interface CodexTestRig {
  readonly world: FakeCodexWorld;
  readonly host: FakeHost<CodexDriverConfig>;
  readonly instance: Instance;
  readonly root: string;
  readonly cwd: string;
  readonly otherCwd: string;
  open(input?: OpenSessionInput): Promise<OpenedCodexSession>;
  nextTurn(): Promise<CodexNativeTurn>;
  /** The next turn Codex started on its own for an active goal. */
  nextAutonomousTurn(): Promise<CodexNativeTurn>;
  /** Requests the fake app-servers received, by method, oldest first. */
  requests(method: string): Array<{ [key: string]: unknown }>;
  cleanup(): Promise<void>;
}

export interface OpenedCodexSession {
  readonly session: Session;
  readonly events: AriEvent[];
  until<T>(find: () => T | undefined, what: string, timeoutMs?: number): Promise<T>;
  bodies<Type extends string>(type: Type): Array<Extract<AriEvent["body"], { type: Type }>>;
}

export function policy(cwd: string, mode: RuntimePolicy["mode"] = "approval_required"): RuntimePolicy {
  return { mode, interaction: "default", cwd };
}

async function until<T>(find: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export async function codexRig(
  options: {
    readonly ambientAuth?: "authenticated" | "unauthenticated" | "unknown" | "unavailable" | "api_key";
    readonly version?: string;
    readonly missingBinary?: boolean;
    readonly host?: Partial<FakeHostOptions<CodexDriverConfig>>;
    readonly environment?: { [name: string]: string };
    readonly config?: Partial<CodexDriverConfig>;
    /** Wraps each `codex app-server` process the driver spawns, for tests that change what crosses the pipe. */
    readonly wrapAppServer?: (process: SpawnedProcess) => SpawnedProcess;
  } = {},
): Promise<CodexTestRig> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-codex-rig-")));
  const cwd = path.join(root, "project");
  const otherCwd = path.join(root, "other");
  const paths = { stateDir: path.join(root, "state"), cacheDir: path.join(root, "cache"), tmpDir: path.join(root, "tmp") };
  for (const directory of [cwd, otherCwd, ...Object.values(paths)]) fs.mkdirSync(directory, { recursive: true });
  const world = new FakeCodexWorld({ ambientAuth: options.ambientAuth ?? "authenticated", realpath: (value) => fs.realpathSync(value), ...(options.version === undefined ? {} : { version: options.version }) });
  const config: CodexDriverConfig = { ...codexDriver.defaultConfig(), ...options.config };
  const host = createFakeHost<CodexDriverConfig>({
    config,
    paths,
    envScrubPrefixes: codexDriver.cliManifest?.envScrubPrefixes ?? [],
    ambientEnvironment: { HOME: path.join(root, "home"), PATH: "/usr/bin" },
    spawn: async (request) => {
      const process = world.spawn(request);
      return request.args?.[0] === "app-server" && options.wrapAppServer !== undefined ? options.wrapAppServer(process) : process;
    },
    resolveExecutable: async (name) => (options.missingBinary !== true && path.basename(name) === "codex" ? "/usr/local/bin/codex" : null),
    ...options.host,
  });
  const instance = await codexDriver.create(host, { instanceId: "codex-test", config, environment: options.environment ?? {} });
  const sessions: Session[] = [];
  return {
    world,
    host,
    instance,
    root,
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
        until,
        bodies: <Type extends string>(type: Type) => events.map((event) => event.body).filter((body): body is Extract<AriEvent["body"], { type: Type }> => body.type === type),
      };
    },
    async nextTurn() {
      const next = await Promise.race([world.turnQueue.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for a native turn")), 5000))]);
      if (next.done === true) throw new Error("the fake was disposed");
      return next.value;
    },
    async nextAutonomousTurn() {
      const next = await Promise.race([world.autonomousTurns.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for a turn Codex starts itself")), 5000))]);
      if (next.done === true) throw new Error("the fake was disposed");
      return next.value;
    },
    requests: (method) => world.requests.filter((request) => request.method === method).map((request) => request.params as { [key: string]: unknown }),
    async cleanup() {
      for (const session of sessions) await session.close().catch(() => undefined);
      await instance.dispose();
      world.dispose();
      fs.rmSync(root, { recursive: true, force: true });
      // Every frame either side sent must validate against the vendored Codex schema.
      if (world.validator.problems.length > 0) {
        throw new Error(`frames the vendored Codex schema rejects: ${world.validator.problems.map((problem) => `${problem.direction} ${problem.message}`).join("; ")}`);
      }
      if (world.servers.length > 0 && world.validator.checked === 0) throw new Error("an app-server ran but the fake checked no frame");
    },
  };
}
