// What ari/node's process service does with a spawn that cannot start, under
// Node: it never starts the command outside its launcher, so no command ever
// runs without a guard, and it still rejects with the error Node's own spawn
// gives. Two things only Node allows make this testable, so the Bun run leaves
// this file out (test/bun-excluded.txt): module.syncBuiltinESMExports() carries
// a patched fs.statSync and child_process.spawn into src/node/process.ts's
// imports, and the reference errors come from Node's own child_process.spawn.
//
// - A command the search missed but that is there right after (an install
//   finishing at that moment) is not started: the spawn rejects with
//   `spawn_failed`, no process is spawned, and the command never runs.
// - For each request spawn cannot start, the rejection has the code (and for
//   `invalid_state` the reason) that Node's spawn error maps to, and nothing is
//   spawned.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isAriError } from "../../src/index.ts";
import { createProcessService } from "../../src/node/index.ts";
import type { SpawnRequest } from "../../src/generated/host.ts";

const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-process-node-")));
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const realSpawn = childProcess.spawn;
const realStatSync = fs.statSync;

/** Records every child_process.spawn call ari/node makes while `body` runs, and still spawns. */
async function recordingSpawns<T>(body: (spawned: string[]) => Promise<T>): Promise<T> {
  const spawned: string[] = [];
  childProcess.spawn = ((...args: Parameters<typeof realSpawn>) => {
    spawned.push(String(args[0]));
    return (realSpawn as (...spawnArgs: unknown[]) => ChildProcess)(...args);
  }) as typeof realSpawn;
  syncBuiltinESMExports();
  try {
    return await body(spawned);
  } finally {
    childProcess.spawn = realSpawn;
    syncBuiltinESMExports();
  }
}

test("a command the search missed but that is there right after is not started: the spawn rejects and nothing runs outside the launcher", async () => {
  const command = path.join(directory, "appears");
  const marker = `${command}.ran`;
  fs.writeFileSync(command, `#!/bin/sh\n: > "${marker}"\nexec /bin/sleep 30\n`, { mode: 0o755 });
  const service = createProcessService({ envPolicy: { stripAmbient: [] }, baseEnv: { PATH: "/usr/bin:/bin" } });
  // The search's first look at the file says it is not there, as when an install finishes just after it.
  let looked = false;
  Object.assign(fs, {
    statSync: (file: fs.PathLike, ...rest: unknown[]) => {
      if (!looked && file === command) {
        looked = true;
        throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${command}'`), { code: "ENOENT" });
      }
      return (realStatSync as (...statArgs: unknown[]) => fs.Stats)(file, ...rest);
    },
  });
  syncBuiltinESMExports();
  try {
    await recordingSpawns(async (spawned) => {
      await assert.rejects(service.spawn({ command }), (error: unknown) => isAriError(error, "invalid_state") && (error.callError as { reason?: string }).reason === "spawn_failed");
      assert.equal(looked, true, "the search looked at the file");
      assert.deepEqual(spawned, [], "nothing was spawned: neither the command nor a launcher");
    });
    await delay(300);
    assert.equal(fs.existsSync(marker), false, "the command never ran");
  } finally {
    Object.assign(fs, { statSync: realStatSync });
    syncBuiltinESMExports();
    await service.dispose();
  }
});

/** The ARI error code (and reason) Node's spawn error `error` maps to. */
function expectedFrom(error: NodeJS.ErrnoException): { code: string; reason?: string } {
  if (typeof error.code === "string" && error.code.startsWith("ERR_INVALID_ARG")) return { code: "validation" };
  if (error.code === "ENOENT") return { code: "not_found" };
  if (error.code === "EACCES" || error.code === "EPERM") return { code: "permission_denied" };
  return { code: "invalid_state", reason: "spawn_failed" };
}

/** The error Node's own spawn gives `request` with environment `env`: thrown at once, or emitted. Fails if it starts something. */
async function nodeSpawnError(request: SpawnRequest, env: { [name: string]: string }): Promise<NodeJS.ErrnoException> {
  let child: ChildProcess;
  try {
    child = realSpawn(request.command, request.args ?? [], { cwd: request.cwd as string, env, stdio: "ignore" });
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
  if (child.pid !== undefined) {
    child.kill("SIGKILL");
    assert.fail(`Node's spawn started ${request.command}, so this is not a case of a spawn that cannot start`);
  }
  return new Promise((resolve) => child.once("error", resolve));
}

test("a spawn that cannot start rejects as Node's own spawn does, and starts nothing", async () => {
  const notExecutable = path.join(directory, "not-executable");
  fs.writeFileSync(notExecutable, "data", { mode: 0o644 });
  const deniedDirectory = path.join(directory, "denied");
  fs.mkdirSync(deniedDirectory);
  fs.writeFileSync(path.join(deniedDirectory, "ari-denied"), "data", { mode: 0o644 });
  const missing = path.join(directory, "missing");
  const basePath = "/usr/bin:/bin";
  const cases: Array<{ readonly name: string; readonly request: SpawnRequest; readonly path?: string }> = [
    { name: "a bare name on no PATH entry", request: { command: "ari-no-such-command" } },
    { name: "a path that does not exist", request: { command: path.join(missing, "tool") } },
    { name: "a file that is not executable", request: { command: notExecutable } },
    { name: "a directory", request: { command: directory } },
    { name: "a bare name that is not executable where PATH finds it", request: { command: "ari-denied" }, path: `${deniedDirectory}:${basePath}` },
    { name: "a bare name on a PATH whose only entry is a file", request: { command: "ari-no-such-command" }, path: notExecutable },
    { name: "a path through a file", request: { command: path.join(notExecutable, "tool") } },
    { name: "a missing command in a cwd that does not exist", request: { command: "ari-no-such-command", cwd: missing } },
    { name: "a missing command in a cwd that is a file", request: { command: "ari-no-such-command", cwd: notExecutable } },
    { name: "a command with a NUL byte", request: { command: "ari-no\0such" } },
    { name: "a missing command with a NUL byte in an argument", request: { command: "ari-no-such-command", args: ["a\0b"] } },
    { name: "a missing command with a NUL byte in the environment", request: { command: "ari-no-such-command", env: { ARI_X: "a\0b" } } },
    { name: "a bare name longer than NAME_MAX", request: { command: "a".repeat(300) } },
    { name: "a cwd that is not a string", request: { command: "ari-no-such-command", cwd: 7 as unknown as string } },
  ];
  await recordingSpawns(async (spawned) => {
    for (const { name, request, path: searchPath } of cases) {
      const baseEnv = { PATH: searchPath ?? basePath };
      const service = createProcessService({ envPolicy: { stripAmbient: [] }, baseEnv });
      try {
        const expected = expectedFrom(await nodeSpawnError(request, { ...baseEnv, ...(request.env ?? {}) }));
        const error = await service.spawn(request).then(
          () => assert.fail(`${name}: the spawn started`),
          (rejection: unknown) => rejection,
        );
        assert.ok(isAriError(error), `${name}: rejected with ${String(error)}`);
        const reason = (error.callError as { reason?: string }).reason;
        assert.deepEqual({ code: error.code, ...(expected.reason === undefined ? {} : { reason }) }, expected, `${name}: ${error.message}`);
        assert.deepEqual(spawned, [], `${name}: nothing was spawned`);
      } finally {
        await service.dispose();
      }
    }
  });
});
