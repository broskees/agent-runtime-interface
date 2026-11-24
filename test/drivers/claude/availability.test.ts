// A missing Claude runtime fails loudly only when used. Importing
// ari/drivers/claude or ari/meta/claude loads no vendor package and spawns
// nothing; with the SDK hidden, create() works, status() and probe() report
// the driver unavailable naming the package, and openSession rejects with
// driver_unavailable; with the SDK present (the pinned devDependency),
// status() reports its version; a version outside the tested range gets an
// advisory; a missing native Claude Code binary, bundled or at the configured
// path, is reported unavailable, not a crash. The child-process checks run the driver's real loader, with
// every child_process entry point trapped so nothing can start Claude Code.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { nativeBinaryCandidates } from "../../../src/drivers/claude/index.ts";
import type { ClaudeDriverConfig } from "../../../src/drivers/claude/index.ts";
import { CLAUDE_TESTED_VERSIONS } from "../../../src/meta/claude.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { openClaudeRig } from "./rig.ts";

/** Runs `body` in a fresh Node process that records every @anthropic-ai resolution and traps every child_process call. */
function inChild(body: string, options: { hideSdk: boolean }): { resolved: string[]; spawned: string[]; result: unknown } {
  const script = `
import { registerHooks, createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
const resolved = [];
const spawned = [];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@anthropic-ai/")) {
      resolved.push(specifier);
      if (${options.hideSdk ? "true" : "false"}) {
        const error = new Error("Cannot find package '" + specifier + "'");
        error.code = "ERR_MODULE_NOT_FOUND";
        throw error;
      }
    }
    return next(specifier, context);
  },
});
const childProcess = createRequire(import.meta.url)("node:child_process");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = (...args) => {
    spawned.push(name + " " + String(args[0]));
    throw new Error("child_process." + name + " is trapped in this test");
  };
}
syncBuiltinESMExports();
const root = ${JSON.stringify(REPO_ROOT)};
const load = (relative) => import(pathToFileURL(root + "/" + relative).href);
const describe = (error) => (error && error.callError) ? error.callError : { thrown: String(error) };
let result;
${body}
process.stdout.write(JSON.stringify({ resolved, spawned, result }));
`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: REPO_ROOT, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" } });
  return JSON.parse(output) as { resolved: string[]; spawned: string[]; result: unknown };
}

const createInstance = `
const { claudeDriver } = await load("src/drivers/claude/index.ts");
const { createFakeHost } = await load("src/conformance/fake-host.ts");
const host = createFakeHost({});
const instance = await claudeDriver.create(host, { instanceId: "availability", config: claudeDriver.defaultConfig(), environment: { PATH: "/usr/bin" } });
`;

describe("claude driver availability", () => {
  test("importing ari/drivers/claude and ari/meta/claude loads no vendor package and spawns nothing", () => {
    const run = inChild(`await load("src/drivers/claude/index.ts"); await load("src/meta/claude.ts"); result = "imported";`, { hideSdk: false });
    assert.deepEqual(run, { resolved: [], spawned: [], result: "imported" });
  });

  test("with the SDK missing, create() succeeds, status() and probe() name the package to install, and openSession rejects with driver_unavailable", () => {
    const run = inChild(
      `${createInstance}
const status = await instance.status();
const probe = await instance.probe({ deep: true });
let opened;
try { await instance.openSession({}); opened = "opened"; } catch (error) { opened = describe(error); }
result = { status, probe: { ok: probe.ok, installed: probe.installed, error: probe.error }, opened, hostSpawns: host.spawns.length };`,
      { hideSdk: true },
    );
    assert.deepEqual(run.spawned, []);
    assert.ok(run.resolved.includes("@anthropic-ai/claude-agent-sdk"), "the loader never asked for the SDK");
    const result = run.result as { status: { state: string; installed: boolean; error: { code: string; package: string; message: string } }; probe: { ok: boolean; installed: boolean; error: { code: string; package: string } }; opened: { code: string; package: string }; hostSpawns: number };
    assert.equal(result.status.state, "unavailable");
    assert.equal(result.status.installed, false);
    assert.equal(result.status.error.code, "driver_unavailable");
    assert.equal(result.status.error.package, "@anthropic-ai/claude-agent-sdk");
    assert.match(result.status.error.message, /npm install @anthropic-ai\/claude-agent-sdk/);
    assert.deepEqual([result.probe.ok, result.probe.installed, result.probe.error.code, result.probe.error.package], [false, false, "driver_unavailable", "@anthropic-ai/claude-agent-sdk"]);
    assert.equal(result.opened.code, "driver_unavailable");
    assert.equal(result.opened.package, "@anthropic-ai/claude-agent-sdk");
    assert.equal(result.hostSpawns, 0);
  });

  test("with the pinned SDK present, status() reports its version and the bundled binary, with no advisory, and nothing starts Claude Code", () => {
    const run = inChild(
      `${createInstance}
const { loadClaudeSdk } = await load("src/drivers/claude/sdk.ts");
const runtime = await loadClaudeSdk();
const status = await instance.status();
const advisory = await instance.maintenance.advisory();
result = { version: runtime.version, claudeCodeVersion: runtime.claudeCodeVersion, bundledExecutable: runtime.bundledExecutable, functions: ["query", "getSessionInfo", "getSessionMessages", "listSessions", "deleteSession", "archiveSession"].filter((name) => typeof runtime.sdk[name] === "function"), status: { state: status.state, installed: status.installed, version: status.version, advisory: status.advisory ?? null }, advisory };`,
      { hideSdk: false },
    );
    assert.deepEqual(run.spawned, []);
    const result = run.result as { version: string; claudeCodeVersion: string; bundledExecutable: string; functions: string[]; status: { state: string; installed: boolean; version: string; advisory: unknown }; advisory: unknown };
    assert.equal(result.version, "0.3.330");
    assert.equal(result.claudeCodeVersion, "2.1.330");
    assert.match(result.bundledExecutable, /claude-agent-sdk-(linux|darwin|win32)-[a-z0-9]+(-musl)?[\\/]claude(\.exe)?$/);
    assert.deepEqual(result.functions, ["query", "getSessionInfo", "getSessionMessages", "listSessions", "deleteSession", "archiveSession"]);
    assert.deepEqual(result.status, { state: "ready", installed: true, version: "0.3.330", advisory: null });
    assert.equal(result.advisory, null);
  });

  test("an SDK outside the tested range gets an untested_version advisory", async () => {
    const rig = await openClaudeRig({ runtime: { version: "0.3.400" } });
    try {
      const status = await rig.instance.status();
      assert.equal(status.version, "0.3.400");
      assert.deepEqual(status.advisory, {
        kind: "untested_version",
        message: `@anthropic-ai/claude-agent-sdk 0.3.400 is outside the versions this driver is tested against (${CLAUDE_TESTED_VERSIONS}).`,
        currentVersion: "0.3.400",
        testedRange: CLAUDE_TESTED_VERSIONS,
      });
      assert.deepEqual(await rig.instance.maintenance!.advisory(), status.advisory);
    } finally {
      await rig.cleanup();
    }
  });

  test("a missing native Claude Code binary is reported unavailable, naming the platform package, and openSession refuses", async () => {
    const rig = await openClaudeRig({ runtime: { bundledExecutable: null } }).catch((error: unknown) => error);
    // The rig opens a session, which must refuse; build the instance by hand instead.
    assert.ok(rig instanceof Error && (rig as { callError?: { code: string } }).callError?.code === "driver_unavailable", `openSession did not refuse: ${String(rig)}`);
    const { createClaudeDriver } = await import("../../../src/drivers/claude/index.ts");
    const { createFakeHost } = await import("../../../src/conformance/fake-host.ts");
    const { FakeClaudeWorld } = await import("./fake-sdk.ts");
    const world = new FakeClaudeWorld();
    const driver = createClaudeDriver({ loadSdk: async () => ({ sdk: world.sdk, version: "0.3.330", claudeCodeVersion: "2.1.330", bundledExecutable: null }) });
    const instance = await driver.create(createFakeHost({}), { instanceId: "no-binary", config: {}, environment: {} });
    const status = await instance.status();
    assert.equal(status.state, "unavailable");
    assert.equal(status.installed, false);
    assert.equal(status.error?.code, "driver_unavailable");
    assert.deepEqual([(status.error as { package?: string }).package, (status.error as { binary?: string }).binary], [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, "claude"]);
    assert.match(status.error!.message, /without --omit=optional/);
    assert.equal((await instance.probe()).installed, false);
    await assert.rejects(instance.openSession({}), (error: { callError?: { code: string } }) => error.callError?.code === "driver_unavailable");
    assert.equal(world.queries.length, 0);
    // A configured executable that is not on PATH is reported the same way, naming it.
    const configured = await driver.create(createFakeHost({}), { instanceId: "custom", config: { executablePath: "claude-nightly" }, environment: {} });
    const configuredStatus = await configured.status();
    assert.equal(configuredStatus.error?.code, "driver_unavailable");
    assert.equal((configuredStatus.error as { binary?: string }).binary, "claude-nightly");
  });

  test("an explicit executablePath that names no executable file is reported unavailable, naming it, and openSession refuses", async () => {
    const { createClaudeDriver } = await import("../../../src/drivers/claude/index.ts");
    const { createFakeHost } = await import("../../../src/conformance/fake-host.ts");
    const { resolveExecutable } = await import("../../../src/node/process.ts");
    const { FakeClaudeWorld } = await import("./fake-sdk.ts");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ari-claude-executable-"));
    try {
      const missing = path.join(home, "no-claude");
      const notExecutable = path.join(home, "claude-notes");
      fs.writeFileSync(notExecutable, "not a program\n", { mode: 0o644 });
      const present = path.join(home, "claude");
      fs.writeFileSync(present, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const world = new FakeClaudeWorld();
      // The node host's own lookup, as a real host resolves the configured path.
      const host = createFakeHost<ClaudeDriverConfig>({ resolveExecutable: (name) => resolveExecutable(name, "/usr/bin:/bin") });
      const driver = createClaudeDriver({ loadSdk: async () => ({ sdk: world.sdk, version: "0.3.330", claudeCodeVersion: "2.1.330", bundledExecutable: null }), newUuid: () => world.newUuid() });
      for (const configured of [missing, notExecutable]) {
        const instance = await driver.create(host, { instanceId: path.basename(configured), config: { executablePath: configured }, environment: {} });
        const status = await instance.status();
        assert.equal(status.state, "unavailable", `${configured} was reported ${status.state}`);
        assert.equal(status.installed, false);
        assert.equal(status.error?.code, "driver_unavailable");
        assert.equal((status.error as { binary?: string }).binary, configured);
        await assert.rejects(instance.openSession({}), (error: { callError?: { code: string } }) => error.callError?.code === "driver_unavailable");
        await instance.dispose();
      }
      assert.equal(world.queries.length, 0);
      // An executable file at the path is the one every query runs.
      const instance = await driver.create(host, { instanceId: "present", config: { executablePath: present }, environment: {} });
      assert.equal((await instance.probe()).installed, true);
      const session = await instance.openSession({});
      await session.createThread({ cwd: home, policy: { mode: "approval_required", interaction: "default", cwd: home } });
      assert.equal(world.queries.at(-1)?.options.pathToClaudeCodeExecutable, present);
      await session.close();
      await instance.dispose();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("the native binary is looked for in the SDK's own platform packages, in the SDK's order", () => {
    assert.deepEqual(nativeBinaryCandidates("linux", "x64", false), ["@anthropic-ai/claude-agent-sdk-linux-x64/claude", "@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude"]);
    assert.deepEqual(nativeBinaryCandidates("linux", "arm64", true), ["@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude", "@anthropic-ai/claude-agent-sdk-linux-arm64/claude"]);
    assert.deepEqual(nativeBinaryCandidates("darwin", "arm64", false), ["@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"]);
    assert.deepEqual(nativeBinaryCandidates("win32", "x64", false), ["@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe"]);
  });

  test("create() reads only whether the instance keeps its own API key", async () => {
    const { createClaudeDriver } = await import("../../../src/drivers/claude/index.ts");
    const { createFakeHost } = await import("../../../src/conformance/fake-host.ts");
    let loads = 0;
    const driver = createClaudeDriver({
      loadSdk: async () => {
        loads += 1;
        throw new Error("not loaded in create");
      },
    });
    const host = createFakeHost({});
    await driver.create(host, { instanceId: "lazy", config: {}, environment: {} });
    assert.equal(loads, 0);
    assert.deepEqual(host.calls.map((call) => call.operation), ["secrets.get"]);
  });
});
