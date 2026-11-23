// The `HostServices` a driver gets inside `ari-driver`: every operation is a
// `host/*` request (or notification) to the host over the wire, scoped by the
// instance's id, and returns the host's answer.
//
// Process spawning follows the host's choice in `initialize`. When the host
// advertised `host.process`, a spawn is a `host/process.spawn` request: the
// host starts the child, the child's output arrives as `host/process.output`,
// its exit as `host/process.exit`, and writes, closing stdin and kills go back
// as `host/process.*` requests. Otherwise the driver spawns locally, applying
// the `envPolicy` the host sent in `initialize`, and executables are looked up
// locally too, since the spawn happens where the driver runs.
//
// Optional members (`attachments.extractText`, `hostTools.callDynamicTool`,
// `telemetry`, `ids`) exist only when the host listed them in
// `driver/create`'s `hostMembers`, as they would be absent on a local host.

import { callErrors } from "../errors.ts";
import type { AttachmentInfo, ConfigValues } from "../generated/common.ts";
import type { CallbackRegistration, DynamicToolResult, EnvPolicy, HostPaths, HostToolServer, Lease, ProcessExit, SpawnRequest, SpawnResult } from "../generated/host.ts";
import type { HostConfigGetResult } from "../generated/rpc.ts";
import type { HostServices, SpawnedProcess } from "../runtime.ts";
import type { WireConnection } from "./connection.ts";
import { StreamRouter, WireQueue, base64ToBytes, bytesToBase64 } from "./streams.ts";
import type { AriError } from "../ari-error.ts";

/** What arrives for one delegated child: a chunk of output, or its exit. */
export type ProcessEvent = { readonly type: "output"; readonly stream: string; readonly data: Uint8Array } | { readonly type: "exit"; readonly exit: ProcessExit };

/** Where delegated children's output and exits are routed, by process id. */
export type ProcessRouter = StreamRouter<ProcessEvent>;

export interface WireHostServicesOptions {
  readonly connection: WireConnection;
  /** The host's id for the instance; every `host/*` call carries it. */
  readonly instanceId: string;
  readonly paths: HostPaths;
  /** The optional members the host serves. */
  readonly hostMembers: readonly string[];
  /** The policy from `initialize`, as `process.envPolicy` reports it. */
  readonly envPolicy: EnvPolicy;
  /** Delegated spawns, through the connection's process router; or local spawns through the given service. */
  readonly processes:
    | { readonly mode: "delegated"; readonly router: ProcessRouter }
    | { readonly mode: "local"; readonly service: () => Pick<HostServices["process"], "spawn" | "resolveExecutable"> };
}

const encoder = new TextEncoder();

/** A child the host spawned for the driver. */
class DelegatedProcess implements SpawnedProcess {
  readonly pid: number | undefined;
  readonly stdout = new WireQueue<Uint8Array>();
  readonly stderr = new WireQueue<Uint8Array>();
  readonly exited: Promise<ProcessExit>;
  readonly #connection: WireConnection;
  readonly #target: { readonly instanceId: string; readonly processId: string };
  #resolveExit: (exit: ProcessExit) => void = () => undefined;
  #done = false;

  constructor(connection: WireConnection, instanceId: string, spawned: SpawnResult) {
    this.#connection = connection;
    this.#target = { instanceId, processId: spawned.processId };
    this.pid = spawned.pid;
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  receive(event: ProcessEvent): void {
    if (this.#done) return;
    if (event.type === "exit") {
      this.#finish(event.exit);
      return;
    }
    if (event.stream === "stderr") this.stderr.push(event.data);
    else this.stdout.push(event.data);
  }

  /** The connection closed: the host kills its children, so this one is gone. */
  lost(): void {
    this.#finish({ code: null, signal: null });
  }

  async write(data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    await this.#connection.request("host/process.write", { ...this.#target, data: bytesToBase64(bytes) });
  }

  async closeStdin(): Promise<void> {
    await this.#connection.request("host/process.closeStdin", this.#target);
  }

  async kill(signal?: string): Promise<void> {
    await this.#connection.request("host/process.kill", signal === undefined ? this.#target : { ...this.#target, signal });
  }

  #finish(exit: ProcessExit): void {
    if (this.#done) return;
    this.#done = true;
    this.stdout.end();
    this.stderr.end();
    this.#resolveExit(exit);
  }
}

/** Builds the `HostServices` of one instance on the driver side of the wire. */
export function createWireHostServices(options: WireHostServicesOptions): HostServices {
  const { connection, instanceId } = options;
  const members = new Set(options.hostMembers);
  const request = <T>(method: string, params: { readonly [key: string]: unknown } = {}): Promise<T> =>
    connection.request<T>(method, { instanceId, ...params });

  const processes = options.processes;
  const process: HostServices["process"] =
    processes.mode === "delegated"
      ? {
          envPolicy: options.envPolicy,
          async spawn(spawnRequest: SpawnRequest): Promise<SpawnedProcess> {
            const spawned = await request<SpawnResult>("host/process.spawn", { ...spawnRequest });
            const child = new DelegatedProcess(connection, instanceId, spawned);
            processes.router.attach(spawned.processId, {
              item: (event) => child.receive(event),
              end: (error?: AriError) => {
                if (error !== undefined) child.lost();
              },
            });
            return child;
          },
          resolveExecutable: (name, resolveOptions) =>
            request<string | null>("host/process.resolveExecutable", resolveOptions?.path === undefined ? { name } : { name, path: resolveOptions.path }),
        }
      : {
          envPolicy: options.envPolicy,
          spawn: (spawnRequest) => processes.service().spawn(spawnRequest),
          resolveExecutable: (name, resolveOptions) => processes.service().resolveExecutable(name, resolveOptions),
        };

  const host: HostServices = {
    paths: { ...options.paths },
    config: {
      async get(getOptions) {
        const watch = getOptions?.watch === true;
        const result = await request<HostConfigGetResult>("host/config.get", watch ? { watch: true } : {});
        const config = result.config as ConfigValues;
        if (result.streamId === undefined) return { config };
        return { config, changes: connection.consume<ConfigValues>(result.streamId) };
      },
    },
    secrets: {
      async get(namespace, key) {
        const value = await request<{ base64: string } | null>("host/secrets.get", { namespace, key });
        return value === null ? null : base64ToBytes(value.base64);
      },
      async set(namespace, key, value) {
        await request("host/secrets.set", { namespace, key, value: { base64: bytesToBase64(value) } });
      },
      async delete(namespace, key) {
        await request("host/secrets.delete", { namespace, key });
      },
    },
    process,
    attachments: {
      resolve: (ref) => request<AttachmentInfo | null>("host/attachments.resolve", { ref }),
    },
    callbacks: {
      register: (flowId) => request<CallbackRegistration>("host/callbacks.register", { flowId }),
    },
    hostTools: {
      mcpServerFor: (threadId, serverOptions) => request<HostToolServer>("host/hostTools.mcpServerFor", { threadId, ...serverOptions }),
    },
    background: {
      shouldRun: (scope) => request<boolean>("host/background.shouldRun", { scope }),
    },
    coordination: {
      acquire: (key, ttlMs) => request<Lease | null>("host/coordination.acquire", { key, ttlMs }),
      async release(leaseId) {
        await request("host/coordination.release", { leaseId });
      },
    },
    diagnostics: {
      log(entry) {
        void connection.notify("host/diagnostics.log", { instanceId, ...entry }).catch(() => undefined);
      },
    },
  };

  if (members.has("attachments.extractText")) {
    host.attachments.extractText = (ref) => request<string | null>("host/attachments.extractText", { ref });
  }
  if (members.has("hostTools.callDynamicTool")) {
    host.hostTools.callDynamicTool = (call) => request<DynamicToolResult>("host/hostTools.callDynamicTool", { ...call });
  }
  if (members.has("telemetry.track")) {
    host.telemetry = {
      track(name, props) {
        void connection.notify("host/telemetry.track", props === undefined ? { instanceId, name } : { instanceId, name, props }).catch(() => undefined);
      },
    };
  }
  if (members.has("ids.derive")) {
    host.ids = { derive: (kind, key) => request<string>("host/ids.derive", { kind, key }) };
  }
  return host;
}

/** Handles `host/process.output` and `host/process.exit` for the delegated children of a connection. */
export function routeProcessNotification(router: ProcessRouter, method: string, params: unknown): boolean {
  if (method === "host/process.output") {
    const output = params as { processId: string; stream: string; data: string };
    let data: Uint8Array;
    try {
      data = base64ToBytes(output.data);
    } catch {
      router.end(output.processId, callErrors.protocol("invalid_process_output", "host/process.output carried data that is not base64"));
      return true;
    }
    router.item(output.processId, { type: "output", stream: output.stream, data });
    return true;
  }
  if (method === "host/process.exit") {
    const exited = params as { processId: string; exit: ProcessExit };
    router.item(exited.processId, { type: "exit", exit: exited.exit });
    router.end(exited.processId);
    return true;
  }
  return false;
}
