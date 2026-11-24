// One `muse serve` host: the child process the ARI host spawned for the
// driver, and the SDK's MSP `Connection` over its stdio.
//
// The driver builds the SDK's `Connection` around its own transport instead
// of letting the SDK spawn the host: the process must come from the ARI host's
// `process.spawn`, so the host's environment policy applies and a host that
// delegates processes (over `ari/wire`) can run it. The handshake is the one
// the SDK's own `MspHandshake.initialize` runs: `initialize`, then the
// `initialized` notification. A v1 host accepts exactly one connection and its
// lifetime is the process lifetime; closing stdin drains it in order.

import { callErrors, toCallError } from "../../errors.ts";
import type { ProcessExit, SpawnRequest } from "../../generated/host.ts";
import type { HostServices, SpawnedProcess } from "../../runtime.ts";
import { ARI_VERSION } from "../../version.ts";
import { MUSE_CLI_INSTALL_HINT } from "../../meta/muse.ts";
import type {
  MuseCommandMethod,
  MuseConnection,
  MuseDuplexTransport,
  MuseInitializeResult,
  MuseMethods,
  MuseMspError,
  MuseQueryMethod,
  MuseSdk,
  MuseWireNotification,
  MuseWireRequest,
} from "./sdk.ts";

/** The `clientInfo.name` the driver identifies itself with; MSP allows `[a-z0-9_]+`. */
export const MUSE_CLIENT_NAME = "ari";

/** How long the host may take to drain after stdin closes before the driver ends the process. */
const DRAIN_MS = 10_000;

export interface MuseHostHandlers {
  readonly onNotification: (notification: MuseWireNotification) => void;
  /** Answers a server request (`approval/request`, `userInput/request`) with its receipt. */
  readonly onServerRequest: (request: MuseWireRequest) => Promise<Record<string, unknown>>;
  /** The process exited; `byDriver` is true when the driver closed it. */
  readonly onExit: (exit: ProcessExit, byDriver: boolean) => void;
}

export interface MuseHostOptions {
  readonly sdk: MuseSdk;
  readonly spawn: SpawnRequest;
  readonly handshakeTimeoutMs: number;
  readonly mintCommandId?: () => string;
  readonly handlers: MuseHostHandlers;
}

/** The MSP error kind of a failed call, or undefined for a failure that is not an MSP error. */
export function mspErrorKind(sdk: MuseSdk, error: unknown): string | undefined {
  return error instanceof sdk.MspError ? (error as MuseMspError).kind : undefined;
}

/** Maps a failed MSP call to a call error. `what` names the thing the call was about, for not-found errors. */
export function callErrorFromMuse(sdk: MuseSdk, error: unknown, what: string): Error {
  if (toCallError(error) !== undefined) return error as Error;
  if (error instanceof sdk.MspError) {
    const msp = error as MuseMspError;
    switch (msp.kind) {
      case "notFound":
      case "sessionNotFound":
      case "approvalNotFound":
      case "userInputNotFound":
        return callErrors.notFound({ resource: what, message: msp.message });
      case "invalidParams":
      case "inputTooLarge":
      case "approvalChoiceInvalid":
      case "userInputAnswerInvalid":
        return callErrors.validation([{ message: msp.message, path: [] }], msp.message);
      case "sessionInUse":
      case "sessionNotLoaded":
      case "commandRejected":
      case "approvalAlreadyResolved":
      case "userInputAlreadySettled":
      case "approvalRequirementStale":
        return callErrors.invalidState(msp.kind, msp.message);
      case "capabilityRequired":
        return callErrors.unsupported(`muse.${String(msp.data["capability"] ?? "capability")}`, msp.message);
      default:
        return callErrors.protocol(`muse error ${msp.code} ${msp.kind}`, msp.message);
    }
  }
  return callErrors.transport(error instanceof Error ? error.message : String(error));
}

/** A `DuplexTransport` over a host-spawned process: decoded stdout chunks in, frames to stdin out. */
function processTransport(process: SpawnedProcess): MuseDuplexTransport {
  async function* incoming(): AsyncGenerator<string, void, undefined> {
    const decoder = new TextDecoder();
    for await (const chunk of process.stdout) yield decoder.decode(chunk, { stream: true });
    const rest = decoder.decode();
    if (rest !== "") yield rest;
  }
  return {
    incoming: incoming(),
    write: (chunk) => process.write(chunk),
    close: async (flushed) => {
      await flushed;
      await process.closeStdin().catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        process.exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), DRAIN_MS);
        }),
      ]);
      clearTimeout(timer);
      if (!drained) await process.kill().catch(() => undefined);
      await process.exited;
    },
  };
}

export class MuseHost {
  readonly #sdk: MuseSdk;
  readonly #process: SpawnedProcess;
  readonly #connection: MuseConnection;
  #closedByDriver = false;
  #exited = false;
  initializeResult: MuseInitializeResult | undefined;

  private constructor(sdk: MuseSdk, process: SpawnedProcess, connection: MuseConnection) {
    this.#sdk = sdk;
    this.#process = process;
    this.#connection = connection;
  }

  /** Spawns `muse serve` through the host and runs the MSP handshake. */
  static async start(host: HostServices<unknown>, options: MuseHostOptions): Promise<MuseHost> {
    let process: SpawnedProcess;
    try {
      process = await host.process.spawn(options.spawn);
    } catch (error) {
      if (toCallError(error)?.code === "not_found") throw callErrors.driverUnavailable({ binary: options.spawn.command, installHint: MUSE_CLI_INSTALL_HINT });
      throw error;
    }
    void (async () => {
      // Muse writes diagnostics to stderr; nothing reads them as protocol.
      for await (const chunk of process.stderr) void chunk;
    })();
    const connection = new options.sdk.Connection(processTransport(process), options.mintCommandId === undefined ? undefined : { mintCommandId: options.mintCommandId });
    const muse = new MuseHost(options.sdk, process, connection);
    connection.onNotification((notification) => options.handlers.onNotification(notification));
    connection.onServerRequest((request) => options.handlers.onServerRequest(request));
    // A frame the SDK refuses is dropped by the SDK; the stream goes on.
    connection.onProtocolError(() => undefined);
    void process.exited.then((exit) => {
      muse.#exited = true;
      options.handlers.onExit(exit, muse.#closedByDriver);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        muse.request("initialize", { clientInfo: { name: MUSE_CLIENT_NAME, title: "ARI", version: ARI_VERSION }, capabilities: { requestedCapabilities: ["sessionMcp"] } }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(callErrors.transport(`muse serve did not answer initialize within ${options.handshakeTimeoutMs} ms`)), options.handshakeTimeoutMs);
        }),
      ]);
      if (result.schema.version !== 1) throw callErrors.protocol(`MSP envelope version ${result.schema.version}`, `muse serve speaks MSP envelope version ${result.schema.version}; this driver speaks version 1`);
      muse.initializeResult = result;
      connection.notify("initialized");
    } catch (error) {
      await muse.close();
      throw callErrorFromMuse(options.sdk, error, "muse serve");
    } finally {
      clearTimeout(timer);
    }
    return muse;
  }

  get exited(): boolean {
    return this.#exited;
  }

  /** True when the host granted the per-session MCP servers capability. */
  get sessionMcp(): boolean {
    return this.initializeResult?.grantedCapabilities.includes("sessionMcp") === true;
  }

  /** Mints a UUIDv7 from the connection's single minter: session ids and turn ids come from it. */
  mintCommandId(): string {
    return this.#connection.mintCommandId();
  }

  /** Sends a command; the connection adds `commandId` (or uses the one given) and checks the ack echoes it. */
  async command<M extends MuseCommandMethod>(method: M, params: MuseMethods[M]["params"], commandId?: string): Promise<MuseMethods[M]["result"]> {
    // The SDK retries a refusal that admitted nothing (overloaded, backpressured) under the same commandId; nothing else is retried.
    const result = await this.#connection.command(method, params as unknown as Record<string, unknown>, commandId === undefined ? undefined : { commandId });
    return result as unknown as MuseMethods[M]["result"];
  }

  /** Sends a query. */
  async request<M extends MuseQueryMethod>(method: M, ...params: MuseMethods[M]["params"] extends undefined ? [] : [params: MuseMethods[M]["params"]]): Promise<MuseMethods[M]["result"]> {
    const result = await this.#connection.request(method, params[0] as Record<string, unknown> | undefined);
    return result as unknown as MuseMethods[M]["result"];
  }

  /** The MSP error kind of a failed call. */
  errorKind(error: unknown): string | undefined {
    return mspErrorKind(this.#sdk, error);
  }

  /** Closes stdin so the host drains in order (cancelling a running turn, releasing its leases), then ends it if it does not exit. */
  async close(): Promise<void> {
    this.#closedByDriver = true;
    if (this.#exited) return;
    await this.#connection.close().catch(() => undefined);
    await this.#process.exited;
  }
}
