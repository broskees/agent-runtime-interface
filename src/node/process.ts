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
// own group (`kill 0`) and starts a timer, its own child in the group, that
// sends SIGKILL to the whole group once `killGraceMs` has passed on the clock.
// Until then it checks whether any member but itself is left, and if none
// is, sends SIGKILL to its own group at once. It never signals by a number:
// it signals the group it is a member of, and while it is a member, that
// group id cannot be given to anyone else. Membership is read with
// `ps -A -o pid= -o ppid= -o pgid=` and `awk`; if they are missing, the timer
// alone ends the group.
//
// The owner ends a group the same way: it writes a line to the guard's pipe
// and waits until the group, guard included, is gone (probing with signal 0,
// which delivers nothing), so cleanup does not wait a whole grace when the
// group empties sooner. The owner sends a signal to a group by its id only
// while the group's leader is its own unreaped child, checked in the same
// synchronous step, since only that keeps the id from naming another group.
// A group still there when the owner stops waiting is logged (a warning with
// code `ARI_PROCESS_GROUP_LEFT_BEHIND`), sent nothing, and reported by
// `kill()` and `dispose()` as an `invalid_state` error. A guard shows in `ps`
// as `/bin/sh -c … ari-agent-guard <grace ms> …`, and costs one idle shell per
// child. If the launcher cannot start the guard, the child never runs: it
// exits with code 126. Someone who kills a guard by hand before it was asked
// to end its group leaves its child unguarded.
//
// Under Bun the launcher is started with `Bun.spawn` rather than
// `node:child_process`, whose extra pipes Bun 1.3.14 closes twice (see
// `fromBunSubprocess`).
//
// What the launcher keeps as it was, and what it does not: spawn errors (a
// missing or non-executable command, a missing `cwd`) reject as before, and
// nothing starts outside the launcher: the command is searched for first, the
// way spawn searches, and for a command that is not found the error spawn
// would give is worked out without starting anything
// (`spawnErrorWithoutStarting`). The child's argv is the one spawn would give
// it, except that with no PATH in the child's environment a bare command name
// is run by its full path (argv[0] is that path), and for its first few
// milliseconds the pid shows the launcher's command line, until the launcher
// `exec`s the child (while that `exec` runs, Linux shows no arguments at all).
// `PWD` and `OLDPWD` are put back as the child's environment had them.
// With bash as `/bin/sh`, an environment without
// `SHLVL` gains `SHLVL=0`. On macOS, a file the user may execute that is not
// a program (no `#!` line) is run by `/bin/sh` instead of failing with
// ENOEXEC; on Linux spawn already runs it so.
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
import { Readable, Writable } from "node:stream";
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
 * exists. Call it only while the group's leader is this process's own child
 * and not yet reaped (`isRunning()`, checked in the same synchronous step): an
 * unreaped leader keeps its pid, and so the group id, from being given to
 * anyone else. Once the leader is reaped, only the guard, a member, may signal
 * the group, and it does so as `kill 0`.
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
 * True once process group `groupId` is gone, false after `timeoutMs`. It
 * probes with signal 0, which delivers nothing, so it can never harm another
 * group. It waits out members that have exited but are not reaped yet: a
 * guard is reaped by the system's reaper, not by this process.
 */
async function groupGone(groupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-groupId, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    if (Date.now() >= deadline) return false;
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
// (`kill 0`), and a timer, its own child in the group, that sends SIGKILL to
// the whole group, guard and timer included, once the grace has passed on the
// clock, however long the checks take. Meanwhile it checks at 20, 60, 140, 300,
// 620 ms and then every 400 ms: when no member but itself (and its own helper
// processes) is left, it sends SIGKILL to its own group at once, which ends the
// timer too. It never exits any other way, and it signals nothing but its own
// group. POSIX sh, ps and awk only, so it runs under bash, dash and macOS's sh
// alike.
const GUARD_SCRIPT = [
  "set +eu",
  "trap '' HUP INT QUIT PIPE ALRM TERM USR1 USR2",
  'PATH="/usr/bin:/bin${PATH:+:$PATH}"',
  "LC_ALL=C",
  "export LC_ALL",
  "unset PS_PERSONALITY CMD_ENV",
  "read -r _ <&3",
  "exec 3<&-",
  "kill -s TERM 0",
  '{ ( sleep "$(printf %d.%03d $(($1 / 1000)) $(($1 % 1000)))"; kill -s KILL 0 ) & }',
  "step=20",
  `while :; do ${[
    'sleep "$(printf %d.%03d $((step / 1000)) $((step % 1000)))"',
    'if [ "$(ps -A -o pid= -o ppid= -o pgid= 2>/dev/null | awk -v me="$$" "$2")" = 0 ]; then kill -s KILL 0; fi',
    "if [ $step -lt 400 ]; then step=$((step * 2)); fi",
  ].join("; ")}; done`,
].join("; ");

// The awk program the guard runs over `ps -A -o pid= -o ppid= -o pgid=`. It
// prints how many members of the guard's group are left besides the guard
// itself and its own helper processes (its children and theirs: the timer and
// its `sleep`, the command substitution's subshell, ps, awk). It prints nothing
// when the guard's own line is missing, which the guard reads as "not alone":
// then only the timer ends the group.
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

/** A started child, from whichever runtime started it: what `spawn` needs of it. */
interface StartedChild {
  readonly pid: number;
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<ProcessExit>;
  /** True until the child has exited and been reaped. */
  isRunning(): boolean;
  /** Sends `signal` to the child alone. */
  signal(signal: NodeJS.Signals): void;
  /** Asks the child's guard to end its group: writes a line to the guard's pipe. Does nothing on Windows. */
  askGuardToEndGroup(): void;
}

/** `child`, started by `node:child_process`, with fd 3 the guard's pipe when it has one. */
function fromChildProcess(child: ChildProcess & { pid: number }): StartedChild {
  child.on("error", () => {});
  child.stdin?.on("error", () => {});
  const guardPipe = child.stdio[3] as Duplex | null | undefined;
  guardPipe?.on("error", () => {});
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout!,
    stderr: child.stderr!,
    exited: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    isRunning: () => child.exitCode === null && child.signalCode === null,
    signal: (signal) => child.kill(signal),
    askGuardToEndGroup: () => {
      if (guardPipe !== null && guardPipe !== undefined && !guardPipe.destroyed && guardPipe.writable) guardPipe.write("\n");
    },
  };
}

// The parts of Bun's own spawn API the launcher uses under Bun.
interface BunFileSink {
  write(chunk: Uint8Array | string): number;
  flush(): number | Promise<number>;
  end(): number | Promise<number>;
}
interface BunSubprocess {
  readonly pid: number;
  readonly stdin: BunFileSink | undefined;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdio: readonly (number | null | undefined)[];
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): void;
}
interface BunRuntime {
  spawn(options: {
    cmd: string[];
    cwd?: string;
    env: { [name: string]: string };
    stdio: ["pipe" | "ignore", "pipe", "pipe", "pipe"];
    detached: boolean;
  }): BunSubprocess;
}

/** Bun's own runtime object, when this code runs under Bun. */
const bunRuntime = (globalThis as { Bun?: BunRuntime }).Bun;

/** A Node stream over the stdin of a `Bun.spawn` child. */
function fileSinkWritable(sink: BunFileSink): Writable {
  return new Writable({
    write(chunk: Uint8Array, _encoding, callback) {
      try {
        sink.write(chunk);
        Promise.resolve(sink.flush()).then(
          () => callback(),
          (error: Error) => callback(error),
        );
      } catch (error) {
        callback(error as Error);
      }
    },
    final(callback) {
      try {
        Promise.resolve(sink.end()).then(
          () => callback(),
          () => callback(),
        );
      } catch {
        callback();
      }
    },
  });
}

/**
 * The launcher started by `Bun.spawn`, for when this code runs under Bun.
 * Bun's `node:child_process` wraps an extra pipe such as fd 3 in a socket that
 * closes the descriptor, and the subprocess closes the same descriptor again
 * once it is garbage-collected: by then that number may belong to another
 * child's guard pipe, whose guard would see end-of-file and end a group whose
 * owner lives (Bun 1.3.14). `Bun.spawn` leaves fd 3 a plain number the
 * subprocess alone owns and closes, once, when it is collected; this record
 * keeps the subprocess reachable for as long as it may write to that number.
 */
function fromBunSubprocess(subprocess: BunSubprocess): StartedChild {
  const guardPipe = subprocess.stdio[3];
  const stdin = subprocess.stdin === undefined ? null : fileSinkWritable(subprocess.stdin);
  stdin?.on("error", () => {});
  return {
    pid: subprocess.pid,
    stdin,
    stdout: Readable.fromWeb(subprocess.stdout as never),
    stderr: Readable.fromWeb(subprocess.stderr as never),
    exited: subprocess.exited.then(() => ({ code: subprocess.exitCode, signal: subprocess.signalCode })),
    isRunning: () => subprocess.exitCode === null && subprocess.signalCode === null,
    signal: (signal) => subprocess.kill(signal),
    askGuardToEndGroup: () => {
      if (typeof guardPipe !== "number") return;
      try {
        fs.writeSync(guardPipe, "\n");
      } catch {
        // The guard has already exited.
      }
    },
  };
}

// Process groups still running in this host process, with whether their
// leader is still this process's unreaped child (so the group id is still
// its). When the host process exits without disposing its services, those
// groups get SIGKILL on the way out, so a host that forgets to dispose does not
// leave agents running. Signals that end the host without running `exit`
// listeners (an unhandled SIGINT, SIGKILL) skip this; the guards end the
// groups then, as they end whatever a leader that already exited left behind.
const runningGroups = new Map<number, () => boolean>();
let exitListenerInstalled = false;

function killRunningGroupsOnExit(): void {
  for (const [groupId, leaderUnreaped] of runningGroups) {
    if (leaderUnreaped()) signalGroup(groupId, "SIGKILL");
  }
}

function rememberRunningGroup(groupId: number, leaderUnreaped: () => boolean): void {
  runningGroups.set(groupId, leaderUnreaped);
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

/** Longest file name exec searches PATH for (NAME_MAX on Linux and macOS); a longer one fails with ENAMETOOLONG. */
const NAME_MAX = 255;

/** Errors with which exec goes on to the next PATH entry (glibc's execvp; libuv's own search on macOS keeps EACCES, ENOENT and ENOTDIR). */
const SEARCH_GOES_ON = new Set(["EACCES", "ENOENT", "ENOTDIR", "ESTALE", "ENODEV", "ETIMEDOUT"]);

/** What exec would fail with for `file`, read with stat and access instead of starting it; null when it would run. */
function execErrorOf(file: string): string | null {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "ENOENT";
  }
  // exec refuses a directory or any other file that is not a regular one with EACCES.
  if (!stats.isFile()) return "EACCES";
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    return "EACCES";
  }
  return null;
}

/** What changing into `directory` would fail with, read with stat and access; null when it would work. */
function chdirErrorOf(directory: string): string | null {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(directory);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "ENOENT";
  }
  if (!stats.isDirectory()) return "ENOTDIR";
  try {
    fs.accessSync(directory, fs.constants.X_OK);
  } catch {
    return "EACCES";
  }
  return null;
}

/**
 * Why `request` cannot run, for a request the search found nothing to run
 * for, worked out without starting anything: a command that appeared since
 * the search would otherwise run without a guard. It makes spawn's checks in
 * spawn's order, so callers get the error spawn itself gave: Node's argument
 * checks (no NUL byte in the command, an argument, `cwd` or the environment,
 * and a string `cwd`), then the `cwd` the child changes into, then what exec
 * would say of each file the search tries, by libc's rules: a name longer
 * than NAME_MAX fails at once, EACCES from any candidate wins over the last
 * error, ENOENT and ENOTDIR go on to the next PATH entry, and any other error
 * stops the search. A command found after all (it appeared in between) is not
 * started either; the spawn rejects with `spawn_failed`.
 */
function spawnErrorWithoutStarting(
  request: SpawnRequest,
  environment: { readonly [name: string]: string },
  searchPath: string | undefined,
  searchCwd: string,
): AriError {
  const command = request.command;
  const failure = (code: string, message = `spawn ${command} ${code}`): AriError => spawnFailure(command, Object.assign(new Error(message), { code }));
  const withoutNul = (argument: string, value: string): AriError | null =>
    value.includes("\0") ? failure("ERR_INVALID_ARG_VALUE", `The argument '${argument}' must be a string without null bytes. Received ${JSON.stringify(value)}`) : null;
  const nul =
    withoutNul("file", command) ??
    (request.args ?? []).reduce<AriError | null>((found, arg, index) => found ?? (typeof arg === "string" ? withoutNul(`args[${index}]`, arg) : null), null) ??
    Object.entries(environment).reduce<AriError | null>((found, [name, value]) => found ?? withoutNul(`options.env['${name}']`, `${name}=${value}`), null);
  if (nul !== null) return nul;
  if (request.cwd !== undefined) {
    if (typeof request.cwd !== "string") return failure("ERR_INVALID_ARG_TYPE", `The "options.cwd" property must be of type string. Received type ${typeof request.cwd}`);
    const cwdNul = withoutNul("options.cwd", request.cwd);
    if (cwdNul !== null) return cwdNul;
    const cwdError = chdirErrorOf(searchCwd);
    if (cwdError !== null) return failure(cwdError);
  }
  const candidates = command.includes("/")
    ? [appendToPath(command, [], searchCwd)]
    : (searchPath ?? DEFAULT_SEARCH_PATH).split(":").map((entry) => appendToPath(entry, [command], searchCwd));
  if (!command.includes("/") && Buffer.byteLength(command) > NAME_MAX) return failure("ENAMETOOLONG");
  let deniedAccess = false;
  let lastError = "ENOENT";
  for (const candidate of candidates) {
    const error = execErrorOf(candidate);
    if (error === null) {
      return callErrors.invalidState("spawn_failed", `Cannot spawn ${command}: it was not found when searched for, but is there now; it was not started`);
    }
    if (!SEARCH_GOES_ON.has(error) || command.includes("/")) return failure(error);
    if (error === "EACCES") deniedAccess = true;
    lastError = error;
  }
  return failure(deniedAccess ? "EACCES" : lastError);
}

/** The warning code of the line logged for a process group the owner had to leave behind. */
export const GROUP_LEFT_BEHIND_WARNING = "ARI_PROCESS_GROUP_LEFT_BEHIND";

/**
 * Logs a group that was still there when the owner stopped waiting for it:
 * its guard was stopped or killed, or a member cannot be ended (it is in
 * uninterruptible sleep, or belongs to another user). Once the leader is
 * reaped nothing keeps the id from naming another group, so the owner sends
 * the group nothing more and only reports it.
 */
function reportGroupLeftBehind(groupId: number, command: string, waitedMs: number): void {
  process.emitWarning(
    `ari/node: process group ${groupId} (${command}) was still there ${waitedMs} ms after its guard was asked to end it; ari/node leaves it and sends it no signal, since once its leader is reaped its id may name another group`,
    { code: GROUP_LEFT_BEHIND_WARNING },
  );
}

/** The error `kill()` and `dispose()` reject with when they had to leave process groups behind. */
function groupsLeftBehind(groupIds: readonly number[]): AriError {
  const plural = groupIds.length > 1;
  return callErrors.invalidState(
    "process_group_left_behind",
    `Process group${plural ? "s" : ""} ${groupIds.join(", ")} ${plural ? "were" : "was"} still there after ${plural ? "their guards were" : "its guard was"} asked to end ${plural ? "them" : "it"}; ari/node sent no signal by group id, since once a leader is reaped its id may name another group`,
  );
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
   * guards are gone. Later spawns reject with `invalid_state`. A group still
   * there when it stops waiting, with its leader already reaped, is logged as
   * a warning (code `ARI_PROCESS_GROUP_LEFT_BEHIND`) and sent nothing; then
   * `dispose()` rejects with `invalid_state` (`process_group_left_behind`)
   * once every other cleanup has finished.
   */
  dispose(): Promise<void>;
};

export function createProcessService(options: ProcessServiceOptions): ProcessService {
  const envPolicy: EnvPolicy = { stripAmbient: [...options.envPolicy.stripAmbient] };
  const baseEnv = options.baseEnv ?? process.env;
  const killGraceMs = Math.max(0, Math.round(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
  // A cleanup resolves to the id of the group it had to leave behind, or undefined; it never rejects.
  const terminators = new Set<() => Promise<number | undefined>>();
  const pendingCleanups = new Set<Promise<number | undefined>>();
  let disposed = false;

  const track = (cleanup: Promise<number | undefined>): Promise<number | undefined> => {
    pendingCleanups.add(cleanup);
    void cleanup.finally(() => pendingCleanups.delete(cleanup));
    return cleanup;
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    options.signal?.removeEventListener("abort", onAbort);
    for (const terminate of terminators) track(terminate());
    const leftBehind = new Set<number>();
    while (pendingCleanups.size > 0) {
      for (const groupId of await Promise.all([...pendingCleanups])) if (groupId !== undefined) leftBehind.add(groupId);
    }
    if (leftBehind.size > 0) throw groupsLeftBehind([...leftBehind]);
  };

  function onAbort(): void {
    // A group left behind is already logged; an aborted signal has nobody to reject to.
    void dispose().catch(() => undefined);
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
  ): { readonly started: StartedChild } | { readonly failure: Promise<AriError> } => {
    const searchPath = environment.PATH;
    if (request.cwd !== undefined && typeof request.cwd !== "string") return { failure: Promise.resolve(spawnErrorWithoutStarting(request, environment, searchPath, process.cwd())) };
    // Search where spawn would: relative entries and names against the child's cwd.
    const searchCwd = request.cwd === undefined ? process.cwd() : appendToPath(request.cwd, [], process.cwd());
    const executable = findExecutable(request.command, searchPath, searchCwd);
    if (executable === null) return { failure: Promise.resolve(spawnErrorWithoutStarting(request, environment, searchPath, searchCwd)) };
    const args = ["-c", LAUNCH_SCRIPT, LAUNCHER_NAME, GUARD_SCRIPT, String(killGraceMs), COUNT_OTHERS, launchTarget(request.command, executable, searchPath), ...(request.args ?? [])];
    const env = launcherEnvironment(environment);
    try {
      if (bunRuntime !== undefined) {
        const subprocess = bunRuntime.spawn({ cmd: ["/bin/sh", ...args], ...(request.cwd === undefined ? {} : { cwd: request.cwd }), env, stdio: [stdinMode, "pipe", "pipe", "pipe"], detached: true });
        return { started: fromBunSubprocess(subprocess) };
      }
      const child = spawnChildProcess("/bin/sh", args, { cwd: request.cwd, env, stdio: [stdinMode, "pipe", "pipe", "pipe"], detached: true });
      if (child.pid === undefined) return { failure: new Promise((resolve) => child.once("error", (error) => resolve(spawnFailure(request.command, error)))) };
      return { started: fromChildProcess(child as ChildProcess & { pid: number }) };
    } catch (error) {
      return { failure: Promise.resolve(spawnFailure(request.command, error as NodeJS.ErrnoException)) };
    }
  };

  /** Starts `request` on Windows, where there are no process groups and no guard. */
  const startOnWindows = (
    request: SpawnRequest,
    environment: { [name: string]: string },
    stdinMode: "pipe" | "ignore",
  ): { readonly started: StartedChild } | { readonly failure: Promise<AriError> } => {
    try {
      const child = spawnChildProcess(request.command, request.args ?? [], {
        cwd: request.cwd,
        env: environment,
        stdio: [stdinMode, "pipe", "pipe"] satisfies StdioOptions,
        windowsHide: true,
      });
      // Node sets `pid` only when the process started; otherwise it emits 'error' on the next tick.
      if (child.pid === undefined) return { failure: new Promise((resolve) => child.once("error", (error) => resolve(spawnFailure(request.command, error)))) };
      return { started: fromChildProcess(child as ChildProcess & { pid: number }) };
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
      const launched = isWindows ? startOnWindows(request, environment, stdinMode) : launch(request, environment, stdinMode);
      if ("failure" in launched) throw await launched.failure;
      // From here to `return` nothing awaits, so the child is registered for
      // cleanup before `dispose()` can run. A write to a closed stdin is
      // reported by `write()`.
      const child = launched.started;
      const pid = child.pid;
      const exited = child.exited;
      const isRunning = child.isRunning;

      let ended: Promise<number | undefined> | undefined;
      /**
       * Has the guard end the group (SIGTERM, then SIGKILL once the grace has
       * passed) and resolves once the group, guard included, is gone; to the
       * group's id when it had to leave the group behind. The owner signals the
       * group by its id only while the leader is still its unreaped child,
       * checked in the same synchronous step as the signal: that alone pins the
       * id. After the leader is reaped, only the guard, a member, ends the
       * group; a group still there then is reported and sent nothing.
       */
      const endGroup = (): Promise<number | undefined> =>
        (ended ??= (async () => {
          child.askGuardToEndGroup();
          let waitedMs = killGraceMs + KILL_WAIT_MS;
          if (await groupGone(pid, waitedMs)) return undefined;
          // The guard did not end the group (it was stopped or killed). The unreaped leader still pins the id.
          if (isRunning()) {
            signalGroup(pid, "SIGKILL");
            waitedMs += KILL_WAIT_MS;
            if (await groupGone(pid, KILL_WAIT_MS)) return undefined;
          }
          reportGroupLeftBehind(pid, request.command, waitedMs);
          return pid;
        })());

      /** Ends the group and waits for the child's exit; resolves to the group's id when it had to leave the group behind. */
      const terminate = async (): Promise<number | undefined> => {
        if (isWindows) {
          if (isRunning()) await terminateTreeOnWindows(pid);
          return undefined;
        }
        const leftBehind = await endGroup();
        await settlesWithin(exited, KILL_WAIT_MS);
        return leftBehind;
      };
      terminators.add(terminate);
      if (!isWindows) rememberRunningGroup(pid, isRunning);

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
        stdout: child.stdout,
        stderr: child.stderr,
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
         * Without a signal, ends the whole process group and resolves when it is gone; rejects with
         * `invalid_state` (`process_group_left_behind`) when the group had to be left behind. With one, sends it
         * to the group (the guard ignores the usual ones) while the child is not yet reaped, so the group id is
         * still its; after that, it sends nothing.
         */
        async kill(signal) {
          if (signal === undefined) {
            const leftBehind = await track(terminate());
            if (leftBehind !== undefined) throw groupsLeftBehind([leftBehind]);
            return;
          }
          if (typeof signal !== "string" || !Object.hasOwn(osConstants.signals, signal)) {
            throw callErrors.validation([{ path: ["signal"], message: "is not a known signal" }], `Unknown signal ${String(signal)}`);
          }
          if (!isRunning()) return;
          if (isWindows) child.signal(signal as NodeJS.Signals);
          else signalGroup(pid, signal as NodeJS.Signals);
        },
      };
    },

    dispose,
  };
}
