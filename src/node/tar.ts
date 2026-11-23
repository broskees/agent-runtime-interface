// Extracts a tar archive, gzip-compressed or plain, from a stream of bytes
// into a directory, with no dependencies. It reads the formats npm, GNU tar and
// bsdtar write: ustar headers with the `prefix` field, pax extended headers
// (`path` and `size`) and GNU long names.
//
// Safety rules, each enforced by refusing the whole archive:
//   - an entry path that is absolute, has a drive letter, contains `\`, or
//     has a `..` segment;
//   - symbolic links, hard links, devices and FIFOs (none of them is needed to
//     install a package, and links could point outside the directory);
//   - a header with a bad checksum, or a stream that ends before the
//     end-of-archive marker.
//
// The first `strip` path segments of every entry are dropped (npm tarballs
// put everything under `package/`), and entries with nothing left are skipped.
// Files keep their owner-executable bits; group and world write are removed.
// Each file is flushed to disk before the extraction resolves.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { callErrors } from "../errors.ts";

const BLOCK_SIZE = 512;

export interface ExtractOptions {
  /** Path segments to drop from the start of each entry. Defaults to 1. */
  strip?: number;
  signal?: AbortSignal;
}

function corrupt(message: string): Error {
  return callErrors.protocol("invalid_tar", `Invalid tar archive: ${message}`);
}

function unsafeEntry(name: string, why: string): Error {
  return callErrors.validation([{ path: ["entries", name], message: why }], `Refusing tar entry "${name}": ${why}`);
}

/** Reads exact byte counts from a stream of chunks. */
interface ByteReader {
  /** The next `length` bytes; fewer only when the stream ends first. */
  read(length: number): Promise<Uint8Array>;
  /** Hands the next `length` bytes to `consume` piece by piece, without holding them all in memory. */
  forward(length: number, consume: (piece: Uint8Array) => Promise<void>): Promise<void>;
  /** Reads and discards everything left. */
  drain(): Promise<void>;
}

function createByteReader(source: AsyncIterable<Uint8Array>): ByteReader {
  const iterator = source[Symbol.asyncIterator]();
  let pending: Uint8Array = new Uint8Array(0);
  let ended = false;

  const pull = async (): Promise<boolean> => {
    if (ended) return false;
    const next = await iterator.next();
    if (next.done === true) {
      ended = true;
      return false;
    }
    const chunk = next.value;
    if (pending.length === 0) {
      pending = chunk;
    } else {
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending, 0);
      joined.set(chunk, pending.length);
      pending = joined;
    }
    return true;
  };

  return {
    async read(length) {
      while (pending.length < length && (await pull())) {
        // keep pulling until there are enough bytes or the stream ends
      }
      const result = pending.subarray(0, length);
      pending = pending.subarray(result.length);
      return result;
    },
    async forward(length, consume) {
      let remaining = length;
      while (remaining > 0) {
        if (pending.length === 0 && !(await pull())) throw corrupt("the stream ended inside an entry");
        const piece = pending.subarray(0, remaining);
        pending = pending.subarray(piece.length);
        remaining -= piece.length;
        await consume(piece);
      }
    },
    async drain() {
      pending = new Uint8Array(0);
      while (await pull()) pending = new Uint8Array(0);
    },
  };
}

function readText(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
}

/** A numeric header field: octal text, or base-256 when the high bit of the first byte is set. */
function readNumber(block: Uint8Array, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);
  if ((field[0]! & 0x80) !== 0) {
    let value = field[0]! & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = new TextDecoder().decode(field).replace(/[\0 ]+$/g, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw corrupt(`bad numeric field "${text}"`);
  return parseInt(text, 8);
}

function hasValidChecksum(block: Uint8Array): boolean {
  const expected = readNumber(block, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : block[index]!;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return expected === unsigned || expected === signed;
}

/** `length` rounded up to a whole number of blocks. */
function paddedSize(length: number): number {
  return Math.ceil(length / BLOCK_SIZE) * BLOCK_SIZE;
}

/** The pax extended header records `key=value` that matter here. */
function parsePaxRecords(content: Uint8Array): Map<string, string> {
  // Each record is "<length> <key>=<value>\n", where <length> counts the bytes of the whole record.
  const records = new Map<string, string>();
  let position = 0;
  while (position < content.length) {
    const space = content.indexOf(0x20, position);
    if (space === -1) break;
    const recordLength = Number(new TextDecoder().decode(content.subarray(position, space)));
    if (!Number.isInteger(recordLength) || recordLength <= space - position) throw corrupt("bad pax record length");
    const body = new TextDecoder().decode(content.subarray(space + 1, position + recordLength)).replace(/\n$/, "");
    const equals = body.indexOf("=");
    if (equals > 0) records.set(body.slice(0, equals), body.slice(equals + 1));
    position += recordLength;
  }
  return records;
}

/** Where entry `name` goes under `destination`, or null when stripping leaves nothing. */
function entryPath(destination: string, name: string, strip: number): string | null {
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw unsafeEntry(name, "the path is absolute");
  if (name.includes("\\")) throw unsafeEntry(name, "the path contains a backslash");
  const segments = name.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) throw unsafeEntry(name, "the path leaves the directory");
  const kept = segments.slice(strip);
  if (kept.length === 0) return null;
  const target = path.join(destination, ...kept);
  const relative = path.relative(destination, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw unsafeEntry(name, "the path leaves the directory");
  return target;
}

async function writeFileEntry(target: string, mode: number, size: number, reader: ByteReader): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  // Keep the owner-executable bits, always let the owner read and write, never let others write.
  const fileMode = (mode & 0o755) | 0o600;
  const handle = await fs.open(target, "w", fileMode);
  try {
    await reader.forward(size, async (piece) => {
      await handle.writeFile(piece);
    });
    await handle.chmod(fileMode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function extractEntries(reader: ByteReader, destination: string, strip: number): Promise<void> {
  // Overrides that a pax header or a GNU long-name entry sets for the next entry.
  let nextName: string | undefined;
  let nextSize: number | undefined;

  for (;;) {
    const header = await reader.read(BLOCK_SIZE);
    if (header.length === 0) throw corrupt("the stream ended before the end-of-archive marker");
    if (header.length < BLOCK_SIZE) throw corrupt("the stream ended inside a header");
    if (header.every((byte) => byte === 0)) {
      await reader.drain();
      return;
    }
    if (!hasValidChecksum(header)) throw corrupt("a header checksum does not match");

    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    const isPosixUstar = readText(header, 257, 6) === "ustar" && header[262] === 0;
    const prefix = isPosixUstar ? readText(header, 345, 155) : "";
    const headerName = prefix === "" ? readText(header, 0, 100) : `${prefix}/${readText(header, 0, 100)}`;
    const name = nextName ?? headerName;
    const size = nextSize ?? readNumber(header, 124, 12);
    const mode = readNumber(header, 100, 8);
    nextName = undefined;
    nextSize = undefined;

    if (type === "x" || type === "g" || type === "L" || type === "K") {
      const content = await reader.read(size);
      if (content.length < size) throw corrupt("the stream ended inside an entry");
      await reader.read(paddedSize(size) - size);
      if (type === "x") {
        const records = parsePaxRecords(content);
        nextName = records.get("path");
        const paxSize = records.get("size");
        if (paxSize !== undefined) nextSize = Number(paxSize);
      } else if (type === "L") {
        nextName = readText(content, 0, content.length);
      }
      // `g` (global pax settings) and `K` (a long link name) change nothing here.
      continue;
    }

    if (type === "0" || type === "7") {
      const target = entryPath(destination, name, strip);
      if (target === null) {
        await reader.forward(paddedSize(size), async () => {});
        continue;
      }
      await writeFileEntry(target, mode, size, reader);
      await reader.read(paddedSize(size) - size);
      continue;
    }

    if (type === "5") {
      const target = entryPath(destination, name, strip);
      if (target !== null) await fs.mkdir(target, { recursive: true, mode: 0o755 });
      await reader.forward(paddedSize(size), async () => {});
      continue;
    }

    if (type === "1" || type === "2") throw unsafeEntry(name, "links are not installed");
    throw unsafeEntry(name, `entry type "${type}" is not installed`);
  }
}

/** Reads the first two bytes of `source`, then gives back the whole stream again and whether those bytes are the gzip magic number. */
async function detectGzip(source: AsyncIterable<Uint8Array>): Promise<{ isGzip: boolean; chunks: AsyncIterable<Uint8Array> }> {
  const iterator = source[Symbol.asyncIterator]();
  const head: Uint8Array[] = [];
  const firstBytes: number[] = [];
  let ended = false;
  while (firstBytes.length < 2) {
    const next = await iterator.next();
    if (next.done === true) {
      ended = true;
      break;
    }
    head.push(next.value);
    for (const byte of next.value.subarray(0, 2 - firstBytes.length)) firstBytes.push(byte);
  }
  async function* replay(): AsyncGenerator<Uint8Array> {
    try {
      yield* head;
      while (!ended) {
        const next = await iterator.next();
        if (next.done === true) return;
        yield next.value;
      }
    } finally {
      // Stops the source (closing a file or a download) when extraction ends early.
      await iterator.return?.();
    }
  }
  return { isGzip: firstBytes[0] === 0x1f && firstBytes[1] === 0x8b, chunks: replay() };
}

/** Extracts the archive in `source` into `destination`, which must exist. Reads `source` to its end. */
export async function extractTarball(source: AsyncIterable<Uint8Array>, destination: string, options: ExtractOptions = {}): Promise<void> {
  const strip = options.strip ?? 1;
  const root = path.resolve(destination);
  const { isGzip, chunks } = await detectGzip(source);
  const consume = async (decoded: AsyncIterable<Uint8Array>): Promise<void> => {
    await extractEntries(createByteReader(decoded), root, strip);
  };
  const pipelineOptions = options.signal === undefined ? {} : { signal: options.signal };
  if (isGzip) await pipeline(chunks, createGunzip(), consume, pipelineOptions);
  else await pipeline(chunks, consume, pipelineOptions);
}
