#!/usr/bin/env node
// `ari-driver`: serves one driver over `ari/wire` on stdin and stdout.
//
//   ari-driver <name>                       a first-party driver, ari/drivers/<name>
//   ari-driver <module path> [--export X]   any module that exports a driver
//
// Stdout carries protocol frames only. Before the driver loads, `console` and
// `process.stdout.write` are pointed at stderr, so a driver that logs cannot
// corrupt the protocol. The process serves until the host closes stdin (or
// sends SIGTERM or SIGINT), then disposes every instance and exits.
//
// Importing this module does nothing; it runs only as the program itself.

import { Console } from "node:console";
import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ARI_VERSION } from "../version.ts";
import { loadDriver } from "./load-driver.ts";
import { serveDriver } from "./server.ts";
import { streamTransport } from "./stdio.ts";

const USAGE = `Usage: ari-driver <driver> [--export <name>]

Serves one ARI driver over ari/wire (newline-delimited JSON-RPC 2.0) on stdin
and stdout.

  <driver>          a first-party driver name (pi, acp, codex, ...), or the path
                    of a module that exports a driver
  --export <name>   with a module path: the export that holds the driver
  --help            show this text
  --version         show the ARI contract version
`;

/** How long cleanup may take after the host goes away before the process exits anyway. */
const CLEANUP_LIMIT_MS = 10_000;

/** Runs `ari-driver` with `argv` (the arguments after the program) and resolves with its exit code. */
export async function runAriDriver(argv: readonly string[]): Promise<number> {
  let spec: string | undefined;
  let exportName: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (argument === "--version") {
      process.stdout.write(`ari-driver (ARI contract ${ARI_VERSION})\n`);
      return 0;
    }
    if (argument === "--export") {
      exportName = argv[index + 1];
      index += 1;
      if (exportName === undefined) {
        process.stderr.write("ari-driver: --export needs a name\n");
        return 2;
      }
      continue;
    }
    if (spec !== undefined) {
      process.stderr.write(`ari-driver: unexpected argument ${JSON.stringify(argument)}\n${USAGE}`);
      return 2;
    }
    spec = argument;
  }
  if (spec === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }

  // From here on stdout belongs to the protocol.
  const stdout = process.stdout;
  const protocolWrite = stdout.write.bind(stdout);
  const toStderr = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) =>
    (process.stderr.write as (...args: unknown[]) => boolean)(chunk, encodingOrCallback, callback)) as typeof stdout.write;
  stdout.write = toStderr;
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

  let driver;
  try {
    driver = await loadDriver(spec, exportName === undefined ? {} : { exportName });
  } catch (error) {
    process.stderr.write(`ari-driver: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const transport = streamTransport(process.stdin, stdout);
  const writeFrame = (frame: string): Promise<void> =>
    new Promise((resolve, reject) => {
      protocolWrite(frame, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  const server = serveDriver(driver, { ...transport, write: writeFrame }, {
    onProblem: (message) => process.stderr.write(`ari-driver: protocol problem: ${message}\n`),
  });

  const stop = (): void => void server.close();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await server.disconnected;
  // The host went away: dispose the instances, but never wait forever for a driver that hangs.
  await Promise.race([server.closed, delay(CLEANUP_LIMIT_MS)]);
  return 0;
}

/** True when this module is the program Node (or Bun) runs, not a module something imported. */
function isProgram(): boolean {
  const main = (import.meta as { main?: boolean }).main;
  if (typeof main === "boolean") return main;
  // Node before 22.18 and 24.2 has no import.meta.main; compare with the script it was started with.
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isProgram()) process.exit(await runAriDriver(process.argv.slice(2)));
