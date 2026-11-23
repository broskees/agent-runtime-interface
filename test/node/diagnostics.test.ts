// Diagnostics in `ari/node`: entries past the byte budget (64 KiB by default)
// are truncated to fit, and the values of registered secrets are redacted
// everywhere in an entry, before any truncation.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DiagnosticEntrySchema } from "../../src/index.ts";
import { createDiagnostics, DEFAULT_DIAGNOSTIC_ENTRY_BYTES } from "../../src/node/index.ts";
import type { DiagnosticRecord } from "../../src/node/index.ts";

function collect(maxEntryBytes?: number): { records: DiagnosticRecord[]; diagnostics: ReturnType<typeof createDiagnostics> } {
  const records: DiagnosticRecord[] = [];
  const write = (record: DiagnosticRecord): void => {
    records.push(record);
  };
  const diagnostics = createDiagnostics(maxEntryBytes === undefined ? { write } : { write, maxEntryBytes });
  return { records, diagnostics };
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("ari/node diagnostics", () => {
  test("the default budget is 64 KiB, and an entry within it passes unchanged", () => {
    assert.equal(DEFAULT_DIAGNOSTIC_ENTRY_BYTES, 65536);
    const { records, diagnostics } = collect();
    const entry = { level: "info", msg: "turn started", native: { method: "turn/start", id: 7 }, data: ["a", 1, null] };
    diagnostics.log(entry);
    assert.deepEqual(records, [entry]);
  });

  test("an entry past the default budget is truncated to fit and marked truncated", () => {
    const { records, diagnostics } = collect();
    const bigFrame = { method: "item/delta", params: { text: "x".repeat(200 * 1024) } };
    diagnostics.log({ level: "debug", msg: "native frame", native: bigFrame, data: { rows: Array.from({ length: 5000 }, (_, index) => index) } });
    const [record] = records;
    assert.ok(record !== undefined);
    assert.ok(jsonBytes(record) <= 65536, `record is ${jsonBytes(record)} bytes`);
    assert.ok(jsonBytes(record) > 60000, "the budget is used, not thrown away");
    assert.equal(record.truncated, true);
    assert.equal(record.level, "debug");
    assert.equal(record.msg, "native frame");
    assert.equal(DiagnosticEntrySchema.is(record), true);
    assert.ok(typeof record.native === "string" && JSON.stringify(bigFrame).startsWith(record.native), "native keeps a prefix of its JSON text");
  });

  test("a huge message is cut without splitting a multi-byte or surrogate-pair character", () => {
    const { records, diagnostics } = collect(1000);
    const message = "€😀".repeat(5000);
    diagnostics.log({ level: "warn", msg: message });
    const [record] = records;
    assert.ok(record !== undefined);
    assert.ok(jsonBytes(record) <= 1000);
    assert.equal(record.truncated, true);
    assert.ok(message.startsWith(record.msg));
    assert.ok(record.msg.length > 0);
    // Each repeat is "€" (one code unit) then "😀" (two): a cut after two units would split the emoji.
    assert.notEqual(record.msg.length % 3, 2, "the cut falls between whole characters");
    assert.equal(Buffer.from(record.msg, "utf8").toString("utf8"), record.msg, "the text is valid UTF-8");
  });

  test("registered secret values are redacted in the message, keys and nested values", () => {
    const { records, diagnostics } = collect();
    diagnostics.registerSecret("sk-ant-0123456789");
    diagnostics.registerSecret(new TextEncoder().encode("oauth-refresh-token-abc"));
    diagnostics.registerSecret("");
    diagnostics.log({
      level: "error",
      msg: "auth failed with sk-ant-0123456789 for user",
      native: { headers: { authorization: "Bearer sk-ant-0123456789" }, list: ["x oauth-refresh-token-abc y"] },
      data: { "sk-ant-0123456789": true, nested: [{ deeper: "prefix-oauth-refresh-token-abc-suffix" }] },
    });
    const [record] = records;
    const text = JSON.stringify(record);
    assert.equal(text.includes("sk-ant-0123456789"), false);
    assert.equal(text.includes("oauth-refresh-token-abc"), false);
    assert.equal(record?.msg, "auth failed with [redacted] for user");
    assert.deepEqual(record?.native, { headers: { authorization: "Bearer [redacted]" }, list: ["x [redacted] y"] });
    assert.deepEqual(record?.data, { "[redacted]": true, nested: [{ deeper: "prefix-[redacted]-suffix" }] });
  });

  test("redaction happens before truncation, so a cut never leaves part of a secret", () => {
    const { records, diagnostics } = collect(300);
    const secret = "very-secret-value-0123456789";
    diagnostics.registerSecret(secret);
    for (let padding = 200; padding < 300; padding += 1) {
      diagnostics.log({ level: "info", msg: `${"p".repeat(padding)}${secret}` });
    }
    for (const record of records) {
      assert.ok(jsonBytes(record) <= 300);
      assert.equal(record.msg.includes(secret.slice(0, 6)), false, record.msg);
    }
  });

  test("a value that cannot be serialized is logged as a note instead of throwing", () => {
    const { records, diagnostics } = collect();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    diagnostics.log({ level: "info", msg: "circular", data: circular });
    assert.match(String(records[0]?.data), /^\[unserializable: /);
  });
});
