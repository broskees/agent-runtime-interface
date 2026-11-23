// File-backed secrets in `ari/node`: bytes in and out by (namespace, key),
// files mode 0600 in directories mode 0700 under the state dir, no reading
// across namespaces, `..` and `/` refused, and two processes writing one key
// at once leave one complete value.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import { isAriError } from "../../src/index.ts";
import { createFileSecrets } from "../../src/node/index.ts";
import { REPO_ROOT } from "../helpers/spec.ts";
import { createSymlinkedRoot, exists } from "../helpers/symlinked-root.ts";

const run = promisify(execFile);
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

async function directoriesBetween(root: string, file: string): Promise<string[]> {
  const directories: string[] = [];
  for (let directory = path.dirname(file); directory.startsWith(root) && directory !== root; directory = path.dirname(directory)) {
    directories.push(directory);
  }
  return directories;
}

describe("ari/node file-backed secrets", () => {
  let scratch: string;
  let stateDir: string;

  before(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ari-secrets-"));
  });
  after(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  const freshStateDir = async (): Promise<string> => {
    stateDir = await fs.mkdtemp(path.join(scratch, "state-"));
    return stateDir;
  };

  test("get, set and delete by namespace and key, as bytes", async () => {
    const secrets = createFileSecrets({ stateDir: await freshStateDir() });
    assert.equal(await secrets.get("claude", "api-key"), null);
    const value = Uint8Array.from([0, 1, 2, 250, 255]);
    await secrets.set("claude", "api-key", value);
    const read = await secrets.get("claude", "api-key");
    assert.ok(read instanceof Uint8Array);
    assert.deepEqual([...read], [...value]);
    await secrets.set("claude", "api-key", bytes("replaced"));
    assert.equal(Buffer.from((await secrets.get("claude", "api-key"))!).toString(), "replaced");
    await secrets.delete("claude", "api-key");
    assert.equal(await secrets.get("claude", "api-key"), null);
    await secrets.delete("claude", "api-key");
  });

  test("files are mode 0600 in directories mode 0700 under the state dir", async () => {
    const root = await freshStateDir();
    // A secrets directory that already exists with a wider mode is narrowed.
    await fs.mkdir(path.join(root, "secrets"), { mode: 0o755 });
    await fs.chmod(path.join(root, "secrets"), 0o755);
    const secrets = createFileSecrets({ stateDir: root });
    await secrets.set("codex", "token", bytes("t0ken"));
    await secrets.set("Mixed.Case ns", "key with spaces", bytes("v"));

    const files = await filesUnder(root);
    assert.equal(files.length, 2);
    for (const file of files) {
      assert.ok(!path.relative(root, file).startsWith(".."), `${file} is under the state dir`);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600, `${file} is mode 0600`);
      for (const directory of await directoriesBetween(root, file)) {
        assert.equal((await fs.stat(directory)).mode & 0o777, 0o700, `${directory} is mode 0700`);
      }
    }
  });

  test("a key in one namespace cannot be read through another", async () => {
    const secrets = createFileSecrets({ stateDir: await freshStateDir() });
    await secrets.set("alpha", "token", bytes("alpha-secret"));
    assert.equal(await secrets.get("beta", "token"), null);
    // Names that differ only by case or by characters a file system treats specially stay apart.
    for (const other of ["Alpha", "ALPHA", "alpha.", "alpha%2E", "alpha ", "alph", "alpha\\"]) {
      assert.equal(await secrets.get(other, "token"), null, `namespace ${JSON.stringify(other)}`);
    }
    await secrets.set("beta", "token", bytes("beta-secret"));
    await secrets.set("Alpha", "token", bytes("upper-secret"));
    assert.equal(Buffer.from((await secrets.get("alpha", "token"))!).toString(), "alpha-secret");
    assert.equal(Buffer.from((await secrets.get("beta", "token"))!).toString(), "beta-secret");
    assert.equal(Buffer.from((await secrets.get("Alpha", "token"))!).toString(), "upper-secret");
    await secrets.delete("beta", "token");
    assert.equal(Buffer.from((await secrets.get("alpha", "token"))!).toString(), "alpha-secret");
  });

  test("a namespace or key containing `..` or `/` is refused and nothing is written", async () => {
    const root = await freshStateDir();
    const secrets = createFileSecrets({ stateDir: root });
    const besideStateDir = await fs.readdir(scratch);
    const badNames = ["..", "../escape", "a/b", "/absolute", "x..y", "../../etc/passwd", ""];
    for (const bad of badNames) {
      await assert.rejects(secrets.set(bad, "key", bytes("v")), (error: unknown) => isAriError(error, "validation"), `set namespace ${bad}`);
      await assert.rejects(secrets.set("namespace", bad, bytes("v")), (error: unknown) => isAriError(error, "validation"), `set key ${bad}`);
      await assert.rejects(secrets.get(bad, "key"), (error: unknown) => isAriError(error, "validation"), `get namespace ${bad}`);
      await assert.rejects(secrets.get("namespace", bad), (error: unknown) => isAriError(error, "validation"), `get key ${bad}`);
      await assert.rejects(secrets.delete(bad, "key"), (error: unknown) => isAriError(error, "validation"), `delete namespace ${bad}`);
      await assert.rejects(secrets.delete("namespace", bad), (error: unknown) => isAriError(error, "validation"), `delete key ${bad}`);
    }
    assert.deepEqual(await fs.readdir(root), []);
    assert.deepEqual(await fs.readdir(scratch), besideStateDir, "nothing appeared beside the state dir");
  });

  test("a state dir with `..` after a symbolic link is used as the operating system reads it", async () => {
    const layout = await createSymlinkedRoot("ari-secrets-symlink-");
    try {
      const secrets = createFileSecrets({ stateDir: layout.throughSymlink("state") });
      await secrets.set("codex", "token", bytes("t0ken"));
      assert.equal(Buffer.from((await secrets.get("codex", "token"))!).toString(), "t0ken");
      const files = await filesUnder(layout.real("state"));
      assert.equal(files.length, 1, "the secret is under the real state dir");
      assert.equal((await fs.stat(files[0]!)).mode & 0o777, 0o600);
      assert.equal(await exists(layout.collapsed("state")), false, "nothing is written where lexical normalization points");
    } finally {
      await fs.rm(layout.root, { recursive: true, force: true });
    }
  });

  test("two processes writing the same key at once leave a complete value from one of them", async () => {
    const root = await freshStateDir();
    const secretsModule = pathToFileURL(path.join(REPO_ROOT, "src", "node", "secrets.ts")).href;
    const size = 512 * 1024;
    const writer = (letter: string): string =>
      [
        `const { createFileSecrets } = await import(${JSON.stringify(secretsModule)});`,
        `const secrets = createFileSecrets({ stateDir: ${JSON.stringify(root)} });`,
        `const value = new Uint8Array(${size}).fill(${letter.charCodeAt(0)});`,
        "for (let round = 0; round < 40; round += 1) await secrets.set('shared', 'token', value);",
      ].join("\n");
    const secrets = createFileSecrets({ stateDir: root });
    const writers = Promise.all(
      ["a", "b"].map((letter) => run(process.execPath, ["--input-type=module", "-e", writer(letter)], { cwd: REPO_ROOT })),
    );
    // Read while both write: every value seen is whole.
    let done = false;
    void writers.finally(() => {
      done = true;
    });
    let reads = 0;
    while (!done) {
      const value = await secrets.get("shared", "token");
      if (value !== null) {
        reads += 1;
        assert.equal(value.length, size, "a read during the writes saw a whole value");
        assert.ok(value.every((byte) => byte === value[0]), "a read during the writes saw one writer's value");
      }
    }
    await writers;
    const final = await secrets.get("shared", "token");
    assert.ok(final !== null);
    assert.equal(final.length, size);
    assert.ok(final[0] === 0x61 || final[0] === 0x62);
    assert.ok(final.every((byte) => byte === final[0]), "the final value is one writer's value, whole");
    assert.equal((await filesUnder(root)).length, 1, "no temporary file is left behind");
    assert.ok(reads > 0, "the reader overlapped the writers");
  });
});
