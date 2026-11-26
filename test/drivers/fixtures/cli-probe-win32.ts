// Model the Win32 process owner on POSIX. Only the OS spawn boundary is
// substituted: the real driver, wire, and Node process service run unchanged.
import assert from "node:assert/strict";
import cp from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { createFakeHost } from "../../../src/conformance/index.ts";
import { codexDriver } from "../../../src/drivers/codex/index.ts";
import { museDriver } from "../../../src/drivers/muse/index.ts";
import { isAriError } from "../../../src/index.ts";
import { connectDriver, serveDriver } from "../../../src/wire/index.ts";
import { memoryTransportPair } from "../../wire/helpers.ts";

const [command, root, scenario] = process.argv.slice(2);
assert.ok(command === "codex" || command === "muse");
assert.ok(root);
assert.ok(scenario === "Path override" || scenario === "case collision");
const driver = command === "codex" ? codexDriver : museDriver;
const [old, minimum] = command === "codex" ? ["0.100.0", "0.172.0"] : ["1.4.7", "1.4.25"];
const hostBin = path.join(root, "host-bin");
const instanceBin = path.join(root, "instance-bin");
const filename = `${command}.exe`;
const oldBinary = path.join(instanceBin, filename);
const supportedBinary = path.join(hostBin, filename);
for (const [dir, version] of [[hostBin, minimum], [instanceBin, old]] as const) {
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, filename), `#!/bin/sh\n[ "$*" = --version ] || exit 64\nprintf '%s\\n' '${command} ${version}'\n`, { mode: 0o755 });
}

const spawned: string[][] = [];
const spawn = cp.spawn;
cp.spawn = ((name: string, args: string[], options: import("node:child_process").SpawnOptions) => {
  assert.equal(name, command, "the host still gets the configured command");
  assert.deepEqual(args, ["--version"], "never spawn an agent session");
  // Node's documented Win32 rule: sort keys and use the first case match.
  const key = Object.keys(options.env ?? {}).sort().find((name) => name.toUpperCase() === "PATH");
  const dir = key === undefined ? undefined : options.env?.[key];
  assert.ok(dir === hostBin || dir === instanceBin, "the model can spawn only the fixture executables");
  const file = path.join(dir, filename);
  spawned.push([file, ...args]);
  return spawn(file, args, options);
}) as typeof cp.spawn;
syncBuiltinESMExports();

const platform = process.platform;
const processModule = new URL("../../../src/node/process.ts?win32-model", import.meta.url);
Object.defineProperty(process, "platform", { value: "win32" });
const { createProcessService }: typeof import("../../../src/node/process.ts") = await import(processModule.href);
// The driver and wire still see POSIX; only the process owner models Win32.
Object.defineProperty(process, "platform", { value: platform });

const service = createProcessService({ envPolicy: { stripAmbient: [] }, baseEnv: {
  Path: hostBin,
  HOME: root,
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_RUNTIME_DIR: path.join(root, "run"),
} });
const config = { ...driver.defaultConfig() };
const host = { ...createFakeHost({ config }), process: service };
const [driverSide, hostSide] = memoryTransportPair();
const server = serveDriver(driver, driverSide);
try {
  const connection = await connectDriver(hostSide, { delegateProcesses: true });
  assert.equal(await service.resolveExecutable(command), supportedBinary);
  // In the collision case the merged env has Path first but PAth sorts
  // earlier, so the spawn and lookup must choose PAth, not insertion order.
  const key = scenario === "case collision" ? "PAth" : "Path";
  const instance = await connection.driver.create(host, { instanceId: "win32-owner", config, environment: { [key]: instanceBin } });
  try {
    const status = await instance.status();
    assert.equal(status.state, "unavailable");
    assert.equal(status.installed, true);
    assert.equal(status.version, old);
    assert.equal(status.error?.code, "driver_unavailable");
    await assert.rejects(instance.openSession({}), (error: unknown) => isAriError(error, "driver_unavailable") && error.message === status.error?.message);
    assert.deepEqual(spawned, [[oldBinary, "--version"], [oldBinary, "--version"]]);
    assert.ok(status.error.message.includes(`(${oldBinary})`), status.error.message);
    assert.ok(!status.error.message.includes(supportedBinary), status.error.message);
  } finally {
    await instance.dispose();
    await connection.close();
  }
} finally {
  await server.close();
  await service.dispose();
}
