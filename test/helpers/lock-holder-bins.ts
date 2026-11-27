// PATH folders for tests of the recorders' flock(2) lock holder
// (test/recordings/flock.ts). A test that puts only these on PATH controls
// exactly which programs the holder and a fake agent can run, and reaches no
// vendor program.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { NODE_EXECUTABLE } from "./runtime.ts";

/** Where `program` is on this process's PATH. */
function systemProgram(program: string): string {
  for (const folder of (process.env["PATH"] ?? "").split(path.delimiter)) {
    const candidate = path.join(folder, program);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this folder.
    }
  }
  throw new Error(`${program} is not on PATH`);
}

/** The Node binary itself, not a version manager's shim: a shim does not run under a test's temp HOME. */
function realNode(): string {
  const run = spawnSync(NODE_EXECUTABLE, ["-p", "process.execPath"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`could not find the Node binary: ${run.stderr}`);
  return run.stdout.trim();
}

/**
 * A new folder in `directory` with links to the system's `flock` and `sh`,
 * and to the Node binary, which a fake `agy` under Bun starts from PATH.
 * Nothing else is in it: no `cat`, no `sleep`, no vendor program.
 */
export function lockHolderBin(directory: string): string {
  const bin = fs.mkdtempSync(path.join(directory, "holder-bin-"));
  for (const program of ["flock", "sh"]) fs.symlinkSync(systemProgram(program), path.join(bin, program));
  fs.symlinkSync(realNode(), path.join(bin, "node"));
  return bin;
}

/**
 * A new folder in `directory` whose `sh` stands in for a lock holder that
 * ends on its own. `flock` runs it in place of the shell, once it took the
 * lock. It says `held` at once, without reading what the recorder sent, and
 * ends 0.5 s later without being told to let go. Put it on PATH before
 * lockHolderBin's folder.
 */
export function dyingHolderBin(directory: string): string {
  const bin = fs.mkdtempSync(path.join(directory, "dying-holder-"));
  fs.writeFileSync(path.join(bin, "sh"), `#!${systemProgram("sh")}\necho held\nexec ${systemProgram("sleep")} 0.5\n`, { mode: 0o755 });
  return bin;
}
