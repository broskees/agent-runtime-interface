// One running `pi --mode rpc` process. Pi's RPC mode is strict JSONL: one
// JSON object per line, split on LF only, never on U+2028 or U+2029 (Pi docs,
// rpc.md "Framing"); the driver kit's NDJSON decoder frames exactly that way.
//
// Commands carry a string `id` and Pi answers each with one `response`
// record repeating it. Everything else on stdout (session events, extension UI
// requests, id-less responses such as a parse error) goes to `onRecord`, in
// the order Pi wrote it. A response's `onResponse` hook runs synchronously
// before any later record is handled, so state a response creates (a started
// turn) exists before the events that follow it.

import { callErrors } from "../../errors.ts";
import { NdjsonDecoder, encodeNdjson } from "../../driver-kit/ndjson.ts";
import type { ProcessExit } from "../../generated/host.ts";
import type { SpawnedProcess } from "../../runtime.ts";

/** One record Pi wrote, or one command the driver sends. */
export interface PiRecord {
  readonly type?: unknown;
  readonly [field: string]: unknown;
}

/** A command Pi answered with `success: false`. */
export class PiCommandError extends Error {
  readonly command: string;
  constructor(command: string, message: string) {
    super(message);
    this.name = "PiCommandError";
    this.command = command;
  }
}

interface Pending {
  readonly command: string;
  readonly onResponse: ((response: PiRecord) => void) | undefined;
  readonly resolve: (data: unknown) => void;
  readonly reject: (error: Error) => void;
}

export interface PiProcessHandlers {
  /** Every record that is not the response to a pending command. */
  readonly onRecord: (record: PiRecord) => void;
  /** The process exited; `byDriver` is true after `close()`. */
  readonly onExit: (exit: ProcessExit, byDriver: boolean) => void;
}

export class PiProcess {
  readonly #process: SpawnedProcess;
  readonly #handlers: PiProcessHandlers;
  readonly #pending = new Map<string, Pending>();
  #nextId = 1;
  #closedByDriver = false;
  #exit: ProcessExit | undefined;
  /** Settles when the process has exited and every record before the exit was handled. */
  readonly finished: Promise<ProcessExit>;

  constructor(process: SpawnedProcess, handlers: PiProcessHandlers) {
    this.#process = process;
    this.#handlers = handlers;
    // Pi writes diagnostics to stderr; they are not protocol data, but the pipe must be drained.
    void (async () => {
      for await (const chunk of process.stderr) void chunk;
    })().catch(() => undefined);
    this.finished = this.#read();
  }

  get exited(): boolean {
    return this.#exit !== undefined;
  }

  async #read(): Promise<ProcessExit> {
    const decoder = new NdjsonDecoder();
    try {
      for await (const chunk of this.#process.stdout) {
        for (const record of decoder.push(chunk)) this.#route(record);
      }
      for (const record of decoder.end()) this.#route(record);
    } catch {
      // A broken pipe ends reading; the exit below says why.
    }
    const exit = await this.#process.exited;
    this.#exit = exit;
    const reason = callErrors.transport(`pi exited (${exit.code === null ? `signal ${String(exit.signal)}` : `code ${exit.code}`})`);
    for (const pending of this.#pending.values()) pending.reject(reason);
    this.#pending.clear();
    this.#handlers.onExit(exit, this.#closedByDriver);
    return exit;
  }

  #route(decoded: { ok: true; value: unknown } | { ok: false; error: string; line: string }): void {
    if (!decoded.ok || typeof decoded.value !== "object" || decoded.value === null || Array.isArray(decoded.value)) return;
    const record = decoded.value as PiRecord;
    if (record.type === "response" && typeof record["id"] === "string") {
      const pending = this.#pending.get(record["id"]);
      if (pending !== undefined) {
        this.#pending.delete(record["id"]);
        if (record["success"] === true) {
          pending.onResponse?.(record);
          pending.resolve(record["data"]);
        } else {
          pending.reject(new PiCommandError(pending.command, typeof record["error"] === "string" ? record["error"] : `pi refused ${pending.command}`));
        }
        return;
      }
    }
    this.#handlers.onRecord(record);
  }

  /** Writes one record (a command without an answer, or an extension UI response). */
  async send(record: PiRecord): Promise<void> {
    if (this.#exit !== undefined) throw callErrors.transport("pi has exited");
    await this.#process.write(encodeNdjson(record));
  }

  /**
   * Sends a command and resolves with its response's `data`. `onResponse`
   * runs synchronously when the response arrives, before later records.
   */
  request<T = unknown>(command: { readonly type: string; readonly [field: string]: unknown }, onResponse?: (response: PiRecord) => void): Promise<T> {
    if (this.#exit !== undefined) return Promise.reject(callErrors.transport("pi has exited"));
    const id = `ari-${this.#nextId}`;
    this.#nextId += 1;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { command: command.type, onResponse, resolve: resolve as (data: unknown) => void, reject });
      this.#process.write(encodeNdjson({ ...command, id })).catch((error: unknown) => {
        if (!this.#pending.delete(id)) return;
        reject(callErrors.transport(error instanceof Error ? error.message : String(error)));
      });
    });
  }

  /** Stops Pi (SIGTERM starts its orderly shutdown) and waits until it has exited. */
  async close(): Promise<void> {
    this.#closedByDriver = true;
    if (this.#exit === undefined) await this.#process.kill().catch(() => undefined);
    await this.finished;
  }
}
