// `ari/drivers/codex`: the Codex driver. It runs the user's `codex` CLI as
// `codex app-server` through the host's process service and speaks the
// app-server JSON-RPC protocol over its stdio, with a client generated from
// the protocol's JSON Schema (vendored at Codex tag rust-v0.172.0).
//
// Importing this module loads no vendor code and spawns nothing: `create()`
// only reads which managed credential the instance holds. A missing `codex`
// binary shows in `status()` and fails `openSession` with
// `driver_unavailable`.

import type { CliLaunchManifest } from "../../generated/driver.ts";
import { CODEX_CONFIG_SCHEMA, CODEX_DRIVER_KIND, CODEX_METADATA, CODEX_TESTED_VERSIONS, codexDefaultConfig } from "../../meta/codex.ts";
import type { CodexDriverConfig } from "../../meta/codex.ts";
import type { Driver } from "../../runtime.ts";
import { ARI_VERSION } from "../../version.ts";
import { CODEX_CREDENTIAL_VARIABLES, CodexInstance, managedKindOf } from "./instance.ts";

export type { CodexDriverConfig } from "../../meta/codex.ts";
export { CODEX_CAPABILITIES } from "./capabilities.ts";
export { CODEX_EXTENSIONS, mcpServerConfig } from "./session.ts";
export {
  CODEX_API_KEY_SECRET,
  CODEX_AUTH_METHODS,
  CODEX_CREDENTIAL_VARIABLES,
  CODEX_POISON_MS,
  CODEX_SECRET_NAMESPACE,
  CODEX_TOKENS_SECRET,
  CODEX_TRANSFER_FORMAT,
  satisfiesVersionRange,
  versionAdvisory,
} from "./instance.ts";
export { CODEX_IDENTITY_VERSION, codexPolicy, decisionOptionId, itemIdFor, requestIdFor, subagentIdFor, taskIdFor, threadIdFor, turnIdFor } from "./mapping.ts";
export { CODEX_PROTOCOL_SOURCE } from "./generated/protocol.ts";
export { CODEX_TESTED_VERSIONS };

/**
 * How a host runs the Codex CLI itself in a terminal: `codex`, `codex resume
 * <id>`, `codex fork <id>`. Codex takes MCP servers only as `-c` config
 * overrides, not as the common `mcpServers` JSON, so the manifest offers no
 * MCP injection.
 */
export const CODEX_CLI_MANIFEST: CliLaunchManifest = {
  binary: "codex",
  envScrubPrefixes: [...CODEX_CREDENTIAL_VARIABLES],
  args: { fresh: [], resume: ["resume", "{sessionId}"], fork: ["fork", "{sessionId}"] },
};

export const codexDriver: Driver<CodexDriverConfig> = {
  kind: CODEX_DRIVER_KIND,
  ariVersion: ARI_VERSION,
  metadata: CODEX_METADATA,
  configSchema: CODEX_CONFIG_SCHEMA,
  defaultConfig: codexDefaultConfig,
  cliManifest: CODEX_CLI_MANIFEST,
  async create(host, input) {
    const managed = await managedKindOf(host as never);
    return new CodexInstance(host, input.config, input.instanceId, input.environment, managed);
  },
};
