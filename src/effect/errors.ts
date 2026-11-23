// Tagged errors for ARI's call errors (proposal §12 and §16). A call that
// rejects with an `AriError`, or with call error data that crossed `ari/wire`,
// fails in Effect's error channel with the tagged error of its code, so Effect
// users can recover with `Effect.catchTag("UnsupportedError", ...)`. Each
// tagged error carries the call error's fields (`error.capability`) and the
// call error itself (`error.callError`), which `toAriError` turns back into a
// throwable `AriError` for code that must reject the plain way.
//
// There is one class for each of the eleven codes, plus `ExtensionCallError`
// for the `x:` codes extensions define. A rejection that is not a call error
// at all breaks the ARI contract, so the services in this subpath treat it as
// a defect (`Effect.die`), not as a typed failure.

import { AriError } from "../ari-error.ts";
import { isCallError, toCallError as callErrorFromUnknown } from "../errors.ts";
import type { CallErrorOf, KnownCallErrorCode } from "../errors.ts";
import type { CallError, ExtensionCallError as ExtensionCallErrorData } from "../generated/errors.ts";
import { ExtensionCallErrorSchema } from "../generated/errors.ts";
import { Data } from "./effect-modules.ts";

/** The fields of a tagged error: the call error's own fields, plus the call error itself. */
export type TaggedErrorFields<Data> = Data & { readonly callError: Data };

export class UnsupportedError extends Data.TaggedError("UnsupportedError")<TaggedErrorFields<CallErrorOf<"unsupported">>> {}
export class InvalidStateError extends Data.TaggedError("InvalidStateError")<TaggedErrorFields<CallErrorOf<"invalid_state">>> {}
export class NotFoundError extends Data.TaggedError("NotFoundError")<TaggedErrorFields<CallErrorOf<"not_found">>> {}
export class AuthRequiredError extends Data.TaggedError("AuthRequiredError")<TaggedErrorFields<CallErrorOf<"auth_required">>> {}
export class UsageLimitError extends Data.TaggedError("UsageLimitError")<TaggedErrorFields<CallErrorOf<"usage_limit">>> {}
export class PermissionDeniedError extends Data.TaggedError("PermissionDeniedError")<
  TaggedErrorFields<CallErrorOf<"permission_denied">>
> {}
export class TransportError extends Data.TaggedError("TransportError")<TaggedErrorFields<CallErrorOf<"transport">>> {}
export class ProtocolError extends Data.TaggedError("ProtocolError")<TaggedErrorFields<CallErrorOf<"protocol">>> {}
export class ValidationError extends Data.TaggedError("ValidationError")<TaggedErrorFields<CallErrorOf<"validation">>> {}
export class AttachmentUnreadableError extends Data.TaggedError("AttachmentUnreadableError")<
  TaggedErrorFields<CallErrorOf<"attachment_unreadable">>
> {}
/**
 * The fields of `DriverUnavailableError`. Its call error type says "at least
 * one of `package` and `binary`" with a union, and a class cannot extend a
 * union, so the fields are listed here with both optional; `callError` keeps
 * the exact type.
 */
export interface DriverUnavailableFields {
  readonly code: "driver_unavailable";
  readonly message: string;
  readonly retryable?: boolean;
  readonly package?: string;
  readonly binary?: string;
  readonly installHint?: string;
  readonly callError: CallErrorOf<"driver_unavailable">;
}
export class DriverUnavailableError extends Data.TaggedError("DriverUnavailableError")<DriverUnavailableFields> {}
/** A call error with an `x:` code defined by an extension. */
export class ExtensionCallError extends Data.TaggedError("ExtensionCallError")<TaggedErrorFields<ExtensionCallErrorData>> {}

/** The tagged error class for each of the eleven call error codes. */
export const TAGGED_CALL_ERRORS = {
  unsupported: UnsupportedError,
  invalid_state: InvalidStateError,
  not_found: NotFoundError,
  auth_required: AuthRequiredError,
  usage_limit: UsageLimitError,
  permission_denied: PermissionDeniedError,
  transport: TransportError,
  protocol: ProtocolError,
  validation: ValidationError,
  attachment_unreadable: AttachmentUnreadableError,
  driver_unavailable: DriverUnavailableError,
} as const;

/** The tagged error for one known call error code. */
export type TaggedCallErrorOf<Code extends KnownCallErrorCode> = InstanceType<(typeof TAGGED_CALL_ERRORS)[Code]>;

/** Every failure an `ari/effect` call can put in Effect's error channel. */
export type AriCallError =
  | UnsupportedError
  | InvalidStateError
  | NotFoundError
  | AuthRequiredError
  | UsageLimitError
  | PermissionDeniedError
  | TransportError
  | ProtocolError
  | ValidationError
  | AttachmentUnreadableError
  | DriverUnavailableError
  | ExtensionCallError;

function tagged<Data extends CallError>(ErrorClass: new (fields: TaggedErrorFields<Data>) => AriCallError, callError: Data): AriCallError {
  return new ErrorClass({ ...callError, callError });
}

/**
 * The tagged error for a call error: an `AriError`, or call error data such as
 * an error that crossed `ari/wire`. Undefined for anything else.
 */
export function toTaggedError(error: unknown): AriCallError | undefined {
  const callError = callErrorFromUnknown(error) ?? (ExtensionCallErrorSchema.is(error) ? error : undefined);
  if (callError === undefined) return undefined;
  if (isCallError(callError)) {
    const ErrorClass = TAGGED_CALL_ERRORS[callError.code] as new (fields: TaggedErrorFields<typeof callError>) => AriCallError;
    return tagged(ErrorClass, callError);
  }
  if (ExtensionCallErrorSchema.is(callError)) return tagged(ExtensionCallError, callError);
  return undefined;
}

/** The throwable `AriError` for a tagged error, for code that must reject the plain way. */
export function toAriError(error: AriCallError): AriError {
  return new AriError(error.callError);
}
