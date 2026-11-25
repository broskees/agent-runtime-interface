// The OpenCode replay server: an HTTP server on a loopback port that serves
// an OpenCode native recording to the driver, through phase 1's replay
// sequencer. It imports no driver code and no fake.
//
// Each request the driver makes becomes a `request` frame, built exactly as
// the recording proxy builds it, and goes through the replay's sanitiser to
// the sequencer, which matches it against the next recorded frame. A
// connection the driver closes before its answer ended becomes a `close`
// frame. The sequencer hands back each recorded inbound frame when it is due:
// a response to its request, an event onto its stream, the end of a stream,
// or a dropped connection. Inbound frames get the replay's own workspace
// where the recording says <WORKSPACE>.
//
// The server writes one frame at a time, each after the one before it was
// flushed to the driver's connection, so the driver receives them in the
// recorded order. A frame counts as taken by the driver once the server has
// written it to a connection the driver still holds open. One for a
// connection the driver closed, an event after its stream ended, or a stream
// after the driver closed it, is never taken, and `finish()` names it.
//
// A request that drifts gets a 500 answer whose text is the drift; the
// sequencer keeps the drift, and the scenario runner reports it.

import * as http from "node:http";
import type { Frame, Recording } from "../format.ts";
import { restoreWorkspace } from "../sanitiser.ts";
import type { Sanitiser } from "../sanitiser.ts";
import type { NativeProgress } from "../scenarios.ts";
import { ReplaySequencer } from "../sequencer.ts";
import { OPENCODE_IGNORED_FIELDS, bodyText, eventText, onExchangeClosed, requestBody, requestFrame } from "./frames.ts";

export interface OpencodeReplay {
  readonly url: string;
  readonly sequencer: ReplaySequencer;
  /** What the scenario runner watches: drift, and where replay stands when it stalls. */
  readonly progress: NativeProgress;
  /** Resolves true once no event stream the driver opened is still open, or false after `timeoutMs`. */
  whenStreamsClosed(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

interface Exchange {
  readonly response: http.ServerResponse;
  /** Set once a recorded frame ends the exchange, or the driver closed it. */
  answered: boolean;
  stream: boolean;
  /** Set once the connection closed, whoever closed it. */
  closed: boolean;
  /** Called when the connection closes. */
  readonly onClose: Set<() => void>;
}

/** Runs `write` and resolves true when its callback reports the bytes flushed, false when the connection closed first. */
function flushed(exchange: Exchange, write: (callback: (error?: Error | null) => void) => void): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      exchange.onClose.delete(onClose);
      resolve(ok);
    };
    const onClose = (): void => finish(false);
    exchange.onClose.add(onClose);
    write((error) => finish(error === undefined || error === null));
  });
}

/** True when nothing more can reach the driver on this exchange. */
function gone(exchange: Exchange): boolean {
  return exchange.closed || exchange.response.destroyed;
}

/** Serves `recording`. `workspace` is this replay's temp workspace; `sanitise` is this replay's sanitiser. */
export async function startOpencodeReplayServer(recording: Recording, options: { readonly workspace: string; readonly sanitise: Sanitiser }): Promise<OpencodeReplay> {
  const exchanges = new Map<number, Exchange>();
  const openStreams = new Set<number>();
  const streamListeners = new Set<() => void>();
  const streamsChanged = (): void => {
    for (const listener of [...streamListeners]) listener();
  };
  let requests = 0;
  // Writes run one after another, each once the one before it was flushed.
  let writes: Promise<void> = Promise.resolve();
  const later = (write: () => Promise<void>): void => {
    writes = writes.then(write, write);
  };
  const restore = <T>(value: T): T => restoreWorkspace(value, options.workspace);

  const deliver = (frame: Frame, line: number): void => {
    const taken = (): void => sequencer.taken(line);
    const id = Number(frame["id"]);
    const exchange = exchanges.get(id);
    if (exchange === undefined) throw new Error(`the frame answers exchange ${JSON.stringify(frame["id"])}, which the driver has not started`);
    const response = exchange.response;
    switch (frame.kind) {
      case "response": {
        if (exchange.answered || exchange.stream) throw new Error(`exchange ${id} already has its answer`);
        const contentType = typeof frame["contentType"] === "string" ? { "content-type": frame["contentType"] } : {};
        const status = Number(frame["status"]);
        if (frame["stream"] === true) {
          exchange.stream = true;
          later(async () => {
            if (gone(exchange)) return;
            response.writeHead(status, { ...contentType, "cache-control": "no-cache" });
            response.flushHeaders();
            openStreams.add(id);
            streamsChanged();
            taken();
          });
          return;
        }
        exchange.answered = true;
        later(async () => {
          if (gone(exchange)) return;
          response.writeHead(status, contentType);
          if (await flushed(exchange, (callback) => response.end(bodyText(restore(frame)), () => callback()))) taken();
        });
        return;
      }
      case "event": {
        if (!exchange.stream) throw new Error(`exchange ${id} is not an event stream`);
        later(async () => {
          if (gone(exchange) || response.writableEnded) return;
          if (await flushed(exchange, (callback) => response.write(eventText(restore(frame)), callback))) taken();
        });
        return;
      }
      case "end": {
        if (!exchange.stream) throw new Error(`exchange ${id} is not an event stream`);
        exchange.answered = true;
        later(async () => {
          if (gone(exchange) || response.writableEnded) return;
          if (await flushed(exchange, (callback) => response.end(() => callback()))) taken();
        });
        return;
      }
      case "dropped": {
        exchange.answered = true;
        later(async () => {
          if (gone(exchange)) return;
          response.socket?.destroy();
          taken();
        });
        return;
      }
      default:
        throw new Error(`the OpenCode replay does not deliver inbound frames of kind ${JSON.stringify(frame.kind)}`);
    }
  };

  const sequencer = new ReplaySequencer({ recording, ignored: OPENCODE_IGNORED_FIELDS, deliver });

  /** Sends an outbound frame, in the recording's placeholder form, to the sequencer; on drift, answers the request with it. */
  const send = (frame: Frame, exchange: Exchange): void => {
    try {
      sequencer.send(options.sanitise(frame));
    } catch (error) {
      if (exchange.answered) return;
      exchange.answered = true;
      if (gone(exchange) || exchange.response.headersSent) return;
      exchange.response.writeHead(500, { "content-type": "text/plain" }).end(error instanceof Error ? error.message : String(error));
    }
  };

  const server = http.createServer((request, response) => {
    const exchange: Exchange = { response, answered: false, stream: false, closed: false, onClose: new Set() };
    let id: number | undefined;
    response.on("error", () => undefined);
    onExchangeClosed(request, response, () => {
      exchange.closed = true;
      for (const listener of [...exchange.onClose]) listener();
      if (id !== undefined && openStreams.delete(id)) streamsChanged();
      if (exchange.answered) return;
      exchange.answered = true;
      // A request the driver never finished sending was never sent to the sequencer.
      if (id !== undefined) send({ dir: "out", kind: "close", id }, exchange);
    });
    void (async () => {
      const body = await requestBody(request);
      if (exchange.answered) return;
      requests += 1;
      id = requests;
      exchanges.set(id, exchange);
      send(requestFrame(id, request.method ?? "GET", new URL(request.url ?? "/", "http://replay.invalid"), body), exchange);
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  sequencer.start();
  return {
    url: `http://127.0.0.1:${address.port}`,
    sequencer,
    progress: {
      failure: () => sequencer.failure,
      describe: (what) => sequencer.describe(what),
      onChange: (listener) => sequencer.onChange(listener),
    },
    whenStreamsClosed: (timeoutMs) =>
      new Promise<boolean>((resolve) => {
        const check = (): void => {
          if (openStreams.size > 0) return;
          clearTimeout(timer);
          streamListeners.delete(check);
          resolve(true);
        };
        const timer = setTimeout(() => {
          streamListeners.delete(check);
          resolve(openStreams.size === 0);
        }, timeoutMs);
        streamListeners.add(check);
        check();
      }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
