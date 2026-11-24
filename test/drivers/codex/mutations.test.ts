// Mutations of the driver's behavior on the wire that the Codex tests must
// catch. Each test changes what the driver writes to the app-server, the way
// a broken driver would, and shows which check fails.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createConformanceSuite } from "../../../src/conformance/index.ts";
import type { SpawnedProcess } from "../../../src/index.ts";
import type { Request } from "../../../src/index.ts";
import { codexHarness } from "./harness.ts";
import { codexRig, policy } from "./rig.ts";

/** The app-server process, except that every approval decision the driver writes reaches Codex twice. */
function answerDecisionsTwice(process: SpawnedProcess): SpawnedProcess {
  return {
    ...process,
    stdout: process.stdout,
    stderr: process.stderr,
    exited: process.exited,
    async write(data) {
      await process.write(data);
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      if (/"result":\{"decision"/.test(text)) await process.write(data);
    },
  };
}

const SECOND_REPLY = /a second reply to server request \d+ \(item\/commandExecution\/requestApproval\)/;

describe("a driver that answers each approval decision twice", () => {
  const harness = codexHarness({ wrapAppServer: answerDecisionsTwice });
  after(() => harness.cleanup());

  test("fails the rig's frame check: the fake records the second reply and the rig's cleanup throws", async () => {
    const rig = await codexRig({ wrapAppServer: answerDecisionsTwice });
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "m-1", intent: "start", content: [{ type: "text", text: "Check." }] });
    const native = await rig.nextTurn();
    const approval = await native.commandApproval("git status", ["accept", "cancel"]);
    const request = await opened.until(() => opened.bodies("request.upsert").find((body) => body.request.status === "pending")?.request as Request | undefined, "the approval");
    await opened.session.respond({ requestId: request.id, responseKey: "once", optionId: "accept" });
    assert.equal(await approval.decision, "accept");
    await opened.until(() => (rig.world.validator.problems.length > 0 ? true : undefined), "the fake to record the second reply");
    assert.match(rig.world.validator.problems[0]!.message, SECOND_REPLY);
    await native.complete();
    await assert.rejects(rig.cleanup(), SECOND_REPLY);
  });

  test("fails the conformance run's frame check, which conformance.test.ts asserts is empty, though scenarios 8 and 15 still pass", async () => {
    const suite = createConformanceSuite(harness, { scenarios: ["duplicate-always-options", "idempotent-responses"], timeoutMs: 3000 });
    for (const scenario of suite.order) {
      const result = await suite.run(scenario);
      assert.equal(result.status, "passed", result.reason);
    }
    const problems = harness.worlds.flatMap((world) => world.validator.problems).map((problem) => problem.message);
    assert.ok(problems.length > 0, "the frame check found nothing");
    assert.ok(problems.every((message) => SECOND_REPLY.test(message)), problems.join("\n"));
  });
});
