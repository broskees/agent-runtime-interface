// Kiro's quirks: its V3 launch command, its `autopilot` option set from the
// thread's runtime mode, and stored sessions loaded with `session/load`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { KIRO_DEFAULT_CONFIG, kiroDriver } from "../../../src/drivers/kiro/index.ts";
import { openRig } from "../acp/rig.ts";
import { KIRO_OPTIONS_V1 } from "./fixtures.ts";

test("kiro runs `kiro-cli acp --agent-engine=v3 --auth-method=cli`, turns autopilot off for supervised threads and on under full_access", async () => {
  const rig = await openRig({ name: "kiro", driver: kiroDriver, config: { ...KIRO_DEFAULT_CONFIG }, executable: "kiro-cli", protocol: 1, agentArgs: ["--load", "--config-options", JSON.stringify(KIRO_OPTIONS_V1)] });
  try {
    const { session } = await rig.open();
    const runtime = rig.host.spawns.find((spawn) => spawn.purpose === "runtime")!;
    assert.equal(runtime.command, "kiro-cli");
    assert.deepEqual(runtime.args, ["acp", "--agent-engine=v3", "--auth-method=cli"]);
    const supervised = await session.createThread({ cwd: rig.cwd, policy: rig.policy("approval_required") });
    assert.equal(supervised.appliedConfig?.["autopilot"], false);
    const unattended = await session.createThread({ cwd: rig.cwd, policy: rig.policy("full_access") });
    assert.equal(unattended.appliedConfig?.["autopilot"], true, "a session starts with autopilot on; full_access leaves it on");
    const sets = rig.harness.frames
      .filter((frame) => frame.from === "client")
      .map((frame) => frame.message as { method?: string; params?: { [key: string]: unknown } })
      .filter((message) => message.method === "session/set_config_option");
    assert.deepEqual(sets.map((message) => message.params), [{ sessionId: supervised.native.id, configId: "autopilot", type: "boolean", value: false }]);
    // A stored Kiro session comes back through session/load in a new session.
    await session.close();
    const { session: second } = await rig.open();
    const resumed = await second.resumeThread({ native: { handle: supervised.handle! }, policy: rig.policy("approval_required") });
    assert.equal(resumed.id, supervised.id);
    assert.ok(rig.harness.frames.some((frame) => (frame.message as { method?: string }).method === "session/load"));
  } finally {
    await rig.cleanup();
  }
});
