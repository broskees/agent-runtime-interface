// The capabilities an ACP session declares, from what the agent advertised in
// `initialize`. docs/drivers/acp.md compares them with the proposal's §1.2
// column for the ACP base and cites the ACP source for every difference.

import type { Capabilities } from "../../generated/capabilities.ts";
import { ARI_VERSION } from "../../version.ts";
import type * as V1 from "./generated/v1.ts";
import type * as V2 from "./generated/v2.ts";
import type { AcpHandshake } from "./connection.ts";
import { acceptedMcpTransports } from "./mapping.ts";

/** Bumped when the driver changes how it derives ids. */
export const ACP_IDENTITY_VERSION = 1;

/** The extension namespace for vendor `_meta`, unmapped updates and ACP extension methods. */
export const ACP_EXTENSION = { ns: "acp", version: "1" } as const;

/** True when the agent supports `session/fork` (a draft ACP feature in both versions). */
export function agentForks(handshake: AcpHandshake): boolean {
  const capabilities = handshake.agentCapabilities;
  const fork = handshake.version === 1 ? (capabilities as V1.AgentCapabilities | undefined)?.sessionCapabilities?.fork : (capabilities as V2.AgentCapabilities | undefined)?.session?.fork;
  return fork !== null && fork !== undefined;
}

/** True when the agent takes a system prompt on `session/new`. */
export function agentTakesSystemPrompt(handshake: AcpHandshake): boolean {
  const capabilities = handshake.agentCapabilities;
  const systemPrompt =
    handshake.version === 1 ? (capabilities as V1.AgentCapabilities | undefined)?.sessionCapabilities?.systemPrompt : (capabilities as V2.AgentCapabilities | undefined)?.session?.systemPrompt;
  return systemPrompt !== null && systemPrompt !== undefined;
}

/** How a v1 agent resumes a stored session: `session/resume` (no replay), `session/load` (replays history), or neither. */
export function v1ResumeMethod(handshake: AcpHandshake): "session/resume" | "session/load" | undefined {
  const capabilities = handshake.agentCapabilities as V1.AgentCapabilities | undefined;
  if (capabilities?.sessionCapabilities?.resume !== null && capabilities?.sessionCapabilities?.resume !== undefined) return "session/resume";
  if (capabilities?.loadSession === true) return "session/load";
  return undefined;
}

export interface AcpCapabilityOptions {
  readonly forkAcrossDirectories: boolean;
  /** Some thread's agent offers a config option in the `model` category, so `session/set_config_option` can change the model. */
  readonly offersModel: boolean;
}

export function acpCapabilities(handshake: AcpHandshake, options: AcpCapabilityOptions): Capabilities {
  const forks = agentForks(handshake);
  const client = "client_boundary" as const;
  return {
    ariVersion: ARI_VERSION,
    sessions: {
      multipleThreads: true,
      // ACP has no model method: the model changes only through a config option the agent offers.
      switchModel: options.offersModel,
      switchRuntimeMode: false,
      pendingRequestsSurviveRestart: false,
      release: false,
      feedbackUpload: false,
      contextUsageReuse: false,
    },
    threads: {
      createEmpty: true,
      readSnapshot: false,
      rollback: false,
      compact: false,
      injectHistory: false,
      unload: false,
      exposesNativeIds: true,
      fork: { supported: forks, fromTurn: false, fromItem: false, fromSubagent: false, crossCwd: forks && options.forkAcrossDirectories },
    },
    turns: {
      interrupt: true,
      steer: false,
      queue: false,
      emitsStarted: true,
      terminalStatus: "strong",
      multiNativeTurnsPerRequest: false,
      steeringInterruptsTools: false,
    },
    streaming: { assistantText: true, reasoning: true, toolOutput: true, planText: false },
    tools: { mcp: true, dynamicTools: false, mcpApps: false, exposesToolItemIds: true },
    approvals: { command: true, fileRead: true, fileChange: true, permission: true, fromSubagents: false },
    planning: { todoList: true, proposedPlan: handshake.version === 2, planUpdates: false, structuredQuestions: false },
    subagents: { supported: false, exposesThreadIds: false, lifecycle: false, wait: false, stop: false },
    context: {
      instructionChannels: agentTakesSystemPrompt(handshake) ? ["system", "first_user_message"] : ["first_user_message"],
      syntheticContext: false,
      summaries: false,
      handoffSummaries: false,
    },
    checkpointing: { workspace: false, conversationRollback: false, rollbackReturnsSnapshot: false },
    identity: { threadIds: "strong", turnIds: "none", itemIds: "weak", requestIds: "weak", identityVersion: ACP_IDENTITY_VERSION },
    runtimePolicy: {
      // ACP has no policy of its own: the driver enforces modes only in how it answers permission requests.
      modes: {
        read_only: { supported: false, enforcement: client },
        approval_required: { supported: true, enforcement: client },
        auto_accept_edits: { supported: false, enforcement: client },
        auto: { supported: false, enforcement: client },
        full_access: { supported: true, enforcement: client },
      },
      interactionModes: ["default"],
      switchInSession: false,
    },
    requests: {
      responseModes: ["live"],
      allowCustomAnswer: false,
      approvalScopes: [
        { decision: "accept", scope: "once" },
        { decision: "accept_always", scope: "project" },
      ],
    },
    background: { list: false, stop: false, await: false, tasksEndWithProcess: true },
    mcp: { acceptsHostServers: acceptedMcpTransports(handshake.version, handshake.agentCapabilities), scope: "session" },
    // One agent process per ARI session, holding all of that session's threads (driver.ts `openSession`).
    sessionModel: "process_per_session",
    externallyOwned: false,
    diffs: { emits: true, canDisable: true },
    contextWindowReporting: false,
    extensions: [{ ...ACP_EXTENSION }],
  };
}
