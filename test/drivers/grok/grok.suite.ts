// Grok's quirks: its launch command, a probe that never starts the updater,
// and inherited xAI keys kept from the agent.

import assert from "node:assert/strict";
import { test } from "node:test";
import { GROK_ACP_ARGS, GROK_DEFAULT_CONFIG, grokDriver } from "../../../src/drivers/grok/index.ts";
import { openRig } from "../acp/rig.ts";

test("grok runs `grok --permission-mode default agent stdio`, probes with the updater off, and never passes on an inherited XAI_API_KEY", async () => {
  const rig = await openRig({
    name: "grok",
    driver: grokDriver,
    config: { ...GROK_DEFAULT_CONFIG },
    executable: "grok",
    protocol: 1,
    fakeHost: { ambientEnvironment: { PATH: "/usr/bin", XAI_API_KEY: "xai-inherited", XAI_ORG: "inherited-org" } },
  });
  try {
    await rig.instance.probe();
    const probe = rig.host.spawns.find((spawn) => spawn.purpose === "probe")!;
    assert.equal(probe.command, "grok");
    assert.deepEqual(probe.args, ["--version"]);
    assert.equal(probe.environment["GROK_DISABLE_AUTOUPDATER"], "1");
    await rig.open();
    const runtime = rig.host.spawns.find((spawn) => spawn.purpose === "runtime")!;
    assert.equal(runtime.command, "grok");
    assert.deepEqual(runtime.args, ["--permission-mode", "default", "agent", "stdio"]);
    assert.deepEqual(GROK_ACP_ARGS, ["--permission-mode", "default", "agent", "stdio"]);
    assert.equal(runtime.environment["XAI_API_KEY"], undefined);
    assert.equal(runtime.environment["XAI_ORG"], undefined);
    assert.equal(runtime.environment["PATH"], "/usr/bin");
    assert.equal(runtime.environment["GROK_DISABLE_AUTOUPDATER"], undefined, "only the probe turns the updater off");
  } finally {
    await rig.cleanup();
  }
});
