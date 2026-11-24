// Finding, starting and stopping OpenCode servers.
//
// - The generation comes from the version: `opencode --version` for a server
//   the driver starts (1.x prints `1.19.6`, 2.x prints `opencode v2.1.2`), or
//   the server itself for an external one (2.x answers `GET /api/info` with
//   `{ version, pid }`, 1.x answers `GET /global/health` with
//   `{ healthy: true, version }`). Major 2 and above is 2.x.
// - A started server is `opencode serve --hostname 127.0.0.1 --port 0`; it
//   prints the URL it listens on (1.x `opencode server listening on <url>`,
//   2.x `Server listening on <url>`). Every server the driver starts gets its
//   own random password: 1.x reads `OPENCODE_SERVER_PASSWORD`, 2.x
//   `OPENCODE_PASSWORD`. Both accept only HTTP Basic auth with the user name
//   `opencode`.

import { callErrors, toCallError } from "../../errors.ts";
import type { HostServices, SpawnedProcess } from "../../runtime.ts";
import type { OpencodeConfig } from "./config.ts";

export type Generation = 1 | 2;

export interface ServerEndpoint {
  readonly url: string;
  /** The `Authorization` header value, when the server has a password. */
  readonly authorization: string | undefined;
  readonly version: string;
  readonly generation: Generation;
  /** True for a server someone else runs: the driver never stops it. */
  readonly external: boolean;
  /** Settles when a server the driver started exits; never for an external one. */
  readonly exited: Promise<void>;
  readonly alive: boolean;
  /** Stops a server the driver started. Does nothing for an external server. */
  stop(): Promise<void>;
}

/** `1.19.6` or `opencode v2.1.2` → the dotted version. */
export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text)?.[1];
}

export function generationOf(version: string): Generation | undefined {
  const major = Number(/^(\d+)\./.exec(version)?.[1]);
  if (!Number.isInteger(major)) return undefined;
  if (major >= 2) return 2;
  return major === 1 ? 1 : undefined;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(/[.+-]/).slice(0, 3).map(Number);
  const right = b.split(/[.+-]/).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** True when `version` lies in a `>=x.y.z <a.b.c` range. */
export function versionInRange(version: string, range: string): boolean {
  const bounds = /^>=(\S+)\s+<(\S+)$/.exec(range.trim());
  if (bounds === null || parseVersion(version) === undefined) return false;
  return compareVersions(version, bounds[1]!) >= 0 && compareVersions(version, bounds[2]!) < 0;
}

export function basicAuthorization(password: string): string {
  const bytes = new TextEncoder().encode(`opencode:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function randomPassword(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

/** Runs `opencode --version` through the host and returns its version. Only ever spawns the CLI with `--version`. */
export async function cliVersion(host: HostServices<OpencodeConfig>, executable: string): Promise<{ version: string | undefined; ok: boolean; output: string }> {
  const child = await host.process.spawn({ command: executable, args: ["--version"], purpose: "probe", stdin: "ignore", timeoutMs: 15_000 });
  const [stdout] = await Promise.all([readAll(child.stdout), readAll(child.stderr)]);
  const exit = await child.exited;
  return { version: parseVersion(stdout), ok: exit.code === 0, output: stdout.trim() };
}

/** Asks a running server for its version without changing anything: `GET /api/info` (2.x), then `GET /global/health` (1.x). */
export async function serverVersion(url: string, authorization: string | undefined, signal?: AbortSignal): Promise<{ version: string; generation: Generation }> {
  const headers: { [name: string]: string } = authorization === undefined ? {} : { authorization };
  for (const path of ["/api/info", "/global/health"] as const) {
    let response: Response;
    try {
      response = await fetch(`${url.replace(/\/+$/, "")}${path}`, { headers, ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      throw callErrors.transport(`Could not reach the OpenCode server at ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw callErrors.authRequired([], "The OpenCode server rejected the server password (store it as the instance secret opencode/server-password)");
    }
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (response.status !== 200 || type !== "application/json") {
      await response.body?.cancel();
      continue;
    }
    const body = (await response.json().catch(() => undefined)) as { version?: unknown; pid?: unknown; healthy?: unknown } | undefined;
    const version = typeof body?.version === "string" ? body.version : undefined;
    // 2.x's /api/info carries a pid; 1.x's /global/health says healthy. Either proves it is OpenCode.
    const isOpencode = path === "/api/info" ? typeof body?.pid === "number" : body?.healthy === true;
    const generation = version === undefined ? undefined : generationOf(version);
    if (isOpencode && version !== undefined && generation !== undefined) return { version, generation };
  }
  throw callErrors.protocol("not_opencode", `The server at ${url} did not identify itself as an OpenCode server`);
}

/** An OpenCode server someone else runs. */
export function externalEndpoint(url: string, authorization: string | undefined, version: string, generation: Generation): ServerEndpoint {
  return {
    url: url.replace(/\/+$/, ""),
    authorization,
    version,
    generation,
    external: true,
    exited: new Promise<void>(() => undefined),
    alive: true,
    stop: async () => undefined,
  };
}

export interface StartServerInput {
  readonly executable: string;
  readonly version: string;
  readonly generation: Generation;
  readonly cwd: string | undefined;
  /** The instance's environment; the driver adds the server password. */
  readonly environment: { readonly [name: string]: string };
  readonly timeoutMs: number;
}

/** Starts `opencode serve` on a free loopback port through the host and waits until it listens. */
export async function startServer(host: HostServices<OpencodeConfig>, input: StartServerInput): Promise<ServerEndpoint> {
  const password = randomPassword();
  const passwordVariable = input.generation === 1 ? "OPENCODE_SERVER_PASSWORD" : "OPENCODE_PASSWORD";
  let child: SpawnedProcess;
  try {
    child = await host.process.spawn({
      command: input.executable,
      args: ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      env: { ...input.environment, [passwordVariable]: password },
      purpose: "runtime",
      stdin: "ignore",
    });
  } catch (error) {
    throw toCallError(error) !== undefined ? error : callErrors.transport(`opencode serve could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  let alive = true;
  let stderrTail = "";
  const exited = child.exited.then(() => {
    alive = false;
  });
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of child.stderr) stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(-2000);
  })().catch(() => undefined);

  const listening = new Promise<string>((resolve, reject) => {
    void (async () => {
      const lines = new TextDecoder();
      let buffer = "";
      let found = false;
      try {
        for await (const chunk of child.stdout) {
          if (found) continue;
          buffer += lines.decode(chunk, { stream: true });
          const match = /listening on (https?:\/\/[^\s]+)/i.exec(buffer);
          if (match !== null) {
            found = true;
            resolve(match[1]!.replace(/\/+$/, ""));
          } else if (buffer.length > 64 * 1024) buffer = buffer.slice(-1024);
        }
      } catch (error) {
        if (!found) reject(error);
        return;
      }
      if (!found) reject(callErrors.transport(`opencode serve exited before it listened${stderrTail === "" ? "" : `: ${stderrTail.trim()}`}`));
    })();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = await Promise.race([
      listening,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(callErrors.transport(`opencode serve did not listen within ${input.timeoutMs} ms`)), input.timeoutMs);
      }),
    ]);
    return {
      url,
      authorization: basicAuthorization(password),
      version: input.version,
      generation: input.generation,
      external: false,
      exited,
      get alive() {
        return alive;
      },
      async stop() {
        if (!alive) return;
        await child.kill("SIGTERM").catch(() => undefined);
        await exited;
      },
    };
  } catch (error) {
    await child.kill("SIGKILL").catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
