// The scenario the tests that end `ari-driver` share: `ari-driver` serves the
// agent-group fixture driver; the host opens a session and starts a turn on
// each of two threads, so two fake agents run, each with a grandchild in its
// group (one agent ignores SIGTERM, so only SIGKILL ends it). The test records
// every agent pid, grandchild pid, group id and guard pid, ends `ari-driver`
// one of four ways, and requires all of them gone within 5 s.
//
// Used by test/wire/driver-death.test.ts (`dist/wire/cli.js` under Node) and
// test/standalone/standalone-binary.e2e.ts (the Bun-built binary).

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { createFakeHost } from "../../src/conformance/index.ts";
import type { HostServices } from "../../src/runtime.ts";
import { startAriDriver } from "../../src/wire/index.ts";
import type { AriDriverProcess } from "../../src/wire/index.ts";
import type { FakeAgentKind } from "../helpers/fake-agent.ts";
import { killRecorded, recordAgents, survivorsAt } from "../helpers/process-groups.ts";
import type { RecordedAgent } from "../helpers/process-groups.ts";
import { REPO_ROOT } from "../helpers/spec.ts";

export const AGENT_GROUP_DRIVER = path.join(REPO_ROOT, "test", "wire", "fixtures", "agent-group-driver.ts");

/** How `ari-driver` ends: a signal from outside, or a crash inside the driver (`process.abort()`). */
export type DriverDeath = "SIGKILL" | "SIGHUP" | "SIGTERM" | "abort";

export const DEATH_LIMIT_MS = 5000;

const AGENT_KINDS: readonly FakeAgentKind[] = ["plain", "ignore-term"];

export interface DriverDeathOptions {
  /** The program and leading arguments that run `ari-driver`. */
  readonly command: readonly string[];
  readonly death: DriverDeath;
  readonly env?: { readonly [name: string]: string };
  readonly cwd?: string;
}

export interface DriverDeathOutcome {
  readonly agents: readonly RecordedAgent[];
  /** How `ari-driver` exited. */
  readonly exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  /** What of the agents was still running 5 s after `ari-driver` was told to end. */
  readonly survivors: readonly string[];
}

export async function runDriverDeath(options: DriverDeathOptions): Promise<DriverDeathOutcome> {
  // A crash must not leave a core file behind, so the crashing `ari-driver` starts with core dumps off.
  const command = options.death === "abort" ? ["/bin/sh", "-c", 'ulimit -c 0; exec "$0" "$@"', ...options.command] : [...options.command];
  const connection: AriDriverProcess = await startAriDriver({
    driver: AGENT_GROUP_DRIVER,
    command,
    envPolicy: { stripAmbient: [] },
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const child = connection.child;
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const agents: RecordedAgent[] = [];
  try {
    const instance = await connection.driver.create(createFakeHost() as unknown as HostServices, { instanceId: "agent-group", config: {}, environment: {} });
    const session = await instance.openSession({});
    const cwd = options.cwd ?? os.tmpdir();
    for (const [index, kind] of AGENT_KINDS.entries()) {
      const thread = await session.createThread({ cwd, policy: { mode: "approval_required", interaction: "default", cwd } });
      const started = await session.startTurn({ threadId: thread.id, clientTurnKey: `turn-${index}`, intent: "start", content: [{ type: "text", text: kind }] });
      assert.equal(started.status, "accepted");
    }
    const reported = (await session.ext!("test.agents", "agents", {})) as Array<{ pid: number; grandchildPid: number }>;
    assert.equal(reported.length, AGENT_KINDS.length, "two agents run");
    recordAgents(agents, reported);

    const endedAt = Date.now();
    if (options.death === "abort") void session.ext!("test.agents", "abort", {}).catch(() => undefined);
    else connection.child.kill(options.death);
    const exit = await exited;
    const survivors = await survivorsAt(agents, endedAt + DEATH_LIMIT_MS);
    return { agents, exit, survivors };
  } finally {
    killRecorded(agents);
    await connection.close();
  }
}

/** Checks a death's outcome: the exit `ari-driver` must show, and nothing of its agents left. */
export function assertEndedEverything(outcome: DriverDeathOutcome, death: DriverDeath): void {
  if (death === "SIGHUP" || death === "SIGTERM") {
    assert.deepEqual(outcome.exit, { code: 0, signal: null }, `after ${death}, ari-driver ran its dispose path and exited normally`);
  } else {
    assert.deepEqual(outcome.exit, { code: null, signal: death === "abort" ? "SIGABRT" : "SIGKILL" }, `ari-driver died by ${death}`);
  }
  assert.equal(outcome.agents.length, 2);
  assert.deepEqual(outcome.survivors, [], `everything ended within ${DEATH_LIMIT_MS} ms`);
}
