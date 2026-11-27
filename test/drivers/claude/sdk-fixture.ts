// Fake installs of the Claude Agent SDK on disk and fakes of the user's own
// Claude Code, for the tests that give the claude driver its SDK from disk
// (by name through a module hook, or by file URL from its loader) and for
// the standalone ari-driver, whose SDK is compiled in.
//
// The fake SDK package is laid out as the real one is: its own package.json
// (with `exports["."].default` naming `sdk.mjs`, and `claudeCodeVersion`),
// and fixture-sdk/sdk.mjs as the entry module.
//
// The fake Claude Code (`writeFakeClaude`) is a POSIX shell script that uses
// only shell built-ins, so it runs with no PATH at all. It appends each
// invocation's arguments to `<its path>.log`, and answers `--version` with a
// line the test chooses, `auth status --json` with a signed-out report, and a
// launch (the SDK's first argument, `--output-format`) with a greeting the
// fixture SDK quotes in its reply. The same script, put where npm puts the
// SDK's native Claude Code package, is the decoy the driver must never run.
// Nothing here reaches the network.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_SDK_PACKAGE, CLAUDE_TESTED_CLAUDE_CODE_VERSION } from "../../../src/meta/claude.ts";

/** The fake SDK's entry module. */
export const FIXTURE_SDK_MODULE = fileURLToPath(new URL("./fixture-sdk/sdk.mjs", import.meta.url));

/** What a Claude Code at the minimum the driver runs prints for `--version`. */
export const MINIMUM_VERSION_LINE = `${CLAUDE_TESTED_CLAUDE_CODE_VERSION} (Claude Code)`;

export interface FakeClaudeOptions {
  /** What `--version` prints, for example `2.1.330 (Claude Code)`. */
  readonly versionLine: string;
  /** The exit code of `--version`; 0 when left out. */
  readonly versionExitCode?: number;
  /** What a launch prints; the fixture SDK quotes it in its reply. */
  readonly greeting: string;
}

/** `text` as one single-quoted shell word. */
function shellWord(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Writes a fake Claude Code at `file` (see the top of this file) and returns `file`. */
export function writeFakeClaude(file: string, options: FakeClaudeOptions): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const script = [
    "#!/bin/sh",
    "# A fake Claude Code: it logs each invocation, answers --version, auth status and a launch, and nothing else.",
    `printf '%s\\n' "$*" >> "$0.log"`,
    'case "$1" in',
    `  --version) printf '%s\\n' ${shellWord(options.versionLine)}; exit ${options.versionExitCode ?? 0} ;;`,
    `  auth) printf '%s\\n' '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}' ;;`,
    `  --output-format) printf '%s\\n' ${shellWord(options.greeting)} ;;`,
    '  *) echo "the fake claude answers only --version, auth status and a launch" >&2; exit 2 ;;',
    "esac",
    "",
  ].join("\n");
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

/** Each invocation of the fake Claude Code at `file`, as its arguments joined by spaces, in order. */
export function fakeClaudeInvocations(file: string): string[] {
  const log = `${file}.log`;
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : [];
}

/** The invocations of the fake at `file` that started a Claude Code session: a launch, not `--version` or `auth status`. */
export function fakeClaudeSessions(file: string): string[] {
  return fakeClaudeInvocations(file).filter((line) => line.startsWith("--output-format"));
}

/**
 * The platform package the SDK would run its native Claude Code from on this
 * machine, as the pinned SDK's sdk.mjs picks it (glibc before musl on Linux),
 * and its binary's file name: where a test puts the decoy.
 */
export function sdkNativePackage(): { pkg: string; binary: string } {
  const report = typeof process.report?.getReport === "function" ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }) : undefined;
  const musl = process.platform === "linux" && report !== undefined && report.header?.glibcVersionRuntime === undefined;
  const platform = process.platform === "linux" ? `linux-${process.arch}${musl ? "-musl" : ""}` : `${process.platform}-${process.arch}`;
  return { pkg: `${CLAUDE_SDK_PACKAGE}-${platform}`, binary: process.platform === "win32" ? "claude.exe" : "claude" };
}

/** Writes the fake SDK package into `packageDirectory`. */
export function writeFixtureSdkPackage(packageDirectory: string, version: string): void {
  fs.mkdirSync(packageDirectory, { recursive: true });
  const manifest = {
    name: CLAUDE_SDK_PACKAGE,
    version,
    type: "module",
    main: "sdk.mjs",
    exports: { ".": { types: "./sdk.d.ts", default: "./sdk.mjs" } },
    claudeCodeVersion: CLAUDE_TESTED_CLAUDE_CODE_VERSION,
  };
  fs.writeFileSync(path.join(packageDirectory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.copyFileSync(FIXTURE_SDK_MODULE, path.join(packageDirectory, "sdk.mjs"));
}

/**
 * The decoy: this platform's native Claude Code package, where npm installs
 * it beside the SDK under `nodeModules`, holding a fake Claude Code at the
 * minimum version that greets with `greeting`. Returns its binary.
 */
export function writeDecoyNativePackage(nodeModules: string, greeting: string): string {
  const { pkg, binary } = sdkNativePackage();
  const directory = path.join(nodeModules, ...pkg.split("/"));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), `${JSON.stringify({ name: pkg, version: "0.3.330", os: [process.platform], cpu: [process.arch] }, null, 2)}\n`);
  return writeFakeClaude(path.join(directory, binary), { versionLine: MINIMUM_VERSION_LINE, greeting });
}

/**
 * A directory as `npm install --prefix <root> @anthropic-ai/claude-agent-sdk`
 * leaves it:
 * `<root>/node_modules/@anthropic-ai/claude-agent-sdk` and, beside it, the
 * decoy native package whose Claude Code greets with `decoyGreeting`.
 * Returns the decoy's binary.
 */
export function writeFixtureSdkDirectory(root: string, version: string, decoyGreeting: string): string {
  writeFixtureSdkPackage(path.join(root, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/")), version);
  return writeDecoyNativePackage(path.join(root, "node_modules"), decoyGreeting);
}
