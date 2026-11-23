// Turns a name a driver or host chose (an instance ID, a secret namespace or
// key) into one directory or file name that is safe on every common file
// system.
//
// Lowercase ASCII letters, digits, `-` and `_` stay as they are. Every other
// UTF-8 byte, including `.`, `/`, `%` and uppercase letters, becomes `%XX`
// with uppercase hex. The mapping is one-to-one, never yields `.`, `..` or a
// path separator, and never yields two names that differ only by letter case,
// so distinct inputs get distinct paths even on case-insensitive file systems.

import { callErrors } from "../errors.ts";

/** Most file systems refuse a single path segment longer than 255 bytes. */
const MAX_SEGMENT_LENGTH = 255;

function isKeptByte(byte: number): boolean {
  const isLowercaseLetter = byte >= 0x61 && byte <= 0x7a;
  const isDigit = byte >= 0x30 && byte <= 0x39;
  return isLowercaseLetter || isDigit || byte === 0x2d || byte === 0x5f;
}

/**
 * The file-system-safe form of `name`. Throws a `validation` error when `name`
 * is empty or its safe form is longer than one path segment may be. `field`
 * names the input in that error.
 */
export function encodePathSegment(name: string, field: string): string {
  if (typeof name !== "string" || name === "") {
    throw callErrors.validation([{ path: [field], message: "must be a non-empty string" }], `Invalid ${field}: it must be a non-empty string`);
  }
  let encoded = "";
  for (const byte of new TextEncoder().encode(name)) {
    encoded += isKeptByte(byte) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  if (encoded.length > MAX_SEGMENT_LENGTH) {
    throw callErrors.validation([{ path: [field], message: "is too long" }], `Invalid ${field}: it is too long to name a file`);
  }
  return encoded;
}
