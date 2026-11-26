// A Node preload (`node --import <this file> …`) that freezes its process at
// the most dangerous moment of starting an agent: right after
// child_process.spawn has started the agent's process, before the process
// service does anything else with it. It makes that process stop itself
// (SIGSTOP) before it runs its first command: the `/bin/sh -c` script it is
// given gets `kill -s STOP $$;` in front. Once the process is stopped, the
// preload writes its pid to the file ARI_TEST_PAUSED_PID_FILE names and
// blocks this process for good, so the test can SIGKILL it right there.
//
// It acts once, on the first spawn of `/bin/sh -c …` whose arguments hold the
// fake agent's `/bin/sleep 3600` (test/helpers/fake-agent.ts): ari/node's
// launcher, or, before the launcher existed, the fake agent itself. Without
// ARI_TEST_PAUSED_PID_FILE it does nothing.

import childProcess, { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const pidFile = process.env.ARI_TEST_PAUSED_PID_FILE;

if (pidFile !== undefined) {
  const realSpawn = childProcess.spawn;
  let paused = false;
  const sleepFor = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  const isStopped = (pid: number): boolean => execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("T");
  const pausingSpawn = function (this: unknown, ...args: unknown[]) {
    const command = args[0];
    const spawnArgs = Array.isArray(args[1]) ? [...(args[1] as unknown[])] : undefined;
    const isAgentShell = command === "/bin/sh" && spawnArgs?.[0] === "-c" && typeof spawnArgs[1] === "string" && spawnArgs.some((arg) => typeof arg === "string" && arg.includes("/bin/sleep 3600"));
    if (paused || !isAgentShell) return (realSpawn as (...spawnArgs: unknown[]) => childProcess.ChildProcess).apply(this, args);
    paused = true;
    spawnArgs![1] = `kill -s STOP $$; ${spawnArgs![1] as string}`;
    const child = (realSpawn as (...spawnArgs: unknown[]) => childProcess.ChildProcess).apply(this, [command, spawnArgs, ...args.slice(2)]);
    if (child.pid !== undefined) {
      const deadline = Date.now() + 10_000;
      while (!isStopped(child.pid) && Date.now() < deadline) sleepFor(5);
      fs.writeFileSync(pidFile, String(child.pid));
      sleepFor(Number.POSITIVE_INFINITY);
    }
    return child;
  };
  childProcess.spawn = pausingSpawn as typeof childProcess.spawn;
  // Carries the patched function into `import { spawn } from "node:child_process"` bindings, which ari/node uses.
  syncBuiltinESMExports();
}
