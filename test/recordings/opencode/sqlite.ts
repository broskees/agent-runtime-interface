// A small SQLite handle for the OpenCode recorder and its tests: Node's
// `node:sqlite` (Node 22.5 and later), or `bun:sqlite` under Bun, which has no
// `node:sqlite` (Bun 1.3.14). OpenCode 2.1.2 keeps its provider sign-ins in
// the `credential` table of its SQLite database, so the recorder reads and
// writes that table through this handle.

export type SqliteValue = string | number | bigint | null | Uint8Array;
export type SqliteRow = { readonly [column: string]: SqliteValue };

export interface SqliteDatabase {
  all(sql: string, ...params: SqliteValue[]): SqliteRow[];
  run(sql: string, ...params: SqliteValue[]): void;
  exec(sql: string): void;
  close(): void;
}

interface NodeStatement {
  all(...params: SqliteValue[]): SqliteRow[];
  run(...params: SqliteValue[]): unknown;
}
interface NodeDatabase {
  prepare(sql: string): NodeStatement;
  exec(sql: string): void;
  close(): void;
}
interface BunDatabase {
  query(sql: string): { all(...params: SqliteValue[]): SqliteRow[]; run(...params: SqliteValue[]): unknown };
  exec(sql: string): void;
  close(): void;
}

// String-typed specifiers: the type checker loads neither module's declarations.
const NODE_SQLITE: string = "node:sqlite";
const BUN_SQLITE: string = "bun:sqlite";

/** Opens `file`; read-only when asked. A missing file is an error when read-only, and is created otherwise. */
export async function openSqlite(file: string, options: { readonly readOnly?: boolean } = {}): Promise<SqliteDatabase> {
  const readOnly = options.readOnly === true;
  if (process.versions["bun"] === undefined) {
    const { DatabaseSync } = (await import(NODE_SQLITE)) as { DatabaseSync: new (file: string, options: { readOnly: boolean; timeout: number }) => NodeDatabase };
    const database = new DatabaseSync(file, { readOnly, timeout: 5_000 });
    return {
      all: (sql, ...params) => database.prepare(sql).all(...params),
      run: (sql, ...params) => void database.prepare(sql).run(...params),
      exec: (sql) => database.exec(sql),
      close: () => database.close(),
    };
  }
  const { Database } = (await import(BUN_SQLITE)) as { Database: new (file: string, options: { readonly?: boolean; create?: boolean; readwrite?: boolean }) => BunDatabase };
  const database = new Database(file, readOnly ? { readonly: true } : { readwrite: true, create: true });
  database.exec("PRAGMA busy_timeout = 5000");
  return {
    all: (sql, ...params) => database.query(sql).all(...params),
    run: (sql, ...params) => void database.query(sql).run(...params),
    exec: (sql) => database.exec(sql),
    close: () => database.close(),
  };
}
