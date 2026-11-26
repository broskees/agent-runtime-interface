// Agents end when their owner dies, and not before. ari/node's process
// service starts a guard beside every child (see src/node/process.ts): when
// the process that owns the service dies without cleaning up, the guard ends
// the child's whole process group. These tests show that:
//
// - a Node host that uses the process service directly (no ari-driver) and is
//   SIGKILLed leaves nothing behind within 5 s: no agent, grandchild, group or
//   guard, even of an agent that ignores SIGTERM;
// - while the owner lives, an idle agent and its grandchild keep running (the
//   guard never ends a group early);
// - an agent that exits on its own takes its grandchild and its guard with it;
// - every agent gets exactly one guard, and `dispose()` returns only once
//   every guard is gone.
//
// The fake agents are in test/helpers/fake-agent.ts; test/wire/driver-death.test.ts
// covers the same guarantee for ari-driver.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createProcessService } from "../../src/node/index.ts";
import type { ProcessService } from "../../src/node/index.ts";
import { fakeAgentArgs, readFirstLine } from "../helpers/fake-agent.ts";
import type { FakeAgentKind } from "../helpers/fake-agent.ts";
import { killRecorded, recordAgents, survivorsAt, survivorsOf } from "../helpers/process-groups.ts";
import type { RecordedAgent } from "../helpers/process-groups.ts";
import { NODE_EXECUTABLE } from "../helpers/runtime.ts";
import { REPO_ROOT } from "../helpers/spec.ts";

const OWNER = path.join(REPO_ROOT, "test", "node", "fixtures", "process-owner.ts");
const LIMIT_MS = 5000;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ari-owner-death-"));
after(() => fs.rmSync(home, { recursive: true, force: true }));

async function startAgent(service: ProcessService, kind: FakeAgentKind, agents: RecordedAgent[]) {
  const child = await service.spawn({ command: "/bin/sh", args: fakeAgentArgs(kind), purpose: "runtime" });
  const [agent] = recordAgents(agents, [{ pid: child.pid!, grandchildPid: Number(await readFirstLine(child.stdout)) }]);
  return { child, agent: agent! };
}

/** Everything of `agent` that runs while nothing has ended it. */
function everythingOf(agent: RecordedAgent): string[] {
  return [`agent ${agent.pid}`, `grandchild ${agent.grandchildPid}`, `group ${agent.groupId}`, ...agent.guardPids.map((guard) => `guard ${guard}`)];
}

describe("agents end when their owner dies, and not before", () => {
  test("a Node host using ari/node's process service directly is SIGKILLed: every agent, grandchild, group and guard is gone within 5 s", async () => {
    const owner = spawn(NODE_EXECUTABLE, [OWNER, "plain", "ignore-term"], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: home,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") },
    });
    let stderr = "";
    owner.stderr.setEncoding("utf8");
    owner.stderr.on("data", (text: string) => {
      stderr += text;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => owner.once("exit", (code, signal) => resolve({ code, signal })));
    const agents: RecordedAgent[] = [];
    try {
      const line = await readFirstLine(owner.stdout).catch((error: Error) => assert.fail(`${error.message}; owner stderr: ${stderr}`));
      recordAgents(agents, JSON.parse(line) as Array<{ pid: number; grandchildPid: number }>);
      assert.equal(agents.length, 2);

      const killedAt = Date.now();
      owner.kill("SIGKILL");
      assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
      assert.deepEqual(await survivorsAt(agents, killedAt + LIMIT_MS), [], `everything ended within ${LIMIT_MS} ms`);
    } finally {
      killRecorded(agents);
      owner.kill("SIGKILL");
    }
  });

  test("while the owner lives, an agent and its grandchild keep running for 10 s with no output and no stdin traffic", async () => {
    const service = createProcessService({ envPolicy: { stripAmbient: [] } });
    const agents: RecordedAgent[] = [];
    try {
      const { agent } = await startAgent(service, "plain", agents);
      await delay(10_500);
      assert.deepEqual(survivorsOf(agents), everythingOf(agent), "the agent, its grandchild, its group and its guard all still run");
      await service.dispose();
      assert.deepEqual(survivorsOf(agents), [], "dispose() returns once the group and its guard are gone");
    } finally {
      killRecorded(agents);
      await service.dispose();
    }
  });

  test("an agent that exits on its own while its owner lives takes its grandchild and its guard with it within 5 s", async () => {
    const service = createProcessService({ envPolicy: { stripAmbient: [] } });
    const agents: RecordedAgent[] = [];
    try {
      const { child } = await startAgent(service, "exit-on-stdin-close", agents);
      await child.closeStdin();
      const exitedAt = Date.now();
      assert.deepEqual(await child.exited, { code: 0, signal: null });
      assert.deepEqual(await survivorsAt(agents, exitedAt + LIMIT_MS), []);
    } finally {
      killRecorded(agents);
      await service.dispose();
    }
  });

  test("20 agents in one owner get one guard each, and dispose() leaves no guard behind", async () => {
    const service = createProcessService({ envPolicy: { stripAmbient: [] } });
    const agents: RecordedAgent[] = [];
    try {
      await Promise.all(Array.from({ length: 20 }, () => startAgent(service, "plain", agents)));
      // recordAgents checked that exactly one guard watches each group.
      assert.equal(agents.length, 20);
      assert.equal(new Set(agents.flatMap((agent) => agent.guardPids)).size, 20, "20 distinct guards");
      await service.dispose();
      assert.deepEqual(survivorsOf(agents), [], "no agent, grandchild, group or guard runs once dispose() returns");
    } finally {
      killRecorded(agents);
      await service.dispose();
    }
  });
});
