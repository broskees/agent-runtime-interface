// Fake installs of the Claude Agent SDK on disk, a fake of the user's own
// Claude Code, and a local npm registry that serves the SDK, for the tests
// that make the claude driver load its SDK from a directory (`sdkDirectory`),
// install it (`maintenance.install`), or import it by name.
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
//
// Tarballs are npm's format (gzip-compressed tar, files under `package/`),
// made with the system `tar`. Nothing here reaches the network.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
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
 * Makes the managed install in `installed` look as an ARI that also
 * downloaded the native Claude Code package left it: that package in the
 * SDK's `node_modules`, and `.ari-install.json` listing its files (with the
 * `mode` that ARI recorded).
 */
export function addNativePackageAsAnEarlierAri(installed: string): void {
  const binary = writeDecoyNativePackage(path.join(installed, "node_modules"), "a native package an earlier ARI installed");
  const file = path.join(installed, ".ari-install.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as { files: Array<{ path: string; size: number; mode?: number; sha256: string }> };
  for (const added of [binary, path.join(path.dirname(binary), "package.json")]) {
    const bytes = fs.readFileSync(added);
    record.files.push({ path: path.relative(installed, added).split(path.sep).join("/"), size: bytes.length, mode: fs.statSync(added).mode & 0o777, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  record.files.sort((a, b) => (a.path < b.path ? -1 : 1));
  fs.writeFileSync(file, JSON.stringify(record));
}

/**
 * A directory as `npm install @anthropic-ai/claude-agent-sdk` leaves it:
 * `<root>/node_modules/@anthropic-ai/claude-agent-sdk` and, beside it, the
 * decoy native package whose Claude Code greets with `decoyGreeting`.
 * Returns the decoy's binary.
 */
export function writeFixtureSdkDirectory(root: string, version: string, decoyGreeting: string): string {
  writeFixtureSdkPackage(path.join(root, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/")), version);
  return writeDecoyNativePackage(path.join(root, "node_modules"), decoyGreeting);
}

/** The npm tarball of the package in `packageDirectory`: its files under `package/`, gzip-compressed. */
export function npmTarball(packageDirectory: string, scratch: string): Buffer {
  const stage = fs.mkdtempSync(path.join(scratch, "tarball-"));
  fs.cpSync(packageDirectory, path.join(stage, "package"), { recursive: true });
  const outfile = path.join(stage, "package.tgz");
  const result = spawnSync("tar", ["-czf", outfile, "-C", stage, "package"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
  const bytes = fs.readFileSync(outfile);
  fs.rmSync(stage, { recursive: true, force: true });
  return bytes;
}

/** npm's `dist.integrity` for `bytes`: sha512 unless another algorithm is named. */
export function integrityOf(bytes: Uint8Array, algorithm: "sha1" | "sha256" | "sha384" | "sha512" = "sha512"): string {
  return `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
}

/** npm's `dist.shasum` for `bytes`: the hex sha1. */
export function shasumOf(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

/** One package version the registry serves. `integrity` defaults to the tarball's sha512; null leaves it out. `shasum` is left out unless given. */
export interface RegistryEntry {
  readonly pkg: string;
  readonly version: string;
  readonly tarball: Buffer;
  readonly integrity?: string | null;
  readonly shasum?: string;
}

export interface FixtureRegistry {
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  /** Every path requested, decoded, in order. */
  readonly requests: string[];
  close(): Promise<void>;
}

/**
 * Serves `entries` as an npm registry on a loopback port: `GET /<pkg>/<version>`
 * answers the version's manifest (`dist.tarball` and `dist.integrity`), and
 * `GET /-/tarballs/<n>.tgz` the tarball. Anything else is 404. Tarballs wait
 * `tarballDelayMs` before they are sent, so two installs can overlap.
 * `onRequest` runs before each answer, with the decoded path.
 */
export async function startFixtureRegistry(
  entries: readonly RegistryEntry[],
  options: { tarballDelayMs?: number; onRequest?: (requested: string) => void | Promise<void> } = {},
): Promise<FixtureRegistry> {
  const requests: string[] = [];
  let url = "";
  const server = http.createServer(async (request, response) => {
    const requested = decodeURIComponent(new URL(request.url ?? "/", "http://registry").pathname);
    requests.push(requested);
    await options.onRequest?.(requested);
    const tarball = /^\/-\/tarballs\/(\d+)\.tgz$/.exec(requested);
    if (tarball !== null) {
      const entry = entries[Number(tarball[1])];
      if (entry === undefined) {
        response.writeHead(404).end();
        return;
      }
      setTimeout(() => response.writeHead(200, { "content-type": "application/octet-stream" }).end(entry.tarball), options.tarballDelayMs ?? 0);
      return;
    }
    const slash = requested.lastIndexOf("/");
    const index = entries.findIndex((entry) => requested.slice(1, slash) === entry.pkg && requested.slice(slash + 1) === entry.version);
    if (index === -1) {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const entry = entries[index]!;
    const integrity = entry.integrity === undefined ? integrityOf(entry.tarball) : entry.integrity;
    const dist = { tarball: `${url}/-/tarballs/${index}.tgz`, ...(integrity === null ? {} : { integrity }), ...(entry.shasum === undefined ? {} : { shasum: entry.shasum }) };
    const manifest = { name: entry.pkg, version: entry.version, dist };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(manifest));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The registry entry of the fake SDK at `version`, published as `CLAUDE_SDK_PACKAGE`; `marker` goes into its package.json, so two entries can differ in their bytes alone. */
export function fixtureSdkEntry(scratch: string, version: string, marker = "fixture"): RegistryEntry {
  const sdkDirectory = fs.mkdtempSync(path.join(scratch, "sdk-package-"));
  writeFixtureSdkPackage(sdkDirectory, version);
  const manifestFile = path.join(sdkDirectory, "package.json");
  fs.writeFileSync(manifestFile, `${JSON.stringify({ ...(JSON.parse(fs.readFileSync(manifestFile, "utf8")) as object), description: marker }, null, 2)}\n`);
  return { pkg: CLAUDE_SDK_PACKAGE, version, tarball: npmTarball(sdkDirectory, scratch) };
}
