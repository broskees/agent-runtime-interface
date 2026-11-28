// `ari/drivers/acp`: the ACP base driver. It runs any agent that speaks the
// Agent Client Protocol (v1 or v2) on stdio, with the command the user
// configures. The `grok`, `fx`, `kiro` and `antigravity` drivers are flavors
// of it, built with `createAcpDriver`. ARI installs no agent: the user
// installs the agent and names its command here.
//
// Importing this module starts nothing and loads no vendor package: the agent
// runs only when a session opens.

import { ACP_CONFIG_SCHEMA, ACP_DEFAULT_CONFIG, meta } from "../../meta/acp.ts";
import type { AcpDriverConfig } from "../../meta/acp.ts";
import type { Driver } from "../../runtime.ts";
import { createAcpDriver } from "./driver.ts";

export { createAcpDriver, canonicalDirectory, compareVersions, inTestedRange, parseVersion, rangeText } from "./driver.ts";
export type { AcpFlavor, AcpFlavorContext, AcpProbeTarget, TestedRange } from "./driver.ts";
export { AcpSession, agentModeId } from "./session.ts";
export type { AcpAgentMode, AcpHarnessMode, AcpSessionSettings } from "./session.ts";
export { ACP_ERRORS, AcpConnection } from "./connection.ts";
export type { AcpHandshake, AcpLaunch } from "./connection.ts";
export { ACP_EXTENSION, ACP_IDENTITY_VERSION, acpCapabilities } from "./capabilities.ts";
export { ACP_CONFIG_SCHEMA, ACP_DEFAULT_CONFIG } from "../../meta/acp.ts";
export type { AcpBaseConfig, AcpDriverConfig } from "../../meta/acp.ts";
export type * as AcpV1 from "./generated/v1.ts";
export type * as AcpV2 from "./generated/v2.ts";

/** The ACP base driver. Set `command` (and `args`) to the agent to run. */
export const acpDriver: Driver<AcpDriverConfig> = createAcpDriver<AcpDriverConfig>({
  kind: "acp",
  metadata: meta.metadata,
  configSchema: ACP_CONFIG_SCHEMA,
  defaultConfig: () => ({ ...ACP_DEFAULT_CONFIG, args: [...ACP_DEFAULT_CONFIG.args], env: { ...ACP_DEFAULT_CONFIG.env }, versionArgs: [...ACP_DEFAULT_CONFIG.versionArgs], configDependencies: {} }),
  launchIdentity: (config) => [config.command, ...config.args].join(" "),
  probeTarget: async ({ config }) =>
    config.command === "" ? { kind: "unset", message: "Set command to the ACP agent's executable" } : { kind: "command", command: config.command, versionArgs: config.versionArgs },
  launch: async ({ config }) => ({ command: config.command, args: [...config.args], env: { ...config.env } }),
});

export default acpDriver;
