// The conformance harness for the OpenCode driver, one per server generation.
// The driver spawns `opencode` through the host; this harness answers with the
// fake of fake-opencode.ts: `--version` prints the fake's version, `serve`
// starts a fake server on a loopback port in the test process. The puppet
// drives the fake's runs directly. Every fake server of a rig shares one
// `FakeWorld`, OpenCode's database for that rig.
//
// OpenCode's permission replies are the fixed strings `once`, `always` and
// `reject`, not option ids, so each approval handle says which native reply
// stands for each of the kit's options (`nativeOptionIds`, worked out from the
// decisions, not by asking the driver).

import * as path from "node:path";
import type { ConformanceHarness, ConformanceWorkspace, FakeSpawnRequest, HarnessRig, NativeSessionState } from "../../../src/conformance/index.ts";
import { deriveId } from "../../../src/driver-kit/index.ts";
import { createOpencodeDriver } from "../../../src/drivers/opencode/index.ts";
import type { OpencodeConfig, OpencodeSdkLoaders } from "../../../src/drivers/opencode/index.ts";
import { callErrors } from "../../../src/index.ts";
import type { Driver, HostPaths, Thread } from "../../../src/index.ts";
import { createConformanceWorkspace, instanceDirectories, watchInstanceFiles } from "../../helpers/conformance.ts";
import { FakeServer, FakeWorld, spawnFakeOpencode, startExternalServer } from "./fake-opencode.ts";
import type { Generation } from "./fake-opencode.ts";

/** The thread id the driver documents for a native session (docs/drivers/opencode.md): kind `thread`, the session id as a strong native id, identity version 1. */
export function documentedThreadId(sessionId: string): string {
  return deriveId({ kind: "thread", native: { id: sessionId, strength: "strong" }, identityVersion: 1 });
}

/** A session as the fake holds it: what `inspectSession` reports. */
export function sessionState(world: FakeWorld, sessionId: string): NativeSessionState | undefined {
  const session = world.sessions.get(sessionId);
  if (session === undefined) return undefined;
  return {
    loaded: world.loadedBy(sessionId) !== undefined,
    cwd: session.directory,
    prompts: world
      .visibleMessages(session)
      .filter((message) => message.role === "user" && !message.steer)
      .map((message) => message.text),
    compactions: session.compactions,
    injectedMessages: [],
    backgroundTasks: [],
    subagents: [],
  };
}

export interface OpencodeHarness extends ConformanceHarness<OpencodeConfig> {
  /** Every world (one per rig) this harness made, for the frame checks. */
  readonly worlds: FakeWorld[];
  readonly root: string;
  cleanup(): void;
}

export interface OpencodeHarnessOptions {
  readonly generation: Generation;
  /** Connect to a fake server the test runs, as an external OpenCode server, instead of letting the driver start one. */
  readonly external?: boolean;
  readonly name?: string;
  readonly loadSdk?: OpencodeSdkLoaders;
}

export function opencodeHarness(options: OpencodeHarnessOptions): OpencodeHarness {
  const created = createConformanceWorkspace(`ari-opencode-${options.generation}-conformance-`);
  const worlds: FakeWorld[] = [];
  const driver: Driver<OpencodeConfig> = createOpencodeDriver(options.loadSdk === undefined ? {} : { loadSdk: options.loadSdk });
  return {
    name: options.name ?? `opencode driver (fake OpenCode ${options.generation}.x server${options.external === true ? ", external" : ""})`,
    worlds,
    root: created.root,
    cleanup: created.cleanup,
    notApplicable: {
      "duplicate-always-options":
        "OpenCode answers a permission request with exactly once, always or reject (1.19.6 permission.reply, 2.1.2 Permission.Reply), so no native request offers two always options",
      "session-replaced.locked": "OpenCode keeps sessions in its database without a lock: any server reads any session by id (1.19.6 Session.get, 2.1.2 session.get), so there is no locked session to resume",
      "idempotent-responses.full-access": "Under full_access the driver gives the session the rule * allow, so OpenCode asks no permission and there is no reply to check",
    },
    workspace: async (): Promise<ConformanceWorkspace> => created.workspace,
    async setup(request): Promise<HarnessRig<OpencodeConfig>> {
      const rigRoot = path.join(created.root, "rigs", `${request.scenario}-${Math.random().toString(36).slice(2)}`);
      const world = new FakeWorld(options.generation);
      await world.ready();
      worlds.push(world);
      let external: FakeServer | undefined;
      if (options.external === true) external = await startExternalServer(world, "external-password");
      const spawn = async (spawnRequest: FakeSpawnRequest) => {
        if (path.basename(spawnRequest.command) !== "opencode") throw callErrors.notFound({ resource: "executable", id: spawnRequest.command });
        return spawnFakeOpencode(world, spawnRequest);
      };
      const firstThread = (): string => {
        for (const session of world.sessions.values()) if (session.parentId === undefined && session.forkedFrom === undefined) return documentedThreadId(session.id);
        return "no-thread";
      };
      return {
        driver,
        config: { binary: "opencode", ...(external === undefined ? {} : { serverUrl: external.url }) },
        hostOptions: (instanceId) => ({
          paths: instanceDirectories(rigRoot, instanceId),
          spawn,
          resolveExecutable: async (name) => (name === "opencode" ? path.join(rigRoot, "bin", "opencode") : null),
          secrets: external === undefined ? [] : [{ namespace: "opencode", key: "server-password", value: "external-password" }],
        }),
        native: {
          nextTurn: async () => {
            const next = await world.turns.next();
            if (next.done === true) throw new Error("the rig was disposed");
            return next.value;
          },
          inspectSession: async (thread: Thread) => sessionState(world, thread.handle ?? thread.native.id ?? ""),
          // `opencode.permissionRules` `get` reads the session from the server: each read, in ARI's shape.
          activity: async () => ({
            feedback: [],
            mcp: [],
            extensions: world.sessionReads.map((read) => ({ params: { threadId: documentedThreadId(read.sessionId) }, result: { rules: read.rules } })),
          }),
        },
        probeExecutables: ["opencode"],
        watchInstanceFiles: (paths: HostPaths) => watchInstanceFiles(paths),
        exercise: {
          model: "fake/fake-small",
          extensionCalls: {
            get "opencode.permissionRules"() {
              return { method: "get", params: { threadId: firstThread() } };
            },
          },
        },
        missingSession: { id: "ses_missing00000000fake", strength: "strong" },
        dispose: async () => {
          world.turns.end();
          for (const server of world.servers) await server.exit(null, "SIGKILL");
        },
      };
    },
  };
}
