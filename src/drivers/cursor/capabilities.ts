// What the Cursor driver declares. docs/drivers/cursor.md compares each value
// with the proposal's §1.2 Cursor column and cites the Cursor source for every
// difference. The driver is thin on purpose: Cursor's SDK has no fork, no
// rollback and no approval flow, and those stay with the host's fallbacks.

import type { Capabilities } from "../../generated/capabilities.ts";
import { ARI_VERSION } from "../../version.ts";
import { IDENTITY_VERSION } from "./mapping.ts";

export function cursorCapabilities(): Capabilities {
  return {
    ariVersion: ARI_VERSION,
    sessions: {
      // One SDK agent per thread, all in the host's process.
      multipleThreads: true,
      // A model on `send()` is sticky for later runs (docs, "Per-run model override").
      switchModel: true,
      // The tool allowlist that enforces read_only is fixed when the agent handle opens.
      switchRuntimeMode: false,
      pendingRequestsSurviveRestart: false,
      // Closing the agent handles frees their local executors; `Agent.resume` reopens them.
      release: true,
      feedbackUpload: false,
      contextUsageReuse: false,
    },
    threads: {
      // `Agent.create` stores the agent before its first run.
      createEmpty: true,
      // Cursor keeps no typed record of a run's prompt: its stored run stream has no event for the
      // prompt, and `Agent.messages.list` types each message `unknown`.
      readSnapshot: false,
      rollback: false,
      // `agent.summarize()`, the CLI's /summarize.
      compact: true,
      injectHistory: false,
      unload: true,
      exposesNativeIds: true,
      fork: { supported: false, fromTurn: false, fromItem: false, fromSubagent: false, crossCwd: false },
    },
    turns: {
      // `run.cancel()`.
      interrupt: true,
      // `run.steer()` on a local run: delivered into the running turn, or refused once it ended.
      steer: true,
      // A local agent refuses a second run while one is active.
      queue: false,
      emitsStarted: true,
      // `run.wait()` resolves only when the run ended, background subagents included.
      terminalStatus: "strong",
      multiNativeTurnsPerRequest: false,
      steeringInterruptsTools: false,
    },
    streaming: { assistantText: true, reasoning: true, toolOutput: false, planText: true },
    tools: { mcp: true, dynamicTools: false, mcpApps: false, exposesToolItemIds: true },
    approvals: { command: false, fileRead: false, fileChange: false, permission: false, fromSubagents: false },
    planning: { todoList: true, proposedPlan: true, planUpdates: true, structuredQuestions: false },
    // Subagents run in the `task` tool; their run waits for background ones before it ends.
    subagents: { supported: true, exposesThreadIds: false, lifecycle: true, wait: true, stop: false },
    context: { instructionChannels: ["first_user_message"], syntheticContext: false, summaries: true, handoffSummaries: false },
    checkpointing: { workspace: false, conversationRollback: false, rollbackReturnsSnapshot: false },
    identity: { threadIds: "strong", turnIds: "strong", itemIds: "weak", requestIds: "none", identityVersion: IDENTITY_VERSION },
    runtimePolicy: {
      modes: {
        // A tool allowlist of reading tools only (`AgentOptions.tools`), which Cursor applies.
        read_only: { supported: true, enforcement: "native" },
        approval_required: { supported: false, enforcement: "native" },
        auto_accept_edits: { supported: false, enforcement: "native" },
        auto: { supported: false, enforcement: "native" },
        // Cursor's default for a local agent: every tool runs (docs, "Sandbox options").
        full_access: { supported: true, enforcement: "native" },
      },
      // `mode: "plan"` on a run.
      interactionModes: ["default", "plan"],
      switchInSession: true,
    },
    requests: { responseModes: [], allowCustomAnswer: false, approvalScopes: [] },
    background: { list: false, stop: false, await: false, tasksEndWithProcess: true },
    mcp: { acceptsHostServers: ["stdio", "http", "sse"], scope: "thread" },
    sessionModel: "in_process",
    externallyOwned: false,
    // The edit tool's result carries a diff (`EditSuccess.diffString`); `emitDiffs: false` leaves it out.
    diffs: { emits: true, canDisable: true },
    contextWindowReporting: false,
    extensions: [],
  };
}
