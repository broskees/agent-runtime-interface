// The NDJSON framer handles a record split across chunks, several records in
// one chunk, a 5 MB line, and an invalid line reported without ending the
// stream.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NdjsonDecoder, encodeNdjson, readNdjson } from "../../src/driver-kit/index.ts";
import type { NdjsonRecord } from "../../src/driver-kit/index.ts";

const encoder = new TextEncoder();

function values(records: readonly NdjsonRecord[]): unknown[] {
  return records.map((record) => (record.ok ? record.value : { invalid: record.line }));
}

describe("NDJSON framing", () => {
  test("a record split across chunks, even inside a multi-byte character, is decoded once whole", () => {
    const bytes = encoder.encode('{"text":"héllo ✓ 🎉","n":1}\n');
    const decoder = new NdjsonDecoder();
    const records: NdjsonRecord[] = [];
    for (let index = 0; index < bytes.length; index += 1) records.push(...decoder.push(bytes.subarray(index, index + 1)));
    records.push(...decoder.end());
    assert.deepEqual(values(records), [{ text: "héllo ✓ 🎉", n: 1 }]);
  });

  test("several records in one chunk come out in order", () => {
    const decoder = new NdjsonDecoder();
    const records = decoder.push(encoder.encode('{"a":1}\n{"b":2}\r\n\n[3]\n"four"\n{"partial":'));
    assert.deepEqual(values(records), [{ a: 1 }, { b: 2 }, [3], "four"]);
    assert.deepEqual(values(decoder.push("true}\n")), [{ partial: true }]);
  });

  test("a 5 MB line arriving in 64 KiB chunks is decoded", () => {
    const big = "x".repeat(5 * 1024 * 1024);
    const bytes = encoder.encode(`${JSON.stringify({ big })}\n{"after":true}\n`);
    const decoder = new NdjsonDecoder();
    const records: NdjsonRecord[] = [];
    for (let index = 0; index < bytes.length; index += 64 * 1024) records.push(...decoder.push(bytes.subarray(index, index + 64 * 1024)));
    records.push(...decoder.end());
    assert.equal(records.length, 2);
    const first = records[0]!;
    assert.ok(first.ok);
    assert.equal((first.value as { big: string }).big.length, big.length);
    assert.deepEqual(values(records.slice(1)), [{ after: true }]);
  });

  test("an invalid JSON line is reported and the stream goes on", async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield encoder.encode('{"ok":1}\n{"broken": \n');
      yield encoder.encode('{"ok":2}\n');
      yield encoder.encode('{"last":3}');
    }
    const records: NdjsonRecord[] = [];
    for await (const record of readNdjson(chunks())) records.push(record);
    assert.equal(records.length, 4);
    assert.deepEqual(records[0], { ok: true, value: { ok: 1 } });
    const invalid = records[1]!;
    assert.equal(invalid.ok, false);
    assert.ok(!invalid.ok && invalid.line === '{"broken": ' && invalid.error.length > 0);
    assert.deepEqual(values(records.slice(2)), [{ ok: 2 }, { last: 3 }]);
  });

  test("records split only on line feeds, never on U+2028 or U+2029", () => {
    const decoder = new NdjsonDecoder();
    const text = `{"text":"a\u2028b\u2029c"}\n`;
    assert.deepEqual(values(decoder.push(text)), [{ text: "a\u2028b\u2029c" }]);
  });

  test("encodeNdjson writes one line per value and refuses a value with no JSON form", () => {
    const line = encodeNdjson({ text: "two\nlines" });
    assert.equal(line, '{"text":"two\\nlines"}\n');
    assert.equal(line.indexOf("\n"), line.length - 1);
    assert.deepEqual(values(new NdjsonDecoder().push(line)), [{ text: "two\nlines" }]);
    assert.throws(() => encodeNdjson(undefined), TypeError);
  });
});
