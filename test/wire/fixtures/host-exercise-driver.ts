// A driver for the host-services test. It runs inside `ari-driver` and, when
// the test calls its `test.host` extension, calls host services through the
// `HostServices` it was created with and returns what each call gave back. The
// test then compares that with what its recording host answered and recorded.
//
// Extension methods:
// - `members`: which optional host members exist, the paths and envPolicy.
// - `watchConfig`: reads the config with `watch: true` and keeps the stream.
// - `nextConfig`: waits for the next config change, then stops watching.
// - `operations`: every other host operation, with the inputs in params.

import { referenceCapabilities } from "../../../src/conformance/reference/driver.ts";
import type { Capabilities, ConfigValues } from "../../../src/index.ts";
import type { Driver, HostServices, Instance, Session } from "../../../src/runtime.ts";
import { ARI_VERSION } from "../../../src/version.ts";

export interface OperationsParams {
  readonly command: string;
  readonly args: readonly string[];
  readonly longRunningArgs: readonly string[];
  readonly env: { readonly [name: string]: string };
}

const decoder = new TextDecoder();

async function readAll(source: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of source) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

async function operations(host: HostServices, params: OperationsParams): Promise<{ [name: string]: unknown }> {
  const report: { [name: string]: unknown } = {};

  await host.secrets.set("wire-test", "token", new Uint8Array([0, 1, 2, 250, 255]));
  report.secretAfterSet = [...((await host.secrets.get("wire-test", "token")) ?? [])];
  await host.secrets.delete("wire-test", "token");
  report.secretAfterDelete = await host.secrets.get("wire-test", "token");

  report.resolved = await host.process.resolveExecutable("wire-tool", { path: "/opt/wire/bin" });

  const child = await host.process.spawn({ command: params.command, args: [...params.args], env: { ...params.env }, purpose: "runtime", stdin: "pipe" });
  const stdout = readAll(child.stdout);
  const stderr = readAll(child.stderr);
  await child.write("ping from the driver\n");
  await child.closeStdin();
  report.spawn = { pid: typeof child.pid, stdout: await stdout, stderr: await stderr, exit: await child.exited };

  const sleeper = await host.process.spawn({ command: params.command, args: [...params.longRunningArgs], purpose: "runtime", stdin: "ignore" });
  void readAll(sleeper.stdout);
  void readAll(sleeper.stderr);
  await sleeper.kill("SIGTERM");
  report.killed = await sleeper.exited;

  report.attachment = await host.attachments.resolve("attachment-1");
  report.missingAttachment = await host.attachments.resolve("no-such-attachment");
  report.attachmentText = (await host.attachments.extractText?.("attachment-1")) ?? "<no extractText>";
  report.callback = await host.callbacks.register("flow-7");
  report.mcpServer = await host.hostTools.mcpServerFor("thread-9", { transport: "stdio" });
  report.dynamicTool = (await host.hostTools.callDynamicTool?.({ threadId: "thread-9", callId: "call-1", name: "lookup", input: { q: "wire" } })) ?? "<no callDynamicTool>";
  report.shouldRun = await host.background.shouldRun("catalog_refresh");

  const lease = await host.coordination.acquire("wire-lock", 60_000);
  const second = await host.coordination.acquire("wire-lock", 60_000);
  if (lease !== null) await host.coordination.release(lease.leaseId);
  const third = await host.coordination.acquire("wire-lock", 60_000);
  report.leases = { lease, second, third };

  host.diagnostics.log({ level: "info", msg: "hello from inside ari-driver", data: { n: 1 } });
  host.telemetry?.track("wire.exercised", { count: 17, ok: true });
  report.derived = (await host.ids?.derive("thread", "native-42")) ?? "<no ids>";
  return report;
}

function createSession(host: HostServices, instanceId: string): Session {
  const capabilities: Capabilities = { ...referenceCapabilities("minimal"), extensions: [{ ns: "test.host", version: "1.0.0" }] };
  let configChanges: AsyncIterator<ConfigValues> | undefined;
  return {
    id: `${instanceId}-session`,
    capabilities: () => capabilities,
    events: () => ({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }),
    }),
    createThread: async () => {
      throw new Error("not used");
    },
    resumeThread: async () => {
      throw new Error("not used");
    },
    canRelease: () => true,
    release: async () => undefined,
    startTurn: async () => ({ status: "unsupported", capability: "turns" }),
    interruptTurn: async () => undefined,
    respond: async () => undefined,
    planConfigChange: async () => ({ type: "reject", reason: "not used" }),
    close: async () => undefined,
    async ext(ns, method, params) {
      if (method === "members") {
        return {
          extractText: typeof host.attachments.extractText,
          callDynamicTool: typeof host.hostTools.callDynamicTool,
          telemetry: typeof host.telemetry?.track,
          ids: typeof host.ids?.derive,
          paths: host.paths,
          envPolicy: host.process.envPolicy,
        };
      }
      if (method === "watchConfig") {
        const reading = await host.config.get({ watch: true });
        configChanges = reading.changes?.[Symbol.asyncIterator]();
        return { config: reading.config, watching: configChanges !== undefined };
      }
      if (method === "nextConfig") {
        const next = await configChanges!.next();
        await configChanges!.return?.();
        return next.done === true ? { ended: true } : { config: next.value };
      }
      if (method === "operations") return operations(host, params as OperationsParams);
      throw new Error(`unknown method ${ns}.${method}`);
    },
  };
}

export const hostExerciseDriver: Driver = {
  kind: "host-exercise",
  ariVersion: ARI_VERSION,
  metadata: { displayName: "Host exercise", multipleInstances: true, hasDefaultInstance: false },
  configSchema: { type: "object" },
  defaultConfig: () => ({ level: 1 }),
  async create(host, input): Promise<Instance> {
    return {
      id: input.instanceId,
      continuationKey: "host-exercise",
      bindingKey: "host-exercise",
      status: async () => ({ state: "ready", installed: true }),
      statusChanges: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }) }),
      probe: async () => ({ ok: true, installed: true, checkedAt: new Date().toISOString() }),
      catalog: { list: async () => ({ models: [] }) },
      openSession: async () => createSession(host, input.instanceId),
      dispose: async () => undefined,
    };
  },
};
