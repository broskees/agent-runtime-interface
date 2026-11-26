// The standalone `ari-driver` runs without Node. `pnpm run build:binary`
// compiles it, and the fake Pi and ACP agents, into single executables under
// build/standalone/linux-x64/; this test runs them with a PATH that holds no
// `node` and no `bun`, and an environment that holds nothing else but a temp
// HOME. Over ari/wire the `pi` driver finds the fake `pi` on that PATH, the
// `acp` driver runs the fake ACP agent by its path (over ACP v1 and v2), and
// each completes a turn whose approval the host answers through `respond`.
//
// The binary also keeps the promise that agents end when `ari-driver` dies:
// serving the agent-group fixture driver (loaded from disk by module path),
// it is SIGKILLed, or gets SIGHUP, while two agents run, and within 5 s of the
// signal every agent, grandchild, process group and guard must be gone. It is
// also SIGKILLed while an agent's launcher is stopped between its spawn and
// its guard (the driver stops it the moment the spawn returns), and that
// agent's group must be gone within 5 s too (test/wire/driver-death-scenario.ts,
// which test/wire/driver-death.test.ts runs under Node).
//
// The gate runs it after the binary build (`pnpm run test:binary`); it is not
// matched by `pnpm run test`, which runs before the binary exists.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { firstPartyDrivers } from "../../scripts/build-binary.ts";
import type { AriEvent, Request } from "../../src/index.ts";
import { createCoordination, createNodeHostServices } from "../../src/node/index.ts";
import { startAriDriver } from "../../src/wire/index.ts";
import { assertEndedEverything, runDeathInStartupWindow, runDriverDeath } from "../wire/driver-death-scenario.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUILD = path.join(ROOT, "build", "standalone", "linux-x64");
const ARI_DRIVER = path.join(BUILD, "ari-driver");
const FAKE_PI = path.join(BUILD, "fakes", "pi");
const FAKE_ACP_AGENT = path.join(BUILD, "fakes", "standalone-acp-agent");

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

function requireBinaries(): void {
  for (const file of [ARI_DRIVER, FAKE_PI, FAKE_ACP_AGENT]) {
    assert.ok(fs.existsSync(file), `${path.relative(ROOT, file)} is missing; run \`pnpm run build:binary\` first`);
  }
}

/** The names of every executable on `searchPath` called `node`, `nodejs` or `bun`. */
function javascriptRuntimesOn(searchPath: string): string[] {
  return searchPath
    .split(path.delimiter)
    .flatMap((directory) => ["node", "nodejs", "bun"].map((name) => path.join(directory, name)))
    .filter((file) => fs.existsSync(file));
}

/** A temp root with `bin/` (only `pi`, the compiled fake), `home/`, `project/` and the host's directory. */
function nodeFreeRoot(): { root: string; bin: string; home: string; project: string; env: { [name: string]: string } } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-standalone-")));
  temporary.push(root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  for (const directory of [bin, home, project]) fs.mkdirSync(directory);
  fs.symlinkSync(FAKE_PI, path.join(bin, "pi"));
  const env = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  };
  assert.deepEqual(javascriptRuntimesOn(env.PATH), [], "the PATH must hold no node or bun");
  return { root, bin, home, project, env };
}

async function until<T>(check: () => T | undefined, description: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Run {
  readonly driver: "pi" | "acp";
  readonly config: (root: ReturnType<typeof nodeFreeRoot>) => { [field: string]: unknown };
  readonly optionId: string;
  readonly expectedVersion: string;
}

const RUNS: Array<{ name: string; run: Run }> = [
  {
    name: "pi, with the fake pi found on PATH",
    run: { driver: "pi", config: () => ({ binary: "pi", provider: "fake", model: "fake/fake-small" }), optionId: "allow-once", expectedVersion: "1.6.0" },
  },
  ...[1, 2].map((maxProtocolVersion) => ({
    name: `acp over ACP v${maxProtocolVersion}, with the fake ACP agent by path`,
    run: {
      driver: "acp" as const,
      config: () => ({ command: FAKE_ACP_AGENT, args: [], env: {}, versionArgs: ["--version"], maxProtocolVersion, forkAcrossDirectories: false, configDependencies: {} }),
      optionId: "allow",
      expectedVersion: "1.0.0",
    },
  })),
];

test("the standalone ari-driver is one native executable that holds every first-party driver", () => {
  requireBinaries();
  for (const file of [ARI_DRIVER, FAKE_PI, FAKE_ACP_AGENT]) {
    const header = Buffer.alloc(4);
    const descriptor = fs.openSync(file, "r");
    fs.readSync(descriptor, header, 0, 4, 0);
    fs.closeSync(descriptor);
    assert.deepEqual([...header], [0x7f, 0x45, 0x4c, 0x46], `${path.relative(ROOT, file)} is an ELF executable, not a script`);
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ari-standalone-empty-path-"));
  temporary.push(empty);
  const version = spawnSync(ARI_DRIVER, ["--version"], { env: { PATH: empty }, encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^ari-driver \(ARI contract \d+\.\d+\.\d+\)\n$/);
  const unknown = spawnSync(ARI_DRIVER, ["no-such-driver"], { env: { PATH: empty }, encoding: "utf8", input: "" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /No first-party driver named "no-such-driver" in this ari-driver\. It holds: /);
  const held = /It holds: (.*)\n/.exec(unknown.stderr)?.[1]?.split(", ") ?? [];
  assert.deepEqual(held, firstPartyDrivers(ROOT));
  assert.ok(held.includes("pi") && held.includes("acp"));
});

for (const { name, run } of RUNS) {
  test(`the standalone ari-driver completes a turn without Node: ${name}`, async () => {
    requireBinaries();
    const where = nodeFreeRoot();
    const config = run.config(where);
    const host = await createNodeHostServices<typeof config>({
      hostRoot: path.join(where.root, "host"),
      instanceId: `${run.driver}-standalone`,
      config: { get: async () => ({ config }) },
      attachments: { resolve: async () => null },
      hostTools: {
        mcpServerFor: async () => {
          throw new Error("this host serves no tools");
        },
      },
      callbacks: { register: async (flowId) => ({ url: `http://127.0.0.1:9/${flowId}` }) },
      coordination: createCoordination(),
      writeDiagnostic: () => undefined,
    });
    const connection = await startAriDriver({ driver: run.driver, command: [ARI_DRIVER], env: where.env, cwd: where.project, envPolicy: { stripAmbient: [] } });
    try {
      assert.equal(connection.driver.kind, run.driver);
      const instance = await connection.driver.create(host, { instanceId: `${run.driver}-standalone`, config, environment: {} });
      const probe = await instance.probe();
      assert.equal(probe.installed, true, JSON.stringify(probe));
      assert.equal(probe.version, run.expectedVersion);
      const session = await instance.openSession({});
      const events: AriEvent[] = [];
      void (async () => {
        for await (const event of session.events()) events.push(event);
      })();
      const thread = await session.createThread({ cwd: where.project, policy: { mode: "approval_required", interaction: "default", cwd: where.project } });
      const started = await session.startTurn({ threadId: thread.id, clientTurnKey: "standalone-1", intent: "start", content: [{ type: "text", text: "Say hello" }] });
      assert.equal(started.status, "accepted");
      const request = await until(() => {
        for (const event of events) if (event.body.type === "request.upsert" && event.body.request.status === "pending") return event.body.request as Request;
        return undefined;
      }, "the approval request");
      assert.ok(request.options?.some((option) => option.optionId === run.optionId), JSON.stringify(request.options));
      await session.respond({ requestId: request.id, responseKey: "standalone-answer", optionId: run.optionId });
      const terminal = await until(() => events.find((event) => event.body.type === "turn.terminal"), "turn.terminal");
      assert.equal(terminal.body.type === "turn.terminal" ? terminal.body.status : undefined, "completed");
      assert.ok(
        events.some((event) => event.body.type === "request.upsert" && event.body.request.id === request.id && event.body.request.status === "resolved"),
        "the request was resolved by the answer",
      );
      await session.close();
      await instance.dispose();
    } finally {
      await connection.close();
      await host.dispose();
    }
    // The fake pi keeps its sessions under the driver's state directory, never in the user's ~/.pi.
    assert.equal(fs.existsSync(path.join(where.home, ".pi")), false);
  });
}

for (const { death, how } of [
  { death: "SIGKILL", how: "is SIGKILLed" },
  { death: "SIGHUP", how: "gets SIGHUP, disposes and exits 0" },
] as const) {
  test(`when the standalone ari-driver ${how}, without Node, every agent, grandchild, process group and guard is gone within 5 s`, async () => {
    requireBinaries();
    const where = nodeFreeRoot();
    const outcome = await runDriverDeath({ command: [ARI_DRIVER], death, env: where.env, cwd: where.project });
    assertEndedEverything(outcome, death);
  });
}

test("when the standalone ari-driver is SIGKILLed after an agent's spawn returned but before its guard started, without Node, the agent's group is gone within 5 s", async () => {
  requireBinaries();
  const where = nodeFreeRoot();
  const outcome = await runDeathInStartupWindow({ command: [ARI_DRIVER], pause: "driver", env: where.env, cwd: where.project });
  assert.deepEqual(outcome.survivors, [], "every agent group, the stopped one included, ended within 5 s of the SIGKILL");
  assert.equal(outcome.exit.signal, "SIGKILL");
});
