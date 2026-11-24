// A fake `fetch` for drivers that download things: fixed responses by URL,
// and a record of every URL asked for.

/** A `fetch` that serves fixed responses by URL and records every URL asked for. */
export function fixtureFetch(routes: { readonly [url: string]: unknown }): typeof globalThis.fetch & { readonly requested: string[] } {
  const requested: string[] = [];
  const fetchFunction = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const body = routes[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (body instanceof Uint8Array) return new Response(body, { status: 200 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return Object.assign(fetchFunction as typeof globalThis.fetch, { requested });
}
