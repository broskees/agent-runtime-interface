// `ari/drivers/fx`: the multi-provider fx agent over ACP (`fx acp`). Quirk it
// keeps: fx offers a `provider` select and a `model` select whose values
// change with the provider. ACP config options cannot state that, so the
// driver marks the model option `dependsOn: ["provider"]`, on every option
// list the agent sends.

import { createAcpDriver } from "../acp/driver.ts";
import { FX_CLI_MANIFEST, FX_CONFIG_DEPENDENCIES, FX_CONFIG_SCHEMA, FX_DEFAULT_CONFIG, meta } from "../../meta/fx.ts";
import type { FxConfig } from "../../meta/fx.ts";
import type { Driver } from "../../runtime.ts";

export type { FxConfig } from "../../meta/fx.ts";
export { FX_CLI_MANIFEST, FX_CONFIG_DEPENDENCIES, FX_CONFIG_SCHEMA, FX_DEFAULT_CONFIG } from "../../meta/fx.ts";

export const fxDriver: Driver<FxConfig> = createAcpDriver<FxConfig>({
  kind: "fx",
  metadata: meta.metadata,
  configSchema: FX_CONFIG_SCHEMA,
  defaultConfig: () => ({ ...FX_DEFAULT_CONFIG, configDependencies: { ...FX_CONFIG_DEPENDENCIES } }),
  cliManifest: FX_CLI_MANIFEST,
  launchIdentity: (config) => config.command,
  probeTarget: async ({ config }) => ({ kind: "command", command: config.command, versionArgs: ["--version"] }),
  launch: async ({ config }) => ({ command: config.command, args: ["acp"], env: {} }),
});

export default fxDriver;
