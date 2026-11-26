// One Codex instance: one config and one account. The account is either the
// user's own Codex sign-in (ambient: Codex's default home) or a managed
// profile this instance owns, kept in the host's secrets and used with the
// instance's state directory as `CODEX_HOME`:
//
// - an API key the user entered (`auth.respond`), which every new app-server
//   gets through `account/login/start { type: "apiKey" }`;
// - ChatGPT tokens another machine obtained and handed over
//   (`auth.transferProfile`), which every new app-server gets through
//   `account/login/start { type: "chatgptAuthTokens" }`. Codex then asks the
//   client for fresh tokens (`account/chatgptAuthTokens/refresh`) instead of
//   refreshing them itself, so only this destination ever refreshes them, with
//   whatever the host handed over last.
//
// `probe()` runs only `codex --version`, and `codex login status` when deep
// and ambient; it never starts an app-server, which could start MCP servers or
// write state.

import { callErrors, toCallError } from "../../errors.ts";
import { deriveId } from "../../driver-kit/ids.ts";
import { JsonRpcError } from "../../driver-kit/json-rpc.ts";
import { CodexTransferredTokensSchema } from "../../generated/extensions/codex.ts";
import type { CodexNativeSessionFilters, CodexTransferredTokens } from "../../generated/extensions/codex.ts";
import type { SpawnRequest } from "../../generated/host.ts";
import type {
  AuthFlow,
  AuthMethod,
  AuthState,
  InstanceStatus,
  ModelCatalog,
  ModelInfo,
  NativeSessionInfo,
  NativeSessionInfoPage,
  NativeSessionListInput,
  OpenSessionInput,
  ProbeResult,
  TransferredProfile,
  UpdateAdvisory,
} from "../../generated/instance.ts";
import type { LimitStatus, ResetCreditOutcome } from "../../generated/usage.ts";
import type { HostServices, Instance, Session } from "../../runtime.ts";
import { CODEX_INSTALL_HINT, CODEX_TESTED_VERSIONS } from "../../meta/codex.ts";
import type { CodexDriverConfig } from "../../meta/codex.ts";
import { CODEX_CAPABILITIES } from "./capabilities.ts";
import { CodexConnection, callErrorFromCodex } from "./connection.ts";
import type { ThreadListParams } from "./generated/protocol.ts";
import { CODEX_IDENTITY_VERSION, isoFromSeconds, limitsFromCodex, strongRef } from "./mapping.ts";
import { CodexSession } from "./session.ts";

export const CODEX_SECRET_NAMESPACE = "codex";
export const CODEX_API_KEY_SECRET = "api-key";
export const CODEX_TOKENS_SECRET = "chatgpt-tokens";
/** The `auth.transferProfile` format this driver accepts; `data` is JSON of `CodexTransferredTokens`. */
export const CODEX_TRANSFER_FORMAT = "codex.chatgpt_auth_tokens";
/** How long a runtime auth failure poisons its scope. */
export const CODEX_POISON_MS = 30_000;
/** Ambient variables that carry OpenAI credentials. They never reach Codex: an instance uses only what it configured. */
export const CODEX_CREDENTIAL_VARIABLES = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_ADMIN_KEY"] as const;

export const CODEX_AUTH_METHODS: readonly AuthMethod[] = [
  { id: "chatgpt", kind: "oauth_browser", label: "Sign in with ChatGPT" },
  { id: "device-code", kind: "device_code", label: "Sign in with ChatGPT on another device" },
  { id: "api-key", kind: "api_key", label: "OpenAI API key", fields: [{ id: "apiKey", label: "API key", secret: true, required: true }] },
];

const NATIVE_SESSION_FILTERS: { readonly [key: string]: keyof ThreadListParams } = {
  "x:codex.limit": "limit",
  "x:codex.searchTerm": "searchTerm",
  "x:codex.archived": "archived",
  "x:codex.modelProviders": "modelProviders",
  "x:codex.sourceKinds": "sourceKinds",
  "x:codex.includedThreadIds": "includedThreadIds",
  "x:codex.excludedThreadIds": "excludedThreadIds",
  "x:codex.useStateDbOnly": "useStateDbOnly",
  "x:codex.currentAccountOnly": "currentAccountOnly",
  "x:codex.parentThreadId": "parentThreadId",
  "x:codex.ancestorThreadId": "ancestorThreadId",
  "x:codex.projectId": "projectId",
  "x:codex.sortKey": "sortKey",
  "x:codex.sortDirection": "sortDirection",
};

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

/** The advisory for a Codex CLI version outside the tested range, or null inside it. */
export function versionAdvisory(version: string | undefined): UpdateAdvisory | null {
  if (version === undefined) return null;
  if (satisfiesVersionRange(version, CODEX_TESTED_VERSIONS)) return null;
  return {
    kind: "untested_version",
    message: `Codex CLI ${version} is outside the versions this driver is tested against (${CODEX_TESTED_VERSIONS}).`,
    currentVersion: version,
    testedRange: CODEX_TESTED_VERSIONS,
  };
}

// Helpers.

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

type Managed = { readonly kind: "api_key"; readonly apiKey: string } | { readonly kind: "tokens"; readonly tokens: CodexTransferredTokens };

interface LoginFlow {
  readonly flowId: string;
  readonly methodId: string;
  readonly loginId: string | undefined;
  /** Where Codex's own login listener expects the browser to come back, from the authorization URL. */
  readonly redirectUri: string | undefined;
  readonly done: Promise<{ success: boolean; error?: string }>;
  readonly finish: (outcome: { success: boolean; error?: string }) => void;
}

export class CodexInstance implements Instance {
  readonly id: string;
  readonly #host: HostServices<CodexDriverConfig>;
  readonly #config: CodexDriverConfig;
  readonly #environment: { readonly [name: string]: string };
  readonly #sessions = new Set<CodexSession>();
  readonly #poison = new Map<string, number>();
  readonly #flows = new Map<string, LoginFlow>();
  readonly #statusWaiters = new Set<() => void>();
  #managedKind: Managed["kind"] | undefined;
  #sessionCount = 0;
  #apiKeyFlows = 0;
  #account: Promise<CodexConnection> | undefined;
  #accountCurrent: CodexConnection | undefined;
  #catalog: ModelCatalog | undefined;
  #limits: LimitStatus | undefined;
  #disposed = false;

  constructor(host: HostServices<CodexDriverConfig>, config: CodexDriverConfig, instanceId: string, environment: { readonly [name: string]: string }, managed: Managed["kind"] | undefined) {
    this.id = instanceId;
    this.#host = host;
    this.#config = config;
    this.#environment = environment;
    this.#managedKind = managed;
  }

  /** Instances on the same account can continue each other's threads: the ambient account, or this instance's own profile. */
  get continuationKey(): string {
    return this.#managedKind === undefined ? "codex:ambient" : `codex:managed:${this.id}`;
  }

  get bindingKey(): string {
    return `codex:${this.#config.binaryPath}:${this.#managedKind === undefined ? "ambient" : `managed:${this.id}`}`;
  }

  // Status.

  async status(): Promise<InstanceStatus> {
    const probe = await this.probe();
    if (!probe.installed) return { state: "unavailable", installed: false, ...(probe.error === undefined ? {} : { error: probe.error }) };
    const auth = await this.#state();
    const advisory = versionAdvisory(probe.version);
    return {
      state: probe.ok ? "ready" : "error",
      installed: true,
      ...(probe.version === undefined ? {} : { version: probe.version }),
      auth,
      ...(advisory === null ? {} : { advisory }),
      ...(this.#limits === undefined ? {} : { limits: this.#limits }),
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

  /** Runs only `codex --version`, and `codex login status` when deep and ambient. Nothing else. */
  async probe(options?: { deep?: boolean }): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    const binary = this.#config.binaryPath;
    const path = await this.#host.process.resolveExecutable(binary);
    if (path === null) return { ok: false, installed: false, error: this.#unavailable().callError, checkedAt };
    let version: string | undefined;
    let ok = false;
    try {
      const run = await this.#run(["--version"]);
      version = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(run.stdout)?.[1];
      ok = run.code === 0 && version !== undefined;
    } catch (error) {
      return { ok: false, installed: true, checkedAt, error: toCallError(error) ?? callErrors.transport(String(error)).callError };
    }
    const result: ProbeResult = { ok, installed: true, ...(version === undefined ? {} : { version }), checkedAt };
    if (options?.deep === true) return { ...result, auth: await this.#state() };
    return result;
  }

  #unavailable(): import("../../ari-error.ts").AriError {
    return callErrors.driverUnavailable({ binary: this.#config.binaryPath, installHint: CODEX_INSTALL_HINT }, `The Codex CLI (${this.#config.binaryPath}) is not installed. ${CODEX_INSTALL_HINT}`);
  }

  /** Runs `codex <args>` to completion, for probes and the sign-in check. */
  async #run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = await this.#host.process.spawn({ command: this.#config.binaryPath, args, purpose: "probe", stdin: "ignore", timeoutMs: 10_000, env: this.#forwardedEnvironment() });
    const [stdout, stderr] = await Promise.all([readAll(child.stdout), readAll(child.stderr)]);
    const exit = await child.exited;
    return { code: exit.code, stdout, stderr };
  }

  /** The instance's own environment, without OpenAI credentials it did not configure. */
  #forwardedEnvironment(): { [name: string]: string } {
    const forwarded: { [name: string]: string } = {};
    for (const [name, value] of Object.entries(this.#environment)) {
      if ((CODEX_CREDENTIAL_VARIABLES as readonly string[]).some((variable) => name.startsWith(variable))) continue;
      forwarded[name] = value;
    }
    return forwarded;
  }

  async #managed(): Promise<Managed | undefined> {
    const apiKey = await this.#host.secrets.get(CODEX_SECRET_NAMESPACE, CODEX_API_KEY_SECRET);
    if (apiKey !== null) {
      this.#managedKind = "api_key";
      return { kind: "api_key", apiKey: decode(apiKey) };
    }
    const tokens = await this.#host.secrets.get(CODEX_SECRET_NAMESPACE, CODEX_TOKENS_SECRET);
    if (tokens !== null) {
      this.#managedKind = "tokens";
      return { kind: "tokens", tokens: JSON.parse(decode(tokens)) as CodexTransferredTokens };
    }
    this.#managedKind = undefined;
    return undefined;
  }

  /** The `codex app-server` spawn: a managed profile uses the instance's state directory as Codex's home. */
  async #spawnRequest(): Promise<SpawnRequest> {
    const managed = await this.#managed();
    return {
      command: this.#config.binaryPath,
      args: ["app-server", ...(this.#config.extraArgs ?? [])],
      env: { ...this.#forwardedEnvironment(), ...(managed === undefined ? {} : { CODEX_HOME: this.#host.paths.stateDir }) },
      purpose: "runtime",
      stdin: "pipe",
    };
  }

  /** Signs a fresh app-server in with the managed credential. The ambient account needs nothing: Codex reads its own home. */
  async #signIn(connection: CodexConnection): Promise<void> {
    const managed = await this.#managed();
    if (managed === undefined) return;
    try {
      if (managed.kind === "api_key") {
        const account = await connection.client.accountRead({ refreshToken: false });
        if (account.account?.type === "apiKey") return;
        await connection.client.accountLoginStart({ type: "apiKey", apiKey: managed.apiKey });
        return;
      }
      await connection.client.accountLoginStart({
        type: "chatgptAuthTokens",
        accessToken: managed.tokens.accessToken,
        chatgptAccountId: managed.tokens.chatgptAccountId,
        ...(managed.tokens.chatgptPlanType === undefined ? {} : { chatgptPlanType: managed.tokens.chatgptPlanType }),
      });
    } catch (error) {
      await connection.close();
      throw callErrorFromCodex(error, "account");
    }
  }

  async #refreshTokens(): Promise<{ accessToken: string; chatgptAccountId: string; chatgptPlanType?: string | null }> {
    const managed = await this.#managed();
    if (managed?.kind !== "tokens") throw callErrors.authRequired([...CODEX_AUTH_METHODS], "This instance holds no handed-over ChatGPT tokens");
    return { accessToken: managed.tokens.accessToken, chatgptAccountId: managed.tokens.chatgptAccountId, chatgptPlanType: managed.tokens.chatgptPlanType ?? null };
  }

  /** The app-server this instance uses for account calls: sign-in, catalog, limits and native sessions. Started on first use. */
  #accountConnection(): Promise<CodexConnection> {
    this.#account ??= (async () => {
      if (this.#disposed) throw callErrors.invalidState("instance_disposed");
      if ((await this.#host.process.resolveExecutable(this.#config.binaryPath)) === null) throw this.#unavailable();
      let connection: CodexConnection | undefined;
      connection = await CodexConnection.start(this.#host, {
        spawn: await this.#spawnRequest(),
        optOutNotificationMethods: ["turn/diff/updated"],
        handshakeTimeoutMs: 120_000,
        handlers: {
          onNotification: (method, params) => this.#onAccountNotification(method, params),
          onRequest: async (method) => {
            if (method === "account/chatgptAuthTokens/refresh") return this.#refreshTokens();
            throw new JsonRpcError(-32601, `The ARI Codex driver does not handle ${method} here`);
          },
          onExit: (_exit, byDriver) => {
            if (!byDriver && connection !== undefined && this.#accountCurrent === connection) {
              this.#accountCurrent = undefined;
              this.#account = undefined;
            }
          },
        },
      });
      this.#accountCurrent = connection;
      await this.#signIn(connection);
      return connection;
    })().catch((error: unknown) => {
      this.#account = undefined;
      throw error;
    });
    return this.#account;
  }

  async #restartAccountConnection(): Promise<void> {
    const account = this.#account;
    this.#account = undefined;
    if (account !== undefined) await (await account.catch(() => undefined))?.close();
  }

  #onAccountNotification(method: string, params: unknown): void {
    const record = (typeof params === "object" && params !== null ? params : {}) as { [key: string]: unknown };
    if (method === "account/login/completed") {
      const loginId = typeof record["loginId"] === "string" ? record["loginId"] : undefined;
      for (const flow of this.#flows.values()) {
        if (flow.loginId !== undefined && flow.loginId === loginId) flow.finish({ success: record["success"] === true, ...(typeof record["error"] === "string" ? { error: record["error"] } : {}) });
      }
      this.#changed();
    } else if (method === "account/updated") this.#changed();
    else if (method === "account/rateLimits/updated") {
      this.#limits = limitsFromCodex(record["rateLimits"] as Parameters<typeof limitsFromCodex>[0]);
      this.#changed();
    }
  }

  // Auth.

  /** The verdict before any runtime poison: a managed credential is configured; the ambient account is what `codex login status` says. */
  async #baseState(): Promise<AuthState> {
    const managed = await this.#managed();
    if (managed?.kind === "api_key") return { status: "configured", evidence: "passive", scope: "managed_profile" };
    if (managed?.kind === "tokens") {
      return {
        status: "configured",
        evidence: "passive",
        scope: "managed_profile",
        account: { id: managed.tokens.chatgptAccountId, ...(managed.tokens.chatgptPlanType === undefined ? {} : { plan: managed.tokens.chatgptPlanType }) },
      };
    }
    let check: { code: number | null; stdout: string; stderr: string };
    try {
      check = await this.#run(["login", "status"]);
    } catch {
      return { status: "unavailable", evidence: "active", scope: "ambient" };
    }
    const text = `${check.stderr}\n${check.stdout}`;
    // codex-rs/cli/src/login.rs (run_login_status) prints these lines to stderr.
    if (check.code === 1 && /^Not logged in/m.test(text)) return { status: "unauthenticated", evidence: "active", scope: "ambient" };
    if (check.code !== 0) return { status: "unavailable", evidence: "active", scope: "ambient" };
    if (/^API key configured/m.test(text)) return { status: "configured", evidence: "passive", scope: "ambient" };
    if (/^Logged in using /m.test(text)) return { status: "authenticated", evidence: "active", scope: "ambient" };
    return { status: "unknown", evidence: "passive", scope: "ambient" };
  }

  async #state(): Promise<AuthState> {
    const base = await this.#baseState();
    const until = this.#poison.get(base.scope);
    if (until === undefined || until <= Date.now()) return base;
    return { status: "unauthenticated", evidence: "runtime_poison", scope: base.scope, poisonExpiresAt: new Date(until).toISOString() };
  }

  auth: NonNullable<Instance["auth"]> = ((instance: CodexInstance) => ({
    get credentialBinding() {
      return instance.#credentialBinding();
    },
    methods: () => CODEX_AUTH_METHODS.map((method) => ({ ...method })),
    state: () => this.#state(),
    reportRuntimeFailure: async () => {
      const base = await this.#baseState();
      this.#poison.set(base.scope, Date.now() + CODEX_POISON_MS);
      this.#changed();
      return this.#state();
    },
    start: async (input) => {
      if (input.methodId === "api-key") {
        this.#apiKeyFlows += 1;
        const flow: AuthFlow = { flowId: `api-key-${this.#apiKeyFlows}`, methodId: "api-key", fields: [...(CODEX_AUTH_METHODS[2]!.fields ?? [])] };
        this.#flows.set(flow.flowId, { flowId: flow.flowId, methodId: "api-key", loginId: undefined, redirectUri: undefined, done: Promise.resolve({ success: false }), finish: () => undefined });
        return flow;
      }
      if (input.methodId !== "chatgpt" && input.methodId !== "device-code") throw callErrors.notFound({ resource: "auth method", id: input.methodId });
      const connection = await this.#accountConnection();
      const started = await connection.client.accountLoginStart(input.methodId === "chatgpt" ? { type: "chatgpt" } : { type: "chatgptDeviceCode" }).catch((error: unknown) => {
        throw callErrorFromCodex(error, "sign-in");
      });
      if (started.type !== "chatgpt" && started.type !== "chatgptDeviceCode") throw callErrors.protocol("unexpected login response", `Codex answered a ${input.methodId} sign-in with ${started.type}`);
      let finish: (outcome: { success: boolean; error?: string }) => void = () => undefined;
      const done = new Promise<{ success: boolean; error?: string }>((resolve) => {
        finish = resolve;
      });
      const redirectUri = started.type === "chatgpt" ? (new URL(started.authUrl).searchParams.get("redirect_uri") ?? undefined) : undefined;
      this.#flows.set(started.loginId, { flowId: started.loginId, methodId: input.methodId, loginId: started.loginId, redirectUri, done, finish });
      if (started.type === "chatgptDeviceCode") return { flowId: started.loginId, methodId: input.methodId, userCode: started.userCode, verificationUrl: started.verificationUrl };
      // Codex's own login listener takes the browser back. When the browser runs elsewhere, the host routes what it saw there to auth.complete.
      let instructions: string | undefined;
      if (input.callback.mode === "server") {
        const registration = await this.#host.callbacks.register(started.loginId);
        instructions = `After signing in, the browser returns to ${redirectUri ?? "Codex's sign-in listener"}. If that page cannot load on this device, send the address it shows to ${registration.url}.`;
      }
      return { flowId: started.loginId, methodId: input.methodId, url: started.authUrl, ...(instructions === undefined ? {} : { instructions }) };
    },
    complete: async (input) => {
      const flow = this.#flows.get(input.flowId);
      if (flow === undefined || flow.methodId !== "chatgpt" || flow.redirectUri === undefined) throw callErrors.notFound({ resource: "sign-in flow", id: input.flowId });
      let callback: URL;
      let expected: URL;
      try {
        callback = new URL(input.callbackUrl);
        expected = new URL(flow.redirectUri);
      } catch {
        throw callErrors.validation([{ message: "callbackUrl is not a URL", path: ["callbackUrl"] }]);
      }
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname);
      if (!loopback || callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
        throw callErrors.validation([{ message: `callbackUrl must be Codex's own sign-in address ${expected.origin}${expected.pathname}`, path: ["callbackUrl"] }]);
      }
      // Hand the provider's redirect to Codex's login listener on this machine; Codex exchanges the code and stores the tokens.
      await fetch(callback.href, { redirect: "manual" }).catch((error: unknown) => {
        throw callErrors.transport(`could not reach Codex's sign-in listener: ${error instanceof Error ? error.message : String(error)}`);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        flow.done,
        new Promise<{ success: boolean; error: string }>((resolve) => {
          timer = setTimeout(() => resolve({ success: false, error: "Codex did not finish the sign-in within 60 seconds" }), 60_000);
        }),
      ]).finally(() => clearTimeout(timer));
      this.#flows.delete(input.flowId);
      this.#poison.delete("ambient");
      this.#changed();
      const state = await this.#state();
      return outcome.success ? state : { ...state, actionRequired: { reason: outcome.error ?? "Sign-in failed" } };
    },
    respond: async (input) => {
      const flow = this.#flows.get(input.flowId);
      if (flow === undefined || flow.methodId !== "api-key") throw callErrors.notFound({ resource: "sign-in flow", id: input.flowId });
      const apiKey = input.values["apiKey"];
      if (apiKey === undefined || apiKey.trim() === "") throw callErrors.validation([{ message: "apiKey is required", path: ["values", "apiKey"] }]);
      await this.#host.secrets.set(CODEX_SECRET_NAMESPACE, CODEX_API_KEY_SECRET, new TextEncoder().encode(apiKey));
      this.#flows.delete(input.flowId);
      this.#poison.delete("managed_profile");
      await this.#restartAccountConnection();
      this.#changed();
      return this.#state();
    },
    cancel: async (flowId) => {
      const flow = this.#flows.get(flowId);
      this.#flows.delete(flowId);
      if (flow?.loginId !== undefined && this.#account !== undefined) {
        const connection = await this.#account.catch(() => undefined);
        await connection?.client.accountLoginCancel({ loginId: flow.loginId }).catch(() => undefined);
      }
      flow?.finish({ success: false, error: "cancelled" });
      return this.#state();
    },
    logout: async () => {
      const managed = await this.#managed();
      if (managed !== undefined) {
        await this.#host.secrets.delete(CODEX_SECRET_NAMESPACE, CODEX_API_KEY_SECRET);
        await this.#host.secrets.delete(CODEX_SECRET_NAMESPACE, CODEX_TOKENS_SECRET);
        this.#managedKind = undefined;
        await this.#restartAccountConnection();
      } else {
        const connection = await this.#accountConnection();
        await connection.client.accountLogout(null).catch((error: unknown) => {
          throw callErrorFromCodex(error, "account");
        });
      }
      this.#changed();
    },
    transferProfile: async (profile: TransferredProfile) => {
      if (profile.format !== CODEX_TRANSFER_FORMAT) throw callErrors.validation([{ message: `the Codex driver accepts profiles of format ${CODEX_TRANSFER_FORMAT}`, path: ["format"] }]);
      let tokens: unknown;
      try {
        tokens = JSON.parse(profile.data);
      } catch {
        throw callErrors.validation([{ message: "data is not JSON", path: ["data"] }]);
      }
      const valid = CodexTransferredTokensSchema.parse(tokens);
      await this.#host.secrets.set(CODEX_SECRET_NAMESPACE, CODEX_TOKENS_SECRET, new TextEncoder().encode(JSON.stringify(valid)));
      this.#managedKind = "tokens";
      this.#poison.delete("managed_profile");
      // New app-servers sign in with the handed-over tokens; the old account connection used the previous account.
      await this.#restartAccountConnection();
      this.#changed();
      return this.#state();
    },
  }))(this);

  /** Who owns the credential and refreshes it: Codex for the ambient sign-in, the host for a managed profile kept in its secrets. */
  #credentialBinding(): { owner: "provider" | "host"; key: string } {
    return this.#managedKind === undefined ? { owner: "provider", key: "codex:ambient" } : { owner: "host", key: `codex:${this.id}` };
  }

  // Catalog.

  catalog: Instance["catalog"] = {
    list: async () => {
      if (this.#catalog !== undefined) return this.#catalog;
      const connection = await this.#accountConnection();
      const models: ModelInfo[] = [];
      let defaultModelId: string | undefined;
      let cursor: string | undefined;
      do {
        const page = await connection.client.modelList({ ...(cursor === undefined ? {} : { cursor }) }).catch((error: unknown) => {
          throw callErrorFromCodex(error, "model catalog");
        });
        for (const model of page.data) {
          if (model.isDefault) defaultModelId = model.model;
          models.push({
            id: model.model,
            label: model.displayName,
            ...(model.description === "" ? {} : { description: model.description }),
            ...(model.hidden ? { legacy: true } : {}),
            options: [
              {
                id: "reasoningEffort",
                category: "reasoning",
                label: "Reasoning effort",
                type: "select",
                values: model.supportedReasoningEfforts.map((option) => ({ id: option.reasoningEffort, label: option.reasoningEffort, ...(option.description === "" ? {} : { description: option.description }) })),
                current: model.defaultReasoningEffort,
                scope: "turn",
                changeEffect: "next_turn",
              },
            ],
          });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
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
    advisory: async () => versionAdvisory((await this.probe()).version),
  };

  // Limits.

  limits: NonNullable<Instance["limits"]> = {
    current: async () => {
      const connection = await this.#accountConnection();
      const read = await connection.client.accountRateLimitsRead({}).catch((error: unknown) => {
        throw callErrorFromCodex(error, "rate limits");
      });
      this.#limits = limitsFromCodex(read.rateLimits);
      return this.#limits;
    },
    accountKey: () => (this.#managedKind === undefined ? "codex:ambient" : `codex:managed:${this.id}`),
    consumeResetCredit: async (input): Promise<ResetCreditOutcome> => {
      const connection = await this.#accountConnection();
      const consumed = await connection.client.accountRateLimitResetCreditConsume({ idempotencyKey: input.idempotencyKey }).catch((error: unknown) => {
        throw callErrorFromCodex(error, "reset credit");
      });
      const statuses: { [outcome: string]: ResetCreditOutcome["status"] } = { reset: "consumed", nothingToReset: "not_available", noCredit: "not_available", alreadyRedeemed: "already_consumed" };
      const limits = await this.limits.current().catch(() => undefined);
      return { status: statuses[consumed.outcome] ?? consumed.outcome, message: `Codex answered ${consumed.outcome}.`, ...(limits === undefined ? {} : { limits }) };
    },
  };

  // Native sessions.

  nativeSessions: NonNullable<Instance["nativeSessions"]> = {
    list: async (input: NativeSessionListInput & CodexNativeSessionFilters): Promise<NativeSessionInfoPage> => {
      const filters: Partial<ThreadListParams> = {};
      for (const [key, value] of Object.entries(input)) {
        if (!key.startsWith("x:")) continue;
        const native = NATIVE_SESSION_FILTERS[key];
        if (native === undefined) throw callErrors.validation([{ message: `Codex has no session filter ${key}`, path: [key] }]);
        if ((key === "x:codex.includedThreadIds" || key === "x:codex.excludedThreadIds") && Array.isArray(value) && value.length > 100) {
          throw callErrors.validation([{ message: `${key} takes at most 100 thread ids`, path: [key] }]);
        }
        (filters as { [key: string]: unknown })[native] = value;
      }
      const connection = await this.#accountConnection();
      const page = await connection.client.threadList({ cwd: input.cwd, ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...filters }).catch((error: unknown) => {
        throw callErrorFromCodex(error, "native sessions");
      });
      const items = page.data.map((thread): NativeSessionInfo => {
        const title = thread.name ?? (thread.preview === "" ? undefined : thread.preview);
        return {
          id: thread.id,
          ...(title === undefined || title === null ? {} : { title }),
          cwd: thread.cwd,
          createdAt: isoFromSeconds(thread.createdAt)!,
          updatedAt: isoFromSeconds(thread.updatedAt)!,
          handle: thread.id,
          native: strongRef(thread.id),
          "x:codex.modelProvider": thread.modelProvider,
          ...(thread.parentThreadId === null || thread.parentThreadId === undefined ? {} : { "x:codex.parentThreadId": thread.parentThreadId }),
        } as NativeSessionInfo;
      });
      return { items, nextCursor: page.nextCursor ?? null };
    },
    delete: async (id) => {
      const connection = await this.#accountConnection();
      await connection.client.threadDelete({ threadId: id }).catch((error: unknown) => {
        throw callErrorFromCodex(error, "native session");
      });
    },
    archive: async (id) => {
      const connection = await this.#accountConnection();
      await connection.client.threadArchive({ threadId: id }).catch((error: unknown) => {
        throw callErrorFromCodex(error, "native session");
      });
    },
  };

  // Sessions.

  async openSession(input: OpenSessionInput): Promise<Session> {
    if (this.#disposed) throw callErrors.invalidState("instance_disposed");
    if ((await this.#host.process.resolveExecutable(this.#config.binaryPath)) === null) throw this.#unavailable();
    const state = await this.#state();
    if (state.status === "unauthenticated") throw callErrors.authRequired([...CODEX_AUTH_METHODS], "Sign in to Codex first");
    this.#sessionCount += 1;
    const id = deriveId({ kind: "session", native: { id: null, strength: "none", ordinal: this.#sessionCount }, identityVersion: CODEX_IDENTITY_VERSION, scope: this.id });
    const session = new CodexSession(
      {
        host: this.#host as HostServices<unknown>,
        instanceId: this.id,
        capabilities: CODEX_CAPABILITIES,
        ...(this.#config.model === undefined ? {} : { defaultModel: this.#config.model }),
        ...(this.#config.reasoningEffort === undefined ? {} : { defaultEffort: this.#config.reasoningEffort }),
        spawnRequest: () => this.#spawnRequest(),
        signIn: (connection) => this.#signIn(connection),
        refreshTokens: () => this.#refreshTokens(),
        onLimits: (limits) => {
          this.#limits = limits;
          this.#changed();
        },
      },
      input,
      id,
    );
    await session.open();
    this.#sessions.add(session);
    return session;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    // Every session ends at once: each waits for its own app-server's process group, which can take the whole
    // kill grace, and ari-driver ends what is left 2 s after its shutdown began (docs/wire.md, "Lifetime").
    await Promise.all([...this.#sessions].map((session) => session.close()));
    this.#sessions.clear();
    await this.#restartAccountConnection();
    this.#changed();
  }
}

/** Reads which managed credential the instance holds, for `create()`. */
export async function managedKindOf(host: HostServices<unknown>): Promise<Managed["kind"] | undefined> {
  if ((await host.secrets.get(CODEX_SECRET_NAMESPACE, CODEX_API_KEY_SECRET)) !== null) return "api_key";
  if ((await host.secrets.get(CODEX_SECRET_NAMESPACE, CODEX_TOKENS_SECRET)) !== null) return "tokens";
  return undefined;
}
