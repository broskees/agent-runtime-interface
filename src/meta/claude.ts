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
   * A Claude Code executable to run instead of the one the SDK bundles
   * (`Options.pathToClaudeCodeExecutable`): a name looked up on PATH, or a
   * path. Leave it out to use the bundled native binary.
   */
  readonly executablePath?: string;
  /** The model new threads start with, for example `sonnet` or `claude-opus-4-8`; Claude Code's default when unset. */
  readonly model?: string;
  /** The reasoning effort new threads start with; the model's default when unset. */
  readonly effort?: ClaudeEffortLevel;
  /** Which settings files Claude Code loads; all three when unset (Claude Code's own default). */
  readonly settingSources?: readonly ClaudeSettingSource[];
  /**
   * An absolute path to a directory where `@anthropic-ai/claude-agent-sdk` is
   * installed: the directory `npm install @anthropic-ai/claude-agent-sdk` ran
   * in, which holds `node_modules/@anthropic-ai/claude-agent-sdk`. The driver
   * loads the SDK from there by file URL, and its native Claude Code binary
   * from the platform package beside it, instead of importing the package by
   * name. The standalone `ari-driver` cannot import a package by name, so it
   * needs this field or `maintenance.install`.
   */
  readonly sdkDirectory?: string;
  /** The npm registry `maintenance.install` and `maintenance.update` download the SDK from; `https://registry.npmjs.org` when unset. */
  readonly sdkRegistry?: string;
}

export const CLAUDE_LABEL = "Claude";
export const CLAUDE_DESCRIPTION = "Runs Claude Code through the Claude Agent SDK (@anthropic-ai/claude-agent-sdk).";

/** The ARI driver kind. */
export const CLAUDE_DRIVER_KIND = "claude";

/** The optional peer package the driver loads with a dynamic `import()`. */
export const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * The SDK version `maintenance.install` and `maintenance.update` install: the
 * pinned devDependency, inside `CLAUDE_TESTED_VERSIONS`. Its native packages
 * carry the same version.
 */
export const CLAUDE_SDK_VERSION = "0.3.330";

/** The npm registry the driver installs the SDK from when `sdkRegistry` is unset. */
export const CLAUDE_DEFAULT_SDK_REGISTRY = "https://registry.npmjs.org";

/** What a host tells the user when the SDK is missing under Node, where importing the package by name works. */
export const CLAUDE_INSTALL_HINT = `Install the Claude Agent SDK next to ari (npm install ${CLAUDE_SDK_PACKAGE}), run maintenance.install on this instance, or set sdkDirectory in the driver config to a directory where it is installed.`;

/**
 * What a host tells the user when the SDK is missing in the standalone
 * `ari-driver` executable, which cannot import a package by name: only these
 * two steps work there.
 */
export const CLAUDE_STANDALONE_INSTALL_HINT = `Run maintenance.install on this instance to download the Claude Agent SDK, or set sdkDirectory in the driver config to a directory where ${CLAUDE_SDK_PACKAGE} is installed.`;

/** What a host tells the user when the SDK is present but its native Claude Code binary is not. */
export const CLAUDE_BINARY_HINT =
  `Reinstall ${CLAUDE_SDK_PACKAGE} without --omit=optional (its platform package carries the native Claude Code binary), or set executablePath in the driver config.`;

/**
 * The Claude Agent SDK versions this driver is tested against, as a semver
 * range: the pinned devDependency whose types the fake SDK is checked
 * against. It bundles Claude Code 2.1.330.
 */
export const CLAUDE_TESTED_VERSIONS = ">=0.3.330 <0.3.331";

/** The Claude Code version the tested SDK bundles. */
export const CLAUDE_TESTED_CLAUDE_CODE_VERSION = "2.1.330";

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
      description: "A Claude Code executable to run instead of the SDK's bundled binary: a name looked up on PATH, or a path.",
    },
    model: { type: "string", minLength: 1, description: "The model new threads start with. Claude Code's default when unset." },
    effort: { enum: [...CLAUDE_EFFORT_LEVELS], description: "The reasoning effort new threads start with. The model's default when unset." },
    settingSources: {
      type: "array",
      items: { enum: [...CLAUDE_SETTING_SOURCES] },
      uniqueItems: true,
      description: "Which settings files Claude Code loads. All of them when unset.",
    },
    sdkDirectory: {
      type: "string",
      minLength: 1,
      description:
        "An absolute path to a directory where @anthropic-ai/claude-agent-sdk is installed (it holds node_modules/@anthropic-ai/claude-agent-sdk). The driver loads the SDK from there instead of by package name; the standalone ari-driver needs this or maintenance.install.",
    },
    sdkRegistry: {
      type: "string",
      pattern: "^https?://",
      description: "The npm registry maintenance.install downloads the Claude Agent SDK from. https://registry.npmjs.org when unset.",
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
    help: "Leave empty to use the binary the SDK bundles.",
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
  sdkDirectory: {
    label: "Claude Agent SDK directory",
    help:
      "A directory where npm install @anthropic-ai/claude-agent-sdk ran. Leave empty to use the SDK maintenance.install downloaded, or the one installed next to ari. The standalone ari-driver needs this or maintenance.install.",
    placeholder: "/opt/claude-agent-sdk",
    widget: "path",
    advanced: true,
  },
  sdkRegistry: {
    label: "npm registry for the SDK",
    help: "Where maintenance.install downloads the Claude Agent SDK from.",
    placeholder: CLAUDE_DEFAULT_SDK_REGISTRY,
    widget: "text",
    advanced: true,
  },
};

export function claudeDefaultConfig(): ClaudeDriverConfig {
  return {};
}
