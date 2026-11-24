// What the Muse driver declares. docs/drivers/muse.md compares each value
// with the proposal's §1.2 Muse column and cites the vendor source for every
// difference; test/drivers/muse/capabilities.suite.ts checks that each declared
// member works and each one declared off is absent or refused.

import type { Capabilities } from "../../generated/capabilities.ts";
import { ARI_VERSION } from "../../version.ts";
import { MUSE_IDENTITY_VERSION } from "./mapping.ts";

export const MUSE_CAPABILITIES: Capabilities = {
  ariVersion: ARI_VERSION,
  sessions: {
    // Each thread runs in its own `muse serve` host, so one ARI session holds any number of them.
    multipleThreads: true,
    // `session/setModel` changes the model for later model calls.
    switchModel: true,
    // Muse's runtime mode is the approval mode, the permission profile and `muse serve --disable-sandbox`; the last is fixed when the host starts.
    switchRuntimeMode: false,
    // A pending approval or question belongs to the host process that asked; the driver does not carry it across a restart.
    pendingRequestsSurviveRestart: false,
    release: true,
    feedbackUpload: false,
    contextUsageReuse: false,
  },
  threads: {
    // `session/start` makes a session before any turn.
    createEmpty: true,
    // `session/read` with `excludeItems: false` serves the folded items.
    readSnapshot: true,
    rollback: false,
    // `session/compact`.
    compact: true,
    injectHistory: false,
    // Closing a thread's host unloads its session; `session/resume` loads it again.
    unload: true,
    exposesNativeIds: true,
    fork: { supported: false, fromTurn: false, fromItem: false, fromSubagent: false, crossCwd: false },
  },
  turns: {
    // `turn/interrupt`.
    interrupt: true,
    // `turn/steer` with `expectedTurnId`.
    steer: true,
    // `turn/start` with `ifBusy: "queue"` answers with the queued turn's id.
    queue: true,
    emitsStarted: true,
    terminalStatus: "strong",
    multiNativeTurnsPerRequest: false,
    steeringInterruptsTools: false,
  },
  streaming: { assistantText: true, reasoning: true, toolOutput: true, planText: false },
  tools: { mcp: true, dynamicTools: false, mcpApps: false, exposesToolItemIds: true },
  approvals: { command: true, fileRead: true, fileChange: true, permission: true, fromSubagents: true },
  planning: { todoList: true, proposedPlan: false, planUpdates: true, structuredQuestions: true },
  subagents: { supported: true, exposesThreadIds: false, lifecycle: true, wait: false, stop: false },
  context: {
    // Host instructions go before the host's own text in the first turn the driver sends on a thread (docs/drivers/muse.md says why not `config.developerPrompt`).
    instructionChannels: ["first_user_message"],
    syntheticContext: false,
    summaries: false,
    handoffSummaries: false,
  },
  checkpointing: { workspace: false, conversationRollback: false, rollbackReturnsSnapshot: false },
  identity: { threadIds: "strong", turnIds: "strong", itemIds: "strong", requestIds: "strong", identityVersion: MUSE_IDENTITY_VERSION },
  runtimePolicy: {
    modes: {
      read_only: { supported: false, enforcement: "native" },
      approval_required: { supported: true, enforcement: "native" },
      auto_accept_edits: { supported: false, enforcement: "native" },
      auto: { supported: false, enforcement: "native" },
      full_access: { supported: true, enforcement: "native" },
    },
    interactionModes: ["default"],
    switchInSession: false,
  },
  requests: {
    responseModes: ["live"],
    // A question takes free text (`freeText`, at most 500 characters); an approval takes only one of Muse's choices.
    allowCustomAnswer: true,
    approvalScopes: [
      { decision: "accept", scope: "once" },
      { decision: "accept_for_session", scope: "session" },
      { decision: "accept_always", scope: "session" },
      { decision: "accept_always", scope: "project" },
      { decision: "accept_always", scope: "global" },
    ],
  },
  background: { list: false, stop: false, await: false, tasksEndWithProcess: true },
  // `SessionConfig.mcpServers` takes stdio and streamable HTTP servers for one session.
  mcp: { acceptsHostServers: ["stdio", "http"], scope: "thread" },
  sessionModel: "process_per_thread",
  externallyOwned: false,
  diffs: { emits: false, canDisable: false },
  // `model/list` reports each model's `contextLimit`.
  contextWindowReporting: true,
  extensions: [],
};
