// `AriError` lives in its own module with no runtime imports, because the
// validators throw it and the generated modules load the validators: keeping
// it apart avoids an import cycle between src/validation.ts and src/errors.ts.

import type { CallError } from "./generated/errors.ts";

/** The throwable form of a call error. `JSON.stringify` gives the call error itself. */
export class AriError extends Error {
  readonly code: CallError["code"];
  readonly callError: CallError;

  constructor(callError: CallError) {
    super(callError.message);
    this.name = "AriError";
    this.code = callError.code;
    this.callError = callError;
  }

  toJSON(): CallError {
    return this.callError;
  }
}
