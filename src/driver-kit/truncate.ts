// Byte-safe truncation for payload caps (`SessionOptions.payloadLimits`:
// `maxToolOutputBytes`, `maxDiffBytes`). Text is capped by its UTF-8 size, and
// the cut never splits a character: a character that does not fit whole is
// left out whole, including a surrogate pair (one 4-byte character). A lone
// surrogate counts as 3 bytes, the size of the U+FFFD that UTF-8 encoders
// write for it. When anything was cut, the result says `truncated: true`, the
// value an item's `truncated` field must then carry.

export interface TruncatedText {
  /** The longest prefix of the input whose UTF-8 encoding fits in the cap. */
  readonly text: string;
  /** True when the input did not fit and `text` is shorter. */
  readonly truncated: boolean;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Caps `text` at `maxBytes` bytes of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): TruncatedText {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new RangeError(`maxBytes must be a non-negative integer, got ${String(maxBytes)}`);
  // A UTF-16 code unit never takes more than 3 bytes of UTF-8.
  if (text.length * 3 <= maxBytes) return { text, truncated: false };
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    let width = 3;
    let units = 1;
    if (code < 0x80) width = 1;
    else if (code < 0x800) width = 2;
    else if (isHighSurrogate(code) && index + 1 < text.length && isLowSurrogate(text.charCodeAt(index + 1))) {
      width = 4;
      units = 2;
    }
    if (bytes + width > maxBytes) return { text: text.slice(0, index), truncated: true };
    bytes += width;
    index += units;
  }
  return { text, truncated: false };
}
