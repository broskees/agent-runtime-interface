// `ari/meta/claude`: what a host shows and configures for the Claude driver
// without loading it: the label, the icon, the config JSON Schema with form
// hints, the default config and the vendor versions the driver is tested
// against. Plain data: it imports no Node built-in, loads no vendor package
// and spawns nothing.

import type { Icon, JsonSchema } from "../generated/common.ts";
import type { DriverMetadata } from "../generated/driver.ts";

/** Reasoning effort levels the Claude Agent SDK accepts (`Options.effort`). */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

/** Filesystem settings sources Claude Code can load (`Options.settingSources`). */
export const CLAUDE_SETTING_SOURCES = ["user", "project", "local"] as const;
export type ClaudeSettingSource = (typeof CLAUDE_SETTING_SOURCES)[number];

/** The Claude driver's config. Every field is optional; `{}` runs Claude Code with its own defaults. */
export interface ClaudeDriverConfig {
  /**
   * The user's Claude Code executable every query runs
   * (`Options.pathToClaudeCodeExecutable`): a name looked up on the host's
   * PATH, or a path. Leave it out to run the `claude` on the host's PATH. It
   * must be Claude Code `CLAUDE_TESTED_CLAUDE_CODE_VERSION` or newer. The
   * driver never runs a Claude Code binary that npm put beside the SDK.
   */
  readonly executablePath?: string;
  /** The model new threads start with, for example `sonnet` or `claude-opus-4-8`; Claude Code's default when unset. */
  readonly model?: string;
  /** The reasoning effort new threads start with; the model's default when unset. */
  readonly effort?: ClaudeEffortLevel;
  /** Which settings files Claude Code loads; all three when unset (Claude Code's own default). */
  readonly settingSources?: readonly ClaudeSettingSource[];
}

export const CLAUDE_LABEL = "Claude";
export const CLAUDE_DESCRIPTION = "Runs the user's Claude Code through the Claude Agent SDK (@anthropic-ai/claude-agent-sdk).";

/** The ARI driver kind. */
export const CLAUDE_DRIVER_KIND = "claude";

/** The optional peer package the driver loads with a dynamic `import()`. */
export const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * The SDK version the install hint names: the pinned devDependency, inside
 * `CLAUDE_TESTED_VERSIONS`, and the version the standalone `ari-driver`
 * compiles in. ARI never installs it; under Node the host does.
 */
export const CLAUDE_SDK_VERSION = "0.3.330";

/**
 * The Claude Code version the pinned SDK bundles (its package.json
 * `claudeCodeVersion`). It is the version this driver is tested against and
 * the oldest it runs: the SDK's docs require "the Claude Code bundled with
 * this SDK or newer" of an app that starts its own Claude Code. A `claude`
 * older than this leaves the driver unavailable; a newer one runs, with an
 * `untested_version` advisory.
 */
export const CLAUDE_TESTED_CLAUDE_CODE_VERSION = "2.1.330";

/** Anthropic's Claude Code setup page, which the install and update hints name. */
export const CLAUDE_CODE_SETUP_URL = "https://code.claude.com/docs/en/setup";

/**
 * What a host tells the user when the SDK is missing under Node, where the
 * driver imports the package by name. ARI installs nothing itself. (The
 * standalone `ari-driver` has the SDK compiled in.)
 */
export const CLAUDE_INSTALL_HINT = `ARI does not install it. Install the Claude Agent SDK next to ari (npm install ${CLAUDE_SDK_PACKAGE}@${CLAUDE_SDK_VERSION}).`;

/**
 * What a host tells the user when no Claude Code is found: Anthropic's
 * native installer (code.claude.com/docs/en/setup), or `executablePath`.
 * The driver never downloads Claude Code itself.
 */
export const CLAUDE_CODE_INSTALL_HINT =
  `Install Claude Code ${CLAUDE_TESTED_CLAUDE_CODE_VERSION} or newer (macOS, Linux and WSL: curl -fsSL https://claude.ai/install.sh | bash; Windows PowerShell: irm https://claude.ai/install.ps1 | iex; see ${CLAUDE_CODE_SETUP_URL}), or set executablePath in the driver config to the path of a Claude Code executable.`;

/** What a host tells the user when the Claude Code found is older than `CLAUDE_TESTED_CLAUDE_CODE_VERSION`. */
export const CLAUDE_CODE_UPDATE_HINT =
  `Update Claude Code to ${CLAUDE_TESTED_CLAUDE_CODE_VERSION} or newer (run claude update, or the upgrade command of the package manager that installed it; see ${CLAUDE_CODE_SETUP_URL}), or set executablePath in the driver config to a newer Claude Code.`;

/**
 * The Claude Agent SDK versions this driver is tested against, as a semver
 * range: the pinned devDependency whose types the fake SDK is checked
 * against. It bundles Claude Code `CLAUDE_TESTED_CLAUDE_CODE_VERSION`.
 */
export const CLAUDE_TESTED_VERSIONS = ">=0.3.330 <0.3.331";

export const CLAUDE_DOCS_URL = "https://docs.claude.com/en/docs/agent-sdk/typescript";

export const CLAUDE_ICON: Icon = {
  type: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3v18"/><path d="M3 12h18"/><path d="M5.6 5.6l12.8 12.8"/><path d="M18.4 5.6L5.6 18.4"/></svg>',
};

export const CLAUDE_METADATA: DriverMetadata = {
  displayName: CLAUDE_LABEL,
  icon: CLAUDE_ICON,
  docsUrl: CLAUDE_DOCS_URL,
  multipleInstances: true,
  hasDefaultInstance: true,
};

export const CLAUDE_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Claude driver config",
  type: "object",
  properties: {
    executablePath: {
      type: "string",
      minLength: 1,
      description: `The Claude Code executable to run: a name looked up on PATH, or a path. The claude on PATH when unset. It must be Claude Code ${CLAUDE_TESTED_CLAUDE_CODE_VERSION} or newer.`,
    },
    model: { type: "string", minLength: 1, description: "The model new threads start with. Claude Code's default when unset." },
    effort: { enum: [...CLAUDE_EFFORT_LEVELS], description: "The reasoning effort new threads start with. The model's default when unset." },
    settingSources: {
      type: "array",
      items: { enum: [...CLAUDE_SETTING_SOURCES] },
      uniqueItems: true,
      description: "Which settings files Claude Code loads. All of them when unset.",
    },
  },
  additionalProperties: false,
};

/** How a settings form shows one config field. */
export interface ClaudeConfigFieldHint {
  readonly label: string;
  readonly help?: string;
  readonly placeholder?: string;
  readonly widget: "text" | "select" | "multi_select" | "path";
  /** Shown only when the user asks for advanced settings. */
  readonly advanced?: boolean;
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

/** Form hints for each field of the config schema, in display order. */
export const CLAUDE_FORM_HINTS: { readonly [field in keyof ClaudeDriverConfig]-?: ClaudeConfigFieldHint } = {
  model: { label: "Model", help: "The model new threads start with. Leave empty for Claude Code's default.", placeholder: "sonnet", widget: "text" },
  effort: {
    label: "Reasoning effort",
    widget: "select",
    options: CLAUDE_EFFORT_LEVELS.map((level) => ({ value: level, label: level })),
  },
  executablePath: {
    label: "Claude Code executable",
    help: `Leave empty to run the claude on PATH. It must be Claude Code ${CLAUDE_TESTED_CLAUDE_CODE_VERSION} or newer.`,
    placeholder: "claude",
    widget: "path",
    advanced: true,
  },
  settingSources: {
    label: "Settings files",
    help: "Which Claude Code settings files to load.",
    widget: "multi_select",
    advanced: true,
    options: CLAUDE_SETTING_SOURCES.map((source) => ({ value: source, label: source })),
  },
};

export function claudeDefaultConfig(): ClaudeDriverConfig {
  return {};
}
