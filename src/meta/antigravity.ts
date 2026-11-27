// `ari/meta/antigravity`: label, icon, config schema and form hints for the
// Google Antigravity driver, which runs the Antigravity CLI (`agy acp`) the
// user installed over ACP. ARI never downloads, installs or updates `agy`.

import type { Icon, JsonSchema } from "../generated/common.ts";
import type { CliLaunchManifest } from "../generated/driver.ts";
import { ACP_BASE_CONFIG_PROPERTIES, ACP_BASE_DEFAULTS, ACP_BASE_FORM_HINTS } from "./acp.ts";
import type { AcpBaseConfig, DriverMeta } from "./acp.ts";

export interface AntigravityConfig extends AcpBaseConfig {
  /** The Antigravity CLI: a name found on PATH, or a path. */
  readonly command: string;
}

/**
 * How to install the Antigravity CLI, from Google's own README
 * (https://github.com/google-antigravity/antigravity-cli#installation).
 */
export const ANTIGRAVITY_INSTALL_STEP =
  "Install the Antigravity CLI yourself: `curl -fsSL https://antigravity.google/cli/install.sh | bash` on macOS and Linux, or `irm https://antigravity.google/cli/install.ps1 | iex` in Windows PowerShell.";

/**
 * The Antigravity CLI's own update step (https://antigravity.google/docs/cli/commands/changelog/:
 * "update your CLI binary to the latest version using `agy update`"), named
 * when `agy` is older than the tested range.
 */
export const ANTIGRAVITY_UPDATE_STEP = "Update the Antigravity CLI with `agy update`.";

/**
 * Ambient Google credentials and Antigravity settings that must never reach
 * the agent: each instance signs in through its own profile directory. A host
 * strips them with `process.envPolicy.stripAmbient`; the CLI manifest's
 * `envScrubPrefixes` cover them all, and the driver refuses to start a session
 * when the host's policy leaves one of them in.
 */
export const ANTIGRAVITY_STRIPPED_VARIABLES: readonly string[] = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
];

/** An orbit around a point, drawn for this package. */
export const ANTIGRAVITY_ICON: Icon = {
  type: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="8" cy="8" rx="6.5" ry="3" transform="rotate(-30 8 8)"/><circle cx="8" cy="8" r="1.4"/></svg>',
};

export const ANTIGRAVITY_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Google Antigravity",
  type: "object",
  properties: {
    command: { type: "string", minLength: 1, description: "The Antigravity CLI: a name found on PATH, or a path." },
    ...ACP_BASE_CONFIG_PROPERTIES,
  },
  required: ["command", "maxProtocolVersion", "forkAcrossDirectories", "configDependencies"],
  additionalProperties: false,
};

export const ANTIGRAVITY_DEFAULT_CONFIG: AntigravityConfig = { command: "agy", ...ACP_BASE_DEFAULTS };

/** The interactive Antigravity CLI, for a host's terminal fallback, with ambient Google credentials scrubbed. */
export const ANTIGRAVITY_CLI_MANIFEST: CliLaunchManifest = {
  binary: "agy",
  envScrubPrefixes: ["GEMINI_", "GOOGLE_", "GCLOUD_", "CLOUDSDK_", "AGY_"],
  args: { fresh: [] },
};

export const meta: DriverMeta = {
  kind: "antigravity",
  label: "Google Antigravity",
  icon: ANTIGRAVITY_ICON,
  metadata: {
    displayName: "Google Antigravity",
    icon: ANTIGRAVITY_ICON,
    docsUrl: "https://antigravity.google/docs/ide/extensions",
    multipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: ANTIGRAVITY_CONFIG_SCHEMA,
  formHints: {
    command: { label: "Antigravity CLI", placeholder: "agy", description: "Your own Antigravity CLI. Update it with `agy update`." },
    ...ACP_BASE_FORM_HINTS,
  },
  testedVersions: { range: ">=1.5.0 <1.6.0", what: "the ACP launch of the Antigravity CLI 1.5 series (`agy acp`; ACP registry entry antigravity-acp 1.5.2)" },
};
