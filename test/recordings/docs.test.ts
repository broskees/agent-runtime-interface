// docs/recordings.md documents the format the code writes: every header
// field, every frame kind, and exactly the fields replay ignores, each with
// the reason the code gives.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../helpers/spec.ts";
import { CLAUDE_FRAME_KINDS } from "./claude/frames.ts";
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
  assert.match(section("How to refresh"), /Record again when the vendor's version changes/);
});
