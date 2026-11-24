// The part of the Muse SDK (`@muse-code/sdk`) this driver uses, written out as
// structural types, and the loader that finds the real SDK with a dynamic
// `import()`.
//
// The driver never imports the SDK's own types: its published declarations
// would then name a package a host may not have installed. Instead these types
// restate what the driver sends over the Muse Session Protocol (MSP) and what
// it reads back. test/drivers/muse/sdk-types.ts checks them against the pinned
// SDK devDependency (1.4.25): the SDK's `Connection` is assignable to
// `MuseConnection`; every params type the driver sends is assignable to the
// SDK's `MspMethodMap` params (without the `commandId` the connection adds);
// and every result, notification and server request the SDK types is
// assignable to the driver's view of it. The fake host's frames are checked
// against the same SDK types in every test (test/drivers/muse/frames.ts).
//
// Sources: the SDK's dist/src/msp.d.ts and dist/src/connection/connection.d.ts
// at 1.4.25, and https://meta-models.github.io/muse-code-sdk/1.4/.

import { callErrors } from "../../errors.ts";
import { MUSE_SDK_INSTALL_HINT, MUSE_SDK_PACKAGE } from "../../meta/muse.ts";

/** The SDK's package specifier, as a constant so the build does not load its declarations. */
const SDK_SPECIFIER = "@muse-code/sdk";

// What the driver sends.

export type MuseApprovalMode = "allowAll" | "promptUnmatched" | "onRequest" | "denyUnmatched";
export type MuseReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** `SessionMcpServerConfig`: one MCP server added to one Muse session. */
export type MuseMcpServerConfig =
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: "streamableHttp"; url: string; headers?: Record<string, string> };

/** `SessionConfig`: per-session MCP servers. The driver never sends `developerPrompt` (docs/drivers/muse.md says why). */
export interface MuseSessionConfig {
  mcpServers?: Record<string, MuseMcpServerConfig>;
}

/** `TurnInputPart`, the two part types the driver sends. */
export type MuseInputPart = { type: "text"; text: string } | { type: "image"; base64Data: string; mediaType: string };

export interface MuseInitializeParams {
  clientInfo: { name: string; title?: string; version: string };
  capabilities?: { requestedCapabilities?: string[] };
}

export interface MuseSessionStartParams {
  sessionId?: string;
  workspaceRoot?: string;
  modelId?: string;
  providerId?: string;
  approvalMode?: MuseApprovalMode;
  permissionProfile?: string;
  config?: MuseSessionConfig;
}

export interface MuseSessionResumeParams {
  sessionId: string;
  excludeItems?: boolean;
  config?: MuseSessionConfig;
  permissionProfile?: string;
  modelId?: string;
}

export interface MuseSessionReadParams {
  sessionId: string;
  excludeItems?: boolean;
}

export interface MuseTurnStartParams {
  sessionId: string;
  input: MuseInputPart[];
  /** The host's own text, shown in transcripts; never model-visible. */
  displayText?: string;
  ifBusy?: "queue" | "steer" | "replace";
  reasoningEffort?: MuseReasoningEffort;
}

export interface MuseTurnSteerParams {
  sessionId: string;
  expectedTurnId: string;
  input: MuseInputPart[];
}

export interface MuseTurnInterruptParams {
  sessionId: string;
  turnId?: string;
}

export interface MuseTurnUnqueueParams {
  sessionId: string;
  turnId: string;
}

export interface MuseRequirementRef {
  approvalId: string;
  sourceIndex: number;
}

export interface MuseApprovalDecideParams {
  sessionId: string;
  approvalId: string;
  requirementId: MuseRequirementRef;
  choiceId: string;
  feedback?: string;
}

export interface MuseUserInputAnswer {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
  note?: string;
}

export interface MuseUserInputAnswerParams {
  sessionId: string;
  userInputId: string;
  answers: MuseUserInputAnswer[];
}

export interface MuseSessionSetModelParams {
  sessionId: string;
  model: { modelId: string; providerId?: string };
}

export interface MuseSessionSetApprovalModeParams {
  sessionId: string;
  mode: MuseApprovalMode;
}

export interface MuseSessionCompactParams {
  sessionId: string;
  turnId?: string;
}

export interface MuseModelListParams {
  sessionId?: string;
}

// What the driver reads.

export interface MuseSessionView {
  sessionId: string;
  status: string;
  activeTurnId: string | null;
  modelId: string | null;
  providerId: string | null;
  workspaceRoot: string | null;
  turnCount: number;
}

export interface MuseTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** `SubagentResult`, the part the driver reads. */
export interface MuseSubagentResult {
  summary: string;
  text?: string;
  errorKind?: string;
}

/** `Item`: the fields the driver reads. Every item carries `itemId`, `kind`, `revision` and `status`. */
export interface MuseItem {
  itemId: string;
  kind: string;
  revision: number;
  status: string;
  turnId?: string | null;
  text?: string;
  displayText?: string;
  summary?: string[];
  tool?: string;
  args?: string;
  visibleOutput?: string;
  failureReason?: string;
  truncated?: boolean;
  approvalId?: string;
  commandId?: string;
  steered?: boolean;
  outcome?: string;
  subagentId?: string;
  childSessionId?: string;
  objective?: string;
  role?: string;
  agentPath?: string;
  result?: MuseSubagentResult;
  commandText?: string;
  exitCode?: number;
  fallbackText?: string;
}

export interface MusePendingRequestPointer {
  kind: string;
  approvalId?: string;
  userInputId?: string;
  viewCursor: string;
}

export interface MuseInitializeResult {
  grantedCapabilities: string[];
  schema: { version: number; fingerprint: string };
  serverInfo: { name: string; version: string };
}

export interface MuseSessionStartResult {
  session: MuseSessionView;
  viewCursor: string;
}

/** `SessionHistory`: inline items, or the folded view snapshot. */
export interface MuseSessionHistory {
  mode: string;
  items: MuseItem[] | null;
  snapshot: { state: { items: MuseItem[] } } | null;
}

/** `LastTurn`: the last `turn/completed` the session folded, restated so a reopened session can report a failed last turn. */
export interface MuseLastTurn {
  turnId: string;
  terminal: string;
  reason?: string;
  error?: MuseTurnError;
}

export interface MuseSessionResumeResult {
  session: MuseSessionView;
  viewCursor: string;
  history: MuseSessionHistory;
  /** Pointers at the requests Muse re-issues as server requests right after this answer. */
  pendingRequests: MusePendingRequestPointer[];
  lastTurn?: MuseLastTurn;
}

export interface MuseSessionReadResult {
  session: MuseSessionView;
  viewCursor: string;
  history: MuseSessionHistory;
  lastTurn?: MuseLastTurn;
}

export interface MuseTurnStartResult {
  commandId: string;
  turnId: string;
  disposition: string;
}

export interface MuseTurnSteerResult {
  turnId: string;
}

export interface MuseTurnInterruptResult {
  turnId: string;
}

export interface MuseTurnUnqueueResult {
  turnId: string;
}

export interface MuseApprovalDecideResult {
  approvalId: string;
  terminal: boolean;
}

export interface MuseUserInputAnswerResult {
  userInputId: string;
}

export interface MuseSessionSetModelResult {
  status: string;
}

export interface MuseSessionSetApprovalModeResult {
  status: string;
}

export interface MuseSessionCompactResult {
  status: string;
  reason?: string;
}

export interface MuseModelEntry {
  modelId: string;
  displayLabel: string;
  description: string | null;
  providerId: string;
  contextLimit: number | null;
  isDefault: boolean;
  defaultReasoningEffort?: MuseReasoningEffort;
  variants?: MuseReasoningEffort[] | "unknown";
}

export interface MuseModelListResult {
  models: MuseModelEntry[];
}

export interface MuseSubscriptionUsage {
  observedAtMs: number;
  tier: string;
  window: { usedPercent: number; windowDurationMins: number; resetsAtMs: number };
  weekly: { usedPercent: number; resetsAtMs: number };
}

export interface MuseUsageReadResult {
  usage?: MuseSubscriptionUsage;
}

/** The methods the driver calls: params as the driver sends them (commands without `commandId`), results as it reads them. */
export interface MuseMethods {
  initialize: { params: MuseInitializeParams; result: MuseInitializeResult };
  "session/start": { params: MuseSessionStartParams; result: MuseSessionStartResult };
  "session/resume": { params: MuseSessionResumeParams; result: MuseSessionResumeResult };
  "session/read": { params: MuseSessionReadParams; result: MuseSessionReadResult };
  "session/setModel": { params: MuseSessionSetModelParams; result: MuseSessionSetModelResult };
  "session/setApprovalMode": { params: MuseSessionSetApprovalModeParams; result: MuseSessionSetApprovalModeResult };
  "session/compact": { params: MuseSessionCompactParams; result: MuseSessionCompactResult };
  "turn/start": { params: MuseTurnStartParams; result: MuseTurnStartResult };
  "turn/steer": { params: MuseTurnSteerParams; result: MuseTurnSteerResult };
  "turn/interrupt": { params: MuseTurnInterruptParams; result: MuseTurnInterruptResult };
  "turn/unqueue": { params: MuseTurnUnqueueParams; result: MuseTurnUnqueueResult };
  "approval/decide": { params: MuseApprovalDecideParams; result: MuseApprovalDecideResult };
  "userInput/answer": { params: MuseUserInputAnswerParams; result: MuseUserInputAnswerResult };
  "model/list": { params: MuseModelListParams; result: MuseModelListResult };
  "usage/read": { params: undefined; result: MuseUsageReadResult };
}

/** The methods that are commands: the connection mints and adds their `commandId`. */
export type MuseCommandMethod =
  | "session/start"
  | "session/resume"
  | "session/setModel"
  | "session/setApprovalMode"
  | "session/compact"
  | "turn/start"
  | "turn/steer"
  | "turn/interrupt"
  | "turn/unqueue"
  | "approval/decide"
  | "userInput/answer";

/** The methods that are queries: no `commandId`. */
export type MuseQueryMethod = Exclude<keyof MuseMethods, MuseCommandMethod>;

/** `ApprovalChoice`. */
export interface MuseApprovalChoice {
  choiceId: string;
  decision: string;
  label: string;
  scope: string;
  acceptsFeedback?: boolean;
}

/** `ApprovalSubject`, the fields the driver reads. */
export interface MuseApprovalSubject {
  kind: string;
  access?: string;
  command?: string;
  path?: string;
  host?: string;
  target?: string;
  toolName?: string;
  workspaceRoot?: string;
}

/** `ApprovalRequestParams`: an `approval/requested` notification and an `approval/request` server request carry it. */
export interface MuseApprovalRequest {
  sessionId: string;
  approvalId: string;
  turnId: string;
  itemId: string;
  toolName: string;
  rawArgs: string;
  subject: MuseApprovalSubject;
  currentRequirementId: MuseRequirementRef;
  availableChoices: MuseApprovalChoice[];
  subagentOrigin?: { subagentId: string; childSessionId: string };
}

export interface MuseApprovalUpdated {
  sessionId: string;
  approvalId: string;
  currentRequirementId: MuseRequirementRef;
  availableChoices: MuseApprovalChoice[];
  subject: MuseApprovalSubject;
}

export interface MuseApprovalResolved {
  sessionId: string;
  approvalId: string;
  decision: string;
}

/** `UserInputQuestion`. */
export interface MuseUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  selection: { mode: "single" | "multiple"; minSelections?: number; maxSelections?: number };
}

/** `UserInputRequestParams`: a `userInput/requested` notification and a `userInput/request` server request carry it. */
export interface MuseUserInputRequest {
  sessionId: string;
  userInputId: string;
  turnId: string;
  itemId: string;
  questions: MuseUserInputQuestion[];
}

export interface MuseUserInputSettled {
  sessionId: string;
  userInputId: string;
  outcome: string;
}

export interface MuseTurnStarted {
  sessionId: string;
  turnId: string;
  commandId: string;
}

/** `TurnError`: why a turn failed. */
export interface MuseTurnError {
  kind: string;
  message: string;
  retryable: boolean;
  quota?: { limitKind: string; resetsAtMs: number };
}

export interface MuseTurnCompleted {
  sessionId: string;
  turnId: string;
  terminal: string;
  reason?: string;
  error?: MuseTurnError;
  usage?: MuseTokenUsage;
}

export interface MuseTurnUnqueued {
  sessionId: string;
  turnId: string;
}

export interface MuseItemEvent {
  sessionId: string;
  item: MuseItem;
}

export interface MuseItemDelta {
  sessionId: string;
  itemId: string;
  field?: string;
  delta: string;
}

export interface MuseTokenUsageEvent {
  sessionId: string;
  turnId: string;
  modelId: string | null;
  usage: MuseTokenUsage;
  totalTokens: number;
}

export interface MuseContextUsageEvent {
  sessionId: string;
  usedTokens: number;
  windowTokens?: number;
}

export interface MuseTodoListChanged {
  sessionId: string;
  items: Array<{ text: string; status: string }>;
}

export interface MuseModelChanged {
  sessionId: string;
  modelId: string;
}

export interface MuseSessionClosed {
  sessionId: string;
  reason: string;
}

/** The notifications the driver reads, by method. */
export interface MuseNotifications {
  "turn/started": MuseTurnStarted;
  "turn/completed": MuseTurnCompleted;
  "turn/unqueued": MuseTurnUnqueued;
  "item/started": MuseItemEvent;
  "item/updated": MuseItemEvent;
  "item/completed": MuseItemEvent;
  "item/delta": MuseItemDelta;
  "approval/requested": MuseApprovalRequest;
  "approval/updated": MuseApprovalUpdated;
  "approval/resolved": MuseApprovalResolved;
  "userInput/requested": MuseUserInputRequest;
  "userInput/settled": MuseUserInputSettled;
  "session/tokenUsage": MuseTokenUsageEvent;
  "session/contextUsage": MuseContextUsageEvent;
  "session/todoListChanged": MuseTodoListChanged;
  "session/modelChanged": MuseModelChanged;
  "session/closed": MuseSessionClosed;
  "usage/changed": MuseSubscriptionUsage;
}

/** The server requests the driver answers, by method, with their params. */
export interface MuseServerRequests {
  "approval/request": MuseApprovalRequest;
  "userInput/request": MuseUserInputRequest;
}

// The SDK surface.

/** `DuplexTransport`: the text stream a connection speaks MSP over. */
export interface MuseDuplexTransport {
  readonly incoming: AsyncIterable<string>;
  write(chunk: string): Promise<void>;
  close?(flushed?: Promise<void>): void | Promise<void>;
}

/** `Request` and `Notification`, the envelopes the handlers receive. */
export interface MuseWireRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface MuseWireNotification {
  method: string;
  params?: Record<string, unknown>;
}

/** `CommandOptions`, the part the driver sets. */
export interface MuseCommandOptions {
  readonly commandId?: string;
  readonly maxAttempts?: number;
}

/** `Connection`: one MSP connection over newline-delimited JSON. */
export interface MuseConnection {
  readonly closed: Promise<void>;
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  command(method: string, params: Record<string, unknown>, options?: MuseCommandOptions): Promise<Record<string, unknown>>;
  notify(method: string, params?: Record<string, unknown>): void;
  mintCommandId(): string;
  onServerRequest(handler: (request: MuseWireRequest) => Promise<Record<string, unknown>>): void;
  onNotification(handler: (notification: MuseWireNotification) => void): void;
  onProtocolError(handler: (error: Error) => void): void;
  close(): Promise<void>;
}

/** `MspError`: the typed error a failed request rejects with. */
export interface MuseMspError extends Error {
  readonly code: number;
  readonly kind: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** The SDK module, the members the driver uses. */
export interface MuseSdk {
  readonly Connection: new (transport: MuseDuplexTransport, options?: { readonly mintCommandId?: () => string }) => MuseConnection;
  readonly MspError: abstract new (...args: never[]) => MuseMspError;
  createUuidV7Mint(): () => string;
}

/** A loaded SDK and the version its package.json names. */
export interface MuseSdkRuntime {
  readonly sdk: MuseSdk;
  readonly version: string | undefined;
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/** Loads `@muse-code/sdk` and reads its version. Throws `driver_unavailable` naming the package when it is missing or fails to load. */
export async function loadMuseSdk(): Promise<MuseSdkRuntime> {
  let sdk: MuseSdk;
  try {
    sdk = (await import(SDK_SPECIFIER)) as MuseSdk;
  } catch (error) {
    if (isModuleNotFound(error)) {
      throw callErrors.driverUnavailable({ package: MUSE_SDK_PACKAGE, installHint: MUSE_SDK_INSTALL_HINT }, `The Muse SDK (${MUSE_SDK_PACKAGE}) is not installed. ${MUSE_SDK_INSTALL_HINT}`);
    }
    throw callErrors.driverUnavailable(
      { package: MUSE_SDK_PACKAGE, installHint: MUSE_SDK_INSTALL_HINT },
      `The Muse SDK (${MUSE_SDK_PACKAGE}) failed to load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { sdk, version: await sdkVersion() };
}

/** The version in the SDK's own package.json, found by walking up from its entry module. */
async function sdkVersion(): Promise<string | undefined> {
  try {
    const fs = await import("node:fs/promises");
    let directory = new URL(".", import.meta.resolve(SDK_SPECIFIER));
    for (let depth = 0; depth < 6; depth += 1) {
      const text = await fs.readFile(new URL("package.json", directory), "utf8").catch(() => undefined);
      if (text !== undefined) {
        const manifest = JSON.parse(text) as { name?: unknown; version?: unknown };
        if (manifest.name === MUSE_SDK_PACKAGE) return typeof manifest.version === "string" ? manifest.version : undefined;
      }
      directory = new URL("..", directory);
    }
  } catch {
    return undefined;
  }
  return undefined;
}
