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

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const stats = await fs.stat(file);
    if (!stats.isFile()) return false;
    await fs.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The absolute path of executable `name`, or null when there is none. A name
 * with a directory part is checked as a path; a bare name is looked up in
 * each directory of `searchPath` (a PATH-style list) in order. On Windows each
 * candidate is also tried with every extension in `pathExtensions` (PATHEXT).
 */
export async function resolveExecutable(name: string, searchPath: string | undefined, pathExtensions?: string): Promise<string | null> {
  if (typeof name !== "string" || name === "") return null;
  const extensions = isWindows ? ["", ...(pathExtensions ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((extension) => extension !== "")] : [""];
  const hasDirectoryPart = name.includes("/") || (isWindows && name.includes("\\"));
  const bases = hasDirectoryPart
    ? [path.resolve(name)]
    : (searchPath ?? "")
        .split(path.delimiter)
        .filter((directory) => directory !== "")
        .map((directory) => path.resolve(directory, name));
  for (const base of bases) {
    for (const extension of extensions) {
      if (await isExecutableFile(base + extension)) return base + extension;
    }
  }
  return null;
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

// Process groups still running in this host process. When the host process
// exits without disposing its services, they get SIGKILL on the way out, so a
// host that forgets to dispose does not leave agents running. Signals that end
// the host without running `exit` listeners (an unhandled SIGINT, SIGKILL)
// skip this; hosts should dispose on shutdown.
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

    async resolveExecutable(name, resolveOptions) {
      const childEnvironment = buildChildEnvironment(baseEnv, envPolicy);
      return resolveExecutable(name, resolveOptions?.path ?? environmentValue(childEnvironment, "PATH"), environmentValue(childEnvironment, "PATHEXT"));
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
      const child: ChildProcess = spawnChildProcess(request.command, request.args ?? [], {
        cwd: request.cwd,
        env: buildChildEnvironment(baseEnv, envPolicy, request.env ?? {}),
        stdio,
        detached: !isWindows,
        windowsHide: true,
      });
      const exited = new Promise<ProcessExit>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
      } catch (error) {
        throw spawnFailure(request.command, error as NodeJS.ErrnoException);
      }
      // After a successful spawn, 'error' only reports a failed kill, which the
      // group signals below make moot; a write to a closed stdin is reported
      // by `write()` instead.
      child.on("error", () => {});
      child.stdin?.on("error", () => {});
      const pid = child.pid as number;
      const isRunning = (): boolean => child.exitCode === null && child.signalCode === null;

      const terminate = async (): Promise<void> => {
        if (isWindows) {
          if (isRunning()) await terminateTreeOnWindows(pid);
          return;
        }
        await terminateGroup(pid, killGraceMs);
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
        // End anything the child left behind in its group, then forget the group.
        void track(terminateGroup(pid, killGraceMs).finally(() => runningGroups.delete(pid)));
      });

      // The service was disposed while this child was starting: it must not outlive the disposal.
      if (disposed) {
        await track(terminate());
        throw callErrors.invalidState("disposed", "The process service was disposed while the process started");
      }

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
