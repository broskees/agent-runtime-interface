// A driver for the wire mapping tests. With `full: true` its instance and
// session implement every member of `Instance` and `Session`; with
// `full: false` they leave every optional member out. Each call is recorded
// with the arguments the driver received, and returns a result that names the
// member and repeats those arguments, so a test can check both directions of
// the mapping.

import { EventSequencer } from "../../../src/driver-kit/index.ts";
import { referenceCapabilities } from "../../../src/conformance/index.ts";
import { callErrors } from "../../../src/index.ts";
import type { Capabilities } from "../../../src/index.ts";
import type { Driver, HostServices, Instance, Session } from "../../../src/runtime.ts";
import { ARI_VERSION } from "../../../src/version.ts";

export interface RecordedCall {
  readonly target: "instance" | "session";
  readonly member: string;
  readonly args: readonly unknown[];
}

export interface RecordingDriver {
  readonly driver: Driver;
  readonly calls: RecordedCall[];
  /** The session's event sequencer, once a session is open. */
  sequencer(): EventSequencer;
  /** What the session's `canRelease()` answers. */
  setCanRelease(value: boolean): void;
  /** The host services the instance was created with. */
  host(instanceId: string): HostServices;
  /** The capabilities the session reports. */
  readonly capabilities: Capabilities;
}

export const RECORDING_AUTH_METHODS = [{ id: "api-key", label: "API key", kind: "api_key" }];

/** The echo every recorded member returns. */
export function echo(member: string, args: readonly unknown[]): { member: string; args: unknown[] } {
  return { member, args: [...args] };
}

export function createRecordingDriver(options: { readonly full: boolean; readonly failWith?: (member: string) => unknown }): RecordingDriver {
  const calls: RecordedCall[] = [];
  const capabilities: Capabilities = { ...referenceCapabilities(options.full ? "full" : "minimal"), extensions: [{ ns: "test.recording", version: "1.0.0" }] };
  let sequencer: EventSequencer | undefined;
  let canRelease = false;
  const hosts = new Map<string, HostServices>();

  const recorded = (target: "instance" | "session", member: string, result?: (args: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      calls.push({ target, member, args });
      const failure = options.failWith?.(member);
      if (failure !== undefined) throw failure;
      return result === undefined ? Promise.resolve(echo(member, args)) : result(args);
    };

  const createSession = (instanceId: string): Session => {
    const events = new EventSequencer({ sessionId: `${instanceId}-session` });
    sequencer = events;
    const session: Session = {
      id: `${instanceId}-session`,
      capabilities: () => capabilities,
      events: recorded("session", "events", (args) => events.events((args[0] as { fromSeq?: number } | undefined) ?? {})) as Session["events"],
      createThread: recorded("session", "createThread") as Session["createThread"],
      resumeThread: recorded("session", "resumeThread") as Session["resumeThread"],
      canRelease: () => canRelease,
      release: recorded("session", "release", async () => undefined) as Session["release"],
      startTurn: recorded("session", "startTurn") as Session["startTurn"],
      interruptTurn: recorded("session", "interruptTurn", async () => undefined) as Session["interruptTurn"],
      respond: recorded("session", "respond", async (args) => ((args[0] as { optionId?: string }).optionId === "follow" ? { followUpPrompt: [{ type: "text", text: "next" }] } : undefined)) as Session["respond"],
      planConfigChange: recorded("session", "planConfigChange") as Session["planConfigChange"],
      close: recorded("session", "close", async () => {
        events.close();
      }) as Session["close"],
    };
    if (!options.full) return session;
    session.readSnapshot = recorded("session", "readSnapshot") as Session["readSnapshot"];
    session.forkThread = recorded("session", "forkThread") as Session["forkThread"];
    session.rollbackThread = recorded("session", "rollbackThread") as Session["rollbackThread"];
    session.compactThread = recorded("session", "compactThread", async () => undefined) as Session["compactThread"];
    session.injectHistory = recorded("session", "injectHistory") as Session["injectHistory"];
    session.unloadThread = recorded("session", "unloadThread", async () => undefined) as Session["unloadThread"];
    session.backgroundTasks = {
      list: recorded("session", "backgroundTasks.list", async (args) => [echo("backgroundTasks.list", args)]) as never,
      stop: recorded("session", "backgroundTasks.stop", async () => undefined) as never,
      await: recorded("session", "backgroundTasks.await") as never,
    };
    session.stopSubagent = recorded("session", "stopSubagent", async () => undefined) as Session["stopSubagent"];
    session.mcpApps = {
      listTools: recorded("session", "mcpApps.listTools", async (args) => [echo("mcpApps.listTools", args)]) as never,
      callTool: recorded("session", "mcpApps.callTool") as never,
      readResource: recorded("session", "mcpApps.readResource") as never,
    };
    session.contextWindow = recorded("session", "contextWindow", (args) => (args[0] === "unknown-model" ? undefined : 200_000 + (args[1] === undefined ? 0 : 1))) as Session["contextWindow"];
    session.canReuseContextUsage = recorded("session", "canReuseContextUsage", (args) => args[0] === args[1]) as Session["canReuseContextUsage"];
    session.uploadFeedback = recorded("session", "uploadFeedback") as Session["uploadFeedback"];
    session.ext = recorded("session", "ext") as Session["ext"];
    return session;
  };

  const createInstance = (instanceId: string): Instance => {
    const instance: Instance = {
      id: instanceId,
      continuationKey: "recording-continuation",
      bindingKey: "recording-binding",
      status: recorded("instance", "status", async () => ({ state: "ready", installed: true })) as Instance["status"],
      statusChanges: recorded("instance", "statusChanges", () =>
        (async function* () {
          yield { state: "starting", installed: true };
          yield { state: "ready", installed: true };
        })(),
      ) as Instance["statusChanges"],
      probe: recorded("instance", "probe") as Instance["probe"],
      catalog: { list: recorded("instance", "catalog.list") as Instance["catalog"]["list"] },
      openSession: recorded("instance", "openSession", async () => createSession(instanceId)) as Instance["openSession"],
      dispose: recorded("instance", "dispose", async () => {
        sequencer?.close();
      }) as Instance["dispose"],
    };
    if (!options.full) return instance;
    instance.invalidateCaches = recorded("instance", "invalidateCaches", async () => undefined) as Instance["invalidateCaches"];
    instance.maintenance = {
      advisory: recorded("instance", "maintenance.advisory", async () => null) as never,
      install: recorded("instance", "maintenance.install", async () => undefined) as never,
      update: recorded("instance", "maintenance.update", async () => undefined) as never,
    };
    instance.auth = {
      methods: recorded("instance", "auth.methods", () => RECORDING_AUTH_METHODS.map((method) => ({ ...method }))) as never,
      state: recorded("instance", "auth.state") as never,
      reportRuntimeFailure: recorded("instance", "auth.reportRuntimeFailure") as never,
      start: recorded("instance", "auth.start") as never,
      complete: recorded("instance", "auth.complete") as never,
      respond: recorded("instance", "auth.respond") as never,
      cancel: recorded("instance", "auth.cancel") as never,
      logout: recorded("instance", "auth.logout", async () => undefined) as never,
      transferProfile: recorded("instance", "auth.transferProfile") as never,
      transferSession: recorded("instance", "auth.transferSession", async (args) => echo("auth.transferSession", [args[0], (args[1] as Instance).id])) as never,
      credentialBinding: { owner: "host", key: "recording-credential" },
    };
    instance.catalog.refresh = recorded("instance", "catalog.refresh", async () => undefined) as never;
    instance.workspace = { snapshot: recorded("instance", "workspace.snapshot") as never };
    instance.limits = {
      current: recorded("instance", "limits.current") as never,
      accountKey: () => "account-key-1",
      consumeResetCredit: recorded("instance", "limits.consumeResetCredit") as never,
    };
    instance.usageHistory = {
      scan: recorded("instance", "usageHistory.scan", () =>
        (async function* () {
          yield { at: "2026-11-23T10:00:00.000Z", model: "model-a", inputTokens: 1 };
          yield { at: "2026-11-23T11:00:00.000Z", model: "model-a", inputTokens: 2 };
        })(),
      ) as never,
    };
    instance.textGeneration = { guarantees: { toolsDisabled: "native" }, generate: recorded("instance", "textGeneration.generate") as never };
    instance.nativeSessions = {
      list: recorded("instance", "nativeSessions.list") as never,
      delete: recorded("instance", "nativeSessions.delete", async () => undefined) as never,
      archive: recorded("instance", "nativeSessions.archive", async () => undefined) as never,
    };
    instance.subProviders = {
      list: recorded("instance", "subProviders.list", async (args) => [echo("subProviders.list", args)]) as never,
      set: recorded("instance", "subProviders.set", async () => undefined) as never,
      disable: recorded("instance", "subProviders.disable", async () => undefined) as never,
    };
    return instance;
  };

  const driver: Driver = {
    kind: "recording",
    ariVersion: ARI_VERSION,
    metadata: { displayName: "Recording", multipleInstances: true, hasDefaultInstance: false },
    configSchema: { type: "object", properties: { level: { type: "integer" } } },
    defaultConfig: () => ({ level: 7 }),
    cliManifest: { binary: "recording-agent", envScrubPrefixes: ["RECORDING_"], args: { fresh: [] } },
    async create(host, input) {
      hosts.set(input.instanceId, host);
      if (input.config !== undefined && (input.config as { failCreate?: boolean }).failCreate === true) throw callErrors.invalidState("create_refused", "refused on purpose");
      return createInstance(input.instanceId);
    },
  };

  return {
    driver,
    calls,
    capabilities,
    sequencer: () => {
      if (sequencer === undefined) throw new Error("no session is open");
      return sequencer;
    },
    setCanRelease: (value) => {
      canRelease = value;
    },
    host: (instanceId) => {
      const host = hosts.get(instanceId);
      if (host === undefined) throw new Error(`no instance ${instanceId} was created`);
      return host;
    },
  };
}
