// The part of the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) this
// driver uses, written out as structural types, and the loader that finds the
// real SDK with a dynamic `import()`.
//
// The driver never imports the SDK's own types: its published declarations
// would then name a package a host may not have installed. Instead these
// types restate exactly what the driver sends and reads.
// test/drivers/claude/sdk-types.ts checks them against the pinned SDK
// devDependency: the SDK's module is assignable to `ClaudeSdk` (so every
// option, message and callback result the driver sends is one the SDK
// accepts), and every message field the driver reads exists in the SDK's
// type with a compatible type.
//
// Field names follow the SDK (snake_case where it uses it). Sources: the SDK's
// sdk.d.ts at 0.3.330 and https://docs.claude.com/en/docs/agent-sdk/typescript.

import { callErrors } from "../../errors.ts";
import { CLAUDE_INSTALL_HINT, CLAUDE_SDK_PACKAGE } from "../../meta/claude.ts";

/** The SDK's `UUID` (from `node:crypto`): five hyphen-separated groups. */
export type ClaudeUuid = `${string}-${string}-${string}-${string}-${string}`;

// What the driver sends.

export type ClaudeImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** A content block of a user message (`MessageParam` content, Anthropic Messages API). */
export type ClaudeContentBlockParam =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ClaudeImageMediaType; data: string } | { type: "url"; url: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string }
  | { type: "document"; source: { type: "text"; media_type: "text/plain"; data: string }; title?: string };

/** `SDKUserMessage`: one message the driver streams into a query. */
export type ClaudeUserMessage = {
  type: "user";
  message: { role: "user"; content: string | ClaudeContentBlockParam[] };
  parent_tool_use_id: null;
  uuid?: ClaudeUuid;
  /** `now`: interrupt the running turn and read this next (a steer). `later`: hold it until the turn ends (a queued turn). */
  priority?: "now" | "next" | "later";
  isSynthetic?: boolean;
  shouldQuery?: boolean;
};

export type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
export type ClaudePermissionDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";
export type ClaudePermissionBehavior = "allow" | "deny" | "ask";
export type ClaudePermissionRule = { toolName: string; ruleContent?: string };

/** `PermissionUpdate`: a rule change Claude suggests with a permission prompt, returned as is to accept it. */
export type ClaudePermissionUpdate =
  | { type: "addRules"; rules: ClaudePermissionRule[]; behavior: ClaudePermissionBehavior; destination: ClaudePermissionDestination }
  | { type: "replaceRules"; rules: ClaudePermissionRule[]; behavior: ClaudePermissionBehavior; destination: ClaudePermissionDestination }
  | { type: "removeRules"; rules: ClaudePermissionRule[]; behavior: ClaudePermissionBehavior; destination: ClaudePermissionDestination }
  | { type: "setMode"; mode: ClaudePermissionMode; destination: ClaudePermissionDestination }
  | { type: "addDirectories"; directories: string[]; destination: ClaudePermissionDestination }
  | { type: "removeDirectories"; directories: string[]; destination: ClaudePermissionDestination };

/** `PermissionResult`: the answer to one `canUseTool` call. */
export type ClaudePermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: ClaudePermissionUpdate[]; decisionClassification?: "user_temporary" | "user_permanent" }
  | { behavior: "deny"; message: string; interrupt?: boolean; decisionClassification?: "user_reject" };

/** What `canUseTool` receives besides the tool name and input. */
export type ClaudeCanUseToolOptions = {
  signal: AbortSignal;
  suggestions?: ClaudePermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  suppressAlwaysAllowRule?: boolean;
  toolUseID: string;
  agentID?: string;
  requestId: string;
  matchedAskRule?: { source: string; toolName: string; ruleContent?: string };
};

export type ClaudeCanUseTool = (toolName: string, input: Record<string, unknown>, options: ClaudeCanUseToolOptions) => Promise<ClaudePermissionResult>;

/** An MCP server Claude Code runs or connects to. `alwaysLoad` keeps its tools out of tool search's deferral. */
export type ClaudeMcpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string>; alwaysLoad?: boolean }
  | { type: "sse"; url: string; headers?: Record<string, string>; alwaysLoad?: boolean }
  | { type: "http"; url: string; headers?: Record<string, string>; alwaysLoad?: boolean };

/** One settings-file command hook (`Settings.hooks[event][].hooks[]`), the only kind the `claude.hooks` extension passes. */
export type ClaudeCommandHook = { type: "command"; command: string; args?: string[]; timeout?: number; statusMessage?: string; once?: boolean; async?: boolean };
export type ClaudeHookSettings = { [event: string]: Array<{ matcher?: string; hooks: ClaudeCommandHook[] }> };

/** The claude_code preset (sessions) or a plain prompt (text generation, which runs without tools). */
export type ClaudeSystemPrompt = { type: "preset"; preset: "claude_code"; append?: string; snapshot?: boolean } | string;

/** The `query()` options this driver sets. */
export type ClaudeQueryOptions = {
  cwd?: string;
  env?: { [name: string]: string | undefined };
  additionalDirectories?: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: ClaudePermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  canUseTool?: ClaudeCanUseTool;
  systemPrompt?: ClaudeSystemPrompt;
  settingSources?: Array<"user" | "project" | "local">;
  includePartialMessages?: boolean;
  includeHookEvents?: boolean;
  enableFileCheckpointing?: boolean;
  perTaskStopAffordance?: boolean;
  persistSession?: boolean;
  sessionId?: string;
  resume?: string;
  forkSession?: boolean;
  resumeSessionAt?: string;
  pathToClaudeCodeExecutable?: string;
  mcpServers?: Record<string, ClaudeMcpServerConfig>;
  strictMcpConfig?: boolean;
  tools?: string[];
  maxTurns?: number;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  abortController?: AbortController;
  stderr?: (data: string) => void;
};

// What the driver reads. Each type lists only the fields the driver looks at.

/** A content block of an assistant message (`BetaMessage.content`). */
export type ClaudeAssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: string };

export type ClaudeAssistantMessage = {
  type: "assistant";
  uuid: string;
  session_id: string;
  message: { id: string; model: string; content: ClaudeAssistantBlock[] };
  parent_tool_use_id: string | null;
  error?: string;
  agent_id?: string;
  user_message_uuids?: string[];
};

export type ClaudeToolResultBlock = { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean };

/** A user message on the stream: tool results, or a replayed prompt. */
export type ClaudeUserMessageOut = {
  type: "user";
  uuid?: string;
  message: { content: unknown };
  parent_tool_use_id: string | null;
  isReplay?: true;
  tool_use_result?: unknown;
};

/** `SDKPartialAssistantMessage`: one Messages API stream event. */
export type ClaudeStreamEventMessage = {
  type: "stream_event";
  uuid: string;
  parent_tool_use_id: string | null;
  event: { type: string };
};

export type ClaudeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
};

export type ClaudeResultMessage = {
  type: "result";
  subtype: string;
  uuid: string;
  session_id: string;
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
  usage: ClaudeUsage;
  terminal_reason?: string;
  user_message_uuids?: string[];
  stop_reason: string | null;
  /** Success arm: the final text. */
  result?: string;
  /** Error arms: what went wrong. */
  errors?: string[];
  api_error_status?: number | null;
  /** Why Claude Code refused to start (with CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1). */
  startup_failure_reason?: string;
  /** Set when a local command such as /compact completed the turn. */
  local_command?: string;
  /** With `outputFormat`: the structured answer. */
  structured_output?: unknown;
};

export type ClaudeRateLimitInfo = {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
};

export type ClaudeSystemMessage = { type: "system"; subtype: string; uuid: string; session_id: string };

export type ClaudeInitMessage = ClaudeSystemMessage & { subtype: "init"; model: string; cwd: string; claude_code_version: string; slash_commands: string[]; permissionMode: ClaudePermissionMode };
export type ClaudeTaskStartedMessage = ClaudeSystemMessage & {
  subtype: "task_started";
  task_id: string;
  tool_use_id?: string;
  description: string;
  task_type?: string;
  subagent_type?: string;
  is_backgrounded?: boolean;
  prompt?: string;
};
export type ClaudeTaskNotificationMessage = ClaudeSystemMessage & {
  subtype: "task_notification";
  task_id: string;
  tool_use_id?: string;
  status: "completed" | "failed" | "stopped";
  summary: string;
};
export type ClaudeTaskUpdatedMessage = ClaudeSystemMessage & {
  subtype: "task_updated";
  task_id: string;
  patch: { status?: "pending" | "running" | "completed" | "failed" | "killed" | "paused"; description?: string; error?: string; is_backgrounded?: boolean };
};
export type ClaudeApiRetryMessage = ClaudeSystemMessage & { subtype: "api_retry"; attempt: number; max_retries: number; retry_delay_ms: number; error: string };
export type ClaudeCompactBoundaryMessage = ClaudeSystemMessage & { subtype: "compact_boundary"; compact_metadata: { trigger: "manual" | "auto"; pre_tokens: number } };
export type ClaudeHookMessage = ClaudeSystemMessage & {
  subtype: "hook_started" | "hook_progress" | "hook_response";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output?: string;
  outcome?: "success" | "error" | "cancelled";
  exit_code?: number;
};
export type ClaudeCommandsChangedMessage = ClaudeSystemMessage & { subtype: "commands_changed"; commands: ClaudeSlashCommand[] };
export type ClaudeRateLimitEvent = { type: "rate_limit_event"; uuid: string; session_id: string; rate_limit_info: ClaudeRateLimitInfo };

/** Any message `Query` yields; the driver switches on `type` and `subtype` and reads the matching type above. */
export type ClaudeMessage =
  | ClaudeAssistantMessage
  | ClaudeUserMessageOut
  | ClaudeStreamEventMessage
  | ClaudeResultMessage
  | ClaudeSystemMessage
  | ClaudeRateLimitEvent
  | { type: string };

export type ClaudeModelInfo = { value: string; displayName: string; description: string; supportedEffortLevels?: Array<"low" | "medium" | "high" | "xhigh" | "max"> };
export type ClaudeSlashCommand = { name: string; description: string; argumentHint: string };
export type ClaudeAccountInfo = { email?: string; organization?: string; subscriptionType?: string; apiProvider?: string };
export type ClaudeInitializeResult = { models: ClaudeModelInfo[]; commands: ClaudeSlashCommand[]; account: ClaudeAccountInfo };
export type ClaudeRewindResult = { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number };
export type ClaudeSetServersResult = { added: string[]; removed: string[]; errors: Record<string, string> };

/** The `Query` a `query()` call returns: its message stream plus the control methods the driver calls. */
export type ClaudeQuery = AsyncIterable<ClaudeMessage> & {
  readonly interrupt: () => Promise<unknown>;
  readonly setPermissionMode: (mode: ClaudePermissionMode) => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setMcpServers: (servers: Record<string, ClaudeMcpServerConfig>) => Promise<ClaudeSetServersResult>;
  readonly applyFlagSettings: (settings: { hooks?: ClaudeHookSettings | null; effortLevel?: "low" | "medium" | "high" | "xhigh" | "max" | null }) => Promise<void>;
  readonly stopTask: (taskId: string) => Promise<void>;
  readonly rewindFiles: (userMessageId: string, options?: { dryRun?: boolean }) => Promise<ClaudeRewindResult>;
  readonly initializationResult: () => Promise<ClaudeInitializeResult>;
  readonly supportedModels: () => Promise<ClaudeModelInfo[]>;
  readonly close: () => void;
};

export type ClaudeSessionInfo = { sessionId: string; summary: string; lastModified: number; cwd?: string; createdAt?: number; customTitle?: string; firstPrompt?: string };
export type ClaudeSessionMessage = { type: "user" | "assistant" | "system"; uuid: string; session_id: string; message: unknown; parent_tool_use_id: string | null };

/** The SDK module, as far as this driver uses it. */
export type ClaudeSdk = {
  readonly query: (params: { prompt: AsyncIterable<ClaudeUserMessage>; options?: ClaudeQueryOptions }) => ClaudeQuery;
  readonly getSessionInfo: (sessionId: string, options?: { dir?: string }) => Promise<ClaudeSessionInfo | undefined>;
  readonly getSessionMessages: (sessionId: string, options?: { dir?: string }) => Promise<ClaudeSessionMessage[]>;
  readonly listSessions: (options?: { dir?: string; limit?: number; offset?: number }) => Promise<ClaudeSessionInfo[]>;
  readonly deleteSession: (sessionId: string, options?: { dir?: string }) => Promise<void>;
  readonly archiveSession: (sessionId: string, options?: { dir?: string }) => Promise<void>;
};

/** A loaded SDK and what the driver found beside it. */
export interface ClaudeSdkRuntime {
  readonly sdk: ClaudeSdk;
  /** The SDK package version, from its package.json. */
  readonly version: string | undefined;
  /** The Claude Code version the SDK bundles (its package.json `claudeCodeVersion`). */
  readonly claudeCodeVersion: string | undefined;
  /** The bundled native Claude Code binary, or null when the SDK's platform package is missing. */
  readonly bundledExecutable: string | null;
}

/** Loads the SDK. Rejects with `driver_unavailable` naming the package when it is not installed. */
export type ClaudeSdkLoader = () => Promise<ClaudeSdkRuntime>;

// A const, not the literal in `import()`: TypeScript then does not load the
// SDK's declarations while building ari (they name packages ari does not
// depend on), and the repository rule for dist files still sees a literal.
const SDK_SPECIFIER = "@anthropic-ai/claude-agent-sdk";

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}

/** The platform packages the SDK looks in for its native binary, in the SDK's own order (sdk.mjs, 0.3.330). */
export function nativeBinaryCandidates(platform: string, arch: string, preferMusl: boolean): string[] {
  const base = CLAUDE_SDK_PACKAGE;
  const extension = platform === "win32" ? ".exe" : "";
  const packages =
    platform === "android"
      ? [`${base}-linux-${arch}-android`]
      : platform === "linux"
        ? preferMusl
          ? [`${base}-linux-${arch}-musl`, `${base}-linux-${arch}`]
          : [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`]
        : [`${base}-${platform}-${arch}`];
  return packages.map((name) => `${name}/claude${extension}`);
}

/**
 * The default loader: `import("@anthropic-ai/claude-agent-sdk")`, then the
 * SDK's package.json for its version, then the native binary the SDK would
 * run, found the way the SDK finds it. Nothing is spawned.
 */
export async function loadClaudeSdk(): Promise<ClaudeSdkRuntime> {
  let sdk: ClaudeSdk;
  try {
    sdk = (await import(SDK_SPECIFIER)) as ClaudeSdk;
  } catch (error) {
    if (isModuleNotFound(error)) {
      throw callErrors.driverUnavailable({ package: CLAUDE_SDK_PACKAGE, installHint: CLAUDE_INSTALL_HINT }, `The Claude Agent SDK (${CLAUDE_SDK_PACKAGE}) is not installed. ${CLAUDE_INSTALL_HINT}`);
    }
    throw callErrors.driverUnavailable(
      { package: CLAUDE_SDK_PACKAGE, installHint: CLAUDE_INSTALL_HINT },
      `The Claude Agent SDK (${CLAUDE_SDK_PACKAGE}) failed to load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const [{ createRequire }, fs, { fileURLToPath }] = await Promise.all([import("node:module"), import("node:fs/promises"), import("node:url")]);
  const entry = import.meta.resolve(SDK_SPECIFIER);
  let version: string | undefined;
  let claudeCodeVersion: string | undefined;
  try {
    const manifest = JSON.parse(await fs.readFile(new URL("./package.json", entry), "utf8")) as { version?: unknown; claudeCodeVersion?: unknown };
    if (typeof manifest.version === "string") version = manifest.version;
    if (typeof manifest.claudeCodeVersion === "string") claudeCodeVersion = manifest.claudeCodeVersion;
  } catch {
    version = undefined;
  }
  const require = createRequire(fileURLToPath(entry));
  const report = typeof process.report?.getReport === "function" ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }) : undefined;
  const preferMusl = process.platform === "linux" && report !== undefined && report.header?.glibcVersionRuntime === undefined;
  let bundledExecutable: string | null = null;
  for (const candidate of nativeBinaryCandidates(process.platform, process.arch, preferMusl)) {
    try {
      const resolved = require.resolve(candidate);
      await fs.access(resolved);
      bundledExecutable = resolved;
      break;
    } catch {
      continue;
    }
  }
  return { sdk, version, claudeCodeVersion, bundledExecutable };
}
