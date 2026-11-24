// What `ari/node` does where Node's own fs and child_process semantics decide
// the outcome. The host roots, cache dirs and PATH entries the host gives are
// passed to the operating system as given:
//
// - a path with `..` after a symbolic link is read as the operating system
//   reads it (the link first, then `..`), which Node's `fs.realpath` follows;
// - an empty or relative PATH entry is searched as the current directory, as
//   Node's `child_process.spawn` does;
// - cleanup never moves an adapter version while a lease on it is being
//   handed out, which this file shows by pausing the installer's
//   `fs.promises.rename` through `module.syncBuiltinESMExports()`.
//
// Bun 1.3.14 differs on each: its `realpath` normalizes `..` before it follows
// a link, its `spawn` does not search an empty PATH entry, and its
// `syncBuiltinESMExports` does not reach `node:fs/promises` imports. So
// test/bun-excluded.txt leaves this file out of the Bun run; `pnpm run test`
// runs it under Node.

import assert from "node:assert/strict";
import nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { createAdapterInstaller, createCoordination, createInstanceDirectories, createNodeHostServices, createProcessService, instancePaths } from "../../src/node/index.ts";
import { createSymlinkedRoot, exists } from "../helpers/symlinked-root.ts";
import { PKG, assertCompleteInstall, fromFile, newCacheDir, packageEntries, packedTarball, removeInstallerFixture, setUpInstallerFixture } from "./installer-fixture.ts";

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += Buffer.from(chunk).toString("utf8");
  return text;
}

describe("ari/node host services", () => {
  test("a host root with `..` after a symbolic link gives drivers canonical paths to the directories the OS reads", async () => {
    const layout = await createSymlinkedRoot("ari-host-symlink-");
    const services = await createNodeHostServices({
      hostRoot: layout.throughSymlink("host"),
      instanceId: "x",
      config: { get: async () => ({ config: {} }) },
      attachments: { resolve: async () => null },
      hostTools: { mcpServerFor: async () => ({ name: "tools", config: { name: "tools", transport: "stdio" as const, command: "tools" } }) },
      callbacks: { register: async () => ({ url: "http://127.0.0.1:1/callback" }) },
      coordination: createCoordination(),
      writeDiagnostic: () => {},
    });
    try {
      for (const directory of Object.values(services.paths)) {
        assert.ok(directory.startsWith(`${layout.real("host")}/`), `${directory} is under the real host root`);
        assert.equal(directory, await fs.realpath(directory), `${directory} is canonical, so a driver may join onto it safely`);
        assert.equal(path.join(directory, "profile"), `${directory}/profile`);
      }
      await services.secrets.set("ns", "key", new TextEncoder().encode("v"));
      assert.equal(await exists(layout.collapsed("host")), false, "nothing is written where lexical normalization points");
    } finally {
      await services.dispose();
      await fs.rm(layout.root, { recursive: true, force: true });
    }
  });
});

describe("ari/node instance paths", () => {
  test("a host root with `..` after a symbolic link is used as the operating system reads it", async () => {
    const layout = await createSymlinkedRoot("ari-paths-symlink-");
    try {
      const paths = instancePaths(layout.throughSymlink("host"), "x");
      await createInstanceDirectories(paths);
      for (const directory of Object.values(paths)) {
        assert.ok((await fs.realpath(directory)).startsWith(`${layout.real("host")}/`), `${directory} is under the real host root`);
      }
      assert.equal(await exists(layout.collapsed("host")), false, "nothing is created where lexical normalization points");
    } finally {
      await fs.rm(layout.root, { recursive: true, force: true });
    }
  });
});

describe("ari/node process spawning", () => {
  test("an empty or relative PATH entry is the current directory, as for spawn, and resolveExecutable names what spawn runs", async () => {
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ari-path-entries-")));
    const previousDirectory = process.cwd();
    const writeAdapter = async (directory: string, label: string, mode = 0o755): Promise<void> => {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "adapter"), `#!/bin/sh\necho ${label}\n`, { mode });
    };
    await writeAdapter(scratch, "current-directory");
    await writeAdapter(path.join(scratch, "relative-bin"), "relative-bin");
    await writeAdapter(path.join(scratch, "elsewhere"), "elsewhere");
    await writeAdapter(path.join(scratch, "not-executable"), "not-executable", 0o644);
    const elsewhere = path.join(scratch, "elsewhere");
    const notExecutable = path.join(scratch, "not-executable");
    const cases = [
      { PATH: ":/usr/bin", expected: "current-directory" },
      { PATH: "/usr/bin:", expected: "current-directory" },
      { PATH: `/usr/bin::${elsewhere}`, expected: "current-directory" },
      { PATH: `${elsewhere}::/usr/bin`, expected: "elsewhere" },
      { PATH: "relative-bin:/usr/bin", expected: "relative-bin" },
      { PATH: `${notExecutable}::${elsewhere}`, expected: "current-directory" },
    ];
    process.chdir(scratch);
    try {
      for (const { PATH, expected } of cases) {
        const service = createProcessService({ envPolicy: { stripAmbient: [] }, baseEnv: { PATH } });
        const resolved = await service.resolveExecutable("adapter");
        const child = await service.spawn({ command: "adapter", stdin: "ignore" });
        const ran = (await readAll(child.stdout)).trim();
        await service.dispose();
        assert.equal(ran, expected, `spawn with PATH=${PATH}`);
        const expectedFile = expected === "current-directory" ? path.join(scratch, "adapter") : path.join(scratch, expected, "adapter");
        assert.equal(resolved, expectedFile, `resolveExecutable with PATH=${PATH}`);
      }
      // With no PATH at all, spawn and resolveExecutable both search /usr/bin:/bin.
      const noPath = createProcessService({ envPolicy: { stripAmbient: ["PATH"] }, baseEnv: { PATH: elsewhere } });
      const shell = await noPath.resolveExecutable("sh");
      assert.ok(shell === "/usr/bin/sh" || shell === "/bin/sh", `sh resolved to ${shell}`);
      assert.equal(await noPath.resolveExecutable("adapter"), null);
      const child = await noPath.spawn({ command: "sh", args: ["-c", "echo ok"], stdin: "ignore" });
      assert.equal((await readAll(child.stdout)).trim(), "ok");
      await noPath.dispose();
    } finally {
      process.chdir(previousDirectory);
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  test("a PATH entry with `..` after a symbolic link is searched as the operating system reads it", async () => {
    const layout = await createSymlinkedRoot("ari-path-symlink-");
    try {
      await fs.mkdir(layout.real("bin"), { recursive: true });
      const realFile = layout.real("bin/ari-probe-adapter");
      await fs.writeFile(realFile, "#!/bin/sh\necho release adapter\n", { mode: 0o755 });
      const searchPath = `${layout.throughSymlink("bin")}:/usr/bin`;
      const service = createProcessService({ envPolicy: { stripAmbient: [] }, baseEnv: { PATH: searchPath } });
      const byName = await service.spawn({ command: "ari-probe-adapter", stdin: "ignore" });
      assert.equal((await readAll(byName.stdout)).trim(), "release adapter", "spawn finds the release's executable");
      const fromBaseEnv = await service.resolveExecutable("ari-probe-adapter");
      const fromOption = await service.resolveExecutable("ari-probe-adapter", { path: searchPath });
      for (const resolved of [fromBaseEnv, fromOption]) {
        assert.ok(resolved !== null, "resolveExecutable finds the executable spawn runs");
        assert.equal(await fs.realpath(resolved), realFile, "the returned path names the release's executable");
        const byPath = await service.spawn({ command: resolved, stdin: "ignore" });
        assert.equal((await readAll(byPath.stdout)).trim(), "release adapter", "running the returned path runs the same file");
      }
      await service.dispose();
    } finally {
      await fs.rm(layout.root, { recursive: true, force: true });
    }
  });
});

describe("ari/node adapter installer", () => {
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

  test("a cache dir with `..` after a symbolic link is used as the operating system reads it", async () => {
    const layout = await createSymlinkedRoot("ari-installer-symlink-");
    try {
      const installer = createAdapterInstaller({ cacheDir: layout.throughSymlink("cache"), fetchTarball: fromFile(packedTarball) });
      const lease = await installer.lease(PKG, "1.0.0");
      await installer.install(PKG, "2.0.0");
      await assertCompleteInstall(lease.dir);
      assert.equal(await fs.realpath(lease.dir), layout.real("cache/adapters/@ari-test/fake-adapter/1.0.0"));
      assert.deepEqual((await installer.cleanup()).map((entry) => entry.version), ["2.0.0"], "cleanup finds the lease in the real cache");
      await assertCompleteInstall(lease.dir);
      assert.deepEqual(await packageEntries(layout.real("cache/adapters/@ari-test/fake-adapter")), ["1.0.0"]);
      assert.equal(await exists(layout.collapsed("cache")), false, "nothing is written where lexical normalization points");
      await lease.release();
    } finally {
      await fs.rm(layout.root, { recursive: true, force: true });
    }
  });
});
