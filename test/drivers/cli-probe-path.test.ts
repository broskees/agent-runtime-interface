// A CLI version and the executable named by its diagnostic must come from
// the same search, including when the instance overrides the host's PATH.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeHost } from "../../src/conformance/index.ts";
import { codexDriver } from "../../src/drivers/codex/index.ts";
import { museDriver } from "../../src/drivers/muse/index.ts";
import { isAriError } from "../../src/index.ts";
import { createProcessService } from "../../src/node/index.ts";
import type { Driver } from "../../src/runtime.ts";

function checkProbePath<Config>(driver: Driver<Config>, command: string, old: string, minimum: string): void {
  test(`${command} probes and names the executable selected by the instance PATH, not the host PATH`, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-cli-probe-path-")));
    const hostBin = path.join(root, "host-bin");
    const instanceBin = path.join(root, "instance-bin");
    const oldBinary = path.join(instanceBin, command);
    const supportedBinary = path.join(hostBin, command);
    for (const directory of [hostBin, instanceBin]) fs.mkdirSync(directory);
    for (const [binary, version] of [[oldBinary, old], [supportedBinary, minimum]] as const) {
      fs.writeFileSync(binary, `#!/bin/sh\n[ "$*" = --version ] || exit 64\nprintf '%s\\n' '${command} ${version}'\n`, { mode: 0o755 });
    }
    const process = createProcessService({ envPolicy: { stripAmbient: [] }, baseEnv: {
      PATH: hostBin,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_RUNTIME_DIR: path.join(root, "run"),
    } });
    const requests: string[][] = [];
    const config = driver.defaultConfig();
    const host = { ...createFakeHost({ config }), process: { ...process, spawn(request: Parameters<typeof process.spawn>[0]) {
      requests.push([request.command, ...(request.args ?? [])]);
      return process.spawn(request);
    } } };
    try {
      assert.equal(await process.resolveExecutable(command), supportedBinary);
      const instance = await driver.create(host, { instanceId: "instance-path", config, environment: { PATH: instanceBin } });
      try {
        const status = await instance.status();
        assert.equal(status.state, "unavailable");
        assert.equal(status.installed, true);
        assert.equal(status.version, old);
        assert.equal(status.error?.code, "driver_unavailable");
        assert.ok(status.error.message.includes(`(${oldBinary})`), status.error.message);
        assert.ok(!status.error.message.includes(supportedBinary), status.error.message);
        await assert.rejects(instance.openSession({}), (error: unknown) => isAriError(error, "driver_unavailable") && error.message === status.error?.message);
        assert.deepEqual(requests, [[command, "--version"], [command, "--version"]], "only the version command runs, through the host");
      } finally {
        await instance.dispose();
      }
    } finally {
      await process.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

checkProbePath(codexDriver, "codex", "0.100.0", "0.172.0");
checkProbePath(museDriver, "muse", "1.4.7", "1.4.25");

for (const command of ["codex", "muse"]) {
  test(`${command} names the old executable selected by the delegated owner's Win32 Path override (modeled on POSIX)`, () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-cli-probe-win32-")));
    try {
      // Node's builtin ESM exports are mutable via syncBuiltinESMExports. Keep
      // the model in its own Node process, including when Bun runs this suite.
      const fixture = fileURLToPath(new URL("./fixtures/cli-probe-win32.ts", import.meta.url));
      execFileSync("node", [fixture, command, root], { timeout: 15_000, stdio: "pipe" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
