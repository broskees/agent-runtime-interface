// Agents end when `ari-driver` dies. The built `ari-driver`
// (`dist/wire/cli.js`, run by Node) serves a driver whose two agents each run
// a grandchild in their process group; the grandchild ignores SIGHUP and
// never reads stdin, and one agent ignores SIGTERM too. `ari-driver` then
// ends one of four ways, and within 5 s every agent, grandchild, process group
// and guard it started must be gone:
//
// - SIGKILL and a crash (`process.abort()` inside the driver) run no cleanup
//   at all; each agent's guard ends its group.
// - SIGHUP, SIGTERM and the host closing its stdin make `ari-driver` dispose
//   every instance, which ends the groups, and exit 0. A driver whose own
//   dispose takes longer than 5 s does not hold its agents up: `ari-driver`
//   ends them 2 s after the shutdown began (LOCAL_PROCESSES_END_AFTER_MS),
//   while that dispose still runs, and exits 0 when it ends. A driver whose
//   dispose ends within those 2 s finishes it with its agents untouched; that
//   case closes `ari-driver`'s stdin, the host's clean shutdown.
//
// What is left is sampled from the moment of the signal, not after
// `ari-driver` exits. And `ari-driver` SIGKILLed between an agent's spawn and
// the moment its guard is up (a preload freezes Node inside
// `child_process.spawn` there) leaves nothing behind either.
//
// test/standalone/standalone-binary.e2e.ts repeats the SIGKILL, SIGHUP and
// startup-window cases with the standalone binary.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { NODE_EXECUTABLE } from "../helpers/runtime.ts";
import assert from "node:assert/strict";
import { PAUSE_AFTER_AGENT_SPAWN, assertEndedEverything, runDeathInStartupWindow, runDriverDeath } from "./driver-death-scenario.ts";
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

test("when ari-driver under Node gets SIGTERM while its driver's dispose takes 6 s, every agent, grandchild, process group and guard is still gone within 5 s, and ari-driver exits 0 once that dispose ends", async () => {
  requireBuild();
  const outcome = await runDriverDeath({ command: [NODE_EXECUTABLE, ARI_DRIVER_BIN], death: "SIGTERM", env: ENV, cwd: home, disposeDelayMs: 6000 });
  assertEndedEverything(outcome, "SIGTERM");
});

test("when the host closes ari-driver's stdin, a driver whose dispose ends within the 2 s budget finishes it with every agent still running; then everything is gone within 5 s", async () => {
  requireBuild();
  const disposeReportFile = path.join(fs.mkdtempSync(path.join(home, "dispose-report-")), "report.json");
  // docs/wire.md names the budget: 2 s. A dispose that takes 1.8 s ends within it.
  const disposeDelayMs = 1800;
  const outcome = await runDriverDeath({ command: [NODE_EXECUTABLE, ARI_DRIVER_BIN], death: "EOF", env: ENV, cwd: home, disposeDelayMs, disposeReportFile });
  assertEndedEverything(outcome, "EOF");
  const report = JSON.parse(fs.readFileSync(disposeReportFile, "utf8")) as { agents: Array<{ pid: number; alive: boolean }> };
  assert.deepEqual(
    report.agents.map((agent) => agent.alive),
    [true, true],
    `when the driver's own dispose ended, ${disposeDelayMs} ms after the stdin closed, ari-driver had not ended any agent yet`,
  );
});

test("when ari-driver under Node is SIGKILLed after an agent's spawn returned but before its guard started, the agent's group is gone within 5 s", async () => {
  requireBuild();
  const outcome = await runDeathInStartupWindow({ command: [NODE_EXECUTABLE, "--import", PAUSE_AFTER_AGENT_SPAWN, ARI_DRIVER_BIN], pause: "preload", env: ENV, cwd: home });
  assert.deepEqual(outcome.survivors, [], "the paused agent's group ended within 5 s of the SIGKILL");
  assert.equal(outcome.exit.signal, "SIGKILL");
});
