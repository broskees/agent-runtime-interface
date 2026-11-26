// `ari/meta/kiro`: label, icon, config schema and form hints for the Kiro
// driver, which runs Kiro CLI's V3 agent harness (`kiro-cli acp`) over ACP.

import type { Icon, JsonSchema } from "../generated/common.ts";
import type { CliLaunchManifest } from "../generated/driver.ts";
import { ACP_BASE_CONFIG_PROPERTIES, ACP_BASE_DEFAULTS, ACP_BASE_FORM_HINTS } from "./acp.ts";
import type { AcpBaseConfig, DriverMeta } from "./acp.ts";

export interface KiroConfig extends AcpBaseConfig {
  /** The Kiro CLI executable. */
  readonly command: string;
}

/** A small ghost, drawn for this package. */
export const KIRO_ICON: Icon = {
  type: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M3.5 14V7a4.5 4.5 0 0 1 9 0v7l-1.5-1.2L9.5 14 8 12.8 6.5 14 5 12.8z"/><path d="M6.3 7.2h.01M9.7 7.2h.01"/></svg>',
};

export const KIRO_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Kiro",
  type: "object",
  properties: { command: { type: "string", minLength: 1, description: "The Kiro CLI executable." }, ...ACP_BASE_CONFIG_PROPERTIES },
  required: ["command", "maxProtocolVersion", "forkAcrossDirectories", "configDependencies"],
  additionalProperties: false,
};

export const KIRO_DEFAULT_CONFIG: KiroConfig = { command: "kiro-cli", ...ACP_BASE_DEFAULTS };

/**
 * Kiro CLI's own update step (https://kiro.dev/docs/reference/cli-commands/#kiro-cli-update),
 * named when `kiro-cli` is older than the tested range. ARI never installs or
 * updates `kiro-cli`.
 */
export const KIRO_UPDATE_STEP = "Update Kiro CLI with `kiro-cli update`.";

/** Kiro's interactive chat, for a host's terminal fallback. */
export const KIRO_CLI_MANIFEST: CliLaunchManifest = { binary: "kiro-cli", args: { fresh: ["chat"] } };

export const meta: DriverMeta = {
  kind: "kiro",
  label: "Kiro",
  icon: KIRO_ICON,
  metadata: { displayName: "Kiro", icon: KIRO_ICON, docsUrl: "https://kiro.dev/docs/cli/acp/", multipleInstances: true, hasDefaultInstance: true },
  configSchema: KIRO_CONFIG_SCHEMA,
  formHints: { command: { label: "Kiro CLI", placeholder: "kiro-cli", description: "Sign in once with `kiro-cli login`." }, ...ACP_BASE_FORM_HINTS },
  testedVersions: { range: ">=3.0.0 <4.0.0", what: "the V3 ACP harness of Kiro CLI 3.x (Kiro's ACP docs and ACP registry entry kiro 3.0.0)" },
};
