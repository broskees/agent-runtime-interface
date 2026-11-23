// Effect services for ARI's runtime interfaces: `Driver`, `Instance`,
// `Session` and `HostServices` (src/runtime.ts). Each `toEffect*` function
// wraps a plain object in an Effect-shaped one with the same members:
//
// - a method that returns a Promise, or a value, returns an `Effect` instead;
//   nothing runs until the Effect runs, and each run calls the method again;
// - a method that returns an `AsyncIterable` returns a `Stream`, which calls
//   the method each time it runs and stops the iterator when it ends early;
// - a rejection or throw with a call error fails with its tagged error from
//   ./errors.ts; any other rejection is a defect, because ARI methods reject
//   only with call errors;
// - optional members stay optional, exactly as on the wrapped object;
// - data properties (`id`, `metadata`, `envPolicy`, ...) are copied, and
//   `unwrapped` is the plain object itself.
//
// The `AriDriver`, `AriInstance`, `AriSession` and `AriHostServices` classes
// are `Context.Service` keys for these shapes, with layers to provide them.

import type { Effect as EffectType, Layer as LayerType, Stream as StreamType } from "effect";
import type { TaskInfo } from "../generated/background.ts";
import type { Capabilities } from "../generated/capabilities.ts";
import type { AttachmentInfo, ConfigValues, JsonSchema } from "../generated/common.ts";
import type { ConfigChangePlan } from "../generated/config.ts";
import type { CliLaunchManifest, DriverMetadata } from "../generated/driver.ts";
import type { AriEvent } from "../generated/events.ts";
import type {
  CallbackRegistration,
  DiagnosticEntry,
  DynamicToolCall,
  DynamicToolResult,
  EnvPolicy,
  HostToolServer,
  Lease,
  McpServerForOptions,
  ProcessExit,
  SpawnRequest,
} from "../generated/host.ts";
import type {
  AuthCompleteInput,
  AuthFlow,
  AuthMethod,
  AuthRespondInput,
  AuthStartInput,
  AuthState,
  CatalogListOptions,
  ConsumeResetCreditInput,
  CredentialBinding,
  InstanceStatus,
  ModelCatalog,
  NativeSessionInfoPage,
  NativeSessionListInput,
  OpenSessionInput,
  ProbeOptions,
  ProbeResult,
  RuntimeFailureReport,
  SubProvider,
  SubProviderDisableInput,
  SubProviderSetInput,
  TextGenerationGuarantees,
  TextGenerationRequest,
  TransferredProfile,
  UpdateAdvisory,
  UsageRange,
  WorkspaceSnapshot,
} from "../generated/instance.ts";
import type {
  AppliedThread,
  AwaitBackgroundTasksInput,
  AwaitBackgroundTasksResult,
  BackgroundTaskListOptions,
  CreateThreadInput,
  EventsOptions,
  ForkThreadInput,
  InjectHistoryInput,
  InjectHistoryResult,
  InterruptTurnInput,
  McpCallResult,
  McpResourceContents,
  McpTool,
  PlanConfigChangeInput,
  RespondInput,
  RespondResult,
  ResumeThreadInput,
  RollbackThreadInput,
  StartTurnInput,
  StartTurnResult,
  StopBackgroundTaskInput,
  StopSubagentInput,
  UploadFeedbackInput,
  UploadFeedbackResult,
} from "../generated/session.ts";
import type { SubagentOutcome } from "../generated/subagent.ts";
import type { SessionHandle, Thread, ThreadSnapshot } from "../generated/thread.ts";
import type { LimitStatus, ResetCreditOutcome, UsageRecord } from "../generated/usage.ts";
import type { CreateInstanceRequest, Driver, HostServices, Instance, Session, SpawnedProcess } from "../runtime.ts";
import { Context, Effect, Layer, Stream } from "./effect-modules.ts";
import { toTaggedError } from "./errors.ts";
import type { AriCallError } from "./errors.ts";

/** An ARI call as an Effect: it fails with a tagged call error. */
export type AriEffect<A> = EffectType.Effect<A, AriCallError>;
/** An ARI stream as an Effect `Stream`: it fails with a tagged call error. */
export type AriStream<A> = StreamType.Stream<A, AriCallError>;

// ---------------------------------------------------------------------------
// Turning plain calls into Effects and Streams

function failWith(error: unknown): AriEffect<never> {
  const tagged = toTaggedError(error);
  return tagged === undefined ? Effect.die(error) : Effect.fail(tagged);
}

/** Runs `run` each time the Effect runs; a rejection becomes its tagged error, or a defect. */
function fromPromise<A>(run: () => PromiseLike<A>): AriEffect<A> {
  return Effect.flatten(
    Effect.promise(() =>
      Promise.resolve()
        .then(run)
        .then(
          (value): AriEffect<A> => Effect.succeed(value),
          (error: unknown) => failWith(error),
        ),
    ),
  );
}

/** Runs the synchronous `run` each time the Effect runs; a throw becomes its tagged error, or a defect. */
function fromSync<A>(run: () => A): AriEffect<A> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(run());
    } catch (error) {
      return failWith(error);
    }
  });
}

/** Calls `open` each time the Stream runs and reads the iterable it returns. */
function fromIterable<A>(open: () => AsyncIterable<A>): AriStream<A> {
  return Stream.suspend(() => {
    let iterable: AsyncIterable<A>;
    try {
      iterable = open();
    } catch (error) {
      const tagged = toTaggedError(error);
      return tagged === undefined ? Stream.die(error) : Stream.fail(tagged);
    }
    return Stream.fromAsyncIterable(iterable, (error) => error).pipe(
      Stream.catch((error: unknown) => {
        const tagged = toTaggedError(error);
        return tagged === undefined ? Stream.die(error) : Stream.fail(tagged);
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// Session

/** `Session` with Effects and Streams. */
export interface EffectSession {
  readonly id: string;
  /** The plain session this wraps. */
  readonly unwrapped: Session;
  capabilities(): AriEffect<Capabilities>;
  /** The session's events; with `fromSeq`, replays from that number and then continues live. */
  events(options?: EventsOptions): AriStream<AriEvent>;

  createThread(input: CreateThreadInput): AriEffect<AppliedThread>;
  resumeThread(input: ResumeThreadInput): AriEffect<AppliedThread>;
  readSnapshot?(threadId: string): AriEffect<ThreadSnapshot>;
  forkThread?(input: ForkThreadInput): AriEffect<Thread>;
  rollbackThread?(input: RollbackThreadInput): AriEffect<ThreadSnapshot>;
  compactThread?(threadId: string): AriEffect<void>;
  injectHistory?(input: InjectHistoryInput): AriEffect<InjectHistoryResult>;
  unloadThread?(threadId: string): AriEffect<void>;

  canRelease(): AriEffect<boolean>;
  release(): AriEffect<void>;

  startTurn(input: StartTurnInput): AriEffect<StartTurnResult>;
  interruptTurn(input: InterruptTurnInput): AriEffect<void>;
  /** Answers a request. Idempotent by `(requestId, responseKey)`. */
  respond(input: RespondInput): AriEffect<RespondResult | void>;

  backgroundTasks?: {
    list(threadId: string, options?: BackgroundTaskListOptions): AriEffect<TaskInfo[]>;
    stop(input: StopBackgroundTaskInput): AriEffect<void>;
    await(input: AwaitBackgroundTasksInput): AriEffect<AwaitBackgroundTasksResult>;
  };
  stopSubagent?(input: StopSubagentInput): AriEffect<SubagentOutcome | void>;

  mcpApps?: {
    listTools(threadId: string, server: string): AriEffect<McpTool[]>;
    callTool(threadId: string, server: string, tool: string, args: { [key: string]: unknown }): AriEffect<McpCallResult>;
    readResource(threadId: string, server: string, uri: string): AriEffect<McpResourceContents>;
  };

  planConfigChange(input: PlanConfigChangeInput): AriEffect<ConfigChangePlan>;
  contextWindow?(model: string, cwd?: string): AriEffect<number | undefined>;
  canReuseContextUsage?(previousModel: string, nextModel: string): AriEffect<boolean>;

  uploadFeedback?(input: UploadFeedbackInput): AriEffect<UploadFeedbackResult>;
  ext?(ns: string, method: string, params: unknown): AriEffect<unknown>;
  close(): AriEffect<void>;
}

/** Wraps a plain `Session`; see the notes at the top of this file. */
export function toEffectSession(session: Session): EffectSession {
  const effectSession: EffectSession = {
    id: session.id,
    unwrapped: session,
    capabilities: () => fromSync(() => session.capabilities()),
    events: (options) => fromIterable(() => session.events(options)),
    createThread: (input) => fromPromise(() => session.createThread(input)),
    resumeThread: (input) => fromPromise(() => session.resumeThread(input)),
    canRelease: () => fromSync(() => session.canRelease()),
    release: () => fromPromise(() => session.release()),
    startTurn: (input) => fromPromise(() => session.startTurn(input)),
    interruptTurn: (input) => fromPromise(() => session.interruptTurn(input)),
    respond: (input) => fromPromise(() => session.respond(input)),
    planConfigChange: (input) => fromPromise(() => session.planConfigChange(input)),
    close: () => fromPromise(() => session.close()),
  };
  if (session.readSnapshot) effectSession.readSnapshot = (threadId) => fromPromise(() => session.readSnapshot!(threadId));
  if (session.forkThread) effectSession.forkThread = (input) => fromPromise(() => session.forkThread!(input));
  if (session.rollbackThread) effectSession.rollbackThread = (input) => fromPromise(() => session.rollbackThread!(input));
  if (session.compactThread) effectSession.compactThread = (threadId) => fromPromise(() => session.compactThread!(threadId));
  if (session.injectHistory) effectSession.injectHistory = (input) => fromPromise(() => session.injectHistory!(input));
  if (session.unloadThread) effectSession.unloadThread = (threadId) => fromPromise(() => session.unloadThread!(threadId));
  const backgroundTasks = session.backgroundTasks;
  if (backgroundTasks) {
    effectSession.backgroundTasks = {
      list: (threadId, options) => fromPromise(() => backgroundTasks.list(threadId, options)),
      stop: (input) => fromPromise(() => backgroundTasks.stop(input)),
      await: (input) => fromPromise(() => backgroundTasks.await(input)),
    };
  }
  if (session.stopSubagent) effectSession.stopSubagent = (input) => fromPromise(() => session.stopSubagent!(input));
  const mcpApps = session.mcpApps;
  if (mcpApps) {
    effectSession.mcpApps = {
      listTools: (threadId, server) => fromPromise(() => mcpApps.listTools(threadId, server)),
      callTool: (threadId, server, tool, args) => fromPromise(() => mcpApps.callTool(threadId, server, tool, args)),
      readResource: (threadId, server, uri) => fromPromise(() => mcpApps.readResource(threadId, server, uri)),
    };
  }
  if (session.contextWindow) effectSession.contextWindow = (model, cwd) => fromSync(() => session.contextWindow!(model, cwd));
  if (session.canReuseContextUsage) {
    effectSession.canReuseContextUsage = (previousModel, nextModel) => fromSync(() => session.canReuseContextUsage!(previousModel, nextModel));
  }
  if (session.uploadFeedback) effectSession.uploadFeedback = (input) => fromPromise(() => session.uploadFeedback!(input));
  if (session.ext) effectSession.ext = (ns, method, params) => fromPromise(() => session.ext!(ns, method, params));
  return effectSession;
}

// ---------------------------------------------------------------------------
// Instance

/** `Instance` with Effects and Streams. */
export interface EffectInstance {
  readonly id: string;
  readonly continuationKey: string;
  readonly bindingKey: string;
  /** The plain instance this wraps. */
  readonly unwrapped: Instance;

  status(): AriEffect<InstanceStatus>;
  statusChanges(): AriStream<InstanceStatus>;
  /** A health check. It must have no side effects. */
  probe(options?: ProbeOptions): AriEffect<ProbeResult>;
  invalidateCaches?(): AriEffect<void>;

  maintenance?: {
    advisory(): AriEffect<UpdateAdvisory | null>;
    install?(): AriEffect<void>;
    update?(): AriEffect<void>;
  };

  auth?: {
    methods(): AriEffect<AuthMethod[]>;
    state(): AriEffect<AuthState>;
    reportRuntimeFailure?(failure: RuntimeFailureReport): AriEffect<AuthState>;
    start(input: AuthStartInput): AriEffect<AuthFlow>;
    complete(input: AuthCompleteInput): AriEffect<AuthState>;
    respond?(input: AuthRespondInput): AriEffect<AuthState>;
    cancel(flowId: string): AriEffect<AuthState>;
    logout?(): AriEffect<void>;
    transferProfile?(profile: TransferredProfile): AriEffect<AuthState>;
    /** Moves a session to `target`, which may be a plain or an Effect-shaped instance. */
    transferSession?(handle: SessionHandle, target: Instance | EffectInstance): AriEffect<SessionHandle>;
    readonly credentialBinding?: CredentialBinding;
  };

  catalog: {
    list(options?: CatalogListOptions): AriEffect<ModelCatalog>;
    refresh?(): AriEffect<void>;
  };

  workspace?: {
    snapshot(cwd: string): AriEffect<WorkspaceSnapshot>;
  };

  limits?: {
    current(): AriEffect<LimitStatus>;
    accountKey(): AriEffect<string>;
    consumeResetCredit?(input: ConsumeResetCreditInput): AriEffect<ResetCreditOutcome>;
  };

  usageHistory?: {
    scan(range: UsageRange): AriStream<UsageRecord>;
  };

  textGeneration?: {
    readonly guarantees: TextGenerationGuarantees;
    generate(request: TextGenerationRequest): AriEffect<unknown>;
  };

  nativeSessions?: {
    list(input: NativeSessionListInput): AriEffect<NativeSessionInfoPage>;
    delete?(id: string): AriEffect<void>;
    archive?(id: string): AriEffect<void>;
  };

  subProviders?: {
    list(cwd: string): AriEffect<SubProvider[]>;
    set(input: SubProviderSetInput): AriEffect<void>;
    disable(input: SubProviderDisableInput): AriEffect<void>;
  };

  openSession(input: OpenSessionInput): AriEffect<EffectSession>;
  dispose(): AriEffect<void>;
}

function plainInstance(target: Instance | EffectInstance): Instance {
  return "unwrapped" in target ? target.unwrapped : target;
}

/** Wraps a plain `Instance`; see the notes at the top of this file. */
export function toEffectInstance(instance: Instance): EffectInstance {
  const effectInstance: EffectInstance = {
    id: instance.id,
    continuationKey: instance.continuationKey,
    bindingKey: instance.bindingKey,
    unwrapped: instance,
    status: () => fromPromise(() => instance.status()),
    statusChanges: () => fromIterable(() => instance.statusChanges()),
    probe: (options) => fromPromise(() => instance.probe(options)),
    catalog: { list: (options) => fromPromise(() => instance.catalog.list(options)) },
    openSession: (input) => Effect.map(fromPromise(() => instance.openSession(input)), toEffectSession),
    dispose: () => fromPromise(() => instance.dispose()),
  };
  if (instance.invalidateCaches) effectInstance.invalidateCaches = () => fromPromise(() => instance.invalidateCaches!());
  const catalog = instance.catalog;
  if (catalog.refresh) effectInstance.catalog.refresh = () => fromPromise(() => catalog.refresh!());

  const maintenance = instance.maintenance;
  if (maintenance) {
    effectInstance.maintenance = { advisory: () => fromPromise(() => maintenance.advisory()) };
    if (maintenance.install) effectInstance.maintenance.install = () => fromPromise(() => maintenance.install!());
    if (maintenance.update) effectInstance.maintenance.update = () => fromPromise(() => maintenance.update!());
  }

  const auth = instance.auth;
  if (auth) {
    const effectAuth: NonNullable<EffectInstance["auth"]> = {
      methods: () => fromSync(() => auth.methods()),
      state: () => fromPromise(() => auth.state()),
      start: (input) => fromPromise(() => auth.start(input)),
      complete: (input) => fromPromise(() => auth.complete(input)),
      cancel: (flowId) => fromPromise(() => auth.cancel(flowId)),
      ...(auth.credentialBinding === undefined ? {} : { credentialBinding: auth.credentialBinding }),
    };
    if (auth.reportRuntimeFailure) effectAuth.reportRuntimeFailure = (failure) => fromPromise(() => auth.reportRuntimeFailure!(failure));
    if (auth.respond) effectAuth.respond = (input) => fromPromise(() => auth.respond!(input));
    if (auth.logout) effectAuth.logout = () => fromPromise(() => auth.logout!());
    if (auth.transferProfile) effectAuth.transferProfile = (profile) => fromPromise(() => auth.transferProfile!(profile));
    if (auth.transferSession) {
      effectAuth.transferSession = (handle, target) => fromPromise(() => auth.transferSession!(handle, plainInstance(target)));
    }
    effectInstance.auth = effectAuth;
  }

  const workspace = instance.workspace;
  if (workspace) effectInstance.workspace = { snapshot: (cwd) => fromPromise(() => workspace.snapshot(cwd)) };

  const limits = instance.limits;
  if (limits) {
    effectInstance.limits = {
      current: () => fromPromise(() => limits.current()),
      accountKey: () => fromSync(() => limits.accountKey()),
    };
    if (limits.consumeResetCredit) effectInstance.limits.consumeResetCredit = (input) => fromPromise(() => limits.consumeResetCredit!(input));
  }

  const usageHistory = instance.usageHistory;
  if (usageHistory) effectInstance.usageHistory = { scan: (range) => fromIterable(() => usageHistory.scan(range)) };

  const textGeneration = instance.textGeneration;
  if (textGeneration) {
    effectInstance.textGeneration = {
      guarantees: textGeneration.guarantees,
      generate: (request) => fromPromise(() => textGeneration.generate(request)),
    };
  }

  const nativeSessions = instance.nativeSessions;
  if (nativeSessions) {
    effectInstance.nativeSessions = { list: (input) => fromPromise(() => nativeSessions.list(input)) };
    if (nativeSessions.delete) effectInstance.nativeSessions.delete = (id) => fromPromise(() => nativeSessions.delete!(id));
    if (nativeSessions.archive) effectInstance.nativeSessions.archive = (id) => fromPromise(() => nativeSessions.archive!(id));
  }

  const subProviders = instance.subProviders;
  if (subProviders) {
    effectInstance.subProviders = {
      list: (cwd) => fromPromise(() => subProviders.list(cwd)),
      set: (input) => fromPromise(() => subProviders.set(input)),
      disable: (input) => fromPromise(() => subProviders.disable(input)),
    };
  }
  return effectInstance;
}

// ---------------------------------------------------------------------------
// Driver

/** `Driver` with Effects. `create` still takes plain host services, which is what drivers use. */
export interface EffectDriver<Config = ConfigValues> {
  readonly kind: string;
  readonly ariVersion: string;
  readonly metadata: DriverMetadata;
  readonly configSchema: JsonSchema;
  readonly cliManifest?: CliLaunchManifest;
  /** The plain driver this wraps. */
  readonly unwrapped: Driver<Config>;
  defaultConfig(): AriEffect<Config>;
  create(host: HostServices<Config>, input: CreateInstanceRequest<Config>): AriEffect<EffectInstance>;
}

/** Wraps a plain `Driver`; see the notes at the top of this file. */
export function toEffectDriver<Config = ConfigValues>(driver: Driver<Config>): EffectDriver<Config> {
  return {
    kind: driver.kind,
    ariVersion: driver.ariVersion,
    metadata: driver.metadata,
    configSchema: driver.configSchema,
    ...(driver.cliManifest === undefined ? {} : { cliManifest: driver.cliManifest }),
    unwrapped: driver,
    defaultConfig: () => fromSync(() => driver.defaultConfig()),
    create: (host, input) => Effect.map(fromPromise(() => driver.create(host, input)), toEffectInstance),
  };
}

// ---------------------------------------------------------------------------
// HostServices

/** A spawned child process with Effects and Streams. */
export interface EffectSpawnedProcess {
  readonly pid?: number;
  /** The plain process this wraps. */
  readonly unwrapped: SpawnedProcess;
  readonly stdout: AriStream<Uint8Array>;
  readonly stderr: AriStream<Uint8Array>;
  write(data: Uint8Array | string): AriEffect<void>;
  closeStdin(): AriEffect<void>;
  kill(signal?: string): AriEffect<void>;
  /** Waits for the child to exit. */
  readonly exited: AriEffect<ProcessExit>;
}

function toEffectSpawnedProcess(child: SpawnedProcess): EffectSpawnedProcess {
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    unwrapped: child,
    stdout: fromIterable(() => child.stdout),
    stderr: fromIterable(() => child.stderr),
    write: (data) => fromPromise(() => child.write(data)),
    closeStdin: () => fromPromise(() => child.closeStdin()),
    kill: (signal) => fromPromise(() => child.kill(signal)),
    exited: fromPromise(() => child.exited),
  };
}

/** `HostServices` with Effects and Streams, for drivers written with Effect. */
export interface EffectHostServices<Config = ConfigValues> {
  /** The plain host services this wraps. */
  readonly unwrapped: HostServices<Config>;
  readonly paths: {
    readonly stateDir: string;
    readonly cacheDir: string;
    readonly tmpDir: string;
  };
  config: {
    /** The instance's own decoded config; with `watch: true`, also a stream of later values. */
    get(options?: { watch?: boolean }): AriEffect<{ config: Config; changes?: AriStream<Config> }>;
  };
  secrets: {
    get(namespace: string, key: string): AriEffect<Uint8Array | null>;
    set(namespace: string, key: string, value: Uint8Array): AriEffect<void>;
    delete(namespace: string, key: string): AriEffect<void>;
  };
  process: {
    readonly envPolicy: EnvPolicy;
    spawn(request: SpawnRequest): AriEffect<EffectSpawnedProcess>;
    resolveExecutable(name: string, options?: { path?: string }): AriEffect<string | null>;
  };
  attachments: {
    resolve(ref: string): AriEffect<AttachmentInfo | null>;
    extractText?(ref: string): AriEffect<string | null>;
  };
  callbacks: {
    register(flowId: string): AriEffect<CallbackRegistration>;
  };
  hostTools: {
    mcpServerFor(threadId: string, options: McpServerForOptions): AriEffect<HostToolServer>;
    callDynamicTool?(call: DynamicToolCall): AriEffect<DynamicToolResult>;
  };
  background: {
    shouldRun(scope: string): AriEffect<boolean>;
  };
  coordination: {
    acquire(key: string, ttlMs: number): AriEffect<Lease | null>;
    release(leaseId: string): AriEffect<void>;
  };
  diagnostics: {
    log(entry: DiagnosticEntry): AriEffect<void>;
  };
  telemetry?: {
    track(name: string, props?: { [key: string]: string | number | boolean | null }): AriEffect<void>;
  };
  ids?: {
    derive(kind: string, key: string): AriEffect<string>;
  };
}

/** Wraps plain `HostServices`; see the notes at the top of this file. */
export function toEffectHostServices<Config = ConfigValues>(host: HostServices<Config>): EffectHostServices<Config> {
  const effectHost: EffectHostServices<Config> = {
    unwrapped: host,
    paths: { stateDir: host.paths.stateDir, cacheDir: host.paths.cacheDir, tmpDir: host.paths.tmpDir },
    config: {
      get: (options) =>
        Effect.map(
          fromPromise(() => host.config.get(options)),
          (reading) => {
            const changes = reading.changes;
            return changes === undefined ? { config: reading.config } : { config: reading.config, changes: fromIterable(() => changes) };
          },
        ),
    },
    secrets: {
      get: (namespace, key) => fromPromise(() => host.secrets.get(namespace, key)),
      set: (namespace, key, value) => fromPromise(() => host.secrets.set(namespace, key, value)),
      delete: (namespace, key) => fromPromise(() => host.secrets.delete(namespace, key)),
    },
    process: {
      envPolicy: host.process.envPolicy,
      spawn: (request) => Effect.map(fromPromise(() => host.process.spawn(request)), toEffectSpawnedProcess),
      resolveExecutable: (name, options) => fromPromise(() => host.process.resolveExecutable(name, options)),
    },
    attachments: { resolve: (ref) => fromPromise(() => host.attachments.resolve(ref)) },
    callbacks: { register: (flowId) => fromPromise(() => host.callbacks.register(flowId)) },
    hostTools: { mcpServerFor: (threadId, options) => fromPromise(() => host.hostTools.mcpServerFor(threadId, options)) },
    background: { shouldRun: (scope) => fromPromise(() => host.background.shouldRun(scope)) },
    coordination: {
      acquire: (key, ttlMs) => fromPromise(() => host.coordination.acquire(key, ttlMs)),
      release: (leaseId) => fromPromise(() => host.coordination.release(leaseId)),
    },
    diagnostics: { log: (entry) => fromSync(() => host.diagnostics.log(entry)) },
  };
  const { attachments, hostTools, telemetry, ids } = host;
  if (attachments.extractText) effectHost.attachments.extractText = (ref) => fromPromise(() => attachments.extractText!(ref));
  if (hostTools.callDynamicTool) effectHost.hostTools.callDynamicTool = (call) => fromPromise(() => hostTools.callDynamicTool!(call));
  if (telemetry) effectHost.telemetry = { track: (name, props) => fromSync(() => telemetry.track(name, props)) };
  if (ids) effectHost.ids = { derive: (kind, key) => fromPromise(() => ids.derive(kind, key)) };
  return effectHost;
}

// ---------------------------------------------------------------------------
// Context services and layers

/** The driver an Effect program uses. */
export class AriDriver extends Context.Service<AriDriver, EffectDriver>()("ari/effect/AriDriver") {
  /** Provides a plain driver as this service. */
  static layer(driver: Driver): LayerType.Layer<AriDriver> {
    return Layer.succeed(AriDriver, toEffectDriver(driver));
  }
}

/** The instance an Effect program uses. */
export class AriInstance extends Context.Service<AriInstance, EffectInstance>()("ari/effect/AriInstance") {
  /** Provides an existing plain instance as this service. Whoever made it disposes it. */
  static layer(instance: Instance): LayerType.Layer<AriInstance> {
    return Layer.succeed(AriInstance, toEffectInstance(instance));
  }

  /**
   * Creates an instance with the `AriDriver` service and disposes it when the
   * layer is released. A failing `dispose()` is ignored: the layer is being
   * torn down either way.
   */
  static create(host: HostServices, request: CreateInstanceRequest<ConfigValues>): LayerType.Layer<AriInstance, AriCallError, AriDriver> {
    return Layer.effect(
      AriInstance,
      Effect.acquireRelease(
        Effect.flatMap(Effect.service(AriDriver), (driver) => driver.create(host, request)),
        (instance) => Effect.ignore(instance.dispose()),
      ),
    );
  }
}

/** The session an Effect program uses. */
export class AriSession extends Context.Service<AriSession, EffectSession>()("ari/effect/AriSession") {
  /** Provides an existing plain session as this service. Whoever opened it closes it. */
  static layer(session: Session): LayerType.Layer<AriSession> {
    return Layer.succeed(AriSession, toEffectSession(session));
  }

  /**
   * Opens a session with the `AriInstance` service and closes it when the
   * layer is released. A failing `close()` is ignored, as for `AriInstance.create`.
   */
  static open(input: OpenSessionInput): LayerType.Layer<AriSession, AriCallError, AriInstance> {
    return Layer.effect(
      AriSession,
      Effect.acquireRelease(
        Effect.flatMap(Effect.service(AriInstance), (instance) => instance.openSession(input)),
        (session) => Effect.ignore(session.close()),
      ),
    );
  }
}

/** The host services an Effect-written driver uses. */
export class AriHostServices extends Context.Service<AriHostServices, EffectHostServices>()("ari/effect/AriHostServices") {
  /** Provides plain host services as this service. */
  static layer(host: HostServices): LayerType.Layer<AriHostServices> {
    return Layer.succeed(AriHostServices, toEffectHostServices(host));
  }
}
