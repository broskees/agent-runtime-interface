// The driver rules for the acp-registry driver, running a registry agent
// already installed in the instance's cache, over ACP v2.

import assert from "node:assert/strict";
import { ACP_REGISTRY_DEFAULT_CONFIG, createAcpRegistryDriver } from "../../../src/drivers/acp-registry/index.ts";
import { meta } from "../../../src/meta/acp-registry.ts";
import { acpInstanceMembers, acpSessionMembers, driverRuleTests } from "../acp/driver-rules.ts";
import { ARCHIVE_URL, FAKE_AGENT_ID, REGISTRY_URL, agentArchive, fixtureFetch, preinstall, registryIndex } from "./fixtures.ts";

const archive = agentArchive();
const driver = createAcpRegistryDriver({ fetch: fixtureFetch({ [REGISTRY_URL]: registryIndex(archive.sha256), [ARCHIVE_URL]: archive.bytes }) });
const config = { ...ACP_REGISTRY_DEFAULT_CONFIG, registryUrl: REGISTRY_URL, agentId: FAKE_AGENT_ID, maxProtocolVersion: 2 as const };

driverRuleTests({
  kind: "acp-registry",
  driver,
  meta,
  config,
  executable: "fake-acp-agent",
  protocol: 2,
  agentArgs: ["--fork"],
  hostOptions: (_instanceId, paths) => {
    preinstall(paths.cacheDir);
    return {};
  },
  missing: { config: { ...config, agentId: "absent-agent" }, package: "absent-agent" },
  reportedVersion: "1.0.0",
  session: acpSessionMembers(true),
  instance: acpInstanceMembers({ "subProviders.list": "supported", "subProviders.set": "supported", "subProviders.disable": "supported" }),
  exerciseInstance: async (instance, member, cwd) => {
    if (member === "subProviders.list") {
      const providers = await instance.subProviders!.list(cwd);
      assert.deepEqual(
        providers.map((provider) => [provider.id, provider.enabled, provider.installed]),
        [
          ["fake-agent", true, true],
          ["npx-agent", false, false],
          ["zip-agent", false, false],
          ["unsigned-agent", false, false],
        ],
      );
      return;
    }
    if (member === "subProviders.set") {
      await instance.subProviders!.set({ cwd, providerId: FAKE_AGENT_ID });
      assert.equal((await instance.probe()).installed, true);
      return;
    }
    await instance.subProviders!.disable({ cwd, providerId: FAKE_AGENT_ID });
    const probe = await instance.probe();
    assert.equal(probe.installed, false);
    assert.equal(probe.error?.code, "invalid_state", "no agent is chosen any more");
  },
  launch: "subProviders.set",
});
