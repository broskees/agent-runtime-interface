// A missing Codex CLI fails loudly only when used: importing the driver or its
// metadata loads no vendor code and spawns nothing, `create()` succeeds,
// `status()` names the binary to install and `openSession` rejects with
// `driver_unavailable`. With the CLI present, `status()` reports its version,
// and an advisory when that version is outside the tested range.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import { CODEX_TESTED_VERSIONS, satisfiesVersionRange, versionAdvisory } from "../../../src/drivers/codex/index.ts";
import { isAriError } from "../../../src/index.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { reachableImports } from "./imports.ts";
import { codexRig } from "./rig.ts";
import type { CodexTestRig } from "./rig.ts";

let rig: CodexTestRig | undefined;
afterEach(async () => {
  await rig?.cleanup();
  rig = undefined;
});

describe("a missing Codex CLI fails loudly only when used", () => {
  test("ari/drivers/codex and ari/meta/codex import nothing outside the package: no vendor SDK, no Node built-in", () => {
    for (const entry of ["src/drivers/codex/index.ts", "src/meta/codex.ts"]) {
      const graph = reachableImports(path.join(REPO_ROOT, entry));
      assert.deepEqual(graph.external, [], `${entry} reaches ${graph.external.join(", ")}`);
      assert.ok(graph.files.every((file) => file.startsWith(path.join(REPO_ROOT, "src"))));
    }
  });

  test("importing the driver and its metadata, and creating an instance, spawns nothing", () => {
    // A child process whose child_process functions throw: any spawn at import or create() fails it.
    const script = `
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const childProcess = createRequire(import.meta.url)("node:child_process");
      for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
        childProcess[name] = () => { throw new Error("spawned " + name); };
      }
      syncBuiltinESMExports();
      const { codexDriver } = await import(${JSON.stringify(path.join(REPO_ROOT, "src/drivers/codex/index.ts"))});
      await import(${JSON.stringify(path.join(REPO_ROOT, "src/meta/codex.ts"))});
      const { createFakeHost } = await import(${JSON.stringify(path.join(REPO_ROOT, "src/conformance/index.ts"))});
      const host = createFakeHost();
      await codexDriver.create(host, { instanceId: "i", config: codexDriver.defaultConfig(), environment: {} });
      process.stdout.write(JSON.stringify(host.calls.map((call) => call.operation)));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["secrets.get", "secrets.get"], "create() only reads which managed credential the instance holds");
  });

  test("without the codex binary: create() succeeds, status() names the binary to install, openSession rejects with driver_unavailable", async () => {
    rig = await codexRig({ missingBinary: true });
    const status = await rig.instance.status();
    assert.equal(status.state, "unavailable");
    assert.equal(status.installed, false);
    assert.equal(status.error?.code, "driver_unavailable");
    assert.equal((status.error as { binary?: string }).binary, "codex");
    assert.match(status.error!.message, /npm install -g @openai\/codex/);
    const probe = await rig.instance.probe({ deep: true });
    assert.equal(probe.installed, false);
    await assert.rejects(rig.instance.openSession({}), (error) => isAriError(error, "driver_unavailable") && (error.callError as { binary?: string }).binary === "codex");
    assert.deepEqual(rig.host.spawns, [], "nothing was spawned");
  });

  test("with codex present: status() reports the version found, with no advisory inside the tested range", async () => {
    rig = await codexRig({ version: "0.172.0" });
    const status = await rig.instance.status();
    assert.equal(status.state, "ready");
    assert.equal(status.version, "0.172.0");
    assert.equal(status.advisory, undefined);
    assert.equal(await rig.instance.maintenance!.advisory(), null);
    assert.deepEqual(rig.host.spawns.map((spawn) => spawn.args), [["--version"], ["login", "status"], ["--version"]]);
  });

  test("with a codex version outside the tested range, status() reports an untested_version advisory", async () => {
    for (const version of ["0.180.1", "0.171.9", "0.172.0-alpha.3"]) {
      rig = await codexRig({ version });
      const status = await rig.instance.status();
      assert.equal(status.version, version);
      assert.deepEqual(status.advisory, {
        kind: "untested_version",
        message: `Codex CLI ${version} is outside the versions this driver is tested against (${CODEX_TESTED_VERSIONS}).`,
        currentVersion: version,
        testedRange: CODEX_TESTED_VERSIONS,
      });
      assert.deepEqual(await rig.instance.maintenance!.advisory(), status.advisory);
      await rig.cleanup();
      rig = undefined;
    }
  });

  test("the tested range is the release the protocol schema was vendored from", () => {
    assert.equal(CODEX_TESTED_VERSIONS, ">=0.172.0 <0.173.0");
    assert.equal(satisfiesVersionRange("0.172.0", CODEX_TESTED_VERSIONS), true);
    assert.equal(satisfiesVersionRange("0.172.9", CODEX_TESTED_VERSIONS), true);
    assert.equal(satisfiesVersionRange("0.173.0", CODEX_TESTED_VERSIONS), false);
    assert.equal(satisfiesVersionRange("not a version", CODEX_TESTED_VERSIONS), false);
    assert.equal(versionAdvisory(undefined), null);
  });
});
