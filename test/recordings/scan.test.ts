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
import { recordingFiles, scanRecordingText, scanRecordings } from "../../scripts/check-recordings.ts";
import { REPO_ROOT } from "../helpers/spec.ts";
import { encodeRecording, parseRecording } from "./format.ts";
import type { Frame, RecordingMetadata } from "./format.ts";
import { PLACEHOLDERS, createSanitiser } from "./sanitiser.ts";

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
  { dir: "out", kind: "query", query: "q1", prompt: "stream", options: { cwd: "<WORKSPACE>/cwd", env: { PATH: "<PATH>", HOME: "<WORKSPACE>/home" } } },
  { dir: "out", kind: "prompt", query: "q1", message: { type: "user", message: { role: "user", content: [{ type: "text", text: "Reply with one word" }] } } },
  { dir: "in", kind: "message", query: "q1", message: { type: "system", subtype: "init", cwd: "<WORKSPACE>/cwd", model: "claude-haiku", account: { email: "<EMAIL>" } } },
  { dir: "in", kind: "message", query: "q1", message: { type: "assistant", message: { content: [{ type: "text", text: "ok, see https://example.com/home/docs and ask-anything" }] } } },
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
  { name: "a path under the scanning machine's $HOME", value: `${SCANNING_HOME}/.claude.json`, rule: "machine-home" },
  { name: "an email address", value: "alice.smith+claude@example.co.uk", rule: "email" },
  { name: "an Anthropic key", value: "sk-ant-api03-AbCdEf0123456789", rule: "token" },
  { name: "an sk- key", value: "sk-proj0123456789abcdefABCDEF", rule: "token" },
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

test("the sanitiser replaces the workspace, $HOME, the user name and the credential values with fixed placeholders, and emails", () => {
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
    const sanitise = createSanitiser({ workspace, env });
    const frame = {
      dir: "out",
      kind: "query",
      options: {
        cwd: `${workspace}/cwd`,
        env: { PATH: env.PATH, HOME: `${workspace}/home`, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, [`${env.HOME}/key`]: "a path as a key" },
        text: `recorder ran in ${env.HOME}/projects as recorder; token ${env.ANTHROPIC_AUTH_TOKEN} and ${env.CLAUDE_CODE_OAUTH_TOKEN}; mail recorder@example.org; recorders stay`,
      },
    };
    assert.deepEqual(sanitise(frame), {
      dir: "out",
      kind: "query",
      options: {
        cwd: `${PLACEHOLDERS.workspace}/cwd`,
        env: { PATH: PLACEHOLDERS.path, HOME: `${PLACEHOLDERS.workspace}/home`, ANTHROPIC_API_KEY: "<ANTHROPIC_API_KEY>", [`${PLACEHOLDERS.home}/key`]: "a path as a key" },
        text: "<USER> ran in <HOME>/projects as <USER>; token <ANTHROPIC_AUTH_TOKEN> and <CLAUDE_CODE_OAUTH_TOKEN>; mail <EMAIL>; recorders stay",
      },
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
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
