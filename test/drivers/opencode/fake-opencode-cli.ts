// A fake `opencode` executable for the OpenCode recorder's tests, run as
// `node test/drivers/opencode/fake-opencode-cli.ts <args>` by a small `opencode`
// script a test puts on PATH. It runs the fake OpenCode 2.1.2 server
// (./fake-opencode.ts) as a process of its own, as the recorder starts
// `opencode serve`:
//   - `--version` prints `opencode v2.1.2`;
//   - `serve` starts the fake server with the password in OPENCODE_PASSWORD,
//     prints `Server listening on <url>`, and plays every run with the
//     scenario puppet (./puppets.ts), until SIGTERM.
//
// Like OpenCode, `serve` loads the user's setup from where its environment
// says (./user-setup.ts) and reads the sign-ins in its database; it adds
// every setup file it loaded to its replies, so a test sees in the recording
// what leaked. It appends what it saw to the JSON lines file in
// ARI_FAKE_OPENCODE_REPORT: its arguments, environment and directory when it
// starts, the sign-ins it found, and at exit any frame of its own that broke
// the pinned schemas. Two variables steer it in a test:
//   ARI_FAKE_OPENCODE_REFRESH  at the first run, every sign-in's value in its
//                              database becomes this text, as when OpenCode
//                              refreshes an OAuth token
//   ARI_FAKE_OPENCODE_CRASH    the server dies in the first run

import * as fs from "node:fs";
import * as path from "node:path";
import { FAKE_VERSIONS, FakeServer, FakeWorld } from "./fake-opencode.ts";
import { startOpencodePuppet } from "./puppets.ts";
import { loadedOpencodeSetup, opencodeDataSource } from "./user-setup.ts";
import { openSqlite } from "../../recordings/opencode/sqlite.ts";

function report(entry: { readonly [key: string]: unknown }): void {
  const file = process.env["ARI_FAKE_OPENCODE_REPORT"];
  if (file !== undefined && file !== "") fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

/** The sign-ins in the database this server opens, if it has one. */
async function credentials(database: string): Promise<Array<{ id: string; value: string }>> {
  if (!fs.existsSync(database)) return [];
  const db = await openSqlite(database, { readOnly: true });
  try {
    return db.all("SELECT id, value FROM credential").map((row) => ({ id: String(row["id"]), value: String(row["value"]) }));
  } finally {
    db.close();
  }
}

/** Every table of the database and its row count, to show what else of the user's the server got. */
async function tableRows(database: string): Promise<{ [table: string]: number }> {
  if (!fs.existsSync(database)) return {};
  const db = await openSqlite(database, { readOnly: true });
  try {
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((row) => String(row["name"]));
    return Object.fromEntries(tables.map((table) => [table, Number(db.all(`SELECT count(*) AS n FROM "${table.replaceAll('"', '""')}"`)[0]!["n"])]));
  } finally {
    db.close();
  }
}

async function refresh(database: string, value: string): Promise<void> {
  const db = await openSqlite(database);
  try {
    db.run("UPDATE credential SET value = ?", value);
  } finally {
    db.close();
  }
}

async function serve(): Promise<void> {
  const env = process.env;
  const world = new FakeWorld(2);
  await world.ready();
  const data = opencodeDataSource(env);
  const database = data === undefined ? "" : path.join(data, "opencode.db");
  const loaded = loadedOpencodeSetup(env, process.cwd());
  report({ loaded, credentials: await credentials(database), tables: await tableRows(database) });
  const server = new FakeServer(world, env["OPENCODE_PASSWORD"]);
  const finish = (code: number): void => {
    report({ violations: [...new Set(world.violations)] });
    process.exit(code);
  };
  const url = await server.listen((code) => finish(code ?? 0));
  const refreshed = env["ARI_FAKE_OPENCODE_REFRESH"];
  startOpencodePuppet(world, {
    extraText: loaded.join("\n"),
    crash: env["ARI_FAKE_OPENCODE_CRASH"] === "1",
    onTurn: async (_run, index) => {
      if (index === 0 && refreshed !== undefined && database !== "" && fs.existsSync(database)) await refresh(database, refreshed);
    },
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void server.exit(0));
  process.stdout.write(`Server listening on ${url}\n`);
}

const args = process.argv.slice(2);
report({ args, env: { ...process.env }, cwd: process.cwd() });
if (args[0] === "--version") {
  process.stdout.write(`opencode v${FAKE_VERSIONS[2]}\n`);
} else if (args[0] === "serve") {
  await serve();
} else {
  process.stderr.write(`fake opencode: unknown command ${args.join(" ")}\n`);
  process.exitCode = 1;
}
