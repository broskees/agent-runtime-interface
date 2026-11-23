// A conformance harness for the ACP base driver and its flavors. The driver
// spawns its agent through the host; this harness starts
// test/drivers/acp/fake-agent.ts (an agent written with the official ACP SDK)
// as a real child process instead, with the environment the host computed.
// ACP frames travel over the child's stdin and stdout and are recorded, so a
// test can check every frame against ACP's schema; puppet calls go over a
// separate IPC channel the driver never sees.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncQueue } from "../../../src/conformance/util.ts";
import type {
  ConformanceHarness,
  FakeHostOptions,
  FakeSpawnRequest,
  HarnessRig,
  NativeActivity,
  NativeSessionState,
  NativeTurn,
} from "../../../src/conformance/index.ts";
import { NdjsonDecoder } from "../../../src/driver-kit/ndjson.ts";
import { callErrors } from "../../../src/index.ts";
import type { HostPaths, SpawnedProcess } from "../../../src/index.ts";
import type { Driver } from "../../../src/runtime.ts";
import { createConformanceWorkspace, instanceDirectories, toSpawnedProcess, watchInstanceFiles } from "../../helpers/conformance.ts";

export const FAKE_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-agent.ts");

/** One JSON-RPC frame on the wire between the driver and an agent process. */
export interface RecordedFrame {
  /** Which agent process (one per spawn), so responses pair with their requests. */
  readonly connection: number;
  /** `client`: the driver sent it. `agent`: the agent sent it. */
  readonly from: "client" | "agent";
  readonly message: unknown;
}

/** Calls the puppet of one agent child over its IPC channel. */
class PuppetChannel {
  readonly #child: childProcess.ChildProcess;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #nextId = 1;
  #alive = true;
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
      this.#alive = false;
      for (const pending of this.#pending.values()) pending.reject(new Error("the agent process exited"));
      this.#pending.clear();
    });
  }

  get alive(): boolean {
    return this.#alive;
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (!this.#alive) return Promise.reject(new Error("the agent process exited"));
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

  fire(method: string, ...args: unknown[]): void {
    if (this.#child.connected) this.#child.send({ id: 0, method, args });
  }
}

/** A native turn of the fake agent, with one step beyond the kit's: sending any `session/update` as is. */
export interface FakeNativeTurn extends NativeTurn {
  raw(update: { readonly [key: string]: unknown }): Promise<void>;
}

function childTurn(channel: PuppetChannel, turn: { turnId: string; prompt: string }): FakeNativeTurn {
  const { turnId, prompt } = turn;
  return {
    prompt,
    raw: (update) => channel.call("rawUpdate", turnId, update),
    say: (text) => channel.call("say", turnId, text),
    runTool: (tool) => channel.call("runTool", turnId, tool),
    requestApproval: async (approval) => {
      const approvalId = await channel.call<string>("requestApproval", turnId, approval);
      return {
        nextReply: () => channel.call<string>("nextApprovalReply", approvalId),
        replies: () => channel.call<string[]>("approvalReplies", approvalId),
      };
    },
    complete: () => channel.call("complete", turnId),
    fail: (failure) => channel.call("fail", turnId, failure),
    stopRequested: () => Promise.race([channel.call<"cancel" | "exit">("stopRequested", turnId), channel.exited.then(() => "exit" as const)]),
    finishCancelled: () => channel.call("finishCancelled", turnId),
    exitProcess: async () => {
      channel.fire("exitProcess");
      await channel.exited;
    },
  };
}

/** A `SpawnedProcess` whose stdin writes and stdout frames are recorded in `frames`. */
export function recorded(spawned: SpawnedProcess, connection: number, frames: RecordedFrame[]): SpawnedProcess {
  const fromClient = new NdjsonDecoder();
  const fromAgent = new NdjsonDecoder();
  const keep = (from: RecordedFrame["from"], records: ReturnType<NdjsonDecoder["push"]>): void => {
    for (const record of records) if (record.ok) frames.push({ connection, from, message: record.value });
  };
  const stdout = spawned.stdout;
  return {
    ...(spawned.pid === undefined ? {} : { pid: spawned.pid }),
    stdout: {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of stdout) {
          keep("agent", fromAgent.push(chunk));
          yield chunk;
        }
      },
    },
    stderr: spawned.stderr,
    write: async (data) => {
      keep("client", fromClient.push(data));
      await spawned.write(data);
    },
    closeStdin: () => spawned.closeStdin(),
    kill: (signal) => spawned.kill(signal),
    exited: spawned.exited,
  };
}

export interface AcpHarnessOptions<Config> {
  readonly name: string;
  readonly driver: Driver<Config>;
  /** The rig's instance config; its command must name `executable`. */
  readonly config: Config;
  /** The executable name the driver spawns; the harness runs the fake agent for it. */
  readonly executable: string;
  readonly protocol: 1 | 2;
  /** Extra fake-agent arguments, such as `--fork`. */
  readonly agentArgs?: readonly string[];
  readonly inheritedCredentials?: readonly string[];
  readonly notApplicable?: { readonly [key: string]: string };
  /** Extra host options, such as an explicit `envPolicy`. */
  readonly hostOptions?: (instanceId: string, paths: HostPaths) => Partial<FakeHostOptions<Config>>;
}

export interface AcpHarness<Config> extends ConformanceHarness<Config> {
  /** Every frame between the driver and its agents so far, in order per process. */
  readonly frames: RecordedFrame[];
  /** Every spawn the fake hosts asked for, with the environment the child got. */
  readonly spawns: FakeSpawnRequest[];
  cleanup(): void;
}

const NOT_APPLICABLE = {
  "turn-failed.usage_limit": "ACP defines no usage-limit error or reset time, so the driver reports every agent failure as provider_error",
};

/** The ACP driver (or a flavor) against the SDK-based fake agent, as a child process. */
export function acpHarness<Config>(options: AcpHarnessOptions<Config>): AcpHarness<Config> {
  const created = createConformanceWorkspace(`ari-acp-${options.driver.kind}-`);
  const frames: RecordedFrame[] = [];
  const spawns: FakeSpawnRequest[] = [];
  let connections = 0;
  return {
    name: options.name,
    frames,
    spawns,
    notApplicable: { ...NOT_APPLICABLE, ...(options.notApplicable ?? {}) },
    workspace: async () => created.workspace,
    cleanup: created.cleanup,
    async setup(request): Promise<HarnessRig<Config>> {
      const rigRoot = path.join(created.root, "rigs", `${request.scenario}-${Math.random().toString(36).slice(2)}`);
      const store = path.join(rigRoot, "native-store");
      fs.mkdirSync(store, { recursive: true });
      const turns = new AsyncQueue<NativeTurn>();
      const children = new Set<childProcess.ChildProcess>();
      const channels: PuppetChannel[] = [];

      const spawn = async (spawnRequest: FakeSpawnRequest): Promise<SpawnedProcess> => {
        if (path.basename(spawnRequest.command) !== options.executable) throw callErrors.notFound({ resource: "executable", id: spawnRequest.command });
        spawns.push(spawnRequest);
        const args = [FAKE_AGENT, ...(spawnRequest.args ?? []), "--protocol", String(options.protocol), "--store", store, ...(options.agentArgs ?? [])];
        const child = childProcess.spawn(process.execPath, args, {
          // Exactly the environment the host computed, so stripped variables stay stripped.
          env: { ...spawnRequest.environment },
          stdio: [spawnRequest.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe", "ipc"],
          ...(spawnRequest.cwd === undefined ? {} : { cwd: spawnRequest.cwd }),
        });
        children.add(child);
        child.once("exit", () => children.delete(child));
        const channel = new PuppetChannel(child, (turn) => turns.push(childTurn(channel, turn)));
        channels.push(channel);
        connections += 1;
        return recorded(toSpawnedProcess(child), connections, frames);
      };

      return {
        driver: options.driver,
        config: options.config,
        hostOptions: (instanceId) => {
          const paths = instanceDirectories(rigRoot, instanceId);
          return {
            paths,
            spawn,
            resolveExecutable: async (name: string) => (path.basename(name) === options.executable ? FAKE_AGENT : null),
            ...(options.hostOptions?.(instanceId, paths) ?? {}),
          };
        },
        native: {
          nextTurn: async () => {
            const next = await turns.next();
            if (next.done === true) throw new Error("the rig was disposed");
            return next.value;
          },
          lockSession: async (thread) => {
            const file = path.join(store, `${encodeURIComponent(thread.handle ?? thread.native.id ?? "")}.json`);
            const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { locked: boolean };
            stored.locked = true;
            fs.writeFileSync(file, JSON.stringify(stored));
          },
          inspectSession: async (thread): Promise<NativeSessionState | undefined> => {
            const sessionId = thread.handle ?? thread.native.id ?? "";
            for (const channel of channels) {
              if (!channel.alive) continue;
              const live = await channel.call<NativeSessionState | null>("inspectSession", sessionId).catch(() => null);
              if (live !== null) return live;
            }
            const file = path.join(store, `${encodeURIComponent(sessionId)}.json`);
            if (!fs.existsSync(file)) return undefined;
            const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { cwd: string; prompts: string[] };
            return { loaded: false, cwd: stored.cwd, prompts: stored.prompts, compactions: 0, injectedMessages: [], backgroundTasks: [], subagents: [] };
          },
          activity: async (): Promise<NativeActivity> => {
            const served: NativeActivity[] = [];
            for (const channel of channels) {
              if (!channel.alive) continue;
              const entry = await channel.call<NativeActivity>("activity").catch(() => undefined);
              if (entry !== undefined) served.push(entry);
            }
            return { feedback: served.flatMap((entry) => entry.feedback), mcp: served.flatMap((entry) => entry.mcp), extensions: served.flatMap((entry) => entry.extensions) };
          },
        },
        probeExecutables: [options.executable],
        ...(options.inheritedCredentials === undefined ? {} : { inheritedCredentials: options.inheritedCredentials }),
        watchInstanceFiles,
        exercise: { extensionCalls: { acp: { method: "_ari/echo", params: { text: "hello" } } } },
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
