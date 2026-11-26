// A Node preload (`node --import <this file> …`) that freezes its process at
// the most dangerous moment of starting an agent: right after
// child_process.spawn has started the agent's process, before the process
// service does anything else with it. It stops that new process with SIGSTOP
// (so it cannot get any further on its own either), writes its pid to the file
// that ARI_TEST_PAUSED_PID_FILE names, and then blocks this process for good,
// so the test can SIGKILL it right there.
//
// It acts once, on the first spawn whose arguments hold the fake agent's
// `/bin/sleep 3600` (test/helpers/fake-agent.ts). Without
// ARI_TEST_PAUSED_PID_FILE it does nothing.

import childProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const pidFile = process.env.ARI_TEST_PAUSED_PID_FILE;

if (pidFile !== undefined) {
  const realSpawn = childProcess.spawn;
  let paused = false;
  const pausingSpawn = function (this: unknown, ...args: unknown[]) {
    const child = (realSpawn as (...spawnArgs: unknown[]) => childProcess.ChildProcess).apply(this, args);
    const argv = [args[0], ...(Array.isArray(args[1]) ? (args[1] as unknown[]) : [])];
    if (!paused && child.pid !== undefined && argv.some((arg) => typeof arg === "string" && arg.includes("/bin/sleep 3600"))) {
      paused = true;
      process.kill(child.pid, "SIGSTOP");
      fs.writeFileSync(pidFile, String(child.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return child;
  };
  childProcess.spawn = pausingSpawn as typeof childProcess.spawn;
  // Carries the patched function into `import { spawn } from "node:child_process"` bindings, which ari/node uses.
  syncBuiltinESMExports();
}
