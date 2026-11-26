// The claude driver without an SDK importable by name: it loads the SDK from
// the directory its `sdkDirectory` config field names, or installs it with
// `maintenance.install` from an npm registry (by default
// https://registry.npmjs.org) into the instance's cache directory, checking
// every tarball against the registry's `dist.integrity` before it unpacks
// any. These tests run the driver in this process against a fake SDK (see
// sdk-fixture.ts) and a local registry; test/standalone/claude-sdk.e2e.ts runs
// the same paths through the standalone ari-driver. No test here reaches the
// network or starts a real Claude Code.

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
import { claudeManagedPackages } from "../../../src/drivers/claude/install.ts";
import { isStandaloneExecutableModule } from "../../../src/drivers/claude/sdk.ts";
import { CLAUDE_DEFAULT_SDK_REGISTRY, CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION, CLAUDE_TESTED_VERSIONS } from "../../../src/meta/claude.ts";
import { satisfiesVersionRange } from "../../../src/drivers/claude/instance.ts";
import { createCoordination, createNodeHostServices } from "../../../src/node/index.ts";
import type { Instance } from "../../../src/runtime.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { fixtureRegistryEntries, hostNativePackage, integrityOf, startFixtureRegistry, writeFixtureSdkDirectory } from "./sdk-fixture.ts";

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

/** The installed versions and leftovers under `<cacheDir>/adapters/<pkg>/`, hidden lock and lease directories left out. */
function installedEntries(cacheDir: string, pkg: string): string[] {
  const directory = path.join(cacheDir, "adapters", ...pkg.split("/"));
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name !== ".locks" && name !== ".leases").sort();
}

describe("the claude driver loads its SDK from sdkDirectory", () => {
  test("status() reports the fixture's version, and a turn completes on the native binary beside it", async () => {
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
      assert.ok(turn.events.includes("fixture SDK reply 1, from the native binary that answered: fixture native claude from sdkDirectory"), turn.events);
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
      await assert.rejects(instance.openSession({}), (error: { callError?: { code: string } }) => error.callError?.code === "driver_unavailable");
    } finally {
      await dispose();
    }
  });
});

describe("maintenance.install and maintenance.update on the claude driver", () => {
  test("download the SDK and this platform's native package from the configured registry into the cache directory, and the next status and turn use them", async () => {
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
      assert.deepEqual(installedEntries(host.paths.cacheDir, CLAUDE_SDK_PACKAGE), [CLAUDE_SDK_VERSION]);
      assert.deepEqual(installedEntries(host.paths.cacheDir, native.pkg), [CLAUDE_SDK_VERSION]);
      const binary = path.join(host.paths.cacheDir, "adapters", ...native.pkg.split("/"), CLAUDE_SDK_VERSION, hostNativePackage().binary);
      assert.equal(fs.statSync(binary).mode & 0o111, 0o111, "the native binary is executable");
      assert.deepEqual(fs.readdirSync(host.paths.tmpDir), [], "the downloads are gone");
      const status = await instance.status();
      assert.equal(status.installed, true, JSON.stringify(status));
      assert.equal(status.version, CLAUDE_SDK_VERSION);
      const turn = await oneTurn(instance, path.join(root, "project"));
      assert.equal(turn.status, "completed", turn.events);
      // The SDK cannot find a managed install's native binary by itself; the driver names it, and the fake SDK ran it.
      assert.ok(turn.events.includes("from the native binary that answered: fixture native claude from the registry"), turn.events);
      await instance.maintenance!.update!();
      assert.equal(registry.requests.length, 4, "an update of an installed version downloads nothing");
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
        assert.deepEqual(installedEntries(host.paths.cacheDir, CLAUDE_SDK_PACKAGE), []);
        assert.deepEqual(installedEntries(host.paths.cacheDir, entries.native.pkg), []);
        assert.deepEqual(fs.readdirSync(host.paths.tmpDir), [], "the downloads are gone");
        assert.equal((await instance.status()).installed, false);
      } finally {
        await dispose();
        await registry.close();
      }
    });
  }

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
      // Both checked before either installed, so both downloaded; only one unpacked each version.
      assert.equal(registry.requests.filter((request) => request.startsWith("/-/tarballs/")).length, 4, registry.requests.join("\n"));
      const cacheDir = first.host.paths.cacheDir;
      assert.deepEqual(installedEntries(cacheDir, CLAUDE_SDK_PACKAGE), [CLAUDE_SDK_VERSION], "no staging or trash directory is left");
      assert.deepEqual(installedEntries(cacheDir, native.pkg), [CLAUDE_SDK_VERSION]);
      const sdkDirectory = path.join(cacheDir, "adapters", ...CLAUDE_SDK_PACKAGE.split("/"), CLAUDE_SDK_VERSION);
      assert.deepEqual(fs.readdirSync(sdkDirectory).sort(), ["package.json", "sdk.mjs"]);
      assert.equal(fs.readFileSync(path.join(sdkDirectory, "sdk.mjs"), "utf8"), fs.readFileSync(new URL("./fixture-sdk/sdk.mjs", import.meta.url), "utf8"));
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
