// `ari/drivers/opencode`: the OpenCode driver. It runs the user's own
// `opencode serve` (or talks to an OpenCode server someone else runs) and
// drives it through the OpenCode SDKs, which are optional peers loaded with a
// dynamic `import()` only when a server of their generation is used:
// `@opencode-ai/sdk` for OpenCode 1.x, `@opencode/client` for OpenCode 2.x.
// Importing this module starts nothing and loads no vendor package.
//
// Read it in this order:
// - config.ts: the instance config, the CLI manifest and the tested versions;
// - capabilities.ts: what it declares, per server generation and owner;
// - instance.ts and pool.ts: status, side-effect-free probes, which server
//   each thread runs on, and the MCP entries each thread holds there;
// - session.ts: threads, turns, requests, and OpenCode's events as ARI events;
// - rules.ts: runtime modes and thread isolation as OpenCode permission rules;
// - v1.ts and v2.ts: the two generations' APIs behind one `NativeRuntime`;
// - server.ts: version detection and `opencode serve`.

import type { Driver } from "../../runtime.ts";
import { ARI_VERSION } from "../../version.ts";
import { OPENCODE_CLI_MANIFEST, OPENCODE_CONFIG_SCHEMA, OPENCODE_DOCS_URL, OPENCODE_DRIVER_KIND, defaultOpencodeConfig } from "./config.ts";
import type { OpencodeConfig } from "./config.ts";
import { OPENCODE_ICON } from "./icon.ts";
import { OpencodeInstance } from "./instance.ts";
import type { OpencodeSdkLoaders } from "./sdk.ts";

export {
  OPENCODE_CLI_MANIFEST,
  OPENCODE_CONFIG_SCHEMA,
  OPENCODE_DRIVER_KIND,
  OPENCODE_PASSWORD_VARIABLES,
  OPENCODE_TESTED_VERSIONS,
  OPENCODE_V1_SDK_PACKAGE,
  OPENCODE_V1_TESTED_VERSIONS,
  OPENCODE_V2_SDK_PACKAGE,
  OPENCODE_V2_TESTED_VERSIONS,
  SERVER_PASSWORD_SECRET,
  defaultOpencodeConfig,
} from "./config.ts";
export type { OpencodeConfig } from "./config.ts";
export { IDENTITY_VERSION, PERMISSION_RULES_EXTENSION, opencodeCapabilities } from "./capabilities.ts";
export type { ServerShape } from "./capabilities.ts";
export { testedRangeFor, versionAdvisory } from "./instance.ts";
export { collidingName, grantCouldReachMcpResources, isolationRules, modeRules, sanitizeMcpName, sessionRules, shellPermission } from "./rules.ts";
export { generationOf, parseVersion, versionInRange } from "./server.ts";
export type { OpencodeSdkLoaders, V1Client, V1Sdk, V2Client, V2Sdk } from "./sdk.ts";
export type { NativeRule } from "./native.ts";

export interface OpencodeDriverOptions {
  /** Replaces how the driver loads each SDK. Tests use it to see a missing package reported. */
  readonly loadSdk?: OpencodeSdkLoaders;
}

/** Builds the OpenCode driver. `opencodeDriver` is the one with the default SDK loaders. */
export function createOpencodeDriver(options: OpencodeDriverOptions = {}): Driver<OpencodeConfig> {
  return {
    kind: OPENCODE_DRIVER_KIND,
    ariVersion: ARI_VERSION,
    metadata: { displayName: "OpenCode", icon: OPENCODE_ICON, docsUrl: OPENCODE_DOCS_URL, multipleInstances: true, hasDefaultInstance: true },
    configSchema: OPENCODE_CONFIG_SCHEMA,
    defaultConfig: defaultOpencodeConfig,
    cliManifest: OPENCODE_CLI_MANIFEST,
    async create(host, input) {
      return new OpencodeInstance(host, { ...defaultOpencodeConfig(), ...input.config }, input.instanceId, input.environment, options.loadSdk ?? {});
    },
  };
}

export const opencodeDriver: Driver<OpencodeConfig> = createOpencodeDriver();

export default opencodeDriver;
