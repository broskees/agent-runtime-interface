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
| `claude/` | the Claude tap, the replay SDK, and the recording and replay functions |

`scripts/record-claude.ts` is the Claude recorder. `scripts/check-recordings.ts`
is the scan the gate runs. Nothing here ships in the npm tarball.

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
| `driver` | the ARI driver kind, for example `claude` |
| `vendor` | the agent, for example `claude-code` |
| `vendorVersion` | the agent's version: for Claude, the `claude_code_version` of Claude Code's `system`/`init` message, else the version the SDK package bundles |
| `sdk` | the package the driver talks through, for example `@anthropic-ai/claude-agent-sdk` |
| `sdkVersion` | that package's version |
| `model` | the model the recorder asked for, for example `haiku` |
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

An outbound frame is recorded when the driver makes the call. A prompt is
recorded when the driver writes it: the tap and the replay SDK both read the
driver's prompt stream as fast as the driver writes it. An inbound frame is
recorded when the driver receives it.

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

The sequencer walks the recording in order:

- each outbound frame the driver sends must equal the next recorded frame,
  apart from the fields listed below;
- each inbound frame is delivered once every frame before it has happened.

Replay fails, naming the recording file, the line and both frames, when:

- the driver sends a frame other than the next recorded one (the message also
  names the first field that differs);
- the driver sends a frame after the last recorded one;
- the scenario ends while recorded frames remain;
- the scenario waits too long for something (a recorded inbound frame is
  missing, for example). The message names the next recorded frame and the
  last frame replayed.

Before it compares, replay runs the driver's frame through the sanitiser with
its own workspace, `$HOME` and `PATH`. Before it delivers, it puts its own
workspace where the recording says `<WORKSPACE>`.

## Fields replay ignores

Frame comparison leaves out only these fields. `test/recordings/docs.test.ts`
checks this table against the code's list.

| Driver | Frame kind | Field | Reason |
|---|---|---|---|
| claude | `query` | `options.env.CLAUDE_AGENT_SDK_CLIENT_APP` | the driver sets it to ari/ followed by the ARI version, which changes with every ARI release |
| claude | `query` | `options.env.ANTHROPIC_API_KEY` | present only when the recorder ran with ANTHROPIC_API_KEY set; a replay has no key, and a recording holds only its placeholder |

## Sanitising and the scan

The repository is public, so every recorder sanitises each frame before it
writes. All recorders use one sanitiser, `test/recordings/sanitiser.ts`. It
replaces, in every string and object key:

| What | Placeholder |
|---|---|
| the recording's temp workspace, and its real path | `<WORKSPACE>` |
| a string that is exactly the value of `PATH` | `<PATH>` |
| `$HOME`, and its real path | `<HOME>` |
| the values of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` | `<ANTHROPIC_API_KEY>`, `<ANTHROPIC_AUTH_TOKEN>`, `<CLAUDE_CODE_OAUTH_TOKEN>` |
| the OS user name, as a whole word | `<USER>` |
| email addresses | `<EMAIL>` |
| another home directory: `/home/<name>`, `/Users/<name>`, `/root` | `<OTHER_HOME>` |
| a token the scan looks for | `<TOKEN>` |

Exact values go first, longest first, so a path inside the workspace is
replaced whole.

`pnpm run check:recordings` (`scripts/check-recordings.ts`) is a step of both
`gate` and `gate:bun`. It scans every file under `test/drivers/*/recordings/`.
It fails, naming the file, the line and the rule but never the matched text,
on:

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
- Managed policy settings (for example `/etc/claude-code/managed-settings.json`)
  load from the machine in all cases. The recorder cannot turn them off; a
  machine with such a file records under it.

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
also after one that fails.

### Ids

The driver picks the session id of each thread and the uuid of each prompt
through `createClaudeDriver({ newUuid })`. The recorder and the replay both
use the same fixed sequence (`a11ce000-0000-4000-8000-000000000001`, ...), so
the ids the driver sends match.

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
and exits 1). Without `ARI_LIVE_RECORD=1` it exits 2 before it loads the SDK
or starts anything. No gate step and no CI workflow sets `ARI_LIVE_RECORD`.

## How to refresh

Record again when the vendor's version changes: a new pinned
`@anthropic-ai/claude-agent-sdk` (which bundles a new Claude Code), or a
change to the scenarios.

1. Bump the pinned SDK and run `pnpm install`.
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
