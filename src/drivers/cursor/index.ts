// `ari/drivers/cursor`: the Cursor driver. It runs Cursor's local agent
// through the Cursor TypeScript SDK (`@cursor/sdk`, an optional peer of ari),
// which runs the agent loop inside the host's Node process; inference goes
// through Cursor's hosted models (https://cursor.com/docs/sdk/typescript).
// Importing this module loads no vendor package and spawns nothing: the SDK
// is loaded with a dynamic `import()` the first time an instance needs it.
//
// The driver is thin on purpose (proposal §14: "thin capability set; host
// fallbacks do the heavy lifting"). Read it in this order:
// - config.ts: the instance config, the package name and the tested versions;
// - capabilities.ts: what it declares;
// - sdk.ts: the part of the SDK it uses, and the loader;
// - instance.ts: status, side-effect-free probes, five-state auth, the catalog;
// - session.ts: threads (agents), turns (runs), steer, stop, compaction;
// - mapping.ts: deterministic ids, failures, and the fold of a run's stream.

import type { Driver } from "../../runtime.ts";
import { ARI_VERSION } from "../../version.ts";
import { CURSOR_CONFIG_SCHEMA, CURSOR_DOCS_URL, CURSOR_DRIVER_KIND, defaultCursorConfig } from "./config.ts";
import type { CursorConfig } from "./config.ts";
import { CURSOR_ICON } from "./icon.ts";
import { CursorInstance } from "./instance.ts";
import { loadCursorSdk } from "./sdk.ts";
import type { CursorSdkLoader } from "./sdk.ts";

export { CURSOR_CONFIG_SCHEMA, CURSOR_DRIVER_KIND, CURSOR_INSTALL_HINT, CURSOR_SDK_PACKAGE, CURSOR_TESTED_VERSIONS, defaultCursorConfig } from "./config.ts";
export type { CursorConfig, CursorSettingSource } from "./config.ts";
export { cursorCapabilities } from "./capabilities.ts";
export { CURSOR_AUTH_METHODS, CURSOR_POISON_MS, CURSOR_SECRET_KEY, CURSOR_SECRET_NAMESPACE, versionAdvisory, versionInRange } from "./instance.ts";
export { READ_ONLY_TOOLS } from "./session.ts";
export { IDENTITY_VERSION, failureFromRunError, itemIdFor, itemNative, threadIdFor, turnIdFor } from "./mapping.ts";
export { loadCursorSdk } from "./sdk.ts";
export type * from "./sdk.ts";

/** How a Cursor driver finds the SDK. Tests pass a loader that returns a fake SDK. */
export interface CursorDriverOptions<Store> {
  readonly loadSdk: CursorSdkLoader<Store>;
}

/** A Cursor driver with its own SDK loader. `cursorDriver` uses `import("@cursor/sdk")`. */
export function createCursorDriver<Store>(options: CursorDriverOptions<Store>): Driver<CursorConfig> {
  return {
    kind: CURSOR_DRIVER_KIND,
    ariVersion: ARI_VERSION,
    metadata: { displayName: "Cursor", icon: CURSOR_ICON, docsUrl: CURSOR_DOCS_URL, multipleInstances: true, hasDefaultInstance: true },
    configSchema: CURSOR_CONFIG_SCHEMA,
    defaultConfig: defaultCursorConfig,
    async create(host, input) {
      return new CursorInstance<Store>(host, { ...defaultCursorConfig(), ...input.config }, input.instanceId, input.environment, options.loadSdk);
    },
  };
}

export const cursorDriver: Driver<CursorConfig> = createCursorDriver({ loadSdk: loadCursorSdk });

export default cursorDriver;
