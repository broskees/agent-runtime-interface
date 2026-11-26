// The host side of `ari/wire` in TypeScript: `connectDriver` returns a
// `Driver` whose instances and sessions are objects implementing `Instance`
// and `Session`, each call a request to the driver on the other end, and it
// serves the driver's `host/*` calls from the `HostServices` each instance was
// created with.
//
// Optional members exist exactly when the driver's descriptor lists them, so
// a host sees the same shape it would in process.
//
// Synchronous members cannot wait for the other end, so they answer from what
// the driver last reported, and the client keeps that fresh:
//
// - `Driver.defaultConfig()`: read once, right after `initialize`.
// - `Session.capabilities()`: from `instance/openSession`'s result, then from
//   each newer `capabilities.updated` event read through `events()`.
// - `Session.canRelease()`: read when the session opens, and again after each
//   call, each event read and each read of `canRelease()` itself.
// - `Instance.auth.methods()`: read when the instance is created and after
//   each `auth` call; `Instance.limits.accountKey()`: from `driver/create`'s
//   result, refreshed on each read.
// - `Session.contextWindow()` and `canReuseContextUsage()` take arguments, so
//   they answer per argument from what the driver said before. The first read
//   for new arguments asks the driver and answers `undefined` (no window
//   known) or `false` (do not reuse), the answers that promise nothing. A
//   capability the session declares off throws `unsupported`, as the
//   contract requires. The `fetch*` members return the driver's answer and
//   fill the cache, for hosts that need it at once.
//
// When the connection closes (the driver process died or the transport
// failed), every pending call rejects with the `transport` call error, and
// each open `events()` stream ends with a `turn.terminal` of status `failed`
// and failure class `transport_error` for every turn that had started and not
// settled, numbered after the last event it saw.

import type { AriError } from "../ari-error.ts";
import { hasCapability } from "../capabilities.ts";
import { callErrors, isAriError } from "../errors.ts";
import type { Capabilities } from "../generated/capabilities.ts";
import type { ConfigValues, Version } from "../generated/common.ts";
import type { AriEvent } from "../generated/events.ts";
import type { EnvPolicy, ProcessExit } from "../generated/host.ts";
import type { InitializeParams, InitializeResult } from "../generated/handshake.ts";
import type { AuthMethod, InstanceStatus } from "../generated/instance.ts";
import type { InstanceDescriptor, SessionDescriptor } from "../generated/rpc.ts";
import type { RespondResult } from "../generated/session.ts";
import type { SubagentOutcome } from "../generated/subagent.ts";
import type { UsageRecord } from "../generated/usage.ts";
import { TURN_REQUIRED_FIELDS } from "../host/event-grammar.ts";
import type { CreateInstanceRequest, Driver, HostServices, Instance, Session, SpawnedProcess } from "../runtime.ts";
import { ARI_VERSION, GRAMMAR_VERSIONS, PERSISTENCE_VERSION } from "../version.ts";
import { WireConnection } from "./connection.ts";
import type { WireRequestContext, WireTransport } from "./connection.ts";
import { negotiateHandshake } from "./handshake.ts";
import type { NegotiatedVersions } from "./handshake.ts";
import { OPTIONAL_HOST_MEMBERS, defaultMethodVersions, presentMembers } from "./methods.ts";
import { base64ToBytes, bytesToBase64 } from "./streams.ts";

export interface ConnectDriverOptions {
  /**
   * Offer `host.process`: the driver's spawns come back to the `HostServices`
   * of their instance, with the child's stdio and exit. Off by default: the
   * driver spawns locally with `envPolicy`.
   */
  readonly delegateProcesses?: boolean;
  /** Environment rules for the driver's local spawns. Defaults to stripping nothing. */
  readonly envPolicy?: EnvPolicy;
  /** The contract version this host speaks. Defaults to this package's. */
  readonly ariVersion?: string;
  /** The event grammar versions this host speaks. Defaults to this package's. */
  readonly grammarVersions?: readonly [number, number];
  /** Per-method versions that differ from this package's, by wire method name. */
  readonly methodVersions?: { readonly [method: string]: Version };
  /** The persistence version this host reads and writes. Defaults to this package's. */
  readonly persistenceVersion?: Version;
  /** Told about frames that break the protocol. */
  readonly onProblem?: (message: string) => void;
  /** Describes why the connection closed when the driver side went away. */
  readonly describeClose?: () => string;
}

/** A session over the wire: a `Session` plus the async forms of its synchronous members. */
export interface WireSession extends Session {
  /** Asks the driver for `canRelease()` and keeps the answer. */
  fetchCanRelease(): Promise<boolean>;
  /** Asks the driver for `capabilities()` and keeps the answer. */
  fetchCapabilities(): Promise<Capabilities>;
  /** Asks the driver for `contextWindow(model, cwd)` and keeps the answer; present when `contextWindow` is. */
  fetchContextWindow?(model: string, cwd?: string): Promise<number | undefined>;
  /** Asks the driver for `canReuseContextUsage(previousModel, nextModel)` and keeps the answer; present when `canReuseContextUsage` is. */
  fetchCanReuseContextUsage?(previousModel: string, nextModel: string): Promise<boolean>;
}

export interface WireDriverConnection {
  /** The driver on the other end. */
  readonly driver: Driver;
  /** The outcome of `initialize`. */
  readonly negotiated: NegotiatedVersions;
  /** Resolves with the error the connection closed with. */
  readonly closed: Promise<AriError>;
  /** Closes the connection; the driver side then disposes its instances. */
  close(): Promise<void>;
}

type Params = { readonly [key: string]: unknown };

/** The change stream of a host that has nothing to watch: it ends at once. */
const NO_CHANGES: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }),
};

function without(params: Params, ...names: string[]): { [key: string]: unknown } {
  const rest: { [key: string]: unknown } = {};
  for (const [key, value] of Object.entries(params)) if (!names.includes(key)) rest[key] = value;
  return rest;
}

function jsonCopy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * The driver's last answer to a synchronous member. `refresh()` asks again in
 * the background, one request at a time. With `catchUp`, a refresh asked for
 * while one runs starts one more when it ends, so the answer catches up with
 * a change that happened meanwhile; without it, the running request is enough.
 */
class Remembered<T> {
  readonly #ask: () => Promise<T>;
  #answer: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } | undefined;
  #running: Promise<unknown> | undefined;
  #again = false;

  constructor(ask: () => Promise<T>, initial?: T) {
    this.#ask = ask;
    if (initial !== undefined) this.#answer = { ok: true, value: initial };
  }

  /** True once the driver answered (with a value or an error). */
  get known(): boolean {
    return this.#answer !== undefined;
  }

  /** The last answer: its value, or its error thrown; `fallback` before any answer. */
  read(fallback: T): T {
    if (this.#answer === undefined) return fallback;
    if (!this.#answer.ok) throw this.#answer.error;
    return this.#answer.value;
  }

  /** Asks the driver now and keeps its answer. */
  async fetch(): Promise<T> {
    try {
      const value = await this.#ask();
      this.#answer = { ok: true, value };
      return value;
    } catch (error) {
      // A closed connection says nothing about the member, so the last answer stays.
      if (!isAriError(error, "transport")) this.#answer = { ok: false, error };
      throw error;
    }
  }

  /** Asks the driver again in the background. */
  refresh(catchUp = false): void {
    if (this.#running !== undefined) {
      if (catchUp) this.#again = true;
      return;
    }
    this.#running = this.fetch()
      .catch(() => undefined)
      .finally(() => {
        this.#running = undefined;
        if (this.#again) {
          this.#again = false;
          this.refresh();
        }
      });
  }
}

class WireClient {
  readonly connection: WireConnection;
  readonly #delegateProcesses: boolean;
  /** Host services by the host's instance id, which every `host/*` call names. */
  readonly #hosts = new Map<string, HostServices<ConfigValues>>();
  /** Children the host spawned for the driver, by the `processId` the driver gave each, with their instance. */
  readonly #processes = new Map<string, { readonly child: SpawnedProcess; readonly instanceId: string }>();
  /** Every `processId` the driver used on this connection; one is never accepted twice. */
  readonly #usedProcessIds = new Set<string>();

  constructor(transport: WireTransport, options: ConnectDriverOptions) {
    this.#delegateProcesses = options.delegateProcesses === true;
    this.connection = new WireConnection(transport, {
      side: "host",
      onRequest: (method, params, context) => this.#hostRequest(method, params as Params, context),
      ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
      ...(options.describeClose === undefined ? {} : { describeClose: options.describeClose }),
    });
    this.connection.onClose(() => {
      // The driver is gone, so its children are too.
      for (const { child } of this.#processes.values()) void child.kill().catch(() => undefined);
      this.#processes.clear();
    });
  }

  async create(host: HostServices<ConfigValues>, input: CreateInstanceRequest<ConfigValues>): Promise<Instance> {
    if (this.#hosts.has(input.instanceId)) {
      throw callErrors.invalidState("duplicate_instance", `An instance with id ${input.instanceId} already exists on this connection`);
    }
    this.#hosts.set(input.instanceId, host);
    let descriptor: InstanceDescriptor;
    try {
      descriptor = await this.connection.request<InstanceDescriptor>("driver/create", {
        instanceId: input.instanceId,
        config: input.config,
        environment: input.environment,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        paths: { stateDir: host.paths.stateDir, cacheDir: host.paths.cacheDir, tmpDir: host.paths.tmpDir },
        hostMembers: presentMembers(host, OPTIONAL_HOST_MEMBERS),
      });
    } catch (error) {
      this.#hosts.delete(input.instanceId);
      throw error;
    }
    return buildInstance(this, descriptor, () => this.#hosts.delete(input.instanceId));
  }

  async openSession(instanceId: string, input: Params): Promise<Session> {
    const descriptor = await this.connection.request<SessionDescriptor>("instance/openSession", { ...input, instanceId });
    const session = buildSession(this, descriptor);
    await session.fetchCanRelease().catch(() => undefined);
    return session;
  }

  #host(params: Params): HostServices<ConfigValues> {
    const host = this.#hosts.get(params.instanceId as string);
    if (host === undefined) throw callErrors.notFound({ resource: "instance", id: params.instanceId as string });
    return host;
  }

  #process(params: Params): SpawnedProcess {
    return this.lookupProcess(params.instanceId as string, params.processId as string);
  }

  /** The registered child `processId` of instance `instanceId`; `not_found` when there is none. */
  lookupProcess(instanceId: string, processId: string): SpawnedProcess {
    const entry = this.#processes.get(processId);
    if (entry === undefined || entry.instanceId !== instanceId) throw callErrors.notFound({ resource: "process", id: processId });
    return entry.child;
  }

  /** The `processId`s of the registered children. */
  processIds(): string[] {
    return [...this.#processes.keys()];
  }

  async #hostRequest(method: string, params: Params, context: WireRequestContext): Promise<unknown> {
    const host = this.#host(params);
    switch (method) {
      case "host/config.get": {
        const watch = params.watch === true;
        const reading = await host.config.get(params.watch === undefined ? undefined : { watch: params.watch as boolean });
        if (!watch) return { config: reading.config };
        // A watch always answers a stream; with nothing to watch it ends at once.
        return { config: reading.config, streamId: this.connection.produce(context, reading.changes ?? NO_CHANGES, "host/config.changed") };
      }
      case "host/secrets.get": {
        const value = await host.secrets.get(params.namespace as string, params.key as string);
        return value === null ? null : { base64: bytesToBase64(value) };
      }
      case "host/secrets.set":
        return host.secrets.set(params.namespace as string, params.key as string, base64ToBytes((params.value as { base64: string }).base64));
      case "host/secrets.delete":
        return host.secrets.delete(params.namespace as string, params.key as string);
      case "host/process.spawn":
        return this.#spawn(host, params, context);
      case "host/process.resolveExecutable":
        return host.process.resolveExecutable(params.name as string, params.path === undefined ? undefined : { path: params.path as string });
      case "host/process.write":
        return this.#process(params).write(base64ToBytes(params.data as string));
      case "host/process.closeStdin":
        return this.#process(params).closeStdin();
      case "host/process.kill":
        return this.#process(params).kill(params.signal as string | undefined);
      case "host/attachments.resolve":
        return host.attachments.resolve(params.ref as string);
      case "host/attachments.extractText": {
        const extractText = host.attachments.extractText;
        if (extractText === undefined) throw callErrors.unsupported("attachments.extractText", "The host does not extract attachment text");
        return extractText.call(host.attachments, params.ref as string);
      }
      case "host/callbacks.register":
        return host.callbacks.register(params.flowId as string);
      case "host/hostTools.mcpServerFor":
        return host.hostTools.mcpServerFor(params.threadId as string, without(params, "instanceId", "threadId") as { transport: never });
      case "host/hostTools.callDynamicTool": {
        const callDynamicTool = host.hostTools.callDynamicTool;
        if (callDynamicTool === undefined) throw callErrors.unsupported("hostTools.callDynamicTool", "The host does not take dynamic tool calls");
        return callDynamicTool.call(host.hostTools, without(params, "instanceId") as never);
      }
      case "host/background.shouldRun":
        return host.background.shouldRun(params.scope as string);
      case "host/coordination.acquire":
        return host.coordination.acquire(params.key as string, params.ttlMs as number);
      case "host/coordination.release":
        return host.coordination.release(params.leaseId as string);
      case "host/ids.derive": {
        const ids = host.ids;
        if (ids === undefined) throw callErrors.unsupported("ids.derive", "The host does not derive ids");
        return ids.derive(params.kind as string, params.key as string);
      }
      case "host/diagnostics.log":
        host.diagnostics.log(without(params, "instanceId") as never);
        return null;
      case "host/telemetry.track": {
        const telemetry = host.telemetry;
        if (telemetry === undefined) throw callErrors.unsupported("telemetry.track", "The host does not take telemetry");
        telemetry.track(params.name as string, params.props as never);
        return null;
      }
      default:
        throw callErrors.unsupported(method, `Method not served by the host: ${method}`);
    }
  }

  async #spawn(host: HostServices<ConfigValues>, params: Params, context: WireRequestContext): Promise<{ pid?: number }> {
    if (!this.#delegateProcesses) {
      throw callErrors.unsupported("host.process", "The host did not offer host.process; the driver spawns locally");
    }
    const processId = params.processId as string;
    if (this.#usedProcessIds.has(processId)) {
      throw callErrors.invalidState("duplicate_process_id", `The driver already used processId ${processId} on this connection; process ids are never reused`);
    }
    this.#usedProcessIds.add(processId);
    const child = await host.process.spawn(without(params, "instanceId", "processId") as never);
    if (this.connection.closed) {
      // The connection closed while the host was spawning, and the close handler has already
      // killed every registered child. Nobody would ever kill this one, so end it now.
      await child.kill().catch(() => undefined);
      throw callErrors.transport(`The ari/wire connection closed while the host was spawning process ${processId}; the process was killed`);
    }
    this.#processes.set(processId, { child, instanceId: params.instanceId as string });
    this.connection.afterResponse(context, () => void this.#pumpProcess(processId, child));
    return child.pid === undefined ? {} : { pid: child.pid };
  }

  /** Sends the child's output, then its exit, to the driver. */
  async #pumpProcess(processId: string, child: SpawnedProcess): Promise<void> {
    const encoder = new TextEncoder();
    const pump = async (source: AsyncIterable<Uint8Array | string>, stream: "stdout" | "stderr"): Promise<void> => {
      try {
        for await (const chunk of source) {
          const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
          await this.connection.notify("host/process.output", { processId, stream, data: bytesToBase64(bytes) });
        }
      } catch {
        // The connection closed; the close handler kills the child.
      }
    };
    await Promise.all([pump(child.stdout, "stdout"), pump(child.stderr, "stderr")]);
    const exit: ProcessExit = await child.exited;
    this.#processes.delete(processId);
    if (this.connection.closed) return;
    await this.connection.notify("host/process.exit", { processId, exit: { code: exit.code, signal: exit.signal } }).catch(() => undefined);
  }
}

/** Builds the `Instance` for a driver's instance descriptor. */
function buildInstance(client: WireClient, descriptor: InstanceDescriptor, forgetHost: () => void): Instance {
  const instanceId = descriptor.instanceId;
  const members = new Set(descriptor.members);
  const connection = client.connection;
  const call = <T>(member: string, params: Params = {}): Promise<T> => connection.request<T>(`instance/${member}`, { ...params, instanceId });
  const voidCall = async (member: string, params: Params = {}): Promise<void> => {
    await call(member, params);
  };
  const missing = (member: string) => (): never => {
    throw callErrors.unsupported(member, `Not supported: ${member}`);
  };
  const missingAsync = (member: string) => (): Promise<never> => Promise.reject(callErrors.unsupported(member, `Not supported: ${member}`));
  const anyOf = (...paths: string[]): boolean => paths.some((path) => members.has(path));

  const instance: Instance = {
    id: instanceId,
    continuationKey: descriptor.continuationKey,
    bindingKey: descriptor.bindingKey,
    status: () => call<InstanceStatus>("status"),
    statusChanges: () => connection.openStream<InstanceStatus>("instance/statusChanges", { instanceId }),
    probe: (options) => call("probe", options ?? {}),
    catalog: {
      list: (options) => call("catalog.list", options ?? {}),
    },
    openSession: (input) => client.openSession(instanceId, input),
    dispose: async () => {
      await voidCall("dispose");
      forgetHost();
    },
  };
  if (members.has("catalog.refresh")) instance.catalog.refresh = () => voidCall("catalog.refresh");
  if (members.has("invalidateCaches")) instance.invalidateCaches = () => voidCall("invalidateCaches");

  if (anyOf("maintenance.advisory", "maintenance.install", "maintenance.update")) {
    const maintenance: NonNullable<Instance["maintenance"]> = {
      advisory: members.has("maintenance.advisory") ? () => call("maintenance.advisory") : missingAsync("maintenance.advisory"),
    };
    if (members.has("maintenance.install")) maintenance.install = () => voidCall("maintenance.install");
    if (members.has("maintenance.update")) maintenance.update = () => voidCall("maintenance.update");
    instance.maintenance = maintenance;
  }

  if (anyOf(...["methods", "state", "reportRuntimeFailure", "start", "complete", "respond", "cancel", "logout", "transferProfile", "transferSession"].map((name) => `auth.${name}`))) {
    const methods = new Remembered(() => call<AuthMethod[]>("auth.methods"));
    /** An auth call; sign-in can change the methods on offer, so they are read again after it. */
    const authCall = async <T>(member: string, params: Params = {}): Promise<T> => {
      try {
        return await call<T>(`auth.${member}`, params);
      } finally {
        if (members.has("auth.methods") && !connection.closed) methods.refresh(true);
      }
    };
    const auth: NonNullable<Instance["auth"]> = {
      methods: members.has("auth.methods")
        ? () => {
            if (!connection.closed) methods.refresh();
            return jsonCopy(methods.read([]));
          }
        : missing("auth.methods"),
      state: members.has("auth.state") ? () => authCall("state") : missingAsync("auth.state"),
      start: members.has("auth.start") ? (input) => authCall("start", input) : missingAsync("auth.start"),
      complete: members.has("auth.complete") ? (input) => authCall("complete", input) : missingAsync("auth.complete"),
      cancel: members.has("auth.cancel") ? (flowId) => authCall("cancel", { flowId }) : missingAsync("auth.cancel"),
      ...(descriptor.credentialBinding === undefined ? {} : { credentialBinding: descriptor.credentialBinding }),
    };
    if (members.has("auth.reportRuntimeFailure")) auth.reportRuntimeFailure = (failure) => authCall("reportRuntimeFailure", failure);
    if (members.has("auth.respond")) auth.respond = (input) => authCall("respond", input);
    if (members.has("auth.logout")) auth.logout = async () => void (await authCall("logout"));
    if (members.has("auth.transferProfile")) auth.transferProfile = (profile) => authCall("transferProfile", { profile });
    if (members.has("auth.transferSession")) {
      auth.transferSession = (handle, target) => {
        if (!WIRE_INSTANCES.has(target) || WIRE_INSTANCES.get(target) !== client) {
          return Promise.reject(callErrors.validation([{ message: "must be an instance of the same ari/wire connection", path: ["target"] }], "transferSession needs a target instance on the same connection"));
        }
        return authCall("transferSession", { handle, targetInstanceId: target.id });
      };
    }
    instance.auth = auth;
    if (members.has("auth.methods")) methods.refresh();
  }

  if (members.has("workspace.snapshot")) instance.workspace = { snapshot: (cwd) => call("workspace.snapshot", { cwd }) };

  if (anyOf("limits.current", "limits.accountKey", "limits.consumeResetCredit")) {
    const accountKey = new Remembered(() => call<string>("limits.accountKey"), descriptor.accountKey);
    const limits: NonNullable<Instance["limits"]> = {
      current: members.has("limits.current") ? () => call("limits.current") : missingAsync("limits.current"),
      accountKey: members.has("limits.accountKey")
        ? () => {
            if (!connection.closed) accountKey.refresh();
            if (!accountKey.known) throw callErrors.invalidState("account_key_unknown", "The driver has not reported the limits account key yet");
            return accountKey.read("");
          }
        : missing("limits.accountKey"),
    };
    if (members.has("limits.consumeResetCredit")) limits.consumeResetCredit = (input) => call("limits.consumeResetCredit", input);
    instance.limits = limits;
  }

  if (members.has("usageHistory.scan")) {
    instance.usageHistory = { scan: (range) => connection.openStream<UsageRecord>("instance/usageHistory.scan", { ...range, instanceId }) };
  }

  if (members.has("textGeneration.generate")) {
    const guarantees = descriptor.textGenerationGuarantees;
    if (guarantees === undefined) throw callErrors.protocol("missing_text_generation_guarantees", "The driver lists textGeneration.generate without textGenerationGuarantees");
    instance.textGeneration = { guarantees, generate: (request) => call("textGeneration.generate", request) };
  }

  if (anyOf("nativeSessions.list", "nativeSessions.delete", "nativeSessions.archive")) {
    const nativeSessions: NonNullable<Instance["nativeSessions"]> = {
      list: members.has("nativeSessions.list") ? (input) => call("nativeSessions.list", input) : missingAsync("nativeSessions.list"),
    };
    if (members.has("nativeSessions.delete")) nativeSessions.delete = (id) => voidCall("nativeSessions.delete", { id });
    if (members.has("nativeSessions.archive")) nativeSessions.archive = (id) => voidCall("nativeSessions.archive", { id });
    instance.nativeSessions = nativeSessions;
  }

  if (anyOf("subProviders.list", "subProviders.set", "subProviders.disable")) {
    instance.subProviders = {
      list: members.has("subProviders.list") ? (cwd) => call("subProviders.list", { cwd }) : missingAsync("subProviders.list"),
      set: members.has("subProviders.set") ? (input) => voidCall("subProviders.set", input) : missingAsync("subProviders.set"),
      disable: members.has("subProviders.disable") ? (input) => voidCall("subProviders.disable", input) : missingAsync("subProviders.disable"),
    };
  }

  WIRE_INSTANCES.set(instance, client);
  return instance;
}

/** Which connection each instance belongs to, for `auth.transferSession`. */
const WIRE_INSTANCES = new WeakMap<Instance, WireClient>();

/** Builds the `Session` for a driver's session descriptor. */
function buildSession(client: WireClient, descriptor: SessionDescriptor): WireSession {
  const sessionId = descriptor.sessionId;
  const members = new Set(descriptor.members);
  const connection = client.connection;

  let capabilities: Capabilities = descriptor.capabilities;
  /** The `seq` of the `capabilities.updated` event `capabilities` came from; 0 for the descriptor. */
  let capabilitiesSeq = 0;
  const canRelease = new Remembered(() => connection.request<boolean>("session/canRelease", { sessionId }));
  let closed = false;
  /** Turns that started and have not settled, with the envelope fields of their events. */
  const openTurns = new Map<string, { readonly threadId?: string; readonly hostTag?: string }>();
  const settledTurns = new Set<string>();
  let lastSeq = 0;
  let closingEvents: AriEvent[] | undefined;

  const refreshCanRelease = (): void => {
    if (!closed && !connection.closed) canRelease.refresh(true);
  };

  const call = async <T>(member: string, params: Params = {}): Promise<T> => {
    try {
      return await connection.request<T>(`session/${member}`, { ...params, sessionId });
    } finally {
      refreshCanRelease();
    }
  };
  const voidCall = async (member: string, params: Params = {}): Promise<void> => {
    await call(member, params);
  };
  const missingAsync = (member: string, capability: string) => (): Promise<never> => Promise.reject(callErrors.unsupported(capability, `Not supported: ${member}`));
  const anyOf = (...paths: string[]): boolean => paths.some((path) => members.has(path));

  const observe = (event: AriEvent): void => {
    if (event.seq > lastSeq) lastSeq = event.seq;
    const body = event.body;
    if (body.type === "turn.upsert") {
      const turn = body.turn as { readonly [field: string]: unknown } & { readonly id: string };
      const complete = TURN_REQUIRED_FIELDS.every((field) => turn[field] !== undefined && turn[field] !== null);
      if (complete && !settledTurns.has(turn.id) && !openTurns.has(turn.id)) {
        openTurns.set(turn.id, {
          ...(typeof turn.threadId === "string" ? { threadId: turn.threadId } : {}),
          ...(event.hostTag === undefined ? {} : { hostTag: event.hostTag }),
        });
      }
    } else if (body.type === "turn.terminal") {
      openTurns.delete(body.turnId);
      settledTurns.add(body.turnId);
    } else if (body.type === "capabilities.updated" && event.seq > capabilitiesSeq) {
      capabilities = body.capabilities;
      capabilitiesSeq = event.seq;
    }
    refreshCanRelease();
  };

  /** The events that end every open stream when the connection dies: a failed terminal for each open turn. */
  const eventsAtClose = (error: AriError): readonly AriEvent[] => {
    closingEvents ??= [...openTurns].map(([turnId, envelope], index) => ({
      seq: lastSeq + 1 + index,
      at: new Date().toISOString(),
      sessionId,
      ...(envelope.threadId === undefined ? {} : { threadId: envelope.threadId }),
      turnId,
      ...(envelope.hostTag === undefined ? {} : { hostTag: envelope.hostTag }),
      body: {
        type: "turn.terminal",
        turnId,
        status: "failed",
        failure: { class: "transport_error", message: error.message, retryable: true },
        threadDisposition: "broken",
      },
    }));
    return closingEvents;
  };

  const session: WireSession = {
    id: sessionId,
    capabilities: () => capabilities,
    events: (options) =>
      connection.openStream<AriEvent>("session/events", options?.fromSeq === undefined ? { sessionId } : { sessionId, fromSeq: options.fromSeq }, {
        observe,
        finalItems: eventsAtClose,
      }),
    createThread: (input) => call("createThread", input),
    resumeThread: (input) => call("resumeThread", input),
    canRelease: () => {
      refreshCanRelease();
      return canRelease.read(false);
    },
    release: () => voidCall("release"),
    startTurn: (input) => call("startTurn", input),
    interruptTurn: (input) => voidCall("interruptTurn", input),
    respond: async (input) => (await call<RespondResult | null>("respond", input)) ?? undefined,
    planConfigChange: (input) => call("planConfigChange", input),
    close: async () => {
      await connection.request("session/close", { sessionId });
      closed = true;
    },
    fetchCanRelease: () => canRelease.fetch(),
    fetchCapabilities: async () => {
      capabilities = await connection.request<Capabilities>("session/capabilities", { sessionId });
      return capabilities;
    },
  };

  if (members.has("readSnapshot")) session.readSnapshot = (threadId) => call("readSnapshot", { threadId });
  if (members.has("forkThread")) session.forkThread = (input) => call("forkThread", input);
  if (members.has("rollbackThread")) session.rollbackThread = (input) => call("rollbackThread", input);
  if (members.has("compactThread")) session.compactThread = (threadId) => voidCall("compactThread", { threadId });
  if (members.has("injectHistory")) session.injectHistory = (input) => call("injectHistory", input);
  if (members.has("unloadThread")) session.unloadThread = (threadId) => voidCall("unloadThread", { threadId });
  if (anyOf("backgroundTasks.list", "backgroundTasks.stop", "backgroundTasks.await")) {
    session.backgroundTasks = {
      list: members.has("backgroundTasks.list")
        ? (threadId, options) => call("backgroundTasks.list", { ...(options ?? {}), threadId })
        : missingAsync("backgroundTasks.list", "background.list"),
      stop: members.has("backgroundTasks.stop") ? (input) => voidCall("backgroundTasks.stop", input) : missingAsync("backgroundTasks.stop", "background.stop"),
      await: members.has("backgroundTasks.await") ? (input) => call("backgroundTasks.await", input) : missingAsync("backgroundTasks.await", "background.await"),
    };
  }
  if (members.has("stopSubagent")) session.stopSubagent = async (input) => (await call<SubagentOutcome | null>("stopSubagent", input)) ?? undefined;
  if (anyOf("mcpApps.listTools", "mcpApps.callTool", "mcpApps.readResource")) {
    session.mcpApps = {
      listTools: members.has("mcpApps.listTools") ? (threadId, server) => call("mcpApps.listTools", { threadId, server }) : missingAsync("mcpApps.listTools", "tools.mcpApps"),
      callTool: members.has("mcpApps.callTool")
        ? (threadId, server, tool, args) => call("mcpApps.callTool", { threadId, server, tool, args })
        : missingAsync("mcpApps.callTool", "tools.mcpApps"),
      readResource: members.has("mcpApps.readResource")
        ? (threadId, server, uri) => call("mcpApps.readResource", { threadId, server, uri })
        : missingAsync("mcpApps.readResource", "tools.mcpApps"),
    };
  }
  if (members.has("contextWindow")) {
    const windows = new Map<string, Remembered<number | null>>();
    const windowFor = (model: string, cwd?: string): Remembered<number | null> => {
      const key = JSON.stringify([model, cwd ?? null]);
      let window = windows.get(key);
      if (window === undefined) {
        window = new Remembered(() => connection.request<number | null>("session/contextWindow", cwd === undefined ? { sessionId, model } : { sessionId, model, cwd }));
        windows.set(key, window);
      }
      return window;
    };
    session.fetchContextWindow = async (model, cwd) => (await windowFor(model, cwd).fetch()) ?? undefined;
    session.contextWindow = (model, cwd) => {
      if (!hasCapability(capabilities, "contextWindowReporting")) throw callErrors.unsupported("contextWindowReporting");
      const window = windowFor(model, cwd);
      if (!window.known && !connection.closed) window.refresh();
      return window.read(null) ?? undefined;
    };
  }
  if (members.has("canReuseContextUsage")) {
    const answers = new Map<string, Remembered<boolean>>();
    const answerFor = (previousModel: string, nextModel: string): Remembered<boolean> => {
      const key = JSON.stringify([previousModel, nextModel]);
      let answer = answers.get(key);
      if (answer === undefined) {
        answer = new Remembered(() => connection.request<boolean>("session/canReuseContextUsage", { sessionId, previousModel, nextModel }));
        answers.set(key, answer);
      }
      return answer;
    };
    session.fetchCanReuseContextUsage = (previousModel, nextModel) => answerFor(previousModel, nextModel).fetch();
    session.canReuseContextUsage = (previousModel, nextModel) => {
      if (!hasCapability(capabilities, "sessions.contextUsageReuse")) throw callErrors.unsupported("sessions.contextUsageReuse");
      const answer = answerFor(previousModel, nextModel);
      if (!answer.known && !connection.closed) answer.refresh();
      return answer.read(false);
    };
  }
  if (members.has("uploadFeedback")) session.uploadFeedback = (input) => call("uploadFeedback", input);
  if (members.has("ext")) session.ext = (ns, method, params) => call("ext", params === undefined ? { ns, method } : { ns, method, params });
  return session;
}

/**
 * Connects to a driver served over `transport` (for example by `ari-driver`
 * on a child's stdio): runs `initialize`, reads the driver's default config,
 * and returns the driver.
 */
export async function connectDriver(transport: WireTransport, options: ConnectDriverOptions = {}): Promise<WireDriverConnection> {
  const client = new WireClient(transport, options);
  const connection = client.connection;
  connection.start();
  const handshake = {
    ariVersion: options.ariVersion ?? ARI_VERSION,
    grammarVersions: [...(options.grammarVersions ?? GRAMMAR_VERSIONS)] as [number, number],
    methodVersions: { ...defaultMethodVersions(), ...(options.methodVersions ?? {}) },
    persistenceVersion: { ...(options.persistenceVersion ?? PERSISTENCE_VERSION) },
  };
  const params: InitializeParams = {
    ...handshake,
    host: {
      capabilities: { process: options.delegateProcesses === true },
      ...(options.envPolicy === undefined ? {} : { envPolicy: { stripAmbient: [...options.envPolicy.stripAmbient] } }),
    },
  };
  let result: InitializeResult;
  let defaultConfig: ConfigValues;
  let negotiated: NegotiatedVersions;
  try {
    result = await connection.request<InitializeResult>("initialize", params);
    negotiated = negotiateHandshake(handshake, result);
    connection.setNegotiated(negotiated);
    defaultConfig = await connection.request<ConfigValues>("driver/defaultConfig", {});
  } catch (error) {
    connection.close();
    throw error;
  }
  const descriptor = result.driver;
  const driver: Driver = {
    kind: descriptor.kind,
    ariVersion: descriptor.ariVersion,
    metadata: descriptor.metadata,
    configSchema: descriptor.configSchema,
    ...(descriptor.cliManifest === undefined ? {} : { cliManifest: descriptor.cliManifest }),
    defaultConfig: () => jsonCopy(defaultConfig),
    create: (host, input) => client.create(host, input),
  };
  const wireConnection: WireDriverConnection = {
    driver,
    negotiated,
    closed: connection.done,
    async close() {
      connection.close();
      await connection.done;
    },
  };
  clients.set(wireConnection, client);
  return wireConnection;
}

/** The client behind each connection `connectDriver` returned, for `delegatedProcessTable`. */
const clients = new WeakMap<WireDriverConnection, WireClient>();

/**
 * The delegated children `connection`'s client has registered: their
 * `processId`s, and the lookup `host/process.write`, `.closeStdin` and
 * `.kill` use, which rejects `not_found` for a child it does not hold. For
 * tests; `ari/wire` does not export it.
 */
export function delegatedProcessTable(connection: WireDriverConnection): { readonly processIds: string[]; lookup(instanceId: string, processId: string): SpawnedProcess } {
  const client = clients.get(connection);
  if (client === undefined) throw new TypeError("delegatedProcessTable: not a connection connectDriver returned");
  return { processIds: client.processIds(), lookup: (instanceId, processId) => client.lookupProcess(instanceId, processId) };
}
