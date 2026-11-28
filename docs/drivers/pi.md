# The Pi driver (`ari/drivers/pi`)

The Pi driver runs the user's own [Pi](https://pi.dev) coding agent through
its RPC mode: `pi --mode rpc`, strict JSONL over stdio
([Pi docs: RPC mode](https://pi.dev/docs/latest/rpc)). It is ARI's reference
driver: small on purpose, and the one to copy when you write a driver for a
CLI agent.

It is tested against Pi `>=1.6.0 <2.0.0`: the RPC protocol, session file
format and extension API of `@earendil-works/pi-coding-agent` 1.6.0.
`test/drivers/pi/SOURCES.md` lists every source the driver and its fake follow.

```ts
import { piDriver } from "ari/drivers/pi";
import { createNodeHostServices, createCoordination } from "ari/node";

const instance = await piDriver.create(host, { instanceId: "pi", config: { binary: "pi" }, environment: {} });
const session = await instance.openSession({});
const thread = await session.createThread({ cwd: "/work", policy: { mode: "approval_required", interaction: "default", cwd: "/work" } });
```

## Config

| Field | Meaning |
|---|---|
| `binary` | The `pi` executable: a name looked up on `PATH` through `host.process.resolveExecutable`, or a path. Default `pi`. |
| `provider` | The provider whose sign-in `pi auth check` reports, for example `anthropic`. |
| `model` | The model new threads start with, as `provider/id` (Pi's `--model`). Pi's default when left out. |
| `thinking` | The thinking level new threads start with (Pi's `--thinking`). |

`ari/meta/pi` exports the label, icon, this schema and form hints without
loading the driver.

## How it runs Pi

- **One Pi process per thread** (`sessionModel: "process_per_thread"`). Pi runs
  one session file per process, and a process keeps the working directory,
  system prompt and runtime mode it started with.
- Each process is `pi --mode rpc --session-dir <stateDir>/sessions
  [--session <file> | --fork <file>] [--model] [--thinking] [--api-key]
  [--append-system-prompt <text>]... --extension <cacheDir>/pi-bridge/ari-pi-bridge.ts`,
  started through `host.process.spawn` in the thread's directory.
- Session files live in the instance's state directory, not in `~/.pi`. Pi
  keeps the system prompt (including host text) in its session files
  ([session-format.md](https://pi.dev/docs/latest/session-format)), so they
  must stay out of the provider's own config directory.
- **The driver opens only session files really inside `<stateDir>/sessions`**,
  symbolic links followed (`fs.realpath` of both the file and the directory).
  `--session-dir` does not move a file named with `--session`, and Pi records
  the `--append-system-prompt` text in the file it opens (Pi's
  `SessionManager.open`, `dist/core/session-manager.js:1347–1368`; the
  `addendum` section, `dist/core/system-prompt.js:96–97`, goes into a system
  message, `dist/core/agent-session.js:1394–1399`, which Pi persists,
  `:825–830`). Resuming a
  file the user's own pi keeps under `~/.pi` would write host instructions
  into it, so `resumeThread` rejects a handle (or an id Pi would read as a
  path) outside that directory with a `validation` error, and starts no
  process. A link inside the directory that leads elsewhere is outside.
- **Pi gets a session file, never a bare session id.** Pi looks a bare id up
  among the sessions made in the directory it starts in; for one made in
  another directory it prints "Session found in different project", asks
  "Fork this session into current directory? [y/N]" on stdin before RPC
  starts, and exits without answering (`dist/main.js:227–253, 347–360`). So
  `resumeThread({ native: { id } })` finds the file itself: Pi names each
  session file `<timestamp>_<session id>.jsonl`, and the file's header must
  hold that id. The resume then works from any `policy.cwd`. An id no file
  holds never reaches Pi.
- A thread whose process was parked (`release`, `unloadThread`, closing the
  session) or exited starts again with `--session <file>` the next time it is
  used. Pi writes a session file only once it holds a message, and
  `--session` of a missing file starts a *different* session at that path
  (Pi's `SessionManager._setSessionFile`). So the driver stops an idle
  process with the bridge's `/ari-persist`, which writes Pi's own header when
  Pi has not written the file and then shuts Pi down; Pi then reopens the
  same session id from it. Every restart checks the session id Pi reports: a
  different id is a
  `not_found` error for that call, and the driver stops the process Pi
  started instead. It never moves the thread's events to another session.
- Frames are split on LF only (the driver kit's NDJSON decoder), never on
  U+2028 or U+2029, as Pi's docs require.

### The ARI bridge extension

Pi asks no approval before tool calls (Pi docs security.md) and leaves
permission gates, extra MCP servers and session-tree navigation to extensions
(extensions.md, mcp.md). The driver writes one small extension, `ari-pi-bridge.ts`, into
the instance's cache directory when a session opens (never during a probe) and
loads it into every Pi process with `--extension`. Its source is
`PI_BRIDGE_SOURCE` in `src/drivers/pi/bridge.ts`. It:

1. **Gates tool calls by the ARI runtime mode** in Pi's `tool_call` hook.
   Read-only tools (`read`, `grep`, `find`, `ls`) always run. `full_access`
   runs everything; `read_only` blocks the rest; `auto_accept_edits` runs
   `edit` and `write` and asks for the rest; `approval_required` asks for the
   rest. It asks with `ctx.ui.select`, which RPC mode sends as an
   `extension_ui_request`. The dialog's title is a JSON descriptor
   (`{ "ari": "approval", kind, tool, input, options }`), and each option
   string is a native option id: `allow-once` (accept, scope `once`),
   `allow-session` (accept for the rest of that Pi process, scope `session`)
   and `decline`.
2. **Reports Pi's working directory** at `session_start` as a `setStatus`
   record under the key `ari`, so a thread started through a symbolic link
   reports the real directory.
3. **Adds four commands** the driver sends as prompts. Pi runs an extension
   command at once and never adds it to the conversation.
   - `/ari-mcp <json>` registers the host's MCP servers with
     `pi.registerMcpServer`, under the names the host chose. Nothing is
     written to Pi's `mcp.json`.
   - `/ari-rewind <entry id>` moves the session's leaf with
     `ctx.navigateTree`, labelled `ari-rewind`. The label entry persists the
     move, so a rollback survives a restart.
   - `/ari-context <json>` holds host instructions for the next run only.
   - `/ari-persist` writes the session header, as Pi's session manager holds
     it (`ctx.sessionManager.getHeader()`), to the session file when Pi has
     not written that file yet, and then calls `ctx.shutdown()`. It creates
     the file exclusively, so a file Pi wrote is never touched. The running
     session manager does not know about the file, and its first message
     would fail to create it (`EEXIST`), so that Pi must not go on: RPC mode
     shuts down once the command has answered and the session is idle
     (`dist/modes/rpc/rpc-mode.js:275–280, 607–611`). This is the bridge's
     only file write, and it imports only `node:fs` for it.
4. **Appends held instructions** to that one run's system prompt in
   `before_agent_start`.

It never adds instruction text of its own. Its runtime mode arrives in the
`ARI_PI_BRIDGE` environment variable, which it deletes once read.

## Threads, turns and ids

- **Thread**: one Pi session. `native` is Pi's session id (strong); `handle`
  is the session file, which `resumeThread({ native: { handle } })` takes.
- **Ephemeral thread**: `createThread({ persistSession: false })` runs
  `pi --no-session`, so Pi keeps the session in memory and writes no file.
  The thread has no `handle`. It lives as long as its process: `forkThread`
  (once it holds a message) and `unloadThread` reject with `invalid_state`
  (`no_session_file`), `canRelease()` is false while it runs, and a thread
  whose process ended cannot be recovered (`invalid_state`
  `no_session_file`). A resume of its id finds no file, as for any missing
  session.
- **Resume**: `pi --session <file>`, for a file under `<stateDir>/sessions`,
  named by the handle or found by the session id.
  Pi works in the directory the file's header records, wherever pi starts, so
  the thread's `cwd` is that directory, not `policy.cwd` (Pi's
  `SessionManager.open` and `dist/main.js:772–776`). A thread without
  messages resumes as itself, because `/ari-persist` wrote its header when
  its process stopped. Pi starts a *new* session when the file is missing;
  the driver sees that its session id does not match the file name, stops
  that process, starts a fresh session and emits `session.replaced` with
  `contextLost: true`. A session id no file holds takes the same fallback
  without starting Pi on it. Only a missing session falls back: when the file
  is there and pi fails to open it (a damaged file, a crash, a sign-in
  error), the error goes to the caller and no fresh session starts.
- **Turn**: one `prompt` and the run it starts. Pi has no turn id, so a turn
  is named by the position of its prompt among every user message of the
  session file in append order (weak, ordinal). Entries are append-only, so a
  position is never reused, even after a rollback.
- **Settlement**: a turn settles only on `agent_settled` (Pi will not continue
  on its own) or when the process exits. Never on `agent_end`, which retries,
  compaction or queued messages can follow, and never on a timer.
- **Steer**: Pi's `steer` command. Pi queues a steer even when no run is
  active and hands it to the next prompt, so after sending one the driver asks
  `get_state`. A steer still pending in an idle session missed its turn: the
  driver removes it with `clear_queue` and returns `prompt_required`.
- **Interrupt**: Pi's `abort`, which answers once the session is idle.
- **Rollback**: `/ari-rewind` to the prompt of the first turn to drop. The
  session keeps its file and id.
- **Fork**: `pi --fork <file>`, run in the destination directory, or in the
  source thread's own directory when the host names none. A fork made over
  RPC keeps the source's working directory, so the driver always uses the
  CLI, as the proposal's §1.3 notes. A fork from a turn then rewinds the copy
  to before that turn's prompt.
- **Compaction**: Pi's `compact` command, between turns.
- **Items**: messages by their position in the turn; reasoning from
  thinking blocks; tools by Pi's tool call id. Built-in tools map to
  `command_execution` (`bash`), `file_read` (`read`), `file_change` (`edit`,
  `write`), `file_search` (`grep`, `find`, `ls`), MCP tools (`mcp__<server>__<tool>`)
  to `mcp_tool_call`, and everything else to `tool_call`.
- **Snapshots** are rebuilt from `get_entries` with the same ids live events
  used. A steer Pi delivered right after a final answer cannot be told from a
  new prompt in a stored file, so after a restart it shows as its own turn.

## Resuming conversations ARI did not create

The driver refuses them. It resumes only session files under its instance's
`<stateDir>/sessions`, where it creates its own, because Pi writes a thread's
launch instructions into the session file it opens. A handle naming a file
anywhere else, such as a session the user's own `pi` keeps, is refused with
`validation` before Pi starts (symbolic links followed). A bare id is looked
up only in that directory: when no file there holds it, the driver starts a
fresh session with `session.replaced` if the host passed `policy`, and rejects
with `validation` otherwise, because it needs `policy.cwd` to start a new
session. The driver lists no native sessions
(`nativeSessions` is absent).

A resume with `purpose: "history"` of a thread this session does not hold
live is refused with `unsupported` (`resumeThread.purpose.history`), and no
`pi` starts: Pi opens a session file only to run it and records the launch
in it, so the driver cannot read its history without a live runtime. A
thread this session holds is reported as it is.

## Prompt content

Text blocks become the prompt's text, and inline images go in Pi's `images`
field. Pi records the prompt as one text block followed by those images
(`dist/core/agent-session.js:1573–1582`). Host files (`attachmentRef`) reach Pi as the path
`host.attachments.resolve` returns. When the host cannot give the bytes, the
prompt names the attachment as unreadable, as the proposal's §10 requires;
that is the only text the driver adds to a prompt. A `resource_link` or an
image URL becomes its URI.

## Requests

- The bridge's approval dialogs become approvals (`command`, `file_change` or
  `permission`) with their native option ids and real scopes.
- Any other extension's dialog becomes a `user_input` request with one
  question: `select` a single choice of its option strings, `confirm` a yes or
  no choice, `input` and `editor` free text. Answers go back in Pi's shapes
  (`value`, `confirmed`). A dialog still open when its turn ends is cancelled
  in Pi too.
- `notify` becomes a `notice` event. Status, widget, title and editor-text
  records are not shown.

## Sign-in

- A stored API key (method `api-key`) is `configured` and is passed with
  `--api-key`, which Pi accepts only with `--model`.
- Otherwise the ambient sign-in is Pi's own: `pi auth check --provider <p>
  --json --no-refresh` (`ready` is authenticated, `not_ready`
  unauthenticated, `invalid` unknown, no answer unavailable). `--no-refresh`
  keeps the check from writing a refreshed token. Without a `provider` or
  `model` there is nothing to check, so the state is `unknown`.
- Method `pi-login` tells the user to run `pi auth login <provider>`.
- A runtime auth failure poisons its scope for 30 seconds.
- The environment passes through. `pi --version`, `pi auth check` and every
  Pi process get the host's environment and the instance's `environment`,
  credential variables such as `ANTHROPIC_API_KEY` included, minus only what
  the host's `envPolicy.stripAmbient` names. A managed key, passed with
  `--api-key`, wins over an inherited one.

## The user's own `pi`, and its minimum

ARI runs the `pi` the user installed, found on `PATH` or at the path the
config names, and never downloads, installs or updates one. The minimum is Pi
1.6.0, the lower bound of the tested range `>=1.6.0 <2.0.0`. With an older
`pi`, `status()` is `unavailable` with `driver_unavailable` (with `installed:
true` and the version found), and `openSession` rejects with the same error
before any Pi process starts in RPC mode: the only process that runs is `pi
--version`. The error names the version found, the path, the minimum and Pi's
update step:

```text
Pi 1.5.9 (/usr/local/bin/pi) is older than 1.6.0, the oldest version this driver supports. Update pi with `pi update`.
```

The update step is Pi's own: "Both installers pin all dependencies and update
Pi with `pi update`" ([Pi quickstart](https://pi.dev/docs/latest/quickstart);
a Nix install updates with `nix profile upgrade pi`, the same page says). A
`pi` above the tested range still runs, with an `untested_version` advisory.
`pi --version` prints the bare version, such as `1.6.0`
(`test/fixtures/cli-version-output/pi.txt`).

## Probes and status

`probe()` runs only `pi --version`; `probe({ deep: true })` adds the auth
check. Neither writes a file or calls a mutating host service. `status()`
reports the version, an `untested_version` advisory above `>=1.6.0 <2.0.0`,
and `driver_unavailable` below 1.6.0. Without `pi`, `status()` is `unavailable` with a
`driver_unavailable` error naming the binary, and `openSession` rejects with
it.

## Capabilities

The third column is the proposal's §1.2 Pi column (Y or –), "not in §1.2" where
it has no row. Every difference names its source.

| Capability | Declared | §1.2 Pi column | Notes and sources |
|---|---|---|---|
| `sessions.multipleThreads` | `true` | not in §1.2 | One Pi process per thread. |
| `sessions.switchModel` | `true` | Y | Pi's `set_model` before the next prompt. |
| `sessions.switchRuntimeMode` | `false` | – | The bridge reads its mode once per process. |
| `sessions.pendingRequestsSurviveRestart` | `false` | not in §1.2 | Extension dialogs die with their process (Pi docs rpc-extension-ui.md). |
| `sessions.release` | `true` | not in §1.2 | Stops the processes; threads restart with `--session`. Vetoed while an ephemeral thread (`persistSession: false`) runs, as stopping it would end it. |
| `sessions.feedbackUpload` | `false` | not in §1.2 | Pi's RPC has no feedback command (Pi docs rpc-commands.md). |
| `sessions.contextUsageReuse` | `false` | not in §1.2 | |
| `threads.createEmpty` | `true` | not in §1.2 | Pi writes no file until a message, so the bridge's `/ari-persist` writes the header before the process stops. |
| `threads.readSnapshot` | `true` | Y | Rebuilt from `get_entries`. |
| `threads.rollback` | `true` | Y | `/ari-rewind`, persisted as a label entry. |
| `threads.compact` | `true` | not in §1.2 | Pi's `compact` command. |
| `threads.injectHistory` | `false` | not in §1.2 | |
| `threads.unload` | `true` | not in §1.2 | Stops the thread's process; `resumeThread` reopens the same session id, in the same session or a fresh one. An ephemeral thread has no file to reopen, so it is not unloaded (`invalid_state`). |
| `threads.exposesNativeIds` | `true` | not in §1.2 | |
| `threads.fork.supported` | `true` | Y | `pi --fork <file>`. |
| `threads.fork.fromTurn` | `true` | Y | Holds the history before the turn. |
| `threads.fork.fromItem` | `false` | not in §1.2 | Pi's events carry no session entry ids for items (Pi docs json.md). |
| `threads.fork.fromSubagent` | `false` | – | |
| `threads.fork.crossCwd` | `true` | not in §1.2 | Pi's CLI runs in the destination directory. |
| `turns.interrupt` | `true` | Y | Pi's `abort`. |
| `turns.steer` | `true` | Y | Pi's `steer`, checked with `get_state`. |
| `turns.queue` | `false` | Y | Pi queues follow-ups inside the running agent run, delivers steers before them, and gives a queued message no id until it is delivered (Pi docs rpc-commands.md `follow_up` and `steer`, json.md `queue_update`), so a queued turn has no id when `startTurn` must return one. Hosts queue on their side. |
| `turns.emitsStarted` | `true` | not in §1.2 | |
| `turns.terminalStatus` | `"strong"` | not in §1.2 | `agent_settled` is authoritative. |
| `turns.multiNativeTurnsPerRequest` | `false` | not in §1.2 | |
| `turns.steeringInterruptsTools` | `false` | not in §1.2 | Pi delivers a steer after the running tools finish (Pi docs rpc-commands.md `steer`). |
| `streaming.assistantText` | `true` | not in §1.2 | |
| `streaming.reasoning` | `true` | not in §1.2 | Thinking blocks. |
| `streaming.toolOutput` | `true` | Y | `tool_execution_update`. |
| `streaming.planText` | `false` | – | |
| `tools.mcp` | `true` | Y | Pi's built-in MCP support. |
| `tools.dynamicTools` | `false` | – | |
| `tools.mcpApps` | `false` | not in §1.2 | Pi's RPC has no MCP app commands (Pi docs rpc-commands.md). |
| `tools.exposesToolItemIds` | `true` | not in §1.2 | |
| `approvals.command` | `true` | Y | Through the bridge. |
| `approvals.fileRead` | `false` | – | Reading tools never ask. |
| `approvals.fileChange` | `true` | Y | Through the bridge. |
| `approvals.permission` | `true` | not in §1.2 | Other tools, MCP tools included. |
| `approvals.fromSubagents` | `false` | – | |
| `planning.todoList` | `false` | – | |
| `planning.proposedPlan` | `false` | – | |
| `planning.planUpdates` | `false` | not in §1.2 | |
| `planning.structuredQuestions` | `true` | Y | Extension UI dialogs. |
| `subagents.supported` | `false` | Y | Pi has no built-in subagents; they exist only as an example extension (Pi docs extensions.md, examples table: `subagent/`), and Pi's RPC protocol has no subagent events or commands (Pi docs json.md, rpc-commands.md). |
| `subagents.exposesThreadIds` | `false` | – | |
| `subagents.lifecycle` | `false` | not in §1.2 | |
| `subagents.wait` | `false` | – | |
| `subagents.stop` | `false` | – | |
| `context.instructionChannels` | `["system"]` | – | §1.2 has "–/–" for system and developer context. Pi takes host text as `--append-system-prompt` (Pi docs cli.md), and per run through the bridge's `before_agent_start` (Pi docs extensions.md); developer text goes to the same channel. |
| `context.syntheticContext` | `false` | not in §1.2 | |
| `context.summaries` | `false` | – | |
| `context.handoffSummaries` | `false` | not in §1.2 | |
| `checkpointing.workspace` | `false` | not in §1.2 | |
| `checkpointing.conversationRollback` | `true` | Y | |
| `checkpointing.rollbackReturnsSnapshot` | `true` | not in §1.2 | |
| `identity.threadIds` | `"strong"` | not in §1.2 | Pi's session id. |
| `identity.turnIds` | `"weak"` | not in §1.2 | §1.2's ID row has weak for Pi turns too. |
| `identity.itemIds` | `"weak"` | not in §1.2 | §1.2's ID row has strong for Pi items. Pi's message events carry no entry id (Pi docs json.md), so messages are named by position; tool calls keep Pi's ids. |
| `identity.requestIds` | `"strong"` | not in §1.2 | Pi's extension UI request id. |
| `identity.identityVersion` | `1` | not in §1.2 | |
| `runtimePolicy.modes.read_only.supported` | `true` | not in §1.2 | |
| `runtimePolicy.modes.read_only.enforcement` | `"client_boundary"` | not in §1.2 | §1.2 has "not in literal": Pi asks no approval before tool calls (Pi docs security.md), and permission gates are extensions (Pi docs extensions.md, the `permission-gate.ts` example uses `on("tool_call")` and `ui.select`), so ARI's bridge enforces every mode. |
| `runtimePolicy.modes.approval_required.supported` | `true` | not in §1.2 | |
| `runtimePolicy.modes.approval_required.enforcement` | `"client_boundary"` | not in §1.2 | |
| `runtimePolicy.modes.auto_accept_edits.supported` | `true` | not in §1.2 | |
| `runtimePolicy.modes.auto_accept_edits.enforcement` | `"client_boundary"` | not in §1.2 | |
| `runtimePolicy.modes.auto.supported` | `false` | not in §1.2 | Pi has no automatic approval classifier. |
| `runtimePolicy.modes.auto.enforcement` | `"client_boundary"` | not in §1.2 | |
| `runtimePolicy.modes.full_access.supported` | `true` | not in §1.2 | |
| `runtimePolicy.modes.full_access.enforcement` | `"client_boundary"` | not in §1.2 | |
| `runtimePolicy.interactionModes` | `["default"]` | not in §1.2 | Pi has no plan mode. |
| `runtimePolicy.switchInSession` | `false` | not in §1.2 | |
| `requests.responseModes` | `["live"]` | not in §1.2 | |
| `requests.allowCustomAnswer` | `false` | not in §1.2 | |
| `requests.approvalScopes` | `[{"decision":"accept","scope":"once"},{"decision":"accept_for_session","scope":"session"}]` | not in §1.2 | "For the session" lasts as long as the Pi process. |
| `background.list` | `false` | not in §1.2 | Pi has no background tasks over RPC (Pi docs rpc-commands.md). |
| `background.stop` | `false` | not in §1.2 | |
| `background.await` | `false` | not in §1.2 | |
| `background.tasksEndWithProcess` | `true` | not in §1.2 | |
| `mcp.acceptsHostServers` | `["stdio","http"]` | not in §1.2 | Pi rejects the legacy SSE transport (Pi docs mcp.md). |
| `mcp.scope` | `"thread"` | not in §1.2 | Registered per Pi process, one per thread. |
| `sessionModel` | `"process_per_thread"` | not in §1.2 | |
| `externallyOwned` | `false` | not in §1.2 | |
| `diffs.emits` | `false` | not in §1.2 | |
| `diffs.canDisable` | `false` | not in §1.2 | |
| `contextWindowReporting` | `true` | not in §1.2 | From `get_available_models`. |
| `extensions` | `[]` | not in §1.2 | |

## Optional members

Of the 42 optional `Session` and `Instance` members, the driver implements
`readSnapshot`, `forkThread`, `rollbackThread`, `compactThread`,
`unloadThread`, `contextWindow` and the `auth` group. `auth.complete` rejects
with `unsupported{capability: "auth.complete"}`, because no Pi sign-in returns
through a callback URL. Every other optional member is left out.
`test/drivers/pi/capabilities.test.ts` holds the full list.

## Limits

- The driver uses `node:fs` on the machine that runs it: to write the bridge
  file, and on a resume to read `<stateDir>/sessions` (real paths, the
  directory listing and file headers). A host that delegates `host.process`
  to another machine must make the same paths exist there.
- A server in the user's own `mcp.json` with the same name as a host server
  takes precedence over the bridge's registration (Pi docs mcp.md).
- Pi does not lock session files, so two processes can open one session; the
  driver never does that itself.
- A session file outside `<stateDir>/sessions`, such as one the user's own pi
  keeps under `~/.pi`, cannot be resumed (see "How it runs Pi").
- A thread without messages whose process exited on its own, before the
  driver could send `/ari-persist`, cannot start again: Pi never wrote its
  session. Its next use fails with `not_found`.
- The real-path check runs before Pi starts; a link changed between the
  check and Pi opening the file is not caught.
