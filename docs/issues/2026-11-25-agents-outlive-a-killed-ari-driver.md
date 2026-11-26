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
