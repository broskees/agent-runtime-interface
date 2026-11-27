// Managed installs of the Claude Agent SDK, for hosts that cannot install it
// with npm: above all the standalone `ari-driver`, which cannot import a
// package by name. `maintenance.install` and `maintenance.update` download the
// pinned SDK, and only the SDK, from an npm registry and install it with
// `ari/node`'s adapter installer:
//
//   <cacheDir>/adapters/@anthropic-ai/claude-agent-sdk/<version>/
//     package.json, sdk.mjs, ...   the SDK
//     .ari-install.json            each file's size and sha256
//
// ARI never downloads Claude Code: every query runs the user's own `claude`
// (instance.ts), so the SDK's native Claude Code packages are never fetched.
// The installer publishes the directory with one rename, so it holds the
// whole SDK or nothing.
//
// Integrity: only a sha512, sha384 or sha256 `dist.integrity` is accepted
// (W3C Subresource Integrity's algorithms; npm publishes sha512), never sha1
// or the `shasum`. The tarball is downloaded and checked, checked again just
// before it is unpacked, and once more as it streams into the extractor, so
// what is installed is exactly what was verified.
//
// Repair: `.ari-install.json`, written before the rename, records every file.
// Loading checks each file's size and the sha256 of every file (the
// JavaScript this process imports); `maintenance.install` does the same and
// reinstalls a directory that is not whole. An install whose record lists a
// `node_modules/` file was made by an ARI that also installed a native Claude
// Code package there; it counts as not whole, so `maintenance.install`
// replaces it with the SDK alone.
//
// The SDK's `sdk.mjs` bundles everything it runs and imports only Node
// built-ins; its peers (`zod`, `@anthropic-ai/sdk`,
// `@modelcontextprotocol/sdk`) serve its type declarations. So the SDK is the
// whole install, and no Node or npm is needed.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { callErrors } from "../../errors.ts";
import { CLAUDE_REPAIR_HINT, CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION } from "../../meta/claude.ts";
import { createAdapterInstaller, npmRegistryFetch } from "../../node/installer.ts";
import type { TarballFetch } from "../../node/installer.ts";
import { importClaudeSdkPackage } from "./sdk.ts";
import type { ClaudeSdkRuntime } from "./sdk.ts";

/** The file in a managed install that records what was installed. */
export const CLAUDE_INSTALL_RECORD = ".ari-install.json";

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

/**
 * What is wrong with the managed install in `dir`, or null when it is whole:
 * every file `.ari-install.json` lists is there with its recorded size and
 * sha256. A directory without a readable record was never finished. A record
 * that lists a file under `node_modules/` belongs to an install that also
 * holds a native Claude Code package, which this driver never runs.
 */
export async function managedInstallProblem(dir: string): Promise<string | null> {
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
    if (file.path.startsWith("node_modules/")) return `it holds ${file.path}, part of a native Claude Code package an earlier ARI installed; the driver runs your own Claude Code instead`;
    let size: number;
    try {
      size = (await fs.stat(`${dir}/${file.path}`)).size;
    } catch {
      return `${file.path} is missing`;
    }
    if (size !== file.size) return `${file.path} has ${size} bytes, not the ${file.size} it was installed with`;
    if ((await fileDigest(`${dir}/${file.path}`, "sha256")) !== file.sha256) return `${file.path} has changed since it was installed`;
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
  const problem = await managedInstallProblem(dir);
  if (problem !== null) throw damaged(problem);
  return importClaudeSdkPackage(dir, damaged);
}

export interface ClaudeSdkInstallOptions {
  /** The instance's cache directory; the install goes under `<cacheDir>/adapters`. */
  readonly cacheDir: string;
  /** The instance's temp directory; the download waits there until it is verified. */
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

/** Downloads the pinned SDK into `file`; `download` fails at the end of the stream unless the bytes match the registry's integrity. */
async function downloadVerified(download: TarballFetch, file: string): Promise<Download> {
  const hash = createHash("sha512");
  const handle = await fs.open(file, "w");
  try {
    for await (const chunk of await download({ pkg: CLAUDE_SDK_PACKAGE, version: CLAUDE_SDK_VERSION })) {
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  return { label: `${CLAUDE_SDK_PACKAGE}@${CLAUDE_SDK_VERSION}`, file, sha512: hash.digest("hex") };
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

/** Installs the pinned SDK, unless a whole install is there; repairs one that is not whole. */
export async function installClaudeSdk(options: ClaudeSdkInstallOptions): Promise<void> {
  const dir = managedClaudeSdkDirectory(options.cacheDir);
  if ((await exists(dir)) && (await managedInstallProblem(dir)) === null) return;

  const fetchTarball = npmRegistryFetch({ registry: options.registry, strongIntegrityOnly: true, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  const scratch = `${options.tmpDir}/claude-sdk-download-${randomUUID()}`;
  try {
    await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
    const verified = await downloadVerified(fetchTarball, `${scratch}/sdk.tgz`);
    // Again, just before it is unpacked: a tarball changed since its download installs nothing.
    if ((await fileDigest(verified.file, "sha512")) !== verified.sha512) throw changedOnDisk(verified);
    const installer = createAdapterInstaller({
      cacheDir: options.cacheDir,
      fetchTarball: () => verifiedRead(verified),
      prepare: async (staging) => writeInstallRecord(staging.dir),
      isIntact: async (installed) => (await managedInstallProblem(installed.dir)) === null,
    });
    await installer.install(CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
