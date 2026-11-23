// truncateUtf8 caps text by UTF-8 bytes without splitting a character and
// says when it cut; CleanupScope aborts its signal and runs cleanups in
// reverse order.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CleanupScope, truncateUtf8 } from "../../src/driver-kit/index.ts";

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe("truncateUtf8", () => {
  test("text that fits is returned whole with truncated: false", () => {
    assert.deepEqual(truncateUtf8("héllo", 6), { text: "héllo", truncated: false });
    assert.deepEqual(truncateUtf8("", 0), { text: "", truncated: false });
  });

  test("the cut never splits a multi-byte character and sets truncated: true", () => {
    // "é" is 2 bytes, "✓" 3 bytes and "🎉" 4 bytes (a surrogate pair).
    const text = "aé✓🎉b";
    const cases: Array<[number, string]> = [
      [0, ""],
      [1, "a"],
      [2, "a"],
      [3, "aé"],
      [5, "aé"],
      [6, "aé✓"],
      [9, "aé✓"],
      [10, "aé✓🎉"],
    ];
    for (const [maxBytes, expected] of cases) {
      assert.deepEqual(truncateUtf8(text, maxBytes), { text: expected, truncated: true }, `maxBytes ${maxBytes}`);
    }
    assert.deepEqual(truncateUtf8(text, 11), { text, truncated: false });
  });

  test("every cap gives the longest prefix whose UTF-8 encoding fits", () => {
    const text = "Output: ✓ passed 🎉 — naïve café ".repeat(200);
    for (let maxBytes = 0; maxBytes < 400; maxBytes += 1) {
      const { text: cut, truncated } = truncateUtf8(text, maxBytes);
      assert.ok(utf8Bytes(cut) <= maxBytes);
      assert.equal(truncated, true);
      assert.ok(text.startsWith(cut));
      const nextCharacter = String.fromCodePoint(text.codePointAt(cut.length)!);
      assert.ok(utf8Bytes(cut) + utf8Bytes(nextCharacter) > maxBytes, `maxBytes ${maxBytes} stopped early`);
    }
  });

  test("a lone surrogate counts as the 3 bytes of U+FFFD", () => {
    assert.deepEqual(truncateUtf8("a\ud800b", 4), { text: "a\ud800", truncated: true });
    assert.deepEqual(truncateUtf8("a\ud800b", 3), { text: "a", truncated: true });
  });

  test("a negative or fractional cap is refused", () => {
    assert.throws(() => truncateUtf8("x", -1), RangeError);
    assert.throws(() => truncateUtf8("x", 1.5), RangeError);
  });
});

describe("CleanupScope", () => {
  test("close aborts the signal, then runs cleanups last-first, awaiting each", async () => {
    const scope = new CleanupScope();
    const order: string[] = [];
    scope.defer(() => order.push("first"));
    scope.defer(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`second (signal aborted: ${String(scope.signal.aborted)})`);
    });
    await scope.close("done");
    assert.deepEqual(order, ["second (signal aborted: true)", "first"]);
    assert.equal(scope.signal.reason, "done");
    assert.equal(scope.closed, true);
    assert.equal(await scope.close(), undefined);
  });

  test("every cleanup runs even when some fail, and the failures are thrown together", async () => {
    const scope = new CleanupScope();
    const ran: number[] = [];
    scope.defer(() => {
      ran.push(1);
      throw new Error("one");
    });
    scope.defer(() => ran.push(2));
    scope.defer(() => {
      ran.push(3);
      throw new Error("three");
    });
    await assert.rejects(scope.close(), (error: unknown) => error instanceof AggregateError && error.errors.length === 2);
    assert.deepEqual(ran, [3, 2, 1]);
  });

  test("a scope closes when its parent signal aborts, and refuses cleanups after closing", async () => {
    const parent = new AbortController();
    const scope = new CleanupScope(parent.signal);
    let cleaned = false;
    scope.defer(() => (cleaned = true));
    parent.abort(new Error("session closed"));
    await scope.close();
    assert.equal(cleaned, true);
    assert.equal((scope.signal.reason as Error).message, "session closed");
    assert.throws(() => scope.defer(() => undefined), /closed/);

    const aborted = new CleanupScope(AbortSignal.abort("already"));
    assert.equal(aborted.signal.aborted, true);
  });
});
