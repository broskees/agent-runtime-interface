// The `HostServices` a driver gets inside `ari-driver`: every operation is a
// `host/*` JSON-RPC request to the host over the wire, scoped by the
// instance's id, and returns the host's answer. `diagnostics.log` and
// `telemetry.track` are requests too, but their TypeScript members return
// nothing, so the driver does not wait for the answer; an error answer is
// reported through `onProblem` (ari-driver writes it to stderr).
//
// Process spawning follows the host's choice in `initialize`. When the host
// advertised `host.process`, a spawn is a `host/process.spawn` request that
// names the child with a `processId` the driver chose: unique on the
// connection and never reused. The child is registered under that id before
// the request goes out, so its output (`host/process.output`) and exit
// (`host/process.exit`) always find it; writes, closing stdin and kills go
// back as `host/process.*` requests. Otherwise the driver spawns locally,
// applying the `envPolicy` the host sent in `initialize`, and executables are
// looked up locally too, since the spawn happens where the driver runs.
//
// Optional members (`attachments.extractText`, `hostTools.callDynamicTool`,
// `telemetry`, `ids`) exist only when the host listed them in
// `driver/create`'s `hostMembers`, as they would be absent on a local host.

import { callErrors, isAriError } from "../errors.ts";
import type { AttachmentInfo, ConfigValues } from "../generated/common.ts";
import type { CallbackRegistration, DynamicToolResult, EnvPolicy, HostPaths, HostToolServer, Lease, ProcessExit, SpawnRequest, SpawnResult } from "../generated/host.ts";
import type { HostConfigGetResult } from "../generated/rpc.ts";
import type { HostServices, SpawnedProcess } from "../runtime.ts";
import type { WireConnection } from "./connection.ts";
import { WireQueue, base64ToBytes, bytesToBase64 } from "./streams.ts";

export interface WireHostServicesOptions {
  readonly connection: WireConnection;
  /** The host's id for the instance; every `host/*` call carries it. */
  readonly instanceId: string;
  readonly paths: HostPaths;
  /** The optional members the host serves. */
  readonly hostMembers: readonly string[];
  /** The policy from `initialize`, as `process.envPolicy` reports it. */
  readonly envPolicy: EnvPolicy;
  /** Delegated spawns, tracked by the connection's children; or local spawns through the given service. */
  readonly processes:
    | { readonly mode: "delegated"; readonly children: DelegatedChildren }
    | { readonly mode: "local"; readonly service: () => Pick<HostServices["process"], "spawn" | "resolveExecutable"> };
  /** Told when the host answers a fire-and-forget operation (`diagnostics.log`, `telemetry.track`) with an error. */
  readonly onProblem?: (message: string) => void;
}

const encoder = new TextEncoder();

/** A child the host spawned for the driver, named by the driver's `processId`. */
class DelegatedProcess implements SpawnedProcess {
  readonly stdout = new WireQueue<Uint8Array>();
  readonly stderr = new WireQueue<Uint8Array>();
  readonly exited: Promise<ProcessExit>;
  readonly #connection: WireConnection;
  readonly #target: { readonly instanceId: string; readonly processId: string };
  readonly #onDone: () => void;
  #pid: number | undefined;
  #resolveExit: (exit: ProcessExit) => void = () => undefined;
  #done = false;

  constructor(connection: WireConnection, instanceId: string, processId: string, onDone: () => void) {
    this.#connection = connection;
    this.#target = { instanceId, processId };
    this.#onDone = onDone;
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  get pid(): number | undefined {
    return this.#pid;
  }

  started(result: SpawnResult): void {
    this.#pid = result.pid;
  }

  output(stream: string, data: Uint8Array): void {
    if (this.#done) return;
    if (stream === "stderr") this.stderr.push(data);
    else this.stdout.push(data);
  }

  exit(exit: ProcessExit): void {
    this.#finish(exit);
  }

  /** The spawn failed, or the connection closed (the host then kills its children): this child is gone. */
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
    this.#onDone();
  }
}

/**
 * The delegated children of one connection, by the `processId` the driver
 * gave each. Ids come from a counter and are never reused, so an exit can
 * only ever reach the child it belongs to. Output or an exit for an id that
 * is not running (never spawned, or already exited) breaks the protocol: it is
 * reported and dropped.
 */
export class DelegatedChildren {
  readonly #running = new Map<string, DelegatedProcess>();
  readonly #onProblem: (message: string) => void;
  #next = 1;

  constructor(onProblem: (message: string) => void = () => undefined) {
    this.#onProblem = onProblem;
  }

  /** Spawns a child through the host. It is registered under its new id before the request goes out. */
  async spawn(connection: WireConnection, instanceId: string, request: SpawnRequest): Promise<SpawnedProcess> {
    const processId = `p${this.#next}`;
    this.#next += 1;
    const child = new DelegatedProcess(connection, instanceId, processId, () => this.#running.delete(processId));
    this.#running.set(processId, child);
    try {
      child.started(await connection.request<SpawnResult>("host/process.spawn", { instanceId, ...request, processId }));
    } catch (error) {
      child.lost();
      throw error;
    }
    return child;
  }

  /** Handles `host/process.output` and `host/process.exit`; false for any other method. */
  receive(method: string, params: unknown): boolean {
    if (method !== "host/process.output" && method !== "host/process.exit") return false;
    const processId = (params as { processId: string }).processId;
    const child = this.#running.get(processId);
    if (child === undefined) {
      this.#onProblem(`dropped ${method} for process ${processId}, which is not running`);
      return true;
    }
    if (method === "host/process.exit") {
      child.exit((params as { exit: ProcessExit }).exit);
      return true;
    }
    const output = params as { stream: string; data: string };
    let data: Uint8Array;
    try {
      data = base64ToBytes(output.data);
    } catch {
      this.#onProblem(`host/process.output for process ${processId} carried data that is not base64`);
      return true;
    }
    child.output(output.stream, data);
    return true;
  }

  /** The connection closed: every running child is gone. */
  closeAll(): void {
    for (const child of [...this.#running.values()]) child.lost();
    this.#running.clear();
  }
}

/** Builds the `HostServices` of one instance on the driver side of the wire. */
export function createWireHostServices(options: WireHostServicesOptions): HostServices {
  const { connection, instanceId } = options;
  const members = new Set(options.hostMembers);
  const request = <T>(method: string, params: { readonly [key: string]: unknown } = {}): Promise<T> =>
    connection.request<T>(method, { instanceId, ...params });
  /** A request whose TypeScript member returns nothing: sent at once, and an error answer reported, not thrown. */
  const unanswered = (method: string, params: { readonly [key: string]: unknown }): void => {
    void request(method, params).catch((error: unknown) => {
      // Once the connection is gone, the host cannot have taken the entry; that is the transport's news, not a refusal.
      if (isAriError(error, "transport")) return;
      options.onProblem?.(`the host rejected ${method}: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const processes = options.processes;
  const process: HostServices["process"] =
    processes.mode === "delegated"
      ? {
          envPolicy: options.envPolicy,
          spawn: (spawnRequest: SpawnRequest) => processes.children.spawn(connection, instanceId, spawnRequest),
          resolveExecutable: (name, resolveOptions) =>
            request<string | null>("host/process.resolveExecutable", { ...resolveOptions, name }),
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
        if (!watch) return { config };
        if (typeof result.streamId !== "string") {
          throw callErrors.protocol("missing_stream_id", "The host answered host/config.get with watch: true but no streamId; a host with nothing to watch must start the stream and end it at once");
        }
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
        unanswered("host/diagnostics.log", { ...entry });
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
        unanswered("host/telemetry.track", props === undefined ? { name } : { name, props });
      },
    };
  }
  if (members.has("ids.derive")) {
    host.ids = { derive: (kind, key) => request<string>("host/ids.derive", { kind, key }) };
  }
  return host;
}
