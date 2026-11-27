# Native recordings

A native recording is what a real agent did, captured at the boundary
between an ARI driver and the vendor's SDK or server. A person makes it by
hand with a recorder, against the real agent and their own sign-in. The
normal test suite and CI then replay it through the driver, with no
credentials.

This is one layer below the ARI replay recorder in `ari/host`, which records
ARI events. These documents call this one a "native recording" to keep the
two apart.

The kit lives in `test/recordings/`:

| File | What |
|---|---|
| `format.ts` | the format, the loader and the writer |
| `scenarios.ts` | the six scenarios, the scenario runner and the scenario checks |
| `sanitiser.ts` | the one sanitiser every recorder uses |
| `sequencer.ts` | the replay sequencer, which knows no transport |
| `recovery.ts` | the recovery file where both recorders keep a refreshed sign-in that cannot go back |
| `resanitise.ts` | runs a committed recording through the sanitiser again, after a fix to the sanitiser |
| `credential-file.ts` | copies a sign-in an agent keeps in one file into the recorded agent's profile, and puts a refreshed copy back, under the agent's own write lock when it has one |
| `claude/` | the Claude tap, the replay SDK, and the recording and replay functions |
| `opencode/` | the OpenCode recording proxy, the replay server, the sign-in copy, `opencode serve`, and the recording and replay functions |
| `stdio/` | the process tap and the replay process service, for every driver that starts its agent through `HostServices.process` and talks to it on stdin and stdout |
| `acp/` | the ACP protocol words and the approval answers read off ACP traffic |
| `antigravity/` | the Antigravity layout and model choice, the sign-in file, and the recording and replay functions |
| `codex/` | the Codex protocol words, the approval answers and turns read off app-server traffic, the Codex layout, the sign-in file, the model choice, and the recording and replay functions |
| `protocol-places.ts` | protocol words by place: where the pinned types put a string literal in an inbound frame |

`scripts/record-claude.ts` is the Claude recorder, `scripts/record-opencode.ts`
the OpenCode recorder, `scripts/record-antigravity.ts` the Antigravity
recorder and `scripts/record-codex.ts` the Codex recorder. `scripts/check-recordings.ts` is the scan the gate runs.
`scripts/resanitise-recordings.ts` sanitises committed recordings again.
Nothing here ships in the npm tarball.

The live recordings are in `test/drivers/claude/recordings/` and
`test/drivers/opencode/recordings/`, one file per scenario. The Antigravity
recorder writes to `test/drivers/antigravity/recordings/`, the Codex recorder
to `test/drivers/codex/recordings/`. The gate replays
them: `test/drivers/claude/live-recordings.test.ts` and
`test/drivers/opencode/live-recordings.suite.ts` take the list of files from
the scenario module, check each header (`source: live`, the vendor version
the pinned SDK runs or OpenCode 2.1.2, the model) and replay each through a
fresh driver with every scenario assertion. A missing recording fails them.
They also check that the sanitiser, run again with no machine's HOME, PATH
or user name, has nothing left to replace in any frame, and that every field
the account-detail rules cover holds its neutral value (see "Account
details"). So a sanitiser rule added later fails them until the recordings
are sanitised again.

## The format

A recording is NDJSON: UTF-8 text, one JSON object per line, every line
ending in `\n`. Line 1 is the header. Every later line is one frame, in the
order the frames happened.

The body is every byte after the header line's newline. The header's
`sha256` is the hex SHA-256 of the body. The recorder writes it. The loader
refuses a recording whose body does not match it, so a recording is never
edited by hand. When a recording and the driver disagree, fix the driver or
the fake, or record again.

### Format versions

`format` is `major.minor`, now `1.0`.

- A higher minor only adds fields or frame kinds that older readers may
  ignore. The loader reads any `1.x`.
- A higher major changes what existing fields mean. The loader refuses it,
  and the error names both versions.

The loader also refuses a malformed line (not JSON, not an object, no `dir`
or `kind`, or empty), naming the file and the line number.

### Header fields

| Field | What |
|---|---|
| `type` | always `header` |
| `format` | the format version, `major.minor` |
| `driver` | the ARI driver kind, for example `claude`, `opencode` or `antigravity` |
| `vendor` | the agent, for example `claude-code`, `opencode` or `antigravity-cli` |
| `vendorVersion` | the agent's version: for Claude, the `claude_code_version` of Claude Code's `system`/`init` message, else the version the SDK package bundles; for OpenCode, the version the server's `GET /api/info` names; for Antigravity, the version `agy --version` prints |
| `sdk` | the package the driver talks through, for example `@anthropic-ai/claude-agent-sdk` or `@opencode/client`; for Antigravity, which speaks ACP on stdio with no package between, `acp` |
| `sdkVersion` | that package's version; for `acp`, the ACP schema release the driver's types come from (`schema-v2.0.0-beta.3`) |
| `model` | the model the recorder asked for: for Claude, for example `haiku`; for OpenCode, a `provider/model` id the server offers; for Antigravity, the id of a value of the agent's model option |
| `scenario` | the scenario's name |
| `recorded` | the day of the recording, `YYYY-MM-DD` |
| `source` | `live` for a real agent, `fake` for a test fake |
| `sha256` | the hex SHA-256 of the body |

### Frames

Every frame has `dir` and `kind`. `dir` is `out` for traffic from the driver
to the native side and `in` for traffic from the native side to the driver.
The other fields depend on the kind.

### Claude frames

The Claude tap records the traffic between the ARI Claude driver and the
Claude Agent SDK module it loads. Query ids are `q1`, `q2`, ... in the order
the driver called `query()`. Call ids count every call, control calls and
session functions alike, from 1.

| Dir | Kind | Fields | What |
|---|---|---|---|
| out | `query` | `query`, `prompt`, `options` | the driver called `query()`. `prompt` is `stream` (an async iterable of prompts) or `{ text }`. `options` are the query options; functions show as `<function>` and the abort controller as `<AbortController>`. |
| out | `prompt` | `query`, `message` | the driver's prompt stream yielded one `SDKUserMessage` |
| out | `call` | `id`, `query`, `method`, `args` | the driver called a `Query` control method (`query` names the query) or an SDK session function (`query` is `null`). `close` has no result. |
| in | `result` | `id`, `value` or `error` | what that call returned (no `value` for `undefined`), or the error it threw (`{ name, message }`) |
| in | `message` | `query`, `message` | the query's stream yielded one `SDKMessage` |
| in | `end` | `query` | the query's stream ended |
| in | `error` | `query`, `error` | the query's stream threw |
| in | `can_use_tool` | `id`, `query`, `toolName`, `input`, `options` | Claude Code called the driver's `canUseTool`. `options` leave out the abort signal. Ids are `p1`, `p2`, ... |
| in | `can_use_tool_abort` | `id`, `query` | Claude Code aborted that call's signal before the driver answered |
| out | `permission` | `id`, `query`, `result` or `error` | the driver's answer to `canUseTool` |
| in | `stderr` | `query`, `data` | Claude Code wrote `data` to its stderr, and the SDK passed it to the driver's `stderr` callback |

An outbound frame is recorded when the driver makes the call. A prompt is
recorded when the driver writes it: the tap and the replay SDK both read the
driver's prompt stream as fast as the driver writes it. An inbound frame is
recorded when the driver receives it.

### OpenCode frames

The OpenCode recording proxy (`test/recordings/opencode/proxy.ts`) records the
HTTP traffic between the ARI OpenCode driver, in external-server mode, and an
OpenCode 2.x server. Every frame names its exchange by `id`: 1, 2, ... in the
order the driver's requests reached the proxy. Request headers are never
recorded: the server password travels in one.

| Dir | Kind | Fields | What |
|---|---|---|---|
| out | `request` | `id`, `method`, `path`, `query`, `body` or `text` | the driver sent a request. `query` is the URL's query parameters as an object (a repeated name holds the list of its values). `body` is the request body when it is JSON, `text` when it is not; neither for an empty body. |
| in | `response` | `id`, `status`, `contentType`, `body` or `text`, `stream` | the server answered the request: its status, its Content-Type header and its body. For an event stream (`GET /api/event`, Content-Type `text/event-stream`) `stream` is `true` and the events follow as frames of their own. |
| in | `event` | `id`, `event` or `data` | the server sent one server-sent event on that stream: `event` is its data as JSON, `data` the raw text when it is not JSON. A comment or keepalive with no data is passed on but not recorded. |
| in | `end` | `id` | the server ended that stream |
| out | `close` | `id` | the driver closed the connection before its answer ended. The driver stops reading its event stream when its session closes, so every recording ends with one. |
| in | `dropped` | `id` | the server closed the connection without an answer |

OpenCode 2.1.2 compresses a large answer, such as the model list of
`GET /api/model`, when the client accepts it (`Content-Encoding: gzip`). The
proxy decompresses a gzip, deflate or br body, records the body the driver's
client would read, and passes that body on without the encoding. A body in
another encoding is passed on as a `dropped` connection.

A request is recorded once its body has arrived. A response or an event is
recorded just before the proxy passes it to the driver, and an event that
arrives after the driver closed its stream is not recorded, because it never
reached the driver. The proxy splits the event stream into events the way
`@opencode/client` 2.1.2 reads it (`promise/generated/client.ts` `sse`).

The proxy and the replay server build a request's frame with the same
function (`requestFrame` in `test/recordings/opencode/frames.ts`). Before it
opens a second session (the `resume` scenario), the host waits until the
server has seen the first session's event stream close. The driver closes
that stream as the session closes and opens the next session at once, on
another connection, so without the wait the server could see the next
request before the close, and a replay could see them the other way round.

### Stdio frames

The process tap (`test/recordings/stdio/tap.ts`) wraps the `HostServices.process`
the recorder hands a driver that starts its agent as a process and talks to it
on stdin and stdout (the Antigravity and Codex drivers; later the other ACP
flavors). It records the traffic between the driver and every
process the driver starts, and knows nothing of the protocol on the pipes.
Every frame names its process by `proc`: 1, 2, ... in the order the driver
asked the host to spawn them.

| Dir | Kind | Fields | What |
|---|---|---|---|
| out | `spawn` | `proc`, `command`, `args`, `envNames`, `cwd`, `purpose`, `stdin`, `timeoutMs` | the driver asked the host to start a process. `envNames` are the names of the variables the request adds, sorted; their values are never recorded. `cwd`, `purpose`, `stdin` and `timeoutMs` are there when the request has them. |
| in | `spawn_failed` | `proc`, `error` | the host could not start it: `error` is `{ message, code }` |
| out | `stdin` | `proc`, `message` or `text`, `newline` | the driver wrote one line to the process's stdin: `message` is the line parsed when it is JSON, `text` the line as written when it is not. `newline: false` marks text the driver wrote after its last line feed before it closed stdin. |
| out | `close_stdin` | `proc` | the driver closed the process's stdin |
| out | `kill` | `proc`, `signal` | the driver asked the host to end the process (`signal` when it named one) |
| in | `stdout` | `proc`, `message` or `text`, `newline` | one line of the process's stdout, as `stdin` |
| in | `stderr` | `proc`, `text`, `newline` | one line of the process's stderr, always as text |
| in | `exit` | `proc`, `code`, `signal` | the process exited |

A spawn, a write, a close and a kill are recorded when the driver makes them.
A stdout or stderr line is recorded when the driver's reader takes the chunk
that holds it, so a line the driver never reads is not recorded. The exit is
recorded when the process exits; the process may exit before the driver has
read its last lines, so a recording can hold a line of a process after its
exit. Lines are split on line feeds only; a line keeps a carriage return
before its line feed. A line is kept as parsed JSON, so replay compares JSON
values, not bytes.

`resolveExecutable` and the host's `envPolicy` pass through the tap
unrecorded. The recorder's own `agy --version` and `codex --version` for the
header, and the Codex recorder's model listing, go around the tap.

## The scenarios

`test/recordings/scenarios.ts` defines six scenarios for every driver. Each
gives its prompts, its runtime policy, what the host does, and what the ARI
events must show. Every scenario's events must pass `EventGrammar` in strict
mode. All six run under the `approval_required` mode.

| Scenario | The host | The events must show |
|---|---|---|
| `simple` | sends one prompt | exactly one `turn.terminal`, `completed`, and a settled assistant message with text |
| `multi_turn` | sends two prompts on one thread | both turns `completed`, in order; the second turn's text holds the word the first prompt gave |
| `approval_allowed` | allows the command once | a `command` request reaches the host; the allow-once answer is a recorded outbound frame; a command or tool item completes; the turn completes |
| `approval_denied` | declines the command | the same request; the decline is a recorded outbound frame; no completed command or tool item's output holds the marker; the turn ends |

The host answers a request with its `decline` option. An agent that offers
none, only a decline that also stops the turn (`cancel`), gets that one:
Codex's ordinary command approval offers `accept` and `cancel` only
(`codex-rs/protocol/src/approvals.rs:379–411` at tag `rust-v0.172.0`), and a
`cancel` answer counts as the decline in the check.
| `interrupt` | calls `interruptTurn` after the first assistant text | the turn ends `interrupted` |
| `resume` | closes the session after one turn, then resumes the thread by its native handle in a new session | the second turn completes with no `session.replaced`, and its text holds the word the first prompt gave |

The approval command builds its marker with `printf`, so only the command's
output can hold the marker, never the command text. There are no snapshot
files of ARI events. A driver change that keeps the behaviour needs no new
recording.

## Replay

Replay runs the recording's scenario through a fresh driver against a replay
of the native side. For Claude that is the replay SDK
(`test/recordings/claude/replay-sdk.ts`). It has the module shape of the
pinned SDK for the parts the driver loads and imports no driver code and no
fake. The workspace is laid out as the recorder lays it out, and the driver
gets the same fixed id sequence.

For OpenCode it is the replay server (`test/recordings/opencode/replay-server.ts`),
an HTTP server on a loopback port that the driver gets as its `serverUrl`. It
imports no driver code and no fake. Each request the driver makes becomes a
`request` frame, and a connection the driver closes before its answer ended
becomes a `close` frame. The server writes the recorded responses, events,
stream ends and dropped connections one at a time, each after the one before
it was flushed to the driver's connection, so the driver receives them in the
recorded order. A request that drifts gets a 500 answer whose text is the
drift.

The sequencer walks the recording in order:

- each outbound frame the driver sends must equal the next recorded frame,
  apart from the fields listed below;
- each inbound frame is delivered once every frame before it has happened.

Replay fails, naming the recording file, the line and both frames, when:

- the driver sends a frame other than the next recorded one (the message also
  names the first field that differs);
- the driver sends a frame after the last recorded one;
- the scenario ends while recorded frames remain;
- the scenario ends while a recorded inbound frame was never taken by the
  driver (see below);
- the scenario waits too long for something (a recorded inbound frame is
  missing, for example). The message names the next recorded frame and the
  last frame replayed. Every wait counts: an event, a call into the driver,
  and the host's answers and interrupt settling.

An inbound frame counts as replayed only once the driver has taken it, not
when the sequencer hands it to the replay SDK. For Claude: a message, the end
or the error of a stream when the driver's `next()` returns it; a call's
result when the driver's call settles with it; a `canUseTool` call, an abort
or a `stderr` line when the driver's callback runs. A stream gives nothing
after its end, so a recording with an extra end or message, or a driver that
starts a query and never reads it, fails. After the scenario, replay waits
until the driver has taken every delivered frame, or has taken none for half
a second.

For a stdio driver: a stdout or stderr line when the driver's reader takes it
off the child's pipe; the exit and a failed spawn when the child's `exited`
settles, or the spawn rejects. So a recorded line the driver never reads
fails replay.

For OpenCode: a response, an event, the end of a stream or a dropped
connection when the replay server has written it to a connection the driver
still holds open. Nothing reaches a connection the driver closed, so an event
or an end recorded after the driver's `close` of its stream, or a response
to a request the driver gave up, fails. After the scenario, replay first waits
until the driver's event streams have closed, or 5 seconds.

For a stdio driver it is the replay process service
(`test/recordings/stdio/replay-process.ts`), the `HostServices.process` the
driver gets. It imports no driver code and no fake. Its `spawn` starts
nothing: it answers with a child that plays the recording back. Each spawn
request, each line the driver writes, each stdin close and each kill becomes a
frame and goes to the sequencer; a frame other than the recorded one fails the
call with the drift. Each recorded stdout and stderr line goes to the child's
pipe, and the exit settles the child's `exited`. A pipe ends once the exit
came and the last line recorded for that pipe was handed over, wherever the
recording holds it. A process may exit before the driver read its last
output, and a driver that drains a pipe apart from waiting for the exit (the
ACP driver drains stderr that way) may start the next process before it
takes the first one's last line; the tap records that order, and replay
plays it. A driver that waits for a pipe's end before it sends the next
frame, when the recording holds a line for that pipe after that frame, waits
until the scenario reports a stall; the stall names each pipe held open and
the line it waits for. A kill returns once the
recorded exit came, as a host's kill returns once the process is gone. When
replay fails, every child ends at once (exit by `SIGKILL`, pipes closed after
what they hold), so the driver's cleanup is not left waiting; the failure is
what replay reports. `resolveExecutable` finds every executable.

Before it compares, replay runs the driver's frame through the sanitiser with
its own workspace, `$HOME` and `PATH`. Before it delivers, it puts its own
workspace where the recording says `<WORKSPACE>`.

### What replay detects, and what it does not

Replay checks the driver against the recording. It is not a tamper detector.
The header's `sha256` guards a recording against edits: the loader refuses a
file whose frames do not match it, so an edit fails unless the checksum is
computed again.

Replay detects:

- an outbound frame that is changed, skipped, extra or out of order: the
  sequencer compares each one with the next recorded frame;
- an extra recorded inbound frame the driver cannot take: an event or an end
  after the driver closed its stream, or a response to a request the driver
  gave up;
- a removed inbound frame the scenario's outcome depends on. The run then
  waits for something that never comes and stalls, or the driver sends a
  frame the recording does not expect, or a scenario assertion fails. For
  example, without the event that ends the turn the turn never ends; without
  the result of the approved command, `approval_allowed` finds no marker in
  the command's output; without Claude Code's result of the declined command,
  `approval_denied` sees that command complete. For Antigravity: without the
  ACP response to `session/prompt` the turn never ends; without the
  `tool_call_update` that completes the approved command, its output never
  reaches the host; without the one that fails the declined command, the
  command shows as completed when the turn ends. For Codex: without the
  `turn/completed` notification the turn never ends; without the frames that
  carry the approved command's output (`item/commandExecution/outputDelta`
  and its `item/completed`), no completed command holds the marker; a
  declined command's `item/completed` that says `completed` with the marker
  fails `approval_denied`. When every recorded frame
  was replayed and a scenario assertion still fails, the Antigravity replay's
  error names the recording file, the recorded frame the outcome depended on,
  whose line leads the error, and the frame replayed last
  (`ReplaySequencer.checkFailed`). Every assertion of the six scenarios
  carries the turns it looks at, and the items of them where it looks at
  items (`ScenarioCheckError`). The frame it depended on is the last recorded
  inbound frame holding the native id of such an item (for the commands
  above, their last `tool_call_update` or permission request). Else it is, for
  each turn the assertion looks at, the ACP response that ended the turn,
  labelled with the line of the turn's `session/prompt` request
  (`acpTurnsDependedOn`): for a reply removed from `simple`, `depended on
  (line 13, the response that ended turn 1, requested at line 11)`. A failure
  the checks did not attribute counts as one about every turn.

  One case names no recorded frame: a turn the assertion looks at whose
  `session/prompt` request the recording does not hold. No assertion of the
  six scenarios reaches it. Each looks at turns of the scenario's prompts;
  the scenario runner starts a turn for every prompt or fails before any
  assertion runs; a started turn's prompt request is an outbound frame
  replay matched; and a replay that did not match every recorded frame fails
  before any assertion runs too.
  If it happened, the error would say `depended on: no recorded frame of what
  the check looked at` and name the frame replayed last.

Replay does not detect:

- a removed, duplicated or reordered inbound frame the driver reads and
  ignores, or that changes nothing the scenario checks. In the fake
  recordings, OpenCode's `session.inbox.enqueued`, `session.step.started` or
  one `session.text.delta` can go (`session.text.ended` carries the whole
  text), and so can one of Claude Code's `content_block_delta` stream events;
- a change to inbound content the scenario's assertions do not look at, such
  as the text of a `session.text.delta`;
- whether the driver read an HTTP frame. A response, an event or an end counts
  as taken once the replay server has written and flushed it to a connection
  the driver still holds open, the same standard as a Claude stream item that
  the driver's `next()` returned.
- whether the driver awaited a process's exit. The exit counts as taken when
  the replay child's `exited` settles.
- a stdout or stderr line added right after its process's exit, which the
  driver reads to the end of the pipe and ignores.
- for Codex, a removed `item/completed` of a command whose output was
  streamed: the driver settles every item still open as `completed` when the
  turn completes, with the output streamed so far, so the outcome is the
  same.

The Codex replay names the frames a failed assertion depended on as the
Antigravity replay does: the last recorded inbound frame holding the native id
of an item it looked at, else, for each turn, the `turn/completed` that ended
it, labelled with the line of the turn's `turn/start` request
(`codexTurnsDependedOn`): `depended on (line 25, the turn/completed that ended
turn 1, started at line 13)`. When an app-server's stdin request and its
answer are appended after its exit, Codex replay reports both as not replayed:
the Codex driver does not wait for an app-server's stdout to end when it
closes a session.

## Fields replay ignores

Frame comparison leaves out only these fields. `test/recordings/docs.test.ts`
checks this table against the code's list. OpenCode replay leaves out no
field: the driver builds every request from the scenario, its config and what
the server answered, so a replay sends the same requests byte for byte, and a
recording holds no request headers. Antigravity replay leaves out only the ARI
version in the driver's ACP `initialize` request (`clientInfo.version`), and
Codex replay only the ARI version in the driver's app-server `initialize`
request.

| Driver | Frame kind | Field | Reason |
|---|---|---|---|
| claude | `query` | `options.env.CLAUDE_AGENT_SDK_CLIENT_APP` | the driver sets it to ari/ followed by the ARI version, which changes with every ARI release |
| claude | `query` | `options.env.ANTHROPIC_API_KEY` | present only when the recorder ran with ANTHROPIC_API_KEY set; a replay has no key, and a recording holds only its placeholder |
| claude | `query` | `options.pathToClaudeCodeExecutable` | the path of the user's claude, which differs between machines (a replay names /ari-replay/claude); recordings made before the driver ran the user's Claude Code have none |
| claude | `query` | `options.mcpServersDelivery` | the driver sets it to initialize on every query since it runs the user's Claude Code; recordings made before then have none, and test/drivers/claude/availability.test.ts checks every query sets it |
| antigravity | `stdin` | `message.params.clientInfo.version` | the driver's ACP initialize request names the ARI version, which changes with every ARI release |
| codex | `stdin` | `message.params.clientInfo.version` | the driver's initialize request names the ARI version, which changes with every ARI release |

## Sanitising and the scan

The repository is public, so every recorder sanitises each frame before it
writes. All recorders use one sanitiser, `test/recordings/sanitiser.ts`. It
replaces, in every string and object key (a frame's own format fields, `dir`,
`kind`, `query`, `id`, `method` and `contentType`, stay as the recorder wrote
them when they hold a string, a number, a boolean or null; an OpenCode
request's `query` is an object of the request's query parameters, and is
sanitised like any other value; a Claude `can_use_tool` frame's `toolName` is
the agent's tool name, and is sanitised like its `input`):

| What | Placeholder |
|---|---|
| the recording's temp workspace, and its real path | `<WORKSPACE>` |
| a string that is exactly the value of `PATH` | `<PATH>` |
| `$HOME`, and its real path | `<HOME>` |
| the values of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` | `<ANTHROPIC_API_KEY>`, `<ANTHROPIC_AUTH_TOKEN>`, `<CLAUDE_CODE_OAUTH_TOKEN>` |
| the value of every other variable of the recorder's environment whose name ends in `_KEY`, `_TOKEN`, `_SECRET` or `_PASSWORD`, when it is 8 characters or more | `<NAME>`, for example `<GEMINI_API_KEY>` |
| the OS user name (`os.userInfo().username`, and the values of `USER` and `LOGNAME` where they differ; under Bun, whose `os.userInfo()` says `unknown` when `USER` and `LOGNAME` are not set, the name `/etc/passwd` gives the user's id, else the name of the home directory the user owns): in an inbound frame wherever it is a whole word, except in a protocol word at its place; in an outbound frame and in object keys where it is a whole segment of a path | `<USER>` |
| email addresses | `<EMAIL>` |
| the string value under a key that names an account or organisation id (compared without case, `-` or `_`: a key ending in `accountid` or `accountuuid`, or in `orgid`, `organizationid`, `organisationid` or their `uuid` forms), in both directions. OpenCode 2.1.2's model list carries the user's ChatGPT account id (`chatgpt-account-id`) and OpenCode organisation id (`x-opencode-org-id`) as request headers of their models | `<ACCOUNT_ID>`, `<ORG_ID>` |
| another home directory: `/home/<name>`, `/Users/<name>`, `/root` | `<OTHER_HOME>` |
| a token the scan looks for | `<TOKEN>` |

Exact values go first, longest first, so a path inside the workspace is
replaced whole.

### Account details

The repository is public, and a recording must not describe the user's
accounts or machine, even where a value is no id or secret. So the
sanitiser also replaces these, in both directions, with fixed neutral
values of the same type, so a driver still parses them. Each rule is keyed
on the field: the key is compared without case, `-` or `_`, and a value of
another type than the rule's stays as it is. The code is
`NEUTRAL_FIELD_RULES` in `test/recordings/sanitiser.ts`.

| What | Key | Neutral value |
|---|---|---|
| the plan name: Claude Code's `subscriptionType` in `initializationResult().account` ("Claude Max"); the plan tier the Antigravity CLI 1.5.17 names `userTier`, `userTierId` or `tierName` (in its binary) | `subscriptionType`, `subscriptionPlan`, `subscriptionTier`, `planName`, `planType`, `planTier`, `rateLimitTier`, `userTier`, `userTierId`, `tierName` (a string) | `<PLAN>` |
| a rate-limit report: Claude Code's `rate_limit_event` with its status, window, utilization, reset times, threshold and overage state | `rate_limit_info` (an object), replaced whole | `{"status":"allowed","rateLimitType":"five_hour","utilization":0,"resetsAt":4102444800}` |
| a credential's expiry time: Claude Code's `credential_expires_at` in result messages | a key ending in `expires`, `expiresAt`, `expiry`, `expiration` or `expirationTime` after `credential`, `token`, `oauth`, `auth` or `login` | `2100-01-01T00:00:00.000Z` for a string; `4102444800000` for a number of milliseconds, `4102444800` for seconds |
| a native process id: Claude Code's `initializationResult().pid`, OpenCode's `GET /api/info` `pid` | `pid`, `ppid`, `processId` (a number) | `1000` (the OpenCode driver checks only that it is a number) |
| a temp directory that shows the machine's session layout: OpenCode's `GET /api/info` `paths.tmp` | `tmp`, `tmpDir`, `temp`, `tempDir`, `tmpPath`, `tempPath` (a string) | `/tmp/ari-recording` |
| a socket path: Claude Code's `messaging_socket_path`, `/tmp/cc-socks/<pid>.sock` | a key ending in `socketPath` or `socketFile` (a string) | `/tmp/ari-recording/agent.sock` |
| the machine's shell: OpenCode's `shell.created` event | `shell`, when the string is a path | `/bin/sh` |
| a quota's figures: the Antigravity CLI 1.5.17 binary's quota bucket fields `remainingFraction` and `remainingAmount` | `remainingFraction`, `remainingAmount`, `usedFraction`, `usedAmount`, `consumedFraction`, `consumedAmount` (a number, or a number written as a string) | `0`, or `"0"` |
| a quota's or a rate limit's reset time: the binary's `resetTime` | `resetTime`, `resetsTime`, `resetAt`, `resetsAt`, `quotaResetTime`, `quotaResetAt` | as a credential's expiry time |
| a credit balance: the binary's `usedPromptCredits`, `availableFlowCredits`, `monthlyPromptCredits`, `consumedCredits`, `availableCredits` | a key ending in `credits` (a number, or a number written as a string) | `0`, or `"0"` |
| whether the user is signed in to a provider: the binary's `isAuthenticated` | `signedIn`, `isSignedIn`, `loggedIn`, `isLoggedIn`, `authenticated`, `isAuthenticated` (a boolean) | `true` |
| whether a provider still needs the user to sign in: the binary's `needs_auth` | `needsAuth`, `needsSignIn`, `needsLogin` (a boolean) | `false` |
| Codex's rate-limit windows: a rate-limit snapshot's (`RateLimitSnapshot`, in `account/rateLimits/updated` and `account/rateLimits/read`) `primary` and `secondary` `RateLimitWindow`, with its used percentage, window length and reset time | `primary`, `secondary` (an object with a number `usedPercent`), replaced whole | `{"usedPercent":0,"windowDurationMins":300,"resetsAt":4102444800}` and `{"usedPercent":0,"windowDurationMins":10080,"resetsAt":4102444800}`: the driver names them `5h` and `weekly` |
| Codex's credit balance: a rate-limit snapshot's `credits` (`CreditsSnapshot`) | `credits` (an object with a boolean `hasCredits`), replaced whole | `{"hasCredits":false,"unlimited":false,"balance":"0"}` |
| Codex's spend-control limit: a rate-limit snapshot's `individualLimit` (`SpendControlLimitSnapshot`) | `individualLimit` (an object with a number `remainingPercent`), replaced whole | `{"limit":"0","remainingPercent":0,"resetsAt":4102444800,"used":"0"}` |
| Codex's rate-limit reset credits: `rateLimitResetCredits` (`RateLimitResetCreditsSummary`) of a usage read | `rateLimitResetCredits` (an object with a number `availableCount`), replaced whole | `{"availableCount":0,"credits":[]}` |
| any other usage percentage | `usedPercent`, `remainingPercent` (a number) | `0` |
| whether the account reached a limit: Codex's `rateLimitReachedType` and `spendControlReached` | `rateLimitReachedType` (a string), `spendControlReached` (a boolean) | `null`, `false` |
| the client's machine in a user agent: Codex's `initialize` answer names the operating system, its version, the architecture and the terminal after the product (`codex_cli_rs/0.172.0 (<system>; x86_64) <terminal>`) | `userAgent` (a string with a space) | the product and its version alone, `codex_cli_rs/0.172.0` |
| the Codex remote-control host and installation | inbound `remoteControl/status/changed` parameters `serverName` and `installationId` (strings) | `<SERVER_NAME>` and `<INSTALLATION_ID>` |
| a Codex project identifier | `projectId` (a nonempty string on an inbound Codex `Thread`) | `<PROJECT_ID>` |
| native Codex token counts | `contentTokenCount`, and the counts under `tokenUsage.total` and `tokenUsage.last` (numbers) | `0`; `modelContextWindow` still describes the model |
| a numeric process identifier serialized as a string, as in Codex command execution | `pid`, `ppid`, `processId` | `"1000"` |

Codex's plan type (`planType`, in a rate-limit snapshot and in
`account/updated`) is a plan name, `<PLAN>`, by the first rule. The Codex
driver reads none of these but the windows and the credit balance, which it
turns into a `limits.updated` event.

The driver also reads the neutral turn token counts as usage events.

Three more account details have a shape rather than one field:

- which providers the user is signed in to: a list whose every entry is an
  object holding one of the sign-in status keys above becomes `[]`, the
  provider the recording used included;
- ACP's usage report: a `usage_update` session update (`UsageUpdate`) gets
  `used` and `size` 0, the tokens in context and the context window;
- ACP's cost and token counts: a `Cost` under `cost` (an object with a number
  `amount` and a string `currency`) gets `amount` 0, and a `Usage` under
  `usage` (with numbers `totalTokens`, `inputTokens` and `outputTokens`, the
  unstable usage of a prompt's result) gets every token count 0.

These shapes are ACP's: Claude Code's turn usage (`input_tokens` and the other
snake-case counts) and OpenCode's cost of a message (a number under `cost`)
stay as they are.

With the recording's model (`recordedModel`, the header's `model`), a model
list keeps only that model, so which providers and models the user's
accounts offer stays out:

- OpenCode 2.x's `GET /api/model` answer (an array of objects with a string
  `providerID` and `modelID`) keeps the recorded `provider/model` alone, and
  of it only the fields the OpenCode driver reads: `providerID`, `modelID`,
  `name`, `enabled` and `limit.context`. The answer listed every model of
  every provider the user is signed in to, with each provider's setup
  (base URLs, request headers, service tiers).
- Claude Code's `initializationResult().models` (objects with a string
  `value` and `resolvedModel`) keeps the entry of the recorded alias whole.
  The list showed which models the user's plan offers and which is its
  default. The Claude driver does not read it.
- An ACP agent's model picker, a session config option of category `model`
  (as `agy acp` offers in `session/new`, `session/resume` and
  `session/set_config_option` answers and `config_option_update` updates),
  keeps among its `options` only the recorded model and the option's
  `currentValue`, and in a group of options the same members; a group left
  empty goes. The driver compares the current value with the model the host
  asks for before it sends `session/set_config_option`, so the current value
  stays as recorded, and replay sends the same frames.

The OpenCode driver keeps the context windows of the models it read, so with
the recorded model in the list it asks for the list once per run, as it did
live. Without `recordedModel` a model list stays whole.

The recorded OpenCode server inherits the recorder's environment, and a tool
it runs can print it; Claude Code gets only `PATH`, but a tool can still print
a value it finds elsewhere. So the sanitiser replaces the value of every
variable whose name ends in `_KEY`, `_TOKEN`, `_SECRET` or `_PASSWORD`, in
inbound and outbound frames alike. A shorter value stays, because it would
match ordinary text. The scan cannot see these values: it runs without the
recorder's environment.

How the user name goes depends on what the string is:

- **Inbound frames** hold what the agent and the machine produced: tool
  output (`tool_use_result.stdout`), assistant text, `stderr`, file contents.
  There every whole-word occurrence of each user name is replaced in every
  string value, so the owner column of an `ls -l` loses it. A whole word is
  one not next to a letter, a digit or an underscore. The one exception is a
  value that is one of the protocol words of its key at its place (below):
  an account named `user` keeps Claude Code's `type: "user"`,
  `role: "user"` and `apiKeySource: "user"` where the SDK's types put them,
  which the driver reads and replay needs, and an account named `text`
  keeps OpenCode's `type: "session.text.delta"`. The same word in a value
  the pinned types do not describe is free text: on an account named
  `memory`, `running` or `unknown`, an opaque `tool_use_result` (the SDK
  types it `unknown`) loses `name: "memory"`, `status: "running"` and
  `error: "unknown"`, though the SDK allows each of them for that key
  elsewhere.
- **Outbound frames** hold what the driver sent, built from the scenario
  module and the host's config. There, and in every object key, the name is
  replaced only where it is a whole segment of a path: a string part that
  starts with `/`, `\`, `~` or a drive letter, as in `/srv/<name>/x`,
  `C:\Users\<name>` or `~<name>/x`. A prompt or option the driver sends is
  then the same on every account, so a recording made on one account replays
  byte-for-byte on another. `test/drivers/claude/replay.test.ts` records on
  accounts named `user` and `root` and replays on the other;
  `test/drivers/opencode/recordings.suite.ts` does the same on accounts named
  `user` and `text`.

Known limit: an outbound frame that carries inbound text back, such as a
`permission` answer with `updatedInput` or `updatedPermissions` copied from
the request, gets only the path rule. A user name in that text as a free word
would stay. The six scenarios send no such answer.

### Protocol words by place

A protocol word keeps the user name only where the pinned types put it: the
same key and word anywhere else is free text. `test/recordings/protocol-places.ts`
holds each kit's words by place. A place is one spot of an inbound frame the
pinned types describe (the set of object types a value there can have),
named by the first path of keys that reaches it from the frame: the empty
name is the frame, `message` its `message`, `message.params` that message's `params`,
and so on; an array's elements share the array's place. For each key of an
object at a place, the table lists the words the types allow as the key's
string value there and the place of the key's object value; `*` stands for
the keys a type declares by an index signature or `additionalProperties`. A
value with no place (a type of `unknown`, `any` or `object`, or JSON Schema
`true`) is opaque, and nothing below it is a protocol word.

The object types at a place are alternatives, and their words are not pooled
where the types say which one an object is. When every type at a place
requires one key whose value is a string literal, and the literals tell the
types apart (a discriminant, such as a content block's `type`), that key's
slot lists `variants`: for each literal, the place of the types that allow
it. An object there takes its keys' slots from the variant its own value of
that key names, and so on down (an SDK message's `subtype` below its
`type`). An object whose value names no variant is opaque. So on an account
named `web_search`, a `tool_use` block's `name: "web_search"` becomes
`<USER>`, because the pinned `BetaToolUseBlock.name` is a plain string. A
`server_tool_use` block's keeps the word, because `BetaServerToolUseBlock.name`
allows that literal (`@anthropic-ai/sdk` 1.12.0,
`resources/beta/messages/messages.d.ts:5219–5225, 6195–6199`); `web_fetch`
the same. The sanitiser walks each inbound frame and the table together. Each kit derives its table
from its pinned sources with `placeProtocolWords`, breadth first with keys
sorted, so the same sources give the same table;
`test/recordings/protocol-words.test.ts` fails when a committed table and its
derivation differ.

### Claude protocol words

`test/recordings/claude/protocol-words.ts` holds, by place, the string
literals the pinned SDK's types allow in an inbound Claude frame.
`test/recordings/claude/derive-protocol-words.ts` derives them with the
TypeScript checker from `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
(0.3.330) and the `@anthropic-ai/sdk` types it imports. Its roots are the
fields of an inbound frame: a `message` frame's `message` is `SDKMessage`; a
`result` frame's `value` is the return type of a `Query` method or SDK
function the driver calls; a `can_use_tool` frame's `options` are the options
`CanUseTool` receives. A `can_use_tool` frame's `toolName` and `input` are a
string and a `Record<string, unknown>` there, so they hold no protocol word.
The walk follows every property, union member, array element and index
signature, and stops at `unknown`: a user message's `tool_use_result` and a
session message's `message` are opaque. After an SDK bump, run
`node test/recordings/claude/derive-protocol-words.ts` and put the result in
the file.

A value is kept only when it is one of its key's words at its place:
`type: "user"` of an SDK message stays, but `error: "permission denied for
<name>"` loses the name, because that `error`'s words are its enum values
(`authentication_failed`, `rate_limit`, `unknown`, ...). The 52 keys holding
words are `allowed_callers`, `apiKeySource`, `apiProvider`, `behavior`, `category`, `compact_result`, `costBasis`, `destination`, `direction`, `effort`, `error`, `errorCode`, `error_code`, `fast_mode_disabled_reason`, `fast_mode_state`, `file_type`, `first_stream_post_queued_behind`, `first_text_post_queued_behind`, `fromMode`, `kind`, `level`, `limitScope`, `lost`, `media_type`, `mode`, `model`, `name`, `outcome`, `overageDisabledReason`, `overageStatus`, `oversized_image`, `permissionMode`, `priority`, `rateLimitType`, `reason`, `response_inclusion`, `role`, `scope`, `service_tier`, `speed`, `startup_failure_reason`, `state`, `status`, `stop_reason`, `subkind`, `subtype`, `supportedEffortLevels`, `terminal_reason`, `trigger`, `ttl`, `type`, `view_mode`.

### ACP protocol words

`test/recordings/acp/protocol-words.ts` holds, by place, the string values
the vendored ACP schemas allow in an inbound ACP stdio frame.
`test/recordings/acp/derive-protocol-words.ts` derives them from
`vendor-schemas/acp/schema-v2.0.0-beta.3/`, the release the ACP drivers are
built on. Its root is a `stdout` frame's `message`: in
`v1/schema.unstable.json` and `v2/schema.unstable.json`, the `Agent` message
(every request, response and notification an agent sends) and the
`ProtocolLevel` message (`$/cancel_request`). The walk follows every `$ref`,
`allOf`, `anyOf`, `oneOf`, property, array item and additional property, and
takes each `const` and `enum`; an agent's `_meta` is opaque. A JSON-RPC
message's `method` holds a method name rather than a schema literal, so the
message's `method` gets the `clientMethods` and `protocolMethods` of each
version's `meta.unstable.json`: the methods an agent sends. After a schema
bump, run `node test/recordings/acp/derive-protocol-words.ts` and put the
result in the file.

The 20 keys holding words are `apiType`, `audience`, `category`, `fileType`, `format`, `jsonrpc`, `kind`, `method`, `mode`, `operation`, `position`, `priority`, `sessionUpdate`, `severity`, `state`, `status`, `stopReason`, `supported`, `theme`, `type`.

### OpenCode protocol words

`test/recordings/opencode/protocol-words.ts` holds, by place, the string
literals the pinned client's types allow in an inbound OpenCode frame.
`test/recordings/opencode/derive-protocol-words.ts` derives them with the
TypeScript checker from `node_modules/@opencode/client/dist/promise/index.d.ts`
(2.1.2) and the generated types it exports. Its roots are the fields of an
inbound frame: an `event` frame's `event` is `OpenCodeEvent` (every event of
`GET /api/event`); a `response` frame's `body` is `ServerInfo` (the driver
reads `GET /api/info` itself), the awaited return type of every client call
the driver makes (each method of `V2Client` in `src/drivers/opencode/sdk.ts`,
looked up by the same path in the client), or an error body the client
declares (each exported type with a `_tag`). The walk follows every property,
union member, array element and index signature, and stops at `unknown`.
After a client bump, or when the driver calls another client method, run
`node test/recordings/opencode/derive-protocol-words.ts` and put the result in
the file.

The 20 keys holding words are `_tag`, `cacheFormat`, `command`, `delivery`, `effect`, `encoding`, `event`, `exit`, `finish`, `format`, `maxTokensField`, `name`, `op`, `outcome`, `reason`, `reasoningField`, `reply`, `status`, `type`, `variant`.

### Codex protocol words

`test/recordings/codex/protocol-words.ts` holds, by place, the string values
the vendored Codex app-server schema allows in an inbound Codex stdio frame.
`test/recordings/codex/derive-protocol-words.ts` derives them from
`vendor-schemas/codex/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex_app_server_protocol.schemas.json`
(Codex tag `rust-v0.172.0`, the schema the driver's client is generated
from). Its root is a `stdout` frame's `message`, which is what
`codex app-server` writes: a server request (every variant of
`ServerRequest`), a notification (every variant of `ServerNotification`), an
error answer (`JSONRPCError`), or the answer to one of the requests the
driver sends (`CLIENT_REQUESTS` of `scripts/codegen-codex.ts`), `{ id,
result }` with that request's response type: `<X>Response` for params
`<X>Params`, except where the schema's `hand-written-additions.json` names
another, as the codegen reads it. The walk follows every `$ref`, `allOf`,
`anyOf`, `oneOf`, property, array item and additional property, and takes
each `const` and `enum`. After a schema bump, or when the driver sends
another request, run `node test/recordings/codex/derive-protocol-words.ts`
and put the result in the file.

The 60 keys holding words are `access`, `accountRoutingOverride`, `action`, `activeFlags`, `approvalPolicy`, `approvalsReviewer`, `authMode`, `authStatus`, `availableDecisions`, `changeType`, `codexErrorInfo`, `cyber`, `daybreakAvailability`, `decisionSource`, `delivery`, `detail`, `eventName`, `executionMode`, `failureReason`, `format`, `handlerType`, `historyMode`, `inputModalities`, `itemType`, `itemsView`, `kind`, `match_type`, `method`, `mode`, `multiAgentMode`, `multiAgentVersion`, `networkAccess`, `onboardingEntrypoint`, `operation`, `outcome`, `personality`, `phase`, `planType`, `preferredModelDisplayMode`, `protocol`, `rateLimitReachedType`, `reason`, `resetType`, `riskLevel`, `role`, `runtimeStatus`, `scope`, `source`, `status`, `stream`, `subAgent`, `subject`, `summary`, `tool`, `trustedContacts`, `turnKind`, `type`, `userAuthorization`, `verifications`, `version`.

`pnpm run check:recordings` (`scripts/check-recordings.ts`) is a step of both
`gate` and `gate:bun`. It scans every file under `test/drivers/*/recordings/`,
each line as written and, when the line is JSON, every string and key it
decodes to. So a `$HOME` holding a quote or a backslash, which JSON escapes,
is still found. It fails, naming the file, the line and the rule but never
the matched text, on:

- a path starting `/home/`, `/Users/` or `/root/`;
- a path starting with the scanning machine's `$HOME`;
- an email address;
- `sk-ant-`, `sk-` followed by 20 or more letters and digits, `gh[pousr]_`,
  `xox[baprs]-`, `AKIA` followed by 16 capitals and digits, or `Bearer `
  followed by 20 or more token characters.

A path counts only where it starts: at the start of a line, or after a
character that cannot be part of a path segment. So `/var/home/x` is not a
path starting `/home/`, but `"/home/x"` and `file:///home/x` are. The token
patterns match anywhere in a line.

The scan does not look for the scanning machine's OS user name as a word. It
runs on every machine that runs the gate, and that name is not the recording
machine's: CI runs as `runner`, a container often as `root`, and a laptop's
account may be `user`. Recorded model text holds such words as ordinary
English ("the user asked", "the root cause"), so a word check would fail
recordings that hold no personal data. The recorder replaces the recording
machine's own names before it writes, and
`test/drivers/claude/recorder.test.ts` shows a real `ls -ld .` listing, free
assistant text and a `stderr` line lose the name.

When a recording holds something personal the sanitiser missed, fix the
sanitiser, then run `node scripts/resanitise-recordings.ts <file> ...` on the
machine and account that recorded it. It reads each recording with the loader,
runs every frame through the sanitiser again, and writes it with the
recorder's writer, which computes the checksum again; the header stays as it
was. The frames already hold placeholders, so a recording with nothing new to
replace comes out byte-identical. Never edit a recording by hand.

Known limit: Claude Code streams text in chunks, and each chunk is its own
`message` frame. A value split across two chunks matches neither the
sanitiser nor the scan. The whole text also arrives in the `assistant`
message, which both check. Personal data outside the list above is out of
scope for the scan.

## How the Claude recorder keeps the user's setup out

The recorded session must not load the user's settings, hooks, plugins,
agents, MCP servers or `CLAUDE.md`, and must not change those files. Each
scenario runs in its own temp workspace: `cwd/` (the thread's directory),
`claude-home/`, `claude-config/` and `instances/` (the host's directories). The
driver hands Claude Code only this environment:

| Variable | Value | Why |
|---|---|---|
| `PATH` | the recorder's `PATH` | Claude Code needs its shell and tools |
| `HOME` | `<workspace>/claude-home`, empty | no shell profile or other home file of the user's |
| `CLAUDE_CONFIG_DIR` | `<workspace>/claude-config` | Claude Code keeps its settings, session history, plugins and global config file under this directory, so it never reads `~/.claude` or `~/.claude.json` |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1` | no auto memory |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | `false` | no claude.ai MCP connectors |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | no auto-update, telemetry or error reports; it also stops feature-flag fetching, so Claude Code does not sync the skills and plugins enabled for the user's claude.ai account ("Features that need feature-flag fetching") |

The driver config is `settingSources: []` and the recorder's `model`. The
host gives the thread no tool server, so the session has no MCP server at
all. The driver itself strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
`CLAUDE_CODE_OAUTH_TOKEN` from the environment.

The sources for these choices (Claude Code and Agent SDK docs, read
2026-11-24, and the pinned SDK 0.3.330):

- `settingSources: []` disables user, project and local settings, and with
  them `CLAUDE.md`, rules, skills, agents, commands and settings hooks
  (Agent SDK TypeScript reference, `Options.settingSources`;
  "Use Claude Code features", "Control filesystem settings with
  settingSources").
- `settingSources` does not cover the global `~/.claude.json` config, which
  holds the user's MCP servers: it is "always read", and `CLAUDE_CONFIG_DIR`
  in `env` relocates it. Auto memory and claude.ai connectors also load
  regardless ("What settingSources does not control").
- `CLAUDE_CONFIG_DIR`: "All settings, session history, and plugins are stored
  under this path" (Environment variables reference).
- Managed settings load in all cases, and neither the temp HOME nor
  `CLAUDE_CONFIG_DIR` keeps them out. The recorder does not isolate them; a
  machine with any of them records under them. The sources, from
  "Deploy managed settings" (read 2026-11-24), "Where each mechanism stores
  the policy":
  - server-managed settings, which Claude Code fetches for an organization
    account from the claude.ai admin console or a Claude apps gateway;
  - the macOS configuration profile in the `com.anthropic.claudecode`
    managed preferences domain;
  - the Windows registry value `Settings` under
    `HKLM\SOFTWARE\Policies\ClaudeCode`, and under
    `HKCU\SOFTWARE\Policies\ClaudeCode`;
  - `managed-settings.json`, a `managed-settings.d/` directory and
    `managed-mcp.json` in the system directory:
    `/Library/Application Support/ClaudeCode/` on macOS,
    `/etc/claude-code/` on Linux and WSL, `C:\Program Files\ClaudeCode\` on
    Windows.

### How Claude Code finds the sign-in

- On Linux, Claude Code keeps the claude.ai sign-in in
  `~/.claude/.credentials.json`, or in `$CLAUDE_CONFIG_DIR/.credentials.json`
  when that variable is set (Authentication, "Credential management"). The
  recorder copies that file from the user's Claude config directory (the
  recorder's own `$CLAUDE_CONFIG_DIR`, else `~/.claude`) into
  `<workspace>/claude-config/`, with mode 0600. It reads no other file there.
- Claude Code may refresh the token during a run and rewrite the copy. After
  each scenario, also one that fails, the recorder writes a changed copy back
  to the user's file, under Claude Code's own write lock (below), so a
  rotated token is never lost. When the user's file also changed meanwhile,
  the recorder leaves it as it is and reports the scenario failed.
- **Claude Code's write lock.** Claude Code 2.1.330, the pinned SDK's
  `claude-agent-sdk-linux-x64` (read with `strings` from the native binary),
  writes its secure storage, `.credentials.json` on Linux, only through the
  storage's `mutate`: no code calls its unlocked `update`. The installed CLIs
  2.1.251, 2.1.278 and 2.1.319 take the same lock in the same call. `mutate`
  holds a lock on `<config dir>/.storage-write` with `{ realpath: false,
  retries: { retries: 10, minTimeout: 100, maxTimeout: 1000 }, stale: 15000
  }` from a bundled lock module that has proper-lockfile's API (`lock`,
  `lockSync`, `check`) and its error messages ("Lock file is already being
  held", "Unable to update lock within the stale threshold"). Claude Code's
  own code calls it "the lock directory", and the storage module names
  `.storage-write.lock`. proper-lockfile 4.1.2 (`lib/lockfile.js`) takes
  such a lock by creating the directory `<file>.lock` with `mkdir`, takes a
  lock whose directory's mtime is older than `stale` for abandoned and
  removes it, and removes its own when done.
- Under that lock Claude Code saves a refreshed claude.ai sign-in as a
  compare-and-swap ("OAuth refresh CAS save"): only when the stored
  `refreshToken` is still the one the session refreshed with; otherwise it
  keeps the stored sign-in. It writes a staging file and renames it over
  `.credentials.json`, so the file is never missing.
- So the recorder's copy-back (`test/recordings/credential-file.ts` with
  `claudeCredentialLock` from `test/recordings/claude/record.ts`) creates
  `<config dir>/.storage-write.lock` with `mkdir` before it reads the user's
  file, and removes it after it renamed the refreshed copy over the file. A
  Claude Code session that saves meanwhile waits for it, then finds a refresh
  token it did not use and keeps the recorder's. One that saved first changed
  the file, which the copy-back then leaves alone while it keeps its own
  refresh in the recovery file. The copy-back never breaks the lock: when
  another holder keeps it for 30 s, it writes nothing back and keeps the
  refreshed sign-in in the recovery file. `scripts/live-claude-standalone.ts`
  uses the same copy-back.
- What the lock leaves open: Claude Code breaks a lock whose directory is
  15 s old, and the copy-back does not refresh the directory's mtime. It
  holds the lock for four synchronous operations on a file of about a
  kilobyte (read, stat, write the staged copy, rename), so only a recorder
  process stopped for 15 s inside them could lose its lock. A Claude Code
  session that then saved would be overwritten, because a rename cannot be
  made conditional on what the file holds, and Node has no
  `renameat2(RENAME_EXCHANGE)`. A program that writes `.credentials.json`
  without the lock races the copy-back within the same four operations; no
  Claude Code version above does.
- Whenever a refreshed copy cannot go back (that case, or a file the
  recorder cannot read or replace), the recorder adds it to the run's
  recovery file beside the user's file,
  `.credentials.json.ari-recorder-refreshed-<pid>.json`, mode 0600. The file
  holds one record, `{ "id": ".credentials.json", "value" }`, whose `value`
  is the refreshed file's whole text, with `olderValues` when a later
  scenario kept a newer one. The recorder reads the file and adds to it,
  never truncates it, never overwrites a file it cannot read as one, and
  replaces it only by renaming a complete new file over it. Each scenario's
  error names the file, and so do the run's last lines. The OpenCode recorder
  keeps its recovery file the same way (`test/recordings/recovery.ts`).
- When the recovery file cannot take the value either, the workspace's copy
  holds the only copy. The recorder then keeps that workspace, stops the run,
  and names the workspace and the copy in the error and in the run's last
  lines.
- With `ANTHROPIC_API_KEY` set, the recorder gives the key to the driver
  instance as its own key (a managed profile), and the driver passes it to
  Claude Code. The sanitiser replaces its value.
- On macOS, Claude Code keeps the sign-in in the Keychain and keys the entry
  to the config directory, so a session with another `CLAUDE_CONFIG_DIR`
  reads another entry (Authentication, "Credential management"). There, record
  with `ANTHROPIC_API_KEY`, or with a `.credentials.json` that Claude Code
  wrote when the Keychain refused the write.
- `CLAUDE_CODE_OAUTH_TOKEN` does not work here: the driver strips it.
- With neither a credential file nor `ANTHROPIC_API_KEY`, a live recording
  stops before it starts Claude Code.

The SDK's session functions (`getSessionInfo`, `getSessionMessages`, ...)
run in the recorder's own process. They read the config directory from that
process's `CLAUDE_CONFIG_DIR` on every call: in `sdk.mjs` of 0.3.330 the
directory is `Vt`, memoised on `process.env.CLAUDE_CONFIG_DIR`. So the
recorder points its own `CLAUDE_CONFIG_DIR` at the isolated directory while a
scenario runs, and puts it back afterwards.

The workspace, with the copied credential, is removed after each scenario,
also after one that fails, unless it holds the only copy of a refreshed
sign-in.

### Ids

The driver picks the session id of each thread and the uuid of each prompt
through `createClaudeDriver({ newUuid })`. The recorder and the replay both
use the same fixed sequence (`a11ce000-0000-4000-8000-000000000001`, ...), so
the ids the driver sends match.

## How the OpenCode recorder keeps the user's setup out

The recorded server must not load the user's OpenCode config, plugins,
agents, MCP servers, instructions or skills, and must not change those
files. The recorder starts its own `opencode serve --hostname 127.0.0.1
--port 0` for each scenario, in its own temp workspace: `cwd/` (the thread's
directory, and the server's), `opencode-home/`, `xdg-config/`, `xdg-data/`,
`xdg-state/`, `xdg-cache/` and `instances/` (the host's directories). The
server runs with the recorder's environment, less `HOME`, the XDG base
directories and every `OPENCODE_*` variable, plus:

| Variable | Value | Why |
|---|---|---|
| `HOME` | `<workspace>/opencode-home`, empty | OpenCode reads `~/.claude` and `~/.agents` from HOME (`packages/core/src/config/discovery.ts:69-70`), and finds its global directories under it when no XDG directory is set |
| `XDG_CONFIG_HOME` | `<workspace>/xdg-config` | its global config directory, `$XDG_CONFIG_HOME/opencode`, with `opencode.json`, plugins, agents and the rest (`packages/util/src/global-roots.ts:7`) |
| `XDG_DATA_HOME` | `<workspace>/xdg-data` | its data directory, `$XDG_DATA_HOME/opencode`: the database with sessions, saved permission grants and sign-ins (`packages/util/src/global-roots.ts:5`) |
| `XDG_STATE_HOME` | `<workspace>/xdg-state` | its state directory |
| `XDG_CACHE_HOME` | `<workspace>/xdg-cache` | its cache directory, with plugins it installs |
| `OPENCODE_PASSWORD` | a random password per scenario | the server's password (`packages/cli/src/env.ts:10`); the driver gets it as the instance secret `opencode/server-password`, and the proxy passes the header on without recording it |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | `1` | no project config: without it OpenCode reads `opencode.json`, `.opencode/`, `.claude/` and `.agents/` in the session's directory and every directory above it (`packages/core/src/config/discovery.ts:80-85`, `packages/cli/src/server-process.ts:124`) |
| `OPENCODE_DISABLE_CLAUDE_CODE` | `1` | no `.claude` directories (`packages/cli/src/server-process.ts:128`) |

Leaving out every `OPENCODE_*` variable of the user's drops `OPENCODE_CONFIG`,
`OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG_CONTENT` (more config,
`packages/cli/src/server-process.ts`, `packages/util/src/global.ts:79`),
`OPENCODE_DB` (another database, `packages/cli/src/database-path.ts:6`) and
`OPENCODE_TEST_HOME` (another home, `packages/util/src/global.ts:17`). `PATH` and
the provider keys OpenCode reads from the environment (such as
`ANTHROPIC_API_KEY`) pass through. A provider that reads its sign-in from a
file in the user's home (such as `~/.aws`) does not find it; set its key in
the environment instead. The host gives the thread no tool server, so the
session has no MCP server at all.

The sources are OpenCode's own code at tag `v2.1.2` (commit
`a517687fde98a7329ada3ae644a01a9fc6c4e99e` of
https://github.com/anomalyco/opencode), read 2026-11-24.

Two system sources load in all cases, and neither the temp HOME nor the XDG
directories keep them out. The recorder does not isolate them; a machine with
either records under them:

- the system config directory, with its `opencode.json` or `opencode.jsonc`
  and the rest of a config directory: `/etc/opencode` on Linux,
  `/Library/Application Support/opencode` on macOS,
  `%ProgramData%\opencode` on Windows (`packages/core/src/config/discovery.ts:27-32`).
  The server sets no option that skips it (`packages/cli/src/server-process.ts:121-133`);
- on macOS, the managed preferences that MDM deploys:
  `/Library/Managed Preferences/<user>/ai.opencode.managed.plist`, else
  `/Library/Managed Preferences/ai.opencode.managed.plist`
  (`packages/core/src/config/discovery.ts:34-40,110-117`).

### How OpenCode finds the sign-in

OpenCode 2.1.2 has no credential file of its own. It keeps every provider
sign-in (API keys and OAuth tokens) as a row of the `credential` table in its
database, the file `opencode.db` in its data directory
(`$XDG_DATA_HOME/opencode/opencode.db`, else
`~/.local/share/opencode/opencode.db`; `OPENCODE_DB` names another file). That
is the credential file the recorder copies into the temp data directory. The
server opens it at `packages/cli/src/server-process.ts:114`,
`path: databasePath(global.data),`; `packages/cli/src/database-path.ts:4-13`
names the file, and `packages/core/src/credential.ts:89-104` reads its rows
(`db.select().from(CredentialTable)`). The
legacy `auth.json` in the same directory is read only by a migration of an
existing database (`packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts:39`),
never by a new one: `packages/core/src/database/migration.ts:29-46` creates a
new database with every migration marked done. Copying it would sign nothing
in.

- The same file holds the user's sessions, saved permission grants and the
  rest of OpenCode's state, and it grows with every session: a long-used one
  can be tens of gigabytes. So the recorder copies only what OpenCode needs
  to open it and sign in. In one read transaction on a read-only connection
  it reads the schema (every table and index, from `sqlite_master`), the
  `user_version`, and the rows of `credential` and the migration journals
  (`migration`, `__drizzle_migrations`), and no row of any other table. It
  writes them into a new database,
  `<workspace>/xdg-data/opencode/opencode.db`, mode 0600, whose other tables
  are empty. A read-only connection to a database in WAL mode leaves an
  empty `opencode.db-wal` and `opencode.db-shm` beside the user's file, as
  any reader does; the file itself is unchanged.
- OpenCode may refresh an OAuth token during a run and write the new value to
  the copy (`packages/core/src/integration.ts:739`,
  `credentials.update(credential.id, { value })`). After each scenario, also
  one that fails, the recorder writes each credential whose value changed in
  the copy back to the user's database, so a rotated token is never lost.
  When the user's row also changed meanwhile, the recorder leaves it as it is
  and reports the scenario failed.
- Whenever a refreshed value cannot go back (that case, or a database the
  recorder cannot write), the recorder adds it to the run's recovery file
  beside the user's database, `opencode.db.ari-recorder-refreshed-<pid>.json`,
  mode 0600. The file holds one record per credential row, `{ "id", "value" }`,
  with `olderValues` when a later scenario kept a newer value for the same row.
  The recorder reads the file and adds to it, never truncates it, and replaces
  it only by renaming a complete new file over it. Each scenario's error names
  the file, and so do the run's last lines.
- When the recovery file cannot take the value either, the workspace's copy of
  the database holds the only copy. The recorder then keeps that workspace,
  stops the run, and names the workspace and the copy in the error and in the
  run's last lines.
- Without a database of the user's, the recorder copies nothing; provider keys
  in the environment still work.

The workspace, with the copied database, is removed after each scenario, also
after one that fails, unless it holds the only copy of a refreshed sign-in.

### The model

OpenCode's models depend on the user's providers, so there is no default. The
recorder needs `ARI_RECORD_OPENCODE_MODEL`, a `provider/model` id. Before the
first prompt it asks the server (`GET /api/model`, straight to the server and
not recorded) which models it offers; when the variable is missing or names a
model the server does not offer, it stops, lists them, and records nothing.

## How the Antigravity recorder keeps the user's setup out

The recorded `agy acp` must not load the user's Antigravity settings, rules,
instructions, skills, plugins, hooks or MCP servers, must not reach the
user's keyring, and must not change any of them. The recorder runs each
scenario in its own temp workspace: `cwd/` (the thread's directory, and the
directory `agy` runs in), `agy-home/`, `xdg-config/`, `xdg-data/`,
`xdg-state/`, `xdg-cache/`, `xdg-runtime/`, `tmp/` and `instances/` (the
host's directories; the driver keeps the instance's Antigravity profile in
`instances/antigravity-recorder/state/profile`). The driver starts
`agy acp --gemini-dir <profile> --app-data-dir antigravity-acp` with
`AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` and `AGY_CLI_DISABLE_AUTO_UPDATE=true`
(docs/drivers/antigravity.md). The recorder's host starts it with the
recorder's own environment, less `HOME`, `TMPDIR`, `DBUS_SESSION_BUS_ADDRESS`
and every `XDG_*` variable, and strips every variable whose name starts with
`GEMINI_`, `GOOGLE_`, `GCLOUD_`, `CLOUDSDK_` or `AGY_` (the prefixes of the
driver's CLI manifest), then adds these, the driver's own last:

| Variable | Value | Why |
|---|---|---|
| `HOME` | `<workspace>/agy-home`, empty | `agy` reads the user's customizations from `~/.gemini/config/`, `~/.gemini/AGENTS.md`, `~/.gemini/GEMINI.md` and `~/.gemini/skills/`, its settings and skills from `~/.gemini/antigravity-cli/` ("Customization discovery", "Settings"), and `--gemini-dir` defaults to `.gemini` in the home directory (`agy acp --help`) |
| `XDG_CONFIG_HOME` | `<workspace>/xdg-config` | `agy` keeps plugin secrets in `~/.config/antigravity` |
| `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | `<workspace>/xdg-data`, `xdg-state`, `xdg-cache` | the other XDG base directories |
| `XDG_RUNTIME_DIR` | `<workspace>/xdg-runtime` | the user's runtime directory holds their session bus and keyring sockets |
| `TMPDIR` | `<workspace>/tmp` | so a temp path `agy` reports is inside the workspace, and becomes `<WORKSPACE>` |
| `DBUS_SESSION_BUS_ADDRESS` | `unix:path=<workspace>/no-session-bus`, where nothing listens | D-Bus clients find the session bus at this address (D-Bus Specification, "Well-known Message Bus Instances"); with it unreachable, `agy` cannot reach the Secret Service keyring and keeps its sign-in in its file storage (see "How Antigravity finds the sign-in") |
| `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` | `1`, from the driver | `agy` 1.5.16 and later use the profile file instead of the shared keyring when this is set. On Linux an unreachable keyring also causes file fallback (docs/drivers/antigravity.md, "A profile per instance"); the recorder keeps the session bus unreachable as a second guard |

A process the driver starts with no working directory (the driver names none
for `agy acp`) starts in `<workspace>/cwd`, not in the recorder's directory:
Antigravity loads workspace rules and customizations, `.agents/`, `AGENTS.md`
and `GEMINI.md`, from the folder it works in and from each parent folder up to
the root of its repository, such as the folder that holds `.git`; outside a
repository it checks only the folder it works in ("Customization discovery",
"Workspace folders and parent directories"). A repository's root can also
name a personal folder in `.gemini/config.json`. So `<workspace>/cwd` is the
root of a Git repository of its own (`cwd/.git` holds `HEAD`, `objects/` and
`refs/`, which Git looks for), and `agy` reads none of the workspace's
parents, wherever `TMPDIR` points. The recorder also stops before it starts
`agy` when its temp workspace lies inside the user's home (a `TMPDIR` in the
home), or when a folder above the workspace holds `AGENTS.md`, `GEMINI.md` or
`.agents/`; the error names each one it found. Then a lookup that goes further
than the docs say finds nothing of the user's either. The host gives the
thread no tool server, so the session has no MCP server at all.
`test/drivers/antigravity/recorder.suite.ts` seeds a home with each of these
files and a marker in each, records all six scenarios against a fake `agy`
that loads them the way the docs say, and shows none reached the recording and
every file is unchanged. It also records with `TMPDIR` in a Git project beside
the home: with `AGENTS.md`, `GEMINI.md` and `.agents/` at the project's root
the recorder stops before it starts `agy`; with a personal folder the
project's `.gemini/config.json` names, `agy` loads nothing of it.

After each scenario, before it removes the workspace, the recorder prints
what `agy` logged anywhere in the workspace about where it keeps the sign-in:
each distinct "Using file-based token storage because ..." or "Failed to load
stored token from keyring, falling back to file ..." line of its `*.log`
files, for example `simple: agy's log on where it keeps the sign-in: Using
file-based token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set`,
or that it logged none. That line shows a live run kept the keyring out by
the driver's variable, not only by the unreachable bus.

The sources are Antigravity's docs, read 2026-11-25: "Customization
discovery" (https://antigravity.google/docs/customization-discovery),
"Settings" (https://antigravity.google/docs/settings), "MCP"
(https://antigravity.google/docs/mcp), "Other editors (ACP)"
(https://antigravity.google/docs/ide/extensions/acp) and "Authenticate"
(https://antigravity.google/docs/install), and `agy acp --help` of `agy`
1.5.17.

Not isolated: an organization's managed admin settings, which Antigravity's
release notes mention (`pluginsDisabled` and the other admin controls of a
Gemini Enterprise organization); a machine whose account has them records
under them.

### How Antigravity finds the sign-in

- `agy` 1.5.x keeps a Google sign-in in the operating system's keyring (Apple
  Keychain, the Secret Service over D-Bus on Linux, Windows Credential
  Manager), under service `gemini` and account `antigravity`, and in a file
  only when the keyring is bypassed or unreachable, or when
  `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` is set (1.5.16 logs "Using file-based
  token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set"; the sources
  are in docs/drivers/antigravity.md, "Sources"). Antigravity's
  "Authenticate" page, "Local silent keyring sign-in": "When launching `agy`
  on your local machine, the CLI attempts to access your operating system's
  native secure keyring". Its release notes (GitHub
  `google-antigravity/antigravity-cli`, read 2026-11-25) say it "falls back to
  file-based token storage" when the keyring is locked, saves the sign-in "to
  its file-based storage" after a keychain write fails, and goes "directly to
  file storage when keyring storage is bypassed or unreachable".
- The file is `antigravity-oauth-token` in `agy`'s app data directory,
  `<gemini dir>/<app data dir>`. For the user's own `agy` that is
  `~/.gemini/antigravity-cli/antigravity-oauth-token` (`--gemini-dir`
  defaults to `.gemini` and `--app-data-dir` to `antigravity-cli`, `agy acp
  --help`; the docs keep the CLI's settings in `~/.gemini/antigravity-cli/`).
  For the driver's `agy acp` it is
  `<profile>/antigravity-acp/antigravity-oauth-token`. Sources: T3 Code issue
  https://github.com/pingdotgg/t3code/issues/34327 (agy 1.5.12 with a Google
  sign-in in a profile launched with these arguments "stores the sign-in as
  `antigravity-acp/antigravity-oauth-token`", a JSON object
  `{ token: { access_token, refresh_token, expiry, ... }, auth_method }`; on a
  desktop the token went to the Secret Service item "Password for
  'antigravity' on 'gemini'" instead) and its fix
  https://github.com/pingdotgg/t3code/pull/38957 ("it keeps its Google sign-in
  in the OS keyring (service "gemini", account "antigravity") or, without a
  keyring, in antigravity-acp/antigravity-oauth-token"); the `agy` 1.5.17
  binary holds the name piece `-oauth-token` and the file storage's
  `NewFileTokenStorage`, `useFileIfKeyringWritesDisabled` and
  `shouldBypassKeyring` (read with `strings`, read-only, from its install
  directory).
- `AGY_ACP_FORCE_FILE_STORAGE` and `GEMINI_HOME`, which earlier releases of
  the driver set, do nothing in `agy` 1.5.x: the 1.5.15 and 1.5.17 binaries
  hold neither name, and the same T3 Code issue found
  `AGY_ACP_FORCE_FILE_STORAGE` missing from 1.5.7 to 1.5.12. The binaries
  hold `AGY_CLI_FORCE_FILE_TOKEN_STORAGE`, which the driver now sets.
- So the recorder copies only that one file: the user's
  `~/.gemini/antigravity-cli/antigravity-oauth-token` (`HOME` from the
  recorder's environment) into `<profile>/antigravity-acp/`, mode 0600 in a
  directory only the user can enter, and the driver's variable and the
  unreachable session bus keep `agy` off the keyring (the table above). It
  reads nothing else of the user's, and never the keyring.
- `agy` may refresh the token during a run and rewrite the copy. After each
  scenario, also one that fails, the recorder writes a changed copy back over
  the user's file, so a rotated token is never lost. When the user's file
  also changed meanwhile, or the recorder cannot write it, the recorder leaves
  it as it is, adds the refreshed content to the run's recovery file beside
  it, `antigravity-oauth-token.ari-recorder-refreshed-<pid>.json` (mode 0600;
  one record `{ "id": "antigravity-oauth-token", "value" }`, with
  `olderValues` when a later scenario kept a newer one), and reports the
  scenario failed. The Claude and OpenCode recorders keep their recovery
  files the same way (`test/recordings/recovery.ts`,
  `test/recordings/credential-file.ts`).
- Two recorder runs can share one sign-in: they run at once with the same
  `HOME`, and each `agy` refreshes its own copy. So the copy-back holds a
  lock of the recorder's own from before it compares the user's file until
  after it replaced it: an exclusive `flock(2)` lock on the folder that holds
  the file, `~/.gemini/antigravity-cli/`. Every Antigravity recorder run takes
  it, so another run cannot put its refresh back between this run's
  comparison and its replace. The run that comes second finds the file
  changed and keeps its refresh in its own recovery file. The folder's
  inode does not change when the file is replaced, the lock adds no file
  to the user's setup, and the kernel drops it when its holder exits, so it
  is never left stale. The recorder takes it through util-linux's `flock`
  command, as the Codex recorder takes Codex's locks (see "How Codex finds
  the sign-in", `test/recordings/flock.ts`). It waits up to 30 s for another
  run to let go and never breaks the lock. When `flock` cannot take it, or
  another run held it all that time, the refresh goes to the recovery file.
  An unchanged copy takes no lock.
- The window that remains: `agy` itself takes no such lock that anyone has
  found, so another `agy` that saves a refresh between the copy-back's
  comparison and its rename (a stat, a write of the staged copy and the
  rename) is overwritten. `test/drivers/antigravity/recorder.suite.ts` runs
  a second recorder run at the first run's comparison, with the same `HOME`;
  both refreshes survive. The Claude recorder's copy-back takes Claude
  Code's own lock (see "How Claude Code finds the sign-in").
- When the recovery file cannot take the value either, the workspace's copy
  holds the only copy. The recorder then keeps that workspace, stops the run,
  and names the workspace and the copy in the error and in the run's last
  lines.
- When the user keeps the sign-in only in the keyring, there is no file to
  copy: a live run stops before it starts `agy`, naming the file and the step
  below. The recorder never reads the keyring. To record, the user signs in
  once into that file:
  `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy acp --login --gemini-dir "$HOME/.gemini" --app-data-dir antigravity-cli`,
  then finishes the Google sign-in it opens. `--login` signs in, then exits
  ("Log in with Google interactively, then exit (ACP terminal auth)", `agy
  acp --help`); with the variable set, `agy` keeps that sign-in in
  `<gemini dir>/<app data dir>/antigravity-oauth-token` and leaves the
  keyring's sign-in as it is (T3 Code checked `acp --login` with the variable
  against 1.5.16; docs/drivers/antigravity.md, "Sources"). Google keeps up
  to 100 refresh tokens per Google Account and OAuth client, and a new one
  invalidates only the oldest beyond that ("Using OAuth 2.0 to Access Google
  APIs", "Refresh token expiration",
  https://developers.google.com/identity/protocols/oauth2#expiration), so a new OAuth grant can invalidate the oldest grant at the limit. The command
  does not itself clear or replace the keyring entry.
- On macOS and Windows the keyring is not on D-Bus, so the unreachable bus
  does not keep `agy` away from it there.

The workspace, with the copied sign-in, is removed after each scenario, also
after one that fails, unless it holds the only copy of a refreshed sign-in.

### The Antigravity model

`agy acp` offers its models as a session config option of category `model`,
"the models available to your account", beside a thinking level (Antigravity's
ACP guide, "Models and thinking level"), in its answers to `session/new` and
`session/resume`. The recorder records with the model
`ARI_RECORD_ANTIGRAVITY_MODEL` names, else with the first model the agent
offers whose id or name holds `Flash` (any case): Flash models are
Antigravity's smallest Gemini models ("Choose a model"). Before each turn the
host gives the turn that model as the value of the thread's model option, and
the driver sends `session/set_config_option` when the thread holds another.
When the variable names a model the agent does not offer, or it is not set
and the agent offers no Flash model, or the agent offers no model option, the
recorder stops before the first prompt and records nothing. Run
`ARI_LIVE_RECORD=1 node scripts/record-antigravity.ts --list-models` to list
model IDs in an isolated ACP session without sending any prompt.
`ARI_RECORD_ANTIGRAVITY_VERSION` can require an exact installed version.
Set `ARI_RECORD_ANTIGRAVITY_EFFORT` with an explicit model to set ACP's
`thought_level`. The recorder checks both applied values before prompting,
including after resuming. Replay uses the header model and the recorded
effort change, if any.

The live recorder denies all tool requests except the exact marker command
in `approval_allowed`, approved once. For `agy` 1.5.17 an implicit command
cwd needs an extra check: a private `tee` wrapper verifies the physical cwd
and filename before passing the marker to system `tee`.

## How the Codex recorder keeps the user's setup out

The recorded `codex app-server` must not load the user's Codex config, MCP
servers, plugins, memories, skills, rules, sessions, goals or `AGENTS.md`,
and must not change any of them. Codex keeps all of these in its home,
`CODEX_HOME`, else `~/.codex` (`codex-rs/utils/home-dir/src/lib.rs:13–60`):
`config.toml` with its `[mcp_servers]` and `[plugins]`
(`codex-rs/config/src/loader/local.rs:122`, `codex-rs/config/src/mcp_edit.rs:13–21`,
`codex-rs/core-plugins/src/loader.rs:722–760`), `managed_config.toml`
(`codex-rs/config/src/loader/layer_io.rs:232`), `AGENTS.md` and
`AGENTS.override.md` (`codex-rs/core/src/agents_md.rs:44–47`), `memories/`
and `memories_v2/` (`codex-rs/protocol/src/memory_version.rs:17–22`), `skills/`
(`codex-rs/ext/skills/src/host_roots.rs:151–157`), `rules/`
(`codex-rs/core/src/exec_policy.rs:966`), installed plugins under `plugins/`,
and the state database that keeps threads and their goals, `state_5.sqlite`
(`codex-rs/state/src/sqlite.rs:53`), in `CODEX_SQLITE_HOME` when set, else in
the home (`codex-rs/core/src/config/mod.rs:295–305, 4529–4540`). Outside the
home it reads skills in `~/.agents/skills`
(`codex-rs/ext/skills/src/host_roots.rs:159–165`), and, from the folder it
works in up to the project root, the nearest folder holding `.git`,
`AGENTS.md`, `AGENTS.override.md`, `.codex/` and `.agents/skills`; outside a
repository only the folder it works in (`codex-rs/core/src/agents_md.rs:7–18`,
`codex-rs/config/src/project_root_markers.rs:5`). All sources are files of
Codex tag `rust-v0.172.0` (commit `3d86e43b075adeba2193ec5c22ac92f55afd82e6`).

The recorder runs each scenario in its own temp workspace: `cwd/` (the
thread's directory, and the directory `codex` runs in), `codex-home/`,
`user-home/`, `xdg-config/`, `xdg-data/`, `xdg-state/`, `xdg-cache/`,
`xdg-runtime/`, `tmp/` and `instances/` (the host's directories). The driver
uses the ambient account, so it starts `codex app-server` and
`codex login status` with no variables of its own. The recorder's host starts
them with the recorder's own environment, less `HOME`, `TMPDIR`,
`DBUS_SESSION_BUS_ADDRESS` and every `XDG_*` variable,
strips every variable whose name starts with `CODEX_` or `OPENAI_`, and then
adds:

| Variable | Value | Why |
|---|---|---|
| `CODEX_HOME` | `<workspace>/codex-home`, holding the recorder's `config.toml` and the copy of the user's `auth.json` | Codex keeps the user's config, MCP servers, plugins, memories, skills, rules, sessions and goals in its home (above); added after the stripping, on every spawn |
| `HOME` | `<workspace>/user-home`, empty | Codex reads `~/.agents/skills`, and `~/.codex` without `CODEX_HOME` |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR` | `<workspace>/xdg-config`, `xdg-data`, `xdg-state`, `xdg-cache`, `xdg-runtime` | the XDG base directories |
| `TMPDIR` | `<workspace>/tmp` | so a temp path `codex` reports is inside the workspace |
| `DBUS_SESSION_BUS_ADDRESS` | `unix:path=<workspace>/no-session-bus`, where nothing listens | the Secret Service of the user's keyring is on the session bus; out of reach even if a setting the recorder does not control sends `codex` to the keyring |

The recorder's `config.toml` in `<workspace>/codex-home` holds only
`cli_auth_credentials_store = "file"` and `mcp_oauth_credentials_store = "file"`:
the recorded Codex keeps its CLI sign-in in `auth.json` and an MCP server's
OAuth credentials in `.credentials.json` there, never in the OS keyring
(`codex-rs/config/src/types.rs:136–166`). Without the second,
`mcp_oauth_credentials_store` is `auto`, which tries the keyring first.
Codex's MCP client on Linux reads the keyring through the kernel keyring as
well as the Secret Service (`keyring` with `linux-native-async-persistent`,
`codex-rs/rmcp-client/Cargo.toml:88`), so the session bus alone would not keep
it out.

Codex reads many `CODEX_` and `OPENAI_` variables: its home and state
database (`CODEX_HOME`, `CODEX_SQLITE_HOME`), sign-ins (`OPENAI_API_KEY`,
`CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENAI_IDENTITY_TOKEN_FILE`),
endpoints (`OPENAI_BASE_URL`, `CODEX_AUTHAPI_BASE_URL`) and more. The driver's
CLI manifest strips only `OPENAI_API_KEY`, `CODEX_API_KEY` and
`OPENAI_ADMIN_KEY`; the recorder strips them all
(`CODEX_RECORDER_ENV_POLICY` in `test/recordings/codex/run.ts`).

A process the driver starts with no working directory (the driver names none
for `codex app-server`) starts in `<workspace>/cwd`, not in the recorder's
directory. `<workspace>/cwd` is the root of a Git repository of its own
(`cwd/.git` holds `HEAD`, `objects/` and `refs/`), so Codex's lookup of
`AGENTS.md`, `.codex/` and `.agents/skills` stops there, wherever `TMPDIR`
points. The recorder also stops before it starts `codex` when its temp
workspace lies inside the user's home, or when a folder above the workspace
holds `AGENTS.md`, `AGENTS.override.md`, `.codex` or `.agents`; the error
names each one it found.

The driver passes the host's tool server for a thread in every
`thread/resume` (docs/drivers/codex.md, "Host instructions and tools"), and
fails the resume when the host has none. The recorder's host names
`ari-recorder-tools`, an HTTP MCP server at
`http://127.0.0.1:9/ari-recorder/no-tools`: on the loopback discard port
nothing listens on an ordinary machine, so Codex's connection is refused and
the session gets no tools. A new thread gets no MCP server at all. The server
carries the header `Authorization: Bearer none`, so Codex's MCP client looks
up no OAuth credentials for it, in the keyring or a file, before it tries to
connect. It skips that lookup for a server whose headers hold an
`Authorization` (`codex-rs/rmcp-client/src/rmcp_client.rs:1459–1470`, and
`auth_status.rs:161–164` for the server's sign-in status).

`test/drivers/codex/recorder.test.ts` seeds a home with a `config.toml` (with
an MCP entry and an enabled plugin), the plugin, a memory, `AGENTS.md`,
`AGENTS.override.md`, a skill, a rule, a stand-in for the state database and
`~/.agents/skills`, a marker in each, and sets `CODEX_HOME`,
`CODEX_SQLITE_HOME`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` and
`CODEX_ACCESS_TOKEN`. It records all six scenarios against a fake `codex`
(`test/drivers/codex/fake-codex-cli.ts`) that loads them where Codex does
(`test/drivers/codex/user-setup.ts`), and shows every `codex` started with
`CODEX_HOME`, `HOME`, the XDG directories, `TMPDIR`, the unreachable session
bus and its working directory in the workspace and no other `CODEX_` or
`OPENAI_` variable, that it loaded only the recorder's `config.toml`, that
none of the markers reached the recording, that every `thread/resume` named
the tool server with its `Authorization` header, and that every seeded file
is unchanged and nothing was added to the user's Codex home.

Not isolated: the machine's system configuration (`/etc/codex/config.toml`,
`/etc/codex/requirements.toml`, the legacy `/etc/codex/managed_config.toml`
that Linux and macOS still read, the system skills in `/etc/codex/skills`),
macOS managed preferences, and a ChatGPT enterprise workspace's
cloud-managed configuration (`codex-rs/config/src/loader/README.md`, "Layering
model"; `codex-rs/config/src/loader/layer_io.rs:22, 223–232` for
`managed_config.toml`). A machine or account that has them records under
them. Of these files the recorder reads one setting, the store of the CLI
sign-in, before it starts `codex` ("How Codex finds the sign-in").

### How Codex finds the sign-in

- Codex keeps a ChatGPT or API-key sign-in in `auth.json` in its home. At
  tag `rust-v0.172.0`, `codex-rs/login/src/auth/storage.rs:167–168` names the
  file, `pub(super) fn get_auth_file(codex_home: &Path) -> PathBuf {` and
  `codex_home.join("auth.json")`, and `FileAuthStorage::load` reads it
  (`storage.rs:263–271`, `let auth_file = get_auth_file(&self.codex_home);`). The home is `CODEX_HOME`, else `~/.codex`,
  so the user's file is `~/.codex/auth.json`, or `auth.json` in the
  `CODEX_HOME` of the recorder's environment. That is file storage, Codex's
  default when no configuration sets `cli_auth_credentials_store`
  (`codex-rs/config/src/types.rs:136–149`,
  `codex-rs/core/src/config/mod.rs:4792–4797`). With `keyring` or `auto`,
  Codex keeps the sign-in in the OS keyring (`auto` reads the file only when
  the keyring holds none or fails, `storage.rs:593–620`); with `ephemeral`,
  only in the memory of each process. An `auth.json` is then no proof that it
  holds the sign-in Codex uses.
- So before it starts `codex`, the recorder reads `cli_auth_credentials_store`,
  and nothing else, from the four files Codex 0.172.0 on Linux takes it from,
  the first that sets it winning (`test/recordings/codex/credential-store.ts`):
  `/etc/codex/requirements.toml`, a system requirement that overrides any
  `config.toml` (`codex-rs/config/src/loader/mod.rs:775–777`,
  `codex-rs/core/src/config/auth_keyring.rs:71–73`); the legacy
  `/etc/codex/managed_config.toml`, a config layer above all others
  (`loader/layer_io.rs:22, 223–232`, `loader/mod.rs:459–484`; its reading as
  requirements covers only `approval_policy`, `approvals_reviewer` and
  `sandbox_mode`, `loader/mod.rs:1000–1037`); the user's `config.toml` in the
  Codex home; and `/etc/codex/config.toml` (`loader/mod.rs:83, 275–292`). It
  reads only the key's top-level value, with a TOML reader of its own that
  reads strings, arrays and inline tables as TOML does, and never copies
  anything of those files into a recording. Unless the winner says `file`,
  or none sets the key, the run stops before it starts `codex`: the error
  names the setting, the file that set it, and what to do (set it to `file`
  or remove it, which a system file needs root for, then `codex login`). A
  file it cannot read, or whose text is no TOML it can read, stops the run
  too. It does not read macOS managed preferences, a `--profile` file or
  cloud-managed configuration (whose requirements cannot set the store,
  `codex-rs/config/src/requirements_layers/layer.rs:13–19`). A local
  development build of Codex (version 0.0.0) would take `keyring` and `auto`
  for `file` (`core/src/config/mod.rs:307–318`); the recorder stops anyway.
- So the recorder copies only that file, into `<workspace>/codex-home/auth.json`,
  mode 0600 in a directory only the user can enter, beside its own
  `config.toml` (`cli_auth_credentials_store = "file"`). The recorder reads
  nothing else of the user's, and never the keyring.
- A ChatGPT sign-in's refresh token rotates: Codex writes the refreshed
  tokens back to `auth.json`, as a new file renamed over the old one
  (`FileAuthStorage::save`, `storage.rs:274–295`). After each scenario, also
  one that fails, the recorder writes a changed copy back to the resolved
  credential target, leaving any symbolic links in place
  (`codex-rs/login/src/auth/storage_file.rs:10–32`). If the target changed,
  disappeared or cannot safely be replaced, the recorder leaves it alone.
  It adds the refreshed content to the run's recovery file beside the
  selected home's `auth.json` (not beside the target of a link),
  `auth.json.ari-recorder-refreshed-<pid>.json` (mode 0600; one record
  `{ "id": "auth.json", "value" }`, with `olderValues` when a later scenario
  kept a newer one), and reports the scenario failed
  (`test/recordings/codex/record.ts`, `test/recordings/recovery.ts`).
- Another `codex` of the user's may save its own refresh at the same time.
  Codex 0.172.0 commits a sign-in (a refresh, a login, a logout, a workspace
  switch) only while it holds an exclusive lock on `auth.lock` in its home,
  around the whole read, compare and write: `lock_for_write` opens the file
  read-write, creating it and never truncating it, and calls Rust's
  `File::lock` (`storage.rs:189–212`; taken at
  `login/src/auth/manager.rs:1023, 1090, 1261, 1768` and
  `manager/workspace_switching.rs:344`). It waits as long as another holder
  has it, and never removes the file. Inside `auth.lock`, Codex takes the
  resolved credential target's commit lock (`login/src/auth/storage_commit.rs:28–68`).
  It replaces the target's extension with `json.lock`, giving `auth.json.lock`
  for a target named `auth.json`. Two Codex homes linked to the same target
  have different home locks but share this commit lock. Network requests
  hold neither (`storage_commit.rs:1–2`). The recorder takes the same locks
  in that order and holds both across comparison and replacement. It waits
  up to 30 s for the home lock and 5 s for the commit lock. It never breaks the lock
  or removes either lock file. If either lock is unavailable, or the link no
  longer resolves to the target copied at the start, the refresh goes to recovery.
  The recorder also declines to replace hard-linked or read-only targets,
  as the pinned file store does (`storage_file.rs:34–59`). An unchanged copy
  takes no locks and adds no lock files.
- How the recorder takes those locks. On Linux, Rust's `File::lock` is
  `flock(2)`, a lock on the open file that the kernel drops when its holder
  closes the file or exits, so it is never left stale. Checked with rustc
  1.97.1: while a program holding `File::lock` ran, `flock -n` on the same
  file was refused and a POSIX `lockf` on it was granted (they are separate
  locks on Linux); while `flock` held it, `File::try_lock` said
  `WouldBlock`. Node cannot take a `flock(2)` lock itself: `node:fs` has no
  such call, and `node:ffi` is in Node 26 only, as an experimental module;
  Node 22.23.1 and 24.18.0, two of the versions CI runs, have no `node:ffi`
  (`ERR_UNKNOWN_BUILTIN_MODULE`). Bun's `node:fs` has none either. So the
  recorder holds the lock through util-linux's `flock` command
  (`test/recordings/codex/sign-in-lock.ts` and `test/recordings/flock.ts`),
  from Node and Bun alike. When
  `flock` does not run, the recorder stops before it starts `codex`.
- The window that remains: a program that ignores the locks can still write
  between comparison and replacement. The locks do not serialize manual
  edits to the link chain. The recorder checks the resolved path again just
  before the rename, but cannot prevent a change after that check.
  `test/drivers/codex/sign-in-copy-back-node.test.ts` makes another writer
  try at the rename, both from the same home and from a second linked home.
  The writer cannot commit there. On retry it sees the newer sign-in and
  does not overwrite it.
- When the recovery file cannot take the value either, the workspace's copy
  holds the only copy. The recorder then keeps that workspace, stops the run,
  and names the workspace and the copy in the error and in the run's last
  lines.
- When the user has no `auth.json` (there is no sign-in, or it is in the
  keyring), a live run stops before it starts `codex`, naming the file. To
  record, sign in with file storage (`codex login` with no
  `cli_auth_credentials_store` set).

The workspace, with the copied sign-in, is removed after each scenario, also
after one that fails, unless it holds the only copy of a refreshed sign-in.

### The Codex model

Codex lists its models with the app-server's `model/list` request: each
`Model` has an `id`, a `model`, a `displayName`, a `description`, whether it
is `hidden` and whether it `isDefault`, and no size or price (the vendored
schema's `Model`; `codex-rs/app-server/src/request_processors/catalog_processor.rs:302–358`
lists the catalog in its order, without hidden models unless asked). Before
the first prompt of each scenario the recorder asks, through a driver
instance whose `codex app-server` starts in the scenario's workspace around
the tap (not recorded). It records with the model `ARI_RECORD_CODEX_MODEL`
names, else with the first model listed whose id or name holds the word
`luna`, `nano` or `mini` (any case): OpenAI's API docs ("Models",
https://developers.openai.com/api/docs/models, read 2026-11-25) name GPT-6
Luna the model "for cost-sensitive, high-volume workloads", and OpenAI named
its earlier small models mini and nano. Codex 0.172.0's bundled catalog lists
`gpt-6-luna` ("Fast and affordable model for easier tasks") as its first such
model (`codex-rs/models-manager/models.json`). The driver config's `model`
starts the thread with it (`thread/start`), and Codex resumes a thread with
the model it ran with (`codex-rs/app-server/src/request_processors/thread_processor.rs:305–334`).
When the variable names a model Codex does not list, or it is not set and
Codex lists no such model, the recorder stops before the first prompt, lists
the models, and records nothing. Replay starts the thread with the model the
header names.

### What the live Codex tapes add to the fake

The six Codex 0.172.0 recordings use `gpt-6-luna`. Replay keeps the observed
frames. References are relative to `test/drivers/codex/recordings/`.

- The live handshake announces remote-control status even when disabled.
  It also announces account state, built-in MCP startup, moderation,
  read state and rate limits. The six-scenario fake does not emit these on
  its own (`simple.ndjson:10,14,18–19,24,27–28`). The built-in `codex_apps`
  server appears in startup status, but no scenario calls it.
- The live approval follows the command's `item/started`. It offers an
  exec-policy amendment as well as accept and cancel. The host accepts just
  once or cancels; it never takes the amendment. The fake puppet asks first,
  then emits the command item, and offers no amendment in these scenarios
  (`approval_allowed.ndjson:39–44`, `approval_denied.ndjson:39–43`). The live
  command reports its marker in the completed item, without the fake's
  command output delta (`approval_allowed.ndjson:44`).
- Real turn replies vary in delta size and timing. The interrupted turn can
  end without a separate completion for the assistant message that was
  streaming (`interrupt.ndjson:22–30`).
- The live resume carries history cursors and clears a goal on the resumed
  thread, and the explicit no-tools server in the recorder fails to connect
  on the loopback discard port (`resume.ndjson:43–53,58–62`). Those are not
  simulated as live network behavior by the fake. The failed server does not
  prevent the second turn from completing (`resume.ndjson:74`).

The live recorder allows only one approval for the exact marker command in
the isolated working directory. It refuses a different command, a different
working directory, any other kind of approval, or a second request.

#### Replaying the pre-admission captures

The six original live tapes predate the driver's `codex --version` session
admission probe. Only the live replay test opts in to compatibility. The
adapter checks each file's body checksum and pins that checksum and the
original header metadata. It supplies a test-only successful version probe
using the observed version from the header, just before the recorded login
at line 2, and again at line 36 of `resume.ndjson`. It runs no executable.
The probe response is not captured traffic. Wrong or extra spawns still fail,
and the existing sequencer matches every original frame in order at its
original file line. Default replay has no adapter: new tapes must record
their own admission probes, and a changed or missing probe fails replay.

## How to record

You need Claude Code signed in on this machine (`claude auth status`), or an
Anthropic API key. Recording spends your Claude quota: it runs eight short
turns, with the `haiku` model unless you choose another. The driver runs
your own `claude` on `PATH`, which must be at least the Claude Code the
pinned SDK bundles (2.1.330 for SDK 0.3.330); the recorder reads its
`--version` before it starts, and the driver refuses an older one.
`test/drivers/claude/live-recordings.test.ts` checks that each recording's
`vendorVersion` equals the version the pinned SDK bundles, so record with
exactly that version.

1. Run `pnpm install --frozen-lockfile`.
2. Run `ARI_LIVE_RECORD=1 pnpm run record:claude`.
3. To record some scenarios only, name them:
   `ARI_LIVE_RECORD=1 pnpm run record:claude -- simple resume`.
4. To use another model, set `ARI_RECORD_CLAUDE_MODEL`, for example
   `ARI_RECORD_CLAUDE_MODEL=sonnet`.
5. To write somewhere else, pass `--out <dir>`.
6. Run `pnpm run check:recordings`, then the replay tests.
7. Read the diff of `test/drivers/claude/recordings/` before you commit it.

The recorder writes `test/drivers/claude/recordings/<scenario>.ndjson`, one
file per scenario, also for a scenario whose checks failed (it says which,
and exits 1). When it cannot write a recording (an output directory it cannot
use, for example), it stops after that scenario. Its last lines name every
recovery file and every kept workspace, whatever else failed; see "How Claude
Code finds the sign-in". Without `ARI_LIVE_RECORD=1` it exits 2 before it
loads the SDK or starts anything. No gate step and no CI workflow sets
`ARI_LIVE_RECORD`.

### Recording OpenCode

You need OpenCode 2.x installed (`opencode --version` prints `opencode v2.1.2`
for the pinned version) and signed in to a provider (`opencode auth login`),
or a provider key in the environment. Recording spends that provider's quota:
eight short turns.

1. Run `pnpm install --frozen-lockfile`.
2. Run `ARI_LIVE_RECORD=1 pnpm run record:opencode` once without a model. It
   stops before the first prompt and lists the models the server offers.
3. Run `ARI_LIVE_RECORD=1 ARI_RECORD_OPENCODE_MODEL=<provider/model> pnpm run record:opencode`
   with one of them, the cheapest you have.
4. To record some scenarios only, or to write somewhere else, use the
   arguments of `record:claude`: `-- simple resume`, `--out <dir>`.
5. Run `pnpm run check:recordings`, then the replay tests.
6. Read the diff of `test/drivers/opencode/recordings/` before you commit it.

The recorder writes `test/drivers/opencode/recordings/<scenario>.ndjson`, one
file per scenario, also for a scenario whose checks failed (it says which,
and exits 1). When it cannot write a recording (an output directory it cannot
use, for example), it stops after that scenario. Its last lines name every
recovery file and every kept workspace, whatever else failed; see "How
OpenCode finds the sign-in". Without `ARI_LIVE_RECORD=1` it exits 2 before it loads anything
or starts any process; without a model the server offers it exits 2 before
the first prompt.

### Recording Antigravity

You need the Antigravity CLI on `PATH` (`agy --version` prints `1.5.17` for
the version these docs were written against) and a Google sign-in in
`~/.gemini/antigravity-cli/antigravity-oauth-token` (see "How Antigravity
finds the sign-in"). To put a sign-in `agy` refreshed back into that file,
the recorder also needs util-linux's `flock` on `PATH`; without it, a
refreshed sign-in goes to the recovery file. Recording spends your
Antigravity quota: eight short turns.

1. If that file does not exist, sign in once into it with
   `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy acp --login --gemini-dir "$HOME/.gemini" --app-data-dir antigravity-cli`.
2. Run `pnpm install --frozen-lockfile`.
3. Run `ARI_LIVE_RECORD=1 pnpm run record:antigravity`.
4. To record with another model, set `ARI_RECORD_ANTIGRAVITY_MODEL` to one the
   agent offers; a model it does not offer stops the recorder before the
   first prompt. Use `--list-models` to see the available IDs.
5. To record some scenarios only, or to write somewhere else, use the
   arguments of `record:claude`: `-- simple resume`, `--out <dir>`.
6. Run `pnpm run check:recordings`, then the replay tests.
7. Read the diff of `test/drivers/antigravity/recordings/` before you commit
   it.

The recorder writes `test/drivers/antigravity/recordings/<scenario>.ndjson`,
one file per scenario, also for a scenario whose checks failed (it says
which, and exits 1). When it cannot write a recording, it stops after that
scenario. Its last lines name every recovery file and every kept workspace,
whatever else failed. Without `ARI_LIVE_RECORD=1` it exits 2 before it loads
anything or starts any process; with its temp workspace inside your home or
below a folder holding `AGENTS.md`, `GEMINI.md` or `.agents/`, without a
sign-in file, or without a model the agent offers, it exits 2 before the
first prompt.

### Recording Codex

You need the Codex CLI on `PATH` (`codex --version` prints `codex-cli 0.172.0`
for the version the driver is built on) and a sign-in in `~/.codex/auth.json`
(see "How Codex finds the sign-in"). Recording spends your Codex usage: eight
short turns.

1. Run `pnpm install --frozen-lockfile`.
2. Run `ARI_LIVE_RECORD=1 pnpm run record:codex`.
3. To record with another model, set `ARI_RECORD_CODEX_MODEL` to one Codex
   lists; a model it does not list stops the recorder before the first
   prompt with the list.
4. To record some scenarios only, or to write somewhere else, use the
   arguments of `record:claude`: `-- simple resume`, `--out <dir>`.
5. Run `pnpm run check:recordings`, then the replay tests.
6. Read the diff of `test/drivers/codex/recordings/` before you commit it.

The recorder writes `test/drivers/codex/recordings/<scenario>.ndjson`, one
file per scenario, also for a scenario whose checks failed (it says which,
and exits 1). When it cannot write a recording, it stops after that
scenario. Its last lines name every recovery file and every kept workspace,
whatever else failed. Without `ARI_LIVE_RECORD=1` it exits 2 before it loads
anything or starts any process; with its temp workspace inside your home or
below a folder holding `AGENTS.md`, `AGENTS.override.md`, `.codex` or
`.agents`, without a sign-in file, or without a model Codex lists, it exits 2
before the first prompt.

## How to refresh

Record again when the vendor's version changes: a new pinned
`@anthropic-ai/claude-agent-sdk` (which bundles a new Claude Code), a new
`opencode` or pinned `@opencode/client`, a new `agy` or vendored ACP schema
release, a new `codex` or vendored Codex schema, or a change to the
scenarios.

1. Bump the pinned SDK (or install the new `opencode`) and run `pnpm install`.
2. Record all six again, as above.
3. Check that each header's `vendorVersion` and `sdkVersion` are the new
   versions.
4. Run the gate. When a replay fails against a fresh live recording, the
   driver or the fake is wrong: fix it, never the recording.

A driver change that keeps the native traffic the same needs no new
recording. A driver change that sends different frames fails replay. Then
record again, and review the diff to confirm the new traffic is what you
meant.

## Sources

The design follows T3 Code (`pingdotgg/t3code`, MIT): one
`record:<provider>-replay` script per provider that a person runs by hand,
NDJSON transcripts with both directions and the SDK version, model and
session id, and replay tests in the normal suite with no provider
credential. See
`apps/server/scripts/record-claude-agent-sdk-replay-fixture.ts` and
`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts` there.
No code was copied.
