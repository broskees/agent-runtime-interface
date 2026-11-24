// `ari/meta/cursor`: what a host needs to show and configure the Cursor
// driver without loading it. Browser-safe: it imports no Node built-in, loads
// no vendor package and spawns nothing.

import type { DriverMetadata } from "../generated/driver.ts";
import {
  CURSOR_CONFIG_SCHEMA,
  CURSOR_DOCS_URL,
  CURSOR_DRIVER_KIND,
  CURSOR_INSTALL_HINT,
  CURSOR_SDK_PACKAGE,
  CURSOR_SETTING_SOURCES,
  CURSOR_TESTED_VERSIONS,
  defaultCursorConfig,
} from "../drivers/cursor/config.ts";
import type { CursorConfig } from "../drivers/cursor/config.ts";
import { CURSOR_ICON } from "../drivers/cursor/icon.ts";

export type { CursorConfig, CursorSettingSource } from "../drivers/cursor/config.ts";

/** How a settings form shows one config field. */
export interface ConfigFieldHint {
  readonly label: string;
  readonly help?: string;
  readonly placeholder?: string;
  readonly widget: "text" | "select" | "multiselect" | "path";
  /** Shown only when the user asks for advanced settings. */
  readonly advanced?: boolean;
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

export const kind = CURSOR_DRIVER_KIND;
export const label = "Cursor";
export const description = "Runs Cursor's agent through the Cursor TypeScript SDK (@cursor/sdk), inside the host's Node process.";
export const icon = CURSOR_ICON;
export const docsUrl = CURSOR_DOCS_URL;
/** The optional peer the driver loads when an instance first needs it. */
export const sdkPackage = CURSOR_SDK_PACKAGE;
export const installHint = CURSOR_INSTALL_HINT;
export const testedVersions = CURSOR_TESTED_VERSIONS;
export const configSchema = CURSOR_CONFIG_SCHEMA;
export const defaultConfig: () => CursorConfig = defaultCursorConfig;

export const metadata: DriverMetadata = { displayName: label, icon, docsUrl, multipleInstances: true, hasDefaultInstance: true };

const SETTING_SOURCE_LABELS: { readonly [source: string]: string } = {
  project: "Project (.cursor/, rules, AGENTS.md)",
  user: "User (~/.cursor/)",
  team: "Team settings",
  mdm: "Managed (MDM) settings",
  plugins: "Plugins",
  all: "All of them",
};

/** Form hints for each field of `configSchema`, in display order. */
export const formHints: { readonly [field in keyof CursorConfig]-?: ConfigFieldHint } = {
  model: { label: "Model", help: "The Cursor model id new threads start with. The instance's model list shows the ids your account may use.", placeholder: "composer-2.5", widget: "text" },
  settingSources: {
    label: "Cursor settings to load",
    help: "On-disk Cursor settings the agent reads. Leave empty so only what the host passes reaches the agent.",
    widget: "multiselect",
    advanced: true,
    options: CURSOR_SETTING_SOURCES.map((source) => ({ value: source, label: SETTING_SOURCE_LABELS[source] ?? source })),
  },
};
