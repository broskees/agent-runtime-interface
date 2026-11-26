// Fake installs of the Claude Agent SDK on disk, and a local npm registry
// that serves them, for the tests that make the claude driver load its SDK
// from a directory (`sdkDirectory`) or install it (`maintenance.install`).
//
// The fake SDK package is laid out as the real one is: its own package.json
// (with `exports["."].default` naming `sdk.mjs`, and `claudeCodeVersion`),
// and fixture-sdk/sdk.mjs as the entry module. The fake native package is
// this platform's `@anthropic-ai/claude-agent-sdk-<os>-<arch>` with an
// executable `claude`: a POSIX shell script that answers `--version` with a
// text the test chooses and `auth status --json` with a signed-out report.
// Tarballs are npm's format (gzip-compressed tar, files under `package/`),
// made with the system `tar`. Nothing here reaches the network.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeBinaryCandidates, prefersMusl } from "../../../src/drivers/claude/sdk.ts";
import { CLAUDE_SDK_PACKAGE } from "../../../src/meta/claude.ts";

/** The fake SDK's entry module. */
export const FIXTURE_SDK_MODULE = fileURLToPath(new URL("./fixture-sdk/sdk.mjs", import.meta.url));

/** The platform package the SDK prefers on this machine, and its binary's file name. */
export function hostNativePackage(): { pkg: string; binary: string } {
  const candidate = nativeBinaryCandidates(process.platform, process.arch, prefersMusl())[0]!;
  return { pkg: candidate.slice(0, candidate.lastIndexOf("/")), binary: candidate.slice(candidate.lastIndexOf("/") + 1) };
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
    claudeCodeVersion: "2.1.330",
  };
  fs.writeFileSync(path.join(packageDirectory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.copyFileSync(FIXTURE_SDK_MODULE, path.join(packageDirectory, "sdk.mjs"));
}

/** Writes this platform's fake native package into `packageDirectory`; its `claude --version` prints `answer`. */
export function writeFixtureNativePackage(packageDirectory: string, version: string, answer: string): string {
  const { pkg, binary } = hostNativePackage();
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, "package.json"), `${JSON.stringify({ name: pkg, version, os: [process.platform], cpu: [process.arch] }, null, 2)}\n`);
  const script = [
    "#!/bin/sh",
    "# The fixture's native Claude Code binary: it answers --version and auth status, and nothing else.",
    'case "$1" in',
    `  --version) echo '${answer.replaceAll("'", "")}' ;;`,
    `  auth) echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}' ;;`,
    '  *) echo "the fixture claude answers only --version and auth status" >&2; exit 2 ;;',
    "esac",
    "",
  ].join("\n");
  const executable = path.join(packageDirectory, binary);
  fs.writeFileSync(executable, script, { mode: 0o755 });
  return executable;
}

/**
 * A directory as `npm install @anthropic-ai/claude-agent-sdk` leaves it:
 * `<root>/node_modules/@anthropic-ai/claude-agent-sdk` and the platform
 * package beside it. Returns the path of the native binary.
 */
export function writeFixtureSdkDirectory(root: string, version: string, answer: string): string {
  writeFixtureSdkPackage(path.join(root, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/")), version);
  return writeFixtureNativePackage(path.join(root, "node_modules", ...hostNativePackage().pkg.split("/")), version, answer);
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

/** npm's `dist.integrity` for `bytes`. */
export function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** One package version the registry serves. `integrity` defaults to the tarball's own. */
export interface RegistryEntry {
  readonly pkg: string;
  readonly version: string;
  readonly tarball: Buffer;
  readonly integrity?: string;
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
 */
export async function startFixtureRegistry(entries: readonly RegistryEntry[], options: { tarballDelayMs?: number } = {}): Promise<FixtureRegistry> {
  const requests: string[] = [];
  let url = "";
  const server = http.createServer((request, response) => {
    const requested = decodeURIComponent(new URL(request.url ?? "/", "http://registry").pathname);
    requests.push(requested);
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
    const manifest = { name: entry.pkg, version: entry.version, dist: { tarball: `${url}/-/tarballs/${index}.tgz`, integrity: entry.integrity ?? integrityOf(entry.tarball) } };
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

/** Registry entries for the fake SDK and this platform's fake native package, both at `version`. */
export function fixtureRegistryEntries(scratch: string, version: string, answer: string): { sdk: RegistryEntry; native: RegistryEntry } {
  const sdkDirectory = fs.mkdtempSync(path.join(scratch, "sdk-package-"));
  const nativeDirectory = fs.mkdtempSync(path.join(scratch, "native-package-"));
  writeFixtureSdkPackage(sdkDirectory, version);
  writeFixtureNativePackage(nativeDirectory, version, answer);
  return {
    sdk: { pkg: CLAUDE_SDK_PACKAGE, version, tarball: npmTarball(sdkDirectory, scratch) },
    native: { pkg: hostNativePackage().pkg, version, tarball: npmTarball(nativeDirectory, scratch) },
  };
}
