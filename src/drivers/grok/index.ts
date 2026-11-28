// `ari/drivers/grok`: xAI's Grok Build CLI as an ACP agent. Quirks it keeps:
// - it launches `grok --permission-mode default agent stdio`, so a supervised
//   thread never inherits an always-approve setting from the user's Grok
//   config; `full_access` is answered at the client boundary by the ACP driver;
// - its probe runs `grok --version` with `GROK_DISABLE_AUTOUPDATER=1`, so a
//   health check never starts the updater;
// - it runs the `grok` the user installed and never updates it; a `grok`
//   older than 1.0.70 is refused, naming `grok update`.

import { createAcpDriver } from "../acp/driver.ts";
import { GROK_CLI_MANIFEST, GROK_CONFIG_SCHEMA, GROK_DEFAULT_CONFIG, GROK_UPDATE_STEP, meta } from "../../meta/grok.ts";
import type { GrokConfig } from "../../meta/grok.ts";
import type { Driver } from "../../runtime.ts";

export type { GrokConfig } from "../../meta/grok.ts";
export { GROK_CLI_MANIFEST, GROK_CONFIG_SCHEMA, GROK_DEFAULT_CONFIG } from "../../meta/grok.ts";

/** The arguments that start Grok as an ACP agent on stdio, in its default (asking) permission mode. */
export const GROK_ACP_ARGS: readonly string[] = ["--permission-mode", "default", "agent", "stdio"];

export const grokDriver: Driver<GrokConfig> = createAcpDriver<GrokConfig>({
  kind: "grok",
  metadata: meta.metadata,
  configSchema: GROK_CONFIG_SCHEMA,
  defaultConfig: () => ({ ...GROK_DEFAULT_CONFIG, configDependencies: {} }),
  cliManifest: GROK_CLI_MANIFEST,
  testedRange: { min: "1.0.70", below: "1.1.0", updateStep: GROK_UPDATE_STEP },
  launchIdentity: (config) => config.command,
  probeTarget: async ({ config }) => ({ kind: "command", command: config.command, versionArgs: ["--version"], env: { GROK_DISABLE_AUTOUPDATER: "1" } }),
  launch: async ({ config }) => ({ command: config.command, args: [...GROK_ACP_ARGS], env: {} }),
});

export default grokDriver;
