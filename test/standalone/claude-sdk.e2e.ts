// The `claude` driver through the standalone `ari-driver`, which cannot
// import a package by name. With a PATH that holds no `node` and no `bun`
// (only, where a test says so, a fake of the user's Claude Code), and an
// environment of nothing but a temp HOME:
//   - `sdkDirectory` naming a fake SDK install, with a decoy native Claude
//     Code package beside it: status reports the fixture's version, and a
//     turn runs the fake `claude` on PATH, never the decoy;
//   - `maintenance.install` from a local npm registry installs the fake SDK
//     alone (no native-package request, no native package in the cache);
//     then status reports it, a turn runs the fake `claude` on PATH, and with
//     `executablePath` set to a second fake, that one runs instead;
//   - a `claude` older than the minimum, or none at all, leaves the driver
//     `driver_unavailable` with the fix in the message, `openSession` rejects
//     the same way, and no Claude Code session starts, for a managed install
//     and for sdkDirectory;
//   - a managed install whose `sdk.mjs` is missing, or that holds a native
//     Claude Code package an earlier ARI installed, is reported in a new
//     driver process naming `maintenance.install` and `sdkDirectory`, and
//     `maintenance.install` repairs it with the SDK alone;
//   - with no SDK at all, status reports `driver_unavailable` naming
//     `maintenance.install` and `sdkDirectory`, and no `npm install`, which
//     the binary could not use;
//   - the binary holds none of the SDK's code.
// The first two run again through `ari-driver` under Node (the package's bin,
// dist/wire/cli.js). The fake SDK, the fake Claude Code and the registry are
// test/drivers/claude/sdk-fixture.ts; nothing reaches the network or starts a
// real Claude Code.
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
import {
  MINIMUM_VERSION_LINE,
  addNativePackageAsAnEarlierAri,
  fakeClaudeInvocations,
  fakeClaudeSessions,
  fixtureSdkEntry,
  startFixtureRegistry,
  writeFakeClaude,
  writeFixtureSdkDirectory,
} from "../drivers/claude/sdk-fixture.ts";
import { NODE_EXECUTABLE } from "../helpers/runtime.ts";
import { killRecorded, recordAgents, survivorsAt } from "../helpers/process-groups.ts";
import type { RecordedAgent } from "../helpers/process-groups.ts";

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

for (const { runtime, delegateProcesses } of [
  { runtime: UNDER_NODE, delegateProcesses: false },
  { runtime: STANDALONE, delegateProcesses: false },
  { runtime: UNDER_NODE, delegateProcesses: true },
]) {
  test(`the pinned SDK's Claude Code, grandchild, guard and group end within 5 s of SIGKILLing ${runtime.name}${delegateProcesses ? " with host-delegated processes" : ""}`, async () => {
    requireBuilt(runtime);
    const where = nodeFreeRoot();
    const sdkDirectory = path.join(where.root, "sdk");
    const sdkPackage = path.join(sdkDirectory, "node_modules", CLAUDE_SDK_PACKAGE);
    fs.mkdirSync(sdkPackage, { recursive: true });
    for (const file of ["package.json", "sdk.mjs"]) fs.copyFileSync(path.join(ROOT, "node_modules", CLAUDE_SDK_PACKAGE, file), path.join(sdkPackage, file));
    const marker = path.join(where.project, "turn-started");
    // No JS runtime, even by absolute path. Stay alive after stdin EOF: only
    // the process guard should end the fake and the child it started.
    fs.writeFileSync(path.join(where.bin, "claude"), `#!/bin/sh
case "$1" in
  --version) echo '2.1.330 (Claude Code)'; exit;;
  auth) echo '{"loggedIn":false}'; exit;;
esac
while IFS= read -r line; do
  case "$line" in
    *'"type":"control_request"'*)
      id=\${line#*'"request_id":"'}
      id=\${id%%'"'*}
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[],"models":[],"account":{},"added":[],"removed":[],"errors":{}}}}\\n' "$id";;
    *'"type":"user"'*) break;;
  esac
done
/bin/sleep 120 &
printf '%s %s\\n' "$$" "$!" > turn-started
wait
`, { mode: 0o755 });
    const agents: RecordedAgent[] = [];
    const config = { sdkDirectory };
    const host = await createNodeHostServices<typeof config>({
      hostRoot: path.join(where.root, "host"),
      instanceId: "claude-death",
      config: { get: async () => ({ config }) },
      attachments: { resolve: async () => null },
      hostTools: { mcpServerFor: async () => { throw new Error("the fixture offers no tools"); } },
      callbacks: { register: async () => { throw new Error("the fixture offers no sign-in"); } },
      coordination: createCoordination(),
      writeDiagnostic: () => undefined,
      baseEnv: where.env,
    });
    const connection = await startAriDriver({ driver: "claude", command: [...runtime.command], env: where.env, cwd: where.project, envPolicy: { stripAmbient: [] }, delegateProcesses });
    const exited = new Promise((resolve) => connection.child.once("exit", (_code, signal) => resolve(signal)));
    let reported: { pid: number; grandchildPid: number } | undefined;
    try {
      const instance = await connection.driver.create(host, { instanceId: "claude-death", config, environment: where.env });
      const session = await instance.openSession({ handshakeTimeoutMs: 15_000 });
      const thread = await session.createThread({ cwd: where.project, policy: { mode: "approval_required", interaction: "default", cwd: where.project } });
      await session.startTurn({ threadId: thread.id, clientTurnKey: "fixture-death", intent: "start", content: [{ type: "text", text: "fixture" }] });
      const deadline = Date.now() + 15_000;
      while (reported === undefined) {
        const pids = fs.existsSync(marker) && /^(\d+) (\d+)\n$/.exec(fs.readFileSync(marker, "utf8"));
        if (pids) reported = { pid: Number(pids[1]), grandchildPid: Number(pids[2]) };
        else if (Date.now() >= deadline) throw new Error("fake Claude Code did not read its prompt");
        else await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Record the group assertion without stopping the death experiment on
      // a regression. The old SDK-local spawn shares this test's group.
      let guardError: unknown;
      try { recordAgents(agents, [reported]); } catch (error) { guardError = error; }
      const killedAt = Date.now();
      assert.equal(connection.child.kill("SIGKILL"), true);
      const survivors = await survivorsAt(agents, killedAt + 5_000);
      assert.equal(await exited, "SIGKILL");
      assert.deepEqual(survivors, [], `the SDK child must use a guarded group: ${String(guardError ?? "")}`);
      if (guardError !== undefined) throw guardError;
    } finally {
      connection.child.kill("SIGKILL");
      try {
        await connection.close();
      } finally {
        // killRecorded signals only the individual fixture pids if they share
        // an inherited group (the SDK-local-spawn regression case).
        killRecorded(agents);
        await host.dispose();
      }
    }
  });
}

function requireBuilt(runtime: Runtime): void {
  const file = runtime === STANDALONE ? ARI_DRIVER : NODE_ARI_DRIVER;
  assert.ok(fs.existsSync(file), `${path.relative(ROOT, file)} is missing; run \`${runtime.built}\` first`);
}

/** A temp root with an empty `bin/` (the whole PATH, of the driver and of the host), `home/`, `project/` and the host's directory. */
function nodeFreeRoot(): { root: string; bin: string; project: string; env: { [name: string]: string } } {
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
  return { root, bin, project, env };
}

/** The user's Claude Code on PATH: a fake that uses only shell built-ins, at the minimum version unless `versionLine` says otherwise. */
function userClaude(where: { bin: string }, versionLine = MINIMUM_VERSION_LINE): string {
  return writeFakeClaude(path.join(where.bin, "claude"), { versionLine, greeting: "the user's claude on PATH" });
}

/** What the fixture SDK's reply says when the driver ran the Claude Code at `file`, which greets with `greeting`. */
function ranOn(file: string, greeting = "the user's claude on PATH"): string {
  return `from the Claude Code at ${file} (named in pathToClaudeCodeExecutable), which answered: ${greeting}`;
}

/** Starts `runtime` serving the claude driver, and one instance with `config` on Node host services under `root` whose PATH is `bin`. */
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
    // The host finds the user's claude on this PATH, as a host without Node would.
    baseEnv: where.env,
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

/** Every directory and file under `directory`, relative to it. */
function everythingUnder(directory: string): string[] {
  return fs.existsSync(directory) ? fs.readdirSync(directory, { recursive: true, encoding: "utf8" }).sort() : [];
}

for (const runtime of [STANDALONE, UNDER_NODE]) {
  test(`${runtime.name} loads the Claude Agent SDK from sdkDirectory: status reports the fixture's version, and a turn runs the claude on PATH, never the native package beside the SDK`, async () => {
    requireBuilt(runtime);
    const where = nodeFreeRoot();
    const sdkDirectory = path.join(where.root, "claude-sdk");
    const decoy = writeFixtureSdkDirectory(sdkDirectory, "0.3.330+fixture", "the native package beside the SDK");
    const claude = userClaude(where);
    const instance = await claudeOver(runtime, where, { sdkDirectory });
    try {
      const status = await instance.instance.status();
      assert.equal(status.installed, true, JSON.stringify(status));
      assert.equal(status.version, "0.3.330+fixture");
      const turn = await oneTurn(instance.instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes(`fixture SDK reply 1, ${ranOn(claude)}`), turn.events);
      assert.deepEqual(fakeClaudeInvocations(decoy), [], "the native package beside the SDK never ran");
    } finally {
      await instance.close();
    }
  });

  test(`${runtime.name} installs the Claude Agent SDK alone with maintenance.install, then status reports it, a turn runs the claude on PATH, and with executablePath a second fake runs instead`, async () => {
    requireBuilt(runtime);
    const where = nodeFreeRoot();
    const registry = await startFixtureRegistry([fixtureSdkEntry(where.root, CLAUDE_SDK_VERSION)]);
    const claude = userClaude(where);
    const configured = writeFakeClaude(path.join(where.root, "elsewhere", "claude-nightly"), { versionLine: MINIMUM_VERSION_LINE, greeting: "the configured claude" });
    const installing = await claudeOver(runtime, where, { sdkRegistry: registry.url });
    const adapters = path.join(installing.host.paths.cacheDir, "adapters");
    try {
      if (runtime === STANDALONE) {
        const before = await installing.instance.status();
        assert.equal(before.installed, false, JSON.stringify(before));
      }
      assert.equal(typeof installing.instance.maintenance?.install, "function", "the driver offers maintenance.install over the wire");
      assert.equal(typeof installing.instance.maintenance?.update, "function", "the driver offers maintenance.update over the wire");
      await installing.instance.maintenance!.install!();
      assert.deepEqual(registry.requests, [`/${CLAUDE_SDK_PACKAGE}/${CLAUDE_SDK_VERSION}`, "/-/tarballs/0.tgz"], "the registry served the SDK and no native package");
      const installed = path.join(adapters, ...CLAUDE_SDK_PACKAGE.split("/"), CLAUDE_SDK_VERSION);
      assert.deepEqual(fs.readdirSync(installed).sort(), [".ari-install.json", "package.json", "sdk.mjs"]);
      assert.deepEqual(fs.readdirSync(path.join(adapters, "@anthropic-ai")), ["claude-agent-sdk"]);
      assert.deepEqual(
        everythingUnder(adapters).filter((entry) => entry.includes("node_modules") || /claude-agent-sdk-/.test(entry)),
        [],
        "the cache holds no native Claude Code package",
      );
      const status = await installing.instance.status();
      assert.equal(status.installed, true, JSON.stringify(status));
      assert.equal(status.version, CLAUDE_SDK_VERSION);
      const turn = await oneTurn(installing.instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes(ranOn(claude)), turn.events);
      assert.deepEqual(fakeClaudeInvocations(configured), []);
    } finally {
      await installing.close();
    }
    // The same cache, with executablePath naming a second fake that is not on PATH.
    const sessionsOnPath = fakeClaudeSessions(claude).length;
    const nightly = await claudeOver(runtime, where, { sdkRegistry: registry.url, executablePath: configured });
    try {
      const turn = await oneTurn(nightly.instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes(ranOn(configured, "the configured claude")), turn.events);
      assert.equal(fakeClaudeInvocations(configured)[0], "--version", "the driver checked the configured Claude Code's version before it ran it");
      assert.equal(fakeClaudeSessions(claude).length, sessionsOnPath, "the claude on PATH started no session");
      assert.equal(registry.requests.length, 2, "nothing more was downloaded");
    } finally {
      await nightly.close();
      await registry.close();
    }
  });
}

/** The standalone driver with its SDK from `source`: a managed install made with maintenance.install, or sdkDirectory with a decoy native package beside it. */
async function standaloneWithSdk(source: "a managed install" | "sdkDirectory", where: ReturnType<typeof nodeFreeRoot>) {
  if (source === "sdkDirectory") {
    const sdkDirectory = path.join(where.root, "claude-sdk");
    const decoy = writeFixtureSdkDirectory(sdkDirectory, CLAUDE_SDK_VERSION, "the native package beside the SDK");
    return { ...(await claudeOver(STANDALONE, where, { sdkDirectory })), decoy, closeRegistry: async () => undefined };
  }
  const registry = await startFixtureRegistry([fixtureSdkEntry(where.root, CLAUDE_SDK_VERSION)]);
  const claude = await claudeOver(STANDALONE, where, { sdkRegistry: registry.url });
  await claude.instance.maintenance!.install!();
  return { ...claude, decoy: undefined, closeRegistry: () => registry.close() };
}

for (const source of ["a managed install", "sdkDirectory"] as const) {
  test(`the standalone ari-driver with ${source} and a claude older than the minimum reports driver_unavailable naming its version, its path, the minimum and how to update, and starts no session`, async () => {
    requireBuilt(STANDALONE);
    const where = nodeFreeRoot();
    const claude = userClaude(where, "2.1.329 (Claude Code)");
    const standalone = await standaloneWithSdk(source, where);
    try {
      const status = await standalone.instance.status();
      assert.equal(status.state, "unavailable", JSON.stringify(status));
      assert.equal(status.error?.code, "driver_unavailable");
      const message = status.error?.message ?? "";
      assert.ok(message.startsWith(`Claude Code 2.1.329 at ${claude} is older than 2.1.330, the oldest version this driver runs`), message);
      assert.match(message, /Update Claude Code to 2\.1\.330 or newer \(run claude update,/);
      assert.match(message, /set executablePath in the driver config/);
      await assert.rejects(standalone.instance.openSession({}), (error: { callError?: { code: string; message: string } }) => {
        assert.deepEqual({ code: error.callError?.code, message: error.callError?.message }, { code: "driver_unavailable", message });
        return true;
      });
      assert.deepEqual(fakeClaudeSessions(claude), [], "no Claude Code session started");
      if (standalone.decoy !== undefined) assert.deepEqual(fakeClaudeInvocations(standalone.decoy), []);
    } finally {
      await standalone.close();
      await standalone.closeRegistry();
    }
  });

  test(`the standalone ari-driver with ${source} and no claude on PATH reports driver_unavailable saying Claude Code is not installed, how to install it, and executablePath`, async () => {
    requireBuilt(STANDALONE);
    const where = nodeFreeRoot();
    const standalone = await standaloneWithSdk(source, where);
    try {
      const status = await standalone.instance.status();
      assert.equal(status.state, "unavailable", JSON.stringify(status));
      assert.equal(status.error?.code, "driver_unavailable");
      const message = status.error?.message ?? "";
      assert.ok(message.startsWith("Claude Code is not installed: no claude executable was found on PATH."), message);
      assert.match(message, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
      assert.match(message, /set executablePath in the driver config/);
      await assert.rejects(standalone.instance.openSession({}), (error: { callError?: { code: string; message: string } }) => {
        assert.deepEqual({ code: error.callError?.code, message: error.callError?.message }, { code: "driver_unavailable", message });
        return true;
      });
      if (standalone.decoy !== undefined) assert.deepEqual(fakeClaudeInvocations(standalone.decoy), [], "the native package beside the SDK never ran");
    } finally {
      await standalone.close();
      await standalone.closeRegistry();
    }
  });
}

const DAMAGES: Array<{ name: string; damage: (installed: string) => void; detail: RegExp }> = [
  { name: "its sdk.mjs is missing", damage: (installed) => fs.rmSync(path.join(installed, "sdk.mjs")), detail: /: sdk\.mjs is missing\./ },
  {
    name: "it holds a native Claude Code package an earlier ARI installed",
    damage: addNativePackageAsAnEarlierAri,
    detail: /: it holds node_modules\/@anthropic-ai\/claude-agent-sdk-[a-z0-9-]+\/claude(\.exe)?, part of a native Claude Code package an earlier ARI installed/,
  },
];

for (const { name, damage, detail } of DAMAGES) {
  test(`the standalone ari-driver reports a managed install when ${name.replace(/^its /, "")}, naming maintenance.install and sdkDirectory, and maintenance.install repairs it with the SDK alone`, async () => {
    requireBuilt(STANDALONE);
    const where = nodeFreeRoot();
    const registry = await startFixtureRegistry([fixtureSdkEntry(where.root, CLAUDE_SDK_VERSION)]);
    const claude = userClaude(where);
    const config = { sdkRegistry: registry.url };
    const installing = await claudeOver(STANDALONE, where, config);
    const installed = path.join(installing.host.paths.cacheDir, "adapters", ...CLAUDE_SDK_PACKAGE.split("/"), CLAUDE_SDK_VERSION);
    try {
      await installing.instance.maintenance!.install!();
    } finally {
      await installing.close();
    }
    damage(installed);
    // A new ari-driver process, so nothing it loaded before the damage is reused.
    const repairing = await claudeOver(STANDALONE, where, config);
    try {
      const status = await repairing.instance.status();
      assert.equal(status.state, "unavailable", JSON.stringify(status));
      assert.equal(status.error?.code, "driver_unavailable");
      const message = status.error?.message ?? "";
      assert.match(message, detail);
      assert.match(message, /Run maintenance\.install on this instance to repair it, or set sdkDirectory in the driver config/);
      const before = registry.requests.length;
      await repairing.instance.maintenance!.install!();
      assert.deepEqual(registry.requests.slice(before), [`/${CLAUDE_SDK_PACKAGE}/${CLAUDE_SDK_VERSION}`, "/-/tarballs/0.tgz"], "the repair downloads the SDK again, and only the SDK");
      assert.deepEqual(fs.readdirSync(installed).sort(), [".ari-install.json", "package.json", "sdk.mjs"], "no node_modules is left");
      const repaired = await repairing.instance.status();
      assert.equal(repaired.installed, true, JSON.stringify(repaired));
      assert.equal(repaired.version, CLAUDE_SDK_VERSION);
      const turn = await oneTurn(repairing.instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes(ranOn(claude)), turn.events);
    } finally {
      await repairing.close();
      await registry.close();
    }
  });
}

test("with no SDK, the standalone ari-driver reports driver_unavailable naming maintenance.install and sdkDirectory, and no npm install it could not use", async () => {
  requireBuilt(STANDALONE);
  const where = nodeFreeRoot();
  userClaude(where);
  // An SDK installed by npm in the driver's working directory does not help the binary, which is why the message never suggests it.
  writeFixtureSdkDirectory(where.project, CLAUDE_SDK_VERSION, "a native package in the working directory");
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
