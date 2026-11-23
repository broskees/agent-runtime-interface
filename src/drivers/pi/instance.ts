// One Pi instance: the user's own `pi`, found on PATH (or at a configured
// path) through the host. Nothing here runs at import time; a missing `pi`
// shows in `status()` and makes `openSession` fail with `driver_unavailable`.
//
// Probes run only `pi --version`, and for a deep probe `pi auth check
// --provider <p> --json --no-refresh` (`--no-refresh` keeps Pi from writing a
// refreshed OAuth token, Pi docs cli.md "Credential commands").

import { callErrors } from "../../errors.ts";
import { deriveId } from "../../driver-kit/ids.ts";
import type { AuthMethod, AuthState, InstanceStatus, ModelCatalog, OpenSessionInput, ProbeResult, UpdateAdvisory } from "../../generated/instance.ts";
import type { HostServices, Instance, Session } from "../../runtime.ts";
import { BRIDGE_FILE_NAME, PI_BRIDGE_SOURCE } from "./bridge.ts";
import { PI_CREDENTIAL_VARIABLES, PI_TESTED_VERSIONS } from "./config.ts";
import type { PiConfig } from "./config.ts";
import { PiProcess } from "./rpc.ts";
import { PiSession } from "./session.ts";
import { IDENTITY_VERSION } from "./transcript.ts";

/** How long a runtime auth failure poisons its scope. */
export const PI_POISON_MS = 30_000;

const SECRET_NAMESPACE = "pi";
const SECRET_KEY = "api-key";

export const PI_AUTH_METHODS: AuthMethod[] = [
  {
    id: "api-key",
    kind: "api_key",
    label: "API key",
    description: "Stored by the host and passed to pi with --api-key for the configured model only.",
    fields: [{ id: "apiKey", label: "API key", secret: true, required: true }],
  },
  { id: "pi-login", kind: "terminal_cli", label: "Sign in with pi", description: "Run `pi auth login <provider>` in a terminal; pi stores the credential itself." },
];

/** Runs `pi <args>` to completion through the host and returns its exit code and stdout. */
async function runPi(host: HostServices<PiConfig>, executable: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  const child = await host.process.spawn({ command: executable, args, purpose: "probe", stdin: "ignore", timeoutMs: 15_000 });
  const decoder = new TextDecoder();
  let stdout = "";
  const drainErrors = (async () => {
    for await (const chunk of child.stderr) void chunk;
  })();
  for await (const chunk of child.stdout) stdout += decoder.decode(chunk, { stream: true });
  await drainErrors;
  const exit = await child.exited;
  return { code: exit.code, stdout };
}

function parseVersion(text: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** True when `version` lies in a `>=x.y.z <a.b.c` range, the form `PI_TESTED_VERSIONS` uses. */
export function versionInRange(version: string, range: string): boolean {
  const found = parseVersion(version);
  const bounds = /^>=(\S+)\s+<(\S+)$/.exec(range.trim());
  const low = bounds === null ? undefined : parseVersion(bounds[1]!);
  const high = bounds === null ? undefined : parseVersion(bounds[2]!);
  if (found === undefined || low === undefined || high === undefined) return false;
  return compareVersions(found, low) >= 0 && compareVersions(found, high) < 0;
}

export function versionAdvisory(version: string): UpdateAdvisory | undefined {
  if (versionInRange(version, PI_TESTED_VERSIONS)) return undefined;
  return {
    kind: "untested_version",
    message: `pi ${version} is outside the versions this driver is tested against (${PI_TESTED_VERSIONS}).`,
    currentVersion: version,
    testedRange: PI_TESTED_VERSIONS,
  };
}

export class PiInstance implements Instance {
  readonly id: string;
  readonly continuationKey: string;
  readonly bindingKey: string;
  readonly #host: HostServices<PiConfig>;
  readonly #config: PiConfig;
  readonly #environment: { readonly [name: string]: string };
  readonly #sessions = new Set<PiSession>();
  /** When each scope's runtime auth poison ends, in milliseconds since the epoch. */
  readonly #poison = new Map<string, number>();
  readonly #contextWindows = new Map<string, number>();
  #sessionCount = 0;
  #flows = 0;

  constructor(host: HostServices<PiConfig>, config: PiConfig, instanceId: string, environment: { readonly [name: string]: string }) {
    this.id = instanceId;
    this.#host = host;
    this.#config = config;
    // Credentials the host did not configure for this instance never reach pi.
    const credentials = new Set<string>(PI_CREDENTIAL_VARIABLES);
    this.#environment = Object.fromEntries(Object.entries(environment).filter(([name]) => !credentials.has(name)));
    // Pi session files open from any instance (`--session <file>`), so every Pi instance can continue another's threads.
    this.continuationKey = "pi";
    this.bindingKey = `pi:${config.binary}:${config.provider ?? ""}:${config.model ?? ""}`;
  }

  async status(): Promise<InstanceStatus> {
    const probe = await this.probe();
    if (!probe.installed) return { state: "unavailable", installed: false, ...(probe.error === undefined ? {} : { error: probe.error }) };
    const auth = await this.#state();
    const advisory = probe.version === undefined ? undefined : versionAdvisory(probe.version);
    return {
      state: probe.ok ? "ready" : "error",
      installed: true,
      ...(probe.version === undefined ? {} : { version: probe.version }),
      auth,
      ...(advisory === undefined ? {} : { advisory }),
      nativeSessions: { list: false, delete: false, archive: false },
    };
  }

  async *statusChanges(): AsyncGenerator<InstanceStatus, void, undefined> {
    yield await this.status();
  }

  async probe(options?: { deep?: boolean }): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    const executable = await this.#host.process.resolveExecutable(this.#config.binary);
    if (executable === null) return { ok: false, installed: false, error: this.#unavailable().callError, checkedAt };
    let version: { code: number | null; stdout: string };
    try {
      version = await runPi(this.#host, executable, ["--version"]);
    } catch (error) {
      return { ok: false, installed: true, error: callErrors.transport(`pi --version failed: ${error instanceof Error ? error.message : String(error)}`).callError, checkedAt };
    }
    const found = version.stdout.trim().split("\n")[0]?.trim();
    const result: ProbeResult = { ok: version.code === 0, installed: true, ...(found === undefined || found === "" ? {} : { version: found }), checkedAt };
    if (options?.deep === true) return { ...result, auth: await this.#state() };
    return result;
  }

  auth: NonNullable<Instance["auth"]> = {
    methods: () => PI_AUTH_METHODS.map((method) => ({ ...method })),
    state: () => this.#state(),
    reportRuntimeFailure: async () => {
      const base = await this.#baseState();
      this.#poison.set(base.scope, Date.now() + PI_POISON_MS);
      return this.#state();
    },
    start: async (input) => {
      this.#flows += 1;
      const flowId = `pi-flow-${this.#flows}`;
      if (input.methodId === "api-key") return { flowId, methodId: input.methodId, fields: PI_AUTH_METHODS[0]!.fields ?? [] };
      if (input.methodId === "pi-login") {
        const provider = this.#config.provider ?? "<provider>";
        return { flowId, methodId: input.methodId, instructions: `Run \`pi auth login ${provider}\` in a terminal, then check the status again.` };
      }
      throw callErrors.notFound({ resource: "auth method", id: input.methodId });
    },
    respond: async (input) => {
      const apiKey = input.values["apiKey"];
      if (apiKey === undefined || apiKey === "") throw callErrors.validation([{ message: "apiKey is required", path: ["values", "apiKey"] }]);
      await this.#host.secrets.set(SECRET_NAMESPACE, SECRET_KEY, new TextEncoder().encode(apiKey));
      return this.#state();
    },
    complete: async () => {
      throw callErrors.invalidState("no_callback_flow", "Pi sign-in has no browser callback");
    },
    cancel: async () => this.#state(),
    logout: async () => {
      await this.#host.secrets.delete(SECRET_NAMESPACE, SECRET_KEY);
    },
  };

  catalog = {
    /** Pi's model list from `get_available_models`, in a Pi process that loads no extensions and no session. */
    list: async (): Promise<ModelCatalog> => {
      const executable = await this.#host.process.resolveExecutable(this.#config.binary);
      if (executable === null) throw this.#unavailable();
      const spawned = await this.#host.process.spawn({
        command: executable,
        args: ["--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", ...(this.#config.model === undefined ? [] : ["--model", this.#config.model])],
        env: { ...this.#environment },
        purpose: "runtime",
        stdin: "pipe",
      });
      const pi = new PiProcess(spawned, { onRecord: () => undefined, onExit: () => undefined });
      try {
        const listed = await pi.request<{ models?: unknown }>({ type: "get_available_models" });
        const state = await pi.request<{ model?: { provider?: unknown; id?: unknown } }>({ type: "get_state" });
        const models = (Array.isArray(listed.models) ? listed.models : []).flatMap((model) => {
          const { provider, id, name, contextWindow } = model as { provider?: unknown; id?: unknown; name?: unknown; contextWindow?: unknown };
          if (typeof provider !== "string" || typeof id !== "string") return [];
          const slug = `${provider}/${id}`;
          if (typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0) this.#contextWindows.set(slug, contextWindow);
          return [{ id: slug, label: typeof name === "string" ? name : slug, ...(typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow >= 0 ? { contextWindow } : {}) }];
        });
        const current = typeof state.model?.provider === "string" && typeof state.model.id === "string" ? `${state.model.provider}/${state.model.id}` : undefined;
        return { models, ...(current === undefined ? {} : { defaultModelId: current }) };
      } finally {
        await pi.close();
      }
    },
  };

  async openSession(input: OpenSessionInput): Promise<Session> {
    const executable = await this.#host.process.resolveExecutable(this.#config.binary);
    if (executable === null) throw this.#unavailable();
    const state = await this.#state();
    if (state.status === "unauthenticated") throw callErrors.authRequired(PI_AUTH_METHODS, state.actionRequired?.reason ?? "Sign in to pi first");
    if (this.#contextWindows.size === 0) await this.catalog.list().catch(() => undefined);
    const key = await this.#host.secrets.get(SECRET_NAMESPACE, SECRET_KEY);
    const bridgeFile = await this.#writeBridge();
    this.#sessionCount += 1;
    const id = deriveId({ kind: "session", native: { id: null, strength: "none", ordinal: this.#sessionCount }, identityVersion: IDENTITY_VERSION, scope: this.id });
    const session = new PiSession(
      {
        host: this.#host,
        config: this.#config,
        executable,
        bridgeFile,
        environment: this.#environment,
        apiKey: key === null ? undefined : new TextDecoder().decode(key),
        contextWindows: this.#contextWindows,
      },
      input,
      id,
    );
    this.#sessions.add(session);
    return session;
  }

  async dispose(): Promise<void> {
    for (const session of this.#sessions) await session.close();
    this.#sessions.clear();
  }

  #unavailable() {
    return callErrors.driverUnavailable({ binary: this.#config.binary, installHint: "Install pi (https://pi.dev) and make sure `pi` is on PATH, or set the driver's binary config." }, `Pi is not installed: ${this.#config.binary} was not found`);
  }

  /**
   * Writes the bridge extension under the instance's cache directory, where
   * each Pi process loads it from. Only when a session opens, never in a probe.
   * Pi reads files, so this is the one place the driver touches the file
   * system; it loads `node:fs` only here.
   */
  async #writeBridge(): Promise<string> {
    const fs = await import("node:fs/promises");
    const directory = `${this.#host.paths.cacheDir}/pi-bridge`;
    const file = `${directory}/${BRIDGE_FILE_NAME}`;
    const current = await fs.readFile(file, "utf8").catch(() => undefined);
    if (current !== PI_BRIDGE_SOURCE) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(temporary, PI_BRIDGE_SOURCE, { mode: 0o600 });
      await fs.rename(temporary, file);
    }
    return file;
  }

  /** The verdict before any runtime poison: a stored key is configured; otherwise Pi's own check for the ambient account. */
  async #baseState(): Promise<AuthState> {
    const key = await this.#host.secrets.get(SECRET_NAMESPACE, SECRET_KEY);
    if (key !== null) return { status: "configured", evidence: "passive", scope: "managed_profile" };
    const target = this.#config.provider !== undefined ? ["--provider", this.#config.provider] : this.#config.model !== undefined ? ["--model", this.#config.model] : undefined;
    // Pi picks its provider itself when none is configured, so there is nothing to check.
    if (target === undefined) return { status: "unknown", evidence: "passive", scope: "ambient" };
    const executable = await this.#host.process.resolveExecutable(this.#config.binary);
    if (executable === null) return { status: "unavailable", evidence: "active", scope: "ambient" };
    let check: { code: number | null; stdout: string };
    try {
      check = await runPi(this.#host, executable, ["auth", "check", ...target, "--json", "--no-refresh"]);
    } catch {
      return { status: "unavailable", evidence: "active", scope: "ambient" };
    }
    let answer: { status?: unknown; provider?: unknown };
    try {
      answer = JSON.parse(check.stdout.trim().split("\n").at(-1) ?? "") as typeof answer;
    } catch {
      return { status: "unavailable", evidence: "active", scope: "ambient" };
    }
    const provider = typeof answer.provider === "string" ? answer.provider : (this.#config.provider ?? "the provider");
    if (answer.status === "ready") return { status: "authenticated", evidence: "active", scope: "ambient" };
    if (answer.status === "not_ready") return { status: "unauthenticated", evidence: "active", scope: "ambient", actionRequired: { reason: `Run \`pi auth login ${provider}\` or store an API key for this instance.` } };
    if (answer.status === "invalid") return { status: "unknown", evidence: "active", scope: "ambient" };
    return { status: "unavailable", evidence: "active", scope: "ambient" };
  }

  async #state(): Promise<AuthState> {
    const base = await this.#baseState();
    const until = this.#poison.get(base.scope);
    if (until === undefined || until <= Date.now()) return base;
    return { status: "unauthenticated", evidence: "runtime_poison", scope: base.scope, poisonExpiresAt: new Date(until).toISOString() };
  }
}
