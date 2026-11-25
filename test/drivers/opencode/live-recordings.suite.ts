// The committed live OpenCode recordings: what the real `opencode` 2.1.2 did
// when a person ran `ARI_LIVE_RECORD=1 ARI_RECORD_OPENCODE_MODEL=<model> node
// scripts/record-opencode.ts`. The directory holds exactly one recording per
// scenario of the scenario module, each made live against OpenCode 2.1.2, and
// each replays through a fresh driver against the replay server with every
// scenario assertion passing. The expected files come from the scenario
// module, so a missing recording fails here. docs/recordings.md says how to
// record them again.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { readRecording } from "../../recordings/format.ts";
import { OPENCODE_PROTOCOL_WORDS } from "../../recordings/opencode/protocol-words.ts";
import { NEUTRAL_PID, NEUTRAL_SHELL, NEUTRAL_TMP_PATH, PLACEHOLDERS, createSanitiser } from "../../recordings/sanitiser.ts";
import { OPENCODE_SDK_NAME, OPENCODE_VENDOR_NAME, opencodeClientVersion } from "../../recordings/opencode/record.ts";
import { replayOpencode } from "../../recordings/opencode/replay.ts";
import { SCENARIO_NAMES } from "../../recordings/scenarios.ts";

const RECORDINGS = path.join(REPO_ROOT, "test", "drivers", "opencode", "recordings");

/** The OpenCode the live recordings come from: the 2.x release the driver's 2.x support is pinned to. */
const RECORDED_OPENCODE_VERSION = "2.1.2";

test("test/drivers/opencode/recordings/ holds exactly one recording per scenario, six in all", () => {
  assert.deepEqual(fs.readdirSync(RECORDINGS).sort(), SCENARIO_NAMES.map((name) => `${name}.ndjson`).sort());
});

for (const name of SCENARIO_NAMES) {
  test(`${name}: the live recording was made by OpenCode ${RECORDED_OPENCODE_VERSION}, and replays through the driver with every scenario assertion passing`, async () => {
    const file = path.join(RECORDINGS, `${name}.ndjson`);
    // The loader checks the body against the header's sha256.
    const recording = await readRecording(file);
    const { header } = recording;
    assert.equal(header.source, "live");
    assert.equal(header.driver, "opencode");
    assert.equal(header.scenario, name);
    assert.equal(header.vendor, OPENCODE_VENDOR_NAME);
    assert.equal(header.vendorVersion, RECORDED_OPENCODE_VERSION, "the version the recorded server's GET /api/info named");
    assert.equal(header.sdk, OPENCODE_SDK_NAME);
    assert.equal(header.sdkVersion, opencodeClientVersion(), "the pinned @opencode/client; record again after a client bump");
    assert.match(header.model, /^[^/\s]+\/\S+$/, "the provider/model used");
    // replayOpencode fails on any drift from the recording and runs the scenario's checks.
    const { run } = await replayOpencode(recording);
    assert.equal(run.scenario.name, name);
  });
}

/** Every value in `value` under one of `keys`, by key. */
function valuesUnder(value: unknown, keys: readonly string[], found: { [key: string]: unknown[] } = {}): { [key: string]: unknown[] } {
  if (Array.isArray(value)) for (const each of value) valuesUnder(each, keys, found);
  else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (keys.includes(key)) (found[key] ??= []).push(entry);
      valuesUnder(entry, keys, found);
    }
  }
  return found;
}

test("the live OpenCode recordings carry no account details: the model list holds only the recorded model, the process id, temp path and shell are neutral, and the sanitiser has nothing left to replace", async () => {
  const found: { [key: string]: unknown[] } = {};
  for (const name of SCENARIO_NAMES) {
    const recording = await readRecording(path.join(RECORDINGS, `${name}.ndjson`));
    // Only the rules that need no machine: no HOME, PATH or user name of this one.
    const sanitise = createSanitiser({ workspace: PLACEHOLDERS.workspace, env: {}, user: "ari-no-such-user", protocolWords: OPENCODE_PROTOCOL_WORDS, recordedModel: recording.header.model });
    for (const { line, frame } of recording.frames) {
      assert.deepEqual(sanitise(frame), frame, `${name}.ndjson:${line} still holds something the sanitiser replaces`);
      valuesUnder(frame, ["pid", "tmp", "shell", "providerID"], found);
      // GET /api/model: the recorded model alone, with only the fields the driver reads.
      const data = (frame["body"] as { data?: unknown } | undefined)?.data;
      if (frame.kind === "response" && Array.isArray(data) && data.some((entry) => typeof (entry as { modelID?: unknown }).modelID === "string")) {
        assert.deepEqual(data, [{ providerID: "anthropic", modelID: "claude-haiku-5-5", name: "Claude Haiku 5.5", enabled: true, limit: { context: 1000000 } }], `${name}.ndjson:${line}`);
        found["model lists"] = [...(found["model lists"] ?? []), data];
      }
    }
  }
  assert.equal(found["model lists"]?.length, SCENARIO_NAMES.length, "one GET /api/model answer in each recording");
  assert.ok(found["pid"]!.length > 0 && found["pid"]!.every((value) => value === NEUTRAL_PID), JSON.stringify(found["pid"]));
  assert.ok(found["tmp"]!.length > 0 && found["tmp"]!.every((value) => value === NEUTRAL_TMP_PATH), JSON.stringify(found["tmp"]));
  assert.ok(found["shell"]!.length > 0 && found["shell"]!.every((value) => value === NEUTRAL_SHELL), JSON.stringify(found["shell"]));
  assert.deepEqual([...new Set(found["providerID"])], ["anthropic"], "no provider but the recorded one");
});
