// A driver for the tests that end `ari-driver` while its agents run
// (test/wire/driver-death.test.ts under Node, and the standalone binary's
// test). Each turn starts one fake agent (test/helpers/fake-agent.ts) through
// the driver's own `host.process`, so `ari-driver` spawns it locally with
// ari/node's process service. The turn's text names the agent's kind:
// "plain" or "ignore-term".
//
// Extension `test.agents`:
// - `agents`: `[{ pid, grandchildPid }]` for every agent this `ari-driver`
//   started, in order.
// - `abort`: crashes `ari-driver` with `process.abort()`, so no cleanup runs.

import { referenceCapabilities } from "../../../src/conformance/reference/driver.ts";
import type { Capabilities } from "../../../src/index.ts";
import type { Driver, HostServices, Instance, Session } from "../../../src/runtime.ts";
import { ARI_VERSION } from "../../../src/version.ts";
import { fakeAgentArgs, readFirstLine } from "../../helpers/fake-agent.ts";
import type { FakeAgentKind } from "../../helpers/fake-agent.ts";

const agents: Array<{ pid: number; grandchildPid: number }> = [];

const NO_ITEMS = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }) };

function createSession(host: HostServices, id: string): Session {
  const capabilities: Capabilities = { ...referenceCapabilities("full"), extensions: [{ ns: "test.agents", version: "1.0.0" }] };
  let threads = 0;
  let turns = 0;
  return {
    id,
    capabilities: () => capabilities,
    events: () => NO_ITEMS,
    createThread: async (input) => {
      threads += 1;
      return { id: `${id}-thread-${threads}`, native: { id: null, strength: "none" }, cwd: input.cwd, status: "idle" };
    },
    resumeThread: async () => {
      throw new Error("not used");
    },
    canRelease: () => true,
    release: async () => undefined,
    async startTurn(input) {
      const text = input.content.find((part) => part.type === "text");
      const kind = (text?.type === "text" ? text.text : "plain") as FakeAgentKind;
      const child = await host.process.spawn({ command: "/bin/sh", args: fakeAgentArgs(kind), purpose: "runtime", stdin: "pipe" });
      const grandchildPid = Number(await readFirstLine(child.stdout));
      void (async () => {
        for await (const _ of child.stderr);
      })();
      agents.push({ pid: child.pid!, grandchildPid });
      turns += 1;
      return { status: "accepted", turnId: `${id}-turn-${turns}`, accepted: "started" };
    },
    interruptTurn: async () => undefined,
    respond: async () => undefined,
    planConfigChange: async () => ({ type: "reject", reason: "not used" }),
    close: async () => undefined,
    async ext(ns, method) {
      if (method === "agents") return agents;
      if (method === "abort") process.abort();
      throw new Error(`unknown method ${ns}.${method}`);
    },
  };
}

export const agentGroupDriver: Driver = {
  kind: "agent-group",
  ariVersion: ARI_VERSION,
  metadata: { displayName: "Agent group", multipleInstances: true, hasDefaultInstance: false },
  configSchema: { type: "object" },
  defaultConfig: () => ({}),
  async create(host, input): Promise<Instance> {
    let sessions = 0;
    return {
      id: input.instanceId,
      continuationKey: "agent-group",
      bindingKey: "agent-group",
      status: async () => ({ state: "ready", installed: true }),
      statusChanges: () => NO_ITEMS,
      probe: async () => ({ ok: true, installed: true, checkedAt: new Date().toISOString() }),
      catalog: { list: async () => ({ models: [] }) },
      openSession: async () => {
        sessions += 1;
        return createSession(host, `${input.instanceId}-session-${sessions}`);
      },
      dispose: async () => undefined,
    };
  },
};
