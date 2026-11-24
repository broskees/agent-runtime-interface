# OpenCode 2.1.2 OpenAPI document

`openapi.json` is the OpenAPI 3.1.0 document an OpenCode 2.1.2 server serves
about itself at `GET /openapi.json` (2.x no longer serves it at `GET /doc`,
which returns its web app):

- Server: the `opencode` CLI 2.1.2 (`opencode --version` prints
  `opencode v2.1.2`), started as `opencode serve --hostname 127.0.0.1 --port 0`
  with `HOME` and every `XDG_*` directory set to an empty temporary directory
  and `OPENCODE_PASSWORD` set, then stopped. No prompt was sent.
- Fetched 2026-11-23 with HTTP Basic auth (user `opencode`).
- sha256 `b99ddb33ba96f6a5bfba762ba777987c1339e09c881bbc76d4deefeb74ee5449`

The repository commits a generated copy at `packages/protocol/openapi.json`
(tag `v2.1.2`, commit `a517687fde98a7329ada3ae644a01a9fc6c4e99e`). It has the
same 119 paths and 290 schemas and differs in one place: the served document's
`Session.StructuredError` has `retryAfterMs` (integer, minimum 0), which the
committed copy lacks. The served document is vendored, because it is what the
2.1.2 server answers with.

The document describes the `GET /api/event` stream only as
`contentMediaType: application/json`; events are checked against
`OpenCodeEvent` from `@opencode/protocol` 2.1.2 instead
(`test/drivers/opencode/v2-events.ts`).

It is a development input for the fake OpenCode 2.x server in
`test/drivers/opencode/`. It is never shipped.
