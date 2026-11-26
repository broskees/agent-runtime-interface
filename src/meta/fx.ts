// `ari/meta/fx`: label, icon, config schema and form hints for the fx driver,
// which runs the multi-provider fx agent (`fx acp`) over ACP.

import type { Icon, JsonSchema } from "../generated/common.ts";
import type { CliLaunchManifest } from "../generated/driver.ts";
import { ACP_BASE_CONFIG_PROPERTIES, ACP_BASE_DEFAULTS, ACP_BASE_FORM_HINTS } from "./acp.ts";
import type { AcpBaseConfig, DriverMeta } from "./acp.ts";

export interface FxConfig extends AcpBaseConfig {
  /** The fx executable. Every fx instance on a machine shares its fx login. */
  readonly command: string;
}

/** Two linked nodes, drawn for this package. */
export const FX_ICON: Icon = {
  type: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="4" cy="8" r="2.2"/><circle cx="12" cy="8" r="2.2"/><path d="M6.2 8h3.6"/></svg>',
};

/** fx offers a provider select and a model select whose values depend on the provider. ACP cannot say so, so the driver does. */
export const FX_CONFIG_DEPENDENCIES: { readonly [optionId: string]: readonly string[] } = { model: ["provider"] };

export const FX_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "fx",
  type: "object",
  properties: { command: { type: "string", minLength: 1, description: "The fx executable." }, ...ACP_BASE_CONFIG_PROPERTIES },
  required: ["command", "maxProtocolVersion", "forkAcrossDirectories", "configDependencies"],
  additionalProperties: false,
};

export const FX_DEFAULT_CONFIG: FxConfig = { command: "fx", ...ACP_BASE_DEFAULTS, configDependencies: FX_CONFIG_DEPENDENCIES };

/**
 * fx's own update step (https://github.com/vercel-labs/fx#install: "`fx
 * upgrade` installs the latest release right away"), named when `fx` is older
 * than the tested range. ARI never installs or updates `fx`.
 */
export const FX_UPDATE_STEP = "Update fx with `fx upgrade`.";

export const FX_CLI_MANIFEST: CliLaunchManifest = { binary: "fx", args: { fresh: [] } };

export const meta: DriverMeta = {
  kind: "fx",
  label: "fx",
  icon: FX_ICON,
  metadata: { displayName: "fx", icon: FX_ICON, multipleInstances: true, hasDefaultInstance: false },
  configSchema: FX_CONFIG_SCHEMA,
  formHints: { command: { label: "fx executable", placeholder: "fx", description: "All fx instances on this machine share its fx login." }, ...ACP_BASE_FORM_HINTS },
  testedVersions: {
    range: ">=0.0.13 <0.0.18",
    what: "fx 0.0.13 to 0.0.17: the releases whose ACP launch (`fx acp`) and provider, model, mode and effort options the fake reproduces, from a public fx client that names fx 0.0.13 and 0.0.14 and postdates 0.0.17; no fx binary ran (docs/drivers/fx.md)",
  },
};
