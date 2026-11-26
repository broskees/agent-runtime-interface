// The Codex instance's dispose() ends every session at once. Each session has
// its own app-server and waits for that process to end, which can take the
// whole kill grace; ari-driver gives a driver's dispose 2 s before it ends the
// agents itself (docs/wire.md, "Lifetime"), so one slow session must not hold
// up the next session's own shutdown.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { endsBegunTogether, slowEnds } from "../../helpers/slow-ends.ts";
import { codexRig, policy } from "./rig.ts";
import type { CodexTestRig } from "./rig.ts";

let rig: CodexTestRig | undefined;
afterEach(async () => {
  await rig?.cleanup();
  rig = undefined;
});

test("dispose() ends every session at once: three app-servers that each take 1 s to end all start ending together", async () => {
  const ends = slowEnds(1000);
  rig = await codexRig({ wrapAppServer: ends.wrap });
  for (const key of ["d1", "d2", "d3"]) {
    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: key, intent: "start", content: [{ type: "text", text: "Hi" }] });
    assert.equal(started.status, "accepted");
    const turnId = (started as { turnId: string }).turnId;
    await (await rig.nextTurn()).complete();
    await opened.until(() => opened.bodies("turn.terminal").find((body) => body.turnId === turnId), `turn.terminal of ${turnId}`);
  }
  const before = ends.startedAt.length;
  const disposing = Date.now();
  await rig.instance.dispose();
  const sessionEnds = ends.startedAt.slice(before);
  assert.ok(sessionEnds.length >= 3, `each session's app-server was ended: ${sessionEnds.length} ends`);
  assert.ok(endsBegunTogether(sessionEnds, 500) >= 3, `the three sessions' ends began together: ${sessionEnds.map((time) => time - disposing).join(", ")} ms after dispose()`);
});
