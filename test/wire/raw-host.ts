// A host that speaks `ari/wire` by hand: it spawns the built `ari-driver`,
// writes JSON-RPC frames as text lines and reads them back, with no ARI
// client code in between. Tests use it to check the protocol the way a Rust,
// Python or Go host sees it: the exact frames, ids and replies.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ARI_DRIVER_BIN, requireBuild } from "./helpers.ts";

/** One JSON-RPC 2.0 frame, as it crossed the wire. */
export interface Frame {
  readonly jsonrpc: "2.0";
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: any;
  readonly result?: any;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: any };
}

/** What a handler answers a driver's request with; `undefined` means it will call `reply` itself later. */
export type Answer = { readonly result: unknown } | { readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } } | undefined;

export type RequestHandler = (params: any, frame: Frame) => Answer | Promise<Answer>;

/** A call error as a JSON-RPC error answer. */
export function callErrorAnswer(code: string, message: string, extra: object = {}): Answer {
  return { error: { code: -32000, message, data: { code, message, ...extra } } };
}

export class RawHost {
  readonly child: ChildProcess;
  /** Every frame ari-driver sent, in order. */
  readonly received: Frame[] = [];
  /** Every frame this host sent, in order. */
  readonly sent: Frame[] = [];
  #stderr = "";
  #nextId = 1;
  readonly #pending = new Map<number, (frame: Frame) => void>();
  readonly #handlers = new Map<string, RequestHandler>();
  readonly #watchers = new Set<() => void>();
  readonly exited: Promise<number | null>;

  private constructor(child: ChildProcess) {
    this.child = child;
    this.exited = new Promise((resolve) => child.once("close", (code) => resolve(code)));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (text: string) => {
      this.#stderr += text;
    });
    let buffered = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (text: string) => {
      buffered += text;
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim() !== "") this.#receive(JSON.parse(line) as Frame);
        newline = buffered.indexOf("\n");
      }
    });
  }

  /** Spawns the built ari-driver with `args`. */
  static start(args: readonly string[], env: { readonly [name: string]: string | undefined } = process.env): RawHost {
    requireBuild();
    const child = spawn(process.execPath, [ARI_DRIVER_BIN, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...env } });
    child.stdin!.on("error", () => undefined);
    return new RawHost(child);
  }

  get stderr(): string {
    return this.#stderr;
  }

  /** Answers the driver's requests for `method` with `handler`. */
  handle(method: string, handler: RequestHandler): void {
    this.#handlers.set(method, handler);
  }

  /** Writes one frame. */
  send(frame: object): void {
    const full = { jsonrpc: "2.0", ...frame } as Frame;
    this.sent.push(full);
    this.child.stdin!.write(`${JSON.stringify(full)}\n`);
  }

  /** Sends a request and resolves with the response frame (a result or an error). */
  request(method: string, params: unknown): Promise<Frame> {
    const id = this.#nextId;
    this.#nextId += 1;
    const answered = new Promise<Frame>((resolve) => this.#pending.set(id, resolve));
    this.send({ id, method, params });
    return answered;
  }

  /** Sends a request and resolves with its result, or throws its error. */
  async call(method: string, params: unknown): Promise<any> {
    const response = await this.request(method, params);
    if (response.error !== undefined) throw Object.assign(new Error(`${method}: ${response.error.message}`), { response });
    return response.result;
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  reply(id: number | string | null | undefined, answer: NonNullable<Answer>): void {
    this.send({ id: id ?? null, ...answer });
  }

  /** Resolves with the first received frame that matches, waiting up to 10 s. */
  async waitFor(match: (frame: Frame) => boolean, what: string): Promise<Frame> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = this.received.find(match);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; stderr: ${this.#stderr}`);
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          this.#watchers.delete(wake);
          resolve();
        };
        this.#watchers.add(wake);
        void delay(50, undefined, { ref: false }).then(wake);
      });
    }
  }

  /** The standard handshake: this package's versions, unless `overrides` change them. */
  initialize(overrides: object = {}): Promise<Frame> {
    return this.request("initialize", {
      ariVersion: "1.0.0",
      grammarVersions: [1, 1],
      methodVersions: {},
      persistenceVersion: { major: 1, minor: 0 },
      host: { capabilities: { process: false } },
      ...overrides,
    });
  }

  /** Closes stdin, which ends ari-driver, and waits for it to exit. */
  async close(): Promise<number | null> {
    this.child.stdin!.end();
    const code = await Promise.race([this.exited, delay(5000, "timeout" as const, { ref: false })]);
    if (code === "timeout") {
      this.child.kill("SIGKILL");
      return this.exited;
    }
    return code;
  }

  #receive(frame: Frame): void {
    this.received.push(frame);
    for (const wake of [...this.#watchers]) wake();
    if (frame.method === undefined) {
      const resolve = typeof frame.id === "number" ? this.#pending.get(frame.id) : undefined;
      if (resolve !== undefined) {
        this.#pending.delete(frame.id as number);
        resolve(frame);
      }
      return;
    }
    if (frame.id === undefined) return;
    const handler = this.#handlers.get(frame.method);
    if (handler === undefined) {
      this.reply(frame.id, { error: { code: -32601, message: `Method not found: ${frame.method}`, data: { code: "unsupported", message: "not served by this raw host", capability: frame.method } } });
      return;
    }
    void Promise.resolve(handler(frame.params, frame)).then((answer) => {
      if (answer !== undefined) this.reply(frame.id, answer);
    });
  }
}
