// Host services cross the wire. A driver running inside the built `ari-driver`
// calls host services through the `HostServices` it was created with; each
// call travels as a `host/*` JSON-RPC request (or notification) to this test
// process, reaches a recording host (`createFakeHost`), and the host's answer
// travels back. The test checks both ends: what the recording host saw, and
// what the driver got.
//
// Two spawn modes:
// - The host offers `host.process`: spawns and executable lookups come back
//   to the host, which starts a real child; the child's stdin, stdout, stderr,
//   kill and exit cross the wire. All 17 operations reach the host.
// - It does not: the driver spawns locally inside `ari-driver`, stripping
//   the variables named by the `envPolicy` the host sent in `initialize`, and
//   the host sees no process call.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { HOST_OPERATIONS, createFakeHost } from "../../src/conformance/index.ts";
import type { FakeHost, FakeHostOptions } from "../../src/conformance/index.ts";
import type { AriDriverProcess, WireSession } from "../../src/wire/index.ts";
import { toSpawnedProcess } from "../helpers/conformance.ts";
import { REPO_ROOT } from "../helpers/spec.ts";
import type { OperationsParams } from "./fixtures/host-exercise-driver.ts";
import { startBuiltAriDriver } from "./helpers.ts";

const FIXTURE = path.join(REPO_ROOT, "test", "wire", "fixtures", "host-exercise-driver.ts");

/** A child that echoes its stdin to stdout, reports three variables and writes to stderr. */
const ECHO_SCRIPT = [
  "let input = '';",
  "process.stdin.on('data', (chunk) => { input += chunk; });",
  "process.stdin.on('end', () => {",
  "  process.stdout.write(JSON.stringify({ input, secret: process.env.WIRE_SECRET_TOKEN ?? null, keep: process.env.WIRE_KEEP ?? null, added: process.env.WIRE_ADDED ?? null }));",
  "  process.stderr.write('child stderr');",
  "  process.exitCode = 3;",
  "});",
].join("\n");

const OPERATIONS: OperationsParams = {
  command: process.execPath,
  args: ["-e", ECHO_SCRIPT],
  longRunningArgs: ["-e", "setInterval(() => {}, 1000)"],
  env: { WIRE_ADDED: "yes" },
};

const AMBIENT = { WIRE_SECRET_TOKEN: "s3cret", WIRE_KEEP: "kept" };
const ENV_POLICY = { stripAmbient: ["WIRE_SECRET_*"] };

const running: AriDriverProcess[] = [];
after(async () => {
  for (const driver of running) await driver.close();
});

function recordingHost(extra: Partial<FakeHostOptions> = {}): FakeHost {
  return createFakeHost({
    label: "wire-host",
    config: { level: 1 },
    paths: { stateDir: "/wire/state", cacheDir: "/wire/cache", tmpDir: "/wire/tmp" },
    envPolicy: ENV_POLICY,
    ambientEnvironment: AMBIENT,
    resolveExecutable: async (name, options) => `${options?.path ?? "/usr/bin"}/${name}`,
    spawn: async (request) =>
      toSpawnedProcess(spawn(request.command, request.args ?? [], { env: { ...request.environment }, stdio: [request.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"] })),
    attachments: { "attachment-1": { info: { path: "/wire/attachments/one.txt", mime: "text/plain", size: 11 }, text: "hello world" } },
    callDynamicTool: async (call) => ({ content: [{ type: "text", text: `looked up ${JSON.stringify(call.input)}` }] }),
    backgroundAllowed: false,
    ...extra,
  });
}

async function openExerciseSession(driver: AriDriverProcess, host: FakeHost, instanceId: string): Promise<WireSession> {
  const instance = await driver.driver.create(host, { instanceId, config: { level: 1 }, environment: {} });
  return (await instance.openSession({})) as WireSession;
}

describe("host services over ari/wire", () => {
  test("with host.process, all 17 host operations travel to the host and return its results", async () => {
    const driver = await startBuiltAriDriver({ driver: FIXTURE, delegateProcesses: true, envPolicy: ENV_POLICY });
    running.push(driver);
    const host = recordingHost();
    const session = await openExerciseSession(driver, host, "delegated");

    const members = (await session.ext!("test.host", "members", {})) as { [key: string]: unknown };
    assert.deepEqual(members, {
      extractText: "function",
      callDynamicTool: "function",
      telemetry: "function",
      ids: "function",
      paths: { stateDir: "/wire/state", cacheDir: "/wire/cache", tmpDir: "/wire/tmp" },
      envPolicy: ENV_POLICY,
    });

    // config.get with a change stream: the change made here reaches the driver.
    assert.deepEqual(await session.ext!("test.host", "watchConfig", {}), { config: { level: 1 }, watching: true });
    host.setConfig({ level: 2 });
    assert.deepEqual(await session.ext!("test.host", "nextConfig", {}), { config: { level: 2 } });

    const report = (await session.ext!("test.host", "operations", OPERATIONS)) as { [key: string]: any };
    assert.deepEqual(report.secretAfterSet, [0, 1, 2, 250, 255]);
    assert.equal(report.secretAfterDelete, null);
    assert.equal(report.resolved, "/opt/wire/bin/wire-tool");
    // The host spawned the child: its environment follows the host's envPolicy, and its stdio and exit crossed the wire.
    assert.deepEqual(JSON.parse(report.spawn.stdout), { input: "ping from the driver\n", secret: null, keep: "kept", added: "yes" });
    assert.equal(report.spawn.stderr, "child stderr");
    assert.equal(report.spawn.pid, "number");
    assert.deepEqual(report.spawn.exit, { code: 3, signal: null });
    assert.deepEqual(report.killed, { code: null, signal: "SIGTERM" });
    assert.deepEqual(report.attachment, { path: "/wire/attachments/one.txt", mime: "text/plain", size: 11 });
    assert.equal(report.missingAttachment, null);
    assert.equal(report.attachmentText, "hello world");
    assert.deepEqual(report.callback, { url: "http://127.0.0.1/ari-conformance/callback/flow-7" });
    assert.equal(report.mcpServer.name, "host-tools-thread-9");
    assert.deepEqual(report.dynamicTool, { content: [{ type: "text", text: 'looked up {"q":"wire"}' }] });
    assert.equal(report.shouldRun, false);
    assert.equal(report.leases.lease.key, "wire-lock");
    assert.equal(report.leases.second, null, "the lease is exclusive across the wire");
    assert.equal(report.leases.third.key, "wire-lock", "release crossed the wire");
    assert.notEqual(report.leases.third.leaseId, report.leases.lease.leaseId);
    assert.equal(report.derived, await createFakeHost().ids!.derive("thread", "native-42"));

    // The recording host saw every operation, with the driver's arguments.
    const seen = new Set(host.calls.map((call) => call.operation));
    assert.deepEqual([...HOST_OPERATIONS].filter((operation) => !seen.has(operation)), []);
    const args = (operation: string) => host.calls.filter((call) => call.operation === operation).map((call) => call.args);
    assert.deepEqual(args("config.get"), [[{ watch: true }]]);
    assert.deepEqual(args("secrets.set").map(([namespace, key, value]) => [namespace, key, [...(value as Uint8Array)]]), [["wire-test", "token", [0, 1, 2, 250, 255]]]);
    assert.deepEqual(args("process.resolveExecutable"), [["wire-tool", { path: "/opt/wire/bin" }]]);
    assert.deepEqual(
      host.spawns.map((request) => request.args),
      [OPERATIONS.args, OPERATIONS.longRunningArgs],
    );
    assert.equal(host.spawns[0]!.environment.WIRE_SECRET_TOKEN, undefined);
    assert.deepEqual(args("hostTools.mcpServerFor"), [["thread-9", { transport: "stdio" }]]);
    assert.deepEqual(args("coordination.acquire").length, 3);
    assert.deepEqual(args("background.shouldRun"), [["catalog_refresh"]]);
    assert.deepEqual(host.diagnosticEntries, [{ level: "info", msg: "hello from inside ari-driver", data: { n: 1 } }]);
    assert.deepEqual(host.telemetryEvents, [{ name: "wire.exercised", props: { count: 17, ok: true } }]);
    assert.deepEqual(args("ids.derive"), [["thread", "native-42"]]);
  });

  test("without host.process, the driver spawns locally with the initialize envPolicy and the host sees no process call", async () => {
    const driver = await startBuiltAriDriver({
      driver: FIXTURE,
      delegateProcesses: false,
      envPolicy: ENV_POLICY,
      env: { ...process.env, ...AMBIENT },
    });
    running.push(driver);
    const host = recordingHost({
      spawn: async () => {
        throw new Error("the host must not be asked to spawn");
      },
    });
    const session = await openExerciseSession(driver, host, "local");
    const report = (await session.ext!("test.host", "operations", OPERATIONS)) as { [key: string]: any };

    // The local spawn stripped WIRE_SECRET_* from ari-driver's own environment, kept the rest and added the request's env.
    assert.deepEqual(JSON.parse(report.spawn.stdout), { input: "ping from the driver\n", secret: null, keep: "kept", added: "yes" });
    assert.equal(report.spawn.stderr, "child stderr");
    assert.deepEqual(report.spawn.exit, { code: 3, signal: null });
    assert.equal(report.killed.signal, "SIGTERM");
    // The executable lookup ran where the spawn runs: locally, not on the host.
    assert.equal(report.resolved, null);
    const operations = new Set(host.calls.map((call) => call.operation));
    assert.equal(operations.has("process.spawn"), false);
    assert.equal(operations.has("process.resolveExecutable"), false);
    assert.equal(host.spawns.length, 0);
    // Every other operation still reached the host.
    for (const operation of HOST_OPERATIONS) {
      if (operation === "process.spawn" || operation === "process.resolveExecutable" || operation === "config.get") continue;
      assert.ok(operations.has(operation), `${operation} reached the host`);
    }
  });

  test("optional host members the host does not have are absent inside the driver", async () => {
    const driver = await startBuiltAriDriver({ driver: FIXTURE });
    running.push(driver);
    const fake = recordingHost();
    const host = {
      ...fake,
      attachments: { resolve: fake.attachments.resolve },
      hostTools: { mcpServerFor: fake.hostTools.mcpServerFor },
      telemetry: undefined,
      ids: undefined,
    } as unknown as FakeHost;
    const session = await openExerciseSession(driver, host, "minimal-host");
    const members = (await session.ext!("test.host", "members", {})) as { [key: string]: unknown };
    assert.equal(members.extractText, "undefined");
    assert.equal(members.callDynamicTool, "undefined");
    assert.equal(members.telemetry, "undefined");
    assert.equal(members.ids, "undefined");
    assert.deepEqual(members.envPolicy, { stripAmbient: [] }, "a host that sends no envPolicy strips nothing");
  });
});
