// The conformance harness for the Codex driver: the real driver against the
// fake Codex CLI of fake-app-server.ts, in a real temporary workspace with a
// real symbolic link and real per-instance directories.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ConformanceHarness, ConformanceWorkspace, FakeSpawnRequest, HarnessRig, NativeActivity } from "../../../src/conformance/index.ts";
import { codexDriver, threadIdFor } from "../../../src/drivers/codex/index.ts";
import type { CodexDriverConfig } from "../../../src/drivers/codex/index.ts";
import type { ThreadGoal } from "../../../src/drivers/codex/generated/protocol.ts";
import { createConformanceWorkspace, instanceDirectories, watchInstanceFiles } from "../../helpers/conformance.ts";
import { FAKE_MCP_RESOURCE, FAKE_MCP_SERVER, FAKE_MCP_TOOL, FakeCodexWorld } from "./fake-app-server.ts";

/** The managed API key the auth scenario's managed profile stores. */
export const MANAGED_API_KEY = "sk-managed-profile-key";

const GOAL_STATUSES: { readonly [status: string]: string } = { active: "active", paused: "paused", complete: "completed", blocked: "blocked", usageLimited: "usage_limited", budgetLimited: "budget_limited" };

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
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

export function codexHarness(): CodexHarness {
  const created = createConformanceWorkspace("ari-codex-conformance-");
  const worlds: FakeCodexWorld[] = [];
  return {
    name: "codex driver (fake codex app-server, schema-checked frames)",
    worlds,
    cleanup: created.cleanup,
    notApplicable: {
      "capability-honesty.ext.codex.review": "codex.review start runs a review turn of its own on the thread scenario 14 goes on to roll back; quirks.test.ts covers it",
    },
    workspace: async (): Promise<ConformanceWorkspace> => created.workspace,
    async setup(request): Promise<HarnessRig<CodexDriverConfig>> {
      const rigRoot = path.join(created.root, "rigs", `${request.scenario}-${Math.random().toString(36).slice(2)}`);
      const world = new FakeCodexWorld({ ambientAuth: request.ambientAuth, realpath: (value) => fs.realpathSync(value) });
      worlds.push(world);
      const spawn = async (spawnRequest: FakeSpawnRequest) => world.spawn(spawnRequest);
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
            return next.value;
          },
          lockSession: async (thread) => world.lock(thread.handle ?? thread.native.id ?? ""),
          inspectSession: async (thread) => world.inspect(thread.handle ?? thread.native.id ?? ""),
          activity: async (): Promise<NativeActivity> => ({ feedback: [...world.activityLog.feedback], mcp: [...world.activityLog.mcp], extensions: extensionActivity(world) }),
        },
        probeExecutables: ["codex"],
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
