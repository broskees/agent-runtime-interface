// The Codex recorder (scripts/record-codex.ts and the recording function it
// calls) runs only when asked, keeps the user's own Codex setup out of the
// recorded `codex` and unchanged, never loses a sign-in `codex` refreshed (a
// ChatGPT refresh token rotates), and records with the model it was asked for
// or its documented default. Every run here is against the fake `codex` on
// PATH.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { LIVE_RECORD_VARIABLE, parseRecordArguments } from "../../../scripts/record-claude.ts";
import { DEFAULT_CODEX_RECORDINGS } from "../../../scripts/record-codex.ts";
import { buildChildEnvironment } from "../../../src/node/process.ts";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { readRecording } from "../../recordings/format.ts";
import { CODEX_SIGN_IN_FILE, userCodexHome, userSignInFile, workspaceSignInFile } from "../../recordings/codex/credentials.ts";
import { CodexModelChoiceError, CodexSignInMissingError, CodexWorkspaceCustomizedError, CodexWorkspaceInHomeError, codexEnvironment, defaultCodexModel, describeCodexRun, failuresOf, recordCodex } from "../../recordings/codex/record.ts";
import type { CodexRecordOutcome } from "../../recordings/codex/record.ts";
import { replayCodex } from "../../recordings/codex/replay.ts";
import { CODEX_RECORDER_ENV_POLICY, createCodexLayout } from "../../recordings/codex/run.ts";
import { RecordingNotWrittenError, recoveryFileFor } from "../../recordings/recovery.ts";
import { SCENARIO_NAMES } from "../../recordings/scenarios.ts";
import type { ScenarioName } from "../../recordings/scenarios.ts";
import { FAKE_CODEX_RECORDER_MODELS, FAKE_SIGN_IN, fakeCodexOnPath } from "./fake-codex.ts";
import type { FakeCodex, FakeCodexProcess } from "./fake-codex.ts";
import { codexSetupSources, loadedCodexSetup } from "./user-setup.ts";

const DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), "ari-codex-recorder-"));
process.on("exit", () => fs.rmSync(DIRECTORY, { recursive: true, force: true }));

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Running the recorder script.

/** A module that records every resolution of the recorder's or the driver's modules and traps every child_process function, and reports both when the process exits. */
const TRAP = `
import { registerHooks, createRequire, syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
const resolved = [];
const spawned = [];
registerHooks({
  resolve(specifier, context, next) {
    if (/recordings\\/(codex|stdio)\\/|drivers\\/codex\\//.test(specifier)) resolved.push(specifier);
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

test("the trap sees a resolution of the Codex recorder's modules and a spawn when a program makes them", () => {
  const probe = runTrapped(["--input-type=module", "-e", `await import("./test/recordings/codex/credentials.ts"); try { (await import("node:child_process")).spawn("true"); } catch {}`], {});
  assert.deepEqual(probe.resolved, ["./test/recordings/codex/credentials.ts"]);
  assert.deepEqual(probe.spawned, ["spawn true"]);
});

test(`node scripts/record-codex.ts without ${LIVE_RECORD_VARIABLE}=1 exits non-zero naming the variable, before it loads the recorder or the driver, or spawns anything`, () => {
  const environments: Array<{ [name: string]: string }> = [{}, { [LIVE_RECORD_VARIABLE]: "0" }, { [LIVE_RECORD_VARIABLE]: "true" }, { [LIVE_RECORD_VARIABLE]: "" }, { ARI_RECORD_CODEX_MODEL: "fake-luna" }];
  for (const env of environments) {
    for (const args of [["scripts/record-codex.ts"], ["scripts/record-codex.ts", "simple", "--out", "elsewhere"]]) {
      const run = runTrapped(args, env);
      assert.equal(run.status, 2, `${JSON.stringify(env)} ${args.join(" ")}: ${run.stderr}`);
      assert.match(run.stderr, /record-codex: refusing to start the real Codex CLI/);
      assert.match(run.stderr, new RegExp(`set ${LIVE_RECORD_VARIABLE}=1 to run it`));
      assert.deepEqual(run.resolved, [], "neither the recorder nor the driver was loaded");
      assert.deepEqual(run.spawned, [], "nothing was spawned");
    }
  }
});

test(`the record:codex script runs the recorder, and no package.json script and no CI workflow step sets ${LIVE_RECORD_VARIABLE}`, () => {
  const scripts = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["record:codex"], "node scripts/record-codex.ts");
  for (const [name, command] of Object.entries(scripts)) assert.ok(!command.includes(LIVE_RECORD_VARIABLE), `script ${name} sets ${LIVE_RECORD_VARIABLE}`);
  const workflows = fs.readdirSync(path.join(REPO_ROOT, ".github", "workflows")).filter((name) => name.endsWith(".yml"));
  assert.ok(workflows.length >= 2, workflows.join(", "));
  for (const workflow of workflows) assert.ok(!fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", workflow), "utf8").includes(LIVE_RECORD_VARIABLE), `${workflow} sets ${LIVE_RECORD_VARIABLE}`);
});

test("the Codex recorder takes the arguments of record:claude, and writes to test/drivers/codex/recordings/ by default", () => {
  assert.equal(DEFAULT_CODEX_RECORDINGS, path.join(REPO_ROOT, "test", "drivers", "codex", "recordings"));
  assert.deepEqual(parseRecordArguments(["resume", "simple", "--out", "/tmp/somewhere"], SCENARIO_NAMES, DEFAULT_CODEX_RECORDINGS), { scenarios: ["resume", "simple"], outDir: "/tmp/somewhere" });
});

// The user's Codex setup.

const MARKERS = {
  config: "marker-codex-config-5d1a",
  mcp: "marker-codex-mcp-8e40",
  plugin: "marker-codex-plugin-2b97",
  memory: "marker-codex-memory-c3f1",
  agents: "marker-codex-agents-md-71e2",
  agentsOverride: "marker-codex-agents-override-4a08",
  skill: "marker-codex-skill-90bd",
  rule: "marker-codex-rule-e6c5",
  goal: "marker-codex-goal-13f7",
  homeSkill: "marker-codex-home-skill-58a2",
  signIn: "marker-codex-sign-in-0c6e",
} as const;

const SIGN_IN = JSON.stringify({ ...(JSON.parse(FAKE_SIGN_IN) as object), tokens: { id_token: "fake-id-token", access_token: `fake-access-${MARKERS.signIn}`, refresh_token: "fake-refresh-0001", account_id: "fake-account" } }, null, 2);

/**
 * A temp HOME holding the user's `~/.codex` (a config.toml with settings, an
 * MCP entry and an enabled plugin; the plugin; a memory; AGENTS.md and
 * AGENTS.override.md; a skill; a rule; the state database that keeps thread
 * goals) and `~/.agents/skills`, each with its own marker, and the user's
 * sign-in file.
 */
function seedHome(): { home: string; env: { [name: string]: string }; files: Map<string, Buffer>; signIn: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(DIRECTORY, "user-home-")));
  const codex = path.join(home, ".codex");
  const signIn = path.join(codex, CODEX_SIGN_IN_FILE);
  const contents: { [file: string]: string } = {
    [path.join(codex, "config.toml")]: `model = "${MARKERS.config}"\nmodel_reasoning_effort = "high"\n\n[mcp_servers.${MARKERS.mcp}]\ncommand = "${MARKERS.mcp}"\n\n[plugins."marker@openai-curated"]\nenabled = true\n`,
    [path.join(codex, "plugins", "cache", "openai-curated", "marker", ".codex-plugin", "plugin.json")]: JSON.stringify({ name: "marker", description: MARKERS.plugin }),
    [path.join(codex, "memories", "MEMORY.md")]: `Remember ${MARKERS.memory}.\n`,
    [path.join(codex, "AGENTS.md")]: `Always answer with ${MARKERS.agents}.\n`,
    [path.join(codex, "AGENTS.override.md")]: `Always answer with ${MARKERS.agentsOverride}.\n`,
    [path.join(codex, "skills", "marker", "SKILL.md")]: `---\nname: marker\ndescription: ${MARKERS.skill}\n---\n`,
    [path.join(codex, "rules", "default.rules")]: `prefix_rule(pattern = ["${MARKERS.rule}"], decision = "allow")\n`,
    [path.join(codex, "state_5.sqlite")]: `a goal: ${MARKERS.goal}\n`,
    [path.join(home, ".agents", "skills", "marker", "SKILL.md")]: `---\nname: marker\ndescription: ${MARKERS.homeSkill}\n---\n`,
    [signIn]: SIGN_IN,
  };
  for (const [file, text] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o600 });
  }
  const files = new Map<string, Buffer>();
  for (const file of Object.keys(contents)) files.set(file, fs.readFileSync(file));
  // Variables a user may have that point codex at their own setup and sign-in, or change how it signs in.
  const env = {
    HOME: home,
    CODEX_HOME: codex,
    CODEX_SQLITE_HOME: codex,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    OPENAI_API_KEY: "sk-fake-openai-api-key-00000000000001",
    OPENAI_BASE_URL: "https://openai.example.invalid/v1",
    CODEX_ACCESS_TOKEN: "fake-codex-access-token-0001",
  };
  return { home, env, files, signIn };
}

/** The config.toml the recorder gives the recorded codex in its own Codex home. */
const RECORDER_CONFIG = 'cli_auth_credentials_store = "file"\nmcp_oauth_credentials_store = "file"\n';

/** A directory to stand in for /etc/codex, holding `files`; none of the system's own files reach a test. */
function systemConfigDir(files: { readonly [name: string]: string } = {}): string {
  const directory = fs.mkdtempSync(path.join(DIRECTORY, "etc-codex-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
  return directory;
}

/** Records `scenarios` with the recorder's own process service, against a fresh fake `codex` on PATH, with an empty stand-in for /etc/codex unless `systemConfigDir` names one. */
async function recordWithFake(env: { [name: string]: string }, scenarios: readonly ScenarioName[], options: { source?: "fake" | "live"; outDir?: string; systemConfigDir?: string } = {}): Promise<{ outDir: string; outcomes: CodexRecordOutcome[]; fake: FakeCodex; log: string[] }> {
  const fake = fakeCodexOnPath(DIRECTORY);
  const outDir = options.outDir ?? fs.mkdtempSync(path.join(DIRECTORY, "out-"));
  const log: string[] = [];
  const outcomes = await recordCodex({
    scenarios,
    outDir,
    source: options.source ?? "fake",
    env: { PATH: `${fake.bin}${path.delimiter}${process.env["PATH"] ?? "/usr/bin:/bin"}`, USER: "ari-test-user", ...fake.env, ...env },
    timeoutMs: 20_000,
    log: (line) => log.push(line),
    systemConfigDir: options.systemConfigDir ?? systemConfigDir(),
  });
  return { outDir, outcomes, fake, log };
}

test("the fake codex, given the user's own environment, loads every seeded setting, MCP entry, plugin, memory, instruction, skill, rule and goal, so a leak would show", () => {
  const { home, env } = seedHome();
  const loaded = loadedCodexSetup(env, path.join(home, "project")).join("\n");
  for (const marker of Object.values(MARKERS).filter((marker) => marker !== MARKERS.signIn)) assert.ok(loaded.includes(marker), `the fake loads ${marker}`);
  assert.ok(!loaded.includes(MARKERS.signIn), "the sign-in is not setup");
  // Without CODEX_HOME it looks in ~/.codex, as Codex does.
  const ambient = loadedCodexSetup({ HOME: home }, path.join(home, "project")).join("\n");
  assert.ok(ambient.includes(MARKERS.agents) && ambient.includes(MARKERS.mcp));
});

test("the recorder starts codex with a CODEX_HOME, HOME, XDG directories, TMPDIR and working directory inside its own temp dir and none of the user's CODEX_ or OPENAI_ variables: nothing of the user's Codex setup reaches codex or the recording, and every seeded file is byte-identical afterwards", async () => {
  const { home, env, files, signIn } = seedHome();
  const codexHomeBefore = fs.readdirSync(path.dirname(signIn)).sort();
  const { outDir, outcomes, fake } = await recordWithFake(env, SCENARIO_NAMES);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.scenario, outcome.error?.message]),
    SCENARIO_NAMES.map((name) => [name, undefined]),
  );
  const processes = fake.processes();
  assert.equal(processes.filter((each) => each.args[0] === "--version").length, outcomes.length, "one codex --version per scenario, for the header");
  assert.equal(processes.filter((each) => each.args[0] === "app-server").length, 13, "one app-server per session, and one per scenario for the model listing");
  const scenarioOf = (started: FakeCodexProcess): CodexRecordOutcome => {
    const outcome = outcomes.find((each) => started.cwd.startsWith(`${each.workspace}${path.sep}`));
    assert.ok(outcome !== undefined, `codex started in a scenario's workspace: ${started.cwd} (${started.args.join(" ")})`);
    return outcome;
  };
  for (const started of processes) {
    const workspace = scenarioOf(started).workspace;
    assert.equal(started.cwd, path.join(workspace, "cwd"), "codex works in the workspace, not in the recorder's directory");
    assert.deepEqual(
      { CODEX_HOME: started.env["CODEX_HOME"], HOME: started.env["HOME"], XDG_CONFIG_HOME: started.env["XDG_CONFIG_HOME"], XDG_DATA_HOME: started.env["XDG_DATA_HOME"], XDG_STATE_HOME: started.env["XDG_STATE_HOME"], XDG_CACHE_HOME: started.env["XDG_CACHE_HOME"], XDG_RUNTIME_DIR: started.env["XDG_RUNTIME_DIR"], TMPDIR: started.env["TMPDIR"] },
      { CODEX_HOME: path.join(workspace, "codex-home"), HOME: path.join(workspace, "user-home"), XDG_CONFIG_HOME: path.join(workspace, "xdg-config"), XDG_DATA_HOME: path.join(workspace, "xdg-data"), XDG_STATE_HOME: path.join(workspace, "xdg-state"), XDG_CACHE_HOME: path.join(workspace, "xdg-cache"), XDG_RUNTIME_DIR: path.join(workspace, "xdg-runtime"), TMPDIR: path.join(workspace, "tmp") },
      `${started.args.join(" ")}: codex's own directories`,
    );
    assert.deepEqual(
      Object.keys(started.env).filter((name) => /^(CODEX_|OPENAI_)/.test(name)),
      ["CODEX_HOME"],
      `${started.args.join(" ")}: none of the user's CODEX_ or OPENAI_ variables, only the recorder's CODEX_HOME`,
    );
    assert.equal(started.env["DBUS_SESSION_BUS_ADDRESS"], `unix:path=${path.join(workspace, "no-session-bus")}`, `${started.args.join(" ")}: a session bus where nothing listens, not the user's`);
    if (started.args[0] !== "app-server") continue;
    for (const source of codexSetupSources(started.env, started.cwd)) assert.ok(!source.startsWith(`${home}${path.sep}`), `codex would read ${source}`);
    assert.deepEqual(started.loaded, [`${path.join(workspace, "codex-home", "config.toml")}: ${RECORDER_CONFIG}`], "codex loaded nothing of the user's setup, only the recorder's own config");
    assert.equal(started.signIn, SIGN_IN, "codex got the user's sign-in");
    assert.equal(started.signInFile, workspaceSignInFile(path.join(workspace, "codex-home")));
  }
  for (const outcome of outcomes) {
    const text = fs.readFileSync(outcome.file!, "utf8");
    for (const marker of Object.values(MARKERS)) assert.ok(!text.includes(marker), `${outcome.scenario}'s recording holds ${marker}`);
    assert.ok(!text.includes(home), `${outcome.scenario}'s recording holds the user's HOME`);
    assert.ok(!text.includes("fake-refresh-0001") && !text.includes("sk-fake-openai") && !text.includes("fake-codex-access-token"), `${outcome.scenario}'s recording holds a sign-in`);
    assert.ok(!fs.existsSync(outcome.workspace), `${outcome.scenario}: the temp dir is removed`);
    await replayCodex(outcome.file!);
  }
  // Every thread/resume names the recorder's tool server with an Authorization header, so Codex's MCP client looks up no OAuth credentials for it in any store before it connects.
  const resumes = (await readRecording(outcomes.find((outcome) => outcome.scenario === "resume")!.file!)).frames
    .map(({ frame }) => frame["message"] as { method?: string; params?: { config?: { [key: string]: unknown } } } | undefined)
    .filter((message) => message?.method === "thread/resume");
  assert.ok(resumes.length > 0, "the resume scenario resumed a thread");
  for (const message of resumes) assert.deepEqual(message!.params?.config?.["mcp_servers.ari-recorder-tools"], { url: "http://127.0.0.1:9/ari-recorder/no-tools", http_headers: { Authorization: "Bearer none" } });
  for (const [file, bytes] of files) assert.ok(fs.readFileSync(file).equals(bytes), `${file} changed`);
  assert.deepEqual(fs.readdirSync(path.dirname(signIn)).sort(), codexHomeBefore, "the recorder added nothing to the user's Codex home, not even Codex's lock file: nothing was refreshed");
  assert.ok(!fs.existsSync(recoveryFileFor(signIn)), "no recovery file: nothing was refreshed");
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("codex's environment is the recorder's less HOME, the XDG directories and TMPDIR, plus the workspace's; the host then strips every CODEX_ and OPENAI_ variable", () => {
  const layout = createCodexLayout("ari-codex-environment-");
  try {
    const user = { PATH: "/usr/bin", LANG: "C.UTF-8", HOME: "/home/someone", XDG_CONFIG_HOME: "/home/someone/.config", XDG_RUNTIME_DIR: "/run/user/1000", TMPDIR: "/var/tmp/someone", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", CODEX_HOME: "/home/someone/.codex", CODEX_SQLITE_HOME: "/home/someone/.codex", OPENAI_API_KEY: "key", OPENAI_BASE_URL: "https://example.invalid", CODEX_ACCESS_TOKEN: "token", CODEX_API_KEY: "key" };
    const environment = codexEnvironment(layout, user);
    assert.equal(environment["LANG"], "C.UTF-8");
    assert.equal(environment["HOME"], layout.home);
    assert.equal(environment["XDG_RUNTIME_DIR"], layout.runtimeDir);
    assert.equal(environment["TMPDIR"], layout.tmp);
    assert.equal(environment["DBUS_SESSION_BUS_ADDRESS"], `unix:path=${path.join(layout.root, "no-session-bus")}`, "the user's session bus, and the Secret Service of their keyring on it, is out of reach");
    assert.ok(!fs.existsSync(path.join(layout.root, "no-session-bus")), "nothing listens there");
    assert.equal(fs.readFileSync(path.join(layout.codexHome, "config.toml"), "utf8"), RECORDER_CONFIG, "codex's own config keeps the CLI sign-in and MCP credentials in files of its own home");
    const child = buildChildEnvironment(environment, CODEX_RECORDER_ENV_POLICY);
    assert.deepEqual(Object.keys(child).filter((name) => /^(CODEX_|OPENAI_)/.test(name)), []);
    assert.equal(child["PATH"], "/usr/bin");
    // The recorder adds its own CODEX_HOME after the stripping (codexProcessService).
    assert.deepEqual(buildChildEnvironment(environment, CODEX_RECORDER_ENV_POLICY, { CODEX_HOME: layout.codexHome })["CODEX_HOME"], layout.codexHome);
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

// The sign-in.

test("the user's sign-in file is auth.json in CODEX_HOME, else in ~/.codex, and the recorded codex finds its copy in the workspace's codex-home/", () => {
  assert.equal(userSignInFile({ HOME: "/srv/someone" }), "/srv/someone/.codex/auth.json");
  assert.equal(userSignInFile({ HOME: "/srv/someone", CODEX_HOME: "/elsewhere/codex" }), "/elsewhere/codex/auth.json");
  assert.equal(userSignInFile({ HOME: "/srv/someone", CODEX_HOME: "  " }), "/srv/someone/.codex/auth.json", "an empty CODEX_HOME counts as unset, as Codex counts it");
  assert.equal(userCodexHome({}), undefined);
  assert.equal(userSignInFile({}), undefined);
  assert.equal(workspaceSignInFile("/x/codex-home"), "/x/codex-home/auth.json");
});

/** The refresh token of an auth.json's text. */
function refreshTokenOf(text: string): unknown {
  return (JSON.parse(text) as { tokens?: { refresh_token?: unknown } }).tokens?.refresh_token;
}

test("a refresh token codex rotates during the run goes back to the user's file, and the temp dir is removed", async () => {
  const { env, signIn } = seedHome();
  const { outcomes, fake } = await recordWithFake({ ...env, ARI_FAKE_CODEX_ROTATE: "fake-refresh-0002" }, ["simple"]);
  assert.equal(outcomes[0]!.error, undefined, outcomes[0]!.error?.message);
  assert.ok(fake.processes().filter((each) => each.args[0] === "app-server").every((each) => each.signIn === SIGN_IN), "codex started with the user's sign-in");
  assert.equal(refreshTokenOf(fs.readFileSync(signIn, "utf8")), "fake-refresh-0002", "the user's file holds the rotated refresh token");
  assert.equal(fs.statSync(signIn).mode & 0o777, 0o600, "and stays readable only by the user");
  assert.ok(!fs.existsSync(outcomes[0]!.workspace), "the temp dir, with its copy of the sign-in, is removed");
  assert.ok(!fs.readFileSync(outcomes[0]!.file!, "utf8").includes("fake-refresh"), "the recording holds no sign-in");
});

test("after a run that fails, the rotated refresh token still goes back and the temp dir is still removed", async () => {
  const { env, signIn } = seedHome();
  const { outcomes } = await recordWithFake({ ...env, ARI_FAKE_CODEX_ROTATE: "fake-refresh-0003", ARI_FAKE_CODEX_CRASH: "1" }, ["approval_allowed"]);
  assert.ok(outcomes[0]!.error !== undefined, "the scenario failed: codex died in its first turn");
  assert.equal(refreshTokenOf(fs.readFileSync(signIn, "utf8")), "fake-refresh-0003");
  assert.ok(!fs.existsSync(outcomes[0]!.workspace), "the temp dir is removed");
});

test("when the user's sign-in also changed during the run, the recorder leaves it as it is, keeps the rotated sign-in in the run's recovery file and reports the scenario failed", async () => {
  const { env, signIn } = seedHome();
  const { outDir, outcomes } = await recordWithFake({ ...env, ARI_FAKE_CODEX_ROTATE: "fake-refresh-rotated-by-the-recorded-codex", ARI_FAKE_CODEX_TOUCH: signIn, ARI_FAKE_CODEX_TOUCH_VALUE: "changed-by-another-codex" }, ["simple"]);
  const kept = recoveryFileFor(signIn);
  assert.match(outcomes[0]!.error?.message ?? "", new RegExp(`${escape(signIn)} changed while the recorder ran, and codex also refreshed the recorder's copy; the recorder left ${escape(signIn)} as it is; it kept the refreshed sign-in in ${escape(kept)}`));
  assert.equal(fs.readFileSync(signIn, "utf8"), "changed-by-another-codex");
  assert.equal(outcomes[0]!.recoveryFile, kept);
  assert.equal(kept, `${signIn}.ari-recorder-refreshed-${process.pid}.json`);
  const records = JSON.parse(fs.readFileSync(kept, "utf8")) as Array<{ id: string; value: string }>;
  assert.deepEqual(records.map((record) => record.id), [CODEX_SIGN_IN_FILE]);
  assert.equal(refreshTokenOf(records[0]!.value), "fake-refresh-rotated-by-the-recorded-codex", "the rotated refresh token is not lost");
  assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(outcomes[0]!.workspace));
  assert.equal(describeCodexRun(outcomes, outDir).filter((line) => line.includes(kept)).length, 1, "the run's last lines name the recovery file");
});

test("rotated sign-ins that cannot go back in two scenarios both survive in the run's recovery file", async () => {
  const { env, signIn } = seedHome();
  const kept = recoveryFileFor(signIn);
  const first = await recordWithFake({ ...env, ARI_FAKE_CODEX_ROTATE: "fake-refresh-rotated-1", ARI_FAKE_CODEX_TOUCH: signIn, ARI_FAKE_CODEX_TOUCH_VALUE: "changed-1" }, ["simple"]);
  // The second scenario starts from the user's file as it is now: the other codex's value, which the fake cannot parse, so seed it again.
  fs.writeFileSync(signIn, SIGN_IN, { mode: 0o600 });
  const second = await recordWithFake({ ...env, ARI_FAKE_CODEX_ROTATE: "fake-refresh-rotated-2", ARI_FAKE_CODEX_TOUCH: signIn, ARI_FAKE_CODEX_TOUCH_VALUE: "changed-2" }, ["multi_turn"]);
  assert.equal(first.outcomes[0]!.recoveryFile, kept);
  assert.equal(second.outcomes[0]!.recoveryFile, kept);
  const [record] = JSON.parse(fs.readFileSync(kept, "utf8")) as Array<{ id: string; value: string; olderValues: string[] }>;
  assert.equal(record!.id, CODEX_SIGN_IN_FILE);
  assert.equal(refreshTokenOf(record!.value), "fake-refresh-rotated-2");
  assert.deepEqual(record!.olderValues.map(refreshTokenOf), ["fake-refresh-rotated-1"]);
});

test("when the recorder cannot write a rotated sign-in back, it keeps it in the recovery file beside the user's file and says where", async () => {
  const { env, signIn } = seedHome();
  // During the run the user's sign-in file becomes a directory: the recorder can neither read nor replace it.
  const { outcomes } = await recordWithFake({ ...env, ARI_FAKE_CODEX_ROTATE: "fake-refresh-rotated-by-the-recorded-codex", ARI_FAKE_CODEX_BREAK: signIn }, ["simple"]);
  const kept = recoveryFileFor(signIn);
  assert.match(outcomes[0]!.error?.message ?? "", new RegExp(`the recorder could not write the sign-in codex refreshed back to ${escape(signIn)} \\(.+\\); it kept the refreshed sign-in in ${escape(kept)}`));
  assert.equal(outcomes[0]!.recoveryFile, kept);
  const records = JSON.parse(fs.readFileSync(kept, "utf8")) as Array<{ id: string; value: string }>;
  assert.equal(refreshTokenOf(records[0]!.value), "fake-refresh-rotated-by-the-recorded-codex");
  assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(outcomes[0]!.workspace), "the temp dir is removed");
});

test("when the recovery file cannot take a rotated sign-in either, the recorder keeps the workspace with its copy, stops the run and names both", async () => {
  const { env, signIn } = seedHome();
  const kept = recoveryFileFor(signIn);
  // Nothing can be written where the recovery file goes.
  fs.mkdirSync(kept);
  fs.writeFileSync(path.join(kept, "occupied"), "");
  const { outDir, outcomes } = await recordWithFake({ ...env, ARI_FAKE_CODEX_ROTATE: "fake-refresh-rotated-by-the-recorded-codex", ARI_FAKE_CODEX_TOUCH: signIn, ARI_FAKE_CODEX_TOUCH_VALUE: "changed-by-another-codex" }, ["simple", "multi_turn"]);
  assert.equal(outcomes.length, 1, "the run stopped: no other scenario ran");
  const [outcome] = outcomes;
  const copy = workspaceSignInFile(path.join(outcome!.workspace, "codex-home"));
  try {
    assert.equal(outcome!.workspaceKept, true);
    assert.equal(outcome!.recoveryFile, undefined);
    assert.equal(refreshTokenOf(fs.readFileSync(copy, "utf8")), "fake-refresh-rotated-by-the-recorded-codex", "the workspace with its copy of the rotated sign-in is kept");
    const message = outcome!.error?.message ?? "";
    assert.match(message, new RegExp(`could not keep the refreshed sign-in in ${escape(kept)} either`));
    assert.match(message, new RegExp(`only in the recorder's copy, ${escape(copy)}`));
    assert.match(message, new RegExp(`the recorder kept the workspace ${escape(outcome!.workspace)}`));
    const ending = describeCodexRun(outcomes, outDir);
    assert.ok(ending.some((line) => line.includes(outcome!.workspace)), "the run's last lines name the kept workspace");
  } finally {
    fs.rmSync(outcome!.workspace, { recursive: true, force: true });
  }
});

for (const [label, blockRecovery] of [
  ["kept in the recovery file", false],
  ["kept only in the workspace", true],
] as const) {
  test(`when the recording cannot be written either, the Codex recorder stops and still names a rotated sign-in ${label}`, async () => {
    const { env, signIn } = seedHome();
    const kept = recoveryFileFor(signIn);
    if (blockRecovery) {
      fs.mkdirSync(kept);
      fs.writeFileSync(path.join(kept, "occupied"), "");
    }
    // The output directory is a file: no recording can be written there.
    const outDir = path.join(fs.mkdtempSync(path.join(DIRECTORY, "out-file-")), "not-a-directory");
    fs.writeFileSync(outDir, "");
    const { outcomes } = await recordWithFake({ ...env, ARI_FAKE_CODEX_ROTATE: "fake-refresh-rotated-by-the-recorded-codex", ARI_FAKE_CODEX_TOUCH: signIn, ARI_FAKE_CODEX_TOUCH_VALUE: "changed-by-another-codex" }, ["simple", "multi_turn"], { outDir });
    assert.equal(outcomes.length, 1, "the run stopped: no other scenario ran");
    const [outcome] = outcomes;
    try {
      assert.equal(outcome!.file, undefined, "no recording was written");
      assert.ok(failuresOf(outcome!).some((failure) => failure instanceof RecordingNotWrittenError && failure.file === path.join(outDir, "simple.ndjson")), outcome!.error?.message);
      const ending = describeCodexRun(outcomes, outDir).join("\n");
      if (blockRecovery) {
        assert.equal(outcome!.workspaceKept, true);
        assert.ok(ending.includes(outcome!.workspace), ending);
      } else {
        assert.equal(outcome!.recoveryFile, kept);
        assert.ok(ending.includes(kept), ending);
        const records = JSON.parse(fs.readFileSync(kept, "utf8")) as Array<{ id: string; value: string }>;
        assert.equal(refreshTokenOf(records[0]!.value), "fake-refresh-rotated-by-the-recorded-codex");
      }
    } finally {
      if (outcome?.workspaceKept === true) fs.rmSync(outcome.workspace, { recursive: true, force: true });
    }
  });
}

test("a live run without the user's sign-in file stops before it starts codex, naming the file, and records nothing", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(DIRECTORY, "no-sign-in-")));
  const { outcomes, fake } = await recordWithFake({ HOME: home }, ["simple", "multi_turn"], { source: "live" });
  assert.equal(outcomes.length, 1, "the run stopped");
  assert.ok(outcomes[0]!.error instanceof CodexSignInMissingError, outcomes[0]!.error?.message);
  assert.ok(outcomes[0]!.error!.message.includes(path.join(home, ".codex", CODEX_SIGN_IN_FILE)));
  assert.match(outcomes[0]!.error!.message, /cli_auth_credentials_store/);
  assert.equal(outcomes[0]!.file, undefined);
  assert.deepEqual(fake.processes(), [], "codex never started");
  assert.ok(!fs.existsSync(outcomes[0]!.workspace));
});

// Where the user's Codex keeps its sign-in: cli_auth_credentials_store.

/** Puts `line` at the top of the user's config.toml, before its first table, where Codex reads top-level settings. */
function setTopLevel(configToml: string, line: string): void {
  fs.writeFileSync(configToml, `${line}\n${fs.readFileSync(configToml, "utf8")}`);
}

/** What a run that must stop at the store check shows: it stopped at once with a CodexCredentialStoreError naming `file` and `setting`, started no codex, recorded nothing and changed none of the user's files. */
function assertStoppedAtStore(run: { outcomes: CodexRecordOutcome[]; fake: FakeCodex; outDir: string }, files: Map<string, Buffer>, file: string, setting: string, change: RegExp): void {
  assert.equal(run.outcomes.length, 1, "the run stopped");
  const error = run.outcomes[0]!.error;
  assert.equal(error?.name, "CodexCredentialStoreError", error?.message);
  assert.ok(error!.message.startsWith(`${file}, `), error!.message);
  assert.ok(error!.message.includes(`sets ${setting}, so your Codex keeps its sign-in `), error!.message);
  assert.ok(/ The recorder copies only \S+auth\.json and never reads your keyring, so it stopped before it started codex\. /.test(error!.message), error!.message);
  assert.match(error!.message, change);
  assert.deepEqual(run.fake.processes(), [], "codex never started");
  assert.deepEqual(fs.readdirSync(run.outDir), [], "nothing recorded");
  assert.ok(!fs.existsSync(run.outcomes[0]!.workspace), "the workspace is removed");
  for (const [each, bytes] of files) assert.ok(fs.readFileSync(each).equals(bytes), `${each} changed`);
}

test("with auth.json present, cli_auth_credentials_store = keyring, auto or ephemeral in the user's config.toml stops the run before it starts codex, naming the setting, the file and what to do; file, or no setting, records", async () => {
  for (const store of ["keyring", "auto", "ephemeral"]) {
    const { env, files, signIn } = seedHome();
    const config = path.join(path.dirname(signIn), "config.toml");
    setTopLevel(config, `cli_auth_credentials_store = "${store}"`);
    files.set(config, fs.readFileSync(config));
    const run = await recordWithFake(env, ["simple", "multi_turn"]);
    assertStoppedAtStore(run, files, config, `cli_auth_credentials_store = "${store}"`, new RegExp(`To record, set cli_auth_credentials_store = "file" in ${escape(config)}, or remove the line, and sign in again with \`codex login\`, then record again\\.`));
    assert.ok(run.outcomes[0]!.error!.message.includes(`The recorder copies only ${signIn} and never reads your keyring`), run.outcomes[0]!.error!.message);
    if (store === "auto") assert.ok(run.outcomes[0]!.error!.message.includes(`keeps its sign-in in your OS keyring, and in ${signIn} only when the keyring fails`), run.outcomes[0]!.error!.message);
  }
  for (const line of ['cli_auth_credentials_store = "file"', "# cli_auth_credentials_store is not set"]) {
    const { env, signIn } = seedHome();
    setTopLevel(path.join(path.dirname(signIn), "config.toml"), line);
    const { outcomes, fake } = await recordWithFake(env, ["simple"]);
    assert.equal(outcomes[0]!.error, undefined, `${line}: ${outcomes[0]!.error?.message}`);
    assert.ok(fake.processes().length > 0, `${line}: codex started`);
  }
});

test("the system's /etc/codex files set the store too: a keyring or auto there stops the run before it starts codex, file records, and a requirement and the legacy managed_config.toml rank above the user's config.toml, the system config.toml below it", async () => {
  const roles = { "config.toml": "the system configuration", "requirements.toml": "a system requirement", "managed_config.toml": "the legacy managed configuration" } as const;
  for (const [name, role] of Object.entries(roles)) {
    for (const store of ["keyring", "auto"]) {
      const { env, files } = seedHome();
      const etc = systemConfigDir({ [name]: `# managed\ncli_auth_credentials_store = '${store}' # the machine's\n\n[otel]\nexporter = "none"\n` });
      const run = await recordWithFake(env, ["simple", "multi_turn"], { systemConfigDir: etc });
      assertStoppedAtStore(run, files, path.join(etc, name), `cli_auth_credentials_store = "${store}"`, new RegExp(`To record, set cli_auth_credentials_store = "file" in ${escape(path.join(etc, name))}, or remove the line \\(the file is the machine's, not yours: that needs root\\), and sign in again with \`codex login\`, then record again\\.`));
      assert.ok(run.outcomes[0]!.error!.message.includes(`${path.join(etc, name)}, ${role}, sets`), run.outcomes[0]!.error!.message);
    }
    const { env } = seedHome();
    const { outcomes, fake } = await recordWithFake(env, ["simple"], { systemConfigDir: systemConfigDir({ [name]: 'cli_auth_credentials_store = "file"\n' }) });
    assert.equal(outcomes[0]!.error, undefined, `${name} = file: ${outcomes[0]!.error?.message}`);
    assert.ok(fake.processes().length > 0, `${name} = file: codex started`);
  }
  // Which file wins: the requirement over the user's config.toml, the user's config.toml over the system config.toml, the legacy managed_config.toml over the user's.
  const ranked: Array<{ user: string; system: { [name: string]: string }; stopsAt?: string }> = [
    { user: "keyring", system: { "requirements.toml": 'cli_auth_credentials_store = "file"\n' } },
    { user: "file", system: { "config.toml": 'cli_auth_credentials_store = "keyring"\n' } },
    { user: "file", system: { "managed_config.toml": 'cli_auth_credentials_store = "keyring"\n' }, stopsAt: "managed_config.toml" },
    { user: "file", system: { "requirements.toml": 'cli_auth_credentials_store = "auto"\n', "managed_config.toml": 'cli_auth_credentials_store = "file"\n' }, stopsAt: "requirements.toml" },
  ];
  for (const each of ranked) {
    const { env, signIn } = seedHome();
    setTopLevel(path.join(path.dirname(signIn), "config.toml"), `cli_auth_credentials_store = "${each.user}"`);
    const etc = systemConfigDir(each.system);
    const { outcomes, fake } = await recordWithFake(env, ["simple"], { systemConfigDir: etc });
    const label = JSON.stringify(each);
    if (each.stopsAt === undefined) {
      assert.equal(outcomes[0]!.error, undefined, `${label}: ${outcomes[0]!.error?.message}`);
      assert.ok(fake.processes().length > 0, `${label}: codex started`);
    } else {
      assert.equal(outcomes[0]!.error?.name, "CodexCredentialStoreError", `${label}: ${outcomes[0]!.error?.message}`);
      assert.ok(outcomes[0]!.error!.message.startsWith(`${path.join(etc, each.stopsAt)}, `), `${label}: ${outcomes[0]!.error!.message}`);
      assert.deepEqual(fake.processes(), [], `${label}: codex never started`);
    }
  }
});

test("without flock on PATH, which takes Codex's own sign-in lock, the recorder stops before it starts codex and records nothing", async () => {
  const { env, files } = seedHome();
  const empty = fs.mkdtempSync(path.join(DIRECTORY, "no-flock-"));
  const run = await recordWithFake({ ...env, PATH: empty }, ["simple", "multi_turn"]);
  assert.equal(run.outcomes.length, 1, "the run stopped");
  const error = run.outcomes[0]!.error;
  assert.equal(error?.name, "CodexSignInLockError", error?.message);
  assert.match(error!.message, /the recorder could not run flock \(.+\), which it needs to take Codex's own lock, auth\.lock, when it puts a refreshed sign-in back; it stopped before it started codex\. Install util-linux's flock on PATH/);
  assert.deepEqual(run.fake.processes(), [], "codex never started");
  assert.deepEqual(fs.readdirSync(run.outDir), []);
  for (const [each, bytes] of files) assert.ok(fs.readFileSync(each).equals(bytes), `${each} changed`);
});

test("a temp workspace inside the user's home stops the run before it starts codex", async () => {
  // A home that holds the system temp directory, and so every workspace the recorder makes.
  const home = path.dirname(fs.realpathSync(os.tmpdir()));
  const { outcomes, fake } = await recordWithFake({ HOME: home }, ["simple", "multi_turn"]);
  assert.equal(outcomes.length, 1, "the run stopped");
  assert.ok(outcomes[0]!.error instanceof CodexWorkspaceInHomeError, outcomes[0]!.error?.message);
  assert.ok(outcomes[0]!.error!.message.includes(`inside your home ${home}`));
  assert.deepEqual(fake.processes(), [], "codex never started");
  assert.ok(!fs.existsSync(outcomes[0]!.workspace));
});

// Folders above the workspace, outside the user's home.

/** A Git project beside the user's home (`git init`), holding `files`, with an empty tmp/ to point TMPDIR at. */
function gitProject(files: { readonly [relative: string]: string }): string {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(DIRECTORY, "project-")));
  const init = spawnSync("git", ["init", "-q", project], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: project, GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(init.status, 0, init.stderr);
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, relative)), { recursive: true });
    fs.writeFileSync(path.join(project, relative), text);
  }
  fs.mkdirSync(path.join(project, "tmp"));
  return project;
}

/** Runs `run` with TMPDIR set to `directory`: the recorder makes its temp workspaces there. */
async function withTmpdir<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const before = process.env["TMPDIR"];
  process.env["TMPDIR"] = directory;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = before;
  }
}

test("the fake codex reads AGENTS.md, AGENTS.override.md, .codex/ and .agents/skills in the folder it works in and each folder above up to the project root, and only that folder outside a repository, as Codex's source says", () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(DIRECTORY, "lookup-")));
  const files: { [file: string]: string } = {
    [path.join(outside, "AGENTS.md")]: "marker-lookup-above-repository",
    [path.join(outside, "repo", "AGENTS.md")]: "marker-lookup-repository-root",
    [path.join(outside, "repo", "sub", ".codex", "config.toml")]: 'model = "marker-lookup-between"',
    [path.join(outside, "repo", "sub", "work", "AGENTS.override.md")]: "marker-lookup-workspace",
    [path.join(outside, "plain", "AGENTS.md")]: "marker-lookup-above-plain",
    [path.join(outside, "plain", "work", ".agents", "skills", "s", "SKILL.md")]: "marker-lookup-plain-workspace",
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  fs.mkdirSync(path.join(outside, "repo", ".git"));
  const inRepository = loadedCodexSetup({}, path.join(outside, "repo", "sub", "work")).join("\n");
  for (const marker of ["marker-lookup-repository-root", "marker-lookup-between", "marker-lookup-workspace"]) assert.ok(inRepository.includes(marker), marker);
  assert.ok(!inRepository.includes("marker-lookup-above-repository"));
  const outsideRepository = loadedCodexSetup({}, path.join(outside, "plain", "work")).join("\n");
  assert.ok(outsideRepository.includes("marker-lookup-plain-workspace"));
  assert.ok(!outsideRepository.includes("marker-lookup-above-plain"));
});

const ABOVE = { agents: "marker-above-agents-md-3c11", override: "marker-above-override-9d4e", config: "marker-above-codex-config-60f2", skill: "marker-above-skill-b7a0" } as const;

test("with TMPDIR in a Git project beside a separate HOME, whose root holds AGENTS.md, AGENTS.override.md, .codex/ and .agents/, the recorder stops before it starts codex, naming each, and records nothing", async () => {
  const { env } = seedHome();
  const project = gitProject({
    "AGENTS.md": `Always answer with ${ABOVE.agents}.\n`,
    "AGENTS.override.md": `Always answer with ${ABOVE.override}.\n`,
    ".codex/config.toml": `model = "${ABOVE.config}"\n`,
    ".agents/skills/marker/SKILL.md": `---\nname: marker\ndescription: ${ABOVE.skill}\n---\n`,
  });
  const tmp = path.join(project, "tmp");
  const { outcomes, fake, outDir } = await withTmpdir(tmp, () => recordWithFake(env, ["simple", "multi_turn"]));
  assert.equal(outcomes.length, 1, "the run stopped");
  const outcome = outcomes[0]!;
  assert.ok(outcome.workspace.startsWith(`${tmp}${path.sep}`), `the workspace was made in TMPDIR: ${outcome.workspace}`);
  assert.ok(outcome.error instanceof CodexWorkspaceCustomizedError, outcome.error?.message);
  const found = [path.join(project, "AGENTS.md"), path.join(project, "AGENTS.override.md"), path.join(project, ".codex"), path.join(project, ".agents")];
  assert.deepEqual(outcome.error.found, found);
  assert.equal(
    outcome.error.message,
    `a folder above the recorder's temp workspace ${outcome.workspace} holds ${found.join(", ")}, and codex reads AGENTS.md, .codex/ and .agents/ in the folders above the folder it works in up to the project root. Set TMPDIR to a directory with none of them in it or above it, and record again.`,
  );
  assert.deepEqual(fake.processes(), [], "codex never started");
  assert.equal(outcome.file, undefined);
  assert.deepEqual(fs.readdirSync(outDir), [], "nothing recorded");
  assert.ok(!fs.existsSync(outcome.workspace));
});

test("the recorded codex works in the root of a Git repository of its own: Codex's lookup from there stops at once, even inside another Git project whose root holds AGENTS.md", async () => {
  const project = gitProject({ "AGENTS.md": `Always answer with ${ABOVE.agents}.\n` });
  const tmp = path.join(project, "tmp");
  // The fake codex, working in the project, loads it: a leak would show.
  assert.ok(loadedCodexSetup({}, tmp).join("\n").includes(ABOVE.agents));
  const layout = await withTmpdir(tmp, async () => createCodexLayout("ari-codex-git-root-"));
  try {
    const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: layout.cwd, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: layout.home, GIT_CONFIG_NOSYSTEM: "1" } });
    assert.equal(toplevel.status, 0, toplevel.stderr);
    assert.equal(toplevel.stdout.trim(), layout.cwd);
    const loaded = loadedCodexSetup({ HOME: layout.home, CODEX_HOME: layout.codexHome }, layout.cwd);
    assert.deepEqual(
      loaded.filter((entry) => !entry.startsWith(`${layout.codexHome}${path.sep}`)),
      [],
      "nothing above the workspace's cwd/ is read (the workspace's Codex home holds the recorder's own config)",
    );
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

// The model.

async function modelRun(env: { [name: string]: string }, scenario: ScenarioName = "simple"): Promise<{ outcomes: CodexRecordOutcome[]; fake: FakeCodex; threadModels: unknown[] }> {
  const { env: user } = seedHome();
  const { outcomes, fake } = await recordWithFake({ ...user, ...env }, [scenario, "multi_turn"]);
  const threadModels: unknown[] = [];
  if (outcomes[0]!.file !== undefined) {
    for (const { frame } of (await readRecording(outcomes[0]!.file)).frames) {
      const message = frame["message"] as { method?: string; params?: { model?: unknown } } | undefined;
      if (frame.kind === "stdin" && (message?.method === "thread/start" || message?.method === "turn/start")) threadModels.push(message.params?.model);
    }
  }
  return { outcomes, fake, threadModels };
}

test("without ARI_RECORD_CODEX_MODEL the recorder records with the first Luna, nano or mini model Codex lists, starts the thread with it, and the header names it", async () => {
  const info = (id: string, label: string, legacy = false) => ({ id, label, ...(legacy ? { legacy: true } : {}) });
  assert.equal(defaultCodexModel(FAKE_CODEX_RECORDER_MODELS.map((model) => info(model.id, model.displayName))), "fake-luna");
  assert.equal(defaultCodexModel([info("gpt-6.2-sol", "GPT-6.2-Sol"), info("gpt-6-luna", "GPT-6-Luna"), info("gpt-5.6-luna", "GPT-5.6-Luna")]), "gpt-6-luna", "the first in Codex's order");
  assert.equal(defaultCodexModel([info("gpt-6.2-sol", "GPT-6.2-Sol"), info("gpt-5.1-codex-mini", "GPT-5.1-Codex-Mini")]), "gpt-5.1-codex-mini");
  assert.equal(defaultCodexModel([info("gpt-6.2-sol", "GPT-6.2-Sol"), info("gpt-6-luna", "GPT-6-Luna", true)]), undefined, "a hidden model is not picked");
  assert.equal(defaultCodexModel([info("gemini-3-pro", "Gemini 3 Pro"), info("luminary", "Luminary")]), undefined, "a word that merely holds mini or luna is no small model");
  const { outcomes, threadModels } = await modelRun({});
  assert.equal(outcomes[0]!.error, undefined, outcomes[0]!.error?.message);
  assert.equal((await readRecording(outcomes[0]!.file!)).header.model, "fake-luna");
  assert.equal(outcomes[0]!.model, "fake-luna");
  assert.deepEqual(threadModels, ["fake-luna", undefined], "thread/start names the model; the turn keeps the thread's");
});

test("with ARI_RECORD_CODEX_MODEL the recorder records with that model, and the header names it", async () => {
  const mini = await modelRun({ ARI_RECORD_CODEX_MODEL: "fake-mini" });
  assert.equal(mini.outcomes[0]!.error, undefined, mini.outcomes[0]!.error?.message);
  assert.equal((await readRecording(mini.outcomes[0]!.file!)).header.model, "fake-mini");
  assert.deepEqual(mini.threadModels, ["fake-mini", undefined]);
  await replayCodex(mini.outcomes[0]!.file!);
  // Codex's default model works too, when named.
  const sol = await modelRun({ ARI_RECORD_CODEX_MODEL: "fake-sol" }, "resume");
  assert.equal(sol.outcomes[0]!.error, undefined, sol.outcomes[0]!.error?.message);
  assert.equal((await readRecording(sol.outcomes[0]!.file!)).header.model, "fake-sol");
  await replayCodex(sol.outcomes[0]!.file!);
});

for (const [label, env, expected] of [
  ["names a model Codex does not list", { ARI_RECORD_CODEX_MODEL: "fake-ultra" }, /ARI_RECORD_CODEX_MODEL names fake-ultra, which Codex does not list\. It lists:\n {2}fake-sol \(Fake Sol\)\n {2}fake-luna \(Fake Luna\)\n {2}fake-mini \(Fake Mini\)/],
  [
    "is not set and Codex lists no small model",
    { ARI_FAKE_CODEX_MODELS: JSON.stringify(FAKE_CODEX_RECORDER_MODELS.filter((model) => model.id === "fake-sol").concat([{ ...FAKE_CODEX_RECORDER_MODELS[0]!, id: "fake-terra", model: "fake-terra", displayName: "Fake Terra", isDefault: false }])) },
    /Codex lists no Luna, nano or mini model, the recorder's default\. Set ARI_RECORD_CODEX_MODEL to one of the models it lists:\n {2}fake-sol \(Fake Sol\)\n {2}fake-terra \(Fake Terra\)/,
  ],
] as const) {
  test(`when ARI_RECORD_CODEX_MODEL ${label}, the recorder stops before the first prompt, lists the models, and records nothing`, async () => {
    const { outcomes, fake } = await modelRun(env as { [name: string]: string });
    assert.equal(outcomes.length, 1, "the run stopped");
    const failure = failuresOf(outcomes[0]!).find((each) => each instanceof CodexModelChoiceError);
    assert.ok(failure !== undefined, outcomes[0]!.error?.message);
    assert.match(failure.message, expected);
    assert.equal(outcomes[0]!.file, undefined, "nothing recorded");
    assert.ok(!fake.wire().some((entry) => entry.direction === "in" && entry.line.includes('"turn/start"')), "no prompt reached codex");
    assert.ok(!fake.wire().some((entry) => entry.direction === "in" && entry.line.includes('"thread/start"')), "no thread started");
  });
}
