// `ari/meta/pi`: what a host needs to show and configure the Pi driver
// without loading it. Browser-safe: it imports no Node built-in, loads no
// vendor package and spawns nothing.

import type { DriverMetadata } from "../generated/driver.ts";
import { PI_CONFIG_SCHEMA, PI_DOCS_URL, PI_DRIVER_KIND, PI_TESTED_VERSIONS, PI_THINKING_LEVELS, defaultPiConfig } from "../drivers/pi/config.ts";
import type { PiConfig } from "../drivers/pi/config.ts";
import { PI_ICON } from "../drivers/pi/icon.ts";

export type { PiConfig } from "../drivers/pi/config.ts";

/** How a settings form shows one config field. */
export interface ConfigFieldHint {
  readonly label: string;
  readonly help?: string;
  readonly placeholder?: string;
  readonly widget: "text" | "select" | "path";
  /** Shown only when the user asks for advanced settings. */
  readonly advanced?: boolean;
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

export const kind = PI_DRIVER_KIND;
export const label = "Pi";
export const description = "Runs your own pi coding agent (pi.dev) in RPC mode.";
export const icon = PI_ICON;
export const docsUrl = PI_DOCS_URL;
export const testedVersions = PI_TESTED_VERSIONS;
export const configSchema = PI_CONFIG_SCHEMA;
export const defaultConfig: () => PiConfig = defaultPiConfig;

export const metadata: DriverMetadata = { displayName: label, icon, docsUrl, multipleInstances: true, hasDefaultInstance: true };

/** Form hints for each field of `configSchema`, in display order. */
export const formHints: { readonly [field in keyof PiConfig]-?: ConfigFieldHint } = {
  binary: { label: "pi executable", help: "A name looked up on PATH, or the full path to pi.", placeholder: "pi", widget: "path" },
  provider: { label: "Provider", help: "Whose sign-in `pi auth check` reports, for example anthropic. Leave empty to let pi choose.", placeholder: "anthropic", widget: "text" },
  model: { label: "Model", help: "The model new threads start with, as provider/id. Leave empty for pi's default.", placeholder: "anthropic/claude-sonnet-4-5", widget: "text" },
  thinking: { label: "Thinking level", widget: "select", advanced: true, options: PI_THINKING_LEVELS.map((level) => ({ value: level, label: level })) },
};
