// What the Claude driver declares. docs/drivers/claude.md compares each value
// with the proposal's §1.2 Claude column and cites the vendor source for every
// difference; test/drivers/claude/capabilities.test.ts checks that each
// declared member works and each one declared off is absent or refused.

import type { Capabilities } from "../../generated/capabilities.ts";
import { ARI_VERSION } from "../../version.ts";
import { CLAUDE_IDENTITY_VERSION } from "./mapping.ts";

/** Extension namespaces the driver lists; each is version "1". */
export const CLAUDE_EXTENSIONS = ["claude.hooks", "claude.fileCheckpoints", "ari.goal"] as const;

export const CLAUDE_CAPABILITIES: Capabilities = {
  ariVersion: ARI_VERSION,
  sessions: {
    // Each thread runs its own query (one Claude Code process), so one session holds any number of threads.
    multipleThreads: true,
    // Query.setModel.
    switchModel: true,
    // Query.setPermissionMode.
    switchRuntimeMode: true,
    // canUseTool is a live callback into this process: a pending prompt dies with the query.
    pendingRequestsSurviveRestart: false,
    // release() closes idle queries; the next turn resumes the session with `resume`.
    release: true,
    feedbackUpload: false,
    contextUsageReuse: false,
  },
  threads: {
    createEmpty: true,
    // getSessionMessages reads the transcript.
    readSnapshot: true,
    // resumeSessionAt keeps the messages up to and including one uuid; nothing keeps none, so "back to the start" cannot be served.
    rollback: false,
    compact: false,
    injectHistory: false,
    unload: true,
    exposesNativeIds: true,
    // query({ resume, forkSession: true, resumeSessionAt }). Transcripts live per project directory, so a fork stays in its source's directory.
    fork: { supported: true, fromTurn: true, fromItem: false, fromSubagent: false, crossCwd: false },
  },
  turns: {
    interrupt: true,
    // A user message with priority "now" interrupts the running turn and is read next.
    steer: true,
    // A user message with priority "later" waits until the running turn ends and starts the next one.
    queue: true,
    emitsStarted: true,
    terminalStatus: "strong",
    // A steer ends the running native turn (terminal_reason aborted_*) and runs another for the same host turn.
    multiNativeTurnsPerRequest: true,
    steeringInterruptsTools: true,
  },
  streaming: { assistantText: true, reasoning: true, toolOutput: false, planText: false },
  tools: { mcp: true, dynamicTools: false, mcpApps: false, exposesToolItemIds: true },
  approvals: { command: true, fileRead: true, fileChange: true, permission: true, fromSubagents: true },
  planning: { todoList: true, proposedPlan: true, planUpdates: false, structuredQuestions: true },
  subagents: { supported: true, exposesThreadIds: false, lifecycle: true, wait: false, stop: true },
  context: {
    // Thread instructions go into the claude_code system prompt's `append`; turn instructions lead the turn's user message.
    instructionChannels: ["system", "first_user_message"],
    syntheticContext: true,
    summaries: false,
    handoffSummaries: false,
  },
  // enableFileCheckpointing plus Query.rewindFiles, through the claude.fileCheckpoints extension.
  checkpointing: { workspace: true, conversationRollback: false, rollbackReturnsSnapshot: false },
  // Turn ids: the uuid of the prompt the driver sent; turns Claude starts on its own have none and use an ordinal.
  identity: { threadIds: "strong", turnIds: "weak", itemIds: "strong", requestIds: "strong", identityVersion: CLAUDE_IDENTITY_VERSION },
  runtimePolicy: {
    modes: {
      // Claude Code has no read-only permission mode; plan mode is an interaction mode.
      read_only: { supported: false, enforcement: "native" },
      approval_required: { supported: true, enforcement: "native" },
      auto_accept_edits: { supported: true, enforcement: "native" },
      auto: { supported: true, enforcement: "native" },
      full_access: { supported: true, enforcement: "native" },
    },
    interactionModes: ["default", "plan"],
    switchInSession: true,
  },
  requests: {
    responseModes: ["live"],
    // AskUserQuestion takes a free-text answer.
    allowCustomAnswer: true,
    approvalScopes: [
      { decision: "accept", scope: "once" },
      { decision: "accept_for_session", scope: "session" },
      { decision: "accept_always", scope: "project" },
      { decision: "accept_always", scope: "global" },
    ],
  },
  background: { list: true, stop: true, await: true, tasksEndWithProcess: true },
  mcp: { acceptsHostServers: ["stdio", "http", "sse"], scope: "thread" },
  sessionModel: "process_per_thread",
  externallyOwned: false,
  diffs: { emits: false, canDisable: false },
  contextWindowReporting: false,
  extensions: CLAUDE_EXTENSIONS.map((ns) => ({ ns, version: "1" })),
};
