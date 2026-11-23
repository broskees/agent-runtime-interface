// A conformance harness whose native agent is a separate process: the
// reference driver spawns `reference-agent`, and this harness starts
// test/conformance/reference-agent-main.ts as a real Node child process for
// it. Protocol frames travel over the child's stdin and stdout, exactly as
// they would for a CLI agent; the harness drives the agent's puppet over a
// separate IPC channel the driver never sees. Sessions live in real files
// under each instance's state directory, the workspace is a real directory
// with a real symbolic link, and the probe scenario lists real files.

import * as childProcess from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncQueue } from "../../src/conformance/util.ts";
import { referenceDriver } from "../../src/conformance/index.ts";
import type {
  ConformanceHarness,
  ConformanceWorkspace,
  FakeSpawnRequest,
  HarnessRig,
  NativeTurn,
  ReferenceDriverConfig,
} from "../../src/conformance/index.ts";
import { callErrors } from "../../src/index.ts";
import type { HostPaths } from "../../src/index.ts";
import { createConformanceWorkspace, instanceDirectories, listInstanceFiles, toSpawnedProcess } from "../helpers/conformance.ts";
import { FileReferenceStore } from "./file-store.ts";

const AGENT_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "reference-agent-main.ts");

/** Calls the puppet of one agent child over its IPC channel. */
class PuppetChannel {
  readonly #child: childProcess.ChildProcess;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #nextId = 1;
  readonly exited: Promise<void>;

  constructor(child: childProcess.ChildProcess, onTurn: (turn: { turnId: string; prompt: string }) => void) {
    this.#child = child;
    child.on("message", (message: { id?: number; result?: unknown; error?: string; event?: string; turnId?: string; prompt?: string }) => {
      if (message.event === "turn") {
        onTurn({ turnId: message.turnId!, prompt: message.prompt! });
        return;
      }
      const pending = message.id === undefined ? undefined : this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id!);
      if (message.error !== undefined) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    this.exited = new Promise((resolve) => child.once("exit", () => resolve()));
    void this.exited.then(() => {
      for (const pending of this.#pending.values()) pending.reject(new Error("the agent process exited"));
      this.#pending.clear();
    });
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#child.send({ id, method, args }, (error) => {
        if (error !== null && error !== undefined) {
          this.#pending.delete(id);
          reject(error);
        }
      });
    });
  }

  /** Sends a call whose answer may never come because the process exits. */
  fire(method: string, ...args: unknown[]): void {
    if (this.#child.connected) this.#child.send({ id: 0, method, args });
  }
}

function childTurn(channel: PuppetChannel, turn: { turnId: string; prompt: string }): NativeTurn {
  const { turnId, prompt } = turn;
  return {
    prompt,
    say: (text) => channel.call("say", turnId, text),
    runTool: (tool) => channel.call("runTool", turnId, tool),
    requestApproval: async (approval) => {
      const approvalId = await channel.call<string>("requestApproval", turnId, approval);
      return {
        nextReply: () => channel.call<string>("nextApprovalReply", approvalId),
        replies: () => channel.call<string[]>("approvalReplies", approvalId),
      };
    },
    startBackgroundTask: (task) => channel.call("startBackgroundTask", turnId, task.title),
    spawnSubagent: (subagent) => channel.call("spawnSubagent", turnId, subagent.name),
    nextSteer: () => channel.call<string>("nextSteer", turnId),
    complete: () => channel.call("complete", turnId),
    fail: (failure) => channel.call("fail", turnId, failure),
    // The child exiting answers a pending stop request too.
    stopRequested: () => Promise.race([channel.call<"cancel" | "exit">("stopRequested", turnId), channel.exited.then(() => "exit" as const)]),
    finishCancelled: () => channel.call("finishCancelled", turnId),
    exitProcess: async () => {
      channel.fire("exitProcess");
      await channel.exited;
    },
  };
}

/** The reference driver against a reference agent that runs as a child process. */
export function childProcessHarness(): ConformanceHarness<ReferenceDriverConfig> & { cleanup(): void } {
  const created = createConformanceWorkspace("ari-conformance-child-");
  return {
    name: "reference driver (full, agent in a child process)",
    workspace: async (): Promise<ConformanceWorkspace> => created.workspace,
    cleanup: created.cleanup,
    async setup(request): Promise<HarnessRig<ReferenceDriverConfig>> {
      const rigRoot = path.join(created.root, "rigs", `${request.scenario}-${Math.random().toString(36).slice(2)}`);
      const turns = new AsyncQueue<NativeTurn>();
      const children = new Set<childProcess.ChildProcess>();
      const instancePaths: HostPaths[] = [];

      const spawn = async (spawnRequest: FakeSpawnRequest) => {
        if (path.basename(spawnRequest.command) !== "reference-agent") throw callErrors.notFound({ resource: "executable", id: spawnRequest.command });
        const child = childProcess.spawn(process.execPath, [AGENT_MAIN, ...(spawnRequest.args ?? []), `--ambient-auth=${request.ambientAuth}`], {
          // Exactly the environment the host computed, so dropped credentials stay dropped.
          env: { ...spawnRequest.environment },
          stdio: [spawnRequest.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe", "ipc"],
          ...(spawnRequest.cwd === undefined ? {} : { cwd: spawnRequest.cwd }),
        });
        children.add(child);
        child.once("exit", () => children.delete(child));
        const channel = new PuppetChannel(child, (turn) => turns.push(childTurn(channel, turn)));
        return toSpawnedProcess(child);
      };

      return {
        driver: referenceDriver,
        config: referenceDriver.defaultConfig(),
        hostOptions: (instanceId, arrangement) => {
          const paths = instanceDirectories(rigRoot, instanceId);
          instancePaths.push(paths);
          return {
            paths,
            spawn,
            resolveExecutable: async (name) => (path.basename(name) === "reference-agent" ? AGENT_MAIN : null),
            secrets: arrangement.managedProfile ? [{ namespace: "reference", key: "api-key", value: "managed-profile-key" }] : [],
          };
        },
        native: {
          nextTurn: async () => {
            const next = await turns.next();
            if (next.done === true) throw new Error("the rig was disposed");
            return next.value;
          },
          lockSession: async (thread) => {
            const sessionId = thread.handle ?? thread.native.id ?? "";
            for (const paths of instancePaths) {
              const store = new FileReferenceStore(path.join(paths.stateDir, "sessions"));
              if (store.has(sessionId)) store.lock(sessionId);
            }
          },
        },
        probeExecutables: ["reference-agent"],
        inheritedCredentials: ["REFERENCE_AGENT_API_KEY"],
        listInstanceFiles,
        exercise: {
          mcpApp: { server: "reference-tools", tool: "echo", args: { text: "hello" }, resourceUri: "reference://readme" },
          extensionCalls: { "reference.echo": { method: "echo", params: { text: "hello" } } },
        },
        dispose: async () => {
          turns.end();
          const exits = [...children].map((child) => new Promise((resolve) => child.once("exit", resolve)));
          for (const child of children) child.kill("SIGKILL");
          await Promise.all(exits);
        },
      };
    },
  };
}
