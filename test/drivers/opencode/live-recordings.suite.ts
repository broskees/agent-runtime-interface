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
