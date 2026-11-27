// The rule every driver that runs a vendor's CLI follows: ARI runs the CLI the
// user installed and never downloads, installs or updates one. A CLI older
// than the lowest version the driver is tested against (the lower bound of
// its tested range) is refused: `status()` reports `driver_unavailable` and
// `openSession` rejects with it before any agent starts. The error names the
// version found, where the CLI is, the minimum and the vendor's own update
// step. A CLI above the tested range still runs, with an advisory.

import { AriError } from "../ari-error.ts";

export interface CliTooOldInput {
  /** The CLI as people know it, such as `Codex CLI`. */
  readonly name: string;
  /** The executable the driver's config names. */
  readonly binary: string;
  /** The version the CLI reported. */
  readonly version: string;
  /** Where the CLI is: the path it resolved to, or the URL of a server the driver connects to. */
  readonly path: string;
  /** The lower bound of the driver's tested range. */
  readonly minimum: string;
  /** The vendor's documented update step, as a sentence. */
  readonly updateStep: string;
}

/** `driver_unavailable` for a CLI older than the driver's minimum. It keeps the version found, so `status()` can still report it. */
export class CliTooOldError extends AriError {
  readonly version: string;

  constructor(input: CliTooOldInput) {
    super({
      code: "driver_unavailable",
      binary: input.binary,
      installHint: input.updateStep,
      message: `${input.name} ${input.version} (${input.path}) is older than ${input.minimum}, the oldest version this driver supports. ${input.updateStep}`,
    });
    this.version = input.version;
  }
}
