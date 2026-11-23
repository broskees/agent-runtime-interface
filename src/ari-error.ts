// `AriError` is the throwable form of a call error. Its constructor checks the
// call error against the `CallError` schema, so every AriError serializes to
// data that `isCallError` (or any schema-based reader on the other side of
// `ari/wire`) accepts again.
//
// Import cycle: src/validation.ts throws AriError from `parse`, and this module
// uses a generated validator, which src/validation.ts creates. The cycle is
// safe because neither side touches the other at module load time: generated
// modules call `createValidator`, which reads no module-level state of
// src/validation.ts, and AriError reads `CallErrorSchema` only when an error is
// constructed. test/module-order.test.ts loads each module first to keep it so.

import { CallErrorSchema } from "./generated/errors.ts";
import type { CallError } from "./generated/errors.ts";

/** The throwable form of a call error. `JSON.stringify` gives the call error itself. */
export class AriError extends Error {
  readonly code: CallError["code"];
  readonly callError: CallError;

  /** Throws a `TypeError` when `callError` is not a valid call error. */
  constructor(callError: CallError) {
    const result = CallErrorSchema["~standard"].validate(callError);
    if (!(result instanceof Promise) && result.issues !== undefined) {
      const first = result.issues[0];
      const where = first?.path !== undefined && first.path.length > 0 ? ` at ${first.path.map(String).join(".")}` : "";
      throw new TypeError(`Invalid call error${where}: ${first?.message ?? "invalid value"}`);
    }
    super(callError.message);
    this.name = "AriError";
    this.code = callError.code;
    this.callError = callError;
  }

  toJSON(): CallError {
    return this.callError;
  }
}
