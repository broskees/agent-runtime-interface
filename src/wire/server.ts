// The driver side of `ari/wire`: serves one `Driver` to one host over a
// transport, as `ari-driver` does on its stdin and stdout.
//
// The host must call `initialize` first; every other call before it is
// refused with `invalid_state` (`not_initialized`). `driver/create` makes an
// instance whose `HostServices` are this connection's `host/*` methods (see
// host-proxy.ts); its result lists the optional members the instance has.
// `instance/openSession` does the same for a session. Instance and session
// calls name their target by `instanceId` and `sessionId`, map the wire params
// onto the TypeScript arguments (positional arguments come from named fields)
// and answer with the return value, `null` for nothing. A member the target
// lacks is refused with `unsupported`, naming its capability for a session
// member and its path for an instance member.
//
// When the connection closes, every instance is disposed (which closes its
// sessions), local child processes are ended, and `closed` resolves. Ending
// the local processes waits for the instances' disposal for at most
// `LOCAL_PROCESSES_END_AFTER_MS`, so a driver whose dispose is slow or hangs
// cannot keep its agents running.

import type { AriError } from "../ari-error.ts";
import { callErrors } from "../errors.ts";
import type { Version } from "../generated/common.ts";
import type { EnvPolicy, HostPaths } from "../generated/host.ts";
import type { InitializeParams, InitializeResult } from "../generated/handshake.ts";
import type { DriverDescriptor } from "../generated/driver.ts";
import type { InstanceDescriptor, SessionDescriptor } from "../generated/rpc.ts";
import { createProcessService } from "../node/process.ts";
import type { ProcessService } from "../node/process.ts";
import type { CreateInstanceRequest, Driver, Instance, Session } from "../runtime.ts";
import { ARI_VERSION, GRAMMAR_VERSIONS, PERSISTENCE_VERSION } from "../version.ts";
import { WireConnection } from "./connection.ts";
import type { WireRequestContext, WireTransport } from "./connection.ts";
import { negotiateHandshake } from "./handshake.ts";
import type { NegotiatedVersions } from "./handshake.ts";
import { DelegatedChildren, createWireHostServices } from "./host-proxy.ts";
import { OPTIONAL_INSTANCE_MEMBERS, OPTIONAL_SESSION_MEMBERS, defaultMethodVersions, memberAt, presentMembers } from "./methods.ts";

/**
 * How long after the connection closes local child processes are ended, even
 * while an instance's dispose still runs: the budget a driver's own shutdown
 * has to stop its agents its own way. It is the largest that keeps every agent
 * gone within 5 s of `ari-driver` being told to stop, for an agent that
 * ignores SIGTERM: this head start, then the 2 s kill grace after SIGTERM,
 * leaves 1 s for scheduling under load (the guard ends such a group about
 * 2.01 s after it is asked, measured at load average 34).
 */
export const LOCAL_PROCESSES_END_AFTER_MS = 2000;

export interface ServeDriverOptions {
  /** The contract version this side speaks. Defaults to this package's. */
  readonly ariVersion?: string;
  /** The event grammar versions this side speaks. Defaults to this package's. */
  readonly grammarVersions?: readonly [number, number];
  /** Per-method versions that differ from this package's, by wire method name. */
  readonly methodVersions?: { readonly [method: string]: Version };
  /** The persistence version this side reads and writes. Defaults to this package's. */
  readonly persistenceVersion?: Version;
  /** Makes the process service for local spawns. Defaults to `ari/node`'s, started from this process's environment. */
  readonly localProcesses?: (envPolicy: EnvPolicy) => ProcessService;
  /** Told about frames that break the protocol. */
  readonly onProblem?: (message: string) => void;
}

export interface DriverServer {
  /** The handshake's outcome, once the host called `initialize`. */
  readonly negotiated: NegotiatedVersions | undefined;
  /** Resolves with the connection's close error as soon as the connection closes. */
  readonly disconnected: Promise<AriError>;
  /** Resolves when the connection closed and every instance was disposed. */
  readonly closed: Promise<void>;
  /** Closes the connection and cleans up. */
  close(): Promise<void>;
}

interface ServedInstance {
  readonly instance: Instance;
  readonly sessions: Set<string>;
}

type Params = { readonly [key: string]: unknown };

/** `params` without the named fields. */
function without(params: Params, ...names: string[]): { [key: string]: unknown } {
  const rest: { [key: string]: unknown } = {};
  for (const [key, value] of Object.entries(params)) if (!names.includes(key)) rest[key] = value;
  return rest;
}

/** The argument list for an optional options argument: none when the wire params held nothing. */
function optionalArgument(options: { [key: string]: unknown }): unknown[] {
  return Object.keys(options).length === 0 ? [] : [options];
}

/** Calls the member at `path` of `target` as a method of the object that holds it, or rejects with `unsupported`. */
function callMember(target: object, path: string, args: unknown[], capability: string = path): unknown {
  const member = memberAt(target, path);
  if (member === undefined) throw callErrors.unsupported(capability, `Not supported: ${path}`);
  let owner: unknown = target;
  for (const segment of path.split(".").slice(0, -1)) owner = (owner as { [key: string]: unknown })[segment];
  return member.apply(owner, args);
}

function sessionCapability(member: string): string {
  return (OPTIONAL_SESSION_MEMBERS as { readonly [member: string]: string })[member] ?? member;
}

/** Serves `driver` over `transport` until the transport closes. */
export function serveDriver(driver: Driver<any>, transport: WireTransport, options: ServeDriverOptions = {}): DriverServer {
  const ownHandshake = {
    ariVersion: options.ariVersion ?? ARI_VERSION,
    grammarVersions: [...(options.grammarVersions ?? GRAMMAR_VERSIONS)] as [number, number],
    methodVersions: { ...defaultMethodVersions(), ...(options.methodVersions ?? {}) },
    persistenceVersion: { ...(options.persistenceVersion ?? PERSISTENCE_VERSION) },
  };
  const instances = new Map<string, ServedInstance>();
  const sessions = new Map<string, { readonly session: Session; readonly instanceId: string }>();
  const problem = options.onProblem ?? (() => undefined);
  const children = new DelegatedChildren(problem);
  let negotiated: NegotiatedVersions | undefined;
  let delegatedProcesses = false;
  let envPolicy: EnvPolicy = { stripAmbient: [] };
  let localProcesses: ProcessService | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const localProcessService = (): ProcessService => {
    localProcesses ??= (options.localProcesses ?? ((policy) => createProcessService({ envPolicy: policy })))(envPolicy);
    return localProcesses;
  };

  const instanceFor = (params: Params): ServedInstance => {
    const served = instances.get(params.instanceId as string);
    if (served === undefined) throw callErrors.notFound({ resource: "instance", id: params.instanceId as string });
    return served;
  };

  const sessionFor = (params: Params): Session => {
    const served = sessions.get(params.sessionId as string);
    if (served === undefined) throw callErrors.notFound({ resource: "session", id: params.sessionId as string });
    return served.session;
  };

  const initialize = (params: InitializeParams): InitializeResult => {
    if (negotiated !== undefined) throw callErrors.invalidState("already_initialized", "initialize was already called on this connection");
    const result = negotiateHandshake(params, ownHandshake);
    negotiated = result;
    connection.setNegotiated(result);
    delegatedProcesses = params.host.capabilities.process;
    envPolicy = { stripAmbient: [...(params.host.envPolicy?.stripAmbient ?? [])] };
    const descriptor: DriverDescriptor = {
      kind: driver.kind,
      ariVersion: driver.ariVersion,
      metadata: driver.metadata,
      configSchema: driver.configSchema,
      ...(driver.cliManifest === undefined ? {} : { cliManifest: driver.cliManifest }),
    };
    return { ...ownHandshake, grammarVersion: result.grammarVersion, driver: descriptor };
  };

  const create = async (params: Params): Promise<InstanceDescriptor> => {
    const hostInstanceId = params.instanceId as string;
    const host = createWireHostServices({
      connection,
      instanceId: hostInstanceId,
      paths: params.paths as HostPaths,
      hostMembers: (params.hostMembers as string[] | undefined) ?? [],
      envPolicy,
      processes: delegatedProcesses ? { mode: "delegated", children } : { mode: "local", service: localProcessService },
      onProblem: problem,
    });
    const input: CreateInstanceRequest<unknown> = {
      instanceId: hostInstanceId,
      config: params.config,
      environment: { ...(params.environment as { [name: string]: string }) },
      ...(params.displayName === undefined ? {} : { displayName: params.displayName as string }),
    };
    const instance = await driver.create(host, input);
    if (instances.has(instance.id)) {
      await instance.dispose().catch(() => undefined);
      throw callErrors.invalidState("duplicate_instance", `An instance with id ${instance.id} already exists on this connection`);
    }
    instances.set(instance.id, { instance, sessions: new Set() });
    const auth = instance.auth;
    let accountKey: string | undefined;
    try {
      accountKey = instance.limits === undefined ? undefined : instance.limits.accountKey();
    } catch {
      // No key yet; the host reads it later with instance/limits.accountKey.
      accountKey = undefined;
    }
    return {
      instanceId: instance.id,
      continuationKey: instance.continuationKey,
      bindingKey: instance.bindingKey,
      members: presentMembers(instance, OPTIONAL_INSTANCE_MEMBERS),
      ...(auth?.credentialBinding === undefined ? {} : { credentialBinding: auth.credentialBinding }),
      ...(instance.textGeneration === undefined ? {} : { textGenerationGuarantees: instance.textGeneration.guarantees }),
      ...(accountKey === undefined ? {} : { accountKey }),
    };
  };

  const openSession = async (served: ServedInstance, params: Params): Promise<SessionDescriptor> => {
    const session = await served.instance.openSession(without(params, "instanceId"));
    if (sessions.has(session.id)) {
      await session.close().catch(() => undefined);
      throw callErrors.invalidState("duplicate_session", `A session with id ${session.id} already exists on this connection`);
    }
    sessions.set(session.id, { session, instanceId: served.instance.id });
    served.sessions.add(session.id);
    return {
      sessionId: session.id,
      capabilities: session.capabilities(),
      members: presentMembers(session, Object.keys(OPTIONAL_SESSION_MEMBERS)),
    };
  };

  const dispose = async (served: ServedInstance): Promise<void> => {
    await served.instance.dispose();
    instances.delete(served.instance.id);
    for (const sessionId of served.sessions) sessions.delete(sessionId);
  };

  const instanceCall = (member: string, params: Params, context: WireRequestContext): unknown => {
    const served = instanceFor(params);
    const instance = served.instance;
    const rest = without(params, "instanceId");
    switch (member) {
      case "statusChanges":
        return { streamId: connection.produce(context, callMember(instance, "statusChanges", []) as AsyncIterable<unknown>, "instance/statusChanged") };
      case "usageHistory.scan":
        return { streamId: connection.produce(context, callMember(instance, "usageHistory.scan", [rest]) as AsyncIterable<unknown>, "instance/usageRecord") };
      case "openSession":
        return openSession(served, params);
      case "dispose":
        return dispose(served);
      case "probe":
      case "catalog.list":
        return callMember(instance, member, optionalArgument(rest));
      case "auth.cancel":
        return callMember(instance, member, [params.flowId]);
      case "auth.transferProfile":
        return callMember(instance, member, [params.profile]);
      case "auth.transferSession": {
        const target = instances.get(params.targetInstanceId as string);
        if (target === undefined) throw callErrors.notFound({ resource: "instance", id: params.targetInstanceId as string });
        return callMember(instance, member, [params.handle, target.instance]);
      }
      case "workspace.snapshot":
      case "subProviders.list":
        return callMember(instance, member, [params.cwd]);
      case "nativeSessions.delete":
      case "nativeSessions.archive":
        return callMember(instance, member, [params.id]);
      case "auth.reportRuntimeFailure":
      case "auth.start":
      case "auth.complete":
      case "auth.respond":
      case "limits.consumeResetCredit":
      case "textGeneration.generate":
      case "nativeSessions.list":
      case "subProviders.set":
      case "subProviders.disable":
        return callMember(instance, member, [rest]);
      default:
        // status, invalidateCaches, maintenance.advisory, auth.methods, auth.state, auth.logout,
        // catalog.refresh, limits.current, limits.accountKey: no arguments.
        return callMember(instance, member, []);
    }
  };

  const sessionCall = (member: string, params: Params, context: WireRequestContext): unknown => {
    const session = sessionFor(params);
    const rest = without(params, "sessionId");
    const call = (args: unknown[]): unknown => callMember(session, member, args, sessionCapability(member));
    switch (member) {
      case "events":
        return { streamId: connection.produce(context, call(optionalArgument(rest)) as AsyncIterable<unknown>, "ari/event") };
      case "readSnapshot":
      case "compactThread":
      case "unloadThread":
        return call([params.threadId]);
      case "backgroundTasks.list":
        return call([params.threadId, ...optionalArgument(without(rest, "threadId"))]);
      case "mcpApps.listTools":
        return call([params.threadId, params.server]);
      case "mcpApps.callTool":
        return call([params.threadId, params.server, params.tool, params.args]);
      case "mcpApps.readResource":
        return call([params.threadId, params.server, params.uri]);
      case "contextWindow":
        return call(params.cwd === undefined ? [params.model] : [params.model, params.cwd]);
      case "canReuseContextUsage":
        return call([params.previousModel, params.nextModel]);
      case "ext":
        return call([params.ns, params.method, params.params]);
      case "capabilities":
      case "canRelease":
      case "release":
      case "close":
        return call([]);
      default:
        // createThread, resumeThread, forkThread, rollbackThread, injectHistory, startTurn,
        // interruptTurn, respond, backgroundTasks.stop/await, stopSubagent,
        // planConfigChange, uploadFeedback: one input object.
        return call([rest]);
    }
  };

  const onRequest = (method: string, params: unknown, context: WireRequestContext): unknown => {
    const record = params as Params;
    if (method === "initialize") return initialize(params as InitializeParams);
    if (negotiated === undefined) throw callErrors.invalidState("not_initialized", `Call initialize before ${method}`);
    if (method === "driver/defaultConfig") return driver.defaultConfig();
    if (method === "driver/create") return create(record);
    if (method.startsWith("instance/")) return instanceCall(method.slice("instance/".length), record, context);
    if (method.startsWith("session/")) return sessionCall(method.slice("session/".length), record, context);
    throw callErrors.unsupported(method, `Method not served by the driver: ${method}`);
  };

  const connection: WireConnection = new WireConnection(transport, {
    side: "driver",
    onRequest,
    onNotification: (method, params) => {
      if (!children.receive(method, params)) problem(`unexpected notification ${method}`);
    },
    onProblem: problem,
    describeClose: () => "The host closed the ari/wire connection",
  });

  connection.onClose(() => {
    children.closeAll();
    void (async () => {
      const served = [...instances.values()];
      instances.clear();
      sessions.clear();
      const disposing = Promise.allSettled(served.map((entry) => entry.instance.dispose()));
      // Give the instances a head start to stop their agents their own way, then end the local processes regardless.
      let headStart: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([disposing, new Promise<void>((resolve) => (headStart = setTimeout(resolve, LOCAL_PROCESSES_END_AFTER_MS)))]);
      clearTimeout(headStart);
      await localProcesses?.dispose().catch(() => undefined);
      await disposing;
      resolveClosed();
    })();
  });

  connection.start();

  return {
    get negotiated() {
      return negotiated;
    },
    disconnected: connection.done,
    closed,
    async close() {
      connection.close();
      await closed;
    },
  };
}
