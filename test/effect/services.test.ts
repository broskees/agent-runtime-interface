// The Effect services of `ari/effect`: a session call that fails with a call
// error fails in Effect's error channel with the tagged error of its code; a
// non-call-error failure is a defect; session events are a lazy `Stream`;
// the Effect shapes mirror the plain interfaces member for member (a type-level
// check); and the layers open and release instances and sessions.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Cause, Effect, Exit, Layer, Result, Stream } from "effect";
import { AriError, CALL_ERROR_CODES, callErrors } from "../../src/index.ts";
import type {
  AriEvent,
  CallError,
  CreateInstanceRequest,
  Driver,
  HostServices,
  Instance,
  InstanceStatus,
  KnownCallErrorCode,
  Session,
  SpawnedProcess,
} from "../../src/index.ts";
import { guardSession } from "../../src/host/capability-guard.ts";
import {
  AriDriver,
  AriHostServices,
  AriInstance,
  AriSession,
  ExtensionCallError,
  TAGGED_CALL_ERRORS,
  UnsupportedError,
  toAriError,
  toEffectDriver,
  toEffectHostServices,
  toEffectInstance,
  toEffectSession,
  toTaggedError,
} from "../../src/effect/index.ts";
import type { AriCallError, EffectDriver, EffectHostServices, EffectInstance, EffectSession, EffectSpawnedProcess } from "../../src/effect/index.ts";
import { fullCapabilities } from "../fixtures/capabilities.ts";
import { fakeSession } from "../fixtures/fake-session.ts";

const POLICY = { mode: "approval_required", interaction: "default", cwd: "/work" } as const;

function withForkOff() {
  const capabilities = fullCapabilities();
  capabilities.threads.fork = { ...capabilities.threads.fork, supported: false };
  return capabilities;
}

async function failureOf<A>(effect: Effect.Effect<A, AriCallError>): Promise<AriCallError> {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit), "expected the effect to fail");
  const error = Cause.findError(exit.cause);
  assert.ok(Result.isSuccess(error), `expected a typed failure, got ${String(exit.cause)}`);
  return error.success;
}

/** One example call error for each of the eleven codes. */
const EXAMPLE_ERRORS: { readonly [Code in KnownCallErrorCode]: CallError } = {
  unsupported: callErrors.unsupported("threads.fork").callError,
  invalid_state: callErrors.invalidState("previous_turn_active").callError,
  not_found: callErrors.notFound({ resource: "thread", id: "thread-9" }).callError,
  auth_required: callErrors.authRequired([{ id: "browser", kind: "browser", label: "Sign in" }]).callError,
  usage_limit: callErrors.usageLimit("2026-11-24T00:00:00Z").callError,
  permission_denied: callErrors.permissionDenied().callError,
  transport: callErrors.transport("driver exited").callError,
  protocol: callErrors.protocol("bad frame").callError,
  validation: callErrors.validation([{ message: "Missing required field", path: ["cwd"] }]).callError,
  attachment_unreadable: callErrors.attachmentUnreadable("attachment-1").callError,
  driver_unavailable: callErrors.driverUnavailable({ package: "@vendor/sdk", installHint: "npm install @vendor/sdk" }).callError,
};

describe("a session call that fails with unsupported", () => {
  test("surfaces as UnsupportedError in Effect's error channel, without reaching the driver", async () => {
    const plain = fakeSession(withForkOff());
    const session = toEffectSession(guardSession(plain));
    const program = Effect.gen(function* () {
      const thread = yield* session.createThread({ cwd: "/work", policy: POLICY });
      return yield* session.forkThread!({ threadId: thread.id, at: { type: "latest" } });
    });
    const error = await failureOf(program);
    assert.ok(error instanceof UnsupportedError);
    assert.equal(error._tag, "UnsupportedError");
    assert.equal(error.capability, "threads.fork");
    assert.equal(error.callError.code, "unsupported");
    assert.equal(error.callError.capability, "threads.fork");
    assert.deepEqual(
      plain.calls.map((call) => call.member),
      ["createThread"],
      "the guard refused the fork before the driver saw it",
    );
  });

  test("Effect.catchTag recovers it through the AriSession service", async () => {
    const program = Effect.gen(function* () {
      const session = yield* AriSession;
      const thread = yield* session.createThread({ cwd: "/work", policy: POLICY });
      return yield* session.forkThread!({ threadId: thread.id, at: { type: "latest" } }).pipe(
        Effect.map((fork) => `forked ${fork.id}`),
        Effect.catchTag("UnsupportedError", (error) => Effect.succeed(`not supported: ${error.capability}`)),
      );
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(AriSession.layer(guardSession(fakeSession(withForkOff()))))));
    assert.equal(result, "not supported: threads.fork");
  });

  test("with fork on, the same program forks", async () => {
    const program = Effect.gen(function* () {
      const session = yield* AriSession;
      const thread = yield* session.createThread({ cwd: "/work", policy: POLICY });
      return yield* session.forkThread!({ threadId: thread.id, at: { type: "latest" } });
    });
    const fork = await Effect.runPromise(program.pipe(Effect.provide(AriSession.layer(guardSession(fakeSession(fullCapabilities()))))));
    assert.equal(fork.id, "thread-fork");
  });
});

describe("tagged errors for the eleven call error codes", () => {
  test("there is one tagged error class per code", () => {
    assert.deepEqual(Object.keys(TAGGED_CALL_ERRORS).sort(), [...CALL_ERROR_CODES].sort());
    assert.equal(new Set(Object.values(TAGGED_CALL_ERRORS)).size, 11);
  });

  for (const code of CALL_ERROR_CODES) {
    test(`${code}: a rejection with an AriError or with wire data fails with its tagged error, which round-trips`, async () => {
      const callError = EXAMPLE_ERRORS[code];
      const ErrorClass = TAGGED_CALL_ERRORS[code];
      const wireForm = JSON.parse(JSON.stringify(new AriError(callError))) as unknown;
      for (const rejection of [new AriError(callError), wireForm]) {
        const session = toEffectSession({
          ...fakeSession(fullCapabilities()),
          interruptTurn: () => Promise.reject(rejection),
        });
        const error = await failureOf(session.interruptTurn({ turnId: "turn-1" }));
        assert.ok(error instanceof ErrorClass, `${code}: got ${error._tag}`);
        assert.equal(error._tag, ErrorClass.name);
        assert.deepEqual(error.callError, callError);
        assert.equal(error.message, callError.message);
        for (const [field, value] of Object.entries(callError)) {
          assert.deepEqual((error as unknown as Record<string, unknown>)[field], value, `${code}: field ${field}`);
        }
        const back = toAriError(error);
        assert.ok(back instanceof AriError);
        assert.deepEqual(back.callError, callError);
      }
    });
  }

  test("a synchronous throw with a call error fails with its tagged error too", async () => {
    const session = toEffectSession({
      ...fakeSession(fullCapabilities()),
      contextWindow: () => {
        throw callErrors.unsupported("contextWindowReporting");
      },
    });
    const error = await failureOf(session.contextWindow!("fast"));
    assert.ok(error instanceof UnsupportedError);
    assert.equal(error.capability, "contextWindowReporting");
  });

  test("an x: code becomes ExtensionCallError", async () => {
    const callError = { code: "x:vendor.quota", message: "Vendor quota", data: { left: 0 } } as const;
    for (const rejection of [new AriError(callError), structuredClone(callError)]) {
      const tagged = toTaggedError(rejection);
      assert.ok(tagged instanceof ExtensionCallError);
      assert.deepEqual(tagged.callError, callError);
      assert.deepEqual(toAriError(tagged).callError, callError);
    }
  });

  test("a rejection that is not a call error is a defect, not a typed failure", async () => {
    const bug = new TypeError("driver bug");
    const session = toEffectSession({ ...fakeSession(fullCapabilities()), release: () => Promise.reject(bug) });
    const exit = await Effect.runPromiseExit(session.release());
    assert.ok(Exit.isFailure(exit));
    assert.equal(Cause.hasFails(exit.cause), false);
    assert.equal(Cause.hasDies(exit.cause), true);
    assert.equal(Cause.squash(exit.cause), bug);
    assert.equal(toTaggedError(bug), undefined);
    assert.equal(toTaggedError({ code: "unsupported", message: "no capability field" }), undefined);
  });
});

describe("session events as a Stream", () => {
  test("the stream calls events() only when it runs, each time it runs, and delivers the session's events", async () => {
    const plain = fakeSession(fullCapabilities());
    let opened = 0;
    const counting: Session = {
      ...plain,
      events: (options) => {
        opened++;
        return plain.events(options);
      },
    };
    const session = toEffectSession(counting);
    const stream = session.events();
    assert.equal(opened, 0, "building the stream calls nothing");

    const run = Effect.gen(function* () {
      const thread = yield* session.createThread({ cwd: "/work", policy: POLICY });
      yield* session.startTurn({ threadId: thread.id, clientTurnKey: "key-1", intent: "start", content: [{ type: "text", text: "hi" }] });
      return yield* Stream.runCollect(stream.pipe(Stream.take(6)));
    });
    const events: AriEvent[] = await Effect.runPromise(run);
    assert.equal(opened, 1);
    assert.deepEqual(
      events.map((event) => event.body.type),
      ["thread.upsert", "turn.upsert", "item.upsert", "item.delta", "item.upsert", "turn.terminal"],
    );
    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 2, 3, 4, 5, 6],
    );

    const replay = await Effect.runPromise(Stream.runCollect(session.events({ fromSeq: 4 }).pipe(Stream.take(3))));
    assert.equal(opened, 2);
    assert.deepEqual(
      replay.map((event) => event.seq),
      [4, 5, 6],
    );
  });

  test("ending the stream early stops the session's iterator", async () => {
    let returned = false;
    async function* endless(): AsyncGenerator<AriEvent> {
      try {
        for (let seq = 1; ; seq++) yield { seq, at: "now", sessionId: "s", body: { type: "notice", level: "info", text: `#${seq}` } };
      } finally {
        returned = true;
      }
    }
    const session = toEffectSession({ ...fakeSession(fullCapabilities()), events: () => endless() });
    const events = await Effect.runPromise(Stream.runCollect(session.events().pipe(Stream.take(2))));
    assert.equal(events.length, 2);
    assert.equal(returned, true);
  });

  test("a stream that fails with a call error fails with its tagged error", async () => {
    async function* broken(): AsyncGenerator<AriEvent> {
      yield { seq: 1, at: "now", sessionId: "s", body: { type: "notice", level: "info", text: "one" } };
      throw callErrors.transport("driver exited");
    }
    const session = toEffectSession({ ...fakeSession(fullCapabilities()), events: () => broken() });
    const exit = await Effect.runPromiseExit(Stream.runCollect(session.events()));
    assert.ok(Exit.isFailure(exit));
    const error = Cause.findError(exit.cause);
    assert.ok(Result.isSuccess(error));
    assert.equal(error.success._tag, "TransportError");
  });
});

// ---------------------------------------------------------------------------
// Fakes for Instance, Driver and HostServices

interface Recorder {
  readonly calls: string[];
}

const READY: InstanceStatus = { state: "ready", installed: true };

function fakeInstance(recorder: Recorder, session: Session): Instance {
  async function* statuses(): AsyncGenerator<InstanceStatus> {
    yield READY;
    yield { state: "unavailable", installed: false };
  }
  return {
    id: "instance-1",
    continuationKey: "account-1",
    bindingKey: "binding-1",
    status: async () => READY,
    statusChanges: () => statuses(),
    probe: async () => ({ ok: true, installed: true, checkedAt: "2026-11-23T00:00:00Z" }),
    maintenance: { advisory: async () => null },
    auth: {
      methods: () => [{ id: "browser", kind: "browser", label: "Sign in" }],
      state: async () => {
        throw callErrors.authRequired([{ id: "browser", kind: "browser", label: "Sign in" }]);
      },
      start: async () => ({ flowId: "flow-1", kind: "browser" }) as never,
      complete: async () => ({}) as never,
      cancel: async () => ({}) as never,
      credentialBinding: { kind: "account" } as never,
    },
    catalog: { list: async () => ({ models: [] }) },
    limits: { current: async () => ({ windows: [] }) as never, accountKey: () => "account-1" },
    openSession: async () => {
      recorder.calls.push("openSession");
      return { ...session, close: async () => void recorder.calls.push("session.close") };
    },
    dispose: async () => void recorder.calls.push("instance.dispose"),
  };
}

function fakeDriver(recorder: Recorder, session: Session): Driver {
  return {
    kind: "fake",
    ariVersion: "1.0.0",
    metadata: { displayName: "Fake", icon: { kind: "url", url: "https://example.invalid/icon.svg" } } as never,
    configSchema: { type: "object" },
    defaultConfig: () => ({ model: "fast" }),
    create: async (_host, input) => {
      recorder.calls.push(`create ${input.instanceId}`);
      return fakeInstance(recorder, session);
    },
  };
}

function fakeHost(recorder: Recorder): HostServices {
  const process: SpawnedProcess = {
    pid: 42,
    stdout: (async function* () {
      yield new TextEncoder().encode("out");
    })(),
    stderr: (async function* () {})(),
    write: async () => void recorder.calls.push("write"),
    closeStdin: async () => undefined,
    kill: async () => undefined,
    exited: Promise.resolve({ code: 0, signal: null }),
  };
  return {
    paths: { stateDir: "/state", cacheDir: "/cache", tmpDir: "/tmp/ari" },
    config: {
      get: async (options) => {
        async function* changes() {
          yield { model: "slow" };
        }
        return options?.watch ? { config: { model: "fast" }, changes: changes() } : { config: { model: "fast" } };
      },
    },
    secrets: {
      get: async () => new Uint8Array([1, 2]),
      set: async () => undefined,
      delete: async () => {
        throw callErrors.permissionDenied("read-only keychain");
      },
    },
    process: { envPolicy: { stripAmbient: ["ANTHROPIC_API_KEY"] }, spawn: async () => process, resolveExecutable: async () => "/usr/bin/agent" },
    attachments: { resolve: async () => null },
    callbacks: { register: async () => ({ url: "http://127.0.0.1:1/cb" }) },
    hostTools: { mcpServerFor: async () => ({ name: "host", config: { name: "host", transport: "stdio", command: "host-mcp" } }) as never },
    background: { shouldRun: async () => true },
    coordination: { acquire: async () => null, release: async () => undefined },
    diagnostics: { log: () => void recorder.calls.push("log") },
  };
}

const REQUEST: CreateInstanceRequest<{ [key: string]: unknown }> = { instanceId: "instance-1", config: {}, environment: {} };

describe("Instance, Driver and HostServices", () => {
  test("toEffectInstance wraps every member, keeps optional members absent, and fails with tagged errors", async () => {
    const recorder: Recorder = { calls: [] };
    const instance = toEffectInstance(fakeInstance(recorder, fakeSession(fullCapabilities())));
    assert.equal(instance.id, "instance-1");
    assert.equal(instance.continuationKey, "account-1");
    assert.equal(instance.bindingKey, "binding-1");
    assert.equal(instance.workspace, undefined);
    assert.equal(instance.usageHistory, undefined);
    assert.equal(instance.auth?.logout, undefined);
    assert.deepEqual(instance.auth?.credentialBinding, { kind: "account" });

    assert.deepEqual(await Effect.runPromise(instance.status()), READY);
    const statuses = await Effect.runPromise(Stream.runCollect(instance.statusChanges()));
    assert.deepEqual(
      statuses.map((status) => status.state),
      ["ready", "unavailable"],
    );
    assert.equal(await Effect.runPromise(instance.limits!.accountKey()), "account-1");
    const authError = await failureOf(instance.auth!.state());
    assert.equal(authError._tag, "AuthRequiredError");

    const session: EffectSession = await Effect.runPromise(instance.openSession({}));
    assert.equal(session.id, "session-fake");
    assert.deepEqual(recorder.calls, ["openSession"]);
  });

  test("toEffectDriver creates Effect-shaped instances", async () => {
    const recorder: Recorder = { calls: [] };
    const driver = toEffectDriver(fakeDriver(recorder, fakeSession(fullCapabilities())));
    assert.equal(driver.kind, "fake");
    assert.deepEqual(await Effect.runPromise(driver.defaultConfig()), { model: "fast" });
    const instance: EffectInstance = await Effect.runPromise(driver.create(fakeHost(recorder), REQUEST));
    assert.equal(instance.unwrapped.id, "instance-1");
    assert.deepEqual(recorder.calls, ["create instance-1"]);
  });

  test("toEffectHostServices wraps every operation, with streams for config changes and process output", async () => {
    const recorder: Recorder = { calls: [] };
    const host = toEffectHostServices(fakeHost(recorder));
    assert.deepEqual(host.paths, { stateDir: "/state", cacheDir: "/cache", tmpDir: "/tmp/ari" });
    assert.deepEqual(host.process.envPolicy, { stripAmbient: ["ANTHROPIC_API_KEY"] });
    assert.equal(host.telemetry, undefined);
    assert.equal(host.ids, undefined);
    assert.equal(host.attachments.extractText, undefined);

    const reading = await Effect.runPromise(host.config.get({ watch: true }));
    assert.deepEqual(reading.config, { model: "fast" });
    assert.deepEqual(await Effect.runPromise(Stream.runCollect(reading.changes!)), [{ model: "slow" }]);
    assert.deepEqual(await Effect.runPromise(host.secrets.get("ns", "key")), new Uint8Array([1, 2]));
    const denied = await failureOf(host.secrets.delete("ns", "key"));
    assert.equal(denied._tag, "PermissionDeniedError");

    const child: EffectSpawnedProcess = await Effect.runPromise(host.process.spawn({ command: "agent" }));
    assert.equal(child.pid, 42);
    const output = await Effect.runPromise(Stream.runCollect(child.stdout));
    assert.equal(new TextDecoder().decode(output[0]), "out");
    assert.deepEqual(await Effect.runPromise(child.exited), { code: 0, signal: null });
    await Effect.runPromise(child.write("x"));
    await Effect.runPromise(host.diagnostics.log({ level: "info", msg: "hi" }));
    assert.deepEqual(recorder.calls, ["write", "log"]);
  });

  test("AriInstance.create and AriSession.open open and release in order", async () => {
    const recorder: Recorder = { calls: [] };
    const plainSession = fakeSession(fullCapabilities());
    const layer = AriSession.open({}).pipe(
      Layer.provideMerge(AriInstance.create(fakeHost(recorder), REQUEST)),
      Layer.provide(AriDriver.layer(fakeDriver(recorder, plainSession))),
    );
    const program = Effect.gen(function* () {
      const session = yield* AriSession;
      const instance = yield* AriInstance;
      recorder.calls.push(`using ${instance.id}/${session.id}`);
      return (yield* session.capabilities()).ariVersion;
    });
    const version = await Effect.runPromise(program.pipe(Effect.provide(layer)));
    assert.equal(version, "1.0.0");
    assert.deepEqual(recorder.calls, ["create instance-1", "openSession", "using instance-1/session-fake", "session.close", "instance.dispose"]);
  });

  test("AriHostServices.layer provides host services to an Effect-written driver", async () => {
    const recorder: Recorder = { calls: [] };
    const program = Effect.gen(function* () {
      const host = yield* AriHostServices;
      return yield* host.process.resolveExecutable("agent");
    });
    assert.equal(await Effect.runPromise(program.pipe(Effect.provide(AriHostServices.layer(fakeHost(recorder))))), "/usr/bin/agent");
  });
});

// ---------------------------------------------------------------------------
// Type-level: the Effect shapes have the same members as the plain interfaces,
// and the same ones optional. Removing or adding a member fails the type-check.

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];
type SameMembers<Plain, Wrapped> = Equal<keyof Plain, Exclude<keyof Wrapped, "unwrapped">> extends true
  ? Equal<OptionalKeys<Plain>, OptionalKeys<Wrapped>>
  : false;
type Group<T, K extends keyof T> = NonNullable<T[K]>;
/** Compiles only when `T` is exactly `true`. */
type Assert<T extends true> = T;

const memberChecks: Array<true> = [
  true satisfies Assert<SameMembers<Session, EffectSession>>,
  true satisfies Assert<SameMembers<Group<Session, "backgroundTasks">, Group<EffectSession, "backgroundTasks">>>,
  true satisfies Assert<SameMembers<Group<Session, "mcpApps">, Group<EffectSession, "mcpApps">>>,
  true satisfies Assert<SameMembers<Instance, EffectInstance>>,
  true satisfies Assert<SameMembers<Group<Instance, "maintenance">, Group<EffectInstance, "maintenance">>>,
  true satisfies Assert<SameMembers<Group<Instance, "auth">, Group<EffectInstance, "auth">>>,
  true satisfies Assert<SameMembers<Group<Instance, "catalog">, Group<EffectInstance, "catalog">>>,
  true satisfies Assert<SameMembers<Group<Instance, "workspace">, Group<EffectInstance, "workspace">>>,
  true satisfies Assert<SameMembers<Group<Instance, "limits">, Group<EffectInstance, "limits">>>,
  true satisfies Assert<SameMembers<Group<Instance, "usageHistory">, Group<EffectInstance, "usageHistory">>>,
  true satisfies Assert<SameMembers<Group<Instance, "textGeneration">, Group<EffectInstance, "textGeneration">>>,
  true satisfies Assert<SameMembers<Group<Instance, "nativeSessions">, Group<EffectInstance, "nativeSessions">>>,
  true satisfies Assert<SameMembers<Group<Instance, "subProviders">, Group<EffectInstance, "subProviders">>>,
  true satisfies Assert<SameMembers<Driver, EffectDriver>>,
  true satisfies Assert<SameMembers<HostServices, EffectHostServices>>,
  true satisfies Assert<SameMembers<Group<HostServices, "paths">, Group<EffectHostServices, "paths">>>,
  true satisfies Assert<SameMembers<Group<HostServices, "config">, Group<EffectHostServices, "config">>>,
  true satisfies Assert<SameMembers<Group<HostServices, "secrets">, Group<EffectHostServices, "secrets">>>,
  true satisfies Assert<SameMembers<Group<HostServices, "process">, Group<EffectHostServices, "process">>>,
  true satisfies Assert<SameMembers<Group<HostServices, "attachments">, Group<EffectHostServices, "attachments">>>,
  true satisfies Assert<SameMembers<Group<HostServices, "callbacks">, Group<EffectHostServices, "callbacks">>>,
  true satisfies Assert<SameMembers<Group<HostServices, "hostTools">, Group<EffectHostServices, "hostTools">>>,
  true satisfies Assert<SameMembers<Group<HostServices, "background">, Group<EffectHostServices, "background">>>,
  true satisfies Assert<SameMembers<Group<HostServices, "coordination">, Group<EffectHostServices, "coordination">>>,
  true satisfies Assert<SameMembers<Group<HostServices, "diagnostics">, Group<EffectHostServices, "diagnostics">>>,
  true satisfies Assert<SameMembers<Group<HostServices, "telemetry">, Group<EffectHostServices, "telemetry">>>,
  true satisfies Assert<SameMembers<Group<HostServices, "ids">, Group<EffectHostServices, "ids">>>,
  true satisfies Assert<SameMembers<SpawnedProcess, EffectSpawnedProcess>>,
];

describe("member coverage", () => {
  test("the Effect shapes mirror Session, Instance, Driver and HostServices (checked by the type-check)", () => {
    assert.equal(memberChecks.length, 28);
  });
});
