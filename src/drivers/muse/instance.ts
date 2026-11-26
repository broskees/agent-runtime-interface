// One Muse instance: one config and one account. The account is either the
// user's own Muse sign-in (`muse login`, ambient) or a managed Meta API key
// this instance keeps in the host's secrets and gives every `muse serve` as
// `META_API_KEY` (the variable Muse reads its key from, per the public
// provider-muse adapter docs/drivers/muse.md cites). An inherited
// `META_API_KEY` never reaches Muse.
//
// MSP has no sign-in check (no account method in its stable surface), so the
// ambient account's state is `unknown`; an auth failure shows on the first
// turn, and the host reports it with `auth.reportRuntimeFailure`.
//
// `probe()` loads the SDK (which runs nothing) and runs only `muse --version`;
// it never starts `muse serve`, which can start MCP servers or write state.
// The driver runs the `muse` the user installed and never installs or updates
// one: a `muse` older than MUSE_MINIMUM_VERSION is `driver_unavailable` in
// `status()` and `openSession`, naming MUSE_CLI_UPDATE_STEP.

import { AriError, callErrors, toCallError } from "../../errors.ts";
import { CliTooOldError } from "../../driver-kit/cli-too-old.ts";
import { deriveId } from "../../driver-kit/ids.ts";
import type { AuthFlow, AuthMethod, AuthState, InstanceStatus, ModelCatalog, ModelInfo, OpenSessionInput, ProbeResult, UpdateAdvisory } from "../../generated/instance.ts";
import type { LimitStatus } from "../../generated/usage.ts";
import type { HostServices, Instance, Session } from "../../runtime.ts";
import { MUSE_CLI_INSTALL_HINT, MUSE_CLI_UPDATE_STEP, MUSE_MINIMUM_VERSION, MUSE_TESTED_VERSIONS } from "../../meta/muse.ts";
import type { MuseDriverConfig } from "../../meta/muse.ts";
import { MUSE_CAPABILITIES } from "./capabilities.ts";
import { MuseHost, callErrorFromMuse } from "./host.ts";
import { MUSE_IDENTITY_VERSION, limitsFromMuse } from "./mapping.ts";
import type { MuseModelEntry, MuseSdkRuntime } from "./sdk.ts";
import { MuseSession } from "./session.ts";

export const MUSE_SECRET_NAMESPACE = "muse";
export const MUSE_API_KEY_SECRET = "api-key";
/** How long a runtime auth failure poisons its scope. */
export const MUSE_POISON_MS = 30_000;
/** Ambient variables that carry Meta credentials. They never reach Muse: an instance uses only what it configured. */
export const MUSE_CREDENTIAL_VARIABLES = ["META_API_KEY"] as const;

export const MUSE_AUTH_METHODS: readonly AuthMethod[] = [
  { id: "api-key", kind: "api_key", label: "Meta API key", fields: [{ id: "apiKey", label: "API key", secret: true, required: true }] },
  { id: "muse-login", kind: "terminal_cli", label: "Sign in with muse login", description: "Run `muse login` in a terminal on this machine." },
];

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

/** The advisory for a Muse CLI or SDK version outside the tested range, or null when both are inside it. */
export function versionAdvisory(cliVersion: string | undefined, sdkVersion: string | undefined): UpdateAdvisory | null {
  const outside: string[] = [];
  if (cliVersion !== undefined && !satisfiesVersionRange(cliVersion, MUSE_TESTED_VERSIONS)) outside.push(`Muse Code ${cliVersion}`);
  if (sdkVersion !== undefined && !satisfiesVersionRange(sdkVersion, MUSE_TESTED_VERSIONS)) outside.push(`@muse-code/sdk ${sdkVersion}`);
  if (outside.length === 0) return null;
  return {
    kind: "untested_version",
    message: `${outside.join(" and ")} ${outside.length === 1 ? "is" : "are"} outside the versions this driver is tested against (${MUSE_TESTED_VERSIONS}).`,
    ...(cliVersion === undefined ? {} : { currentVersion: cliVersion }),
    testedRange: MUSE_TESTED_VERSIONS,
  };
}

// Helpers.

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

export interface MuseInstanceOptions {
  readonly loadSdk: () => Promise<MuseSdkRuntime>;
  readonly mintCommandId?: () => string;
}

export class MuseInstance implements Instance {
  readonly id: string;
  readonly #host: HostServices<MuseDriverConfig>;
  readonly #config: MuseDriverConfig;
  readonly #environment: { readonly [name: string]: string };
  readonly #options: MuseInstanceOptions;
  readonly #sessions = new Set<MuseSession>();
  readonly #poison = new Map<string, number>();
  readonly #flows = new Map<string, string>();
  readonly #statusWaiters = new Set<() => void>();
  readonly #contextWindows = new Map<string, number>();
  #sdk: Promise<MuseSdkRuntime> | undefined;
  #managed: boolean;
  #sessionCount = 0;
  #flowCount = 0;
  #catalog: ModelCatalog | undefined;
  #limits: LimitStatus | undefined;
  #disposed = false;

  constructor(host: HostServices<MuseDriverConfig>, config: MuseDriverConfig, instanceId: string, environment: { readonly [name: string]: string }, managed: boolean, options: MuseInstanceOptions) {
    this.id = instanceId;
    this.#host = host;
    this.#config = config;
    this.#environment = environment;
    this.#managed = managed;
    this.#options = options;
  }

  /** Instances on the same account can continue each other's threads: the ambient account, or this instance's own key. */
  get continuationKey(): string {
    return this.#managed ? `muse:managed:${this.id}` : "muse:ambient";
  }

  get bindingKey(): string {
    return `muse:${this.#config.binaryPath}:${this.#managed ? `managed:${this.id}` : "ambient"}`;
  }

  /** The SDK, loaded once; a failure is kept, so `status()` and `openSession` name the missing package every time. */
  #loadSdk(): Promise<MuseSdkRuntime> {
    this.#sdk ??= this.#options.loadSdk();
    return this.#sdk;
  }

  // Status.

  async status(): Promise<InstanceStatus> {
    const probe = await this.probe();
    if (!probe.installed) return { state: "unavailable", installed: false, ...(probe.error === undefined ? {} : { error: probe.error }) };
    // Installed but older than the minimum: the driver will not run it.
    if (probe.error?.code === "driver_unavailable") return { state: "unavailable", installed: true, ...(probe.version === undefined ? {} : { version: probe.version }), error: probe.error };
    const sdk = await this.#loadSdk();
    const auth = await this.#state();
    const advisory = versionAdvisory(probe.version, sdk.version);
    return {
      state: probe.ok ? "ready" : "error",
      installed: true,
      ...(probe.version === undefined ? {} : { version: probe.version }),
      auth,
      ...(advisory === null ? {} : { advisory }),
      ...(this.#limits === undefined ? {} : { limits: this.#limits }),
      ...(this.#catalog === undefined ? {} : { models: this.#catalog }),
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

  /** Loads the SDK (no side effect) and runs only `muse --version`. */
  async probe(options?: { deep?: boolean }): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    try {
      await this.#loadSdk();
    } catch (error) {
      return { ok: false, installed: false, error: toCallError(error) ?? callErrors.transport(String(error)).callError, checkedAt };
    }
    const env = this.#forwardedEnvironment();
    // The process owner interprets env as for spawn. Keep path for older hosts.
    const path = await this.#host.process.resolveExecutable(this.#config.binaryPath, { env, ...(env["PATH"] === undefined ? {} : { path: env["PATH"] }) });
    if (path === null) return { ok: false, installed: false, error: this.#cliMissing().callError, checkedAt };
    let version: string | undefined;
    let ok = false;
    try {
      const child = await this.#host.process.spawn({ command: this.#config.binaryPath, args: ["--version"], purpose: "probe", stdin: "ignore", timeoutMs: 10_000, env });
      const [stdout, stderr] = await Promise.all([readAll(child.stdout), readAll(child.stderr)]);
      const exit = await child.exited;
      version = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(`${stdout}\n${stderr}`)?.[1];
      ok = exit.code === 0 && version !== undefined;
    } catch (error) {
      return { ok: false, installed: true, checkedAt, error: toCallError(error) ?? callErrors.transport(String(error)).callError };
    }
    if (version !== undefined && compareVersions(version, MUSE_MINIMUM_VERSION) < 0) {
      const tooOld = new CliTooOldError({ name: "Muse Code", binary: this.#config.binaryPath, version, path, minimum: MUSE_MINIMUM_VERSION, updateStep: MUSE_CLI_UPDATE_STEP });
      return { ok: false, installed: true, version, error: tooOld.callError, checkedAt };
    }
    const result: ProbeResult = { ok, installed: true, ...(version === undefined ? {} : { version }), checkedAt };
    if (options?.deep === true) return { ...result, auth: await this.#state() };
    return result;
  }

  #cliMissing(): import("../../ari-error.ts").AriError {
    return callErrors.driverUnavailable({ binary: this.#config.binaryPath, installHint: MUSE_CLI_INSTALL_HINT }, `Muse Code (${this.#config.binaryPath}) is not installed. ${MUSE_CLI_INSTALL_HINT}`);
  }

  /** The instance's own environment, without Meta credentials it did not configure. */
  #forwardedEnvironment(): { [name: string]: string } {
    const forwarded: { [name: string]: string } = {};
    for (const [name, value] of Object.entries(this.#environment)) {
      if ((MUSE_CREDENTIAL_VARIABLES as readonly string[]).some((variable) => name.toUpperCase().startsWith(variable))) continue;
      forwarded[name] = value;
    }
    return forwarded;
  }

  async #managedKey(): Promise<string | undefined> {
    const key = await this.#host.secrets.get(MUSE_SECRET_NAMESPACE, MUSE_API_KEY_SECRET);
    this.#managed = key !== null;
    return key === null ? undefined : new TextDecoder().decode(key);
  }

  /** What every `muse serve` gets added to the host's environment: no automatic update, and the managed key when there is one. */
  async #serveEnvironment(): Promise<{ [name: string]: string }> {
    const key = await this.#managedKey();
    return { ...this.#forwardedEnvironment(), MUSE_NO_AUTO_UPDATE: "1", ...(key === undefined ? {} : { META_API_KEY: key }) };
  }

  /** Runs `body` against a short-lived `muse serve`, for account-wide reads (catalog, limits). */
  async #withHost<T>(body: (host: MuseHost) => Promise<T>): Promise<T> {
    if (this.#disposed) throw callErrors.invalidState("instance_disposed");
    const { sdk } = await this.#loadSdk();
    if ((await this.#host.process.resolveExecutable(this.#config.binaryPath)) === null) throw this.#cliMissing();
    const host = await MuseHost.start(this.#host as HostServices<unknown>, {
      sdk,
      spawn: { command: this.#config.binaryPath, args: ["serve", ...(this.#config.extraArgs ?? [])], env: await this.#serveEnvironment(), purpose: "runtime", stdin: "pipe" },
      handshakeTimeoutMs: 120_000,
      ...(this.#options.mintCommandId === undefined ? {} : { mintCommandId: this.#options.mintCommandId }),
      handlers: {
        onNotification: (notification) => {
          if (notification.method === "usage/changed" && notification.params !== undefined) this.#onLimits(limitsFromMuse(notification.params as never));
        },
        onServerRequest: async () => ({}),
        onExit: () => undefined,
      },
    });
    try {
      return await body(host);
    } catch (error) {
      throw callErrorFromMuse(sdk, error, "muse serve");
    } finally {
      await host.close();
    }
  }

  #onLimits(limits: LimitStatus): void {
    this.#limits = limits;
    this.#changed();
  }

  #onModels(models: readonly MuseModelEntry[]): void {
    for (const model of models) if (model.contextLimit !== null && model.contextLimit > 0) this.#contextWindows.set(model.modelId, model.contextLimit);
  }

  // Auth.

  /** The verdict before any runtime poison: a managed key is configured; the ambient account cannot be checked over MSP. */
  async #baseState(): Promise<AuthState> {
    if ((await this.#managedKey()) !== undefined) return { status: "configured", evidence: "passive", scope: "managed_profile" };
    return { status: "unknown", evidence: "passive", scope: "ambient" };
  }

  async #state(): Promise<AuthState> {
    const base = await this.#baseState();
    const until = this.#poison.get(base.scope);
    if (until === undefined || until <= Date.now()) return base;
    return { status: "unauthenticated", evidence: "runtime_poison", scope: base.scope, poisonExpiresAt: new Date(until).toISOString() };
  }

  auth: NonNullable<Instance["auth"]> = ((instance: MuseInstance) => ({
    get credentialBinding() {
      return instance.#managed ? { owner: "host", key: `muse:${instance.id}` } : { owner: "provider", key: "muse:ambient" };
    },
    methods: () => MUSE_AUTH_METHODS.map((method) => ({ ...method })),
    state: () => instance.#state(),
    reportRuntimeFailure: async () => {
      const base = await instance.#baseState();
      instance.#poison.set(base.scope, Date.now() + MUSE_POISON_MS);
      instance.#changed();
      return instance.#state();
    },
    start: async (input): Promise<AuthFlow> => {
      const method = MUSE_AUTH_METHODS.find((candidate) => candidate.id === input.methodId);
      if (method === undefined) throw callErrors.notFound({ resource: "auth method", id: input.methodId });
      instance.#flowCount += 1;
      const flowId = `${method.id}-${instance.#flowCount}`;
      instance.#flows.set(flowId, method.id);
      if (method.id === "api-key") return { flowId, methodId: method.id, fields: [...(method.fields ?? [])] };
      return { flowId, methodId: method.id, instructions: `Run \`${instance.#config.binaryPath} login\` in a terminal on this machine, then check the status again.` };
    },
    // Neither method returns through a callback URL.
    complete: async () => {
      throw callErrors.unsupported("auth.complete", "Muse sign-in has no callback to complete");
    },
    respond: async (input) => {
      if (instance.#flows.get(input.flowId) !== "api-key") throw callErrors.notFound({ resource: "sign-in flow", id: input.flowId });
      const apiKey = input.values["apiKey"];
      if (apiKey === undefined || apiKey.trim() === "") throw callErrors.validation([{ message: "apiKey is required", path: ["values", "apiKey"] }]);
      await instance.#host.secrets.set(MUSE_SECRET_NAMESPACE, MUSE_API_KEY_SECRET, new TextEncoder().encode(apiKey));
      instance.#flows.delete(input.flowId);
      instance.#managed = true;
      instance.#poison.delete("managed_profile");
      instance.#changed();
      return instance.#state();
    },
    cancel: async (flowId) => {
      instance.#flows.delete(flowId);
      return instance.#state();
    },
    logout: async () => {
      if ((await instance.#managedKey()) === undefined) throw callErrors.unsupported("auth.logout", `Sign the ambient account out with \`${instance.#config.binaryPath}\` itself`);
      await instance.#host.secrets.delete(MUSE_SECRET_NAMESPACE, MUSE_API_KEY_SECRET);
      instance.#managed = false;
      instance.#changed();
    },
  }))(this);

  // Catalog.

  catalog: Instance["catalog"] = {
    list: async () => {
      if (this.#catalog !== undefined) return this.#catalog;
      const listed = await this.#withHost((host) => host.request("model/list", {}));
      this.#onModels(listed.models);
      let defaultModelId: string | undefined;
      const models = listed.models.map((model): ModelInfo => {
        if (model.isDefault) defaultModelId ??= model.modelId;
        const efforts = Array.isArray(model.variants) ? model.variants : [];
        return {
          id: model.modelId,
          label: model.displayLabel,
          ...(model.description === null || model.description === "" ? {} : { description: model.description }),
          ...(model.contextLimit === null ? {} : { contextWindow: model.contextLimit }),
          ...(efforts.length === 0
            ? {}
            : {
                options: [
                  {
                    id: "reasoningEffort",
                    category: "reasoning",
                    label: "Reasoning effort",
                    type: "select",
                    values: efforts.map((effort) => ({ id: effort, label: effort })),
                    current: model.defaultReasoningEffort ?? null,
                    scope: "turn",
                    changeEffect: "next_turn",
                  },
                ],
              }),
        };
      });
      this.#catalog = { models, ...(defaultModelId === undefined ? {} : { defaultModelId }) };
      return this.#catalog;
    },
    refresh: async () => {
      this.#catalog = undefined;
      await this.catalog.list();
      this.#changed();
    },
  };

  async invalidateCaches(): Promise<void> {
    this.#catalog = undefined;
    this.#limits = undefined;
  }

  maintenance: NonNullable<Instance["maintenance"]> = {
    advisory: async () => {
      const probe = await this.probe();
      const sdk = await this.#loadSdk().catch(() => undefined);
      return versionAdvisory(probe.version, sdk?.version);
    },
  };

  // Limits.

  limits: NonNullable<Instance["limits"]> = {
    current: async () => {
      const read = await this.#withHost((host) => host.request("usage/read"));
      // `usage` is absent until the host has observed a subscription window.
      const limits: LimitStatus = read.usage === undefined ? { windows: [], limited: false } : limitsFromMuse(read.usage);
      this.#onLimits(limits);
      return limits;
    },
    accountKey: () => (this.#managed ? `muse:managed:${this.id}` : "muse:ambient"),
  };

  // Sessions.

  async openSession(input: OpenSessionInput): Promise<Session> {
    if (this.#disposed) throw callErrors.invalidState("instance_disposed");
    const { sdk } = await this.#loadSdk();
    // A missing `muse`, or one below the minimum, never starts `muse serve`.
    const probe = await this.probe();
    if (probe.error?.code === "driver_unavailable") throw new AriError(probe.error);
    const state = await this.#state();
    if (state.status === "unauthenticated") throw callErrors.authRequired([...MUSE_AUTH_METHODS], "Sign in to Muse first");
    this.#sessionCount += 1;
    const id = deriveId({ kind: "session", native: { id: null, strength: "none", ordinal: this.#sessionCount }, identityVersion: MUSE_IDENTITY_VERSION, scope: this.id });
    const session = new MuseSession(
      {
        host: this.#host as HostServices<unknown>,
        sdk,
        capabilities: MUSE_CAPABILITIES,
        binaryPath: this.#config.binaryPath,
        extraArgs: this.#config.extraArgs ?? [],
        ...(this.#config.model === undefined ? {} : { defaultModel: this.#config.model }),
        ...(this.#config.providerId === undefined ? {} : { providerId: this.#config.providerId }),
        ...(this.#config.reasoningEffort === undefined ? {} : { defaultEffort: this.#config.reasoningEffort }),
        environment: () => this.#serveEnvironment(),
        ...(this.#options.mintCommandId === undefined ? {} : { mintCommandId: this.#options.mintCommandId }),
        onLimits: (limits) => this.#onLimits(limits),
        onModels: (models) => this.#onModels(models),
        contextWindow: (model) => this.#contextWindows.get(model),
      },
      input,
      id,
    );
    session.open();
    this.#sessions.add(session);
    return session;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const session of this.#sessions) await session.close();
    this.#sessions.clear();
    this.#changed();
  }
}

/** Reads whether the instance holds a managed key, for `create()`. */
export async function hasManagedKey(host: HostServices<unknown>): Promise<boolean> {
  return (await host.secrets.get(MUSE_SECRET_NAMESPACE, MUSE_API_KEY_SECRET)) !== null;
}
