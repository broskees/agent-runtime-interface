// A crashed driver fails cleanly. The reference driver runs inside the built
// `ari-driver`; mid-turn, with two calls waiting on the host, the test kills
// the process with SIGKILL. Within 5 seconds the session's event stream must
// end with that turn's `turn.terminal` (status `failed`, failure class
// `transport_error`), and every pending call must reject with the `transport`
// call error. Nothing may hang.

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createFakeHost, referenceHarness } from "../../src/conformance/index.ts";
import { EventGrammar } from "../../src/host/index.ts";
import { isAriError } from "../../src/index.ts";
import type { AriEvent, ConfigValues, TurnTerminalBody } from "../../src/index.ts";
import type { HostServices } from "../../src/runtime.ts";
import { REFERENCE_DRIVER_MODULE, startBuiltAriDriver } from "./helpers.ts";

const LIMIT_MS = 5000;

/** Settles like `promise`, or rejects once `ms` of real time passed. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, delay(ms, undefined, { ref: false }).then(() => Promise.reject(new Error(`${what} did not happen within ${ms} ms`)))]);
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(5);
  }
}

test("killing ari-driver mid-turn ends the turn failed with transport_error and rejects every pending call within 5 s", async () => {
  const harness = referenceHarness();
  const workspace = await harness.workspace();
  const rig = await harness.setup({ scenario: "crash", workspace, ambientAuth: "authenticated" });
  const driverProcess = await startBuiltAriDriver({ driver: REFERENCE_DRIVER_MODULE, delegateProcesses: true });
  try {
    const instanceId = "crash-instance";
    const hostOptions = await rig.hostOptions!(instanceId, { managedProfile: false });
    let probeSpawns = 0;
    let hangProbes = false;
    const host = createFakeHost({
      ...hostOptions,
      config: rig.config,
      // Once the turn runs, a probe's spawn never answers, so the calls that probe stay pending until the driver dies.
      spawn: async (request) => {
        if (hangProbes && request.purpose === "probe") {
          probeSpawns += 1;
          return new Promise(() => undefined);
        }
        return hostOptions.spawn!(request);
      },
    });
    const instance = await driverProcess.driver.create(host as unknown as HostServices, { instanceId, config: rig.config as unknown as ConfigValues, environment: {} });
    const session = await instance.openSession({});
    const events: AriEvent[] = [];
    const reading = (async () => {
      for await (const event of session.events()) events.push(event);
    })();

    const thread = await session.createThread({ cwd: workspace.cwd, policy: { mode: "approval_required", interaction: "default", cwd: workspace.cwd } });
    const started = await session.startTurn({ threadId: thread.id, clientTurnKey: "crash-turn", intent: "start", content: [{ type: "text", text: "Start the build." }] });
    assert.equal(started.status, "accepted");
    const turnId = started.status === "accepted" ? started.turnId : "";
    const native = await rig.native.nextTurn();
    await native.say("Working on it");
    await until(() => events.some((event) => event.body.type === "item.delta"), "the streamed text");

    hangProbes = true;
    const pending = [instance.probe(), instance.status()];
    await until(() => probeSpawns === 2, "both calls to wait on the host");
    assert.equal(events.some((event) => event.body.type === "turn.terminal"), false, "the turn is still running");
    const lastSeqBefore = events.at(-1)!.seq;

    const killedAt = Date.now();
    driverProcess.child.kill("SIGKILL");

    await within(reading, LIMIT_MS, "the event stream ending");
    const outcomes = await within(Promise.allSettled(pending), LIMIT_MS, "the pending calls settling");
    assert.ok(Date.now() - killedAt < LIMIT_MS, `took ${Date.now() - killedAt} ms`);

    const last = events.at(-1)!;
    assert.equal(last.body.type, "turn.terminal", "the stream ends with a turn.terminal");
    const terminal = last.body as TurnTerminalBody;
    assert.equal(terminal.turnId, turnId);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.failure?.class, "transport_error");
    assert.equal(last.seq, lastSeqBefore + 1, "the terminal continues the stream's numbering");
    assert.equal(last.threadId, thread.id);
    assert.equal(events.filter((event) => event.body.type === "turn.terminal").length, 1);
    // The stream, ending included, still keeps the event grammar.
    const grammar = new EventGrammar({ mode: "strict" });
    for (const event of events) grammar.observe(event);

    for (const outcome of outcomes) {
      assert.equal(outcome.status, "rejected");
      assert.ok(isAriError((outcome as PromiseRejectedResult).reason, "transport"), `rejected with ${String((outcome as PromiseRejectedResult).reason)}`);
    }
    // Calls made after the crash fail the same way, at once.
    await assert.rejects(session.startTurn({ threadId: thread.id, clientTurnKey: "after", intent: "start", content: [{ type: "text", text: "Again." }] }), (error: unknown) => isAriError(error, "transport"));
    await assert.rejects(instance.status(), (error: unknown) => isAriError(error, "transport"));
    const closedWith = await within(driverProcess.closed, LIMIT_MS, "the connection closing");
    assert.equal(closedWith.code, "transport");
    assert.match(closedWith.message, /ari-driver/);
  } finally {
    await rig.dispose?.();
    await driverProcess.close();
  }
});
