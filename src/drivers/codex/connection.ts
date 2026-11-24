// One connection to a running `codex app-server`: the child process the host
// spawned, NDJSON framing on its stdio, the driver kit's JSON-RPC peer and the
// generated Codex client on top.
//
// Codex frames are JSON-RPC 2.0 without the `"jsonrpc"` member, so the
// connection adds it to every frame it reads before the peer sees it, and
// removes it from every frame the peer writes. Nothing else changes.

import { callErrors, toCallError } from "../../errors.ts";
import { JsonRpcError, JsonRpcPeer } from "../../driver-kit/json-rpc.ts";
import type { JsonRpcMessage } from "../../driver-kit/json-rpc.ts";
import { encodeNdjson, readNdjson } from "../../driver-kit/ndjson.ts";
import type { ProcessExit, SpawnRequest } from "../../generated/host.ts";
import type { HostServices, SpawnedProcess } from "../../runtime.ts";
import { ARI_VERSION } from "../../version.ts";
import { CodexAppServerClient } from "./generated/protocol.ts";
import type { InitializeResponse } from "./generated/protocol.ts";

/** A frame as it crossed the pipe, for diagnostics and tests. */
export interface CodexFrame {
  readonly direction: "to_codex" | "from_codex";
  readonly frame: unknown;
}

export interface CodexConnectionHandlers {
  readonly onNotification: (method: string, params: unknown) => void;
  readonly onRequest: (method: string, params: unknown, context: { readonly signal: AbortSignal; readonly id: string | number | null }) => unknown;
  /** The process exited; `byDriver` is true when the driver closed it. */
  readonly onExit: (exit: ProcessExit, byDriver: boolean) => void;
}

export interface CodexConnectionOptions {
  readonly spawn: SpawnRequest;
  /** Notifications the server must not send on this connection. */
  readonly optOutNotificationMethods: readonly string[];
  /** How long `initialize` may take; a hung start fails deterministically. */
  readonly handshakeTimeoutMs: number;
  readonly handlers: CodexConnectionHandlers;
}

/** The JSON-RPC error codes the app-server uses (codex-rs/app-server/src/error_code.rs). */
export const CODEX_ERROR_CODES = { invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internalError: -32603, overloaded: -32001 } as const;

/** Maps an app-server error to a call error. `what` names the thing the call was about, for not-found errors. */
export function callErrorFromCodex(error: unknown, what: string): Error {
  if (toCallError(error) !== undefined) return error as Error;
  if (error instanceof JsonRpcError) {
    const message = error.message;
    if (error.code === CODEX_ERROR_CODES.methodNotFound) return callErrors.protocol(`method not found (${error.code})`, message);
    if (/no rollout found|thread not found|not found/i.test(message)) return callErrors.notFound({ resource: what, message });
    if (error.code === CODEX_ERROR_CODES.invalidParams) return callErrors.validation([{ message, path: [] }], message);
    if (error.code === CODEX_ERROR_CODES.invalidRequest) return callErrors.invalidState("codex_rejected", message);
    return callErrors.protocol(`codex error ${error.code}`, message);
  }
  return callErrors.transport(error instanceof Error ? error.message : String(error));
}

export class CodexConnection {
  readonly client: CodexAppServerClient;
  readonly #peer: JsonRpcPeer;
  readonly #process: SpawnedProcess;
  #closedByDriver = false;
  #exited = false;
  /** Every frame in and out, oldest first, bounded. */
  readonly frames: CodexFrame[] = [];
  initializeResponse: InitializeResponse | undefined;

  private constructor(process: SpawnedProcess, handlers: CodexConnectionHandlers) {
    this.#process = process;
    const record = (frame: CodexFrame): void => {
      this.frames.push(frame);
      if (this.frames.length > 2000) this.frames.splice(0, this.frames.length - 2000);
    };
    const peer = new JsonRpcPeer({
      send: (message: JsonRpcMessage) => {
        const { jsonrpc: _version, ...frame } = message;
        record({ direction: "to_codex", frame });
        return process.write(encodeNdjson(frame));
      },
      onNotification: (method, params) => handlers.onNotification(method, params),
      onRequest: (method, params, context) => handlers.onRequest(method, params, { signal: context.signal, id: context.id }),
    });
    this.#peer = peer;
    this.client = new CodexAppServerClient({
      request: (method, params) => peer.request(method, params),
      notify: (method, params) => peer.notify(method, params),
    });
    void (async () => {
      for await (const chunk of process.stderr) void chunk;
    })();
    void (async () => {
      try {
        for await (const line of readNdjson(process.stdout)) {
          if (!line.ok) continue;
          record({ direction: "from_codex", frame: line.value });
          const value = line.value;
          if (typeof value === "object" && value !== null && !Array.isArray(value)) peer.receive({ jsonrpc: "2.0", ...value });
        }
      } catch {
        // A broken pipe ends the stream the same way an exit does.
      }
      const exit = await process.exited;
      this.#exited = true;
      peer.close(callErrors.transport(`codex app-server exited (${exit.code === null ? `signal ${String(exit.signal)}` : `code ${exit.code}`})`));
      handlers.onExit(exit, this.#closedByDriver);
    })();
  }

  /** Spawns `codex app-server` through the host and runs the `initialize` handshake. */
  static async start(host: HostServices<unknown>, options: CodexConnectionOptions): Promise<CodexConnection> {
    let process: SpawnedProcess;
    try {
      process = await host.process.spawn(options.spawn);
    } catch (error) {
      if (toCallError(error)?.code === "not_found") throw callErrors.driverUnavailable({ binary: options.spawn.command, installHint: "npm install -g @openai/codex" });
      throw error;
    }
    const connection = new CodexConnection(process, options.handlers);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        connection.client.initialize({
          clientInfo: { name: "ari", title: "ARI", version: ARI_VERSION },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [...options.optOutNotificationMethods] },
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(callErrors.transport(`codex app-server did not answer initialize within ${options.handshakeTimeoutMs} ms`)), options.handshakeTimeoutMs);
        }),
      ]);
      connection.initializeResponse = response;
      await connection.client.initialized();
    } catch (error) {
      await connection.close();
      throw callErrorFromCodex(error, "codex app-server");
    } finally {
      clearTimeout(timer);
    }
    return connection;
  }

  get exited(): boolean {
    return this.#exited;
  }

  /** Stops the process. Pending calls reject with a transport error. */
  async close(): Promise<void> {
    this.#closedByDriver = true;
    this.#peer.close();
    await this.#process.closeStdin().catch(() => undefined);
    await this.#process.kill().catch(() => undefined);
    await this.#process.exited;
  }
}
