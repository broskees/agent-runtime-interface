// Where a recorder keeps a refreshed sign-in that cannot go back to where the
// user keeps theirs, so a rotated token is never lost. Both recorders use it:
// the Claude recorder for the user's `.credentials.json`, the OpenCode
// recorder for the rows of the user's `opencode.db` credential table.
//
// The recovery file sits beside the user's own file and is readable only by
// the user (mode 0600). It holds one record per credential, `{ id, value }`,
// with `olderValues` when a later scenario kept a newer value for the same
// credential. A recorder reads the file first and adds to it, never truncates
// it, and replaces it only by renaming a complete new file over it.
//
// RecordingNotWrittenError is here too: a failed write of a recording must not
// hide where a refreshed sign-in went, so both recorders report it beside the
// sign-in's fate and stop.

import * as fs from "node:fs";

/**
 * Where this recorder run keeps refreshed sign-ins that could not go back to
 * `file`: a file beside it, readable only by the user. One file per run (by
 * process id), so two runs at once never write the same file; every scenario
 * of the run adds to it.
 */
export function recoveryFileFor(file: string): string {
  return `${file}.ari-recorder-refreshed-${process.pid}.json`;
}

/** One credential in the recovery file: the newest refreshed value the recorder could not put back, and any older ones. */
export interface RecoveredCredential {
  readonly id: string;
  readonly value: string;
  /** Values an earlier scenario or run kept for the same credential, oldest first. */
  readonly olderValues?: readonly string[];
}

/** Some refreshed sign-ins could not go back to where the user keeps them; each is safe in `recoveryFile`. */
export class CredentialsKeptError extends Error {
  readonly recoveryFile: string;
  constructor(message: string, recoveryFile: string) {
    super(message);
    this.name = "CredentialsKeptError";
    this.recoveryFile = recoveryFile;
  }
}

/** Some refreshed sign-ins could not go back, and the recovery file could not take them either: the workspace copy is the only one left. */
export class CredentialsNotSavedError extends Error {
  readonly copy: string;
  readonly recoveryFile: string;
  constructor(message: string, copy: string, recoveryFile: string) {
    super(message);
    this.name = "CredentialsNotSavedError";
    this.copy = copy;
    this.recoveryFile = recoveryFile;
  }
}

/**
 * Adds `rows` to the recovery file, one record per credential: a credential
 * already there keeps its earlier values in `olderValues`. It reads the file
 * first and writes the merged list to a new file it then renames over the
 * old one, so a failed write leaves the old file whole. A file it cannot
 * read as a recovery file is never overwritten: it throws instead.
 */
export function keepRefreshedCredentials(recoveryFile: string, rows: ReadonlyArray<{ id: string; value: string }>): void {
  let kept: RecoveredCredential[] = [];
  if (fs.existsSync(recoveryFile)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(recoveryFile, "utf8"));
    const valid = Array.isArray(parsed) && parsed.every((entry: unknown) => {
      const record = entry as { id?: unknown; value?: unknown; olderValues?: unknown };
      return typeof record === "object" && record !== null && typeof record.id === "string" && typeof record.value === "string" && (record.olderValues === undefined || (Array.isArray(record.olderValues) && record.olderValues.every((value) => typeof value === "string")));
    });
    if (!valid) throw new Error(`${recoveryFile} is not a list of credential records the recorder wrote`);
    kept = parsed as RecoveredCredential[];
  }
  for (const row of rows) {
    const index = kept.findIndex((record) => record.id === row.id);
    const earlier = kept[index];
    if (earlier === undefined) {
      kept.push({ id: row.id, value: row.value });
      continue;
    }
    if (earlier.value === row.value) continue;
    const olderValues = [...(earlier.olderValues ?? []), earlier.value].filter((value) => value !== row.value);
    kept[index] = { id: row.id, value: row.value, olderValues };
  }
  const staged = `${recoveryFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(staged, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600, flag: "w" });
    fs.chmodSync(staged, 0o600);
    fs.renameSync(staged, recoveryFile);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  }
}

/** The recorder could not write a scenario's recording (an output directory it cannot use, a full disk): the recorder stops, since the next scenario would fail the same way. */
export class RecordingNotWrittenError extends Error {
  readonly file: string;
  constructor(file: string, cause: unknown) {
    super(`the recorder could not write the recording ${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "RecordingNotWrittenError";
    this.file = file;
  }
}
