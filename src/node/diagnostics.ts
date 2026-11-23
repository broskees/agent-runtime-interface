// Diagnostics for one instance. Each entry is redacted, then held to a byte
// budget, then handed to the host's `write` function.
//
// Redaction: every occurrence of a registered secret value, in `msg`, in
// `level`, and in any string or object key inside `native` or `data`, becomes
// `[redacted]`. Redaction happens before truncation, so a cut can never leave
// part of a secret behind.
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
  /** Every later entry has this value replaced by `[redacted]`. Empty values are ignored. */
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

/** A plain JSON copy of `value`, or a note saying why there is none. */
function toJson(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : JSON.parse(text);
  } catch (error) {
    return `[unserializable: ${(error as Error).message}]`;
  }
}

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_DIAGNOSTIC_ENTRY_BYTES;
  if (!Number.isInteger(maxEntryBytes) || maxEntryBytes < MIN_DIAGNOSTIC_ENTRY_BYTES) {
    throw new RangeError(`maxEntryBytes must be an integer of at least ${MIN_DIAGNOSTIC_ENTRY_BYTES}`);
  }
  const secrets = new Set<string>();
  // Longest first, so a secret that contains another is replaced whole.
  let secretsLongestFirst: string[] = [];

  const redactText = (text: string): string => {
    let result = text;
    for (const secret of secretsLongestFirst) result = result.split(secret).join(REDACTED);
    return result;
  };

  const redactValue = (value: unknown): unknown => {
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (typeof value === "object" && value !== null) {
      const result: { [key: string]: unknown } = {};
      for (const [key, inner] of Object.entries(value)) result[redactText(key)] = redactValue(inner);
      return result;
    }
    return value;
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
      const text = typeof value === "string" ? value : new TextDecoder().decode(value);
      if (text === "" || secrets.has(text)) return;
      secrets.add(text);
      secretsLongestFirst = [...secrets].sort((left, right) => right.length - left.length);
    },

    log(entry: DiagnosticEntry): void {
      const record: DiagnosticRecord = {
        level: redactText(String(entry.level)),
        msg: redactText(String(entry.msg)),
      };
      if (entry.native !== undefined) record.native = redactValue(toJson(entry.native));
      if (entry.data !== undefined) record.data = redactValue(toJson(entry.data));
      options.write(fitToBudget(record));
    },
  };
}
