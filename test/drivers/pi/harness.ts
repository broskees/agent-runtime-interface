// The conformance harness for the Pi driver. The driver spawns `pi` through
// the host; this harness starts test/drivers/pi/fake-pi.ts as a real Node child
// process instead, with the environment the host computed, and drives its
// puppet over a Node IPC channel the driver never sees. Session files are real
// files under each instance's state directory, and the workspace is a real
// directory with a real symbolic link.
//
// The harness also keeps every RPC frame each fake sent or received, and the
// command line and directory of every fake it started, so tests can check the
// frames against Pi's published types and see how the driver ran Pi.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncQueue } from "../../../src/conformance/util.ts";
import type {
  ConformanceHarness,
  ConformanceWorkspace,
  FakeSpawnRequest,
  HarnessRig,
  NativeApproval,
  NativeSessionState,
  NativeTool,
  NativeTurn,
} from "../../../src/conformance/index.ts";
import { piDriver } from "../../../src/drivers/pi/index.ts";
import type { PiConfig } from "../../../src/drivers/pi/index.ts";
import { callErrors } from "../../../src/index.ts";
import type { HostPaths, Thread } from "../../../src/index.ts";
import { createConformanceWorkspace, instanceDirectories, toSpawnedProcess, watchInstanceFiles } from "../../helpers/conformance.ts";

export const FAKE_PI = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-pi.ts");

/** One RPC record a fake received (`in`) or sent (`out`). */
export interface Frame {
  readonly direction: "in" | "out";
  readonly record: { readonly [key: string]: unknown };
}

/** One fake `pi` the harness started: its arguments and working directory. */
export interface Invocation {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly bridge: { readonly mode: string; readonly mcpServers: readonly string[] } | null;
}

/** Calls the puppet of one fake over its IPC channel. */
export class PuppetChannel {
  readonly #child: childProcess.ChildProcess;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #nextId = 1;
  #alive = true;
  readonly exited: Promise<void>;

  constructor(child: childProcess.ChildProcess, onEvent: (event: { [key: string]: unknown }) => void) {
    this.#child = child;
    child.on("message", (message: { id?: number; result?: unknown; error?: string; event?: string }) => {
      if (message.event !== undefined) {
        onEvent(message as { [key: string]: unknown });
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
      for (const pending of this.#pending.values()) pending.reject(new Error("the fake pi process exited"));
      this.#pending.clear();
    });
  }

  get alive(): boolean {
    return this.#alive;
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<T>((resolve, reject) => {
      if (!this.#alive) {
        reject(new Error("the fake pi process exited"));
        return;
      }
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#child.send({ id, method, args }, (error) => {
        if (error !== null && error !== undefined) {
          this.#pending.delete(id);
          reject(error);
        }
      });
    });
  }

  /** A call whose answer may never come because the process exits. */
  fire(method: string, ...args: unknown[]): void {
    if (this.#child.connected) this.#child.send({ id: 0, method, args });
  }
}

/** The puppet's controls for one run of one fake, plus a test-only dialog step. */
export interface PiNativeTurn extends NativeTurn {
  readonly channel: PuppetChannel;
  readonly runId: number;
  /** Opens an extension UI dialog of some other extension (not the bridge) in this run. */
  extensionDialog(request: { readonly [key: string]: unknown }): Promise<{ replies(): Promise<readonly string[]>; nextReply(): Promise<string> }>;
}

function nativeTurn(channel: PuppetChannel, runId: number, prompt: string): PiNativeTurn {
  const dialogHandle = (id: string) => ({
    nextReply: () => channel.call<string>("nextApprovalReply", id),
    replies: () => channel.call<string[]>("approvalReplies", id),
  });
  return {
    channel,
    runId,
    prompt,
    say: (text: string) => channel.call("say", runId, text),
    runTool: (tool: NativeTool) => channel.call("runTool", runId, tool),
    requestApproval: async (approval: NativeApproval) => dialogHandle(await channel.call<string>("requestApproval", runId, approval)),
    extensionDialog: async (request) => dialogHandle(await channel.call<string>("extensionDialog", runId, request)),
    nextSteer: () => channel.call<string>("nextSteer", runId),
    complete: () => channel.call("complete", runId),
    completeHeld: async () => {
      await channel.call("holdCompletion", runId);
      return { release: () => channel.call("releaseCompletion") };
    },
    fail: (failure) => channel.call("fail", runId, failure),
    // The process exiting answers a pending stop request too.
    stopRequested: () => Promise.race([channel.call<"cancel" | "exit">("stopRequested", runId), channel.exited.then(() => "exit" as const)]),
    finishCancelled: () => channel.call("finishCancelled", runId),
    exitProcess: async () => {
      channel.fire("exitProcess");
      await channel.exited;
    },
  };
}

/** Reads a session file the way Pi does: the leaf is the last entry; the active branch runs from it to the root. */
export function storedSessionState(file: string): NativeSessionState | undefined {
  if (!fs.existsSync(file)) return undefined;
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type: string; id?: string; parentId?: string | null; cwd?: string; message?: { role?: string; content?: unknown } });
  const header = lines.find((line) => line.type === "session");
  const entries = lines.filter((line) => line.type !== "session");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const active: typeof entries = [];
  for (let current = entries.at(-1); current !== undefined; current = current.parentId === null || current.parentId === undefined ? undefined : byId.get(current.parentId)) active.push(current);
  active.reverse();
  let prompts = new Set<string>();
  try {
    prompts = new Set((JSON.parse(fs.readFileSync(`${file}.fake-pi.json`, "utf8")) as { prompts: string[] }).prompts);
  } catch {
    // No prompts recorded yet.
  }
  return {
    loaded: false,
    cwd: header?.cwd ?? "",
    prompts: active.filter((entry) => entry.type === "message" && prompts.has(entry.id ?? "")).map((entry) => String(entry.message?.content)),
    compactions: active.filter((entry) => entry.type === "compaction").length,
    injectedMessages: [],
    backgroundTasks: [],
    subagents: [],
  };
}

export interface PiHarness extends ConformanceHarness<PiConfig> {
  readonly frames: Frame[];
  readonly invocations: Invocation[];
  readonly root: string;
  cleanup(): void;
}

export interface PiHarnessOptions {
  /** The version the fake reports for `pi --version`. */
  readonly fakeVersion?: string;
  readonly name?: string;
}

/** The Pi driver against fake `pi` processes. */
export function piHarness(options: PiHarnessOptions = {}): PiHarness {
  const created = createConformanceWorkspace("ari-pi-conformance-");
  const frames: Frame[] = [];
  const invocations: Invocation[] = [];
  return {
    name: options.name ?? "pi driver (fake pi --mode rpc in a child process)",
    frames,
    invocations,
    root: created.root,
    cleanup: created.cleanup,
    notApplicable: {
      "session-replaced.locked": "Pi does not lock session files: two pi processes can open the same session (Pi 1.6.0 SessionManager has no lock), so there is no locked state to resume",
    },
    workspace: async (): Promise<ConformanceWorkspace> => created.workspace,
    async setup(request): Promise<HarnessRig<PiConfig>> {
      const rigRoot = path.join(created.root, "rigs", `${request.scenario}-${Math.random().toString(36).slice(2)}`);
      const turns = new AsyncQueue<NativeTurn>();
      const children = new Set<childProcess.ChildProcess>();
      const channels: PuppetChannel[] = [];

      const spawn = async (spawnRequest: FakeSpawnRequest) => {
        if (path.basename(spawnRequest.command) !== path.basename(FAKE_PI)) throw callErrors.notFound({ resource: "executable", id: spawnRequest.command });
        const extra = [`--fake-ambient-auth=${request.ambientAuth}`, ...(options.fakeVersion === undefined ? [] : [`--fake-version=${options.fakeVersion}`])];
        const child = childProcess.spawn(process.execPath, [FAKE_PI, ...(spawnRequest.args ?? []), ...extra], {
          // Exactly the environment the host computed, so dropped credentials stay dropped.
          env: { ...spawnRequest.environment },
          stdio: [spawnRequest.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe", "ipc"],
          ...(spawnRequest.cwd === undefined ? {} : { cwd: spawnRequest.cwd }),
        });
        children.add(child);
        child.once("exit", () => children.delete(child));
        const channel: PuppetChannel = new PuppetChannel(child, (event) => {
          if (event["event"] === "turn") turns.push(nativeTurn(channel, Number(event["runId"]), String(event["prompt"])));
          else if (event["event"] === "frame") frames.push({ direction: event["direction"] as Frame["direction"], record: event["record"] as Frame["record"] });
          else if (event["event"] === "started") invocations.push({ argv: event["argv"] as string[], cwd: String(event["cwd"]), bridge: event["bridge"] as Invocation["bridge"] });
        });
        channels.push(channel);
        return toSpawnedProcess(child);
      };

      return {
        driver: piDriver,
        config: { binary: "pi", provider: "fake", model: "fake/fake-small" },
        hostOptions: (instanceId, arrangement) => ({
          paths: instanceDirectories(rigRoot, instanceId),
          spawn,
          resolveExecutable: async (name) => (name === "pi" ? FAKE_PI : null),
          secrets: arrangement.managedProfile ? [{ namespace: "pi", key: "api-key", value: "managed-profile-key" }] : [],
        }),
        native: {
          nextTurn: async () => {
            const next = await turns.next();
            if (next.done === true) throw new Error("the rig was disposed");
            return next.value;
          },
          inspectSession: async (thread: Thread): Promise<NativeSessionState | undefined> => {
            const file = thread.handle ?? "";
            for (const channel of channels) {
              if (!channel.alive) continue;
              const loaded = await channel.call<NativeSessionState | null>("inspect", file).catch(() => null);
              if (loaded !== null) return loaded;
            }
            return storedSessionState(file);
          },
        },
        probeExecutables: [path.basename(FAKE_PI)],
        inheritedCredentials: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
        watchInstanceFiles: (paths: HostPaths) => watchInstanceFiles(paths),
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
