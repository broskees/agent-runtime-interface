// The frames of an OpenCode native recording: the HTTP traffic between the
// ARI OpenCode driver, in external-server mode, and an OpenCode 2.x server.
// docs/recordings.md documents each kind.
//
//   out request   the driver sent a request: method, path, query, body
//   in  response  the server answered it: status, content type, body; for an
//                 event stream (`GET /api/event`) only the status and type
//   in  event     the server sent one server-sent event on a stream
//   in  end       the server ended a stream
//   out close     the driver closed a connection before the server ended it
//                 (it stops reading the event stream when its session closes)
//   in  dropped   the server closed the connection without an answer
//
// Every frame names its exchange by `id`: 1, 2, ... in the order the driver's
// requests reached the proxy (when recording) or the replay server.
//
// The proxy and the replay server build the frames of a request with the same
// function here, so both sides describe a request the same way.

import type * as http from "node:http";
import type { Frame, FrameDirection } from "../format.ts";
import type { NativeAnswer } from "../scenarios.ts";
import type { IgnoredField } from "../sequencer.ts";

export const OPENCODE_FRAME_KINDS: ReadonlyArray<{ readonly kind: string; readonly dir: FrameDirection }> = [
  { kind: "request", dir: "out" },
  { kind: "response", dir: "in" },
  { kind: "event", dir: "in" },
  { kind: "end", dir: "in" },
  { kind: "close", dir: "out" },
  { kind: "dropped", dir: "in" },
];

/**
 * The fields OpenCode replay leaves out of the comparison: none. The driver
 * builds every request from the scenario, its config and what the server
 * answered, so a replay sends the same requests byte for byte. The recording
 * holds no request headers (the server password travels in one).
 */
export const OPENCODE_IGNORED_FIELDS: readonly IgnoredField[] = [];

/** The content type of a server-sent event stream. */
export const EVENT_STREAM = "text/event-stream";

type Json = { readonly [key: string]: unknown };

/** A URL's query as an object: each name once, a repeated name as the list of its values, in the order sent. */
export function queryObject(search: URLSearchParams): { [name: string]: string | string[] } {
  const query: { [name: string]: string | string[] } = {};
  for (const [name, value] of search) {
    const before = query[name];
    query[name] = before === undefined ? value : Array.isArray(before) ? [...before, value] : [before, value];
  }
  return query;
}

/** A body as a frame holds it: `body` when it is JSON, `text` otherwise, nothing when it is empty. */
export function bodyFields(text: string): { body?: unknown; text?: string } {
  if (text === "") return {};
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return { text };
  }
}

/** The bytes of a body a frame holds. */
export function bodyText(frame: Frame): string {
  if (frame["body"] !== undefined) return JSON.stringify(frame["body"]);
  return typeof frame["text"] === "string" ? frame["text"] : "";
}

/** The `request` frame of one HTTP request, as both the proxy and the replay server record it. */
export function requestFrame(id: number, method: string, url: URL, body: string): Frame {
  return { dir: "out", kind: "request", id, method, path: url.pathname, query: queryObject(url.searchParams), ...bodyFields(body) };
}

/** The media type of a Content-Type header, without its parameters. */
export function mediaType(header: string | undefined): string | undefined {
  const type = header?.split(";", 1)[0]?.trim().toLowerCase();
  return type === undefined || type === "" ? undefined : type;
}

/**
 * Splits server-sent event text into blocks the way `@opencode/client` 2.1.2
 * reads them (`promise/generated/client.ts` `sse`): CRLF and CR become LF, a
 * blank line ends a block, and a block's data is its `data:` lines joined by
 * LF. `push` returns the blocks the text completes; `end` the last one, if
 * the stream ended inside it.
 */
export class EventStreamSplitter {
  #buffer = "";

  push(chunk: string): string[] {
    this.#buffer = (this.#buffer + chunk).replaceAll("\r\n", "\n");
    // A CR at the very end may be the first half of a CRLF; keep it until the next chunk.
    const trailing = this.#buffer.endsWith("\r");
    if (trailing) this.#buffer = this.#buffer.slice(0, -1);
    this.#buffer = this.#buffer.replaceAll("\r", "\n");
    if (trailing) this.#buffer += "\r";
    const blocks: string[] = [];
    for (let boundary = this.#buffer.indexOf("\n\n"); boundary >= 0; boundary = this.#buffer.indexOf("\n\n")) {
      blocks.push(this.#buffer.slice(0, boundary));
      this.#buffer = this.#buffer.slice(boundary + 2);
    }
    return blocks;
  }

  end(): string | undefined {
    const rest = this.#buffer.replaceAll("\r", "\n");
    this.#buffer = "";
    return rest === "" ? undefined : rest;
  }
}

/** A block's data, as the client reads it: its `data:` lines, joined by LF. Empty for a comment or keepalive. */
export function blockData(block: string): string {
  return block
    .split("\n")
    .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
    .join("\n");
}

/** The `event` frame of one block with data: the event as JSON, or its raw `data` when it is not JSON. */
export function eventFrame(id: number, data: string): Frame {
  try {
    return { dir: "in", kind: "event", id, event: JSON.parse(data) as unknown };
  } catch {
    return { dir: "in", kind: "event", id, data };
  }
}

/** The bytes of one recorded event as the replay server writes it. */
export function eventText(frame: Frame): string {
  const data = frame["event"] !== undefined ? JSON.stringify(frame["event"]) : String(frame["data"] ?? "");
  return `${data
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n")}\n\n`;
}

/**
 * Calls `listener` once, when the exchange is over: the response ended, or
 * the client closed the connection first. Node emits the response's `close`
 * in both cases. Bun 1.3.14 emits it only for a response that ended: when the
 * client aborts an event stream whose request body was read, Bun emits only
 * the socket's `close`. So the socket's `close` counts too, for as long as the
 * exchange lasts (a kept-alive socket carries later requests). The request's
 * own `close` fires as soon as its body is read, in both, so it says nothing.
 * Call it before reading the request body.
 */
export function onExchangeClosed(request: http.IncomingMessage, response: http.ServerResponse, listener: () => void): void {
  const socket = request.socket;
  let called = false;
  const once = (): void => {
    if (called) return;
    called = true;
    response.off("close", once);
    request.off("aborted", once);
    socket.off("close", once);
    listener();
  };
  response.once("close", once);
  request.once("aborted", once);
  socket.once("close", once);
}

/**
 * The request's body, read only when it has one (a Content-Length above zero,
 * or a Transfer-Encoding). Bun 1.3.14 reports nothing more of a connection
 * whose request body a handler read: a client that then closes the event
 * stream raises no event at all. The event stream's request is a GET without a
 * body, so it is never read.
 */
export async function requestBody(request: http.IncomingMessage): Promise<string> {
  const length = Number(request.headers["content-length"] ?? "0");
  if (request.headers["transfer-encoding"] === undefined && !(length > 0)) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const PERMISSION_REPLY = /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/;

/**
 * The approval answers the driver sent OpenCode, read off its `request`
 * frames: `POST /api/session/{sessionID}/permission/{requestID}/reply` with
 * the decision `once` (accept, once), `always` (accept beyond this call) or
 * `reject` (decline).
 */
export function opencodeNativeAnswers(frames: ReadonlyArray<Frame | { readonly line: number; readonly frame: Frame }>): NativeAnswer[] {
  const answers: NativeAnswer[] = [];
  for (const entry of frames) {
    const frame = "frame" in entry && typeof entry.frame === "object" ? (entry.frame as Frame) : (entry as Frame);
    const line = "frame" in entry && typeof entry.line === "number" ? entry.line : undefined;
    if (frame.dir !== "out" || frame.kind !== "request" || frame["method"] !== "POST" || !PERMISSION_REPLY.test(String(frame["path"]))) continue;
    const decision = (frame["body"] as Json | undefined)?.["decision"];
    const at = line === undefined ? {} : { line };
    if (decision === "once") answers.push({ decision: "accept", scope: "once", ...at });
    else if (decision === "always") answers.push({ decision: "accept", ...at });
    else if (decision === "reject") answers.push({ decision: "decline", ...at });
  }
  return answers;
}
