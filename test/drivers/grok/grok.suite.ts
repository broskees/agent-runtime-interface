// Grok's quirks: its launch command, a probe that never starts the updater,
// and inherited xAI keys passed through unless the host strips them.

import assert from "node:assert/strict";
import { test } from "node:test";
import { GROK_ACP_ARGS, GROK_DEFAULT_CONFIG, grokDriver } from "../../../src/drivers/grok/index.ts";
import { openRig } from "../acp/rig.ts";

test("grok runs `grok --permission-mode default agent stdio`, probes with the updater off, and passes on an inherited XAI_API_KEY unless the host strips it", async () => {
  for (const stripAmbient of [[], ["XAI_*"]]) {
    const rig = await openRig({
      name: "grok",
      driver: grokDriver,
      config: { ...GROK_DEFAULT_CONFIG },
      executable: "grok",
      protocol: 1,
      fakeHost: { ambientEnvironment: { PATH: "/usr/bin", XAI_API_KEY: "xai-inherited", XAI_ORG: "inherited-org" }, envPolicy: { stripAmbient } },
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
      const stripped = stripAmbient.length > 0;
      for (const spawn of [probe, runtime]) {
        assert.equal(spawn.environment["XAI_API_KEY"], stripped ? undefined : "xai-inherited", `XAI_API_KEY under stripAmbient ${JSON.stringify(stripAmbient)}`);
        assert.equal(spawn.environment["XAI_ORG"], stripped ? undefined : "inherited-org", `XAI_ORG under stripAmbient ${JSON.stringify(stripAmbient)}`);
      }
      assert.equal(runtime.environment["PATH"], "/usr/bin");
      assert.equal(runtime.environment["GROK_DISABLE_AUTOUPDATER"], undefined, "only the probe turns the updater off");
    } finally {
      await rig.cleanup();
    }
  }
});

test("grok: a policy without a mode still runs Grok in its default permission mode, which the launch fixes for the process, and reports it as approval_required", async () => {
  const rig = await openRig({ name: "grok-own-mode", driver: grokDriver, config: { ...GROK_DEFAULT_CONFIG }, executable: "grok", protocol: 1 });
  try {
    const { session } = await rig.open();
    assert.deepEqual(rig.host.spawns.find((spawn) => spawn.purpose === "runtime")!.args, ["--permission-mode", "default", "agent", "stdio"]);
    const own = await session.createThread({ cwd: rig.cwd, policy: { interaction: "default", cwd: rig.cwd } });
    assert.deepEqual(own.effectiveMode, { mode: "approval_required", interaction: "default", source: "harness" });
    const hosted = await session.createThread({ cwd: rig.cwd, policy: rig.policy("full_access") });
    assert.deepEqual(hosted.effectiveMode, { mode: "full_access", interaction: "default", source: "host" });
  } finally {
    await rig.cleanup();
  }
});
