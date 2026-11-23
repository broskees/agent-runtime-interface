// The replay recorder records a session into the fixture format of
// spec/v1/fixture.schema.json; the written file validates against the schema
// and loads back with the same events.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { PERSISTENCE_VERSION, isAriError } from "../../src/index.ts";
import type { AriEvent } from "../../src/index.ts";
import {
  EventGrammar,
  FixtureSchema,
  ReplayRecorder,
  fixtureEvents,
  guardSession,
  parseFixture,
  replayEvents,
  serializeFixture,
} from "../../src/host/index.ts";
import { fullCapabilities } from "../fixtures/capabilities.ts";
import { fakeSession } from "../fixtures/fake-session.ts";
import { createSpecAjv, defId } from "../helpers/spec.ts";

const tempDirs: string[] = [];
after(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
});

const POLICY = { mode: "approval_required", interaction: "default", cwd: "/work" } as const;

async function recordSampleSession(): Promise<{ recorder: ReplayRecorder; consumed: AriEvent[] }> {
  let tick = 0;
  const recorder = new ReplayRecorder({
    name: "sample",
    description: "two turns, a snapshot, a refused rollback and a failed call",
    driver: { kind: "fake", version: "0.0.0", identityVersion: 1 },
    clock: () => new Date(Date.UTC(2026, 10, 23, 13, 0, tick++)).toISOString(),
  });
  const capabilities = fullCapabilities();
  capabilities.threads.rollback = false;
  const session = recorder.recordSession(guardSession(fakeSession(capabilities)));

  const consumed: AriEvent[] = [];
  const reading = (async () => {
    for await (const event of session.events()) consumed.push(event);
  })();

  const thread = await session.createThread({ cwd: "/work", policy: POLICY });
  await session.startTurn({ threadId: thread.id, clientTurnKey: "key-1", intent: "start", content: [{ type: "text", text: "hello" }] });
  await session.respond({ requestId: "request-1", responseKey: "key-a", optionId: "allow" });
  await session.readSnapshot!(thread.id);
  await assert.rejects(session.rollbackThread!({ threadId: thread.id, to: { type: "start" } }), (error: unknown) => isAriError(error, "unsupported"));
  await assert.rejects(session.readSnapshot!("thread-missing"), /no thread thread-missing/);
  assert.equal(session.contextWindow!("fast"), 200_000);
  await session.mcpApps!.callTool(thread.id, "docs", "search", { q: "x" });
  await session.startTurn({ threadId: thread.id, clientTurnKey: "key-2", intent: "start", content: [{ type: "text", text: "again" }] });

  // A reconnect that replays seq 2 to 4 again records nothing twice.
  const replayedSeqs: number[] = [];
  for await (const event of session.events({ fromSeq: 2 })) {
    replayedSeqs.push(event.seq);
    if (event.seq === 4) break;
  }
  assert.deepEqual(replayedSeqs, [2, 3, 4]);
  await session.close();
  await reading;
  return { recorder, consumed };
}

describe("replay recorder", () => {
  test("records a session to a file that validates against spec/v1/fixture.schema.json and replays the same events", async () => {
    const { recorder, consumed } = await recordSampleSession();
    assert.ok(consumed.length >= 10, `${consumed.length} events`);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-fixture-"));
    tempDirs.push(directory);
    const file = path.join(directory, "sample.fixture.json");
    fs.writeFileSync(file, serializeFixture(recorder.fixture()));

    const written: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const validate = createSpecAjv().getSchema(defId("fixture.schema.json", "Fixture"));
    assert.ok(validate !== undefined);
    assert.equal(validate(written), true, JSON.stringify(validate.errors));
    assert.equal(FixtureSchema.is(written), true);

    const loaded = parseFixture(fs.readFileSync(file, "utf8"));
    const replayed: AriEvent[] = [];
    for await (const event of replayEvents(loaded)) replayed.push(event);
    assert.deepEqual(replayed, consumed);
    assert.deepEqual(fixtureEvents(loaded), consumed);

    // The replayed stream keeps the event grammar.
    const strict = new EventGrammar({ mode: "strict" });
    for (const event of replayed) strict.observe(event);
  });

  test("the fixture carries the persistence version, the header and every call with its outcome in order", async () => {
    const { recorder } = await recordSampleSession();
    const fixture = recorder.fixture();
    assert.deepEqual(fixture.persistence, { major: PERSISTENCE_VERSION.major, minor: PERSISTENCE_VERSION.minor });
    assert.equal(fixture.format, "ari.fixture");
    assert.equal(fixture.grammarVersion, 1);
    assert.equal(fixture.sessionId, "session-fake");
    assert.equal(fixture.driver?.kind, "fake");
    assert.equal(fixture.capabilities?.threads.rollback, false);

    const calls = fixture.entries.flatMap((entry) => (entry.type === "call" ? [entry] : []));
    assert.deepEqual(
      calls.map((entry) => entry.method),
      [
        "session/createThread",
        "session/startTurn",
        "session/respond",
        "session/readSnapshot",
        "session/rollbackThread",
        "session/readSnapshot",
        "session/contextWindow",
        "session/mcpApps.callTool",
        "session/startTurn",
        "session/close",
      ],
    );
    assert.deepEqual(calls[3]!.params, { threadId: "thread-1" });
    assert.deepEqual(calls[7]!.params, { threadId: "thread-1", server: "docs", tool: "search", args: { q: "x" } });

    const outcomeOf = (callId: number) => fixture.entries.find((entry) => (entry.type === "result" || entry.type === "error") && entry.callId === callId);
    const refused = outcomeOf(calls[4]!.callId);
    assert.ok(refused?.type === "error");
    assert.equal(refused.callError?.code, "unsupported");
    const failed = outcomeOf(calls[5]!.callId);
    assert.ok(failed?.type === "error");
    assert.equal(failed.callError, undefined);
    assert.match(failed.message, /no thread thread-missing/);
    const contextWindow = outcomeOf(calls[6]!.callId);
    assert.ok(contextWindow?.type === "result");
    assert.equal(contextWindow.result, 200_000);
    const closed = outcomeOf(calls[9]!.callId);
    assert.ok(closed?.type === "result");
    assert.equal(closed.result, null);

    const seqs = fixtureEvents(fixture).map((event) => event.seq);
    assert.deepEqual(seqs, seqs.map((_seq, index) => index + 1));
  });

  test("a fixture with a higher persistence major version is refused with an error naming both versions", () => {
    const newer = { format: "ari.fixture", persistence: { major: PERSISTENCE_VERSION.major + 1, minor: 3 }, ariVersion: "9.0.0", grammarVersion: 1, entries: [] };
    assert.throws(
      () => parseFixture(JSON.stringify(newer)),
      (error: unknown) => {
        assert.ok(isAriError(error, "validation"));
        assert.match(error.message, new RegExp(`${PERSISTENCE_VERSION.major + 1}\\.3`));
        assert.match(error.message, new RegExp(`${PERSISTENCE_VERSION.major}\\.${PERSISTENCE_VERSION.minor}`));
        return true;
      },
    );
    const older = { ...newer, persistence: { major: PERSISTENCE_VERSION.major, minor: 0 } };
    assert.equal(parseFixture(older).entries.length, 0);
  });

  test("a fixture that does not match the schema is refused", () => {
    assert.throws(
      () => parseFixture({ format: "ari.fixture", persistence: { major: 1, minor: 0 }, ariVersion: "1.0.0", grammarVersion: 1, entries: [{ type: "event" }] }),
      (error: unknown) => isAriError(error, "validation"),
    );
  });
});
