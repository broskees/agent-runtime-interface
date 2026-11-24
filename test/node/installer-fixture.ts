// The installer tests' fixture: a throwaway package that `npm pack` turns
// into a tarball, so the installer reads the format npm publishes, and the
// helpers that check what an install left behind. test/node/installer.test.ts
// and test/node/node-semantics.test.ts share it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import type { TarballFetch } from "../../src/node/index.ts";

const run = promisify(execFile);
export const PKG = "@ari-test/fake-adapter";
const LONG_DIRECTORY = `lib/${"very-long-directory-name-".repeat(5)}`;
export const CHUNK_FILES = 48;

export let scratch: string;
/** The gzip tarball `npm pack` made. */
export let packedTarball: string;
/** The same archive, uncompressed, so that half of its bytes is half of its files. */
export let plainTarball: string;
let fileContents: Map<string, string>;

async function makeFixturePackage(): Promise<void> {
  const packageDir = path.join(scratch, "fixture-package");
  fileContents = new Map();
  const add = async (relative: string, content: string, mode = 0o644): Promise<void> => {
    await fs.mkdir(path.join(packageDir, path.dirname(relative)), { recursive: true });
    await fs.writeFile(path.join(packageDir, relative), content, { mode });
    fileContents.set(relative, content);
  };
  await add("package.json", JSON.stringify({ name: PKG, version: "1.0.0", bin: { "fake-adapter": "bin/agent.js" } }));
  await add("bin/agent.js", "#!/usr/bin/env node\nconsole.log('fake adapter');\n", 0o755);
  await add(`${LONG_DIRECTORY}/data.txt`, "a file whose path is longer than 100 bytes\n");
  for (let index = 0; index < CHUNK_FILES; index += 1) {
    const name = `lib/chunk-${String(index).padStart(3, "0")}.txt`;
    // Distinct, poorly compressible content, so the files are spread through the archive.
    await add(name, createHash("sha512").update(name).digest("hex").repeat(64));
  }
  const home = path.join(scratch, "npm-home");
  await fs.mkdir(home);
  const { stdout } = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], {
    cwd: packageDir,
    env: { PATH: process.env.PATH, HOME: home, npm_config_cache: path.join(home, ".npm"), npm_config_update_notifier: "false" },
  });
  const [{ filename }] = JSON.parse(stdout) as [{ filename: string }];
  packedTarball = path.join(scratch, filename);
  plainTarball = path.join(scratch, "fixture.tar");
  await fs.writeFile(plainTarball, gunzipSync(await fs.readFile(packedTarball)));
}

/** Makes the scratch directory and the fixture tarballs; call it from a `before` hook. */
export async function setUpInstallerFixture(): Promise<void> {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ari-installer-"));
  await makeFixturePackage();
}

/** Removes the scratch directory and everything under it; call it from an `after` hook. */
export async function removeInstallerFixture(): Promise<void> {
  await fs.rm(scratch, { recursive: true, force: true });
}

// Joined with "/" rather than path.join, which would collapse a `..` that `dir` may hold on purpose.
export async function assertCompleteInstall(dir: string): Promise<void> {
  for (const [relative, content] of fileContents) {
    assert.equal(await fs.readFile(`${dir}/${relative}`, "utf8"), content, relative);
  }
  const agentMode = (await fs.stat(`${dir}/bin/agent.js`)).mode;
  assert.equal(agentMode & 0o100, 0o100, "the bin file stays executable");
}

export const fromFile = (file: string): TarballFetch => () => createReadStream(file);

// The installer's own bookkeeping directories: version locks and lease files.
const BOOKKEEPING = new Set([".locks", ".leases"]);

/** What a package directory holds besides bookkeeping: installed versions and any staging or trash left behind. */
export async function packageEntries(packageDir: string): Promise<string[]> {
  return (await fs.readdir(packageDir)).filter((name) => !BOOKKEEPING.has(name)).sort();
}

export async function newCacheDir(): Promise<string> {
  return fs.mkdtemp(path.join(scratch, "cache-"));
}
