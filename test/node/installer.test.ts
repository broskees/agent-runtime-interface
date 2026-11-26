// The managed adapter installer in `ari/node`: it installs a package version
// into `<cacheDir>/adapters/<pkg>/<version>` from a tarball supplied by a
// pluggable fetch, never running `npx`. The final path either does not exist
// or holds a complete install, even when the installing process is killed
// midway. Concurrent installs of one version, from one installer object,
// several objects or several processes, share the first result. Cleanup keeps
// versions held by a lease, and never moves a version while a lease on it is
// being handed out.
//
// The fixture tarball is made by `npm pack` from a throwaway package, so the
// installer reads the format npm publishes (test/node/installer-fixture.ts).
// The two installer tests that need Node's own fs semantics are in
// test/node/node-semantics.test.ts, which the Bun run leaves out.

import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import { isAriError } from "../../src/index.ts";
import { createAdapterInstaller, extractTarball, npmRegistryFetch } from "../../src/node/index.ts";
import type { TarballFetch } from "../../src/node/index.ts";
import { REPO_ROOT } from "../helpers/spec.ts";
import { createSymlinkedRoot, exists } from "../helpers/symlinked-root.ts";
import {
  CHUNK_FILES,
  PKG,
  assertCompleteInstall,
  fromFile,
  newCacheDir,
  packageEntries,
  packedTarball,
  plainTarball,
  removeInstallerFixture,
  scratch,
  setUpInstallerFixture,
} from "./installer-fixture.ts";

const run = promisify(execFile);
const INSTALLER_MODULE = pathToFileURL(path.join(REPO_ROOT, "src", "node", "installer.ts")).href;

/** A fetch that yields the file in 4 KiB chunks, pausing `delayMs` between them, and counts its calls. */
function slowFetch(file: string, delayMs: number): { fetch: TarballFetch; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: async function* () {
      calls += 1;
      const content = await fs.readFile(file);
      for (let offset = 0; offset < content.length; offset += 4096) {
        yield content.subarray(offset, offset + 4096);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    },
  };
}

/** Runs an ES module script in a child Node process, with PATH and HOME set by the caller. */
function startNode(script: string, env: Record<string, string | undefined> = {}): ChildProcess {
  return spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: scratch, ...env },
  });
}

function waitForLine(child: ChildProcess, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.split("\n").includes(line)) resolve();
    });
    child.once("exit", (code) => reject(new Error(`the child exited (${code}) before printing "${line}": ${output} ${errors}`)));
  });
}

async function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

// A minimal ustar writer for archives npm would never produce: escaping
// paths, links and broken headers.
interface CraftedEntry {
  name: string;
  type?: "0" | "2" | "5";
  content?: string;
  linkName?: string;
}

function craftTar(entries: CraftedEntry[], options: { endMarker?: boolean } = {}): Uint8Array {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const entry of entries) {
    const content = encoder.encode(entry.content ?? "");
    const header = new Uint8Array(512);
    const put = (offset: number, text: string): void => header.set(encoder.encode(text), offset);
    const octal = (offset: number, length: number, value: number): void => put(offset, value.toString(8).padStart(length - 1, "0"));
    put(0, entry.name);
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, content.length);
    octal(136, 12, 0);
    put(156, entry.type ?? "0");
    put(157, entry.linkName ?? "");
    put(257, "ustar\u000000");
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    put(148, `${checksum.toString(8).padStart(6, "0")}\u0000 `);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
    padded.set(content);
    blocks.push(padded);
  }
  if (options.endMarker !== false) blocks.push(new Uint8Array(1024));
  const archive = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return archive;
}

async function* yieldOnce(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

describe("ari/node adapter installer", () => {
  before(setUpInstallerFixture);
  after(removeInstallerFixture);

  test("installs a version from a local tarball into <cacheDir>/adapters/<pkg>/<version>", async () => {
    const cacheDir = await newCacheDir();
    const installer = createAdapterInstaller({ cacheDir, fetchTarball: fromFile(packedTarball) });
    const installed = await installer.install(PKG, "1.0.0");
    const expected = path.join(cacheDir, "adapters", "@ari-test", "fake-adapter", "1.0.0");
    assert.deepEqual(installed, { pkg: PKG, version: "1.0.0", dir: expected });
    assert.equal(installer.pathFor(PKG, "1.0.0"), expected);
    await assertCompleteInstall(expected);
    assert.deepEqual(await packageEntries(path.dirname(expected)), ["1.0.0"], "no staging directory is left");

    // Installing again reuses the install without fetching.
    const again = createAdapterInstaller({
      cacheDir,
      fetchTarball: () => {
        throw new Error("fetched an installed version");
      },
    });
    assert.deepEqual(await again.install(PKG, "1.0.0"), installed);
  });

  test("a concurrent second install of the same version reuses the first result", async () => {
    const cacheDir = await newCacheDir();
    const slow = slowFetch(packedTarball, 5);
    const installer = createAdapterInstaller({ cacheDir, fetchTarball: slow.fetch });
    const first = installer.install(PKG, "1.0.0");
    const second = installer.install(PKG, "1.0.0");
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(secondResult, firstResult);
    assert.equal(slow.calls(), 1, "the tarball was fetched once");
    await assertCompleteInstall(firstResult.dir);
  });

  test("a concurrent install through a second installer object on the same cache reuses the first result", async () => {
    const cacheDir = await newCacheDir();
    let releaseFirstFetch = (): void => {};
    let firstFetchStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      firstFetchStarted = resolve;
    });
    const content = await fs.readFile(packedTarball);
    const first = createAdapterInstaller({
      cacheDir,
      fetchTarball: async function* () {
        firstFetchStarted();
        await new Promise<void>((resolve) => {
          releaseFirstFetch = resolve;
        });
        yield content;
      },
    });
    let secondFetches = 0;
    const second = createAdapterInstaller({
      cacheDir,
      fetchTarball: () => {
        secondFetches += 1;
        throw new Error("temporary HTTP 503");
      },
    });
    const firstInstall = first.install(PKG, "1.0.0");
    await started;
    const secondInstall = second.install(PKG, "1.0.0");
    await new Promise((resolve) => setTimeout(resolve, 150));
    releaseFirstFetch();
    const [firstResult, secondResult] = await Promise.all([firstInstall, secondInstall]);
    assert.deepEqual(secondResult, firstResult);
    assert.equal(secondFetches, 0, "the second object waited for the first install instead of fetching");
    await assertCompleteInstall(firstResult.dir);
  });

  test("two processes installing one version at once share one fetch, and neither runs a package manager", async () => {
    const cacheDir = await newCacheDir();
    const markers = await fs.mkdtemp(path.join(scratch, "markers-"));
    // A PATH whose only commands record that they ran. The record is a shell
    // redirect, so it needs no other command on PATH.
    const trap = await fs.mkdtemp(path.join(scratch, "trap-"));
    const trapCommands = ["npx", "npm", "pnpm", "yarn", "tar"];
    for (const command of trapCommands) {
      await fs.writeFile(path.join(trap, command), `#!/bin/sh\n: > "${markers}/ran-${command}"\nexit 1\n`, { mode: 0o755 });
    }
    // Prove the trap fires with this PATH, then clear its record.
    assert.throws(() => execFileSync("npx", ["-y", "anything"], { env: { PATH: trap }, stdio: "ignore" }));
    assert.deepEqual(await fs.readdir(markers), ["ran-npx"]);
    await fs.rm(path.join(markers, "ran-npx"));

    const script = [
      `const { createAdapterInstaller } = await import(${JSON.stringify(INSTALLER_MODULE)});`,
      "const fs = await import('node:fs');",
      `const content = fs.readFileSync(${JSON.stringify(packedTarball)});`,
      "async function* fetchTarball() {",
      `  fs.writeFileSync(${JSON.stringify(markers)} + '/fetched-' + process.pid, '');`,
      "  for (let offset = 0; offset < content.length; offset += 2048) {",
      "    yield content.subarray(offset, offset + 2048);",
      "    await new Promise((resolve) => setTimeout(resolve, 3));",
      "  }",
      "}",
      `const installer = createAdapterInstaller({ cacheDir: ${JSON.stringify(cacheDir)}, fetchTarball });`,
      `const installed = await installer.install(${JSON.stringify(PKG)}, '1.0.0');`,
      "process.stdout.write(JSON.stringify(installed));",
    ].join("\n");
    const children = [startNode(script, { PATH: trap }), startNode(script, { PATH: trap })];
    const outputs = await Promise.all(
      children.map(async (child) => {
        let output = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        const exit = await exitOf(child);
        assert.deepEqual(exit, { code: 0, signal: null });
        return JSON.parse(output) as { dir: string };
      }),
    );
    assert.equal(outputs[0]!.dir, outputs[1]!.dir);
    await assertCompleteInstall(outputs[0]!.dir);
    assert.deepEqual(await packageEntries(path.dirname(outputs[0]!.dir)), ["1.0.0"], "no staging copy is left");
    const records = await fs.readdir(markers);
    assert.equal(records.filter((name) => name.startsWith("fetched-")).length, 1, "the tarball was fetched once across both processes");
    assert.deepEqual(records.filter((name) => name.startsWith("ran-")), [], "no package manager command ran");
  });

  test("an install killed midway leaves nothing at the final path", async () => {
    const cacheDir = await newCacheDir();
    const script = [
      `const { createAdapterInstaller } = await import(${JSON.stringify(INSTALLER_MODULE)});`,
      "const fs = await import('node:fs');",
      `const content = fs.readFileSync(${JSON.stringify(plainTarball)});`,
      "setInterval(() => {}, 1000);",
      "async function* fetchTarball() {",
      "  const half = Math.floor(content.length / 2);",
      "  for (let offset = 0; offset < half; offset += 4096) yield content.subarray(offset, Math.min(offset + 4096, half));",
      "  process.stdout.write('midway\\n');",
      "  await new Promise(() => {});",
      "}",
      `const installer = createAdapterInstaller({ cacheDir: ${JSON.stringify(cacheDir)}, fetchTarball });`,
      `await installer.install(${JSON.stringify(PKG)}, '1.0.0');`,
      "process.stdout.write('finished\\n');",
    ].join("\n");
    const child = startNode(script);
    await waitForLine(child, "midway");
    const packageDir = path.join(cacheDir, "adapters", "@ari-test", "fake-adapter");
    const finalDir = path.join(packageDir, "1.0.0");

    // Wait until the extraction has written part of the package, wherever it writes.
    const extractedChunks = async (): Promise<string[]> => {
      const entries = await fs.readdir(packageDir, { recursive: true }).catch(() => [] as string[]);
      return entries.filter((entry) => /chunk-\d+\.txt$/.test(entry));
    };
    let chunks: string[] = [];
    for (let attempt = 0; attempt < 250 && chunks.length === 0; attempt += 1) {
      chunks = await extractedChunks();
      if (chunks.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(chunks.length > 0, "the install was midway: some files were extracted");
    assert.ok(chunks.length < CHUNK_FILES, "the install was midway: not every file was extracted");

    child.kill("SIGKILL");
    assert.equal((await exitOf(child)).signal, "SIGKILL");
    assert.equal(await fs.stat(finalDir).then(() => true, () => false), false, "nothing is at the final path after the kill");

    // Cleanup removes the dead process's staging; a later install succeeds.
    const installer = createAdapterInstaller({ cacheDir, fetchTarball: fromFile(packedTarball) });
    assert.deepEqual(await installer.cleanup(), []);
    assert.deepEqual(await packageEntries(packageDir), []);
    await assertCompleteInstall((await installer.install(PKG, "1.0.0")).dir);
  });

  test("an install that fails midway in this process leaves nothing behind", async () => {
    const cacheDir = await newCacheDir();
    const content = await fs.readFile(plainTarball);
    const installer = createAdapterInstaller({
      cacheDir,
      fetchTarball: async function* () {
        yield content.subarray(0, Math.floor(content.length / 2));
        throw new Error("connection reset");
      },
    });
    await assert.rejects(installer.install(PKG, "1.0.0"), /connection reset/);
    assert.deepEqual(await packageEntries(path.join(cacheDir, "adapters", "@ari-test", "fake-adapter")), []);
  });

  test("cleanup keeps a version held by a lease and removes one that is not held", async () => {
    const cacheDir = await newCacheDir();
    const installer = createAdapterInstaller({ cacheDir, fetchTarball: fromFile(packedTarball) });
    const held = await installer.lease(PKG, "1.0.0");
    await installer.install(PKG, "2.0.0");
    await assertCompleteInstall(held.dir);

    const removed = await installer.cleanup();
    assert.deepEqual(removed.map((entry) => entry.version), ["2.0.0"]);
    assert.equal(await fs.stat(installer.pathFor(PKG, "2.0.0")).then(() => true, () => false), false);
    await assertCompleteInstall(held.dir);

    await held.release();
    await held.release();
    assert.deepEqual((await installer.cleanup()).map((entry) => entry.version), ["1.0.0"]);
    assert.equal(await fs.stat(held.dir).then(() => true, () => false), false);
  });

  test("four processes leasing, releasing and cleaning one version never fetch at once or lose a leased version", async () => {
    const cacheDir = await newCacheDir();
    const markers = await fs.mkdtemp(path.join(scratch, "stress-"));
    const script = [
      `const { createAdapterInstaller } = await import(${JSON.stringify(INSTALLER_MODULE)});`,
      "const fs = await import('node:fs');",
      `const markers = ${JSON.stringify(markers)};`,
      `const content = fs.readFileSync(${JSON.stringify(packedTarball)});`,
      "const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
      "async function* fetchTarball() {",
      "  // Only one fetch of this version may run at a time, across every process.",
      "  try { fs.writeFileSync(markers + '/inside', String(process.pid), { flag: 'wx' }); } catch { process.stdout.write('overlap\\n'); }",
      "  fs.writeFileSync(markers + '/fetch-' + process.pid + '-' + Math.random(), '');",
      "  await pause(10);",
      "  yield content;",
      "  fs.rmSync(markers + '/inside', { force: true });",
      "}",
      `const installer = createAdapterInstaller({ cacheDir: ${JSON.stringify(cacheDir)}, fetchTarball });`,
      "for (let round = 0; round < 8; round += 1) {",
      `  const lease = await installer.lease(${JSON.stringify(PKG)}, '1.0.0');`,
      "  // A held lease's files stay readable however the other processes clean up.",
      "  fs.readFileSync(lease.dir + '/bin/agent.js');",
      "  await pause(5);",
      "  fs.readFileSync(lease.dir + '/package.json');",
      "  await lease.release();",
      "  await installer.cleanup();",
      "}",
      "process.stdout.write('done\\n');",
    ].join("\n");
    const children = Array.from({ length: 4 }, () => startNode(script));
    const outputs = await Promise.all(
      children.map(async (child) => {
        let output = "";
        let errors = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          errors += chunk.toString();
        });
        assert.deepEqual(await exitOf(child), { code: 0, signal: null }, errors);
        return output;
      }),
    );
    for (const output of outputs) assert.equal(output, "done\n");
    const fetches = (await fs.readdir(markers)).filter((name) => name.startsWith("fetch-"));
    assert.ok(fetches.length >= 1, `fetched ${fetches.length} times`);
    const packageDir = path.join(cacheDir, "adapters", "@ari-test", "fake-adapter");
    const left = (await packageEntries(packageDir)).filter((name) => name !== "1.0.0");
    assert.deepEqual(left, [], "no staging or trash is left");
  });

  test("a lease held by another live process protects its version until that process ends", async () => {
    const cacheDir = await newCacheDir();
    const installer = createAdapterInstaller({ cacheDir, fetchTarball: fromFile(packedTarball) });
    const script = [
      `const { createAdapterInstaller } = await import(${JSON.stringify(INSTALLER_MODULE)});`,
      "const { createReadStream } = await import('node:fs');",
      `const installer = createAdapterInstaller({ cacheDir: ${JSON.stringify(cacheDir)}, fetchTarball: () => createReadStream(${JSON.stringify(packedTarball)}) });`,
      `await installer.lease(${JSON.stringify(PKG)}, '3.0.0');`,
      "process.stdout.write('leased\\n');",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const holder = startNode(script);
    await waitForLine(holder, "leased");
    await installer.install(PKG, "4.0.0");

    assert.deepEqual((await installer.cleanup()).map((entry) => entry.version), ["4.0.0"]);
    await assertCompleteInstall(installer.pathFor(PKG, "3.0.0"));

    holder.kill("SIGKILL");
    await exitOf(holder);
    assert.deepEqual((await installer.cleanup()).map((entry) => entry.version), ["3.0.0"], "a dead process's lease no longer holds");
  });

  test("cleanup keeps what `keep` asks for", async () => {
    const cacheDir = await newCacheDir();
    const installer = createAdapterInstaller({ cacheDir, fetchTarball: fromFile(packedTarball) });
    await installer.install(PKG, "1.0.0");
    await installer.install(PKG, "2.0.0");
    const removed = await installer.cleanup({ keep: (pkg, version) => pkg === PKG && version === "2.0.0" });
    assert.deepEqual(removed.map((entry) => entry.version), ["1.0.0"]);
    await assertCompleteInstall(installer.pathFor(PKG, "2.0.0"));
  });

  test("a tarball extracts into a destination with `..` after a symbolic link as the operating system reads it", async () => {
    const layout = await createSymlinkedRoot("ari-tar-symlink-");
    try {
      await fs.mkdir(layout.real("extract"));
      await extractTarball(createReadStream(packedTarball), layout.throughSymlink("extract"));
      await assertCompleteInstall(layout.real("extract"));
      assert.equal(await exists(layout.collapsed("extract")), false);
    } finally {
      await fs.rm(layout.root, { recursive: true, force: true });
    }
  });

  test("the npm registry fetch checks the published digest", async () => {
    const tarball = await fs.readFile(packedTarball);
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    const wrongIntegrity = `sha512-${createHash("sha512").update("other bytes").digest("base64")}`;
    const requests: string[] = [];
    const server = http.createServer((request, response) => {
      requests.push(request.url ?? "");
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const manifests: Record<string, string> = {
        "/@ari-test%2Ffake-adapter/1.0.0": integrity,
        "/@ari-test%2Ffake-adapter/6.6.6": wrongIntegrity,
      };
      const digest = manifests[request.url ?? ""];
      if (digest !== undefined) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: PKG, dist: { tarball: `${base}/tarballs/fake-adapter.tgz`, integrity: digest } }));
      } else if (request.url === "/tarballs/fake-adapter.tgz") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(tarball);
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const cacheDir = await newCacheDir();
      const installer = createAdapterInstaller({ cacheDir, fetchTarball: npmRegistryFetch({ registry }) });
      await assertCompleteInstall((await installer.install(PKG, "1.0.0")).dir);

      await assert.rejects(installer.install(PKG, "6.6.6"), (error: unknown) => isAriError(error, "protocol"));
      assert.equal(await fs.stat(installer.pathFor(PKG, "6.6.6")).then(() => true, () => false), false);
      await assert.rejects(installer.install(PKG, "9.9.9"), (error: unknown) => isAriError(error, "not_found"));
      assert.deepEqual(await packageEntries(path.dirname(installer.pathFor(PKG, "1.0.0"))), ["1.0.0"]);
      assert.ok(requests.includes("/@ari-test%2Ffake-adapter/1.0.0"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("with strongIntegrityOnly, the npm registry fetch takes a sha512, sha384 or sha256 integrity and refuses sha1 and the shasum", async () => {
    const tarball = await fs.readFile(packedTarball);
    const digest = (algorithm: string, encoding: "base64" | "hex"): string => createHash(algorithm).update(tarball).digest(encoding);
    // Each version's manifest publishes one kind of digest, all of them matching the tarball.
    const dists: Record<string, { integrity?: string; shasum?: string }> = {
      "1.0.512": { integrity: `sha512-${digest("sha512", "base64")}` },
      "1.0.384": { integrity: `sha384-${digest("sha384", "base64")}` },
      "1.0.256": { integrity: `sha256-${digest("sha256", "base64")}` },
      "1.0.1": { integrity: `sha1-${digest("sha1", "base64")}`, shasum: digest("sha1", "hex") },
      "1.0.0": { shasum: digest("sha1", "hex") },
    };
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/tarball.tgz")) return new Response(tarball);
      const version = url.slice(url.lastIndexOf("/") + 1);
      return Response.json({ dist: { tarball: "http://registry.test/tarball.tgz", ...dists[version] } });
    }) as typeof globalThis.fetch;
    const strict = createAdapterInstaller({ cacheDir: await newCacheDir(), fetchTarball: npmRegistryFetch({ registry: "http://registry.test", fetch, strongIntegrityOnly: true }) });
    for (const version of ["1.0.512", "1.0.384", "1.0.256"]) await assertCompleteInstall((await strict.install(PKG, version)).dir);
    for (const version of ["1.0.1", "1.0.0"]) {
      await assert.rejects(strict.install(PKG, version), (error: unknown) => isAriError(error, "protocol") && (error as { callError: { detail?: string } }).callError.detail === "no_integrity");
      assert.equal(await exists(strict.pathFor(PKG, version)), false);
    }
    // Without the option, the shasum still counts, as before.
    const lenient = createAdapterInstaller({ cacheDir: await newCacheDir(), fetchTarball: npmRegistryFetch({ registry: "http://registry.test", fetch }) });
    await assertCompleteInstall((await lenient.install(PKG, "1.0.0")).dir);
  });

  test("prepare adds files to the staging directory before the rename, and a prepare that fails installs nothing", async () => {
    const cacheDir = await newCacheDir();
    const seen: string[] = [];
    const installer = createAdapterInstaller({
      cacheDir,
      fetchTarball: fromFile(packedTarball),
      prepare: async (staging) => {
        seen.push(staging.dir);
        assert.equal(await exists(installer.pathFor(PKG, staging.version)), false, "prepare runs before the version is published");
        if (staging.version === "6.6.6") throw new Error("prepare failed");
        await fs.writeFile(`${staging.dir}/prepared.txt`, `${staging.pkg}@${staging.version}`);
      },
    });
    const installed = await installer.install(PKG, "1.0.0");
    await assertCompleteInstall(installed.dir);
    assert.equal(await fs.readFile(`${installed.dir}/prepared.txt`, "utf8"), `${PKG}@1.0.0`);
    assert.match(path.basename(seen[0]!), /^\.staging-/);
    await assert.rejects(installer.install(PKG, "6.6.6"), /prepare failed/);
    assert.deepEqual(await packageEntries(path.dirname(installed.dir)), ["1.0.0"], "the failed staging directory is gone, and 6.6.6 is not installed");
  });

  test("isIntact replaces an install it calls broken and keeps a whole one; without it an existing directory counts as installed", async () => {
    const cacheDir = await newCacheDir();
    let fetches = 0;
    const counting: TarballFetch = (request) => {
      fetches += 1;
      return fromFile(packedTarball)(request);
    };
    const whole = async (installed: { dir: string }): Promise<boolean> => exists(`${installed.dir}/bin/agent.js`);
    const installer = createAdapterInstaller({ cacheDir, fetchTarball: counting, isIntact: whole });
    const installed = await installer.install(PKG, "1.0.0");
    await installer.install(PKG, "1.0.0");
    assert.equal(fetches, 1, "a whole install is kept");
    await fs.rm(`${installed.dir}/bin/agent.js`);
    // An installer without isIntact takes the broken directory as it is.
    const plain = createAdapterInstaller({ cacheDir, fetchTarball: counting });
    await plain.install(PKG, "1.0.0");
    assert.equal(fetches, 1);
    assert.equal(await exists(`${installed.dir}/bin/agent.js`), false);
    await installer.install(PKG, "1.0.0");
    assert.equal(fetches, 2, "the broken install was fetched again");
    await assertCompleteInstall(installed.dir);
    assert.deepEqual(await packageEntries(path.dirname(installed.dir)), ["1.0.0"], "the broken directory was removed");
  });

  test("package names and versions that could leave the adapters directory are refused", async () => {
    const installer = createAdapterInstaller({ cacheDir: await newCacheDir(), fetchTarball: fromFile(packedTarball) });
    for (const [pkg, version] of [
      ["../evil", "1.0.0"],
      ["@scope/../evil", "1.0.0"],
      ["Evil", "1.0.0"],
      [".hidden", "1.0.0"],
      ["ok", "../1.0.0"],
      ["ok", ".staging-1"],
      ["ok", "1.0.0/x"],
      ["ok", ""],
    ] as const) {
      await assert.rejects(installer.install(pkg, version), (error: unknown) => isAriError(error, "validation"), `${pkg}@${version}`);
    }
  });

  test("an archive entry that escapes, is absolute, or is a link is refused, and nothing is installed", async () => {
    const cases: Array<{ name: string; archive: Uint8Array; code: "validation" | "protocol" }> = [
      { name: "parent segments", archive: craftTar([{ name: "package/ok.txt", content: "ok" }, { name: "package/../../escape.txt", content: "x" }]), code: "validation" },
      { name: "absolute path", archive: craftTar([{ name: "/tmp/ari-absolute.txt", content: "x" }]), code: "validation" },
      { name: "symbolic link", archive: craftTar([{ name: "package/link", type: "2", linkName: "/etc/passwd" }]), code: "validation" },
      { name: "missing end marker", archive: craftTar([{ name: "package/ok.txt", content: "ok" }], { endMarker: false }), code: "protocol" },
    ];
    const corrupt = craftTar([{ name: "package/ok.txt", content: "ok" }]);
    corrupt[0] = "q".charCodeAt(0);
    cases.push({ name: "bad checksum", archive: corrupt, code: "protocol" });

    for (const { name, archive, code } of cases) {
      const cacheDir = await newCacheDir();
      const installer = createAdapterInstaller({ cacheDir, fetchTarball: () => yieldOnce(gzipSync(archive)) });
      await assert.rejects(installer.install("crafted", "1.0.0"), (error: unknown) => isAriError(error, code), name);
      assert.deepEqual(await packageEntries(path.join(cacheDir, "adapters", "crafted")), [], `${name}: nothing installed`);
      assert.deepEqual(await fs.readdir(cacheDir), ["adapters"], `${name}: nothing written outside`);
    }
    assert.equal(await fs.stat("/tmp/ari-absolute.txt").then(() => true, () => false), false);
  });

  test("archives written by GNU tar and in pax format extract the same", async () => {
    const source = path.join(scratch, "tar-source");
    const deepName = `package/${"deep-directory-name-".repeat(8)}/file.txt`;
    await fs.mkdir(path.join(source, path.dirname(deepName)), { recursive: true });
    await fs.writeFile(path.join(source, deepName), "deep content\n");
    await fs.writeFile(path.join(source, "package", "top.txt"), "top\n");
    for (const format of ["gnu", "pax", "ustar"]) {
      const archive = path.join(scratch, `fixture-${format}.tgz`);
      // ustar cannot hold the long name, so that archive gets only the short file.
      const members = format === "ustar" ? ["package/top.txt"] : ["package"];
      await run("tar", [`--format=${format}`, "-czf", archive, "-C", source, ...members]);
      const destination = await fs.mkdtemp(path.join(scratch, `extract-${format}-`));
      await extractTarball(createReadStream(archive), destination);
      assert.equal(await fs.readFile(path.join(destination, "top.txt"), "utf8"), "top\n", format);
      if (format !== "ustar") {
        assert.equal(await fs.readFile(path.join(destination, deepName.slice("package/".length)), "utf8"), "deep content\n", format);
      }
    }
  });
});
