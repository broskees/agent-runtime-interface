// Process spawning for drivers.
//
// Environment: a child gets the base environment (by default `process.env`)
// minus every variable an `envPolicy.stripAmbient` rule matches, plus the
// request's explicit `env` additions, which are applied last and never
// stripped. A rule is an exact variable name, or a prefix when it ends in `*`.
//
// Process groups: on Linux and macOS each child starts as the leader of its
// own process group, so everything it starts in that group can be ended
// together. Disposing the service, aborting its signal, a request's
// `timeoutMs`, `kill()` without a signal, and the child exiting on its own all
// end the whole group: SIGTERM, then SIGKILL after `killGraceMs` for anything
// still running. Windows has no process groups; there `taskkill /T` ends the
// child's process tree instead, and only while this process lives (not
// exercised by the test suite, which runs on Linux).
//
// The guard: on Linux and macOS every child's group holds a guard, a small
// `/bin/sh` that ends the group when this process (the owner, for example
// `ari-driver`) dies for any reason: SIGKILL, a crash, an out-of-memory kill.
// The child is spawned through a `/bin/sh` launcher that starts the guard in
// the background, in the same process group (stdio on /dev/null, holding only
// the read end of a pipe whose other end the owner holds), and then `exec`s
// the child in its own place, so the child keeps the pid Node reports and
// never runs before its guard exists. The pipe is passed at spawn, so an owner
// that dies before the guard starts still leaves it an immediate end-of-file.
//
// The guard ignores SIGTERM, SIGHUP, SIGINT (and SIGQUIT, SIGPIPE, SIGALRM,
// SIGUSR1, SIGUSR2), so a driver's own signal to the group reaches the child
// but not the guard. It waits on the pipe. When the owner dies, or the owner
// writes a line to ask for the group to end, the guard sends SIGTERM to its
// own group (`kill 0`), waits until no member but itself is left or
// `killGraceMs` has passed, sends SIGKILL to the group, and exits. It never
// signals by a number: it signals the group it is a member of, and while it
// is a member, that group id cannot be given to anyone else. Membership is
// read with `ps -A -o pid= -o ppid= -o pgid=` and `awk`; if they are
// missing, the guard waits the whole grace.
//
// The owner ends a group the same way: it writes a line to the guard's pipe
// and waits for the guard to exit (the pipe's end-of-file), so cleanup does not
// wait a whole grace when the group empties sooner. A guard shows in `ps` as
// `/bin/sh -c … ari-agent-guard <grace ms> …`, and costs one idle shell per
// child. If the launcher cannot start the guard, the child never runs: it
// exits with code 126.
//
// What the launcher keeps as it was, and what it does not: spawn errors (a
// missing or non-executable command, a missing `cwd`) reject as before,
// because the command is searched for first, the way spawn searches, and a
// command that is not found is handed to spawn itself for the platform's own
// error. The child's argv is the one spawn would give it, except that with no
// PATH in the child's environment a bare command name is run by its full path
// (argv[0] is that path), and for its first few milliseconds the pid shows the
// launcher's command line, until the launcher `exec`s the child. `PWD` and `OLDPWD` are put back as the child's
// environment had them. With bash as `/bin/sh`, an environment without `SHLVL`
// gains `SHLVL=0`. A file the user may execute that is not a program (no `#!`
// line) is run by `/bin/sh` instead of failing with ENOEXEC.
//
// Not reached: a process that leaves the child's group (`setsid`, `setpgid`)
// is outside the group, and nothing here ends it.
//
// Disposal: a child is registered for cleanup in the same synchronous step
// that starts it, so `dispose()` always sees it and returns only once every
// child's guard has ended its group and exited.
//
// Output: `stdout` and `stderr` are pipes. Read both, or a child that writes a
// lot may block once a pipe buffer is full.

import { spawn as spawnChildProcess } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import * as fs from "node:fs";
import { constants as osConstants } from "node:os";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import type { AriError } from "../ari-error.ts";
import { callErrors } from "../errors.ts";
import type { EnvPolicy, ProcessExit, SpawnRequest } from "../generated/host.ts";
import type { HostServices, SpawnedProcess } from "../runtime.ts";
import { appendToPath } from "./os-path.ts";

/** An environment such as `process.env`: names to values, where `undefined` means unset. */
export type Environment = { readonly [name: string]: string | undefined };

export const DEFAULT_KILL_GRACE_MS = 2000;

/** How long to wait after the guard should have finished, or after SIGKILL, before giving up. */
const KILL_WAIT_MS = 5000;
const GROUP_POLL_MS = 10;
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
function isExecutableFile(file: string): boolean {
  try {
    const stats = fs.statSync(file);
    if (!stats.isFile()) return false;
    if (!isWindows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstExecutable(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
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
  return findExecutable(name, searchPath, cwd);
}

/** `resolveExecutable` without waiting: `spawn` searches before it starts anything, in the same synchronous step. */
function findExecutable(name: string, searchPath: string | undefined, cwd: string): string | null {
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
/**
 * Sends `signal` to process group `groupId`. False when the group no longer
 * exists. Call it only while the group's guard runs: the guard's membership
 * is what keeps the id from naming another group.
 */
function signalGroup(groupId: number, signal: NodeJS.Signals): boolean {
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

/**
 * Resolves once process group `groupId` is gone, or after `timeoutMs`. It
 * probes with signal 0, which delivers nothing, so it can never harm another
 * group. It waits out members that have exited but are not reaped yet: a
 * guard is reaped by the system's reaper, not by this process.
 */
async function groupGone(groupId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-groupId, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
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

// The launcher, run as `/bin/sh -c LAUNCH_SCRIPT ari-agent-launch GUARD_SCRIPT
// <grace ms> COUNT_OTHERS <command> <args...>` with fd 3 the guard's pipe. It
// starts the guard in the background, in its own process group (no job
// control, so a background job stays in the group); the inner `&` inside
// `( … )` leaves the guard without the child as its parent. If that fails,
// the child never runs. It then gives the child back the PWD and OLDPWD it
// should see (bash resets them at start-up), and `exec`s the child, which
// keeps the launcher's pid and does not get fd 3.
const LAUNCH_SCRIPT = [
  '( /bin/sh -c "$1" ari-agent-guard "$2" "$3" </dev/null >/dev/null 2>&1 & ) || exit 126',
  "shift 3",
  'if [ "${__ARI_LAUNCH_PWD+set}" = set ]; then PWD=$__ARI_LAUNCH_PWD; export PWD; else unset PWD; fi',
  'if [ "${__ARI_LAUNCH_OLDPWD+set}" = set ]; then OLDPWD=$__ARI_LAUNCH_OLDPWD; export OLDPWD; else unset OLDPWD; fi',
  "unset __ARI_LAUNCH_PWD __ARI_LAUNCH_OLDPWD",
  'exec "$@" 3<&-',
].join("; ");

// The guard, run as `/bin/sh -c GUARD_SCRIPT ari-agent-guard <grace ms>
// COUNT_OTHERS` inside the child's process group, with fd 3 the pipe. `read`
// returns when the owner writes a line or dies. Then: SIGTERM to its own group
// (`kill 0`), and checks at 20, 60, 140, 300, 620 ms and then every 400 ms until
// the grace has passed: when no member but itself is left it exits, else at
// the end it sends SIGKILL to its own group, itself included. POSIX sh, ps and
// awk only, so it runs under bash, dash and macOS's sh alike.
const GUARD_SCRIPT = [
  "set +eu",
  "trap '' HUP INT QUIT PIPE ALRM TERM USR1 USR2",
  'PATH="/usr/bin:/bin${PATH:+:$PATH}"',
  "LC_ALL=C",
  "export LC_ALL",
  "unset PS_PERSONALITY CMD_ENV",
  "read -r _ <&3",
  "kill -s TERM 0",
  "waited=0",
  "step=20",
  `while [ "$waited" -lt "$1" ]; do ${[
    'if [ $((waited + step)) -gt "$1" ]; then step=$(($1 - waited)); fi',
    'sleep "$(printf %d.%03d $((step / 1000)) $((step % 1000)))"',
    "waited=$((waited + step))",
    'if [ "$(ps -A -o pid= -o ppid= -o pgid= 2>/dev/null | awk -v me="$$" "$2")" = 0 ]; then exit 0; fi',
    "if [ $step -lt 400 ]; then step=$((step * 2)); fi",
  ].join("; ")}; done`,
  "kill -s KILL 0",
].join("; ");

// The awk program the guard runs over `ps -A -o pid= -o ppid= -o pgid=`. It
// prints how many members of the guard's group are left besides the guard
// itself and the processes it runs to look (its children and theirs: the
// command substitution's subshell, ps, awk). It prints nothing when the
// guard's own line is missing, which the guard reads as "not alone".
const COUNT_OTHERS = [
  "{ pid[NR] = $1; ppid[NR] = $2; pgid[NR] = $3; if ($1 == me) mine = $3; if ($2 == me) helper[$1] = 1 }",
  'END { if (mine == "") exit; n = 0; for (i = 1; i <= NR; i++) if (pgid[i] == mine && pid[i] != me && ppid[i] != me && !(ppid[i] in helper)) n++; print n }',
].join(" ");

const LAUNCHER_NAME = "ari-agent-launch";

/**
 * The word the launcher `exec`s for `command`, found at `executable`. A command
 * with a `/` runs as given (relative to the child's cwd, as spawn runs it); a
 * bare name runs by name, so argv[0] is the name and the shell searches the
 * same PATH spawn would. Without a PATH (the shell would search its own
 * default, not spawn's), or with a leading `-` (which `exec` would read as an
 * option), it runs by the full path the search found.
 */
function launchTarget(command: string, executable: string, searchPath: string | undefined): string {
  if (command.startsWith("-")) return executable;
  if (command.includes("/")) return command;
  return searchPath === undefined ? executable : command;
}

/** The launcher's environment: the child's, plus what it needs to give the child back PWD and OLDPWD exactly. */
function launcherEnvironment(environment: { readonly [name: string]: string }): { [name: string]: string } {
  const launcher: { [name: string]: string } = { ...environment };
  if (environment.PWD !== undefined) launcher.__ARI_LAUNCH_PWD = environment.PWD;
  if (environment.OLDPWD !== undefined) launcher.__ARI_LAUNCH_OLDPWD = environment.OLDPWD;
  return launcher;
}

/** The owner's end of a guard's pipe. */
interface GuardPipe {
  /** True until the guard has exited (the pipe's other end closed). */
  readonly running: boolean;
  /** Resolves once the guard has exited. */
  readonly gone: Promise<void>;
  /** Asks the guard to end its group: SIGTERM, then SIGKILL after the grace. */
  endGroup(): void;
}

function watchGuardPipe(pipe: Duplex): GuardPipe {
  let running = true;
  let markGone: () => void = () => undefined;
  const gone = new Promise<void>((resolve) => {
    markGone = resolve;
  });
  const finish = (): void => {
    running = false;
    markGone();
  };
  pipe.on("error", () => {});
  pipe.once("end", finish);
  pipe.once("close", finish);
  // Read (the guard never writes), so the guard's end-of-file is seen.
  pipe.resume();
  return {
    get running() {
      return running;
    },
    gone,
    endGroup() {
      if (running && !pipe.destroyed && pipe.writable) pipe.write("\n");
    },
  };
}

// Process groups still running in this host process, with whether their guard
// still runs. When the host process exits without disposing its services, the
// groups get SIGKILL on the way out, so a host that forgets to dispose does
// not leave agents running. Signals that end the host without running `exit`
// listeners (an unhandled SIGINT, SIGKILL) skip this; the guards end the
// groups then.
const runningGroups = new Map<number, () => boolean>();
let exitListenerInstalled = false;

function killRunningGroupsOnExit(): void {
  for (const [groupId, guardRunning] of runningGroups) {
    if (guardRunning()) signalGroup(groupId, "SIGKILL");
  }
}

function rememberRunningGroup(groupId: number, guardRunning: () => boolean): void {
  runningGroups.set(groupId, guardRunning);
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

/**
 * Why `request` cannot run, as spawn itself reports it: the search found no
 * command (or the request has a malformed `cwd`), so spawn is asked directly
 * and its error is the one callers have always seen. Should spawn start
 * something after all (the file appeared in between), that process is ended
 * at once: it ran without a guard.
 */
async function directSpawnFailure(request: SpawnRequest, environment: { readonly [name: string]: string }): Promise<AriError> {
  let probe: ChildProcess;
  try {
    probe = spawnChildProcess(request.command, request.args ?? [], { cwd: request.cwd, env: environment, stdio: "ignore", detached: true });
  } catch (error) {
    return spawnFailure(request.command, error as NodeJS.ErrnoException);
  }
  if (probe.pid === undefined) return spawnFailure(request.command, await new Promise<NodeJS.ErrnoException>((resolve) => probe.once("error", resolve)));
  probe.on("error", () => {});
  // It is this process's own child and not reaped yet, so its group id is still its own.
  try {
    process.kill(-probe.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  return callErrors.invalidState("spawn_failed", `Cannot spawn ${request.command}: it was not found when searched for, but appeared when spawned`);
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
   * whose leftovers are being cleaned up, and resolves when they and their
   * guards are gone. Later spawns reject with `invalid_state`.
   */
  dispose(): Promise<void>;
};

export function createProcessService(options: ProcessServiceOptions): ProcessService {
  const envPolicy: EnvPolicy = { stripAmbient: [...options.envPolicy.stripAmbient] };
  const baseEnv = options.baseEnv ?? process.env;
  const killGraceMs = Math.max(0, Math.round(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
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

  /**
   * Starts `request` on Linux and macOS: searched for first, then through the
   * launcher, with its guard. It does not wait on the way to a started child,
   * so the caller can register the child before a `dispose()` runs; only a
   * failure is waited for.
   */
  const launch = (
    request: SpawnRequest,
    environment: { [name: string]: string },
    stdinMode: "pipe" | "ignore",
  ): { readonly child: ChildProcess } | { readonly failure: Promise<AriError> } => {
    if (request.cwd !== undefined && typeof request.cwd !== "string") return { failure: directSpawnFailure(request, environment) };
    // Search where spawn would: relative entries and names against the child's cwd.
    const searchCwd = request.cwd === undefined ? process.cwd() : appendToPath(request.cwd, [], process.cwd());
    const searchPath = environment.PATH;
    const executable = findExecutable(request.command, searchPath, searchCwd);
    if (executable === null) return { failure: directSpawnFailure(request, environment) };
    const launcherArgs = ["-c", LAUNCH_SCRIPT, LAUNCHER_NAME, GUARD_SCRIPT, String(killGraceMs), COUNT_OTHERS];
    try {
      const child = spawnChildProcess("/bin/sh", [...launcherArgs, launchTarget(request.command, executable, searchPath), ...(request.args ?? [])], {
        cwd: request.cwd,
        env: launcherEnvironment(environment),
        stdio: [stdinMode, "pipe", "pipe", "pipe"],
        detached: true,
      });
      return { child };
    } catch (error) {
      return { failure: Promise.resolve(spawnFailure(request.command, error as NodeJS.ErrnoException)) };
    }
  };

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

      const environment = buildChildEnvironment(baseEnv, envPolicy, request.env ?? {});
      let child: ChildProcess;
      if (isWindows) {
        try {
          child = spawnChildProcess(request.command, request.args ?? [], {
            cwd: request.cwd,
            env: environment,
            stdio: [stdinMode, "pipe", "pipe"] satisfies StdioOptions,
            windowsHide: true,
          });
        } catch (error) {
          throw spawnFailure(request.command, error as NodeJS.ErrnoException);
        }
      } else {
        const launched = launch(request, environment, stdinMode);
        if ("failure" in launched) throw await launched.failure;
        child = launched.child;
      }
      // Node sets `pid` only when the process started; otherwise it emits 'error' on the next tick.
      if (child.pid === undefined) {
        const failure = await new Promise<NodeJS.ErrnoException>((resolve) => child.once("error", resolve));
        throw spawnFailure(request.command, failure);
      }
      // From here to `return` nothing awaits, so the child is registered for
      // cleanup before `dispose()` can run. Later 'error' events only report a
      // failed kill, which the guard makes moot; a write to a closed stdin is
      // reported by `write()` instead.
      child.on("error", () => {});
      child.stdin?.on("error", () => {});
      const pid = child.pid;
      const exited = new Promise<ProcessExit>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      const isRunning = (): boolean => child.exitCode === null && child.signalCode === null;

      const guard = isWindows ? undefined : watchGuardPipe(child.stdio[3] as Duplex);
      let endRequested = false;
      let ended: Promise<void> | undefined;
      /** Has the guard end the group (SIGTERM, then SIGKILL after the grace) and resolves once the guard has exited and the group is gone. */
      const endGroup = (): Promise<void> =>
        (ended ??= (async () => {
          if (guard === undefined) return;
          endRequested = true;
          guard.endGroup();
          if (!(await settlesWithin(guard.gone, killGraceMs + KILL_WAIT_MS))) {
            // The guard has not finished. It still runs, so the group id is still its: end the group from here.
            if (guard.running) signalGroup(pid, "SIGKILL");
            await settlesWithin(guard.gone, KILL_WAIT_MS);
          }
          await groupGone(pid, KILL_WAIT_MS);
        })());
      // A guard that is gone while nobody asked it to end its group (it was killed, or never started):
      // the child is not reaped yet, so its group id is still its own; end the group now rather than leave it unguarded.
      void guard?.gone.then(() => {
        if (!endRequested && isRunning()) signalGroup(pid, "SIGKILL");
      });

      const terminate = async (): Promise<void> => {
        if (isWindows) {
          if (isRunning()) await terminateTreeOnWindows(pid);
          return;
        }
        await endGroup();
        await settlesWithin(exited, KILL_WAIT_MS);
      };
      terminators.add(terminate);
      if (guard !== undefined) rememberRunningGroup(pid, () => guard.running);

      // Timers cannot wait longer than 2^31 - 1 ms; a longer timeout waits that long.
      const timeoutTimer =
        request.timeoutMs === undefined ? undefined : setTimeout(() => void track(terminate()), Math.min(request.timeoutMs, MAX_TIMER_MS));
      void exited.then(() => {
        clearTimeout(timeoutTimer);
        terminators.delete(terminate);
        if (isWindows) return;
        // End anything the child left behind in its group, then forget the group.
        void track(endGroup().finally(() => runningGroups.delete(pid)));
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

        /**
         * Without a signal, ends the whole process group and resolves when it is gone. With one, sends it to the
         * group while the guard holds the group's id (the guard ignores the usual ones), else to the child alone.
         */
        async kill(signal) {
          if (signal === undefined) {
            await track(terminate());
            return;
          }
          if (typeof signal !== "string" || !Object.hasOwn(osConstants.signals, signal)) {
            throw callErrors.validation([{ path: ["signal"], message: "is not a known signal" }], `Unknown signal ${String(signal)}`);
          }
          if (isWindows) child.kill(signal as NodeJS.Signals);
          else if (guard?.running === true) signalGroup(pid, signal as NodeJS.Signals);
          else if (isRunning()) child.kill(signal as NodeJS.Signals);
        },
      };
    },

    dispose,
  };
}
