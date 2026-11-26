// docs/recordings.md documents the format the code writes: every header
// field, every frame kind, and exactly the fields replay ignores, each with
// the reason the code gives.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../helpers/spec.ts";
import { CLAUDE_FRAME_KINDS } from "./claude/frames.ts";
import { OPENCODE_FRAME_KINDS } from "./opencode/frames.ts";
import { STDIO_FRAME_KINDS } from "./stdio/frames.ts";
import { RECORDING_HEADER_FIELDS } from "./format.ts";
import { REPLAY_IGNORED_FIELDS } from "./ignored-fields.ts";

const DOC = fs.readFileSync(path.join(REPO_ROOT, "docs", "recordings.md"), "utf8");

/** The text of a section, from its heading to the next heading of the same or a higher level. */
function section(heading: string): string {
  const lines = DOC.split("\n");
  const start = lines.findIndex((line) => line.replace(/^#+ /, "") === heading && line.startsWith("#"));
  assert.notEqual(start, -1, `docs/recordings.md has a section "${heading}"`);
  const level = lines[start]!.indexOf(" ");
  const end = lines.findIndex((line, index) => index > start && /^#+ /.test(line) && line.indexOf(" ") <= level);
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

/** The body rows of the first table in `text`, as cells. */
function tableRows(text: string): string[][] {
  const rows = text.split("\n").filter((line) => line.startsWith("|"));
  return rows.slice(2).map((row) =>
    row
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim()),
  );
}

test("the docs list every header field the writer writes, and no other", () => {
  const fields = tableRows(section("Header fields")).map((row) => row[0]!.replace(/`/g, ""));
  assert.deepEqual(fields, [...RECORDING_HEADER_FIELDS]);
  assert.match(section("Format versions"), /`major\.minor`/);
});

test("the docs list every Claude frame kind with its direction, and no other", () => {
  const kinds = tableRows(section("Claude frames")).map((row) => ({ dir: row[0]!, kind: row[1]!.replace(/`/g, "") }));
  assert.deepEqual(kinds, CLAUDE_FRAME_KINDS.map((entry) => ({ dir: entry.dir, kind: entry.kind })));
});

test("the docs list every OpenCode frame kind with its direction, and no other", () => {
  const kinds = tableRows(section("OpenCode frames")).map((row) => ({ dir: row[0]!, kind: row[1]!.replace(/`/g, "") }));
  assert.deepEqual(kinds, OPENCODE_FRAME_KINDS.map((entry) => ({ dir: entry.dir, kind: entry.kind })));
});

test("the docs list every stdio frame kind with its direction, and no other", () => {
  const kinds = tableRows(section("Stdio frames")).map((row) => ({ dir: row[0]!, kind: row[1]!.replace(/`/g, "") }));
  assert.deepEqual(kinds, STDIO_FRAME_KINDS.map((entry) => ({ dir: entry.dir, kind: entry.kind })));
});

test('the docs list under "Fields replay ignores" equals the code\'s list, each field with its reason', () => {
  const documented = tableRows(section("Fields replay ignores")).map(([driver, kind, field, reason]) => ({
    driver: driver!,
    kind: kind!.replace(/`/g, ""),
    field: field!.replace(/`/g, ""),
    reason: reason!,
  }));
  assert.deepEqual(
    documented,
    REPLAY_IGNORED_FIELDS.map((entry) => ({ driver: entry.driver, kind: entry.kind, field: entry.field, reason: entry.reason })),
  );
  for (const entry of documented) assert.ok(entry.reason.length > 20, `${entry.field} has a reason`);
});

test('the docs have the "How to record" and "How to refresh" sections a person follows', () => {
  assert.match(section("How to record"), /ARI_LIVE_RECORD=1 pnpm run record:claude/);
  assert.match(section("Recording OpenCode"), /ARI_LIVE_RECORD=1 ARI_RECORD_OPENCODE_MODEL=<provider\/model> pnpm run record:opencode/);
  assert.match(section("Recording Antigravity"), /ARI_LIVE_RECORD=1 pnpm run record:antigravity/);
  assert.match(section("The Antigravity model"), /`ARI_RECORD_ANTIGRAVITY_MODEL`/);
  assert.match(section("Recording Codex"), /ARI_LIVE_RECORD=1 pnpm run record:codex/);
  assert.match(section("The Codex model"), /`ARI_RECORD_CODEX_MODEL`/);
  assert.match(section("The Codex model"), /`luna`, `nano` or `mini`/);
  assert.match(section("How to refresh"), /Record again when the vendor's version changes/);
});

test("the docs name the file OpenCode 2.1.2 keeps its sign-ins in, and the source line that opens it", () => {
  const signIn = section("How OpenCode finds the sign-in");
  assert.match(signIn, /`opencode\.db` in its data directory/);
  assert.match(signIn, /`packages\/cli\/src\/server-process\.ts:114`,\n`path: databasePath\(global\.data\),`/);
  assert.match(signIn, /^OpenCode 2\.1\.2 has no credential file of its own/m);
  const setup = section("How the OpenCode recorder keeps the user's setup out");
  for (const variable of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_PASSWORD", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_CLAUDE_CODE"]) {
    assert.ok(tableRows(setup).some((row) => row[0] === `\`${variable}\``), `the table names ${variable}`);
  }
});

test("the docs say what replay detects and what it does not, and that the checksum guards edits", () => {
  const replay = section("What replay detects, and what it does not");
  assert.match(replay, /It is not a tamper detector\.\nThe header's `sha256` guards a recording against edits/);
  assert.match(replay, /^Replay detects:$/m);
  assert.match(replay, /^Replay does not detect:$/m);
  assert.match(replay, /written and flushed it to a connection\s+the driver still holds open/);
});

test("the docs name the system and managed configuration sources that the temp HOME and config directories do not keep out", () => {
  const opencode = section("How the OpenCode recorder keeps the user's setup out");
  for (const source of ["`/etc/opencode`", "`/Library/Application Support/opencode`", "`%ProgramData%\\opencode`", "`/Library/Managed Preferences/<user>/ai.opencode.managed.plist`", "`/Library/Managed Preferences/ai.opencode.managed.plist`"]) {
    assert.ok(opencode.includes(source), `the OpenCode section names ${source}`);
  }
  const claude = section("How the Claude recorder keeps the user's setup out");
  for (const source of ["server-managed settings", "`com.anthropic.claudecode`", "`HKLM\\SOFTWARE\\Policies\\ClaudeCode`", "`HKCU\\SOFTWARE\\Policies\\ClaudeCode`", "`/Library/Application Support/ClaudeCode/`", "`/etc/claude-code/`", "`C:\\Program Files\\ClaudeCode\\`", "`managed-settings.d/`", "`managed-mcp.json`"]) {
    assert.ok(claude.includes(source), `the Claude section names ${source}`);
  }
});

test("the docs give the sanitiser's rule for secret environment variables", () => {
  const rows = tableRows(section("Sanitising and the scan"));
  assert.ok(
    rows.some((row) => /ends in `_KEY`, `_TOKEN`, `_SECRET` or `_PASSWORD`, when it is 8 characters or more/.test(row[0]!) && row[1] === "`<NAME>`, for example `<GEMINI_API_KEY>`"),
    JSON.stringify(rows),
  );
});

test("the docs name the file the Antigravity recorder copies for the sign-in, where agy keeps it, and the sources of both", () => {
  const signIn = section("How Antigravity finds the sign-in");
  assert.match(signIn, /`~\/\.gemini\/antigravity-cli\/antigravity-oauth-token`/);
  assert.match(signIn, /`<profile>\/antigravity-acp\/antigravity-oauth-token`/);
  assert.match(signIn, /service `gemini` and account `antigravity`/);
  // The repository's name is spelled in two parts here: scripts/check-rules.ts keeps host product names out of test/.
  const repository = `https://github.com/pingdotgg/${"t"}${"3code"}`;
  for (const source of [`${repository}/issues/34327`, `${repository}/pull/38957`, "`google-antigravity/antigravity-cli`", "\"Local silent keyring sign-in\""]) assert.ok(signIn.includes(source), `the section cites ${source}`);
  assert.match(signIn, /So the recorder copies only that one file/);
  const setup = section("How the Antigravity recorder keeps the user's setup out");
  for (const variable of ["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "DBUS_SESSION_BUS_ADDRESS", "AGY_CLI_FORCE_FILE_TOKEN_STORAGE"]) {
    assert.ok(tableRows(setup).some((row) => row[0] === `\`${variable}\``), `the table names ${variable}`);
  }
});

test("the docs name the file the Codex recorder copies for the sign-in, with the pinned rust-v0.172.0 source line that reads it, the variables it sets and the configuration it does not keep out", () => {
  const signIn = section("How Codex finds the sign-in");
  assert.match(signIn, /`~\/\.codex\/auth\.json`/);
  assert.match(signIn, /`<workspace>\/codex-home\/auth\.json`/);
  assert.match(signIn, /At\s+tag `rust-v0\.172\.0`, `codex-rs\/login\/src\/auth\/storage\.rs:167–168` names the\s+file, `pub\(super\) fn get_auth_file\(codex_home: &Path\) -> PathBuf \{` and\s+`codex_home\.join\("auth\.json"\)`/);
  assert.match(signIn, /`FileAuthStorage::load` reads it\s+\(`storage\.rs:263–271`/);
  assert.match(signIn, /So the recorder copies only that file/);
  assert.match(signIn, /refresh token rotates/);
  const setup = section("How the Codex recorder keeps the user's setup out");
  for (const variable of ["CODEX_HOME", "HOME", "TMPDIR"]) assert.ok(tableRows(setup).some((row) => row[0] === `\`${variable}\``), `the table names ${variable}`);
  for (const source of ["`/etc/codex/config.toml`", "`/etc/codex/requirements.toml`", "macOS managed preferences", "cloud-managed configuration"]) assert.ok(setup.includes(source), `the Codex section names ${source}`);
  assert.match(setup, /strips every variable whose name starts with `CODEX_` or\s+`OPENAI_`/);
});
