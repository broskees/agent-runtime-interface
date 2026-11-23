// Diagnostics for one instance. Each entry is turned into plain JSON data with
// registered secrets redacted, then held to a byte budget, then handed to the
// host's `write` function. Redaction happens before truncation, so a cut can
// never leave part of a secret behind. What redaction covers is listed on
// `Diagnostics.registerSecret` below.
//
// Budget: an entry whose JSON form is larger than `maxEntryBytes` UTF-8 bytes
// (default 64 KiB) is truncated. `native` and `data` become their JSON text,
// then fields are cut, least important first (`data`, `native`, `msg`,
// `level`), until the record fits. A truncated record carries
// `truncated: true`. Cuts never split a UTF-16 surrogate pair.

import type { DiagnosticEntry } from "../generated/host.ts";
import type { HostServices } from "../runtime.ts";

export const DEFAULT_DIAGNOSTIC_ENTRY_BYTES = 64 * 1024;

/** The smallest budget that always leaves room for a truncated record. */
const MIN_DIAGNOSTIC_ENTRY_BYTES = 256;

const REDACTED = "[redacted]";

/** An HTTP Basic credential in text: `Basic`, whitespace, then standard base64. */
const BASIC_CREDENTIAL = /\b(basic\s+)([A-Za-z0-9+/]+={0,2})/gi;

/** What the host's `write` receives: a redacted entry within the budget. */
export interface DiagnosticRecord extends DiagnosticEntry {
  truncated?: true;
}

export interface DiagnosticsOptions {
  /** Receives every record. The host decides where it goes. */
  write(record: DiagnosticRecord): void;
  /** The largest JSON size of one record, in UTF-8 bytes. Defaults to 64 KiB. */
  maxEntryBytes?: number;
}

export type Diagnostics = HostServices["diagnostics"] & {
  /**
   * Redacts `value` from every later entry. Empty values are ignored. The
   * guarantee covers only the values registered here, in these forms:
   *
   *   - Text, in `msg`, `level` and every string and object key inside
   *     `native` and `data`: each occurrence of one of the value's text forms
   *     becomes `[redacted]`. The text forms are the value itself (for bytes,
   *     their UTF-8 text when the bytes are valid UTF-8), and the base64 (with
   *     and without `=` padding), base64url and lowercase and uppercase hex
   *     encodings of its bytes (UTF-8 bytes for a string).
   *   - HTTP Basic credentials, in the same text: a `Basic <base64>` token
   *     (`Basic` in any letter case, whitespace, then standard base64) whose
   *     decoded bytes contain the value's bytes (UTF-8 bytes for a string)
   *     becomes `Basic [redacted]`, so `Authorization: Basic base64(user:pw)`
   *     is redacted when `pw` is registered.
   *   - Numbers: a number or bigint whose decimal text contains a text form
   *     becomes `[redacted]`, so a numeric PIN registered as "123456" is
   *     redacted from `{ pin: 123456 }`.
   *   - Bytes: a Buffer, typed array, DataView or ArrayBuffer, and an array of
   *     integers 0 to 255 (which covers the `data` of Buffer's JSON form
   *     `{ type: "Buffer", data: [...] }`), whose bytes contain the value's
   *     bytes (UTF-8 bytes for a string) becomes `[redacted]` whole. Other
   *     binary values are logged as `{ base64 }`.
   *
   * Not covered: any other encoding (UTF-16, URL encoding, a typed array
   * already turned into `{ "0": .., "1": .. }` by JSON), a value encoded
   * together with other data outside an HTTP Basic token (base64 of
   * `user:secret` elsewhere is not caught), and a value split across fields.
   */
  registerSecret(value: string | Uint8Array): void;
};

type TruncatableField = "data" | "native" | "msg" | "level";

function serializedBytes(record: DiagnosticRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

/** The first `length` code units of `text`, one shorter when the cut would split a surrogate pair. */
function prefixOf(text: string, length: number): string {
  let end = Math.min(length, text.length);
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/** The longest prefix of `text` for which `fits` holds, found by binary search. */
function longestFittingPrefix(text: string, fits: (candidate: string) => boolean): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(prefixOf(text, middle))) low = middle;
    else high = middle - 1;
  }
  return prefixOf(text, low);
}

/** True for a non-empty array of integers 0 to 255, which may be bytes. */
function isByteArray(value: readonly unknown[]): value is number[] {
  return value.length > 0 && value.every((item) => Number.isInteger(item) && (item as number) >= 0 && (item as number) <= 255);
}

/** The text forms of a registered value; see `registerSecret`. */
function textForms(value: string | Uint8Array, bytes: Buffer): string[] {
  const forms: string[] = [];
  if (typeof value === "string") {
    forms.push(value);
  } else {
    try {
      forms.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      // Not valid UTF-8: the bytes have no text form of their own.
    }
  }
  const base64 = bytes.toString("base64");
  const hex = bytes.toString("hex");
  forms.push(base64, base64.replace(/=+$/, ""), bytes.toString("base64url"), hex, hex.toUpperCase());
  return forms.filter((form) => form !== "");
}

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_DIAGNOSTIC_ENTRY_BYTES;
  if (!Number.isInteger(maxEntryBytes) || maxEntryBytes < MIN_DIAGNOSTIC_ENTRY_BYTES) {
    throw new RangeError(`maxEntryBytes must be an integer of at least ${MIN_DIAGNOSTIC_ENTRY_BYTES}`);
  }
  const registeredHex = new Set<string>();
  const secretBytes: Buffer[] = [];
  // Longest first, so a text form that contains another is replaced whole.
  let textFormsLongestFirst: string[] = [];

  const holdsSecretText = (text: string): boolean => textFormsLongestFirst.some((form) => text.includes(form));
  const holdsSecretBytes = (bytes: Buffer): boolean => secretBytes.some((secret) => bytes.indexOf(secret) !== -1);
  const redactText = (text: string): string => {
    let result = text.replace(BASIC_CREDENTIAL, (token: string, prefix: string, encoded: string) =>
      holdsSecretBytes(Buffer.from(encoded, "base64")) ? `${prefix}${REDACTED}` : token,
    );
    for (const form of textFormsLongestFirst) result = result.split(form).join(REDACTED);
    return result;
  };

  // Plain JSON data for `value` with registered secrets redacted. Undefined
  // for what JSON leaves out (undefined, functions, symbols).
  const toRedactedJson = (value: unknown, ancestors: readonly object[]): unknown => {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return redactText(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      return holdsSecretText(String(value)) ? REDACTED : value;
    }
    if (typeof value === "bigint") return holdsSecretText(value.toString()) ? REDACTED : value.toString();
    if (typeof value !== "object") return undefined;
    if (ancestors.includes(value)) return "[circular]";
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      const bytes = value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      return holdsSecretBytes(bytes) ? REDACTED : { base64: bytes.toString("base64") };
    }
    const inside = [...ancestors, value];
    if (Array.isArray(value)) {
      if (isByteArray(value) && holdsSecretBytes(Buffer.from(value))) return REDACTED;
      return value.map((item) => toRedactedJson(item, inside) ?? null);
    }
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") return toRedactedJson(toJSON.call(value), inside);
    const result: { [key: string]: unknown } = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toRedactedJson(item, inside);
      if (converted !== undefined) result[redactText(key)] = converted;
    }
    return result;
  };

  const redactedField = (value: unknown): unknown => {
    try {
      return toRedactedJson(value, []) ?? null;
    } catch (error) {
      return redactText(`[unserializable: ${(error as Error).message}]`);
    }
  };

  const fitToBudget = (record: DiagnosticRecord): DiagnosticRecord => {
    if (serializedBytes(record) <= maxEntryBytes) return record;
    const truncated: DiagnosticRecord = { ...record, truncated: true };
    if (truncated.native !== undefined) truncated.native = JSON.stringify(truncated.native);
    if (truncated.data !== undefined) truncated.data = JSON.stringify(truncated.data);
    const fieldOrder: TruncatableField[] = ["data", "native", "msg", "level"];
    for (const field of fieldOrder) {
      if (serializedBytes(truncated) <= maxEntryBytes) break;
      const text = truncated[field];
      if (typeof text !== "string") continue;
      // A prefix longer than the budget can never fit: each code unit takes at least one byte.
      const candidates = prefixOf(text, maxEntryBytes);
      truncated[field] = longestFittingPrefix(candidates, (candidate) => serializedBytes({ ...truncated, [field]: candidate }) <= maxEntryBytes);
    }
    return truncated;
  };

  return {
    registerSecret(value: string | Uint8Array): void {
      // A copy, so a caller reusing its buffer cannot change what is redacted.
      const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(Uint8Array.from(value));
      if (bytes.length === 0 || registeredHex.has(bytes.toString("hex"))) return;
      registeredHex.add(bytes.toString("hex"));
      secretBytes.push(bytes);
      const allForms = new Set([...textFormsLongestFirst, ...textForms(value, bytes)]);
      textFormsLongestFirst = [...allForms].sort((left, right) => right.length - left.length);
    },

    log(entry: DiagnosticEntry): void {
      const record: DiagnosticRecord = {
        level: redactText(String(entry.level)),
        msg: redactText(String(entry.msg)),
      };
      if (entry.native !== undefined) record.native = redactedField(entry.native);
      if (entry.data !== undefined) record.data = redactedField(entry.data);
      options.write(fitToBudget(record));
    },
  };
}
