// The in-memory harness for the reference driver: the agent runs in this
// JavaScript realm behind a `SpawnedProcess` made of queues, with a virtual
// filesystem. It needs no Node built-in, so the whole suite can run in a
// browser or Bun as well as Node.
//
// The virtual workspace is `/workspace/project`, reached through the virtual
// symbolic link `/workspace/link-to-project`; the agent resolves paths the way
// an operating system resolves that link. Session files the agent writes live
// under the instance's virtual state directory; the memory store reports each
// write, so `watchInstanceFiles` sees every one.

import { callErrors } from "../../errors.ts";
import type { Driver } from "../../runtime.ts";
import type { FakeSpawnRequest } from "../fake-host.ts";
import type { ConformanceHarness, ConformanceWorkspace, HarnessRig, NativeSessionState, NativeTurn } from "../harness.ts";
import { AsyncQueue, baseName } from "../util.ts";
import { ReferenceAgent } from "./agent.ts";
import { referenceDriver } from "./driver.ts";
import type { ReferenceDriverConfig } from "./driver.ts";
import { createMemoryProcess } from "./memory-process.ts";
import { MemoryReferenceStore } from "./store.ts";

export const REFERENCE_WORKSPACE: ConformanceWorkspace = {
  cwd: "/workspace/project",
  symlinkedCwd: "/workspace/link-to-project",
  otherCwd: "/workspace/other",
};

/** Resolves the virtual workspace link the way the operating system would. */
function virtualRealpath(path: string): string {
  const link = REFERENCE_WORKSPACE.symlinkedCwd!;
  if (path === link || path.startsWith(`${link}/`)) return `${REFERENCE_WORKSPACE.cwd}${path.slice(link.length)}`;
  return path;
}

/** The puppet controls of one turn of an in-memory reference agent. */
export function referenceNativeTurn(agent: ReferenceAgent, turn: { readonly turnId: string; readonly prompt: string }): NativeTurn {
  const { turnId, prompt } = turn;
  return {
    prompt,
    say: (text) => agent.say(turnId, text),
    runTool: (tool) => agent.runTool(turnId, tool),
    requestApproval: async (approval) => {
      const approvalId = await agent.requestApproval(turnId, approval);
      return { nextReply: () => agent.nextApprovalReply(approvalId), replies: async () => agent.approvalReplies(approvalId) };
    },
    startBackgroundTask: (task) => agent.startBackgroundTask(turnId, task.title),
    spawnSubagent: (subagent) => agent.spawnSubagent(turnId, subagent.name),
    nextSteer: () => agent.nextSteer(turnId),
    complete: () => agent.complete(turnId),
    completeHeld: async () => {
      await agent.holdCompletion(turnId);
      return { release: () => agent.releaseCompletion(turnId) };
    },
    fail: (failure) => agent.fail(turnId, failure),
    stopRequested: () => agent.stopRequested(turnId),
    finishCancelled: () => agent.finishCancelled(turnId),
    exitProcess: async () => agent.exitProcess(),
  };
}

export interface ReferenceHarnessOptions {
  readonly name?: string;
  /** Config for the reference driver; unset fields take `defaultConfig()`. */
  readonly config?: Partial<ReferenceDriverConfig>;
  readonly notApplicable?: ConformanceHarness["notApplicable"];
  readonly time?: ConformanceHarness["time"];
}

/** A conformance harness that runs the reference driver against an in-memory reference agent. */
export function referenceHarness(options: ReferenceHarnessOptions = {}): ConformanceHarness<ReferenceDriverConfig> {
  const driver: Driver<ReferenceDriverConfig> = referenceDriver;
  const config: ReferenceDriverConfig = { ...driver.defaultConfig(), ...options.config };
  return {
    name: options.name ?? `reference driver (${config.profile}, in memory)`,
    ...(options.notApplicable === undefined ? {} : { notApplicable: options.notApplicable }),
    ...(options.time === undefined ? {} : { time: options.time }),
    workspace: async () => REFERENCE_WORKSPACE,
    async setup(request): Promise<HarnessRig<ReferenceDriverConfig>> {
      const stores = new Map<string, MemoryReferenceStore>();
      /** What each running `watchInstanceFiles` hears. */
      const watchers = new Set<(path: string) => void>();
      const storeFor = (directory: string): MemoryReferenceStore => {
        let store = stores.get(directory);
        if (store === undefined) {
          store = new MemoryReferenceStore(directory, (path) => {
            for (const watcher of watchers) watcher(path);
          });
          stores.set(directory, store);
        }
        return store;
      };
      const turns = new AsyncQueue<NativeTurn>();
      const agents: ReferenceAgent[] = [];
      const environments: Array<{ readonly [name: string]: string }> = [];

      const spawn = async (spawnRequest: FakeSpawnRequest) => {
        if (baseName(spawnRequest.command) !== "reference-agent") throw callErrors.notFound({ resource: "executable", id: spawnRequest.command });
        let agent: ReferenceAgent | undefined;
        const memory = createMemoryProcess({
          onStdin: (text) => agent?.receive(text),
          onStdinClosed: () => agent?.closeStdin(),
          onKill: (signal) => agent?.kill(signal),
        });
        const created = new ReferenceAgent({
          argv: spawnRequest.args ?? [],
          env: spawnRequest.environment,
          io: { out: memory.stdout, err: memory.stderr, exit: memory.exit },
          storeFor,
          realpath: virtualRealpath,
          ambientAuth: request.ambientAuth,
          onTurn: (turn) => turns.push(referenceNativeTurn(created, turn)),
        });
        agent = created;
        agents.push(created);
        environments.push(spawnRequest.environment);
        created.start();
        return memory.process;
      };

      return {
        driver,
        config,
        hostOptions: (instanceId, arrangement) => ({
          paths: { stateDir: `/instances/${instanceId}/state`, cacheDir: `/instances/${instanceId}/cache`, tmpDir: `/instances/${instanceId}/tmp` },
          spawn,
          resolveExecutable: async (name) => (baseName(name) === "reference-agent" ? "/usr/local/bin/reference-agent" : null),
          secrets: arrangement.managedProfile ? [{ namespace: "reference", key: "api-key", value: "managed-profile-key" }] : [],
        }),
        native: {
          nextTurn: async () => {
            const next = await turns.next();
            if (next.done === true) throw new Error("the rig was disposed");
            return next.value;
          },
          lockSession: async (thread) => {
            const sessionId = thread.handle ?? thread.native.id ?? "";
            for (const store of stores.values()) if (store.has(sessionId)) store.lock(sessionId);
          },
          observedEnvironments: async () => [...environments],
          inspectSession: async (thread): Promise<NativeSessionState | undefined> => {
            const sessionId = thread.handle ?? thread.native.id ?? "";
            for (const agent of agents) {
              const loaded = agent.inspectSession(sessionId);
              if (loaded !== undefined) return loaded;
            }
            for (const store of stores.values()) {
              const stored = store.load(sessionId);
              if (stored !== undefined) {
                return { loaded: false, cwd: stored.cwd, turns: stored.turns.length, compactions: stored.compactions, injectedMessages: stored.injectedMessages };
              }
            }
            return undefined;
          },
        },
        probeExecutables: ["reference-agent"],
        inheritedCredentials: ["REFERENCE_AGENT_API_KEY"],
        watchInstanceFiles: async (paths) => {
          const roots = [paths.stateDir, paths.cacheDir, paths.tmpDir].map((root) => `${root}/`);
          const written = new Set<string>();
          const watcher = (path: string): void => {
            if (roots.some((root) => path.startsWith(root))) written.add(path);
          };
          watchers.add(watcher);
          return {
            stop: async () => {
              watchers.delete(watcher);
              return [...written].sort();
            },
          };
        },
        exercise: {
          mcpApp: { server: "reference-tools", tool: "echo", args: { text: "hello" }, resourceUri: "reference://readme" },
          extensionCalls: { "reference.echo": { method: "echo", params: { text: "hello" } } },
        },
        dispose: async () => {
          turns.end();
          for (const agent of agents) agent.kill("SIGKILL");
        },
      };
    },
  };
}
