// `ari/drivers/muse`: the Muse Code driver. It runs the user's `muse` CLI as
// `muse serve`, one host per thread, through the host's process service, and
// speaks the Muse Session Protocol (MSP) over its stdio with the Muse SDK's
// `Connection` (`@muse-code/sdk`, an optional peer loaded with a dynamic
// `import()` when it is needed).
//
// Importing this module loads no vendor code and spawns nothing: `create()`
// only reads whether the instance holds a managed key. A missing SDK or a
// missing `muse` binary shows in `status()` and fails `openSession` with
// `driver_unavailable` naming what to install.

import type { CliLaunchManifest } from "../../generated/driver.ts";
import { MUSE_CONFIG_SCHEMA, MUSE_DRIVER_KIND, MUSE_METADATA, MUSE_TESTED_VERSIONS, museDefaultConfig } from "../../meta/muse.ts";
import type { MuseDriverConfig } from "../../meta/muse.ts";
import type { Driver } from "../../runtime.ts";
import { ARI_VERSION } from "../../version.ts";
import { MUSE_CREDENTIAL_VARIABLES, MuseInstance, hasManagedKey } from "./instance.ts";
import { loadMuseSdk } from "./sdk.ts";
import type { MuseSdkRuntime } from "./sdk.ts";

export type { MuseDriverConfig } from "../../meta/muse.ts";
export { MUSE_CAPABILITIES } from "./capabilities.ts";
export { MUSE_CLIENT_NAME } from "./host.ts";
export { MUSE_API_KEY_SECRET, MUSE_AUTH_METHODS, MUSE_CREDENTIAL_VARIABLES, MUSE_POISON_MS, MUSE_SECRET_NAMESPACE, satisfiesVersionRange, versionAdvisory } from "./instance.ts";
export { MUSE_IDENTITY_VERSION, choiceOption, itemIdFor, musePolicy, planIdFor, requestIdFor, subagentIdFor, threadIdFor, turnIdFor } from "./mapping.ts";
export { museMcpServers } from "./session.ts";
export { loadMuseSdk } from "./sdk.ts";
export type { MuseSdk, MuseSdkRuntime } from "./sdk.ts";
export { MUSE_TESTED_VERSIONS };

/**
 * How a host runs Muse Code itself in a terminal: plain `muse`. The driver
 * names no resume or fork arguments and no MCP injection, because Muse's
 * public documentation names no such CLI flags.
 */
export const MUSE_CLI_MANIFEST: CliLaunchManifest = {
  binary: "muse",
  envScrubPrefixes: [...MUSE_CREDENTIAL_VARIABLES],
  args: { fresh: [] },
};

export interface MuseDriverOptions {
  /** Loads the SDK; defaults to a dynamic `import("@muse-code/sdk")`. */
  readonly loadSdk?: () => Promise<MuseSdkRuntime>;
  /**
   * The command id minter every connection uses (session ids and turn ids
   * come from it). Defaults to the SDK's own UUIDv7 minter; the SDK documents
   * it as the seam for deterministic transcripts.
   */
  readonly mintCommandId?: () => string;
}

/** A Muse driver with its own SDK loader and command id minter. */
export function createMuseDriver(options: MuseDriverOptions = {}): Driver<MuseDriverConfig> {
  return {
    kind: MUSE_DRIVER_KIND,
    ariVersion: ARI_VERSION,
    metadata: MUSE_METADATA,
    configSchema: MUSE_CONFIG_SCHEMA,
    defaultConfig: museDefaultConfig,
    cliManifest: MUSE_CLI_MANIFEST,
    async create(host, input) {
      const managed = await hasManagedKey(host as never);
      return new MuseInstance(host, input.config, input.instanceId, input.environment, managed, {
        loadSdk: options.loadSdk ?? loadMuseSdk,
        ...(options.mintCommandId === undefined ? {} : { mintCommandId: options.mintCommandId }),
      });
    },
  };
}

export const museDriver: Driver<MuseDriverConfig> = createMuseDriver();

export default museDriver;
