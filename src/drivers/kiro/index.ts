// `ari/drivers/kiro`: Kiro CLI over ACP. Quirks it keeps:
// - it launches `kiro-cli acp --agent-engine=v3 --auth-method=cli`: Kiro's
//   default harness may be an older engine with another ACP surface, so V3 is
//   asked for, and `--auth-method=cli` keeps access tokens inside Kiro;
// - Kiro's `autopilot` session option decides whether Kiro asks before it
//   acts. The driver sets it from the thread's runtime mode (on only under
//   `full_access`), whenever the agent offers the option;
// - it runs the `kiro-cli` the user installed and never updates it; a
//   `kiro-cli` older than 3.0.0 is refused, naming `kiro-cli update`.

import { createAcpDriver } from "../acp/driver.ts";
import { KIRO_CLI_MANIFEST, KIRO_CONFIG_SCHEMA, KIRO_DEFAULT_CONFIG, KIRO_UPDATE_STEP, meta } from "../../meta/kiro.ts";
import type { KiroConfig } from "../../meta/kiro.ts";
import type { Driver } from "../../runtime.ts";

export type { KiroConfig } from "../../meta/kiro.ts";
export { KIRO_CLI_MANIFEST, KIRO_CONFIG_SCHEMA, KIRO_DEFAULT_CONFIG } from "../../meta/kiro.ts";

export const KIRO_ACP_ARGS: readonly string[] = ["acp", "--agent-engine=v3", "--auth-method=cli"];

/** Kiro's session option that, when on, lets it act without asking. */
export const KIRO_AUTOPILOT_OPTION = "autopilot";

export const kiroDriver: Driver<KiroConfig> = createAcpDriver<KiroConfig>({
  kind: "kiro",
  metadata: meta.metadata,
  configSchema: KIRO_CONFIG_SCHEMA,
  defaultConfig: () => ({ ...KIRO_DEFAULT_CONFIG, configDependencies: {} }),
  cliManifest: KIRO_CLI_MANIFEST,
  testedRange: { min: "3.0.0", below: "4.0.0", updateStep: KIRO_UPDATE_STEP },
  launchIdentity: (config) => config.command,
  probeTarget: async ({ config }) => ({ kind: "command", command: config.command, versionArgs: ["--version"] }),
  launch: async ({ config }) => ({ command: config.command, args: [...KIRO_ACP_ARGS], env: {} }),
  policyConfig: (policy) => ({ [KIRO_AUTOPILOT_OPTION]: policy.mode === "full_access" }),
});

export default kiroDriver;
