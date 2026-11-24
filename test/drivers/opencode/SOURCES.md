# Sources of the fake OpenCode

`fake-opencode.ts` is a fake `opencode` CLI and server for OpenCode 1.19.6
(1.x) and 2.1.2 (2.x). It imports no driver code. Every request it receives
and every response it sends is validated against the vendored OpenAPI document
of its version, 1.x events against that document's `Event` schema, and 2.x
events against `OpenCodeEvent` of `@opencode/protocol`; tests assert that no
frame failed.

## Pinned versions

| What | Version | Where |
|---|---|---|
| OpenCode 1.x server API | 1.19.6 | `vendor-schemas/opencode/1.19.6/openapi.json` (tag `v1.19.6`, commit `f4e363c8295fa90a03dddc451882fffe8fbce357`) |
| OpenCode 2.x server API | 2.1.2 | `vendor-schemas/opencode/2.1.2/openapi.json` (served by `opencode` 2.1.2 at `GET /openapi.json`; tag `v2.1.2`, commit `a517687fde98a7329ada3ae644a01a9fc6c4e99e`) |
| 1.x SDK (devDependency) | @opencode-ai/sdk@1.19.6 | npm; the driver uses its `./v2` client |
| 2.x client (devDependency) | @opencode/client@2.1.2 | npm; the driver uses its Promise client (`.`) |
| 2.x event schema (devDependency) | @opencode/protocol@2.1.2 | npm; `groups/event` `OpenCodeEvent`, decoded with its own dependency effect 4.0.1 |
| `opencode` CLI run by hand | 2.1.2 | `opencode --version`, `opencode --help`, `opencode serve --help`, one isolated `opencode serve` to fetch its OpenAPI document |

Source read at the tags (sparse clones of https://github.com/anomalyco/opencode):
1.x under `packages/opencode/src`, 2.x under `packages/core/src`,
`packages/server/src`, `packages/cli/src` and `packages/client`.

## Behaviour and where it comes from

### Both generations

- `opencode serve --hostname 127.0.0.1 --port 0` prints the URL it listens on:
  1.x `opencode server listening on <url>` (1.x `cli/cmd/serve.ts`), 2.1.2
  `Server listening on <url>` (seen when run by hand; the 2.x source at the
  tag prints it in lower case, `cli/src/server-process.ts`, so the driver
  matches either).
- `opencode --version`: 1.x prints the bare version; 2.1.2 prints
  `opencode v2.1.2` (run by hand).
- HTTP Basic auth with the user `opencode` when a password is set: 1.x reads
  `OPENCODE_SERVER_PASSWORD` (1.x `cli/cmd/serve.ts`, `server/auth.ts`), 2.x
  `OPENCODE_PASSWORD` (2.x `cli/src/env.ts`). A request without it gets 401
  (seen when run by hand: `GET /api/info` without auth answered 401).
- A GET the API does not have reaches the web app, which answers HTML: 2.1.2
  answered `GET /global/health` and `GET /doc` with its HTML page when run by
  hand. The fake does the same for the other generation's info route.
- Permission rules: the last rule that matches wins, no match asks
  (1.x `permission/index.ts` `evaluate`, 2.x `core/src/permission.ts`
  `evaluate`), with `*` and `?` wildcards (`util/wildcard.ts` `match` in
  both). 2.x checks a session's own rules for a deny before it adds saved
  grants (`evaluateInput`); 1.x adds its in-memory grants last.
- "Always": 1.x keeps the grant in memory for the directory's instance
  (`permission/index.ts` `approved`); 2.x saves it for the project
  (`PermissionSaved.add` with `location.project.id`). Both reach every session
  there.
- MCP tools ask for the permission `<server>_<tool>`, both names sanitized to
  `[a-zA-Z0-9_-]` (1.x `mcp/catalog.ts` `toolName`, 2.x `core/src/tool/mcp.ts`
  `name`), with the pattern `*`.
- Sessions live in OpenCode's database, read by id from any server
  (1.x `session/session.ts` `get` by id; 2.x `SessionStore`); nothing locks a
  session.
- A fork copies the messages before the boundary into a new session with new
  ids (1.x `session/session.ts` `fork`).

### 1.x (1.19.6)

- `GET /event?directory=` streams `{ id, type, properties }` frames of that
  directory's instance, `server.connected` first
  (`server/routes/instance/httpapi/handlers/event.ts`).
- `POST /session/{id}/prompt_async` answers 204; the user message and its text
  part are published, then `session.status` busy; the run ends with
  `session.status` idle followed by `session.idle` (`session/status.ts`
  `set`). A prompt while a run is busy joins it (`session/prompt.ts` `loop`,
  `effect/runner.ts`).
- Text parts open empty, stream `message.part.delta` (`field: "text"`) and
  close with `time.end` (`session/processor.ts`); tool parts go pending,
  running, completed.
- Failures publish `session.error` and leave the error on the assistant
  message; a usage limit is `APIError` with `statusCode` 429 and the
  provider's response headers; an abort is `MessageAbortedError`
  (`session/processor.ts`, `session/message-error.ts`).
- `POST /session/{id}/revert` stages a revert; the next prompt or summary
  removes the messages (`session/revert.ts` `cleanup`).
- `POST /session/{id}/summarize` runs the loop for a compaction and answers
  when it is done (`server/routes/instance/httpapi/handlers/session.ts`
  `summarize`).
- `POST /mcp` adds a server to the instance's runtime config only
  (`mcp/index.ts` `add`); nothing is written to a file.
- Questions: `question.asked` with `questions[{ question, header, options,
  multiple, custom }]`, answered by `POST /question/{id}/reply` with
  `answers: string[][]`.
- Todo lists: `todo.updated` with `todos[{ content, status, priority }]`.

### 2.x (2.1.2)

- `GET /api/event` streams every location's events, `server.connected` first
  (`@opencode/protocol` `groups/event`).
- `POST /api/session/{id}/prompt` admits the prompt to the inbox
  (`session.inbox.enqueued`), wakes the execution
  (`session.execution.started`), delivers it (`session.inbox.delivered`); one
  terminal per busy period: `session.execution.succeeded|failed|interrupted`
  (`core/src/session/execution.ts`, `run-coordinator.ts`). With
  `delivery: "steer"` and `resume: false` the prompt waits in the inbox and a
  running execution takes it at its next step (`core/src/session/session.ts`
  `prompt`, `runner/llm.ts`); `DELETE /api/session/{id}/inbox/{inboxID}`
  takes a pending one back.
- Text streams as `session.text.started|delta|ended` named by the assistant
  message and the part's ordinal; tools as `session.tool.input.started`,
  `session.tool.called`, `session.tool.success|failed`.
- A failed execution carries a structured error; a usage limit is
  `provider.rate-limit` (or `provider.quota` other than HTTP 402) with
  `retryAfterMs` (served 2.1.2 OpenAPI `Session.StructuredError`).
- `PUT /api/experimental/session/{id}/instructions/entries/{key}` keeps
  instructions for a session.
- `PUT|DELETE /api/experimental/mcp/{server}?location[directory]=` adds and
  removes runtime overrides (`core/src/mcp/index.ts` `add`, `remove`).
- `POST /api/session/{id}/revert/stage` then `.../revert/commit` drops
  messages; `POST /api/session/{id}/compact` admits a compaction that runs as
  an execution of its own.
- Questions are forms: `form.created` with string or multiselect fields,
  answered by `POST /api/session/{id}/form/{formID}/reply`.
- Child sessions of the `task` tool are published as `session.created` with a
  `parentID`.
