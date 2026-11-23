// Per-instance directories under one host root. Each instance gets
// `<root>/instances/<safe instance id>/{state,cache,tmp}`. The safe form of the
// instance ID is one-to-one and case-safe (see safe-name.ts), so two instance
// IDs never share or nest a directory. The root is kept as given (see
// os-path.ts); a relative root is taken from the current directory.

import * as fs from "node:fs/promises";
import type { HostPaths } from "../generated/host.ts";
import { appendToPath } from "./os-path.ts";
import { encodePathSegment } from "./safe-name.ts";

/** The `stateDir`, `cacheDir` and `tmpDir` of one instance under `hostRoot`. Creates nothing. */
export function instancePaths(hostRoot: string, instanceId: string): HostPaths {
  const instanceDir = appendToPath(hostRoot, ["instances", encodePathSegment(instanceId, "instanceId")]);
  return {
    stateDir: appendToPath(instanceDir, ["state"]),
    cacheDir: appendToPath(instanceDir, ["cache"]),
    tmpDir: appendToPath(instanceDir, ["tmp"]),
  };
}

/** Creates the three directories, readable only by the current user (mode 0700). */
export async function createInstanceDirectories(paths: HostPaths): Promise<void> {
  for (const directory of [paths.stateDir, paths.cacheDir, paths.tmpDir]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
  }
}
