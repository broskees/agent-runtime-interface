// The claude driver without an SDK importable by name: it loads the SDK from
// the directory its `sdkDirectory` config field names, or installs it with
// `maintenance.install` from an npm registry (by default
// https://registry.npmjs.org) into the instance's cache directory.
//
// The install downloads the SDK alone, never a native Claude Code package.
// It accepts only a sha512, sha384 or sha256 `dist.integrity`, checks the
// tarball before it unpacks it, unpacks only bytes it verified, and records
// every file; `status()` reports an install that is not whole, naming the
// steps that work, and `maintenance.install` repairs it.
//
// Wherever the SDK comes from, every query runs the user's own Claude Code:
// here a fake `claude` on the host's PATH (sdk-fixture.ts), or the one
// `executablePath` names, never the decoy native package npm would put
// beside the SDK. A `claude` that is missing, prints no version or is older
// than the version the pinned SDK bundles leaves the driver unavailable with
// an error that names the fix, and starts no Claude Code session; a newer one
// runs with an advisory.
//
// These tests run the driver in this process against a fake SDK (see
// sdk-fixture.ts) and a local registry; test/standalone/claude-sdk.e2e.ts runs
// the same paths through the standalone ari-driver, and
// sdk-install-node.test.ts checks the bytes again as they are unpacked. No
// test here reaches the network or starts a real Claude Code.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { builtinModules } from "node:module";
import { after, describe, test } from "node:test";
import type { AriEvent } from "../../../src/index.ts";
import { createClaudeDriver } from "../../../src/drivers/claude/index.ts";
import type { ClaudeDriverConfig, ClaudeDriverOptions } from "../../../src/drivers/claude/index.ts";
import { CLAUDE_INSTALL_RECORD } from "../../../src/drivers/claude/install.ts";
import { isStandaloneExecutableModule } from "../../../src/drivers/claude/sdk.ts";
import { CLAUDE_DEFAULT_SDK_REGISTRY, CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION, CLAUDE_TESTED_VERSIONS } from "../../../src/meta/claude.ts";
import { satisfiesVersionRange } from "../../../src/drivers/claude/instance.ts";
import { createCoordination, createNodeHostServices } from "../../../src/node/index.ts";
import type { Instance } from "../../../src/runtime.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import {
  MINIMUM_VERSION_LINE,
  addNativePackageAsAnEarlierAri,
  fakeClaudeInvocations,
  fakeClaudeSessions,
  fixtureSdkEntry,
  integrityOf,
  sdkNativePackage,
  shasumOf,
  startFixtureRegistry,
  writeFakeClaude,
  writeFixtureSdkDirectory,
} from "./sdk-fixture.ts";
import type { RegistryEntry } from "./sdk-fixture.ts";

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

/** A temp root with `bin/` (the host's whole PATH, empty), `project/` (a thread's cwd) and room for the host's directories. */
function scratch(): { root: string; bin: string; project: string; hostRoot: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-claude-sdk-")));
  temporary.push(root);
  const where = { root, bin: path.join(root, "bin"), project: path.join(root, "project"), hostRoot: path.join(root, "host") };
  fs.mkdirSync(where.bin);
  fs.mkdirSync(where.project);
  return where;
}

/** The user's Claude Code on the host's PATH: a fake at the minimum version, unless `versionLine` says otherwise. */
function userClaude(bin: string, versionLine = MINIMUM_VERSION_LINE, versionExitCode = 0): string {
  return writeFakeClaude(path.join(bin, "claude"), { versionLine, versionExitCode, greeting: "the user's claude on PATH" });
}

/** What the fixture SDK's reply says when the driver ran the Claude Code at `file`, which greets with `greeting`. */
function ranOn(file: string, greeting = "the user's claude on PATH"): string {
  return `from the Claude Code at ${file} (named in pathToClaudeCodeExecutable), which answered: ${greeting}`;
}

/**
 * A Claude instance on real Node host services rooted at `hostRoot`, whose
 * PATH is `bin` alone; instances with the same root and id share a cache
 * directory.
 */
async function claudeInstance(where: { hostRoot: string; bin: string }, config: ClaudeDriverConfig, options: ClaudeDriverOptions = {}) {
  const host = await createNodeHostServices<ClaudeDriverConfig>({
    hostRoot: where.hostRoot,
    instanceId: "claude-sdk",
    config: { get: async () => ({ config }) },
    attachments: { resolve: async () => null },
    hostTools: {
      mcpServerFor: async () => {
        throw new Error("this host serves no tools");
      },
    },
    callbacks: { register: async (flowId) => ({ url: `http://127.0.0.1:9/${flowId}` }) },
    coordination: createCoordination(),
    writeDiagnostic: () => undefined,
    baseEnv: { PATH: where.bin },
  });
  const instance = await createClaudeDriver(options).create(host, { instanceId: "claude-sdk", config, environment: {} });
  return {
    host,
    instance,
    async dispose() {
      await instance.dispose();
      await host.dispose();
    },
  };
}

/** Runs one turn and resolves with its terminal status and every event's JSON. */
async function oneTurn(instance: Instance, cwd: string): Promise<{ status: string | undefined; events: string }> {
  const session = await instance.openSession({});
  const events: AriEvent[] = [];
  void (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  try {
    const thread = await session.createThread({ cwd, policy: { mode: "approval_required", interaction: "default", cwd } });
    await session.startTurn({ threadId: thread.id, clientTurnKey: "sdk-1", intent: "start", content: [{ type: "text", text: "Say hello" }] });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const terminal = events.find((event) => event.body.type === "turn.terminal");
      if (terminal !== undefined) return { status: terminal.body.type === "turn.terminal" ? terminal.body.status : undefined, events: JSON.stringify(events) };
      if (Date.now() > deadline) throw new Error(`no turn.terminal within 15 s: ${JSON.stringify(events)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await session.close();
  }
}

/** Where a managed install of the pinned SDK lives in `cacheDir`. */
function managedDirectory(cacheDir: string): string {
  return path.join(cacheDir, "adapters", ...CLAUDE_SDK_PACKAGE.split("/"), CLAUDE_SDK_VERSION);
}

/** What `<cacheDir>/adapters/@anthropic-ai/` holds, and the entries of the SDK's package directory, hidden lock and lease directories left out. */
function installedEntries(cacheDir: string): { packages: string[]; versions: string[] } {
  const scope = path.join(cacheDir, "adapters", "@anthropic-ai");
  const sdkDirectory = path.join(scope, "claude-agent-sdk");
  return {
    packages: fs.existsSync(scope) ? fs.readdirSync(scope).sort() : [],
    versions: fs.existsSync(sdkDirectory) ? fs.readdirSync(sdkDirectory).filter((name) => name !== ".locks" && name !== ".leases").sort() : [],
  };
}

const NOTHING_INSTALLED = { packages: [], versions: [] };
const ONE_INSTALL = { packages: ["claude-agent-sdk"], versions: [CLAUDE_SDK_VERSION] };
/** What a managed install holds: the fake SDK's two files and the record, and no node_modules. */
const INSTALLED_FILES = [CLAUDE_INSTALL_RECORD, "package.json", "sdk.mjs"];

describe("the claude driver loads its SDK from sdkDirectory and runs the user's Claude Code", () => {
  test("status() reports the fixture's version, and a turn runs the claude on PATH, never the native package npm put beside the SDK", async () => {
    const where = scratch();
    const decoy = writeFixtureSdkDirectory(path.join(where.root, "sdk"), "0.3.330+fixture", "the native package beside the SDK");
    const claude = userClaude(where.bin);
    const { instance, dispose } = await claudeInstance(where, { sdkDirectory: path.join(where.root, "sdk") });
    try {
      const status = await instance.status();
      assert.equal(status.installed, true, JSON.stringify(status));
      assert.equal(status.version, "0.3.330+fixture");
      assert.equal(status.advisory, undefined, "the claude on PATH is the minimum, which is tested");
      const turn = await oneTurn(instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes(`fixture SDK reply 1, ${ranOn(claude)}`), turn.events);
      assert.equal(fakeClaudeSessions(claude).length, 1);
      assert.deepEqual(fakeClaudeInvocations(decoy), [], "the native package beside the SDK never ran");
      // The decoy sits where the pinned SDK would look for its native Claude Code: a platform package its sdk.mjs lists.
      const pinned = JSON.parse(fs.readFileSync(path.join(fs.realpathSync(path.join(REPO_ROOT, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/"))), "package.json"), "utf8")) as { optionalDependencies: { [name: string]: string } };
      assert.equal(pinned.optionalDependencies[sdkNativePackage().pkg], CLAUDE_SDK_VERSION);
    } finally {
      await dispose();
    }
  });

  test("with executablePath set, that Claude Code runs instead of the claude on PATH", async () => {
    const where = scratch();
    const decoy = writeFixtureSdkDirectory(path.join(where.root, "sdk"), CLAUDE_SDK_VERSION, "the native package beside the SDK");
    const onPath = userClaude(where.bin);
    const configured = writeFakeClaude(path.join(where.root, "elsewhere", "claude-nightly"), { versionLine: MINIMUM_VERSION_LINE, greeting: "the configured claude" });
    const { instance, dispose } = await claudeInstance(where, { sdkDirectory: path.join(where.root, "sdk"), executablePath: configured });
    try {
      const turn = await oneTurn(instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes(ranOn(configured, "the configured claude")), turn.events);
      assert.equal(fakeClaudeInvocations(configured)[0], "--version", "the driver checked the configured Claude Code's version before it ran it");
      assert.deepEqual(fakeClaudeInvocations(onPath), []);
      assert.deepEqual(fakeClaudeInvocations(decoy), []);
    } finally {
      await dispose();
    }
  });

  test("a directory without the SDK is reported unavailable naming it, and openSession refuses", async () => {
    const where = scratch();
    userClaude(where.bin);
    const { instance, dispose } = await claudeInstance(where, { sdkDirectory: path.join(where.root, "empty") });
    try {
      const status = await instance.status();
      assert.equal(status.installed, false);
      assert.equal(status.error?.code, "driver_unavailable");
      assert.match(status.error?.message ?? "", new RegExp(`sdkDirectory ${path.join(where.root, "empty").replaceAll("/", "\\/")}`));
      assert.match(status.error?.message ?? "", /node_modules\/@anthropic-ai\/claude-agent-sdk\/package\.json cannot be read/);
      assert.match(status.error?.message ?? "", /maintenance\.install/);
      await assert.rejects(instance.openSession({}), (error: { callError?: { code: string } }) => error.callError?.code === "driver_unavailable");
    } finally {
      await dispose();
    }
  });
});

describe("maintenance.install and maintenance.update on the claude driver download the SDK alone", () => {
  test("install the SDK from the configured registry, with no native Claude Code package, and the next status and turn use it with the claude on PATH", async () => {
    const where = scratch();
    const registry = await startFixtureRegistry([fixtureSdkEntry(where.root, CLAUDE_SDK_VERSION)]);
    const claude = userClaude(where.bin);
    const { host, instance, dispose } = await claudeInstance(where, { sdkRegistry: registry.url }, { loadSdk: async () => Promise.reject(new Error("the package by name must not be loaded")) });
    try {
      assert.equal(typeof instance.maintenance?.install, "function");
      assert.equal(typeof instance.maintenance?.update, "function");
      const before = await instance.status();
      assert.equal(before.installed, false);
      await instance.maintenance!.install!();
      assert.deepEqual(registry.requests, [`/${CLAUDE_SDK_PACKAGE}/${CLAUDE_SDK_VERSION}`, "/-/tarballs/0.tgz"], "only the SDK was asked for");
      // One directory, published by one rename: the SDK and the record of its files, and no node_modules.
      assert.deepEqual(installedEntries(host.paths.cacheDir), ONE_INSTALL);
      const installed = managedDirectory(host.paths.cacheDir);
      assert.deepEqual(fs.readdirSync(installed).sort(), INSTALLED_FILES);
      const record = JSON.parse(fs.readFileSync(path.join(installed, CLAUDE_INSTALL_RECORD), "utf8")) as { files: Array<{ path: string; size: number; sha256: string }> };
      assert.deepEqual(
        record.files.map((file) => file.path),
        ["package.json", "sdk.mjs"],
      );
      for (const file of record.files) {
        const bytes = fs.readFileSync(path.join(installed, file.path));
        assert.deepEqual([file.size, file.sha256], [bytes.length, createHash("sha256").update(bytes).digest("hex")], file.path);
      }
      assert.deepEqual(fs.readdirSync(host.paths.tmpDir), [], "the download is gone");
      const status = await instance.status();
      assert.equal(status.installed, true, JSON.stringify(status));
      assert.equal(status.version, CLAUDE_SDK_VERSION);
      const turn = await oneTurn(instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes(ranOn(claude)), turn.events);
      await instance.maintenance!.update!();
      assert.equal(registry.requests.length, 2, "an update of a whole install downloads nothing");
    } finally {
      await dispose();
      await registry.close();
    }
  });

  test("an SDK tarball whose bytes do not match its integrity is refused, and nothing is installed", async () => {
    const where = scratch();
    const entry = fixtureSdkEntry(where.root, CLAUDE_SDK_VERSION);
    const changed = Buffer.from(entry.tarball);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
    const registry = await startFixtureRegistry([{ ...entry, tarball: changed, integrity: integrityOf(entry.tarball) }]);
    const { host, instance, dispose } = await claudeInstance(where, { sdkRegistry: registry.url }, { loadSdk: async () => Promise.reject(new Error("not by name")) });
    try {
      await assert.rejects(instance.maintenance!.install!(), (error: { callError?: { code: string; detail?: string; message: string } }) => {
        assert.deepEqual(
          { code: error.callError?.code, detail: error.callError?.detail, message: error.callError?.message },
          { code: "protocol", detail: "integrity_mismatch", message: `The tarball of ${CLAUDE_SDK_PACKAGE}@${CLAUDE_SDK_VERSION} does not match its published sha512 digest` },
        );
        return true;
      });
      assert.ok(registry.requests.includes("/-/tarballs/0.tgz"), "the tampered tarball was downloaded and refused");
      assert.deepEqual(installedEntries(host.paths.cacheDir), NOTHING_INSTALLED);
      assert.deepEqual(fs.readdirSync(host.paths.tmpDir), [], "the download is gone");
      assert.equal((await instance.status()).installed, false);
    } finally {
      await dispose();
      await registry.close();
    }
  });

  // What the SDK's manifest publishes, and whether the install takes it.
  const manifests: Array<{ name: string; dist: (bytes: Buffer, other: Buffer) => Pick<RegistryEntry, "integrity" | "shasum">; accepted: boolean; detail?: string }> = [
    { name: "only a matching sha1 shasum, no integrity", dist: (bytes) => ({ integrity: null, shasum: shasumOf(bytes) }), accepted: false, detail: "no_integrity" },
    { name: "a matching sha1 integrity and shasum", dist: (bytes) => ({ integrity: integrityOf(bytes, "sha1"), shasum: shasumOf(bytes) }), accepted: false, detail: "no_integrity" },
    { name: "no digest at all", dist: () => ({ integrity: null }), accepted: false, detail: "no_integrity" },
    { name: "a matching sha256 integrity", dist: (bytes) => ({ integrity: integrityOf(bytes, "sha256") }), accepted: true },
    { name: "a matching sha384 integrity", dist: (bytes) => ({ integrity: integrityOf(bytes, "sha384") }), accepted: true },
    { name: "a matching sha256 and a wrong sha512 integrity (the strongest decides)", dist: (bytes, other) => ({ integrity: `${integrityOf(bytes, "sha256")} ${integrityOf(other)}` }), accepted: false, detail: "integrity_mismatch" },
  ];
  for (const manifest of manifests) {
    test(`an SDK manifest with ${manifest.name} is ${manifest.accepted ? "installed" : "refused, and nothing is installed"}`, async () => {
      const where = scratch();
      const entry = fixtureSdkEntry(where.root, CLAUDE_SDK_VERSION);
      const other = fixtureSdkEntry(where.root, CLAUDE_SDK_VERSION, "another tarball").tarball;
      const registry = await startFixtureRegistry([{ ...entry, ...manifest.dist(entry.tarball, other) }]);
      const { host, instance, dispose } = await claudeInstance(where, { sdkRegistry: registry.url }, { loadSdk: async () => Promise.reject(new Error("not by name")) });
      try {
        if (manifest.accepted) {
          userClaude(where.bin);
          await instance.maintenance!.install!();
          assert.deepEqual(installedEntries(host.paths.cacheDir), ONE_INSTALL);
          assert.equal((await instance.status()).installed, true);
          return;
        }
        await assert.rejects(instance.maintenance!.install!(), (error: { callError?: { code: string; detail?: string; message: string } }) => {
          assert.equal(error.callError?.detail, manifest.detail, JSON.stringify(error.callError));
          if (manifest.detail === "no_integrity") {
            assert.equal(
              error.callError?.message,
              `The registry manifest of ${CLAUDE_SDK_PACKAGE}@${CLAUDE_SDK_VERSION} publishes no sha512, sha384 or sha256 dist.integrity to check the tarball against (a sha1 integrity or shasum is not accepted)`,
            );
          }
          return true;
        });
        assert.deepEqual(installedEntries(host.paths.cacheDir), NOTHING_INSTALLED);
        assert.deepEqual(fs.readdirSync(host.paths.tmpDir), []);
      } finally {
        await dispose();
        await registry.close();
      }
    });
  }

  test("a downloaded tarball that changes on disk after it was verified is refused before anything is unpacked", async () => {
    const where = scratch();
    const entry = fixtureSdkEntry(where.root, CLAUDE_SDK_VERSION);
    const registry = await startFixtureRegistry([entry]);
    let tmpDir = "";
    let changedOnDisk = false;
    /** The download in the instance's temp directory, once all `size` bytes are on disk. */
    const downloaded = async (size: number): Promise<string> => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const [download] = fs.readdirSync(tmpDir);
        const file = download === undefined ? undefined : path.join(tmpDir, download, "sdk.tgz");
        if (file !== undefined && fs.existsSync(file) && fs.statSync(file).size === size) return file;
        if (Date.now() > deadline) throw new Error("the download never reached the disk");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    // The tarball arrives whole and matches its integrity; before its stream ends, something rewrites the file it was saved to.
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await globalThis.fetch(input, init);
      if (!String(input).includes("/-/tarballs/")) return response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(bytes);
            return;
          }
          const file = await downloaded(bytes.length);
          assert.deepEqual(new Uint8Array(fs.readFileSync(file)), bytes, "the scratch file holds the verified tarball");
          const changed = Buffer.from(bytes);
          changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
          fs.writeFileSync(file, changed);
          changedOnDisk = true;
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: response.headers });
    }) as typeof globalThis.fetch;
    const { host, instance, dispose } = await claudeInstance(where, { sdkRegistry: registry.url }, { fetch, loadSdk: async () => Promise.reject(new Error("not by name")) });
    tmpDir = host.paths.tmpDir;
    try {
      await assert.rejects(instance.maintenance!.install!(), (error: { callError?: { code: string; detail?: string; message: string } }) => {
        assert.deepEqual(
          { code: error.callError?.code, detail: error.callError?.detail, message: error.callError?.message },
          { code: "protocol", detail: "integrity_mismatch", message: `The downloaded tarball of ${CLAUDE_SDK_PACKAGE}@${CLAUDE_SDK_VERSION} changed on disk after it was verified` },
        );
        return true;
      });
      assert.equal(changedOnDisk, true);
      assert.deepEqual(installedEntries(host.paths.cacheDir), NOTHING_INSTALLED);
      assert.deepEqual(fs.readdirSync(host.paths.tmpDir), []);
    } finally {
      await dispose();
      await registry.close();
    }
  });

  test("two installs at once, from two instances on one cache directory, end with one intact install", async () => {
    const where = scratch();
    const registry = await startFixtureRegistry([fixtureSdkEntry(where.root, CLAUDE_SDK_VERSION)], { tarballDelayMs: 200 });
    userClaude(where.bin);
    const first = await claudeInstance(where, { sdkRegistry: registry.url });
    const second = await claudeInstance(where, { sdkRegistry: registry.url });
    try {
      assert.equal(first.host.paths.cacheDir, second.host.paths.cacheDir);
      await Promise.all([first.instance.maintenance!.install!(), second.instance.maintenance!.install!()]);
      // Both checked before either installed, so both downloaded; only one unpacked.
      assert.equal(registry.requests.filter((request) => request.startsWith("/-/tarballs/")).length, 2, registry.requests.join("\n"));
      const cacheDir = first.host.paths.cacheDir;
      assert.deepEqual(installedEntries(cacheDir), ONE_INSTALL, "no staging or trash directory is left");
      const installed = managedDirectory(cacheDir);
      assert.deepEqual(fs.readdirSync(installed).sort(), INSTALLED_FILES);
      assert.equal(fs.readFileSync(path.join(installed, "sdk.mjs"), "utf8"), fs.readFileSync(new URL("./fixture-sdk/sdk.mjs", import.meta.url), "utf8"));
      for (const { instance } of [first, second]) {
        const status = await instance.status();
        assert.equal(status.version, CLAUDE_SDK_VERSION, JSON.stringify(status));
        assert.equal((await oneTurn(instance, where.project)).status, "completed");
      }
    } finally {
      await first.dispose();
      await second.dispose();
      await registry.close();
    }
  });

  test("the registry defaults to https://registry.npmjs.org, and sdkRegistry replaces it", async () => {
    const where = scratch();
    const asked: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return new Response("{}", { status: 404 });
    }) as typeof globalThis.fetch;
    const unset = await claudeInstance({ hostRoot: path.join(where.root, "unset"), bin: where.bin }, {}, { fetch });
    const set = await claudeInstance({ hostRoot: path.join(where.root, "set"), bin: where.bin }, { sdkRegistry: "http://registry.example.test/npm/" }, { fetch });
    try {
      assert.equal(CLAUDE_DEFAULT_SDK_REGISTRY, "https://registry.npmjs.org");
      await assert.rejects(unset.instance.maintenance!.install!(), (error: { callError?: { code: string } }) => error.callError?.code === "not_found");
      await assert.rejects(set.instance.maintenance!.install!(), (error: { callError?: { code: string } }) => error.callError?.code === "not_found");
      const sdk = encodeURIComponent(CLAUDE_SDK_PACKAGE).replace(/^%40/, "@");
      assert.deepEqual(asked, [`https://registry.npmjs.org/${sdk}/${CLAUDE_SDK_VERSION}`, `http://registry.example.test/npm/${sdk}/${CLAUDE_SDK_VERSION}`]);
    } finally {
      await unset.dispose();
      await set.dispose();
    }
  });
});

describe("a managed install that is not whole", () => {
  /** Changes one byte of `file` and keeps its size. */
  function flipLastByte(file: string): void {
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 0x01;
    fs.writeFileSync(file, bytes);
  }

  const damages: Array<{ name: string; damage: (cacheDir: string) => void; detail: RegExp }> = [
    { name: "sdk.mjs is missing", damage: (cacheDir) => fs.rmSync(path.join(managedDirectory(cacheDir), "sdk.mjs")), detail: /: sdk\.mjs is missing\./ },
    { name: "package.json is truncated", damage: (cacheDir) => fs.truncateSync(path.join(managedDirectory(cacheDir), "package.json"), 10), detail: /: package\.json has 10 bytes, not the \d+ it was installed with\./ },
    { name: "sdk.mjs changed but kept its size", damage: (cacheDir) => flipLastByte(path.join(managedDirectory(cacheDir), "sdk.mjs")), detail: /: sdk\.mjs has changed since it was installed\./ },
    { name: "the record of the install is missing", damage: (cacheDir) => fs.rmSync(path.join(managedDirectory(cacheDir), CLAUDE_INSTALL_RECORD)), detail: /\.ari-install\.json, written when an install completes, is missing or unreadable/ },
    {
      name: "it holds a native Claude Code package an earlier ARI installed",
      damage: (cacheDir) => addNativePackageAsAnEarlierAri(managedDirectory(cacheDir)),
      detail: /: it holds node_modules\/@anthropic-ai\/claude-agent-sdk-[a-z0-9-]+\/claude(\.exe)?, part of a native Claude Code package an earlier ARI installed; the driver runs your own Claude Code instead\./,
    },
  ];
  for (const { name, damage, detail } of damages) {
    test(`when ${name}, status names maintenance.install and sdkDirectory, and maintenance.install repairs it with the SDK alone`, async () => {
      const where = scratch();
      const registry = await startFixtureRegistry([fixtureSdkEntry(where.root, CLAUDE_SDK_VERSION)]);
      const claude = userClaude(where.bin);
      const installing = await claudeInstance(where, { sdkRegistry: registry.url });
      const cacheDir = installing.host.paths.cacheDir;
      await installing.instance.maintenance!.install!();
      await installing.dispose();
      const whole = fs.readFileSync(path.join(managedDirectory(cacheDir), "sdk.mjs"));
      damage(cacheDir);
      // A new instance, as after a restart, so nothing loaded before the damage is reused.
      const { instance, dispose } = await claudeInstance(where, { sdkRegistry: registry.url }, { loadSdk: async () => Promise.reject(new Error("not by name")) });
      try {
        const status = await instance.status();
        assert.equal(status.state, "unavailable", JSON.stringify(status));
        assert.equal(status.error?.code, "driver_unavailable");
        const message = status.error?.message ?? "";
        assert.match(message, detail);
        assert.match(message, /Run maintenance\.install on this instance to repair it, or set sdkDirectory in the driver config/);
        await assert.rejects(instance.openSession({}), (error: { callError?: { code: string } }) => error.callError?.code === "driver_unavailable");
        const before = registry.requests.length;
        await instance.maintenance!.install!();
        assert.deepEqual(registry.requests.slice(before), [`/${CLAUDE_SDK_PACKAGE}/${CLAUDE_SDK_VERSION}`, "/-/tarballs/0.tgz"], "the repair downloads the SDK again, and only the SDK");
        assert.deepEqual(installedEntries(cacheDir), ONE_INSTALL, "the damaged install was replaced, and nothing is left beside it");
        assert.deepEqual(fs.readdirSync(managedDirectory(cacheDir)).sort(), INSTALLED_FILES, "no node_modules is left");
        assert.deepEqual(fs.readFileSync(path.join(managedDirectory(cacheDir), "sdk.mjs")), whole);
        const repaired = await instance.status();
        assert.equal(repaired.installed, true, JSON.stringify(repaired));
        assert.equal(repaired.version, CLAUDE_SDK_VERSION);
        const turn = await oneTurn(instance, where.project);
        assert.equal(turn.status, "completed", turn.events);
        assert.ok(turn.events.includes(ranOn(claude)), turn.events);
      } finally {
        await dispose();
        await registry.close();
      }
    });
  }
});

describe("the user's Claude Code decides whether the claude driver is available, for a managed install and for sdkDirectory", () => {
  const sources = ["a managed install", "sdkDirectory"] as const;

  /** An instance whose SDK comes from `source`, with `bin` its host's PATH; for sdkDirectory, the decoy native package beside the SDK. */
  async function prepared(source: (typeof sources)[number], where: ReturnType<typeof scratch>) {
    if (source === "sdkDirectory") {
      const decoy = writeFixtureSdkDirectory(path.join(where.root, "sdk"), CLAUDE_SDK_VERSION, "the native package beside the SDK");
      return { ...(await claudeInstance(where, { sdkDirectory: path.join(where.root, "sdk") })), decoy, close: async () => undefined };
    }
    const registry = await startFixtureRegistry([fixtureSdkEntry(where.root, CLAUDE_SDK_VERSION)]);
    const claude = await claudeInstance(where, { sdkRegistry: registry.url }, { loadSdk: async () => Promise.reject(new Error("not by name")) });
    await claude.instance.maintenance!.install!();
    return { ...claude, decoy: undefined, close: () => registry.close() };
  }

  /** status() is driver_unavailable, openSession rejects with the same error, and no Claude Code session started. */
  async function refused(instance: Instance, claude: string | undefined, decoy: string | undefined): Promise<{ message: string; binary: string | undefined }> {
    const status = await instance.status();
    assert.equal(status.state, "unavailable", JSON.stringify(status));
    assert.equal(status.installed, false);
    assert.equal(status.error?.code, "driver_unavailable");
    await assert.rejects(instance.openSession({}), (error: { callError?: { code: string; message: string } }) => {
      assert.deepEqual({ code: error.callError?.code, message: error.callError?.message }, { code: status.error?.code, message: status.error?.message });
      return true;
    });
    if (claude !== undefined) {
      assert.deepEqual(fakeClaudeSessions(claude), [], "no Claude Code session started");
      assert.ok(fakeClaudeInvocations(claude).every((line) => line === "--version"), fakeClaudeInvocations(claude).join("\n"));
    }
    if (decoy !== undefined) assert.deepEqual(fakeClaudeInvocations(decoy), [], "the native package beside the SDK never ran");
    return { message: status.error!.message, binary: (status.error as { binary?: string }).binary };
  }

  test("after claude update replaces a too old claude, the next status() reports the driver ready, without a restart", async () => {
    const where = scratch();
    const claude = userClaude(where.bin, "2.1.319 (Claude Code)");
    const { instance, dispose, close } = await prepared("sdkDirectory", where);
    try {
      assert.equal((await instance.status()).error?.code, "driver_unavailable");
      // As `claude update` leaves it: a new file at the same path.
      fs.rmSync(claude);
      userClaude(where.bin, "2.1.330 (Claude Code)");
      const status = await instance.status();
      assert.equal(status.state, "ready", JSON.stringify(status));
      assert.equal((await oneTurn(instance, where.project)).status, "completed");
    } finally {
      await dispose();
      await close();
    }
  });

  for (const source of sources) {
    test(`with ${source}, a claude older than the minimum is driver_unavailable naming its version, its path, the minimum and how to update`, async () => {
      const where = scratch();
      const claude = userClaude(where.bin, "2.1.329 (Claude Code)");
      const { instance, dispose, decoy, close } = await prepared(source, where);
      try {
        const { message, binary } = await refused(instance, claude, decoy);
        assert.equal(binary, claude);
        assert.ok(message.startsWith(`Claude Code 2.1.329 at ${claude} is older than 2.1.330, the oldest version this driver runs`), message);
        assert.match(message, /Update Claude Code to 2\.1\.330 or newer \(run claude update,/);
        assert.match(message, /set executablePath in the driver config/);
      } finally {
        await dispose();
        await close();
      }
    });

    test(`with ${source}, no claude at all is driver_unavailable saying Claude Code is not installed, how to install it, and executablePath`, async () => {
      const where = scratch();
      const { instance, dispose, decoy, close } = await prepared(source, where);
      try {
        const { message, binary } = await refused(instance, undefined, decoy);
        assert.equal(binary, "claude");
        assert.ok(message.startsWith("Claude Code is not installed: no claude executable was found on PATH."), message);
        assert.match(message, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
        assert.match(message, /set executablePath in the driver config/);
      } finally {
        await dispose();
        await close();
      }
    });

    test(`with ${source}, a claude whose version cannot be read is driver_unavailable naming its path and what it printed`, async () => {
      const where = scratch();
      const claude = userClaude(where.bin, "claude: error while loading shared libraries: libnode.so.115", 127);
      const { instance, dispose, decoy, close } = await prepared(source, where);
      try {
        const { message, binary } = await refused(instance, claude, decoy);
        assert.equal(binary, claude);
        assert.ok(
          message.startsWith(`The version of the Claude Code at ${claude} cannot be read: ${claude} --version exited with code 127 and printed "claude: error while loading shared libraries: libnode.so.115".`),
          message,
        );
        assert.match(message, /set executablePath in the driver config/);
      } finally {
        await dispose();
        await close();
      }
    });

    test(`with ${source}, a claude newer than the minimum is available with an untested_version advisory, and runs`, async () => {
      const where = scratch();
      const claude = userClaude(where.bin, "2.1.400 (Claude Code)");
      const { instance, dispose, decoy, close } = await prepared(source, where);
      try {
        const status = await instance.status();
        assert.equal(status.state, "ready", JSON.stringify(status));
        assert.equal(status.installed, true);
        assert.deepEqual(status.advisory, {
          kind: "untested_version",
          message: `Claude Code 2.1.400 at ${claude} is newer than 2.1.330, the version this driver is tested against: it runs, but this version is untested.`,
          currentVersion: "2.1.400",
          testedRange: "2.1.330",
        });
        assert.deepEqual(await instance.maintenance!.advisory(), status.advisory);
        const turn = await oneTurn(instance, where.project);
        assert.equal(turn.status, "completed", turn.events);
        assert.ok(turn.events.includes(ranOn(claude)), turn.events);
        if (decoy !== undefined) assert.deepEqual(fakeClaudeInvocations(decoy), []);
      } finally {
        await dispose();
        await close();
      }
    });
  }
});

describe("what a managed install holds", () => {
  const sdkRoot = fs.realpathSync(path.join(REPO_ROOT, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/")));
  const pinned = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8")) as { version: string };

  test("the pinned version is the SDK devDependency, inside the tested range", () => {
    const repository = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { devDependencies: { [name: string]: string } };
    assert.equal(CLAUDE_SDK_VERSION, repository.devDependencies[CLAUDE_SDK_PACKAGE]);
    assert.equal(CLAUDE_SDK_VERSION, pinned.version);
    assert.equal(satisfiesVersionRange(CLAUDE_SDK_VERSION, CLAUDE_TESTED_VERSIONS), true);
  });

  test("the pinned SDK's sdk.mjs imports only Node built-ins, so the install needs no peer package at run time", () => {
    const source = fs.readFileSync(path.join(sdkRoot, "sdk.mjs"), "utf8");
    // Its static imports are `import{...}from"<specifier>"` (minified); every one names a Node built-in.
    const specifiers = [...source.matchAll(/\bimport\s*\{[^}]*\}\s*from\s*"([^"]+)"/g)].map((match) => match[1]!);
    assert.ok(specifiers.length > 20, `found ${specifiers.length} imports`);
    const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
    assert.deepEqual([...new Set(specifiers.filter((specifier) => !builtins.has(specifier)))], []);
    // It loads no package with a computed import either: its only import() calls name nothing outside it.
    assert.deepEqual([...source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]!).filter((specifier) => !builtins.has(specifier)), []);
  });

  test("the standalone executable is recognized by its modules' URLs, on every release platform", () => {
    assert.equal(isStandaloneExecutableModule("file:///$bunfs/root/ari-driver"), true);
    assert.equal(isStandaloneExecutableModule("file:///B:/~BUN/root/ari-driver.exe"), true);
    assert.equal(isStandaloneExecutableModule("file:///b:/~BUN/root/ari-driver.exe"), true);
    assert.equal(isStandaloneExecutableModule(import.meta.url), false);
    assert.equal(isStandaloneExecutableModule("file:///home/me/project/node_modules/ari/dist/drivers/claude/sdk.js"), false);
    assert.equal(isStandaloneExecutableModule("file:///C:/Users/me/ari/dist/drivers/claude/sdk.js"), false);
  });
});
