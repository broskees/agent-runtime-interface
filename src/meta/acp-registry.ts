// `ari/meta/acp-registry`: label, icon, config schema and form hints for the
// ACP Registry driver, which installs and runs agents listed in the ACP
// Registry (https://agentclientprotocol.com/get-started/registry).

import type { Icon, JsonSchema } from "../generated/common.ts";
import { ACP_BASE_CONFIG_PROPERTIES, ACP_BASE_DEFAULTS, ACP_BASE_FORM_HINTS } from "./acp.ts";
import type { AcpBaseConfig, DriverMeta } from "./acp.ts";

export interface AcpRegistryConfig extends AcpBaseConfig {
  /** The registry index (`registry.json`). */
  readonly registryUrl: string;
  /** The registry agent this instance runs; empty until one is chosen with `subProviders.set`. */
  readonly agentId: string;
  /** The installed version to run; empty for the newest one installed. */
  readonly agentVersion: string;
}

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/** A shelf of three boxes, drawn for this package. */
export const ACP_REGISTRY_ICON: Icon = {
  type: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><path d="M11.5 9.5v4M9.5 11.5h4"/></svg>',
};

export const ACP_REGISTRY_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ACP Registry agent",
  type: "object",
  properties: {
    registryUrl: { type: "string", minLength: 1, description: "The ACP Registry index." },
    agentId: { type: "string", description: "The registry agent to run; empty until one is chosen." },
    agentVersion: { type: "string", description: "The installed version to run; empty for the newest installed." },
    ...ACP_BASE_CONFIG_PROPERTIES,
  },
  required: ["registryUrl", "agentId", "agentVersion", "maxProtocolVersion", "forkAcrossDirectories", "configDependencies"],
  additionalProperties: false,
};

export const ACP_REGISTRY_DEFAULT_CONFIG: AcpRegistryConfig = { registryUrl: ACP_REGISTRY_URL, agentId: "", agentVersion: "", ...ACP_BASE_DEFAULTS };

export const meta: DriverMeta = {
  kind: "acp-registry",
  label: "ACP Registry",
  icon: ACP_REGISTRY_ICON,
  metadata: {
    displayName: "ACP Registry",
    icon: ACP_REGISTRY_ICON,
    docsUrl: "https://agentclientprotocol.com/get-started/registry",
    multipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: ACP_REGISTRY_CONFIG_SCHEMA,
  formHints: {
    registryUrl: { label: "Registry index", advanced: true },
    agentId: { label: "Agent", description: "Choose an agent from the registry list." },
    agentVersion: { label: "Version", advanced: true },
    ...ACP_BASE_FORM_HINTS,
  },
  testedVersions: { range: "1.x", what: "registry index format 1.0.0 (the index served on 2026-11-23, 46 agents); each agent's own version is whatever the index lists" },
};
