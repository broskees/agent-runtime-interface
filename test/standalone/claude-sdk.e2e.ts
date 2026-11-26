// The `claude` driver through the standalone `ari-driver`, which cannot
// import a package by name. With a PATH that holds no `node` and no `bun`, and
// an environment of nothing but a temp HOME:
//   - `sdkDirectory` naming a fake SDK install makes `instance/status` report
//     the fixture's version, and a turn completes;
//   - `maintenance.install` from a local npm registry installs the fake SDK
//     with this platform's fake native package in its `node_modules` into the
//     instance's cache directory, and afterwards status reports it and a turn
//     completes, the SDK finding its native binary by itself;
//   - a managed install whose `sdk.mjs` is missing, or whose native binary is
//     truncated or lost its execute permission, is reported in a new driver
//     process naming `maintenance.install` and `sdkDirectory`, and
//     `maintenance.install` repairs it;
//   - with no SDK at all, status reports `driver_unavailable` naming
//     `maintenance.install` and `sdkDirectory`, and no `npm install`, which
//     the binary could not use;
//   - the binary holds none of the SDK's code.
// The first two run again through `ari-driver` under Node (the package's bin,
// dist/wire/cli.js). The fake SDK and registry are test/drivers/claude/
// sdk-fixture.ts; nothing reaches the network or starts a real Claude Code.
//
// The gate runs it after the binary build (`pnpm run test:binary`).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CLAUDE_SDK_CODE_MARKER } from "../../scripts/check-package.ts";
import type { AriEvent } from "../../src/index.ts";
import { CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION } from "../../src/meta/claude.ts";
import { createCoordination, createNodeHostServices } from "../../src/node/index.ts";
import { startAriDriver } from "../../src/wire/index.ts";
import { fixtureRegistryEntries, hostNativePackage, startFixtureRegistry, writeFixtureSdkDirectory } from "../drivers/claude/sdk-fixture.ts";
import { NODE_EXECUTABLE } from "../helpers/runtime.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARI_DRIVER = path.join(ROOT, "build", "standalone", "linux-x64", "ari-driver");
const NODE_ARI_DRIVER = path.join(ROOT, "dist", "wire", "cli.js");

/**
 * A string unique to the SDK's sdk.mjs: the environment variable it sets for
 * every Claude Code process it starts. ARI's own code never names it.
 */
const SDK_MARKER = "CLAUDE_CODE_SDK_READS_SESSION_STATE";

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

interface Runtime {
  readonly name: string;
  readonly command: readonly string[];
  readonly built: string;
}

const STANDALONE: Runtime = { name: "the standalone ari-driver", command: [ARI_DRIVER], built: "pnpm run build:binary" };
const UNDER_NODE: Runtime = { name: "ari-driver under Node", command: [NODE_EXECUTABLE, NODE_ARI_DRIVER], built: "pnpm run build" };

function requireBuilt(runtime: Runtime): void {
  const file = runtime === STANDALONE ? ARI_DRIVER : NODE_ARI_DRIVER;
  assert.ok(fs.existsSync(file), `${path.relative(ROOT, file)} is missing; run \`${runtime.built}\` first`);
}

/** A temp root with an empty `bin/` (the whole PATH), `home/`, `project/` and the host's directory. */
function nodeFreeRoot(): { root: string; project: string; env: { [name: string]: string } } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-standalone-claude-")));
  temporary.push(root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  for (const directory of [bin, home, project]) fs.mkdirSync(directory);
  const env = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  };
  assert.deepEqual(fs.readdirSync(bin), [], "the PATH holds nothing, so no node and no bun");
  return { root, project, env };
}

/** Starts `runtime` serving the claude driver, and one instance with `config` on Node host services under `root`. */
async function claudeOver(runtime: Runtime, where: ReturnType<typeof nodeFreeRoot>, config: { [field: string]: unknown }) {
  const host = await createNodeHostServices<typeof config>({
    hostRoot: path.join(where.root, "host"),
    instanceId: "claude-standalone",
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
  const connection = await startAriDriver({ driver: "claude", command: [...runtime.command], env: where.env, cwd: where.project, envPolicy: { stripAmbient: [] } });
  assert.equal(connection.driver.kind, "claude");
  const instance = await connection.driver.create(host, { instanceId: "claude-standalone", config, environment: {} });
  return {
    host,
    instance,
    async close() {
      await instance.dispose();
      await connection.close();
      await host.dispose();
    },
  };
}

/** Runs one turn over the wire and resolves with its terminal status and every event's JSON. */
async function oneTurn(instance: Awaited<ReturnType<typeof claudeOver>>["instance"], cwd: string): Promise<{ status: string | undefined; events: string }> {
  const session = await instance.openSession({});
  const events: AriEvent[] = [];
  void (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  try {
    const thread = await session.createThread({ cwd, policy: { mode: "approval_required", interaction: "default", cwd } });
    const started = await session.startTurn({ threadId: thread.id, clientTurnKey: "standalone-claude-1", intent: "start", content: [{ type: "text", text: "Say hello" }] });
    assert.equal(started.status, "accepted");
    const deadline = Date.now() + 15_000;
    for (;;) {
      const terminal = events.find((event) => event.body.type === "turn.terminal");
      if (terminal !== undefined) return { status: terminal.body.type === "turn.terminal" ? terminal.body.status : undefined, events: JSON.stringify(events) };
      if (Date.now() > deadline) throw new Error(`no turn.terminal within 15 s: ${JSON.stringify(events)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await session.close();
  }
}

for (const runtime of [STANDALONE, UNDER_NODE]) {
  test(`${runtime.name} loads the Claude Agent SDK from sdkDirectory: status reports the fixture's version and a turn completes`, async () => {
    requireBuilt(runtime);
    const where = nodeFreeRoot();
    const sdkDirectory = path.join(where.root, "claude-sdk");
    writeFixtureSdkDirectory(sdkDirectory, "0.3.330+fixture", "fixture native claude beside the SDK");
    const claude = await claudeOver(runtime, where, { sdkDirectory });
    try {
      const status = await claude.instance.status();
      assert.equal(status.installed, true, JSON.stringify(status));
      assert.equal(status.version, "0.3.330+fixture");
      const turn = await oneTurn(claude.instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes("fixture SDK reply 1, from the native binary that answered: fixture native claude beside the SDK"), turn.events);
    } finally {
      await claude.close();
    }
  });

  test(`${runtime.name} installs the Claude Agent SDK with maintenance.install from an npm registry, then status reports it and a turn completes`, async () => {
    requireBuilt(runtime);
    const where = nodeFreeRoot();
    const { sdk, native } = fixtureRegistryEntries(where.root, CLAUDE_SDK_VERSION, "fixture native claude from the registry");
    const registry = await startFixtureRegistry([sdk, native]);
    const claude = await claudeOver(runtime, where, { sdkRegistry: registry.url });
    try {
      if (runtime === STANDALONE) {
        const before = await claude.instance.status();
        assert.equal(before.installed, false, JSON.stringify(before));
      }
      assert.equal(typeof claude.instance.maintenance?.install, "function", "the driver offers maintenance.install over the wire");
      assert.equal(typeof claude.instance.maintenance?.update, "function", "the driver offers maintenance.update over the wire");
      await claude.instance.maintenance!.install!();
      assert.deepEqual(registry.requests, [`/${native.pkg}/${CLAUDE_SDK_VERSION}`, "/-/tarballs/1.tgz", `/${CLAUDE_SDK_PACKAGE}/${CLAUDE_SDK_VERSION}`, "/-/tarballs/0.tgz"]);
      const installed = path.join(claude.host.paths.cacheDir, "adapters", ...CLAUDE_SDK_PACKAGE.split("/"), CLAUDE_SDK_VERSION);
      assert.ok(fs.existsSync(path.join(installed, "sdk.mjs")));
      assert.ok(fs.existsSync(path.join(installed, "node_modules", ...native.pkg.split("/"), hostNativePackage().binary)), "the native package is in the SDK's node_modules");
      assert.deepEqual(fs.readdirSync(path.join(claude.host.paths.cacheDir, "adapters", "@anthropic-ai")), ["claude-agent-sdk"]);
      const status = await claude.instance.status();
      assert.equal(status.installed, true, JSON.stringify(status));
      assert.equal(status.version, CLAUDE_SDK_VERSION);
      const turn = await oneTurn(claude.instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes("from the native binary that answered: fixture native claude from the registry (found by the SDK itself)"), turn.events);
    } finally {
      await claude.close();
      await registry.close();
    }
  });
}

const DAMAGES: Array<{ name: string; damage: (installed: string, binary: string) => void; detail: RegExp }> = [
  { name: "its sdk.mjs is missing", damage: (installed) => fs.rmSync(path.join(installed, "sdk.mjs")), detail: /: sdk\.mjs is missing\./ },
  { name: "its native binary is truncated", damage: (_installed, binary) => fs.truncateSync(binary, 10), detail: /claude(\.exe)? has 10 bytes, not the \d+ it was installed with\./ },
  { name: "its native binary lost its execute permission", damage: (_installed, binary) => fs.chmodSync(binary, 0o644), detail: /claude(\.exe)? is not executable: its mode is 0644, and it was installed with 0755\./ },
];

for (const { name, damage, detail } of DAMAGES) {
  test(`the standalone ari-driver reports a managed install whose ${name.replace(/^its /, "")}, naming maintenance.install and sdkDirectory, and maintenance.install repairs it`, async () => {
    requireBuilt(STANDALONE);
    const where = nodeFreeRoot();
    const { sdk, native } = fixtureRegistryEntries(where.root, CLAUDE_SDK_VERSION, "fixture native claude from the registry");
    const registry = await startFixtureRegistry([sdk, native]);
    const config = { sdkRegistry: registry.url };
    const installing = await claudeOver(STANDALONE, where, config);
    const installed = path.join(installing.host.paths.cacheDir, "adapters", ...CLAUDE_SDK_PACKAGE.split("/"), CLAUDE_SDK_VERSION);
    const binary = path.join(installed, "node_modules", ...native.pkg.split("/"), hostNativePackage().binary);
    try {
      await installing.instance.maintenance!.install!();
    } finally {
      await installing.close();
    }
    damage(installed, binary);
    // A new ari-driver process, so nothing it loaded before the damage is reused.
    const claude = await claudeOver(STANDALONE, where, config);
    try {
      const status = await claude.instance.status();
      assert.equal(status.state, "unavailable", JSON.stringify(status));
      assert.equal(status.error?.code, "driver_unavailable");
      const message = status.error?.message ?? "";
      assert.match(message, detail);
      assert.match(message, /Run maintenance\.install on this instance to repair it, or set sdkDirectory in the driver config/);
      const before = registry.requests.length;
      await claude.instance.maintenance!.install!();
      assert.deepEqual(registry.requests.slice(before).filter((request) => request.startsWith("/-/tarballs/")), ["/-/tarballs/1.tgz", "/-/tarballs/0.tgz"], "the repair downloads both again");
      assert.equal(fs.statSync(binary).mode & 0o777, 0o755, "the repaired native binary is executable");
      const repaired = await claude.instance.status();
      assert.equal(repaired.installed, true, JSON.stringify(repaired));
      assert.equal(repaired.version, CLAUDE_SDK_VERSION);
      const turn = await oneTurn(claude.instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes("answered: fixture native claude from the registry (found by the SDK itself)"), turn.events);
    } finally {
      await claude.close();
      await registry.close();
    }
  });
}

test("with no SDK, the standalone ari-driver reports driver_unavailable naming maintenance.install and sdkDirectory, and no npm install it could not use", async () => {
  requireBuilt(STANDALONE);
  const where = nodeFreeRoot();
  // An SDK installed by npm in the driver's working directory does not help the binary, which is why the message never suggests it.
  writeFixtureSdkDirectory(where.project, CLAUDE_SDK_VERSION, "fixture native claude in the working directory");
  const claude = await claudeOver(STANDALONE, where, {});
  try {
    const status = await claude.instance.status();
    assert.equal(status.state, "unavailable");
    assert.equal(status.installed, false);
    assert.equal(status.error?.code, "driver_unavailable");
    const message = status.error?.message ?? "";
    assert.match(message, /maintenance\.install/);
    assert.match(message, /sdkDirectory/);
    assert.doesNotMatch(message, /npm install/);
    assert.equal((status.error as { package?: string } | undefined)?.package, CLAUDE_SDK_PACKAGE);
    await assert.rejects(claude.instance.openSession({}), (error: { callError?: { code: string; message: string } }) => {
      assert.equal(error.callError?.code, "driver_unavailable");
      assert.match(error.callError?.message ?? "", /maintenance\.install/);
      return true;
    });
  } finally {
    await claude.close();
  }
});

test("the standalone ari-driver holds none of the Claude Agent SDK's code", () => {
  requireBuilt(STANDALONE);
  assert.equal(SDK_MARKER, CLAUDE_SDK_CODE_MARKER, "the package check looks for the same string");
  const sdkModule = path.join(fs.realpathSync(path.join(ROOT, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/"))), "sdk.mjs");
  assert.ok(fs.readFileSync(sdkModule).includes(SDK_MARKER), `${SDK_MARKER} is in the pinned SDK's sdk.mjs`);
  const binary = fs.readFileSync(ARI_DRIVER);
  // The binary embeds ARI's driver sources as text: the claude driver's own message is there, the SDK's code is not.
  assert.ok(binary.includes("cannot load a package by name"), "the scan reads the bundled sources");
  assert.equal(binary.includes(SDK_MARKER), false, `${path.relative(ROOT, ARI_DRIVER)} contains ${SDK_MARKER}`);
});
