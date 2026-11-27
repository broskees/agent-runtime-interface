// A delegated child whose spawn finishes after the wire closed is ended at
// once and never registered. With `delegateProcesses: true` the TypeScript
// client starts the driver's children through the host's `process.spawn`,
// registers each by its `processId`, and kills every registered child when the
// connection closes. A spawn still in progress at that moment resolves after
// the close handler has run; the client must kill that child right away and
// never put it in its process table, or nothing would ever end it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createFakeHost } from "../../src/conformance/index.ts";
import { isAriError } from "../../src/index.ts";
import { createProcessService } from "../../src/node/index.ts";
import type { Driver, HostServices, Instance, SpawnedProcess } from "../../src/runtime.ts";
import { ARI_VERSION } from "../../src/version.ts";
import { delegatedProcessTable } from "../../src/wire/client.ts";
import { connectDriver, serveDriver } from "../../src/wire/index.ts";
import { fakeAgentArgs, readFirstLine } from "../helpers/fake-agent.ts";
import { killRecorded, recordAgents, survivorsAt, survivorsOf } from "../helpers/process-groups.ts";
import type { RecordedAgent } from "../helpers/process-groups.ts";
import { memoryTransportPair } from "./helpers.ts";

const INSTANCE_ID = "late-spawn-1";

/** A driver whose `probe()` spawns two children through its host: `p1`, then `p2`. */
const spawningDriver: Driver = {
  kind: "late-spawn",
  ariVersion: ARI_VERSION,
  metadata: { displayName: "Late spawn", multipleInstances: true, hasDefaultInstance: false },
  configSchema: { type: "object" },
  defaultConfig: () => ({}),
  async create(host, input): Promise<Instance> {
    const none = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }) };
    return {
      id: input.instanceId,
      continuationKey: "late-spawn",
      bindingKey: "late-spawn",
      status: async () => ({ state: "ready", installed: true }),
      statusChanges: () => none,
      probe: async () => {
        await host.process.spawn({ command: "/bin/sh", args: fakeAgentArgs("plain"), purpose: "probe" });
        await host.process.spawn({ command: "/bin/sh", args: fakeAgentArgs("plain"), purpose: "probe" });
        return { ok: true, installed: true, checkedAt: new Date().toISOString() };
      },
      catalog: { list: async () => ({ models: [] }) },
      openSession: async () => {
        throw new Error("not used");
      },
      dispose: async () => undefined,
    };
  },
};

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(5);
  }
}

test("a delegated child whose host spawn resolves after the close handler ran is killed at once, never registered, and gone within 5 s", async () => {
  const service = createProcessService({ envPolicy: { stripAmbient: [] } });
  const agents: RecordedAgent[] = [];
  const kills = [0, 0];
  let spawns = 0;
  let lateRequested = false;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let lateStarted = false;
  const host = createFakeHost({
    // The first child starts at once; the second waits for the gate, then starts a real child (with a grandchild).
    spawn: async (request) => {
      const index = spawns;
      spawns += 1;
      if (index === 1) {
        lateRequested = true;
        await gate;
      }
      const child = await service.spawn({ command: request.command, args: [...(request.args ?? [])] });
      await recordAgents(agents, [{ pid: child.pid!, grandchildPid: Number(await readFirstLine(child.stdout)) }]);
      if (index === 1) lateStarted = true;
      const counted: SpawnedProcess = {
        pid: child.pid,
        stdout: child.stdout,
        stderr: child.stderr,
        exited: child.exited,
        write: (data) => child.write(data),
        closeStdin: () => child.closeStdin(),
        kill: (signal) => {
          kills[index]! += 1;
          return child.kill(signal);
        },
      };
      return counted;
    },
  });

  const [driverSide, hostSide] = memoryTransportPair();
  const server = serveDriver(spawningDriver, driverSide);
  const connection = await connectDriver(hostSide, { delegateProcesses: true });
  const table = (): ReturnType<typeof delegatedProcessTable> => delegatedProcessTable(connection);
  try {
    const instance = await connection.driver.create(host as unknown as HostServices, { instanceId: INSTANCE_ID, config: {}, environment: {} });
    const probing = instance.probe();
    await until(() => lateRequested, "the second spawn to reach the host");
    assert.deepEqual(table().processIds, ["p1"], "the first child is registered while the second is still spawning");

    // The driver side goes away while the host is still spawning the second child.
    await server.close();
    const closedWith = await connection.closed;
    assert.equal(closedWith.code, "transport");
    await assert.rejects(probing, (error: unknown) => isAriError(error, "transport"));
    assert.equal(kills[0], 1, "the close handler has run: it killed the registered child");
    assert.deepEqual(table().processIds, [], "the close handler emptied the process table");

    openGate();
    await until(() => lateStarted && kills[1] === 1, "the late child to start and be killed");
    const resolvedAt = Date.now();
    assert.deepEqual(table().processIds, [], "the late child p2 was never registered");
    assert.throws(() => table().lookup(INSTANCE_ID, "p2"), (error: unknown) => isAriError(error, "not_found"), "a host call for p2 would find no such process");
    assert.equal(agents.length, 2);
    assert.deepEqual(await survivorsAt(agents, resolvedAt + 5000), [], "the late child, its grandchild, group and guard are gone within 5 s");
    await delay(100);
    assert.deepEqual(kills, [1, 1], "each child was killed once: the first by the close handler, the late one by its spawn");
    assert.deepEqual(table().processIds, []);
    assert.deepEqual(survivorsOf(agents), []);
  } finally {
    killRecorded(agents);
    await connection.close();
    await service.dispose();
  }
});
