// The runtime API: the hand-written `Driver`, `Instance`, `Session` and
// `HostServices` interfaces (proposal §6, §9 and §10). Methods and
// `AsyncIterable` streams are not wire data, so these live in TypeScript; every
// member is listed in spec/v1/methods.json, and a committed test checks the two
// against each other. All data types come from the generated schema types.
//
// Optional members (`?`) are gated by capabilities or simply absent; a driver
// that lacks a feature leaves the member out or rejects with `unsupported`.
// `resumeThread` is required: every driver can resume a stored thread or
// reject with a resume failure.

import type { TaskInfo } from "./generated/background.ts";
import type { Capabilities } from "./generated/capabilities.ts";
import type { AttachmentInfo, ConfigValues, JsonSchema } from "./generated/common.ts";
import type { ConfigChangePlan } from "./generated/config.ts";
import type { CliLaunchManifest, DriverMetadata } from "./generated/driver.ts";
import type { AriEvent } from "./generated/events.ts";
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
  ResolveExecutableInput,
  SpawnRequest,
} from "./generated/host.ts";
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
} from "./generated/instance.ts";
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
} from "./generated/session.ts";
import type { SubagentOutcome } from "./generated/subagent.ts";
import type { SessionHandle, Thread, ThreadSnapshot } from "./generated/thread.ts";
import type { LimitStatus, ResetCreditOutcome, UsageRecord } from "./generated/usage.ts";

/** One live provider process or connection: threads, turns, requests and its event stream. */
export interface Session {
  readonly id: string;
  capabilities(): Capabilities;
  /** The session's events; with `fromSeq`, replays from that number and then continues live. */
  events(options?: EventsOptions): AsyncIterable<AriEvent>;

  createThread(input: CreateThreadInput): Promise<AppliedThread>;
  resumeThread(input: ResumeThreadInput): Promise<AppliedThread>;
  readSnapshot?(threadId: string): Promise<ThreadSnapshot>;
  forkThread?(input: ForkThreadInput): Promise<Thread>;
  rollbackThread?(input: RollbackThreadInput): Promise<ThreadSnapshot>;
  compactThread?(threadId: string): Promise<void>;
  injectHistory?(input: InjectHistoryInput): Promise<InjectHistoryResult>;
  unloadThread?(threadId: string): Promise<void>;

  /** False while background tasks, pending requests or unpersisted state would be lost by `release()`. */
  canRelease(): boolean;
  /** Parks the runtime without destroying threads or killing background work. */
  release(): Promise<void>;

  startTurn(input: StartTurnInput): Promise<StartTurnResult>;
  interruptTurn(input: InterruptTurnInput): Promise<void>;
  /** Answers a request. Idempotent by `(requestId, responseKey)`. */
  respond(input: RespondInput): Promise<RespondResult | void>;

  backgroundTasks?: {
    list(threadId: string, options?: BackgroundTaskListOptions): Promise<TaskInfo[]>;
    stop(input: StopBackgroundTaskInput): Promise<void>;
    await(input: AwaitBackgroundTasksInput): Promise<AwaitBackgroundTasksResult>;
  };
  stopSubagent?(input: StopSubagentInput): Promise<SubagentOutcome | void>;

  mcpApps?: {
    listTools(threadId: string, server: string): Promise<McpTool[]>;
    callTool(threadId: string, server: string, tool: string, args: { [key: string]: unknown }): Promise<McpCallResult>;
    readResource(threadId: string, server: string, uri: string): Promise<McpResourceContents>;
  };

  /** Says how a config change would take effect, without applying it. */
  planConfigChange(input: PlanConfigChangeInput): Promise<ConfigChangePlan>;
  contextWindow?(model: string, cwd?: string): number | undefined;
  canReuseContextUsage?(previousModel: string, nextModel: string): boolean;

  uploadFeedback?(input: UploadFeedbackInput): Promise<UploadFeedbackResult>;
  /** Calls a named extension listed in `capabilities().extensions`. */
  ext?(ns: string, method: string, params: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** One configured account of a driver: whether its runtime is there, sign-in, catalog, limits and sessions. */
export interface Instance {
  readonly id: string;
  /** Instances with equal keys can continue each other's threads. */
  readonly continuationKey: string;
  /** Opaque, non-secret fingerprint of account plus launch config, for host pooling and recovery. */
  readonly bindingKey: string;

  status(): Promise<InstanceStatus>;
  statusChanges(): AsyncIterable<InstanceStatus>;
  /** A health check. It must have no side effects. */
  probe(options?: ProbeOptions): Promise<ProbeResult>;
  invalidateCaches?(): Promise<void>;

  /** Version advice only: ARI installs and updates nothing; the user or the host does. */
  maintenance?: {
    advisory(): Promise<UpdateAdvisory | null>;
  };

  auth?: {
    methods(): AuthMethod[];
    state(): Promise<AuthState>;
    /** Sets a short-lived runtime auth poison after a live auth failure. */
    reportRuntimeFailure?(failure: RuntimeFailureReport): Promise<AuthState>;
    start(input: AuthStartInput): Promise<AuthFlow>;
    complete(input: AuthCompleteInput): Promise<AuthState>;
    respond?(input: AuthRespondInput): Promise<AuthState>;
    cancel(flowId: string): Promise<AuthState>;
    logout?(): Promise<void>;
    transferProfile?(profile: TransferredProfile): Promise<AuthState>;
    transferSession?(handle: SessionHandle, target: Instance): Promise<SessionHandle>;
    readonly credentialBinding?: CredentialBinding;
  };

  catalog: {
    list(options?: CatalogListOptions): Promise<ModelCatalog>;
    refresh?(): Promise<void>;
  };

  workspace?: {
    snapshot(cwd: string): Promise<WorkspaceSnapshot>;
  };

  limits?: {
    current(): Promise<LimitStatus>;
    /** The host serializes reset-credit redemptions per account key. */
    accountKey(): string;
    consumeResetCredit?(input: ConsumeResetCreditInput): Promise<ResetCreditOutcome>;
  };

  usageHistory?: {
    scan(range: UsageRange): AsyncIterable<UsageRecord>;
  };

  textGeneration?: {
    readonly guarantees: TextGenerationGuarantees;
    generate(request: TextGenerationRequest): Promise<unknown>;
  };

  nativeSessions?: {
    list(input: NativeSessionListInput): Promise<NativeSessionInfoPage>;
    delete?(id: string): Promise<void>;
    archive?(id: string): Promise<void>;
  };

  subProviders?: {
    list(cwd: string): Promise<SubProvider[]>;
    set(input: SubProviderSetInput): Promise<void>;
    disable(input: SubProviderDisableInput): Promise<void>;
  };

  openSession(input: OpenSessionInput): Promise<Session>;
  dispose(): Promise<void>;
}

/** What `Driver.create` receives besides the host services. */
export interface CreateInstanceRequest<Config> {
  instanceId: string;
  config: Config;
  displayName?: string;
  environment: { [name: string]: string };
}

/** A driver: metadata, its config schema and a factory for instances. Any object with this shape works. */
export interface Driver<Config = ConfigValues> {
  readonly kind: string;
  readonly ariVersion: string;
  readonly metadata: DriverMetadata;
  readonly configSchema: JsonSchema;
  defaultConfig(): Config;
  readonly cliManifest?: CliLaunchManifest;
  create(host: HostServices<Config>, input: CreateInstanceRequest<Config>): Promise<Instance>;
}

/** The instance's current config and, when watched, its later values. */
export interface ConfigReading<Config> {
  config: Config;
  changes?: AsyncIterable<Config>;
}

/**
 * A child process the host spawned. Output streams end when the child closes
 * them; `exited` settles when it exits.
 */
export interface SpawnedProcess {
  readonly pid?: number;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  write(data: Uint8Array | string): Promise<void>;
  closeStdin(): Promise<void>;
  kill(signal?: string): Promise<void>;
  readonly exited: Promise<ProcessExit>;
}

/**
 * Everything a driver may rely on from its host. A driver sees only its own
 * instance's config and namespaced services, never host-wide settings. No
 * member takes a callback, so every operation can cross `ari/wire`.
 */
export interface HostServices<Config = ConfigValues> {
  readonly paths: {
    readonly stateDir: string;
    readonly cacheDir: string;
    readonly tmpDir: string;
  };
  config: {
    /** The instance's own decoded config; with `watch: true`, also a stream of later values. */
    get(options?: { watch?: boolean }): Promise<ConfigReading<Config>>;
  };
  secrets: {
    get(namespace: string, key: string): Promise<Uint8Array | null>;
    set(namespace: string, key: string, value: Uint8Array): Promise<void>;
    delete(namespace: string, key: string): Promise<void>;
  };
  process: {
    /** Ambient environment variables removed before every spawn. */
    readonly envPolicy: EnvPolicy;
    spawn(request: SpawnRequest): Promise<SpawnedProcess>;
    /** Search as for a spawn with `env`, or use an explicit `path` when `env` is absent. */
    resolveExecutable(name: string, options?: Omit<ResolveExecutableInput, "name">): Promise<string | null>;
  };
  attachments: {
    /** Null when the bytes cannot be had; the driver must then tell the agent. */
    resolve(ref: string): Promise<AttachmentInfo | null>;
    extractText?(ref: string): Promise<string | null>;
  };
  callbacks: {
    /** A URL for a sign-in callback; the host routes it to `instance.auth.complete`. */
    register(flowId: string): Promise<CallbackRegistration>;
  };
  hostTools: {
    /** The host's MCP server for a thread. Use its `name` exactly. */
    mcpServerFor(threadId: string, options: McpServerForOptions): Promise<HostToolServer>;
    callDynamicTool?(call: DynamicToolCall): Promise<DynamicToolResult>;
  };
  background: {
    shouldRun(scope: string): Promise<boolean>;
  };
  coordination: {
    /** An exclusive lease on `key` until released or `ttlMs` passes; null while someone else holds it. */
    acquire(key: string, ttlMs: number): Promise<Lease | null>;
    release(leaseId: string): Promise<void>;
  };
  diagnostics: {
    log(entry: DiagnosticEntry): void;
  };
  telemetry?: {
    track(name: string, props?: { [key: string]: string | number | boolean | null }): void;
  };
  ids?: {
    derive(kind: string, key: string): Promise<string>;
  };
}
