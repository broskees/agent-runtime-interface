// The self-contained fake agent (standalone-agent.ts, one file with no
// imports) runs as its own process under real `ari/node` host services, and
// the ACP driver completes a turn with it over ACP v1 and over ACP v2: the
// agent asks for permission, the host answers through `respond`, and the turn
// ends `completed`. Every frame matches ACP's schema.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ACP_DEFAULT_CONFIG, acpDriver } from "../../../src/drivers/acp/index.ts";
import type { AcpDriverConfig } from "../../../src/drivers/acp/index.ts";
import type { AriEvent } from "../../../src/index.ts";
import { createCoordination, createNodeHostServices } from "../../../src/node/index.ts";
import type { HostServices } from "../../../src/runtime.ts";
import { checkFrames } from "./frames.ts";
import { recorded } from "./harness.ts";
import type { RecordedFrame } from "./harness.ts";
import { until } from "./rig.ts";

export const STANDALONE_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "standalone-agent.ts");

test("the standalone agent file imports nothing", () => {
  const source = fs.readFileSync(STANDALONE_AGENT, "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\brequire\(/);
  assert.doesNotMatch(source, /\bimport\(/);
});

for (const maxProtocolVersion of [1, 2] as const) {
  for (const answer of ["allow", "reject"] as const) {
    test(`ACP v${maxProtocolVersion}: a turn with the standalone agent, the permission answered "${answer}", under real host services`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ari-acp-standalone-"));
      const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-acp-standalone-workspace-")));
      const config: AcpDriverConfig = { ...ACP_DEFAULT_CONFIG, command: process.execPath, args: [STANDALONE_AGENT], versionArgs: [STANDALONE_AGENT, "--version"], maxProtocolVersion };
      const node = await createNodeHostServices<AcpDriverConfig>({
        hostRoot: root,
        instanceId: "standalone",
        config: { get: async () => ({ config }) },
        attachments: { resolve: async () => null },
        hostTools: {
          mcpServerFor: async () => {
            throw new Error("no host tools in this test");
          },
        },
        callbacks: { register: async (flowId) => ({ url: `http://127.0.0.1/callback/${flowId}` }) },
        coordination: createCoordination(),
        writeDiagnostic: () => undefined,
        envPolicy: { stripAmbient: [] },
      });
      const frames: RecordedFrame[] = [];
      let spawned = 0;
      const host: HostServices<AcpDriverConfig> = {
        ...node,
        process: {
          envPolicy: node.process.envPolicy,
          resolveExecutable: (name, options) => node.process.resolveExecutable(name, options),
          spawn: async (request) => {
            spawned += 1;
            return recorded(await node.process.spawn(request), spawned, frames);
          },
        },
      };
      const instance = await acpDriver.create(host, { instanceId: "standalone", config, environment: {} });
      try {
        const probe = await instance.probe();
        assert.equal(probe.installed, true);
        assert.equal(probe.version, "1.0.0");
        const session = await instance.openSession({});
        const events: AriEvent[] = [];
        void (async () => {
          for await (const event of session.events()) events.push(event);
        })();
        const thread = await session.createThread({ cwd: workspace, policy: { mode: "approval_required", interaction: "default", cwd: workspace } });
        const started = await session.startTurn({ threadId: thread.id, clientTurnKey: "standalone-1", intent: "start", content: [{ type: "text", text: "Say hello" }] });
        assert.equal(started.status, "accepted");
        const pending = await until(() => events.find((event) => event.body.type === "request.upsert" && event.body.request.status === "pending"), "the permission request");
        const request = pending.body.type === "request.upsert" ? pending.body.request : undefined;
        assert.equal(request?.kind, "command");
        assert.deepEqual(request?.subject?.command, ["echo", "hello"]);
        await session.respond({ requestId: request!.id, responseKey: "standalone-answer", optionId: answer });
        const terminal = await until(() => events.find((event) => event.body.type === "turn.terminal"), "turn.terminal", 10_000);
        assert.equal(terminal.body.type === "turn.terminal" && terminal.body.status, "completed");
        const opened = events.find((event) => event.body.type === "item.upsert" && event.body.item.kind === "command_execution");
        const toolId = opened?.body.type === "item.upsert" ? opened.body.item.id : undefined;
        const patches = events.flatMap((event) => (event.body.type === "item.upsert" && event.body.item.id === toolId ? [event.body.item] : []));
        assert.equal(patches.findLast((patch) => patch.status !== undefined)?.status, answer === "allow" ? "completed" : "failed");
        assert.equal(patches.findLast((patch) => patch.output !== undefined)?.output, answer === "allow" ? "hello" : "permission denied");
        await session.close();
        const check = checkFrames(frames);
        assert.deepEqual(check.problems, []);
        assert.ok(check.seen.has("agent session/request_permission Request") && check.seen.has("client session/request_permission Response"));
      } finally {
        await instance.dispose();
        await node.dispose();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
}
