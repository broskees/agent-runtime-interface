// The Cursor driver's config, package name and tested range. `ari/meta/cursor`
// reads this file too, so it imports nothing from Node, loads no vendor
// package and spawns nothing.

import type { JsonSchema } from "../../generated/common.ts";

/** Which on-disk Cursor settings layers a local agent loads (the SDK's `SettingSource`). */
export type CursorSettingSource = "project" | "user" | "team" | "mdm" | "plugins" | "all";

/** The instance config of the Cursor driver. */
export interface CursorConfig {
  /**
   * The model new threads start with, as a Cursor model id (for example
   * `composer-2.5`). Local Cursor agents need an explicit model
   * (`AgentOptions.model`, @cursor/sdk options.d.ts).
   */
  readonly model: string;
  /**
   * The on-disk settings layers the agent loads: `project` (the workspace's
   * `.cursor/`, rules and `AGENTS.md`), `user` (`~/.cursor/`), `team`, `mdm`,
   * `plugins` or `all`. Empty by default, so only what the host passes inline
   * reaches the agent.
   */
  readonly settingSources?: readonly CursorSettingSource[];
}

export const CURSOR_DRIVER_KIND = "cursor";

/** The npm package the driver loads with a dynamic `import()`: an optional peer of ari. */
export const CURSOR_SDK_PACKAGE = "@cursor/sdk";

export const CURSOR_INSTALL_HINT = "Install the Cursor TypeScript SDK next to ari: npm install @cursor/sdk";

/** The @cursor/sdk versions this driver is tested against: the pinned devDependency 1.4.2 and its patch releases. */
export const CURSOR_TESTED_VERSIONS = ">=1.4.2 <1.5.0";

export const CURSOR_DOCS_URL = "https://cursor.com/docs/sdk/typescript";

export const CURSOR_SETTING_SOURCES: readonly CursorSettingSource[] = ["project", "user", "team", "mdm", "plugins", "all"];

export const CURSOR_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Cursor",
  type: "object",
  properties: {
    model: { type: "string", minLength: 1, description: "The Cursor model id new threads start with, for example composer-2.5." },
    settingSources: {
      type: "array",
      items: { enum: [...CURSOR_SETTING_SOURCES] },
      uniqueItems: true,
      description: "The on-disk Cursor settings layers the agent loads. Empty: only what the host passes inline.",
    },
  },
  required: ["model"],
  additionalProperties: false,
};

export function defaultCursorConfig(): CursorConfig {
  return { model: "composer-2.5", settingSources: [] };
}
