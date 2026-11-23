// Node helpers for conformance harnesses whose native agent is a real process
// or touches the real file system: a temporary workspace reached through a
// symbolic link, per-instance directories, a file watch for the probe
// scenario, and a `SpawnedProcess` view of a Node child process. Driver phases
// import these from their own harnesses.

import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConformanceWorkspace, InstanceFileWatch } from "../../src/conformance/index.ts";
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

/** Every file under `roots`, by path, as `size:mtimeMs`. */
function inventory(roots: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = fs.statSync(full);
        files.set(full, `${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  for (const root of roots) walk(root);
  return files;
}

/**
 * Watches the instance's three directories for the probe scenario. Each
 * directory under them gets its own non-recursive `fs.watch` (inotify on
 * Linux), because Node's recursive watch on Linux misses a file that is
 * written and deleted at once. A directory created during the watch is
 * reported, and watched from then on. `stop()` writes a sentinel file and
 * waits until the watch sees it, so every change made before the call has
 * arrived, then adds any file whose size or modification time differs from
 * an inventory taken at the start. The directories must exist before the
 * watch starts (`instanceDirectories` creates them).
 */
export async function watchInstanceFiles(paths: HostPaths): Promise<InstanceFileWatch> {
  const roots = [paths.stateDir, paths.cacheDir, paths.tmpDir];
  for (const root of roots) {
    if (!fs.existsSync(root)) throw new Error(`watchInstanceFiles needs ${root} to exist before it starts; create the instance's directories first`);
  }
  const before = inventory(roots);
  const touched = new Set<string>();
  const sentinelName = `.ari-conformance-watch-${process.pid}-${Math.random().toString(36).slice(2)}`;
  let sentinelSeen = false;
  const watchers = new Map<string, fs.FSWatcher>();

  const watchDirectory = (directory: string): void => {
    if (watchers.has(directory)) return;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(directory, (_event, name) => {
        if (name === null) {
          touched.add(directory);
          return;
        }
        const full = path.join(directory, name.toString());
        if (path.basename(full) === sentinelName) {
          sentinelSeen = true;
          return;
        }
        touched.add(full);
        let isDirectory = false;
        try {
          isDirectory = fs.statSync(full).isDirectory();
        } catch {
          // Gone again already: the change itself is what counts.
        }
        if (isDirectory) watchDirectory(full);
      });
    } catch {
      // The directory vanished between listing and watching: that is a change.
      touched.add(directory);
      return;
    }
    watcher.on("error", () => undefined);
    watchers.set(directory, watcher);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) watchDirectory(path.join(directory, entry.name));
    }
  };
  for (const root of roots) watchDirectory(root);

  return {
    async stop() {
      const sentinel = path.join(paths.tmpDir, sentinelName);
      fs.writeFileSync(sentinel, "");
      const deadline = Date.now() + 5000;
      while (!sentinelSeen && Date.now() < deadline) await sleep(2);
      fs.rmSync(sentinel, { force: true });
      for (const watcher of watchers.values()) watcher.close();
      if (!sentinelSeen) throw new Error("the file watch never saw its own sentinel file, so it cannot vouch for what it saw");
      const after = inventory(roots);
      for (const [file, key] of after) if (before.get(file) !== key) touched.add(file);
      for (const file of before.keys()) if (!after.has(file)) touched.add(file);
      return [...touched].sort();
    },
  };
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
