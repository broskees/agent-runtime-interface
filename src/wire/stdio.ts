// Node transports for `ari/wire`: a pair of streams (such as a process's own
// stdin and stdout), and `startAriDriver`, which spawns `ari-driver` and
// connects to it over the child's stdio.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { callErrors, isAriError } from "../errors.ts";
import type { WireTransport } from "./connection.ts";
import { connectDriver } from "./client.ts";
import type { ConnectDriverOptions, WireDriverConnection } from "./client.ts";

/** A transport over a readable and a writable stream. Writes wait for the stream to take the frame. */
export function streamTransport(input: Readable, output: Writable, options: { readonly endOutputOnClose?: boolean } = {}): WireTransport {
  return {
    input,
    write: (frame) =>
      new Promise<void>((resolve, reject) => {
        output.write(frame, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    close: () => {
      if (options.endOutputOnClose !== false && !output.writableEnded && !output.destroyed) output.end();
    },
  };
}

/** The `ari-driver` program of this package, run by the current Node: the bin `package.json` declares. */
export function defaultAriDriverCommand(): string[] {
  // In the published package this module is dist/wire/stdio.js and the bin dist/wire/cli.js;
  // run from source, both are .ts files.
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return [process.execPath, fileURLToPath(new URL(`./cli${extension}`, import.meta.url))];
}

export interface StartAriDriverOptions extends ConnectDriverOptions {
  /** A first-party driver name such as `pi`, or the path of a module that exports a driver. */
  readonly driver: string;
  /** With a module path: the export that holds the driver, when the module exports several. */
  readonly exportName?: string;
  /** The program and leading arguments that run `ari-driver`. Defaults to `defaultAriDriverCommand()`. */
  readonly command?: readonly string[];
  /** The environment `ari-driver` runs with. Defaults to this process's. */
  readonly env?: { readonly [name: string]: string | undefined };
  readonly cwd?: string;
  /** How long `close()` waits for the process to exit before killing it. Defaults to 5000 ms. */
  readonly exitGraceMs?: number;
}

export interface AriDriverProcess extends WireDriverConnection {
  /** The `ari-driver` process. */
  readonly child: ChildProcess;
  /** The last few kilobytes `ari-driver` wrote to stderr. */
  stderrTail(): string;
}

const STDERR_TAIL_BYTES = 8192;

/** Spawns `ari-driver` serving `options.driver` and connects to it over its stdio. */
export async function startAriDriver(options: StartAriDriverOptions): Promise<AriDriverProcess> {
  const [program, ...leading] = options.command ?? defaultAriDriverCommand();
  if (program === undefined) throw new TypeError("startAriDriver: the command is empty");
  const args = [...leading, options.driver, ...(options.exportName === undefined ? [] : ["--export", options.exportName])];
  const child = spawn(program, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...(options.env ?? process.env) },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    stderr = (stderr + text).slice(-STDERR_TAIL_BYTES);
  });
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  // "close" comes after the process exited and its stdio closed, so stderr is complete by then.
  const exited = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      exit = { code, signal };
      resolve();
    });
    child.once("error", (error) => {
      spawnError = error;
      resolve();
    });
  });
  child.stdin.on("error", () => undefined);

  const describeClose = (): string => {
    const how =
      spawnError !== undefined
        ? `could not start (${spawnError.message})`
        : exit === undefined
          ? "closed its output"
          : exit.signal !== null
            ? `was killed by ${exit.signal}`
            : `exited with code ${exit.code}`;
    const tail = stderr.trim();
    return `The ari-driver process ${how}${tail === "" ? "" : `; its stderr ends with: ${tail.slice(-1000)}`}`;
  };

  const transport = streamTransport(child.stdout, child.stdin);
  let connection: WireDriverConnection;
  try {
    connection = await connectDriver(transport, { ...options, describeClose });
  } catch (error) {
    if (isAriError(error, "transport")) {
      // It died while starting: wait a moment for its exit status and last words.
      await Promise.race([exited, delay(2000, undefined, { ref: false })]);
      child.kill("SIGKILL");
      throw callErrors.transport(describeClose());
    }
    child.kill("SIGKILL");
    throw error;
  }
  const exitGraceMs = options.exitGraceMs ?? 5000;
  return {
    ...connection,
    child,
    stderrTail: () => stderr,
    async close() {
      await connection.close();
      // ari-driver exits when its stdin closes; give it a moment to dispose its instances.
      // node:timers keeps real time even while a conformance virtual clock is installed.
      // The grace timer does not keep the host process alive.
      const gone = await Promise.race([exited.then(() => true), delay(exitGraceMs, false, { ref: false })]);
      if (!gone) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}
