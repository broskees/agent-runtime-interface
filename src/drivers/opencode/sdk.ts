// Loading the OpenCode SDKs, which are optional peers: `@opencode-ai/sdk` for
// OpenCode 1.x servers and `@opencode/client` for OpenCode 2.x servers. Each
// is loaded with a dynamic `import()` only when a server of its generation is
// used, never at import time, and a missing one is reported by name.
//
// The interfaces below are the parts of each SDK the driver calls, written
// out here so the driver's declarations never name a package a consumer may
// not have. `test/drivers/opencode/sdk-types.test.ts` checks that the pinned
// SDKs (`@opencode-ai/sdk` 1.19.6, `@opencode/client` 2.1.2) satisfy them.

import { callErrors } from "../../errors.ts";
import { OPENCODE_V1_SDK_PACKAGE, OPENCODE_V2_SDK_PACKAGE } from "./config.ts";

/** A hey-api result: `data` on success, `error` (the decoded body) otherwise. */
export interface V1Result {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response?: { readonly status: number };
}

export interface V1CallOptions {
  readonly signal?: AbortSignal;
  readonly sseMaxRetryAttempts?: number;
  readonly onSseError?: (error: unknown) => void;
}

type V1Call<Parameters> = (parameters: Parameters, options?: V1CallOptions) => Promise<V1Result>;
type Directory = { directory?: string };
type V1Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" };
type V1Part = { type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string };

/** The `@opencode-ai/sdk/v2` client calls the 1.x runtime makes (operation ids of the 1.19.6 OpenAPI document in brackets). */
export interface V1Client {
  readonly global: { health(options?: V1CallOptions): Promise<V1Result> };
  readonly event: { subscribe(parameters: Directory, options?: V1CallOptions): Promise<{ readonly stream: AsyncGenerator<unknown, void, unknown> }> };
  readonly session: {
    /** [session.create] */
    create: V1Call<Directory & { title?: string; permission?: V1Rule[] }>;
    /** [session.get] */
    get: V1Call<Directory & { sessionID: string }>;
    /** [session.update] */
    update: V1Call<Directory & { sessionID: string; permission?: V1Rule[] }>;
    /** [session.messages] */
    messages: V1Call<Directory & { sessionID: string }>;
    /** [session.prompt_async] */
    promptAsync: V1Call<Directory & { sessionID: string; messageID?: string; model?: { providerID: string; modelID: string }; agent?: string; system?: string; parts?: V1Part[] }>;
    /** [session.abort] */
    abort: V1Call<Directory & { sessionID: string }>;
    /** [session.fork] */
    fork: V1Call<Directory & { sessionID: string; messageID?: string }>;
    /** [session.revert] */
    revert: V1Call<Directory & { sessionID: string; messageID?: string }>;
    /** [session.summarize] */
    summarize: V1Call<Directory & { sessionID: string; providerID?: string; modelID?: string }>;
  };
  /** [permission.reply] */
  readonly permission: { reply: V1Call<Directory & { requestID: string; reply?: "once" | "always" | "reject"; message?: string }> };
  /** [question.reply], [question.reject] */
  readonly question: { reply: V1Call<Directory & { requestID: string; answers?: string[][] }>; reject: V1Call<Directory & { requestID: string }> };
  /** [mcp.add], [mcp.disconnect] */
  readonly mcp: {
    add: V1Call<Directory & { name?: string; config?: { type: "local"; command: string[]; environment?: { [name: string]: string } } | { type: "remote"; url: string; headers?: { [name: string]: string } } }>;
    disconnect: V1Call<Directory & { name: string }>;
  };
  /** [config.providers] */
  readonly config: { providers: V1Call<Directory> };
}

export interface V1Sdk {
  createOpencodeClient(config: { baseUrl: string; headers?: { [name: string]: string } }): V1Client;
}

export interface V2RequestOptions {
  readonly signal?: AbortSignal;
}

type Location = { readonly directory: string };
type V2Rule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" };

/** The `@opencode/client` calls the 2.x runtime makes (operation ids of the 2.1.2 OpenAPI document in brackets). */
export interface V2Client {
  /** [server.info] */
  readonly server: { info(options?: V2RequestOptions): Promise<unknown> };
  readonly event: { subscribe(options?: V2RequestOptions): AsyncIterable<unknown> };
  readonly session: {
    /** [session.create] */
    create(input: { readonly location?: Location; readonly title?: string; readonly agent?: string; readonly model?: { readonly id: string; readonly providerID: string }; readonly permissions?: ReadonlyArray<V2Rule> }): Promise<unknown>;
    /** [session.get] */
    get(input: { readonly sessionID: string }): Promise<unknown>;
    /** [session.update] */
    update(input: { readonly sessionID: string; readonly permissions?: ReadonlyArray<V2Rule> }): Promise<void>;
    /** [session.active] */
    active(): Promise<unknown>;
    /** [session.prompt] */
    prompt(input: {
      readonly sessionID: string;
      readonly id?: string;
      readonly text: string;
      readonly files?: ReadonlyArray<{ readonly uri: string; readonly name?: string }>;
      readonly metadata?: { readonly [key: string]: boolean | string | number };
      readonly delivery?: "steer" | "queue";
      readonly resume?: boolean;
    }): Promise<unknown>;
    /** [session.switchModel] */
    switchModel(input: { readonly sessionID: string; readonly model: { readonly id: string; readonly providerID: string } }): Promise<void>;
    /** [session.switchAgent] */
    switchAgent(input: { readonly sessionID: string; readonly agent: string }): Promise<void>;
    /** [session.interrupt] */
    interrupt(input: { readonly sessionID: string }): Promise<unknown>;
    /** [session.fork] */
    fork(input: { readonly sessionID: string; readonly before?: string }): Promise<unknown>;
    /** [session.compact] */
    compact(input: { readonly sessionID: string }): Promise<unknown>;
    readonly revert: {
      /** [session.revert.stage] */
      stage(input: { readonly sessionID: string; readonly messageID: string }): Promise<unknown>;
      /** [session.revert.commit] */
      commit(input: { readonly sessionID: string }): Promise<void>;
    };
    readonly inbox: {
      /** [session.inbox.cancel] */
      cancel(input: { readonly sessionID: string; readonly inboxID: string }): Promise<void>;
    };
    readonly instructions: {
      readonly entry: {
        /** [experimental.session.instructions.entry.put] */
        put(input: { readonly sessionID: string; readonly key: string; readonly value: string }): Promise<void>;
        /** [experimental.session.instructions.entry.remove] */
        remove(input: { readonly sessionID: string; readonly key: string }): Promise<void>;
      };
    };
    readonly form: {
      /** [session.form.reply] */
      reply(input: { readonly sessionID: string; readonly formID: string; readonly answer: { readonly [key: string]: string | string[] } }): Promise<void>;
      /** [session.form.cancel] */
      cancel(input: { readonly sessionID: string; readonly formID: string }): Promise<void>;
    };
  };
  /** [session.message.list] */
  readonly message: { list(input: { readonly sessionID: string }): Promise<unknown> };
  /** [session.permission.reply] */
  readonly permission: { reply(input: { readonly sessionID: string; readonly requestID: string; readonly decision: "once" | "always" | "reject" }): Promise<void> };
  /** [experimental.mcp.add], [experimental.mcp.remove] */
  readonly mcp: {
    add(input: {
      readonly server: string;
      readonly location: Location;
      readonly config: { readonly type: "local"; readonly command: ReadonlyArray<string>; readonly environment?: { readonly [name: string]: string } } | { readonly type: "remote"; readonly url: string; readonly headers?: { readonly [name: string]: string } };
    }): Promise<void>;
    remove(input: { readonly server: string; readonly location: Location }): Promise<void>;
  };
  /** [model.list] */
  readonly model: { list(input?: { readonly location?: Location }): Promise<unknown> };
}

export interface V2Sdk {
  readonly OpenCode: { make(options: { readonly baseUrl: string; readonly headers?: { readonly [name: string]: string } }): V2Client };
}

/** How the driver loads each SDK; tests may pass loaders that fail, to see the driver report a missing package. */
export interface OpencodeSdkLoaders {
  readonly v1?: () => Promise<V1Sdk>;
  readonly v2?: () => Promise<V2Sdk>;
}

function isMissingModule(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || (error instanceof Error && /Cannot find (module|package)/i.test(error.message));
}

function unavailable(packageName: string, generation: string, error: unknown) {
  if (!isMissingModule(error)) {
    return callErrors.driverUnavailable({ package: packageName }, `${packageName} could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
  return callErrors.driverUnavailable(
    { package: packageName, installHint: `npm install ${packageName}` },
    `The OpenCode driver needs the optional peer dependency "${packageName}" to talk to an OpenCode ${generation} server, and it is not installed`,
  );
}

// String-typed specifiers: the type checker then does not load the SDKs'
// declarations, so building `ari` never needs them. Each is a `const` bound to
// a literal, which the repository rules accept for a dynamic import of an
// optional peer.
const V1_SDK_SPECIFIER: string = "@opencode-ai/sdk/v2";
const V2_SDK_SPECIFIER: string = "@opencode/client";

export const defaultV1Loader = async (): Promise<V1Sdk> => (await import(V1_SDK_SPECIFIER)) as V1Sdk;
export const defaultV2Loader = async (): Promise<V2Sdk> => (await import(V2_SDK_SPECIFIER)) as V2Sdk;

/** Loads the SDK for a server generation, or throws `driver_unavailable` naming the package to install. */
export async function loadSdk(generation: 1, loaders: OpencodeSdkLoaders): Promise<V1Sdk>;
export async function loadSdk(generation: 2, loaders: OpencodeSdkLoaders): Promise<V2Sdk>;
export async function loadSdk(generation: 1 | 2, loaders: OpencodeSdkLoaders): Promise<V1Sdk | V2Sdk>;
export async function loadSdk(generation: 1 | 2, loaders: OpencodeSdkLoaders): Promise<V1Sdk | V2Sdk> {
  if (generation === 1) {
    try {
      return await (loaders.v1 ?? defaultV1Loader)();
    } catch (error) {
      throw unavailable(OPENCODE_V1_SDK_PACKAGE, "1.x", error);
    }
  }
  try {
    return await (loaders.v2 ?? defaultV2Loader)();
  } catch (error) {
    throw unavailable(OPENCODE_V2_SDK_PACKAGE, "2.x", error);
  }
}
