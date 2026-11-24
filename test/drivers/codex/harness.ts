// The conformance harness for the Codex driver: the real driver against the
// fake Codex CLI of fake-app-server.ts, in a real temporary workspace with a
// real symbolic link and real per-instance directories.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ConformanceHarness, ConformanceWorkspace, FakeSpawnRequest, HarnessRig, NativeActivity, NativeTurn } from "../../../src/conformance/index.ts";
import { codexDriver, threadIdFor } from "../../../src/drivers/codex/index.ts";
import type { CodexDriverConfig } from "../../../src/drivers/codex/index.ts";
import type { SpawnedProcess } from "../../../src/index.ts";
import type { CommandExecutionApprovalDecision, FileChangeApprovalDecision, ThreadGoal } from "../../../src/drivers/codex/generated/protocol.ts";
import { createConformanceWorkspace, instanceDirectories, watchInstanceFiles } from "../../helpers/conformance.ts";
import { FAKE_MCP_RESOURCE, FAKE_MCP_SERVER, FAKE_MCP_TOOL, FakeCodexWorld } from "./fake-app-server.ts";
import type { CodexNativeTurn } from "./fake-app-server.ts";

/** The managed API key the auth scenario's managed profile stores. */
export const MANAGED_API_KEY = "sk-managed-profile-key";

const GOAL_STATUSES: { readonly [status: string]: string } = { active: "active", paused: "paused", complete: "completed", blocked: "blocked", usageLimited: "usage_limited", budgetLimited: "budget_limited" };

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * The option id the driver shows for a Codex decision, as docs/drivers/codex.md
 * documents it: a plain decision is its own text; an exec-policy amendment is
 * `acceptWithExecpolicyAmendment:` and the JSON prefix; a network amendment is
 * `applyNetworkPolicyAmendment:` and the JSON `[action, host]`. Written here
 * from the documentation, not taken from the driver, so a driver that strays
 * from it fails the scenarios.
 */
export function documentedOptionId(decision: CommandExecutionApprovalDecision | FileChangeApprovalDecision): string {
  if (typeof decision === "string") return decision;
  if ("acceptWithExecpolicyAmendment" in decision) return `acceptWithExecpolicyAmendment:${JSON.stringify(decision.acceptWithExecpolicyAmendment.execpolicy_amendment)}`;
  const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
  return `applyNetworkPolicyAmendment:${JSON.stringify([amendment.action, amendment.host])}`;
}

/** The kit's view of a fake turn: approval handles carry the native option id the driver shows for each kit option. */
function kitTurn(turn: CodexNativeTurn): NativeTurn {
  return {
    ...turn,
    requestApproval: async (approval) => {
      const handle = await turn.requestApproval(approval);
      const nativeOptionIds = Object.fromEntries(Object.entries(handle.nativeDecisions).map(([kitId, decision]) => [kitId, documentedOptionId(decision)]));
      return { nextReply: handle.nextReply, replies: handle.replies, nativeOptionIds };
    },
  };
}

/** What the fake served for extension calls, in the shapes the driver returns them (the harness knows both protocols). */
export function extensionActivity(world: FakeCodexWorld): NativeActivity["extensions"] {
  return world.activityLog.extensions.flatMap((entry): Array<{ params: unknown; result: unknown }> => {
    const threadId = threadIdFor(entry.params["threadId"] as string);
    if (entry.method === "thread/goal/set") {
      const goal = (entry.result as { goal: ThreadGoal }).goal;
      return [
        {
          params: { threadId, objective: entry.params["objective"] },
          result: { threadId, objective: goal.objective, status: GOAL_STATUSES[goal.status] ?? goal.status, derived: false, turnIds: [], updatedAt: iso(goal.updatedAt) },
        },
      ];
    }
    if (entry.method === "thread/goal/get") {
      const goal = (entry.result as { goal: ThreadGoal | null }).goal;
      return [
        {
          params: { threadId },
          result:
            goal === null
              ? null
              : { threadId, objective: goal.objective, status: goal.status, tokenBudget: goal.tokenBudget ?? null, tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds, createdAt: iso(goal.createdAt), updatedAt: iso(goal.updatedAt) },
        },
      ];
    }
    if (entry.method === "thread/read") {
      const readState = (entry.result as { readState: { revision: string; firstUnread: unknown } | null }).readState;
      return [{ params: { threadId }, result: { threadId, readState: readState === null ? null : { revision: readState.revision, firstUnread: readState.firstUnread ?? null } } }];
    }
    if (entry.method === "thread/memory/read") return [{ params: { threadId }, result: { threadId, summary: (entry.result as { summary: string | null }).summary ?? null } }];
    return [];
  });
}

export interface CodexHarness extends ConformanceHarness<CodexDriverConfig> {
  /** Every rig's fake Codex, so tests can check what crossed the wire. */
  readonly worlds: FakeCodexWorld[];
  cleanup(): void;
}

export function codexHarness(options: { readonly wrapAppServer?: (process: SpawnedProcess) => SpawnedProcess } = {}): CodexHarness {
  const created = createConformanceWorkspace("ari-codex-conformance-");
  const worlds: FakeCodexWorld[] = [];
  return {
    name: "codex driver (fake codex app-server, schema-checked frames)",
    worlds,
    cleanup: created.cleanup,
    notApplicable: {
      "capability-honesty.ext.codex.review": "codex.review start runs a review turn of its own on the thread scenario 14 goes on to roll back; quirks.test.ts covers it",
      "idempotent-responses.full-access":
        "under full_access the driver runs Codex with approval policy never, and Codex then sends no ordinary approval (core/src/exec_policy.rs:907–911), so no reply exists to check",
    },
    workspace: async (): Promise<ConformanceWorkspace> => created.workspace,
    async setup(request): Promise<HarnessRig<CodexDriverConfig>> {
      const rigRoot = path.join(created.root, "rigs", `${request.scenario}-${Math.random().toString(36).slice(2)}`);
      // The model meets a goal in the first turn Codex starts for it, so scenario 14's ari.goal set leaves no turn running.
      const world = new FakeCodexWorld({ ambientAuth: request.ambientAuth, realpath: (value) => fs.realpathSync(value), goalAutopilot: true });
      worlds.push(world);
      const spawn = async (spawnRequest: FakeSpawnRequest) => {
        const process = world.spawn(spawnRequest);
        return spawnRequest.args?.[0] === "app-server" && options.wrapAppServer !== undefined ? options.wrapAppServer(process) : process;
      };
      return {
        driver: codexDriver,
        config: codexDriver.defaultConfig(),
        hostOptions: (instanceId, arrangement) => ({
          paths: instanceDirectories(rigRoot, instanceId),
          spawn,
          resolveExecutable: async (name) => (path.basename(name) === "codex" ? "/usr/local/bin/codex" : null),
          secrets: arrangement.managedProfile ? [{ namespace: "codex", key: "api-key", value: MANAGED_API_KEY }] : [],
        }),
        native: {
          nextTurn: async () => {
            const next = await world.turnQueue.next();
            if (next.done === true) throw new Error("the rig was disposed");
            return kitTurn(next.value);
          },
          lockSession: async (thread) => world.lock(thread.handle ?? thread.native.id ?? ""),
          inspectSession: async (thread) => world.inspect(thread.handle ?? thread.native.id ?? ""),
          activity: async (): Promise<NativeActivity> => ({ feedback: [...world.activityLog.feedback], mcp: [...world.activityLog.mcp], extensions: extensionActivity(world) }),
        },
        probeExecutables: ["codex"],
        // Codex thread ids are UUIDs; a malformed id is a different error (`invalid session id`) than a missing one.
        missingSession: { id: "019a0000-0000-7000-8000-0000deadbeef", strength: "strong" },
        inheritedCredentials: ["OPENAI_API_KEY", "CODEX_API_KEY"],
        watchInstanceFiles,
        exercise: {
          mcpApp: { server: FAKE_MCP_SERVER, tool: FAKE_MCP_TOOL, args: { text: "hello" }, resourceUri: FAKE_MCP_RESOURCE },
          // Every Codex extension call names a thread, so the calls are made when the kit asks: on the rig's first thread.
          get extensionCalls(): { [ns: string]: { method: string; params: unknown } } {
            const first = world.threadOrder[0];
            if (first === undefined) return {};
            const threadId = threadIdFor(first);
            return {
              "ari.goal": { method: "set", params: { threadId, objective: "Keep the build green." } },
              "codex.goal": { method: "get", params: { threadId } },
              "codex.readState": { method: "read", params: { threadId } },
              "codex.memory": { method: "read", params: { threadId } },
            };
          },
        },
        dispose: async () => world.dispose(),
      };
    },
  };
}
