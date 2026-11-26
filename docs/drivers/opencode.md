# The OpenCode driver (`ari/drivers/opencode`)

The OpenCode driver runs the user's own [OpenCode](https://opencode.ai) server,
1.x or 2.x, or talks to an OpenCode server someone else runs. It speaks the
server's HTTP API through the OpenCode SDKs, which are optional peers loaded
with a dynamic `import()` only when a server of their generation is used:

| Server | SDK the driver loads | Tested against |
|---|---|---|
| OpenCode 1.x | `@opencode-ai/sdk` (its `./v2` client) | `>=1.19.6 <2.0.0`: the 1.19.6 API, `@opencode-ai/sdk` 1.19.6 |
| OpenCode 2.x | `@opencode/client` (its Promise client) | `>=2.1.2 <2.2.0`: the 2.1.2 API, `@opencode/client` 2.1.2 |

The proposal names `@opencode-ai/sdk ^1.3.15` and `@opencode/client 2.0.28`.
Both packages exist on npm. The driver is built and tested against
`@opencode-ai/sdk` 1.19.6 (the latest 1.x, 2026-11-17) and `@opencode/client`
2.1.2 (the version of the `opencode` 2.1.2 CLI used to fetch the 2.x API
description), so its peer ranges are `^1.19.6` and `^2.1.2`.
`test/drivers/opencode/SOURCES.md` lists every source the driver and its fake
follow.

```ts
import { opencodeDriver } from "ari/drivers/opencode";

const instance = await opencodeDriver.create(host, { instanceId: "opencode", config: { binary: "opencode" }, environment: {} });
const session = await instance.openSession({});
const thread = await session.createThread({ cwd: "/work", policy: { mode: "approval_required", interaction: "default", cwd: "/work" } });
```

## Config

| Field | Meaning |
|---|---|
| `binary` | The `opencode` executable: a name looked up on `PATH` through `host.process.resolveExecutable`, or a path. Default `opencode`. |
| `serverUrl` | An OpenCode server someone else runs. When set, the driver never starts or stops a server. Its password, if any, is the instance secret `opencode/server-password`, never config. |
| `model` | The model new threads start with, as `provider/model`. OpenCode's default when left out. |
| `agent` | The OpenCode agent new threads use (for example `build`). OpenCode's default when left out. |

`ari/meta/opencode` exports the label, icon, this schema, form hints, the
tested ranges and the SDK package of each generation, without loading the
driver.

## Which server, and which runtime

The driver chooses the runtime by the server's version:

- For a server it starts, `opencode --version` (1.x prints `1.19.6`, 2.x
  prints `opencode v2.1.2`). Major 2 or above is 2.x.
- For an external server, `GET /api/info` (2.x answers `{ version, pid }`),
  then `GET /global/health` (1.x answers `{ healthy: true, version }`). A
  route of the other generation reaches the server's web app, which answers
  HTML; the driver requires JSON.

Who runs which server, and the session model the capabilities declare:

| Server | `sessionModel` | `externallyOwned` | What the driver does |
|---|---|---|---|
| 1.x, started by the driver | `process_per_thread` | `false` | One `opencode serve` per thread. A 1.x server keeps "always" grants in memory for the whole directory and lets them win over a session's own rules (1.19.6 `permission/index.ts`), so threads never share a 1.x server the driver starts. Parking a thread (`unloadThread`, `release`) stops its server; OpenCode keeps the session in its database, and the next use starts a server and finds it again. |
| 2.x, started by the driver | `process_per_instance` | `false` | One `opencode serve` per instance, shared by every session of the instance, stopped by `instance.dispose()`. Closing a session never stops it. |
| Any external server | `external` | `true` | Never started and never stopped: `session.close()` and `instance.dispose()` only drop the driver's subscriptions and take its MCP entries off the server. A turn that loses an external server ends `failed` with `threadDisposition: "broken"`, because nobody here can start it again. |

Every server the driver starts runs `opencode serve --hostname 127.0.0.1
--port 0` through `host.process.spawn`, with its own random password: 1.x
reads `OPENCODE_SERVER_PASSWORD`, 2.x `OPENCODE_PASSWORD`. Inherited values of
both are removed from the instance's environment, and the CLI manifest scrubs
them. Both generations accept only HTTP Basic auth with the user `opencode`.

2.x serves its own OpenAPI document at `GET /openapi.json`; `GET /doc` (the
1.x path) returns 2.x's web app. The vendored 2.1.2 document
(`vendor-schemas/opencode/2.1.2/`) was fetched that way from an isolated
`opencode serve`.

## Threads, turns and ids

- **Thread**: one OpenCode session. `native` is the session id (strong);
  `handle` is the same id, which `resumeThread({ native: { handle } })`
  takes. A thread's directory is made canonical (symbolic links followed)
  before OpenCode sees it, so a thread started through a link reports the
  real directory and the same ids.
- **Resume**: a resume that brings a `LaunchContext` gives the thread that
  launch from its next turn, its MCP servers included (entries the old launch
  gave come off); one that brings none keeps the thread's own, whether the
  session holds the thread loaded, parked (1.x) or not at all. The thread's
  creation `context` stays with it in the session that created it. A 2.x
  thread resumed by an instance that did not write its instruction entry gets
  the entry cleared before its first prompt, so host text an earlier instance
  wrote does not stay (removing a missing entry changes nothing, 2.1.2
  `core/src/session/instruction-entry.ts`).
- **Ids**: every id derives from a native OpenCode id with
  `deriveId(kind, { id, strength: "strong" }, identityVersion: 1)`, scoped by
  the thread for turns, items and requests. A thread id is
  `deriveId({ kind: "thread", native: { id: <session id>, strength: "strong" }, identityVersion: 1 })`.
- **Turn**: one prompt and the run it starts. It is named by the prompt's
  message id as the server assigned it: 2.x says it in the answer to
  `session.prompt` and in `session.inbox.enqueued`; 1.x in the user message's
  events. `startTurn` returns once the server has named the prompt.
- **Settlement**: only on the server's authoritative end of the run (1.x
  `session.status` idle then `session.idle`; 2.x
  `session.execution.succeeded|failed|interrupted`), or when a server the
  driver started exits. Never on a timer.
- **Steer** (2.x): `session.prompt` with `delivery: "steer"` and
  `resume: false`, tagged `ari.steer` in its metadata. It joins the running
  execution at its next step and never starts one. If no execution runs
  (`session.active`), the driver takes it back
  (`DELETE /api/session/{id}/inbox/{inboxID}`) and returns `prompt_required`.
  1.x has no such call: a prompt sent while a run is active joins it, but one
  sent after the run ended starts a new run, so a late steer cannot be
  refused; 1.x steering is off.
- **Interrupt**: 1.x `session.abort`, 2.x `session.interrupt`; the run ends
  with the interrupted outcome. `restartRuntime` on 1.x stops the thread's
  server.
- **Rollback**: 1.x `session.revert` at the first message to drop (OpenCode
  removes the messages with the next prompt or summary, and the driver hides
  them until then); 2.x `revert.stage` then `revert.commit`. Rolling back to a
  turn keeps it.
- **Fork**: `session.fork` before a turn's prompt (from a turn) or of every
  message (at latest). OpenCode's fork takes no directory, so a fork stays in
  the source's directory (`crossCwd: false`). 2.x refuses to fork a session
  without messages (`InvalidRequestError` `empty_session`, 2.1.2
  `core/src/session.ts` `fork`); the driver reports that as `invalid_state`
  (`empty_thread`). A 2.x fork takes the parent's rules and instruction
  entries, and the driver knows the copied entry as the fork's own.
- **Compaction**: 1.x `session.summarize` (with the thread's model), 2.x
  `session.compact`; both run as a run of their own, and `compactThread`
  returns when it ends.
- **Snapshots** are rebuilt from the session's messages with the ids the live
  events used: each prompt starts a turn; steers (tagged in their metadata)
  and assistant messages belong to the turn before. Snapshots, forks from a
  turn and rollbacks read the whole history, oldest first: 1.x answers it so
  when the call has no `limit` (1.19.6 `session/session.ts` `messages`); 2.x
  answers 50 messages a page, newest first, by default (2.1.2
  `server/src/handlers/message.ts`), so the driver asks for `order: "asc"`
  and pages of 200 and follows `cursor.next` until a page comes back short.
- **Items**: text and reasoning parts by part id (2.x: the assistant message
  and the part's ordinal), tools by call id. `bash`/`shell` map to
  `command_execution`, `read` to `file_read`, `edit`/`write`/`apply_patch` to
  `file_change`, `glob`/`grep`/`list` to `file_search`, `websearch` to
  `web_search`, `task` to `subagent_spawn`, MCP tools (`<server>_<tool>`) to
  `mcp_tool_call`, anything else to `tool_call`. 1.x streams a running shell
  command's output (`metadata.output`); 2.x reports it with the result.
- **Subagents**: a child session of a thread (OpenCode's `task` tool) is a
  subagent with its own thread (`subagent.upsert` with `threadId`), running
  until the child's run ends. Its approvals and questions reach the host on
  the parent thread with `origin.subagentId`. OpenCode gives the child its
  rules once, when it creates it: 2.x a copy of the parent's (2.1.2
  `core/src/session.ts` `create`), 1.x only the parent's denies and
  `external_directory` rules, evaluated after the subagent's own agent's
  rules (1.19.6 `tool/task.ts`, `agent/subagent-permissions.ts`). So a 1.x
  subagent does not ask where the thread's mode asks, and asks where its
  agent does (for example before reading a `.env` file): that is OpenCode's
  native behaviour, kept. The driver adds to each child's rules every deny of
  another thread's MCP entry the thread gets later.
- **Todo lists** (1.x): `todo.updated` becomes the turn's `todo_list` item.

## Runtime modes are OpenCode permission rules

OpenCode enforces each mode natively, through the session's own permission
rules (1.x `Session.permission`, 2.x `Session.permissions`). Both generations
evaluate the agent's rules and then the session's, and the last rule that
matches wins. A thread's rules are, in this order:

1. the mode's rules (`bash` in 1.x is `shell` in 2.x):
   - `full_access`: `* allow`; OpenCode then asks nothing;
   - `approval_required`: shell, `edit` and `external_directory` ask;
   - `auto_accept_edits`: shell and `external_directory` ask, `edit` allowed;
   - `read_only`: shell and `edit` denied, `external_directory` asks;
2. the host's own rules, set through `opencode.permissionRules`;
3. the `deny` rules for every other thread's host MCP entries on the same
   server (see below).

`auto` is not supported: OpenCode has no automatic approval classifier.
2.x replaces a session's rules on a live session (`session.update`), so the
mode can change between turns; 1.x keeps it fixed.

## MCP servers are per directory

OpenCode registers MCP servers per directory on a server (1.x `POST /mcp`,
2.x `PUT /api/experimental/mcp/{server}`, both runtime only, never written to
a config file), while the host's tool servers are per thread. So:

- Each thread gets the host's tool server for it (`hostTools.mcpServerFor`)
  plus the launch's MCP servers, under exactly the names the host chose,
  before its first turn: on create, resume, fork and replacement alike.
- On a shared server (2.x, or any external server) every other thread, and
  each of its subagents, gets `deny` rules for each new entry before the
  entry is added, one for each way OpenCode reaches an entry:
  - its tools: MCP tools ask for the permission `<server>_<tool>`, both names
    sanitized to `[a-zA-Z0-9_-]` (1.19.6 `mcp/catalog.ts` `toolName`, 2.1.2
    `core/src/tool/mcp.ts` `name`), so `<other server>_* deny` closes every
    tool of that entry (1.x also leaves such a tool out of the model's tools,
    1.19.6 `permission/index.ts` `disabled`);
  - its resources: 1.x lists and reads them under `read` for
    `mcp:<server>:*` and `mcp:<server>:<uri>` (1.19.6 `session/tools.ts`), so
    the driver denies `read` on `mcp:<other server>:*`; 2.x under
    `opencode_list_mcp_resources` for the server's name and
    `opencode_read_mcp_resource` for `<server>:<uri>` (2.1.2
    `core/src/tool/plugin/mcp-resource.ts`), so the driver denies both. A
    listing of every server names them all, so a thread lists resources by
    its own server's name while another thread's entry is there.
  The deny rules come last, so neither a mode nor the host's rules can reopen
  them, and on 2.x a saved "always" grant cannot either (2.x checks a
  session's denies before saved grants, 2.1.2 `core/src/permission.ts`
  `evaluateInput`).
- 1.x checks its in-memory "always" grants after a session's rules (1.19.6
  `permission/index.ts` `ask`), and a shared external 1.x server keeps them
  for every session of the directory. Tools stay closed, because 1.x leaves a
  tool denied for every resource out of the model's tools whatever the grants
  say. The resource deny does not: a grant of `read` whose pattern can match
  `mcp:<server>:*` overrides it for every thread, and 1.x grants `*` for an
  ordinary file read (1.19.6 `tool/read.ts`). So on a shared 1.x server the
  driver offers `always` only when the grant cannot match an MCP resource: a
  permission other than `read`, or `read` patterns whose text before the
  first wildcard neither starts with `mcp:` nor is the start of `mcp:` (an
  external directory's glob, a literal path). A file read there offers
  `once` and `reject`. Any other "always" still reaches every session of the
  directory, as its `scope: "project"` and warning say. A grant another
  client of that server makes is outside the driver's reach.
- A thread whose resume drops an entry another thread in the directory still
  holds is denied it from then on, and so are its subagents; the entry stays
  for the other thread.
- Threads in one directory that ask for the same MCP server under one name
  (the same config, such as a session's launch servers) share its entry. A
  thread that asks for a different server under a name another thread holds
  in that directory is refused with `invalid_state` (`mcp_name_conflict`):
  OpenCode keeps one entry per name there, and the second would replace the
  first. Host names that OpenCode's rules cannot keep apart (one is the
  other's prefix followed by `_` or `:`, or a name holds `*` or `?`) are
  refused with `invalid_state` (`mcp_name_collision`).
- A closed session takes its entries off a shared server first (an entry
  another thread still holds stays), and only then do the other threads stop
  denying them. A removal OpenCode does not confirm keeps the other threads'
  denies, and `session.close()` rejects with it.

## Requests

- A permission request becomes an approval (`command` for shell, `file_change`
  for `edit`, `file_read` for `read`, `permission` for anything else, MCP
  tools included). Its options are OpenCode's three replies, and the option id
  is the reply itself:
  - `once`: decision `accept`, scope `once`;
  - `always`: decision `accept_always`, `scope: "project"`, with a warning:
    OpenCode keeps the grant for every session of the project (1.x in the
    directory's instance, 2.x saved for the project);
  - `reject`: decision `decline`.
  A host's `full_access` auto-reply (`fullAccessAutoReply` in `ari/host`)
  therefore picks `once`, the narrowest. The driver itself never answers.
  Under `full_access` the thread's `* allow` rule means OpenCode asks the
  thread's own session nothing. A request that still arrives says why:
  - a rule the host set asks for it: `fullAccessOverride: "ask_rule"`;
  - it comes from a 1.x subagent, whose agent's rules asked (see Subagents):
    no override, so the host's auto-reply answers it, and OpenCode gets
    `once`;
  - anything else is OpenCode's own check, such as a plugin's
    `permission.evaluate` hook (2.1.2 `core/src/permission.ts`
    `evaluateInput`): `fullAccessOverride: "provider_check"`.
  A request with an override reaches the user; no auto-reply answers it.
- A question (1.x `question.asked`, 2.x a form) becomes a `user_input` request
  answered in OpenCode's shape (1.x `answers: string[][]` of option labels,
  2.x the form's `answer` by field key). Answering without `answers` rejects
  (1.x) or cancels (2.x) it.
- Requests live only as long as their run and their server
  (`pendingRequestsSurviveRestart: false`).

## Host instructions

Host text (`launch.appendSystemPrompt`, `launch.developerPrompt`,
`context.system`, `context.developer`) travels in OpenCode's system channel
(`context.instructionChannels: ["system"]`):

- 1.x: the `system` field of `session.prompt_async`, on every prompt
  (OpenCode runs each step with the latest user message's system text).
- 2.x: the session's instruction entry `ari`
  (`PUT /api/experimental/session/{id}/instructions/entries/ari`), written
  when it changes and removed when it becomes empty.

Without host text the driver sends none: it never adds instruction text of its
own. OpenCode keeps the text in its session database (1.x on the user
message, 2.x as the instruction entry), never in its config files.

## Resuming conversations ARI did not create

The driver resumes any session the OpenCode server holds, including one
created outside ARI: `resumeThread` asks the server for the id the host named.
It then gives that session what it gives a session it created: the permission
rules for the host's runtime policy (plus, on a shared server, deny rules for
other threads' host MCP entries), the host's MCP servers registered on the
running server under the names the host chose, and the host's instructions
through the system channel above. All of it goes through the server's API;
nothing is written to OpenCode's config files. For OpenCode 1.x, a session
this ARI session has not seen needs `policy.cwd` (`validation` otherwise). A
session the server does not have is replaced by a fresh one with
`session.replaced` when the host passed `policy`, and rejects with `not_found`
otherwise. The driver lists no native sessions (`nativeSessions` is absent).

## The `opencode.permissionRules` extension

`capabilities.extensions` lists `{ ns: "opencode.permissionRules", version:
"1" }`; the schema is `spec/v1/extensions/opencode.schema.json`.

- `session.ext("opencode.permissionRules", "get", { threadId })` returns the
  thread's session rules as the server holds them: `{ rules: [{ action,
  resource, effect }] }` (1.x's `permission`/`pattern`/`action` renamed to
  2.x's `action`/`resource`/`effect`).
- `session.ext("opencode.permissionRules", "set", { threadId, rules })`
  replaces the host's rules (between the mode's rules and the isolation
  denies) and returns the server's rules after the change.

## Sign-in

OpenCode keeps sign-in per model provider in its own store, so the instance
has no ARI `auth` group: `status()` reports no auth state, and sign-in happens
in OpenCode (`opencode auth login`). A server password for an external server
is the instance secret `opencode/server-password`.

## The user's own `opencode`, and its minimum

ARI runs the `opencode` the user installed, found on `PATH` or at the path the
config names, and never downloads, installs or updates one. The minimums are
OpenCode 1.19.6 for 1.x and 2.1.2 for 2.x, the lower bounds of the tested
ranges `>=1.19.6 <2.0.0` and `>=2.1.2 <2.2.0`; a release from before 1.x
counts as older than the 1.x minimum. With an older `opencode`, `status()` is
`unavailable` with `driver_unavailable` (with `installed: true` and the
version found), and `openSession` rejects with the same error before any
server starts: the only process that runs is `opencode --version`.
`catalog.list` rejects with it too when it would start a local server.
The error names the version found, the path, the minimum and OpenCode's
update step:

```text
OpenCode 2.0.21 (/usr/local/bin/opencode) is older than 2.1.2, the oldest version this driver supports. Update OpenCode with `opencode upgrade`.
```

The update step is OpenCode's own: `opencode upgrade` "Upgrades OpenCode to
the latest or a specific version" ([OpenCode CLI commands,
`upgrade`](https://opencode.ai/docs/cli/commands/#upgrade)). An `opencode`
above the tested range still runs, with an `untested_version` advisory.
`opencode --version` prints `opencode v2.1.2` for 2.x and the bare version,
such as `1.19.6`, for 1.x (`test/fixtures/cli-version-output/opencode-2.txt`
and `opencode-1.txt`).

## Probes and status

`probe()` runs only `opencode --version`, or reads an external server's info
route; it starts no server and writes nothing. `status()` reports the version.
A local CLI below the minimum gives `driver_unavailable`. A local CLI above
its generation's tested range, or an external server outside that range,
gets an `untested_version` advisory.
Without `opencode`, `status()` is `unavailable` with a `driver_unavailable`
error naming the binary. Without the SDK the server's generation needs, it is
`unavailable` with a `driver_unavailable` error naming `@opencode-ai/sdk` or
`@opencode/client`. `openSession` rejects with the same error in both cases.

## Capabilities

The columns are the driver's declarations for 1.x and 2.x servers it starts,
then the proposal's §1.2 OpenCode 1.x and 2.x columns (Y or –, "n/a" where
§1.2 has no row). Every difference cites the OpenCode source. An external
server declares `sessionModel: "external"`, `externallyOwned: true`, and
`sessions.release` and `threads.unload` `false`.

| Capability | 1.x | 2.x | §1.2 1.x | §1.2 2.x | Notes and sources |
|---|---|---|---|---|---|
| `sessions.multipleThreads` | `true` | `true` | n/a | n/a | |
| `sessions.switchModel` | `true` | `true` | Y | Y | 1.x per prompt (`model`), 2.x `session.switchModel`. |
| `sessions.switchRuntimeMode` | `false` | `true` | – | Y | 2.x `session.update` replaces the rules. |
| `sessions.pendingRequestsSurviveRestart` | `false` | `false` | n/a | n/a | Pending requests live in the server's memory. |
| `sessions.release` | `true` | `false` | n/a | n/a | 1.x stops the threads' servers; a 2.x server serves the whole instance. |
| `sessions.feedbackUpload` | `false` | `false` | n/a | n/a | Neither OpenAPI document has a feedback route. |
| `sessions.contextUsageReuse` | `false` | `false` | n/a | n/a | |
| `threads.createEmpty` | `true` | `true` | n/a | n/a | |
| `threads.readSnapshot` | `true` | `true` | Y | Y | |
| `threads.rollback` | `true` | `true` | Y | Y | |
| `threads.compact` | `true` | `true` | n/a | n/a | |
| `threads.injectHistory` | `false` | `false` | n/a | n/a | |
| `threads.unload` | `true` | `false` | n/a | n/a | As `sessions.release`. |
| `threads.exposesNativeIds` | `true` | `true` | n/a | n/a | |
| `threads.fork.supported` | `true` | `true` | Y | Y | |
| `threads.fork.fromTurn` | `true` | `true` | Y | Y | The fork holds the history before the turn. |
| `threads.fork.fromItem` | `false` | `false` | n/a | n/a | |
| `threads.fork.fromSubagent` | `true` | `false` | Y | – | 1.x forks a subagent's session like any other. |
| `threads.fork.crossCwd` | `false` | `false` | n/a | n/a | `session.fork` takes no directory (1.19.6 and 2.1.2 OpenAPI). |
| `turns.interrupt` | `true` | `true` | Y | Y | |
| `turns.steer` | `false` | `true` | Y | Y | 1.x: a prompt joins a running loop but starts a new run once it ended (OpenCode 1.19.6 `session/prompt.ts` `loop`, `effect/runner.ts` `ensureRunning`), so a late steer cannot be refused and would start an untracked turn. 2.x: `delivery: "steer"`, `resume: false`. |
| `turns.queue` | `false` | `false` | Y | Y | 1.x: a prompt sent during a run joins it at the next step instead of waiting (OpenCode 1.19.6 `session/prompt.ts`). 2.x: a queued prompt runs inside the same execution, whose one terminal (OpenCode 2.1.2 `core/src/session/execution.ts`, "one terminal observation per busy period") cannot settle the earlier turn. Hosts queue on their side. |
| `turns.emitsStarted` | `true` | `true` | n/a | n/a | |
| `turns.terminalStatus` | `"strong"` | `"strong"` | n/a | n/a | |
| `turns.multiNativeTurnsPerRequest` | `false` | `false` | n/a | n/a | |
| `turns.steeringInterruptsTools` | `false` | `false` | n/a | n/a | A steer joins at the next step. |
| `streaming.assistantText` | `true` | `true` | n/a | n/a | |
| `streaming.reasoning` | `true` | `true` | n/a | n/a | |
| `streaming.toolOutput` | `true` | `false` | Y | – | 1.x running shell `metadata.output`. |
| `streaming.planText` | `false` | `false` | – | – | |
| `tools.mcp` | `true` | `true` | Y | – | 2.x takes runtime MCP servers at `PUT /api/experimental/mcp/{server}` (OpenCode 2.1.2 OpenAPI) and registers their tools (OpenCode 2.1.2 `core/src/tool/mcp.ts`). |
| `tools.dynamicTools` | `false` | `false` | – | – | |
| `tools.mcpApps` | `false` | `false` | n/a | n/a | Neither OpenAPI document has a route to call an MCP tool or read a resource directly. |
| `tools.exposesToolItemIds` | `true` | `true` | n/a | n/a | |
| `approvals.command` | `true` | `true` | Y | Y | |
| `approvals.fileRead` | `true` | `true` | Y | Y | |
| `approvals.fileChange` | `true` | `true` | Y | Y | |
| `approvals.permission` | `true` | `true` | n/a | n/a | |
| `approvals.fromSubagents` | `true` | `true` | Y | Y | |
| `planning.todoList` | `true` | `false` | Y | – | 1.x `todo.updated`. |
| `planning.proposedPlan` | `false` | `false` | – | – | |
| `planning.planUpdates` | `false` | `false` | n/a | n/a | |
| `planning.structuredQuestions` | `true` | `true` | Y | Y | 1.x questions, 2.x forms. |
| `subagents.supported` | `true` | `true` | Y | Y | |
| `subagents.exposesThreadIds` | `true` | `true` | Y | Y | |
| `subagents.lifecycle` | `true` | `true` | n/a | n/a | |
| `subagents.wait` | `true` | `true` | Y | Y | The `task` tool waits for its child session. |
| `subagents.stop` | `false` | `false` | – | – | |
| `context.instructionChannels` | `["system"]` | `["system"]` | – | – | §1.2 has "–/–" for system and developer context. OpenCode takes host text natively: 1.x `session.prompt_async` `system` (OpenCode 1.19.6 OpenAPI), 2.x session instruction entries (OpenCode 2.1.2 OpenAPI `PUT /api/experimental/session/{sessionID}/instructions/entries/{key}`). |
| `context.syntheticContext` | `false` | `false` | n/a | n/a | |
| `context.summaries` | `true` | `true` | Y | – | Compaction writes a summary in both: 1.x `session.summarize`, 2.x `session.compaction.ended` `text` (OpenCode 2.1.2 `@opencode/protocol` events). |
| `context.handoffSummaries` | `false` | `false` | n/a | n/a | |
| `checkpointing.workspace` | `false` | `false` | n/a | n/a | |
| `checkpointing.conversationRollback` | `true` | `true` | Y | Y | |
| `checkpointing.rollbackReturnsSnapshot` | `true` | `true` | n/a | n/a | |
| `identity.threadIds` | `"strong"` | `"strong"` | n/a | n/a | The session id. |
| `identity.turnIds` | `"strong"` | `"strong"` | n/a | n/a | §1.2's id row has weak turn ids for both. The driver names a turn by its prompt's message id as the server assigned it (OpenCode 1.19.6 `UserMessage.id`, 2.1.2 `Session.Inbox.User.id`). |
| `identity.itemIds` | `"strong"` | `"strong"` | n/a | n/a | Part ids and tool call ids. |
| `identity.requestIds` | `"strong"` | `"strong"` | n/a | n/a | |
| `identity.identityVersion` | `1` | `1` | n/a | n/a | |
| `runtimePolicy.modes.read_only.supported` | `true` | `true` | n/a | n/a | |
| `runtimePolicy.modes.read_only.enforcement` | `"native"` | `"native"` | n/a | n/a | Session permission rules. |
| `runtimePolicy.modes.approval_required.supported` | `true` | `true` | n/a | n/a | |
| `runtimePolicy.modes.approval_required.enforcement` | `"native"` | `"native"` | n/a | n/a | |
| `runtimePolicy.modes.auto_accept_edits.supported` | `true` | `true` | n/a | n/a | |
| `runtimePolicy.modes.auto_accept_edits.enforcement` | `"native"` | `"native"` | n/a | n/a | |
| `runtimePolicy.modes.auto.supported` | `false` | `false` | n/a | n/a | No automatic approval classifier. |
| `runtimePolicy.modes.auto.enforcement` | `"native"` | `"native"` | n/a | n/a | |
| `runtimePolicy.modes.full_access.supported` | `true` | `true` | n/a | n/a | |
| `runtimePolicy.modes.full_access.enforcement` | `"native"` | `"native"` | n/a | n/a | |
| `runtimePolicy.interactionModes` | `["default"]` | `["default"]` | n/a | n/a | |
| `runtimePolicy.switchInSession` | `false` | `true` | n/a | n/a | As `sessions.switchRuntimeMode`. |
| `requests.responseModes` | `["live"]` | `["live"]` | n/a | n/a | |
| `requests.allowCustomAnswer` | `true` | `true` | n/a | n/a | Questions take free text where OpenCode allows it. |
| `requests.approvalScopes` | `[{"decision":"accept","scope":"once"},{"decision":"accept_always","scope":"project"}]` | `[{"decision":"accept","scope":"once"},{"decision":"accept_always","scope":"project"}]` | n/a | n/a | "Always" reaches the project. |
| `background.list` | `false` | `false` | n/a | n/a | |
| `background.stop` | `false` | `false` | n/a | n/a | |
| `background.await` | `false` | `false` | n/a | n/a | |
| `background.tasksEndWithProcess` | `true` | `true` | n/a | n/a | |
| `mcp.acceptsHostServers` | `["stdio","http"]` | `["stdio","http"]` | n/a | n/a | OpenCode's `local` and `remote` MCP configs. |
| `mcp.scope` | `"directory"` | `"directory"` | n/a | n/a | Per directory on a server. |
| `sessionModel` | `"process_per_thread"` | `"process_per_instance"` | n/a | n/a | `external` for an external server. |
| `externallyOwned` | `false` | `false` | n/a | n/a | `true` for an external server. |
| `diffs.emits` | `false` | `false` | n/a | n/a | |
| `diffs.canDisable` | `false` | `false` | n/a | n/a | |
| `contextWindowReporting` | `true` | `true` | n/a | n/a | From the catalog's `limit.context`. |
| `extensions` | `[{"ns":"opencode.permissionRules","version":"1"}]` | `[{"ns":"opencode.permissionRules","version":"1"}]` | n/a | n/a | |

## Optional members

Of the 44 optional `Session` and `Instance` members, the driver implements
`readSnapshot`, `forkThread`, `rollbackThread`, `compactThread`,
`unloadThread`, `contextWindow` and `ext`. `unloadThread` rejects with
`unsupported{capability: "threads.unload"}` on a 2.x or external server.
Every other optional member is left out, the `auth` group included.
`test/drivers/opencode/capabilities.suite.ts` holds the full list for each
generation.

## How it is tested

`test/drivers/opencode/fake-opencode.ts` is a fake `opencode` for 1.19.6 and
2.1.2: `--version`, and `serve` as a real HTTP server on a loopback port. It
imports no driver code and follows the pinned source (`SOURCES.md`). It
validates every request it receives and every response it sends against the
vendored OpenAPI document of its version, 1.x events against that document's
`Event` schema, and 2.x events against `OpenCodeEvent` of
`@opencode/protocol` 2.1.2; every test asserts it recorded no mismatch. The 15
conformance scenarios run against both generations, with the driver starting
the server and with an external one.

## Limits

- The driver resolves a thread's directory on the machine it runs on; a
  directory only an external server can see is passed as given.
- OpenCode 2.x before 2.2.6 loads a new MCP server's tools about 100 ms after
  it connects; a prompt sent sooner may not see them.
- A 2.x steer that joins an execution just as it ends may stay in OpenCode's
  inbox until the next prompt.
- The CLI manifest has no fork launch (2.x has no `--fork` flag) and no MCP
  injection (OpenCode's `mcp` config is not the `mcpServers` shape
  `ari/cli-manifests` writes).
