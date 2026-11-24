// `ari/meta/codex`: what a host shows about the Codex driver before loading
// it: the label, the icon, the config JSON Schema with form hints, the default
// config and the Codex CLI versions the driver is tested against. Plain data;
// it imports no Node built-in and loads nothing.

import type { Icon, JsonSchema } from "../generated/common.ts";
import type { DriverMetadata } from "../generated/driver.ts";

/** The Codex driver's config. */
export interface CodexDriverConfig {
  /** The `codex` executable: a name looked up on PATH, or a path. */
  readonly binaryPath: string;
  /** Extra arguments for `codex app-server`, for example `["-c", "model_reasoning_summary=detailed"]`. */
  readonly extraArgs?: readonly string[];
  /** The model for new threads; the provider's default when unset. */
  readonly model?: string;
  /** The reasoning effort for new turns (`low`, `medium`, `high`, ...); the model's default when unset. */
  readonly reasoningEffort?: string;
}

export const CODEX_LABEL = "Codex";

/** The ARI driver kind. */
export const CODEX_DRIVER_KIND = "codex";

/** The npm package that installs the `codex` CLI, named in "not installed" errors. */
export const CODEX_INSTALL_HINT = "Install the Codex CLI: npm install -g @openai/codex";

/**
 * The Codex CLI versions this driver is tested against, as a semver range:
 * the release whose app-server protocol schema is vendored under
 * vendor-schemas/codex/ (tag rust-v0.172.0).
 */
export const CODEX_TESTED_VERSIONS = ">=0.172.0 <0.173.0";

export const CODEX_ICON: Icon = {
  type: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 10l3 2-3 2"/><path d="M13 15h3"/></svg>',
};

export const CODEX_METADATA: DriverMetadata = {
  displayName: CODEX_LABEL,
  icon: CODEX_ICON,
  docsUrl: "https://github.com/openai/codex",
  multipleInstances: true,
  hasDefaultInstance: true,
};

export const CODEX_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Codex driver config",
  type: "object",
  properties: {
    binaryPath: { type: "string", minLength: 1, description: "The codex executable: a name looked up on PATH, or a path." },
    extraArgs: { type: "array", items: { type: "string" }, description: "Extra arguments for `codex app-server`." },
    model: { type: "string", minLength: 1, description: "The model for new threads. The provider's default when unset." },
    reasoningEffort: { type: "string", minLength: 1, description: "The reasoning effort for new turns. The model's default when unset." },
  },
  required: ["binaryPath"],
};

/** How a host renders each config field in a settings form. */
export const CODEX_FORM_HINTS: { readonly [field: string]: { readonly label: string; readonly widget: "text" | "list"; readonly placeholder?: string; readonly advanced?: boolean } } = {
  binaryPath: { label: "Codex executable", widget: "text", placeholder: "codex" },
  model: { label: "Default model", widget: "text", placeholder: "Provider default" },
  reasoningEffort: { label: "Reasoning effort", widget: "text", placeholder: "Model default", advanced: true },
  extraArgs: { label: "Extra app-server arguments", widget: "list", advanced: true },
};

export function codexDefaultConfig(): CodexDriverConfig {
  return { binaryPath: "codex" };
}
