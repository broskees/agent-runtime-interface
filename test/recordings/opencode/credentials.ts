// The OpenCode sign-in the recorder gives the recorded server, and gives back.
//
// OpenCode 2.1.2 has no credential file of its own: it keeps every provider
// sign-in (API keys and OAuth tokens) as a row of the `credential` table in
// its SQLite database, the file `opencode.db` in its data directory. The
// server opens that file at `packages/cli/src/server-process.ts:114`
// (`database: { path: databasePath(global.data) }`), and
// `packages/cli/src/database-path.ts` names it (`OPENCODE_DB`, else
// `opencode.db`); `packages/core/src/credential.ts:89-104` reads the rows. The data
// directory is `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`
// (`packages/util/src/global-roots.ts`). The legacy `auth.json` there is read
// only by a migration of an existing database, never by a new one
// (`packages/core/src/database/migration.ts` marks every migration done when it
// creates a database), so copying it would sign nothing in.
//
// The same file holds the user's sessions, saved permission grants and the
// rest of OpenCode's state, so the recorder copies it with all of that left
// out: a consistent copy (`VACUUM INTO`, from a read-only connection) into the
// workspace's data directory, then every table but `credential` and the
// migration journal emptied. When the run ends, a credential whose value
// OpenCode changed in the copy (it refreshed an OAuth token, as
// `packages/core/src/integration.ts` does through `credentials.update`) goes
// back to the user's database, unless the user's row also changed meanwhile.
// A value that cannot go back is added to the run's recovery file beside the
// user's database; when that fails too, the caller keeps the copy.

import * as fs from "node:fs";
import * as path from "node:path";
import type { OpencodeLayout } from "./run.ts";
import { openSqlite } from "./sqlite.ts";
import type { SqliteDatabase } from "./sqlite.ts";

/** The database file of OpenCode 2.1.2 release builds (`packages/cli/src/database-path.ts`). */
export const OPENCODE_DATABASE_FILE = "opencode.db";

/** The tables the copy keeps: the sign-ins, and the migration journals OpenCode checks when it opens a database. */
const KEPT_TABLES: ReadonlySet<string> = new Set(["credential", "migration", "__drizzle_migrations"]);

type Env = { readonly [name: string]: string | undefined };

/** OpenCode's data directory for an environment: `$XDG_DATA_HOME/opencode`, else `$HOME/.local/share/opencode`. */
export function opencodeDataDirectory(env: Env): string | undefined {
  const xdg = env["XDG_DATA_HOME"]?.trim();
  if (xdg !== undefined && xdg !== "") return path.join(xdg, "opencode");
  const home = env["HOME"]?.trim();
  return home === undefined || home === "" ? undefined : path.join(home, ".local", "share", "opencode");
}

/** The user's OpenCode database, as OpenCode finds it: `OPENCODE_DB` (relative to the data directory), else `opencode.db` there. */
export function userDatabaseFile(env: Env): string | undefined {
  const data = opencodeDataDirectory(env);
  const configured = env["OPENCODE_DB"]?.trim();
  if (configured === ":memory:") return undefined;
  if (configured !== undefined && configured !== "") return data === undefined ? path.resolve(configured) : path.resolve(data, configured);
  return data === undefined ? undefined : path.join(data, OPENCODE_DATABASE_FILE);
}

/** Where the recorded server finds its database: `opencode.db` in the workspace's data directory. */
export function workspaceDatabaseFile(layout: OpencodeLayout): string {
  return path.join(layout.dataHome, "opencode", OPENCODE_DATABASE_FILE);
}

export interface CopiedCredentials {
  /** The user's database. */
  readonly real: string;
  /** The copy the recorded server opens. */
  readonly copy: string;
  /** Each credential's value as copied, by id. */
  readonly original: ReadonlyMap<string, string>;
}

function sqlString(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function sqlName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Copies the user's sign-ins, and nothing else of their database, into the workspace. Undefined when the user has no database. */
export async function copyCredentials(env: Env, layout: OpencodeLayout): Promise<CopiedCredentials | undefined> {
  const real = userDatabaseFile(env);
  if (real === undefined || !fs.existsSync(real)) return undefined;
  const copy = workspaceDatabaseFile(layout);
  fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
  const source = await openSqlite(real, { readOnly: true });
  try {
    source.exec(`VACUUM INTO ${sqlString(copy)}`);
  } finally {
    source.close();
  }
  fs.chmodSync(copy, 0o600);
  const database = await openSqlite(copy);
  try {
    const tables = database.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((row) => String(row["name"]));
    if (!tables.includes("credential")) throw new Error(`${real} has no credential table; it is not the database of an OpenCode 2.x the recorder knows`);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("BEGIN");
    for (const table of tables) if (!KEPT_TABLES.has(table)) database.exec(`DELETE FROM ${sqlName(table)}`);
    database.exec("COMMIT");
    // The emptied rows leave no trace in the copy's free pages.
    database.exec("VACUUM");
    const original = new Map(database.all("SELECT id, value FROM credential").map((row) => [String(row["id"]), String(row["value"])]));
    return { real, copy, original };
  } finally {
    database.close();
  }
}

/**
 * Where this recorder run keeps refreshed sign-ins that could not go back to
 * `database`: a file beside it, readable only by the user. One file per run
 * (by process id), so two runs at once never write the same file; every
 * scenario of the run adds to it.
 */
export function recoveryFileFor(database: string): string {
  return `${database}.ari-recorder-refreshed-${process.pid}.json`;
}

/** One credential row in the recovery file: the newest refreshed value the recorder could not put back, and any older ones. */
export interface RecoveredCredential {
  readonly id: string;
  readonly value: string;
  /** Values an earlier scenario or run kept for the same row, oldest first. */
  readonly olderValues?: readonly string[];
}

/** Some refreshed sign-ins could not go back to the user's database; each is safe in `recoveryFile`. */
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
 * Adds `rows` to the recovery file, one record per credential row: a row
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

/**
 * Puts each credential OpenCode changed in the copy back into the user's
 * database. A changed value that cannot go back (the user's row also changed
 * while the recorder ran, or the recorder cannot write the database) is added
 * to the recovery file beside the user's database (`recoveryFileFor`), and
 * this throws a CredentialsKeptError naming it. When even that file cannot
 * take the value, this throws a CredentialsNotSavedError: the copy is then
 * the only place the value is, and the caller must keep it. Any other error
 * leaves the caller unsure whether a value changed, so it must keep the copy
 * too.
 */
export async function returnCredentials(credentials: CopiedCredentials): Promise<void> {
  if (!fs.existsSync(credentials.copy)) return;
  const copy = await openSqlite(credentials.copy, { readOnly: true });
  let rows: Array<{ id: string; value: string }>;
  try {
    rows = copy.all("SELECT id, value FROM credential").map((row) => ({ id: String(row["id"]), value: String(row["value"]) }));
  } finally {
    copy.close();
  }
  const changed = rows.filter((row) => credentials.original.has(row.id) && credentials.original.get(row.id) !== row.value);
  if (changed.length === 0) return;
  const recoveryFile = recoveryFileFor(credentials.real);
  /** Keeps `rows` in the recovery file, or throws CredentialsNotSavedError saying why it could not. */
  const keep = (rows: ReadonlyArray<{ id: string; value: string }>, why: string): never => {
    try {
      keepRefreshedCredentials(recoveryFile, rows);
    } catch (error) {
      throw new CredentialsNotSavedError(
        `${why}, and the recorder could not keep them in ${recoveryFile} either (${error instanceof Error ? error.message : String(error)}). The refreshed value(s) of ${rows.map((row) => row.id).join(", ")} are only in the recorder's copy, ${credentials.copy}.`,
        credentials.copy,
        recoveryFile,
      );
    }
    throw new CredentialsKeptError(`${why}; it kept the refreshed value(s) in ${recoveryFile}, readable only by you. Put each value back into its row of the credential table, or sign in again.`, recoveryFile);
  };
  let user: SqliteDatabase | undefined;
  const conflicts: string[] = [];
  try {
    user = await openSqlite(credentials.real);
    const stamped = user.all("PRAGMA table_info(credential)").some((column) => column["name"] === "time_updated");
    user.exec("BEGIN IMMEDIATE");
    for (const row of changed) {
      const current = user.all("SELECT value FROM credential WHERE id = ?", row.id)[0];
      if (current === undefined || String(current["value"]) !== credentials.original.get(row.id)) {
        conflicts.push(row.id);
        continue;
      }
      if (stamped) user.run("UPDATE credential SET value = ?, time_updated = ? WHERE id = ?", row.value, Date.now(), row.id);
      else user.run("UPDATE credential SET value = ? WHERE id = ?", row.value, row.id);
    }
    user.exec("COMMIT");
  } catch (error) {
    try {
      user?.exec("ROLLBACK");
    } catch {
      // No transaction was open.
    }
    keep(changed, `the recorder could not write the sign-in(s) OpenCode refreshed back to ${credentials.real} (${error instanceof Error ? error.message : String(error)})`);
  } finally {
    user?.close();
  }
  if (conflicts.length > 0) {
    keep(
      changed.filter((row) => conflicts.includes(row.id)),
      `the credential(s) ${conflicts.join(", ")} in ${credentials.real} changed while the recorder ran, and OpenCode also refreshed the recorder's copy; the recorder left them as they are`,
    );
  }
}
