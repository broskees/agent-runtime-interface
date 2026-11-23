import type { Capabilities } from "../../src/index.ts";

/** A complete, valid capabilities object for a capable provider. Tests clone and edit it. */
export function fullCapabilities(): Capabilities {
  return {
    ariVersion: "1.0.0",
    sessions: {
      multipleThreads: true,
      switchModel: true,
      switchRuntimeMode: false,
      pendingRequestsSurviveRestart: true,
      release: true,
      feedbackUpload: false,
      contextUsageReuse: true,
    },
    threads: {
      createEmpty: true,
      readSnapshot: true,
      rollback: false,
      compact: true,
      injectHistory: false,
      unload: true,
      exposesNativeIds: true,
      fork: { supported: true, fromTurn: true, fromItem: false, fromSubagent: false, crossCwd: false },
    },
    turns: {
      interrupt: true,
      steer: true,
      queue: false,
      emitsStarted: true,
      terminalStatus: "strong",
      multiNativeTurnsPerRequest: true,
      steeringInterruptsTools: false,
    },
    streaming: { assistantText: true, reasoning: false, toolOutput: true, planText: false },
    tools: { mcp: true, dynamicTools: false, mcpApps: true, exposesToolItemIds: true },
    approvals: { command: true, fileRead: false, fileChange: true, permission: true, fromSubagents: false },
    planning: { todoList: true, proposedPlan: false, planUpdates: true, structuredQuestions: true },
    subagents: { supported: true, exposesThreadIds: false, lifecycle: true, wait: false, stop: true },
    context: { instructionChannels: ["system", "developer"], syntheticContext: false, summaries: true, handoffSummaries: false },
    checkpointing: { workspace: false, conversationRollback: true, rollbackReturnsSnapshot: true },
    identity: { threadIds: "strong", turnIds: "weak", itemIds: "strong", requestIds: "none", identityVersion: 1 },
    runtimePolicy: {
      modes: {
        read_only: { supported: true, enforcement: "native" },
        approval_required: { supported: true, enforcement: "native" },
        auto_accept_edits: { supported: false, enforcement: "client_boundary" },
        auto: { supported: false, enforcement: "client_boundary" },
        full_access: { supported: true, enforcement: "client_boundary" },
      },
      interactionModes: ["default", "plan"],
      switchInSession: true,
    },
    requests: {
      responseModes: ["live", "message"],
      allowCustomAnswer: true,
      approvalScopes: [
        { decision: "accept", scope: "once" },
        { decision: "accept_always", scope: "project" },
      ],
    },
    background: { list: true, stop: true, await: false, tasksEndWithProcess: true },
    mcp: { acceptsHostServers: ["stdio", "http"], scope: "directory" },
    sessionModel: "process_per_instance",
    externallyOwned: false,
    diffs: { emits: true, canDisable: true },
    contextWindowReporting: true,
    extensions: [{ ns: "ari.goal", version: "1" }],
  };
}
