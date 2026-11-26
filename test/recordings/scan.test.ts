// Recordings are public, so they carry no paths, emails or tokens. The scan
// (`pnpm run check:recordings`, in both gate chains) fails on each pattern
// planted in a copy of a recording, naming the file and the line; the one
// sanitiser's output for a frame holding each passes it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { recordingFiles, scanRecordingText, scanRecordings } from "../../scripts/check-recordings.ts";
import { REPO_ROOT } from "../helpers/spec.ts";
import { encodeRecording, parseRecording, readRecording } from "./format.ts";
import type { Frame, RecordingMetadata } from "./format.ts";
import { CLAUDE_PROTOCOL_WORDS } from "./claude/protocol-words.ts";
import { ACP_PROTOCOL_WORDS } from "./acp/protocol-words.ts";
import type { ProtocolWords } from "./protocol-places.ts";
import { resanitiseRecording } from "./resanitise.ts";
import { NEUTRAL_PID, NEUTRAL_RATE_LIMIT_INFO, NEUTRAL_SHELL, NEUTRAL_SOCKET_PATH, NEUTRAL_TIME, NEUTRAL_TMP_PATH, PLACEHOLDERS, createSanitiser, osUserName, secretVariablesOf, userNames } from "./sanitiser.ts";

const METADATA: RecordingMetadata = {
  driver: "claude",
  vendor: "claude-code",
  vendorVersion: "2.1.330",
  sdk: "@anthropic-ai/claude-agent-sdk",
  sdkVersion: "0.3.330",
  model: "haiku",
  scenario: "simple",
  recorded: "2026-11-24",
  source: "fake",
};

// A plain recording: the frames a simple scenario has, with placeholders only.
const CLEAN: Frame[] = [
  { dir: "out", kind: "query", query: "q1", prompt: "stream", options: { cwd: "<WORKSPACE>/cwd", env: { PATH: "<PATH>", HOME: "<WORKSPACE>/claude-home" } } },
  { dir: "out", kind: "prompt", query: "q1", message: { type: "user", message: { role: "user", content: [{ type: "text", text: "Reply with one word" }] } } },
  { dir: "in", kind: "message", query: "q1", message: { type: "system", subtype: "init", cwd: "<WORKSPACE>/cwd", model: "claude-haiku", account: { email: "<EMAIL>" } } },
  { dir: "in", kind: "message", query: "q1", message: { type: "assistant", message: { content: [{ type: "text", text: "ok, see https://example.com/home/docs, /var/home/shared and ask-anything" }] } } },
  { dir: "in", kind: "end", query: "q1" },
];

// The scanning machine's $HOME in these tests: a temp dir, as for every spawned process.
const SCANNING_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-scan-home-")));
process.on("exit", () => fs.rmSync(SCANNING_HOME, { recursive: true, force: true }));

/** The environment of a spawned scan: HOME and every XDG dir in the temp HOME. */
function scanEnvironment(): { [name: string]: string } {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: SCANNING_HOME,
    XDG_CONFIG_HOME: path.join(SCANNING_HOME, ".config"),
    XDG_DATA_HOME: path.join(SCANNING_HOME, ".local", "share"),
    XDG_STATE_HOME: path.join(SCANNING_HOME, ".local", "state"),
    XDG_CACHE_HOME: path.join(SCANNING_HOME, ".cache"),
  };
}

// Each pattern the scan refuses, as it could appear inside a frame.
const PLANTED: ReadonlyArray<{ name: string; value: string; rule: string }> = [
  { name: "a path under /home/", value: "/home/alice/project/notes.txt", rule: "home-path" },
  { name: "a path under /Users/", value: "/Users/alice/Library/x", rule: "home-path" },
  { name: "a path under /root/", value: "/root/.claude/settings.json", rule: "home-path" },
  { name: "a file URL into /home/", value: "file:///home/alice/notes.txt", rule: "home-path" },
  { name: "a path under the scanning machine's $HOME", value: `${SCANNING_HOME}/.claude.json`, rule: "machine-home" },
  { name: "an email address", value: "alice.smith+claude@example.co.uk", rule: "email" },
  { name: "an Anthropic key", value: "sk-ant-api03-AbCdEf0123456789", rule: "token" },
  { name: "an sk- key", value: "sk-proj0123456789abcdefABCDEF", rule: "token" },
  { name: "an sk- key inside a word", value: "task-0123456789abcdefABCDEF", rule: "token" },
  { name: "a GitHub token", value: "ghp_0123456789abcdefABCDEF0123456789abcd", rule: "token" },
  { name: "a GitHub app token", value: "ghs_0123456789abcdefABCDEF", rule: "token" },
  { name: "a Slack token", value: "xoxb-1234-5678-abcdef", rule: "token" },
  { name: "an AWS access key", value: "AKIAIOSFODNN7EXAMPLE", rule: "token" },
  { name: "a bearer token", value: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature", rule: "token" },
];

/** A copy of the clean recording, signed again, with `value` planted in the assistant text of frame line 5. */
function plantedCopy(value: string): string {
  const frames = structuredClone(CLEAN);
  (frames[3]!["message"] as { message: { content: Array<{ text: string }> } }).message.content[0]!.text = `I wrote it to ${value} for you.`;
  return encodeRecording(METADATA, frames);
}

function tempRepo(files: { [relative: string]: string }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ari-scan-"));
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  return root;
}

test("a clean recording passes the scan", () => {
  const text = encodeRecording(METADATA, CLEAN);
  assert.deepEqual(scanRecordingText(text, "clean.ndjson", { home: SCANNING_HOME }), []);
});

test("the scan fails on each planted path, email and token, naming the file and the line", () => {
  for (const planted of PLANTED) {
    const root = tempRepo({ "test/drivers/claude/recordings/simple.ndjson": plantedCopy(planted.value) });
    try {
      // The copy is a recording the loader accepts: only the scan stops it.
      parseRecording(fs.readFileSync(path.join(root, "test/drivers/claude/recordings/simple.ndjson"), "utf8"), "simple.ndjson");
      const { findings } = scanRecordings(root, { home: SCANNING_HOME });
      assert.ok(findings.length > 0, `${planted.name}: the scan found nothing`);
      for (const finding of findings) {
        assert.equal(finding.file, "test/drivers/claude/recordings/simple.ndjson", planted.name);
        assert.equal(finding.line, 5, planted.name);
      }
      assert.ok(
        findings.some((finding) => finding.rule === planted.rule),
        `${planted.name}: rule ${planted.rule} (found ${findings.map((finding) => finding.rule).join(", ")})`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("check:recordings exits non-zero naming the file and line, never the matched text, and passes a clean tree", () => {
  const root = tempRepo({
    "test/drivers/claude/recordings/simple.ndjson": encodeRecording(METADATA, CLEAN),
    "test/drivers/claude/recordings/nested/resume.ndjson": plantedCopy("sk-ant-api03-Secret0123456789"),
    "test/drivers/opencode/recordings/notes.txt": "first line\nsee /Users/bob/x\n",
    "test/drivers/claude/elsewhere.ndjson": plantedCopy("/home/alice/x"),
  });
  try {
    assert.deepEqual(recordingFiles(root), ["test/drivers/claude/recordings/nested/resume.ndjson", "test/drivers/claude/recordings/simple.ndjson", "test/drivers/opencode/recordings/notes.txt"]);
    const failed = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "check-recordings.ts"), "--root", root], { encoding: "utf8", env: scanEnvironment() });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /test\/drivers\/claude\/recordings\/nested\/resume\.ndjson:5:\d+: token: an Anthropic key/);
    assert.match(failed.stderr, /test\/drivers\/opencode\/recordings\/notes\.txt:2:\d+: home-path: a path starting \/Users\//);
    assert.ok(!failed.stderr.includes("Secret0123456789"), "the scan never prints the matched text");
    assert.ok(!failed.stderr.includes("elsewhere"), "only files under recordings/ are scanned");
    fs.rmSync(path.join(root, "test/drivers/claude/recordings/nested"), { recursive: true });
    fs.rmSync(path.join(root, "test/drivers/opencode/recordings/notes.txt"));
    const passed = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "check-recordings.ts"), "--root", root], { encoding: "utf8", env: scanEnvironment() });
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /1 recording file\(s\), no paths, emails or tokens/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the sanitiser replaces the workspace, $HOME, the user name in paths and the credential values with fixed placeholders, and emails", () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-sanitiser-")));
  try {
    const env = {
      HOME: "/home/recorder",
      PATH: "/home/recorder/.local/bin:/usr/bin:/bin",
      USER: "recorder",
      ANTHROPIC_API_KEY: "sk-ant-api03-RealKeyValue0123456789",
      ANTHROPIC_AUTH_TOKEN: "auth-token-value-0123456789",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value-0123456789",
    };
    const sanitise = createSanitiser({ workspace, env, user: "recorder" });
    const frame = {
      dir: "out",
      kind: "query",
      options: {
        cwd: `${workspace}/cwd`,
        env: { PATH: env.PATH, HOME: `${workspace}/home`, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, [`${env.HOME}/key`]: "a path as a key" },
        text: `ran in ${env.HOME}/projects and /srv/recorder/cache and C:\\Users\\recorder\\x and ~recorder/notes; token ${env.ANTHROPIC_AUTH_TOKEN} and ${env.CLAUDE_CODE_OAUTH_TOKEN}; mail recorder@example.org; recorders stay`,
      },
    };
    assert.deepEqual(sanitise(frame), {
      dir: "out",
      kind: "query",
      options: {
        cwd: `${PLACEHOLDERS.workspace}/cwd`,
        env: { PATH: PLACEHOLDERS.path, HOME: `${PLACEHOLDERS.workspace}/home`, ANTHROPIC_API_KEY: "<ANTHROPIC_API_KEY>", [`${PLACEHOLDERS.home}/key`]: "a path as a key" },
        text: "ran in <HOME>/projects and /srv/<USER>/cache and C:\\Users\\<USER>\\x and ~<USER>/notes; token <ANTHROPIC_AUTH_TOKEN> and <CLAUDE_CODE_OAUTH_TOKEN>; mail <EMAIL>; recorders stay",
      },
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the sanitiser replaces the value of every variable whose name ends in _KEY, _TOKEN, _SECRET or _PASSWORD, 8 characters or more, in both directions", () => {
  const env = {
    HOME: "/tmp/ari-unused-home",
    GEMINI_API_KEY: "AIzaSyAriSyntheticGeminiKeyForTests000",
    GITHUB_TOKEN: "github-token-value-0123",
    SESSION_SECRET: "session-secret-value",
    DB_PASSWORD: "correct-horse-battery",
    SHORT_TOKEN: "1234567",
    MONKEY: "monkey-value-0123",
    KEY: "bare-key-value-0123",
  };
  assert.deepEqual(secretVariablesOf(env), ["DB_PASSWORD", "GEMINI_API_KEY", "GITHUB_TOKEN", "SESSION_SECRET"]);
  const sanitise = createSanitiser({ workspace: "/tmp/ari-unused-workspace", env, user: "ari-nobody" });
  const printed = Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
  const expected = "HOME=<HOME> GEMINI_API_KEY=<GEMINI_API_KEY> GITHUB_TOKEN=<GITHUB_TOKEN> SESSION_SECRET=<SESSION_SECRET> DB_PASSWORD=<DB_PASSWORD> SHORT_TOKEN=1234567 MONKEY=monkey-value-0123 KEY=bare-key-value-0123";
  for (const dir of ["in", "out"] as const) {
    assert.deepEqual(sanitise({ dir, kind: "message", text: printed, [env.GEMINI_API_KEY]: "as a key" }), { dir, kind: "message", text: expected, "<GEMINI_API_KEY>": "as a key" }, `a frame going ${dir}`);
  }
});

test("in an inbound frame the user name goes wherever it is a whole word, except in a protocol word of its key at its place; in an outbound frame only from paths", () => {
  for (const user of ["user", "root", "assistant", "system", "text", "default", "message", "end", "joe"]) {
    const sanitise = createSanitiser({ workspace: "/tmp/ari-unused-workspace", env: { HOME: "/tmp/ari-unused-home", USER: user, LOGNAME: user }, user, protocolWords: CLAUDE_PROTOCOL_WORDS });
    // Every key of an SDK message whose protocol words there hold this name, set to it: those values stay.
    const protocol = Object.fromEntries(
      Object.entries(CLAUDE_PROTOCOL_WORDS["message"]!)
        .filter(([key, slot]) => slot.words?.includes(user) === true && !["message", "error"].includes(key))
        .map(([key]) => [key, user]),
    );
    const roles = ["user", "assistant", "system"].includes(user);
    const payload = {
      ...protocol,
      message: { ...(roles ? { role: user } : {}), content: [{ type: "text", text: `the ${user} ran ls as ${user}'s shell` }] },
      tool_use_result: { stdout: `drwx------ 2 ${user} ${user} 4096 Nov 24 12:00 .\n`, stderr: "" },
      error: `permission denied for ${user}`,
      file: `/var/lib/${user}/x`,
      [user]: "a key named like the account",
      untouched: `${user}_name ${user}name`,
    };
    const inbound = sanitise({ dir: "in", kind: "message", query: "q1", message: payload } as Frame);
    assert.deepEqual(
      inbound,
      {
        dir: "in",
        kind: "message",
        query: "q1",
        message: {
          ...protocol,
          message: { ...(roles ? { role: user } : {}), content: [{ type: "text", text: "the <USER> ran ls as <USER>'s shell" }] },
          tool_use_result: { stdout: "drwx------ 2 <USER> <USER> 4096 Nov 24 12:00 .\n", stderr: "" },
          error: "permission denied for <USER>",
          file: "/var/lib/<USER>/x",
          [user]: "a key named like the account",
          untouched: `${user}_name ${user}name`,
        },
      },
      `account ${user}, inbound`,
    );
    const outbound = sanitise({ dir: "out", kind: "prompt", query: "q1", message: payload } as Frame);
    assert.deepEqual(outbound, { dir: "out", kind: "prompt", query: "q1", message: { ...payload, file: "/var/lib/<USER>/x" } }, `account ${user}, outbound: only the path changes`);
  }
});

test("a word the pinned types allow for a key at one place loses the user name at another: an opaque tool result's name, status and error, an agent's _meta, a tool's name", () => {
  const sanitiseAs = (user: string, protocolWords: ProtocolWords) => createSanitiser({ workspace: "/tmp/ari-unused-workspace", env: { HOME: "/tmp/ari-unused-home", USER: user, LOGNAME: user }, user, protocolWords });
  // The Claude SDK types a user message's tool_use_result as unknown: none of its fields is a protocol word, whatever the key.
  for (const [user, typed] of [
    ["memory", { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_reference", tool_changes: [{ tool: { definition: { name: "memory" } } }] } } }],
    ["unknown", { type: "assistant", error: "unknown" }],
    ["running", { type: "system", subtype: "task_updated", patch: { status: "running" } }],
  ] as const) {
    const sanitise = sanitiseAs(user, CLAUDE_PROTOCOL_WORDS);
    const opaque = { type: "user", message: { role: "user", content: [] }, tool_use_result: { name: user, status: user, error: user, type: user } };
    assert.deepEqual(sanitise({ dir: "in", kind: "message", query: "q1", message: opaque } as Frame).message, { ...opaque, tool_use_result: { name: "<USER>", status: "<USER>", error: "<USER>", type: "<USER>" } }, `account ${user}: the opaque tool result loses it`);
    assert.deepEqual(sanitise({ dir: "in", kind: "message", query: "q1", message: typed } as Frame).message, typed, `account ${user}: where the SDK's types put the word, it stays`);
  }
  // A can_use_tool frame's toolName is the agent's tool name, a string in the SDK's types: sanitised like its input.
  const archive = sanitiseAs("archive", CLAUDE_PROTOCOL_WORDS);
  assert.deepEqual(archive({ dir: "in", kind: "can_use_tool", id: "p1", query: "q1", toolName: "archive", input: { name: "archive" }, options: { toolUseID: "toolu_1" } } as Frame), { dir: "in", kind: "can_use_tool", id: "p1", query: "q1", toolName: "<USER>", input: { name: "<USER>" }, options: { toolUseID: "toolu_1" } });
  // ACP: a content block's type is a protocol word; the same word in an agent's _meta is not.
  const text = sanitiseAs("text", ACP_PROTOCOL_WORDS);
  const update = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello text" }, _meta: { "ari.test/x": { type: "text" } } } } };
  assert.deepEqual(text({ dir: "in", kind: "stdout", proc: 1, message: update } as Frame), { dir: "in", kind: "stdout", proc: 1, message: { ...update, params: { ...update.params, update: { ...update.params.update, content: { type: "text", text: "hello <USER>" }, _meta: { "ari.test/x": { type: "<USER>" } } } } } });
});

test("the user names are the OS user's (os.userInfo), and USER and LOGNAME too when they differ", () => {
  const osName = os.userInfo().username;
  assert.ok(osName !== "", "the OS has a user name");
  assert.deepEqual(userNames({ env: { USER: "stale-user", LOGNAME: "other-login" } }), [osName, "stale-user", "other-login"].filter((name, index, all) => all.indexOf(name) === index));
  assert.deepEqual(userNames({ env: { USER: osName, LOGNAME: osName } }), [osName]);
  const sanitise = createSanitiser({ workspace: "/tmp/ari-unused-workspace", env: { HOME: "/tmp/ari-unused-home", USER: "stale-user", LOGNAME: "other-login" } });
  assert.equal(sanitise(`/srv/${osName}/a /srv/stale-user/b /srv/other-login/c`), "/srv/<USER>/a /srv/<USER>/b /srv/<USER>/c");
});

test("under Bun with USER and LOGNAME stripped, where os.userInfo() says unknown, the sanitiser still finds the OS user name and replaces it", () => {
  const account = osUserName();
  assert.ok(account !== undefined && account !== "" && account !== "unknown", `the OS has a user name: ${String(account)}`);
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-bun-user-")));
  try {
    const home = path.join(directory, "child-home");
    fs.mkdirSync(home);
    const script = path.join(directory, "probe.ts");
    fs.writeFileSync(
      script,
      [
        'import * as os from "node:os";',
        `const { createSanitiser } = await import(${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "test", "recordings", "sanitiser.ts")).href)});`,
        'const sanitise = createSanitiser({ workspace: "/tmp/ari-unused-workspace", env: { HOME: process.env.HOME } });',
        "const name = process.env.ARI_TEST_ACCOUNT;",
        'process.stdout.write(JSON.stringify({ reported: os.userInfo().username, user: process.env.USER ?? null, logname: process.env.LOGNAME ?? null, out: sanitise(`drwx------ 2 ${name} ${name} 4096 Nov 25 12:00 project`) }));',
      ].join("\n"),
    );
    const env: { [name: string]: string } = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== "USER" && name !== "LOGNAME") env[name] = value;
    Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"), ARI_TEST_ACCOUNT: account });
    // Bun runs the probe: the runtime running this test under `bun test`, else the bun on PATH (every CI leg installs it).
    const bun = process.versions["bun"] === undefined ? "bun" : process.execPath;
    const run = spawnSync(bun, [script], { cwd: directory, encoding: "utf8", env });
    assert.equal(run.status, 0, `${bun} ${script}: ${run.error?.message ?? run.stderr}`);
    const probe = JSON.parse(run.stdout) as { reported: string; user: string | null; logname: string | null; out: string };
    assert.deepEqual({ user: probe.user, logname: probe.logname }, { user: null, logname: null }, "the probe ran without USER and LOGNAME");
    assert.ok(probe.reported === "unknown" || probe.reported === account, `Bun's os.userInfo().username: ${probe.reported}`);
    assert.equal(probe.out, `drwx------ 2 ${PLACEHOLDERS.user} ${PLACEHOLDERS.user} 4096 Nov 25 12:00 project`, `os.userInfo() said ${probe.reported}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a $HOME holding a quote, a backslash and a space is found by the scan through JSON's escaping, and the sanitiser removes it", () => {
  // A child of a plain temp dir: Bun 1.3.14's realpath and mkdtemp take a backslash for a separator.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-scan-escaped-")));
  const home = path.join(base, 'home "Lab" \\ dir');
  fs.mkdirSync(home);
  try {
    assert.ok(home.includes('"') && home.includes("\\") && home.includes(" "), home);
    const line = JSON.stringify({ dir: "in", kind: "message", text: `${home}/config/file` });
    assert.ok(!line.includes(home), "JSON escapes the quote and the backslash");
    const findings = scanRecordingText(line, "escaped.ndjson", { home });
    assert.deepEqual(
      findings.map((finding) => [finding.line, finding.rule]),
      [[1, "machine-home"]],
    );
    // A path JSON writes with \/ is decoded too.
    assert.deepEqual(
      scanRecordingText('{"text":"\\/home\\/alice\\/x"}', "slashes.ndjson").map((finding) => finding.rule),
      ["home-path"],
    );
    const sanitise = createSanitiser({ workspace: "/tmp/ari-unused-workspace", env: { HOME: home } });
    const text = encodeRecording(METADATA, [sanitise({ dir: "in", kind: "message", query: "q1", text: `${home}/config/file`, [`${home}/key`]: home } as Frame)]);
    assert.deepEqual(scanRecordingText(text, "sanitised.ndjson", { home }), []);
    assert.ok(text.includes('"text":"<HOME>/config/file"'), text);
    const root = tempRepo({ "test/drivers/claude/recordings/escaped.ndjson": encodeRecording(METADATA, [{ dir: "in", kind: "message", query: "q1", text: `${home}/x` }]) });
    try {
      const environment = { ...scanEnvironment(), HOME: home };
      const failed = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "check-recordings.ts"), "--root", root], { encoding: "utf8", env: environment });
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(failed.stderr, /test\/drivers\/claude\/recordings\/escaped\.ndjson:2: machine-home: a path starting with this machine's \$HOME \(in a decoded JSON string\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the sanitiser's output for a frame holding each planted pattern passes the scan", () => {
  const sanitise = createSanitiser({ workspace: "/tmp/ari-unused-workspace", env: { HOME: SCANNING_HOME, USER: "nobody-in-particular" } });
  for (const planted of PLANTED) {
    const frame: Frame = { dir: "in", kind: "message", query: "q1", message: { type: "assistant", text: `I wrote it to ${planted.value} for you.`, [planted.value]: planted.value } };
    const text = encodeRecording(METADATA, [sanitise(frame)]);
    assert.deepEqual(scanRecordingText(text, "sanitised.ndjson", { home: SCANNING_HOME }), [], `${planted.name}: ${text}`);
  }
  const everything: Frame = { dir: "in", kind: "message", query: "q1", text: PLANTED.map((planted) => planted.value).join(" and ") };
  assert.deepEqual(scanRecordingText(encodeRecording(METADATA, [sanitise(everything)]), "all.ndjson", { home: SCANNING_HOME }), []);
});

test("check:recordings is a step of both gate chains, in the same position", () => {
  const scripts = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["check:recordings"], "node scripts/check-recordings.ts");
  const gate = scripts["gate"]!.split(" && ");
  const gateBun = scripts["gate:bun"]!.split(" && ");
  assert.ok(gate.includes("pnpm run check:recordings"));
  assert.ok(gateBun.includes("pnpm run check:recordings"));
  assert.equal(gate.length - gate.indexOf("pnpm run check:recordings"), gateBun.length - gateBun.indexOf("pnpm run check:recordings"));
});

test("the value under a key that names an account or organisation id becomes <ACCOUNT_ID> or <ORG_ID>, in both directions; other ids stay", () => {
  const sanitise = createSanitiser({ workspace: "/tmp/ari-unused-workspace", env: { HOME: "/tmp/ari-unused-home" }, user: "ari-nobody" });
  // As OpenCode 2.1.2's GET /api/model gives them: request headers of the models of the user's providers.
  const ids = {
    "chatgpt-account-id": "0b6f1d1e-6a4e-4c39-9d4c-6a4f3b9e2c11",
    "x-opencode-org-id": "org_01ARISYNTHETICORG000000000",
    accountUuid: "5f2b9c3a-0000-4000-8000-00000000a11c",
    account_id: "acct_0123",
    organizationUuid: "7d1c2b3a-0000-4000-8000-0000000000e9",
    organization_id: "org-0123",
    orgId: "o-42",
  };
  const kept = { sessionID: "ses_0001", projectID: "a762c972", aggregateID: "ses_0001", parent_agent_id: "agent-1", providerID: "openai", modelID: "gpt", id: "x", api_message_id: "msg_1", empty_account_id: "" };
  for (const dir of ["in", "out"] as const) {
    const out = sanitise({ dir, kind: "response", id: 3, body: { data: [{ headers: ids, ...kept }] } });
    assert.deepEqual(
      out,
      {
        dir,
        kind: "response",
        id: 3,
        body: { data: [{ headers: { "chatgpt-account-id": "<ACCOUNT_ID>", "x-opencode-org-id": "<ORG_ID>", accountUuid: "<ACCOUNT_ID>", account_id: "<ACCOUNT_ID>", organizationUuid: "<ORG_ID>", organization_id: "<ORG_ID>", orgId: "<ORG_ID>" }, ...kept }] },
      },
      `a frame going ${dir}`,
    );
  }
});

test("resanitiseRecording runs a recording through the sanitiser again with a new checksum, keeps its header, and leaves one with nothing new to replace byte-identical", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-resanitise-"));
  try {
    const opencode: RecordingMetadata = { ...METADATA, driver: "opencode", vendor: "opencode", vendorVersion: "2.1.2", sdk: "@opencode/client", sdkVersion: "2.1.2", model: "anthropic/claude-haiku-5-5", source: "live" };
    const holding = path.join(directory, "simple.ndjson");
    const frames: Frame[] = [
      { dir: "out", kind: "request", id: 3, method: "GET", path: "/api/model", query: { "location[directory]": "" } },
      { dir: "in", kind: "response", id: 3, status: 200, contentType: "application/json", body: { data: [{ providerID: "anthropic", modelID: "claude-haiku-5-5", name: "Claude Haiku 5.5", headers: { "x-opencode-org-id": "org_01ARISYNTHETICORG000000000" }, enabled: true, limit: { context: 1000000, output: 128000 } }, { providerID: "openai", modelID: "gpt", headers: { "chatgpt-account-id": "0b6f1d1e-6a4e-4c39-9d4c-6a4f3b9e2c11", originator: "opencode" } }] } },
      { dir: "in", kind: "event", id: 4, event: { type: "account.updated", data: { "chatgpt-account-id": "0b6f1d1e-6a4e-4c39-9d4c-6a4f3b9e2c11", "x-opencode-org-id": "org_01ARISYNTHETICORG000000000" } } },
      { dir: "in", kind: "event", id: 4, event: { type: "session.text.delta", data: { delta: "ok, <WORKSPACE>/cwd for <USER>" } } },
    ];
    fs.writeFileSync(holding, encodeRecording(opencode, frames));
    assert.equal(await resanitiseRecording(holding, { env: { HOME: "/tmp/ari-unused-home" }, user: "ari-nobody" }), true);
    const again = await readRecording(holding);
    const { type: _type, format: _format, sha256: _sha256, ...header } = again.header;
    assert.deepEqual(header, opencode, "the header stays as the recorder wrote it");
    const text = fs.readFileSync(holding, "utf8");
    assert.ok(!text.includes("0b6f1d1e") && !text.includes("org_01ARI"), text);
    assert.deepEqual(
      again.frames.map((entry) => entry.frame),
      [
        frames[0],
        // The header's model is the recorded one: the model list keeps only it, with only the fields the driver reads.
        { ...frames[1], body: { data: [{ providerID: "anthropic", modelID: "claude-haiku-5-5", name: "Claude Haiku 5.5", enabled: true, limit: { context: 1000000 } }] } },
        { ...frames[2], event: { type: "account.updated", data: { "chatgpt-account-id": "<ACCOUNT_ID>", "x-opencode-org-id": "<ORG_ID>" } } },
        frames[3],
      ],
    );
    // A second pass, and a recording with only placeholders, change nothing.
    assert.equal(await resanitiseRecording(holding, { env: { HOME: "/tmp/ari-unused-home" }, user: "ari-nobody" }), false);
    assert.equal(fs.readFileSync(holding, "utf8"), text);
    const clean = path.join(directory, "clean.ndjson");
    fs.writeFileSync(clean, encodeRecording(METADATA, CLEAN));
    const before = fs.readFileSync(clean, "utf8");
    assert.equal(await resanitiseRecording(clean, { env: { HOME: "/tmp/ari-unused-home" }, user: "ari-nobody" }), false);
    assert.equal(fs.readFileSync(clean, "utf8"), before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// The host's ruling "account details stay out": each kind, as the real Claude Code 2.1.330 and OpenCode 2.1.2 sent it.
const ACCOUNT_DETAIL_FRAMES: Frame[] = [
  // Claude Code's initializationResult(): the plan, the native process id, and the models the plan offers.
  {
    dir: "in",
    kind: "result",
    id: 1,
    value: {
      account: { email: "someone@example.org", subscriptionType: "Claude Max", apiProvider: "firstParty" },
      pid: 2294915,
      models: [
        { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
        { value: "fable", resolvedModel: "claude-fable-5-2", displayName: "Fable" },
        { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku" },
      ],
    },
  },
  // A rate-limit report, with usage figures, reset times and the overage state.
  {
    dir: "in",
    kind: "message",
    query: "q1",
    message: {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", resetsAt: 1796072400, rateLimitType: "seven_day", utilization: 0.78, overageStatus: "rejected", overageDisabledReason: "out_of_credits", isUsingOverage: false, surpassedThreshold: 0.75, unifiedWindows: { seven_day: { utilization: 0.78, resetsAt: 1796072400, status: "allowed_warning", surpassedThreshold: 0.75 } }, overageEnabled: true },
      uuid: "dacce09b-8780-4565-b346-ff68f7bdfea6",
      session_id: "a11ce000-0000-4000-8000-000000000001",
    },
  },
  // Credential expiry times: Claude Code's result message, and the number forms.
  { dir: "in", kind: "message", query: "q1", message: { type: "result", subtype: "success", credential_expires_at: "2026-12-16T12:44:44.039Z", tokenExpiresAt: 1796000000000, oauth_expires_at: 1796000000 } },
  // Temp paths: Claude Code's messaging socket, OpenCode's GET /api/info tmp path and process id.
  { dir: "in", kind: "message", query: "q1", message: { type: "system", subtype: "init", messaging_socket_path: "/tmp/cc-socks/2294915.sock" } },
  { dir: "in", kind: "response", id: 1, status: 200, contentType: "application/json", body: { version: "2.1.2", pid: 2309969, urls: ["http://127.0.0.1:41117"], paths: { tmp: "/var/tmp/opencode/session.1YX2c84S/opencode" }, capabilities: { persistentPty: true } } },
  // OpenCode's GET /api/model: every provider the user is signed in to, and how.
  {
    dir: "in",
    kind: "response",
    id: 3,
    status: 200,
    contentType: "application/json",
    body: {
      location: { directory: "<WORKSPACE>/cwd" },
      data: [
        { id: "claude-haiku-5-5", modelID: "claude-haiku-5-5", providerID: "anthropic", name: "Claude Haiku 5.5", package: "@opencode/ai/providers/anthropic", headers: { "anthropic-beta": "fast-mode-2026-02-01" }, cost: [{ input: 0.1, output: 0.5 }], status: "active", enabled: true, limit: { context: 1000000, output: 128000 } },
        { id: "claude-opus-5-5", modelID: "claude-opus-5-5", providerID: "anthropic", name: "Claude Opus 5.5", enabled: true, limit: { context: 1000000 } },
        { id: "gpt-6-sol", modelID: "gpt-6-sol", providerID: "openai", name: "GPT-6 Sol", settings: { baseURL: "https://chatgpt.com/backend-api/codex", body: { service_tier: "priority" } }, headers: { "chatgpt-account-id": "0b6f1d1e-6a4e-4c39-9d4c-6a4f3b9e2c11" }, enabled: true },
        { id: "m", modelID: "m", providerID: "github-copilot", name: "M", settings: { baseURL: "https://api.githubcopilot.com" }, enabled: true },
      ],
    },
  },
  // OpenCode's shell.created event names the machine's login shell.
  { dir: "in", kind: "event", id: 4, event: { type: "shell.created", data: { info: { id: "sh_1", status: "running", command: "printf x", cwd: "<WORKSPACE>/cwd", shell: "/usr/bin/zsh" } } } },
];

test("each account detail of the host's ruling becomes a fixed neutral value of the same type: plan name, rate-limit figures, credential expiry, process id, temp and socket paths, shell, and every model but the recorded one", () => {
  const sanitise = createSanitiser({ workspace: "/tmp/ari-unused-workspace", env: { HOME: "/tmp/ari-unused-home" }, user: "ari-nobody", recordedModel: "anthropic/claude-haiku-5-5" });
  const out = ACCOUNT_DETAIL_FRAMES.map((frame) => sanitise(frame));
  const claude = createSanitiser({ workspace: "/tmp/ari-unused-workspace", env: { HOME: "/tmp/ari-unused-home" }, user: "ari-nobody", recordedModel: "haiku" });
  assert.deepEqual((claude(ACCOUNT_DETAIL_FRAMES[0]!)["value"] as { [key: string]: unknown }), {
    account: { email: "<EMAIL>", subscriptionType: "<PLAN>", apiProvider: "firstParty" },
    pid: NEUTRAL_PID,
    models: [{ value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku" }],
  }, "the plan, the process id and every model but the recorded one");
  assert.deepEqual((out[1]!["message"] as { rate_limit_info: unknown }).rate_limit_info, NEUTRAL_RATE_LIMIT_INFO, "the rate-limit report");
  assert.deepEqual(out[2]!["message"], { type: "result", subtype: "success", credential_expires_at: NEUTRAL_TIME.iso, tokenExpiresAt: NEUTRAL_TIME.milliseconds, oauth_expires_at: NEUTRAL_TIME.seconds }, "credential expiry, as a string, in milliseconds and in seconds");
  assert.deepEqual(out[3]!["message"], { type: "system", subtype: "init", messaging_socket_path: NEUTRAL_SOCKET_PATH });
  assert.deepEqual(out[4]!["body"], { version: "2.1.2", pid: NEUTRAL_PID, urls: ["http://127.0.0.1:41117"], paths: { tmp: NEUTRAL_TMP_PATH }, capabilities: { persistentPty: true } });
  assert.deepEqual(out[5]!["body"], { location: { directory: "<WORKSPACE>/cwd" }, data: [{ providerID: "anthropic", modelID: "claude-haiku-5-5", name: "Claude Haiku 5.5", enabled: true, limit: { context: 1000000 } }] }, "only the recorded model, with only the fields the driver reads");
  assert.equal(((out[6]!["event"] as { data: { info: { shell: unknown } } }).data.info.shell), NEUTRAL_SHELL);
  // Of the same type, so a driver still parses them: OpenCode's driver takes /api/info as OpenCode's only when pid is a number.
  assert.equal(typeof (out[4]!["body"] as { pid: unknown }).pid, "number");
  assert.equal(typeof NEUTRAL_RATE_LIMIT_INFO.resetsAt, "number");
  // A second pass changes nothing, and nothing the scan refuses is left.
  assert.deepEqual(out.map((frame) => sanitise(frame)), out);
  const text = encodeRecording({ ...METADATA, driver: "opencode", model: "anthropic/claude-haiku-5-5" }, out);
  for (const leaked of ["Claude Max", "0.78", "out_of_credits", "1796072400", "2026-12-16", "2294915", "2309969", "cc-socks", "session.1YX2c84S", "openai", "github-copilot", "chatgpt", "claude-opus-5-5", "zsh"]) assert.ok(!text.includes(leaked), `${leaked} is gone`);
  assert.ok(!encodeRecording(METADATA, [claude(ACCOUNT_DETAIL_FRAMES[0]!)]).includes("claude-fable-5-2"), "the Claude models the plan offers are gone");
  assert.deepEqual(scanRecordingText(text, "account-details.ndjson", { home: SCANNING_HOME }), []);
});

test("the account-detail rules apply in both directions, and without a recorded model a model list stays whole", () => {
  const sanitise = createSanitiser({ workspace: "/tmp/ari-unused-workspace", env: { HOME: "/tmp/ari-unused-home" }, user: "ari-nobody" });
  assert.deepEqual(sanitise({ dir: "out", kind: "request", id: 9, body: { pid: 42, subscriptionType: "Claude Max", paths: { tmp: "/var/tmp/x" } } }), { dir: "out", kind: "request", id: 9, body: { pid: NEUTRAL_PID, subscriptionType: "<PLAN>", paths: { tmp: NEUTRAL_TMP_PATH } } });
  const list = (ACCOUNT_DETAIL_FRAMES[5]!["body"] as { data: Array<{ providerID: string }> }).data;
  const kept = (sanitise(ACCOUNT_DETAIL_FRAMES[5]!)["body"] as { data: Array<{ providerID: string }> }).data;
  assert.deepEqual(kept.map((entry) => entry.providerID), list.map((entry) => entry.providerID));
  // Fields of other types, and other keys, stay: a status, a model's own shell tool, a path-less shell name.
  assert.deepEqual(sanitise({ dir: "in", kind: "event", id: 1, event: { status: "allowed_warning", name: "shell", shell: "bash", pid: "not-a-number" } }), { dir: "in", kind: "event", id: 1, event: { status: "allowed_warning", name: "shell", shell: "bash", pid: "not-a-number" } });
});

test("ACP's usage figures, a quota's figures and reset time, credit balances and per-provider sign-in status become neutral values of the same type, keyed on their fields, and the usage shapes of other agents stay", () => {
  const sanitise = createSanitiser({ workspace: "/tmp/ari-unused-workspace", env: { HOME: "/tmp/ari-unused-home" }, user: "ari-nobody" });
  const update = (value: unknown): Frame => ({ dir: "in", kind: "stdout", proc: 1, message: { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: value } } });
  const updateOf = (frame: Frame): unknown => ((frame["message"] as { params: { update: unknown } }).params.update);
  // ACP UsageUpdate with its Cost; and the unstable Usage of a prompt's result.
  assert.deepEqual(updateOf(sanitise(update({ sessionUpdate: "usage_update", used: 3271, size: 131072, cost: { amount: 0.02187, currency: "USD" } }))), { sessionUpdate: "usage_update", used: 0, size: 0, cost: { amount: 0, currency: "USD" } });
  assert.deepEqual(
    sanitise({ dir: "in", kind: "stdout", proc: 1, message: { jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn", usage: { totalTokens: 4100, inputTokens: 3900, outputTokens: 200, thoughtTokens: 64, cachedReadTokens: 2048, cachedWriteTokens: null } } } }),
    { dir: "in", kind: "stdout", proc: 1, message: { jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn", usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedReadTokens: 0, cachedWriteTokens: null } } } },
  );
  // A quota bucket and credits as the Antigravity CLI 1.5.17 binary names them, and a reset time in seconds.
  assert.deepEqual(
    sanitise({ remainingFraction: 0.239, remainingAmount: "412", resetTime: "2026-11-26T03:00:00Z", resetsAt: 1796072400, usedPromptCredits: 18307, availableCredits: "1693", consumedCredits: 12.5, userTierId: "g1-ultra-tier", tierName: "Ultra" }),
    { remainingFraction: 0, remainingAmount: "0", resetTime: NEUTRAL_TIME.iso, resetsAt: NEUTRAL_TIME.seconds, usedPromptCredits: 0, availableCredits: "0", consumedCredits: 0, userTierId: PLACEHOLDERS.plan, tierName: PLACEHOLDERS.plan },
  );
  // Sign-in status: a list of providers with theirs goes whole; a status on its own becomes signed in, needing no sign-in.
  assert.deepEqual(
    sanitise({ providers: [{ id: "google", isAuthenticated: true }, { id: "vertex", signed_in: false, needs_auth: true }], account: { loggedIn: false, needsAuth: true, isAuthenticated: "yes" } }),
    { providers: [], account: { loggedIn: true, needsAuth: false, isAuthenticated: "yes" } },
  );
  // Other shapes stay: Claude Code's turn usage (snake-case counts), OpenCode's cost per message (a number), a list without sign-in status, ACP's authMethods.
  const others = {
    usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 0 },
    cost: 0.0123,
    tokens: { input: 12, output: 3 },
    providers: [{ id: "google", name: "Google" }],
    authMethods: [{ id: "oauth-personal", name: "Log in with Google", description: null }],
    size: 4096,
    used: 7,
  };
  assert.deepEqual(sanitise(others), others);
});
