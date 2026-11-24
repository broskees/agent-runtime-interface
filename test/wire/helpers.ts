// Helpers for the ari/wire tests: an in-memory transport pair, the paths of
// the built `ari-driver` bin and reference driver, and a conformance harness
// that runs the reference driver inside `ari-driver`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { referenceHarness } from "../../src/conformance/index.ts";
import type { ConformanceHarness } from "../../src/conformance/index.ts";
import type { ReferenceDriverConfig } from "../../src/conformance/reference/driver.ts";
import { startAriDriver } from "../../src/wire/index.ts";
import type { AriDriverProcess, StartAriDriverOptions, WireTransport } from "../../src/wire/index.ts";
import { WireQueue } from "../../src/wire/streams.ts";
import { REPO_ROOT } from "../helpers/spec.ts";

/** The `ari-driver` bin as package.json declares it, built into dist/. */
export const ARI_DRIVER_BIN = path.join(REPO_ROOT, "dist", "wire", "cli.js");

/** The built module that exports the conformance kit's reference driver. */
export const REFERENCE_DRIVER_MODULE = path.join(REPO_ROOT, "dist", "conformance", "reference", "driver.js");

/** The tests that run `ari-driver` need the build; the gate builds before it tests. */
export function requireBuild(): void {
  assert.ok(fs.existsSync(ARI_DRIVER_BIN), "dist/ is missing: run `pnpm run build` first (the gate does)");
}

/** Starts the built `ari-driver` serving `driver` (a module path or a first-party name). */
export function startBuiltAriDriver(options: Omit<StartAriDriverOptions, "command">): Promise<AriDriverProcess> {
  requireBuild();
  return startAriDriver({ ...options, command: [process.execPath, ARI_DRIVER_BIN] });
}

/** Two connected in-memory transports: what one writes, the other reads. */
export function memoryTransportPair(): [WireTransport, WireTransport] {
  const toA = new WireQueue<string>();
  const toB = new WireQueue<string>();
  const a: WireTransport = {
    input: toA,
    write: (frame) => {
      if (toB.ended) throw new Error("the other side closed");
      toB.push(frame);
    },
    close: () => toB.end(),
  };
  const b: WireTransport = {
    input: toB,
    write: (frame) => {
      if (toA.ended) throw new Error("the other side closed");
      toA.push(frame);
    },
    close: () => toA.end(),
  };
  return [a, b];
}

/**
 * A conformance harness whose driver is the reference driver running inside
 * the built `ari-driver`, one process per rig, reached through `ari/wire`'s
 * client. The host offers `host.process`, so the driver's spawns come back to
 * the rig's in-memory reference agent. Time is real: the driver's timers run
 * in another process.
 */
export function wireReferenceHarness(options: { readonly config?: Partial<ReferenceDriverConfig>; readonly onStart?: (driver: AriDriverProcess) => void } = {}): ConformanceHarness<ReferenceDriverConfig> {
  const inner = referenceHarness({ time: "real", ...(options.config === undefined ? {} : { config: options.config }) });
  return {
    name: `reference driver over ari/wire (${inner.name})`,
    time: "real",
    workspace: () => inner.workspace(),
    async setup(request) {
      const rig = await inner.setup(request);
      const driver = await startBuiltAriDriver({ driver: REFERENCE_DRIVER_MODULE, delegateProcesses: true });
      options.onStart?.(driver);
      return {
        ...rig,
        driver: driver.driver as unknown as typeof rig.driver,
        dispose: async () => {
          await rig.dispose?.();
          await driver.close();
        },
      };
    },
  };
}
