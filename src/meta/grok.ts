// `ari/meta/grok`: label, icon, config schema and form hints for the Grok
// driver, which runs xAI's Grok Build CLI (`grok agent stdio`) over ACP.

import type { Icon, JsonSchema } from "../generated/common.ts";
import type { CliLaunchManifest } from "../generated/driver.ts";
import { ACP_BASE_CONFIG_PROPERTIES, ACP_BASE_DEFAULTS, ACP_BASE_FORM_HINTS } from "./acp.ts";
import type { AcpBaseConfig, DriverMeta } from "./acp.ts";

export interface GrokConfig extends AcpBaseConfig {
  /** The Grok CLI executable, found on PATH unless it is a path. */
  readonly command: string;
}

/** A spark on a dark tile, drawn for this package. */
export const GROK_ICON: Icon = {
  type: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M8 2v4M8 10v4M2 8h4M10 8h4M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2"/></svg>',
};

export const GROK_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Grok",
  type: "object",
  properties: { command: { type: "string", minLength: 1, description: "The Grok CLI executable." }, ...ACP_BASE_CONFIG_PROPERTIES },
  required: ["command", "maxProtocolVersion", "forkAcrossDirectories", "configDependencies"],
  additionalProperties: false,
};

export const GROK_DEFAULT_CONFIG: GrokConfig = { command: "grok", ...ACP_BASE_DEFAULTS };

/**
 * The Grok CLI's own update step (https://docs.x.ai/build/overview#update),
 * named when `grok` is older than the tested range. ARI never installs or
 * updates `grok`.
 */
export const GROK_UPDATE_STEP = "Update the Grok CLI with `grok update`.";

/** The interactive Grok CLI, for a host's terminal fallback. */
export const GROK_CLI_MANIFEST: CliLaunchManifest = {
  binary: "grok",
  args: { fresh: [], resume: ["--resume", "{sessionId}"], fork: ["--resume", "{sessionId}", "--fork-session"] },
};

export const meta: DriverMeta = {
  kind: "grok",
  label: "Grok",
  icon: GROK_ICON,
  metadata: { displayName: "Grok", icon: GROK_ICON, docsUrl: "https://x.ai/cli", multipleInstances: true, hasDefaultInstance: true },
  configSchema: GROK_CONFIG_SCHEMA,
  formHints: { command: { label: "Grok CLI", placeholder: "grok", description: "Sign in once with `grok login`." }, ...ACP_BASE_FORM_HINTS },
  testedVersions: { range: ">=1.0.70 <1.1.0", what: "the launch and ACP behaviour of Grok Build CLI 1.0.70 (the CLI's --help) and 1.0.93 (ACP registry entry grok-build)" },
};
