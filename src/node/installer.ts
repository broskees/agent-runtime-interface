// The managed adapter installer. It puts one version of a package at
// `<cacheDir>/adapters/<pkg>/<version>` from a tarball that a pluggable fetch
// supplies. It never runs `npx`, `npm` or any other process.
//
// Atomic installs: the tarball is extracted into a staging directory beside
// the final one (`.staging-<pid>-<random>`), and only a complete extraction is
// renamed to the final path. Rename is atomic, so the final path either does
// not exist or holds a whole install, even when the installing process is
// killed midway. Concurrent installs of one version in this process share one
// fetch. Across processes, each extracts on its own, the first rename wins,
// and the others discard their copy and use the winner's.
//
// Leases: `lease(pkg, version)` records a lease file
// (`.leases/<version>/<pid>-<random>`) and installs the version if needed. A
// lease is live until it is released or its process ends. `cleanup()` removes
// every installed version that no live lease holds (and that `keep` does not
// keep), plus staging and trash left by processes that died. To remove a
// version it first renames it aside, then checks the leases again, and puts it
// back if a lease arrived in between, so a version is never deleted under a
// new lease and never seen half-deleted at the final path.
//
// Installs hold only the package's own files. A package that needs its npm
// dependencies installed next to it must bundle them.

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { callErrors } from "../errors.ts";
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
  /** Aborting it cancels installs in progress. */
  signal?: AbortSignal;
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
  /** Installs `pkg@version` unless it is already installed, and resolves with where it is. */
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

export function createAdapterInstaller(options: AdapterInstallerOptions): AdapterInstaller {
  const adaptersRoot = path.join(path.resolve(options.cacheDir), "adapters");
  const strip = options.strip ?? 1;
  const installsInProgress = new Map<string, Promise<InstalledAdapter>>();

  const packageDirectory = (pkg: string): string => path.join(adaptersRoot, ...pkg.split("/"));
  const pathFor = (pkg: string, version: string): string => {
    checkPackage(pkg, version);
    return path.join(packageDirectory(pkg), version);
  };
  const leaseDirectory = (pkg: string, version: string): string => path.join(packageDirectory(pkg), LEASES_DIRECTORY, version);

  const installNow = async (pkg: string, version: string): Promise<InstalledAdapter> => {
    const dir = pathFor(pkg, version);
    const installed: InstalledAdapter = { pkg, version, dir };
    if (await exists(dir)) return installed;
    await fs.mkdir(packageDirectory(pkg), { recursive: true });
    const stagingDir = path.join(packageDirectory(pkg), `${STAGING_PREFIX}${process.pid}-${randomUUID()}`);
    await fs.mkdir(stagingDir);
    try {
      const request: TarballRequest = options.signal === undefined ? { pkg, version } : { pkg, version, signal: options.signal };
      const tarball = await options.fetchTarball(request);
      await extractTarball(tarball, stagingDir, options.signal === undefined ? { strip } : { strip, signal: options.signal });
      await fs.rename(stagingDir, dir);
      return installed;
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      // Another process finished first: its rename won, so use its install.
      if (await exists(dir)) return installed;
      throw error;
    }
  };

  const install = async (pkg: string, version: string): Promise<InstalledAdapter> => {
    const dir = pathFor(pkg, version);
    const inProgress = installsInProgress.get(dir);
    if (inProgress !== undefined) return inProgress;
    const started = installNow(pkg, version).finally(() => installsInProgress.delete(dir));
    installsInProgress.set(dir, started);
    return started;
  };

  /** True when a live process holds a lease on the version. Deletes lease files of dead processes. */
  const hasLiveLease = async (pkg: string, version: string): Promise<boolean> => {
    let live = false;
    for (const name of await listDirectory(leaseDirectory(pkg, version))) {
      if (isProcessAlive(ownerPid(name))) live = true;
      else await fs.rm(path.join(leaseDirectory(pkg, version), name), { force: true });
    }
    return live;
  };

  const removeUnleasedVersion = async (pkg: string, version: string): Promise<boolean> => {
    if (await hasLiveLease(pkg, version)) return false;
    const dir = path.join(packageDirectory(pkg), version);
    const trashDir = path.join(packageDirectory(pkg), `${TRASH_PREFIX}${process.pid}-${randomUUID()}`);
    try {
      await fs.rename(dir, trashDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    if (await hasLiveLease(pkg, version)) {
      // A lease arrived between the check and the rename: put the version back.
      try {
        await fs.rename(trashDir, dir);
      } catch {
        // The leaseholder already reinstalled it; its copy stays.
        await fs.rm(trashDir, { recursive: true, force: true });
      }
      return false;
    }
    await fs.rm(trashDir, { recursive: true, force: true });
    return true;
  };

  const installedPackages = async (): Promise<string[]> => {
    const packages: string[] = [];
    for (const name of await listDirectory(adaptersRoot)) {
      if (!name.startsWith("@")) {
        packages.push(name);
        continue;
      }
      for (const scoped of await listDirectory(path.join(adaptersRoot, name))) packages.push(`${name}/${scoped}`);
    }
    return packages;
  };

  return {
    pathFor,
    install,

    async lease(pkg, version) {
      checkPackage(pkg, version);
      await fs.mkdir(leaseDirectory(pkg, version), { recursive: true });
      const leaseFile = path.join(leaseDirectory(pkg, version), `${process.pid}-${randomUUID()}`);
      await fs.writeFile(leaseFile, "");
      try {
        const installed = await install(pkg, version);
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
    },

    async cleanup(cleanupOptions = {}) {
      const removed: InstalledAdapter[] = [];
      for (const pkg of await installedPackages()) {
        if (!PACKAGE_NAME.test(pkg)) continue;
        for (const name of await listDirectory(packageDirectory(pkg))) {
          const leftover = name.startsWith(STAGING_PREFIX) || name.startsWith(TRASH_PREFIX);
          if (leftover) {
            const pid = ownerPid(name.slice(name.indexOf("-") + 1));
            if (!isProcessAlive(pid)) await fs.rm(path.join(packageDirectory(pkg), name), { recursive: true, force: true });
            continue;
          }
          if (!VERSION.test(name)) continue;
          if (cleanupOptions.keep?.(pkg, name) === true) continue;
          if (await removeUnleasedVersion(pkg, name)) removed.push({ pkg, version: name, dir: path.join(packageDirectory(pkg), name) });
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

/** The strongest digest npm publishes for a version: an SRI `integrity` (sha512, sha384 or sha256), else the sha1 `shasum`. */
function publishedDigest(dist: { integrity?: unknown; shasum?: unknown }): { algorithm: string; expected: string; encoding: "base64" | "hex" } | null {
  if (typeof dist.integrity === "string") {
    for (const algorithm of ["sha512", "sha384", "sha256"]) {
      const entry = dist.integrity.split(/\s+/).find((candidate) => candidate.startsWith(`${algorithm}-`));
      if (entry !== undefined) return { algorithm, expected: entry.slice(algorithm.length + 1).replace(/\?.*$/, ""), encoding: "base64" };
    }
  }
  if (typeof dist.shasum === "string") return { algorithm: "sha1", expected: dist.shasum.toLowerCase(), encoding: "hex" };
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
    const digest = publishedDigest(manifest.dist ?? {});
    if (digest === null) throw callErrors.protocol("no_integrity", `The registry manifest of ${label} publishes no digest to check the tarball against`);
    const tarballResponse = await fetchImplementation(new URL(tarballUrl, `${registry}/`), init);
    if (!tarballResponse.ok || tarballResponse.body === null) {
      throw callErrors.transport(`The registry answered ${tarballResponse.status} for the tarball of ${label}`);
    }
    return checkDigest(readBody(tarballResponse.body), digest.algorithm, digest.expected, digest.encoding, label);
  };
}
