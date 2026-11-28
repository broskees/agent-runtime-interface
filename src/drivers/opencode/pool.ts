// The servers of one instance, and which host MCP entries each thread put on them.
//
// - 1.x, started by the driver: one server per thread (`process_per_thread`).
//   A 1.x server keeps "always" grants in memory for the whole directory
//   (1.x `permission/index.ts` `approved`), and those grants win over a
//   session's own rules there, so threads never share a 1.x server the driver
//   starts.
// - 2.x, started by the driver: one server per instance, shared by every
//   session (`process_per_instance`), stopped only by `dispose()`.
// - Any external server (`serverUrl`): shared, never started or stopped.
//
// MCP registrations are per directory on a server (1.x the directory's
// instance, 2.x the location), so threads that share one see each other's
// entries. The registry here knows every thread's entries per server: their
// names, directory and config. When a thread adds its own, every other thread
// on that server first gets deny rules for them (see rules.ts). Threads in one
// directory that ask for the same server under one name share its entry, which
// stays until the last of them leaves; asking for a different server under a
// name another thread holds there is refused, because OpenCode keeps one entry
// per name and the second would replace the first.

import { CliTooOldError } from "../../driver-kit/cli-too-old.ts";
import { withoutHostStripped } from "../../driver-kit/env-policy.ts";
import { callErrors } from "../../errors.ts";
import type { HostServices } from "../../runtime.ts";
import type { ServerShape } from "./capabilities.ts";
import { OPENCODE_PASSWORD_VARIABLES, OPENCODE_UPDATE_STEP, SERVER_PASSWORD_SECRET } from "./config.ts";
import type { OpencodeConfig } from "./config.ts";
import type { NativeRuntime } from "./native.ts";
import { collidingName } from "./rules.ts";
import { loadSdk } from "./sdk.ts";
import type { OpencodeSdkLoaders } from "./sdk.ts";
import { basicAuthorization, belowMinimum, cliVersion, externalEndpoint, generationOf, minimumVersionFor, serverVersion, startServer } from "./server.ts";
import type { Generation, ServerEndpoint } from "./server.ts";
import { V1Runtime } from "./v1.ts";
import { V2Runtime } from "./v2.ts";

export interface Link {
  readonly endpoint: ServerEndpoint;
  readonly runtime: NativeRuntime;
}

/** What the instance found: the server generation and version, and how to reach or start it. */
export interface Detected {
  readonly generation: Generation;
  readonly version: string;
  readonly external: boolean;
  /** The `opencode` executable, for a server the driver starts. */
  readonly executable?: string;
  /** The external server's URL and authorization. */
  readonly url?: string;
  readonly authorization?: string;
}

interface Owner {
  readonly directory: string;
  /** Entry names, each with its config as `mcpConfigKey` writes it. */
  readonly entries: ReadonlyMap<string, string>;
  readonly onOthers: (others: string[]) => Promise<void>;
}

/** An MCP config as one string, keys sorted, so two threads' requests for the same server compare equal. */
export function mcpConfigKey(config: unknown): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as { [key: string]: unknown })[key])]),
    );
  };
  return JSON.stringify(sorted(config));
}

export class ServerPool {
  readonly #host: HostServices<OpencodeConfig>;
  readonly #config: OpencodeConfig;
  readonly #environment: { readonly [name: string]: string };
  readonly #loaders: OpencodeSdkLoaders;
  #shared: Promise<Link> | undefined;
  /** Host MCP entries by server, then by owning thread. */
  readonly #owners = new Map<ServerEndpoint, Map<string, Owner>>();
  #disposed = false;

  constructor(host: HostServices<OpencodeConfig>, config: OpencodeConfig, environment: { readonly [name: string]: string }, loaders: OpencodeSdkLoaders) {
    this.#host = host;
    this.#config = config;
    // The instance's environment as given, minus only what the host strips, and minus the password variables: every
    // server the driver starts gets its own password there, a launch variable the driver sets itself.
    const passwords = new Set<string>(OPENCODE_PASSWORD_VARIABLES);
    const given = withoutHostStripped(environment, host.process.envPolicy.stripAmbient);
    this.#environment = Object.fromEntries(Object.entries(given).filter(([name]) => !passwords.has(name)));
    this.#loaders = loaders;
  }

  get environment(): { readonly [name: string]: string } {
    return this.#environment;
  }

  get external(): boolean {
    return this.#config.serverUrl !== undefined && this.#config.serverUrl !== "";
  }

  async #externalAuthorization(): Promise<string | undefined> {
    const stored = await this.#host.secrets.get(SERVER_PASSWORD_SECRET.namespace, SERVER_PASSWORD_SECRET.key);
    return stored === null ? undefined : basicAuthorization(new TextDecoder().decode(stored));
  }

  unavailableBinary() {
    return callErrors.driverUnavailable({ binary: this.#config.binary, installHint: "Install OpenCode (https://opencode.ai) and make sure `opencode` is on PATH, or set the driver's binary config." }, `OpenCode is not installed: ${this.#config.binary} was not found`);
  }

  /**
   * Finds the server generation and version. Starts nothing and writes nothing: `opencode --version`, or a read of the
   * external server's info. A local CLI older than its generation's minimum throws `CliTooOldError`, so it never starts.
   */
  async detect(): Promise<Detected> {
    if (this.external) {
      const url = this.#config.serverUrl!;
      const authorization = await this.#externalAuthorization();
      const found = await serverVersion(url, authorization);
      return { generation: found.generation, version: found.version, external: true, url, ...(authorization === undefined ? {} : { authorization }) };
    }
    // Found, probed and started with the instance's environment alike. Keep `path` for hosts that read only it.
    const env = { ...this.#environment };
    const executable = await this.#host.process.resolveExecutable(this.#config.binary, { env, ...(env["PATH"] === undefined ? {} : { path: env["PATH"] }) });
    if (executable === null) throw this.unavailableBinary();
    const found = await cliVersion(this.#host, executable, env);
    if (found.ok && found.version !== undefined && belowMinimum(found.version)) throw this.#tooOld(found.version, executable);
    const generation = found.version === undefined ? undefined : generationOf(found.version);
    if (!found.ok || found.version === undefined || generation === undefined) throw callErrors.protocol("unknown_version", `Could not tell the OpenCode version from \`${this.#config.binary} --version\`: ${JSON.stringify(found.output)}`);
    return { generation, version: found.version, external: false, executable };
  }

  #tooOld(version: string, where: string): CliTooOldError {
    return new CliTooOldError({ name: "OpenCode", binary: this.#config.binary, version, path: where, minimum: minimumVersionFor(version), updateStep: OPENCODE_UPDATE_STEP });
  }

  async #runtime(endpoint: ServerEndpoint): Promise<NativeRuntime> {
    if (endpoint.generation === 1) return new V1Runtime(await loadSdk(1, this.#loaders), endpoint);
    return new V2Runtime(await loadSdk(2, this.#loaders), endpoint);
  }

  /** The instance's shared server: an external one, or the one 2.x server the driver starts. */
  async shared(detected: Detected, timeoutMs: number): Promise<Link> {
    if (this.#disposed) throw callErrors.invalidState("instance_disposed");
    const current = this.#shared;
    if (current !== undefined) {
      const link = await current.catch(() => undefined);
      if (link !== undefined && link.endpoint.alive && link.endpoint.version === detected.version) return link;
      if (link !== undefined && !link.endpoint.external) await link.endpoint.stop();
      this.#shared = undefined;
    }
    const started = (async (): Promise<Link> => {
      const endpoint = detected.external
        ? externalEndpoint(detected.url!, detected.authorization, detected.version, detected.generation)
        : await startServer(this.#host, { executable: detected.executable!, version: detected.version, generation: detected.generation, cwd: undefined, environment: this.#environment, timeoutMs });
      try {
        return { endpoint, runtime: await this.#runtime(endpoint) };
      } catch (error) {
        await endpoint.stop();
        throw error;
      }
    })();
    this.#shared = started;
    started.catch(() => {
      if (this.#shared === started) this.#shared = undefined;
    });
    return started;
  }

  /** A server of its own for one 1.x thread, started in the thread's directory. */
  async dedicated(detected: Detected, cwd: string | undefined, timeoutMs: number): Promise<Link> {
    if (this.#disposed) throw callErrors.invalidState("instance_disposed");
    const endpoint = await startServer(this.#host, { executable: detected.executable!, version: detected.version, generation: detected.generation, cwd, environment: this.#environment, timeoutMs });
    try {
      return { endpoint, runtime: await this.#runtime(endpoint) };
    } catch (error) {
      await endpoint.stop();
      throw error;
    }
  }

  /** The server a thread runs on, by the instance's shape. */
  async linkFor(detected: Detected, shape: ServerShape, cwd: string | undefined, timeoutMs: number): Promise<Link> {
    if (shape.generation === 1 && !shape.external) return this.dedicated(detected, cwd, timeoutMs);
    return this.shared(detected, timeoutMs);
  }

  /** The entry names every thread but `owner` holds on `endpoint`, less the names `owner` holds itself. */
  othersOn(endpoint: ServerEndpoint, owner: string): string[] {
    const owners = this.#owners.get(endpoint);
    if (owners === undefined) return [];
    const own = owners.get(owner)?.entries ?? new Map<string, string>();
    return [...new Set([...owners.entries()].filter(([id]) => id !== owner).flatMap(([, entry]) => [...entry.entries.keys()].filter((name) => !own.has(name))))];
  }

  /** The entries `owner` holds on `endpoint`. */
  entriesOf(endpoint: ServerEndpoint, owner: string): ReadonlyMap<string, string> {
    return this.#owners.get(endpoint)?.get(owner)?.entries ?? new Map<string, string>();
  }

  /** Whether a thread other than `owner` holds the entry `name` in `directory` on `endpoint`: then it must stay. */
  heldByOthers(endpoint: ServerEndpoint, owner: string, directory: string, name: string): boolean {
    const owners = this.#owners.get(endpoint);
    if (owners === undefined) return false;
    return [...owners.entries()].some(([id, entry]) => id !== owner && entry.directory === directory && entry.entries.has(name));
  }

  /**
   * Records `owner`'s entries on `endpoint`, and first gives every other
   * thread there deny rules for them. Refuses a name another thread holds in
   * the same directory for a different server, and names OpenCode's rules
   * cannot keep apart from another thread's.
   */
  async register(endpoint: ServerEndpoint, owner: string, directory: string, entries: ReadonlyMap<string, string>, onOthers: (others: string[]) => Promise<void>): Promise<string[]> {
    const owners = this.#owners.get(endpoint) ?? new Map<string, Owner>();
    this.#owners.set(endpoint, owners);
    for (const [id, entry] of owners) {
      if (id === owner) continue;
      for (const [name, config] of entries) {
        const theirs = entry.entries.get(name);
        if (theirs !== undefined) {
          if (entry.directory === directory && theirs !== config) {
            throw callErrors.invalidState("mcp_name_conflict", `Another thread on this OpenCode server has a different MCP server named "${name}" in ${directory}; OpenCode keeps one entry per name there, so this one would replace it. Give the threads' servers different names.`);
          }
          // The same server under the same name (shared), or an entry of another directory, which this thread's sessions never see.
          continue;
        }
        const clash = collidingName(name, entry.entries.keys());
        if (clash !== undefined) {
          throw callErrors.invalidState("mcp_name_collision", `OpenCode's permission rules name MCP servers by prefix (tools <server>_<tool>, resources <server>:<uri>), so the host tool servers "${name}" and "${clash}" cannot be kept apart on one server; give them names that are not one another's prefix and hold no * or ?`);
        }
      }
    }
    owners.set(owner, { directory, entries, onOthers });
    for (const [id, entry] of owners) {
      if (id !== owner) await entry.onOthers(this.othersOn(endpoint, id));
    }
    return this.othersOn(endpoint, owner);
  }

  /** Forgets `owner`'s entries; the other threads stop denying the ones nobody holds now. A thread whose rules could not be relaxed keeps denying, which is safe. */
  async unregister(endpoint: ServerEndpoint, owner: string): Promise<void> {
    const owners = this.#owners.get(endpoint);
    if (owners === undefined || !owners.delete(owner)) return;
    for (const [id, entry] of owners) {
      await entry.onOthers(this.othersOn(endpoint, id)).catch((error: unknown) => {
        this.#host.diagnostics.log({ level: "warn", msg: `Thread ${id} still denies MCP entries that are gone: ${error instanceof Error ? error.message : String(error)}` });
      });
    }
    if (owners.size === 0) this.#owners.delete(endpoint);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const shared = this.#shared;
    this.#shared = undefined;
    const link = await shared?.catch(() => undefined);
    if (link !== undefined) await link.endpoint.stop();
  }
}
