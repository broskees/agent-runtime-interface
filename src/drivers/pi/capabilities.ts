// What the Pi driver declares. docs/drivers/pi.md compares each value with the
// proposal's §1.2 Pi column and cites the Pi source for every difference.

import type { Capabilities } from "../../generated/capabilities.ts";
import { ARI_VERSION } from "../../version.ts";
import { IDENTITY_VERSION } from "./transcript.ts";

export function piCapabilities(): Capabilities {
  return {
    ariVersion: ARI_VERSION,
    sessions: {
      // One Pi process per thread, so a session holds any number of threads.
      multipleThreads: true,
      switchModel: true,
      // The bridge reads the runtime mode once, when its Pi process starts.
      switchRuntimeMode: false,
      pendingRequestsSurviveRestart: false,
      release: true,
      feedbackUpload: false,
      contextUsageReuse: false,
    },
    threads: {
      createEmpty: true,
      readSnapshot: true,
      rollback: true,
      compact: true,
      injectHistory: false,
      unload: true,
      exposesNativeIds: true,
      fork: { supported: true, fromTurn: true, fromItem: false, fromSubagent: false, crossCwd: true },
    },
    turns: {
      interrupt: true,
      steer: true,
      queue: false,
      emitsStarted: true,
      terminalStatus: "strong",
      multiNativeTurnsPerRequest: false,
      steeringInterruptsTools: false,
    },
    streaming: { assistantText: true, reasoning: true, toolOutput: true, planText: false },
    tools: { mcp: true, dynamicTools: false, mcpApps: false, exposesToolItemIds: true },
    approvals: { command: true, fileRead: false, fileChange: true, permission: true, fromSubagents: false },
    planning: { todoList: false, proposedPlan: false, planUpdates: false, structuredQuestions: true },
    subagents: { supported: false, exposesThreadIds: false, lifecycle: false, wait: false, stop: false },
    context: { instructionChannels: ["system"], syntheticContext: false, summaries: false, handoffSummaries: false },
    checkpointing: { workspace: false, conversationRollback: true, rollbackReturnsSnapshot: true },
    identity: { threadIds: "strong", turnIds: "weak", itemIds: "weak", requestIds: "strong", identityVersion: IDENTITY_VERSION },
    runtimePolicy: {
      modes: {
        read_only: { supported: true, enforcement: "client_boundary" },
        approval_required: { supported: true, enforcement: "client_boundary" },
        auto_accept_edits: { supported: true, enforcement: "client_boundary" },
        auto: { supported: false, enforcement: "client_boundary" },
        full_access: { supported: true, enforcement: "client_boundary" },
      },
      interactionModes: ["default"],
      switchInSession: false,
    },
    requests: {
      responseModes: ["live"],
      allowCustomAnswer: false,
      approvalScopes: [
        { decision: "accept", scope: "once" },
        { decision: "accept_for_session", scope: "session" },
      ],
    },
    background: { list: false, stop: false, await: false, tasksEndWithProcess: true },
    mcp: { acceptsHostServers: ["stdio", "http"], scope: "thread" },
    sessionModel: "process_per_thread",
    externallyOwned: false,
    diffs: { emits: false, canDisable: false },
    contextWindowReporting: true,
    extensions: [],
  };
}
