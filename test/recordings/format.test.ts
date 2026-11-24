// The native recording format and its loader (docs/recordings.md, "The
// format"): a recording whose format major is newer is refused naming both
// versions, a newer minor is read, a malformed line is refused naming the
// file and line, and a body that does not match its checksum is refused
// naming the file.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { RECORDING_FORMAT_VERSION, RecordingFormatError, encodeBody, encodeRecording, parseRecording, readRecording, sha256Hex, writeRecording } from "./format.ts";
import type { Frame, RecordingMetadata } from "./format.ts";

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

const FRAMES: Frame[] = [
  { dir: "out", kind: "query", query: "q1", prompt: "stream", options: { cwd: "<WORKSPACE>/cwd" } },
  { dir: "in", kind: "message", query: "q1", message: { type: "result", subtype: "success" } },
  { dir: "in", kind: "end", query: "q1" },
];

/** A recording's text with the header changed by `edit`, its checksum still that of the body. */
function withHeader(edit: (header: { [field: string]: unknown }) => void, body = encodeBody(FRAMES)): string {
  const header: { [field: string]: unknown } = JSON.parse(encodeRecording(METADATA, FRAMES).split("\n")[0]!);
  edit(header);
  header["sha256"] = sha256Hex(body);
  return `${JSON.stringify(header)}\n${body}`;
}

test("the writer and the loader agree: header fields, frames with their lines, and the body's sha256", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-recording-format-"));
  try {
    const file = path.join(directory, "nested", "simple.ndjson");
    await writeRecording(file, METADATA, FRAMES);
    const text = fs.readFileSync(file, "utf8");
    const recording = await readRecording(file);
    assert.equal(recording.file, file);
    assert.deepEqual(recording.header, { type: "header", format: RECORDING_FORMAT_VERSION, ...METADATA, sha256: sha256Hex(text.slice(text.indexOf("\n") + 1)) });
    assert.deepEqual(
      recording.frames.map((entry) => entry.line),
      [2, 3, 4],
    );
    assert.deepEqual(
      recording.frames.map((entry) => entry.frame),
      FRAMES,
    );
    assert.equal(RECORDING_FORMAT_VERSION, "1.0");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a recording whose format major is newer than the loader reads is refused, and the error names both versions", () => {
  const text = withHeader((header) => {
    header["format"] = "2.0";
  });
  assert.throws(
    () => parseRecording(text, "recordings/future.ndjson"),
    (error: unknown) => {
      assert.ok(error instanceof RecordingFormatError);
      assert.match(error.message, /^recordings\/future\.ndjson:1: /);
      assert.match(error.message, /recording format 2\.0 is newer than this loader reads \(1\.0, any 1\.x\)/);
      return true;
    },
  );
});

test("a recording whose format minor is newer loads, with the fields it adds", () => {
  const frames: Frame[] = [...FRAMES, { dir: "in", kind: "message", query: "q1", message: { type: "system" }, addedInMinor7: true }];
  const body = encodeBody(frames);
  const text = withHeader((header) => {
    header["format"] = "1.7";
    header["addedInMinor7"] = "a header field a newer minor adds";
  }, body);
  const recording = parseRecording(text, "recordings/newer-minor.ndjson");
  assert.equal(recording.header.format, "1.7");
  assert.equal(recording.frames.length, 4);
  assert.equal(recording.frames[3]!.frame["addedInMinor7"], true);
});

test("a malformed line is refused, and the error names the file and the line number", () => {
  const lines = encodeBody(FRAMES).split("\n");
  const cases: Array<{ line: number; text: string; reason: RegExp }> = [
    { line: 3, text: "{not json", reason: /the line is not JSON/ },
    { line: 2, text: "[1, 2]", reason: /not a JSON object/ },
    { line: 4, text: JSON.stringify({ dir: "sideways", kind: "end" }), reason: /dir must be "out" or "in"/ },
    { line: 3, text: JSON.stringify({ dir: "in" }), reason: /the frame has no kind/ },
    { line: 2, text: "", reason: /the line is empty/ },
  ];
  for (const { line, text, reason } of cases) {
    const body = [...lines];
    body[line - 2] = text;
    const recording = withHeader(() => undefined, body.join("\n"));
    assert.throws(
      () => parseRecording(recording, "recordings/broken.ndjson"),
      (error: unknown) => {
        assert.ok(error instanceof RecordingFormatError, String(error));
        assert.equal(error.line, line);
        assert.match(error.message, new RegExp(`^recordings/broken\\.ndjson:${line}: `));
        assert.match(error.message, reason);
        return true;
      },
      `line ${line}: ${text}`,
    );
  }
  assert.throws(() => parseRecording("{}\n", "recordings/headless.ndjson"), /recordings\/headless\.ndjson:1: the first line is not a header/);
  assert.throws(() => parseRecording(withHeader((header) => delete header["model"]), "recordings/no-model.ndjson"), /recordings\/no-model\.ndjson:1: the header's model must be a non-empty string/);
});

test("a recording whose body does not match its checksum is refused, and the error names the file", () => {
  const text = encodeRecording(METADATA, FRAMES);
  const edited = text.replace('"subtype":"success"', '"subtype":"error_during_execution"');
  assert.notEqual(edited, text);
  assert.throws(
    () => parseRecording(edited, "test/drivers/claude/recordings/simple.ndjson"),
    (error: unknown) => {
      assert.ok(error instanceof RecordingFormatError);
      assert.equal(error.file, "test/drivers/claude/recordings/simple.ndjson");
      assert.match(error.message, /^test\/drivers\/claude\/recordings\/simple\.ndjson: the body does not match the header's sha256/);
      return true;
    },
  );
  // An appended line changes the body too.
  assert.throws(() => parseRecording(`${text}${JSON.stringify({ dir: "in", kind: "end", query: "q2" })}\n`, "appended.ndjson"), /appended\.ndjson: the body does not match/);
});
