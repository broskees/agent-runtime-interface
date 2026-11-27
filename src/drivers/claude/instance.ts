// One Claude instance: one config and one account. The account is either the
// user's own Claude Code sign-in (ambient: whatever `claude auth status`
// reports) or an Anthropic API key this instance keeps in the host's secrets
// (a managed profile), given to Claude Code as ANTHROPIC_API_KEY.
//
// The SDK is an optional peer, loaded on first use from the first of: the
// directory the config's `sdkDirectory` names, the managed install
// `maintenance.install` put in the instance's cache directory, and the
// package imported by name (the loader `createClaudeDriver` was given).
//
// Every query runs the user's own Claude Code, wherever the SDK came from:
// the configured `executablePath`, else `claude` on the host's PATH, passed
// to the SDK as `pathToClaudeCodeExecutable`. A Claude Code binary that npm or
// `maintenance.install` put beside the SDK is never run. Its `--version` must
// be at least `CLAUDE_TESTED_CLAUDE_CODE_VERSION`, the Claude Code the pinned
// SDK bundles; a newer one gets an `untested_version` advisory.
//
// `create()` loads nothing and spawns nothing; a missing SDK, or a Claude Code
// that is missing, too old or prints no version, shows in `status()` and
// `probe()` and fails `openSession` with `driver_unavailable` before any
// Claude Code session starts. `probe()` runs only `claude --version`, and a
// deep probe also `claude auth status --json`.
//
// Claude Code keeps sessions in its config directory (CLAUDE_CONFIG_DIR, by
// default ~/.claude). The SDK's session functions (listSessions,
// getSessionInfo, getSessionMessages, deleteSession, archiveSession) run in
// this process and read that directory as this process's environment names
// it.

import * as fs from "node:fs/promises";
import { callErrors, toCallError } from "../../errors.ts";
import type {
  AuthFlow,
  AuthMethod,
  AuthState,
  InstanceStatus,
  ModelCatalog,
  ModelInfo,
  NativeSessionInfoPage,
  NativeSessionListInput,
  OpenSessionInput,
  ProbeResult,
  TextGenerationRequest,
  UpdateAdvisory,
} from "../../generated/instance.ts";
import type { LimitStatus } from "../../generated/usage.ts";
import {
  CLAUDE_CODE_INSTALL_HINT,
  CLAUDE_CODE_UPDATE_HINT,
  CLAUDE_DEFAULT_SDK_REGISTRY,
  CLAUDE_INSTALL_HINT,
  CLAUDE_SDK_PACKAGE,
  CLAUDE_SDK_VERSION,
  CLAUDE_TESTED_CLAUDE_CODE_VERSION,
  CLAUDE_TESTED_VERSIONS,
} from "../../meta/claude.ts";
import type { ClaudeDriverConfig } from "../../meta/claude.ts";
import type { HostServices, Instance, Session } from "../../runtime.ts";
import { ARI_VERSION } from "../../version.ts";
import { installClaudeSdk, loadManagedClaudeSdk } from "./install.ts";
import { limitStatusFrom, limitWindowFrom, strongRef } from "./mapping.ts";
import type { ClaudeLimitWindowState } from "./mapping.ts";
import { claudeProcessOptions } from "./process.ts";
import { loadClaudeSdkFromDirectory } from "./sdk.ts";
import type { ClaudeQueryOptions, ClaudeRateLimitInfo, ClaudeResultMessage, ClaudeSdkLoader, ClaudeSdkRuntime, ClaudeUserMessage } from "./sdk.ts";
import { ClaudeSession, sessionIdFor } from "./session.ts";

export const CLAUDE_SECRET_NAMESPACE = "claude";
export const CLAUDE_API_KEY_SECRET = "api-key";
/** How long a runtime auth failure poisons its scope. */
export const CLAUDE_POISON_MS = 30_000;
/** Ambient variables that carry Anthropic credentials. They never reach Claude Code: an instance uses only what it configured. */
export const CLAUDE_CREDENTIAL_VARIABLES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

export const CLAUDE_AUTH_METHODS: readonly AuthMethod[] = [
  { id: "api-key", kind: "api_key", label: "Anthropic API key", fields: [{ id: "apiKey", label: "API key", secret: true, required: true }] },
  { id: "claude-login", kind: "terminal_cli", label: "Sign in with Claude", description: "Run `claude auth login` in a terminal; the instance then uses that sign-in." },
];

/** Options for `createClaudeDriver`: seams for hosts and tests. */
export interface ClaudeDriverOptions {
  /**
   * Loads the SDK when the config names no `sdkDirectory` and no managed
   * install exists. Defaults to a dynamic `import("@anthropic-ai/claude-agent-sdk")`.
   */
  readonly loadSdk?: ClaudeSdkLoader;
  /** How `maintenance.install` and `maintenance.update` download from the npm registry. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Makes the UUIDs the driver gives Claude: the session id of each new
   * thread or fork, and the id of each prompt (which the transcript keeps and
   * turn ids derive from). Defaults to `crypto.randomUUID()`.
   */
  readonly newUuid?: () => string;
}

// Versions.

function parseVersion(text: string): { core: number[]; pre: string | undefined } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text.trim());
  if (match === null) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] };
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return Number.NaN;
  for (let index = 0; index < 3; index += 1) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return difference;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** True when `version` satisfies every space-separated comparator of `range` (`>=`, `>`, `<=`, `<`, `=`). */
export function satisfiesVersionRange(version: string, range: string): boolean {
  return range
    .split(/\s+/)
    .filter((part) => part !== "")
    .every((comparator) => {
      const match = /^(>=|<=|>|<|=)?(.+)$/.exec(comparator);
      if (match === null) return false;
      const order = compareVersions(version, match[2]!);
      if (Number.isNaN(order)) return false;
      switch (match[1]) {
        case ">=":
          return order >= 0;
        case ">":
          return order > 0;
        case "<=":
          return order <= 0;
        case "<":
          return order < 0;
        default:
          return order === 0;
      }
    });
}

/** The advisory for an SDK version outside the tested range, or null inside it. */
export function versionAdvisory(version: string | undefined): UpdateAdvisory | null {
  if (version === undefined || satisfiesVersionRange(version, CLAUDE_TESTED_VERSIONS)) return null;
  return {
    kind: "untested_version",
    message: `${CLAUDE_SDK_PACKAGE} ${version} is outside the versions this driver is tested against (${CLAUDE_TESTED_VERSIONS}).`,
    currentVersion: version,
    testedRange: CLAUDE_TESTED_VERSIONS,
  };
}

/** The user's Claude Code: the executable every query runs, and the version its `--version` printed. */
interface ClaudeCode {
  readonly path: string;
  readonly version: string;
}

/**
 * The version in what `claude --version` printed: `2.1.319 (Claude Code)`
 * (Claude Code docs, code.claude.com/docs/en/setup), or the version alone.
 * Undefined for anything else.
 */
export function parseClaudeCodeVersion(stdout: string): string | undefined {
  const firstLine = stdout.trim().split(/\r?\n/)[0] ?? "";
  return /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s+\(Claude Code\))?$/.exec(firstLine.trim())?.[1];
}

/** The advisory for a Claude Code newer than the one the driver is tested against, or null. */
function claudeCodeAdvisory(claudeCode: ClaudeCode): UpdateAdvisory | null {
  if (compareVersions(claudeCode.version, CLAUDE_TESTED_CLAUDE_CODE_VERSION) <= 0) return null;
  return {
    kind: "untested_version",
    message: `Claude Code ${claudeCode.version} at ${claudeCode.path} is newer than ${CLAUDE_TESTED_CLAUDE_CODE_VERSION}, the version this driver is tested against: it runs, but this version is untested.`,
    currentVersion: claudeCode.version,
    testedRange: CLAUDE_TESTED_CLAUDE_CODE_VERSION,
  };
}

/** The wire has one advisory slot. Keep the SDK's version fields if both are untested, but name both in the message. */
function availabilityAdvisory(sdkVersion: string | undefined, claudeCode: ClaudeCode): UpdateAdvisory | null {
  const sdk = versionAdvisory(sdkVersion);
  const cli = claudeCodeAdvisory(claudeCode);
  if (sdk === null) return cli;
  if (cli === null) return sdk;
  return { ...sdk, message: `${sdk.message} ${cli.message}` };
}

/** What changes when a file is replaced or rewritten in place, as `claude update` does; null when it cannot be read. */
async function fileIdentity(path: string): Promise<string | null> {
  try {
    const stats = await fs.stat(path);
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

/** True when `name` matches an `envPolicy.stripAmbient` entry: an exact name, or a prefix ending in `*`. */
function stripped(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern));
}

/** One prompt, then the end of input: what a one-shot query reads. */
async function* onePrompt(text: string): AsyncGenerator<ClaudeUserMessage> {
  yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

/** No prompt at all: a query that only answers control requests until it is closed. */
function noPrompts(): AsyncIterable<ClaudeUserMessage> & { end(): void } {
  let finish: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    end: () => finish(),
    async *[Symbol.asyncIterator]() {
      await ended;
    },
  };
}

const TEXT_KINDS: { readonly [kind: string]: string } = {
  commit_message: "a git commit message",
  pr: "a pull request title and description",
  branch: "a short git branch name",
  title: "a short title",
  review_guide: "a guide for reviewing the change",
};

/** A loaded SDK and the user's Claude Code its queries run. */
interface Available {
  readonly runtime: ClaudeSdkRuntime;
  readonly claudeCode: ClaudeCode;
}

export class ClaudeInstance implements Instance {
  readonly id: string;
  readonly #host: HostServices<ClaudeDriverConfig>;
  readonly #config: ClaudeDriverConfig;
  readonly #environment: { readonly [name: string]: string };
  readonly #options: ClaudeDriverOptions;
  readonly #loadSdk: ClaudeSdkLoader;
  readonly #sessions = new Set<ClaudeSession>();
  readonly #poison = new Map<string, number>();
  readonly #limits = new Map<string, ClaudeLimitWindowState>();
  readonly #flows = new Map<string, string>();
  readonly #statusWaiters = new Set<() => void>();
  #runtime: Promise<ClaudeSdkRuntime> | undefined;
  /** The last Claude Code whose version was read, kept while its file stays the same. */
  #checkedClaudeCode: (ClaudeCode & { readonly identity: string }) | undefined;
  #catalog: ModelCatalog | undefined;
  #managed: boolean;
  #sessionCount = 0;
  #flowCount = 0;
  #disposed = false;

  constructor(host: HostServices<ClaudeDriverConfig>, config: ClaudeDriverConfig, instanceId: string, environment: { readonly [name: string]: string }, managed: boolean, options: ClaudeDriverOptions, loadSdk: ClaudeSdkLoader) {
    this.id = instanceId;
    this.#host = host;
    this.#config = config;
    this.#environment = environment;
    this.#managed = managed;
    this.#options = options;
    this.#loadSdk = loadSdk;
  }

  /** Instances that read the same Claude config directory can continue each other's sessions. */
  get continuationKey(): string {
    return `claude:${this.#environment["CLAUDE_CONFIG_DIR"] ?? "default-config-dir"}`;
  }

  get bindingKey(): string {
    return `claude:${this.#config.executablePath ?? "claude"}:${this.#managed ? `managed:${this.id}` : "ambient"}`;
  }

  // The SDK and the user's Claude Code.

  /** The loaded SDK; a failed load is not kept, so installing the SDK later works without a restart. */
  #sdk(): Promise<ClaudeSdkRuntime> {
    this.#runtime ??= this.#loadRuntime().catch((error: unknown) => {
      this.#runtime = undefined;
      throw error;
    });
    return this.#runtime;
  }

  /** The SDK from the configured `sdkDirectory`, else from a managed install, else from the driver's loader (the package by name). */
  async #loadRuntime(): Promise<ClaudeSdkRuntime> {
    if (this.#config.sdkDirectory !== undefined) return loadClaudeSdkFromDirectory(this.#config.sdkDirectory);
    const managed = await loadManagedClaudeSdk(this.#host.paths.cacheDir);
    return managed ?? this.#loadSdk();
  }

  /** `maintenance.install` and `maintenance.update`: installs the pinned SDK, and only the SDK, from the npm registry; the next use loads it. */
  async #install(): Promise<void> {
    if (this.#disposed) throw callErrors.invalidState("instance_disposed");
    await installClaudeSdk({
      cacheDir: this.#host.paths.cacheDir,
      tmpDir: this.#host.paths.tmpDir,
      registry: this.#config.sdkRegistry ?? CLAUDE_DEFAULT_SDK_REGISTRY,
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
    });
    this.#runtime = undefined;
    this.#catalog = undefined;
    this.#changed();
  }

  /**
   * The user's Claude Code, which every query runs: the configured
   * `executablePath`, else `claude`, as the host resolves it (a bare name on
   * its PATH, a path with a directory part as it stands), at
   * `CLAUDE_TESTED_CLAUDE_CODE_VERSION` or newer. Missing, printing no
   * version, or older: the driver is unavailable, and the error names the fix.
   */
  async #claudeCode(): Promise<ClaudeCode> {
    const configured = this.#config.executablePath;
    const path = await this.#host.process.resolveExecutable(configured ?? "claude");
    if (path === null) {
      if (configured !== undefined) {
        throw callErrors.driverUnavailable(
          { binary: configured, installHint: CLAUDE_CODE_INSTALL_HINT },
          `Claude Code is not installed at the configured executablePath: ${configured} names no executable file. ${CLAUDE_CODE_INSTALL_HINT}`,
        );
      }
      throw callErrors.driverUnavailable({ binary: "claude", installHint: CLAUDE_CODE_INSTALL_HINT }, `Claude Code is not installed: no claude executable was found on PATH. ${CLAUDE_CODE_INSTALL_HINT}`);
    }
    const version = await this.#claudeCodeVersion(path);
    if (compareVersions(version, CLAUDE_TESTED_CLAUDE_CODE_VERSION) < 0) {
      throw callErrors.driverUnavailable(
        { binary: path, installHint: CLAUDE_CODE_UPDATE_HINT },
        `Claude Code ${version} at ${path} is older than ${CLAUDE_TESTED_CLAUDE_CODE_VERSION}, the oldest version this driver runs (the one ${CLAUDE_SDK_PACKAGE} ${CLAUDE_SDK_VERSION} bundles). ${CLAUDE_CODE_UPDATE_HINT}`,
      );
    }
    return { path, version };
  }

  /**
   * The version `<path> --version` prints. It is read again whenever the file
   * changes (`claude update` replaces it), and on every check of a file this
   * process cannot stat.
   */
  async #claudeCodeVersion(path: string): Promise<string> {
    const identity = await fileIdentity(path);
    const checked = this.#checkedClaudeCode;
    if (identity !== null && checked !== undefined && checked.path === path && checked.identity === identity) return checked.version;
    const unreadable = (what: string): Error =>
      callErrors.driverUnavailable(
        { binary: path, installHint: CLAUDE_CODE_INSTALL_HINT },
        `The version of the Claude Code at ${path} cannot be read: ${what}. Claude Code prints a version such as ${CLAUDE_TESTED_CLAUDE_CODE_VERSION} (Claude Code). ${CLAUDE_CODE_INSTALL_HINT}`,
      );
    let printed: { stdout: string; stderr: string; code: number | null; signal: string | null };
    try {
      const child = await this.#host.process.spawn({ command: path, args: ["--version"], purpose: "probe", stdin: "ignore", timeoutMs: 10_000, env: this.#forwardedEnvironment() });
      const [stdout, stderr] = await Promise.all([readAll(child.stdout), readAll(child.stderr)]);
      const exit = await child.exited;
      printed = { stdout, stderr, code: exit.code, signal: exit.signal };
    } catch (error) {
      throw unreadable(`${path} --version could not be started (${errorMessage(error)})`);
    }
    const version = parseClaudeCodeVersion(printed.stdout);
    if (printed.code !== 0 || version === undefined) {
      const ended = printed.code === null ? `was stopped by ${printed.signal ?? "a signal"}` : `exited with code ${printed.code}`;
      const output = `${printed.stdout}${printed.stderr}`.trim();
      throw unreadable(`${path} --version ${ended} and printed ${output === "" ? "nothing" : JSON.stringify(output.length > 300 ? `${output.slice(0, 300)}…` : output)}`);
    }
    if (identity !== null) this.#checkedClaudeCode = { path, version, identity };
    return version;
  }

  async #available(): Promise<Available> {
    if (this.#disposed) throw callErrors.invalidState("instance_disposed");
    const runtime = await this.#sdk();
    return { runtime, claudeCode: await this.#claudeCode() };
  }

  /** A failure to load the SDK or find Claude Code, as the call error `status()` and `probe()` report. */
  #unavailable(error: unknown): NonNullable<ProbeResult["error"]> {
    return toCallError(error) ?? callErrors.driverUnavailable({ package: CLAUDE_SDK_PACKAGE, installHint: CLAUDE_INSTALL_HINT }, errorMessage(error)).callError;
  }

  // Status.

  async status(): Promise<InstanceStatus> {
    let available: Available;
    try {
      available = await this.#available();
    } catch (error) {
      return { state: "unavailable", installed: false, error: this.#unavailable(error) };
    }
    const auth = await this.#state();
    const version = available.runtime.version;
    const advisory = availabilityAdvisory(version, available.claudeCode);
    const limits = this.#limits.size === 0 ? undefined : limitStatusFrom(this.#limits.values());
    return {
      state: "ready",
      installed: true,
      ...(version === undefined ? {} : { version }),
      auth,
      ...(advisory === null ? {} : { advisory }),
      ...(limits === undefined ? {} : { limits }),
      nativeSessions: { list: true, delete: true, archive: true },
    };
  }

  async *statusChanges(): AsyncGenerator<InstanceStatus, void, undefined> {
    while (!this.#disposed) {
      const changed = new Promise<void>((resolve) => this.#statusWaiters.add(resolve));
      yield await this.status();
      await changed;
    }
  }

  #changed(): void {
    const waiters = [...this.#statusWaiters];
    this.#statusWaiters.clear();
    for (const wake of waiters) wake();
  }

  /** Loads the SDK, finds the user's Claude Code and runs its `--version`; a deep probe also runs `claude auth status --json`. Nothing else. */
  async probe(options?: { deep?: boolean }): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    let available: Available;
    try {
      available = await this.#available();
    } catch (error) {
      return { ok: false, installed: false, error: this.#unavailable(error), checkedAt };
    }
    const version = available.runtime.version;
    const result: ProbeResult = { ok: true, installed: true, ...(version === undefined ? {} : { version }), checkedAt };
    if (options?.deep === true) return { ...result, auth: await this.#state() };
    return result;
  }

  // Environment and credentials.

  async #apiKey(): Promise<string | undefined> {
    const stored = await this.#host.secrets.get(CLAUDE_SECRET_NAMESPACE, CLAUDE_API_KEY_SECRET);
    this.#managed = stored !== null;
    return stored === null ? undefined : new TextDecoder().decode(stored);
  }

  /** The instance's own environment without credentials it did not configure or the host strips. */
  #forwardedEnvironment(): { [name: string]: string } {
    const patterns = this.#host.process.envPolicy.stripAmbient;
    const forwarded: { [name: string]: string } = {};
    for (const [name, value] of Object.entries(this.#environment)) {
      if ((CLAUDE_CREDENTIAL_VARIABLES as readonly string[]).includes(name) || stripped(name, patterns)) continue;
      forwarded[name] = value;
    }
    return forwarded;
  }

  /** What a query's Claude Code process gets: `env` replaces its whole environment. */
  async #queryEnvironment(): Promise<{ [name: string]: string }> {
    const apiKey = await this.#apiKey();
    return {
      ...this.#forwardedEnvironment(),
      ...(apiKey === undefined ? {} : { ANTHROPIC_API_KEY: apiKey }),
      // A refused resume (a session another process holds) comes back as a result naming the reason.
      CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
      CLAUDE_AGENT_SDK_CLIENT_APP: `ari/${ARI_VERSION}`,
    };
  }

  // Auth.

  /** The verdict before any runtime poison: a stored API key is configured; the ambient sign-in is what `claude auth status` says. */
  async #baseState(): Promise<AuthState> {
    if ((await this.#apiKey()) !== undefined) return { status: "configured", evidence: "passive", scope: "managed_profile" };
    let executable: string;
    try {
      executable = (await this.#available()).claudeCode.path;
    } catch {
      return { status: "unavailable", evidence: "passive", scope: "ambient" };
    }
    let check: { code: number | null; stdout: string };
    try {
      const child = await this.#host.process.spawn({ command: executable, args: ["auth", "status", "--json"], purpose: "probe", stdin: "ignore", timeoutMs: 10_000, env: this.#forwardedEnvironment() });
      const [stdout] = await Promise.all([readAll(child.stdout), readAll(child.stderr)]);
      const exit = await child.exited;
      check = { code: exit.code, stdout };
    } catch {
      return { status: "unavailable", evidence: "active", scope: "ambient" };
    }
    if (check.code !== 0) return { status: "unavailable", evidence: "active", scope: "ambient" };
    let report: { [key: string]: unknown };
    try {
      report = JSON.parse(check.stdout) as { [key: string]: unknown };
    } catch {
      return { status: "unknown", evidence: "passive", scope: "ambient" };
    }
    // `claude auth status --json` prints { loggedIn, authMethod, apiProvider, ... } and exits 0 signed in or not.
    // Bedrock, Vertex and the other cloud providers authenticate outside Claude Code, which therefore cannot tell.
    const provider = report["apiProvider"];
    if (typeof report["loggedIn"] !== "boolean" || (typeof provider === "string" && provider !== "firstParty")) return { status: "unknown", evidence: "passive", scope: "ambient" };
    if (!report["loggedIn"]) return { status: "unauthenticated", evidence: "active", scope: "ambient" };
    const email = typeof report["email"] === "string" ? report["email"] : undefined;
    const plan = typeof report["subscriptionType"] === "string" ? report["subscriptionType"] : undefined;
    return {
      status: "authenticated",
      evidence: "active",
      scope: "ambient",
      ...(email === undefined && plan === undefined ? {} : { account: { ...(email === undefined ? {} : { email }), ...(plan === undefined ? {} : { plan }) } }),
    };
  }

  async #state(): Promise<AuthState> {
    const base = await this.#baseState();
    const until = this.#poison.get(base.scope);
    if (until === undefined || until <= Date.now()) return base;
    return { status: "unauthenticated", evidence: "runtime_poison", scope: base.scope, poisonExpiresAt: new Date(until).toISOString() };
  }

  async #poisonCurrentScope(): Promise<AuthState> {
    const scope = (await this.#apiKey()) === undefined ? "ambient" : "managed_profile";
    this.#poison.set(scope, Date.now() + CLAUDE_POISON_MS);
    this.#changed();
    return this.#state();
  }

  auth: NonNullable<Instance["auth"]> = ((instance: ClaudeInstance) => ({
    get credentialBinding() {
      return instance.#managed ? { owner: "host", key: `${CLAUDE_SECRET_NAMESPACE}/${CLAUDE_API_KEY_SECRET}` } : { owner: "provider", key: "claude:ambient" };
    },
    methods: () => CLAUDE_AUTH_METHODS.map((method) => ({ ...method })),
    state: () => this.#state(),
    reportRuntimeFailure: () => this.#poisonCurrentScope(),
    start: async (input) => {
      const method = CLAUDE_AUTH_METHODS.find((candidate) => candidate.id === input.methodId);
      if (method === undefined) throw callErrors.notFound({ resource: "auth method", id: input.methodId });
      this.#flowCount += 1;
      const flowId = `${method.id}-${this.#flowCount}`;
      this.#flows.set(flowId, method.id);
      if (method.id === "api-key") return { flowId, methodId: method.id, fields: [...(method.fields ?? [])] } satisfies AuthFlow;
      return { flowId, methodId: method.id, instructions: "Run `claude auth login` in a terminal, then check the sign-in again." } satisfies AuthFlow;
    },
    complete: async () => {
      // Claude Code signs in through its own terminal flow; no callback URL comes back to the host.
      throw callErrors.unsupported("auth.complete", "Claude sign-in runs in `claude auth login`; there is no callback to complete");
    },
    respond: async (input) => {
      const methodId = this.#flows.get(input.flowId);
      if (methodId === undefined) throw callErrors.notFound({ resource: "sign-in flow", id: input.flowId });
      if (methodId !== "api-key") throw callErrors.invalidState("no_input_expected", `Flow ${input.flowId} takes no values; run \`claude auth login\``);
      const apiKey = input.values["apiKey"];
      if (apiKey === undefined || apiKey.trim() === "") throw callErrors.validation([{ message: "apiKey is required", path: ["values", "apiKey"] }]);
      await this.#host.secrets.set(CLAUDE_SECRET_NAMESPACE, CLAUDE_API_KEY_SECRET, new TextEncoder().encode(apiKey.trim()));
      this.#flows.delete(input.flowId);
      this.#managed = true;
      this.#changed();
      return this.#state();
    },
    cancel: async (flowId) => {
      this.#flows.delete(flowId);
      return this.#state();
    },
    logout: async () => {
      // Removes this instance's own API key. The ambient sign-in belongs to the user's Claude Code (`claude auth logout`).
      await this.#host.secrets.delete(CLAUDE_SECRET_NAMESPACE, CLAUDE_API_KEY_SECRET);
      this.#managed = false;
      this.#changed();
    },
  }))(this);

  // Catalog.

  catalog = {
    list: async (options?: { cwd?: string }): Promise<ModelCatalog> => {
      this.#catalog ??= await this.#loadCatalog(options?.cwd);
      return this.#catalog;
    },
    refresh: async (): Promise<void> => {
      this.#catalog = await this.#loadCatalog(undefined);
      this.#changed();
    },
  };

  /**
   * The models Claude Code offers (`Query.supportedModels`), from a query
   * that loads no settings, MCP servers or tools and is closed at once.
   */
  async #loadCatalog(cwd: string | undefined): Promise<ModelCatalog> {
    const { runtime, claudeCode } = await this.#available();
    const input = noPrompts();
    const query = runtime.sdk.query({ prompt: input, options: { ...(await this.#isolatedOptions(claudeCode)), cwd: cwd ?? this.#host.paths.tmpDir } });
    try {
      const models = await query.supportedModels();
      const catalog: ModelInfo[] = models.map((model) => ({
        id: model.value,
        label: model.displayName,
        ...(model.description === "" ? {} : { description: model.description }),
        ...(model.supportedEffortLevels === undefined || model.supportedEffortLevels.length === 0
          ? {}
          : {
              options: [
                {
                  id: "effort",
                  category: "reasoning",
                  label: "Effort",
                  type: "select",
                  values: model.supportedEffortLevels.map((level) => ({ id: level, label: level })),
                  current: null,
                  scope: "turn",
                  changeEffect: "next_turn",
                },
              ],
            }),
      }));
      const defaultModel = catalog.find((model) => model.id === "default") ?? catalog[0];
      return { models: catalog, ...(defaultModel === undefined ? {} : { defaultModelId: defaultModel.id }) };
    } finally {
      input.end();
      query.close();
    }
  }

  /** Options for a query that must not act: no settings files, no MCP servers, no tools, nothing persisted. */
  async #isolatedOptions(claudeCode: ClaudeCode): Promise<ClaudeQueryOptions> {
    return {
      env: await this.#queryEnvironment(),
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      tools: [],
      persistSession: false,
      permissionMode: "dontAsk",
      ...claudeProcessOptions(this.#host, claudeCode.path),
      ...(this.#config.model === undefined ? {} : { model: this.#config.model }),
    };
  }

  invalidateCaches = async (): Promise<void> => {
    this.#catalog = undefined;
    this.#runtime = undefined;
    this.#checkedClaudeCode = undefined;
    this.#changed();
  };

  maintenance = {
    /** The same version advice as `status()` when ready; `status()` reports any Claude Code availability error. */
    advisory: async (): Promise<UpdateAdvisory | null> => {
      const runtime = await this.#sdk();
      let claudeCode: ClaudeCode;
      try {
        claudeCode = await this.#claudeCode();
      } catch {
        return versionAdvisory(runtime.version);
      }
      return availabilityAdvisory(runtime.version, claudeCode);
    },
    /** Downloads the pinned SDK, and only the SDK, from the npm registry (`sdkRegistry`) into the instance's cache directory. */
    install: (): Promise<void> => this.#install(),
    /** The same as `install`: installs the version this driver pins, which a newer driver may have moved. */
    update: (): Promise<void> => this.#install(),
  };

  // Limits.

  #rateLimited(info: ClaudeRateLimitInfo): LimitStatus {
    const state = limitWindowFrom(info);
    this.#limits.set(state.window.window, state);
    this.#changed();
    return limitStatusFrom(this.#limits.values());
  }

  limits = {
    /** What Claude Code's rate limit events reported for this account, latest per window. */
    current: async (): Promise<LimitStatus> => limitStatusFrom(this.#limits.values()),
    accountKey: (): string => (this.#managed ? `claude:managed:${this.id}` : `${this.continuationKey}:ambient`),
  };

  // Text generation.

  textGeneration = {
    /** Claude Code runs with `tools: []`, no MCP servers and no settings files, so it cannot call a tool. */
    guarantees: { toolsDisabled: "native" as const },
    generate: async (request: TextGenerationRequest): Promise<unknown> => {
      const { runtime, claudeCode } = await this.#available();
      const what = TEXT_KINDS[request.kind] ?? `a ${request.kind.replace(/^x:/, "")}`;
      const systemPrompt = `Write ${what} for the input the user gives. Reply with it alone.`;
      const query = runtime.sdk.query({
        prompt: onePrompt(typeof request.input === "string" ? request.input : JSON.stringify(request.input, null, 2)),
        options: {
          ...(await this.#isolatedOptions(claudeCode)),
          cwd: this.#host.paths.tmpDir,
          systemPrompt,
          maxTurns: 1,
          ...(request.schema === undefined ? {} : { outputFormat: { type: "json_schema", schema: request.schema as Record<string, unknown> } }),
        },
      });
      let result: ClaudeResultMessage | undefined;
      try {
        for await (const message of query) {
          if (message.type === "result") result = message as ClaudeResultMessage;
          if (message.type === "rate_limit_event") this.#rateLimited((message as { rate_limit_info: ClaudeRateLimitInfo }).rate_limit_info);
        }
      } finally {
        query.close();
      }
      if (result === undefined) throw callErrors.transport("Claude Code ended without a result");
      if (result.is_error || result.subtype !== "success") throw callErrors.protocol("generation_failed", `Claude could not generate ${what}: ${result.result ?? (result.errors ?? []).join("; ")}`);
      return request.schema === undefined ? (result.result ?? "") : result.structured_output;
    },
  };

  // Native sessions.

  nativeSessions = {
    /** Claude sessions recorded for `cwd`, newest first, 50 per page; the cursor is the offset. */
    list: async (input: NativeSessionListInput): Promise<NativeSessionInfoPage> => {
      const { runtime } = await this.#available();
      const offset = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
      if (!Number.isInteger(offset) || offset < 0) throw callErrors.validation([{ message: "cursor is not one this driver returned", path: ["cursor"] }]);
      const page = 50;
      const sessions = await runtime.sdk.listSessions({ dir: input.cwd, limit: page + 1, offset });
      return {
        items: sessions.slice(0, page).map((session) => ({
          id: session.sessionId,
          title: session.customTitle ?? session.summary,
          ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
          ...(session.createdAt === undefined ? {} : { createdAt: new Date(session.createdAt).toISOString() }),
          updatedAt: new Date(session.lastModified).toISOString(),
          handle: session.sessionId,
          native: strongRef(session.sessionId),
        })),
        nextCursor: sessions.length > page ? String(offset + page) : null,
      };
    },
    delete: async (id: string): Promise<void> => {
      const { runtime } = await this.#available();
      this.#refuseOpen(id);
      await runtime.sdk.deleteSession(id);
    },
    archive: async (id: string): Promise<void> => {
      const { runtime } = await this.#available();
      await runtime.sdk.archiveSession(id);
    },
  };

  #refuseOpen(nativeId: string): void {
    for (const session of this.#sessions) {
      if (session.holds(nativeId)) throw callErrors.invalidState("session_open", `Claude session ${nativeId} is open in session ${session.id}`);
    }
  }

  // Sessions.

  async openSession(input: OpenSessionInput): Promise<Session> {
    if ((input.launch?.dynamicTools ?? []).length > 0) {
      throw callErrors.unsupported("tools.dynamicTools", "The Claude driver does not serve dynamic tools; give the host's tools as an MCP server");
    }
    const { runtime, claudeCode } = await this.#available();
    const ordinal = this.#sessionCount;
    this.#sessionCount += 1;
    const newUuid = this.#options.newUuid ?? (() => globalThis.crypto.randomUUID());
    const session: ClaudeSession = new ClaudeSession(
      {
        host: this.#host,
        config: { ...this.#config, ...pickConfig(input.config) },
        sdk: runtime.sdk,
        executablePath: claudeCode.path,
        sessionId: sessionIdFor(this.id, ordinal),
        newUuid,
        environment: () => this.#queryEnvironment(),
        rateLimited: (info) => this.#rateLimited(info),
        authFailed: async () => {
          await this.#poisonCurrentScope();
        },
        closed: () => this.#sessions.delete(session),
      },
      input,
    );
    this.#sessions.add(session);
    return session;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await Promise.all([...this.#sessions].map((session) => session.close()));
    this.#changed();
  }
}

/** The driver-config fields a session's `config` may override. */
function pickConfig(config: { [key: string]: unknown } | undefined): Partial<ClaudeDriverConfig> {
  if (config === undefined) return {};
  const picked: { model?: string; effort?: ClaudeDriverConfig["effort"] } = {};
  if (typeof config["model"] === "string" && config["model"] !== "") picked.model = config["model"];
  if (typeof config["effort"] === "string" && ["low", "medium", "high", "xhigh", "max"].includes(config["effort"])) picked.effort = config["effort"] as ClaudeDriverConfig["effort"];
  return picked;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
