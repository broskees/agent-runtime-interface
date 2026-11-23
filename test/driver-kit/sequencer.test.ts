// The event sequencer numbers each session's events 1, 2, 3, ... with no
// gaps, and events({ fromSeq }) replays from that number and then continues
// live.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AriEventSchema, isAriError } from "../../src/index.ts";
import type { AriEvent } from "../../src/index.ts";
import { EventSequencer } from "../../src/driver-kit/index.ts";

function notice(text: string): { body: { type: "notice"; level: "info"; text: string } } {
  return { body: { type: "notice", level: "info", text } };
}

/** Reads `count` events from an iterator. */
async function take(iterator: AsyncIterator<AriEvent>, count: number): Promise<AriEvent[]> {
  const events: AriEvent[] = [];
  while (events.length < count) {
    const next = await iterator.next();
    if (next.done === true) break;
    events.push(next.value);
  }
  return events;
}

describe("event sequencer", () => {
  test("seq is gap-free and increasing per session, starting at 1", () => {
    const first = new EventSequencer({ sessionId: "session-a" });
    const second = new EventSequencer({ sessionId: "session-b" });
    const a = [first.emit(notice("a1")), first.emit(notice("a2")), first.emit(notice("a3"))];
    const b = [second.emit(notice("b1")), second.emit(notice("b2"))];
    assert.deepEqual(a.map((event) => event.seq), [1, 2, 3]);
    assert.deepEqual(b.map((event) => event.seq), [1, 2]);
    assert.equal(first.lastSeq, 3);
    for (const event of [...a, ...b]) assert.ok(AriEventSchema.is(event));
    assert.deepEqual(a.map((event) => event.sessionId), ["session-a", "session-a", "session-a"]);
  });

  test("the envelope keeps the ids and tag it is given, and the clock stamps the time", () => {
    const sequencer = new EventSequencer({ sessionId: "s", clock: () => "2026-11-23T12:00:00.000Z" });
    const event = sequencer.emit({ ...notice("x"), threadId: "thread-1", turnId: "turn-1", hostTag: "tag", native: { method: "m" } });
    assert.deepEqual(event, {
      seq: 1,
      at: "2026-11-23T12:00:00.000Z",
      sessionId: "s",
      threadId: "thread-1",
      turnId: "turn-1",
      hostTag: "tag",
      body: { type: "notice", level: "info", text: "x" },
      native: { method: "m" },
    });
  });

  test("events({ fromSeq }) replays from that number and then continues live", async () => {
    const sequencer = new EventSequencer({ sessionId: "s" });
    for (let index = 1; index <= 5; index += 1) sequencer.emit(notice(`n${index}`));

    const stream = sequencer.events({ fromSeq: 3 });
    const replayed = await take(stream, 3);
    assert.deepEqual(replayed.map((event) => event.seq), [3, 4, 5]);

    const live = stream.next();
    let settled = false;
    void live.then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the stream waits for the next event");

    const emitted = sequencer.emit(notice("n6"));
    const next = await live;
    assert.equal(next.done, false);
    assert.equal(next.value, emitted);
    assert.equal(emitted.seq, 6);
  });

  test("a reconnect with fromSeq gets the identical events a first reader got", async () => {
    const sequencer = new EventSequencer({ sessionId: "s" });
    const first = sequencer.events();
    for (let index = 1; index <= 4; index += 1) sequencer.emit(notice(`n${index}`));
    const seen = await take(first, 4);
    await first.return?.();
    sequencer.emit(notice("n5"));

    const resumed = await take(sequencer.events({ fromSeq: 2 }), 4);
    assert.deepEqual(resumed, [...seen.slice(1), resumed[3]]);
    assert.deepEqual(resumed.map((event) => event.seq), [2, 3, 4, 5]);
  });

  test("several readers read independently, and close() ends each once it has caught up", async () => {
    const sequencer = new EventSequencer({ sessionId: "s" });
    const readers = [sequencer.events(), sequencer.events()].map(async (stream) => {
      const seqs: number[] = [];
      for await (const event of stream) seqs.push(event.seq);
      return seqs;
    });
    sequencer.emit(notice("1"));
    await new Promise((resolve) => setImmediate(resolve));
    sequencer.emit(notice("2"));
    sequencer.close();
    assert.deepEqual(await Promise.all(readers), [
      [1, 2],
      [1, 2],
    ]);
    assert.throws(() => sequencer.emit(notice("late")), /closed/);
  });

  test("an aborted signal ends a waiting stream", async () => {
    const sequencer = new EventSequencer({ sessionId: "s" });
    const controller = new AbortController();
    const stream = sequencer.events({ signal: controller.signal });
    const pending = stream.next();
    controller.abort();
    assert.deepEqual(await pending, { done: true, value: undefined });
    sequencer.emit(notice("after"));
    assert.deepEqual(await stream.next(), { done: true, value: undefined });
  });

  test("fromSeq must be a positive integer", () => {
    const sequencer = new EventSequencer({ sessionId: "s" });
    assert.throws(() => sequencer.events({ fromSeq: 0 }), (error: unknown) => isAriError(error, "validation"));
    assert.throws(() => sequencer.events({ fromSeq: 1.5 }), (error: unknown) => isAriError(error, "validation"));
  });
});
