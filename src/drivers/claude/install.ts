// Managed installs of the Claude Agent SDK, for hosts that cannot install it
// with npm: above all the standalone `ari-driver`, which cannot import a
// package by name. `maintenance.install` and `maintenance.update` download the
// pinned SDK and this platform's native Claude Code package from an npm
// registry and unpack them with `ari/node`'s adapter installer under the
// instance's cache directory:
//
//   <cacheDir>/adapters/@anthropic-ai/claude-agent-sdk/<version>/            the SDK
//   <cacheDir>/adapters/@anthropic-ai/claude-agent-sdk-<os>-<arch>/<version>/ its native binary
//
// The SDK's `sdk.mjs` bundles everything it runs and imports only Node
// built-ins; its peers (`zod`, `@anthropic-ai/sdk`,
// `@modelcontextprotocol/sdk`) serve its type declarations. So the two
// packages are the whole install, and no Node or npm is needed.
//
// The native package sits outside any `node_modules` the SDK searches, so
// the loader names the binary in every query (`passBundledExecutable`).

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { callErrors } from "../../errors.ts";
import { CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION } from "../../meta/claude.ts";
import { createAdapterInstaller, npmRegistryFetch } from "../../node/installer.ts";
import type { TarballFetch } from "../../node/installer.ts";
import { importClaudeSdkPackage, nativeBinaryCandidates, prefersMusl } from "./sdk.ts";
import type { ClaudeSdkRuntime } from "./sdk.ts";

/** What a host tells the user when a managed install is incomplete. */
const REINSTALL_HINT = "Run maintenance.install on this instance again.";

/** One package of a managed install. */
export interface ClaudeManagedPackage {
  readonly pkg: string;
  readonly version: string;
}

/** A platform package candidate (`<package>/claude`) split into the package and the binary's file name. */
function splitCandidate(candidate: string): { pkg: string; binary: string } {
  const slash = candidate.lastIndexOf("/");
  return { pkg: candidate.slice(0, slash), binary: candidate.slice(slash + 1) };
}

/**
 * The packages a managed install of the pinned SDK holds on this platform:
 * the native package first (the one the SDK itself prefers here, glibc before
 * musl on Linux), then the SDK.
 */
export function claudeManagedPackages(platform: string, arch: string, preferMusl: boolean): ClaudeManagedPackage[] {
  const native = splitCandidate(nativeBinaryCandidates(platform, arch, preferMusl)[0]!).pkg;
  return [
    { pkg: native, version: CLAUDE_SDK_VERSION },
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

/**
 * The SDK a managed install holds in `cacheDir`, loaded by file URL, or null
 * when the pinned SDK is not installed there. An install whose native
 * package is missing is reported unavailable.
 */
export async function loadManagedClaudeSdk(cacheDir: string): Promise<ClaudeSdkRuntime | null> {
  const installer = createAdapterInstaller({ cacheDir, fetchTarball: NO_FETCH });
  const sdkDirectory = installer.pathFor(CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION);
  if (!(await exists(`${sdkDirectory}/package.json`))) return null;
  const loaded = await importClaudeSdkPackage(sdkDirectory, (detail) =>
    callErrors.driverUnavailable({ package: CLAUDE_SDK_PACKAGE, installHint: REINSTALL_HINT }, `The managed Claude Agent SDK install cannot be loaded: ${detail}. ${REINSTALL_HINT}`),
  );
  for (const candidate of nativeBinaryCandidates(process.platform, process.arch, prefersMusl())) {
    const { pkg, binary } = splitCandidate(candidate);
    const executable = `${installer.pathFor(pkg, CLAUDE_SDK_VERSION)}/${binary}`;
    if (await exists(executable)) {
      return { sdk: loaded.sdk, version: loaded.version, claudeCodeVersion: loaded.claudeCodeVersion, bundledExecutable: executable, passBundledExecutable: true };
    }
  }
  const native = claudeManagedPackages(process.platform, process.arch, prefersMusl())[0]!.pkg;
  throw callErrors.driverUnavailable(
    { package: native, binary: "claude", installHint: REINSTALL_HINT },
    `The managed Claude Agent SDK install has no native Claude Code package for ${process.platform}-${process.arch} (${native}@${CLAUDE_SDK_VERSION}). ${REINSTALL_HINT}`,
  );
}

export interface ClaudeSdkInstallOptions {
  /** The instance's cache directory; the install goes under `<cacheDir>/adapters`. */
  readonly cacheDir: string;
  /** The instance's temp directory; downloads wait there until every one is verified. */
  readonly tmpDir: string;
  /** The npm registry to download from. */
  readonly registry: string;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Installs the pinned SDK and this platform's native package, unless they
 * are installed already.
 *
 * Every tarball not yet installed is first downloaded into a temp directory
 * and checked against the registry's `dist.integrity` (`ari/node`'s
 * `npmRegistryFetch`). Only when all of them match are they unpacked, so a
 * tarball that does not match leaves nothing installed. Unpacking goes
 * through `ari/node`'s installer, native package first: each version is
 * extracted aside and renamed into place, under a lock per version, so two
 * installs at once end with one whole install, and the second reuses the
 * first's.
 */
export async function installClaudeSdk(options: ClaudeSdkInstallOptions): Promise<ClaudeManagedPackage[]> {
  const download = npmRegistryFetch({ registry: options.registry, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  const packages = claudeManagedPackages(process.platform, process.arch, prefersMusl());
  const downloaded = new Map<string, string>();
  const installer = createAdapterInstaller({
    cacheDir: options.cacheDir,
    fetchTarball: (request) => {
      const file = downloaded.get(request.pkg);
      // A version removed after the check below is fetched again, still against its integrity.
      return file === undefined ? download(request) : createReadStream(file);
    },
  });
  const scratch = `${options.tmpDir}/claude-sdk-download-${randomUUID()}`;
  try {
    await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
    for (const [index, { pkg, version }] of packages.entries()) {
      if (await exists(installer.pathFor(pkg, version))) continue;
      const file = `${scratch}/${index}.tgz`;
      const handle = await fs.open(file, "w");
      try {
        // The stream fails at its end unless the bytes match the published digest.
        for await (const chunk of await download({ pkg, version })) await handle.write(chunk);
      } finally {
        await handle.close();
      }
      downloaded.set(pkg, file);
    }
    for (const { pkg, version } of packages) await installer.install(pkg, version);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  return packages;
}
