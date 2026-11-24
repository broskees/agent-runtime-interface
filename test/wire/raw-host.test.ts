// ari/wire as a host in another language sees it: raw NDJSON frames to and
// from the built `ari-driver`, with no ARI client code on the host side. The
// driver inside is the committed host-exercise fixture, which calls every host
// operation; this host answers each one by hand. The last test turns it
// around: a raw driver drives the TypeScript host client frame by frame.

import assert from "node:assert/strict";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { createFakeHost } from "../../src/conformance/index.ts";
import { isAriError } from "../../src/index.ts";
import { connectDriver, defaultMethodVersions } from "../../src/wire/index.ts";
import type { HostServices } from "../../src/runtime.ts";
import { REPO_ROOT } from "../helpers/spec.ts";
import type { OperationsParams } from "./fixtures/host-exercise-driver.ts";
import { memoryTransportPair } from "./helpers.ts";
import { RawHost, callErrorAnswer } from "./raw-host.ts";
import type { Frame } from "./raw-host.ts";

const FIXTURE = path.join(REPO_ROOT, "test", "wire", "fixtures", "host-exercise-driver.ts");

/** The 17 host-service operations of inventory G, by wire method. */
const HOST_OPERATION_METHODS = [
  "host/config.get",
  "host/secrets.get",
  "host/secrets.set",
  "host/secrets.delete",
  "host/process.spawn",
  "host/process.resolveExecutable",
  "host/attachments.resolve",
  "host/attachments.extractText",
  "host/callbacks.register",
  "host/hostTools.mcpServerFor",
  "host/hostTools.callDynamicTool",
  "host/background.shouldRun",
  "host/coordination.acquire",
  "host/coordination.release",
  "host/diagnostics.log",
  "host/telemetry.track",
  "host/ids.derive",
];

const OPERATIONS: OperationsParams = { command: "raw-echo", args: ["--echo"], longRunningArgs: ["--sleep"], env: { WIRE_ADDED: "yes" } };

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

const hosts: RawHost[] = [];
after(async () => {
  for (const host of hosts) await host.close();
});

/**
 * A raw host serving every host operation the fixture calls, with simulated
 * child processes: the echo child answers its stdin on stdout when stdin
 * closes, then exits 3; the sleeper exits when killed.
 */
function servedHost(options: { readonly logAnswer?: "ok" | "error" } = {}): { host: RawHost; spawns: Frame[]; childOutput: Map<string, string> } {
  const host = RawHost.start([FIXTURE]);
  hosts.push(host);
  const secrets = new Map<string, string>();
  const leases = new Map<string, string>();
  const spawns: Frame[] = [];
  const childOutput = new Map<string, string>();
  const stdin = new Map<string, string>();
  let nextLease = 1;

  host.handle("host/config.get", (params) => (params.watch === true ? { result: { config: { level: 1 }, streamId: "cfg-1" } } : { result: { config: { level: 1 } } }));
  host.handle("stream/cancel", (params, frame) => {
    host.reply(frame.id, { result: null });
    host.notify("stream/end", { streamId: params.streamId });
    return undefined;
  });
  host.handle("host/secrets.get", (params) => ({ result: secrets.has(`${params.namespace}/${params.key}`) ? { base64: secrets.get(`${params.namespace}/${params.key}`) } : null }));
  host.handle("host/secrets.set", (params) => {
    secrets.set(`${params.namespace}/${params.key}`, params.value.base64);
    return { result: null };
  });
  host.handle("host/secrets.delete", (params) => {
    secrets.delete(`${params.namespace}/${params.key}`);
    return { result: null };
  });
  host.handle("host/process.resolveExecutable", (params) => ({ result: `${params.path ?? "/usr/bin"}/${params.name}` }));
  host.handle("host/process.spawn", (params, frame) => {
    spawns.push(frame);
    stdin.set(params.processId, "");
    // The answer comes first; the child's output and exit follow it.
    host.reply(frame.id, { result: { pid: 4000 + spawns.length } });
    return undefined;
  });
  host.handle("host/process.write", (params) => {
    stdin.set(params.processId, (stdin.get(params.processId) ?? "") + Buffer.from(params.data, "base64").toString("utf8"));
    return { result: null };
  });
  host.handle("host/process.closeStdin", (params, frame) => {
    host.reply(frame.id, { result: null });
    const output = JSON.stringify({ input: stdin.get(params.processId), secret: null, keep: "kept", added: "yes" });
    childOutput.set(params.processId, output);
    host.notify("host/process.output", { processId: params.processId, stream: "stdout", data: base64(output) });
    host.notify("host/process.output", { processId: params.processId, stream: "stderr", data: base64("child stderr") });
    host.notify("host/process.exit", { processId: params.processId, exit: { code: 3, signal: null } });
    return undefined;
  });
  host.handle("host/process.kill", (params, frame) => {
    host.reply(frame.id, { result: null });
    host.notify("host/process.exit", { processId: params.processId, exit: { code: null, signal: params.signal ?? "SIGTERM" } });
    return undefined;
  });
  host.handle("host/attachments.resolve", (params) => ({ result: params.ref === "attachment-1" ? { path: "/raw/one.txt", mime: "text/plain", size: 11 } : null }));
  host.handle("host/attachments.extractText", () => ({ result: "raw text" }));
  host.handle("host/callbacks.register", (params) => ({ result: { url: `https://raw.invalid/callback/${params.flowId}` } }));
  host.handle("host/hostTools.mcpServerFor", (params) => ({ result: { name: `raw-tools-${params.threadId}`, config: { name: `raw-tools-${params.threadId}`, transport: "stdio", command: "raw-tools" } } }));
  host.handle("host/hostTools.callDynamicTool", () => ({ result: { content: [{ type: "text", text: "raw dynamic" }] } }));
  host.handle("host/background.shouldRun", () => ({ result: true }));
  host.handle("host/coordination.acquire", (params) => {
    if (leases.has(params.key)) return { result: null };
    const leaseId = `raw-lease-${nextLease++}`;
    leases.set(params.key, leaseId);
    return { result: { leaseId, key: params.key, expiresAt: "2026-11-24T00:00:00.000Z" } };
  });
  host.handle("host/coordination.release", (params) => {
    for (const [key, leaseId] of leases) if (leaseId === params.leaseId) leases.delete(key);
    return { result: null };
  });
  const logAnswer = () => (options.logAnswer === "error" ? callErrorAnswer("invalid_state", "the log is full", { reason: "log_full" }) : { result: null });
  host.handle("host/diagnostics.log", logAnswer);
  host.handle("host/telemetry.track", logAnswer);
  host.handle("host/ids.derive", (params) => ({ result: `raw-${params.kind}-${params.key}` }));
  return { host, spawns, childOutput };
}

/** Initializes with process delegation, creates an instance with every optional host member, and opens a session. */
async function openSession(host: RawHost): Promise<string> {
  const initialized = await host.initialize({ host: { capabilities: { process: true }, envPolicy: { stripAmbient: [] } } });
  assert.equal(initialized.result.driver.kind, "host-exercise");
  await host.call("driver/create", {
    instanceId: "raw-1",
    config: { level: 1 },
    environment: {},
    paths: { stateDir: "/raw/state", cacheDir: "/raw/cache", tmpDir: "/raw/tmp" },
    hostMembers: ["attachments.extractText", "hostTools.callDynamicTool", "telemetry.track", "ids.derive"],
  });
  const session = await host.call("instance/openSession", { instanceId: "raw-1" });
  return session.sessionId as string;
}

describe("a raw NDJSON host driving ari-driver", () => {
  test("all 17 host operations arrive as JSON-RPC requests with ids, and each answer reaches the driver", async () => {
    const { host, spawns, childOutput } = servedHost();
    const sessionId = await openSession(host);
    const ext = (method: string, params: unknown = {}) => host.call("session/ext", { sessionId, ns: "test.host", method, params });

    assert.deepEqual(await ext("watchConfig"), { config: { level: 1 }, watching: true });
    host.notify("host/config.changed", { streamId: "cfg-1", config: { level: 2 } });
    assert.deepEqual(await ext("nextConfig"), { config: { level: 2 } });
    const cancel = await host.waitFor((frame) => frame.method === "stream/cancel", "the driver to cancel the config stream");
    assert.equal(typeof cancel.id, "number", "stream/cancel is a request");
    assert.deepEqual(cancel.params, { streamId: "cfg-1" });

    const report = await ext("operations", OPERATIONS);

    // Request framing: every operation came with an id, and this host answered each id once.
    const requests = host.received.filter((frame) => frame.method?.startsWith("host/") === true);
    for (const method of HOST_OPERATION_METHODS) {
      const frames = requests.filter((frame) => frame.method === method);
      assert.ok(frames.length > 0, `${method} reached the host`);
      for (const frame of frames) {
        assert.equal(typeof frame.id, "number", `${method} is a request with an id`);
        assert.equal(frame.params.instanceId, "raw-1", `${method} names the instance`);
        const answers = host.sent.filter((sent) => sent.id === frame.id && sent.method === undefined);
        assert.equal(answers.length, 1, `${method} (id ${String(frame.id)}) got one answer`);
      }
    }
    assert.ok(requests.every((frame) => typeof frame.id === "number"), "no host method arrives as a notification");
    assert.deepEqual(requests.find((frame) => frame.method === "host/diagnostics.log")!.params, { instanceId: "raw-1", level: "info", msg: "hello from inside ari-driver", data: { n: 1 } });
    assert.deepEqual(requests.find((frame) => frame.method === "host/telemetry.track")!.params, { instanceId: "raw-1", name: "wire.exercised", props: { count: 17, ok: true } });

    // The answers came back to the driver.
    assert.deepEqual(report.secretAfterSet, [0, 1, 2, 250, 255]);
    assert.equal(report.secretAfterDelete, null);
    assert.equal(report.resolved, "/opt/wire/bin/wire-tool");
    assert.deepEqual(report.attachment, { path: "/raw/one.txt", mime: "text/plain", size: 11 });
    assert.equal(report.missingAttachment, null);
    assert.equal(report.attachmentText, "raw text");
    assert.deepEqual(report.callback, { url: "https://raw.invalid/callback/flow-7" });
    assert.equal(report.mcpServer.name, "raw-tools-thread-9");
    assert.deepEqual(report.dynamicTool, { content: [{ type: "text", text: "raw dynamic" }] });
    assert.equal(report.shouldRun, true);
    assert.equal(report.leases.lease.leaseId, "raw-lease-1");
    assert.equal(report.leases.second, null);
    assert.equal(report.leases.third.leaseId, "raw-lease-2");
    assert.equal(report.derived, "raw-thread-native-42");

    // Two successive children, each named by the driver's own processId.
    assert.equal(spawns.length, 2);
    const [echo, sleeper] = spawns.map((frame) => frame.params.processId as string);
    assert.equal(typeof echo, "string");
    assert.notEqual(echo, sleeper, "process ids are never reused");
    assert.deepEqual(spawns[0]!.params, { instanceId: "raw-1", command: "raw-echo", args: ["--echo"], env: { WIRE_ADDED: "yes" }, purpose: "runtime", stdin: "pipe", processId: echo });
    assert.equal(report.spawn.pid, "number");
    assert.equal(report.spawn.stdout, childOutput.get(echo!));
    assert.equal(JSON.parse(report.spawn.stdout).input, "ping from the driver\n");
    assert.equal(report.spawn.stderr, "child stderr");
    assert.deepEqual(report.spawn.exit, { code: 3, signal: null });
    assert.deepEqual(report.killed, { code: null, signal: "SIGTERM" });
    assert.deepEqual(
      host.received.filter((frame) => frame.method === "host/process.kill").map((frame) => frame.params),
      [{ instanceId: "raw-1", processId: sleeper, signal: "SIGTERM" }],
    );

    // Every answer matched a request the driver was waiting on.
    assert.doesNotMatch(host.stderr, /matches no pending call|rejected|dropped/);

    // Output for a process id the driver never gave is dropped and reported, not misrouted.
    host.notify("host/process.output", { processId: echo, stream: "stdout", data: base64("late") });
    host.notify("host/process.exit", { processId: "p-unknown", exit: { code: 0, signal: null } });
    assert.deepEqual(await ext("members"), {
      extractText: "function",
      callDynamicTool: "function",
      telemetry: "function",
      ids: "function",
      paths: { stateDir: "/raw/state", cacheDir: "/raw/cache", tmpDir: "/raw/tmp" },
      envPolicy: { stripAmbient: [] },
    });
    assert.match(host.stderr, new RegExp(`dropped host/process.output for process ${echo}, which is not running`));
    assert.match(host.stderr, /dropped host\/process.exit for process p-unknown, which is not running/);
  });

  test("an error answer to diagnostics.log or telemetry.track reaches ari-driver, which reports it and goes on", async () => {
    const { host } = servedHost({ logAnswer: "error" });
    const sessionId = await openSession(host);
    const report = await host.call("session/ext", { sessionId, ns: "test.host", method: "operations", params: OPERATIONS });
    assert.equal(report.derived, "raw-thread-native-42", "the operations after the refused log still ran");
    await host.waitFor(() => /rejected host\/telemetry.track/.test(host.stderr), "the telemetry refusal on stderr");
    assert.match(host.stderr, /the host rejected host\/diagnostics.log: the log is full/);
    assert.match(host.stderr, /the host rejected host\/telemetry.track: the log is full/);
  });

  test("config watch: the answer must carry a streamId; a stream that ends at once means no changes", async () => {
    const { host } = servedHost();
    const sessionId = await openSession(host);
    const ext = (method: string) => host.request("session/ext", { sessionId, ns: "test.host", method, params: {} });

    host.handle("host/config.get", () => ({ result: { config: { level: 1 } } }));
    const refused = await ext("watchConfig");
    assert.equal(refused.error?.code, -32000);
    assert.equal(refused.error?.data.code, "protocol");
    assert.equal(refused.error?.data.detail, "missing_stream_id");

    host.handle("host/config.get", (_params, frame) => {
      host.reply(frame.id, { result: { config: { level: 1 }, streamId: "cfg-empty" } });
      host.notify("stream/end", { streamId: "cfg-empty" });
      return undefined;
    });
    assert.deepEqual((await ext("watchConfig")).result, { config: { level: 1 }, watching: true });
    assert.deepEqual((await ext("nextConfig")).result, { ended: true });
  });

  test("initialize refuses a host whose stream/cancel or stream/end has another major version", async () => {
    for (const method of ["stream/cancel", "stream/end", "initialize"]) {
      const host = RawHost.start([FIXTURE]);
      hosts.push(host);
      const refused = await host.initialize({ methodVersions: { [method]: { major: 2, minor: 0 } } });
      assert.equal(refused.error?.code, -32000, method);
      assert.equal(refused.error?.data.code, "protocol");
      assert.equal(refused.error?.data.detail, "core_method_version_mismatch");
      assert.match(refused.error!.message, new RegExp(`${method.replace("/", "\\/")} is incompatible: the host speaks version 2\\.0 and the driver speaks 1\\.0`));
      const after = await host.request("driver/defaultConfig", {});
      assert.equal(after.error?.data.reason, "not_initialized", "nothing is served after a refused initialize");
      const retried = await host.initialize();
      assert.equal(retried.result?.driver.kind, "host-exercise", "the host may send initialize again after a refusal");
    }
  });

  test("a refused stream item notification refuses the request that starts the stream; cancelling an ended stream answers null", async () => {
    const { host } = servedHost();
    await host.initialize({ methodVersions: { "ari/event": { major: 2, minor: 0 }, "instance/statusChanged": { major: 1, minor: 0 } } });
    await host.call("driver/create", { instanceId: "raw-1", config: {}, environment: {}, paths: { stateDir: "/s", cacheDir: "/c", tmpDir: "/t" } });
    const session = await host.call("instance/openSession", { instanceId: "raw-1" });
    const events = await host.request("session/events", { sessionId: session.sessionId });
    assert.equal(events.error?.data.code, "unsupported");
    assert.match(events.error!.message, /session\/events is unavailable because it needs ari\/event/);
    // The rest of the connection works, and stream/cancel answers null for a stream that already ended.
    const status = await host.call("instance/statusChanges", { instanceId: "raw-1" });
    await host.waitFor((frame) => frame.method === "stream/end" && frame.params.streamId === status.streamId, "the status stream to end");
    assert.deepEqual(await host.call("stream/cancel", { streamId: status.streamId }), null);
    assert.deepEqual(await host.call("stream/cancel", { streamId: "never-started" }), null);
    // A disposed instance and its sessions are forgotten.
    assert.equal(await host.call("instance/dispose", { instanceId: "raw-1" }), null);
    assert.equal((await host.request("instance/status", { instanceId: "raw-1" })).error?.data.code, "not_found");
    assert.equal((await host.request("session/close", { sessionId: session.sessionId })).error?.data.code, "not_found");
  });
});

describe("a raw driver driving the TypeScript host client", () => {
  /** The driver end of an in-memory connection, written and read frame by frame. */
  function rawDriver(transport: ReturnType<typeof memoryTransportPair>[0]) {
    const received: Frame[] = [];
    const waiting = new Set<() => void>();
    let buffered = "";
    void (async () => {
      for await (const chunk of transport.input) {
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          received.push(JSON.parse(buffered.slice(0, newline)) as Frame);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
        }
        for (const wake of [...waiting]) wake();
      }
    })();
    const send = (frame: object): void => void transport.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
    /** Takes the first received frame that matches, waiting for it. */
    const next = async (match: (frame: Frame) => boolean): Promise<Frame> => {
      for (;;) {
        const index = received.findIndex(match);
        if (index !== -1) return received.splice(index, 1)[0]!;
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            waiting.delete(wake);
            resolve();
          };
          waiting.add(wake);
        });
      }
    };
    /** Sends a request and takes its answer. */
    const call = async (id: number, method: string, params: object): Promise<Frame> => {
      send({ id, method, params });
      return next((frame) => frame.id === id && frame.method === undefined);
    };
    return { send, next, call };
  }

  /** A raw driver's answer to initialize, with `methodVersions` replaced when given. */
  function initializeResult(methodVersions = defaultMethodVersions()): object {
    return {
      ariVersion: "1.0.0",
      grammarVersions: [1, 1],
      methodVersions,
      persistenceVersion: { major: 1, minor: 0 },
      grammarVersion: 1,
      driver: { kind: "raw", ariVersion: "1.0.0", metadata: { displayName: "Raw", multipleInstances: true, hasDefaultInstance: false }, configSchema: {} },
    };
  }

  /** Connects the TypeScript host client to a raw driver and creates instance `raw-host-1` on `host`. */
  async function connectRaw(host: HostServices) {
    const [driverSide, hostSide] = memoryTransportPair();
    const driver = rawDriver(driverSide);
    const connecting = connectDriver(hostSide, { delegateProcesses: true });
    const initialize = await driver.next((frame) => frame.method === "initialize");
    driver.send({ id: initialize.id, result: initializeResult() });
    const defaultConfig = await driver.next((frame) => frame.method === "driver/defaultConfig");
    driver.send({ id: defaultConfig.id, result: {} });
    const connection = await connecting;
    const creating = connection.driver.create(host, { instanceId: "raw-host-1", config: {}, environment: {} });
    const create = await driver.next((frame) => frame.method === "driver/create");
    driver.send({ id: create.id, result: { instanceId: "raw-host-1", continuationKey: "k", bindingKey: "b", members: [] } });
    await creating;
    return { driver, connection };
  }

  test("host/process.spawn: the host refuses a processId the driver already used, and starts nothing", async () => {
    const fake = createFakeHost({
      spawn: async () => ({
        pid: 77,
        stdout: (async function* () {})(),
        stderr: (async function* () {})(),
        write: async () => undefined,
        closeStdin: async () => undefined,
        kill: async () => undefined,
        exited: new Promise(() => undefined),
      }),
    });
    const { driver, connection } = await connectRaw(fake);
    try {
      assert.deepEqual((await driver.call(1, "host/process.spawn", { instanceId: "raw-host-1", command: "agent", processId: "same" })).result, { pid: 77 });
      const reused = await driver.call(2, "host/process.spawn", { instanceId: "raw-host-1", command: "agent", processId: "same" });
      assert.equal(reused.error?.code, -32000);
      assert.equal(reused.error?.data.code, "invalid_state");
      assert.equal(reused.error?.data.reason, "duplicate_process_id");
      assert.equal(fake.spawns.length, 1, "the reused id started nothing");
      const missing = await driver.call(3, "host/process.spawn", { instanceId: "raw-host-1", command: "agent" });
      assert.equal(missing.error?.code, -32602, "a spawn without a processId is invalid params");
      // Another instance cannot reach this instance's child.
      const foreign = await driver.call(4, "host/process.kill", { instanceId: "someone-else", processId: "same" });
      assert.equal(foreign.error?.data.code, "not_found");
    } finally {
      await connection.close();
    }
  });

  test("host/config.get with watch: true is always answered with a streamId, which ends at once when there is nothing to watch", async () => {
    const fake = createFakeHost();
    const host: HostServices = { ...fake, config: { get: async () => ({ config: { level: 5 } }) } } as HostServices;
    const { driver, connection } = await connectRaw(host);
    try {
      const plain = await driver.call(1, "host/config.get", { instanceId: "raw-host-1" });
      assert.deepEqual(plain.result, { config: { level: 5 } }, "no watch, no streamId");
      const watched = await driver.call(2, "host/config.get", { instanceId: "raw-host-1", watch: true });
      assert.deepEqual(watched.result.config, { level: 5 });
      assert.equal(typeof watched.result.streamId, "string", "a watch is always answered with a stream");
      await driver.next((frame) => frame.method === "stream/end" && frame.params.streamId === watched.result.streamId);
    } finally {
      await connection.close();
    }
  });

  test("host/diagnostics.log and host/telemetry.track are requests the host answers with null or an error", async () => {
    const fake = createFakeHost();
    const { driver, connection } = await connectRaw(fake);
    try {
      assert.deepEqual(await driver.call(4, "host/diagnostics.log", { instanceId: "raw-host-1", level: "warn", msg: "careful" }), { jsonrpc: "2.0", id: 4, result: null });
      assert.deepEqual(fake.diagnosticEntries, [{ level: "warn", msg: "careful" }]);
      assert.deepEqual(await driver.call(5, "host/telemetry.track", { instanceId: "raw-host-1", name: "t", props: { a: 1 } }), { jsonrpc: "2.0", id: 5, result: null });
      assert.deepEqual(fake.telemetryEvents, [{ name: "t", props: { a: 1 } }]);
      assert.equal((await driver.call(6, "host/diagnostics.log", { instanceId: "nobody", level: "info", msg: "lost" })).error?.data.code, "not_found");
      assert.equal((await driver.call(7, "host/diagnostics.log", { instanceId: "raw-host-1", msg: "no level" })).error?.code, -32602);
    } finally {
      await connection.close();
    }
  });

  test("the host refuses a driver that does not list a core method, or lists one at another major version", async () => {
    for (const [method, versions] of [
      ["stream/cancel", (all: { [method: string]: { major: number; minor: number } }) => without(all, "stream/cancel")],
      ["stream/end", (all: { [method: string]: { major: number; minor: number } }) => ({ ...all, "stream/end": { major: 2, minor: 0 } })],
    ] as const) {
      const [driverSide, hostSide] = memoryTransportPair();
      const driver = rawDriver(driverSide);
      const connecting = connectDriver(hostSide);
      const initialize = await driver.next((frame) => frame.method === "initialize");
      driver.send({ id: initialize.id, result: initializeResult(versions(defaultMethodVersions())) });
      await assert.rejects(connecting, (error: unknown) => {
        assert.ok(isAriError(error, "protocol"), String(error));
        assert.match(error.message, new RegExp(method));
        return true;
      });
      hostSide.close();
    }
  });
});

function without<T extends object>(value: T, key: string): T {
  const copy = { ...value } as { [key: string]: unknown };
  delete copy[key];
  return copy as T;
}
