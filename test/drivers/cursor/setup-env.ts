// Process setup for every Cursor driver test. Import it before anything that
// loads the SDK.
//
// - The real @cursor/sdk resolves a model against Cursor's catalog over the
//   network unless CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON holds one (dist/esm
//   index.js, `listModelsForLocalValidation`). The fake SDK creates and
//   resumes agents with the real SDK, so the catalog is set here and nothing
//   goes to Cursor.
// - Cursor's SDK writes per-workspace data (transcripts, MCP descriptors)
//   under `$CURSOR_DATA_DIR/projects`, else `~/.cursor/projects` (dist/esm
//   977.js), and keeps its stored login in `~/.cursor/sdk/auth.json`. Tests
//   must never read or write the user's ~/.cursor, so HOME and the data
//   directory are temporary ones unless a test sets its own.
// - Every outbound connection to a host other than this machine is refused
//   and recorded, so a test that reached Cursor's hosted service would fail.

import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

export const FAKE_CURSOR_MODELS = [
  { id: "composer-2.5", displayName: "Composer 2.5", description: "Cursor's agent model", aliases: ["composer"] },
  { id: "gpt-5.5", displayName: "GPT-5.5" },
] as const;

process.env["CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON"] = JSON.stringify(FAKE_CURSOR_MODELS);

export const TEST_DATA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-cursor-data-")));
export const TEST_HOME = path.join(TEST_DATA_ROOT, "home");
fs.mkdirSync(TEST_HOME);
process.env["HOME"] = TEST_HOME;
process.env["CURSOR_DATA_DIR"] ??= path.join(TEST_DATA_ROOT, "cursor-data");
process.on("exit", () => fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

const attempts: string[] = [];

/** Every outbound connection a test made to a host other than this machine. */
export function networkAttempts(): readonly string[] {
  return [...attempts];
}

function isLocal(host: unknown): boolean {
  if (typeof host !== "string" || host === "") return true;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function hostOf(target: unknown): unknown {
  if (typeof target === "string") {
    try {
      return new URL(target).hostname;
    } catch {
      return target;
    }
  }
  if (target instanceof URL) return target.hostname;
  if (typeof target === "object" && target !== null) {
    const options = target as { hostname?: unknown; host?: unknown; path?: unknown; socketPath?: unknown };
    if (typeof options.socketPath === "string") return "";
    return options.hostname ?? options.host;
  }
  return undefined;
}

function refuse(name: string, host: unknown): never {
  attempts.push(`${name} ${String(host)}`);
  throw new Error(`The Cursor driver tests refuse outbound connections (${name} to ${String(host)})`);
}

const require = createRequire(import.meta.url);
for (const moduleName of ["node:http", "node:https"]) {
  const module = require(moduleName) as { request: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown };
  for (const name of ["request", "get"] as const) {
    const original = module[name];
    module[name] = (...args: unknown[]) => {
      const host = hostOf(args[0]);
      if (!isLocal(host)) refuse(`${moduleName}.${name}`, host);
      return original(...args);
    };
  }
}
{
  const http2 = require("node:http2") as { connect: (...args: unknown[]) => unknown };
  const original = http2.connect;
  http2.connect = (...args: unknown[]) => {
    const host = hostOf(args[0]);
    if (!isLocal(host)) refuse("node:http2.connect", host);
    return original(...args);
  };
}
for (const moduleName of ["node:net", "node:tls"]) {
  const module = require(moduleName) as { connect: (...args: unknown[]) => unknown; createConnection?: (...args: unknown[]) => unknown };
  for (const name of ["connect", "createConnection"] as const) {
    const original = module[name];
    if (typeof original !== "function") continue;
    module[name] = (...args: unknown[]) => {
      const first = args[0];
      const host = typeof first === "number" ? args[1] : hostOf(first);
      if (!isLocal(host)) refuse(`${moduleName}.${name}`, host);
      return original(...args);
    };
  }
}
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = hostOf(input instanceof Request ? input.url : input);
  if (!isLocal(host)) refuse("fetch", host);
  return originalFetch(input, init);
}) as typeof fetch;
