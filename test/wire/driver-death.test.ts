// Agents end when `ari-driver` dies. The built `ari-driver`
// (`dist/wire/cli.js`, run by Node) serves a driver whose two agents each run
// a grandchild in their process group; the grandchild ignores SIGHUP and
// never reads stdin, and one agent ignores SIGTERM too. `ari-driver` then
// ends one of four ways, and within 5 s every agent, grandchild, process group
// and guard it started must be gone:
//
// - SIGKILL and a crash (`process.abort()` inside the driver) run no cleanup
//   at all; each agent's guard ends its group.
// - SIGHUP and SIGTERM make `ari-driver` dispose every instance, which ends
//   the groups, and exit 0.
//
// test/standalone/standalone-binary.e2e.ts repeats the SIGKILL and SIGHUP cases
// with the standalone binary.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { NODE_EXECUTABLE } from "../helpers/runtime.ts";
import { assertEndedEverything, runDriverDeath } from "./driver-death-scenario.ts";
import type { DriverDeath } from "./driver-death-scenario.ts";
import { ARI_DRIVER_BIN, requireBuild } from "./helpers.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ari-driver-death-"));
after(() => fs.rmSync(home, { recursive: true, force: true }));

const ENV = {
  ...(process.env as { [name: string]: string }),
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
};

const DEATHS: Array<{ death: DriverDeath; how: string }> = [
  { death: "SIGKILL", how: "is SIGKILLed" },
  { death: "abort", how: "crashes (process.abort() in the driver)" },
  { death: "SIGHUP", how: "gets SIGHUP, disposes and exits 0" },
  { death: "SIGTERM", how: "gets SIGTERM, disposes and exits 0" },
];

for (const { death, how } of DEATHS) {
  test(`when ari-driver under Node ${how}, every agent, grandchild, process group and guard is gone within 5 s`, async () => {
    requireBuild();
    const outcome = await runDriverDeath({ command: [NODE_EXECUTABLE, ARI_DRIVER_BIN], death, env: ENV, cwd: home });
    assertEndedEverything(outcome, death);
  });
}
