// Managed installs of the Claude Agent SDK, for hosts that cannot install it
// with npm: above all the standalone `ari-driver`, which cannot import a
// package by name. `maintenance.install` and `maintenance.update` download the
// pinned SDK and this platform's native Claude Code package from an npm
// registry and install them with `ari/node`'s adapter installer as one
// directory, laid out as npm lays them out:
//
//   <cacheDir>/adapters/@anthropic-ai/claude-agent-sdk/<version>/
//     package.json, sdk.mjs, ...                                the SDK
//     node_modules/@anthropic-ai/claude-agent-sdk-<os>-<arch>/  its native binary
//     .ari-install.json                                         each file's size and sha256
//
// So the SDK finds its native binary by itself, as in an npm install, and the
// driver never names it in `pathToClaudeCodeExecutable` (which would change
// SDK defaults: no `--await-initialize` on a resume, and a deprecation warning
// for MCP servers given in `Options.mcpServers`). The installer publishes the
// directory with one rename, so it holds both packages or neither.
//
// Integrity: only a sha512, sha384 or sha256 `dist.integrity` is accepted
// (W3C Subresource Integrity's algorithms; npm publishes sha512), never sha1
// or the `shasum`. Both tarballs are downloaded and checked before either is
// unpacked, checked again just before unpacking, and once more as they stream
// into the extractor, so what is installed is exactly what was verified.
//
// Repair: `.ari-install.json`, written before the rename, records every file.
// Loading checks each file's size and the sha256 of the SDK's own files (the
// JavaScript this process imports); `maintenance.install` checks every sha256
// and reinstalls a directory that is not whole.
//
// The SDK's `sdk.mjs` bundles everything it runs and imports only Node
// built-ins; its peers (`zod`, `@anthropic-ai/sdk`,
// `@modelcontextprotocol/sdk`) serve its type declarations. So the two
// packages are the whole install, and no Node or npm is needed.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { callErrors } from "../../errors.ts";
import { CLAUDE_REPAIR_HINT, CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION } from "../../meta/claude.ts";
import { createAdapterInstaller, npmRegistryFetch } from "../../node/installer.ts";
import type { TarballFetch } from "../../node/installer.ts";
import { extractTarball } from "../../node/tar.ts";
import { findBundledExecutable, importClaudeSdkPackage, nativeBinaryCandidates, prefersMusl } from "./sdk.ts";
import type { ClaudeSdkRuntime } from "./sdk.ts";

/** The file in a managed install that records what was installed. */
export const CLAUDE_INSTALL_RECORD = ".ari-install.json";

/** One package of a managed install. */
export interface ClaudeManagedPackage {
  readonly pkg: string;
  readonly version: string;
}

/**
 * The packages a managed install of the pinned SDK holds on this platform:
 * the native package (the one the SDK itself prefers here, glibc before musl
 * on Linux), then the SDK.
 */
export function claudeManagedPackages(platform: string, arch: string, preferMusl: boolean): ClaudeManagedPackage[] {
  const candidate = nativeBinaryCandidates(platform, arch, preferMusl)[0]!;
  return [
    { pkg: candidate.slice(0, candidate.lastIndexOf("/")), version: CLAUDE_SDK_VERSION },
    { pkg: CLAUDE_SDK_PACKAGE, version: CLAUDE_SDK_VERSION },
  ];
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** The tarball source of an installer that only looks installs up: it never fetches. */
const NO_FETCH: TarballFetch = ({ pkg, version }) => {
  throw callErrors.invalidState("not_installed", `${pkg}@${version} is not installed`);
};

/** The directory of the managed install of the pinned SDK in `cacheDir`, whether or not it exists. */
export function managedClaudeSdkDirectory(cacheDir: string): string {
  return createAdapterInstaller({ cacheDir, fetchTarball: NO_FETCH }).pathFor(CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION);
}

async function fileDigest(file: string, algorithm: "sha256" | "sha512"): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}

/** Every regular file under `root`, as paths relative to it with `/` separators, the install record left out. */
async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await fs.readdir(relative === "" ? root : `${root}/${relative}`, { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && path !== CLAUDE_INSTALL_RECORD) found.push(path);
    }
  };
  await visit("");
  return found.sort();
}

interface InstallRecord {
  readonly files: ReadonlyArray<{ readonly path: string; readonly size: number; readonly sha256: string }>;
}

/** Records every file under `dir` with its size and sha256 in `.ari-install.json`. */
async function writeInstallRecord(dir: string): Promise<void> {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  for (const path of await filesUnder(dir)) {
    files.push({ path, size: (await fs.stat(`${dir}/${path}`)).size, sha256: await fileDigest(`${dir}/${path}`, "sha256") });
  }
  await fs.writeFile(`${dir}/${CLAUDE_INSTALL_RECORD}`, `${JSON.stringify({ files } satisfies InstallRecord, null, 2)}\n`);
}

/** Every recorded file's sha256 is checked (what `maintenance.install` does). */
const EVERY_FILE = (): boolean => true;
/** Only the SDK's own files, the JavaScript this process imports, have their sha256 checked; the native package's files only their size. */
const SDK_FILES = (path: string): boolean => !path.startsWith("node_modules/");

/**
 * What is wrong with the managed install in `dir`, or null when it is whole:
 * every file `.ari-install.json` lists is there with its recorded size, and,
 * for each file `checkDigest` picks, its recorded sha256. A directory without
 * a readable record was never finished.
 */
export async function managedInstallProblem(dir: string, checkDigest: (path: string) => boolean): Promise<string | null> {
  let record: InstallRecord;
  try {
    record = JSON.parse(await fs.readFile(`${dir}/${CLAUDE_INSTALL_RECORD}`, "utf8")) as InstallRecord;
  } catch {
    return `${CLAUDE_INSTALL_RECORD}, written when an install completes, is missing or unreadable`;
  }
  if (!Array.isArray(record.files) || record.files.length === 0) return `${CLAUDE_INSTALL_RECORD} lists no files`;
  for (const file of record.files) {
    const safe = typeof file?.path === "string" && file.path.split("/").every((part: string) => part !== "" && part !== "." && part !== "..");
    if (!safe || typeof file.size !== "number" || typeof file.sha256 !== "string") return `${CLAUDE_INSTALL_RECORD} is malformed`;
    let size: number;
    try {
      size = (await fs.stat(`${dir}/${file.path}`)).size;
    } catch {
      return `${file.path} is missing`;
    }
    if (size !== file.size) return `${file.path} has ${size} bytes, not the ${file.size} it was installed with`;
    if (checkDigest(file.path) && (await fileDigest(`${dir}/${file.path}`, "sha256")) !== file.sha256) return `${file.path} has changed since it was installed`;
  }
  return null;
}

/**
 * The SDK a managed install holds in `cacheDir`, loaded by file URL, or null
 * when none is there. An install that is not whole, or does not load, is
 * reported unavailable with the step that repairs it.
 */
export async function loadManagedClaudeSdk(cacheDir: string): Promise<ClaudeSdkRuntime | null> {
  const dir = managedClaudeSdkDirectory(cacheDir);
  if (!(await exists(dir))) return null;
  const damaged = (detail: string): Error =>
    callErrors.driverUnavailable({ package: CLAUDE_SDK_PACKAGE, installHint: CLAUDE_REPAIR_HINT }, `The managed Claude Agent SDK install in ${dir} is damaged: ${detail}. ${CLAUDE_REPAIR_HINT}`);
  const problem = await managedInstallProblem(dir, SDK_FILES);
  if (problem !== null) throw damaged(problem);
  const loaded = await importClaudeSdkPackage(dir, damaged);
  const bundledExecutable = await findBundledExecutable(loaded.entryFile);
  if (bundledExecutable === null) throw damaged(`it holds no native Claude Code package for ${process.platform}-${process.arch}`);
  return { sdk: loaded.sdk, version: loaded.version, claudeCodeVersion: loaded.claudeCodeVersion, bundledExecutable };
}

export interface ClaudeSdkInstallOptions {
  /** The instance's cache directory; the install goes under `<cacheDir>/adapters`. */
  readonly cacheDir: string;
  /** The instance's temp directory; downloads wait there until both are verified. */
  readonly tmpDir: string;
  /** The npm registry to download from. */
  readonly registry: string;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** A tarball on disk and the sha512 of the bytes that were verified against the registry. */
interface Download {
  readonly label: string;
  readonly file: string;
  readonly sha512: string;
}

/** Downloads `pkg@version` into `file`; `download` fails at the end of the stream unless the bytes match the registry's integrity. */
async function downloadVerified(download: TarballFetch, { pkg, version }: ClaudeManagedPackage, file: string): Promise<Download> {
  const hash = createHash("sha512");
  const handle = await fs.open(file, "w");
  try {
    for await (const chunk of await download({ pkg, version })) {
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  return { label: `${pkg}@${version}`, file, sha512: hash.digest("hex") };
}

function changedOnDisk(download: Download): Error {
  return callErrors.protocol("integrity_mismatch", `The downloaded tarball of ${download.label} changed on disk after it was verified`);
}

/** The downloaded tarball, read again and checked as it streams: the stream fails at its end, and the installer discards the extraction, when the bytes are not the ones verified. */
async function* verifiedRead(download: Download): AsyncGenerator<Uint8Array> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(download.file)) {
    hash.update(chunk as Uint8Array);
    yield chunk as Uint8Array;
  }
  if (hash.digest("hex") !== download.sha512) throw changedOnDisk(download);
}

/**
 * Installs the pinned SDK with this platform's native package, unless a whole
 * install is there; repairs one that is not whole. Resolves with the two
 * packages.
 */
export async function installClaudeSdk(options: ClaudeSdkInstallOptions): Promise<ClaudeManagedPackage[]> {
  const [native, sdk] = claudeManagedPackages(process.platform, process.arch, prefersMusl()) as [ClaudeManagedPackage, ClaudeManagedPackage];
  const dir = managedClaudeSdkDirectory(options.cacheDir);
  if ((await exists(dir)) && (await managedInstallProblem(dir, EVERY_FILE)) === null) return [native, sdk];

  const download = npmRegistryFetch({ registry: options.registry, strongIntegrityOnly: true, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  const downloads = new Map<string, Download>();
  const downloaded = (pkg: string): Download => {
    const found = downloads.get(pkg);
    if (found === undefined) throw callErrors.invalidState("not_downloaded", `${pkg} was not downloaded`);
    return found;
  };
  const installer = createAdapterInstaller({
    cacheDir: options.cacheDir,
    fetchTarball: () => verifiedRead(downloaded(sdk.pkg)),
    // The native package goes where npm puts it, so the SDK finds its binary by itself; then the record of every file.
    prepare: async (staging) => {
      const nativeDirectory = `${staging.dir}/node_modules/${native.pkg}`;
      await fs.mkdir(nativeDirectory, { recursive: true });
      await extractTarball(verifiedRead(downloaded(native.pkg)), nativeDirectory, { strip: 1 });
      await writeInstallRecord(staging.dir);
    },
    isIntact: async (installed) => (await managedInstallProblem(installed.dir, EVERY_FILE)) === null,
  });
  const scratch = `${options.tmpDir}/claude-sdk-download-${randomUUID()}`;
  try {
    await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
    for (const [index, entry] of [native, sdk].entries()) downloads.set(entry.pkg, await downloadVerified(download, entry, `${scratch}/${index}.tgz`));
    // Both again, just before either is unpacked: a tarball changed since its download installs nothing.
    for (const verified of downloads.values()) if ((await fileDigest(verified.file, "sha512")) !== verified.sha512) throw changedOnDisk(verified);
    await installer.install(sdk.pkg, sdk.version);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  return [native, sdk];
}
