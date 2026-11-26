// Process spawning for drivers.
//
// Environment: a child gets the base environment (by default `process.env`)
// minus every variable an `envPolicy.stripAmbient` rule matches, plus the
// request's explicit `env` additions, which are applied last and never
// stripped. A rule is an exact variable name, or a prefix when it ends in `*`.
//
// Process groups: on Linux and macOS each child starts as the leader of its
// own process group, so everything it starts can be ended together. Disposing
// the service, aborting its signal, a request's `timeoutMs`, and `kill()`
// without a signal all end the whole group: SIGTERM, then SIGKILL after
// `killGraceMs` for anything still running. When a child exits on its own, any
// process it left behind in its group is ended the same way. Windows has no
// process groups; there `taskkill /T` ends the child's process tree instead
// (not exercised by the test suite, which runs on Linux).
//
// When the owner dies: the process that created the service (the owner, for
// example `ari-driver`) may end without running any of that cleanup: SIGKILL,
// a crash, an out-of-memory kill, or a signal that skips `exit` listeners. On
// Linux and macOS every child's process group still ends within about
// `killGraceMs` plus a fraction of a second. Each child gets a guard: a
// `/bin/sh` process started right after the child, in a session of its own so
// no signal sent to the child's group or the owner's group reaches it. The
// guard blocks reading a pipe whose other end only the owner holds and never
// writes to. When the owner dies the operating system closes that end, the
// read ends, and the guard sends SIGTERM to the child's process group, waits
// up to `killGraceMs` for it to empty, sends SIGKILL to what is left, and
// exits. While the owner lives the guard only waits. Once the child's group is
// gone, the owner closes the pipe itself and the guard exits at once, so
// `dispose()` returns only after every guard is gone too. A guard shows in
// `ps` as `/bin/sh -c … ari-agent-guard <group id> <grace ms>`, and costs one
// idle shell per child. A child whose guard cannot start is ended at once and
// its spawn rejects.
//
// Disposal: a child is registered for cleanup in the same synchronous step
// that starts it, so `dispose()` always sees it and returns only once the
// process group of every child it spawned, and that child's guard, is gone.
//
// Output: `stdout` and `stderr` are pipes. Read both, or a child that writes a
// lot may block once a pipe buffer is full.

import { spawn as spawnChildProcess } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AriError } from "../ari-error.ts";
import { callErrors } from "../errors.ts";
import type { EnvPolicy, ProcessExit, SpawnRequest } from "../generated/host.ts";
import type { HostServices, SpawnedProcess } from "../runtime.ts";
import { appendToPath } from "./os-path.ts";

/** An environment such as `process.env`: names to values, where `undefined` means unset. */
export type Environment = { readonly [name: string]: string | undefined };

export const DEFAULT_KILL_GRACE_MS = 2000;

/** How long to wait for a process group to vanish after SIGKILL. */
const KILL_WAIT_MS = 5000;
const GROUP_POLL_MS = 20;
const MAX_TIMER_MS = 2 ** 31 - 1;

const isWindows = process.platform === "win32";

/** True when variable `name` matches `rule`: the same name, or a prefix when `rule` ends in `*`. Case-insensitive on Windows. */
export function matchesStripRule(name: string, rule: string): boolean {
  const comparableName = isWindows ? name.toUpperCase() : name;
  const comparableRule = isWindows ? rule.toUpperCase() : rule;
  if (comparableRule.endsWith("*")) return comparableName.startsWith(comparableRule.slice(0, -1));
  return comparableName === comparableRule;
}

/** The environment a child gets: `baseEnv` minus every variable `policy` strips, plus `additions`. */
export function buildChildEnvironment(
  baseEnv: Environment,
  policy: EnvPolicy,
  additions: { readonly [name: string]: string } = {},
): { [name: string]: string } {
  const environment: { [name: string]: string } = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (policy.stripAmbient.some((rule) => matchesStripRule(name, rule))) continue;
    environment[name] = value;
  }
  for (const [name, value] of Object.entries(additions)) environment[name] = value;
  return environment;
}

/** The value of variable `name`, matched case-insensitively on Windows. */
function environmentValue(environment: Environment, name: string): string | undefined {
  if (!isWindows) return environment[name];
  const match = Object.keys(environment).find((candidate) => candidate.toUpperCase() === name);
  return match === undefined ? undefined : environment[match];
}

/** The search path Node's spawn uses on Linux and macOS when the child environment has no PATH. */
const DEFAULT_SEARCH_PATH = "/usr/bin:/bin";

/** A regular file the current user may execute (on Windows: any file that is not a directory). */
async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const stats = await fs.stat(file);
    if (!stats.isFile()) return false;
    if (!isWindows) await fs.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExecutable(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The absolute path of the file Node's spawn runs for command `name`, or null
 * when spawn would find none. It repeats the search libuv (Node's process
 * layer) makes, so it names what spawn runs:
 *
 *   - A name with a directory part is not searched; it is relative to `cwd`.
 *   - Linux and macOS: the entries of `searchPath`, split on `:`, in order. An
 *     empty entry is `cwd` and a relative entry is relative to `cwd`. The
 *     first regular file the user may execute wins. Without a search path,
 *     spawn searches `/usr/bin:/bin`, and so does this.
 *   - Windows: `cwd` first (unless `NoDefaultCurrentDirectoryInExePath` is
 *     set), then the entries of `searchPath` split on `;`, with empty entries
 *     skipped and quotes removed. In each directory: the exact name when it
 *     has an extension, then the name plus `.com`, then plus `.exe`. The test
 *     suite runs on Linux and does not exercise this branch.
 *
 * `cwd` defaults to this process's current directory, which is where spawn
 * looks when a request has no `cwd`.
 *
 * On Linux and macOS each candidate is the entry and the name joined with
 * `/`, never normalized: `current/../bin` with `current` a symbolic link is
 * read by the operating system, as spawn's exec does, not collapsed to `bin`.
 * The returned path, run as a command, runs the same file spawn runs.
 */
export async function resolveExecutable(name: string, searchPath: string | undefined, cwd: string = process.cwd()): Promise<string | null> {
  if (typeof name !== "string" || name === "") return null;
  if (!isWindows) {
    if (name.includes("/")) return firstExecutable([appendToPath(name, [], cwd)]);
    const entries = (searchPath ?? DEFAULT_SEARCH_PATH).split(":");
    return firstExecutable(entries.map((entry) => appendToPath(entry, [name], cwd)));
  }
  // Windows collapses `..` in a path string itself, so `path.resolve` names the same file libuv's search tries.
  const withExtensions = (base: string): string[] => {
    // libuv counts a name as having an extension when any `.` in it is followed by a character.
    const hasExtension = /\.[\s\S]/.test(path.win32.basename(base));
    return [...(hasExtension ? [base] : []), `${base}.com`, `${base}.exe`];
  };
  if (/[\\/:]/.test(name)) return firstExecutable(withExtensions(path.resolve(cwd, name)));
  const directories = (searchPath ?? "")
    .split(";")
    .map((entry) => entry.replace(/^["']|["']$/g, ""))
    .filter((entry) => entry !== "");
  if (process.env.NoDefaultCurrentDirectoryInExePath === undefined) directories.unshift(cwd);
  return firstExecutable(directories.flatMap((directory) => withExtensions(path.resolve(cwd, directory, name))));
}

/** Sends `signal` to process group `groupId`. False when the group no longer exists. */
function signalGroup(groupId: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM: a member exists that this user may not signal.
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForGroupExit(groupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!signalGroup(groupId, 0)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(GROUP_POLL_MS);
  }
}

/** Ends a whole process group: SIGTERM, then SIGKILL after `graceMs`. Resolves once the group is gone, or 5 s after SIGKILL. */
async function terminateGroup(groupId: number, graceMs: number): Promise<void> {
  if (!signalGroup(groupId, "SIGTERM")) return;
  if (await waitForGroupExit(groupId, graceMs)) return;
  signalGroup(groupId, "SIGKILL");
  await waitForGroupExit(groupId, KILL_WAIT_MS);
}

/** Windows has no process groups: `taskkill /T` ends a process and every process it started. */
async function terminateTreeOnWindows(pid: number): Promise<void> {
  const killer = spawnChildProcess("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve) => {
    killer.once("exit", () => resolve());
    killer.once("error", () => resolve());
  });
}

/** True when `promise` settles within `ms`. The timer keeps the event loop alive while it waits. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// The guard's program, run as `/bin/sh -c GUARD_SCRIPT ari-agent-guard <group
// id> <grace ms>` with its stdin the pipe only the owner holds. `read` returns
// only at end-of-file, since the owner never writes. Then: SIGTERM to the
// group (nothing to do if it is already gone), poll every 0.1 s until the
// group is empty, and SIGKILL it once the grace has passed. POSIX sh only, so
// it runs under bash, dash and macOS's sh alike.
const GUARD_SCRIPT = [
  "while read -r _; do :; done",
  'kill -s TERM -- "-$1" 2>/dev/null || exit 0',
  "waited=0",
  'while kill -s 0 -- "-$1" 2>/dev/null; do if [ "$waited" -ge "$2" ]; then kill -s KILL -- "-$1" 2>/dev/null; exit 0; fi; sleep 0.1; waited=$((waited + 100)); done',
].join("; ");

/** The guard's `$0`, which `ps` shows. */
const GUARD_NAME = "ari-agent-guard";

interface Guard {
  /** Closes the owner's end of the pipe and resolves once the guard has exited. Call it only once the child's group is gone. */
  release(): Promise<void>;
}

/** Starts the guard of process group `groupId`, or returns undefined when `/bin/sh` cannot start. */
function startGuard(groupId: number, graceMs: number): Guard | undefined {
  let guard: ChildProcess;
  try {
    guard = spawnChildProcess("/bin/sh", ["-c", GUARD_SCRIPT, GUARD_NAME, String(groupId), String(graceMs)], {
      stdio: ["pipe", "ignore", "ignore"],
      // A session of its own: signals sent to the child's group, or to the owner's group, never reach it.
      detached: true,
      cwd: "/",
      // The guard needs only `sleep`. It gets nothing else of the owner's environment.
      env: { PATH: ["/usr/bin", "/bin", process.env.PATH].filter((entry) => entry !== undefined && entry !== "").join(":") },
    });
  } catch {
    return undefined;
  }
  guard.on("error", () => {});
  if (guard.pid === undefined || guard.stdin === null) return undefined;
  const pipe = guard.stdin;
  pipe.on("error", () => {});
  const exited = new Promise<void>((resolve) => {
    if (guard.exitCode !== null || guard.signalCode !== null) resolve();
    else guard.once("exit", () => resolve());
  });
  let released: Promise<void> | undefined;
  return {
    release: () =>
      (released ??= (async () => {
        // End-of-file for the guard: it finds the group gone and exits.
        pipe.destroy();
        if (await settlesWithin(exited, KILL_WAIT_MS)) return;
        guard.kill("SIGKILL");
        await settlesWithin(exited, KILL_WAIT_MS);
      })()),
  };
}

// Process groups still running in this host process. When the host process
// exits without disposing its services, they get SIGKILL on the way out, so a
// host that forgets to dispose does not leave agents running. Signals that end
// the host without running `exit` listeners (an unhandled SIGINT, SIGKILL)
// skip this; each child's guard ends its group then.
const runningGroups = new Set<number>();
let exitListenerInstalled = false;

function killRunningGroupsOnExit(): void {
  for (const groupId of runningGroups) signalGroup(groupId, "SIGKILL");
}

function rememberRunningGroup(groupId: number): void {
  runningGroups.add(groupId);
  if (exitListenerInstalled) return;
  exitListenerInstalled = true;
  process.once("exit", killRunningGroupsOnExit);
}

function spawnFailure(command: string, error: NodeJS.ErrnoException): AriError {
  if (typeof error.code === "string" && error.code.startsWith("ERR_INVALID_ARG")) {
    return callErrors.validation([{ path: ["command"], message: error.message }], `Cannot spawn ${command}: ${error.message}`);
  }
  if (error.code === "ENOENT") {
    return callErrors.notFound({
      resource: "executable",
      id: command,
      message: `Cannot spawn ${command}: the executable or the working directory does not exist`,
    });
  }
  if (error.code === "EACCES" || error.code === "EPERM") return callErrors.permissionDenied(`Cannot spawn ${command}: permission denied`);
  return callErrors.invalidState("spawn_failed", `Cannot spawn ${command}: ${error.message}`);
}

export interface ProcessServiceOptions {
  envPolicy: EnvPolicy;
  /** The environment children start from, before stripping. Defaults to `process.env`. */
  baseEnv?: Environment;
  /** Aborting it disposes the service. */
  signal?: AbortSignal;
  /** How long a process group gets after SIGTERM before SIGKILL. Defaults to 2000 ms. */
  killGraceMs?: number;
}

export type ProcessService = HostServices["process"] & {
  /**
   * Ends the process group of every child still running and of every child
   * whose leftovers are being cleaned up, and resolves when they are gone.
   * Later spawns reject with `invalid_state`.
   */
  dispose(): Promise<void>;
};

export function createProcessService(options: ProcessServiceOptions): ProcessService {
  const envPolicy: EnvPolicy = { stripAmbient: [...options.envPolicy.stripAmbient] };
  const baseEnv = options.baseEnv ?? process.env;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const terminators = new Set<() => Promise<void>>();
  const pendingCleanups = new Set<Promise<void>>();
  let disposed = false;

  const track = (cleanup: Promise<void>): Promise<void> => {
    pendingCleanups.add(cleanup);
    void cleanup.finally(() => pendingCleanups.delete(cleanup));
    return cleanup;
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    options.signal?.removeEventListener("abort", onAbort);
    for (const terminate of terminators) track(terminate());
    while (pendingCleanups.size > 0) await Promise.all([...pendingCleanups]);
  };

  function onAbort(): void {
    void dispose();
  }
  if (options.signal?.aborted === true) disposed = true;
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    envPolicy,

    /** Searches the given `path`, or else the PATH a child would get, the way `spawn` does for a request without `cwd`. */
    async resolveExecutable(name, resolveOptions) {
      const childPath = environmentValue(buildChildEnvironment(baseEnv, envPolicy), "PATH");
      // On Windows, spawn falls back to this process's own PATH when the child environment has none.
      const searchPath = resolveOptions?.path ?? childPath ?? (isWindows ? environmentValue(process.env, "PATH") : undefined);
      return resolveExecutable(name, searchPath);
    },

    async spawn(request: SpawnRequest): Promise<SpawnedProcess> {
      if (disposed) throw callErrors.invalidState("disposed", "The process service is disposed");
      if (typeof request?.command !== "string" || request.command === "") {
        throw callErrors.validation([{ path: ["command"], message: "must be a non-empty string" }], "Invalid spawn request: no command");
      }
      if (request.stdin !== undefined && request.stdin !== "pipe" && request.stdin !== "ignore") {
        throw callErrors.validation([{ path: ["stdin"], message: 'must be "pipe" or "ignore"' }], `Invalid spawn request: stdin "${request.stdin}"`);
      }
      const stdinMode: "pipe" | "ignore" = request.stdin === "ignore" ? "ignore" : "pipe";
      if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 0)) {
        throw callErrors.validation([{ path: ["timeoutMs"], message: "must be a non-negative integer" }], "Invalid spawn request: timeoutMs");
      }

      const stdio: StdioOptions = [stdinMode, "pipe", "pipe"];
      let child: ChildProcess;
      try {
        child = spawnChildProcess(request.command, request.args ?? [], {
          cwd: request.cwd,
          env: buildChildEnvironment(baseEnv, envPolicy, request.env ?? {}),
          stdio,
          detached: !isWindows,
          windowsHide: true,
        });
      } catch (error) {
        throw spawnFailure(request.command, error as NodeJS.ErrnoException);
      }
      // Node sets `pid` only when the process started; otherwise it emits 'error' on the next tick.
      if (child.pid === undefined) {
        const failure = await new Promise<NodeJS.ErrnoException>((resolve) => child.once("error", resolve));
        throw spawnFailure(request.command, failure);
      }
      // From here to `return` nothing awaits, so the child is registered for
      // cleanup before `dispose()` can run. Later 'error' events only report a
      // failed kill, which the group signals make moot; a write to a closed
      // stdin is reported by `write()` instead.
      child.on("error", () => {});
      child.stdin?.on("error", () => {});
      const pid = child.pid;
      const exited = new Promise<ProcessExit>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      const isRunning = (): boolean => child.exitCode === null && child.signalCode === null;

      // Ends the child's group if this process dies without cleaning up. A child that cannot be guarded does not run.
      const guard = isWindows ? undefined : startGuard(pid, killGraceMs);
      if (!isWindows && guard === undefined) {
        signalGroup(pid, "SIGKILL");
        throw callErrors.invalidState("spawn_failed", `Cannot spawn ${request.command}: /bin/sh did not start the guard that ends its process group if this process dies`);
      }
      const releaseGuard = async (): Promise<void> => {
        await guard?.release();
      };

      const terminate = async (): Promise<void> => {
        if (isWindows) {
          if (isRunning()) await terminateTreeOnWindows(pid);
          return;
        }
        await terminateGroup(pid, killGraceMs);
        await releaseGuard();
      };
      terminators.add(terminate);
      if (!isWindows) rememberRunningGroup(pid);

      // Timers cannot wait longer than 2^31 - 1 ms; a longer timeout waits that long.
      const timeoutTimer =
        request.timeoutMs === undefined ? undefined : setTimeout(() => void track(terminate()), Math.min(request.timeoutMs, MAX_TIMER_MS));
      void exited.then(() => {
        clearTimeout(timeoutTimer);
        terminators.delete(terminate);
        if (isWindows) return;
        // End anything the child left behind in its group, forget the group, then let its guard go.
        void track(
          terminateGroup(pid, killGraceMs)
            .finally(() => runningGroups.delete(pid))
            .then(releaseGuard),
        );
      });

      return {
        pid,
        stdout: child.stdout!,
        stderr: child.stderr!,
        exited,

        async write(data) {
          const stdin = child.stdin;
          if (stdin === null) throw callErrors.invalidState("stdin_ignored", "The process was spawned with stdin ignored");
          await new Promise<void>((resolve, reject) => {
            stdin.write(data, (error) => {
              if (error) reject(callErrors.transport(`Cannot write to ${request.command}: ${error.message}`));
              else resolve();
            });
          });
        },

        async closeStdin() {
          const stdin = child.stdin;
          if (stdin === null || stdin.writableEnded || stdin.destroyed) return;
          await new Promise<void>((resolve) => stdin.end(() => resolve()));
        },

        /** Without a signal, ends the whole process group and resolves when it is gone. With one, sends it to the group. */
        async kill(signal) {
          if (signal === undefined) {
            await track(terminate());
            return;
          }
          try {
            if (isWindows) child.kill(signal as NodeJS.Signals);
            else signalGroup(pid, signal as NodeJS.Signals);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ERR_UNKNOWN_SIGNAL") {
              throw callErrors.validation([{ path: ["signal"], message: "is not a known signal" }], `Unknown signal ${signal}`);
            }
            throw error;
          }
        },
      };
    },

    dispose,
  };
}
