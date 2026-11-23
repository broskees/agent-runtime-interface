// Diagnostics in `ari/node`: entries past the byte budget (64 KiB by default)
// are truncated to fit, and registered secret values are redacted, before any
// truncation, in every form the redaction doc comment in
// src/node/diagnostics.ts lists: text, base64 and hex text, numbers, and bytes.

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

  test("registered secret bytes never appear, whether logged as a Buffer, a Uint8Array, Buffer's JSON form or a byte array", () => {
    const { records, diagnostics } = collect();
    // Not valid UTF-8, so the secret has no text form; only its bytes identify it.
    const secret = Buffer.from([0x00, 0xff, 0x9c, 0x42, 0x13, 0xfe, 0x80, 0x07, 0xaa, 0x55]);
    diagnostics.registerSecret(secret);
    const surrounded = Buffer.concat([Buffer.from("prefix"), secret, Buffer.from("suffix")]);
    diagnostics.log({
      level: "info",
      msg: "binary credential",
      native: { asBuffer: secret, asUint8Array: new Uint8Array(secret), inside: surrounded, view: new DataView(surrounded.buffer, surrounded.byteOffset, surrounded.byteLength) },
      data: { bufferJson: JSON.parse(JSON.stringify(secret)), byteArray: [...surrounded], arrayBuffer: Uint8Array.from(secret).buffer },
    });
    const [record] = records;
    assert.deepEqual(record?.native, { asBuffer: "[redacted]", asUint8Array: "[redacted]", inside: "[redacted]", view: "[redacted]" });
    assert.deepEqual(record?.data, { bufferJson: { type: "Buffer", data: "[redacted]" }, byteArray: "[redacted]", arrayBuffer: "[redacted]" });
    const text = JSON.stringify(record);
    for (const encoded of [secret.toString("base64"), secret.toString("base64url"), secret.toString("hex"), JSON.stringify([...secret]).slice(1, -1)]) {
      assert.equal(text.includes(encoded), false, `the secret appears as ${encoded}`);
    }
  });

  test("bytes that hold no registered secret are logged as base64", () => {
    const { records, diagnostics } = collect();
    diagnostics.registerSecret("unrelated-secret");
    diagnostics.log({ level: "info", msg: "frame", data: { payload: Buffer.from("hello"), view: new Uint8Array([1, 2, 3]) } });
    assert.deepEqual(records[0]?.data, { payload: { base64: "aGVsbG8=" }, view: { base64: "AQID" } });
  });

  test("a registered numeric secret is redacted from numbers and bigints, and other numbers are kept", () => {
    const { records, diagnostics } = collect();
    diagnostics.registerSecret("123456");
    diagnostics.log({
      level: "info",
      msg: "pin 123456 entered",
      native: { pin: 123456, padded: 91234567, other: 42, big: 123456n, list: [123456, 7], flag: true },
      data: 123456,
    });
    const [record] = records;
    assert.equal(record?.msg, "pin [redacted] entered");
    assert.deepEqual(record?.native, { pin: "[redacted]", padded: "[redacted]", other: 42, big: "[redacted]", list: ["[redacted]", 7], flag: true });
    assert.equal(record?.data, "[redacted]");
    assert.equal(JSON.stringify(record).includes("123456"), false);
  });

  test("the base64 and hex forms of a registered value are redacted from text", () => {
    const { records, diagnostics } = collect();
    const token = "tok_live_9f8e7d6c5b4a";
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
    diagnostics.registerSecret(token);
    diagnostics.registerSecret(bytes);
    const forms = [
      Buffer.from(token).toString("base64"),
      Buffer.from(token).toString("base64url"),
      Buffer.from(token).toString("hex"),
      Buffer.from(token).toString("hex").toUpperCase(),
      bytes.toString("base64"),
      bytes.toString("base64").replace(/=+$/, ""),
      bytes.toString("hex"),
    ];
    diagnostics.log({ level: "info", msg: forms.join(" | "), data: { forms } });
    const text = JSON.stringify(records[0]);
    for (const form of forms) assert.equal(text.includes(form), false, `${form} was not redacted`);
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

  test("a circular reference or a value that cannot be serialized is logged as a note instead of throwing", () => {
    const { records, diagnostics } = collect();
    const circular: { name: string; self?: unknown } = { name: "loop" };
    circular.self = circular;
    diagnostics.log({ level: "info", msg: "circular", data: circular });
    assert.deepEqual(records[0]?.data, { name: "loop", self: "[circular]" });
    diagnostics.log({
      level: "info",
      msg: "throws",
      data: {
        toJSON() {
          throw new Error("cannot serialize");
        },
      },
    });
    assert.equal(records[1]?.data, "[unserializable: cannot serialize]");
  });
});
