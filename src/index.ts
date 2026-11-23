// The `ari` root export: the wire contract's types and validators, call
// errors, the patch and capability helpers, and the hand-written runtime
// interfaces. Browser-safe: nothing reachable from here imports a Node built-in.

export * from "./generated/common.ts";
export * from "./generated/errors.ts";
export * from "./generated/capabilities.ts";
export * from "./generated/config.ts";
export * from "./generated/thread.ts";
export * from "./generated/item.ts";
export * from "./generated/request.ts";
export * from "./generated/subagent.ts";
export * from "./generated/plan.ts";
export * from "./generated/background.ts";
export * from "./generated/usage.ts";
export * from "./generated/events.ts";
export * from "./generated/session.ts";
export * from "./generated/instance.ts";
export * from "./generated/driver.ts";
export * from "./generated/host.ts";
export * from "./generated/handshake.ts";
export * from "./generated/rpc.ts";
export * from "./generated/method-table.ts";
export * from "./generated/extensions/ari.goal.ts";

export { createValidator } from "./validation.ts";
export type { SchemaDocument, SchemaNode, Validator, ValidationIssue as ValidatorIssue } from "./validation.ts";
export type { StandardJSONSchemaV1, StandardSchemaV1, StandardTypedV1 } from "./standard-schema.ts";

export {
  AriError,
  CALL_ERROR_CODES,
  FAILURE_CLASSES,
  callErrors,
  isAriError,
  isCallError,
  isFailure,
  toCallError,
} from "./errors.ts";
export type { CallErrorOf, KnownCallErrorCode, KnownFailureClass } from "./errors.ts";

export { applyPatch } from "./patch.ts";
export type { Patch } from "./patch.ts";

export { capabilityValue, hasCapability, requireCapability } from "./capabilities.ts";

export { ARI_VERSION, GRAMMAR_VERSIONS, PERSISTENCE_VERSION } from "./version.ts";

export type {
  ConfigReading,
  CreateInstanceRequest,
  Driver,
  HostServices,
  Instance,
  Session,
  SpawnedProcess,
} from "./runtime.ts";
