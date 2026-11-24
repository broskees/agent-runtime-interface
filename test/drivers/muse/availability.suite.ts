// A missing Muse runtime fails loudly only when used. Importing
// ari/drivers/muse or ari/meta/muse loads no vendor package and spawns
// nothing; with the SDK hidden, create() works, status() and probe() report
// the driver unavailable naming the package, and openSession rejects with
// driver_unavailable; with the `muse` binary missing, they name the binary;
// with both present, status() reports the version found, and a version
// outside the tested range gets an advisory. The child-process checks run the
// driver's real loader, with every child_process entry point trapped.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";
import { isAriError } from "../../../src/index.ts";
import { loadMuseSdk } from "../../../src/drivers/muse/index.ts";
import { MUSE_SDK_PACKAGE, MUSE_TESTED_VERSIONS } from "../../../src/meta/muse.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { museRig } from "./rig.ts";

/** Runs `body` in a fresh Node process that records every @muse-code resolution and traps every child_process call. */
function inChild(body: string, options: { hideSdk: boolean }): { resolved: string[]; spawned: string[]; result: unknown } {
  const script = `
import { registerHooks, createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
const resolved = [];
const spawned = [];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@muse-code/")) {
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
const { museDriver } = await load("src/drivers/muse/index.ts");
const { createFakeHost } = await load("src/conformance/fake-host.ts");
const host = createFakeHost({ resolveExecutable: async (name) => (name === "muse" ? "/usr/local/bin/muse" : null) });
const instance = await museDriver.create(host, { instanceId: "availability", config: museDriver.defaultConfig(), environment: { PATH: "/usr/bin" } });
`;

describe("muse driver availability", () => {
  test("importing ari/drivers/muse and ari/meta/muse loads no vendor package and spawns nothing", () => {
    const run = inChild(`await load("src/drivers/muse/index.ts"); await load("src/meta/muse.ts"); result = "imported";`, { hideSdk: false });
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
    const result = run.result as { status: { state: string; installed: boolean; error?: { code: string; package?: string; installHint?: string } }; probe: { ok: boolean; installed: boolean; error?: { code: string; package?: string } }; opened: { code: string; package?: string }; hostSpawns: number };
    assert.deepEqual(run.spawned, []);
    assert.ok(run.resolved.includes("@muse-code/sdk"), "the driver tried to load the SDK only when it was needed");
    assert.equal(result.status.state, "unavailable");
    assert.equal(result.status.installed, false);
    assert.equal(result.status.error?.code, "driver_unavailable");
    assert.equal(result.status.error?.package, MUSE_SDK_PACKAGE);
    assert.match(result.status.error?.installHint ?? "", /npm install @muse-code\/sdk/);
    assert.deepEqual(result.probe, { ok: false, installed: false, error: result.status.error });
    assert.equal(result.opened.code, "driver_unavailable");
    assert.equal(result.opened.package, MUSE_SDK_PACKAGE);
    assert.equal(result.hostSpawns, 0);
  });

  test("with the SDK present, the loader finds it and reads its version", async () => {
    const runtime = await loadMuseSdk();
    assert.equal(runtime.version, "1.4.25");
    assert.equal(typeof runtime.sdk.Connection, "function");
    assert.equal(typeof runtime.sdk.createUuidV7Mint, "function");
  });

  test("with the muse binary missing, status() names the binary and openSession rejects with driver_unavailable", async () => {
    const rig = await museRig({ missingBinary: true });
    try {
      const status = await rig.instance.status();
      assert.equal(status.state, "unavailable");
      assert.equal(status.error?.code, "driver_unavailable");
      assert.equal((status.error as { binary?: string }).binary, "muse");
      await assert.rejects(rig.instance.openSession({}), (error) => isAriError(error, "driver_unavailable") && (error.callError as { binary?: string }).binary === "muse");
      assert.equal(rig.host.spawns.length, 0);
    } finally {
      await rig.cleanup();
    }
  });

  test("with both present, status() reports the version muse --version prints and no advisory", async () => {
    const rig = await museRig();
    try {
      const status = await rig.instance.status();
      assert.equal(status.state, "ready");
      assert.equal(status.installed, true);
      assert.equal(status.version, "1.4.25");
      assert.equal(status.advisory, undefined);
      assert.deepEqual(rig.host.spawns.map((spawn) => [spawn.command, ...(spawn.args ?? [])]), [["muse", "--version"]]);
    } finally {
      await rig.cleanup();
    }
  });

  test("a muse CLI or an SDK outside the tested range gets an untested_version advisory", async () => {
    const cli = await museRig({ fake: { version: "1.5.0" } });
    try {
      const status = await cli.instance.status();
      assert.equal(status.version, "1.5.0");
      assert.equal(status.advisory?.kind, "untested_version");
      assert.equal(status.advisory?.testedRange, MUSE_TESTED_VERSIONS);
      assert.match(status.advisory?.message ?? "", /Muse Code 1\.5\.0/);
      assert.equal((await cli.instance.maintenance!.advisory())?.kind, "untested_version");
    } finally {
      await cli.cleanup();
    }
    const real = await loadMuseSdk();
    const sdk = await museRig({ driver: { loadSdk: async () => ({ sdk: real.sdk, version: "1.4.6" }) } });
    try {
      const status = await sdk.instance.status();
      assert.equal(status.advisory?.kind, "untested_version");
      assert.match(status.advisory?.message ?? "", /@muse-code\/sdk 1\.4\.6/);
    } finally {
      await sdk.cleanup();
    }
  });
});
