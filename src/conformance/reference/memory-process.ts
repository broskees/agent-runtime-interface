// A `SpawnedProcess` made of in-memory queues, so a stdio driver can talk to
// an agent that runs in the same JavaScript realm. What the driver writes
// reaches `onStdin`; what the agent writes with `stdout` reaches the driver's
// `stdout` stream; `exit` ends both output streams and settles `exited`.

import type { ProcessExit } from "../../generated/host.ts";
import type { SpawnedProcess } from "../../runtime.ts";
import { AsyncQueue } from "../util.ts";

export interface MemoryProcessHandlers {
  /** Text the driver wrote to the process's stdin. */
  onStdin(text: string): void;
  /** The driver closed stdin. */
  onStdinClosed(): void;
  /** The driver killed the process. */
  onKill(signal: string): void;
}

export interface MemoryProcess {
  readonly process: SpawnedProcess;
  /** Writes to the process's stdout. */
  stdout(text: string): void;
  stderr(text: string): void;
  /** Ends the process: closes its output and settles `exited`. */
  exit(code: number | null, signal: string | null): void;
  readonly exited: boolean;
}

let nextPid = 70_000;

export function createMemoryProcess(handlers: MemoryProcessHandlers): MemoryProcess {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stdout = new AsyncQueue<Uint8Array>();
  const stderr = new AsyncQueue<Uint8Array>();
  let resolveExit: (exit: ProcessExit) => void = () => undefined;
  const exited = new Promise<ProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  let done = false;
  nextPid += 1;

  const exit = (code: number | null, signal: string | null): void => {
    if (done) return;
    done = true;
    stdout.end();
    stderr.end();
    resolveExit({ code, signal });
  };

  const process: SpawnedProcess = {
    pid: nextPid,
    stdout,
    stderr,
    async write(data) {
      if (done) throw new Error("write after the process exited");
      const text = typeof data === "string" ? data : decoder.decode(data);
      // Deliver on a later microtask, as a pipe would, so a reply never runs inside the write.
      queueMicrotask(() => {
        if (!done) handlers.onStdin(text);
      });
    },
    async closeStdin() {
      queueMicrotask(() => {
        if (!done) handlers.onStdinClosed();
      });
    },
    async kill(signal) {
      if (!done) handlers.onKill(signal ?? "SIGTERM");
    },
    exited,
  };

  return {
    process,
    stdout: (text) => {
      if (!done) stdout.push(encoder.encode(text));
    },
    stderr: (text) => {
      if (!done) stderr.push(encoder.encode(text));
    },
    exit,
    get exited() {
      return done;
    },
  };
}
