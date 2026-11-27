// `ari/drivers/antigravity`: the Google Antigravity CLI over ACP. Quirks it
// keeps:
// - each instance gets its own profile directory (`<stateDir>/profile`),
//   passed as `--gemini-dir`, and `agy` keeps the instance's Google sign-in
//   in that profile's file storage, never in the OS keyring's one entry that
//   every `agy` on the machine shares, so instances never share a Google
//   sign-in (see ANTIGRAVITY_LAUNCH_ENVIRONMENT);
// - ambient Google credentials are stripped through the host's
//   `process.envPolicy`; the driver refuses to start a session when the
//   host's policy would let one through (see ANTIGRAVITY_STRIPPED_VARIABLES);
// - permission prompts take fixed choices only (`allowCustomAnswer: false`);
// - the agent can checkpoint the workspace but cannot roll back its
//   conversation, so `rollbackThread` rejects with `unsupported` before it
//   does anything, and touches no file;
// - it runs the `agy` the user installed (`command`, by default `agy` on
//   PATH) and never downloads, installs or updates one: an `agy` older than
//   1.5.0 is refused, naming `agy update`, and a config that still names a
//   setting of the managed install ARI used to offer (`installation`,
//   `releaseManifestUrl`, `version`) is refused by `create()`, naming how to
//   install `agy`.

import * as fs from "node:fs/promises";
import { callErrors } from "../../errors.ts";
import type { RollbackThreadInput } from "../../generated/session.ts";
import type { ThreadSnapshot } from "../../generated/thread.ts";
import type { HostServices, Session } from "../../runtime.ts";
import {
  ANTIGRAVITY_CLI_MANIFEST,
  ANTIGRAVITY_CONFIG_SCHEMA,
  ANTIGRAVITY_DEFAULT_CONFIG,
  ANTIGRAVITY_INSTALL_STEP,
  ANTIGRAVITY_STRIPPED_VARIABLES,
  ANTIGRAVITY_UPDATE_STEP,
  meta,
} from "../../meta/antigravity.ts";
import type { AntigravityConfig } from "../../meta/antigravity.ts";
import type { Driver } from "../../runtime.ts";
import { createAcpDriver } from "../acp/driver.ts";

export type { AntigravityConfig } from "../../meta/antigravity.ts";
export { ANTIGRAVITY_CLI_MANIFEST, ANTIGRAVITY_CONFIG_SCHEMA, ANTIGRAVITY_DEFAULT_CONFIG, ANTIGRAVITY_INSTALL_STEP, ANTIGRAVITY_STRIPPED_VARIABLES, ANTIGRAVITY_UPDATE_STEP } from "../../meta/antigravity.ts";

/** The settings of the managed install ARI no longer offers. A config that names one is refused. */
export const ANTIGRAVITY_REMOVED_SETTINGS: readonly string[] = ["installation", "releaseManifestUrl", "version"];

/** The instance's own profile directory. */
export function antigravityProfile(host: HostServices<unknown>): string {
  return `${host.paths.stateDir}/profile`;
}

/**
 * The variables the driver gives `agy acp`, all of which `agy` 1.5.x reads:
 * - `AGY_CLI_FORCE_FILE_TOKEN_STORAGE`: `agy` 1.5.16 and later keep a Google
 *   sign-in in the OS keyring's one entry (service `gemini`, account
 *   `antigravity`), whatever `--gemini-dir` says, unless this is set; then in
 *   `<profile>/antigravity-acp/antigravity-oauth-token` (they log "Using
 *   file-based token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is
 *   set"). `AGY_ACP_FORCE_FILE_STORAGE` and `GEMINI_HOME` are not in the 1.5.x
 *   binary.
 * - `AGY_CLI_DISABLE_AUTO_UPDATE`: the switch of the CLI's self-updater.
 */
const ANTIGRAVITY_LAUNCH_ENVIRONMENT: { readonly [name: string]: string } = { AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1", AGY_CLI_DISABLE_AUTO_UPDATE: "true" };

/** The required variables the host's environment policy would let through. */
export function unstrippedVariables(stripAmbient: readonly string[]): string[] {
  const covered = (name: string): boolean => stripAmbient.some((entry) => (entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : entry === name));
  return ANTIGRAVITY_STRIPPED_VARIABLES.filter((name) => !covered(name));
}

/** Refuses a config that still names a managed-install setting: ARI runs the user's own `agy` and never installs one. */
function refuseManagedInstallSettings(config: AntigravityConfig): void {
  const named = ANTIGRAVITY_REMOVED_SETTINGS.filter((setting) => Object.hasOwn(config, setting));
  if (named.length === 0) return;
  throw callErrors.validation(
    named.map((setting) => ({ path: [setting], message: "ARI no longer installs the Antigravity CLI" })),
    `ARI no longer downloads, installs or updates the Antigravity CLI (agy), so the config may not name ${named.join(", ")}. Remove ${named.length === 1 ? "it" : "them"}; the driver runs the agy on PATH, or the one \`command\` names. ${ANTIGRAVITY_INSTALL_STEP}`,
  );
}

/** An Antigravity driver. */
export function createAntigravityDriver(): Driver<AntigravityConfig> {
  const driver = createAcpDriver<AntigravityConfig>({
    kind: "antigravity",
    metadata: meta.metadata,
    configSchema: ANTIGRAVITY_CONFIG_SCHEMA,
    defaultConfig: () => ({ ...ANTIGRAVITY_DEFAULT_CONFIG, configDependencies: {} }),
    cliManifest: ANTIGRAVITY_CLI_MANIFEST,
    testedRange: { min: "1.5.0", below: "1.6.0", updateStep: ANTIGRAVITY_UPDATE_STEP },
    launchIdentity: (config) => config.command,

    probeTarget: async (context) => ({ kind: "command", command: context.config.command, versionArgs: ["--version"], env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } }),

    async beforeSession(context) {
      // The host strips ambient Google credentials; a session never starts when its policy would let one through.
      const missing = unstrippedVariables(context.host.process.envPolicy.stripAmbient);
      if (missing.length > 0) {
        throw callErrors.invalidState("env_policy_incomplete", `The host's process.envPolicy must strip ${missing.join(", ")} for Antigravity (the CLI manifest's envScrubPrefixes cover them all)`);
      }
    },

    async launch(context) {
      const profile = antigravityProfile(context.host as HostServices<unknown>);
      await fs.mkdir(profile, { recursive: true, mode: 0o700 });
      const args = ["acp", "--gemini-dir", profile, "--app-data-dir", "antigravity-acp"];
      return { command: context.config.command, args, env: { ...ANTIGRAVITY_LAUNCH_ENVIRONMENT } };
    },

    adjustCapabilities: (capabilities) => ({
      ...capabilities,
      // Antigravity's permission prompts take one of their fixed choices, never a typed answer.
      requests: { ...capabilities.requests, allowCustomAnswer: false },
      checkpointing: { ...capabilities.checkpointing, conversationRollback: false, rollbackReturnsSnapshot: false },
      threads: { ...capabilities.threads, rollback: false },
    }),

    decorateSession(session) {
      const decorated = session as Session;
      // Rejected first, before any file or process is touched: the agent cannot roll back its conversation.
      decorated.rollbackThread = (input: RollbackThreadInput): Promise<ThreadSnapshot> => {
        void input;
        return Promise.reject(callErrors.unsupported("threads.rollback", "Antigravity can checkpoint the workspace but cannot roll back its conversation"));
      };
      return decorated;
    },
  });
  return {
    ...driver,
    async create(host, input) {
      refuseManagedInstallSettings(input.config);
      return driver.create(host, input);
    },
  };
}

export const antigravityDriver: Driver<AntigravityConfig> = createAntigravityDriver();

export default antigravityDriver;
