// What the Codex driver declares. docs/drivers/codex.md compares each value
// with the proposal's §1.2 Codex column and cites the vendor source for every
// difference; test/drivers/codex/capabilities.test.ts checks that each
// declared member works and each one declared off is absent or refused.

import type { Capabilities } from "../../generated/capabilities.ts";
import { ARI_VERSION } from "../../version.ts";
import { CODEX_IDENTITY_VERSION } from "./mapping.ts";
import { CODEX_EXTENSIONS } from "./session.ts";

export const CODEX_CAPABILITIES: Capabilities = {
  ariVersion: ARI_VERSION,
  sessions: {
    // One app-server holds any number of threads.
    multipleThreads: true,
    // Codex takes `model` and `effort` on every turn/start.
    switchModel: true,
    // Codex takes `approvalPolicy` and `sandboxPolicy` on every turn/start.
    switchRuntimeMode: true,
    // Async questions (message mode) survive a restart; live approvals do not (each says so in `survivesRestart`).
    pendingRequestsSurviveRestart: true,
    release: true,
    feedbackUpload: true,
    contextUsageReuse: true,
  },
  threads: {
    createEmpty: true,
    readSnapshot: true,
    rollback: true,
    compact: true,
    injectHistory: true,
    unload: true,
    exposesNativeIds: true,
    // `thread/fork` takes `lastTurnId` and `cwd`; it has no item point.
    fork: { supported: true, fromTurn: true, fromItem: false, fromSubagent: false, crossCwd: true },
  },
  turns: {
    interrupt: true,
    steer: true,
    // `thread/queue/add` answers with a queued submission, not a turn: no turn id can be derived from native data when the host queues.
    queue: false,
    emitsStarted: true,
    terminalStatus: "strong",
    multiNativeTurnsPerRequest: true,
    steeringInterruptsTools: false,
  },
  streaming: { assistantText: true, reasoning: true, toolOutput: true, planText: true },
  tools: { mcp: true, dynamicTools: true, mcpApps: true, exposesToolItemIds: true },
  approvals: { command: true, fileRead: false, fileChange: true, permission: true, fromSubagents: false },
  planning: { todoList: true, proposedPlan: true, planUpdates: true, structuredQuestions: true },
  subagents: { supported: true, exposesThreadIds: false, lifecycle: true, wait: false, stop: true },
  context: {
    // Host instructions go into Codex's `developerInstructions` (thread start, resume, fork) and per-turn `additionalContext`.
    instructionChannels: ["developer"],
    syntheticContext: true,
    summaries: false,
    handoffSummaries: true,
  },
  checkpointing: { workspace: false, conversationRollback: true, rollbackReturnsSnapshot: true },
  identity: { threadIds: "strong", turnIds: "strong", itemIds: "strong", requestIds: "strong", identityVersion: CODEX_IDENTITY_VERSION },
  runtimePolicy: {
    modes: {
      read_only: { supported: true, enforcement: "native" },
      approval_required: { supported: true, enforcement: "native" },
      auto_accept_edits: { supported: true, enforcement: "native" },
      auto: { supported: true, enforcement: "native" },
      full_access: { supported: true, enforcement: "native" },
    },
    interactionModes: ["default"],
    switchInSession: true,
  },
  requests: {
    responseModes: ["live", "message"],
    allowCustomAnswer: true,
    approvalScopes: [
      { decision: "accept", scope: "once" },
      { decision: "accept_for_session", scope: "session" },
      { decision: "accept_always", scope: "global" },
    ],
  },
  background: { list: true, stop: true, await: true, tasksEndWithProcess: true },
  mcp: { acceptsHostServers: ["stdio", "http"], scope: "thread" },
  sessionModel: "process_per_instance",
  externallyOwned: false,
  diffs: { emits: true, canDisable: true },
  contextWindowReporting: true,
  extensions: CODEX_EXTENSIONS.map((ns) => ({ ns, version: "1" })),
};
