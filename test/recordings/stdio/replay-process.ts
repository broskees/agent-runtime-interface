// The replay process service: the `HostServices.process` a stdio driver gets
// on replay. Its `spawn` answers with a child that plays the recording back
// through the kit's sequencer (../sequencer.ts) instead of starting anything:
//   - each spawn request, each line the driver writes to stdin, each stdin
//     close and each kill is compared with the next recorded frame, as parsed
//     JSON, after the replay's own sanitiser; a frame other than the recorded
//     one fails the write (or the spawn, close or kill) with a ReplayDriftError
//     naming the recording file, the line and both frames;
//   - each recorded stdout and stderr line goes to the child's pipe once every
//     frame before it has happened, and counts as taken when the driver's
//     reader takes it off the pipe; the exit settles `exited` and counts as
//     taken then. A pipe ends once the exit came and the last line recorded
//     for that pipe was handed over, wherever the recording holds it: a
//     process may exit before the driver read its last output, and a driver
//     that drains a pipe apart from waiting for the exit (an ACP driver's
//     stderr) may start the next process before it reads the first one's last
//     line. So each pipe stays open until its own recorded end.
// Once replay has failed, every process ends at once (exit by SIGKILL, pipes
// closed after what they hold), so the driver's cleanup does not wait for
// frames that will never come; the failure is what the replay reports.
// It imports no driver code and no fake: it plays any stdio driver's
// recording.

import type { EnvPolicy, ProcessExit, SpawnRequest } from "../../../src/generated/host.ts";
import type { HostServices, SpawnedProcess } from "../../../src/runtime.ts";
import type { Frame, Recording } from "../format.ts";
import type { NativeProgress } from "../scenarios.ts";
import { restoreWorkspace } from "../sanitiser.ts";
import type { Sanitiser } from "../sanitiser.ts";
import { ReplaySequencer, showFrame } from "../sequencer.ts";
import type { IgnoredField } from "../sequencer.ts";
import { LineSplitter, lineFrame, lineText, procOf } from "./frames.ts";
import { spawnFrame } from "./tap.ts";

export interface StdioReplayOptions {
  /** The replay's own workspace: it stands where the recording says <WORKSPACE>. */
  readonly workspace: string;
  /** Sanitises each frame the driver sends before it is compared, as the recorder sanitised what it recorded. */
  readonly sanitise: Sanitiser;
  /** The fields the comparison leaves out; only those of the recording's driver apply. */
  readonly ignored: readonly IgnoredField[];
  /** The environment rule the service declares to the driver. */
  readonly envPolicy: EnvPolicy;
}

export interface StdioReplay {
  readonly process: HostServices["process"];
  readonly sequencer: ReplaySequencer;
  readonly progress: NativeProgress;
}

/** One pipe of a replayed child: recorded lines wait here until the driver's reader takes them. */
class ReplayPipe {
  readonly #taken: (line: number) => void;
  readonly #queue: Array<{ line: number; bytes: Uint8Array }> = [];
  #ended = false;
  #wake: (() => void) | undefined;
  /** Lines handed to this pipe so far. */
  delivered = 0;

  constructor(taken: (line: number) => void) {
    this.#taken = taken;
  }

  push(line: number, text: string): void {
    this.delivered += 1;
    this.#queue.push({ line, bytes: new TextEncoder().encode(text) });
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  get ended(): boolean {
    return this.#ended;
  }

  readonly iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        for (;;) {
          const next = this.#queue.shift();
          if (next !== undefined) {
            // The driver's reader takes the line now.
            this.#taken(next.line);
            return { done: false, value: next.bytes };
          }
          if (this.#ended) return { done: true, value: undefined };
          await new Promise<void>((resolve) => (this.#wake = resolve));
          this.#wake = undefined;
        }
      },
      return: async (): Promise<IteratorResult<Uint8Array>> => ({ done: true, value: undefined }),
    }),
  };
}

/** One replayed child process. */
class ReplayChild {
  readonly proc: number;
  readonly stdout: ReplayPipe;
  readonly stderr: ReplayPipe;
  /** Once the exit came: how many lines each pipe gets in all before it ends. */
  #lines: { readonly stdout: number; readonly stderr: number } | undefined;
  readonly exited: Promise<ProcessExit>;
  #exit!: (exit: ProcessExit) => void;
  #hasExited = false;
  failure: { line: number; message: string; code?: string } | undefined;

  constructor(proc: number, taken: (line: number) => void) {
    this.proc = proc;
    this.stdout = new ReplayPipe(taken);
    this.stderr = new ReplayPipe(taken);
    this.exited = new Promise((resolve) => (this.#exit = resolve));
  }

  get hasExited(): boolean {
    return this.#hasExited;
  }

  /** The process exited; each pipe ends once it has handed over `lines` lines in all, every line the recording holds for it. */
  exit(exit: ProcessExit, lines: { readonly stdout: number; readonly stderr: number }): void {
    this.#hasExited = true;
    this.#lines = lines;
    this.#exit(exit);
    this.endPipes();
  }

  /** Replay failed: the process ends at once, with what it had, so a driver cleaning up after the failure is not left waiting for it. */
  abandon(): void {
    if (!this.#hasExited) {
      this.#hasExited = true;
      this.#exit({ code: null, signal: "SIGKILL" });
    }
    if (!this.stdout.ended) this.stdout.end();
    if (!this.stderr.ended) this.stderr.end();
  }

  /** Ends each pipe once the process exited and the last line recorded for the pipe was handed over. */
  endPipes(): void {
    if (this.#lines === undefined) return;
    if (!this.stdout.ended && this.stdout.delivered >= this.#lines.stdout) this.stdout.end();
    if (!this.stderr.ended && this.stderr.delivered >= this.#lines.stderr) this.stderr.end();
  }
}

export function startStdioReplay(recording: Recording, options: StdioReplayOptions): StdioReplay {
  const children = new Map<number, ReplayChild>();
  // For each process: how many lines the recording holds for each of its pipes, wherever they are.
  const linesOf = new Map<number, { stdout: number; stderr: number }>();
  for (const { frame } of recording.frames) {
    if (frame.kind !== "stdout" && frame.kind !== "stderr") continue;
    const counts = linesOf.get(procOf(frame)) ?? { stdout: 0, stderr: 0 };
    counts[frame.kind] += 1;
    linesOf.set(procOf(frame), counts);
  }

  const sequencer: ReplaySequencer = new ReplaySequencer({
    recording,
    ignored: options.ignored,
    deliver: (recorded, line) => {
      const frame = restoreWorkspace(recorded, options.workspace);
      const child = children.get(procOf(frame));
      if (child === undefined) throw new Error(`the frame belongs to process ${String(frame["proc"])}, which the driver has not started`);
      switch (frame.kind) {
        case "stdout":
        case "stderr":
          if (child[frame.kind].ended) throw new Error(`the ${frame.kind} of process ${child.proc} has ended`);
          child[frame.kind].push(line, lineText(frame));
          child.endPipes();
          return;
        case "exit":
          child.exit({ code: (frame["code"] ?? null) as number | null, signal: (frame["signal"] ?? null) as string | null }, linesOf.get(child.proc) ?? { stdout: 0, stderr: 0 });
          // `exited` settles now: the driver has it.
          queueMicrotask(() => sequencer.taken(line));
          return;
        case "spawn_failed": {
          const error = (frame["error"] ?? {}) as { message?: unknown; code?: unknown };
          child.failure = { line, message: String(error.message ?? "the spawn failed"), ...(typeof error.code === "string" ? { code: error.code } : {}) };
          return;
        }
        default:
          throw new Error(`replay cannot deliver a ${frame.kind} frame`);
      }
    },
  });

  // After a drift nothing more is delivered: every process ends, as a host's processes end when it gives up on them.
  sequencer.onChange(() => {
    if (sequencer.failure !== undefined) for (const child of children.values()) child.abandon();
  });

  /** Compares a frame the driver sent with the next recorded one. */
  const send = (frame: Frame): void => sequencer.send(options.sanitise(frame));

  const spawn = async (request: SpawnRequest): Promise<SpawnedProcess> => {
    const proc = children.size + 1;
    const child = new ReplayChild(proc, (line) => sequencer.taken(line));
    children.set(proc, child);
    send(spawnFrame(proc, request));
    if (child.failure !== undefined) {
      sequencer.taken(child.failure.line);
      throw Object.assign(new Error(child.failure.message), child.failure.code === undefined ? {} : { code: child.failure.code });
    }
    const stdin = new LineSplitter();
    return {
      stdout: child.stdout.iterable,
      stderr: child.stderr.iterable,
      exited: child.exited,
      write: async (data) => {
        for (const line of stdin.push(data)) send(lineFrame("out", "stdin", proc, line));
      },
      closeStdin: async () => {
        const rest = stdin.end();
        if (rest !== "") send(lineFrame("out", "stdin", proc, rest, true));
        send({ dir: "out", kind: "close_stdin", proc });
      },
      kill: async (signal) => {
        send({ dir: "out", kind: "kill", proc, ...(signal === undefined ? {} : { signal }) });
        // As a host's kill does, this returns once the process is gone.
        await child.exited;
      },
    };
  };

  /** Each pipe of an exited process that stays open for a line recorded later, with that line: a driver waiting for the pipe's end waits for it. */
  const heldOpen = (): string =>
    [...children.values()]
      .filter((child) => child.hasExited)
      .flatMap((child) =>
        (["stdout", "stderr"] as const).flatMap((kind) => {
          if (child[kind].ended) return [];
          const next = recording.frames.filter((entry) => entry.frame.kind === kind && procOf(entry.frame) === child.proc)[child[kind].delivered];
          return next === undefined ? [] : [`\n  held open: the ${kind} of process ${child.proc}, which exited, ends after its line ${next.line}: ${showFrame(next.frame)}`];
        }),
      )
      .join("");

  sequencer.start();
  return {
    process: {
      envPolicy: options.envPolicy,
      spawn,
      // Nothing runs on replay: every executable is there.
      resolveExecutable: async (name) => name,
    },
    sequencer,
    progress: {
      failure: () => sequencer.failure,
      describe: (what) => `${sequencer.describe(what)}${heldOpen()}`,
      onChange: (listener) => sequencer.onChange(listener),
    },
  };
}
