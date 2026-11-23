// Node helpers for conformance harnesses whose native agent is a real process
// or touches the real file system: a temporary workspace reached through a
// symbolic link, per-instance directories, a file lister for the probe
// scenario, and a `SpawnedProcess` view of a Node child process. Driver phases
// import these from their own harnesses.

import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ConformanceWorkspace, InstanceFile } from "../../src/conformance/index.ts";
import type { HostPaths, ProcessExit, SpawnedProcess } from "../../src/index.ts";

/** A real workspace directory, a symbolic link to it, and a second directory. Call `cleanup` when done. */
export function createConformanceWorkspace(prefix = "ari-conformance-"): { workspace: ConformanceWorkspace; root: string; cleanup: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const project = path.join(root, "project");
  const other = path.join(root, "other");
  const link = path.join(root, "link-to-project");
  fs.mkdirSync(project);
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(project, "README.md"), "# Workspace\n");
  fs.symlinkSync(project, link, "dir");
  return {
    workspace: { cwd: project, symlinkedCwd: link, otherCwd: other },
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Creates `<root>/instances/<instanceId>/{state,cache,tmp}` and returns them as host paths. */
export function instanceDirectories(root: string, instanceId: string): HostPaths {
  const base = path.join(root, "instances", encodeURIComponent(instanceId));
  const paths = { stateDir: path.join(base, "state"), cacheDir: path.join(base, "cache"), tmpDir: path.join(base, "tmp") };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return paths;
}

/** Every file under the instance's paths, with its size and modification time. */
export async function listInstanceFiles(paths: HostPaths): Promise<InstanceFile[]> {
  const files: InstanceFile[] = [];
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = fs.statSync(full);
        files.push({ path: full, size: stat.size, modifiedMs: stat.mtimeMs });
      }
    }
  };
  for (const directory of [paths.stateDir, paths.cacheDir, paths.tmpDir]) walk(directory);
  return files;
}

/** A `SpawnedProcess` over a Node child started with piped stdio. */
export function toSpawnedProcess(child: ChildProcess): SpawnedProcess {
  const exited = new Promise<ProcessExit>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const stdin = child.stdin;
  stdin?.on("error", () => undefined);
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    stdout: child.stdout!,
    stderr: child.stderr!,
    write: (data) =>
      new Promise((resolve, reject) => {
        if (stdin === null) {
          reject(new Error("the process was started without a stdin pipe"));
          return;
        }
        stdin.write(data, (error) => (error === null || error === undefined ? resolve() : reject(error)));
      }),
    closeStdin: async () => {
      stdin?.end();
    },
    kill: async (signal) => {
      if (child.exitCode === null && child.signalCode === null) child.kill((signal ?? "SIGTERM") as NodeJS.Signals);
    },
    exited,
  };
}
