// A missing vendor runtime fails loudly only when used. Importing
// `ari/drivers/opencode` or `ari/meta/opencode` loads no SDK and spawns
// nothing. Without the SDK the server's generation needs (`@opencode-ai/sdk`
// for 1.x, `@opencode/client` for 2.x), or without `opencode`, `create()`
// works, `status()` reports the driver unavailable naming what to install,
// and `openSession` rejects with `driver_unavailable`. With them, `status()`
// reports the version found and an advisory outside the tested range.
//
// The missing-SDK checks run in a child Node process whose module resolution
// refuses the two packages, exactly as Node does for a package that is not
// installed (`ERR_MODULE_NOT_FOUND`), so the driver's own default loaders run.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakeHost, createMemoryProcess } from "../../../src/conformance/index.ts";
import type { FakeSpawnRequest } from "../../../src/conformance/index.ts";
import { OPENCODE_V1_TESTED_VERSIONS, OPENCODE_V2_TESTED_VERSIONS, opencodeDriver } from "../../../src/drivers/opencode/index.ts";
import type { OpencodeConfig } from "../../../src/drivers/opencode/index.ts";
import { isAriError, toCallError } from "../../../src/index.ts";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DRIVER = pathToFileURL(path.join(ROOT, "src/drivers/opencode/index.ts")).href;
const META = pathToFileURL(path.join(ROOT, "src/meta/opencode.ts")).href;
const CONFORMANCE = pathToFileURL(path.join(ROOT, "src/conformance/index.ts")).href;

function runChild(source: string): unknown {
  // The child registers node:module hooks, which Bun lacks, so it runs on Node whichever runtime runs this test.
  const result = spawnSync(NODE_EXECUTABLE, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 60_000, cwd: ROOT });
  assert.equal(result.status, 0, `the child failed: ${result.stderr}`);
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line);
}

test("importing ari/drivers/opencode and ari/meta/opencode loads no vendor SDK and spawns nothing", () => {
  const outcome = runChild(`
    import { registerHooks, createRequire, syncBuiltinESMExports } from "node:module";
    const resolved = [];
    registerHooks({ resolve(specifier, context, next) { resolved.push(specifier); return next(specifier, context); } });
    const childProcess = createRequire(import.meta.url)("node:child_process");
    const spawned = [];
    for (const name of ["spawn", "spawnSync", "exec", "execFile", "fork"]) {
      const original = childProcess[name];
      childProcess[name] = (...args) => { spawned.push(name); return original(...args); };
    }
    syncBuiltinESMExports();
    const driver = await import(${JSON.stringify(DRIVER)});
    const meta = await import(${JSON.stringify(META)});
    console.log(JSON.stringify({ sdk: resolved.filter((specifier) => specifier.startsWith("@opencode")), spawned, kind: driver.opencodeDriver.kind, label: meta.label }));
  `) as { sdk: string[]; spawned: string[]; kind: string; label: string };
  assert.equal(outcome.kind, "opencode");
  assert.equal(outcome.label, "OpenCode");
  assert.deepEqual(outcome.sdk, []);
  assert.deepEqual(outcome.spawned, []);
});

test("with the SDK a server's generation needs not installed: create works, status names the package, openSession is driver_unavailable", () => {
  const outcome = runChild(`
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier.startsWith("@opencode-ai/sdk") || specifier.startsWith("@opencode/client")) {
          const error = new Error("Cannot find package '" + specifier + "' imported from the driver");
          error.code = "ERR_MODULE_NOT_FOUND";
          throw error;
        }
        return next(specifier, context);
      },
    });
    const { opencodeDriver } = await import(${JSON.stringify(DRIVER)});
    const { createFakeHost, createMemoryProcess } = await import(${JSON.stringify(CONFORMANCE)});
    const results = {};
    for (const [generation, printed] of [["1", "1.19.6"], ["2", "opencode v2.1.2"]]) {
      const host = createFakeHost({
        resolveExecutable: async (name) => (name === "opencode" ? "/opt/opencode/bin/opencode" : null),
        spawn: async (request) => {
          const memory = createMemoryProcess({ onStdin() {}, onStdinClosed() {}, onKill() {} });
          queueMicrotask(() => { memory.stdout(printed + "\\n"); memory.exit(0, null); });
          return memory.process;
        },
      });
      const instance = await opencodeDriver.create(host, { instanceId: "missing-" + generation, config: opencodeDriver.defaultConfig(), environment: {} });
      const status = await instance.status();
      let rejected;
      try { await instance.openSession({}); } catch (error) { rejected = error.callError ?? { message: String(error) }; }
      results[generation] = { status, rejected, spawns: host.spawns.map((spawn) => spawn.args) };
    }
    console.log(JSON.stringify(results));
  `) as { [generation: string]: { status: { state: string; installed: boolean; version?: string; error?: { code: string; package?: string; message: string } }; rejected?: { code: string; package?: string }; spawns: string[][] } };
  for (const [generation, packageName] of [
    ["1", "@opencode-ai/sdk"],
    ["2", "@opencode/client"],
  ] as const) {
    const result = outcome[generation]!;
    assert.equal(result.status.state, "unavailable", `${generation}.x status`);
    assert.equal(result.status.installed, true, "opencode itself is there");
    assert.equal(result.status.error?.code, "driver_unavailable");
    assert.equal(result.status.error?.package, packageName);
    assert.match(result.status.error?.message ?? "", new RegExp(packageName.replace("/", "\\/")));
    assert.equal(result.rejected?.code, "driver_unavailable");
    assert.equal(result.rejected?.package, packageName);
    assert.ok(
      result.spawns.every((args) => args[0] === "--version"),
      "nothing but --version ran",
    );
  }
});

function versionHost(printed: string | null) {
  return createFakeHost<OpencodeConfig>({
    resolveExecutable: async (name) => (printed !== null && name === "opencode" ? "/opt/opencode/bin/opencode" : null),
    spawn: async (request: FakeSpawnRequest) => {
      const memory = createMemoryProcess({ onStdin() {}, onStdinClosed() {}, onKill() {} });
      queueMicrotask(() => {
        if (request.args?.[0] === "--version") memory.stdout(`${printed}\n`);
        memory.exit(request.args?.[0] === "--version" ? 0 : 1, null);
      });
      return memory.process;
    },
  });
}

test("without opencode: create works, status names the binary, openSession is driver_unavailable, and nothing spawned", async () => {
  const host = versionHost(null);
  const instance = await opencodeDriver.create(host, { instanceId: "no-binary", config: opencodeDriver.defaultConfig(), environment: {} });
  const status = await instance.status();
  assert.equal(status.state, "unavailable");
  assert.equal(status.installed, false);
  assert.equal(status.error?.code, "driver_unavailable");
  assert.equal((status.error as { binary?: string }).binary, "opencode");
  await assert.rejects(instance.openSession({}), (error: unknown) => isAriError(error, "driver_unavailable") && (toCallError(error) as { binary?: string }).binary === "opencode");
  assert.equal(host.spawns.length, 0);
});

test("an external server that cannot be reached is unavailable, without anything spawned", async () => {
  const host = versionHost(null);
  const instance = await opencodeDriver.create(host, { instanceId: "no-server", config: { binary: "opencode", serverUrl: "http://127.0.0.1:9" }, environment: {} });
  const status = await instance.status();
  assert.equal(status.state, "unavailable");
  assert.equal(status.error?.code, "transport");
  await assert.rejects(instance.openSession({}), (error: unknown) => isAriError(error, "transport"));
  assert.equal(host.spawns.length, 0);
});

test("with opencode and its SDK: status reports the version found, and an advisory outside the tested ranges", async () => {
  const cases: Array<[string, string, boolean]> = [
    ["1.19.6", "1.19.6", false],
    ["1.3.15", "1.3.15", true],
    ["opencode v2.1.2", "2.1.2", false],
    ["opencode v2.4.1", "2.4.1", true],
  ];
  for (const [printed, version, advised] of cases) {
    const instance = await opencodeDriver.create(versionHost(printed), { instanceId: `v-${version}`, config: opencodeDriver.defaultConfig(), environment: {} });
    const status = await instance.status();
    assert.equal(status.state, "ready", printed);
    assert.equal(status.version, version);
    if (!advised) assert.equal(status.advisory, undefined, printed);
    else {
      assert.equal(status.advisory?.kind, "untested_version", printed);
      assert.equal(status.advisory?.currentVersion, version);
      assert.equal(status.advisory?.testedRange, version.startsWith("1.") ? OPENCODE_V1_TESTED_VERSIONS : OPENCODE_V2_TESTED_VERSIONS);
    }
    const probe = await instance.probe();
    assert.equal(probe.installed, true);
    assert.equal(probe.version, version);
  }
});
