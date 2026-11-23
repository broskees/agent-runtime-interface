// `ari/effect`: Effect bindings for ARI (proposal §16 and §17.3).
//
// - Effect services for `Driver`, `Instance`, `Session` and `HostServices`
//   (`AriDriver`, `AriInstance`, `AriSession`, `AriHostServices`), with
//   `toEffect*` converters and layers. Session events are a `Stream`.
// - Tagged errors for the eleven call error codes, plus `ExtensionCallError`
//   for `x:` codes, in the error channel of every call.
// - Effect schemas generated from spec/v1, one `<Name>Schema` per definition,
//   with the same names as the zero-dependency validators of the root export.
//   They accept the same values, keep unknown fields, and decode to the wire
//   types of `ari`.
//
// This is the only subpath that loads `effect`, an optional peer dependency
// (`^4.0.0`). Importing it without `effect` installed fails with an error that
// names the package; no other subpath imports this one.

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

export {
  AttachmentUnreadableError,
  AuthRequiredError,
  DriverUnavailableError,
  ExtensionCallError,
  InvalidStateError,
  NotFoundError,
  PermissionDeniedError,
  ProtocolError,
  TAGGED_CALL_ERRORS,
  TransportError,
  UnsupportedError,
  UsageLimitError,
  ValidationError,
  toAriError,
  toTaggedError,
} from "./errors.ts";
export type { AriCallError, DriverUnavailableFields, TaggedCallErrorOf, TaggedErrorFields } from "./errors.ts";

export {
  AriDriver,
  AriHostServices,
  AriInstance,
  AriSession,
  toEffectDriver,
  toEffectHostServices,
  toEffectInstance,
  toEffectSession,
} from "./services.ts";
export type {
  AriEffect,
  AriStream,
  EffectDriver,
  EffectHostServices,
  EffectInstance,
  EffectSession,
  EffectSpawnedProcess,
} from "./services.ts";
