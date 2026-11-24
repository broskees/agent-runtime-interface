// `ari/meta/antigravity`: label, icon, config schema and form hints for the
// Google Antigravity driver, which runs the Antigravity CLI (`agy acp`) over
// ACP, either the user's own install or one this driver manages.

import type { Icon, JsonSchema } from "../generated/common.ts";
import type { CliLaunchManifest } from "../generated/driver.ts";
import { ACP_BASE_CONFIG_PROPERTIES, ACP_BASE_DEFAULTS, ACP_BASE_FORM_HINTS } from "./acp.ts";
import type { AcpBaseConfig, DriverMeta } from "./acp.ts";

export interface AntigravityConfig extends AcpBaseConfig {
  /** `path`: run `command` from PATH. `managed`: run the version this driver installed with `maintenance.install()`. */
  readonly installation: "path" | "managed";
  /** The Antigravity CLI when `installation` is `path`. */
  readonly command: string;
  /** Managed installs: where the CLI's release manifests are, one `<target>.json` per platform. */
  readonly releaseManifestUrl: string;
  /** Managed installs: `latest`, or a pinned version. */
  readonly version: string;
}

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

export const ANTIGRAVITY_RELEASE_MANIFESTS = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

export const ANTIGRAVITY_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Google Antigravity",
  type: "object",
  properties: {
    installation: { enum: ["path", "managed"], description: "path: the CLI on PATH. managed: a version this driver installs." },
    command: { type: "string", minLength: 1, description: "The Antigravity CLI when installation is path." },
    releaseManifestUrl: { type: "string", minLength: 1, description: "Where managed installs read release manifests." },
    version: { type: "string", minLength: 1, description: "Managed installs: latest, or a pinned version." },
    ...ACP_BASE_CONFIG_PROPERTIES,
  },
  required: ["installation", "command", "releaseManifestUrl", "version", "maxProtocolVersion", "forkAcrossDirectories", "configDependencies"],
  additionalProperties: false,
};

export const ANTIGRAVITY_DEFAULT_CONFIG: AntigravityConfig = {
  installation: "path",
  command: "agy",
  releaseManifestUrl: ANTIGRAVITY_RELEASE_MANIFESTS,
  version: "latest",
  ...ACP_BASE_DEFAULTS,
};

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
    installation: { label: "Installation", description: "Use your own Antigravity CLI, or let this app install and update one." },
    command: { label: "Antigravity CLI", placeholder: "agy" },
    releaseManifestUrl: { label: "Release manifests", advanced: true },
    version: { label: "Version", placeholder: "latest", advanced: true },
    ...ACP_BASE_FORM_HINTS,
  },
  testedVersions: { range: ">=1.5.0 <1.6.0", what: "the ACP launch of the Antigravity CLI 1.5 series (`agy acp`; ACP registry entry antigravity-acp 1.5.2)" },
};
