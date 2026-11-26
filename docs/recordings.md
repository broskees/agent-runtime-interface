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
| `credential-file.ts` | copies a sign-in an agent keeps in one file into the recorded agent's profile, and puts a refreshed copy back |
| `claude/` | the Claude tap, the replay SDK, and the recording and replay functions |
| `opencode/` | the OpenCode recording proxy, the replay server, the sign-in copy, `opencode serve`, and the recording and replay functions |
| `stdio/` | the process tap and the replay process service, for every driver that starts its agent through `HostServices.process` and talks to it on stdin and stdout |
| `acp/` | the ACP protocol words and the approval answers read off ACP traffic |
| `antigravity/` | the Antigravity layout and model choice, the sign-in file, and the recording and replay functions |

`scripts/record-claude.ts` is the Claude recorder, `scripts/record-opencode.ts`
the OpenCode recorder and `scripts/record-antigravity.ts` the Antigravity
recorder. `scripts/check-recordings.ts` is the scan the gate runs.
`scripts/resanitise-recordings.ts` sanitises committed recordings again.
Nothing here ships in the npm tarball.

The live recordings are in `test/drivers/claude/recordings/` and
`test/drivers/opencode/recordings/`, one file per scenario. The Antigravity
recorder writes to `test/drivers/antigravity/recordings/`. The gate replays
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
on stdin and stdout (the Antigravity driver; later the Codex driver and the
other ACP flavors). It records the traffic between the driver and every
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
unrecorded. The recorder's own `agy --version` for the header goes around the
tap.

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
  command shows as completed when the turn ends. When every recorded frame
  was replayed and a scenario assertion still fails, the Antigravity replay's
  error names the recording file, the frame replayed last, and the recorded
  frame the outcome depended on where one can be named: the last recorded
  inbound frame that holds the native id of an item the assertion looked at
  (for the commands above, their last `tool_call_update` or permission
  request). Its line leads the error (`ReplaySequencer.checkFailed`).

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

## Fields replay ignores

Frame comparison leaves out only these fields. `test/recordings/docs.test.ts`
checks this table against the code's list. OpenCode replay leaves out no
field: the driver builds every request from the scenario, its config and what
the server answered, so a replay sends the same requests byte for byte, and a
recording holds no request headers. Antigravity replay leaves out only the ARI
version in the driver's ACP `initialize` request (`clientInfo.version`).

| Driver | Frame kind | Field | Reason |
|---|---|---|---|
| claude | `query` | `options.env.CLAUDE_AGENT_SDK_CLIENT_APP` | the driver sets it to ari/ followed by the ARI version, which changes with every ARI release |
| claude | `query` | `options.env.ANTHROPIC_API_KEY` | present only when the recorder ran with ANTHROPIC_API_KEY set; a replay has no key, and a recording holds only its placeholder |
| antigravity | `stdin` | `message.params.clientInfo.version` | the driver's ACP initialize request names the ARI version, which changes with every ARI release |

## Sanitising and the scan

The repository is public, so every recorder sanitises each frame before it
writes. All recorders use one sanitiser, `test/recordings/sanitiser.ts`. It
replaces, in every string and object key (a frame's own format fields, `dir`,
`kind`, `query`, `id`, `method`, `toolName` and `contentType`, stay as the
recorder wrote them when they hold a string, a number, a boolean or null; an
OpenCode request's `query` is an object of the request's query parameters,
and is sanitised like any other value):

| What | Placeholder |
|---|---|
| the recording's temp workspace, and its real path | `<WORKSPACE>` |
| a string that is exactly the value of `PATH` | `<PATH>` |
| `$HOME`, and its real path | `<HOME>` |
| the values of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` | `<ANTHROPIC_API_KEY>`, `<ANTHROPIC_AUTH_TOKEN>`, `<CLAUDE_CODE_OAUTH_TOKEN>` |
| the value of every other variable of the recorder's environment whose name ends in `_KEY`, `_TOKEN`, `_SECRET` or `_PASSWORD`, when it is 8 characters or more | `<NAME>`, for example `<GEMINI_API_KEY>` |
| the OS user name (`os.userInfo().username`, and the values of `USER` and `LOGNAME` where they differ): in an inbound frame wherever it is a whole word, except in a protocol word; in an outbound frame and in object keys where it is a whole segment of a path | `<USER>` |
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
  value that is one of the protocol words of its key (below): an account
  named `user` keeps Claude Code's `type: "user"`, `role: "user"` and
  `apiKeySource: "user"`, which the driver reads and replay needs, and an
  account named `text` keeps OpenCode's `type: "session.text.delta"`.
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

### Claude protocol words

`test/recordings/claude/protocol-words.ts` lists, for each object key the
pinned SDK can put in an inbound Claude frame, the string literals its types
allow as that key's value. `test/recordings/claude/derive-protocol-words.ts`
derives them with the TypeScript checker from
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (0.3.330) and the
`@anthropic-ai/sdk` types it imports. It starts from `SDKMessage`, the return
types of the `Query` methods and SDK functions the driver calls, and the
options `CanUseTool` receives, and follows every property, union member,
array element and index signature. `test/recordings/protocol-words.test.ts`
fails when the committed list and the derivation differ; after an SDK bump,
run `node test/recordings/claude/derive-protocol-words.ts` and paste the result.

A value is kept only when it is one of its key's words: `type: "user"` stays,
but `error: "permission denied for <name>"` loses the name, because `error`'s
words are its enum values (`authentication_failed`, `rate_limit`, ...). The
52 keys are `allowed_callers`, `apiKeySource`, `apiProvider`, `behavior`, `category`, `compact_result`, `costBasis`, `destination`, `direction`, `effort`, `error`, `errorCode`, `error_code`, `fast_mode_disabled_reason`, `fast_mode_state`, `file_type`, `first_stream_post_queued_behind`, `first_text_post_queued_behind`, `fromMode`, `kind`, `level`, `limitScope`, `lost`, `media_type`, `mode`, `model`, `name`, `outcome`, `overageDisabledReason`, `overageStatus`, `oversized_image`, `permissionMode`, `priority`, `rateLimitType`, `reason`, `response_inclusion`, `role`, `scope`, `service_tier`, `speed`, `startup_failure_reason`, `state`, `status`, `stop_reason`, `subkind`, `subtype`, `supportedEffortLevels`, `terminal_reason`, `trigger`, `ttl`, `type`, `view_mode`.

### ACP protocol words

`test/recordings/acp/protocol-words.ts` lists, for each object key an ACP
agent can put in a message to the client, the string values the vendored ACP
schemas allow there. `test/recordings/acp/derive-protocol-words.ts` derives
them from `vendor-schemas/acp/schema-v2.0.0-beta.3/`, the release the ACP
drivers are built on. It starts, in `v1/schema.unstable.json` and
`v2/schema.unstable.json`, from the `Agent` message (every request, response
and notification an agent sends) and the `ProtocolLevel` message
(`$/cancel_request`), follows every `$ref`, `allOf`, `anyOf`, `oneOf`,
property, array item and additional property, and takes each `const` and
`enum`. A JSON-RPC message's `method` holds a method name rather than a schema
literal, so `method` gets the `clientMethods` and `protocolMethods` of each
version's `meta.unstable.json`: the methods an agent sends.
`test/recordings/protocol-words.test.ts` fails when the committed list and the
derivation differ; after a schema bump, run
`node test/recordings/acp/derive-protocol-words.ts` and paste the result.

The 20 keys are `apiType`, `audience`, `category`, `fileType`, `format`, `jsonrpc`, `kind`, `method`, `mode`, `operation`, `position`, `priority`, `sessionUpdate`, `severity`, `state`, `status`, `stopReason`, `supported`, `theme`, `type`.

### OpenCode protocol words

`test/recordings/opencode/protocol-words.ts` lists, for each object key an
OpenCode 2.x server can put in an inbound OpenCode frame, the string literals
the types allow as that key's value. `test/recordings/opencode/derive-protocol-words.ts`
derives them with the TypeScript checker from
`node_modules/@opencode/client/dist/promise/index.d.ts` (2.1.2) and the
generated types it exports. It starts from `OpenCodeEvent` (every event of
`GET /api/event`), `ServerInfo` (the driver reads `GET /api/info` itself), the
awaited return type of every client call the driver makes (each method of
`V2Client` in `src/drivers/opencode/sdk.ts`, looked up by the same path in the
client), and every error body the client declares (each exported type with a
`_tag`), and follows every property, union member, array element and index
signature. `test/recordings/protocol-words.test.ts` fails when the committed
list and the derivation differ; after a client bump, or when the driver calls
another client method, run `node test/recordings/opencode/derive-protocol-words.ts`
and paste the result.

The 20 keys are `_tag`, `cacheFormat`, `command`, `delivery`, `effect`, `encoding`, `event`, `exit`, `finish`, `format`, `maxTokensField`, `name`, `op`, `outcome`, `reason`, `reasoningField`, `reply`, `status`, `type`, `variant`.

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
  to the user's file, so a rotated token is never lost. When the user's file
  also changed meanwhile, the recorder leaves it as it is and reports the
  scenario failed.
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
`GEMINI_HOME=<profile>`, `AGY_ACP_FORCE_FILE_STORAGE=1` and
`AGY_CLI_DISABLE_AUTO_UPDATE=1` (docs/drivers/antigravity.md). The recorder's
host starts it with the recorder's own environment, less `HOME`, `TMPDIR`,
`DBUS_SESSION_BUS_ADDRESS` and every `XDG_*` variable, and strips every
variable whose name starts with `GEMINI_`, `GOOGLE_`, `GCLOUD_`, `CLOUDSDK_`
or `AGY_` (the prefixes of the driver's CLI manifest), then adds:

| Variable | Value | Why |
|---|---|---|
| `HOME` | `<workspace>/agy-home`, empty | `agy` reads the user's customizations from `~/.gemini/config/`, `~/.gemini/AGENTS.md`, `~/.gemini/GEMINI.md` and `~/.gemini/skills/`, its settings and skills from `~/.gemini/antigravity-cli/` ("Customization discovery", "Settings"), and `--gemini-dir` defaults to `.gemini` in the home directory (`agy acp --help`) |
| `XDG_CONFIG_HOME` | `<workspace>/xdg-config` | `agy` keeps plugin secrets in `~/.config/antigravity` |
| `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | `<workspace>/xdg-data`, `xdg-state`, `xdg-cache` | the other XDG base directories |
| `XDG_RUNTIME_DIR` | `<workspace>/xdg-runtime` | the user's runtime directory holds their session bus and keyring sockets |
| `TMPDIR` | `<workspace>/tmp` | so a temp path `agy` reports is inside the workspace, and becomes `<WORKSPACE>` |
| `DBUS_SESSION_BUS_ADDRESS` | `unix:path=<workspace>/no-session-bus`, where nothing listens | D-Bus clients find the session bus at this address (D-Bus Specification, "Well-known Message Bus Instances"); with it unreachable, `agy` cannot reach the Secret Service keyring and keeps its sign-in in its file storage (see "How Antigravity finds the sign-in") |
| `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` | `1` | the name the `agy` 1.5.17 binary holds for forcing its file token storage; added after the stripping. Antigravity documents no meaning for it, so the unreachable session bus is what the recorder relies on |

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
  only when the keyring is bypassed or unreachable. Antigravity's
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
- `AGY_ACP_FORCE_FILE_STORAGE`, which the driver sets, does nothing in
  `agy` 1.5.x: the 1.5.17 binary holds neither that name nor `GEMINI_HOME`,
  and the same T3 Code issue found `AGY_ACP_FORCE_FILE_STORAGE` missing from
  1.5.7 to 1.5.12. The binary holds `AGY_CLI_FORCE_FILE_TOKEN_STORAGE`.
- So the recorder copies only that one file: the user's
  `~/.gemini/antigravity-cli/antigravity-oauth-token` (`HOME` from the
  recorder's environment) into `<profile>/antigravity-acp/`, mode 0600 in a
  directory only the user can enter, and makes the keyring unreachable (the
  table above). It reads nothing else of the user's, and never the keyring.
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
- When the recovery file cannot take the value either, the workspace's copy
  holds the only copy. The recorder then keeps that workspace, stops the run,
  and names the workspace and the copy in the error and in the run's last
  lines.
- When the user keeps the sign-in only in the keyring, there is no file to
  copy: a live run stops before it starts `agy`, naming the file. The
  recorder never reads the keyring. To record, the user needs the sign-in in
  that file. By the release notes above, a sign-in made while the keyring is
  unreachable, such as `agy acp --login` (Antigravity's ACP guide) run with
  `DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent`, goes to the file; no
  phase of this plan has signed in, so that is not verified.
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
recorder stops before the first prompt, lists the models, and records
nothing. Replay gives each turn the model the header names.

## How to record

You need Claude Code signed in on this machine (`claude auth status`), or an
Anthropic API key. Recording spends your Claude quota: it runs eight short
turns, with the `haiku` model unless you choose another.

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
finds the sign-in"). Recording spends your Antigravity quota: eight short
turns.

1. Run `pnpm install --frozen-lockfile`.
2. Run `ARI_LIVE_RECORD=1 pnpm run record:antigravity`.
3. To record with another model, set `ARI_RECORD_ANTIGRAVITY_MODEL` to one the
   agent offers; a model it does not offer stops the recorder before the
   first prompt with the list.
4. To record some scenarios only, or to write somewhere else, use the
   arguments of `record:claude`: `-- simple resume`, `--out <dir>`.
5. Run `pnpm run check:recordings`, then the replay tests.
6. Read the diff of `test/drivers/antigravity/recordings/` before you commit
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

## How to refresh

Record again when the vendor's version changes: a new pinned
`@anthropic-ai/claude-agent-sdk` (which bundles a new Claude Code), a new
`opencode` or pinned `@opencode/client`, a new `agy` or vendored ACP schema
release, or a change to the scenarios.

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
