// The native recording format: NDJSON, one header line, then one frame per
// line in the order the frames happened. docs/recordings.md documents it.
//
// The header names the format version (`major.minor`), the driver, the
// vendor and SDK with their versions, the model, the scenario, the date, the
// source (`live` or `fake`) and the sha256 of the body: every byte after the
// header line's newline. The loader refuses a recording whose format major is
// newer than it reads, a malformed line, and a body that does not match its
// checksum. A higher minor only adds fields, so the loader reads it.

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** The format this code writes. */
export const RECORDING_FORMAT_MAJOR = 1;
export const RECORDING_FORMAT_MINOR = 0;
export const RECORDING_FORMAT_VERSION = `${RECORDING_FORMAT_MAJOR}.${RECORDING_FORMAT_MINOR}`;

/** Where the frame went: `out` from the driver to the native side, `in` from the native side to the driver. */
export type FrameDirection = "out" | "in";

export type RecordingSource = "live" | "fake";

/** The fields of the header line, in the order the writer writes them. */
export const RECORDING_HEADER_FIELDS = ["type", "format", "driver", "vendor", "vendorVersion", "sdk", "sdkVersion", "model", "scenario", "recorded", "source", "sha256"] as const;

export interface RecordingHeader {
  readonly type: "header";
  /** `major.minor`. */
  readonly format: string;
  /** The ARI driver kind, for example `claude`. */
  readonly driver: string;
  /** The agent the driver ran, for example `claude-code`. */
  readonly vendor: string;
  readonly vendorVersion: string;
  /** The package the driver talks to the agent through, for example `@anthropic-ai/claude-agent-sdk`. */
  readonly sdk: string;
  readonly sdkVersion: string;
  /** The model the recorder asked for. */
  readonly model: string;
  readonly scenario: string;
  /** The day the recording was made, `YYYY-MM-DD`. */
  readonly recorded: string;
  readonly source: RecordingSource;
  /** Hex sha256 of the body. */
  readonly sha256: string;
}

/** What a recorder knows when it writes a recording; the writer adds `type`, `format` and `sha256`. */
export type RecordingMetadata = Omit<RecordingHeader, "type" | "format" | "sha256">;

/** One recorded frame: its direction, its kind, and the kind's own fields. */
export interface Frame {
  readonly dir: FrameDirection;
  readonly kind: string;
  readonly [field: string]: unknown;
}

/** A frame with the line it sits on in its file (the header is line 1). */
export interface RecordedFrame {
  readonly line: number;
  readonly frame: Frame;
}

export interface Recording {
  readonly file: string;
  readonly header: RecordingHeader;
  readonly frames: readonly RecordedFrame[];
}

/** Every refusal of the loader. The message names the file, and the line when one line is at fault. */
export class RecordingFormatError extends Error {
  readonly file: string;
  readonly line: number | undefined;
  constructor(file: string, line: number | undefined, message: string) {
    super(`${line === undefined ? file : `${file}:${line}`}: ${message}`);
    this.name = "RecordingFormatError";
    this.file = file;
    this.line = line;
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The body text of a list of frames: one JSON line each, every line ending in a newline. */
export function encodeBody(frames: readonly Frame[]): string {
  return frames.map((frame) => `${JSON.stringify(frame)}\n`).join("");
}

/** The whole file: the header line with the body's checksum, then the body. */
export function encodeRecording(metadata: RecordingMetadata, frames: readonly Frame[]): string {
  const body = encodeBody(frames);
  const header: RecordingHeader = {
    type: "header",
    format: RECORDING_FORMAT_VERSION,
    driver: metadata.driver,
    vendor: metadata.vendor,
    vendorVersion: metadata.vendorVersion,
    sdk: metadata.sdk,
    sdkVersion: metadata.sdkVersion,
    model: metadata.model,
    scenario: metadata.scenario,
    recorded: metadata.recorded,
    source: metadata.source,
    sha256: sha256Hex(body),
  };
  return `${JSON.stringify(header)}\n${body}`;
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHeader(text: string, file: string): RecordingHeader {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RecordingFormatError(file, 1, `the header line is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isObject(value) || value["type"] !== "header") throw new RecordingFormatError(file, 1, 'the first line is not a header (an object with "type": "header")');
  const format = value["format"];
  if (typeof format !== "string" || !/^\d+\.\d+$/.test(format)) throw new RecordingFormatError(file, 1, `the header's format must be "major.minor", not ${JSON.stringify(format)}`);
  const major = Number(format.split(".")[0]);
  if (major > RECORDING_FORMAT_MAJOR) {
    throw new RecordingFormatError(file, 1, `recording format ${format} is newer than this loader reads (${RECORDING_FORMAT_VERSION}, any ${RECORDING_FORMAT_MAJOR}.x); update the loader or re-record`);
  }
  if (major < RECORDING_FORMAT_MAJOR) {
    throw new RecordingFormatError(file, 1, `recording format ${format} is older than this loader reads (${RECORDING_FORMAT_VERSION}, any ${RECORDING_FORMAT_MAJOR}.x); re-record it`);
  }
  for (const field of RECORDING_HEADER_FIELDS) {
    if (typeof value[field] !== "string" || value[field] === "") throw new RecordingFormatError(file, 1, `the header's ${field} must be a non-empty string`);
  }
  if (value["source"] !== "live" && value["source"] !== "fake") throw new RecordingFormatError(file, 1, `the header's source must be "live" or "fake", not ${JSON.stringify(value["source"])}`);
  if (!/^[0-9a-f]{64}$/.test(value["sha256"] as string)) throw new RecordingFormatError(file, 1, "the header's sha256 must be 64 lowercase hex digits");
  return value as unknown as RecordingHeader;
}

function parseFrame(text: string, file: string, line: number): Frame {
  if (text === "") throw new RecordingFormatError(file, line, "the line is empty; every line after the header is one frame");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RecordingFormatError(file, line, `the line is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isObject(value)) throw new RecordingFormatError(file, line, "the line is not a JSON object");
  if (value["dir"] !== "out" && value["dir"] !== "in") throw new RecordingFormatError(file, line, `the frame's dir must be "out" or "in", not ${JSON.stringify(value["dir"])}`);
  if (typeof value["kind"] !== "string" || value["kind"] === "") throw new RecordingFormatError(file, line, "the frame has no kind");
  return value as Frame;
}

/** Parses a recording's text. `file` names it in every error. */
export function parseRecording(text: string, file: string): Recording {
  const newline = text.indexOf("\n");
  if (newline === -1) throw new RecordingFormatError(file, 1, "the recording has no newline after its header line");
  const header = parseHeader(text.slice(0, newline), file);
  const body = text.slice(newline + 1);
  const frames: RecordedFrame[] = [];
  if (body !== "") {
    if (!body.endsWith("\n")) throw new RecordingFormatError(file, body.split("\n").length + 1, "the last line does not end with a newline");
    const lines = body.slice(0, -1).split("\n");
    lines.forEach((lineText, index) => {
      const line = index + 2;
      frames.push({ line, frame: parseFrame(lineText, file, line) });
    });
  }
  const actual = sha256Hex(body);
  if (actual !== header.sha256) {
    throw new RecordingFormatError(file, undefined, `the body does not match the header's sha256 (header ${header.sha256}, body ${actual}); a recording is never edited by hand, record it again`);
  }
  return { file, header, frames };
}

export async function readRecording(file: string): Promise<Recording> {
  return parseRecording(await fs.readFile(file, "utf8"), file);
}

export async function writeRecording(file: string, metadata: RecordingMetadata, frames: readonly Frame[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, encodeRecording(metadata, frames));
}
