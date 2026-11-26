# Agents and their tool processes outlive an `ari-driver` that dies without disposing

Reported 2026-11-25 from the CoChat Companion build (plan `ari-sessions-companion`,
phase 3 verifier finding). Checked against `main` at `e40e1e6`.

## Summary

When `ari-driver` ends without running its own cleanup (SIGKILL, a crash, an
out-of-memory kill, or SIGHUP), every agent process it started keeps running,
together with everything the agent started (test runners, dev servers, shells
from its Bash tool). Nothing can find them afterwards. A host that kills
`ari-driver`'s process group does not reach them, because each agent leads a
process group of its own.

Joe's ruling: fix this in ARI, not in each host.

## Why it happens

- `src/node/process.ts:297` spawns every child with `detached: !isWindows`, so
  each agent leads its own process group. That is deliberate: it lets ARI end
  everything an agent started with one `kill(-pgid)`.
- Cleanup of those groups only runs inside a living `ari-driver`:
  - `dispose()` and the wire server's `connection.onClose` (`src/wire/server.ts`,
    the `onClose` handler that disposes every instance and `localProcesses`);
  - `process.once("SIGTERM" | "SIGINT", stop)` in `src/wire/cli.ts:113-114`;
  - the `exit` listener `killRunningGroupsOnExit` (`src/node/process.ts:186-202`),
    which the comment already says is skipped by "Signals that end the host
    without running `exit` listeners (an unhandled SIGINT, SIGKILL)".
- So these paths leak:
  1. SIGKILL of `ari-driver`. Companion sends SIGTERM to `ari-driver`'s group,
     waits 15 s, then SIGKILL. A dispose that takes longer than the grace, or a
     host that kills straight away, leaks every agent group.
  2. A crash or OOM kill of `ari-driver`.
  3. SIGHUP: not handled in `src/wire/cli.ts`, so the default action ends the
     process without `exit` listeners.
- Agents that read stdin usually exit on their own once `ari-driver` is gone
  (their stdin pipe reaches EOF). That is why ARI's fake Pi passes Companion's
  tests. But what the agent started in its group survives: a process group is
  not ended when its leader exits, and the reaping described in the
  `process.ts` header ("When a child exits on its own, any process it left
  behind in its group is ended the same way") needs a living `ari-driver`.
  Real `claude` and `codex` have not been checked either way.

## Reproduce (Linux or macOS)

1. Start `ari-driver pi` (or `codex`) with the fake or real agent, open a
   session, start a turn whose agent runs a long command (`sleep 600`, or the
   fake agent started through the puppet channel with a child of its own).
2. `kill -9 <ari-driver pid>`.
3. `ps -eo pid,pgid,command | grep -E 'sleep 600|pi|codex'` still lists the
   agent's group (or at least the `sleep`), now reparented to init/launchd.

## What a fix should guarantee

After `ari-driver` ends for any reason, no process it spawned through the
process service, and nothing in those processes' groups, is still running
within a bounded time (a few seconds), on Linux and macOS. Windows keeps its
`taskkill /T` behaviour.

## Possible approaches (not prescriptive)

- A watchdog per agent group that outlives `ari-driver` only long enough to
  notice it died: for example a tiny process started in the same group that
  holds the read end of a pipe whose write end only `ari-driver` holds, and
  sends SIGTERM then SIGKILL to its own group on EOF. A pipe EOF is the one
  signal that survives SIGKILL of the parent. (Linux could also use
  `PR_SET_PDEATHSIG`, but Node cannot set it, and macOS has no equivalent.)
- Record running group ids in the instance's state folder (ARI already has
  per-instance paths and coordination leases), and on the next start reap the
  groups a dead previous `ari-driver` left behind. This covers restarts, not a
  host that never starts the driver again, so it is a complement, not a fix.
- Handle SIGHUP like SIGTERM in `src/wire/cli.ts`.
- Optionally report the running agent pids and process groups in
  `instance/status` (or a diagnostic method) so a host can act as a last resort.

## Tests that would prove it

- A conformance or node test that starts a driver over `ari/wire`, starts a
  turn whose agent spawns a long-lived grandchild in its group, SIGKILLs
  `ari-driver`, and asserts within N seconds that `kill(-pgid, 0)` fails with
  ESRCH for every group the driver had started.
- The same with SIGHUP and with a crash (`process.abort()` in a test driver).
- Run under the standalone `bun build --compile` binary as well as Node, since
  hosts like Companion run the standalone binary.

## Who depends on this

CoChat Companion (`cochat-companion`, branch `feat/ari-sessions`) runs one
standalone `ari-driver` per driver and relies on ARI to end the agents. Its
threat model records this as an open risk (`docs/architecture/threat-model.md`),
and its end-to-end phase on a real Mac will check it with real `claude` and
`codex`.

## Resolution

Fixed in ARI on 2026-11-25, plan `driver-death-cleanup-20261125-190011`,
phase 1, by these commits:

- `8f0981b` ("Agents end when their driver dies: a guard per agent group,
  SIGHUP as shutdown, late delegated children killed") started each guard as
  a separate process outside the agent's group. Review showed that an owner
  killed between the two spawns left the agent unguarded, and that a guard
  signalling a group by its number could hit a group ARI never started once
  that number was reused.
- `26f0a72` ("The guard moves into the agent's process group, started before
  the agent runs; local agents end within 1 s of shutdown; death tests measure
  from the signal") replaced it with the first approach above, in full.
- `7c89550`: `dispose()` waits until each group is gone, not only its guard
  (the guard is reaped by the system's reaper, so it can briefly stay a
  zombie in the group); the startup-window test pauses the launcher before
  its first command every time.
- `e016ac5`: under Bun the launcher is started with `Bun.spawn`. Bun 1.3.14's
  `node:child_process` closes an extra pipe's descriptor twice, the second
  time when the finished child is garbage-collected; that stale close hit a
  live agent's guard pipe and ended its group while its owner lived.

What changed:

- `src/node/process.ts`: every child the process service starts on Linux and
  macOS is spawned through a `/bin/sh` launcher. The launcher starts the
  child's guard in the background, inside the child's own process group
  (stdio on `/dev/null`, holding only the read end of a pipe the owner
  holds), then `exec`s the child in its place, so the child keeps its pid and
  never runs before its guard exists. The guard ignores SIGTERM, SIGHUP,
  SIGINT and the other usual signals. When the owner dies for any reason (or
  asks it to, by writing a line to the pipe), it sends SIGTERM to its own
  group, waits until it is alone or the kill grace (2 s by default) has
  passed, sends SIGKILL to the group and exits. It only ever signals the
  group it is a member of, and its membership keeps that group id from being
  given to anyone else. The command is searched for before the launch, so
  spawn errors and argv stay as callers saw them (`docs/wire.md` lists the
  small differences that remain). It costs one idle shell per agent (with
  bash as `/bin/sh`, about 4.2 MB resident, 0.4 MB of it not shared).
- `src/wire/server.ts`: local child processes are ended at most 1 s after the
  connection closes, even while an instance's dispose still runs.
- `src/wire/cli.ts`: SIGHUP is handled like SIGTERM (dispose, then exit 0).
- `src/wire/client.ts`: a delegated child whose host spawn resolves after the
  wire closed is killed at once and never registered (the ARI build's
  finding F16).
- `docs/wire.md` ("Agents end when `ari-driver` dies") and the
  `src/node/process.ts` header state the guarantee, how it works, what it
  costs, and its limit: a process that leaves the agent's group with
  `setsid()` or `setpgid()` is not reached.

Tests:

- `test/wire/driver-death.test.ts`: the built `ari-driver` under Node serves
  a driver whose two agents each run a grandchild that ignores SIGHUP and
  never reads stdin (one agent also ignores SIGTERM). `ari-driver` is
  SIGKILLed, crashes with `process.abort()`, gets SIGHUP, or gets SIGTERM;
  each time every agent, grandchild, group and guard is gone within 5 s of
  the signal (sampled from the signal on), and after SIGHUP and SIGTERM
  `ari-driver` exits 0. The same holds for SIGTERM when the driver's dispose
  takes 6 s, and for a SIGKILL that lands after an agent's spawn returned
  but before its guard started (a preload freezes Node inside
  `child_process.spawn` there).
- `test/standalone/standalone-binary.e2e.ts` (run by `pnpm run test:binary`):
  the SIGKILL, SIGHUP and startup-window cases against the Bun-built
  standalone `ari-driver`, with no `node` or `bun` on `PATH`.
- `test/node/owner-death.test.ts`: a Node host using the process service
  directly is SIGKILLed, also inside the startup window, and leaves nothing
  behind within 5 s; a guard holds its group id until it exits; an idle agent
  and its grandchild keep running for 10 s while the owner lives, and while
  other children come and go and are garbage-collected; an agent that exits
  on its own takes its grandchild and guard with it; 20 agents get one guard
  each, and `dispose()` leaves no guard.
- `test/node/process.test.ts`: the launcher keeps spawn errors, argv and the
  environment as a direct spawn gives them, apart from the documented
  differences.
- `test/wire/late-spawn.test.ts`: the late delegated child is killed, gone
  within 5 s, and never in the client's process table.
- `.github/workflows/ci.yml` gains a `macos-latest` job that runs
  `test/wire/driver-death.test.ts` and `test/node/owner-death.test.ts`.

Not covered: Windows keeps `taskkill /T`, which runs only while the owner
lives. Processes that leave the agent's group are not reached. Real `claude`
and `codex` were not run (the plan starts no real agent).
