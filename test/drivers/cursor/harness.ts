// The conformance harness for the Cursor driver. The driver loads the SDK
// through the loader `createCursorDriver` takes; this harness hands it the
// fake SDK of fake-sdk.ts instead, one fresh fake Cursor per rig. Agents are
// created and resumed by the real @cursor/sdk, offline, in a real agent store
// under each instance's state directory; runs are driven by the kit's puppet.

import "./setup-env.ts";
import * as path from "node:path";
import type { ToolCall } from "@cursor/sdk";
import type { ConformanceHarness, HarnessRig, NativeSessionState, NativeTool, NativeTurn } from "../../../src/conformance/index.ts";
import { createCursorDriver } from "../../../src/drivers/cursor/index.ts";
import type { CursorConfig } from "../../../src/drivers/cursor/index.ts";
import type { Thread } from "../../../src/index.ts";
import { createConformanceWorkspace, instanceDirectories, watchInstanceFiles } from "../../helpers/conformance.ts";
import { FakeCursorWorld } from "./fake-sdk.ts";
import type { FakeRun } from "./fake-sdk.ts";

/** The API key a managed instance stores; the fake Cursor accepts it. */
export const MANAGED_KEY = "crsr_fake_managed_instance_key";

/** The version the fake loader reports: the pinned devDependency. */
export const FAKE_SDK_VERSION = "1.4.2";

const TURN_USAGE = { inputTokens: 120, outputTokens: 30, cacheReadTokens: 64, cacheWriteTokens: 0 };

/**
 * The Cursor tool a kit tool becomes. The kit's tools read the workspace, so
 * they are tools a `read_only` agent offers: `read` for a file, `ls` for a
 * directory listing, `semSearch` for anything else. Cursor reports paths as
 * absolute paths in the agent's own directory.
 */
export function cursorToolFor(tool: NativeTool, cwd: string): ToolCall {
  const absolute = tool.path === undefined ? undefined : path.join(cwd, tool.path);
  if (tool.name === "list_files" && absolute !== undefined) {
    return {
      type: "ls",
      args: { path: path.dirname(absolute) },
      result: { status: "success", value: { directoryTreeRoot: { absPath: path.dirname(absolute), childrenDirs: [], childrenFiles: [{ name: path.basename(absolute) }], childrenWereProcessed: true, fullSubtreeExtensionCounts: {}, numFiles: 1 } } },
    };
  }
  if (absolute !== undefined) {
    return { type: "read", args: { path: absolute }, result: { status: "success", value: { content: tool.output, totalLines: tool.output.split("\n").length, fileSize: tool.output.length } } };
  }
  return { type: "semSearch", args: { query: JSON.stringify(tool.input) }, result: { status: "success", value: { results: tool.output } } };
}

/** The kit's puppet for one fake run. */
export function nativeTurnFor(run: FakeRun, cwd: string): NativeTurn {
  let tools = 0;
  return {
    prompt: run.prompt,
    say: (text) => run.say(text),
    runTool: async (tool) => {
      tools += 1;
      await run.runTool(`tool_${run.id.slice(-6)}_${tools}`, cursorToolFor(tool, cwd));
    },
    requestApproval: async () => {
      throw new Error("Cursor's SDK raises no approval requests: a local run answers its own interaction queries");
    },
    nextSteer: () => run.nextSteer(),
    complete: async () => {
      await run.endTurn(TURN_USAGE);
      run.finish();
    },
    completeHeld: async () => {
      await run.endTurn(TURN_USAGE);
      return { release: async () => run.finish() };
    },
    fail: async (failure) => {
      if (failure.kind === "usage_limit") run.fail({ message: failure.message, code: "PRO_USER_USAGE_LIMIT" });
      else run.fail({ message: failure.message });
    },
    stopRequested: () => run.stopRequested(),
    finishCancelled: async () => run.finishCancelled(),
    // The agent loop runs inside the host's process; its runtime dying is the run failing on a lost connection.
    exitProcess: async () => run.fail({ message: "Connection failed repeatedly", code: "unavailable" }),
  };
}

/** What the fake Cursor holds for the agent behind a thread. */
export function inspectAgent(world: FakeCursorWorld, thread: Thread): NativeSessionState | undefined {
  const agentId = thread.handle ?? thread.native.id;
  const record = agentId === null ? undefined : world.agentFor(agentId);
  if (record === undefined) return undefined;
  return {
    loaded: record.handles.size > 0,
    cwd: record.cwd,
    prompts: [...record.prompts],
    compactions: record.compactions,
    injectedMessages: [],
    backgroundTasks: [],
    subagents: record.subagents.map((subagent) => ({ ...subagent })),
  };
}

export function cursorHarness(): ConformanceHarness<CursorConfig> & { cleanup(): void } {
  const { workspace, root, cleanup } = createConformanceWorkspace("ari-cursor-conformance-");
  let rigs = 0;
  return {
    name: "cursor (fake @cursor/sdk 1.4.2, in process)",
    notApplicable: {
      "session-replaced.locked": "Cursor's local agent store has no lock: Agent.resume reads the agent's row and opens it, whoever else holds it (@cursor/sdk index.js resumeAgent)",
      "turn-failed.usage_limit": "Cursor's RunError carries only a message and a code, no reset time (@cursor/sdk run.d.ts); quirks.test.ts checks the usage_limit class",
      "auth-states.inherited-credentials":
        "The SDK runs Cursor's agent inside the host's process, whose shell tools inherit the host's process.env (977.js); the driver's part, an explicit apiKey on every SDK call, is tested in auth.test.ts",
    },
    cleanup,
    workspace: async () => workspace,
    async setup(request): Promise<HarnessRig<CursorConfig>> {
      rigs += 1;
      const rigRoot = path.join(root, `rig-${rigs}`);
      const world = new FakeCursorWorld({ root: path.join(rigRoot, "cursor"), ambientAuth: request.ambientAuth, acceptedKeys: [MANAGED_KEY] });
      await world.storeSignIn(request.ambientAuth !== "unauthenticated");
      const driver = createCursorDriver({ loadSdk: async () => ({ sdk: world.module, version: FAKE_SDK_VERSION }) });
      return {
        driver,
        hostOptions: (instanceId, arrangement) => ({
          paths: instanceDirectories(rigRoot, instanceId),
          secrets: arrangement.managedProfile ? [{ namespace: "cursor", key: "api-key", value: MANAGED_KEY }] : [],
        }),
        native: {
          nextTurn: async () => {
            const run = await world.nextRun();
            return nativeTurnFor(run, world.agentFor(run.agentId)?.cwd ?? workspace.cwd);
          },
          inspectSession: async (thread) => inspectAgent(world, thread),
        },
        probeExecutables: [],
        watchInstanceFiles,
        inheritedCredentials: ["CURSOR_API_KEY"],
        dispose: async () => world.close(),
      };
    },
  };
}
