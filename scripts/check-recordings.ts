// The recordings scan, a gate step (`pnpm run check:recordings`). The
// repository is public, so every file under test/drivers/*/recordings/ must
// hold no path into a home directory, no email address and no token. A
// finding names the file, the line and the rule, never the matched text.
//
// The rules:
//   home-path      a path starting /home/, /Users/ or /root/;
//   machine-home   a path starting with this machine's $HOME;
//   email          an email address;
//   token          sk-ant-, sk-<20 or more letters and digits>, gh[pousr]_,
//                  xox[baprs]-, AKIA<16 capitals and digits>, or "Bearer "
//                  followed by 20 or more token characters.
//
// test/recordings/sanitiser.ts replaces all of these before a recorder
// writes, so a finding means a recording was written some other way.
//
// Usage: node scripts/check-recordings.ts [--root <dir>]

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type RecordingScanRule = "home-path" | "machine-home" | "email" | "token";

export interface RecordingFinding {
  /** Path relative to the root, with forward slashes. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly rule: RecordingScanRule;
  readonly what: string;
}

interface Pattern {
  readonly rule: RecordingScanRule;
  readonly what: string;
  readonly pattern: RegExp;
}

// A path starts at the beginning of the text or after a character that cannot be part of a path or a word.
const PATH_START = "(?:^|(?<=[^A-Za-z0-9._~/-]))";

export const RECORDING_SCAN_PATTERNS: readonly Pattern[] = [
  { rule: "home-path", what: "a path starting /home/", pattern: new RegExp(`${PATH_START}/home/`, "g") },
  { rule: "home-path", what: "a path starting /Users/", pattern: new RegExp(`${PATH_START}/Users/`, "g") },
  { rule: "home-path", what: "a path starting /root/", pattern: new RegExp(`${PATH_START}/root/`, "g") },
  { rule: "email", what: "an email address", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { rule: "token", what: "an Anthropic key (sk-ant-)", pattern: /sk-ant-/g },
  { rule: "token", what: "an API key (sk-...)", pattern: /\bsk-[A-Za-z0-9]{20,}/g },
  { rule: "token", what: "a GitHub token (gh?_)", pattern: /\bgh[pousr]_/g },
  { rule: "token", what: "a Slack token (xox?-)", pattern: /\bxox[baprs]-/g },
  { rule: "token", what: "an AWS access key (AKIA...)", pattern: /\bAKIA[0-9A-Z]{16}/g },
  { rule: "token", what: "a bearer token", pattern: /\bBearer [A-Za-z0-9._~+/=-]{20,}/g },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The machine-home pattern for a $HOME, or undefined when $HOME is unset or the root. */
function machineHomePattern(home: string | undefined): Pattern | undefined {
  if (home === undefined) return undefined;
  const trimmed = home.replace(/\/+$/, "");
  if (trimmed === "") return undefined;
  return { rule: "machine-home", what: `a path starting with this machine's $HOME`, pattern: new RegExp(`${PATH_START}${escapeRegExp(trimmed)}(?![A-Za-z0-9._~-])`, "g") };
}

/** Every finding in one file's text. */
export function scanRecordingText(text: string, file: string, options: { home?: string } = {}): RecordingFinding[] {
  const patterns = [...RECORDING_SCAN_PATTERNS];
  const home = machineHomePattern(options.home);
  if (home !== undefined) patterns.push(home);
  const findings: RecordingFinding[] = [];
  text.split("\n").forEach((lineText, index) => {
    for (const { rule, what, pattern } of patterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(lineText);
      if (match !== null) findings.push({ file, line: index + 1, column: match.index + 1, rule, what });
    }
  });
  return findings;
}

/** Every file under <root>/test/drivers/<driver>/recordings/, relative to root. */
export function recordingFiles(root: string): string[] {
  const drivers = path.join(root, "test", "drivers");
  if (!fs.existsSync(drivers)) return [];
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  for (const driver of fs.readdirSync(drivers, { withFileTypes: true })) {
    if (!driver.isDirectory()) continue;
    const recordings = path.join(drivers, driver.name, "recordings");
    if (fs.existsSync(recordings) && fs.statSync(recordings).isDirectory()) walk(recordings);
  }
  return files.sort();
}

export function scanRecordings(root: string, options: { home?: string } = {}): { files: string[]; findings: RecordingFinding[] } {
  const files = recordingFiles(root);
  const findings = files.flatMap((file) => scanRecordingText(fs.readFileSync(path.join(root, file), "utf8"), file, options));
  return { files, findings };
}

function main(argv: readonly string[]): number {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex === -1 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") : path.resolve(argv[rootIndex + 1] ?? ".");
  const home = process.env["HOME"];
  const { files, findings } = scanRecordings(root, home === undefined ? {} : { home });
  for (const finding of findings) process.stderr.write(`${finding.file}:${finding.line}:${finding.column}: ${finding.rule}: ${finding.what}\n`);
  if (findings.length > 0) {
    process.stderr.write(`check-recordings: ${findings.length} finding(s) in ${new Set(findings.map((finding) => finding.file)).size} of ${files.length} recording file(s)\n`);
    return 1;
  }
  process.stdout.write(`check-recordings: ${files.length} recording file(s), no paths, emails or tokens\n`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
