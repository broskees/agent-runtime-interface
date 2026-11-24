// The OpenCode recorder runs a real agent only when asked, keeps the user's
// own OpenCode setup out of the recorded server and unchanged, gives the
// server the user's sign-ins and takes a refreshed one back, and stops before
// the first prompt without a model the server offers. Everything here runs
// against the fake OpenCode, in this process or as a fake `opencode`
// executable on PATH; nothing starts a real OpenCode.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { LIVE_RECORD_VARIABLE, parseRecordArguments } from "../../../scripts/record-claude.ts";
import { DEFAULT_OPENCODE_RECORDINGS } from "../../../scripts/record-opencode.ts";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { opencodeDataDirectory, recoveryFileFor, userDatabaseFile } from "../../recordings/opencode/credentials.ts";
import { OpencodeModelChoiceError, RecordingNotWrittenError, describeOpencodeRun, failuresOf, recordOpencode } from "../../recordings/opencode/record.ts";
import type { OpencodeRecordOutcome, RecordOpencodeOptions } from "../../recordings/opencode/record.ts";
import { replayOpencode } from "../../recordings/opencode/replay.ts";
import { OPENCODE_SERVE_ARGS, opencodeServeEnvironment, startOpencodeServe } from "../../recordings/opencode/serve.ts";
import { openSqlite } from "../../recordings/opencode/sqlite.ts";
import { SCENARIO_NAMES } from "../../recordings/scenarios.ts";
import type { ScenarioName } from "../../recordings/scenarios.ts";
import { fakeOpencodeServers } from "./puppets.ts";
import type { FakeOpencodeServer } from "./puppets.ts";
import { loadedOpencodeSetup, opencodeSetupSources } from "./user-setup.ts";

const DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), "ari-opencode-recorder-"));
process.on("exit", () => fs.rmSync(DIRECTORY, { recursive: true, force: true }));

// Running the recorder script.

/** A module that hides every @opencode package and traps every child_process function, and reports both when the process exits. */
const TRAP = `
import { registerHooks, createRequire, syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
const resolved = [];
const spawned = [];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@opencode/") || specifier.startsWith("@opencode-ai/")) {
      resolved.push(specifier);
      const error = new Error("Cannot find package '" + specifier + "'");
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    }
    return next(specifier, context);
  },
});
const childProcess = createRequire(import.meta.url)("node:child_process");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = (...args) => {
    spawned.push(name + " " + String(args[0]));
    throw new Error("child_process." + name + " is trapped in this test");
  };
}
syncBuiltinESMExports();
process.on("exit", () => fs.writeFileSync(process.env.ARI_TEST_TRAP_REPORT, JSON.stringify({ resolved, spawned })));
`;

/** Runs Node with the trap loaded first. The trap uses node:module hooks, which Bun lacks, so this is Node whichever runtime runs the test. */
function runTrapped(args: string[], env: { [name: string]: string }): { status: number | null; stderr: string; resolved: string[]; spawned: string[] } {
  const directory = fs.mkdtempSync(path.join(DIRECTORY, "trap-"));
  const trap = path.join(directory, "trap.mjs");
  const report = path.join(directory, "report.json");
  const home = path.join(directory, "trap-home");
  fs.mkdirSync(home);
  fs.writeFileSync(trap, TRAP);
  const child = spawnSync(NODE_EXECUTABLE, ["--import", pathToFileURL(trap).href, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      ARI_TEST_TRAP_REPORT: report,
      ...env,
    },
  });
  const { resolved, spawned } = JSON.parse(fs.readFileSync(report, "utf8")) as { resolved: string[]; spawned: string[] };
  return { status: child.status, stderr: child.stderr, resolved, spawned };
}

test("the trap sees an @opencode resolution and a spawn when a program makes them", () => {
  const probe = runTrapped(["--input-type=module", "-e", `await import("@opencode/client").catch(() => undefined); try { (await import("node:child_process")).spawn("true"); } catch {}`], {});
  assert.deepEqual(probe.resolved, ["@opencode/client"]);
  assert.deepEqual(probe.spawned, ["spawn true"]);
});

test(`node scripts/record-opencode.ts without ${LIVE_RECORD_VARIABLE}=1 exits non-zero naming the variable, before it loads the client or spawns anything`, () => {
  const environments: Array<{ [name: string]: string }> = [{}, { [LIVE_RECORD_VARIABLE]: "0" }, { [LIVE_RECORD_VARIABLE]: "true" }, { [LIVE_RECORD_VARIABLE]: "" }, { ARI_RECORD_OPENCODE_MODEL: "fake/fake-small" }];
  for (const env of environments) {
    for (const args of [["scripts/record-opencode.ts"], ["scripts/record-opencode.ts", "simple", "--out", "elsewhere"]]) {
      const run = runTrapped(args, env);
      assert.equal(run.status, 2, `${JSON.stringify(env)} ${args.join(" ")}: ${run.stderr}`);
      assert.match(run.stderr, /record-opencode: refusing to start a real OpenCode server/);
      assert.match(run.stderr, new RegExp(`set ${LIVE_RECORD_VARIABLE}=1 to run it`));
      assert.deepEqual(run.resolved, [], "no @opencode package was resolved");
      assert.deepEqual(run.spawned, [], "nothing was spawned");
    }
  }
});

test(`the record:opencode script runs the recorder, and no package.json script and no CI workflow step sets ${LIVE_RECORD_VARIABLE}`, () => {
  const scripts = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["record:opencode"], "node scripts/record-opencode.ts");
  for (const [name, command] of Object.entries(scripts)) assert.ok(!command.includes(LIVE_RECORD_VARIABLE), `script ${name} sets ${LIVE_RECORD_VARIABLE}`);
  const workflows = fs.readdirSync(path.join(REPO_ROOT, ".github", "workflows")).filter((name) => name.endsWith(".yml"));
  assert.ok(workflows.length >= 2, workflows.join(", "));
  for (const workflow of workflows) assert.ok(!fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", workflow), "utf8").includes(LIVE_RECORD_VARIABLE), `${workflow} sets ${LIVE_RECORD_VARIABLE}`);
});

test("the OpenCode recorder takes the arguments of record:claude, and writes to test/drivers/opencode/recordings/ by default", () => {
  assert.equal(DEFAULT_OPENCODE_RECORDINGS, path.join(REPO_ROOT, "test", "drivers", "opencode", "recordings"));
  assert.deepEqual(parseRecordArguments(["resume", "simple", "--out", "/tmp/somewhere"], SCENARIO_NAMES, DEFAULT_OPENCODE_RECORDINGS), { scenarios: ["resume", "simple"], outDir: "/tmp/somewhere" });
  assert.deepEqual(parseRecordArguments([], SCENARIO_NAMES, DEFAULT_OPENCODE_RECORDINGS), { scenarios: [], outDir: DEFAULT_OPENCODE_RECORDINGS });
});

// The user's OpenCode setup.

const MARKERS = {
  config: "marker-oc-config-31a7",
  mcp: "marker-oc-mcp-8c42",
  plugin: "marker-oc-plugin-5e19",
  agent: "marker-oc-agent-d06b",
  claude: "marker-oc-claude-md-71f3",
  agents: "marker-oc-agents-2b88",
  explicit: "marker-oc-explicit-4d21",
  configDir: "marker-oc-config-dir-a9c5",
  content: "marker-oc-content-6f0e",
  session: "marker-oc-session-9a54",
  permission: "marker-oc-permission-c3e0",
} as const;

const SIGN_IN = JSON.stringify({ type: "key", key: "fake-provider-key-0001" });

/** Creates an OpenCode 2.x database shaped like 2.1.2's where it matters: the sign-ins, the migration journal, a session and a saved permission grant. */
async function seedDatabase(file: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = await openSqlite(file);
  try {
    db.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL); CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL); CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE permission (id TEXT PRIMARY KEY, project_id TEXT, action TEXT, resources TEXT)",
    );
    db.run("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, 1, 1, 1)", "crd_0001", "fake", "default", SIGN_IN);
    db.run("INSERT INTO migration VALUES (?, ?)", "20260805200742_import_legacy_credentials", 1);
    db.run("INSERT INTO session_v2 VALUES (?, ?)", "ses_user0001", `A session of the user's: ${MARKERS.session}`);
    db.run("INSERT INTO permission VALUES (?, ?, ?, ?)", "prm_0001", "global", "shell", JSON.stringify([`printf * ${MARKERS.permission}`]));
  } finally {
    db.close();
  }
}

/** A temp HOME holding an OpenCode config with an MCP entry, a plugin, an agent, `~/.claude` and `~/.agents` files and a database, each with its own marker; and variables that point OpenCode at more of them. */
async function seedHome(): Promise<{ home: string; env: { [name: string]: string }; files: Map<string, Buffer>; database: string }> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(DIRECTORY, "user-home-")));
  const config = path.join(home, ".config", "opencode");
  const contents: { [file: string]: string } = {
    [path.join(config, "opencode.json")]: JSON.stringify({ $schema: "https://opencode.ai/config.json", instructions: [MARKERS.config], mcp: { [MARKERS.mcp]: { type: "local", command: [MARKERS.mcp] } } }),
    [path.join(config, "plugin", "marker.js")]: `export const MarkerPlugin = async () => ({ name: "${MARKERS.plugin}" });\n`,
    [path.join(config, "agent", "marker.md")]: `---\ndescription: ${MARKERS.agent}\n---\nAlways answer with ${MARKERS.agent}.\n`,
    [path.join(home, ".claude", "CLAUDE.md")]: `Always answer with ${MARKERS.claude}.\n`,
    [path.join(home, ".agents", "skills", "marker", "SKILL.md")]: `---\nname: marker\ndescription: ${MARKERS.agents}\n---\n`,
    [path.join(home, "explicit-opencode.json")]: JSON.stringify({ instructions: [MARKERS.explicit] }),
    [path.join(home, "config-dir", "opencode.json")]: JSON.stringify({ instructions: [MARKERS.configDir] }),
  };
  for (const [file, text] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const database = path.join(home, ".local", "share", "opencode", "opencode.db");
  await seedDatabase(database);
  const files = new Map<string, Buffer>();
  for (const file of [...Object.keys(contents), database]) files.set(file, fs.readFileSync(file));
  const env = {
    HOME: home,
    OPENCODE_CONFIG: path.join(home, "explicit-opencode.json"),
    OPENCODE_CONFIG_DIR: path.join(home, "config-dir"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: [MARKERS.content] }),
  };
  return { home, env, files, database };
}

async function credentialValue(database: string): Promise<string> {
  const db = await openSqlite(database, { readOnly: true });
  try {
    return String(db.all("SELECT value FROM credential WHERE id = ?", "crd_0001")[0]!["value"]);
  } finally {
    db.close();
  }
}

interface FakeProcess {
  readonly args: string[];
  readonly env: { [name: string]: string };
  readonly cwd: string;
  readonly loaded?: string[];
  readonly credentials?: Array<{ id: string; value: string }>;
  readonly tables?: { [table: string]: number };
  readonly violations?: string[];
}

/** A directory holding a fake `opencode` that runs test/drivers/opencode/fake-opencode-cli.ts, and the report file it writes to. */
function fakeOpencodeOnPath(): { bin: string; report: string; processes(): FakeProcess[] } {
  const directory = fs.mkdtempSync(path.join(DIRECTORY, "fake-bin-"));
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  const node = NODE_EXECUTABLE === "node" ? "node" : JSON.stringify(NODE_EXECUTABLE);
  fs.writeFileSync(path.join(bin, "opencode"), `#!/bin/sh\nexec ${node} ${JSON.stringify(path.join(REPO_ROOT, "test", "drivers", "opencode", "fake-opencode-cli.ts"))} "$@"\n`, { mode: 0o755 });
  const report = path.join(directory, "report.ndjson");
  return {
    bin,
    report,
    processes: () => {
      const entries = fs.existsSync(report) ? fs.readFileSync(report, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { [key: string]: unknown }) : [];
      const processes: FakeProcess[] = [];
      for (const entry of entries) {
        if (entry["args"] !== undefined) processes.push(entry as unknown as FakeProcess);
        else Object.assign(processes.at(-1)!, entry);
      }
      return processes;
    },
  };
}

/** Records `scenarios` with the recorder's own `opencode serve` starter, against the fake `opencode` on PATH. */
async function recordWithFakeExecutable(env: { [name: string]: string }, scenarios: readonly ScenarioName[], fake: ReturnType<typeof fakeOpencodeOnPath>): Promise<{ outDir: string; outcomes: OpencodeRecordOutcome[] }> {
  const outDir = fs.mkdtempSync(path.join(DIRECTORY, "out-"));
  const outcomes = await recordOpencode({
    scenarios,
    outDir,
    source: "fake",
    env: { PATH: `${fake.bin}${path.delimiter}${process.env["PATH"] ?? "/usr/bin:/bin"}`, ARI_RECORD_OPENCODE_MODEL: "fake/fake-small", ARI_FAKE_OPENCODE_REPORT: fake.report, ...env },
    startServer: (input) => startOpencodeServe({ layout: input.layout, env: input.env, password: input.password }),
    timeoutMs: 20_000,
  });
  return { outDir, outcomes };
}

const ALLOWED_OPENCODE_VARIABLES = ["OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_PASSWORD"];

test("the fake OpenCode, given the user's own environment, loads every seeded config, plugin, agent and MCP entry, so a leak would show", async () => {
  const { home, env } = await seedHome();
  // OPENCODE_CONFIG_DIR replaces ~/.config/opencode (2.1.2 `packages/util/src/global.ts:79`), so each is loaded without the other.
  const { OPENCODE_CONFIG_DIR: configDir, ...withoutConfigDir } = env;
  const loaded = loadedOpencodeSetup(withoutConfigDir, path.join(home, "project")).join("\n");
  for (const marker of [MARKERS.config, MARKERS.mcp, MARKERS.plugin, MARKERS.agent, MARKERS.claude, MARKERS.agents, MARKERS.explicit, MARKERS.content]) assert.ok(loaded.includes(marker), `the fake loads ${marker}`);
  assert.ok(loadedOpencodeSetup({ HOME: home, OPENCODE_CONFIG_DIR: configDir! }, path.join(home, "project")).join("\n").includes(MARKERS.configDir), `the fake loads ${MARKERS.configDir}`);
});

test("the recorder starts `opencode serve` with HOME and XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME and XDG_CACHE_HOME inside its own temp dir: nothing of the user's OpenCode setup reaches the server or the recording, and every seeded file is byte-identical afterwards", async () => {
  const { home, env, files } = await seedHome();
  const fake = fakeOpencodeOnPath();
  const { outDir, outcomes } = await recordWithFakeExecutable(env, SCENARIO_NAMES, fake);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.scenario, outcome.error?.message]),
    SCENARIO_NAMES.map((name) => [name, undefined]),
  );
  const processes = fake.processes();
  assert.equal(processes.length, outcomes.length, "one opencode serve per scenario");
  for (const [index, outcome] of outcomes.entries()) {
    const started = processes[index]!;
    const workspace = outcome.workspace;
    assert.deepEqual(started.args, [...OPENCODE_SERVE_ARGS]);
    assert.equal(started.cwd, path.join(workspace, "cwd"));
    assert.deepEqual(
      { HOME: started.env["HOME"], XDG_CONFIG_HOME: started.env["XDG_CONFIG_HOME"], XDG_DATA_HOME: started.env["XDG_DATA_HOME"], XDG_STATE_HOME: started.env["XDG_STATE_HOME"], XDG_CACHE_HOME: started.env["XDG_CACHE_HOME"] },
      { HOME: path.join(workspace, "opencode-home"), XDG_CONFIG_HOME: path.join(workspace, "xdg-config"), XDG_DATA_HOME: path.join(workspace, "xdg-data"), XDG_STATE_HOME: path.join(workspace, "xdg-state"), XDG_CACHE_HOME: path.join(workspace, "xdg-cache") },
      `${outcome.scenario}: the server's own dirs`,
    );
    assert.deepEqual(
      Object.keys(started.env).filter((name) => name.startsWith("OPENCODE_")).sort(),
      ALLOWED_OPENCODE_VARIABLES,
      `${outcome.scenario}: none of the user's OPENCODE_* variables`,
    );
    for (const source of opencodeSetupSources(started.env, started.cwd)) assert.ok(!source.startsWith(`${home}${path.sep}`), `${outcome.scenario}: OpenCode would read ${source}`);
    // Also where the temp dir lies inside the user's HOME (a TMPDIR there): project config is off, so OpenCode walks up to none of the user's directories.
    for (const source of opencodeSetupSources(started.env, path.join(home, "tmp", "workspace", "cwd"))) assert.ok(!source.startsWith(`${home}${path.sep}`), `${outcome.scenario}: OpenCode would read ${source}`);
    assert.deepEqual(started.loaded, [], `${outcome.scenario}: the server loaded nothing of the user's setup`);
    assert.deepEqual(started.credentials, [{ id: "crd_0001", value: SIGN_IN }], `${outcome.scenario}: the server got the user's sign-in`);
    assert.deepEqual(started.tables, { credential: 1, migration: 1, session_v2: 0, permission: 0 }, `${outcome.scenario}: and none of the user's sessions or saved permission grants`);
    assert.deepEqual(started.violations, [], `${outcome.scenario}: the fake saw only frames that match the pinned schemas`);
    const text = fs.readFileSync(outcome.file!, "utf8");
    for (const marker of Object.values(MARKERS)) assert.ok(!text.includes(marker), `${outcome.scenario}'s recording holds ${marker}`);
    assert.ok(!text.includes(home), `${outcome.scenario}'s recording holds the user's HOME`);
    assert.ok(!text.includes("fake-provider-key"), `${outcome.scenario}'s recording holds the sign-in`);
    assert.ok(!fs.existsSync(workspace), `${outcome.scenario}: the temp dir is removed`);
    await replayOpencode(outcome.file!);
  }
  for (const [file, bytes] of files) assert.ok(fs.readFileSync(file).equals(bytes), `${file} changed`);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("a sign-in OpenCode refreshes during the run goes back to the user's database, and the temp dir is removed", async () => {
  const { database, env } = await seedHome();
  const refreshed = JSON.stringify({ type: "key", key: "fake-provider-key-0002" });
  const fake = fakeOpencodeOnPath();
  const { outcomes } = await recordWithFakeExecutable({ ...env, ARI_FAKE_OPENCODE_REFRESH: refreshed }, ["simple"], fake);
  assert.equal(outcomes[0]!.error, undefined, outcomes[0]!.error?.message);
  assert.deepEqual(fake.processes()[0]!.credentials, [{ id: "crd_0001", value: SIGN_IN }], "the server started with the user's sign-in");
  assert.equal(await credentialValue(database), refreshed, "the user's database holds the refreshed sign-in");
  assert.ok(!fs.existsSync(outcomes[0]!.workspace), "the temp dir, with its copy of the database, is removed");
  assert.ok(!fs.readFileSync(outcomes[0]!.file!, "utf8").includes("fake-provider-key"), "the recording holds no sign-in");
});

test("after a run that fails, the refreshed sign-in still goes back and the temp dir is still removed", async () => {
  const { database, env } = await seedHome();
  const refreshed = JSON.stringify({ type: "key", key: "fake-provider-key-0003" });
  const fake = fakeOpencodeOnPath();
  const { outcomes } = await recordWithFakeExecutable({ ...env, ARI_FAKE_OPENCODE_REFRESH: refreshed, ARI_FAKE_OPENCODE_CRASH: "1" }, ["approval_allowed"], fake);
  assert.ok(outcomes[0]!.error !== undefined, "the scenario failed: the server died in its first run");
  assert.equal(await credentialValue(database), refreshed);
  assert.ok(!fs.existsSync(outcomes[0]!.workspace), "the temp dir is removed");
});

/** The recording function against the fake in this process, with the recorder's environment `env`. */
async function recordInProcess(env: RecordOpencodeOptions["env"], scenarios: readonly ScenarioName[], startServer?: RecordOpencodeOptions["startServer"], outDir = fs.mkdtempSync(path.join(DIRECTORY, "out-"))): Promise<{ outDir: string; outcomes: OpencodeRecordOutcome[]; servers: FakeOpencodeServer[]; log: string[] }> {
  const servers: FakeOpencodeServer[] = [];
  const log: string[] = [];
  const outcomes = await recordOpencode({ scenarios, outDir, source: "fake", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env }, startServer: startServer ?? fakeOpencodeServers(servers), timeoutMs: 20_000, log: (line) => log.push(line) });
  return { outDir, outcomes, servers, log };
}

test("when the user's sign-in also changed during the run, the recorder leaves it as it is and reports the scenario failed", async () => {
  const { database, env } = await seedHome();
  const servers: FakeOpencodeServer[] = [];
  let copy = "";
  const set = async (file: string, value: string): Promise<void> => {
    const db = await openSqlite(file);
    try {
      db.run("UPDATE credential SET value = ?", value);
    } finally {
      db.close();
    }
  };
  const start = fakeOpencodeServers(servers, {
    onTurn: async () => {
      await set(copy, "refreshed-by-the-recorded-server");
      await set(database, "refreshed-by-another-opencode");
    },
  });
  const { outcomes } = await recordInProcess({ ...env, ARI_RECORD_OPENCODE_MODEL: "fake/fake-small" }, ["simple"], async (input) => {
    copy = path.join(input.env["XDG_DATA_HOME"]!, "opencode", "opencode.db");
    return start(input);
  });
  assert.match(outcomes[0]!.error?.message ?? "", /crd_0001 in .* changed while the recorder ran, and OpenCode also refreshed the recorder's copy; the recorder left them as they are; it kept the refreshed value\(s\) in .*opencode\.db\.ari-recorder-refreshed-\d+\.json/);
  assert.equal(await credentialValue(database), "refreshed-by-another-opencode");
  const kept = `${database}.ari-recorder-refreshed-${process.pid}.json`;
  assert.equal(outcomes[0]!.recoveryFile, kept);
  assert.deepEqual(JSON.parse(fs.readFileSync(kept, "utf8")), [{ id: "crd_0001", value: "refreshed-by-the-recorded-server" }], "the recorder's refreshed value is not lost");
  assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(outcomes[0]!.workspace));
});

test("when the recorder cannot write a refreshed sign-in back, it keeps it in a file beside the user's database and says where", async () => {
  const { database, env } = await seedHome();
  const servers: FakeOpencodeServer[] = [];
  let copy = "";
  const start = fakeOpencodeServers(servers, {
    onTurn: async () => {
      const db = await openSqlite(copy);
      try {
        db.run("UPDATE credential SET value = ?", "refreshed-by-the-recorded-server");
      } finally {
        db.close();
      }
      // The user's database is no longer one the recorder can open.
      for (const file of [database, `${database}-wal`, `${database}-shm`]) fs.rmSync(file, { force: true });
      fs.writeFileSync(database, "not a database any more");
    },
  });
  const { outcomes } = await recordInProcess({ ...env, ARI_RECORD_OPENCODE_MODEL: "fake/fake-small" }, ["simple"], async (input) => {
    copy = path.join(input.env["XDG_DATA_HOME"]!, "opencode", "opencode.db");
    return start(input);
  });
  const kept = `${database}.ari-recorder-refreshed-${process.pid}.json`;
  assert.match(outcomes[0]!.error?.message ?? "", new RegExp(`could not write the sign-in\\(s\\) OpenCode refreshed back to .*; it kept the refreshed value\\(s\\) in ${kept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.deepEqual(JSON.parse(fs.readFileSync(kept, "utf8")), [{ id: "crd_0001", value: "refreshed-by-the-recorded-server" }]);
  assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(outcomes[0]!.workspace), "the temp dir is removed");
});

/** Sets the value of credential row `id` in the database `file`. */
async function setCredential(file: string, id: string, value: string): Promise<void> {
  const db = await openSqlite(file);
  try {
    db.run("UPDATE credential SET value = ? WHERE id = ?", value, id);
  } finally {
    db.close();
  }
}

/** The recording function against fresh fakes in this process; `onScenario` runs at the first turn of each scenario, given its number (from 0) and the database copy its server opens. */
async function recordWithSignInChanges(env: { [name: string]: string }, scenarios: readonly ScenarioName[], onScenario: (number: number, copy: string) => Promise<void>, crash = false, outDir: string = fs.mkdtempSync(path.join(DIRECTORY, "out-"))): Promise<{ outDir: string; outcomes: OpencodeRecordOutcome[] }> {
  const servers: FakeOpencodeServer[] = [];
  let started = -1;
  const { outcomes } = await recordInProcess({ ...env, ARI_RECORD_OPENCODE_MODEL: "fake/fake-small" }, scenarios, async (input) => {
    started += 1;
    const number = started;
    const copy = path.join(input.env["XDG_DATA_HOME"]!, "opencode", "opencode.db");
    return fakeOpencodeServers(servers, { crash, onTurn: async (_run, index) => (index === 0 ? onScenario(number, copy) : undefined) })(input);
  }, outDir);
  return { outDir, outcomes };
}

test("refreshed sign-ins that cannot go back in two scenarios all survive in the run's recovery file, one record per credential row", async () => {
  const { database, env } = await seedHome();
  const seed = await openSqlite(database);
  try {
    seed.run("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, 1, 1, 1)", "crd_0002", "other", "default", JSON.stringify({ type: "key", key: "fake-provider-key-0102" }));
  } finally {
    seed.close();
  }
  // Each scenario: OpenCode refreshes one row of the copy, and another OpenCode changes the same row of the user's database.
  const rows = ["crd_0001", "crd_0002", "crd_0001"];
  const { outDir, outcomes } = await recordWithSignInChanges(env, ["simple", "approval_denied", "multi_turn"], async (number, copy) => {
    await setCredential(copy, rows[number]!, `refreshed-${number + 1}-by-the-recorded-server`);
    await setCredential(database, rows[number]!, `changed-${number + 1}-by-another-opencode`);
  });
  const kept = recoveryFileFor(database);
  assert.deepEqual(JSON.parse(fs.readFileSync(kept, "utf8")), [
    { id: "crd_0001", value: "refreshed-3-by-the-recorded-server", olderValues: ["refreshed-1-by-the-recorded-server"] },
    { id: "crd_0002", value: "refreshed-2-by-the-recorded-server" },
  ]);
  assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.scenario, outcome.recoveryFile, outcome.workspaceKept, fs.existsSync(outcome.workspace)]),
    [
      ["simple", kept, false, false],
      ["approval_denied", kept, false, false],
      ["multi_turn", kept, false, false],
    ],
  );
  for (const outcome of outcomes) assert.match(outcome.error?.message ?? "", new RegExp(`it kept the refreshed value\\(s\\) in ${kept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(describeOpencodeRun(outcomes, outDir).filter((line) => line.includes(kept)).length, 1, "the run's last lines name the recovery file");
});

test("when the recovery file cannot take a refreshed sign-in either, the recorder keeps the workspace with its database copy, stops the run and names both", async () => {
  const { database, env } = await seedHome();
  const kept = recoveryFileFor(database);
  // Nothing can be written where the recovery file goes.
  fs.mkdirSync(kept);
  fs.writeFileSync(path.join(kept, "occupied"), "");
  const { outDir, outcomes } = await recordWithSignInChanges(env, ["simple", "multi_turn"], async (_number, copy) => {
    await setCredential(copy, "crd_0001", "refreshed-by-the-recorded-server");
    // The user's database is no longer one the recorder can open.
    for (const file of [database, `${database}-wal`, `${database}-shm`]) fs.rmSync(file, { force: true });
    fs.writeFileSync(database, "not a database any more");
  });
  assert.equal(outcomes.length, 1, "the run stopped: no other scenario ran");
  const [outcome] = outcomes;
  const copy = path.join(outcome!.workspace, "xdg-data", "opencode", "opencode.db");
  try {
    assert.equal(outcome!.workspaceKept, true);
    assert.equal(outcome!.recoveryFile, undefined);
    assert.ok(fs.existsSync(copy), "the workspace with its database copy is kept");
    const db = await openSqlite(copy, { readOnly: true });
    try {
      assert.equal(String(db.all("SELECT value FROM credential WHERE id = ?", "crd_0001")[0]!["value"]), "refreshed-by-the-recorded-server", "the copy holds the refreshed sign-in");
    } finally {
      db.close();
    }
    const message = outcome!.error?.message ?? "";
    const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(message, new RegExp(`could not keep them in ${escaped(kept)} either`));
    assert.match(message, new RegExp(`only in the recorder's copy, ${escaped(copy)}`));
    assert.match(message, new RegExp(`the recorder kept the workspace ${escaped(outcome!.workspace)}`));
    assert.ok(describeOpencodeRun(outcomes, outDir).some((line) => line.includes(outcome!.workspace)), "the run's last lines name the kept workspace");
  } finally {
    fs.rmSync(outcome!.workspace, { recursive: true, force: true });
  }
});

for (const [label, blockRecovery] of [
  ["kept in the recovery file", false],
  ["kept only in the workspace", true],
] as const) {
  test(`a scenario that fails and a refreshed sign-in ${label} are both reported`, async () => {
    const { database, env } = await seedHome();
    const kept = recoveryFileFor(database);
    if (blockRecovery) {
      fs.mkdirSync(kept);
      fs.writeFileSync(path.join(kept, "occupied"), "");
    }
    // The server dies in the scenario's first run, after OpenCode refreshed the copy and another OpenCode changed the user's row.
    const { outDir, outcomes } = await recordWithSignInChanges(
      env,
      ["simple"],
      async (_number, copy) => {
        await setCredential(copy, "crd_0001", "refreshed-by-the-recorded-server");
        await setCredential(database, "crd_0001", "changed-by-another-opencode");
      },
      true,
    );
    const [outcome] = outcomes;
    try {
      const failures = failuresOf(outcome!);
      assert.ok(failures.length >= 2, `more than one failure: ${outcome!.error?.message}`);
      assert.doesNotMatch(failures[0]!.message, /credential|sign-in/, "the scenario's own failure comes first");
      assert.ok(outcome!.error!.message.includes(failures[0]!.message), "the error names the scenario's failure");
      const ending = describeOpencodeRun(outcomes, outDir).join("\n");
      if (blockRecovery) {
        assert.equal(outcome!.workspaceKept, true);
        assert.match(outcome!.error!.message, /could not keep them in .* either/);
        assert.ok(outcome!.error!.message.includes(`the recorder kept the workspace ${outcome!.workspace}`), outcome!.error!.message);
        assert.ok(ending.includes(outcome!.workspace), ending);
      } else {
        assert.equal(outcome!.recoveryFile, kept);
        assert.ok(outcome!.error!.message.includes(`it kept the refreshed value(s) in ${kept}`), outcome!.error!.message);
        assert.ok(ending.includes(kept), ending);
        assert.deepEqual(JSON.parse(fs.readFileSync(kept, "utf8")), [{ id: "crd_0001", value: "refreshed-by-the-recorded-server" }]);
      }
    } finally {
      if (outcome?.workspaceKept === true) fs.rmSync(outcome.workspace, { recursive: true, force: true });
    }
  });
}

for (const [label, blockRecovery] of [
  ["kept in the recovery file", false],
  ["kept only in the workspace", true],
] as const) {
  test(`when the recording cannot be written either, the recorder stops and still names a refreshed sign-in ${label}`, async () => {
    const { database, env } = await seedHome();
    const kept = recoveryFileFor(database);
    if (blockRecovery) {
      fs.mkdirSync(kept);
      fs.writeFileSync(path.join(kept, "occupied"), "");
    }
    // The output directory is a file: no recording can be written there.
    const outDir = path.join(fs.mkdtempSync(path.join(DIRECTORY, "out-file-")), "not-a-directory");
    fs.writeFileSync(outDir, "");
    // OpenCode refreshes the copy while another OpenCode changes the user's row.
    const { outcomes } = await recordWithSignInChanges(
      env,
      ["simple", "multi_turn"],
      async (_number, copy) => {
        await setCredential(copy, "crd_0001", "refreshed-by-the-recorded-server");
        await setCredential(database, "crd_0001", "changed-by-another-opencode");
      },
      false,
      outDir,
    );
    assert.equal(outcomes.length, 1, "the run stopped: no other scenario ran");
    const [outcome] = outcomes;
    try {
      assert.equal(outcome!.file, undefined, "no recording was written");
      const failures = failuresOf(outcome!);
      assert.ok(
        failures.some((failure) => failure instanceof RecordingNotWrittenError && failure.file === path.join(outDir, "simple.ndjson")),
        `the write's failure is reported: ${outcome!.error?.message}`,
      );
      const message = outcome!.error!.message;
      const ending = describeOpencodeRun(outcomes, outDir).join("\n");
      if (blockRecovery) {
        assert.equal(outcome!.workspaceKept, true);
        assert.ok(message.includes(`the recorder kept the workspace ${outcome!.workspace}`), message);
        assert.ok(ending.includes(outcome!.workspace), ending);
      } else {
        assert.equal(outcome!.recoveryFile, kept);
        assert.ok(message.includes(`it kept the refreshed value(s) in ${kept}`), message);
        assert.ok(ending.includes(kept), ending);
        assert.deepEqual(JSON.parse(fs.readFileSync(kept, "utf8")), [{ id: "crd_0001", value: "refreshed-by-the-recorded-server" }]);
      }
    } finally {
      if (outcome?.workspaceKept === true) fs.rmSync(outcome.workspace, { recursive: true, force: true });
    }
  });
}

test("without a database of the user's the recorder copies nothing and creates nothing in the user's data directory", async () => {
  const home = fs.mkdtempSync(path.join(DIRECTORY, "no-database-"));
  const { outcomes } = await recordInProcess({ HOME: home, ARI_RECORD_OPENCODE_MODEL: "fake/fake-small" }, ["simple"]);
  assert.equal(outcomes[0]!.error, undefined, outcomes[0]!.error?.message);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("the user's database is where OpenCode 2.1.2 looks: OPENCODE_DB, in $XDG_DATA_HOME/opencode, else ~/.local/share/opencode", () => {
  assert.equal(opencodeDataDirectory({ HOME: "/u" }), path.join("/u", ".local", "share", "opencode"));
  assert.equal(opencodeDataDirectory({ HOME: "/u", XDG_DATA_HOME: "/x" }), path.join("/x", "opencode"));
  assert.equal(userDatabaseFile({ HOME: "/u" }), path.join("/u", ".local", "share", "opencode", "opencode.db"));
  assert.equal(userDatabaseFile({ HOME: "/u", OPENCODE_DB: "other.db" }), path.join("/u", ".local", "share", "opencode", "other.db"));
  assert.equal(userDatabaseFile({ HOME: "/u", OPENCODE_DB: "/elsewhere/db.sqlite" }), "/elsewhere/db.sqlite");
  assert.equal(userDatabaseFile({ HOME: "/u", OPENCODE_DB: ":memory:" }), undefined);
});

test("the server's environment drops HOME, the XDG base directories and every OPENCODE_* variable of the recorder's, and keeps the rest", () => {
  const layout = { root: "/w", cwd: "/w/cwd", home: "/w/opencode-home", configHome: "/w/xdg-config", dataHome: "/w/xdg-data", stateHome: "/w/xdg-state", cacheHome: "/w/xdg-cache" };
  const env = opencodeServeEnvironment(layout, { PATH: "/bin", HOME: "/u", XDG_CONFIG_HOME: "/u/c", XDG_RUNTIME_DIR: "/run/u", ANTHROPIC_API_KEY: "k", OPENCODE_CONFIG: "/u/x.json", OPENCODE_DB: "d", OPENCODE_SERVER_PASSWORD: "p" }, "pw");
  assert.deepEqual(env, {
    PATH: "/bin",
    XDG_RUNTIME_DIR: "/run/u",
    ANTHROPIC_API_KEY: "k",
    HOME: "/w/opencode-home",
    XDG_CONFIG_HOME: "/w/xdg-config",
    XDG_DATA_HOME: "/w/xdg-data",
    XDG_STATE_HOME: "/w/xdg-state",
    XDG_CACHE_HOME: "/w/xdg-cache",
    OPENCODE_PASSWORD: "pw",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
  });
});

// The model.

for (const [label, model, why] of [
  ["without ARI_RECORD_OPENCODE_MODEL", undefined, /ARI_RECORD_OPENCODE_MODEL is not set\. Set it to one of the models the OpenCode server offers:/],
  ["when ARI_RECORD_OPENCODE_MODEL names a model the server does not offer", "fake/not-offered", /ARI_RECORD_OPENCODE_MODEL names fake\/not-offered, which the OpenCode server does not offer\. It offers:/],
] as const) {
  test(`${label}, the recorder stops before the first prompt and prints the models the server offers`, async () => {
    const home = fs.mkdtempSync(path.join(DIRECTORY, "model-"));
    const { outDir, outcomes, servers, log } = await recordInProcess({ HOME: home, ...(model === undefined ? {} : { ARI_RECORD_OPENCODE_MODEL: model }) }, ["simple", "multi_turn"]);
    assert.equal(outcomes.length, 1, "the recorder stopped: no other scenario ran");
    const error = outcomes[0]!.error;
    assert.ok(error instanceof OpencodeModelChoiceError, String(error));
    assert.match(error.message, why);
    assert.deepEqual(error.models, ["fake/fake-small", "fake/fake-large"]);
    assert.ok(log.some((line) => line.includes("\n  fake/fake-small\n  fake/fake-large")), `the recorder printed the models: ${log.join("\n")}`);
    assert.deepEqual(
      servers[0]!.world.frames.filter((frame) => frame.direction === "request").map((frame) => frame.operation),
      ["server.info", "model.list"],
      "the server got no prompt, nor any other request but the recorder's questions",
    );
    assert.deepEqual(fs.readdirSync(outDir), [], "nothing recorded");
    assert.ok(!fs.existsSync(outcomes[0]!.workspace));
  });
}
