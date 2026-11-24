// `ari/drivers/acp-registry`: agents from the ACP Registry, installed and run
// by this driver. Quirks it keeps:
// - the registry's agents are the instance's `subProviders`: `list` reads the
//   registry index, `set` picks one and installs it through `ari/node`'s
//   adapter installer (never npx, uvx or any package manager), `disable`
//   drops the choice;
// - only binary distributions in a tar archive (`.tar.gz`, `.tgz`, `.tar`)
//   with a published sha256 can be installed: the installer unpacks tar only
//   and never installs dependencies. `npx` and `uvx` packages, zip,
//   tar.bz2 and bare-file downloads are refused with an error that says so
//   (docs/drivers/acp-registry.md has the counts for the index of 2026-11-23);
// - a running session holds an installer lease on its agent's version until
//   its process exits, so cleanup never removes it underneath;
// - the driver is tested against ACP protocol versions 1 and 2, and each agent
//   at the version the registry lists: `status()` gives an advisory when the
//   index the instance last read (through `subProviders.list` or `set`, or a
//   session start) does not list the installed version. `status()` itself
//   reads nothing from the network.

import { callErrors } from "../../errors.ts";
import type { SubProvider, UpdateAdvisory } from "../../generated/instance.ts";
import { ACP_REGISTRY_CONFIG_SCHEMA, ACP_REGISTRY_DEFAULT_CONFIG, meta } from "../../meta/acp-registry.ts";
import type { AcpRegistryConfig } from "../../meta/acp-registry.ts";
import type { Driver, Instance } from "../../runtime.ts";
import { compareVersions, createAcpDriver } from "../acp/driver.ts";
import type { AcpFlavorContext } from "../acp/driver.ts";
import { archiveFetch, flavorInstaller, insideInstall, installedVersions, isTarArchive } from "../acp/install.ts";
import type { FetchFunction } from "../acp/install.ts";

export type { AcpRegistryConfig } from "../../meta/acp-registry.ts";
export { ACP_REGISTRY_CONFIG_SCHEMA, ACP_REGISTRY_DEFAULT_CONFIG, ACP_REGISTRY_URL } from "../../meta/acp-registry.ts";

/** One platform build of a binary distribution. */
export interface RegistryBinaryTarget {
  readonly archive: string;
  readonly cmd: string;
  readonly args?: readonly string[];
  readonly env?: { readonly [name: string]: string };
  readonly sha256?: string;
}

/** One agent of the registry index (the manifest format of the ACP Agent Registry RFD). */
export interface RegistryAgent {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly icon?: string;
  readonly distribution: {
    readonly binary?: { readonly [target: string]: RegistryBinaryTarget };
    readonly npx?: { readonly package: string; readonly args?: readonly string[] };
    readonly uvx?: { readonly package: string; readonly args?: readonly string[] };
  };
}

export interface RegistryIndex {
  readonly version: string;
  readonly agents: readonly RegistryAgent[];
}

/** The registry's name for a platform, such as `linux-x86_64`. */
export function registryTarget(platform: string, arch: string): string {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch;
  return `${os}-${cpu}`;
}

/** The build this driver can install for `target`, or why it cannot install the agent. */
export function installableBuild(agent: RegistryAgent, target: string): { build: RegistryBinaryTarget } | { reason: string } {
  const build = agent.distribution.binary?.[target];
  if (build === undefined) {
    if (agent.distribution.npx !== undefined) return { reason: `${agent.name} is distributed as the npm package ${agent.distribution.npx.package}, which needs npx and its dependencies; this driver installs only binary archives and never runs npx` };
    if (agent.distribution.uvx !== undefined) return { reason: `${agent.name} is distributed as the Python package ${agent.distribution.uvx.package}, which needs uvx; this driver installs only binary archives` };
    return { reason: `${agent.name} has no build for ${target}` };
  }
  if (!isTarArchive(build.archive)) return { reason: `${agent.name}'s ${target} build is ${build.archive.split("/").pop() ?? build.archive}; the installer unpacks only tar and tar.gz archives` };
  if (build.sha256 === undefined || !/^[0-9a-fA-F]{64}$/.test(build.sha256)) return { reason: `${agent.name}'s ${target} build publishes no sha256 to check the download against` };
  return { build };
}

function parseIndex(value: unknown): RegistryIndex {
  const index = value as { version?: unknown; agents?: unknown };
  if (typeof index.version !== "string" || !Array.isArray(index.agents)) throw callErrors.protocol("invalid_registry", "The ACP Registry index has no version and agents list");
  const agents = (index.agents as Array<Partial<RegistryAgent>>).filter(
    (agent): agent is RegistryAgent => typeof agent.id === "string" && /^[a-z][a-z0-9-]*$/.test(agent.id) && typeof agent.name === "string" && typeof agent.version === "string" && typeof agent.distribution === "object" && agent.distribution !== null,
  );
  return { version: index.version, agents };
}

export interface AcpRegistryDriverOptions {
  /** How the driver reads the index and downloads archives. Defaults to the global `fetch`. */
  readonly fetch?: FetchFunction;
  /** The platform to install for. Defaults to this process's. */
  readonly platform?: { readonly os: string; readonly arch: string };
}

/** An ACP Registry driver; tests pass their own `fetch`. */
export function createAcpRegistryDriver(options: AcpRegistryDriverOptions = {}): Driver<AcpRegistryConfig> {
  const fetchImplementation = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const platform = options.platform ?? { os: process.platform, arch: process.arch };
  const target = registryTarget(platform.os, platform.arch);

  /** The index each instance read last, for `status()`'s advisory. */
  const lastIndex = new WeakMap<object, RegistryIndex>();
  const readIndex = async (context: AcpFlavorContext<AcpRegistryConfig>): Promise<RegistryIndex> => {
    const response = await fetchImplementation(context.config.registryUrl, { headers: { accept: "application/json" } });
    if (!response.ok) throw callErrors.transport(`The ACP Registry answered ${response.status}`);
    const index = parseIndex(await response.json());
    lastIndex.set(context, index);
    return index;
  };

  /** The agent an instance runs: what `subProviders.set` chose, else its config. */
  const selections = new WeakMap<object, { agentId: string; agentVersion: string }>();
  const selection = (context: AcpFlavorContext<AcpRegistryConfig>): { agentId: string; agentVersion: string } =>
    selections.get(context) ?? { agentId: context.config.agentId, agentVersion: context.config.agentVersion };

  const installedVersion = async (context: AcpFlavorContext<AcpRegistryConfig>, agentId: string, agentVersion: string): Promise<string | undefined> => {
    const versions = await installedVersions(context.host.paths.cacheDir, agentId);
    if (agentVersion !== "") return versions.includes(agentVersion) ? agentVersion : undefined;
    return versions.sort(compareVersions).at(-1);
  };

  return createAcpDriver<AcpRegistryConfig>({
    kind: "acp-registry",
    metadata: meta.metadata,
    configSchema: ACP_REGISTRY_CONFIG_SCHEMA,
    defaultConfig: () => ({ ...ACP_REGISTRY_DEFAULT_CONFIG, configDependencies: {} }),
    launchIdentity: (config) => `${config.registryUrl}#${config.agentId}`,

    async probeTarget(context) {
      const { agentId, agentVersion } = selection(context);
      if (agentId === "") return { kind: "unset", message: "Choose a registry agent with subProviders.set" };
      // The install is looked up on disk; the probe neither reads the network nor installs.
      const version = await installedVersion(context, agentId, agentVersion);
      if (version === undefined) {
        return { kind: "known", installed: false, error: callErrors.driverUnavailable({ package: agentId }, `The registry agent ${agentId} is not installed; install it with subProviders.set`).callError };
      }
      return { kind: "known", installed: true, version };
    },

    advisory(context, version): UpdateAdvisory | undefined {
      const index = lastIndex.get(context);
      const { agentId } = selection(context);
      if (index === undefined || version === undefined || agentId === "") return undefined;
      const listed = index.agents.find((candidate) => candidate.id === agentId)?.version;
      if (listed === version) return undefined;
      if (listed === undefined) {
        return { kind: "untested_version", message: `The ACP Registry no longer lists ${agentId}; the installed ${version} is untested`, currentVersion: version };
      }
      return {
        kind: "untested_version",
        message: `The ACP Registry lists ${agentId} ${listed}, not the installed ${version}; install the listed version with subProviders.set`,
        currentVersion: version,
        latestVersion: listed,
        testedRange: listed,
      };
    },

    async launch(context) {
      const { agentId, agentVersion } = selection(context);
      const version = await installedVersion(context, agentId, agentVersion);
      if (version === undefined) throw callErrors.driverUnavailable({ package: agentId }, `The registry agent ${agentId} is not installed; install it with subProviders.set`);
      const agent = (await readIndex(context)).agents.find((candidate) => candidate.id === agentId);
      const build = agent?.distribution.binary?.[target];
      if (agent === undefined || build === undefined) throw callErrors.notFound({ resource: "registry agent", id: agentId, message: `The ACP Registry no longer lists a ${target} build of ${agentId}` });
      // The lease keeps cleanup away from this version until the agent process exits.
      const installer = flavorInstaller(context.host.paths.cacheDir, async () => {
        throw callErrors.invalidState("not_installed", `${agentId} ${version} was removed while a session started`);
      });
      const lease = await installer.lease(agentId, version);
      return { command: insideInstall(lease.dir, build.cmd), args: [...(build.args ?? [])], env: { ...(build.env ?? {}) }, release: () => lease.release() };
    },

    decorateInstance(instance: Instance, context) {
      instance.subProviders = {
        list: async (): Promise<SubProvider[]> => {
          const index = await readIndex(context);
          const chosen = selection(context);
          const providers: SubProvider[] = [];
          for (const agent of index.agents) {
            const installed = (await installedVersions(context.host.paths.cacheDir, agent.id)).length > 0;
            providers.push({
              id: agent.id,
              label: agent.name,
              ...(agent.description === "" ? {} : { description: agent.description }),
              enabled: agent.id === chosen.agentId,
              installed,
              version: agent.version,
              ...(agent.icon === undefined ? {} : { icon: { type: "url" as const, url: agent.icon } }),
            });
          }
          return providers;
        },
        set: async (input) => {
          const index = await readIndex(context);
          const agent = index.agents.find((candidate) => candidate.id === input.providerId);
          if (agent === undefined) throw callErrors.notFound({ resource: "registry agent", id: input.providerId });
          const installable = installableBuild(agent, target);
          if ("reason" in installable) throw callErrors.invalidState("distribution_unsupported", installable.reason);
          const installer = flavorInstaller(
            context.host.paths.cacheDir,
            archiveFetch(fetchImplementation, { pkg: agent.id, version: agent.version, url: installable.build.archive, algorithm: "sha256", digest: installable.build.sha256 ?? "" }),
          );
          await installer.install(agent.id, agent.version);
          selections.set(context, { agentId: agent.id, agentVersion: agent.version });
        },
        disable: async (input) => {
          if (selection(context).agentId === input.providerId) selections.set(context, { agentId: "", agentVersion: "" });
        },
      };
    },
  });
}

export const acpRegistryDriver: Driver<AcpRegistryConfig> = createAcpRegistryDriver();

export default acpRegistryDriver;
