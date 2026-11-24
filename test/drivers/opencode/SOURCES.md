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
  grants, then lets a plugin's `permission.evaluate` hook change the effect
  (`evaluateInput`); 1.x adds its in-memory grants last (`ask`). The fake's
  `FakeServer.decide` is that order; it models agent rules only for a 1.x
  child session (the `general` subagent's, 1.x `agent/agent.ts`).
- 1.x leaves out of the model's tools any tool whose last matching agent or
  session rule denies every resource (`permission/index.ts` `disabled`,
  `session/llm/request.ts`, `tool/code-mode.ts`); in-memory grants play no
  part (`FakeServer.v1Hidden`).
- A child session takes its rules once, when OpenCode creates it: 2.x copies
  the parent's (`core/src/session.ts` `create`: `permissions ?? parent.permissions`),
  1.x keeps the parent's deny and `external_directory` rules and adds a
  `task` deny (`tool/task.ts`, `agent/subagent-permissions.ts`).
- "Always": 1.x keeps the grant in memory for the directory's instance
  (`permission/index.ts` `approved`); 2.x saves it for the project
  (`PermissionSaved.add` with `location.project.id`). Both reach every session
  there.
- The patterns an "always" grants are the tool's, not the request's resource
  (`FakeServer.alwaysFor`): `*` for file reads and edits, web fetches and
  searches, globs, greps and MCP tools (1.x `tool/read.ts`, `tool/edit.ts`,
  `tool/write.ts`, `tool/apply_patch.ts`, `tool/webfetch.ts`,
  `tool/websearch.ts`, `tool/glob.ts`, `tool/grep.ts`, `session/tools.ts`;
  2.x `core/src/file-access.ts`, `core/src/tool/plugin/*.ts`,
  `core/src/tool/mcp.ts`); the glob for `external_directory`
  (`tool/external-directory.ts`); for MCP resources 1.x `mcp:<server>:*`
  (`session/tools.ts`), 2.x the server name to list and `<server>:*` to read
  (`core/src/tool/plugin/mcp-resource.ts`). A shell command's is its arity
  prefix and ` *` (1.x `tool/shell.ts`); the fake uses the first word.
- MCP tools ask for the permission `<server>_<tool>`, both names sanitized to
  `[a-zA-Z0-9_-]` (1.x `mcp/catalog.ts` `toolName`, 2.x `core/src/tool/mcp.ts`
  `name`), with the pattern `*`.
- MCP resources have tools of their own. 1.x: `list_mcp_resources`,
  `list_mcp_resource_templates` and `read_mcp_resource` ask `read` for
  `mcp:<server>:*` and `mcp:<server>:<uri>` (`session/tools.ts`). 2.x:
  `list_mcp_resources` asks `opencode_list_mcp_resources` for each server
  name, `read_mcp_resource` asks `opencode_read_mcp_resource` for
  `<server>:<uri>` (`core/src/tool/plugin/mcp-resource.ts`).
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
  (`mcp/index.ts` `add`); nothing is written to a file. `POST
  /mcp/{name}/disconnect` closes its client and keeps the config; a name
  never added is `McpServerNotFoundError` (`mcp/index.ts` `disconnect`,
  `server/routes/instance/httpapi/handlers/mcp.ts`).
- `GET /session/{id}/message` without `limit` pages through the whole history
  and answers it oldest first (`session/session.ts` `messages`,
  `session/message-v2.ts` `page`). The fake serves only that call.
- A fork of an empty session, or before a message it does not have, copies
  what there is (`session/session.ts` `fork`).
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
  removes runtime overrides of one location (`core/src/mcp/index.ts` `add`,
  `remove`, a location node). `add` replaces an entry of that name; `remove`
  of a name the location does not have is `McpServerNotFoundError`
  (`server/src/handlers/mcp.ts`).
- `GET /api/session/{id}/message` answers 50 messages newest first unless
  `limit` (1 to 200) or `order` says otherwise, with `cursor.previous` and
  `cursor.next` (base64url JSON of the anchor id, order and direction) for
  every non-empty page; following `next` past the oldest message gives an
  empty page without cursors; a cursor with `order` is `InvalidCursorError`
  (`server/src/handlers/message.ts`, `core/src/session/store.ts` `messages`).
- `POST /api/session/{id}/fork` refuses a session without messages
  (`InvalidRequestError`, `kind: "empty_session"`) and an unknown `before`
  (`MessageNotFoundError`); the fork takes the parent's rules and instruction
  entries and is published as `session.forked` (`core/src/session.ts` `fork`,
  `core/src/session/projector.ts`, `server/src/handlers/session.ts`,
  `schema/src/session-event.ts` `Forked`).
- `POST /api/session/{id}/revert/stage` then `.../revert/commit` drops
  messages; `POST /api/session/{id}/compact` admits a compaction that runs as
  an execution of its own.
- Questions are forms: `form.created` with string or multiselect fields,
  answered by `POST /api/session/{id}/form/{formID}/reply`.
- Child sessions of the `task` tool are published as `session.created` with a
  `parentID`.
