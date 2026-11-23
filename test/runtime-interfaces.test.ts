// The hand-written runtime interfaces cover the proposal's surface. The type
// assertions below reference every member of inventories D (Session), E
// (Instance), F (Driver) and G (HostServices) and its optionality, so removing
// a member, or making an optional one required (or the reverse), fails the
// gate's type-check. The runtime tests then walk complete implementations.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AriEvent, Driver, HostServices, Instance, InstanceStatus, Session, UsageRecord } from "../src/index.ts";
import { fullCapabilities } from "./fixtures/capabilities.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
/** True when `Key` is an optional member of `T`. Does not compile when `Key` is not a member. */
type IsOptional<T, Key extends keyof T> = {} extends Pick<T, Key> ? true : false;
type IsRequired<T, Key extends keyof T> = Equal<IsOptional<T, Key>, false>;
type IsMethod<T> = [NonNullable<T>] extends [(...args: never[]) => unknown] ? true : false;
type Group<T, Key extends keyof T> = NonNullable<T[Key]>;

type S = Session;
type I = Instance;
type D = Driver;
type H = HostServices;

// Inventory D: 28 Session methods plus the `id` property.
export type SessionSurface = [
  Expect<IsRequired<S, "id">>,
  Expect<IsRequired<S, "capabilities">>, Expect<IsMethod<S["capabilities"]>>,
  Expect<IsRequired<S, "events">>, Expect<IsMethod<S["events"]>>,
  Expect<IsRequired<S, "createThread">>, Expect<IsMethod<S["createThread"]>>,
  Expect<IsRequired<S, "resumeThread">>, Expect<IsMethod<S["resumeThread"]>>,
  Expect<IsOptional<S, "readSnapshot">>, Expect<IsMethod<S["readSnapshot"]>>,
  Expect<IsOptional<S, "forkThread">>, Expect<IsMethod<S["forkThread"]>>,
  Expect<IsOptional<S, "rollbackThread">>, Expect<IsMethod<S["rollbackThread"]>>,
  Expect<IsOptional<S, "compactThread">>, Expect<IsMethod<S["compactThread"]>>,
  Expect<IsOptional<S, "injectHistory">>, Expect<IsMethod<S["injectHistory"]>>,
  Expect<IsOptional<S, "unloadThread">>, Expect<IsMethod<S["unloadThread"]>>,
  Expect<IsRequired<S, "canRelease">>, Expect<IsMethod<S["canRelease"]>>,
  Expect<IsRequired<S, "release">>, Expect<IsMethod<S["release"]>>,
  Expect<IsRequired<S, "startTurn">>, Expect<IsMethod<S["startTurn"]>>,
  Expect<IsRequired<S, "interruptTurn">>, Expect<IsMethod<S["interruptTurn"]>>,
  Expect<IsRequired<S, "respond">>, Expect<IsMethod<S["respond"]>>,
  Expect<IsOptional<S, "backgroundTasks">>,
  Expect<IsRequired<Group<S, "backgroundTasks">, "list">>, Expect<IsMethod<Group<S, "backgroundTasks">["list"]>>,
  Expect<IsRequired<Group<S, "backgroundTasks">, "stop">>, Expect<IsMethod<Group<S, "backgroundTasks">["stop"]>>,
  Expect<IsRequired<Group<S, "backgroundTasks">, "await">>, Expect<IsMethod<Group<S, "backgroundTasks">["await"]>>,
  Expect<IsOptional<S, "stopSubagent">>, Expect<IsMethod<S["stopSubagent"]>>,
  Expect<IsOptional<S, "mcpApps">>,
  Expect<IsRequired<Group<S, "mcpApps">, "listTools">>, Expect<IsMethod<Group<S, "mcpApps">["listTools"]>>,
  Expect<IsRequired<Group<S, "mcpApps">, "callTool">>, Expect<IsMethod<Group<S, "mcpApps">["callTool"]>>,
  Expect<IsRequired<Group<S, "mcpApps">, "readResource">>, Expect<IsMethod<Group<S, "mcpApps">["readResource"]>>,
  Expect<IsRequired<S, "planConfigChange">>, Expect<IsMethod<S["planConfigChange"]>>,
  Expect<IsOptional<S, "contextWindow">>, Expect<IsMethod<S["contextWindow"]>>,
  Expect<IsOptional<S, "canReuseContextUsage">>, Expect<IsMethod<S["canReuseContextUsage"]>>,
  Expect<IsOptional<S, "uploadFeedback">>, Expect<IsMethod<S["uploadFeedback"]>>,
  Expect<IsOptional<S, "ext">>, Expect<IsMethod<S["ext"]>>,
  Expect<IsRequired<S, "close">>, Expect<IsMethod<S["close"]>>,
];

type Auth = Group<I, "auth">;
type Maintenance = Group<I, "maintenance">;
type NativeSessions = Group<I, "nativeSessions">;

// Inventory E: 33 Instance methods plus five properties.
export type InstanceSurface = [
  Expect<IsRequired<I, "id">>,
  Expect<IsRequired<I, "continuationKey">>,
  Expect<IsRequired<I, "bindingKey">>,
  Expect<IsRequired<I, "status">>, Expect<IsMethod<I["status"]>>,
  Expect<IsRequired<I, "statusChanges">>, Expect<IsMethod<I["statusChanges"]>>,
  Expect<IsRequired<I, "probe">>, Expect<IsMethod<I["probe"]>>,
  Expect<IsOptional<I, "invalidateCaches">>, Expect<IsMethod<I["invalidateCaches"]>>,
  Expect<IsOptional<I, "maintenance">>,
  Expect<IsRequired<Maintenance, "advisory">>, Expect<IsMethod<Maintenance["advisory"]>>,
  Expect<IsOptional<Maintenance, "install">>, Expect<IsMethod<Maintenance["install"]>>,
  Expect<IsOptional<Maintenance, "update">>, Expect<IsMethod<Maintenance["update"]>>,
  Expect<IsOptional<I, "auth">>,
  Expect<IsRequired<Auth, "methods">>, Expect<IsMethod<Auth["methods"]>>,
  Expect<IsRequired<Auth, "state">>, Expect<IsMethod<Auth["state"]>>,
  Expect<IsOptional<Auth, "reportRuntimeFailure">>, Expect<IsMethod<Auth["reportRuntimeFailure"]>>,
  Expect<IsRequired<Auth, "start">>, Expect<IsMethod<Auth["start"]>>,
  Expect<IsRequired<Auth, "complete">>, Expect<IsMethod<Auth["complete"]>>,
  Expect<IsOptional<Auth, "respond">>, Expect<IsMethod<Auth["respond"]>>,
  Expect<IsRequired<Auth, "cancel">>, Expect<IsMethod<Auth["cancel"]>>,
  Expect<IsOptional<Auth, "logout">>, Expect<IsMethod<Auth["logout"]>>,
  Expect<IsOptional<Auth, "transferProfile">>, Expect<IsMethod<Auth["transferProfile"]>>,
  Expect<IsOptional<Auth, "transferSession">>, Expect<IsMethod<Auth["transferSession"]>>,
  Expect<IsOptional<Auth, "credentialBinding">>,
  Expect<IsRequired<I, "catalog">>,
  Expect<IsRequired<I["catalog"], "list">>, Expect<IsMethod<I["catalog"]["list"]>>,
  Expect<IsOptional<I["catalog"], "refresh">>, Expect<IsMethod<I["catalog"]["refresh"]>>,
  Expect<IsOptional<I, "workspace">>,
  Expect<IsRequired<Group<I, "workspace">, "snapshot">>, Expect<IsMethod<Group<I, "workspace">["snapshot"]>>,
  Expect<IsOptional<I, "limits">>,
  Expect<IsRequired<Group<I, "limits">, "current">>, Expect<IsMethod<Group<I, "limits">["current"]>>,
  Expect<IsRequired<Group<I, "limits">, "accountKey">>, Expect<IsMethod<Group<I, "limits">["accountKey"]>>,
  Expect<IsOptional<Group<I, "limits">, "consumeResetCredit">>, Expect<IsMethod<Group<I, "limits">["consumeResetCredit"]>>,
  Expect<IsOptional<I, "usageHistory">>,
  Expect<IsRequired<Group<I, "usageHistory">, "scan">>, Expect<IsMethod<Group<I, "usageHistory">["scan"]>>,
  Expect<IsOptional<I, "textGeneration">>,
  Expect<IsRequired<Group<I, "textGeneration">, "generate">>, Expect<IsMethod<Group<I, "textGeneration">["generate"]>>,
  Expect<IsRequired<Group<I, "textGeneration">, "guarantees">>,
  Expect<IsOptional<I, "nativeSessions">>,
  Expect<IsRequired<NativeSessions, "list">>, Expect<IsMethod<NativeSessions["list"]>>,
  Expect<IsOptional<NativeSessions, "delete">>, Expect<IsMethod<NativeSessions["delete"]>>,
  Expect<IsOptional<NativeSessions, "archive">>, Expect<IsMethod<NativeSessions["archive"]>>,
  Expect<IsOptional<I, "subProviders">>,
  Expect<IsRequired<Group<I, "subProviders">, "list">>, Expect<IsMethod<Group<I, "subProviders">["list"]>>,
  Expect<IsRequired<Group<I, "subProviders">, "set">>, Expect<IsMethod<Group<I, "subProviders">["set"]>>,
  Expect<IsRequired<Group<I, "subProviders">, "disable">>, Expect<IsMethod<Group<I, "subProviders">["disable"]>>,
  Expect<IsRequired<I, "openSession">>, Expect<IsMethod<I["openSession"]>>,
  Expect<IsRequired<I, "dispose">>, Expect<IsMethod<I["dispose"]>>,
];

// Inventory F: Driver members, including the metadata fields.
export type DriverSurface = [
  Expect<IsRequired<D, "kind">>,
  Expect<IsRequired<D, "ariVersion">>,
  Expect<IsRequired<D, "metadata">>,
  Expect<IsRequired<D["metadata"], "displayName">>,
  Expect<IsOptional<D["metadata"], "icon">>,
  Expect<IsOptional<D["metadata"], "docsUrl">>,
  Expect<IsRequired<D["metadata"], "multipleInstances">>,
  Expect<IsRequired<D["metadata"], "hasDefaultInstance">>,
  Expect<IsRequired<D, "configSchema">>,
  Expect<IsRequired<D, "defaultConfig">>, Expect<IsMethod<D["defaultConfig"]>>,
  Expect<IsOptional<D, "cliManifest">>,
  Expect<IsRequired<D, "create">>, Expect<IsMethod<D["create"]>>,
];

// Inventory G: 17 host-service operations plus the listed properties.
export type HostSurface = [
  Expect<IsRequired<H["paths"], "stateDir">>,
  Expect<IsRequired<H["paths"], "cacheDir">>,
  Expect<IsRequired<H["paths"], "tmpDir">>,
  Expect<IsRequired<H["process"], "envPolicy">>,
  Expect<IsRequired<H["config"], "get">>, Expect<IsMethod<H["config"]["get"]>>,
  Expect<IsRequired<H["secrets"], "get">>, Expect<IsMethod<H["secrets"]["get"]>>,
  Expect<IsRequired<H["secrets"], "set">>, Expect<IsMethod<H["secrets"]["set"]>>,
  Expect<IsRequired<H["secrets"], "delete">>, Expect<IsMethod<H["secrets"]["delete"]>>,
  Expect<IsRequired<H["process"], "spawn">>, Expect<IsMethod<H["process"]["spawn"]>>,
  Expect<IsRequired<H["process"], "resolveExecutable">>, Expect<IsMethod<H["process"]["resolveExecutable"]>>,
  Expect<IsRequired<H["attachments"], "resolve">>, Expect<IsMethod<H["attachments"]["resolve"]>>,
  Expect<IsOptional<H["attachments"], "extractText">>, Expect<IsMethod<H["attachments"]["extractText"]>>,
  Expect<IsRequired<H["callbacks"], "register">>, Expect<IsMethod<H["callbacks"]["register"]>>,
  Expect<IsRequired<H["hostTools"], "mcpServerFor">>, Expect<IsMethod<H["hostTools"]["mcpServerFor"]>>,
  Expect<IsOptional<H["hostTools"], "callDynamicTool">>, Expect<IsMethod<H["hostTools"]["callDynamicTool"]>>,
  Expect<IsRequired<H["background"], "shouldRun">>, Expect<IsMethod<H["background"]["shouldRun"]>>,
  Expect<IsRequired<H["coordination"], "acquire">>, Expect<IsMethod<H["coordination"]["acquire"]>>,
  Expect<IsRequired<H["coordination"], "release">>, Expect<IsMethod<H["coordination"]["release"]>>,
  Expect<IsRequired<H["diagnostics"], "log">>, Expect<IsMethod<H["diagnostics"]["log"]>>,
  Expect<IsOptional<H, "telemetry">>,
  Expect<IsRequired<Group<H, "telemetry">, "track">>, Expect<IsMethod<Group<H, "telemetry">["track"]>>,
  Expect<IsOptional<H, "ids">>,
  Expect<IsRequired<Group<H, "ids">, "derive">>, Expect<IsMethod<Group<H, "ids">["derive"]>>,
];

// The inventories as dotted paths, for the runtime walk.
const SESSION_METHODS = [
  "capabilities", "events", "createThread", "resumeThread", "readSnapshot", "forkThread", "rollbackThread",
  "compactThread", "injectHistory", "unloadThread", "canRelease", "release", "startTurn", "interruptTurn", "respond",
  "backgroundTasks.list", "backgroundTasks.stop", "backgroundTasks.await", "stopSubagent", "mcpApps.listTools",
  "mcpApps.callTool", "mcpApps.readResource", "planConfigChange", "contextWindow", "canReuseContextUsage",
  "uploadFeedback", "ext", "close",
];
const INSTANCE_METHODS = [
  "status", "statusChanges", "probe", "invalidateCaches", "maintenance.advisory", "maintenance.install",
  "maintenance.update", "auth.methods", "auth.state", "auth.reportRuntimeFailure", "auth.start", "auth.complete",
  "auth.respond", "auth.cancel", "auth.logout", "auth.transferProfile", "auth.transferSession", "catalog.list",
  "catalog.refresh", "workspace.snapshot", "limits.current", "limits.accountKey", "limits.consumeResetCredit",
  "usageHistory.scan", "textGeneration.generate", "nativeSessions.list", "nativeSessions.delete",
  "nativeSessions.archive", "subProviders.list", "subProviders.set", "subProviders.disable", "openSession", "dispose",
];
const HOST_OPERATIONS = [
  "config.get", "secrets.get", "secrets.set", "secrets.delete", "process.spawn", "process.resolveExecutable",
  "attachments.resolve", "attachments.extractText", "callbacks.register", "hostTools.mcpServerFor",
  "hostTools.callDynamicTool", "background.shouldRun", "coordination.acquire", "coordination.release",
  "diagnostics.log", "telemetry.track", "ids.derive",
];

const unused = async (): Promise<never> => {
  throw new Error("not used in this test");
};
async function* noEvents(): AsyncIterable<AriEvent> {}
async function* noStatus(): AsyncIterable<InstanceStatus> {}
async function* noUsage(): AsyncIterable<UsageRecord> {}

// Complete implementations: `satisfies` rejects any member the interfaces do not declare.
const fullSession = {
  id: "session-1",
  capabilities: () => fullCapabilities(),
  events: () => noEvents(),
  createThread: unused,
  resumeThread: unused,
  readSnapshot: unused,
  forkThread: unused,
  rollbackThread: unused,
  compactThread: unused,
  injectHistory: unused,
  unloadThread: unused,
  canRelease: () => true,
  release: unused,
  startTurn: unused,
  interruptTurn: unused,
  respond: unused,
  backgroundTasks: { list: unused, stop: unused, await: unused },
  stopSubagent: unused,
  mcpApps: { listTools: unused, callTool: unused, readResource: unused },
  planConfigChange: unused,
  contextWindow: () => 200_000,
  canReuseContextUsage: () => true,
  uploadFeedback: unused,
  ext: unused,
  close: unused,
} satisfies Session;

const fullInstance = {
  id: "instance-1",
  continuationKey: "account-a",
  bindingKey: "binding-a",
  status: unused,
  statusChanges: () => noStatus(),
  probe: unused,
  invalidateCaches: unused,
  maintenance: { advisory: unused, install: unused, update: unused },
  auth: {
    methods: () => [],
    state: unused,
    reportRuntimeFailure: unused,
    start: unused,
    complete: unused,
    respond: unused,
    cancel: unused,
    logout: unused,
    transferProfile: unused,
    transferSession: unused,
    credentialBinding: { owner: "host", key: "binding-a" },
  },
  catalog: { list: unused, refresh: unused },
  workspace: { snapshot: unused },
  limits: { current: unused, accountKey: () => "account-a", consumeResetCredit: unused },
  usageHistory: { scan: () => noUsage() },
  textGeneration: { guarantees: { toolsDisabled: "native" }, generate: unused },
  nativeSessions: { list: unused, delete: unused, archive: unused },
  subProviders: { list: unused, set: unused, disable: unused },
  openSession: unused,
  dispose: unused,
} satisfies Instance;

const fullHost = {
  paths: { stateDir: "/state", cacheDir: "/cache", tmpDir: "/tmp/x" },
  config: { get: unused },
  secrets: { get: unused, set: unused, delete: unused },
  process: { envPolicy: { stripAmbient: ["GOOGLE_*"] }, spawn: unused, resolveExecutable: unused },
  attachments: { resolve: unused, extractText: unused },
  callbacks: { register: unused },
  hostTools: { mcpServerFor: unused, callDynamicTool: unused },
  background: { shouldRun: unused },
  coordination: { acquire: unused, release: unused },
  diagnostics: { log: () => undefined },
  telemetry: { track: () => undefined },
  ids: { derive: unused },
} satisfies HostServices;

const fullDriver = {
  kind: "sample",
  ariVersion: "1.0.0",
  metadata: { displayName: "Sample", docsUrl: "https://example.invalid", multipleInstances: true, hasDefaultInstance: false },
  configSchema: { type: "object" },
  defaultConfig: () => ({}),
  cliManifest: { binary: "sample", args: { fresh: [] } },
  create: unused,
} satisfies Driver;

// A session with only the required members compiles; one without resumeThread does not.
export const minimalSession: Session = {
  id: "session-2",
  capabilities: () => fullCapabilities(),
  events: () => noEvents(),
  createThread: unused,
  resumeThread: unused,
  canRelease: () => false,
  release: unused,
  startTurn: unused,
  interruptTurn: unused,
  respond: unused,
  planConfigChange: unused,
  close: unused,
};
// @ts-expect-error resumeThread is required: every driver can resume a stored thread.
export const sessionWithoutResume: Session = {
  id: "session-3",
  capabilities: () => fullCapabilities(),
  events: () => noEvents(),
  createThread: unused,
  canRelease: () => false,
  release: unused,
  startTurn: unused,
  interruptTurn: unused,
  respond: unused,
  planConfigChange: unused,
  close: unused,
};

function at(root: object, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root);
}

describe("runtime interfaces", () => {
  test("Session has the 28 methods of inventory D", () => {
    assert.equal(SESSION_METHODS.length, 28);
    for (const member of SESSION_METHODS) assert.equal(typeof at(fullSession, member), "function", member);
  });

  test("Instance has the 33 methods of inventory E and its five properties", () => {
    assert.equal(INSTANCE_METHODS.length, 33);
    for (const member of INSTANCE_METHODS) assert.equal(typeof at(fullInstance, member), "function", member);
    for (const property of ["id", "continuationKey", "bindingKey", "auth.credentialBinding", "textGeneration.guarantees"]) {
      assert.notEqual(at(fullInstance, property), undefined, property);
    }
  });

  test("HostServices has the 17 operations of inventory G and its properties", () => {
    assert.equal(HOST_OPERATIONS.length, 17);
    for (const member of HOST_OPERATIONS) assert.equal(typeof at(fullHost, member), "function", member);
    for (const property of ["paths.stateDir", "paths.cacheDir", "paths.tmpDir", "process.envPolicy"]) {
      assert.notEqual(at(fullHost, property), undefined, property);
    }
  });

  test("Driver has the members of inventory F", () => {
    for (const member of ["defaultConfig", "create"]) assert.equal(typeof at(fullDriver, member), "function", member);
    for (const property of ["kind", "ariVersion", "metadata.displayName", "metadata.multipleInstances", "metadata.hasDefaultInstance", "configSchema", "cliManifest"]) {
      assert.notEqual(at(fullDriver, property), undefined, property);
    }
  });

  test("a minimal session leaves every optional member out", () => {
    for (const member of ["readSnapshot", "forkThread", "rollbackThread", "backgroundTasks", "mcpApps", "ext"]) {
      assert.equal(member in minimalSession, false, member);
    }
  });
});
