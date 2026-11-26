// The Pi driver's config, CLI manifest and tested range. `ari/meta/pi` reads
// this file too, so it imports nothing from Node and spawns nothing.

import type { JsonSchema } from "../../generated/common.ts";
import type { CliLaunchManifest } from "../../generated/driver.ts";

/** The instance config of the Pi driver. */
export interface PiConfig {
  /** The `pi` executable: a name looked up on PATH, or a path. */
  readonly binary: string;
  /**
   * The provider whose sign-in `pi auth check` reports, for example
   * `anthropic`. Without it (and without `model`) the ambient sign-in is
   * `unknown`, because Pi picks its provider itself.
   */
  readonly provider?: string;
  /** The model new threads start with, as Pi's `--model` takes it (`provider/id`). Pi's default otherwise. */
  readonly model?: string;
  /** The thinking level new threads start with, as Pi's `--thinking` takes it. */
  readonly thinking?: string;
}

export const PI_DRIVER_KIND = "pi";

/**
 * The oldest `pi` the driver runs: the lower bound of `PI_TESTED_VERSIONS`.
 * An older `pi` is refused with `driver_unavailable` naming `PI_UPDATE_STEP`;
 * ARI never installs or updates `pi`.
 */
export const PI_MINIMUM_VERSION = "1.6.0";

/** The Pi versions this driver is tested against: the RPC protocol of `@earendil-works/pi-coding-agent` 1.6.0. */
export const PI_TESTED_VERSIONS = `>=${PI_MINIMUM_VERSION} <2.0.0`;

/** Pi's own update step (https://pi.dev/docs/latest/quickstart: "Both installers pin all dependencies and update Pi with `pi update`"), named when `pi` is older than the minimum. */
export const PI_UPDATE_STEP = "Update pi with `pi update`.";

export const PI_DOCS_URL = "https://pi.dev/docs/latest/rpc";

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const PI_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Pi",
  type: "object",
  properties: {
    binary: { type: "string", minLength: 1, description: "The pi executable: a name looked up on PATH, or a path." },
    provider: { type: "string", minLength: 1, description: "The provider whose sign-in `pi auth check` reports, for example anthropic." },
    model: { type: "string", minLength: 1, description: "The model new threads start with, as `provider/id`. Pi's default when left out." },
    thinking: { enum: [...PI_THINKING_LEVELS], description: "The thinking level new threads start with." },
  },
  required: ["binary"],
  additionalProperties: false,
};

export function defaultPiConfig(): PiConfig {
  return { binary: "pi" };
}

/**
 * Credential variables Pi reads from its environment (Pi docs, providers.md).
 * Hosts strip them from the environment a Pi process inherits, so only
 * credentials the instance configured reach Pi; the user's own sign-in in
 * `~/.pi/agent/auth.json` is untouched. They are exact names, used as
 * prefixes by `ari/cli-manifests`.
 */
export const PI_CREDENTIAL_VARIABLES = [
  "AI_GATEWAY_API_KEY",
  "ANT_LING_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "BASETEN_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "META_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY",
  "QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY",
  "QWEN_TOKEN_PLAN_TEAM_API_KEY",
  "QWEN_TOKEN_PLAN_TEAM_CN_API_KEY",
  "RADIUS_API_KEY",
  "TOGETHER_API_KEY",
  "TYPESAFE_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
] as const;

/**
 * How a host runs the user's own `pi` in a terminal (Pi docs, cli.md):
 * `--session` resumes a session file or id in its working directory, and
 * `--fork` copies one into the current directory. Host MCP servers have no
 * terminal route: Pi reads them only from `mcp.json` or an extension, so the
 * manifest offers no MCP injection.
 */
export const PI_CLI_MANIFEST: CliLaunchManifest = {
  binary: "pi",
  envScrubPrefixes: [...PI_CREDENTIAL_VARIABLES],
  args: {
    fresh: [],
    resume: ["--session", "{sessionId}"],
    fork: ["--fork", "{sessionId}"],
  },
};
