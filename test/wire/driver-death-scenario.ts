// The scenarios the tests that end `ari-driver` share. `ari-driver` serves
// the agent-group fixture driver (test/wire/fixtures/agent-group-driver.ts).
//
// - `runDriverDeath`: the host opens a session and starts a turn on each of
//   two threads, so two fake agents run, each with a grandchild in its group
//   (one agent ignores SIGTERM, so only SIGKILL ends it). The test records
//   every agent pid, grandchild pid, group id and guard pid, ends `ari-driver`
//   one of five ways (a signal, a crash or a closed stdin), and from that
//   moment on samples what is left: all of it must be gone within 5 s,
//   whenever `ari-driver` itself exits.
// - `runDeathInStartupWindow`: `ari-driver` is SIGKILLed after an agent's
//   spawn returned but before that agent's guard exists, and the agent's
//   group must still be gone within 5 s. Two ways to get there: a preload that
//   freezes Node's `ari-driver` inside `child_process.spawn`
//   (test/helpers/pause-after-agent-spawn.ts), or, where no preload can run
//   (the standalone binary), the fixture driver stopping the agent's launcher
//   with SIGSTOP the moment its spawn returns.
//
// Used by test/wire/driver-death.test.ts (`dist/wire/cli.js` under Node) and
// test/standalone/standalone-binary.e2e.ts (the Bun-built binary).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFakeHost } from "../../src/conformance/index.ts";
import type { HostServices, Session } from "../../src/runtime.ts";
import { startAriDriver } from "../../src/wire/index.ts";
import type { AriDriverProcess } from "../../src/wire/index.ts";
import type { FakeAgentKind } from "../helpers/fake-agent.ts";
import { guardsOf, isStopped, killRecorded, processGroupOf, recordAgents, recordPausedLauncher, survivorsAt } from "../helpers/process-groups.ts";
import type { RecordedAgent } from "../helpers/process-groups.ts";
import { REPO_ROOT } from "../helpers/spec.ts";

export const AGENT_GROUP_DRIVER = path.join(REPO_ROOT, "test", "wire", "fixtures", "agent-group-driver.ts");
/** The preload that freezes Node inside the agent's spawn; pass it with `--import`. */
export const PAUSE_AFTER_AGENT_SPAWN = path.join(REPO_ROOT, "test", "helpers", "pause-after-agent-spawn.ts");

/** How `ari-driver` ends: a signal from outside, a crash inside the driver (`process.abort()`), or the host closing its stdin. */
export type DriverDeath = "SIGKILL" | "SIGHUP" | "SIGTERM" | "abort" | "EOF";

export const DEATH_LIMIT_MS = 5000;
/** How long `ari-driver` may take to exit at all; its own cleanup is bounded by 10 s. */
const EXIT_LIMIT_MS = 15_000;

const AGENT_KINDS: readonly FakeAgentKind[] = ["plain", "ignore-term"];

export interface DriverDeathOptions {
  /** The program and leading arguments that run `ari-driver`. */
  readonly command: readonly string[];
  readonly death: DriverDeath;
  readonly env?: { readonly [name: string]: string };
  readonly cwd?: string;
  /** How long the driver's `instance.dispose()` takes. */
  readonly disposeDelayMs?: number;
  /** Where the driver's `instance.dispose()` writes which agents still ran when it ended. */
  readonly disposeReportFile?: string;
}

export interface DriverDeathOutcome {
  readonly agents: readonly RecordedAgent[];
  /** How `ari-driver` exited. */
  readonly exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  /** What of the agents still ran 5 s after `ari-driver` was told to end, as `survivorsAt` reports it. */
  readonly survivors: readonly string[];
}

function exitOf(connection: AriDriverProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const child = connection.child;
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, delay(ms, undefined, { ref: false }).then(() => Promise.reject(new Error(`${what} did not happen within ${ms} ms`)))]);
}

async function openSession(connection: AriDriverProcess, config: { [field: string]: unknown }): Promise<Session> {
  const instance = await connection.driver.create(createFakeHost() as unknown as HostServices, { instanceId: "agent-group", config: config as never, environment: {} });
  return instance.openSession({});
}

async function startTurn(session: Session, cwd: string, kind: FakeAgentKind, key: string): Promise<void> {
  const thread = await session.createThread({ cwd, policy: { mode: "approval_required", interaction: "default", cwd } });
  const started = await session.startTurn({ threadId: thread.id, clientTurnKey: key, intent: "start", content: [{ type: "text", text: kind }] });
  assert.equal(started.status, "accepted");
}

export async function runDriverDeath(options: DriverDeathOptions): Promise<DriverDeathOutcome> {
  // A crash must not leave a core file behind, so the crashing `ari-driver` starts with core dumps off.
  const command = options.death === "abort" ? ["/bin/sh", "-c", 'ulimit -c 0; exec "$0" "$@"', ...options.command] : [...options.command];
  const connection = await startAriDriver({
    driver: AGENT_GROUP_DRIVER,
    command,
    envPolicy: { stripAmbient: [] },
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  const exited = exitOf(connection);
  const agents: RecordedAgent[] = [];
  try {
    const session = await openSession(connection, {
      ...(options.disposeDelayMs === undefined ? {} : { disposeDelayMs: options.disposeDelayMs }),
      ...(options.disposeReportFile === undefined ? {} : { disposeReportFile: options.disposeReportFile }),
    });
    const cwd = options.cwd ?? os.tmpdir();
    for (const [index, kind] of AGENT_KINDS.entries()) await startTurn(session, cwd, kind, `turn-${index}`);
    const reported = (await session.ext!("test.agents", "agents", {})) as Array<{ pid: number; grandchildPid: number }>;
    assert.equal(reported.length, AGENT_KINDS.length, "two agents run");
    await recordAgents(agents, reported);

    const endedAt = Date.now();
    if (options.death === "abort") void session.ext!("test.agents", "abort", {}).catch(() => undefined);
    else if (options.death === "EOF") connection.child.stdin!.end();
    else connection.child.kill(options.death);
    // Sampled from the signal on, while ari-driver may still be cleaning up.
    const survivors = await survivorsAt(agents, endedAt + DEATH_LIMIT_MS);
    const exit = await within(exited, EXIT_LIMIT_MS, "ari-driver exiting");
    return { agents, exit, survivors };
  } finally {
    killRecorded(agents);
    await connection.close();
  }
}

/** Checks a death's outcome: the exit `ari-driver` must show, and nothing of its agents left within 5 s of the signal. */
export function assertEndedEverything(outcome: DriverDeathOutcome, death: DriverDeath): void {
  assert.deepEqual(outcome.survivors, [], `everything ended within ${DEATH_LIMIT_MS} ms of the ${death}`);
  if (death === "SIGHUP" || death === "SIGTERM" || death === "EOF") {
    assert.deepEqual(outcome.exit, { code: 0, signal: null }, `after ${death}, ari-driver ran its dispose path and exited normally`);
  } else {
    assert.deepEqual(outcome.exit, { code: null, signal: death === "abort" ? "SIGABRT" : "SIGKILL" }, `ari-driver died by ${death}`);
  }
  assert.equal(outcome.agents.length, 2);
}

export interface StartupWindowOptions {
  /** The program and leading arguments that run `ari-driver`. With `pause: "preload"`, Node with `--import PAUSE_AFTER_AGENT_SPAWN`. */
  readonly command: readonly string[];
  /** How the agent is held between its spawn and its guard: Node frozen inside spawn by the preload, or its launcher stopped by the driver. */
  readonly pause: "preload" | "driver";
  readonly env?: { readonly [name: string]: string };
  readonly cwd: string;
}

export interface StartupWindowOutcome {
  /** Every agent the test recorded: the paused one last, with the agent-group driver's other agents before it. */
  readonly agents: readonly RecordedAgent[];
  readonly survivors: readonly string[];
  readonly exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
}

/** How many times the driver may stop a launcher too late (its guard already up) before the test gives up. */
const STOP_ATTEMPTS = 10;

export async function runDeathInStartupWindow(options: StartupWindowOptions): Promise<StartupWindowOutcome> {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ari-startup-window-")), "paused.pid");
  const env = { ...(options.env ?? (process.env as { [name: string]: string })), ...(options.pause === "preload" ? { ARI_TEST_PAUSED_PID_FILE: pidFile } : {}) };
  const connection = await startAriDriver({ driver: AGENT_GROUP_DRIVER, command: [...options.command], envPolicy: { stripAmbient: [] }, env, cwd: options.cwd });
  const exited = exitOf(connection);
  const agents: RecordedAgent[] = [];
  let pausedPid: number | undefined;
  try {
    const session = await openSession(connection, {});
    if (options.pause === "preload") {
      // The turn never answers: ari-driver freezes inside the agent's spawn.
      void startTurn(session, options.cwd, "plain", "paused").catch(() => undefined);
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, "utf8") === "") {
        if (Date.now() > deadline) throw new Error(`the preload did not pause a spawn; ari-driver stderr: ${connection.stderrTail()}`);
        await delay(10);
      }
      pausedPid = Number(fs.readFileSync(pidFile, "utf8"));
      recordPausedLauncher(agents, pausedPid);
    } else {
      // One agent that runs normally, guarded, then one stopped between its spawn and its guard.
      await startTurn(session, options.cwd, "plain", "running");
      await recordAgents(agents, (await session.ext!("test.agents", "agents", {})) as Array<{ pid: number; grandchildPid: number }>);
      for (let attempt = 1; pausedPid === undefined; attempt += 1) {
        const { pid } = (await session.ext!("test.agents", "spawnStopped", {})) as { pid: number };
        if (guardsOf(pid).length === 0 && isStopped(pid)) {
          pausedPid = pid;
          recordPausedLauncher(agents, pid);
        } else {
          // Stopped too late: its guard was already up. Keep it for the checks below and try again.
          agents.push({ pid, grandchildPid: undefined, groupId: processGroupOf(pid), guardPids: guardsOf(pid) });
          assert.ok(attempt < STOP_ATTEMPTS, `the driver never stopped a launcher before its guard started in ${STOP_ATTEMPTS} attempts`);
        }
      }
    }

    const killedAt = Date.now();
    connection.child.kill("SIGKILL");
    // The launcher goes on only now, with its owner already dead.
    process.kill(pausedPid, "SIGCONT");
    const survivors = await survivorsAt(agents, killedAt + DEATH_LIMIT_MS);
    const exit = await within(exited, EXIT_LIMIT_MS, "ari-driver exiting");
    return { agents, survivors, exit };
  } finally {
    if (pausedPid !== undefined) {
      try {
        process.kill(pausedPid, "SIGCONT");
      } catch {
        // Gone.
      }
    }
    killRecorded(agents);
    await connection.close();
    fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
  }
}
