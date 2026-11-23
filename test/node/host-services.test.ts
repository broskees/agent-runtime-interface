// `createNodeHostServices` gives a driver every `HostServices` member from
// `ari/node` plus the pieces a host supplies (config, attachments, host
// tools), and the loopback callback server routes a sign-in callback back to
// the host once.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import type { AuthCompleteInput, HostServices } from "../../src/index.ts";
import { createCoordination, createNodeHostServices, startCallbackServer } from "../../src/node/index.ts";
import type { DiagnosticRecord } from "../../src/node/index.ts";

type ExampleConfig = { binaryPath: string };

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += Buffer.from(chunk).toString("utf8");
  return text;
}

describe("ari/node host services", () => {
  let hostRoot: string;
  before(async () => {
    hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ari-host-services-"));
  });
  after(async () => {
    await fs.rm(hostRoot, { recursive: true, force: true });
  });

  test("a Node host hands a driver every HostServices member", async () => {
    const callbacks = await startCallbackServer({ onCallback: () => {} });
    const coordination = createCoordination();
    const records: DiagnosticRecord[] = [];
    const tracked: string[] = [];
    const services = await createNodeHostServices<ExampleConfig>({
      hostRoot,
      instanceId: "codex-work",
      config: { get: async () => ({ config: { binaryPath: "/usr/bin/agent" } }) },
      attachments: { resolve: async (ref) => (ref === "known" ? { path: "/tmp/a.png", mime: "image/png", size: 3 } : null) },
      hostTools: {
        mcpServerFor: async (threadId) => ({
          name: `host-tools-${threadId}`,
          config: { name: `host-tools-${threadId}`, transport: "stdio", command: "host-tools" },
        }),
      },
      callbacks,
      coordination,
      writeDiagnostic: (record) => records.push(record),
      envPolicy: { stripAmbient: ["GOOGLE_*"] },
      baseEnv: { PATH: process.env.PATH, GOOGLE_APPLICATION_CREDENTIALS: "/adc.json", KEEP_ME: "1" },
      telemetry: { track: (name) => tracked.push(name) },
      ids: { derive: async (kind, key) => `${kind}:${key}` },
    });
    try {
      // The value is typed as the interface a driver receives.
      const host: HostServices<ExampleConfig> = services;
      const memberKinds = {
        "paths.stateDir": typeof host.paths.stateDir,
        "paths.cacheDir": typeof host.paths.cacheDir,
        "paths.tmpDir": typeof host.paths.tmpDir,
        "config.get": typeof host.config.get,
        "secrets.get": typeof host.secrets.get,
        "secrets.set": typeof host.secrets.set,
        "secrets.delete": typeof host.secrets.delete,
        "process.envPolicy": typeof host.process.envPolicy,
        "process.spawn": typeof host.process.spawn,
        "process.resolveExecutable": typeof host.process.resolveExecutable,
        "attachments.resolve": typeof host.attachments.resolve,
        "callbacks.register": typeof host.callbacks.register,
        "hostTools.mcpServerFor": typeof host.hostTools.mcpServerFor,
        "background.shouldRun": typeof host.background.shouldRun,
        "coordination.acquire": typeof host.coordination.acquire,
        "coordination.release": typeof host.coordination.release,
        "diagnostics.log": typeof host.diagnostics.log,
        "telemetry.track": typeof host.telemetry?.track,
        "ids.derive": typeof host.ids?.derive,
      };
      for (const [member, kind] of Object.entries(memberKinds)) {
        assert.ok(kind === "function" || kind === "string" || kind === "object", `${member} is ${kind}`);
      }

      for (const directory of Object.values(host.paths)) assert.ok((await fs.stat(directory)).isDirectory());
      assert.deepEqual((await host.config.get()).config, { binaryPath: "/usr/bin/agent" });
      assert.equal(await host.attachments.resolve("missing"), null);
      assert.equal((await host.hostTools.mcpServerFor("t1", { transport: "stdio" })).name, "host-tools-t1");
      assert.match((await host.callbacks.register("flow-1")).url, /^http:\/\/127\.0\.0\.1:\d+\/callback\//);
      assert.ok((await host.coordination.acquire("k", 1000)) !== null);
      assert.equal(await host.ids?.derive("thread", "native-1"), "thread:native-1");
      host.telemetry?.track("session.opened");
      assert.deepEqual(tracked, ["session.opened"]);

      // Secrets live under the instance's state dir.
      await host.secrets.set("codex", "token", new TextEncoder().encode("tok-123456789"));
      const files = await fs.readdir(host.paths.stateDir, { recursive: true });
      assert.ok(files.some((file) => file.startsWith("secrets")), "the secret is stored under stateDir");

      // A secret read or written through the services is redacted from diagnostics.
      host.diagnostics.log({ level: "info", msg: "using tok-123456789", data: { token: "tok-123456789" } });
      assert.deepEqual(records.at(-1), { level: "info", msg: "using [redacted]", data: { token: "[redacted]" } });

      // Spawns follow the env policy.
      const child = await host.process.spawn({
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        stdin: "ignore",
      });
      const environment = JSON.parse(await readAll(child.stdout)) as Record<string, string>;
      assert.equal("GOOGLE_APPLICATION_CREDENTIALS" in environment, false);
      assert.equal(environment.KEEP_ME, "1");
      assert.deepEqual(host.process.envPolicy, { stripAmbient: ["GOOGLE_*"] });

      assert.equal(await host.background.shouldRun("usage-refresh"), true);
      await services.dispose();
      assert.equal(await host.background.shouldRun("usage-refresh"), false, "background work stops after dispose");
      await assert.rejects(host.process.spawn({ command: process.execPath }));
    } finally {
      await services.dispose();
      await callbacks.close();
    }
  });

  test("two instances of one host get separate paths and secrets but share coordination", async () => {
    const coordination = createCoordination();
    const common = {
      hostRoot,
      config: { get: async () => ({ config: {} }) },
      attachments: { resolve: async () => null },
      hostTools: { mcpServerFor: async () => ({ name: "tools", config: { name: "tools", transport: "stdio" as const, command: "tools" } }) },
      callbacks: { register: async () => ({ url: "http://127.0.0.1:1/callback" }) },
      coordination,
      writeDiagnostic: () => {},
    };
    const first = await createNodeHostServices({ ...common, instanceId: "account-1" });
    const second = await createNodeHostServices({ ...common, instanceId: "account-2" });
    try {
      assert.notEqual(first.paths.stateDir, second.paths.stateDir);
      await first.secrets.set("ns", "key", new TextEncoder().encode("first"));
      assert.equal(await second.secrets.get("ns", "key"), null);
      const lease = await first.coordination.acquire("reset-credit:shared-account", 5000);
      assert.ok(lease !== null);
      assert.equal(await second.coordination.acquire("reset-credit:shared-account", 5000), null);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  test("the callback server hands the host the requested URL once, for the registered flow only", async () => {
    const received: AuthCompleteInput[] = [];
    const server = await startCallbackServer({ onCallback: (input) => void received.push(input) });
    try {
      const { url } = await server.register("flow-42");
      assert.ok(url.startsWith(`${server.url}/callback/`));
      const other = await server.register("flow-43");
      assert.notEqual(other.url, url);

      const response = await fetch(`${url}?code=abc&state=xyz`);
      assert.equal(response.status, 200);
      assert.deepEqual(received, [{ flowId: "flow-42", callbackUrl: `${url}?code=abc&state=xyz` }]);

      assert.equal((await fetch(`${url}?code=again`)).status, 404, "a registration is used once");
      assert.equal((await fetch(`${server.url}/callback/guessed`)).status, 404);
      assert.equal(received.length, 1);
    } finally {
      await server.close();
    }
  });

  test("a callback the host fails to complete answers 500", async () => {
    const server = await startCallbackServer({
      onCallback: async () => {
        throw new Error("no such flow");
      },
    });
    try {
      const { url } = await server.register("flow-x");
      assert.equal((await fetch(url)).status, 500);
    } finally {
      await server.close();
    }
  });
});
