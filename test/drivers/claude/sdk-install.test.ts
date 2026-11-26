// The claude driver without an SDK importable by name: it loads the SDK from
// the directory its `sdkDirectory` config field names, or installs it with
// `maintenance.install` from an npm registry (by default
// https://registry.npmjs.org) into the instance's cache directory.
//
// The install accepts only a sha512, sha384 or sha256 `dist.integrity`,
// checks both tarballs before it unpacks either, and unpacks only bytes it
// verified. It lays the SDK out with its native package in its own
// `node_modules`, so the SDK finds its binary by itself, and records every
// file; `status()` reports an install that is not whole, naming the steps that
// work, and `maintenance.install` repairs it.
//
// These tests run the driver in this process against a fake SDK (see
// sdk-fixture.ts) and a local registry; test/standalone/claude-sdk.e2e.ts runs
// the same paths through the standalone ari-driver, and
// sdk-install-node.test.ts checks the bytes again as they are unpacked. No
// test here reaches the network or starts a real Claude Code.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { builtinModules } from "node:module";
import { after, describe, test } from "node:test";
import { BINARY_TARGETS } from "../../../scripts/build-binary.ts";
import type { AriEvent } from "../../../src/index.ts";
import { createClaudeDriver } from "../../../src/drivers/claude/index.ts";
import type { ClaudeDriverConfig, ClaudeDriverOptions } from "../../../src/drivers/claude/index.ts";
import { CLAUDE_INSTALL_RECORD, claudeManagedPackages } from "../../../src/drivers/claude/install.ts";
import { isStandaloneExecutableModule } from "../../../src/drivers/claude/sdk.ts";
import { CLAUDE_DEFAULT_SDK_REGISTRY, CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION, CLAUDE_TESTED_VERSIONS } from "../../../src/meta/claude.ts";
import { satisfiesVersionRange } from "../../../src/drivers/claude/instance.ts";
import { createCoordination, createNodeHostServices } from "../../../src/node/index.ts";
import type { Instance } from "../../../src/runtime.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { fixtureRegistryEntries, hostNativePackage, integrityOf, shasumOf, startFixtureRegistry, writeFixtureSdkDirectory } from "./sdk-fixture.ts";
import type { RegistryEntry } from "./sdk-fixture.ts";

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

function scratchDirectory(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-claude-sdk-")));
  temporary.push(directory);
  return directory;
}

/** A Claude instance on real Node host services rooted at `hostRoot`; instances with the same root and id share a cache directory. */
async function claudeInstance(hostRoot: string, config: ClaudeDriverConfig, options: ClaudeDriverOptions = {}) {
  const host = await createNodeHostServices<ClaudeDriverConfig>({
    hostRoot,
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

/** The native binary inside a managed install, where npm would put it. */
function managedBinary(cacheDir: string): string {
  return path.join(managedDirectory(cacheDir), "node_modules", ...hostNativePackage().pkg.split("/"), hostNativePackage().binary);
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

describe("the claude driver loads its SDK from sdkDirectory", () => {
  test("status() reports the fixture's version, and a turn completes on the native binary beside it, which the SDK finds by itself", async () => {
    const root = scratchDirectory();
    writeFixtureSdkDirectory(path.join(root, "sdk"), "0.3.330+fixture", "fixture native claude from sdkDirectory");
    fs.mkdirSync(path.join(root, "project"));
    const { instance, dispose } = await claudeInstance(path.join(root, "host"), { sdkDirectory: path.join(root, "sdk") });
    try {
      const status = await instance.status();
      assert.equal(status.installed, true, JSON.stringify(status));
      assert.equal(status.version, "0.3.330+fixture");
      assert.equal(status.advisory, undefined);
      const turn = await oneTurn(instance, path.join(root, "project"));
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes("fixture SDK reply 1, from the native binary that answered: fixture native claude from sdkDirectory (found by the SDK itself)"), turn.events);
    } finally {
      await dispose();
    }
  });

  test("a directory without the SDK is reported unavailable naming it, and openSession refuses", async () => {
    const root = scratchDirectory();
    const { instance, dispose } = await claudeInstance(path.join(root, "host"), { sdkDirectory: path.join(root, "empty") });
    try {
      const status = await instance.status();
      assert.equal(status.installed, false);
      assert.equal(status.error?.code, "driver_unavailable");
      assert.match(status.error?.message ?? "", new RegExp(`sdkDirectory ${path.join(root, "empty").replaceAll("/", "\\/")}`));
      assert.match(status.error?.message ?? "", /node_modules\/@anthropic-ai\/claude-agent-sdk\/package\.json cannot be read/);
      assert.match(status.error?.message ?? "", /maintenance\.install/);
      await assert.rejects(instance.openSession({}), (error: { callError?: { code: string } }) => error.callError?.code === "driver_unavailable");
    } finally {
      await dispose();
    }
  });

  test("a directory whose native package is missing names reinstalling there, maintenance.install and executablePath", async () => {
    const root = scratchDirectory();
    const binary = writeFixtureSdkDirectory(path.join(root, "sdk"), CLAUDE_SDK_VERSION, "fixture native claude");
    fs.rmSync(path.dirname(binary), { recursive: true });
    const { instance, dispose } = await claudeInstance(path.join(root, "host"), { sdkDirectory: path.join(root, "sdk") });
    try {
      const status = await instance.status();
      assert.equal(status.error?.code, "driver_unavailable");
      const message = status.error?.message ?? "";
      assert.match(message, new RegExp(`npm install --prefix ${path.join(root, "sdk").replaceAll("/", "\\/")} @anthropic-ai\\/claude-agent-sdk`));
      assert.match(message, /remove sdkDirectory from the driver config and run maintenance\.install/);
      assert.match(message, /executablePath/);
    } finally {
      await dispose();
    }
  });
});

describe("maintenance.install and maintenance.update on the claude driver", () => {
  test("install the SDK with this platform's native package in its node_modules, from the configured registry, and the next status and turn use them", async () => {
    const root = scratchDirectory();
    const { sdk, native } = fixtureRegistryEntries(root, CLAUDE_SDK_VERSION, "fixture native claude from the registry");
    const registry = await startFixtureRegistry([sdk, native]);
    fs.mkdirSync(path.join(root, "project"));
    const { host, instance, dispose } = await claudeInstance(path.join(root, "host"), { sdkRegistry: registry.url }, { loadSdk: async () => Promise.reject(new Error("the package by name must not be loaded")) });
    try {
      assert.equal(typeof instance.maintenance?.install, "function");
      assert.equal(typeof instance.maintenance?.update, "function");
      const before = await instance.status();
      assert.equal(before.installed, false);
      await instance.maintenance!.install!();
      assert.deepEqual(registry.requests, [
        `/${native.pkg}/${CLAUDE_SDK_VERSION}`,
        "/-/tarballs/1.tgz",
        `/${CLAUDE_SDK_PACKAGE}/${CLAUDE_SDK_VERSION}`,
        "/-/tarballs/0.tgz",
      ]);
      // One directory, published by one rename: the SDK, its native package where npm puts it, and the record of both.
      assert.deepEqual(installedEntries(host.paths.cacheDir), ONE_INSTALL);
      const installed = managedDirectory(host.paths.cacheDir);
      assert.deepEqual(fs.readdirSync(installed).sort(), [CLAUDE_INSTALL_RECORD, "node_modules", "package.json", "sdk.mjs"]);
      assert.equal(fs.statSync(managedBinary(host.paths.cacheDir)).mode & 0o111, 0o111, "the native binary is executable");
      const record = JSON.parse(fs.readFileSync(path.join(installed, CLAUDE_INSTALL_RECORD), "utf8")) as { files: Array<{ path: string; size: number; mode: number; sha256: string }> };
      assert.deepEqual(
        record.files.map((file) => [file.path, file.mode]),
        [
          [`node_modules/${native.pkg}/${hostNativePackage().binary}`, 0o755],
          [`node_modules/${native.pkg}/package.json`, 0o644],
          ["package.json", 0o644],
          ["sdk.mjs", 0o644],
        ],
      );
      assert.ok(record.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256) && file.size > 0));
      assert.deepEqual(fs.readdirSync(host.paths.tmpDir), [], "the downloads are gone");
      const status = await instance.status();
      assert.equal(status.installed, true, JSON.stringify(status));
      assert.equal(status.version, CLAUDE_SDK_VERSION);
      const turn = await oneTurn(instance, path.join(root, "project"));
      assert.equal(turn.status, "completed", turn.events);
      // The driver does not name the binary: the SDK finds it in its own node_modules, as in an npm install.
      assert.ok(turn.events.includes("from the native binary that answered: fixture native claude from the registry (found by the SDK itself)"), turn.events);
      await instance.maintenance!.update!();
      assert.equal(registry.requests.length, 4, "an update of a whole install downloads nothing");
    } finally {
      await dispose();
      await registry.close();
    }
  });

  for (const tampered of ["sdk", "native"] as const) {
    test(`a ${tampered === "sdk" ? "SDK" : "native package"} tarball whose bytes do not match its integrity is refused, and nothing is installed`, async () => {
      const root = scratchDirectory();
      const entries = fixtureRegistryEntries(root, CLAUDE_SDK_VERSION, "fixture native claude");
      const original = entries[tampered].tarball;
      const changed = Buffer.from(original);
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
      const registry = await startFixtureRegistry([
        tampered === "sdk" ? { ...entries.sdk, tarball: changed, integrity: integrityOf(original) } : entries.sdk,
        tampered === "native" ? { ...entries.native, tarball: changed, integrity: integrityOf(original) } : entries.native,
      ]);
      const { host, instance, dispose } = await claudeInstance(path.join(root, "host"), { sdkRegistry: registry.url }, { loadSdk: async () => Promise.reject(new Error("not by name")) });
      try {
        const refused = tampered === "sdk" ? CLAUDE_SDK_PACKAGE : entries.native.pkg;
        await assert.rejects(instance.maintenance!.install!(), (error: { callError?: { code: string; detail?: string; message: string } }) => {
          assert.deepEqual(
            { code: error.callError?.code, detail: error.callError?.detail, message: error.callError?.message },
            { code: "protocol", detail: "integrity_mismatch", message: `The tarball of ${refused}@${CLAUDE_SDK_VERSION} does not match its published sha512 digest` },
          );
          return true;
        });
        assert.ok(registry.requests.includes(tampered === "sdk" ? "/-/tarballs/0.tgz" : "/-/tarballs/1.tgz"), "the tampered tarball was downloaded and refused");
        assert.deepEqual(installedEntries(host.paths.cacheDir), NOTHING_INSTALLED);
        assert.deepEqual(fs.readdirSync(host.paths.tmpDir), [], "the downloads are gone");
        assert.equal((await instance.status()).installed, false);
      } finally {
        await dispose();
        await registry.close();
      }
    });
  }

  // What the native package's manifest publishes, and whether the install takes it. The SDK's manifest is a plain sha512 in every case.
  const manifests: Array<{ name: string; dist: (bytes: Buffer, other: Buffer) => Pick<RegistryEntry, "integrity" | "shasum">; accepted: boolean; detail?: string }> = [
    { name: "only a matching sha1 shasum, no integrity", dist: (bytes) => ({ integrity: null, shasum: shasumOf(bytes) }), accepted: false, detail: "no_integrity" },
    { name: "a matching sha1 integrity and shasum", dist: (bytes) => ({ integrity: integrityOf(bytes, "sha1"), shasum: shasumOf(bytes) }), accepted: false, detail: "no_integrity" },
    { name: "no digest at all", dist: () => ({ integrity: null }), accepted: false, detail: "no_integrity" },
    { name: "a matching sha256 integrity", dist: (bytes) => ({ integrity: integrityOf(bytes, "sha256") }), accepted: true },
    { name: "a matching sha384 integrity", dist: (bytes) => ({ integrity: integrityOf(bytes, "sha384") }), accepted: true },
    { name: "a matching sha256 and a wrong sha512 integrity (the strongest decides)", dist: (bytes, other) => ({ integrity: `${integrityOf(bytes, "sha256")} ${integrityOf(other)}` }), accepted: false, detail: "integrity_mismatch" },
  ];
  for (const manifest of manifests) {
    test(`a native package manifest with ${manifest.name} is ${manifest.accepted ? "installed" : "refused, and nothing is installed"}`, async () => {
      const root = scratchDirectory();
      const entries = fixtureRegistryEntries(root, CLAUDE_SDK_VERSION, "fixture native claude");
      const registry = await startFixtureRegistry([entries.sdk, { ...entries.native, ...manifest.dist(entries.native.tarball, entries.sdk.tarball) }]);
      const { host, instance, dispose } = await claudeInstance(path.join(root, "host"), { sdkRegistry: registry.url }, { loadSdk: async () => Promise.reject(new Error("not by name")) });
      try {
        if (manifest.accepted) {
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
              `The registry manifest of ${entries.native.pkg}@${CLAUDE_SDK_VERSION} publishes no sha512, sha384 or sha256 dist.integrity to check the tarball against (a sha1 integrity or shasum is not accepted)`,
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
    const root = scratchDirectory();
    const entries = fixtureRegistryEntries(root, CLAUDE_SDK_VERSION, "fixture native claude");
    let tmpDir = "";
    let changedOnDisk = false;
    // The native tarball is downloaded and verified first; while the SDK's manifest is fetched, something rewrites it.
    const registry = await startFixtureRegistry([entries.sdk, entries.native], {
      onRequest: (requested) => {
        if (requested !== `/${CLAUDE_SDK_PACKAGE}/${CLAUDE_SDK_VERSION}`) return;
        const [download] = fs.readdirSync(tmpDir);
        const file = path.join(tmpDir, download!, "0.tgz");
        const bytes = fs.readFileSync(file);
        assert.deepEqual(bytes, entries.native.tarball, "the scratch file holds the verified tarball");
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
        fs.writeFileSync(file, bytes);
        changedOnDisk = true;
      },
    });
    const { host, instance, dispose } = await claudeInstance(path.join(root, "host"), { sdkRegistry: registry.url }, { loadSdk: async () => Promise.reject(new Error("not by name")) });
    tmpDir = host.paths.tmpDir;
    try {
      await assert.rejects(instance.maintenance!.install!(), (error: { callError?: { code: string; detail?: string; message: string } }) => {
        assert.deepEqual(
          { code: error.callError?.code, detail: error.callError?.detail, message: error.callError?.message },
          { code: "protocol", detail: "integrity_mismatch", message: `The downloaded tarball of ${entries.native.pkg}@${CLAUDE_SDK_VERSION} changed on disk after it was verified` },
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
    const root = scratchDirectory();
    const { sdk, native } = fixtureRegistryEntries(root, CLAUDE_SDK_VERSION, "fixture native claude");
    const registry = await startFixtureRegistry([sdk, native], { tarballDelayMs: 200 });
    fs.mkdirSync(path.join(root, "project"));
    const first = await claudeInstance(path.join(root, "host"), { sdkRegistry: registry.url });
    const second = await claudeInstance(path.join(root, "host"), { sdkRegistry: registry.url });
    try {
      assert.equal(first.host.paths.cacheDir, second.host.paths.cacheDir);
      await Promise.all([first.instance.maintenance!.install!(), second.instance.maintenance!.install!()]);
      // Both checked before either installed, so both downloaded; only one unpacked.
      assert.equal(registry.requests.filter((request) => request.startsWith("/-/tarballs/")).length, 4, registry.requests.join("\n"));
      const cacheDir = first.host.paths.cacheDir;
      assert.deepEqual(installedEntries(cacheDir), ONE_INSTALL, "no staging or trash directory is left");
      const installed = managedDirectory(cacheDir);
      assert.deepEqual(fs.readdirSync(installed).sort(), [CLAUDE_INSTALL_RECORD, "node_modules", "package.json", "sdk.mjs"]);
      assert.equal(fs.readFileSync(path.join(installed, "sdk.mjs"), "utf8"), fs.readFileSync(new URL("./fixture-sdk/sdk.mjs", import.meta.url), "utf8"));
      for (const { instance } of [first, second]) {
        const status = await instance.status();
        assert.equal(status.version, CLAUDE_SDK_VERSION, JSON.stringify(status));
        assert.equal((await oneTurn(instance, path.join(root, "project"))).status, "completed");
      }
    } finally {
      await first.dispose();
      await second.dispose();
      await registry.close();
    }
  });

  test("the registry defaults to https://registry.npmjs.org, and sdkRegistry replaces it", async () => {
    const root = scratchDirectory();
    const asked: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return new Response("{}", { status: 404 });
    }) as typeof globalThis.fetch;
    const unset = await claudeInstance(path.join(root, "unset"), {}, { fetch });
    const set = await claudeInstance(path.join(root, "set"), { sdkRegistry: "http://registry.example.test/npm/" }, { fetch });
    try {
      assert.equal(CLAUDE_DEFAULT_SDK_REGISTRY, "https://registry.npmjs.org");
      await assert.rejects(unset.instance.maintenance!.install!(), (error: { callError?: { code: string } }) => error.callError?.code === "not_found");
      await assert.rejects(set.instance.maintenance!.install!(), (error: { callError?: { code: string } }) => error.callError?.code === "not_found");
      const native = encodeURIComponent(hostNativePackage().pkg).replace(/^%40/, "@");
      assert.deepEqual(asked, [`https://registry.npmjs.org/${native}/${CLAUDE_SDK_VERSION}`, `http://registry.example.test/npm/${native}/${CLAUDE_SDK_VERSION}`]);
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

  const damages: Array<{ name: string; damage: (cacheDir: string) => void; detail: RegExp | null }> = [
    { name: "sdk.mjs is missing", damage: (cacheDir) => fs.rmSync(path.join(managedDirectory(cacheDir), "sdk.mjs")), detail: /: sdk\.mjs is missing\./ },
    { name: "the native binary is missing", damage: (cacheDir) => fs.rmSync(managedBinary(cacheDir)), detail: /: node_modules\/@anthropic-ai\/claude-agent-sdk-[a-z0-9-]+\/claude(\.exe)? is missing\./ },
    {
      name: "the native binary is truncated",
      damage: (cacheDir) => fs.truncateSync(managedBinary(cacheDir), 10),
      detail: /: node_modules\/@anthropic-ai\/claude-agent-sdk-[a-z0-9-]+\/claude(\.exe)? has 10 bytes, not the \d+ it was installed with\./,
    },
    { name: "sdk.mjs changed but kept its size", damage: (cacheDir) => flipLastByte(path.join(managedDirectory(cacheDir), "sdk.mjs")), detail: /: sdk\.mjs has changed since it was installed\./ },
    // As after a cache is restored by a tool that drops permissions: the same bytes, but the SDK could not start the binary.
    {
      name: "the native binary lost its execute permission",
      damage: (cacheDir) => fs.chmodSync(managedBinary(cacheDir), 0o644),
      detail: /: node_modules\/@anthropic-ai\/claude-agent-sdk-[a-z0-9-]+\/claude(\.exe)? is not executable: its mode is 0644, and it was installed with 0755\./,
    },
    { name: "the record of the install is missing", damage: (cacheDir) => fs.rmSync(path.join(managedDirectory(cacheDir), CLAUDE_INSTALL_RECORD)), detail: /\.ari-install\.json, written when an install completes, is missing or unreadable/ },
    {
      name: "the record of the install has no modes, as an install made before modes were recorded",
      damage: (cacheDir) => {
        const file = path.join(managedDirectory(cacheDir), CLAUDE_INSTALL_RECORD);
        const record = JSON.parse(fs.readFileSync(file, "utf8")) as { files: Array<{ mode?: number }> };
        for (const entry of record.files) delete entry.mode;
        fs.writeFileSync(file, JSON.stringify(record));
      },
      detail: /: \.ari-install\.json is malformed\./,
    },
    // Only the size of the native binary is checked on every load (it is 381 MB); maintenance.install checks its sha256 too.
    { name: "the native binary changed but kept its size", damage: (cacheDir) => flipLastByte(managedBinary(cacheDir)), detail: null },
  ];
  for (const { name, damage, detail } of damages) {
    test(`when ${name}, status ${detail === null ? "cannot tell, but" : "names maintenance.install and sdkDirectory, and"} maintenance.install repairs it`, async () => {
      const root = scratchDirectory();
      const { sdk, native } = fixtureRegistryEntries(root, CLAUDE_SDK_VERSION, "fixture native claude");
      const registry = await startFixtureRegistry([sdk, native]);
      fs.mkdirSync(path.join(root, "project"));
      const hostRoot = path.join(root, "host");
      const installing = await claudeInstance(hostRoot, { sdkRegistry: registry.url });
      const cacheDir = installing.host.paths.cacheDir;
      await installing.instance.maintenance!.install!();
      await installing.dispose();
      const whole = { sdk: fs.readFileSync(path.join(managedDirectory(cacheDir), "sdk.mjs")), binary: fs.readFileSync(managedBinary(cacheDir)) };
      damage(cacheDir);
      // A new instance, as after a restart, so nothing loaded before the damage is reused.
      const { instance, dispose } = await claudeInstance(hostRoot, { sdkRegistry: registry.url }, { loadSdk: async () => Promise.reject(new Error("not by name")) });
      try {
        const status = await instance.status();
        if (detail === null) assert.equal(status.installed, true, JSON.stringify(status));
        else {
          assert.equal(status.state, "unavailable", JSON.stringify(status));
          assert.equal(status.error?.code, "driver_unavailable");
          const message = status.error?.message ?? "";
          assert.match(message, detail);
          assert.match(message, /Run maintenance\.install on this instance to repair it, or set sdkDirectory in the driver config/);
          await assert.rejects(instance.openSession({}), (error: { callError?: { code: string } }) => error.callError?.code === "driver_unavailable");
        }
        const before = registry.requests.length;
        await instance.maintenance!.install!();
        assert.deepEqual(registry.requests.slice(before).filter((request) => request.startsWith("/-/tarballs/")), ["/-/tarballs/1.tgz", "/-/tarballs/0.tgz"], "the repair downloads both again");
        assert.deepEqual(installedEntries(cacheDir), ONE_INSTALL, "the damaged install was replaced, and nothing is left beside it");
        assert.deepEqual(fs.readFileSync(path.join(managedDirectory(cacheDir), "sdk.mjs")), whole.sdk);
        assert.deepEqual(fs.readFileSync(managedBinary(cacheDir)), whole.binary);
        assert.equal(fs.statSync(managedBinary(cacheDir)).mode & 0o777, 0o755, "the repaired native binary is executable");
        const repaired = await instance.status();
        assert.equal(repaired.installed, true, JSON.stringify(repaired));
        assert.equal(repaired.version, CLAUDE_SDK_VERSION);
        const turn = await oneTurn(instance, path.join(root, "project"));
        assert.equal(turn.status, "completed", turn.events);
        assert.ok(turn.events.includes("answered: fixture native claude (found by the SDK itself)"), turn.events);
      } finally {
        await dispose();
        await registry.close();
      }
    });
  }
});

describe("what a managed install holds", () => {
  const sdkRoot = fs.realpathSync(path.join(REPO_ROOT, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/")));
  const pinned = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8")) as { version: string; optionalDependencies: { [name: string]: string } };

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

  test("each release target's native package is one the pinned SDK lists, at the SDK's version", () => {
    const platforms: { [target: string]: [string, string] } = {
      "linux-x64": ["linux", "x64"],
      "linux-arm64": ["linux", "arm64"],
      "darwin-x64": ["darwin", "x64"],
      "darwin-arm64": ["darwin", "arm64"],
      "windows-x64": ["win32", "x64"],
    };
    assert.deepEqual(Object.keys(platforms).sort(), [...BINARY_TARGETS].sort());
    for (const target of BINARY_TARGETS) {
      const [platform, arch] = platforms[target]!;
      for (const musl of platform === "linux" ? [false, true] : [false]) {
        const [native, sdk] = claudeManagedPackages(platform, arch, musl);
        assert.deepEqual(sdk, { pkg: CLAUDE_SDK_PACKAGE, version: CLAUDE_SDK_VERSION });
        assert.equal(native!.pkg, `${CLAUDE_SDK_PACKAGE}-${platform}-${arch}${musl ? "-musl" : ""}`);
        assert.equal(pinned.optionalDependencies[native!.pkg], CLAUDE_SDK_VERSION, `${target}${musl ? " (musl)" : ""}`);
      }
    }
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
