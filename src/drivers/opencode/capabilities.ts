// What the OpenCode driver declares, which depends on the server: its
// generation (1.x or 2.x) and whether the driver started it. docs/drivers/opencode.md
// compares each value with the proposal's §1.2 OpenCode 1.x and 2.x columns
// and cites the OpenCode source for every difference.

import type { Capabilities } from "../../generated/capabilities.ts";
import { ARI_VERSION } from "../../version.ts";
import type { Generation } from "./server.ts";

/** The identity version of every id the driver derives. */
export const IDENTITY_VERSION = 1;

/** The extension that reads and sets a thread's own OpenCode permission rules. */
export const PERMISSION_RULES_EXTENSION = "opencode.permissionRules";

export interface ServerShape {
  readonly generation: Generation;
  /** True when someone else runs the server: the driver never starts or stops it. */
  readonly external: boolean;
}

export function opencodeCapabilities(shape: ServerShape): Capabilities {
  const v2 = shape.generation === 2;
  // Parking a thread stops its own 1.x server; a 2.x server, or any external one, serves other threads too.
  const parks = !v2 && !shape.external;
  return {
    ariVersion: ARI_VERSION,
    sessions: {
      multipleThreads: true,
      switchModel: true,
      // 2.x rules can be replaced on a live session (`session.update`); the driver keeps a 1.x session's mode fixed, as the proposal's §1.2 1.x column has it.
      switchRuntimeMode: v2,
      pendingRequestsSurviveRestart: false,
      release: parks,
      feedbackUpload: false,
      contextUsageReuse: false,
    },
    threads: {
      createEmpty: true,
      readSnapshot: true,
      rollback: true,
      compact: true,
      injectHistory: false,
      unload: parks,
      exposesNativeIds: true,
      // A subagent's session is a session like any other to 1.x's `session.fork`; the proposal's §1.2 has 2.x without it.
      fork: { supported: true, fromTurn: true, fromItem: false, fromSubagent: !v2, crossCwd: false },
    },
    turns: {
      interrupt: true,
      steer: v2,
      queue: false,
      emitsStarted: true,
      terminalStatus: "strong",
      multiNativeTurnsPerRequest: false,
      steeringInterruptsTools: false,
    },
    streaming: { assistantText: true, reasoning: true, toolOutput: !v2, planText: false },
    tools: { mcp: true, dynamicTools: false, mcpApps: false, exposesToolItemIds: true },
    approvals: { command: true, fileRead: true, fileChange: true, permission: true, fromSubagents: true },
    planning: { todoList: !v2, proposedPlan: false, planUpdates: false, structuredQuestions: true },
    subagents: { supported: true, exposesThreadIds: true, lifecycle: true, wait: true, stop: false },
    // Compaction writes a summary of the conversation in both generations (1.x `session.summarize`, 2.x `session.compaction.ended` `text`).
    context: { instructionChannels: ["system"], syntheticContext: false, summaries: true, handoffSummaries: false },
    checkpointing: { workspace: false, conversationRollback: true, rollbackReturnsSnapshot: true },
    identity: { threadIds: "strong", turnIds: "strong", itemIds: "strong", requestIds: "strong", identityVersion: IDENTITY_VERSION },
    runtimePolicy: {
      modes: {
        read_only: { supported: true, enforcement: "native" },
        approval_required: { supported: true, enforcement: "native" },
        auto_accept_edits: { supported: true, enforcement: "native" },
        auto: { supported: false, enforcement: "native" },
        full_access: { supported: true, enforcement: "native" },
      },
      interactionModes: ["default"],
      switchInSession: v2,
    },
    requests: {
      responseModes: ["live"],
      allowCustomAnswer: true,
      // OpenCode keeps an "always" grant for the whole project (1.x `permission/index.ts` `approved`, 2.x `PermissionSaved` by project id).
      approvalScopes: [
        { decision: "accept", scope: "once" },
        { decision: "accept_always", scope: "project" },
      ],
    },
    background: { list: false, stop: false, await: false, tasksEndWithProcess: true },
    mcp: { acceptsHostServers: ["stdio", "http"], scope: "directory" },
    sessionModel: shape.external ? "external" : v2 ? "process_per_instance" : "process_per_thread",
    externallyOwned: shape.external,
    diffs: { emits: false, canDisable: false },
    contextWindowReporting: true,
    extensions: [{ ns: PERMISSION_RULES_EXTENSION, version: "1" }],
  };
}
