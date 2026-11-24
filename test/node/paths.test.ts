// Per-instance paths in `ari/node`: every instance gets its own stateDir,
// cacheDir and tmpDir under the host root, and no two instance IDs share or
// nest a directory, even IDs that differ only by case or by characters a file
// system treats specially.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { isAriError } from "../../src/index.ts";
import { createInstanceDirectories, instancePaths } from "../../src/node/index.ts";

const TRICKY_INSTANCE_IDS = ["a", "b", "A", "a/b", "a_b", "a%2Fb", "a.b", ".", "..", "../a", "a\\b", "codex:work", "Codex:Work", "ünï-cödé", " a"];

/** True when one path is the other or lies inside it. */
function overlaps(left: string, right: string): boolean {
  const inside = (outer: string, inner: string): boolean => {
    const relative = path.relative(outer, inner);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  return inside(left, right) || inside(right, left);
}

describe("ari/node instance paths", () => {
  test("each instance has its own stateDir, cacheDir and tmpDir under the host root", () => {
    const root = path.join(os.tmpdir(), "ari-host-root");
    const paths = instancePaths(root, "claude-personal");
    for (const directory of [paths.stateDir, paths.cacheDir, paths.tmpDir]) {
      const relative = path.relative(root, directory);
      assert.ok(relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative), `${directory} is under the root`);
    }
    assert.equal(new Set([paths.stateDir, paths.cacheDir, paths.tmpDir]).size, 3);
    assert.equal(overlaps(paths.stateDir, paths.cacheDir) || overlaps(paths.stateDir, paths.tmpDir) || overlaps(paths.cacheDir, paths.tmpDir), false);
    assert.deepEqual(instancePaths(root, "claude-personal"), paths, "the same ID always gets the same paths");
  });

  test("no directory of one instance overlaps any directory of another, even ignoring letter case", () => {
    const root = path.join(os.tmpdir(), "ari-host-root");
    const all = TRICKY_INSTANCE_IDS.map((id) => ({ id, paths: instancePaths(root, id) }));
    for (const left of all) {
      for (const right of all) {
        if (left.id === right.id) continue;
        for (const leftDirectory of Object.values(left.paths)) {
          for (const rightDirectory of Object.values(right.paths)) {
            assert.equal(overlaps(leftDirectory, rightDirectory), false, `${left.id} ${leftDirectory} vs ${right.id} ${rightDirectory}`);
            assert.notEqual(leftDirectory.toLowerCase(), rightDirectory.toLowerCase(), `${left.id} vs ${right.id} on a case-insensitive file system`);
          }
        }
      }
    }
  });

  test("createInstanceDirectories makes the directories, mode 0700, and two instances write apart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ari-paths-"));
    try {
      const first = instancePaths(root, "x");
      const second = instancePaths(root, "X");
      await createInstanceDirectories(first);
      await createInstanceDirectories(second);
      for (const directory of [...Object.values(first), ...Object.values(second)]) {
        const stats = await fs.stat(directory);
        assert.ok(stats.isDirectory());
        assert.equal(stats.mode & 0o777, 0o700, directory);
      }
      await fs.writeFile(path.join(first.stateDir, "marker"), "first");
      assert.deepEqual(await fs.readdir(second.stateDir), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("an empty instance ID is refused", () => {
    assert.throws(() => instancePaths("/tmp/root", ""), (error: unknown) => isAriError(error, "validation"));
  });
});
