import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { HostServices } from "../../runtime.ts";
import type { ClaudeQueryOptions, ClaudeSpawnedProcess } from "./sdk.ts";

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

/** The SDK needs a ChildProcess-shaped handle now; a host (including a wire host) returns its child asynchronously. */
export function claudeProcessOptions<Config>(host: HostServices<Config>, executable: string, stderr?: (data: string) => void): ClaudeQueryOptions {
  return {
    pathToClaudeCodeExecutable: executable,
    // SDK recommendation for an app launching its own compatible executable.
    mcpServersDelivery: "initialize",
    ...(stderr === undefined ? {} : { stderr }),
    spawnClaudeCodeProcess(this: Pick<ClaudeQueryOptions, "stderr"> | undefined, { command, args, cwd, env, signal }): ClaudeSpawnedProcess {
      // The pinned transport calls this as a method on its options (which
      // include stderr). This lets an SDK tap wrap stderr as before.
      const onStderr = this?.stderr ?? stderr;
      const events = new EventEmitter<{ exit: [number | null, NodeJS.Signals | null]; error: [Error] }>();
      const child = Promise.resolve().then(() => host.process.spawn({
        command,
        args,
        ...(cwd === undefined ? {} : { cwd }),
        env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        // The SDK's env replaces the parent environment. Merging at the host
        // would restore credentials (and NODE_OPTIONS) the driver or SDK removed.
        inheritEnv: false,
        purpose: "runtime",
        stdin: "pipe",
      }));
      let ended = false;
      let killed = false;
      let exitCode: number | null = null;
      let signalCode: NodeJS.Signals | null = null;
      const emitError = (error: unknown): void => { events.emit("error", asError(error)); };
      // This is the SDK's forwarded signal, not the caller's raw abort. The
      // SDK ends stdin first and only aborts this signal after its grace window.
      const abort = (): void => { void child.then((process) => process.kill(), () => undefined).catch(emitError); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();

      const finished = child.then(async (process) => {
        // Custom spawns get no SDK stderr reader. Drain even without a callback.
        const drainStderr = (async () => {
          const decoder = new TextDecoder();
          for await (const bytes of process.stderr) {
            const text = decoder.decode(bytes, { stream: true });
            if (text !== "") onStderr?.(text);
          }
          const tail = decoder.decode();
          if (tail !== "") onStderr?.(tail);
        })().catch(emitError);
        const exit = await process.exited;
        exitCode = exit.code;
        signalCode = exit.signal as NodeJS.Signals | null;
        ended = true;
        events.emit("exit", exitCode, signalCode);
        await drainStderr;
      }).catch((error: unknown) => {
        ended = true;
        emitError(error);
      }).finally(() => signal.removeEventListener("abort", abort));

      return {
        stdin: new Writable({
          write(chunk: Buffer, _encoding, done) {
            void child.then((process) => process.write(chunk)).then(() => done(), (error: unknown) => done(asError(error)));
          },
          final(done) {
            void child.then((process) => process.closeStdin()).then(() => done(), (error: unknown) => done(asError(error)));
          },
        }),
        stdout: Readable.from((async function* () {
          const process = await child.catch(() => undefined);
          if (process !== undefined) yield* process.stdout;
          // Deliver exit/error before EOF, so the SDK does not miss an exit
          // when a host delivers the output and lifecycle on separate channels.
          await finished;
        })(), { objectMode: false }),
        get killed() { return killed; },
        get exitCode() { return exitCode; },
        get signalCode() { return signalCode; },
        kill(signal) {
          if (ended) return false;
          killed = true;
          void child.then((process) => process.kill(signal), () => undefined).catch(emitError);
          return true;
        },
        on: events.on.bind(events),
        once: events.once.bind(events),
        off: events.off.bind(events),
      };
    },
  };
}
