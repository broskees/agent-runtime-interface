// One running ACP agent process and the JSON-RPC connection to it: spawning
// through the host, newline-delimited JSON-RPC on stdio, the `initialize`
// handshake that picks the protocol version, and requests typed by the
// method tables generated from ACP's own v1 and v2 schemas
// (src/drivers/acp/generated, made by scripts/codegen-acp.ts).

import { callErrors, toCallError } from "../../errors.ts";
import { JsonRpcError, JsonRpcPeer } from "../../driver-kit/json-rpc.ts";
import type { JsonRpcRequestContext } from "../../driver-kit/json-rpc.ts";
import { encodeNdjson, readNdjson } from "../../driver-kit/ndjson.ts";
import type { ProcessExit } from "../../generated/host.ts";
import type { HostServices, SpawnedProcess } from "../../runtime.ts";
import { ARI_VERSION } from "../../version.ts";
import type * as V1 from "./generated/v1.ts";
import type * as V2 from "./generated/v2.ts";
import type { AcpVersion } from "./mapping.ts";

/** The command one session runs, as a flavor builds it. */
export interface AcpLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** Explicit environment additions; the host's `envPolicy` strips ambient variables first. */
  readonly env: { readonly [name: string]: string };
  readonly cwd?: string;
  /** Called once the process has exited, for example to end an installer lease. */
  readonly release?: () => Promise<void>;
}

/** JSON-RPC error codes ACP defines. */
export const ACP_ERRORS = {
  authRequired: -32000,
  resourceNotFound: -32002,
  unsupportedProtocolVersion: -32022,
  requestCancelled: -32800,
} as const;

export interface AcpConnectionHandlers {
  readonly onNotification: (method: string, params: unknown) => void;
  readonly onRequest: (method: string, params: unknown, context: JsonRpcRequestContext) => unknown;
  /** The agent process exited; `byDriver` is true when the driver closed it. */
  readonly onExit: (exit: ProcessExit, byDriver: boolean) => void;
}

export interface AcpHandshake {
  readonly version: AcpVersion;
  readonly agentInfo: V1.Implementation | V2.Implementation | undefined;
  readonly agentCapabilities: V1.AgentCapabilities | V2.AgentCapabilities | undefined;
  readonly authMethods: ReadonlyArray<V1.AuthMethod | V2.AuthMethod>;
  readonly meta: { readonly [key: string]: unknown } | undefined;
}

type V1AgentMethod = keyof V1.AgentMethods;
type V2AgentMethod = keyof V2.AgentMethods;

/** Maps a JSON-RPC error from the agent to an ARI call error. */
export function callErrorFrom(error: unknown, what: string): Error {
  if (toCallError(error) !== undefined) return error as Error;
  if (error instanceof JsonRpcError) {
    if (error.code === ACP_ERRORS.authRequired) return callErrors.authRequired([], error.message);
    if (error.code === ACP_ERRORS.resourceNotFound) return callErrors.notFound({ resource: what, message: error.message });
    if (error.code === -32602) return callErrors.validation([{ path: [], message: error.message }], `The agent refused the ${what} request: ${error.message}`);
    if (error.code === -32601) return callErrors.unsupported(`acp.${what}`, `The agent does not implement ${what}: ${error.message}`);
    return callErrors.protocol(`agent error ${error.code}`, error.message);
  }
  return callErrors.transport(error instanceof Error ? error.message : String(error));
}

export class AcpConnection {
  readonly peer: JsonRpcPeer;
  readonly process: SpawnedProcess;
  readonly exited: Promise<ProcessExit>;
  #closedByDriver = false;
  #handshake: AcpHandshake | undefined;

  private constructor(process: SpawnedProcess, handlers: AcpConnectionHandlers, release: (() => Promise<void>) | undefined) {
    this.process = process;
    const peer = new JsonRpcPeer({
      send: (message) => process.write(encodeNdjson(message)),
      onNotification: (method, params) => handlers.onNotification(method, params),
      onRequest: (method, params, context) => handlers.onRequest(method, params, context),
    });
    this.peer = peer;
    void (async () => {
      for await (const chunk of process.stderr) void chunk;
    })().catch(() => undefined);
    this.exited = (async () => {
      try {
        for await (const record of readNdjson(process.stdout)) {
          if (record.ok) peer.receive(record.value);
        }
      } catch {
        // A broken pipe ends the stream like an exit does.
      }
      const exit = await process.exited;
      peer.close(callErrors.transport(`The ACP agent exited (${exit.code === null ? `signal ${String(exit.signal)}` : `code ${exit.code}`})`));
      await release?.().catch(() => undefined);
      handlers.onExit(exit, this.#closedByDriver);
      return exit;
    })();
  }

  /** Spawns the agent and completes the `initialize` handshake within `timeoutMs`. */
  static async open(
    host: HostServices<unknown>,
    launch: AcpLaunch,
    options: {
      readonly maxProtocolVersion: AcpVersion;
      readonly timeoutMs: number;
      /** Told the protocol version the agent answered `initialize` with, before the driver accepts or refuses it. */
      readonly onAnswer?: (protocolVersion: unknown) => void;
    },
    handlers: AcpConnectionHandlers,
  ): Promise<AcpConnection> {
    let process: SpawnedProcess;
    try {
      process = await host.process.spawn({
        command: launch.command,
        args: [...launch.args],
        env: { ...launch.env },
        purpose: "runtime",
        stdin: "pipe",
        ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
      });
    } catch (error) {
      await launch.release?.().catch(() => undefined);
      if (toCallError(error)?.code === "not_found") throw callErrors.driverUnavailable({ binary: launch.command }, `The ACP agent ${launch.command} is not installed`);
      throw error;
    }
    const connection = new AcpConnection(process, handlers, launch.release);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const handshake = await Promise.race([
        connection.#initialize(options.maxProtocolVersion, options.onAnswer),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(callErrors.transport(`The ACP agent did not answer initialize within ${options.timeoutMs} ms`)), options.timeoutMs);
        }),
      ]);
      connection.#handshake = handshake;
      return connection;
    } catch (error) {
      await connection.close();
      throw callErrorFrom(error, "initialize");
    } finally {
      clearTimeout(timer);
    }
  }

  get handshake(): AcpHandshake {
    if (this.#handshake === undefined) throw callErrors.invalidState("not_initialized");
    return this.#handshake;
  }

  get version(): AcpVersion {
    return this.handshake.version;
  }

  /** Sends `initialize` asking for `maxVersion` and takes the version the agent answers with. */
  async #initialize(maxVersion: AcpVersion, onAnswer: ((protocolVersion: unknown) => void) | undefined): Promise<AcpHandshake> {
    const info = { name: "ari", title: "ARI", version: ARI_VERSION };
    const params: V1.InitializeRequest | V2.InitializeRequest =
      maxVersion === 2
        ? ({ protocolVersion: 2, info, capabilities: {} } satisfies V2.InitializeRequest)
        : ({
            protocolVersion: 1,
            // The driver maps boolean config options, which a v1 agent offers only to a client that says so.
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { configOptions: { boolean: {} } } },
            clientInfo: info,
          } satisfies V1.InitializeRequest);
    const result = (await this.peer.request("initialize", params)) as V1.InitializeResponse | V2.InitializeResponse;
    const version = result.protocolVersion;
    onAnswer?.(version);
    if (version !== 1 && version !== 2) {
      throw callErrors.protocol("unsupported_protocol_version", `The ACP agent answered initialize with protocol version ${String(version)}; this driver speaks 1 and 2`);
    }
    if (version > maxVersion) {
      throw callErrors.protocol("unsupported_protocol_version", `The ACP agent chose protocol version ${version}, newer than the ${maxVersion} this driver asked for`);
    }
    if (version === 1) {
      const v1 = result as V1.InitializeResponse;
      return { version, agentInfo: v1.agentInfo ?? undefined, agentCapabilities: v1.agentCapabilities, authMethods: v1.authMethods ?? [], meta: v1._meta ?? undefined };
    }
    const v2 = result as V2.InitializeResponse;
    return { version, agentInfo: v2.info, agentCapabilities: v2.capabilities, authMethods: v2.authMethods ?? [], meta: v2._meta ?? undefined };
  }

  /** A v1 request, typed by the v1 schema's method table. */
  requestV1<Method extends V1AgentMethod>(method: Method, params: V1.AgentMethods[Method]["params"]): Promise<V1.AgentMethods[Method]["result"]> {
    return this.peer.request(method, params);
  }

  /** A v2 request, typed by the v2 schema's method table. */
  requestV2<Method extends V2AgentMethod>(method: Method, params: V2.AgentMethods[Method]["params"]): Promise<V2.AgentMethods[Method]["result"]> {
    return this.peer.request(method, params);
  }

  notifyV1<Method extends keyof V1.AgentNotifications>(method: Method, params: V1.AgentNotifications[Method]): Promise<void> {
    return this.peer.notify(method, params);
  }

  notifyV2<Method extends keyof V2.AgentNotifications>(method: Method, params: V2.AgentNotifications[Method]): Promise<void> {
    return this.peer.notify(method, params);
  }

  /** An ACP extension request (a method name starting with `_`). */
  extension(method: string, params: unknown): Promise<unknown> {
    return this.peer.request(method, params);
  }

  /** Ends the agent process and waits for it to exit. */
  async close(): Promise<void> {
    this.#closedByDriver = true;
    this.peer.close();
    await this.process.kill().catch(() => undefined);
    await this.exited;
  }
}
