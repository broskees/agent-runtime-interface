// A sign-in an agent keeps in one file: the recorder copies the user's file
// into the recorded agent's own profile, and afterwards puts a copy the agent
// rewrote (a refreshed token) back where the user keeps it, so a rotated
// token is never lost. When it cannot go back (the user's file also changed
// meanwhile, or the recorder cannot write it), the refreshed content goes into
// the run's recovery file beside the user's file (./recovery.ts); when that
// fails too, the caller keeps the copy. The Antigravity and Claude recorders
// (./antigravity/record.ts, ./claude/record.ts) keep their sign-ins this way.
//
// An agent may guard its own writes of the file with a lock (Claude Code
// does: ./claude/record.ts, `claudeCredentialLock`). Then the recorder takes
// the same lock to compare the user's file and replace it, so another session
// of the agent cannot save a refresh between the two; without the lock, such
// a save is overwritten. The Antigravity recorder, whose agent documents no
// such lock, holds a lock of its own around this copy-back instead, so two
// recorder runs cannot overwrite each other's refresh
// (./antigravity/record.ts, `returnAntigravitySignIn`). docs/recordings.md
// says what window remains.

import * as fs from "node:fs";
import * as path from "node:path";
import { CredentialsKeptError, CredentialsNotSavedError, keepRefreshedCredentials, recoveryFileFor } from "./recovery.ts";

/**
 * A lock the agent itself takes around each write of its credential file, as
 * proper-lockfile takes one: it creates `directory` with mkdir (which fails
 * while another holder has it) and removes it when done.
 */
export interface CredentialWriteLock {
  readonly directory: string;
  /**
   * How long the recorder waits for another holder to let go. Then it does
   * not write: the refreshed sign-in goes to the recovery file. The recorder
   * never breaks the agent's lock, even one that looks abandoned.
   */
  readonly waitMs: number;
}

export interface CopiedCredentialFile {
  /** The user's file. */
  readonly real: string;
  /** The recorded agent's copy. */
  readonly copy: string;
  /** The record id of the file in the recovery file. */
  readonly id: string;
  /** The content as copied. */
  readonly original: Buffer;
  /** The agent's own lock around writes of `real`, when it has one. */
  readonly lock?: CredentialWriteLock;
}

/** Copies the user's file `real` to `copy`, readable only by the user, in a directory only the user can enter. Undefined when the user has no such file. */
export function copyCredentialFile(real: string, copy: string, id: string, lock?: CredentialWriteLock): CopiedCredentialFile | undefined {
  if (!fs.existsSync(real)) return undefined;
  const original = fs.readFileSync(real);
  fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
  fs.writeFileSync(copy, original, { mode: 0o600 });
  fs.chmodSync(copy, 0o600);
  return { real, copy, id, original, ...(lock === undefined ? {} : { lock }) };
}

/** Blocks this thread for `ms`: the copy-back runs in `finally` blocks, so it stays synchronous. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Takes `lock` as the agent takes it, waiting up to `lock.waitMs` for another holder; false when it was held all that time. */
function takeLock(lock: CredentialWriteLock): boolean {
  const deadline = Date.now() + lock.waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock.directory);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (Date.now() >= deadline) return false;
    sleep(50);
  }
}

/**
 * Adds `refreshed`, the agent's rewrite of the recorder's copy, to the
 * recovery file beside the user's file, and throws a CredentialsKeptError
 * naming it; when even that file cannot take it, a CredentialsNotSavedError:
 * the copy is then the only place the refreshed sign-in is, and the caller
 * must keep it. `why` says why the sign-in could not go back.
 */
export function keepRefreshedCopy(credential: CopiedCredentialFile, refreshed: Buffer, why: string): never {
  const recoveryFile = recoveryFileFor(credential.real);
  try {
    keepRefreshedCredentials(recoveryFile, [{ id: credential.id, value: refreshed.toString("utf8") }]);
  } catch (error) {
    throw new CredentialsNotSavedError(
      `${why}, and the recorder could not keep the refreshed sign-in in ${recoveryFile} either (${error instanceof Error ? error.message : String(error)}). The refreshed sign-in is only in the recorder's copy, ${credential.copy}.`,
      credential.copy,
      recoveryFile,
    );
  }
  throw new CredentialsKeptError(`${why}; it kept the refreshed sign-in in ${recoveryFile}, readable only by you. Write its newest value over ${credential.real}, or sign in again.`, recoveryFile);
}

/**
 * Puts a copy the agent rewrote back over the user's file, unless the user's
 * file also changed while the recorder ran. With the agent's lock, it holds
 * the lock from before it reads the user's file until after it replaced it.
 * A refreshed copy that cannot go back (the file changed, the recorder cannot
 * write it or cannot take the lock) is added to the recovery file beside the
 * user's file, and this throws a CredentialsKeptError naming it; when even
 * that file cannot take it, a CredentialsNotSavedError: the copy is then the
 * only place the refreshed sign-in is, and the caller must keep it. `agent`
 * names the agent in the messages. Any other error leaves the caller unsure
 * whether the copy changed, so it must keep the copy too.
 */
export function returnCredentialFile(credential: CopiedCredentialFile, agent: string): void {
  if (!fs.existsSync(credential.copy)) return;
  const now = fs.readFileSync(credential.copy);
  if (now.equals(credential.original)) return;
  const keep = (why: string): never => keepRefreshedCopy(credential, now, why);
  const lock = credential.lock;
  if (lock !== undefined) {
    let taken: boolean;
    try {
      taken = takeLock(lock);
    } catch (error) {
      return keep(`the recorder could not take ${agent}'s lock ${lock.directory} to write the refreshed sign-in back to ${credential.real} (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!taken) keep(`another ${agent} held its lock ${lock.directory} for ${lock.waitMs / 1000} s, so the recorder did not write the refreshed sign-in back to ${credential.real}`);
  }
  try {
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
  } finally {
    if (lock !== undefined) {
      try {
        fs.rmdirSync(lock.directory);
      } catch {
        // Gone already: nothing to let go of.
      }
    }
  }
}
