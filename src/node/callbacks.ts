// Sign-in callbacks for a Node host: a loopback HTTP server. `register(flowId)`
// returns a URL on 127.0.0.1 with an unguessable path. When a browser or the
// provider requests that URL, the server hands the host
// `{ flowId, callbackUrl }` (the shape of `instance.auth.complete`'s input) and
// answers with a short page. The host routes it to the right instance. No
// handler function crosses into the driver, so this works over `ari/wire` too.
//
// A registration is used once: the first request completes it, and later
// requests to the same URL get 404. Unknown paths get 404.

import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { callErrors } from "../errors.ts";
import type { CallbackRegistration } from "../generated/host.ts";
import type { AuthCompleteInput } from "../generated/instance.ts";

export interface CallbackServerOptions {
  /** Called once per registration with the full URL that was requested. */
  onCallback(input: AuthCompleteInput): void | Promise<void>;
  /** Defaults to 0: the system picks a free port. */
  port?: number;
}

export interface CallbackServer {
  /** The base URL, such as `http://127.0.0.1:43123`. */
  readonly url: string;
  /** A one-time callback URL for sign-in flow `flowId`. */
  register(flowId: string): Promise<CallbackRegistration>;
  close(): Promise<void>;
}

const COMPLETED_PAGE = "<!doctype html><title>Signed in</title><p>Sign-in received. You can close this window.</p>";

export async function startCallbackServer(options: CallbackServerOptions): Promise<CallbackServer> {
  const flowsByPath = new Map<string, string>();

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const flowId = flowsByPath.get(requestUrl.pathname);
    if (flowId === undefined) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    flowsByPath.delete(requestUrl.pathname);
    const callbackUrl = new URL(request.url ?? "/", baseUrl).href;
    Promise.resolve()
      .then(() => options.onCallback({ flowId, callbackUrl }))
      .then(
        () => response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(COMPLETED_PAGE),
        () => response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("Sign-in could not be completed"),
      );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: baseUrl,

    async register(flowId) {
      if (typeof flowId !== "string" || flowId === "") {
        throw callErrors.validation([{ path: ["flowId"], message: "must be a non-empty string" }], "Invalid flowId");
      }
      const callbackPath = `/callback/${randomBytes(24).toString("base64url")}`;
      flowsByPath.set(callbackPath, flowId);
      return { url: `${baseUrl}${callbackPath}` };
    },

    async close() {
      flowsByPath.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
