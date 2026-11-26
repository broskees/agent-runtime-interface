// The process tap: wraps the `HostServices.process` a recorder hands a stdio
// driver, and records the traffic between the driver and every process it
// starts, as stdio frames (./frames.ts):
//   - the spawn request, with the names of its environment variables and
//     never their values;
//   - each line the driver writes to stdin, when it writes it;
//   - each line of stdout and stderr, when the driver's reader takes the chunk
//     that holds it;
//   - the driver closing stdin or killing the process;
//   - the exit, when the process exits.
// It knows nothing of the protocol on the pipes, so any stdio driver records
// through it. `resolveExecutable` and `envPolicy` pass through unrecorded.

import type { Frame } from "../format.ts";
import type { HostServices, SpawnedProcess } from "../../../src/runtime.ts";
import type { SpawnRequest } from "../../../src/generated/host.ts";
import { LineSplitter, lineFrame } from "./frames.ts";

type ProcessService = HostServices["process"];

export interface ProcessTap {
  /** The process service to hand the driver. */
  readonly process: ProcessService;
  /**
   * Resolves true once every process the driver started has exited and the
   * driver's readers of its stdout and stderr (those it began reading) have
   * ended, or false after `timeoutMs`.
   */
  settled(timeoutMs: number): Promise<boolean>;
}

/** The spawn request as a frame: the environment as its variable names, sorted. */
export function spawnFrame(proc: number, request: SpawnRequest): Frame {
  return {
    dir: "out",
    kind: "spawn",
    proc,
    command: request.command,
    args: [...(request.args ?? [])],
    envNames: Object.keys(request.env ?? {}).sort(),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  };
}

export function tapProcess(inner: ProcessService, record: (frame: Frame) => void): ProcessTap {
  let spawned = 0;
  const done: Array<Promise<unknown>> = [];

  const spawn = async (request: SpawnRequest): Promise<SpawnedProcess> => {
    spawned += 1;
    const proc = spawned;
    record(spawnFrame(proc, request));
    let child: SpawnedProcess;
    try {
      child = await inner.spawn(request);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      record({ dir: "in", kind: "spawn_failed", proc, error: { message: error instanceof Error ? error.message : String(error), ...(typeof code === "string" ? { code } : {}) } });
      throw error;
    }

    const exited = child.exited.then((exit) => {
      record({ dir: "in", kind: "exit", proc, code: exit.code, signal: exit.signal });
      return exit;
    });
    done.push(exited);

    /** One of the child's output pipes, recording each line as the driver's reader takes it. */
    const output = (source: AsyncIterable<Uint8Array>, kind: "stdout" | "stderr"): AsyncIterable<Uint8Array> => ({
      [Symbol.asyncIterator]: () => {
        let ended!: () => void;
        done.push(new Promise<void>((resolve) => (ended = resolve)));
        const splitter = new LineSplitter();
        const lines = (async function* (): AsyncGenerator<Uint8Array> {
          try {
            for await (const chunk of source) {
              for (const line of splitter.push(chunk)) record(lineFrame("in", kind, proc, line));
              yield chunk;
            }
            const rest = splitter.end();
            if (rest !== "") record(lineFrame("in", kind, proc, rest, true));
          } finally {
            ended();
          }
        })();
        return lines;
      },
    });

    const stdin = new LineSplitter();
    return {
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      stdout: output(child.stdout, "stdout"),
      stderr: output(child.stderr, "stderr"),
      exited,
      write: async (data) => {
        for (const line of stdin.push(data)) record(lineFrame("out", "stdin", proc, line));
        await child.write(data);
      },
      closeStdin: async () => {
        const rest = stdin.end();
        if (rest !== "") record(lineFrame("out", "stdin", proc, rest, true));
        record({ dir: "out", kind: "close_stdin", proc });
        await child.closeStdin();
      },
      kill: async (signal) => {
        record({ dir: "out", kind: "kill", proc, ...(signal === undefined ? {} : { signal }) });
        await child.kill(signal);
      },
    };
  };

  return {
    process: {
      envPolicy: inner.envPolicy,
      spawn,
      resolveExecutable: (name, options) => inner.resolveExecutable(name, options),
    },
    settled: async (timeoutMs) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
      try {
        // A pipe the driver begins reading meanwhile adds to `done`: look again until nothing new came.
        for (let seen = -1; seen !== done.length; ) {
          seen = done.length;
          if ((await Promise.race([Promise.all(done.slice()).then(() => true as const), timedOut])) === false) return false;
        }
        return true;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
