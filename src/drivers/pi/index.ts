// `ari/drivers/pi`: the Pi driver. It runs the user's own `pi` in RPC mode
// (`pi --mode rpc`, strict JSONL over stdio; Pi docs https://pi.dev/docs/latest/rpc),
// one process per thread. Importing this module starts nothing and loads no
// vendor package; `create()` only records the config.
//
// It is ARI's reference driver: small on purpose, and the one to copy when
// writing a driver for a CLI agent. Read it in this order:
// - config.ts: the instance config, the CLI manifest and the tested versions;
// - capabilities.ts: what it declares;
// - instance.ts: status, side-effect-free probes, five-state auth, the catalog;
// - session.ts: threads, turns, requests, and Pi's events as ARI events;
// - transcript.ts: deterministic ids, and snapshots rebuilt from session files;
// - bridge.ts: the small Pi extension it loads into every Pi process;
// - rpc.ts: one Pi process and its JSONL framing.

import type { Driver } from "../../runtime.ts";
import { ARI_VERSION } from "../../version.ts";
import { PI_CLI_MANIFEST, PI_CONFIG_SCHEMA, PI_DOCS_URL, PI_DRIVER_KIND, defaultPiConfig } from "./config.ts";
import type { PiConfig } from "./config.ts";
import { PiInstance } from "./instance.ts";
import { PI_ICON } from "./icon.ts";

export { PI_CLI_MANIFEST, PI_CONFIG_SCHEMA, PI_CREDENTIAL_VARIABLES, PI_DRIVER_KIND, PI_TESTED_VERSIONS, defaultPiConfig } from "./config.ts";
export type { PiConfig } from "./config.ts";
export { piCapabilities } from "./capabilities.ts";
export { PI_AUTH_METHODS, PI_POISON_MS, versionAdvisory, versionInRange } from "./instance.ts";
export { BRIDGE_FILE_NAME, BRIDGE_SETTINGS_VARIABLE, PI_BRIDGE_SOURCE, parseApprovalTitle } from "./bridge.ts";
export type { ApprovalDescriptor, BridgeSettings } from "./bridge.ts";

export const piDriver: Driver<PiConfig> = {
  kind: PI_DRIVER_KIND,
  ariVersion: ARI_VERSION,
  metadata: { displayName: "Pi", icon: PI_ICON, docsUrl: PI_DOCS_URL, multipleInstances: true, hasDefaultInstance: true },
  configSchema: PI_CONFIG_SCHEMA,
  defaultConfig: defaultPiConfig,
  cliManifest: PI_CLI_MANIFEST,
  async create(host, input) {
    return new PiInstance(host, { ...defaultPiConfig(), ...input.config }, input.instanceId, input.environment);
  },
};

export default piDriver;
