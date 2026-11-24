// A missing Cursor SDK fails loudly only when used. Importing
// ari/drivers/cursor or ari/meta/cursor loads no vendor package and spawns
// nothing; with @cursor/sdk hidden, create() works, status() and probe()
// report the driver unavailable naming the package, and openSession rejects
// with driver_unavailable; with the SDK present (the pinned devDependency),
// status() reports its version, and a version outside the tested range gets
// an advisory. The child-process checks run the driver's real loader, with
// every child_process entry point trapped and HOME pointed at an empty
// directory, so nothing reads the user's own Cursor sign-in.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CURSOR_TESTED_VERSIONS, versionAdvisory, versionInRange } from "../../../src/drivers/cursor/index.ts";
import { openCursorRig } from "./rig.ts";
import type { CursorTestRig } from "./rig.ts";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-cursor-home-")));
const rigs: CursorTestRig[] = [];
after(async () => {
  for (const rig of rigs) await rig.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

/** Runs `body` in a fresh Node process that records every @cursor/ resolution and traps every child_process call. */
function inChild(body: string, options: { hideSdk: boolean }): { resolved: string[]; spawned: string[]; result: unknown } {
  const script = `
import { registerHooks, createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
const resolved = [];
const spawned = [];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@cursor/")) {
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
const root = ${JSON.stringify(ROOT)};
const load = (relative) => import(pathToFileURL(root + "/" + relative).href);
const describe = (error) => (error && error.callError) ? error.callError : { thrown: String(error) };
let result;
${body}
process.stdout.write(JSON.stringify({ resolved, spawned, result }));
`;
  // The child registers node:module hooks, which Bun lacks, so it runs on Node whichever runtime runs this test.
  const output = execFileSync(NODE_EXECUTABLE, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME } });
  return JSON.parse(output) as { resolved: string[]; spawned: string[]; result: unknown };
}

const createInstance = `
const { cursorDriver } = await load("src/drivers/cursor/index.ts");
const { createFakeHost } = await load("src/conformance/fake-host.ts");
const host = createFakeHost({ paths: { stateDir: ${JSON.stringify(path.join(HOME, "state"))}, cacheDir: ${JSON.stringify(path.join(HOME, "cache"))}, tmpDir: ${JSON.stringify(path.join(HOME, "tmp"))} } });
const instance = await cursorDriver.create(host, { instanceId: "availability", config: cursorDriver.defaultConfig(), environment: { PATH: "/usr/bin" } });
`;

describe("cursor driver availability", () => {
  test("importing ari/drivers/cursor and ari/meta/cursor loads no vendor package and spawns nothing", () => {
    const run = inChild(`await load("src/drivers/cursor/index.ts"); await load("src/meta/cursor.ts"); result = "imported";`, { hideSdk: false });
    assert.deepEqual(run, { resolved: [], spawned: [], result: "imported" });
  });

  test("with the SDK missing, create() succeeds, status() and probe() name the package to install, and openSession rejects with driver_unavailable", () => {
    const run = inChild(
      `${createInstance}
const status = await instance.status();
const probe = await instance.probe({ deep: true });
let opened;
try { await instance.openSession({}); opened = "opened"; } catch (error) { opened = describe(error); }
result = { status, probe: { ok: probe.ok, installed: probe.installed, error: probe.error }, opened, hostCalls: host.calls.map((call) => call.operation) };`,
      { hideSdk: true },
    );
    const result = run.result as { status: { state: string; installed: boolean; error?: { code: string; package?: string; installHint?: string } }; probe: { ok: boolean; installed: boolean; error?: { code: string; package?: string } }; opened: { code?: string; package?: string }; hostCalls: string[] };
    assert.equal(result.status.state, "unavailable");
    assert.equal(result.status.installed, false);
    assert.equal(result.status.error?.code, "driver_unavailable");
    assert.equal(result.status.error?.package, "@cursor/sdk");
    assert.match(result.status.error?.installHint ?? "", /npm install @cursor\/sdk/);
    assert.deepEqual({ ok: result.probe.ok, installed: result.probe.installed, code: result.probe.error?.code, package: result.probe.error?.package }, { ok: false, installed: false, code: "driver_unavailable", package: "@cursor/sdk" });
    assert.equal(result.opened.code, "driver_unavailable");
    assert.equal(result.opened.package, "@cursor/sdk");
    assert.deepEqual(run.spawned, []);
    assert.ok(run.resolved.includes("@cursor/sdk"), "the driver tried to load the SDK only when used");
    assert.ok(!result.hostCalls.includes("process.spawn"));
  });

  test("with the SDK present, status() reports the version found, inside the tested range", () => {
    const run = inChild(
      `${createInstance}
const status = await instance.status();
const { loadCursorSdk } = await load("src/drivers/cursor/index.ts");
const loaded = await loadCursorSdk();
result = { state: status.state, installed: status.installed, version: status.version, advisory: status.advisory ?? null, auth: status.auth, loaded: loaded.version };`,
      { hideSdk: false },
    );
    const pinned = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { devDependencies: { [name: string]: string } }).devDependencies["@cursor/sdk"];
    assert.deepEqual(run.result, { state: "ready", installed: true, version: pinned, advisory: null, auth: { status: "unauthenticated", evidence: "passive", scope: "ambient", actionRequired: { reason: "Store a Cursor API key for this instance, or sign in with the Cursor SDK (Cursor.auth.login())." } }, loaded: pinned });
    assert.deepEqual(run.spawned, []);
    assert.deepEqual(fs.readdirSync(HOME).filter((entry) => entry === ".cursor"), [], "nothing was written under the home directory");
  });

  test("a version outside the tested range gets an untested_version advisory in status()", async () => {
    assert.equal(versionInRange("1.4.2", CURSOR_TESTED_VERSIONS), true);
    assert.equal(versionInRange("1.4.9", CURSOR_TESTED_VERSIONS), true);
    assert.equal(versionInRange("1.5.0", CURSOR_TESTED_VERSIONS), false);
    assert.equal(versionInRange("1.3.1", CURSOR_TESTED_VERSIONS), false);
    assert.equal(versionAdvisory("1.4.2"), undefined);
    const rig = await openCursorRig({ version: "1.5.0" });
    rigs.push(rig);
    const status = await rig.instance.status();
    assert.equal(status.state, "ready");
    assert.equal(status.version, "1.5.0");
    assert.deepEqual(status.advisory, { kind: "untested_version", message: `@cursor/sdk 1.5.0 is outside the versions this driver is tested against (${CURSOR_TESTED_VERSIONS}).`, currentVersion: "1.5.0", testedRange: CURSOR_TESTED_VERSIONS });
    const inRange = await openCursorRig();
    rigs.push(inRange);
    assert.equal((await inRange.instance.status()).advisory, undefined);
  });
});
