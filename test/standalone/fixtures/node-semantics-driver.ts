// Runs the Node host setup and the wire server's local process service from
// inside the standalone binary. The command is a shell fixture, not an agent.
import assert from "node:assert/strict";
import { createCoordination, createNodeHostServices } from "../../../src/node/index.ts";
import type { Driver } from "../../../src/runtime.ts";
import { agentGroupDriver } from "../../wire/fixtures/agent-group-driver.ts";

export const nodeSemanticsDriver: Driver = {
  ...agentGroupDriver,
  kind: "node-semantics",
  async create(host, input) {
    const instance = await agentGroupDriver.create(host, input);
    return {
      ...instance,
      async probe() {
        const services = await createNodeHostServices({
          hostRoot: String(input.config["hostRoot"]),
          instanceId: input.instanceId,
          config: host.config,
          attachments: host.attachments,
          hostTools: host.hostTools,
          callbacks: host.callbacks,
          coordination: createCoordination(),
          writeDiagnostic: () => undefined,
        });
        try {
          assert.equal(services.paths.stateDir, input.config["expectedStateDir"], "the driver received the canonical directory the OS reads");
          const child = await host.process.spawn({ command: "ari-standalone-path-probe", stdin: "ignore", purpose: "probe" });
          let output = "";
          for await (const chunk of child.stdout) output += Buffer.from(chunk).toString("utf8");
          const { code } = await child.exited;
          if (code !== 0) throw new Error(`The PATH probe exited with ${code}`);
          return { ...(await instance.probe()), version: output.trim() };
        } finally {
          await services.dispose();
        }
      },
    };
  },
};
