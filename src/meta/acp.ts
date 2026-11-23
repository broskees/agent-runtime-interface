// `ari/meta/acp`: what a host shows about the ACP base driver before loading
// it (label, icon, config schema and form hints). It imports nothing at run
// time, so a settings page in a browser can use it.
//
// The ACP base driver runs any agent that speaks the Agent Client Protocol
// (https://agentclientprotocol.com) on stdio: the user names the executable
// and its arguments. The flavor drivers (`grok`, `fx`, `kiro`,
// `acp-registry`, `antigravity`) build on the same driver with a fixed launch
// command; their metadata imports the shared pieces from this module.

import type { Icon, JsonSchema } from "../generated/common.ts";
import type { DriverMetadata } from "../generated/driver.ts";

/** How a settings form should show one config field. */
export interface FormHint {
  readonly label: string;
  readonly description?: string;
  readonly placeholder?: string;
  /** Hidden fields keep their default and are only changed by advanced users. */
  readonly advanced?: boolean;
}

/** The metadata module of one driver. */
export interface DriverMeta {
  readonly kind: string;
  readonly label: string;
  readonly icon: Icon;
  readonly metadata: DriverMetadata;
  readonly configSchema: JsonSchema;
  readonly formHints: { readonly [field: string]: FormHint };
  /** The vendor versions the driver is tested against, as a semver range, and what was tested. */
  readonly testedVersions: { readonly range: string; readonly what: string };
}

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** The config every ACP-based driver shares. Flavors add their own fields. */
export interface AcpBaseConfig {
  /** The newest ACP protocol version to request in `initialize`. The agent may answer with an older one. */
  readonly maxProtocolVersion: 1 | 2;
  /** Whether `forkThread` may move a fork into another directory. Many agents reject a different `cwd` on `session/fork`. */
  readonly forkAcrossDirectories: boolean;
  /** Config option dependencies the agent does not state itself: option id to the ids it depends on. */
  readonly configDependencies: { readonly [optionId: string]: readonly string[] };
}

/** The ACP base driver's config. */
export interface AcpDriverConfig extends AcpBaseConfig {
  /** The agent executable, found on PATH unless it is a path. Empty until the user sets it. */
  readonly command: string;
  readonly args: readonly string[];
  /** Extra environment variables for the agent process. Never put credentials here: they are not secrets. */
  readonly env: { readonly [name: string]: string };
  /** Arguments that make the executable print its version, for `probe()`. */
  readonly versionArgs: readonly string[];
}

/** JSON Schema properties of `AcpBaseConfig`, for flavors to reuse. */
export const ACP_BASE_CONFIG_PROPERTIES: { readonly [field: string]: JsonSchema } = {
  maxProtocolVersion: { enum: [1, 2], description: "The newest ACP protocol version to request. The agent may answer with version 1." },
  forkAcrossDirectories: { type: "boolean", description: "Whether forks may move into another directory." },
  configDependencies: {
    type: "object",
    description: "Config option dependencies the agent does not state: option id to the option ids it depends on.",
    additionalProperties: { type: "array", items: { type: "string" } },
  },
};

export const ACP_BASE_FORM_HINTS: { readonly [field: string]: FormHint } = {
  maxProtocolVersion: { label: "Newest ACP version", description: "ACP v2 is in Preview; choose 2 to ask the agent for it.", advanced: true },
  forkAcrossDirectories: { label: "Forks may change directory", advanced: true },
  configDependencies: { label: "Config option dependencies", advanced: true },
};

/**
 * The defaults: request ACP v1. ACP v2 is in Preview, and ACP's migration
 * guide suggests clients keep requesting it opt-in; set `maxProtocolVersion`
 * to 2 to ask for it (a v1 agent still answers with v1).
 */
export const ACP_BASE_DEFAULTS: AcpBaseConfig = { maxProtocolVersion: 1, forkAcrossDirectories: false, configDependencies: {} };

/** A plug in a socket, drawn for this package, monochrome so it follows the theme. */
export const ACP_ICON: Icon = {
  type: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M5 2v3M11 2v3M3.5 5h9v2.5a4.5 4.5 0 0 1-9 0z"/><path d="M8 12v2.5"/></svg>',
};

export const ACP_CONFIG_SCHEMA: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "ACP agent",
  type: "object",
  properties: {
    command: { type: "string", description: "The agent executable, found on PATH unless it is a path." },
    args: { type: "array", items: { type: "string" }, description: "Arguments that start the agent in ACP mode on stdio." },
    env: { type: "object", additionalProperties: { type: "string" }, description: "Extra environment variables for the agent. Not for credentials." },
    versionArgs: { type: "array", items: { type: "string" }, description: "Arguments that make the executable print its version." },
    ...ACP_BASE_CONFIG_PROPERTIES,
  },
  required: ["command", "args", "env", "versionArgs", "maxProtocolVersion", "forkAcrossDirectories", "configDependencies"],
  additionalProperties: false,
};

export const ACP_DEFAULT_CONFIG: AcpDriverConfig = { command: "", args: [], env: {}, versionArgs: ["--version"], ...ACP_BASE_DEFAULTS };

export const meta: DriverMeta = {
  kind: "acp",
  label: "ACP agent",
  icon: ACP_ICON,
  metadata: {
    displayName: "ACP agent",
    icon: ACP_ICON,
    docsUrl: "https://agentclientprotocol.com/protocol/overview",
    multipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: ACP_CONFIG_SCHEMA,
  formHints: {
    command: { label: "Agent executable", placeholder: "my-acp-agent", description: "The program that speaks ACP on stdio." },
    args: { label: "Arguments", placeholder: "acp", description: "Arguments that start the agent in ACP mode." },
    env: { label: "Environment", advanced: true },
    versionArgs: { label: "Version arguments", advanced: true },
    ...ACP_BASE_FORM_HINTS,
  },
  testedVersions: {
    range: "1 - 2",
    what: "ACP protocol versions 1 and 2, schema release schema-v2.0.0-beta.3 (@agentclientprotocol/sdk 2.9.1)",
  },
};
