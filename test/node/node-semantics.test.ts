// Node's results under both Node and Bun: paths follow symlinks before `..`,
// and an empty or relative PATH entry is searched from the child's directory.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { createCoordination, createInstanceDirectories, createNodeHostServices, createProcessService, instancePaths } from "../../src/node/index.ts";
import { createSymlinkedRoot, exists } from "../helpers/symlinked-root.ts";

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += Buffer.from(chunk).toString("utf8");
  return text;
}

// stat asks the OS which file each spelling names. Bun's own realpath can
// collapse a symlink followed by `..` before asking the OS.
async function assertSameFile(actual: string, expected: string): Promise<void> {
  const [a, b] = await Promise.all([fs.stat(actual), fs.stat(expected)]);
  assert.deepEqual([a.dev, a.ino], [b.dev, b.ino], `${actual} names ${expected}`);
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
    }).catch(async (error: unknown) => {
      await fs.rm(layout.root, { recursive: true, force: true });
      throw error;
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
      await assertSameFile(paths.stateDir, layout.real("host/instances/x/state"));
      await assertSameFile(paths.cacheDir, layout.real("host/instances/x/cache"));
      await assertSameFile(paths.tmpDir, layout.real("host/instances/x/tmp"));
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
      { PATH: "", expected: "current-directory" },
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
        await assertSameFile(resolved, realFile);
        const byPath = await service.spawn({ command: resolved, stdin: "ignore" });
        assert.equal((await readAll(byPath.stdout)).trim(), "release adapter", "running the returned path runs the same file");
      }
      await service.dispose();
    } finally {
      await fs.rm(layout.root, { recursive: true, force: true });
    }
  });
});
