// Call errors and turn failures (proposal §12). A call error is plain JSON
// data, so it survives `JSON.stringify` and `JSON.parse` and can travel over
// `ari/wire` unchanged. `AriError` is the throwable wrapper: it serializes to
// its call error, and `toCallError` turns either form back into data.

import { AriError } from "./ari-error.ts";
import {
  AttachmentUnreadableErrorSchema,
  AuthRequiredErrorSchema,
  DriverUnavailableErrorSchema,
  FailureSchema,
  InvalidStateErrorSchema,
  NotFoundErrorSchema,
  PermissionDeniedErrorSchema,
  ProtocolErrorSchema,
  TransportErrorSchema,
  UnsupportedErrorSchema,
  UsageLimitErrorSchema,
  ValidationErrorSchema,
} from "./generated/errors.ts";
import type { CallError, Failure, ValidationIssue } from "./generated/errors.ts";
import type { AuthMethod } from "./generated/instance.ts";
import type { Validator } from "./validation.ts";

export { AriError };

/** The eleven call error codes. */
export const CALL_ERROR_CODES = [
  "unsupported",
  "invalid_state",
  "not_found",
  "auth_required",
  "usage_limit",
  "permission_denied",
  "transport",
  "protocol",
  "validation",
  "attachment_unreadable",
  "driver_unavailable",
] as const;

export type KnownCallErrorCode = (typeof CALL_ERROR_CODES)[number];

/** The call error with a given known code, with that code's payload. */
export type CallErrorOf<Code extends KnownCallErrorCode> = Extract<CallError, { code: Code }>;

/** The six turn failure classes. */
export const FAILURE_CLASSES = [
  "usage_limit",
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
] as const;

export type KnownFailureClass = (typeof FAILURE_CLASSES)[number];

const CALL_ERROR_VALIDATORS: { readonly [Code in KnownCallErrorCode]: Validator<CallErrorOf<Code>> } = {
  unsupported: UnsupportedErrorSchema,
  invalid_state: InvalidStateErrorSchema,
  not_found: NotFoundErrorSchema,
  auth_required: AuthRequiredErrorSchema,
  usage_limit: UsageLimitErrorSchema,
  permission_denied: PermissionDeniedErrorSchema,
  transport: TransportErrorSchema,
  protocol: ProtocolErrorSchema,
  validation: ValidationErrorSchema,
  attachment_unreadable: AttachmentUnreadableErrorSchema,
  driver_unavailable: DriverUnavailableErrorSchema,
};

function isKnownCallErrorCode(code: unknown): code is KnownCallErrorCode {
  return typeof code === "string" && (CALL_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * True when `value` is a call error with one of the eleven known codes and a
 * valid payload for that code. Pass `code` to check for one code. Works on
 * plain data, including data that went through `JSON.stringify` and
 * `JSON.parse`. For a thrown `AriError`, use `isAriError` or `toCallError`.
 */
export function isCallError(value: unknown): value is CallErrorOf<KnownCallErrorCode>;
export function isCallError<Code extends KnownCallErrorCode>(value: unknown, code: Code): value is CallErrorOf<Code>;
export function isCallError(value: unknown, code?: KnownCallErrorCode): boolean {
  if (typeof value !== "object" || value === null) return false;
  const actual = (value as { code?: unknown }).code;
  if (!isKnownCallErrorCode(actual)) return false;
  if (code !== undefined && actual !== code) return false;
  return CALL_ERROR_VALIDATORS[actual].is(value);
}


/** True when `value` is an `AriError`, optionally with a given code. */
export function isAriError(value: unknown, code?: KnownCallErrorCode): value is AriError {
  if (!(value instanceof AriError)) return false;
  return code === undefined || value.code === code;
}

/** The call error carried by an `AriError` or given as data; undefined for anything else. */
export function toCallError(value: unknown): CallError | undefined {
  if (value instanceof AriError) return value.callError;
  if (isCallError(value)) return value;
  return undefined;
}

/** Builders for the eleven call errors. Each returns a throwable `AriError`. */
export const callErrors = {
  unsupported(capability: string, message = `Not supported: ${capability}`): AriError {
    return new AriError({ code: "unsupported", message, capability });
  },
  invalidState(reason: string, message = `Invalid state: ${reason}`): AriError {
    return new AriError({ code: "invalid_state", message, reason });
  },
  notFound(details: { resource?: string; id?: string; message?: string } = {}): AriError {
    const { message, ...rest } = details;
    const what = [details.resource, details.id].filter((part) => part !== undefined).join(" ");
    return new AriError({ code: "not_found", message: message ?? `Not found${what === "" ? "" : `: ${what}`}`, ...rest });
  },
  authRequired(methods: AuthMethod[], message = "Sign-in required"): AriError {
    return new AriError({ code: "auth_required", message, methods });
  },
  usageLimit(resetAt: string | null, message = "Usage limit reached"): AriError {
    return new AriError({ code: "usage_limit", message, resetAt });
  },
  permissionDenied(message = "Permission denied"): AriError {
    return new AriError({ code: "permission_denied", message });
  },
  transport(message = "Transport failed"): AriError {
    return new AriError({ code: "transport", message });
  },
  protocol(detail: string, message = `Protocol error: ${detail}`): AriError {
    return new AriError({ code: "protocol", message, detail });
  },
  validation(issues: ValidationIssue[] = [], message = "Validation failed"): AriError {
    return new AriError({ code: "validation", message, issues });
  },
  attachmentUnreadable(attachmentRef?: string, message = "Attachment unreadable"): AriError {
    return new AriError({
      code: "attachment_unreadable",
      message,
      ...(attachmentRef === undefined ? {} : { attachmentRef }),
    });
  },
  driverUnavailable(
    missing: { package: string; binary?: string; installHint?: string } | { package?: string; binary: string; installHint?: string },
    message = `Driver unavailable: install ${missing.package ?? missing.binary}`,
  ): AriError {
    return new AriError({ code: "driver_unavailable", message, ...missing });
  },
};

/** True when `value` is a valid turn or session failure. */
export function isFailure(value: unknown): value is Failure {
  return FailureSchema.is(value);
}
