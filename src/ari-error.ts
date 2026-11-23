// `AriError` is the throwable form of a call error. Its constructor keeps the
// call error's JSON wire form (what `JSON.stringify` sends, so fields set to
// `undefined` are left out) and checks that form against the `CallError`
// schema. Every AriError therefore serializes to data that `isCallError`, or
// any schema-based reader on the other side of `ari/wire`, accepts again.
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

  /**
   * Keeps the JSON wire form of `callError`. Throws a `TypeError` when that
   * form is not a valid call error, or when `callError` cannot be serialized.
   */
  constructor(callError: CallError) {
    let wireForm: CallError;
    try {
      wireForm = JSON.parse(JSON.stringify(callError)) as CallError;
    } catch (error) {
      throw new TypeError(`Invalid call error: it cannot be serialized as JSON (${(error as Error).message})`);
    }
    const result = CallErrorSchema["~standard"].validate(wireForm);
    if (!(result instanceof Promise) && result.issues !== undefined) {
      const first = result.issues[0];
      const where = first?.path !== undefined && first.path.length > 0 ? ` at ${first.path.map(String).join(".")}` : "";
      throw new TypeError(`Invalid call error${where}: ${first?.message ?? "invalid value"}`);
    }
    super(wireForm.message);
    this.name = "AriError";
    this.code = wireForm.code;
    this.callError = wireForm;
  }

  toJSON(): CallError {
    return this.callError;
  }
}
