// A delegated child whose spawn finishes after the wire closed is ended at
// once. With `delegateProcesses: true` the TypeScript client starts the
// driver's children through the host's `process.spawn`, and kills every child
// it registered when the connection closes. A spawn still in progress at that
// moment resolves later; the client must kill that child right away and never
// register it, or nothing would ever end it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeHost } from "../../src/conformance/index.ts";
import { isAriError } from "../../src/index.ts";
import { createProcessService } from "../../src/node/index.ts";
import type { Driver, HostServices, Instance, SpawnedProcess } from "../../src/runtime.ts";
import { ARI_VERSION } from "../../src/version.ts";
import { connectDriver, serveDriver } from "../../src/wire/index.ts";
import { fakeAgentArgs, readFirstLine } from "../helpers/fake-agent.ts";
import { killRecorded, recordAgents, survivorsAt } from "../helpers/process-groups.ts";
import type { RecordedAgent } from "../helpers/process-groups.ts";
import { memoryTransportPair } from "./helpers.ts";

/** A driver whose `probe()` spawns one child through its host. */
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

test("a delegated child whose host spawn resolves after the wire closed is killed at once and never registered; it is gone within 5 s", async () => {
  const service = createProcessService({ envPolicy: { stripAmbient: [] } });
  const agents: RecordedAgent[] = [];
  let spawnRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    spawnRequested = resolve;
  });
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let childRecorded!: () => void;
  const recorded = new Promise<void>((resolve) => {
    childRecorded = resolve;
  });
  let killCalls = 0;
  const host = createFakeHost({
    // Holds the spawn until the test opens the gate, then starts a real child (with a grandchild) and records it.
    spawn: async (request) => {
      spawnRequested();
      await gate;
      const child = await service.spawn({ command: request.command, args: [...(request.args ?? [])] });
      recordAgents(agents, [{ pid: child.pid!, grandchildPid: Number(await readFirstLine(child.stdout)) }]);
      childRecorded();
      const counted: SpawnedProcess = {
        pid: child.pid,
        stdout: child.stdout,
        stderr: child.stderr,
        exited: child.exited,
        write: (data) => child.write(data),
        closeStdin: () => child.closeStdin(),
        kill: (signal) => {
          killCalls += 1;
          return child.kill(signal);
        },
      };
      return counted;
    },
  });

  const [driverSide, hostSide] = memoryTransportPair();
  const server = serveDriver(spawningDriver, driverSide);
  const connection = await connectDriver(hostSide, { delegateProcesses: true });
  try {
    const instance = await connection.driver.create(host as unknown as HostServices, { instanceId: "late-spawn-1", config: {}, environment: {} });
    const probing = instance.probe();
    await requested;

    // The driver side goes away while the host is still spawning.
    await server.close();
    const closedWith = await connection.closed;
    assert.equal(closedWith.code, "transport");
    await assert.rejects(probing, (error: unknown) => isAriError(error, "transport"));

    openGate();
    await recorded;
    const resolvedAt = Date.now();
    assert.equal(agents.length, 1, "the host started the child after the wire closed");
    assert.deepEqual(await survivorsAt(agents, resolvedAt + 5000), [], "the late child, its grandchild, group and guard are gone within 5 s");
    assert.equal(killCalls, 1, "the client killed the late child once, itself; no close handler saw it");
  } finally {
    killRecorded(agents);
    await connection.close();
    await service.dispose();
  }
});
