// The OpenCode recording proxy: an HTTP server on a loopback port that the
// driver talks to as its external OpenCode server (`serverUrl`). It forwards
// every request to the real (or fake) OpenCode server and records, as frames
// (./frames.ts), each request the driver sent, each response the server gave,
// each server-sent event it relayed, the end of each stream, and each
// connection the driver closed before its answer ended.
//
// A frame is recorded when it crosses the proxy: a request once its body has
// arrived, a response just before the proxy writes it, an event just before
// the proxy writes it to the driver. An event arriving after the driver closed
// its stream never reaches the driver and is not recorded. Request headers are
// passed on but never recorded: the server password travels in one.
//
// OpenCode compresses a large answer (the model list is about 40 KB of gzip)
// when the driver's client accepts it, and the client decompresses it. The
// proxy records and passes on the decompressed body, so a frame holds what
// the driver's client reads, and the driver gets the same JSON a direct
// connection would give it.

import * as http from "node:http";
import type { Readable } from "node:stream";
import * as zlib from "node:zlib";
import type { Frame } from "../format.ts";
import { EVENT_STREAM, EventStreamSplitter, blockData, bodyFields, eventFrame, mediaType, onExchangeClosed, requestBody, requestFrame } from "./frames.ts";

export interface RecordingProxy {
  readonly url: string;
  /** Resolves true once no event stream the driver opened is still open, or false after `timeoutMs`. */
  whenStreamsClosed(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

/** Headers that belong to one connection, not to the request or response it carries. */
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

function passedHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !HOP_HEADERS.has(name.toLowerCase())));
}

/** The answer's body as the client reads it: decompressed when the server sent it gzip, deflate or br encoded. Undefined for an encoding the proxy cannot decode. */
function decodedBody(answer: http.IncomingMessage): Readable | undefined {
  const encoding = String(answer.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  if (encoding === "identity" || encoding === "") return answer;
  if (encoding === "gzip" || encoding === "x-gzip") return answer.pipe(zlib.createGunzip());
  if (encoding === "deflate") return answer.pipe(zlib.createInflate());
  if (encoding === "br") return answer.pipe(zlib.createBrotliDecompress());
  return undefined;
}

async function readBody(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Starts the proxy in front of `upstream` (the server's base URL). `record` receives every frame, in order. */
export async function startRecordingProxy(options: { readonly upstream: string; readonly record: (frame: Frame) => void }): Promise<RecordingProxy> {
  const upstream = new URL(options.upstream);
  let requests = 0;
  const openStreams = new Set<number>();
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const server = http.createServer((request, response) => {
    let id: number | undefined;
    // Set once the exchange is over: the proxy ended the driver's response, or the connection closed.
    let answered = false;
    let stream = false;
    let forward: http.ClientRequest | undefined;
    response.on("error", () => undefined);
    onExchangeClosed(request, response, () => {
      if (stream && id !== undefined && openStreams.delete(id)) changed();
      if (!answered) {
        answered = true;
        // The driver closed the connection before its answer ended (a request it never finished sending is not recorded).
        if (id !== undefined) options.record({ dir: "out", kind: "close", id });
      }
      // Last: Bun ends the upstream response at once when its request is destroyed.
      forward?.destroy();
    });
    void (async () => {
      const body = Buffer.from(await requestBody(request), "utf8");
      if (answered) return;
      requests += 1;
      id = requests;
      const exchange = id;
      const url = new URL(request.url ?? "/", "http://proxy.invalid");
      options.record(requestFrame(exchange, request.method ?? "GET", url, body.toString("utf8")));
      forward = http.request(new URL(`${url.pathname}${url.search}`, upstream), { method: request.method ?? "GET", headers: { ...passedHeaders(request.headers), "content-length": String(body.length) } });
      const dropped = (): void => {
        if (answered) return;
        answered = true;
        options.record({ dir: "in", kind: "dropped", id: exchange });
        response.destroy();
      };
      forward.on("error", dropped);
      forward.on("response", (answer) => {
        const contentType = answer.headers["content-type"];
        const status = answer.statusCode ?? 502;
        const type = contentType === undefined ? {} : { contentType };
        if (answered) {
          answer.destroy();
          return;
        }
        const decoded = decodedBody(answer);
        if (decoded === undefined) {
          answer.destroy();
          dropped();
          return;
        }
        if (decoded !== answer) {
          answer.on("error", dropped);
          decoded.on("error", dropped);
        }
        if (mediaType(contentType) === EVENT_STREAM) {
          stream = true;
          openStreams.add(exchange);
          options.record({ dir: "in", kind: "response", id: exchange, status, ...type, stream: true });
          response.writeHead(status, { ...(contentType === undefined ? {} : { "content-type": contentType }), "cache-control": "no-cache" });
          response.flushHeaders();
          const splitter = new EventStreamSplitter();
          const relay = (block: string): void => {
            if (answered) return;
            const data = blockData(block);
            if (data !== "") options.record(eventFrame(exchange, data));
            response.write(`${block}\n\n`);
          };
          decoded.setEncoding("utf8");
          decoded.on("data", (chunk: string) => {
            for (const block of splitter.push(chunk)) relay(block);
          });
          decoded.on("end", () => {
            const rest = splitter.end();
            if (rest !== undefined) relay(rest);
            if (answered) return;
            answered = true;
            options.record({ dir: "in", kind: "end", id: exchange });
            response.end();
          });
          decoded.on("error", dropped);
          return;
        }
        void readBody(decoded).then((bytes) => {
          if (answered) return;
          answered = true;
          const text = bytes.toString("utf8");
          options.record({ dir: "in", kind: "response", id: exchange, status, ...type, ...bodyFields(text) });
          response.writeHead(status, contentType === undefined ? {} : { "content-type": contentType });
          response.end(bytes);
        }, dropped);
      });
      forward.end(body);
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    whenStreamsClosed: (timeoutMs) =>
      new Promise<boolean>((resolve) => {
        const check = (): void => {
          if (openStreams.size > 0) return;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(true);
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          resolve(openStreams.size === 0);
        }, timeoutMs);
        listeners.add(check);
        check();
      }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
