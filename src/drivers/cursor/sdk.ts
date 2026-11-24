// The part of the Cursor TypeScript SDK (`@cursor/sdk`) this driver uses,
// written out as structural types, and the loader that finds the real SDK
// with a dynamic `import()`.
//
// The driver never imports the SDK's own types: its published declarations
// would then name a package a host may not have installed (proposal §17.10,
// "keep vendor types out of the public API"). These types restate exactly
// what the driver sends and reads. test/drivers/cursor/sdk-types.ts checks
// them against the pinned devDependency (@cursor/sdk 1.4.2): the SDK's module
// is assignable to `CursorSdk`, so every option and message the driver sends
// is one the SDK accepts, and every field the driver reads exists in the
// SDK's type with a compatible type.
//
// Members are function-typed properties, not methods, so TypeScript checks
// their parameters strictly. Field names follow the SDK (snake_case in stream
// messages, as the SDK has them). Sources: dist/esm/*.d.ts of @cursor/sdk
// 1.4.2 and https://cursor.com/docs/sdk/typescript.

import { callErrors } from "../../errors.ts";
import { CURSOR_INSTALL_HINT, CURSOR_SDK_PACKAGE } from "./config.ts";
import type { CursorSettingSource } from "./config.ts";

// What the driver sends.

/** `ModelSelection`: a model id and its parameters. */
export interface CursorModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

/** `McpServerConfig`: an inline MCP server, keyed by its name in `mcpServers`. */
export type CursorMcpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

/** `SDKImage` as a local agent takes it: base64 data (URL images are cloud only). */
export interface CursorImage {
  data: string;
  mimeType: string;
}

/** `SDKUserMessage`: prompt text with images. */
export interface CursorUserMessage {
  text: string;
  images?: CursorImage[];
}

/** `AgentModeOption`: whether a run plans first or implements directly. */
export type CursorMode = "agent" | "plan";

/**
 * `AgentOptions` for a local agent. `Store` is the SDK's `LocalAgentStore`,
 * built with the SDK's own `JsonlLocalAgentStore`; the driver never looks inside it.
 */
export interface CursorAgentOptions<Store> {
  apiKey: string;
  model: CursorModelSelection;
  name?: string;
  mode?: CursorMode;
  local: { cwd: string; store: Store; settingSources?: CursorSettingSource[] };
  mcpServers?: Record<string, CursorMcpServerConfig>;
  /** The built-in tools offered to the model (`ToolName[]`). */
  tools?: string[];
}

/**
 * `SendOptions`: per-run overrides. `mcpServers` replaces the creation-time
 * servers for the run. `onDelta` receives every raw interaction update of the
 * run, and the SDK awaits it before it handles the next one. `local.force`
 * expires the agent's active persisted run, if any, before this run starts
 * (`LocalSendOptions.force`).
 */
export interface CursorSendOptions {
  model?: CursorModelSelection;
  mode?: CursorMode;
  mcpServers?: Record<string, CursorMcpServerConfig>;
  local?: { force?: boolean };
  onDelta?: (args: { update: CursorInteractionUpdate }) => void;
}

// What the driver reads.

export interface CursorTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

/** `ToolCall`: one built-in tool's call. Cursor's argument and result shapes are not stable, so the driver reads them as unknown. */
export interface CursorToolCall {
  type: string;
  args?: unknown;
  result?: unknown;
}

/** Token counts of one Cursor turn (`TurnEndedUpdate.usage`). */
export interface CursorTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}

/**
 * `InteractionUpdate`, the raw updates of a run that `onDelta` receives,
 * with the fields the driver reads. Every update type the SDK defines has a
 * member here, so the SDK's union is assignable to this one.
 */
export type CursorInteractionUpdate =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-completed"; thinkingDurationMs: number }
  | { type: "tool-call-started"; callId: string; toolCall: CursorToolCall }
  | { type: "partial-tool-call"; callId: string; toolCall: CursorToolCall }
  | { type: "tool-call-completed"; callId: string; toolCall: CursorToolCall }
  | { type: "tool-call-delta"; callId: string }
  | { type: "user-message-appended"; userMessage: { text: string } }
  | { type: "token-delta" }
  | { type: "summary" }
  | { type: "summary-started" }
  | { type: "summary-completed" }
  | { type: "shell-output-delta" }
  | { type: "turn-ended"; usage?: CursorTurnUsage }
  | { type: "model-call-completed" }
  | { type: "step-started" }
  | { type: "step-completed" }
  | { type: "tool-requests-listed" };

/** `SDKMessage`, the events of `Run.stream()`. The driver reads its updates through `onDelta` instead and only drains the stream. */
export type CursorSdkMessage = { type: string };

/** `RunError`: a failed run's message and code. Cursor reports no reset time. */
export interface CursorRunError {
  message: string;
  code?: string;
}

/** `RunResult`: how a run ended. */
export interface CursorRunResult {
  id: string;
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: CursorRunError;
  usage?: CursorTokenUsage;
}

/** `SteerAckOutcome`: whether a steer reached the running turn. `queued` comes only from cloud agents. */
export type CursorSteerOutcome = "complete_delivered" | "revert_to_followup" | { outcome: "queued" };

/** `Run`: one prompt submission. */
export interface CursorRun {
  readonly id: string;
  readonly status: "running" | "finished" | "error" | "cancelled";
  stream: () => AsyncIterable<CursorSdkMessage>;
  wait: () => Promise<CursorRunResult>;
  cancel: () => Promise<void>;
  steer?: (text: string) => Promise<CursorSteerOutcome>;
}

/** `SDKAgent`: one Cursor agent, which holds a conversation. */
export interface CursorSdkAgent {
  readonly agentId: string;
  send: (message: string | CursorUserMessage, options?: CursorSendOptions) => Promise<CursorRun>;
  /** Starts a run that summarizes the conversation (the CLI's /summarize). Local agents only. */
  summarize: () => Promise<CursorRun>;
  /** Begins disposal: releases the local executor this handle holds. */
  close: () => void;
}

/** `ModelListItem` from `Cursor.models.list()`. */
export interface CursorModel {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
}

/** `SDKUser` from `Cursor.me()`. */
export interface CursorUser {
  apiKeyName: string;
  userEmail?: string;
}

/** `StoredSdkCredentials`: the API key a `Cursor.auth.login()` minted and stored. */
export interface CursorStoredLogin {
  apiKey: string;
  apiKeyExpiresAtMs?: number;
  email?: string;
}

/** The SDK module: the members the driver calls. */
export interface CursorSdk<Store> {
  Agent: {
    create: (options: CursorAgentOptions<Store>) => Promise<CursorSdkAgent>;
    resume: (agentId: string, options: CursorAgentOptions<Store>) => Promise<CursorSdkAgent>;
  };
  Cursor: {
    me: (options: { apiKey: string }) => Promise<CursorUser>;
    models: { list: (options: { apiKey: string }) => Promise<CursorModel[]> };
  };
  /** The stored login of `Cursor.auth.login()` (`~/.cursor/sdk/auth.json` by default). */
  FileCredentialStore: new () => { load: () => Promise<CursorStoredLogin | undefined> };
  /** A local agent store of NDJSON files under the directory given. */
  JsonlLocalAgentStore: new (rootDir: string) => Store;
}

/** A loaded SDK and the version its package.json declares. */
export interface CursorSdkRuntime<Store> {
  readonly sdk: CursorSdk<Store>;
  readonly version: string | undefined;
}

/** Loads the SDK. Rejects with `driver_unavailable` naming the package when it cannot be loaded. */
export type CursorSdkLoader<Store> = () => Promise<CursorSdkRuntime<Store>>;

// A const, not the literal in `import()`: TypeScript then does not load the
// SDK's declarations while building ari (the package does not depend on it),
// and the repository rule for dist files still sees a literal.
const SDK_SPECIFIER = "@cursor/sdk";

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}

/** The `version` of the @cursor/sdk package.json above the module the SDK resolves to. */
async function sdkVersion(): Promise<string | undefined> {
  const fs = await import("node:fs/promises");
  let directory = new URL("./", import.meta.resolve(SDK_SPECIFIER));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(await fs.readFile(new URL("package.json", directory), "utf8")) as { name?: unknown; version?: unknown };
      if (manifest.name === CURSOR_SDK_PACKAGE) return typeof manifest.version === "string" ? manifest.version : undefined;
    } catch {
      // No package.json at this level: look one directory up.
    }
    directory = new URL("../", directory);
  }
  return undefined;
}

/**
 * The default loader: `import("@cursor/sdk")`, then the version from the
 * SDK's package.json. Importing the SDK does not load its local agent stack,
 * which the SDK loads on the first local agent (docs, "Runtime support").
 */
export async function loadCursorSdk(): Promise<CursorSdkRuntime<unknown>> {
  let sdk: CursorSdk<unknown>;
  try {
    sdk = (await import(SDK_SPECIFIER)) as CursorSdk<unknown>;
  } catch (error) {
    if (isModuleNotFound(error)) {
      throw callErrors.driverUnavailable({ package: CURSOR_SDK_PACKAGE, installHint: CURSOR_INSTALL_HINT }, `The Cursor TypeScript SDK (${CURSOR_SDK_PACKAGE}) is not installed. ${CURSOR_INSTALL_HINT}`);
    }
    throw callErrors.driverUnavailable(
      { package: CURSOR_SDK_PACKAGE, installHint: CURSOR_INSTALL_HINT },
      `The Cursor TypeScript SDK (${CURSOR_SDK_PACKAGE}) failed to load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { sdk, version: await sdkVersion().catch(() => undefined) };
}
