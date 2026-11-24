// One Cursor instance: one account (a stored API key, or the user's own SDK
// sign-in) and one local agent store under the instance's state directory.
// Nothing here runs at import time; the SDK is loaded the first time a call
// needs it, and a missing SDK shows in `status()` and makes `openSession`
// fail with `driver_unavailable`.
//
// Credentials. The SDK resolves an API key as: the `apiKey` option, then
// `CURSOR_API_KEY` in the process environment, then the login
// `Cursor.auth.login()` stored (docs, "Cursor.auth"). The driver always
// passes `apiKey` itself, so the SDK never falls back to a `CURSOR_API_KEY`
// the host process inherited: the instance's stored key, else the stored SDK
// login (the user's ambient sign-in). A `CURSOR_API_KEY` in the instance's
// environment is dropped like any inherited credential.

import { callErrors } from "../../errors.ts";
import { deriveId } from "../../driver-kit/ids.ts";
import type { AuthMethod, AuthState, InstanceStatus, ModelCatalog, OpenSessionInput, ProbeResult, UpdateAdvisory } from "../../generated/instance.ts";
import type { HostServices, Instance, Session } from "../../runtime.ts";
import { CURSOR_INSTALL_HINT, CURSOR_SDK_PACKAGE, CURSOR_TESTED_VERSIONS } from "./config.ts";
import type { CursorConfig } from "./config.ts";
import { CreatedAgents } from "./created-agents.ts";
import { IDENTITY_VERSION, callErrorFromSdk } from "./mapping.ts";
import type { CursorSdkLoader, CursorSdkRuntime } from "./sdk.ts";
import { CursorSession } from "./session.ts";

/** How long a runtime auth failure poisons its scope. */
export const CURSOR_POISON_MS = 30_000;

/** Where the instance's API key lives in the host's secrets. */
export const CURSOR_SECRET_NAMESPACE = "cursor";
export const CURSOR_SECRET_KEY = "api-key";

/** The credential variable Cursor's SDK reads (docs, "Authentication"). Never passed on. */
export const CURSOR_CREDENTIAL_VARIABLES = ["CURSOR_API_KEY"] as const;

export const CURSOR_AUTH_METHODS: AuthMethod[] = [
  {
    id: "api-key",
    kind: "api_key",
    label: "API key",
    description: "A Cursor user or service-account API key (Cursor Dashboard, API Keys), stored by the host and passed to the SDK for this instance only.",
    fields: [{ id: "apiKey", label: "API key", secret: true, required: true }],
  },
];

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

/** True when `version` lies in a `>=x.y.z <a.b.c` range, the form `CURSOR_TESTED_VERSIONS` uses. */
export function versionInRange(version: string, range: string): boolean {
  const found = parseVersion(version);
  const bounds = /^>=(\S+)\s+<(\S+)$/.exec(range.trim());
  const low = bounds === null ? undefined : parseVersion(bounds[1]!);
  const high = bounds === null ? undefined : parseVersion(bounds[2]!);
  if (found === undefined || low === undefined || high === undefined) return false;
  return compareVersions(found, low) >= 0 && compareVersions(found, high) < 0;
}

export function versionAdvisory(version: string): UpdateAdvisory | undefined {
  if (versionInRange(version, CURSOR_TESTED_VERSIONS)) return undefined;
  return {
    kind: "untested_version",
    message: `@cursor/sdk ${version} is outside the versions this driver is tested against (${CURSOR_TESTED_VERSIONS}).`,
    currentVersion: version,
    testedRange: CURSOR_TESTED_VERSIONS,
  };
}

function errorName(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
}

/** The account a session runs with: its API key and the auth scope that key belongs to. */
export interface CursorAccount {
  readonly apiKey: string;
  readonly scope: "managed_profile" | "ambient";
}

export class CursorInstance<Store> implements Instance {
  readonly id: string;
  readonly continuationKey: string;
  readonly bindingKey: string;
  readonly #host: HostServices<CursorConfig>;
  readonly #config: CursorConfig;
  readonly #loadSdk: CursorSdkLoader<Store>;
  readonly #sessions = new Set<CursorSession<Store>>();
  readonly #createdAgents: CreatedAgents;
  /** The agents a session of this instance is running a turn on. */
  readonly #runningAgents = new Set<string>();
  /** When each scope's runtime auth poison ends, in milliseconds since the epoch. */
  readonly #poison = new Map<string, number>();
  #runtime: Promise<CursorSdkRuntime<Store>> | undefined;
  #store: Store | undefined;
  #sessionCount = 0;
  #flows = 0;

  constructor(host: HostServices<CursorConfig>, config: CursorConfig, instanceId: string, loadSdk: CursorSdkLoader<Store>) {
    this.id = instanceId;
    this.#host = host;
    this.#config = config;
    this.#loadSdk = loadSdk;
    this.#createdAgents = new CreatedAgents(host.paths.stateDir);
    // Cursor agents live in this instance's own store, so only this instance can continue its threads.
    this.continuationKey = `cursor:${instanceId}`;
    this.bindingKey = `cursor:${instanceId}:${config.model}`;
  }

  async status(): Promise<InstanceStatus> {
    let runtime: CursorSdkRuntime<Store>;
    try {
      runtime = await this.#sdk();
    } catch (error) {
      return { state: "unavailable", installed: false, error: this.#unavailable(error).callError, nativeSessions: { list: false, delete: false, archive: false } };
    }
    const advisory = runtime.version === undefined ? undefined : versionAdvisory(runtime.version);
    return {
      state: "ready",
      installed: true,
      ...(runtime.version === undefined ? {} : { version: runtime.version }),
      auth: await this.#state(),
      ...(advisory === undefined ? {} : { advisory }),
      nativeSessions: { list: false, delete: false, archive: false },
    };
  }

  async *statusChanges(): AsyncGenerator<InstanceStatus, void, undefined> {
    yield await this.status();
  }

  /** Loads the SDK and, for a deep probe, checks the sign-in. Writes nothing and calls no mutating host service. */
  async probe(options?: { deep?: boolean }): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    let runtime: CursorSdkRuntime<Store>;
    try {
      runtime = await this.#sdk();
    } catch (error) {
      return { ok: false, installed: false, error: this.#unavailable(error).callError, checkedAt };
    }
    const result: ProbeResult = { ok: true, installed: true, ...(runtime.version === undefined ? {} : { version: runtime.version }), checkedAt };
    if (options?.deep === true) return { ...result, auth: await this.#state() };
    return result;
  }

  auth: NonNullable<Instance["auth"]> = {
    methods: () => CURSOR_AUTH_METHODS.map((method) => ({ ...method })),
    state: () => this.#state(),
    reportRuntimeFailure: async () => {
      const base = await this.#baseState();
      this.#poison.set(base.scope, Date.now() + CURSOR_POISON_MS);
      return this.#state();
    },
    start: async (input) => {
      if (input.methodId !== "api-key") throw callErrors.notFound({ resource: "auth method", id: input.methodId });
      this.#flows += 1;
      return { flowId: `cursor-flow-${this.#flows}`, methodId: input.methodId, fields: CURSOR_AUTH_METHODS[0]!.fields ?? [] };
    },
    respond: async (input) => {
      const apiKey = input.values["apiKey"];
      if (apiKey === undefined || apiKey === "") throw callErrors.validation([{ message: "apiKey is required", path: ["values", "apiKey"] }]);
      await this.#host.secrets.set(CURSOR_SECRET_NAMESPACE, CURSOR_SECRET_KEY, new TextEncoder().encode(apiKey));
      return this.#state();
    },
    // An API key is entered through `respond`; no Cursor sign-in returns through a callback URL.
    complete: async () => {
      throw callErrors.unsupported("auth.complete", "Cursor sign-in has no browser callback in this driver");
    },
    cancel: async () => this.#state(),
    logout: async () => {
      await this.#host.secrets.delete(CURSOR_SECRET_NAMESPACE, CURSOR_SECRET_KEY);
    },
  };

  catalog = {
    /** `Cursor.models.list()`: the models, aliases and parameters the account may use. */
    list: async (): Promise<ModelCatalog> => {
      const { sdk } = await this.#sdkOrUnavailable();
      const account = await this.#account();
      let models;
      try {
        models = await sdk.Cursor.models.list({ apiKey: account.apiKey });
      } catch (error) {
        throw callErrorFromSdk(error, "Cursor.models.list");
      }
      return {
        models: models.map((model) => ({
          id: model.id,
          label: model.displayName,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(model.aliases === undefined || model.aliases.length === 0 ? {} : { aliases: [...model.aliases] }),
        })),
        defaultModelId: this.#config.model,
      };
    },
  };

  async openSession(input: OpenSessionInput): Promise<Session> {
    const runtime = await this.#sdkOrUnavailable();
    const account = await this.#account();
    this.#store ??= new runtime.sdk.JsonlLocalAgentStore(`${this.#host.paths.stateDir}/cursor-agents`);
    this.#sessionCount += 1;
    const id = deriveId({ kind: "session", native: { id: null, strength: "none", ordinal: this.#sessionCount }, identityVersion: IDENTITY_VERSION, scope: this.id });
    const session = new CursorSession<Store>(
      { host: this.#host, config: this.#config, sdk: runtime.sdk, store: this.#store, apiKey: account.apiKey, createdAgents: this.#createdAgents, runningAgents: this.#runningAgents },
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

  #sdk(): Promise<CursorSdkRuntime<Store>> {
    const loading = this.#runtime ?? this.#loadSdk();
    this.#runtime = loading;
    // A failed load is tried again next time: the host may install the SDK meanwhile.
    loading.catch(() => {
      if (this.#runtime === loading) this.#runtime = undefined;
    });
    return loading;
  }

  async #sdkOrUnavailable(): Promise<CursorSdkRuntime<Store>> {
    try {
      return await this.#sdk();
    } catch (error) {
      throw this.#unavailable(error);
    }
  }

  #unavailable(error: unknown) {
    if (error instanceof Error && (error as { callError?: { code?: unknown } }).callError?.code === "driver_unavailable") return error as ReturnType<typeof callErrors.driverUnavailable>;
    return callErrors.driverUnavailable({ package: CURSOR_SDK_PACKAGE, installHint: CURSOR_INSTALL_HINT }, `The Cursor TypeScript SDK failed to load: ${error instanceof Error ? error.message : String(error)}`);
  }

  async #managedKey(): Promise<string | undefined> {
    const stored = await this.#host.secrets.get(CURSOR_SECRET_NAMESPACE, CURSOR_SECRET_KEY);
    return stored === null ? undefined : new TextDecoder().decode(stored);
  }

  /** The account a session uses: the instance's stored key, else the SDK login the user stored. Never `CURSOR_API_KEY`. */
  async #account(): Promise<CursorAccount> {
    const state = await this.#state();
    if (state.status === "unauthenticated") throw callErrors.authRequired(CURSOR_AUTH_METHODS, state.actionRequired?.reason ?? "Sign in to Cursor first");
    const managed = await this.#managedKey();
    if (managed !== undefined) return { apiKey: managed, scope: "managed_profile" };
    const { sdk } = await this.#sdkOrUnavailable();
    const login = await new sdk.FileCredentialStore().load();
    if (login === undefined) throw callErrors.authRequired(CURSOR_AUTH_METHODS, "No Cursor API key is stored for this instance, and the Cursor SDK has no stored sign-in");
    return { apiKey: login.apiKey, scope: "ambient" };
  }

  /**
   * The verdict before any runtime poison. A stored key is `configured`
   * (never checked). The ambient account is the SDK's stored sign-in: none,
   * or an expired one, is `unauthenticated`; otherwise `Cursor.me()` checks
   * the key: accepted is `authenticated`, refused `unauthenticated`, a
   * network failure `unavailable`, anything else `unknown`.
   */
  async #baseState(): Promise<AuthState> {
    if ((await this.#managedKey()) !== undefined) return { status: "configured", evidence: "passive", scope: "managed_profile" };
    let runtime: CursorSdkRuntime<Store>;
    try {
      runtime = await this.#sdk();
    } catch {
      return { status: "unavailable", evidence: "passive", scope: "ambient" };
    }
    let login;
    try {
      login = await new runtime.sdk.FileCredentialStore().load();
    } catch {
      return { status: "unavailable", evidence: "passive", scope: "ambient" };
    }
    const signIn = "Store a Cursor API key for this instance, or sign in with the Cursor SDK (Cursor.auth.login()).";
    if (login === undefined) return { status: "unauthenticated", evidence: "passive", scope: "ambient", actionRequired: { reason: signIn } };
    if (login.apiKeyExpiresAtMs !== undefined && login.apiKeyExpiresAtMs <= Date.now()) {
      return { status: "unauthenticated", evidence: "passive", scope: "ambient", actionRequired: { reason: `The Cursor SDK sign-in expired. ${signIn}` } };
    }
    try {
      const user = await runtime.sdk.Cursor.me({ apiKey: login.apiKey });
      const email = user.userEmail ?? login.email;
      return { status: "authenticated", evidence: "active", scope: "ambient", ...(email === undefined ? {} : { account: { email } }) };
    } catch (error) {
      const name = errorName(error);
      if (name === "AuthenticationError") return { status: "unauthenticated", evidence: "active", scope: "ambient", actionRequired: { reason: `Cursor refused the stored sign-in. ${signIn}` } };
      if (name === "NetworkError") return { status: "unavailable", evidence: "active", scope: "ambient" };
      return { status: "unknown", evidence: "active", scope: "ambient" };
    }
  }

  async #state(): Promise<AuthState> {
    const base = await this.#baseState();
    const until = this.#poison.get(base.scope);
    if (until === undefined || until <= Date.now()) return base;
    return { status: "unauthenticated", evidence: "runtime_poison", scope: base.scope, poisonExpiresAt: new Date(until).toISOString() };
  }
}
