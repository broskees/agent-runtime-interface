// `ari/drivers/antigravity`: the Google Antigravity CLI over ACP. Quirks it
// keeps:
// - each instance gets its own profile directory (`<stateDir>/profile`),
//   passed as `--gemini-dir`, and `agy` keeps the instance's Google sign-in
//   in that profile's file storage, never in the OS keyring's one entry that
//   every `agy` on the machine shares, so instances never share a Google
//   sign-in (see ANTIGRAVITY_LAUNCH_ENVIRONMENT);
// - ambient Google credentials are stripped through the host's
//   `process.envPolicy`; the driver refuses to start a session when the
//   host's policy would let one through (see ANTIGRAVITY_STRIPPED_VARIABLES);
// - permission prompts take fixed choices only (`allowCustomAnswer: false`);
// - the agent can checkpoint the workspace but cannot roll back its
//   conversation, so `rollbackThread` rejects with `unsupported` before it
//   does anything, and touches no file;
// - a managed install (`installation: "managed"`) is installed by
//   `maintenance.install()` through `ari/node`'s installer, and every running
//   session holds an installer lease on its version until its process exits.

import * as fs from "node:fs/promises";
import { callErrors } from "../../errors.ts";
import type { RollbackThreadInput } from "../../generated/session.ts";
import type { ThreadSnapshot } from "../../generated/thread.ts";
import type { HostServices, Instance, Session } from "../../runtime.ts";
import {
  ANTIGRAVITY_CLI_MANIFEST,
  ANTIGRAVITY_CONFIG_SCHEMA,
  ANTIGRAVITY_DEFAULT_CONFIG,
  ANTIGRAVITY_STRIPPED_VARIABLES,
  meta,
} from "../../meta/antigravity.ts";
import type { AntigravityConfig } from "../../meta/antigravity.ts";
import type { Driver } from "../../runtime.ts";
import { compareVersions, createAcpDriver, inTestedRange, rangeText } from "../acp/driver.ts";
import type { AcpFlavorContext } from "../acp/driver.ts";
import { archiveFetch, flavorInstaller, installedVersions } from "../acp/install.ts";
import type { FetchFunction } from "../acp/install.ts";

export type { AntigravityConfig } from "../../meta/antigravity.ts";
export { ANTIGRAVITY_CLI_MANIFEST, ANTIGRAVITY_CONFIG_SCHEMA, ANTIGRAVITY_DEFAULT_CONFIG, ANTIGRAVITY_STRIPPED_VARIABLES } from "../../meta/antigravity.ts";

/** The installer's package name for the managed CLI. */
export const ANTIGRAVITY_PACKAGE = "antigravity-cli";

const TESTED = { min: "1.5.0", below: "1.6.0" };

/** One release of the CLI, as its manifest gives it. */
export interface AntigravityRelease {
  readonly version: string;
  readonly url: string;
  readonly sha512: string;
}

/** The manifest name of a platform, or null when the CLI has no build for it. */
export function antigravityTarget(platform: string, arch: string): string | null {
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) return null;
  return `${platform === "win32" ? "windows" : platform}_${arch === "x64" ? "amd64" : arch}`;
}

/** The executable inside a managed install. */
export function antigravityExecutable(platform: string): string {
  return platform === "win32" ? "agy.exe" : "antigravity";
}

/** The instance's own profile directory. */
export function antigravityProfile(host: HostServices<unknown>): string {
  return `${host.paths.stateDir}/profile`;
}

/**
 * The variables the driver gives `agy acp`, all of which `agy` 1.5.x reads:
 * - `AGY_CLI_FORCE_FILE_TOKEN_STORAGE`: `agy` 1.5.16 and later keep a Google
 *   sign-in in the OS keyring's one entry (service `gemini`, account
 *   `antigravity`), whatever `--gemini-dir` says, unless this is set; then in
 *   `<profile>/antigravity-acp/antigravity-oauth-token` (they log "Using
 *   file-based token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is
 *   set"). `AGY_ACP_FORCE_FILE_STORAGE` and `GEMINI_HOME` are not in the 1.5.x
 *   binary.
 * - `AGY_CLI_DISABLE_AUTO_UPDATE`: the switch of the CLI's self-updater.
 */
const ANTIGRAVITY_LAUNCH_ENVIRONMENT: { readonly [name: string]: string } = { AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1", AGY_CLI_DISABLE_AUTO_UPDATE: "1" };

/** The required variables the host's environment policy would let through. */
export function unstrippedVariables(stripAmbient: readonly string[]): string[] {
  const covered = (name: string): boolean => stripAmbient.some((entry) => (entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : entry === name));
  return ANTIGRAVITY_STRIPPED_VARIABLES.filter((name) => !covered(name));
}

/** Reads the newest release from the platform's manifest. */
export async function fetchAntigravityRelease(fetchImplementation: FetchFunction, manifestBase: string, target: string): Promise<AntigravityRelease> {
  const response = await fetchImplementation(`${manifestBase.replace(/\/+$/, "")}/${target}.json`, { headers: { accept: "application/json" } });
  if (!response.ok) throw callErrors.transport(`The Antigravity release manifest answered ${response.status}`);
  const manifest = (await response.json()) as { version?: unknown; url?: unknown; sha512?: unknown };
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version) || typeof manifest.url !== "string" || typeof manifest.sha512 !== "string" || !/^[0-9a-fA-F]{128}$/.test(manifest.sha512)) {
    throw callErrors.protocol("invalid_manifest", "The Antigravity release manifest has no valid version, url and sha512");
  }
  if (!manifest.url.startsWith("https://")) throw callErrors.protocol("invalid_manifest", "The Antigravity release manifest names a download that is not https");
  return { version: manifest.version, url: manifest.url, sha512: manifest.sha512.toLowerCase() };
}

export interface AntigravityDriverOptions {
  /** How the driver downloads release manifests and archives. Defaults to the global `fetch`. */
  readonly fetch?: FetchFunction;
  /** The platform to install for. Defaults to this process's. */
  readonly platform?: { readonly os: string; readonly arch: string };
}

/** An Antigravity driver; tests pass their own `fetch`. */
export function createAntigravityDriver(options: AntigravityDriverOptions = {}): Driver<AntigravityConfig> {
  const fetchImplementation = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const platform = options.platform ?? { os: process.platform, arch: process.arch };
  const executable = antigravityExecutable(platform.os);

  /** The managed version a session runs: the newest installed one, or the pinned one. */
  const managedVersion = async (context: AcpFlavorContext<AntigravityConfig>): Promise<string | undefined> => {
    const versions = await installedVersions(context.host.paths.cacheDir, ANTIGRAVITY_PACKAGE);
    if (context.config.version !== "latest") return versions.includes(context.config.version) ? context.config.version : undefined;
    return versions.sort(compareVersions).at(-1);
  };

  const install = async (context: AcpFlavorContext<AntigravityConfig>): Promise<string> => {
    const target = antigravityTarget(platform.os, platform.arch);
    if (target === null) throw callErrors.unsupported("maintenance.install", `The Antigravity CLI has no build for ${platform.os}-${platform.arch}`);
    // Windows releases are a bare executable, which the adapter installer (tar archives only) cannot install.
    if (platform.os === "win32") throw callErrors.unsupported("maintenance.install", "Managed Antigravity installs need a tar.gz release; the Windows release is a bare agy.exe. Use installation: \"path\".");
    const release = await fetchAntigravityRelease(fetchImplementation, context.config.releaseManifestUrl, target);
    if (context.config.version !== "latest" && context.config.version !== release.version) {
      throw callErrors.notFound({ resource: "Antigravity release", id: context.config.version, message: `The release manifest offers ${release.version}, not the pinned ${context.config.version}` });
    }
    const installer = flavorInstaller(context.host.paths.cacheDir, archiveFetch(fetchImplementation, { pkg: ANTIGRAVITY_PACKAGE, version: release.version, url: release.url, algorithm: "sha512", digest: release.sha512 }));
    await installer.install(ANTIGRAVITY_PACKAGE, release.version);
    return release.version;
  };

  return createAcpDriver<AntigravityConfig>({
    kind: "antigravity",
    metadata: meta.metadata,
    configSchema: ANTIGRAVITY_CONFIG_SCHEMA,
    defaultConfig: () => ({ ...ANTIGRAVITY_DEFAULT_CONFIG, configDependencies: {} }),
    cliManifest: ANTIGRAVITY_CLI_MANIFEST,
    testedRange: TESTED,
    launchIdentity: (config) => (config.installation === "managed" ? `managed:${config.version}` : config.command),

    async probeTarget(context) {
      if (context.config.installation === "path") return { kind: "command", command: context.config.command, versionArgs: ["--version"] };
      // A managed install is looked up, never started or installed, by a probe.
      const version = await managedVersion(context);
      if (version === undefined) {
        return { kind: "known", installed: false, error: callErrors.driverUnavailable({ package: ANTIGRAVITY_PACKAGE, binary: executable }, "The managed Antigravity CLI is not installed; run maintenance.install()").callError };
      }
      return { kind: "known", installed: true, version };
    },

    async beforeSession(context) {
      // The host strips ambient Google credentials; a session never starts when its policy would let one through.
      const missing = unstrippedVariables(context.host.process.envPolicy.stripAmbient);
      if (missing.length > 0) {
        throw callErrors.invalidState("env_policy_incomplete", `The host's process.envPolicy must strip ${missing.join(", ")} for Antigravity (the CLI manifest's envScrubPrefixes cover them all)`);
      }
      await fs.mkdir(antigravityProfile(context.host as HostServices<unknown>), { recursive: true, mode: 0o700 });
    },

    async launch(context) {
      const profile = antigravityProfile(context.host as HostServices<unknown>);
      const args = ["acp", "--gemini-dir", profile, "--app-data-dir", "antigravity-acp"];
      const env = { ...ANTIGRAVITY_LAUNCH_ENVIRONMENT };
      if (context.config.installation === "path") return { command: context.config.command, args, env };
      const version = await managedVersion(context);
      if (version === undefined) throw callErrors.driverUnavailable({ package: ANTIGRAVITY_PACKAGE, binary: executable }, "The managed Antigravity CLI is not installed; run maintenance.install()");
      // The lease keeps cleanup away from this version until the agent process exits.
      const installer = flavorInstaller(context.host.paths.cacheDir, async () => {
        throw callErrors.invalidState("not_installed", `Antigravity ${version} was removed while a session started`);
      });
      const lease = await installer.lease(ANTIGRAVITY_PACKAGE, version);
      return { command: `${lease.dir}/${executable}`, args, env, release: () => lease.release() };
    },

    adjustCapabilities: (capabilities) => ({
      ...capabilities,
      // Antigravity's permission prompts take one of their fixed choices, never a typed answer.
      requests: { ...capabilities.requests, allowCustomAnswer: false },
      checkpointing: { ...capabilities.checkpointing, conversationRollback: false, rollbackReturnsSnapshot: false },
      threads: { ...capabilities.threads, rollback: false },
    }),

    decorateSession(session) {
      const decorated = session as Session;
      // Rejected first, before any file or process is touched: the agent cannot roll back its conversation.
      decorated.rollbackThread = (input: RollbackThreadInput): Promise<ThreadSnapshot> => {
        void input;
        return Promise.reject(callErrors.unsupported("threads.rollback", "Antigravity can checkpoint the workspace but cannot roll back its conversation"));
      };
      return decorated;
    },

    decorateInstance(instance: Instance, context) {
      if (context.config.installation !== "managed") return;
      instance.maintenance = {
        advisory: async () => {
          const version = await managedVersion(context);
          if (version === undefined || inTestedRange(version, TESTED)) return null;
          return { kind: "untested_version", message: `Antigravity ${version} is outside the tested versions ${rangeText(TESTED)}`, currentVersion: version, testedRange: rangeText(TESTED) };
        },
        install: async () => {
          await install(context);
        },
        update: async () => {
          await install(context);
        },
      };
    },
  });
}

export const antigravityDriver: Driver<AntigravityConfig> = createAntigravityDriver();

export default antigravityDriver;
