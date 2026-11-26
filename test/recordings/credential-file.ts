// A sign-in an agent keeps in one file: the recorder copies the user's file
// into the recorded agent's own profile, and afterwards puts a copy the agent
// rewrote (a refreshed token) back where the user keeps it, so a rotated
// token is never lost. When it cannot go back (the user's file also changed
// meanwhile, or the recorder cannot write it), the refreshed content goes into
// the run's recovery file beside the user's file (./recovery.ts); when that
// fails too, the caller keeps the copy. The Antigravity recorder keeps its
// sign-in this way; the Claude recorder (./claude/record.ts) does the same
// with its own code.

import * as fs from "node:fs";
import * as path from "node:path";
import { CredentialsKeptError, CredentialsNotSavedError, keepRefreshedCredentials, recoveryFileFor } from "./recovery.ts";

export interface CopiedCredentialFile {
  /** The user's file. */
  readonly real: string;
  /** The recorded agent's copy. */
  readonly copy: string;
  /** The record id of the file in the recovery file. */
  readonly id: string;
  /** The content as copied. */
  readonly original: Buffer;
}

/** Copies the user's file `real` to `copy`, readable only by the user, in a directory only the user can enter. Undefined when the user has no such file. */
export function copyCredentialFile(real: string, copy: string, id: string): CopiedCredentialFile | undefined {
  if (!fs.existsSync(real)) return undefined;
  const original = fs.readFileSync(real);
  fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
  fs.writeFileSync(copy, original, { mode: 0o600 });
  fs.chmodSync(copy, 0o600);
  return { real, copy, id, original };
}

/**
 * Puts a copy the agent rewrote back over the user's file, unless the user's
 * file also changed while the recorder ran. A refreshed copy that cannot go
 * back is added to the recovery file beside the user's file, and this throws
 * a CredentialsKeptError naming it; when even that file cannot take it, a
 * CredentialsNotSavedError: the copy is then the only place the refreshed
 * sign-in is, and the caller must keep it. `agent` names the agent in the
 * messages. Any other error leaves the caller unsure whether the copy
 * changed, so it must keep the copy too.
 */
export function returnCredentialFile(credential: CopiedCredentialFile, agent: string): void {
  if (!fs.existsSync(credential.copy)) return;
  const now = fs.readFileSync(credential.copy);
  if (now.equals(credential.original)) return;
  const recoveryFile = recoveryFileFor(credential.real);
  /** Keeps the refreshed content in the recovery file, or throws CredentialsNotSavedError saying why it could not. */
  const keep = (why: string): never => {
    try {
      keepRefreshedCredentials(recoveryFile, [{ id: credential.id, value: now.toString("utf8") }]);
    } catch (error) {
      throw new CredentialsNotSavedError(
        `${why}, and the recorder could not keep the refreshed sign-in in ${recoveryFile} either (${error instanceof Error ? error.message : String(error)}). The refreshed sign-in is only in the recorder's copy, ${credential.copy}.`,
        credential.copy,
        recoveryFile,
      );
    }
    throw new CredentialsKeptError(`${why}; it kept the refreshed sign-in in ${recoveryFile}, readable only by you. Write its newest value over ${credential.real}, or sign in again.`, recoveryFile);
  };
  const staged = `${credential.real}.ari-recorder-${process.pid}`;
  try {
    const current = fs.existsSync(credential.real) ? fs.readFileSync(credential.real) : undefined;
    if (current === undefined || current.equals(credential.original)) {
      const mode = current === undefined ? 0o600 : fs.statSync(credential.real).mode & 0o777;
      fs.writeFileSync(staged, now, { mode });
      fs.renameSync(staged, credential.real);
      return;
    }
  } catch (error) {
    fs.rmSync(staged, { force: true });
    keep(`the recorder could not write the sign-in ${agent} refreshed back to ${credential.real} (${error instanceof Error ? error.message : String(error)})`);
  }
  keep(`${credential.real} changed while the recorder ran, and ${agent} also refreshed the recorder's copy; the recorder left ${credential.real} as it is`);
}
