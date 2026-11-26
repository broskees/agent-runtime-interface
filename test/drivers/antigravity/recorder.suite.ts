// The Antigravity recorder (scripts/record-antigravity.ts and the recording
// function it calls) runs only when asked, keeps the user's own Antigravity
// setup out of the recorded `agy` and unchanged, never loses a sign-in `agy`
// refreshed, and records with the model it was asked for or its documented
// default. Every run here is against the fake `agy` on PATH.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { LIVE_RECORD_VARIABLE, parseRecordArguments } from "../../../scripts/record-claude.ts";
import { DEFAULT_ANTIGRAVITY_RECORDINGS } from "../../../scripts/record-antigravity.ts";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { readRecording } from "../../recordings/format.ts";
import { ANTIGRAVITY_SIGN_IN_FILE, profileSignInFile, userSignInFile } from "../../recordings/antigravity/credentials.ts";
import { AntigravitySignInMissingError, AntigravityWorkspaceCustomizedError, AntigravityWorkspaceInHomeError, antigravityEnvironment, describeAntigravityRun, failuresOf, recordAntigravity } from "../../recordings/antigravity/record.ts";
import type { AntigravityRecordOutcome } from "../../recordings/antigravity/record.ts";
import { replayAntigravity } from "../../recordings/antigravity/replay.ts";
import { ANTIGRAVITY_RECORDER_ENV_POLICY, AntigravityModelChoiceError, createAntigravityLayout, defaultAntigravityModel } from "../../recordings/antigravity/run.ts";
import { RecordingNotWrittenError, recoveryFileFor } from "../../recordings/recovery.ts";
import { SCENARIO_NAMES } from "../../recordings/scenarios.ts";
import type { ScenarioName } from "../../recordings/scenarios.ts";
import { buildChildEnvironment } from "../../../src/node/process.ts";
import { FAKE_AGY_MODELS, fakeAgyOnPath } from "./fake-agy.ts";
import type { FakeAgy } from "./fake-agy.ts";
import { antigravitySetupSources, loadedAntigravitySetup } from "./user-setup.ts";

const DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), "ari-antigravity-recorder-"));
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
    if (/recordings\\/(antigravity|stdio)\\/|drivers\\/(antigravity|acp)\\//.test(specifier)) resolved.push(specifier);
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

test("the trap sees a resolution of the recorder's modules and a spawn when a program makes them", () => {
  const probe = runTrapped(["--input-type=module", "-e", `await import("./test/recordings/antigravity/credentials.ts"); try { (await import("node:child_process")).spawn("true"); } catch {}`], {});
  assert.deepEqual(probe.resolved, ["./test/recordings/antigravity/credentials.ts"]);
  assert.deepEqual(probe.spawned, ["spawn true"]);
});

test(`node scripts/record-antigravity.ts without ${LIVE_RECORD_VARIABLE}=1 exits non-zero naming the variable, before it loads the recorder or the driver, or spawns anything`, () => {
  const environments: Array<{ [name: string]: string }> = [{}, { [LIVE_RECORD_VARIABLE]: "0" }, { [LIVE_RECORD_VARIABLE]: "true" }, { [LIVE_RECORD_VARIABLE]: "" }, { ARI_RECORD_ANTIGRAVITY_MODEL: "fake-flash" }];
  for (const env of environments) {
    for (const args of [["scripts/record-antigravity.ts"], ["scripts/record-antigravity.ts", "simple", "--out", "elsewhere"]]) {
      const run = runTrapped(args, env);
      assert.equal(run.status, 2, `${JSON.stringify(env)} ${args.join(" ")}: ${run.stderr}`);
      assert.match(run.stderr, /record-antigravity: refusing to start the real Antigravity CLI/);
      assert.match(run.stderr, new RegExp(`set ${LIVE_RECORD_VARIABLE}=1 to run it`));
      assert.deepEqual(run.resolved, [], "neither the recorder nor the driver was loaded");
      assert.deepEqual(run.spawned, [], "nothing was spawned");
    }
  }
});

test(`the record:antigravity script runs the recorder, and no package.json script and no CI workflow step sets ${LIVE_RECORD_VARIABLE}`, () => {
  const scripts = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["record:antigravity"], "node scripts/record-antigravity.ts");
  for (const [name, command] of Object.entries(scripts)) assert.ok(!command.includes(LIVE_RECORD_VARIABLE), `script ${name} sets ${LIVE_RECORD_VARIABLE}`);
  const workflows = fs.readdirSync(path.join(REPO_ROOT, ".github", "workflows")).filter((name) => name.endsWith(".yml"));
  assert.ok(workflows.length >= 2, workflows.join(", "));
  for (const workflow of workflows) assert.ok(!fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", workflow), "utf8").includes(LIVE_RECORD_VARIABLE), `${workflow} sets ${LIVE_RECORD_VARIABLE}`);
});

test("the Antigravity recorder takes the arguments of record:claude, and writes to test/drivers/antigravity/recordings/ by default", () => {
  assert.equal(DEFAULT_ANTIGRAVITY_RECORDINGS, path.join(REPO_ROOT, "test", "drivers", "antigravity", "recordings"));
  assert.deepEqual(parseRecordArguments(["resume", "simple", "--out", "/tmp/somewhere"], SCENARIO_NAMES, DEFAULT_ANTIGRAVITY_RECORDINGS), { scenarios: ["resume", "simple"], outDir: "/tmp/somewhere" });
});

// The user's Antigravity setup.

const MARKERS = {
  settings: "marker-agy-settings-4c1e",
  mcp: "marker-agy-mcp-9b27",
  instructions: "marker-agy-gemini-md-1f80",
  agents: "marker-agy-agents-md-6d3a",
  rule: "marker-agy-rule-a2c9",
  skill: "marker-agy-skill-e715",
  configSettings: "marker-agy-config-settings-38d4",
  pluginSecrets: "marker-agy-plugin-secrets-c06b",
  signIn: "marker-agy-sign-in-7e52",
} as const;

const SIGN_IN = JSON.stringify({ token: { access_token: `fake-access-${MARKERS.signIn}`, token_type: "Bearer", refresh_token: "fake-refresh-0001", expiry: "2100-01-01T00:00:00Z" }, auth_method: "consumer" });

/** A temp HOME holding the user's `~/.gemini` (settings, an MCP entry, instructions, a rule, a skill) and `~/.config/antigravity` (settings, plugin secrets), each with its own marker, and the user's sign-in file. */
function seedHome(): { home: string; env: { [name: string]: string }; files: Map<string, Buffer>; signIn: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(DIRECTORY, "user-home-")));
  const gemini = path.join(home, ".gemini");
  const signIn = path.join(gemini, "antigravity-cli", ANTIGRAVITY_SIGN_IN_FILE);
  const contents: { [file: string]: string } = {
    [path.join(gemini, "antigravity-cli", "settings.json")]: JSON.stringify({ model: MARKERS.settings, permissions: { allow: ["command(*)"] } }),
    [path.join(gemini, "config", "mcp_config.json")]: JSON.stringify({ mcpServers: { [MARKERS.mcp]: { command: MARKERS.mcp } } }),
    [path.join(gemini, "GEMINI.md")]: `Always answer with ${MARKERS.instructions}.\n`,
    [path.join(gemini, "AGENTS.md")]: `Always answer with ${MARKERS.agents}.\n`,
    [path.join(gemini, "config", "rules", "marker.md")]: `Always answer with ${MARKERS.rule}.\n`,
    [path.join(gemini, "antigravity-cli", "skills", "marker", "SKILL.md")]: `---\nname: marker\ndescription: ${MARKERS.skill}\n---\n`,
    [path.join(home, ".config", "antigravity", "settings.json")]: JSON.stringify({ marker: MARKERS.configSettings }),
    [path.join(home, ".config", "antigravity", "plugin-secrets.json")]: JSON.stringify({ marker: MARKERS.pluginSecrets }),
    [signIn]: SIGN_IN,
  };
  for (const [file, text] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o600 });
  }
  const files = new Map<string, Buffer>();
  for (const file of Object.keys(contents)) files.set(file, fs.readFileSync(file));
  // Variables a user may have that point agy at their own setup and sign-in, or change how it signs in.
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GEMINI_HOME: gemini,
    GEMINI_API_KEY: "fake-gemini-api-key-0001",
    GOOGLE_APPLICATION_CREDENTIALS: path.join(home, "adc.json"),
    AGY_ADC_AUTH: "true",
  };
  return { home, env, files, signIn };
}

/** Records `scenarios` with the recorder's own process service, against a fresh fake `agy` on PATH. */
async function recordWithFake(env: { [name: string]: string }, scenarios: readonly ScenarioName[], options: { source?: "fake" | "live"; outDir?: string } = {}): Promise<{ outDir: string; outcomes: AntigravityRecordOutcome[]; fake: FakeAgy; log: string[] }> {
  const fake = fakeAgyOnPath(DIRECTORY);
  const outDir = options.outDir ?? fs.mkdtempSync(path.join(DIRECTORY, "out-"));
  const log: string[] = [];
  const outcomes = await recordAntigravity({
    scenarios,
    outDir,
    source: options.source ?? "fake",
    env: { PATH: `${fake.bin}${path.delimiter}${process.env["PATH"] ?? "/usr/bin:/bin"}`, USER: "ari-test-user", ...fake.env, ...env },
    timeoutMs: 20_000,
    log: (line) => log.push(line),
  });
  return { outDir, outcomes, fake, log };
}

/** The Google and Antigravity variables the recorded agy may get: the driver's own, and the recorder's file storage switch. */
const ALLOWED_AGENT_VARIABLES = ["AGY_ACP_FORCE_FILE_STORAGE", "AGY_CLI_DISABLE_AUTO_UPDATE", "AGY_CLI_FORCE_FILE_TOKEN_STORAGE", "GEMINI_HOME"];

test("the fake agy, given the user's own environment, loads every seeded setting, MCP entry, instruction, rule and skill, so a leak would show", () => {
  const { home, env } = seedHome();
  const loaded = loadedAntigravitySetup(env, path.join(home, "project")).join("\n");
  for (const marker of Object.values(MARKERS).filter((marker) => marker !== MARKERS.signIn)) assert.ok(loaded.includes(marker), `the fake loads ${marker}`);
  assert.ok(!loaded.includes(MARKERS.signIn), "the sign-in is not setup");
});

test("the recorder starts agy with a profile, HOME, XDG directories, TMPDIR and working directory inside its own temp dir and none of the user's Google or Antigravity variables: nothing of the user's Antigravity setup reaches agy or the recording, and every seeded file is byte-identical afterwards", async () => {
  const { home, env, files } = seedHome();
  const { outDir, outcomes, fake } = await recordWithFake(env, SCENARIO_NAMES);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.scenario, outcome.error?.message]),
    SCENARIO_NAMES.map((name) => [name, undefined]),
  );
  const processes = fake.processes();
  const acp = processes.filter((each) => each.args[0] === "acp");
  assert.equal(acp.length, 7, "one agy acp per session");
  const versions = processes.filter((each) => each.args[0] === "--version");
  assert.equal(versions.length, outcomes.length, "one agy --version per scenario, for the header");
  for (const started of [...acp, ...versions]) {
    const outcome = outcomes.find((each) => started.cwd.startsWith(`${each.workspace}${path.sep}`))!;
    assert.ok(outcome !== undefined, `agy started in a scenario's workspace: ${started.cwd}`);
    const workspace = outcome.workspace;
    const profile = path.join(workspace, "instances", "antigravity-recorder", "state", "profile");
    assert.equal(started.cwd, path.join(workspace, "cwd"), "agy works in the workspace, not in the recorder's directory");
    assert.deepEqual(
      { HOME: started.env["HOME"], XDG_CONFIG_HOME: started.env["XDG_CONFIG_HOME"], XDG_DATA_HOME: started.env["XDG_DATA_HOME"], XDG_STATE_HOME: started.env["XDG_STATE_HOME"], XDG_CACHE_HOME: started.env["XDG_CACHE_HOME"], XDG_RUNTIME_DIR: started.env["XDG_RUNTIME_DIR"], TMPDIR: started.env["TMPDIR"], DBUS_SESSION_BUS_ADDRESS: started.env["DBUS_SESSION_BUS_ADDRESS"] },
      { HOME: path.join(workspace, "agy-home"), XDG_CONFIG_HOME: path.join(workspace, "xdg-config"), XDG_DATA_HOME: path.join(workspace, "xdg-data"), XDG_STATE_HOME: path.join(workspace, "xdg-state"), XDG_CACHE_HOME: path.join(workspace, "xdg-cache"), XDG_RUNTIME_DIR: path.join(workspace, "xdg-runtime"), TMPDIR: path.join(workspace, "tmp"), DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(workspace, "no-session-bus")}` },
      `${outcome.scenario}: agy's own directories, and a session bus nobody listens on`,
    );
    assert.ok(!fs.existsSync(path.join(workspace, "no-session-bus")) || !outcome.workspaceKept);
    assert.deepEqual(
      Object.keys(started.env).filter((name) => /^(GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_|AGY_)/.test(name)).sort(),
      started.args[0] === "acp" ? ALLOWED_AGENT_VARIABLES : ["AGY_CLI_DISABLE_AUTO_UPDATE", "AGY_CLI_FORCE_FILE_TOKEN_STORAGE"],
      `${outcome.scenario}: none of the user's Google or Antigravity variables`,
    );
    if (started.args[0] !== "acp") continue;
    assert.deepEqual(started.args, ["acp", "--gemini-dir", profile, "--app-data-dir", "antigravity-acp"], "the instance's own profile");
    assert.equal(started.env["GEMINI_HOME"], profile);
    for (const source of antigravitySetupSources(started.env, started.cwd, profile, "antigravity-acp")) assert.ok(!source.startsWith(`${home}${path.sep}`), `${outcome.scenario}: agy would read ${source}`);
    assert.deepEqual(started.loaded, [], `${outcome.scenario}: agy loaded nothing of the user's setup`);
    assert.equal(started.signIn, SIGN_IN, `${outcome.scenario}: agy got the user's sign-in`);
    assert.equal(started.signInFile, profileSignInFile(profile));
  }
  for (const outcome of outcomes) {
    const text = fs.readFileSync(outcome.file!, "utf8");
    for (const marker of Object.values(MARKERS)) assert.ok(!text.includes(marker), `${outcome.scenario}'s recording holds ${marker}`);
    assert.ok(!text.includes(home), `${outcome.scenario}'s recording holds the user's HOME`);
    assert.ok(!text.includes("fake-refresh-0001") && !text.includes("fake-gemini-api-key"), `${outcome.scenario}'s recording holds a sign-in`);
    assert.ok(!fs.existsSync(outcome.workspace), `${outcome.scenario}: the temp dir is removed`);
    await replayAntigravity(outcome.file!);
  }
  for (const [file, bytes] of files) assert.ok(fs.readFileSync(file).equals(bytes), `${file} changed`);
  assert.ok(!fs.existsSync(recoveryFileFor(path.join(home, ".gemini", "antigravity-cli", ANTIGRAVITY_SIGN_IN_FILE))), "no recovery file: nothing was refreshed");
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("agy's environment is the recorder's less HOME, the XDG directories, TMPDIR and the session bus, plus the workspace's; the host then strips every GEMINI_, GOOGLE_, GCLOUD_, CLOUDSDK_ and AGY_ variable", () => {
  const layout = createAntigravityLayout("ari-antigravity-environment-");
  try {
    const user = { PATH: "/usr/bin", LANG: "C.UTF-8", HOME: "/home/someone", XDG_CONFIG_HOME: "/home/someone/.config", XDG_RUNTIME_DIR: "/run/user/1000", TMPDIR: "/var/tmp/someone", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", GEMINI_API_KEY: "key", GOOGLE_CLOUD_PROJECT: "p", AGY_ADC_AUTH: "true", CLOUDSDK_CORE_PROJECT: "p", GCLOUD_PROJECT: "p" };
    const environment = antigravityEnvironment(layout, user);
    assert.equal(environment["LANG"], "C.UTF-8");
    assert.equal(environment["HOME"], layout.home);
    assert.equal(environment["XDG_RUNTIME_DIR"], layout.runtimeDir);
    assert.equal(environment["TMPDIR"], layout.tmp);
    assert.equal(environment["DBUS_SESSION_BUS_ADDRESS"], `unix:path=${path.join(layout.root, "no-session-bus")}`);
    const child = buildChildEnvironment(environment, ANTIGRAVITY_RECORDER_ENV_POLICY);
    assert.deepEqual(Object.keys(child).filter((name) => /^(GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_|AGY_)/.test(name)), []);
    assert.equal(child["PATH"], "/usr/bin");
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

// The sign-in.

test("the user's sign-in file is ~/.gemini/antigravity-cli/antigravity-oauth-token, and the recorded agy finds its copy in <profile>/antigravity-acp/", () => {
  assert.equal(userSignInFile({ HOME: "/srv/someone" }), "/srv/someone/.gemini/antigravity-cli/antigravity-oauth-token");
  assert.equal(userSignInFile({ HOME: "/srv/someone", GEMINI_HOME: "/elsewhere" }), "/srv/someone/.gemini/antigravity-cli/antigravity-oauth-token", "agy 1.5.17 does not read GEMINI_HOME");
  assert.equal(userSignInFile({}), undefined);
  assert.equal(profileSignInFile("/x/profile"), "/x/profile/antigravity-acp/antigravity-oauth-token");
});

test("a sign-in agy refreshes during the run goes back to the user's file, and the temp dir is removed", async () => {
  const { env, signIn } = seedHome();
  const refreshed = JSON.stringify({ token: { access_token: "fake-access-0002", refresh_token: "fake-refresh-0002" }, auth_method: "consumer" });
  const { outcomes, fake } = await recordWithFake({ ...env, ARI_FAKE_AGY_REFRESH: refreshed }, ["simple"]);
  assert.equal(outcomes[0]!.error, undefined, outcomes[0]!.error?.message);
  assert.equal(fake.processes().find((each) => each.args[0] === "acp")!.signIn, SIGN_IN, "agy started with the user's sign-in");
  assert.equal(fs.readFileSync(signIn, "utf8"), refreshed, "the user's file holds the refreshed sign-in");
  assert.equal(fs.statSync(signIn).mode & 0o777, 0o600, "and stays readable only by the user");
  assert.ok(!fs.existsSync(outcomes[0]!.workspace), "the temp dir, with its copy of the sign-in, is removed");
  assert.ok(!fs.readFileSync(outcomes[0]!.file!, "utf8").includes("fake-refresh"), "the recording holds no sign-in");
});

test("after a run that fails, the refreshed sign-in still goes back and the temp dir is still removed", async () => {
  const { env, signIn } = seedHome();
  const refreshed = JSON.stringify({ token: { refresh_token: "fake-refresh-0003" } });
  const { outcomes } = await recordWithFake({ ...env, ARI_FAKE_AGY_REFRESH: refreshed, ARI_FAKE_AGY_CRASH: "1" }, ["approval_allowed"]);
  assert.ok(outcomes[0]!.error !== undefined, "the scenario failed: agy died in its first turn");
  assert.equal(fs.readFileSync(signIn, "utf8"), refreshed);
  assert.ok(!fs.existsSync(outcomes[0]!.workspace), "the temp dir is removed");
});

test("when the user's sign-in also changed during the run, the recorder leaves it as it is, keeps the refreshed value in the run's recovery file and reports the scenario failed", async () => {
  const { env, signIn } = seedHome();
  const { outDir, outcomes } = await recordWithFake({ ...env, ARI_FAKE_AGY_REFRESH: "refreshed-by-the-recorded-agy", ARI_FAKE_AGY_TOUCH: signIn, ARI_FAKE_AGY_TOUCH_VALUE: "changed-by-another-agy" }, ["simple"]);
  const kept = recoveryFileFor(signIn);
  assert.match(outcomes[0]!.error?.message ?? "", new RegExp(`${escape(signIn)} changed while the recorder ran, and agy also refreshed the recorder's copy; the recorder left ${escape(signIn)} as it is; it kept the refreshed sign-in in ${escape(kept)}`));
  assert.equal(fs.readFileSync(signIn, "utf8"), "changed-by-another-agy");
  assert.equal(outcomes[0]!.recoveryFile, kept);
  assert.equal(kept, `${signIn}.ari-recorder-refreshed-${process.pid}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(kept, "utf8")), [{ id: ANTIGRAVITY_SIGN_IN_FILE, value: "refreshed-by-the-recorded-agy" }], "the refreshed value is not lost");
  assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(outcomes[0]!.workspace));
  assert.equal(describeAntigravityRun(outcomes, outDir).filter((line) => line.includes(kept)).length, 1, "the run's last lines name the recovery file");
});

test("refreshed sign-ins that cannot go back in two scenarios both survive in the run's recovery file", async () => {
  const { env, signIn } = seedHome();
  const kept = recoveryFileFor(signIn);
  const first = await recordWithFake({ ...env, ARI_FAKE_AGY_REFRESH: "refreshed-1", ARI_FAKE_AGY_TOUCH: signIn, ARI_FAKE_AGY_TOUCH_VALUE: "changed-1" }, ["simple"]);
  const second = await recordWithFake({ ...env, ARI_FAKE_AGY_REFRESH: "refreshed-2", ARI_FAKE_AGY_TOUCH: signIn, ARI_FAKE_AGY_TOUCH_VALUE: "changed-2" }, ["multi_turn"]);
  assert.equal(first.outcomes[0]!.recoveryFile, kept);
  assert.equal(second.outcomes[0]!.recoveryFile, kept);
  assert.deepEqual(JSON.parse(fs.readFileSync(kept, "utf8")), [{ id: ANTIGRAVITY_SIGN_IN_FILE, value: "refreshed-2", olderValues: ["refreshed-1"] }]);
});

test("when the recorder cannot write a refreshed sign-in back, it keeps it in the recovery file beside the user's file and says where", async () => {
  const { env, signIn } = seedHome();
  // During the run the user's sign-in file becomes a directory: the recorder can neither read nor replace it.
  const { outcomes } = await recordWithFake({ ...env, ARI_FAKE_AGY_REFRESH: "refreshed-by-the-recorded-agy", ARI_FAKE_AGY_BREAK: signIn }, ["simple"]);
  const kept = recoveryFileFor(signIn);
  assert.match(outcomes[0]!.error?.message ?? "", new RegExp(`the recorder could not write the sign-in agy refreshed back to ${escape(signIn)} \\(.+\\); it kept the refreshed sign-in in ${escape(kept)}`));
  assert.equal(outcomes[0]!.recoveryFile, kept);
  assert.deepEqual(JSON.parse(fs.readFileSync(kept, "utf8")), [{ id: ANTIGRAVITY_SIGN_IN_FILE, value: "refreshed-by-the-recorded-agy" }]);
  assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(outcomes[0]!.workspace), "the temp dir is removed");
});

test("when the recovery file cannot take a refreshed sign-in either, the recorder keeps the workspace with its copy, stops the run and names both", async () => {
  const { env, signIn } = seedHome();
  const kept = recoveryFileFor(signIn);
  // Nothing can be written where the recovery file goes.
  fs.mkdirSync(kept);
  fs.writeFileSync(path.join(kept, "occupied"), "");
  const { outDir, outcomes } = await recordWithFake({ ...env, ARI_FAKE_AGY_REFRESH: "refreshed-by-the-recorded-agy", ARI_FAKE_AGY_TOUCH: signIn, ARI_FAKE_AGY_TOUCH_VALUE: "changed-by-another-agy" }, ["simple", "multi_turn"]);
  assert.equal(outcomes.length, 1, "the run stopped: no other scenario ran");
  const [outcome] = outcomes;
  const copy = profileSignInFile(path.join(outcome!.workspace, "instances", "antigravity-recorder", "state", "profile"));
  try {
    assert.equal(outcome!.workspaceKept, true);
    assert.equal(outcome!.recoveryFile, undefined);
    assert.equal(fs.readFileSync(copy, "utf8"), "refreshed-by-the-recorded-agy", "the workspace with its copy of the refreshed sign-in is kept");
    const message = outcome!.error?.message ?? "";
    assert.match(message, new RegExp(`could not keep the refreshed sign-in in ${escape(kept)} either`));
    assert.match(message, new RegExp(`only in the recorder's copy, ${escape(copy)}`));
    assert.match(message, new RegExp(`the recorder kept the workspace ${escape(outcome!.workspace)}`));
    const ending = describeAntigravityRun(outcomes, outDir);
    assert.ok(ending.some((line) => line.includes(outcome!.workspace)), "the run's last lines name the kept workspace");
  } finally {
    fs.rmSync(outcome!.workspace, { recursive: true, force: true });
  }
});

for (const [label, blockRecovery] of [
  ["kept in the recovery file", false],
  ["kept only in the workspace", true],
] as const) {
  test(`when the recording cannot be written either, the recorder stops and still names a refreshed sign-in ${label}`, async () => {
    const { env, signIn } = seedHome();
    const kept = recoveryFileFor(signIn);
    if (blockRecovery) {
      fs.mkdirSync(kept);
      fs.writeFileSync(path.join(kept, "occupied"), "");
    }
    // The output directory is a file: no recording can be written there.
    const outDir = path.join(fs.mkdtempSync(path.join(DIRECTORY, "out-file-")), "not-a-directory");
    fs.writeFileSync(outDir, "");
    const { outcomes } = await recordWithFake({ ...env, ARI_FAKE_AGY_REFRESH: "refreshed-by-the-recorded-agy", ARI_FAKE_AGY_TOUCH: signIn, ARI_FAKE_AGY_TOUCH_VALUE: "changed-by-another-agy" }, ["simple", "multi_turn"], { outDir });
    assert.equal(outcomes.length, 1, "the run stopped: no other scenario ran");
    const [outcome] = outcomes;
    try {
      assert.equal(outcome!.file, undefined, "no recording was written");
      assert.ok(failuresOf(outcome!).some((failure) => failure instanceof RecordingNotWrittenError && failure.file === path.join(outDir, "simple.ndjson")), outcome!.error?.message);
      const ending = describeAntigravityRun(outcomes, outDir).join("\n");
      if (blockRecovery) {
        assert.equal(outcome!.workspaceKept, true);
        assert.ok(ending.includes(outcome!.workspace), ending);
      } else {
        assert.equal(outcome!.recoveryFile, kept);
        assert.ok(ending.includes(kept), ending);
        assert.deepEqual(JSON.parse(fs.readFileSync(kept, "utf8")), [{ id: ANTIGRAVITY_SIGN_IN_FILE, value: "refreshed-by-the-recorded-agy" }]);
      }
    } finally {
      if (outcome?.workspaceKept === true) fs.rmSync(outcome.workspace, { recursive: true, force: true });
    }
  });
}

test("a live run without the user's sign-in file stops before it starts agy, naming the file, and records nothing", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(DIRECTORY, "no-sign-in-")));
  const { outcomes, fake } = await recordWithFake({ HOME: home }, ["simple", "multi_turn"], { source: "live" });
  assert.equal(outcomes.length, 1, "the run stopped");
  assert.ok(outcomes[0]!.error instanceof AntigravitySignInMissingError, outcomes[0]!.error?.message);
  assert.ok(outcomes[0]!.error!.message.includes(path.join(home, ".gemini", "antigravity-cli", ANTIGRAVITY_SIGN_IN_FILE)));
  assert.equal(outcomes[0]!.file, undefined);
  assert.deepEqual(fake.processes(), [], "agy never started");
  assert.ok(!fs.existsSync(outcomes[0]!.workspace));
});

test("a temp workspace inside the user's home stops the run before it starts agy: agy reads AGENTS.md, GEMINI.md and .agents/ in the folders above its own", async () => {
  // A home that holds the system temp directory, and so every workspace the recorder makes.
  const home = path.dirname(fs.realpathSync(os.tmpdir()));
  const { outcomes, fake } = await recordWithFake({ HOME: home }, ["simple", "multi_turn"]);
  assert.equal(outcomes.length, 1, "the run stopped");
  assert.ok(outcomes[0]!.error instanceof AntigravityWorkspaceInHomeError, outcomes[0]!.error?.message);
  assert.ok(outcomes[0]!.error!.message.includes(`inside your home ${home}`));
  assert.deepEqual(fake.processes(), [], "agy never started");
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

test("the fake agy reads AGENTS.md, GEMINI.md and .agents/ in the folder it works in and each folder above up to its repository's root, only that folder outside a repository, and a personal folder the repository's .gemini/config.json names, as Antigravity's docs say", () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(DIRECTORY, "lookup-")));
  const files: { [file: string]: string } = {
    [path.join(outside, "AGENTS.md")]: "marker-lookup-above-repository",
    [path.join(outside, "repo", "GEMINI.md")]: "marker-lookup-repository-root",
    [path.join(outside, "repo", "sub", ".agents", "rules", "rule.md")]: "marker-lookup-between",
    [path.join(outside, "repo", ".gemini", "config.json")]: JSON.stringify({ personal_customization_dir: "people/{user}" }),
    [path.join(outside, "repo", "people", "ari-test-user", ".agents", "rules", "rule.md")]: "marker-lookup-personal",
    [path.join(outside, "plain", "GEMINI.md")]: "marker-lookup-above-plain",
    [path.join(outside, "plain", "work", "AGENTS.md")]: "marker-lookup-plain-workspace",
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  fs.mkdirSync(path.join(outside, "repo", ".git"));
  fs.mkdirSync(path.join(outside, "repo", "sub", "work"));
  const inRepository = loadedAntigravitySetup({ USER: "ari-test-user" }, path.join(outside, "repo", "sub", "work")).join("\n");
  for (const marker of ["marker-lookup-repository-root", "marker-lookup-between", "marker-lookup-personal"]) assert.ok(inRepository.includes(marker), marker);
  assert.ok(!inRepository.includes("marker-lookup-above-repository"));
  const outsideRepository = loadedAntigravitySetup({ USER: "ari-test-user" }, path.join(outside, "plain", "work")).join("\n");
  assert.ok(outsideRepository.includes("marker-lookup-plain-workspace"));
  assert.ok(!outsideRepository.includes("marker-lookup-above-plain"));
});

const ABOVE = { agents: "marker-above-agents-md-5e21", gemini: "marker-above-gemini-md-0b9d", mcp: "marker-above-mcp-c4a7", personal: "marker-above-personal-rule-71fa" } as const;

test("with TMPDIR in a Git project beside a separate HOME, whose root holds AGENTS.md, GEMINI.md and .agents/mcp_config.json, the recorder stops before it starts agy, naming each, and records nothing", async () => {
  const { env } = seedHome();
  const project = gitProject({
    "AGENTS.md": `Always answer with ${ABOVE.agents}.\n`,
    "GEMINI.md": `Always answer with ${ABOVE.gemini}.\n`,
    ".agents/mcp_config.json": JSON.stringify({ mcpServers: { [ABOVE.mcp]: { command: ABOVE.mcp } } }),
  });
  const tmp = path.join(project, "tmp");
  const { outcomes, fake, outDir } = await withTmpdir(tmp, () => recordWithFake(env, ["simple", "multi_turn"]));
  assert.equal(outcomes.length, 1, "the run stopped");
  const outcome = outcomes[0]!;
  assert.ok(outcome.workspace.startsWith(`${tmp}${path.sep}`), `the workspace was made in TMPDIR: ${outcome.workspace}`);
  assert.ok(outcome.error instanceof AntigravityWorkspaceCustomizedError, outcome.error?.message);
  const found = [path.join(project, "AGENTS.md"), path.join(project, "GEMINI.md"), path.join(project, ".agents")];
  assert.deepEqual(outcome.error.found, found);
  assert.equal(
    outcome.error.message,
    `a folder above the recorder's temp workspace ${outcome.workspace} holds ${found.join(", ")}, and agy reads AGENTS.md, GEMINI.md and .agents/ in the folders above the folder it works in. Set TMPDIR to a directory with none of them in it or above it, and record again.`,
  );
  assert.deepEqual(fake.processes(), [], "agy never started");
  assert.equal(outcome.file, undefined);
  assert.deepEqual(fs.readdirSync(outDir), [], "nothing recorded");
  assert.ok(!fs.existsSync(outcome.workspace));
});

test("a folder above the workspace that is in no repository and holds only .agents/ stops the recorder too, naming it", async () => {
  const { env } = seedHome();
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(DIRECTORY, "plain-")));
  fs.mkdirSync(path.join(plain, ".agents", "skills"), { recursive: true });
  const tmp = path.join(plain, "a", "b");
  fs.mkdirSync(tmp, { recursive: true });
  const { outcomes, fake } = await withTmpdir(tmp, () => recordWithFake(env, ["simple"]));
  assert.ok(outcomes[0]!.error instanceof AntigravityWorkspaceCustomizedError, outcomes[0]!.error?.message);
  assert.deepEqual(outcomes[0]!.error.found, [path.join(plain, ".agents")]);
  assert.deepEqual(fake.processes(), [], "agy never started");
});

test("the recorded agy works in the root of a Git repository of its own: a Git project above the workspace whose .gemini/config.json names a personal customization folder reaches neither agy nor the recording", async () => {
  const project = gitProject({
    ".gemini/config.json": JSON.stringify({ personal_customization_dir: "people/{user}" }),
    "people/ari-test-user/.agents/rules/marker.md": `---\ntrigger: always_on\n---\nAlways answer with ${ABOVE.personal}.\n`,
  });
  const tmp = path.join(project, "tmp");
  // The fake agy, working in the project, loads it: a leak would show.
  assert.ok(loadedAntigravitySetup({ USER: "ari-test-user" }, tmp).join("\n").includes(ABOVE.personal));
  // A workspace the recorder makes there: Git finds its cwd/ to be a repository's root.
  const layout = await withTmpdir(tmp, async () => createAntigravityLayout("ari-antigravity-git-root-"));
  try {
    const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: layout.cwd, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: layout.home, GIT_CONFIG_NOSYSTEM: "1" } });
    assert.equal(toplevel.status, 0, toplevel.stderr);
    assert.equal(toplevel.stdout.trim(), layout.cwd);
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
  const { env } = seedHome();
  const { outcomes, fake } = await withTmpdir(tmp, () => recordWithFake(env, ["simple"]));
  const outcome = outcomes[0]!;
  assert.equal(outcome.error, undefined, outcome.error?.message);
  assert.ok(outcome.workspace.startsWith(`${tmp}${path.sep}`), `the workspace was made in TMPDIR: ${outcome.workspace}`);
  const acp = fake.processes().find((each) => each.args[0] === "acp")!;
  assert.equal(acp.cwd, path.join(outcome.workspace, "cwd"));
  assert.deepEqual(acp.loaded, [], "agy loaded nothing from the folders above");
  assert.ok(!fs.readFileSync(outcome.file!, "utf8").includes(ABOVE.personal));
  await replayAntigravity(outcome.file!);
});

// The model.

async function modelRun(env: { [name: string]: string }, scenario: ScenarioName = "simple"): Promise<{ outcomes: AntigravityRecordOutcome[]; fake: FakeAgy; setModel: unknown[] }> {
  const { env: user } = seedHome();
  const { outcomes, fake } = await recordWithFake({ ...user, ...env }, [scenario, "multi_turn"]);
  const setModel: unknown[] = [];
  if (outcomes[0]!.file !== undefined) {
    for (const { frame } of (await readRecording(outcomes[0]!.file)).frames) {
      const message = frame["message"] as { method?: string; params?: { value?: unknown } } | undefined;
      if (frame.kind === "stdin" && message?.method === "session/set_config_option") setModel.push(message.params?.value);
    }
  }
  return { outcomes, fake, setModel };
}

test("without ARI_RECORD_ANTIGRAVITY_MODEL the recorder records with the first Flash model agy offers, sets it before the first prompt, and the header names it", async () => {
  assert.equal(defaultAntigravityModel({ id: "model", category: "model", label: "Model", type: "select", values: FAKE_AGY_MODELS.map((model) => ({ id: model.value, label: model.name })), current: "fake-pro-high", scope: "thread", changeEffect: "next_turn" }), "fake-flash");
  assert.equal(defaultAntigravityModel({ id: "model", category: "model", label: "Model", type: "select", values: [{ id: "gemini-3.8-fl", label: "Gemini 3.8 Flash" }, { id: "gemini-4-neon", label: "Gemini 4 Neon" }], current: null, scope: "thread", changeEffect: "next_turn" }), "gemini-3.8-fl", "a name holding Flash counts too");
  const { outcomes, setModel } = await modelRun({});
  assert.equal(outcomes[0]!.error, undefined, outcomes[0]!.error?.message);
  assert.equal((await readRecording(outcomes[0]!.file!)).header.model, "fake-flash");
  assert.equal(outcomes[0]!.model, "fake-flash");
  assert.deepEqual(setModel, ["fake-flash"]);
});

test("with ARI_RECORD_ANTIGRAVITY_MODEL the recorder records with that model, and the header names it", async () => {
  const lite = await modelRun({ ARI_RECORD_ANTIGRAVITY_MODEL: "fake-flash-lite" });
  assert.equal(lite.outcomes[0]!.error, undefined, lite.outcomes[0]!.error?.message);
  assert.equal((await readRecording(lite.outcomes[0]!.file!)).header.model, "fake-flash-lite");
  assert.deepEqual(lite.setModel, ["fake-flash-lite"]);
  await replayAntigravity(lite.outcomes[0]!.file!);
  // The model agy already holds needs no change.
  const pro = await modelRun({ ARI_RECORD_ANTIGRAVITY_MODEL: "fake-pro-high" });
  assert.equal(pro.outcomes[0]!.error, undefined, pro.outcomes[0]!.error?.message);
  assert.equal((await readRecording(pro.outcomes[0]!.file!)).header.model, "fake-pro-high");
  assert.deepEqual(pro.setModel, []);
  await replayAntigravity(pro.outcomes[0]!.file!);
});

for (const [label, env, expected] of [
  ["names a model agy does not offer", { ARI_RECORD_ANTIGRAVITY_MODEL: "fake-ultra" }, /ARI_RECORD_ANTIGRAVITY_MODEL names fake-ultra, which the agent does not offer\. It offers:\n {2}fake-pro-high \(Fake Pro \(High\)\)\n {2}fake-flash \(Fake Flash\)\n {2}fake-flash-lite \(Fake Flash Lite\)/],
  ["is not set and agy offers no Flash model", { ARI_FAKE_AGY_MODELS: JSON.stringify([{ value: "fake-pro-high", name: "Fake Pro (High)" }, { value: "fake-argon", name: "Fake Argon" }]) }, /the agent offers no Flash model, the recorder's default\. Set ARI_RECORD_ANTIGRAVITY_MODEL to one of the models it offers:\n {2}fake-pro-high \(Fake Pro \(High\)\)\n {2}fake-argon \(Fake Argon\)/],
] as const) {
  test(`when ARI_RECORD_ANTIGRAVITY_MODEL ${label}, the recorder stops before the first prompt, lists the models, and records nothing`, async () => {
    const { outcomes, fake } = await modelRun(env as { [name: string]: string });
    assert.equal(outcomes.length, 1, "the run stopped");
    const failure = failuresOf(outcomes[0]!).find((each) => each instanceof AntigravityModelChoiceError);
    assert.ok(failure !== undefined, outcomes[0]!.error?.message);
    assert.match(failure.message, expected);
    assert.equal(outcomes[0]!.file, undefined, "nothing recorded");
    assert.ok(!fake.wire().some((entry) => entry.direction === "in" && entry.line.includes('"session/prompt"')), "no prompt reached agy");
  });
}
