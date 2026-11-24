// The conformance harness for the Claude driver: an in-process SDK harness.
// Each rig is a fresh fake Claude Code installation (`FakeClaudeWorld`):
// its transcript store, its processes, and the puppet that moves them. The
// driver is built with `createClaudeDriver({ loadSdk })` around the fake
// SDK, and spawns through the host only `claude auth status --json`, which
// the fake host hands to the fake's answer.
//
// This file is test glue, not the fake: it may use the driver's id and
// option naming to translate between the kit's terms and the driver's, as
// a host would.

import type { ConformanceHarness, HarnessRig, NativeActivity, NativeApproval, NativeApprovalHandle, NativeTurn } from "../../../src/conformance/index.ts";
import { createMemoryProcess } from "../../../src/conformance/index.ts";
import type { FakeHostOptions, FakeSpawnRequest } from "../../../src/conformance/fake-host.ts";
import { CLAUDE_OPTION_ALLOW, CLAUDE_OPTION_DENY, allowWithRulesOptionId, createClaudeDriver, threadIdFor, turnIdFor } from "../../../src/drivers/claude/index.ts";
import type { ClaudeDriverConfig } from "../../../src/drivers/claude/index.ts";
import type { SpawnedProcess } from "../../../src/runtime.ts";
import { createConformanceWorkspace, instanceDirectories, watchInstanceFiles } from "../../helpers/conformance.ts";
import { FakeClaudeWorld, entryPrompt } from "./fake-sdk.ts";
import type { FakeAmbientAuth, FakeApprovalHandle, FakeNativeAnswer, FakeTurn } from "./fake-sdk.ts";

/** Where the fake SDK says its bundled native binary is. Only `claude auth status --json` ever runs it, through the host. */
export const FAKE_CLAUDE_BINARY = "/fake-node-modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude";

/** The SDK version the fake reports: the pinned devDependency it is typed against. */
export const FAKE_SDK_VERSION = "0.3.330";

export const CLAUDE_INHERITED_CREDENTIALS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/** The driver's option id for a native answer: the translation a host reads off the request's options. */
export function driverOptionId(answer: FakeNativeAnswer): string {
  if (answer.behavior === "deny") return CLAUDE_OPTION_DENY;
  return answer.destination === undefined ? CLAUDE_OPTION_ALLOW : allowWithRulesOptionId(answer.destination);
}

/** The kit's view of a fake turn: Claude's permission results carry no option ids, so each kit option is named by the driver's id for its answer. */
export function kitTurn(turn: FakeTurn): NativeTurn {
  return {
    get prompt() {
      return turn.prompt;
    },
    say: (text) => turn.say(text),
    runTool: (tool) => turn.runTool(tool),
    requestApproval: async (approval: NativeApproval): Promise<NativeApprovalHandle> => {
      const handle = (await turn.requestApproval(approval)) as FakeApprovalHandle;
      const nativeOptionIds = Object.fromEntries(Object.entries(handle.nativeAnswers).map(([optionId, answer]) => [optionId, driverOptionId(answer)]));
      return { nextReply: () => handle.nextReply(), replies: () => handle.replies(), nativeOptionIds };
    },
    startBackgroundTask: (task) => turn.startBackgroundTask!(task),
    spawnSubagent: (subagent) => turn.spawnSubagent!(subagent),
    nextSteer: () => turn.nextSteer!(),
    complete: () => turn.complete(),
    fail: (failure) => turn.fail(failure),
    stopRequested: () => turn.stopRequested(),
    finishCancelled: () => turn.finishCancelled(),
    exitProcess: () => turn.exitProcess(),
  };
}

/** A fake `claude` process: it answers `claude auth status --json` and nothing else. */
export function fakeClaudeSpawn(world: FakeClaudeWorld): (request: FakeSpawnRequest) => Promise<SpawnedProcess> {
  return async (request) => {
    const args = request.args ?? [];
    if (request.command !== FAKE_CLAUDE_BINARY || args.join(" ") !== "auth status --json") {
      throw new Error(`the fake claude binary only answers \`claude auth status --json\`, not ${request.command} ${args.join(" ")}`);
    }
    const answer = world.authStatus();
    const child = createMemoryProcess({ onStdin: () => undefined, onStdinClosed: () => undefined, onKill: () => undefined });
    queueMicrotask(() => {
      if (answer.stdout !== "") child.stdout(answer.stdout);
      if (answer.stderr !== "") child.stderr(answer.stderr);
      child.exit(answer.code, null);
    });
    return child.process;
  };
}

/** The extension calls the world served, in ARI's terms, as `NativeAgent.activity` reports them. */
export function worldActivity(world: FakeClaudeWorld): NativeActivity {
  const extensions = world.calls.flatMap((call): Array<{ params: unknown; result: unknown }> => {
    if (call.kind === "rewindFiles") {
      const threadId = threadIdFor(call.sessionId);
      return [{ params: { threadId, turnId: turnIdFor(threadId, call.userMessageId), dryRun: call.dryRun }, result: call.result }];
    }
    if (call.kind === "applyFlagSettings" && call.settings.hooks !== undefined) {
      return [{ params: { threadId: threadIdFor(call.sessionId), hooks: call.settings.hooks }, result: null }];
    }
    return [];
  });
  return { feedback: [], mcp: [], extensions };
}

/** The first thread of a world that ran a turn, and its first turn, in ARI ids. */
function firstThreadAndTurn(world: FakeClaudeWorld): { threadId: string; turnId: string } | undefined {
  for (const session of world.sessions.values()) {
    const prompt = session.entries.find((entry) => entryPrompt(entry) !== undefined);
    if (prompt === undefined) continue;
    const threadId = threadIdFor(session.id);
    return { threadId, turnId: turnIdFor(threadId, prompt.uuid) };
  }
  return undefined;
}

export interface ClaudeHarness extends ConformanceHarness<ClaudeDriverConfig> {
  readonly worlds: FakeClaudeWorld[];
  cleanup(): void;
}

export function claudeHarness(): ClaudeHarness {
  const { workspace, root, cleanup } = createConformanceWorkspace("ari-claude-conformance-");
  const worlds: FakeClaudeWorld[] = [];
  return {
    name: "claude (fake Claude Agent SDK 0.3.330, in process)",
    worlds,
    cleanup,
    notApplicable: {
      "steer-after-end.race":
        "Claude Code has no refusal for a late steer: a prompt that reaches an idle session starts a new turn (SDKUserMessage priority, Agent SDK docs), so a turn ending just before a steer cannot come back as prompt_required",
      "capability-honesty.ext.ari.goal": "ari.goal is derived by the driver from the transcript (derived: true); Claude has no goal call to observe",
      "idempotent-responses.full-access":
        "under full_access the driver runs Claude Code in bypassPermissions, and Claude Code then runs the tool without calling canUseTool (Agent SDK TypeScript reference, Options.canUseTool: not invoked for calls auto-approved by permissionMode), so no reply exists to check",
    },
    workspace: async () => workspace,
    async setup(request): Promise<HarnessRig<ClaudeDriverConfig>> {
      const world = new FakeClaudeWorld({ ambientAuth: request.ambientAuth as FakeAmbientAuth });
      worlds.push(world);
      const driver = createClaudeDriver({
        loadSdk: async () => ({ sdk: world.sdk, version: FAKE_SDK_VERSION, claudeCodeVersion: "2.1.330", bundledExecutable: FAKE_CLAUDE_BINARY }),
        newUuid: () => world.newUuid(),
      });
      const spawn = fakeClaudeSpawn(world);
      return {
        driver,
        hostOptions: (instanceId, arrangement): FakeHostOptions<ClaudeDriverConfig> => ({
          paths: instanceDirectories(root, instanceId),
          spawn,
          resolveExecutable: async (name) => (name === "claude" ? FAKE_CLAUDE_BINARY : null),
          ...(arrangement.managedProfile ? { secrets: [{ namespace: "claude", key: "api-key", value: "sk-ant-managed-conformance-key" }] } : {}),
        }),
        native: {
          nextTurn: async () => kitTurn(await world.nextTurn()),
          lockSession: async (thread) => {
            world.locked.add(thread.handle ?? thread.native.id!);
          },
          observedEnvironments: async () => world.environments(),
          inspectSession: async (thread) => world.inspect(thread.handle ?? thread.native.id!),
          activity: async () => worldActivity(world),
        },
        probeExecutables: [FAKE_CLAUDE_BINARY],
        inheritedCredentials: [...CLAUDE_INHERITED_CREDENTIALS],
        watchInstanceFiles,
        exercise: {
          get extensionCalls(): { readonly [ns: string]: { readonly method: string; readonly params: unknown } } {
            const first = firstThreadAndTurn(world);
            if (first === undefined) return {};
            return {
              "claude.fileCheckpoints": { method: "rewind", params: { threadId: first.threadId, turnId: first.turnId, dryRun: true } },
              "claude.hooks": { method: "set", params: { threadId: first.threadId, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] } } },
            };
          },
        },
      };
    },
  };
}
