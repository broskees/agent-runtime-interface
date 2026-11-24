// Runs the 15 conformance scenarios against the OpenCode driver four times:
// against a fake OpenCode 1.19.6 (one server per thread, started by the
// driver) and a fake OpenCode 2.1.2 (one server per instance), each also as an
// external server the driver neither starts nor stops. The fakes check every
// request, response and event of the runs against the vendored OpenAPI
// documents and, for 2.x events, against `@opencode/protocol`.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { conformanceTests } from "../../../src/conformance/index.ts";
import { opencodeHarness } from "./harness.ts";

for (const [generation, external] of [
  [1, false],
  [2, false],
  [1, true],
  [2, true],
] as const) {
  describe(`OpenCode ${generation}.x${external ? ", external server" : ""}`, () => {
    const harness = opencodeHarness({ generation, external });
    after(() => harness.cleanup());

    conformanceTests(test, harness);

    test(`every request, response and event of the ${generation}.x${external ? " external" : ""} conformance run matches the pinned OpenCode ${generation}.x schemas`, () => {
      const frames = harness.worlds.flatMap((world) => world.frames);
      const operations = new Set(frames.map((frame) => frame.operation));
      const expected =
        generation === 1
          ? ["session.create", "session.prompt_async", "session.abort", "session.fork", "session.revert", "session.summarize", "permission.reply", "mcp.add", "session.update", "session.messages", "message.part.delta", "session.idle", "permission.asked"]
          : ["session.create", "session.prompt", "session.interrupt", "session.fork", "session.revert.stage", "session.revert.commit", "session.compact", "session.permission.reply", "experimental.mcp.add", "session.update", "session.message.list", "session.active", "session.inbox.cancel", "session.text.delta", "session.execution.succeeded", "permission.asked"];
      for (const operation of expected) assert.ok(operations.has(operation), `the run never exchanged ${operation}`);
      assert.deepEqual(harness.worlds.flatMap((world) => world.violations), []);
    });
  });
}
