// `ari/drivers/claude`: the Claude driver. It runs the user's own Claude Code
// (the configured `executablePath`, else `claude` on PATH, at least the
// version the pinned SDK bundles) through the Claude Agent SDK
// (`@anthropic-ai/claude-agent-sdk`, an optional peer), which it loads with a
// dynamic `import()` the first time an instance needs it. ARI never downloads
// or runs a Claude Code of its own. Importing this module loads no vendor code
// and spawns nothing, and `create()` does neither: a missing SDK, or a Claude
// Code that is missing or too old, shows in `status()` and fails
// `openSession` with `driver_unavailable`.
//
// The standalone `ari-driver`, which cannot import a package by name, has
// the SDK's JavaScript compiled in (scripts/build-binary.ts) and never a
// Claude Code. Under Node, ARI installs nothing: the user or the host
// installs the SDK and Claude Code.
//
// `createClaudeDriver({ loadSdk, newUuid })` builds the driver with another
// SDK loader (a build that bundles the SDK, as the standalone `ari-driver`
// does, or a test's fake) and another source of the UUIDs it gives Claude;
// `claudeDriver` uses the defaults.

import type { CliLaunchManifest } from "../../generated/driver.ts";
import { CLAUDE_CONFIG_SCHEMA, CLAUDE_DRIVER_KIND, CLAUDE_METADATA, CLAUDE_TESTED_VERSIONS, claudeDefaultConfig } from "../../meta/claude.ts";
import type { ClaudeDriverConfig } from "../../meta/claude.ts";
import type { Driver } from "../../runtime.ts";
import { ARI_VERSION } from "../../version.ts";
import { CLAUDE_API_KEY_SECRET, CLAUDE_SECRET_NAMESPACE, ClaudeInstance } from "./instance.ts";
import type { ClaudeDriverOptions } from "./instance.ts";
import { loadClaudeSdk } from "./sdk.ts";

export type { ClaudeDriverConfig } from "../../meta/claude.ts";
export type { ClaudeDriverOptions } from "./instance.ts";
export type { ClaudeSdk, ClaudeSdkLoader, ClaudeSdkRuntime } from "./sdk.ts";
export { CLAUDE_CAPABILITIES, CLAUDE_EXTENSIONS } from "./capabilities.ts";
export {
  CLAUDE_API_KEY_SECRET,
  CLAUDE_AUTH_METHODS,
  CLAUDE_POISON_MS,
  CLAUDE_SECRET_NAMESPACE,
  satisfiesVersionRange,
  versionAdvisory,
} from "./instance.ts";
export {
  CLAUDE_IDENTITY_VERSION,
  CLAUDE_OPTION_ALLOW,
  CLAUDE_OPTION_DENY,
  CLAUDE_OPTION_DENY_INTERRUPT,
  allowWithRulesOptionId,
  itemIdFor,
  permissionModeFor,
  requestIdFor,
  subagentIdFor,
  taskIdFor,
  threadIdFor,
  turnIdFor,
} from "./mapping.ts";
export { loadClaudeSdk } from "./sdk.ts";
export { CLAUDE_TESTED_VERSIONS };

/**
 * How a host runs Claude Code itself in a terminal: `claude`, `claude
 * --resume <id>`, `claude --resume <id> --fork-session`, with MCP servers as
 * `--mcp-config <json>`. The launch gets the environment the host gives it.
 */
export const CLAUDE_CLI_MANIFEST: CliLaunchManifest = {
  binary: "claude",
  args: { fresh: [], resume: ["--resume", "{sessionId}"], fork: ["--resume", "{sessionId}", "--fork-session"] },
  mcpInjection: { mode: "inline_json", flag: "--mcp-config" },
};

/** A Claude driver with another SDK loader or session id source. */
export function createClaudeDriver(options: ClaudeDriverOptions = {}): Driver<ClaudeDriverConfig> {
  const loadSdk = options.loadSdk ?? loadClaudeSdk;
  return {
    kind: CLAUDE_DRIVER_KIND,
    ariVersion: ARI_VERSION,
    metadata: CLAUDE_METADATA,
    configSchema: CLAUDE_CONFIG_SCHEMA,
    defaultConfig: claudeDefaultConfig,
    cliManifest: CLAUDE_CLI_MANIFEST,
    async create(host, input) {
      // Only reads whether the instance holds its own API key; the SDK loads on first use.
      const managed = (await host.secrets.get(CLAUDE_SECRET_NAMESPACE, CLAUDE_API_KEY_SECRET)) !== null;
      return new ClaudeInstance(host, input.config, input.instanceId, input.environment, managed, options, loadSdk);
    },
  };
}

export const claudeDriver: Driver<ClaudeDriverConfig> = createClaudeDriver();

export default claudeDriver;
