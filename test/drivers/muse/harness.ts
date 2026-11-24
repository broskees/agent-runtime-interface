// The conformance harness for the Muse driver: the real driver, with the real
// `@muse-code/sdk` `Connection`, against the fake `muse serve` of
// fake-muse.ts, in a real temporary workspace with a real symbolic link and
// real per-instance directories.
//
// Each rig has its own command id minter (session ids and turn ids come from
// it), counting from one like the fake's own ids, so two rigs that do the same
// things get the same ids, as two runs against a real host with a seeded
// minter would (the SDK documents the injectable minter for deterministic
// transcripts).

import * as path from "node:path";
import type { ConformanceHarness, ConformanceWorkspace, HarnessRig } from "../../../src/conformance/index.ts";
import { createMuseDriver } from "../../../src/drivers/muse/index.ts";
import type { MuseDriverConfig } from "../../../src/drivers/muse/index.ts";
import { createConformanceWorkspace, instanceDirectories, watchInstanceFiles } from "../../helpers/conformance.ts";
import { FakeMuseWorld } from "./fake-muse.ts";

/** The managed Meta API key the auth scenario's managed profile stores. */
export const MANAGED_API_KEY = "meta-managed-profile-key";

/** A command id minter counting from one, in UUIDv7 form. */
export function seededMinter(prefix = "0197"): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}0000-0000-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

export interface MuseHarness extends ConformanceHarness<MuseDriverConfig> {
  /** Every rig's fake Muse, so tests can check what crossed the wire. */
  readonly worlds: FakeMuseWorld[];
  cleanup(): void;
}

export function museHarness(): MuseHarness {
  const created = createConformanceWorkspace("ari-muse-conformance-");
  const worlds: FakeMuseWorld[] = [];
  return {
    name: "muse driver (real @muse-code/sdk Connection, fake muse serve, SDK-typed frames)",
    worlds,
    cleanup: created.cleanup,
    notApplicable: {
      "auth-states.unavailable": "the driver runs no sign-in check: MSP 1.4.25 has no account method in its stable surface, so the ambient account is always unknown and no check can fail",
    },
    workspace: async (): Promise<ConformanceWorkspace> => created.workspace,
    async setup(request): Promise<HarnessRig<MuseDriverConfig>> {
      const rigRoot = path.join(created.root, "rigs", `${request.scenario}-${Math.random().toString(36).slice(2)}`);
      const world = new FakeMuseWorld({ ambientAuth: request.ambientAuth });
      worlds.push(world);
      const driver = createMuseDriver({ mintCommandId: seededMinter() });
      return {
        driver,
        config: driver.defaultConfig(),
        hostOptions: (instanceId, arrangement) => ({
          paths: instanceDirectories(rigRoot, instanceId),
          spawn: async (spawnRequest) => world.spawn(spawnRequest),
          resolveExecutable: async (name) => (path.basename(name) === "muse" ? "/usr/local/bin/muse" : null),
          secrets: arrangement.managedProfile ? [{ namespace: "muse", key: "api-key", value: MANAGED_API_KEY }] : [],
        }),
        native: {
          nextTurn: async () => {
            const next = await world.turnQueue.next();
            if (next.done === true) throw new Error("the rig was disposed");
            return next.value;
          },
          lockSession: async (thread) => world.lock(thread.handle ?? thread.native.id ?? ""),
          inspectSession: async (thread) => world.inspect(thread.handle ?? thread.native.id ?? ""),
        },
        probeExecutables: ["muse"],
        // Muse session ids are UUIDv7s.
        missingSession: { id: "019a0000-0000-7000-8000-0000deadbeef", strength: "strong" },
        inheritedCredentials: ["META_API_KEY"],
        watchInstanceFiles,
        dispose: async () => world.dispose(),
      };
    },
  };
}
