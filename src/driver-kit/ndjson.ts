// NDJSON (newline-delimited JSON) framing, as `ari/wire`, Codex app-server,
// ACP and Pi's RPC mode use it: one JSON value per record, each ending in a
// line feed. Records are split on "\n" only, never on U+2028 or U+2029 (which
// JSON strings may hold raw); a "\r" before the "\n" is dropped, and blank
// lines are skipped.
//
// The decoder takes chunks as they arrive: a record may be split across any
// number of chunks (including inside a multi-byte UTF-8 character), a chunk
// may hold several records, and a record may be megabytes long. A line that is
// not valid JSON comes back as an `ok: false` record and decoding goes on, so
// one bad frame never ends the stream.

/** One decoded line: the parsed value, or why the line is not JSON. */
export type NdjsonRecord =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string; readonly line: string };

function parseLine(rawLine: string): NdjsonRecord | undefined {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (line.trim() === "") return undefined;
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch (error) {
    return { ok: false, error: (error as Error).message, line };
  }
}

/** Splits a byte or text stream into NDJSON records. Use one decoder per stream. */
export class NdjsonDecoder {
  readonly #textDecoder = new TextDecoder("utf-8");
  /** The pieces of the line not yet ended by a line feed. */
  #partial: string[] = [];

  /** Decodes one chunk and returns the records it completes. */
  push(chunk: Uint8Array | string): NdjsonRecord[] {
    const text = typeof chunk === "string" ? chunk : this.#textDecoder.decode(chunk, { stream: true });
    return this.#takeLines(text);
  }

  /** Ends the stream and returns the records still held, including a last line with no line feed. */
  end(): NdjsonRecord[] {
    const records = this.#takeLines(this.#textDecoder.decode());
    const rest = this.#partial.join("");
    this.#partial = [];
    const last = parseLine(rest);
    if (last !== undefined) records.push(last);
    return records;
  }

  #takeLines(text: string): NdjsonRecord[] {
    const records: NdjsonRecord[] = [];
    let start = 0;
    let newline = text.indexOf("\n");
    while (newline !== -1) {
      this.#partial.push(text.slice(start, newline));
      const line = this.#partial.join("");
      this.#partial = [];
      const record = parseLine(line);
      if (record !== undefined) records.push(record);
      start = newline + 1;
      newline = text.indexOf("\n", start);
    }
    if (start < text.length) this.#partial.push(text.slice(start));
    return records;
  }
}

/** Reads NDJSON records from a stream of chunks, such as a child process's stdout. */
export async function* readNdjson(source: AsyncIterable<Uint8Array | string>): AsyncGenerator<NdjsonRecord, void, undefined> {
  const decoder = new NdjsonDecoder();
  for await (const chunk of source) yield* decoder.push(chunk);
  yield* decoder.end();
}

/**
 * One NDJSON record for `value`: its JSON text and a line feed. `JSON.stringify`
 * escapes every line feed inside strings, so the record is always one line.
 * Throws a `TypeError` for a value JSON cannot represent, such as `undefined`.
 */
export function encodeNdjson(value: unknown): string {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) throw new TypeError("encodeNdjson: the value has no JSON form");
  return `${text}\n`;
}
