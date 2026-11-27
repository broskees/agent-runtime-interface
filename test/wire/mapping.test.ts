// Every member of `Instance` and `Session` crosses the wire with its
// arguments and result intact, optional members exist over the wire exactly
// when the driver has them, synchronous members answer from what the driver
// reported, and errors keep their call error. The driver runs in this process
// behind `serveDriver`, connected to `connectDriver` by an in-memory
// transport pair; the recording driver notes the arguments each member got.

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test } from "node:test";
import { createFakeHost } from "../../src/conformance/index.ts";
import type { FakeHost } from "../../src/conformance/index.ts";
import { AriError, isAriError } from "../../src/index.ts";
import type { AriEvent, Capabilities } from "../../src/index.ts";
import type { Instance, Session } from "../../src/runtime.ts";
import { OPTIONAL_INSTANCE_MEMBERS, OPTIONAL_SESSION_MEMBERS, connectDriver, serveDriver } from "../../src/wire/index.ts";
import type { WireDriverConnection, WireSession } from "../../src/wire/index.ts";
import { RECORDING_AUTH_METHODS, createRecordingDriver, echo } from "./fixtures/recording-driver.ts";
import type { RecordingDriver } from "./fixtures/recording-driver.ts";
import { memoryTransportPair } from "./helpers.ts";

interface Rig {
  readonly recording: RecordingDriver;
  readonly connection: WireDriverConnection;
  readonly host: FakeHost;
  readonly instance: Instance;
  readonly session: WireSession;
  close(): Promise<void>;
}

async function rig(options: { full: boolean; failWith?: (member: string) => unknown }): Promise<Rig> {
  const recording = createRecordingDriver(options);
  const [driverSide, hostSide] = memoryTransportPair();
  const server = serveDriver(recording.driver, driverSide);
  const connection = await connectDriver(hostSide);
  const host = createFakeHost({ label: "mapping", paths: { stateDir: "/m/state", cacheDir: "/m/cache", tmpDir: "/m/tmp" } });
  const instance = await connection.driver.create(host, { instanceId: "mapping-1", config: { level: 7 }, environment: { A: "1" } });
  const session = (await instance.openSession({ emitDiffs: false })) as WireSession;
  return {
    recording,
    connection,
    host,
    instance,
    session,
    async close() {
      await connection.close();
      await server.closed;
    },
  };
}

/** Polls `check` until it holds. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(2);
  }
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

const POLICY = { mode: "approval_required", interaction: "default", cwd: "/w" } as const;

describe("instance members over ari/wire", () => {
  test("each member reaches the driver with its arguments and returns the driver's result", async () => {
    const { recording, connection, instance, close } = await rig({ full: true });
    try {
      const target = await connection.driver.create(createFakeHost(), { instanceId: "mapping-2", config: {}, environment: {} });
      const handle = { driverKind: "recording", handle: "h-1", identityVersion: 1, persistence: { major: 1, minor: 0 } };
      const cases: Array<{ member: string; call: () => Promise<unknown>; args: unknown[]; result: unknown }> = [
        { member: "status", call: () => instance.status(), args: [], result: { state: "ready", installed: true } },
        { member: "probe", call: () => instance.probe({ deep: true }), args: [{ deep: true }], result: echo("probe", [{ deep: true }]) },
        { member: "probe", call: () => instance.probe(), args: [], result: echo("probe", []) },
        { member: "invalidateCaches", call: () => instance.invalidateCaches!(), args: [], result: undefined },
        { member: "maintenance.advisory", call: () => instance.maintenance!.advisory(), args: [], result: null },
        { member: "auth.state", call: () => instance.auth!.state(), args: [], result: echo("auth.state", []) },
        { member: "auth.reportRuntimeFailure", call: () => instance.auth!.reportRuntimeFailure!({ message: "401", code: "unauthorized" }), args: [{ message: "401", code: "unauthorized" }], result: echo("auth.reportRuntimeFailure", [{ message: "401", code: "unauthorized" }]) },
        { member: "auth.start", call: () => instance.auth!.start({ ownerSessionId: "s", methodId: "api-key", callback: { mode: "server" } }), args: [{ ownerSessionId: "s", methodId: "api-key", callback: { mode: "server" } }], result: echo("auth.start", [{ ownerSessionId: "s", methodId: "api-key", callback: { mode: "server" } }]) },
        { member: "auth.complete", call: () => instance.auth!.complete({ flowId: "f-1", callbackUrl: "http://cb" }), args: [{ flowId: "f-1", callbackUrl: "http://cb" }], result: echo("auth.complete", [{ flowId: "f-1", callbackUrl: "http://cb" }]) },
        { member: "auth.respond", call: () => instance.auth!.respond!({ flowId: "f-1", values: { apiKey: "k" } }), args: [{ flowId: "f-1", values: { apiKey: "k" } }], result: echo("auth.respond", [{ flowId: "f-1", values: { apiKey: "k" } }]) },
        { member: "auth.cancel", call: () => instance.auth!.cancel("f-1"), args: ["f-1"], result: echo("auth.cancel", ["f-1"]) },
        { member: "auth.logout", call: () => instance.auth!.logout!(), args: [], result: undefined },
        { member: "auth.transferProfile", call: () => instance.auth!.transferProfile!({ format: "token", data: "abc" }), args: [{ format: "token", data: "abc" }], result: echo("auth.transferProfile", [{ format: "token", data: "abc" }]) },
        { member: "catalog.list", call: () => instance.catalog.list({ cwd: "/w" }), args: [{ cwd: "/w" }], result: echo("catalog.list", [{ cwd: "/w" }]) },
        { member: "catalog.list", call: () => instance.catalog.list(), args: [], result: echo("catalog.list", []) },
        { member: "catalog.refresh", call: () => instance.catalog.refresh!(), args: [], result: undefined },
        { member: "workspace.snapshot", call: () => instance.workspace!.snapshot("/w"), args: ["/w"], result: echo("workspace.snapshot", ["/w"]) },
        { member: "limits.current", call: () => instance.limits!.current(), args: [], result: echo("limits.current", []) },
        { member: "limits.consumeResetCredit", call: () => instance.limits!.consumeResetCredit!({ idempotencyKey: "i-1" }), args: [{ idempotencyKey: "i-1" }], result: echo("limits.consumeResetCredit", [{ idempotencyKey: "i-1" }]) },
        { member: "textGeneration.generate", call: () => instance.textGeneration!.generate({ kind: "title", input: "fix" }), args: [{ kind: "title", input: "fix" }], result: echo("textGeneration.generate", [{ kind: "title", input: "fix" }]) },
        { member: "nativeSessions.list", call: () => instance.nativeSessions!.list({ cwd: "/w", cursor: "c" }), args: [{ cwd: "/w", cursor: "c" }], result: echo("nativeSessions.list", [{ cwd: "/w", cursor: "c" }]) },
        { member: "nativeSessions.delete", call: () => instance.nativeSessions!.delete!("n-1"), args: ["n-1"], result: undefined },
        { member: "nativeSessions.archive", call: () => instance.nativeSessions!.archive!("n-2"), args: ["n-2"], result: undefined },
        { member: "subProviders.list", call: () => instance.subProviders!.list("/w"), args: ["/w"], result: [echo("subProviders.list", ["/w"])] },
        { member: "subProviders.set", call: () => instance.subProviders!.set({ cwd: "/w", providerId: "p" }), args: [{ cwd: "/w", providerId: "p" }], result: undefined },
        { member: "subProviders.disable", call: () => instance.subProviders!.disable({ cwd: "/w", providerId: "p" }), args: [{ cwd: "/w", providerId: "p" }], result: undefined },
      ];
      for (const { member, call, args, result } of cases) {
        const before = recording.calls.length;
        assert.deepEqual(await call(), result, `${member}: result`);
        const received = recording.calls.slice(before).filter((entry) => entry.member === member);
        assert.deepEqual(received.map((entry) => entry.args), [args], `${member}: arguments`);
      }

      // auth.transferSession names its target by id over the wire; the driver gets its own instance object.
      const transferred = await instance.auth!.transferSession!(handle as never, target);
      assert.deepEqual(transferred, echo("auth.transferSession", [handle, "mapping-2"]));

      // Streams.
      assert.deepEqual(await collect(instance.statusChanges()), [{ state: "starting", installed: true }, { state: "ready", installed: true }]);
      const range = { from: "2026-11-23T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" };
      assert.equal((await collect(instance.usageHistory!.scan(range))).length, 2);
      assert.deepEqual(recording.calls.filter((entry) => entry.member === "usageHistory.scan").map((entry) => entry.args), [[range]]);

      // Non-method members.
      assert.equal(instance.id, "mapping-1");
      assert.equal(instance.continuationKey, "recording-continuation");
      assert.equal(instance.bindingKey, "recording-binding");
      assert.deepEqual(instance.auth!.credentialBinding, { owner: "host", key: "recording-credential" });
      assert.deepEqual(instance.textGeneration!.guarantees, { toolsDisabled: "native" });
      assert.equal(instance.limits!.accountKey(), "account-key-1");
      await until(() => instance.auth!.methods().length > 0, "auth.methods to be read");
      assert.deepEqual(instance.auth!.methods(), RECORDING_AUTH_METHODS);

      // driver.create and instance.openSession got the host's input.
      const host = recording.host("mapping-1");
      assert.deepEqual(host.paths, { stateDir: "/m/state", cacheDir: "/m/cache", tmpDir: "/m/tmp" });
      assert.deepEqual(recording.calls.find((entry) => entry.member === "openSession")?.args, [{ emitDiffs: false }]);

      // dispose reaches the driver, and the instance's host routing goes with it.
      await target.dispose();
      assert.equal(recording.calls.filter((entry) => entry.member === "dispose").length, 1);
    } finally {
      await close();
    }
  });

  test("the driver's non-method members and defaultConfig come from the handshake", async () => {
    const { connection, close } = await rig({ full: true });
    try {
      const driver = connection.driver;
      assert.equal(driver.kind, "recording");
      assert.equal(driver.metadata.displayName, "Recording");
      assert.deepEqual(driver.configSchema, { type: "object", properties: { level: { type: "integer" } } });
      assert.deepEqual(driver.cliManifest, { binary: "recording-agent", envScrubPrefixes: ["RECORDING_"], args: { fresh: [] } });
      const config = driver.defaultConfig() as { level: number };
      assert.deepEqual(config, { level: 7 });
      config.level = 99;
      assert.deepEqual(driver.defaultConfig(), { level: 7 }, "each call returns its own copy");
    } finally {
      await close();
    }
  });
});

describe("session members over ari/wire", () => {
  test("each member reaches the driver with its arguments and returns the driver's result", async () => {
    const { recording, session, close } = await rig({ full: true });
    try {
      const turn = { threadId: "t-1", clientTurnKey: "k-1", intent: "start", content: [{ type: "text", text: "hi" }] } as const;
      const history = { threadId: "t-1", messages: [{ role: "user", content: [{ type: "text", text: "earlier" }] }], summary: "s" } as const;
      const cases: Array<{ member: string; call: () => Promise<unknown>; args: unknown[]; result: unknown }> = [
        { member: "createThread", call: () => session.createThread({ cwd: "/w", policy: POLICY }), args: [{ cwd: "/w", policy: POLICY }], result: echo("createThread", [{ cwd: "/w", policy: POLICY }]) },
        { member: "resumeThread", call: () => session.resumeThread({ native: { handle: "h-1" } }), args: [{ native: { handle: "h-1" } }], result: echo("resumeThread", [{ native: { handle: "h-1" } }]) },
        { member: "readSnapshot", call: () => session.readSnapshot!("t-1"), args: ["t-1"], result: echo("readSnapshot", ["t-1"]) },
        { member: "forkThread", call: () => session.forkThread!({ threadId: "t-1", at: { type: "turn", turnId: "u-1" }, cwd: "/o" }), args: [{ threadId: "t-1", at: { type: "turn", turnId: "u-1" }, cwd: "/o" }], result: echo("forkThread", [{ threadId: "t-1", at: { type: "turn", turnId: "u-1" }, cwd: "/o" }]) },
        { member: "rollbackThread", call: () => session.rollbackThread!({ threadId: "t-1", to: { type: "start" } }), args: [{ threadId: "t-1", to: { type: "start" } }], result: echo("rollbackThread", [{ threadId: "t-1", to: { type: "start" } }]) },
        { member: "compactThread", call: () => session.compactThread!("t-1"), args: ["t-1"], result: undefined },
        { member: "injectHistory", call: () => session.injectHistory!(history as never), args: [history], result: echo("injectHistory", [history]) },
        { member: "unloadThread", call: () => session.unloadThread!("t-1"), args: ["t-1"], result: undefined },
        { member: "release", call: () => session.release(), args: [], result: undefined },
        { member: "startTurn", call: () => session.startTurn(turn as never), args: [turn], result: echo("startTurn", [turn]) },
        { member: "interruptTurn", call: () => session.interruptTurn({ turnId: "u-1", restartRuntime: true }), args: [{ turnId: "u-1", restartRuntime: true }], result: undefined },
        { member: "respond", call: () => session.respond({ requestId: "r-1", responseKey: "a", optionId: "o-1" }), args: [{ requestId: "r-1", responseKey: "a", optionId: "o-1" }], result: undefined },
        { member: "respond", call: () => session.respond({ requestId: "r-2", responseKey: "b", optionId: "follow" }), args: [{ requestId: "r-2", responseKey: "b", optionId: "follow" }], result: { followUpPrompt: [{ type: "text", text: "next" }] } },
        { member: "backgroundTasks.list", call: () => session.backgroundTasks!.list("t-1", { includeSubagents: true }), args: ["t-1", { includeSubagents: true }], result: [echo("backgroundTasks.list", ["t-1", { includeSubagents: true }])] },
        { member: "backgroundTasks.list", call: () => session.backgroundTasks!.list("t-1"), args: ["t-1"], result: [echo("backgroundTasks.list", ["t-1"])] },
        { member: "backgroundTasks.stop", call: () => session.backgroundTasks!.stop({ threadId: "t-1", taskId: "b-1" }), args: [{ threadId: "t-1", taskId: "b-1" }], result: undefined },
        { member: "backgroundTasks.await", call: () => session.backgroundTasks!.await({ threadId: "t-1", taskIds: ["b-1"], awaited: true }), args: [{ threadId: "t-1", taskIds: ["b-1"], awaited: true }], result: echo("backgroundTasks.await", [{ threadId: "t-1", taskIds: ["b-1"], awaited: true }]) },
        { member: "stopSubagent", call: () => session.stopSubagent!({ subagentId: "a-1" }), args: [{ subagentId: "a-1" }], result: undefined },
        { member: "mcpApps.listTools", call: () => session.mcpApps!.listTools("t-1", "srv"), args: ["t-1", "srv"], result: [echo("mcpApps.listTools", ["t-1", "srv"])] },
        { member: "mcpApps.callTool", call: () => session.mcpApps!.callTool("t-1", "srv", "echo", { text: "x" }), args: ["t-1", "srv", "echo", { text: "x" }], result: echo("mcpApps.callTool", ["t-1", "srv", "echo", { text: "x" }]) },
        { member: "mcpApps.readResource", call: () => session.mcpApps!.readResource("t-1", "srv", "res://a"), args: ["t-1", "srv", "res://a"], result: echo("mcpApps.readResource", ["t-1", "srv", "res://a"]) },
        { member: "planConfigChange", call: () => session.planConfigChange({ threadId: "t-1", changes: { model: "m" } }), args: [{ threadId: "t-1", changes: { model: "m" } }], result: echo("planConfigChange", [{ threadId: "t-1", changes: { model: "m" } }]) },
        { member: "uploadFeedback", call: () => session.uploadFeedback!({ threadId: "t-1", reason: "bad" }), args: [{ threadId: "t-1", reason: "bad" }], result: echo("uploadFeedback", [{ threadId: "t-1", reason: "bad" }]) },
        { member: "ext", call: () => session.ext!("test.recording", "ping", { n: 1 }), args: ["test.recording", "ping", { n: 1 }], result: echo("ext", ["test.recording", "ping", { n: 1 }]) },
        // The driver got no params; its echo's `undefined` array element comes back as JSON's null.
        { member: "ext", call: () => session.ext!("test.recording", "bare", undefined), args: ["test.recording", "bare", undefined], result: echo("ext", ["test.recording", "bare", null]) },
      ];
      for (const { member, call, args, result } of cases) {
        const before = recording.calls.length;
        assert.deepEqual(await call(), result, `${member}: result`);
        const received = recording.calls.slice(before).filter((entry) => entry.member === member);
        assert.deepEqual(received.map((entry) => entry.args), [args], `${member}: arguments`);
      }
      await session.close();
      assert.equal(recording.calls.filter((entry) => entry.member === "close").length, 1);
    } finally {
      await close();
    }
  });

  test("events stream live and replay from a seq, and a stopped stream is cancelled on the driver", async () => {
    const { recording, session, close } = await rig({ full: true });
    try {
      const sequencer = recording.sequencer();
      const live: AriEvent[] = [];
      const iterator = session.events()[Symbol.asyncIterator]();
      sequencer.emit({ body: { type: "session.state", state: "ready" } });
      sequencer.emit({ body: { type: "notice", level: "info", text: "one" } });
      live.push((await iterator.next()).value as AriEvent, (await iterator.next()).value as AriEvent);
      assert.deepEqual(live.map((event) => event.seq), [1, 2]);
      sequencer.emit({ body: { type: "notice", level: "info", text: "two" } });
      assert.equal(((await iterator.next()).value as AriEvent).seq, 3);

      const replay = session.events({ fromSeq: 2 })[Symbol.asyncIterator]();
      assert.deepEqual([((await replay.next()).value as AriEvent).seq, ((await replay.next()).value as AriEvent).seq], [2, 3]);
      assert.deepEqual(recording.calls.filter((entry) => entry.member === "events").map((entry) => entry.args), [[], [{ fromSeq: 2 }]]);

      await replay.return!();
      await iterator.return!();
      // Both driver-side streams were stopped, so they no longer wait for events.
      sequencer.emit({ body: { type: "notice", level: "info", text: "three" } });
      const fresh = session.events({ fromSeq: 4 })[Symbol.asyncIterator]();
      assert.equal(((await fresh.next()).value as AriEvent).seq, 4);
      await fresh.return!();
    } finally {
      await close();
    }
  });
});

describe("optional members over ari/wire", () => {
  test("a driver that leaves out every optional member gives a wire instance and session without them", async () => {
    const { instance, session, close } = await rig({ full: false });
    try {
      const at = (target: object, path: string): unknown => path.split(".").reduce<unknown>((owner, segment) => (owner as { [key: string]: unknown } | undefined)?.[segment], target);
      for (const path of OPTIONAL_INSTANCE_MEMBERS) assert.equal(at(instance, path), undefined, `instance ${path} is absent`);
      for (const path of Object.keys(OPTIONAL_SESSION_MEMBERS)) assert.equal(at(session, path), undefined, `session ${path} is absent`);
      for (const group of ["maintenance", "auth", "workspace", "limits", "usageHistory", "textGeneration", "nativeSessions", "subProviders"]) {
        assert.equal((instance as unknown as { [key: string]: unknown })[group], undefined, `instance.${group} is absent`);
      }
      assert.equal(session.backgroundTasks, undefined);
      assert.equal(session.mcpApps, undefined);
    } finally {
      await close();
    }
  });

  test("a driver that has every optional member gives a wire instance and session with all of them", async () => {
    const { instance, session, close } = await rig({ full: true });
    try {
      const at = (target: object, path: string): unknown => path.split(".").reduce<unknown>((owner, segment) => (owner as { [key: string]: unknown } | undefined)?.[segment], target);
      for (const path of OPTIONAL_INSTANCE_MEMBERS) assert.equal(typeof at(instance, path), "function", `instance ${path} is present`);
      for (const path of Object.keys(OPTIONAL_SESSION_MEMBERS)) assert.equal(typeof at(session, path), "function", `session ${path} is present`);
    } finally {
      await close();
    }
  });
});

describe("synchronous members over ari/wire", () => {
  test("capabilities() follows the newest capabilities.updated event, never an older replayed one", async () => {
    const { recording, session, close } = await rig({ full: true });
    try {
      assert.deepEqual(session.capabilities(), recording.capabilities);
      const first: Capabilities = { ...recording.capabilities, extensions: [{ ns: "first", version: "1" }] };
      const second: Capabilities = { ...recording.capabilities, extensions: [{ ns: "second", version: "1" }] };
      recording.sequencer().emit({ body: { type: "capabilities.updated", capabilities: first } });
      recording.sequencer().emit({ body: { type: "capabilities.updated", capabilities: second } });
      const live = session.events()[Symbol.asyncIterator]();
      await live.next();
      await live.next();
      assert.deepEqual(session.capabilities().extensions, [{ ns: "second", version: "1" }]);
      const replay = session.events({ fromSeq: 1 })[Symbol.asyncIterator]();
      await replay.next();
      assert.deepEqual(session.capabilities().extensions, [{ ns: "second", version: "1" }], "the replayed older event does not win");
      await replay.return!();
      await live.return!();
      assert.deepEqual(await session.fetchCapabilities(), recording.capabilities, "fetchCapabilities asks the driver");
    } finally {
      await close();
    }
  });

  test("canRelease() reports the driver's answer and catches up when it changes", async () => {
    const { recording, session, close } = await rig({ full: true });
    try {
      assert.equal(session.canRelease(), false, "read when the session opened");
      recording.setCanRelease(true);
      await until(() => session.canRelease(), "canRelease() to turn true");
      recording.setCanRelease(false);
      assert.equal(await session.fetchCanRelease(), false);
      assert.equal(session.canRelease(), false);
    } finally {
      await close();
    }
  });

  test("contextWindow() and canReuseContextUsage() answer per argument from the driver's last answer", async () => {
    const { recording, session, close } = await rig({ full: true });
    try {
      assert.equal(session.contextWindow!("model-a"), undefined, "nothing is known before the driver answered");
      await until(() => session.contextWindow!("model-a") !== undefined, "the driver's answer");
      assert.equal(session.contextWindow!("model-a"), 200_000);
      assert.equal(await session.fetchContextWindow!("model-a", "/w"), 200_001);
      assert.equal(session.contextWindow!("model-a", "/w"), 200_001);
      assert.equal(await session.fetchContextWindow!("unknown-model"), undefined);
      assert.deepEqual(
        recording.calls.filter((entry) => entry.member === "contextWindow").map((entry) => entry.args),
        [["model-a"], ["model-a", "/w"], ["unknown-model"]],
      );

      assert.equal(session.canReuseContextUsage!("m", "m"), false, "no reuse is promised before the driver answered");
      await until(() => session.canReuseContextUsage!("m", "m"), "the driver's answer");
      assert.equal(await session.fetchCanReuseContextUsage!("m", "n"), false);

      // When the session declares the capabilities off, both throw unsupported without asking.
      const off: Capabilities = { ...recording.capabilities, contextWindowReporting: false, sessions: { ...recording.capabilities.sessions, contextUsageReuse: false } };
      recording.sequencer().emit({ body: { type: "capabilities.updated", capabilities: off } });
      const events = session.events()[Symbol.asyncIterator]();
      await events.next();
      assert.throws(() => session.contextWindow!("model-a"), (error: unknown) => isAriError(error, "unsupported") && error.callError.code === "unsupported" && error.callError.capability === "contextWindowReporting");
      assert.throws(() => session.canReuseContextUsage!("m", "m"), (error: unknown) => isAriError(error, "unsupported"));
      await events.return!();
    } finally {
      await close();
    }
  });
});

describe("errors over ari/wire", () => {
  test("a call error keeps its code and payload; any other throw becomes a protocol call error", async () => {
    const { session, instance, close } = await rig({
      full: true,
      failWith: (member) => {
        if (member === "forkThread") return new AriError({ code: "unsupported", message: "No forks here", capability: "threads.fork.crossCwd" });
        if (member === "compactThread") return new AriError({ code: "usage_limit", message: "Limited", resetAt: "2026-11-24T00:00:00.000Z" });
        if (member === "readSnapshot") return new TypeError("snapshot exploded");
        if (member === "probe") return { code: "not_found", message: "plain data", resource: "binary", id: "x" };
        return undefined;
      },
    });
    try {
      await assert.rejects(session.forkThread!({ threadId: "t", at: { type: "latest" } }), (error: unknown) => {
        assert.ok(error instanceof AriError);
        assert.deepEqual(error.callError, { code: "unsupported", message: "No forks here", capability: "threads.fork.crossCwd" });
        return true;
      });
      await assert.rejects(session.compactThread!("t"), (error: unknown) => isAriError(error, "usage_limit") && error.callError.code === "usage_limit" && error.callError.resetAt === "2026-11-24T00:00:00.000Z");
      await assert.rejects(session.readSnapshot!("t"), (error: unknown) => {
        assert.ok(isAriError(error, "protocol"));
        assert.equal((error.callError as { detail: string }).detail, "uncaught_error");
        assert.match(error.message, /TypeError: snapshot exploded/);
        return true;
      });
      await assert.rejects(instance.probe(), (error: unknown) => isAriError(error, "not_found") && (error.callError as { resource?: string }).resource === "binary");
    } finally {
      await close();
    }
  });

  test("an account key the driver cannot give yet does not fail driver/create; reads report the driver's error", async () => {
    const recording = createRecordingDriver({ full: true });
    const driver = {
      ...recording.driver,
      async create(...args: Parameters<typeof recording.driver.create>) {
        const instance = await recording.driver.create(...args);
        instance.limits!.accountKey = () => {
          throw new AriError({ code: "invalid_state", message: "Sign in first", reason: "signed_out" });
        };
        return instance;
      },
    };
    const [driverSide, hostSide] = memoryTransportPair();
    const server = serveDriver(driver, driverSide);
    const connection = await connectDriver(hostSide);
    try {
      const instance = await connection.driver.create(createFakeHost(), { instanceId: "no-key", config: {}, environment: {} });
      assert.throws(() => instance.limits!.accountKey(), (error: unknown) => isAriError(error, "invalid_state") && error.callError.code === "invalid_state" && error.callError.reason === "account_key_unknown");
      await until(() => {
        try {
          instance.limits!.accountKey();
          return false;
        } catch (error) {
          return isAriError(error, "invalid_state") && error.callError.code === "invalid_state" && error.callError.reason === "signed_out";
        }
      }, "the driver's own error");
    } finally {
      await connection.close();
      await server.closed;
    }
  });

  test("a failed driver/create leaves the instance id free for the next try", async () => {
    const recording = createRecordingDriver({ full: true });
    const [driverSide, hostSide] = memoryTransportPair();
    const server = serveDriver(recording.driver, driverSide);
    const connection = await connectDriver(hostSide);
    try {
      await assert.rejects(connection.driver.create(createFakeHost(), { instanceId: "again", config: { failCreate: true }, environment: {} }), (error: unknown) => isAriError(error, "invalid_state"));
      const instance = await connection.driver.create(createFakeHost(), { instanceId: "again", config: {}, environment: {} });
      assert.equal(instance.id, "again");
    } finally {
      await connection.close();
      await server.closed;
    }
  });
});

describe("raw frames: what a host in any language sees", () => {
  /** A host that speaks NDJSON JSON-RPC by hand, with no ARI client code. */
  async function rawHost(): Promise<{ send(message: object): void; next(): Promise<any>; frames: any[]; close(): Promise<void> }> {
    const recording = createRecordingDriver({ full: true });
    const [driverSide, hostSide] = memoryTransportPair();
    const server = serveDriver(recording.driver, driverSide);
    const frames: any[] = [];
    const waiting: Array<(frame: any) => void> = [];
    let buffered = "";
    void (async () => {
      for await (const chunk of hostSide.input) {
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const frame = JSON.parse(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          frames.push(frame);
          waiting.shift()?.(frame);
          newline = buffered.indexOf("\n");
        }
      }
    })();
    let read = 0;
    return {
      send: (message) => void hostSide.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
      next: () => {
        if (read < frames.length) return Promise.resolve(frames[read++]);
        return new Promise((resolve) => {
          waiting.push((frame) => {
            read += 1;
            resolve(frame);
          });
        });
      },
      frames,
      async close() {
        hostSide.close();
        await server.closed;
      },
    };
  }

  const initialize = {
    ariVersion: "1.0.0",
    grammarVersions: [1, 1],
    methodVersions: {},
    persistenceVersion: { major: 1, minor: 0 },
    host: { capabilities: { process: false } },
  };

  test("refusals carry a CallError in the JSON-RPC error's data", async () => {
    const host = await rawHost();
    try {
      host.send({ id: 1, method: "driver/defaultConfig", params: {} });
      const early = await host.next();
      assert.equal(early.id, 1);
      assert.equal(early.error.code, -32000);
      assert.deepEqual([early.error.data.code, early.error.data.reason], ["invalid_state", "not_initialized"]);

      host.send({ id: 2, method: "initialize", params: initialize });
      const initialized = await host.next();
      assert.equal(initialized.result.grammarVersion, 1);
      assert.equal(initialized.result.driver.kind, "recording");

      host.send({ id: 3, method: "initialize", params: initialize });
      assert.equal((await host.next()).error.data.reason, "already_initialized");

      host.send({ id: 4, method: "no/such.method", params: {} });
      const unknown = await host.next();
      assert.equal(unknown.error.code, -32601);
      assert.equal(unknown.error.data.code, "unsupported");

      host.send({ id: 5, method: "driver/create", params: { instanceId: "raw", config: {}, environment: {} } });
      const invalid = await host.next();
      assert.equal(invalid.error.code, -32602);
      assert.equal(invalid.error.data.code, "validation");
      assert.ok(invalid.error.data.issues.some((issue: { path?: unknown[] }) => issue.path?.includes("paths")), JSON.stringify(invalid.error.data));

      host.send({ id: 6, method: "session/startTurn", params: { sessionId: "nobody", threadId: "t", clientTurnKey: "k", intent: "start", content: [] } });
      const missing = await host.next();
      assert.deepEqual([missing.error.data.code, missing.error.data.resource], ["not_found", "session"]);

      host.send({ id: 7, method: "host/secrets.get", params: { instanceId: "raw", namespace: "n", key: "k" } });
      assert.equal((await host.next()).error.code, -32601, "a driver does not serve host methods");
    } finally {
      await host.close();
    }
  });

  test("a whole session by hand: create, open, events, cancel, with the response before the stream's frames", async () => {
    const host = await rawHost();
    try {
      host.send({ id: 1, method: "initialize", params: initialize });
      await host.next();
      host.send({ id: 2, method: "driver/create", params: { instanceId: "raw", config: {}, environment: {}, paths: { stateDir: "/s", cacheDir: "/c", tmpDir: "/t" } } });
      const created = await host.next();
      assert.equal(created.result.instanceId, "raw");
      assert.ok(created.result.members.includes("auth.start"));
      host.send({ id: 3, method: "instance/openSession", params: { instanceId: "raw" } });
      const opened = await host.next();
      assert.equal(opened.result.sessionId, "raw-session");
      assert.ok(opened.result.members.includes("forkThread"));
      host.send({ id: 4, method: "session/events", params: { sessionId: "raw-session" } });
      const started = await host.next();
      assert.equal(started.id, 4);
      const streamId = started.result.streamId as string;
      host.send({ id: 5, method: "session/close", params: { sessionId: "raw-session" } });
      // The session closed, so its stream ends; the close's response and the stream's end both arrive.
      const after = [await host.next(), await host.next()];
      assert.ok(after.some((frame) => frame.id === 5 && frame.result === null));
      assert.ok(after.some((frame) => frame.method === "stream/end" && frame.params.streamId === streamId));

      host.send({ id: 6, method: "instance/statusChanges", params: { instanceId: "raw" } });
      const status = await host.next();
      assert.equal(status.id, 6, "the response that names the stream comes before its items");
      const items = [await host.next(), await host.next(), await host.next()];
      assert.deepEqual(items.map((frame) => frame.method), ["instance/statusChanged", "instance/statusChanged", "stream/end"]);
      assert.ok(items.every((frame) => frame.params.streamId === status.result.streamId));
    } finally {
      await host.close();
    }
  });
});
