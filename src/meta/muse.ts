// `ari/meta/muse`: what a host shows about the Muse driver before loading it:
// the label, the icon, the config JSON Schema with form hints, the default
// config, and the Muse Code versions the driver is tested against. Plain data;
// it imports no Node built-in and loads nothing.

import type { Icon, JsonSchema } from "../generated/common.ts";
import type { DriverMetadata } from "../generated/driver.ts";

/** The Muse driver's config. */
export interface MuseDriverConfig {
  /** The `muse` executable: a name looked up on PATH, or a path. */
  readonly binaryPath: string;
  /** Extra arguments for `muse serve`, placed after `serve`. */
  readonly extraArgs?: readonly string[];
  /** The model for new threads (`session/start` `modelId`); Muse's default when unset. */
  readonly model?: string;
  /** The provider routing for new threads (`session/start` `providerId`); Muse's default when unset. */
  readonly providerId?: string;
  /** The reasoning effort for new turns (`none` ... `ultra`); the model's default when unset. */
  readonly reasoningEffort?: string;
}

export const MUSE_LABEL = "Muse Code";

/** The ARI driver kind. */
export const MUSE_DRIVER_KIND = "muse";

/** The optional peer package the driver loads with a dynamic `import()`. */
export const MUSE_SDK_PACKAGE = "@muse-code/sdk";

/**
 * The oldest `muse` CLI the driver runs: the lower bound of
 * `MUSE_TESTED_VERSIONS`. An older `muse` is refused with `driver_unavailable`
 * naming `MUSE_CLI_UPDATE_STEP`; ARI never installs or updates `muse`. (An SDK
 * outside the range still gets only an advisory.)
 */
export const MUSE_MINIMUM_VERSION = "1.4.25";

/**
 * The Muse Code versions this driver is tested against, as a semver range. The
 * SDK versions in lockstep with Muse Code (`@muse-code/sdk` X.Y.Z pairs with
 * Muse Code X.Y.Z, says the SDK's README), so the range covers both the SDK
 * package and the `muse` CLI.
 */
export const MUSE_TESTED_VERSIONS = `>=${MUSE_MINIMUM_VERSION} <1.4.26`;

/**
 * Muse Code's own update step: its changelog sends upgrades to the overview's
 * installer (https://dev.meta.ai/docs/muse-code/changelog: "For install and
 * upgrade steps, see the Muse Code overview"; https://dev.meta.ai/docs/muse-code#install).
 */
export const MUSE_CLI_UPDATE_STEP = "Update Muse Code by running its installer again: `curl -fsSL https://dev.meta.ai/install.sh | bash`.";

/** Named in "not installed" errors for the SDK package. */
export const MUSE_SDK_INSTALL_HINT = "Install the Muse SDK beside ari: npm install @muse-code/sdk@1.4.25";

/** Named in "not installed" errors for the CLI. */
export const MUSE_CLI_INSTALL_HINT = "Install Muse Code (https://dev.meta.ai/docs/muse-code) and run `muse login`";

export const MUSE_ICON: Icon = {
  type: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V6l8 7 8-7v13"/><circle cx="12" cy="4" r="1.2"/></svg>',
};

export const MUSE_METADATA: DriverMetadata = {
  displayName: MUSE_LABEL,
  icon: MUSE_ICON,
  docsUrl: "https://meta-models.github.io/muse-code-sdk/",
  multipleInstances: true,
  hasDefaultInstance: true,
};

export const MUSE_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Muse driver config",
  type: "object",
  properties: {
    binaryPath: { type: "string", minLength: 1, description: "The muse executable: a name looked up on PATH, or a path." },
    extraArgs: { type: "array", items: { type: "string" }, description: "Extra arguments for `muse serve`." },
    model: { type: "string", minLength: 1, description: "The model for new threads. Muse's default when unset." },
    providerId: { type: "string", minLength: 1, description: "The provider routing for new threads. Muse's default when unset." },
    reasoningEffort: {
      type: "string",
      enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
      description: "The reasoning effort for new turns. The model's default when unset.",
    },
  },
  required: ["binaryPath"],
};

/** How a host renders each config field in a settings form. */
export const MUSE_FORM_HINTS: {
  readonly [field: string]: { readonly label: string; readonly widget: "text" | "list" | "select"; readonly placeholder?: string; readonly advanced?: boolean };
} = {
  binaryPath: { label: "Muse executable", widget: "text", placeholder: "muse" },
  model: { label: "Default model", widget: "text", placeholder: "Muse default" },
  providerId: { label: "Provider", widget: "text", placeholder: "Muse default", advanced: true },
  reasoningEffort: { label: "Reasoning effort", widget: "select", placeholder: "Model default", advanced: true },
  extraArgs: { label: "Extra `muse serve` arguments", widget: "list", advanced: true },
};

export function museDefaultConfig(): MuseDriverConfig {
  return { binaryPath: "muse" };
}
