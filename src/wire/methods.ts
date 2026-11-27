// The wire methods this package speaks, one entry per method in
// spec/v1/methods.json: its direction, whether it is a request or a
// notification, its `{ major, minor }` version and the validator for its
// params. test/wire/methods.test.ts keeps this table equal to methods.json, so
// a method added there fails the test until both ends of the wire serve it.
//
// It also lists the optional members (`?` in the TypeScript interfaces) of
// `Instance`, `Session` and `HostServices`. Over the wire an object tells the
// other end which of them it has (`InstanceDescriptor.members`,
// `SessionDescriptor.members`, `DriverCreateParams.hostMembers`), and the
// other end builds an object with exactly those.

import type { Version } from "../generated/common.ts";
import { InitializeParamsSchema } from "../generated/handshake.ts";
import {
  ConfigChangedParamsSchema,
  DriverCreateParamsSchema,
  EmptyParamsSchema,
  EventNotificationParamsSchema,
  HostAttachmentParamsSchema,
  HostBackgroundShouldRunParamsSchema,
  HostCallDynamicToolParamsSchema,
  HostCallbacksRegisterParamsSchema,
  HostConfigGetParamsSchema,
  HostCoordinationAcquireParamsSchema,
  HostCoordinationReleaseParamsSchema,
  HostDiagnosticsLogParamsSchema,
  HostIdsDeriveParamsSchema,
  HostMcpServerForParamsSchema,
  HostProcessExitParamsSchema,
  HostProcessKillParamsSchema,
  HostProcessOutputParamsSchema,
  HostProcessResolveExecutableParamsSchema,
  HostProcessSpawnParamsSchema,
  HostProcessTargetSchema,
  HostProcessWriteParamsSchema,
  HostSecretParamsSchema,
  HostSecretsSetParamsSchema,
  HostTelemetryTrackParamsSchema,
  InstanceAuthCancelParamsSchema,
  InstanceAuthCompleteParamsSchema,
  InstanceAuthReportRuntimeFailureParamsSchema,
  InstanceAuthRespondParamsSchema,
  InstanceAuthStartParamsSchema,
  InstanceAuthTransferProfileParamsSchema,
  InstanceAuthTransferSessionParamsSchema,
  InstanceCatalogListParamsSchema,
  InstanceConsumeResetCreditParamsSchema,
  InstanceNativeSessionParamsSchema,
  InstanceNativeSessionsListParamsSchema,
  InstanceOpenSessionParamsSchema,
  InstanceProbeParamsSchema,
  InstanceSubProvidersDisableParamsSchema,
  InstanceSubProvidersListParamsSchema,
  InstanceSubProvidersSetParamsSchema,
  InstanceTargetSchema,
  InstanceTextGenerationParamsSchema,
  InstanceUsageHistoryScanParamsSchema,
  InstanceWorkspaceSnapshotParamsSchema,
  SessionBackgroundTasksAwaitParamsSchema,
  SessionBackgroundTasksListParamsSchema,
  SessionBackgroundTasksStopParamsSchema,
  SessionCanReuseContextUsageParamsSchema,
  SessionContextWindowParamsSchema,
  SessionCreateThreadParamsSchema,
  SessionEventsParamsSchema,
  SessionExtParamsSchema,
  SessionForkThreadParamsSchema,
  SessionInjectHistoryParamsSchema,
  SessionInterruptTurnParamsSchema,
  SessionMcpAppsCallToolParamsSchema,
  SessionMcpAppsReadResourceParamsSchema,
  SessionMcpServerTargetSchema,
  SessionPlanConfigChangeParamsSchema,
  SessionRespondParamsSchema,
  SessionResumeThreadParamsSchema,
  SessionRollbackThreadParamsSchema,
  SessionStartTurnParamsSchema,
  SessionStopSubagentParamsSchema,
  SessionTargetSchema,
  SessionThreadTargetSchema,
  SessionUploadFeedbackParamsSchema,
  StatusChangedParamsSchema,
  StreamCancelParamsSchema,
  StreamEndParamsSchema,
  UsageRecordParamsSchema,
} from "../generated/rpc.ts";
import type { Validator } from "../validation.ts";

export type WireDirection = "host_to_driver" | "driver_to_host" | "both";

export interface WireMethod {
  readonly name: string;
  readonly direction: WireDirection;
  readonly kind: "request" | "notification";
  readonly version: Version;
  readonly params: Validator<unknown>;
}

const V1_0: Version = { major: 1, minor: 0 };

function request(name: string, direction: WireDirection, params: Validator<unknown>, version: Version = V1_0): WireMethod {
  return { name, direction, kind: "request", version, params };
}

function notification(name: string, direction: WireDirection, params: Validator<unknown>, version: Version = V1_0): WireMethod {
  return { name, direction, kind: "notification", version, params };
}

const HOST = "host_to_driver";
const DRIVER = "driver_to_host";

/** Every method of spec/v1/methods.json, in its order. */
export const WIRE_METHODS: readonly WireMethod[] = [
  request("initialize", HOST, InitializeParamsSchema),
  notification("stream/end", "both", StreamEndParamsSchema),
  request("stream/cancel", "both", StreamCancelParamsSchema),
  request("driver/defaultConfig", HOST, EmptyParamsSchema),
  request("driver/create", HOST, DriverCreateParamsSchema),
  request("instance/status", HOST, InstanceTargetSchema),
  request("instance/statusChanges", HOST, InstanceTargetSchema),
  request("instance/probe", HOST, InstanceProbeParamsSchema),
  request("instance/invalidateCaches", HOST, InstanceTargetSchema),
  request("instance/maintenance.advisory", HOST, InstanceTargetSchema),
  request("instance/auth.methods", HOST, InstanceTargetSchema),
  request("instance/auth.state", HOST, InstanceTargetSchema),
  request("instance/auth.reportRuntimeFailure", HOST, InstanceAuthReportRuntimeFailureParamsSchema),
  request("instance/auth.start", HOST, InstanceAuthStartParamsSchema),
  request("instance/auth.complete", HOST, InstanceAuthCompleteParamsSchema),
  request("instance/auth.respond", HOST, InstanceAuthRespondParamsSchema),
  request("instance/auth.cancel", HOST, InstanceAuthCancelParamsSchema),
  request("instance/auth.logout", HOST, InstanceTargetSchema),
  request("instance/auth.transferProfile", HOST, InstanceAuthTransferProfileParamsSchema),
  request("instance/auth.transferSession", HOST, InstanceAuthTransferSessionParamsSchema),
  request("instance/catalog.list", HOST, InstanceCatalogListParamsSchema),
  request("instance/catalog.refresh", HOST, InstanceTargetSchema),
  request("instance/workspace.snapshot", HOST, InstanceWorkspaceSnapshotParamsSchema),
  request("instance/limits.current", HOST, InstanceTargetSchema),
  request("instance/limits.accountKey", HOST, InstanceTargetSchema),
  request("instance/limits.consumeResetCredit", HOST, InstanceConsumeResetCreditParamsSchema),
  request("instance/usageHistory.scan", HOST, InstanceUsageHistoryScanParamsSchema),
  request("instance/textGeneration.generate", HOST, InstanceTextGenerationParamsSchema),
  request("instance/nativeSessions.list", HOST, InstanceNativeSessionsListParamsSchema),
  request("instance/nativeSessions.delete", HOST, InstanceNativeSessionParamsSchema),
  request("instance/nativeSessions.archive", HOST, InstanceNativeSessionParamsSchema),
  request("instance/subProviders.list", HOST, InstanceSubProvidersListParamsSchema),
  request("instance/subProviders.set", HOST, InstanceSubProvidersSetParamsSchema),
  request("instance/subProviders.disable", HOST, InstanceSubProvidersDisableParamsSchema),
  request("instance/openSession", HOST, InstanceOpenSessionParamsSchema),
  request("instance/dispose", HOST, InstanceTargetSchema),
  notification("instance/statusChanged", DRIVER, StatusChangedParamsSchema),
  notification("instance/usageRecord", DRIVER, UsageRecordParamsSchema),
  request("session/capabilities", HOST, SessionTargetSchema),
  request("session/events", HOST, SessionEventsParamsSchema),
  request("session/createThread", HOST, SessionCreateThreadParamsSchema),
  request("session/resumeThread", HOST, SessionResumeThreadParamsSchema),
  request("session/readSnapshot", HOST, SessionThreadTargetSchema),
  request("session/forkThread", HOST, SessionForkThreadParamsSchema),
  request("session/rollbackThread", HOST, SessionRollbackThreadParamsSchema),
  request("session/compactThread", HOST, SessionThreadTargetSchema),
  request("session/injectHistory", HOST, SessionInjectHistoryParamsSchema),
  request("session/unloadThread", HOST, SessionThreadTargetSchema),
  request("session/canRelease", HOST, SessionTargetSchema),
  request("session/release", HOST, SessionTargetSchema),
  request("session/startTurn", HOST, SessionStartTurnParamsSchema),
  request("session/interruptTurn", HOST, SessionInterruptTurnParamsSchema),
  request("session/respond", HOST, SessionRespondParamsSchema),
  request("session/backgroundTasks.list", HOST, SessionBackgroundTasksListParamsSchema),
  request("session/backgroundTasks.stop", HOST, SessionBackgroundTasksStopParamsSchema),
  request("session/backgroundTasks.await", HOST, SessionBackgroundTasksAwaitParamsSchema),
  request("session/stopSubagent", HOST, SessionStopSubagentParamsSchema),
  request("session/mcpApps.listTools", HOST, SessionMcpServerTargetSchema),
  request("session/mcpApps.callTool", HOST, SessionMcpAppsCallToolParamsSchema),
  request("session/mcpApps.readResource", HOST, SessionMcpAppsReadResourceParamsSchema),
  request("session/planConfigChange", HOST, SessionPlanConfigChangeParamsSchema),
  request("session/contextWindow", HOST, SessionContextWindowParamsSchema),
  request("session/canReuseContextUsage", HOST, SessionCanReuseContextUsageParamsSchema),
  request("session/uploadFeedback", HOST, SessionUploadFeedbackParamsSchema),
  request("session/ext", HOST, SessionExtParamsSchema),
  request("session/close", HOST, SessionTargetSchema),
  notification("ari/event", DRIVER, EventNotificationParamsSchema),
  request("host/config.get", DRIVER, HostConfigGetParamsSchema),
  request("host/secrets.get", DRIVER, HostSecretParamsSchema),
  request("host/secrets.set", DRIVER, HostSecretsSetParamsSchema),
  request("host/secrets.delete", DRIVER, HostSecretParamsSchema),
  request("host/process.spawn", DRIVER, HostProcessSpawnParamsSchema),
  request("host/process.resolveExecutable", DRIVER, HostProcessResolveExecutableParamsSchema),
  request("host/attachments.resolve", DRIVER, HostAttachmentParamsSchema),
  request("host/attachments.extractText", DRIVER, HostAttachmentParamsSchema),
  request("host/callbacks.register", DRIVER, HostCallbacksRegisterParamsSchema),
  request("host/hostTools.mcpServerFor", DRIVER, HostMcpServerForParamsSchema),
  request("host/hostTools.callDynamicTool", DRIVER, HostCallDynamicToolParamsSchema),
  request("host/background.shouldRun", DRIVER, HostBackgroundShouldRunParamsSchema),
  request("host/coordination.acquire", DRIVER, HostCoordinationAcquireParamsSchema),
  request("host/coordination.release", DRIVER, HostCoordinationReleaseParamsSchema),
  request("host/diagnostics.log", DRIVER, HostDiagnosticsLogParamsSchema),
  request("host/telemetry.track", DRIVER, HostTelemetryTrackParamsSchema),
  request("host/ids.derive", DRIVER, HostIdsDeriveParamsSchema),
  notification("host/config.changed", HOST, ConfigChangedParamsSchema),
  request("host/process.write", DRIVER, HostProcessWriteParamsSchema),
  request("host/process.closeStdin", DRIVER, HostProcessTargetSchema),
  request("host/process.kill", DRIVER, HostProcessKillParamsSchema),
  notification("host/process.output", HOST, HostProcessOutputParamsSchema),
  notification("host/process.exit", HOST, HostProcessExitParamsSchema),
];

const BY_NAME = new Map(WIRE_METHODS.map((method) => [method.name, method]));

export function wireMethod(name: string): WireMethod | undefined {
  return BY_NAME.get(name);
}

/** This package's version of every wire method, as `initialize` sends it. */
export function defaultMethodVersions(): { [method: string]: Version } {
  const versions: { [method: string]: Version } = {};
  for (const method of WIRE_METHODS) versions[method.name] = { ...method.version };
  return versions;
}

/** Notifications that carry one item of a stream, and the params field that holds it. */
export const STREAM_ITEM_NOTIFICATIONS: { readonly [method: string]: string } = {
  "ari/event": "event",
  "instance/statusChanged": "status",
  "instance/usageRecord": "record",
  "host/config.changed": "config",
};

/**
 * Methods that only work together with others: a stream's item notification,
 * and the helpers of a delegated child. The handshake refuses a method when
 * one of its helpers is refused, so a stream or a child never hangs halfway.
 */
export const METHOD_HELPERS: { readonly [method: string]: readonly string[] } = {
  "session/events": ["ari/event"],
  "instance/statusChanges": ["instance/statusChanged"],
  "instance/usageHistory.scan": ["instance/usageRecord"],
  "host/config.get": ["host/config.changed"],
  "host/process.spawn": ["host/process.output", "host/process.exit", "host/process.write", "host/process.closeStdin", "host/process.kill"],
};

/** The optional `Instance` members, by dotted path. */
export const OPTIONAL_INSTANCE_MEMBERS = [
  "invalidateCaches",
  "maintenance.advisory",
  "auth.methods",
  "auth.state",
  "auth.reportRuntimeFailure",
  "auth.start",
  "auth.complete",
  "auth.respond",
  "auth.cancel",
  "auth.logout",
  "auth.transferProfile",
  "auth.transferSession",
  "catalog.refresh",
  "workspace.snapshot",
  "limits.current",
  "limits.accountKey",
  "limits.consumeResetCredit",
  "usageHistory.scan",
  "textGeneration.generate",
  "nativeSessions.list",
  "nativeSessions.delete",
  "nativeSessions.archive",
  "subProviders.list",
  "subProviders.set",
  "subProviders.disable",
] as const;

/** The optional `Session` members, by dotted path, with the capability path that gates each. */
export const OPTIONAL_SESSION_MEMBERS = {
  readSnapshot: "threads.readSnapshot",
  forkThread: "threads.fork",
  rollbackThread: "threads.rollback",
  compactThread: "threads.compact",
  injectHistory: "threads.injectHistory",
  unloadThread: "threads.unload",
  "backgroundTasks.list": "background.list",
  "backgroundTasks.stop": "background.stop",
  "backgroundTasks.await": "background.await",
  stopSubagent: "subagents.stop",
  "mcpApps.listTools": "tools.mcpApps",
  "mcpApps.callTool": "tools.mcpApps",
  "mcpApps.readResource": "tools.mcpApps",
  contextWindow: "contextWindowReporting",
  canReuseContextUsage: "sessions.contextUsageReuse",
  uploadFeedback: "sessions.feedbackUpload",
  ext: "extensions",
} as const;

/** The optional `HostServices` members, by dotted path. */
export const OPTIONAL_HOST_MEMBERS = ["attachments.extractText", "hostTools.callDynamicTool", "telemetry.track", "ids.derive"] as const;

/** The function at dotted `path` of `target`, if there is one. */
export function memberAt(target: unknown, path: string): ((...args: unknown[]) => unknown) | undefined {
  const segments = path.split(".");
  let owner: unknown = target;
  for (const segment of segments.slice(0, -1)) {
    if (typeof owner !== "object" || owner === null) return undefined;
    owner = (owner as { [key: string]: unknown })[segment];
  }
  if (typeof owner !== "object" || owner === null) return undefined;
  const member = (owner as { [key: string]: unknown })[segments[segments.length - 1]!];
  return typeof member === "function" ? (member as (...args: unknown[]) => unknown) : undefined;
}

/** The dotted paths of `paths` at which `target` has a function. */
export function presentMembers(target: unknown, paths: readonly string[]): string[] {
  return paths.filter((path) => memberAt(target, path) !== undefined);
}
