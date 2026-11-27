// The managed adapter installer. It puts one version of a package at
// `<cacheDir>/adapters/<pkg>/<version>` from a tarball that a pluggable fetch
// supplies. It never runs `npx`, `npm` or any other process.
//
// Atomic installs: the tarball is extracted into a staging directory beside
// the final one (`.staging-<pid>-<random>`), and only a complete extraction is
// renamed to the final path. Rename is atomic, so the final path either does
// not exist or holds a whole install, even when the installing process is
// killed midway.
//
// One lock per version: installing, leasing and removing a version each run
// while holding that version's lock, a cross-process lock kept as files in
// `.locks/<version>/` (see `acquireVersionLock`). So:
//   - a second install of a version, from this installer, another installer
//     object or another process, waits for the first and then finds it
//     installed, instead of fetching again;
//   - `lease()` writes its lease file under the lock, and `cleanup()` checks
//     for leases and moves the version aside under the same lock, so cleanup
//     never moves a leased version, and a lease is never handed out while
//     cleanup is removing its version: the lease waits, then installs again.
//
// Leases: a lease is a file `.leases/<version>/<pid>-<random>`. It holds until
// it is released or its process ends. `install()` alone holds nothing: a
// version installed without a lease may be removed by the next cleanup.
// `cleanup()` also removes staging and trash left by processes that died.
//
// A lock or lease belongs to a process ID and counts while that process
// exists. If the system reuses the ID of a process that died holding a lock,
// the lock stays held until that new process ends.
//
// Installs hold only the package's own files, plus whatever the optional
// `prepare` hook adds to the staging directory before the rename. A package
// that needs its npm dependencies installed next to it must bundle them, or
// its caller adds them in `prepare`.
//
// Repair: with the optional `isIntact` hook, an install whose directory exists
// but is not whole is moved aside and installed again, under the version's
// lock. Without it, an existing directory counts as installed.
//
// `cacheDir` is kept as given (see os-path.ts); every path below it is built
// from validated package names, versions and names this module chose.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { callErrors } from "../errors.ts";
import { appendToPath } from "./os-path.ts";
import { extractTarball } from "./tar.ts";

/**
 * How long a driver should wait for an adapter it launched to answer its
 * protocol handshake: 120 seconds. A first launch after an install can be
 * slow, and a short timeout turns that into a confusing failure.
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 120_000;

export interface TarballRequest {
  pkg: string;
  version: string;
  signal?: AbortSignal;
}

/** Supplies the bytes of a package version's tarball (gzip-compressed or plain tar). */
export type TarballFetch = (request: TarballRequest) => Promise<AsyncIterable<Uint8Array>> | AsyncIterable<Uint8Array>;

export interface AdapterInstallerOptions {
  /** The instance's cache directory; installs go under `<cacheDir>/adapters`. */
  cacheDir: string;
  fetchTarball: TarballFetch;
  /** Path segments dropped from each tarball entry. Defaults to 1, for npm's `package/` directory. */
  strip?: number;
  /** Aborting it cancels installs in progress and stops waiting for a version's lock. */
  signal?: AbortSignal;
  /**
   * Runs on each complete extraction, in its staging directory, before the
   * rename publishes it and while the version's lock is held. It may add
   * files there (a record of what was installed, a second archive); if it
   * throws, the staging directory is removed and nothing is installed.
   */
  prepare?: (staging: { readonly dir: string; readonly pkg: string; readonly version: string }) => Promise<void>;
  /**
   * Says whether an installed version is whole. `install()` and `lease()`
   * move a version it calls broken aside and install it again, under the
   * version's lock. Without it, an existing version directory counts as
   * installed.
   */
  isIntact?: (installed: InstalledAdapter) => Promise<boolean>;
}

export interface InstalledAdapter {
  readonly pkg: string;
  readonly version: string;
  /** `<cacheDir>/adapters/<pkg>/<version>` */
  readonly dir: string;
}

export interface AdapterLease extends InstalledAdapter {
  /** Ends the lease. Calling it again does nothing. */
  release(): Promise<void>;
}

export interface CleanupOptions {
  /** Versions for which this returns true are kept even without a lease. */
  keep?: (pkg: string, version: string) => boolean;
}

export interface AdapterInstaller {
  /** The final path of a version, whether or not it is installed. */
  pathFor(pkg: string, version: string): string;
  /** Installs `pkg@version` unless it is already installed, and resolves with where it is. Waits for an install of the same version already in progress. */
  install(pkg: string, version: string): Promise<InstalledAdapter>;
  /** Holds `pkg@version` against cleanup until released, installing it first if needed. */
  lease(pkg: string, version: string): Promise<AdapterLease>;
  /** Removes installed versions no live lease holds, and leftovers of dead processes. Resolves with the versions removed. */
  cleanup(options?: CleanupOptions): Promise<InstalledAdapter[]>;
}

// npm package names: lowercase, URL-safe, optionally scoped. Neither part may start with `.` or `_`.
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
// Versions: letters, digits, `.`, `+`, `-`, `_`, starting with a letter or digit, so a version never names a hidden entry.
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

const STAGING_PREFIX = ".staging-";
const TRASH_PREFIX = ".trash-";
const LEASES_DIRECTORY = ".leases";
const LOCKS_DIRECTORY = ".locks";
const LOCK_POLL_MS = 25;

function checkPackage(pkg: string, version: string): void {
  if (typeof pkg !== "string" || pkg.length > 214 || !PACKAGE_NAME.test(pkg)) {
    throw callErrors.validation([{ path: ["pkg"], message: "is not a valid npm package name" }], `Invalid package name "${pkg}"`);
  }
  if (typeof version !== "string" || version.length > 256 || !VERSION.test(version)) {
    throw callErrors.validation([{ path: ["version"], message: "is not a valid version" }], `Invalid version "${version}"`);
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function listDirectory(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return [];
    throw error;
  }
}

/** True while process `pid` exists. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/** The process ID at the start of a `<pid>-<random>` name. */
function ownerPid(name: string): number {
  return Number(name.split("-", 1)[0]);
}

// The version lock is the bakery algorithm, with files for its shared
// variables, so it needs no lock primitive the file system lacks. Each waiter:
//   1. creates `choosing.<pid>.<id>`;
//   2. reads every `ticket.<n>.<pid>.<id>` and takes n = highest + 1;
//   3. creates its own ticket file, then deletes its `choosing` file;
//   4. waits until no other `choosing` file exists, then until no other ticket
//      orders before its own (by n, then pid, then id), and holds the lock.
// Releasing deletes the ticket. A waiter that starts choosing after another's
// ticket exists sees that ticket in step 2 and takes a higher number; one that
// chose at the same time is seen in step 4. Files whose process has ended are
// deleted when read, so a crashed holder does not block anyone.

interface LockFile {
  readonly kind: "choosing" | "ticket";
  readonly number: number;
  readonly pid: number;
  readonly id: string;
}

function parseLockFile(name: string): LockFile | null {
  const parts = name.split(".");
  if (parts[0] === "choosing" && parts.length === 3) return { kind: "choosing", number: 0, pid: Number(parts[1]), id: parts[2]! };
  if (parts[0] === "ticket" && parts.length === 4) return { kind: "ticket", number: Number(parts[1]), pid: Number(parts[2]), id: parts[3]! };
  return null;
}

/** The lock files of processes that still exist. Files of processes that ended are deleted. */
async function liveLockFiles(directory: string): Promise<LockFile[]> {
  const live: LockFile[] = [];
  for (const name of await listDirectory(directory)) {
    const file = parseLockFile(name);
    if (file === null) continue;
    if (isProcessAlive(file.pid)) live.push(file);
    else await fs.rm(appendToPath(directory, [name]), { force: true });
  }
  return live;
}

function ordersBefore(left: LockFile, right: LockFile): boolean {
  if (left.number !== right.number) return left.number < right.number;
  if (left.pid !== right.pid) return left.pid < right.pid;
  return left.id < right.id;
}

/** Waits for the lock kept in `directory` and resolves with the function that releases it. */
async function acquireVersionLock(directory: string, signal: AbortSignal | undefined): Promise<() => Promise<void>> {
  await fs.mkdir(directory, { recursive: true });
  const id = randomBytes(8).toString("hex");
  const choosingFile = appendToPath(directory, [`choosing.${process.pid}.${id}`]);
  await fs.writeFile(choosingFile, "");
  let mine: LockFile;
  let ticketFile: string;
  try {
    const tickets = (await listDirectory(directory)).map(parseLockFile).filter((file) => file?.kind === "ticket") as LockFile[];
    mine = { kind: "ticket", number: 1 + Math.max(0, ...tickets.map((ticket) => ticket.number)), pid: process.pid, id };
    ticketFile = appendToPath(directory, [`ticket.${mine.number}.${mine.pid}.${id}`]);
    await fs.writeFile(ticketFile, "");
  } finally {
    await fs.rm(choosingFile, { force: true });
  }
  const release = async (): Promise<void> => {
    await fs.rm(ticketFile, { force: true });
  };
  try {
    for (;;) {
      if (signal?.aborted === true) throw signal.reason;
      const others = (await liveLockFiles(directory)).filter((file) => file.id !== id);
      const someoneChoosing = others.some((file) => file.kind === "choosing");
      const someoneAhead =
        !someoneChoosing &&
        (await liveLockFiles(directory)).some((file) => file.id !== id && file.kind === "ticket" && ordersBefore(file, mine));
      if (!someoneChoosing && !someoneAhead) return release;
      await sleep(LOCK_POLL_MS);
    }
  } catch (error) {
    await release();
    throw error;
  }
}

export function createAdapterInstaller(options: AdapterInstallerOptions): AdapterInstaller {
  const adaptersRoot = appendToPath(options.cacheDir, ["adapters"]);
  const strip = options.strip ?? 1;
  const packageDirectory = (pkg: string): string => appendToPath(adaptersRoot, pkg.split("/"));
  const pathFor = (pkg: string, version: string): string => {
    checkPackage(pkg, version);
    return appendToPath(packageDirectory(pkg), [version]);
  };
  const leaseDirectory = (pkg: string, version: string): string => appendToPath(packageDirectory(pkg), [LEASES_DIRECTORY, version]);

  /** Runs `work` while holding the lock of `pkg@version`. */
  const withVersionLock = async <Result>(pkg: string, version: string, work: () => Promise<Result>): Promise<Result> => {
    const release = await acquireVersionLock(appendToPath(packageDirectory(pkg), [LOCKS_DIRECTORY, version]), options.signal);
    try {
      return await work();
    } finally {
      await release();
    }
  };

  /** Installs `pkg@version` unless a whole install is there. The caller holds the version's lock. */
  const installHoldingLock = async (pkg: string, version: string): Promise<InstalledAdapter> => {
    const dir = pathFor(pkg, version);
    const installed: InstalledAdapter = { pkg, version, dir };
    if (await exists(dir)) {
      if (options.isIntact === undefined || (await options.isIntact(installed))) return installed;
      // A broken install: out of the final path first, so it is replaced whole or not at all.
      const brokenDir = appendToPath(packageDirectory(pkg), [`${TRASH_PREFIX}${process.pid}-${randomUUID()}`]);
      await fs.rename(dir, brokenDir);
      await fs.rm(brokenDir, { recursive: true, force: true });
    }
    const stagingDir = appendToPath(packageDirectory(pkg), [`${STAGING_PREFIX}${process.pid}-${randomUUID()}`]);
    await fs.mkdir(stagingDir);
    try {
      const request: TarballRequest = options.signal === undefined ? { pkg, version } : { pkg, version, signal: options.signal };
      const tarball = await options.fetchTarball(request);
      await extractTarball(tarball, stagingDir, options.signal === undefined ? { strip } : { strip, signal: options.signal });
      if (options.prepare !== undefined) await options.prepare({ dir: stagingDir, pkg, version });
      await fs.rename(stagingDir, dir);
      return installed;
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  };

  /** True when a live process holds a lease on the version. Deletes lease files of dead processes. */
  const hasLiveLease = async (pkg: string, version: string): Promise<boolean> => {
    let live = false;
    for (const name of await listDirectory(leaseDirectory(pkg, version))) {
      if (isProcessAlive(ownerPid(name))) live = true;
      else await fs.rm(appendToPath(leaseDirectory(pkg, version), [name]), { force: true });
    }
    return live;
  };

  /** Moves an unleased version aside under its lock; resolves with where it went, or null when it stays. */
  const moveAsideUnlessLeased = (pkg: string, version: string): Promise<string | null> =>
    withVersionLock(pkg, version, async () => {
      if (await hasLiveLease(pkg, version)) return null;
      const trashDir = appendToPath(packageDirectory(pkg), [`${TRASH_PREFIX}${process.pid}-${randomUUID()}`]);
      try {
        await fs.rename(appendToPath(packageDirectory(pkg), [version]), trashDir);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
      return trashDir;
    });

  const installedPackages = async (): Promise<string[]> => {
    const packages: string[] = [];
    for (const name of await listDirectory(adaptersRoot)) {
      if (!name.startsWith("@")) {
        packages.push(name);
        continue;
      }
      for (const scoped of await listDirectory(appendToPath(adaptersRoot, [name]))) packages.push(`${name}/${scoped}`);
    }
    return packages;
  };

  return {
    pathFor,

    async install(pkg, version) {
      checkPackage(pkg, version);
      return withVersionLock(pkg, version, () => installHoldingLock(pkg, version));
    },

    async lease(pkg, version) {
      checkPackage(pkg, version);
      return withVersionLock(pkg, version, async () => {
        await fs.mkdir(leaseDirectory(pkg, version), { recursive: true });
        const leaseFile = appendToPath(leaseDirectory(pkg, version), [`${process.pid}-${randomUUID()}`]);
        await fs.writeFile(leaseFile, "");
        try {
          const installed = await installHoldingLock(pkg, version);
          let released = false;
          return {
            ...installed,
            async release() {
              if (released) return;
              released = true;
              await fs.rm(leaseFile, { force: true });
            },
          };
        } catch (error) {
          await fs.rm(leaseFile, { force: true });
          throw error;
        }
      });
    },

    async cleanup(cleanupOptions = {}) {
      const removed: InstalledAdapter[] = [];
      for (const pkg of await installedPackages()) {
        if (!PACKAGE_NAME.test(pkg)) continue;
        for (const name of await listDirectory(packageDirectory(pkg))) {
          const leftover = name.startsWith(STAGING_PREFIX) || name.startsWith(TRASH_PREFIX);
          if (leftover) {
            const pid = ownerPid(name.slice(name.indexOf("-") + 1));
            if (!isProcessAlive(pid)) await fs.rm(appendToPath(packageDirectory(pkg), [name]), { recursive: true, force: true });
            continue;
          }
          if (!VERSION.test(name)) continue;
          if (cleanupOptions.keep?.(pkg, name) === true) continue;
          const trashDir = await moveAsideUnlessLeased(pkg, name);
          if (trashDir === null) continue;
          // Out of the final path already, so deleting it outside the lock is safe.
          await fs.rm(trashDir, { recursive: true, force: true });
          removed.push({ pkg, version: name, dir: appendToPath(packageDirectory(pkg), [name]) });
        }
      }
      return removed;
    },
  };
}

export interface NpmRegistryFetchOptions {
  /** Defaults to `https://registry.npmjs.org`. */
  registry?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * Accept only a `dist.integrity` in sha512, sha384 or sha256 (the
   * algorithms of W3C Subresource Integrity; npm publishes sha512), and
   * refuse a version whose manifest offers only a sha1 integrity or the sha1
   * `shasum`. Defaults to false, which falls back to `shasum` for registries
   * that publish no integrity.
   */
  strongIntegrityOnly?: boolean;
}

async function* readBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Passes `chunks` through and, at the end, throws unless their digest equals `expected`. */
async function* checkDigest(
  chunks: AsyncIterable<Uint8Array>,
  algorithm: string,
  expected: string,
  encoding: "base64" | "hex",
  label: string,
): AsyncGenerator<Uint8Array> {
  const hash = createHash(algorithm);
  for await (const chunk of chunks) {
    hash.update(chunk);
    yield chunk;
  }
  const actual = hash.digest(encoding);
  if (actual !== expected) throw callErrors.protocol("integrity_mismatch", `The tarball of ${label} does not match its published ${algorithm} digest`);
}

/** The strongest digest npm publishes for a version: an SRI `integrity` (sha512, sha384 or sha256), else, unless `strongOnly`, the sha1 `shasum`. */
function publishedDigest(dist: { integrity?: unknown; shasum?: unknown }, strongOnly: boolean): { algorithm: string; expected: string; encoding: "base64" | "hex" } | null {
  if (typeof dist.integrity === "string") {
    for (const algorithm of ["sha512", "sha384", "sha256"]) {
      const entry = dist.integrity.split(/\s+/).find((candidate) => candidate.startsWith(`${algorithm}-`));
      if (entry !== undefined) return { algorithm, expected: entry.slice(algorithm.length + 1).replace(/\?.*$/, ""), encoding: "base64" };
    }
  }
  if (typeof dist.shasum === "string" && !strongOnly) return { algorithm: "sha1", expected: dist.shasum.toLowerCase(), encoding: "hex" };
  return null;
}

/**
 * A `TarballFetch` that downloads from an npm registry over HTTP: it reads the
 * version's manifest, downloads `dist.tarball`, and fails the install unless
 * the bytes match the published digest.
 */
export function npmRegistryFetch(fetchOptions: NpmRegistryFetchOptions = {}): TarballFetch {
  const registry = (fetchOptions.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  const fetchImplementation = fetchOptions.fetch ?? globalThis.fetch;
  return async ({ pkg, version, signal }) => {
    const label = `${pkg}@${version}`;
    const manifestUrl = `${registry}/${encodeURIComponent(pkg).replace(/^%40/, "@")}/${encodeURIComponent(version)}`;
    const init = signal === undefined ? {} : { signal };
    const manifestResponse = await fetchImplementation(manifestUrl, { ...init, headers: { accept: "application/json" } });
    if (manifestResponse.status === 404) throw callErrors.notFound({ resource: "package version", id: label });
    if (!manifestResponse.ok) throw callErrors.transport(`The registry answered ${manifestResponse.status} for ${label}`);
    const manifest = (await manifestResponse.json()) as { dist?: { tarball?: unknown; integrity?: unknown; shasum?: unknown } };
    const tarballUrl = manifest.dist?.tarball;
    if (typeof tarballUrl !== "string") throw callErrors.protocol("no_tarball", `The registry manifest of ${label} has no dist.tarball`);
    const strongOnly = fetchOptions.strongIntegrityOnly === true;
    const digest = publishedDigest(manifest.dist ?? {}, strongOnly);
    if (digest === null) {
      throw callErrors.protocol(
        "no_integrity",
        strongOnly
          ? `The registry manifest of ${label} publishes no sha512, sha384 or sha256 dist.integrity to check the tarball against (a sha1 integrity or shasum is not accepted)`
          : `The registry manifest of ${label} publishes no digest to check the tarball against`,
      );
    }
    const tarballResponse = await fetchImplementation(new URL(tarballUrl, `${registry}/`), init);
    if (!tarballResponse.ok || tarballResponse.body === null) {
      throw callErrors.transport(`The registry answered ${tarballResponse.status} for the tarball of ${label}`);
    }
    return checkDigest(readBody(tarballResponse.body), digest.algorithm, digest.expected, digest.encoding, label);
  };
}
