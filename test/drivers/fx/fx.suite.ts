// fx's quirks: its launch command, and a model option that depends on the
// provider option, kept on every option list fx sends.

import assert from "node:assert/strict";
import { test } from "node:test";
import { FX_DEFAULT_CONFIG, fxDriver } from "../../../src/drivers/fx/index.ts";
import type { ConfigOption } from "../../../src/index.ts";
import { openRig, until } from "../acp/rig.ts";
import { FX_OPTIONS_V1 } from "./fixtures.ts";

test("fx runs `fx acp` and exposes a provider select and a model select that depends on it", async () => {
  const rig = await openRig({ name: "fx", driver: fxDriver, config: { ...FX_DEFAULT_CONFIG }, executable: "fx", protocol: 1, agentArgs: ["--config-options", JSON.stringify(FX_OPTIONS_V1)] });
  try {
    const { session, events } = await rig.open();
    const runtime = rig.host.spawns.find((spawn) => spawn.purpose === "runtime")!;
    assert.equal(runtime.command, "fx");
    assert.deepEqual(runtime.args, ["acp"]);
    const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy(), config: { provider: "anthropic" } });
    assert.equal(thread.appliedConfig?.["provider"], "anthropic");
    const lists = await until(() => {
      const found = events.flatMap((event) => (event.body.type === "config.updated" ? [event.body.options] : []));
      return found.length >= 3 ? found : undefined;
    }, "the option lists fx sent: on session/new, on set_config_option, and in its config_option_update");
    for (const options of lists) {
      const provider = options.find((option: ConfigOption) => option.id === "provider")!;
      const model = options.find((option: ConfigOption) => option.id === "model")!;
      assert.equal(provider.type, "select");
      assert.deepEqual(provider.values?.map((value) => value.id), ["openai", "anthropic"]);
      assert.equal(model.type, "select");
      assert.equal(model.category, "model");
      assert.deepEqual(model.dependsOn, ["provider"]);
      assert.equal(provider.dependsOn, undefined);
    }
  } finally {
    await rig.cleanup();
  }
});
