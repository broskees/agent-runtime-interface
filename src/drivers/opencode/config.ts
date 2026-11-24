// The OpenCode driver's config, CLI manifest and tested versions. `ari/meta/opencode`
// reads this file too, so it imports nothing from Node, loads no SDK and spawns nothing.

import type { JsonSchema } from "../../generated/common.ts";
import type { CliLaunchManifest } from "../../generated/driver.ts";

/** The instance config of the OpenCode driver. */
export interface OpencodeConfig {
  /** The `opencode` executable: a name looked up on PATH, or a path. Used when no `serverUrl` is set. */
  readonly binary: string;
  /**
   * An OpenCode server someone else runs (`http://host:port`). When set, the
   * driver never starts or stops a server: the server stays externally owned.
   * Its password, if it has one, is the instance secret `opencode/server-password`.
   */
  readonly serverUrl?: string;
  /** The model new threads start with, as `provider/model`. OpenCode's default when left out. */
  readonly model?: string;
  /** The OpenCode agent new threads use (for example `build`). OpenCode's default when left out. */
  readonly agent?: string;
}

export const OPENCODE_DRIVER_KIND = "opencode";

export const OPENCODE_DOCS_URL = "https://opencode.ai/docs/server/";

/** The OpenCode 1.x servers this driver is tested against: the API of OpenCode 1.19.6 (`@opencode-ai/sdk` 1.19.6). */
export const OPENCODE_V1_TESTED_VERSIONS = ">=1.19.6 <2.0.0";

/** The OpenCode 2.x servers this driver is tested against: the API of OpenCode 2.1.2 (`@opencode/client` 2.1.2). */
export const OPENCODE_V2_TESTED_VERSIONS = ">=2.1.2 <2.2.0";

/** Both ranges, as `ari/meta/opencode` shows them. */
export const OPENCODE_TESTED_VERSIONS = `${OPENCODE_V1_TESTED_VERSIONS} || ${OPENCODE_V2_TESTED_VERSIONS}`;

/** The SDK package each server generation needs. */
export const OPENCODE_V1_SDK_PACKAGE = "@opencode-ai/sdk";
export const OPENCODE_V2_SDK_PACKAGE = "@opencode/client";

/** Where the password of an external server is kept: the instance's secrets. */
export const SERVER_PASSWORD_SECRET = { namespace: "opencode", key: "server-password" } as const;

/**
 * The server-password variables OpenCode reads (1.x `OPENCODE_SERVER_PASSWORD`,
 * 2.x `OPENCODE_PASSWORD`, which overrides it). The driver gives every server
 * it starts its own password, so inherited values are removed.
 */
export const OPENCODE_PASSWORD_VARIABLES = ["OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD"] as const;

export const OPENCODE_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "OpenCode",
  type: "object",
  properties: {
    binary: { type: "string", minLength: 1, description: "The opencode executable: a name looked up on PATH, or a path." },
    serverUrl: { type: "string", pattern: "^https?://", description: "An OpenCode server someone else runs. The driver never starts or stops it." },
    model: { type: "string", pattern: "^[^/]+/.+$", description: "The model new threads start with, as provider/model. OpenCode's default when left out." },
    agent: { type: "string", minLength: 1, description: "The OpenCode agent new threads use, for example build." },
  },
  required: ["binary"],
  additionalProperties: false,
};

export function defaultOpencodeConfig(): OpencodeConfig {
  return { binary: "opencode" };
}

/**
 * How a host runs the user's own `opencode` in a terminal: `--session <id>`
 * continues a session in both generations (1.x `cli/cmd/tui.ts`, 2.x
 * `opencode --help`). 2.x has no `--fork` flag, so the manifest offers no fork
 * launch. OpenCode reads MCP servers from its `mcp` config, which is not the
 * `mcpServers` shape `ari/cli-manifests` writes, so there is no MCP injection.
 */
export const OPENCODE_CLI_MANIFEST: CliLaunchManifest = {
  binary: "opencode",
  envScrubPrefixes: [...OPENCODE_PASSWORD_VARIABLES],
  args: {
    fresh: [],
    resume: ["--session", "{sessionId}"],
  },
};
