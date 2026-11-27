// Replays the committed captures without agy, a credential or a network call.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { scanRecordingText } from "../../../scripts/check-recordings.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { replayAntigravity } from "../../recordings/antigravity/replay.ts";
import { readRecording } from "../../recordings/format.ts";
import { SCENARIO_NAMES } from "../../recordings/scenarios.ts";
import { NEUTRAL_TIME, PLACEHOLDERS } from "../../recordings/sanitiser.ts";

const DIRECTORY = path.join(REPO_ROOT, "test", "drivers", "antigravity", "recordings");

test("the live Antigravity recordings cover exactly the shared scenarios", () => {
  assert.deepEqual(fs.readdirSync(DIRECTORY).sort(), SCENARIO_NAMES.map((name) => `${name}.ndjson`).sort());
});

for (const scenario of SCENARIO_NAMES) {
  test(`${scenario}: the live agy 1.5.17 capture replays with all scenario assertions`, async () => {
    const file = path.join(DIRECTORY, `${scenario}.ndjson`);
    const recording = await readRecording(file); // Verifies the body checksum; a missing file fails.
    const { recorded, sha256: _sha256, ...header } = recording.header;
    assert.deepEqual(header, { type: "header", format: "1.0", driver: "antigravity", vendor: "antigravity-cli", vendorVersion: "1.5.17", sdk: "acp", sdkVersion: "schema-v2.0.0-beta.3", model: "gemini-4-hydrogen", scenario, source: "live" });
    assert.match(recorded, /^\d{4}-\d{2}-\d{2}$/);
    const text = fs.readFileSync(file, "utf8");
    assert.deepEqual(scanRecordingText(text, file), []);
    assert.doesNotMatch(text, /"sessionId":"(?!<AGY_ID_\d+>")|"toolCallId":"(?!<AGY_ID_\d+>")/);
    if (scenario === "approval_allowed") {
      assert.deepEqual([...text.matchAll(/(?:Created|Completed) At: (\S+?)(?=\\r|\\n|")/g)].map((match) => match[1]), Array(4).fill(NEUTRAL_TIME.iso));
    }

    // Each process has its own config; resume must re-establish medium.
    const config = new Map<unknown, Map<string, string>>();
    let prompts = 0;
    let catalogs = 0;
    for (const { frame, line } of recording.frames) {
      const message = frame["message"] as {
        method?: string;
        result?: { models?: { currentModelId: string; availableModels: Array<{ modelId: string }> }; _meta?: { antigravity?: { tier?: unknown } }; configOptions?: Array<{ id: string; currentValue: string }> };
      } | undefined;
      if (frame.dir === "in" && message?.result?.models !== undefined) {
        const { models, _meta } = message.result;
        assert.deepEqual(models.availableModels.map(({ modelId }) => modelId), [models.currentModelId], `${file}:${line}`);
        assert.deepEqual(_meta?.antigravity?.tier, { name: PLACEHOLDERS.plan, id: PLACEHOLDERS.plan, upgradeUri: "" }, `${file}:${line}`);
        catalogs++;
      }
      if (frame.dir === "in" && message?.result?.configOptions !== undefined) {
        config.set(frame["proc"], new Map(message.result.configOptions.map(({ id, currentValue }) => [id, currentValue])));
      }
      if (frame.dir === "out" && message?.method === "session/prompt") {
        assert.equal(config.get(frame["proc"])?.get("model"), header.model, `${file}:${line}`);
        assert.equal(config.get(frame["proc"])?.get("thought_level"), "medium", `${file}:${line}`);
        prompts++;
      }
    }
    assert.equal(catalogs, scenario === "resume" ? 2 : 1);
    const { run, replay } = await replayAntigravity(recording, { env: {}, user: "offline-replay" });
    assert.equal(run.scenario.name, scenario);
    assert.equal(prompts, run.scenario.prompts.length);
    assert.deepEqual(replay.sequencer.recording, recording);
  });
}
