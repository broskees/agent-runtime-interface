// Pause the installer's rename to exercise the race between cleanup and a
// lease. This needs Node to sync the patched method into node:fs/promises.

import assert from "node:assert/strict";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { after, before, test } from "node:test";
import { createAdapterInstaller } from "../../src/node/index.ts";
import { PKG, assertCompleteInstall, fromFile, newCacheDir, packedTarball, removeInstallerFixture, setUpInstallerFixture } from "./installer-fixture.ts";

before(setUpInstallerFixture);
after(removeInstallerFixture);

test("cleanup never moves a version while a lease on it is being handed out", async () => {
  const cacheDir = await newCacheDir();
  const installer = createAdapterInstaller({ cacheDir, fetchTarball: fromFile(packedTarball) });
  const versionDir = (await installer.install(PKG, "1.0.0")).dir;

  // Pause cleanup at the moment it moves the version aside.
  const realRename = nodeFs.promises.rename;
  let cleanupPaused = (): void => {};
  const paused = new Promise<void>((resolve) => {
    cleanupPaused = resolve;
  });
  let resumeCleanup = (): void => {};
  const resumed = new Promise<void>((resolve) => {
    resumeCleanup = resolve;
  });
  nodeFs.promises.rename = async (from, to) => {
    if (String(from) === versionDir && String(to).includes(".trash-")) {
      cleanupPaused();
      await resumed;
    }
    return realRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    const cleaning = installer.cleanup();
    await paused;
    let leaseSettled = false;
    const leasing = installer.lease(PKG, "1.0.0").finally(() => {
      leaseSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(leaseSettled, false, "the lease waits while cleanup is removing its version");
    resumeCleanup();
    const [removed, lease] = await Promise.all([cleaning, leasing]);
    assert.deepEqual(removed.map((entry) => entry.version), ["1.0.0"], "cleanup removed the version it had started removing");
    // The lease was handed out after cleanup finished, so its version was installed again and stays.
    await assertCompleteInstall(lease.dir);
    assert.deepEqual(await installer.cleanup(), [], "a held lease keeps its version");
    await assertCompleteInstall(lease.dir);
    await lease.release();
  } finally {
    resumeCleanup();
    nodeFs.promises.rename = realRename;
    syncBuiltinESMExports();
  }
});
