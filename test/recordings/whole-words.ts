// For the recorders' tests: every place in recorded frames where a name (the
// OS user name) is still a whole word, other than a protocol word of its key
// at its place (./protocol-places.ts) or a frame's own format field. A
// recording made through the sanitiser has none.

import type { Frame } from "./format.ts";
import { FRAME_PLACE, slotAt, slotIn } from "./protocol-places.ts";
import type { ProtocolSlot, ProtocolWords } from "./protocol-places.ts";
import { FRAME_FORMAT_FIELDS } from "./sanitiser.ts";

/** Each string in `frames` that holds `name` as a whole word and is no protocol word where it is, as `frame <line>.<path>: <value>`. */
export function wholeWordsOf(name: string, frames: readonly Frame[], words: ProtocolWords): string[] {
  const word = new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`);
  const found: string[] = [];
  const walk = (value: unknown, slot: ProtocolSlot | undefined, at: string): void => {
    if (typeof value === "string") {
      if (slot?.words?.includes(value) === true) return;
      if (word.test(value)) found.push(`${at}: ${JSON.stringify(value)}`);
    } else if (Array.isArray(value)) value.forEach((each, index) => walk(each, slot, `${at}[${index}]`));
    else if (typeof value === "object" && value !== null) for (const [field, entry] of Object.entries(value)) walk(entry, slotIn(words, slot, value as { [key: string]: unknown }, field), `${at}.${field}`);
  };
  frames.forEach((frame, index) => {
    for (const [field, entry] of Object.entries(frame)) if (!FRAME_FORMAT_FIELDS.has(field) || typeof entry === "object") walk(entry, slotAt(words, FRAME_PLACE, field), `frame ${index + 2}.${field}`);
  });
  return found;
}

/**
 * Each string in `frames` that is a whole placeholder `placeholder` (`<USER>`)
 * where the pinned types allow `name` as a protocol word: a protocol word the
 * sanitiser replaced. A recording made through the sanitiser on an account
 * named `name` has none; an opaque value (one the types give no shape) may
 * hold the placeholder.
 */
export function replacedProtocolWords(name: string, placeholder: string, frames: readonly Frame[], words: ProtocolWords): string[] {
  const found: string[] = [];
  const walk = (value: unknown, slot: ProtocolSlot | undefined, at: string): void => {
    if (typeof value === "string") {
      if (value === placeholder && slot?.words?.includes(name) === true) found.push(at);
    } else if (Array.isArray(value)) value.forEach((each, index) => walk(each, slot, `${at}[${index}]`));
    else if (typeof value === "object" && value !== null) for (const [field, entry] of Object.entries(value)) walk(entry, slotIn(words, slot, value as { [key: string]: unknown }, field), `${at}.${field}`);
  };
  frames.forEach((frame, index) => {
    for (const [field, entry] of Object.entries(frame)) walk(entry, slotAt(words, FRAME_PLACE, field), `frame ${index + 2}.${field}`);
  });
  return found;
}
