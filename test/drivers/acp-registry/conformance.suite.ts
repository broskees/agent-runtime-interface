// The acp-registry driver passes the conformance suite running a registry
// agent that is already installed in each instance's cache, over ACP v2. The
// SDK-based fake agent stands in for the installed agent's command.

import { ACP_REGISTRY_DEFAULT_CONFIG, createAcpRegistryDriver } from "../../../src/drivers/acp-registry/index.ts";
import { acpConformance } from "../acp/conformance-suite.ts";
import { FAKE_AGENT_ID, REGISTRY_URL, fixtureFetch, preinstall, registryIndex } from "./fixtures.ts";

const driver = createAcpRegistryDriver({ fetch: fixtureFetch({ [REGISTRY_URL]: registryIndex("0".repeat(64)) }) });

acpConformance({
  name: "acp-registry driver, ACP v2 agent",
  driver,
  config: { ...ACP_REGISTRY_DEFAULT_CONFIG, registryUrl: REGISTRY_URL, agentId: FAKE_AGENT_ID, maxProtocolVersion: 2 },
  executable: "fake-acp-agent",
  protocol: 2,
  agentArgs: ["--fork"],
  hostOptions: (_instanceId, paths) => {
    preinstall(paths.cacheDir);
    return {};
  },
});
