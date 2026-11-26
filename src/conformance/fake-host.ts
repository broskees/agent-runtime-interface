// The fake host: a complete in-memory `HostServices` that records every
// host-service call a driver makes. Scenarios read the record to check, for
// example, that `probe()` made no mutating call, or that an inherited
// credential never reached a spawned process.
//
// Everything is in memory except process spawning and executable lookup,
// which the harness supplies (`spawn`, `resolveExecutable`): the kit is
// browser-safe and cannot start processes itself. A harness whose native
// agent is a child process passes a `spawn` that starts it; one whose agent
// is in memory passes a `spawn` that connects to it.
//
// Spawning applies the host's environment rule. The child's environment is
// `ambientEnvironment` minus every `envPolicy.stripAmbient` entry (a name, or a
// prefix when it ends in `*`), plus the request's own `env` additions. The
// harness's `spawn` receives that environment as `environment` and must give
// the child exactly that. When the options leave `envPolicy` out, the host
// strips the prefixes the driver's CLI manifest declares
// (`cliManifest.envScrubPrefixes`), as a host that honours the manifest does.

import { callErrors } from "../errors.ts";
import type { AttachmentInfo, ConfigValues } from "../generated/common.ts";
import type {
  CallbackRegistration,
  DiagnosticEntry,
  DynamicToolCall,
  DynamicToolResult,
  EnvPolicy,
  HostPaths,
  HostToolServer,
  Lease,
  McpServerForOptions,
  SpawnRequest,
} from "../generated/host.ts";
import { sha256Hex } from "../driver-kit/sha256.ts";
import type { ConfigReading, HostServices, SpawnedProcess } from "../runtime.ts";
import { AsyncQueue } from "./util.ts";

/** The 17 host-service operations, by the names `methods.json` and the conformance report use. */
export const HOST_OPERATIONS = [
  "config.get",
  "secrets.get",
  "secrets.set",
  "secrets.delete",
  "process.spawn",
  "process.resolveExecutable",
  "attachments.resolve",
  "attachments.extractText",
  "callbacks.register",
  "hostTools.mcpServerFor",
  "hostTools.callDynamicTool",
  "background.shouldRun",
  "coordination.acquire",
  "coordination.release",
  "diagnostics.log",
  "telemetry.track",
  "ids.derive",
] as const;

export type HostOperation = (typeof HOST_OPERATIONS)[number];

/** One host-service call, in the order the driver made it. */
export interface HostCall {
  /** Position in the host's call record, from 0. */
  readonly index: number;
  readonly operation: HostOperation;
  readonly args: readonly unknown[];
}

/** A spawn request as the harness's `spawn` receives it: the driver's request plus the child's whole environment. */
export interface FakeSpawnRequest extends SpawnRequest {
  /** The complete environment the child must get: ambient minus `envPolicy.stripAmbient`, plus the request's `env`. */
  readonly environment: { readonly [name: string]: string };
}

export interface FakeHostOptions<Config = ConfigValues> {
  /** The instance's own config, as `config.get` returns it. */
  readonly config?: Config;
  /** Defaults to virtual paths under `/ari-conformance/<label>/`. */
  readonly paths?: HostPaths;
  readonly envPolicy?: EnvPolicy;
  /** The prefixes to strip when `envPolicy` is left out, normally the driver's `cliManifest.envScrubPrefixes`. */
  readonly envScrubPrefixes?: readonly string[];
  /** The environment a spawned child inherits before stripping. */
  readonly ambientEnvironment?: { readonly [name: string]: string };
  /** Starts a process. Without it, every spawn rejects with `not_found`. */
  readonly spawn?: (request: FakeSpawnRequest) => Promise<SpawnedProcess>;
  /** Finds an executable. Without it, every lookup returns null. */
  readonly resolveExecutable?: HostServices["process"]["resolveExecutable"];
  /** Secrets stored before the driver starts. */
  readonly secrets?: ReadonlyArray<{ readonly namespace: string; readonly key: string; readonly value: Uint8Array | string }>;
  /** Readable attachments by reference; any other reference resolves to null. */
  readonly attachments?: { readonly [ref: string]: { readonly info: AttachmentInfo; readonly text?: string } };
  /** The host's MCP server name for a thread. Defaults to `host-tools-<threadId>`. */
  readonly mcpServerName?: (threadId: string, options: McpServerForOptions) => string;
  /** Answers dynamic tool calls. Defaults to a text result `ok`. */
  readonly callDynamicTool?: (call: DynamicToolCall) => Promise<DynamicToolResult>;
  /** The URL prefix of sign-in callbacks. */
  readonly callbackBaseUrl?: string;
  /** What `background.shouldRun` answers. Defaults to true. */
  readonly backgroundAllowed?: boolean;
  /** Names the default virtual paths. */
  readonly label?: string;
}

export interface FakeHost<Config = ConfigValues> extends HostServices<Config> {
  /** Every host-service call so far. */
  readonly calls: readonly HostCall[];
  /** Every spawn so far, with the environment the child got. */
  readonly spawns: readonly FakeSpawnRequest[];
  readonly diagnosticEntries: readonly DiagnosticEntry[];
  readonly telemetryEvents: ReadonlyArray<{ readonly name: string; readonly props?: unknown }>;
  /** The position the next call will take; pass it to `callsSince`. */
  mark(): number;
  callsSince(mark: number): HostCall[];
  /** Changes the config and tells every `config.get({ watch: true })` reader. */
  setConfig(config: Config): void;
  /** The secrets stored now, by namespace and key. */
  storedSecrets(): Array<{ namespace: string; key: string; value: Uint8Array }>;
  /** Ends every config watch. */
  dispose(): void;
}

function checkSecretName(kind: string, value: string): void {
  if (value === "" || value.includes("..") || value.includes("/")) {
    throw callErrors.validation([{ message: `${kind} must be non-empty and contain neither ".." nor "/"`, path: [kind] }]);
  }
}

function stripped(name: string, policy: EnvPolicy): boolean {
  return policy.stripAmbient.some((entry) => (entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry));
}

/** Builds a fake host. Each instance under test gets its own. */
export function createFakeHost<Config = ConfigValues>(options: FakeHostOptions<Config> = {}): FakeHost<Config> {
  const label = options.label ?? "instance";
  const paths: HostPaths = options.paths ?? {
    stateDir: `/ari-conformance/${label}/state`,
    cacheDir: `/ari-conformance/${label}/cache`,
    tmpDir: `/ari-conformance/${label}/tmp`,
  };
  const envPolicy: EnvPolicy = options.envPolicy ?? { stripAmbient: (options.envScrubPrefixes ?? []).map((prefix) => `${prefix}*`) };
  const calls: HostCall[] = [];
  const spawns: FakeSpawnRequest[] = [];
  const diagnosticEntries: DiagnosticEntry[] = [];
  const telemetryEvents: Array<{ name: string; props?: unknown }> = [];
  const secrets = new Map<string, { namespace: string; key: string; value: Uint8Array }>();
  const leases = new Map<string, Lease>();
  const configWatchers = new Set<AsyncQueue<Config>>();
  let config = (options.config ?? {}) as Config;
  let nextLease = 1;

  for (const secret of options.secrets ?? []) {
    const value = typeof secret.value === "string" ? new TextEncoder().encode(secret.value) : secret.value;
    secrets.set(`${secret.namespace}/${secret.key}`, { namespace: secret.namespace, key: secret.key, value: new Uint8Array(value) });
  }

  const record = (operation: HostOperation, ...args: unknown[]): void => {
    calls.push({ index: calls.length, operation, args });
  };

  const host: FakeHost<Config> = {
    paths,
    calls,
    spawns,
    diagnosticEntries,
    telemetryEvents,
    mark: () => calls.length,
    callsSince: (mark) => calls.slice(mark),
    setConfig(next) {
      config = next;
      for (const watcher of configWatchers) watcher.push(next);
    },
    storedSecrets: () => [...secrets.values()].map((entry) => ({ ...entry, value: new Uint8Array(entry.value) })),
    dispose() {
      for (const watcher of configWatchers) watcher.end();
      configWatchers.clear();
    },

    config: {
      async get(getOptions) {
        record("config.get", getOptions);
        if (getOptions?.watch !== true) return { config };
        const changes = new AsyncQueue<Config>();
        configWatchers.add(changes);
        const reading: ConfigReading<Config> = { config, changes };
        return reading;
      },
    },

    secrets: {
      async get(namespace, key) {
        record("secrets.get", namespace, key);
        checkSecretName("namespace", namespace);
        checkSecretName("key", key);
        const entry = secrets.get(`${namespace}/${key}`);
        return entry === undefined ? null : new Uint8Array(entry.value);
      },
      async set(namespace, key, value) {
        record("secrets.set", namespace, key, value);
        checkSecretName("namespace", namespace);
        checkSecretName("key", key);
        secrets.set(`${namespace}/${key}`, { namespace, key, value: new Uint8Array(value) });
      },
      async delete(namespace, key) {
        record("secrets.delete", namespace, key);
        checkSecretName("namespace", namespace);
        checkSecretName("key", key);
        secrets.delete(`${namespace}/${key}`);
      },
    },

    process: {
      envPolicy,
      async spawn(request) {
        record("process.spawn", request);
        const environment: { [name: string]: string } = {};
        for (const [name, value] of Object.entries(options.ambientEnvironment ?? {})) {
          if (!stripped(name, envPolicy)) environment[name] = value;
        }
        Object.assign(environment, request.env ?? {});
        const spawnRequest: FakeSpawnRequest = { ...request, environment };
        spawns.push(spawnRequest);
        if (options.spawn === undefined) throw callErrors.notFound({ resource: "executable", id: request.command });
        return options.spawn(spawnRequest);
      },
      async resolveExecutable(name, resolveOptions) {
        record("process.resolveExecutable", name, resolveOptions);
        return options.resolveExecutable === undefined ? null : options.resolveExecutable(name, resolveOptions);
      },
    },

    attachments: {
      async resolve(ref) {
        record("attachments.resolve", ref);
        return options.attachments?.[ref]?.info ?? null;
      },
      async extractText(ref) {
        record("attachments.extractText", ref);
        return options.attachments?.[ref]?.text ?? null;
      },
    },

    callbacks: {
      async register(flowId): Promise<CallbackRegistration> {
        record("callbacks.register", flowId);
        return { url: `${options.callbackBaseUrl ?? "http://127.0.0.1/ari-conformance/callback/"}${encodeURIComponent(flowId)}` };
      },
    },

    hostTools: {
      async mcpServerFor(threadId, serverOptions): Promise<HostToolServer> {
        record("hostTools.mcpServerFor", threadId, serverOptions);
        const name = options.mcpServerName?.(threadId, serverOptions) ?? `host-tools-${threadId}`;
        if (serverOptions.transport === "stdio") {
          return { name, config: { name, transport: "stdio", command: "ari-conformance-host-tools", args: [threadId] }, alwaysLoad: true };
        }
        return {
          name,
          config: { name, transport: serverOptions.transport, url: `http://127.0.0.1/ari-conformance/mcp/${encodeURIComponent(threadId)}` },
          alwaysLoad: true,
        };
      },
      async callDynamicTool(call) {
        record("hostTools.callDynamicTool", call);
        return options.callDynamicTool === undefined ? { content: [{ type: "text", text: "ok" }] } : options.callDynamicTool(call);
      },
    },

    background: {
      async shouldRun(scope) {
        record("background.shouldRun", scope);
        return options.backgroundAllowed ?? true;
      },
    },

    coordination: {
      async acquire(key, ttlMs) {
        record("coordination.acquire", key, ttlMs);
        const held = leases.get(key);
        if (held !== undefined && Date.parse(held.expiresAt) > Date.now()) return null;
        const lease: Lease = { leaseId: `lease-${nextLease}`, key, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
        nextLease += 1;
        leases.set(key, lease);
        return lease;
      },
      async release(leaseId) {
        record("coordination.release", leaseId);
        for (const [key, lease] of leases) {
          if (lease.leaseId === leaseId) leases.delete(key);
        }
      },
    },

    diagnostics: {
      log(entry) {
        record("diagnostics.log", entry);
        diagnosticEntries.push(entry);
      },
    },

    telemetry: {
      track(name, props) {
        record("telemetry.track", name, props);
        telemetryEvents.push(props === undefined ? { name } : { name, props });
      },
    },

    ids: {
      async derive(kind, key) {
        record("ids.derive", kind, key);
        return `${kind}_${sha256Hex(`${kind}\u0000${key}`).slice(0, 32)}`;
      },
    },
  };
  return host;
}
