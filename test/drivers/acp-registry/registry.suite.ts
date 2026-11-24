// The ACP Registry driver's quirks: registry agents are sub-providers read
// from the index; choosing one installs it through `ari/node`'s adapter
// installer (never npx or another program); only verified tar archives
// install; a session runs the installed command and holds a lease on it.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { ACP_REGISTRY_DEFAULT_CONFIG, createAcpRegistryDriver, installableBuild, registryTarget } from "../../../src/drivers/acp-registry/index.ts";
import { isAriError } from "../../../src/index.ts";
import { createAdapterInstaller } from "../../../src/node/installer.ts";
import { openRig, until } from "../acp/rig.ts";
import { ARCHIVE_URL, FAKE_AGENT_ID, REGISTRY_URL, TARGET, agentArchive, fixtureFetch, preinstall, registryIndex } from "./fixtures.ts";

const archive = agentArchive();
const config = { ...ACP_REGISTRY_DEFAULT_CONFIG, registryUrl: REGISTRY_URL, maxProtocolVersion: 2 as const };

async function registryRig(routes: { readonly [url: string]: unknown }) {
  const fetch = fixtureFetch(routes);
  const rig = await openRig({ name: "acp-registry", driver: createAcpRegistryDriver({ fetch }), config, executable: "fake-acp-agent", protocol: 2 });
  return { rig, fetch };
}

test("registry agents are listed as sub-providers from the registry index", async () => {
  const { rig, fetch } = await registryRig({ [REGISTRY_URL]: registryIndex(archive.sha256) });
  try {
    const providers = await rig.instance.subProviders!.list(rig.cwd);
    assert.deepEqual(fetch.requested, [REGISTRY_URL]);
    assert.deepEqual(providers[0], {
      id: FAKE_AGENT_ID,
      label: "Fake Agent",
      description: "An ACP agent for tests",
      enabled: false,
      installed: false,
      version: "1.0.0",
      icon: { type: "url", url: "https://registry.invalid/fake-agent.svg" },
    });
    assert.deepEqual(providers.map((provider) => provider.id), ["fake-agent", "npx-agent", "uvx-agent", "zip-agent", "unsigned-agent"]);
    // Nothing is chosen yet, so there is nothing to run.
    assert.equal((await rig.instance.status()).state, "setup_required");
    await assert.rejects(rig.instance.openSession({}), (error) => isAriError(error, "invalid_state"));
  } finally {
    await rig.cleanup();
  }
});

test("choosing an agent installs it through the adapter installer, without starting any program; a session runs it and holds a lease", async () => {
  const { rig, fetch } = await registryRig({ [REGISTRY_URL]: registryIndex(archive.sha256), [ARCHIVE_URL]: archive.bytes });
  try {
    await rig.instance.subProviders!.set({ cwd: rig.cwd, providerId: FAKE_AGENT_ID });
    assert.deepEqual(fetch.requested, [REGISTRY_URL, ARCHIVE_URL]);
    assert.equal(rig.host.spawns.length, 0, "installing started no program: no npx, no package manager");
    const installed = `${rig.host.paths.cacheDir}/adapters/${FAKE_AGENT_ID}/1.0.0`;
    assert.ok((fs.statSync(`${installed}/bin/fake-acp-agent`).mode & 0o100) !== 0, "the agent's command is installed and executable");
    assert.deepEqual(
      fs.readdirSync(`${rig.host.paths.cacheDir}/adapters/${FAKE_AGENT_ID}`).filter((name) => name.startsWith(".staging") || name.startsWith(".trash")),
      [],
    );
    const listed = await rig.instance.subProviders!.list(rig.cwd);
    assert.deepEqual([listed[0]!.enabled, listed[0]!.installed], [true, true]);
    const status = await rig.instance.status();
    assert.equal(status.state, "ready");
    assert.equal(status.version, "1.0.0");

    const { session } = await rig.open();
    const runtime = rig.host.spawns.find((spawn) => spawn.purpose === "runtime")!;
    assert.equal(runtime.command, `${installed}/bin/fake-acp-agent`);
    assert.deepEqual(runtime.args, ["acp"]);
    const leases = `${rig.host.paths.cacheDir}/adapters/${FAKE_AGENT_ID}/.leases/1.0.0`;
    assert.equal(fs.readdirSync(leases).length, 1);
    const installer = createAdapterInstaller({ cacheDir: rig.host.paths.cacheDir, fetchTarball: () => (async function* () {})() });
    assert.deepEqual(await installer.cleanup(), []);
    await session.close();
    await until(() => (fs.readdirSync(leases).length === 0 ? true : undefined), "the lease to end with the agent process");

    await rig.instance.subProviders!.disable({ cwd: rig.cwd, providerId: FAKE_AGENT_ID });
    assert.equal((await rig.instance.subProviders!.list(rig.cwd))[0]!.enabled, false);
  } finally {
    await rig.cleanup();
  }
});

test("npx and uvx packages, zip archives and archives without a sha256 are refused with the reason, and never fetched", async () => {
  const { rig, fetch } = await registryRig({ [REGISTRY_URL]: registryIndex(archive.sha256) });
  try {
    for (const [providerId, reason] of [
      ["npx-agent", /npm package @example\/npx-agent@2\.0\.0.*never runs npx/],
      ["uvx-agent", /Python package uvx-agent@2\.1\.0, which needs uvx/],
      ["zip-agent", /unpacks only tar and tar\.gz/],
      ["unsigned-agent", /publishes no sha256/],
    ] as const) {
      await assert.rejects(rig.instance.subProviders!.set({ cwd: rig.cwd, providerId }), (error) => isAriError(error, "invalid_state") && reason.test(error.message), providerId);
    }
    assert.deepEqual(new Set(fetch.requested), new Set([REGISTRY_URL]), "no archive was downloaded");
    assert.equal(rig.host.spawns.length, 0);
    assert.equal(fs.existsSync(`${rig.host.paths.cacheDir}/adapters`), false);
  } finally {
    await rig.cleanup();
  }
});

test("an archive that does not match its sha256 is not installed", async () => {
  const tampered = new Uint8Array(archive.bytes);
  tampered[tampered.length - 1] ^= 0xff;
  const { rig } = await registryRig({ [REGISTRY_URL]: registryIndex(archive.sha256), [ARCHIVE_URL]: tampered });
  try {
    await assert.rejects(rig.instance.subProviders!.set({ cwd: rig.cwd, providerId: FAKE_AGENT_ID }), (error) => isAriError(error, "protocol") && /sha256/.test(error.message));
    assert.equal(fs.existsSync(`${rig.host.paths.cacheDir}/adapters/${FAKE_AGENT_ID}/1.0.0`), false);
  } finally {
    await rig.cleanup();
  }
});

test("registry platform names and installable builds follow the registry's distribution format", () => {
  assert.equal(registryTarget("linux", "x64"), "linux-x86_64");
  assert.equal(registryTarget("darwin", "arm64"), "darwin-aarch64");
  assert.equal(registryTarget("win32", "x64"), "windows-x86_64");
  const index = registryIndex(archive.sha256);
  assert.ok("build" in installableBuild(index.agents[0]!, TARGET));
  assert.ok("reason" in installableBuild(index.agents[0]!, "plan9-mips"));
});

test("status() gives an advisory when the registry index the instance last read lists another version of the agent than the one installed", async () => {
  const index = registryIndex(archive.sha256);
  for (const [listedVersion, advised] of [
    ["1.0.0", false],
    ["1.1.0", true],
  ] as const) {
    const listing = { ...index, agents: index.agents.map((agent) => (agent.id === FAKE_AGENT_ID ? { ...agent, version: listedVersion } : agent)) };
    const fetch = fixtureFetch({ [REGISTRY_URL]: listing });
    const rig = await openRig({
      name: "acp-registry advisory",
      driver: createAcpRegistryDriver({ fetch }),
      config: { ...config, agentId: FAKE_AGENT_ID },
      executable: "fake-acp-agent",
      protocol: 2,
      hostOptions: (_instanceId, paths) => {
        preinstall(paths.cacheDir);
        return {};
      },
    });
    try {
      const before = await rig.instance.status();
      assert.equal(before.version, "1.0.0", "the installed version");
      assert.equal(before.advisory, undefined, "status() reads no index itself");
      assert.deepEqual(fetch.requested, []);
      await rig.instance.subProviders!.list(rig.cwd);
      const after = await rig.instance.status();
      if (!advised) assert.equal(after.advisory, undefined, "the index lists the installed version");
      else {
        assert.equal(after.advisory?.kind, "untested_version");
        assert.equal(after.advisory?.currentVersion, "1.0.0");
        assert.equal(after.advisory?.latestVersion, "1.1.0");
        assert.equal(after.advisory?.testedRange, "1.1.0");
        assert.match(after.advisory?.message ?? "", /subProviders\.set/);
      }
    } finally {
      await rig.cleanup();
    }
  }
});
