// The Claude recorder runs a real agent only when asked, keeps the user's own
// Claude setup out of the recorded session and unchanged, and sanitises
// what it writes. Everything here runs against the fake SDK or with the SDK
// hidden; nothing starts Claude Code.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { scanRecordingText } from "../../../scripts/check-recordings.ts";
import { DEFAULT_CLAUDE_RECORDINGS, LIVE_RECORD_VARIABLE, parseRecordArguments } from "../../../scripts/record-claude.ts";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { recordClaude, recordModel, userCredentialFile } from "../../recordings/claude/record.ts";
import type { RecordClaudeOptions } from "../../recordings/claude/record.ts";
import { replayClaude } from "../../recordings/claude/replay.ts";
import { readRecording } from "../../recordings/format.ts";
import type { Frame } from "../../recordings/format.ts";
import { CLAUDE_PROTOCOL_WORDS } from "../../recordings/claude/protocol-words.ts";
import { SCENARIOS, SCENARIO_NAMES } from "../../recordings/scenarios.ts";
import type { Scenario } from "../../recordings/scenarios.ts";
import type { FakeClaudeWorld } from "./fake-sdk.ts";
import { puppetRuntime, refreshCredential, startPuppet } from "./puppets.ts";
import type { PuppetOptions } from "./puppets.ts";

// Running the recorder script.

/** A module that hides every @anthropic-ai package and traps every child_process function, and reports both when the process exits. */
const TRAP = `
import { registerHooks, createRequire, syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
const resolved = [];
const spawned = [];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@anthropic-ai/")) {
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

interface Trapped {
  readonly status: number | null;
  readonly stderr: string;
  readonly resolved: string[];
  readonly spawned: string[];
}

/** Runs Node with the trap loaded first. The trap uses node:module hooks, which Bun lacks, so this is Node whichever runtime runs the test. */
function runTrapped(args: string[], env: { [name: string]: string }): Trapped {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-record-trap-"));
  try {
    const trap = path.join(directory, "trap.mjs");
    const report = path.join(directory, "report.json");
    const home = path.join(directory, "home");
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
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("the trap sees an SDK resolution and a spawn when a program makes them", () => {
  const probe = runTrapped(["--input-type=module", "-e", `await import("@anthropic-ai/claude-agent-sdk").catch(() => undefined); try { (await import("node:child_process")).spawn("true"); } catch {}`], {});
  assert.deepEqual(probe.resolved, ["@anthropic-ai/claude-agent-sdk"]);
  assert.deepEqual(probe.spawned, ["spawn true"]);
});

test(`node scripts/record-claude.ts without ${LIVE_RECORD_VARIABLE}=1 exits non-zero naming the variable, before it resolves the SDK or spawns anything`, () => {
  const environments: Array<{ [name: string]: string }> = [{}, { [LIVE_RECORD_VARIABLE]: "0" }, { [LIVE_RECORD_VARIABLE]: "true" }, { [LIVE_RECORD_VARIABLE]: "" }];
  for (const env of environments) {
    for (const args of [["scripts/record-claude.ts"], ["scripts/record-claude.ts", "simple", "--out", "elsewhere"]]) {
      const run = runTrapped(args, env);
      assert.equal(run.status, 2, `${JSON.stringify(env)} ${args.join(" ")}: ${run.stderr}`);
      assert.match(run.stderr, /record-claude: refusing to start a real Claude session/);
      assert.match(run.stderr, new RegExp(`set ${LIVE_RECORD_VARIABLE}=1 to run it`));
      assert.deepEqual(run.resolved, [], "no @anthropic-ai package was resolved");
      assert.deepEqual(run.spawned, [], "nothing was spawned");
    }
  }
});

test(`no package.json script and no CI workflow step sets ${LIVE_RECORD_VARIABLE}`, () => {
  const scripts = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["record:claude"], "node scripts/record-claude.ts");
  for (const [name, command] of Object.entries(scripts)) assert.ok(!command.includes(LIVE_RECORD_VARIABLE), `script ${name} sets ${LIVE_RECORD_VARIABLE}`);
  const workflows = fs.readdirSync(path.join(REPO_ROOT, ".github", "workflows")).filter((name) => name.endsWith(".yml"));
  assert.ok(workflows.length >= 2, workflows.join(", "));
  for (const workflow of workflows) {
    assert.ok(!fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", workflow), "utf8").includes(LIVE_RECORD_VARIABLE), `${workflow} sets ${LIVE_RECORD_VARIABLE}`);
  }
});

test("the recorder takes a list of scenario names (all six by default) and an output dir (test/drivers/claude/recordings/ by default)", () => {
  assert.equal(DEFAULT_CLAUDE_RECORDINGS, path.join(REPO_ROOT, "test", "drivers", "claude", "recordings"));
  assert.deepEqual(parseRecordArguments([], SCENARIO_NAMES, "/default"), { scenarios: [], outDir: "/default" });
  assert.deepEqual(parseRecordArguments(["resume", "simple", "resume", "--out", "/tmp/somewhere"], SCENARIO_NAMES, "/default"), { scenarios: ["resume", "simple"], outDir: "/tmp/somewhere" });
  assert.throws(() => parseRecordArguments(["steer"], SCENARIO_NAMES, "/default"), /unknown scenario "steer"; the scenarios are simple, multi_turn/);
  assert.throws(() => parseRecordArguments(["--model", "x"], SCENARIO_NAMES, "/default"), /unknown option --model/);
  assert.throws(() => parseRecordArguments(["--out"], SCENARIO_NAMES, "/default"), /--out needs a directory/);
});

// Running the recording function against the fake.

const MARKERS = {
  settings: "marker-settings-5b1e",
  hook: "marker-hook-9e2a",
  mcp: "marker-mcp-c73d",
  claudeMd: "marker-claude-md-4f8b",
} as const;

const CREDENTIAL = JSON.stringify({ claudeAiOauth: { accessToken: "fake-access-0001", refreshToken: "fake-refresh-0001", expiresAt: 1 } });

/** A temp HOME holding a Claude Code settings file with a hook, the hook, an MCP server entry, a user CLAUDE.md and a sign-in, each with its own marker. */
function seedHome(): { home: string; files: Map<string, Buffer> } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-record-home-")));
  const hook = path.join(home, ".claude", "hooks", "ari-marker-hook.sh");
  const contents: { [file: string]: string } = {
    [path.join(home, ".claude", "settings.json")]: JSON.stringify({ env: { ARI_MARKER: MARKERS.settings }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hook }] }] } }),
    [hook]: `#!/bin/sh\necho ${MARKERS.hook}\n`,
    [path.join(home, ".claude.json")]: JSON.stringify({ mcpServers: { [MARKERS.mcp]: { type: "stdio", command: MARKERS.mcp } } }),
    [path.join(home, ".claude", "CLAUDE.md")]: `Always answer with ${MARKERS.claudeMd}.\n`,
    [path.join(home, ".claude", ".credentials.json")]: CREDENTIAL,
  };
  const files = new Map<string, Buffer>();
  for (const [file, text] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: file.endsWith(".credentials.json") ? 0o600 : 0o644 });
    files.set(file, fs.readFileSync(file));
  }
  return { home, files };
}

interface FakeRecording {
  readonly outDir: string;
  readonly worlds: FakeClaudeWorld[];
  readonly outcomes: Awaited<ReturnType<typeof recordClaude>>;
}

/** Records `scenarios` from fresh puppets through the recording function, with the recorder's environment `env`. */
async function recordFake(env: RecordClaudeOptions["env"], scenarios: Array<Scenario["name"]>, puppet: PuppetOptions = {}): Promise<FakeRecording> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ari-record-out-"));
  const worlds: FakeClaudeWorld[] = [];
  const outcomes = await recordClaude({
    scenarios,
    outDir,
    source: "fake",
    env,
    loadSdk: async (scenario) => {
      const started = startPuppet(scenario, puppet);
      worlds.push(started.world);
      return puppetRuntime(started);
    },
    timeoutMs: 10_000,
  });
  return { outDir, worlds, outcomes };
}

/** What Claude Code would read from the user's side for a query's options (Claude Code and Agent SDK docs, docs/recordings.md). */
function userFilesClaudeCodeWouldRead(options: { env?: { [name: string]: string | undefined }; settingSources?: string[] }): string[] {
  const env = options.env ?? {};
  const configDir = env["CLAUDE_CONFIG_DIR"] ?? path.join(env["HOME"] ?? "/", ".claude");
  const globalConfig = env["CLAUDE_CONFIG_DIR"] === undefined ? path.join(env["HOME"] ?? "/", ".claude.json") : path.join(configDir, ".claude.json");
  const userSettings = options.settingSources === undefined || options.settingSources.includes("user");
  return [globalConfig, path.join(configDir, ".credentials.json"), path.join(configDir, "plugins"), ...(userSettings ? [path.join(configDir, "settings.json"), path.join(configDir, "CLAUDE.md"), path.join(configDir, "agents")] : [])];
}

test("the recorded session gets none of the user's settings, hook, MCP servers or CLAUDE.md, and leaves every file of theirs byte-identical", async () => {
  const { home, files } = seedHome();
  const { outDir, worlds, outcomes } = await recordFake({ HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, [...SCENARIO_NAMES]);
  try {
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.scenario, outcome.error?.message]),
      SCENARIO_NAMES.map((name) => [name, undefined]),
    );
    for (const world of worlds) {
      const queries = world.calls.flatMap((call) => (call.kind === "query" ? [call.options] : []));
      assert.ok(queries.length > 0);
      const received = JSON.stringify({ queries, prompts: world.prompts() });
      for (const marker of Object.values(MARKERS)) assert.ok(!received.includes(marker), `the fake received ${marker}`);
      assert.ok(!received.includes(home), "the fake received a path into the user's HOME");
      for (const options of queries) {
        assert.deepEqual(options.settingSources, [], "no settings files");
        for (const file of userFilesClaudeCodeWouldRead(options)) assert.ok(!file.startsWith(`${home}${path.sep}`), `Claude Code would read ${file}`);
        assert.ok(options.env?.["HOME"] !== home && options.env?.["CLAUDE_CONFIG_DIR"] !== undefined);
      }
    }
    for (const outcome of outcomes) {
      const text = fs.readFileSync(outcome.file!, "utf8");
      for (const marker of Object.values(MARKERS)) assert.ok(!text.includes(marker), `${outcome.scenario}'s recording holds ${marker}`);
      assert.ok(!text.includes(home), `${outcome.scenario}'s recording holds the user's HOME`);
    }
    for (const [file, bytes] of files) assert.ok(fs.readFileSync(file).equals(bytes), `${file} changed`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("the model in the query options is Claude Code's haiku alias, and ARI_RECORD_CLAUDE_MODEL when that is set", async () => {
  assert.equal(recordModel({}), "haiku");
  assert.equal(recordModel({ ARI_RECORD_CLAUDE_MODEL: " " }), "haiku");
  assert.equal(recordModel({ ARI_RECORD_CLAUDE_MODEL: "sonnet" }), "sonnet");
  for (const [env, expected] of [
    [{}, "haiku"],
    [{ ARI_RECORD_CLAUDE_MODEL: "claude-opus-4-8" }, "claude-opus-4-8"],
  ] as const) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ari-record-model-"));
    const { outDir, worlds, outcomes } = await recordFake({ HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env }, ["simple", "resume"]);
    try {
      for (const world of worlds) {
        for (const call of world.calls) if (call.kind === "query") assert.equal(call.options.model, expected);
      }
      for (const outcome of outcomes) assert.equal((await readRecording(outcome.file!)).header.model, expected);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
});

test("a credential Claude Code refreshes during the run goes back to the user's file, and the isolated dir is removed", async () => {
  const { home } = seedHome();
  const real = path.join(home, ".claude", ".credentials.json");
  const refreshed = JSON.stringify({ claudeAiOauth: { accessToken: "fake-access-0002", refreshToken: "fake-refresh-0002", expiresAt: 2 } });
  let copy: string | undefined;
  let seenBeforeRefresh: string | undefined;
  const { outDir, worlds, outcomes } = await recordFake({ HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, ["simple"], {
    onTurn: (_turn, _index, world) => {
      const configDir = world.queries.at(-1)!.options.env!["CLAUDE_CONFIG_DIR"]!;
      seenBeforeRefresh = fs.readFileSync(path.join(configDir, ".credentials.json"), "utf8");
      copy = refreshCredential(world, refreshed);
    },
  });
  try {
    assert.equal(outcomes[0]!.error, undefined, outcomes[0]!.error?.message);
    assert.equal(seenBeforeRefresh, CREDENTIAL, "Claude Code found the user's sign-in in its isolated config dir");
    assert.equal(fs.readFileSync(real, "utf8"), refreshed, "the user's file holds the refreshed credential");
    assert.equal(fs.statSync(real).mode & 0o777, 0o600, "with its mode");
    assert.ok(copy !== undefined && !fs.existsSync(copy), "the copy is gone");
    const configDir = worlds[0]!.queries[0]!.options.env!["CLAUDE_CONFIG_DIR"]!;
    assert.ok(!fs.existsSync(configDir), "the isolated config dir is removed");
    assert.ok(!fs.existsSync(outcomes[0]!.workspace), "the temp workspace is removed");
    assert.ok(!fs.readFileSync(outcomes[0]!.file!, "utf8").includes("fake-refresh"), "the recording holds no credential");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("after a run that fails, the refreshed credential still goes back and the isolated dir is still removed", async () => {
  const { home } = seedHome();
  const real = path.join(home, ".claude", ".credentials.json");
  const refreshed = JSON.stringify({ claudeAiOauth: { accessToken: "fake-access-0003", refreshToken: "fake-refresh-0003", expiresAt: 3 } });
  const { outDir, worlds, outcomes } = await recordFake({ HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, ["approval_allowed"], {
    crash: true,
    onTurn: (_turn, _index, world) => {
      refreshCredential(world, refreshed);
    },
  });
  try {
    assert.ok(outcomes[0]!.error !== undefined, "the scenario failed");
    assert.match(outcomes[0]!.error!.message, /scenario approval_allowed/);
    assert.equal(fs.readFileSync(real, "utf8"), refreshed);
    assert.ok(!fs.existsSync(worlds[0]!.queries[0]!.options.env!["CLAUDE_CONFIG_DIR"]!), "the isolated config dir is removed");
    assert.ok(!fs.existsSync(outcomes[0]!.workspace), "the temp workspace is removed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("a run whose SDK fails to load still removes the isolated dir, and records nothing", async () => {
  const { home, files } = seedHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ari-record-out-"));
  try {
    const outcomes = await recordClaude({
      scenarios: ["simple"],
      outDir,
      source: "fake",
      env: { HOME: home },
      loadSdk: async () => {
        throw new Error("the SDK is not installed");
      },
    });
    assert.match(outcomes[0]!.error!.message, /the SDK is not installed/);
    assert.equal(outcomes[0]!.file, undefined);
    assert.deepEqual(fs.readdirSync(outDir), []);
    assert.ok(!fs.existsSync(outcomes[0]!.workspace));
    for (const [file, bytes] of files) assert.ok(fs.readFileSync(file).equals(bytes), `${file} changed`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("the credential comes from the user's own CLAUDE_CONFIG_DIR when set, and goes back there", async () => {
  const { home, files } = seedHome();
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "ari-record-own-config-"));
  const ownCredential = JSON.stringify({ claudeAiOauth: { accessToken: "own-access-1", refreshToken: "own-refresh-1", expiresAt: 4 } });
  fs.writeFileSync(path.join(own, ".credentials.json"), ownCredential, { mode: 0o600 });
  let seen: string | undefined;
  const { outDir, outcomes } = await recordFake({ HOME: home, CLAUDE_CONFIG_DIR: own, PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, ["simple"], {
    onTurn: (_turn, _index, world) => {
      seen = fs.readFileSync(path.join(world.queries.at(-1)!.options.env!["CLAUDE_CONFIG_DIR"]!, ".credentials.json"), "utf8");
      refreshCredential(world, "own-refreshed");
    },
  });
  try {
    assert.equal(userCredentialFile({ HOME: home, CLAUDE_CONFIG_DIR: own }), path.join(own, ".credentials.json"));
    assert.equal(outcomes[0]!.error, undefined, outcomes[0]!.error?.message);
    assert.equal(seen, ownCredential);
    assert.equal(fs.readFileSync(path.join(own, ".credentials.json"), "utf8"), "own-refreshed");
    for (const [file, bytes] of files) assert.ok(fs.readFileSync(file).equals(bytes), `${file} changed`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(own, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("when the user's credential file also changed during the run, the recorder leaves it as it is and reports the scenario failed", async () => {
  const { home } = seedHome();
  const real = path.join(home, ".claude", ".credentials.json");
  const { outDir, outcomes } = await recordFake({ HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, ["simple"], {
    onTurn: (_turn, _index, world) => {
      refreshCredential(world, "refreshed-by-the-recorded-session");
      fs.writeFileSync(real, "refreshed-by-another-claude-code");
    },
  });
  try {
    assert.match(outcomes[0]!.error?.message ?? "", /changed while the recorder ran, and Claude Code also refreshed the recorder's copy/);
    assert.equal(fs.readFileSync(real, "utf8"), "refreshed-by-another-claude-code");
    assert.ok(!fs.existsSync(outcomes[0]!.workspace));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("a live recording with neither a sign-in nor ANTHROPIC_API_KEY stops before it loads the SDK", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ari-record-no-sign-in-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ari-record-out-"));
  let loaded = 0;
  try {
    const outcomes = await recordClaude({
      scenarios: ["simple"],
      outDir,
      source: "live",
      env: { HOME: home },
      loadSdk: async () => {
        loaded += 1;
        throw new Error("never called");
      },
    });
    assert.match(outcomes[0]!.error!.message, /no Claude sign-in found: neither .*\.claude\/\.credentials\.json nor ANTHROPIC_API_KEY/);
    assert.equal(loaded, 0);
    assert.deepEqual(fs.readdirSync(outDir), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

// The OS user name outside a path.

const FRAME_FORMAT_FIELDS = new Set(["dir", "kind", "query", "id", "method", "toolName"]);

/** Every place in a recording where `name` is a whole word, other than a protocol word of its key or a frame's format field. */
function wholeWordsOf(name: string, frames: readonly Frame[]): string[] {
  const word = new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`);
  const found: string[] = [];
  const walk = (value: unknown, key: string | undefined, at: string): void => {
    if (typeof value === "string") {
      if (key !== undefined && CLAUDE_PROTOCOL_WORDS[key]?.includes(value)) return;
      if (word.test(value)) found.push(`${at}: ${JSON.stringify(value)}`);
    } else if (Array.isArray(value)) value.forEach((each, index) => walk(each, key, `${at}[${index}]`));
    else if (typeof value === "object" && value !== null) for (const [field, entry] of Object.entries(value)) walk(entry, field, `${at}.${field}`);
  };
  frames.forEach((frame, index) => {
    for (const [field, entry] of Object.entries(frame)) if (!FRAME_FORMAT_FIELDS.has(field)) walk(entry, field, `frame ${index + 2}.${field}`);
  });
  return found;
}

test("the owner column of `ls -ld .`, which reaches tool_use_result.stdout through turn.runBash, loses the OS user name, and the scan passes", async () => {
  const osName = os.userInfo().username;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-record-listing-")));
  let listing = "";
  // As the verifier ran it: the isolated HOME, no USER and no LOGNAME, the real ls in the recorder's workspace.
  const { outDir, outcomes } = await recordFake({ HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, ["approval_allowed"], {
    bashOutput: (cwd) => {
      listing = execFileSync("ls", ["-ld", "."], { cwd, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, LC_ALL: "C" } });
      return `${listing}${SCENARIOS.find((scenario) => scenario.name === "approval_allowed")!.marker!}\n`;
    },
  });
  try {
    assert.equal(outcomes[0]!.error, undefined, outcomes[0]!.error?.message);
    assert.ok(new RegExp(`(?<![A-Za-z0-9_])${osName}(?![A-Za-z0-9_])`).test(listing), `the listing shows the owner: ${listing}`);
    const recording = await readRecording(outcomes[0]!.file!);
    const frames = recording.frames.map((entry) => entry.frame);
    const stdouts = frames.flatMap((frame) => {
      const stdout = (frame["message"] as { tool_use_result?: { stdout?: unknown } } | undefined)?.tool_use_result?.stdout;
      return frame.kind === "message" && typeof stdout === "string" ? [stdout] : [];
    });
    assert.equal(stdouts.length, 1, "the command's output reached the recording as tool_use_result.stdout");
    assert.ok(stdouts[0]!.includes("<USER>"), `the owner column holds the placeholder: ${stdouts[0]}`);
    assert.deepEqual(wholeWordsOf(osName, frames), [], "the OS user name is nowhere in the recording but in protocol words");
    const text = fs.readFileSync(outcomes[0]!.file!, "utf8");
    assert.deepEqual(scanRecordingText(text, outcomes[0]!.file!, { home }), []);
    await replayClaude(outcomes[0]!.file!);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("the OS user name in the agent's free text, in assistant text and on stderr, is replaced", async () => {
  const osName = os.userInfo().username;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-record-free-text-")));
  // The fake streams a text in two halves; the name sits well inside the first.
  const reply = `${osName} said ok. The rest of this sentence keeps the name inside the first streamed half.`;
  const stderrLine = `warning: no keychain entry for ${osName}\n`;
  const { outDir, outcomes } = await recordFake({ HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, ["simple"], {
    reply,
    onTurn: (_turn, _index, world) => world.queries.at(-1)!.options.stderr!(stderrLine),
  });
  try {
    assert.equal(outcomes[0]!.error, undefined, outcomes[0]!.error?.message);
    const recording = await readRecording(outcomes[0]!.file!);
    const frames = recording.frames.map((entry) => entry.frame);
    const assistant = frames.find((frame) => frame.kind === "message" && (frame["message"] as { type: string }).type === "assistant")!;
    assert.deepEqual((assistant["message"] as { message: { content: unknown } }).message.content, [{ type: "text", text: reply.replace(osName, "<USER>"), citations: null }]);
    assert.deepEqual(
      frames.filter((frame) => frame.kind === "stderr").map((frame) => frame["data"]),
      ["warning: no keychain entry for <USER>\n"],
    );
    assert.deepEqual(wholeWordsOf(osName, frames), [], "the OS user name is nowhere in the recording but in protocol words");
    await replayClaude(outcomes[0]!.file!);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("the recorder sanitises what it writes: no workspace path, no HOME and no API key value, and the scan passes", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-record-sanitise-")));
  const key = "sk-ant-api03-RecorderTestKey0123456789abcdef";
  const { outDir, worlds, outcomes } = await recordFake({ HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin", USER: "ari-recorder-user", ANTHROPIC_API_KEY: key }, [...SCENARIO_NAMES]);
  try {
    for (const world of worlds) {
      for (const call of world.calls) if (call.kind === "query") assert.equal(call.options.env?.["ANTHROPIC_API_KEY"], key, "the driver instance used the key as its own");
    }
    for (const outcome of outcomes) {
      assert.equal(outcome.error, undefined, outcome.error?.message);
      const text = fs.readFileSync(outcome.file!, "utf8");
      assert.ok(!text.includes(outcome.workspace), `${outcome.scenario}: the workspace path`);
      assert.ok(text.includes("<WORKSPACE>/cwd"), `${outcome.scenario}: the workspace placeholder`);
      assert.ok(!text.includes(key) && text.includes('"ANTHROPIC_API_KEY":"<ANTHROPIC_API_KEY>"'), `${outcome.scenario}: the key placeholder`);
      assert.ok(!text.includes("fake@example.invalid") && text.includes("<EMAIL>"), `${outcome.scenario}: the account email`);
      assert.deepEqual(scanRecordingText(text, outcome.file!, { home }), [], outcome.scenario);
      // A recording made with a key replays without one.
      await replayClaude(outcome.file!);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
