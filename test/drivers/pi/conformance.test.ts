// Runs the 15 conformance scenarios against the Pi driver and fake
// `pi --mode rpc` processes, then checks every RPC frame of the run (both
// directions) and every line of every session file the fakes wrote against
// the types `@earendil-works/pi-coding-agent` publishes.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { conformanceTests } from "../../../src/conformance/index.ts";
import { piHarness } from "./harness.ts";
import { checkAgainstPiTypes, sessionLinesUnder } from "./pi-types.ts";

const harness = piHarness();
after(() => harness.cleanup());

conformanceTests(test, harness);

test("every frame of the conformance run, and every session file line, matches Pi's published types", () => {
  const sent = harness.frames.filter((frame) => frame.direction === "in").map((frame) => frame.record);
  const received = harness.frames.filter((frame) => frame.direction === "out").map((frame) => frame.record);
  const sessionLines = sessionLinesUnder(harness.root);
  // The run must have produced each family of record, or the check would prove little.
  for (const type of ["prompt", "steer", "abort", "get_state", "get_entries", "compact", "clear_queue", "extension_ui_response"]) {
    assert.ok(sent.some((record) => record["type"] === type), `the driver never sent ${type}`);
  }
  for (const type of ["response", "agent_start", "message_update", "tool_execution_end", "agent_settled", "extension_ui_request", "compaction_end", "queue_update"]) {
    assert.ok(received.some((record) => record["type"] === type), `the fake never sent ${type}`);
  }
  assert.ok(sessionLines.some((line) => (line as { type?: unknown }).type === "session"));
  assert.deepEqual(checkAgainstPiTypes({ sent, received, sessionLines }), []);
});
