// `ari/meta/opencode`: what a host needs to show and configure the OpenCode
// driver without loading it. Browser-safe: it imports no Node built-in, loads
// no vendor package and spawns nothing.

import type { DriverMetadata } from "../generated/driver.ts";
import {
  OPENCODE_CONFIG_SCHEMA,
  OPENCODE_DOCS_URL,
  OPENCODE_DRIVER_KIND,
  OPENCODE_TESTED_VERSIONS,
  OPENCODE_V1_SDK_PACKAGE,
  OPENCODE_V1_TESTED_VERSIONS,
  OPENCODE_V2_SDK_PACKAGE,
  OPENCODE_V2_TESTED_VERSIONS,
  SERVER_PASSWORD_SECRET,
  defaultOpencodeConfig,
} from "../drivers/opencode/config.ts";
import type { OpencodeConfig } from "../drivers/opencode/config.ts";
import { OPENCODE_ICON } from "../drivers/opencode/icon.ts";

export type { OpencodeConfig } from "../drivers/opencode/config.ts";

/** How a settings form shows one config field. */
export interface ConfigFieldHint {
  readonly label: string;
  readonly help?: string;
  readonly placeholder?: string;
  readonly widget: "text" | "select" | "path" | "url";
  /** Shown only when the user asks for advanced settings. */
  readonly advanced?: boolean;
}

export const kind = OPENCODE_DRIVER_KIND;
export const label = "OpenCode";
export const description = "Runs your own OpenCode (opencode.ai) server, 1.x or 2.x, or connects to one you run.";
export const icon = OPENCODE_ICON;
export const docsUrl = OPENCODE_DOCS_URL;
export const testedVersions = OPENCODE_TESTED_VERSIONS;
export const testedVersionsByGeneration = { "1.x": OPENCODE_V1_TESTED_VERSIONS, "2.x": OPENCODE_V2_TESTED_VERSIONS } as const;
/** The optional peer each server generation needs. */
export const sdkPackages = { "1.x": OPENCODE_V1_SDK_PACKAGE, "2.x": OPENCODE_V2_SDK_PACKAGE } as const;
/** Where an external server's password is kept: the instance's secrets, never its config. */
export const serverPasswordSecret = SERVER_PASSWORD_SECRET;
export const configSchema = OPENCODE_CONFIG_SCHEMA;
export const defaultConfig: () => OpencodeConfig = defaultOpencodeConfig;

export const metadata: DriverMetadata = { displayName: label, icon, docsUrl, multipleInstances: true, hasDefaultInstance: true };

/** Form hints for each field of `configSchema`, in display order. */
export const formHints: { readonly [field in keyof OpencodeConfig]-?: ConfigFieldHint } = {
  binary: { label: "opencode executable", help: "A name looked up on PATH, or the full path to opencode.", placeholder: "opencode", widget: "path" },
  serverUrl: { label: "Server URL", help: "Leave empty to let the driver start OpenCode's server. A server you run yourself is never stopped by the driver; store its password as the secret opencode/server-password.", placeholder: "http://127.0.0.1:4096", widget: "url", advanced: true },
  model: { label: "Model", help: "The model new threads start with, as provider/model. Leave empty for OpenCode's default.", placeholder: "anthropic/claude-sonnet-4-5", widget: "text" },
  agent: { label: "Agent", help: "The OpenCode agent new threads use. Leave empty for OpenCode's default.", placeholder: "build", widget: "text", advanced: true },
};
