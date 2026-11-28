# The `claude` driver

`ari/drivers/claude` runs the user's own Claude Code through the Claude Agent
SDK (`@anthropic-ai/claude-agent-sdk`). `ari/meta/claude` holds what a host
shows before loading it: the label, the icon, the config schema with form
hints and the tested versions.

## Install

The driver needs two things: the user's own Claude Code, and the SDK. ARI
installs neither. The user installs Claude Code. Under Node the user or the
host installs the SDK; the standalone `ari-driver` includes it.

### Claude Code: the user's own `claude`

ARI never downloads or ships Claude Code, and never runs a Claude Code that
npm installed beside the SDK. Every query runs the user's `claude`:
the config's `executablePath` when set (a name looked up on the host's
`PATH`, or a path), else `claude` on the host's `PATH`, both found through the
host's `process.resolveExecutable`. The driver passes it to the SDK as
`pathToClaudeCodeExecutable`. This holds wherever the SDK comes from: an npm
install under Node, or the SDK compiled into the standalone `ari-driver`.

It must be Claude Code **2.1.330** or newer (`CLAUDE_TESTED_CLAUDE_CODE_VERSION`
in `ari/meta/claude`), the Claude Code the pinned SDK bundles: the SDK's
`sdk.d.ts` requires "the Claude Code bundled with this SDK or newer" of an
app that starts its own Claude Code. The driver reads the version with
`claude --version`, which prints for example `2.1.330 (Claude Code)`, and
reads it again whenever the file changes, so `claude update` shows at the
next `status()` without a restart. `status()` and `probe()` then report:

| What the driver finds | `status()` | The message |
|---|---|---|
| no `claude` on `PATH` | `driver_unavailable`, `binary: "claude"` | `Claude Code is not installed: no claude executable was found on PATH.`, then how to install it (`curl -fsSL https://claude.ai/install.sh \| bash` on macOS, Linux and WSL, `irm https://claude.ai/install.ps1 \| iex` in Windows PowerShell, https://code.claude.com/docs/en/setup) or to set `executablePath` |
| an `executablePath` that names no executable file | `driver_unavailable`, `binary` the configured value | `Claude Code is not installed at the configured executablePath: ...`, then the same steps |
| a `claude` older than 2.1.330 | `driver_unavailable`, `binary` its path | `Claude Code 2.1.319 at /path/to/claude is older than 2.1.330, the oldest version this driver runs (...)`, then how to update it (`claude update`, or the upgrade command of the package manager that installed it) or to set `executablePath` |
| a `claude` whose `--version` prints no version, fails or cannot start | `driver_unavailable`, `binary` its path | `The version of the Claude Code at /path/to/claude cannot be read: ... exited with code 127 and printed "..."`, then the install steps |
| Claude Code 2.1.330 | ready | |
| a newer Claude Code | ready, with an `untested_version` advisory | `Claude Code 2.2.0 at /path/to/claude is newer than 2.1.330, the version this driver is tested against: it runs, but this version is untested.` |

In each unavailable case `openSession` rejects with the same error before any
Claude Code session starts. `maintenance.advisory()` gives the same advisory
as `status()`. ARI does not update Claude Code for the user.

### The SDK under Node

The SDK is an optional peer of `ari`:

```sh
npm install ari @anthropic-ai/claude-agent-sdk
```

The driver is tested against SDK **0.3.330**, which bundles Claude Code
**2.1.330** (`CLAUDE_TESTED_VERSIONS` is `>=0.3.330 <0.3.331`). The peer
range is `^0.3.330`. Another SDK version works, and `status().advisory` says
it is untested.

npm also installs the SDK's native Claude Code package
(`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, an optional dependency).
The driver never runs it; `npm install --omit=optional` leaves it out and
loses nothing.

### Without Node: the standalone `ari-driver`

The standalone `ari-driver` executable (built with `bun build --compile`)
cannot import a package by name: Bun resolves a bare specifier against the
executable's embedded file system, never against a `node_modules` on disk.
So it includes the SDK: `scripts/build-binary.ts` compiles the pinned
`@anthropic-ai/claude-agent-sdk` 0.3.330 (the lockfile's install) into it and
hands the `claude` driver a loader over that copy. The `claude` driver there
needs no SDK install and no config. `status()` reports the SDK version
0.3.330, and every query runs the user's `claude` as above.

The executable holds only the SDK's JavaScript, its `sdk.mjs`. It holds none
of the SDK's 8 platform packages (`@anthropic-ai/claude-agent-sdk-<platform>`,
its optional dependencies, each a copy of Claude Code, 381 MB on linux-x64)
and no Claude Code at all. The SDK's `sdk.mjs` does not import those
packages: it resolves one at run time, with `createRequire(...).resolve()` of
a template string, and only when `pathToClaudeCodeExecutable` is unset, which
the driver never leaves it. The bundler cannot follow that, and the build
also marks the 8 packages `--external`. The other vendor SDKs stay out of the
executable.

**Checked against the real Claude Code.** `ARI_LIVE_RECORD=1 node
scripts/live-claude-standalone.ts --no-turn` (after `pnpm run build:binary`)
runs the standalone `ari-driver` with no `node` or `bun` on `PATH`: it loads
the compiled-in SDK and prints `instance/status` without spending quota. To run the fixed `haiku` smoke
prompt on your Claude sign-in, replace `--no-turn` with `--attempt-dir`
and the path to a private scratch directory. Reuse that directory when
resuming; an interrupted attempt cannot be repeated. A separately verified
temporary CLI can be put on the isolated `PATH` with `--claude <path>`.
After an exact `ok` reply, `--driver-death` runs the separate second check.
The harness keeps the session apart from your
Claude setup as the recorder does (see [docs/recordings.md](../recordings.md)),
with the same handling of a refreshed sign-in, and fails when your
`settings.json`, `CLAUDE.md`, `~/.claude.json` or installed Claude executable changed. Without
`ARI_LIVE_RECORD=1` it exits 2 before it loads the driver or starts a process.
The [standalone issue's live follow-up](../issues/2026-11-25-standalone-ari-driver-cannot-run-claude.md#resolution)
records a completed `ok` turn with an external Claude Code and a separate
check in which Claude Code and its process group ended after the driver died.

The Claude Agent SDK builds the command and exchanges messages over stdin
and stdout. ARI starts that command through the host process service, including
for catalog and text generation queries. Local wire sessions inherit the same
process-group cleanup as other standalone drivers; a delegated host owns
its Claude Code processes instead.

**The SDK's terms, and where its code is.** The SDK is © Anthropic PBC, and
its use is subject to Anthropic's legal agreements
(https://code.claude.com/docs/en/legal-and-compliance); it is not under
ARI's MIT License. The standalone `ari-driver` includes it, so each GitHub
release attaches `THIRD-PARTY-NOTICES.md` beside the binaries, which says
so. The npm package holds none of the SDK's code: there the SDK stays an
optional peer, because as a regular dependency npm would also install the
platform's 381 MB Claude Code package for every user of `ari`.
`check:package` checks the npm tarball for `CLAUDE_CODE_SDK_READS_SESSION_STATE`,
a string unique to the SDK's `sdk.mjs`, and
`test/standalone/claude-sdk.e2e.ts` checks the executable has it and none of
Claude Code.

## How the driver runs Claude Code

- **Loading.** Importing the driver or its metadata loads no vendor code and
  spawns nothing; `create()` only reads whether the instance keeps an API key.
  The first `status()`, `probe()`, `catalog.list()` or `openSession()` loads
  the SDK with a dynamic `import()`, finds the user's `claude` and runs its
  `--version`. `probe()` runs nothing else; a deep probe also runs `claude
  auth status --json`.
- **The user's Claude Code.** Every query, of a thread, the catalog or text
  generation, passes the user's `claude` as `pathToClaudeCodeExecutable` and
  sets `mcpServersDelivery: "initialize"`, the mode `sdk.d.ts` recommends for
  an app that starts its own Claude Code at or above the bundled version: any
  MCP server in `Options.mcpServers` would reach Claude Code in the
  initialize request over stdin, never on its command line, and the SDK's
  `CLAUDE_SDK_MCP_SERVERS_ARGV_DEPRECATED` warning never fires. The driver
  itself gives a thread's MCP servers through `setMcpServers`, also over
  stdin. Naming the executable has one SDK effect the driver cannot change:
  a resume starts Claude Code without `--await-initialize`, which the SDK
  adds only for the Claude Code it finds itself.
- **Missing runtime.** Under Node without the SDK, `status()` and `probe()`
  report `installed: false` with a `driver_unavailable` error naming
  `@anthropic-ai/claude-agent-sdk`, and `openSession` rejects with it. The
  message says ARI does not install the SDK and names
  `npm install @anthropic-ai/claude-agent-sdk@0.3.330` next to ari. The
  standalone `ari-driver` always has the SDK. A missing, unreadable or too
  old Claude Code is reported as the table above says.
- **One query per thread.** Each thread is one Claude session run by one
  `query()` in streaming input mode, so one Claude Code process per thread
  (`sessionModel: "process_per_thread"`). A session holds any number of
  threads.
- **Ids.** The driver picks each new thread's Claude session id (a UUID, the
  `sessionId` option) and each prompt's uuid, through `crypto.randomUUID()`
  by default (`createClaudeDriver({ newUuid })` replaces it). Claude keeps
  both in its transcript. Thread ids derive from the session id, turn ids
  from the prompt's uuid, item ids from the API message id and block index or
  the `tool_use` id, request ids from the `canUseTool` request id, and task
  and subagent ids from Claude's task id. A turn Claude starts on its own
  (after a background task finishes) has no prompt of ours and uses an
  ordinal and the first frame's uuid (`turnIds: "weak"`).
- **Environment.** `Options.env` replaces Claude Code's whole environment.
  It is the instance's `environment` as the host gives it, credentials such
  as `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`
  included, minus only what the host's `envPolicy.stripAmbient` names. The
  instance's own API key, when it has one, replaces `ANTHROPIC_API_KEY`, and
  then the driver leaves out `ANTHROPIC_AUTH_TOKEN`, which Claude Code would
  use first (Claude Code docs, "Authentication precedence"). The driver adds
  `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` (a refused resume then comes back
  as a result naming the reason). `claude --version` and `claude auth status
  --json` run with `inheritEnv: false` in exactly this environment, so the
  checks and the queries see the same variables and nothing of the host
  process's own environment.

## Turns

- A turn starts with a prompt and settles only on Claude's `result` message,
  on Stop, or when the process dies. There is no quiet timer.
- **Steer** is a prompt with `priority: "now"`. Claude ends the running native
  turn (`terminal_reason` `aborted_streaming` or `aborted_tools`) and reads the
  steer next. The host's turn spans both native turns and settles on the
  result whose `user_message_uuids` holds the steer
  (`turns.steeringInterruptsTools` and `turns.multiNativeTurnsPerRequest`).
  A steer for a turn the driver knows has ended returns `prompt_required`.
- **Queue** is a prompt with `priority: "later"`: Claude holds it until the
  running turn ends and then starts it. The queued turn is reported `pending`
  until then.
- **Stop** calls `Query.interrupt()`; `restartRuntime: true` closes the query
  instead. Either way the turn ends `interrupted`, and the next turn resumes
  the session.
- **Process exit** ends the turn `failed` with `transport_error` and
  `threadDisposition: "reusable"`: the next turn resumes the session in a new
  process. Background tasks end with the process.
- **Failures.** A rejected rate limit, an assistant `rate_limit` error or an
  API 429 is `usage_limit`, with `resetAt` from the rate limit event's
  `resetsAt`. `authentication_failed` and its relatives, or a 401/403, are
  `permission_error`, and also poison the instance's auth scope for 30
  seconds. `invalid_request` and `model_not_found` are `validation_error`;
  the rest are `provider_error`.

## Requests

Permission prompts come through `canUseTool` and wait as `live` requests
(`survivesRestart: false`) until `respond`. Claude's answers carry no option
ids, so the driver names each option after the answer it sends:

| Option id | Decision | Scope | Claude gets |
|---|---|---|---|
| `allow` | `accept` | `once` | `{ behavior: "allow" }` |
| `allow:session` (or `allow:cliArg`) | `accept_for_session` | `session` | `allow` with the suggestions that persist for the session |
| `allow:localSettings`, `allow:projectSettings` | `accept_always` | `project` | `allow` with the suggestions for that settings file |
| `allow:userSettings` | `accept_always` | `global` | `allow` with the suggestions for the user's settings |
| `deny` | `decline` | | `{ behavior: "deny", message }` (the host's `feedback`, if any) |
| `deny:interrupt` | `cancel` | | `deny` with `interrupt: true` |

Claude's `suggestions` are grouped by where they persist; each group is one
option whose scope is that destination's real reach. When Claude sets
`suppressAlwaysAllowRule`, only session-scoped suggestions are offered. An
`AskUserQuestion` call is a `user_input` request: questions `q0`, `q1`, ...,
option ids are Claude's labels, and the answers go back as
`updatedInput.answers`. A prompt raised inside a subagent names it in
`origin.subagentId`. A prompt forced by an ask rule carries
`fullAccessOverride: "ask_rule"`. Under `full_access` the session runs in
`bypassPermissions`, so Claude asks only for ask rules. Every other call runs
without `canUseTool` (SDK reference, `Options.canUseTool`: "Not invoked for
calls auto-approved by ... `permissionMode`"), so no request and no reply
exist for it.

## Host instructions and MCP servers

- `launch.appendSystemPrompt`, `launch.developerPrompt` and the thread's
  `context.system` and `context.developer` go into the `claude_code` system
  prompt's `append` (channel `system`), with `snapshot: false`, so Claude Code
  never records them in its transcript and a resume can carry new ones.
- A turn's `context.system`, `context.developer` and `context.synthetic` lead
  the turn's prompt as text blocks (channel `first_user_message`). They are
  part of the prompt, so the transcript keeps them.
- Without either, the driver passes Claude Code's own `claude_code` preset
  with nothing appended, and the prompt holds only the host's content.
- MCP servers: the session's and thread's `launch.mcpServers`, plus the
  server `hostTools.mcpServerFor(threadId, { transport: "http" })` returns,
  under exactly the names the host gave, through `Query.setMcpServers` right
  after the process starts and before the first prompt. `alwaysLoad` is kept,
  so tool search does not defer those tools. A resume of a live thread with a
  new `launch` replaces them the same way. Claude Code's stdio config has no
  working directory, so a stdio server with `cwd` is refused.
- A running query cannot change its system prompt. A resume of a live thread
  whose new `launch` changes the append therefore ends the running query and
  starts one with `resume` (or, for a session that has no message yet,
  `sessionId` again), which carries the new append. While the thread has a
  turn, a queued turn, a pending request or a background task, that would end
  them, so the resume rejects with `invalid_state` and changes nothing. A
  `launch` that keeps the append keeps the query.
- Nothing from `LaunchContext` is written to a file: MCP servers travel over
  the control channel, and the append is not recorded.

## Threads

- `createThread` starts the thread's query at once (`threads.createEmpty`).
- `resumeThread` checks the session with `getSessionInfo`. A missing session,
  or one Claude Code refuses to resume (`startup_failure_reason`
  `session_held_by_background`), is replaced by a fresh session in the
  policy's directory, with `session.replaced` (`contextLost: true`). Claude
  Code writes a transcript only once a session holds a message, so a thread
  that never ran a turn cannot be resumed and is replaced too. A resume
  replays the stored turns as events unless `quiet`.
- A resume of a live thread applies a new `model` and `effort` to the running
  query with `setModel` and `applyFlagSettings`, and a new policy's
  permission mode with `setPermissionMode`; `appliedConfig` reports only
  what the query took. A resume with `purpose: "history"` changes nothing and
  reports what the thread runs with.
- `forkThread` starts a query with `resume` (the source), `forkSession: true`,
  `sessionId` (the fork) and, for a fork from a turn, `resumeSessionAt` set to
  the last transcript entry of that turn (the fork keeps the turn). Claude
  keeps transcripts per project directory, so a fork stays in its source's
  directory (`crossCwd: false`).
- `readSnapshot` reads the transcript with `getSessionMessages`. Steers this
  session sent belong to the turn they steered; a steer sent by an earlier
  session reads as a turn of its own. A local command such as `/goal` reads
  as the command the user typed; the rows Claude Code writes around it (its
  caveat and its output) are not turns.
- `unloadThread` and `release()` close queries; the next turn resumes the
  session. `canRelease()` is false while a turn, a queued turn, a pending
  request or a background task runs.
- Directories are resolved to their real path, so a path through a symbolic
  link names the same thread.

## Resuming conversations ARI did not create

The driver resumes any Claude Code session the host names, including one
started outside ARI and every session `nativeSessions.list` returns.
`resumeThread` looks the session up with the SDK's `getSessionInfo` and
resumes it with `query({ options: { resume } })`, carrying only the
LaunchContext the host passed: its instructions as the system prompt's
`append` (not recorded in the transcript) and its MCP servers through
`Query.setMcpServers` under the names the host chose. Nothing is written to
Claude Code's settings or other files. A session Claude Code has no record of,
or refuses to resume because another process holds it, is replaced by a fresh
session with `session.replaced` (`contextLost: true`) when the host passed
`policy`, and rejects with `not_found` otherwise.

## Capabilities against the proposal's §1.2 Claude column

| Capability | §1.2 | Driver | Source for a difference |
|---|---|---|---|
| Switch model mid-session | Y | Y (`sessions.switchModel`) | |
| Switch runtime mode mid-session | – | Y (`sessions.switchRuntimeMode`, `runtimePolicy.switchInSession`) | `Query.setPermissionMode` (Agent SDK TypeScript reference, Query object) |
| Read thread snapshot | – | Y | `getSessionMessages()` (Agent SDK TypeScript reference, Functions) |
| Roll back thread | Y | – | `resumeSessionAt` keeps messages "up to and including" one uuid (SDK `Options.resumeSessionAt`), so rolling back to the start, which `rollbackThread` must serve, has no native form |
| Fork thread / fork from a turn | Y/Y | Y/Y | |
| Fork from an item | (not in §1.2) | – | |
| Fork from a subagent thread | – | – | |
| Fork into another directory | (not in §1.2) | – | `listSessions({ dir })`: sessions are stored per project directory |
| Steer an active turn (stops pending tools) | Y | Y, `steeringInterruptsTools: true` | |
| Queued messages / interrupt | Y | Y/Y | |
| Streams tool output | – | – | |
| Streams plan text | – | – | |
| MCP tools | Y | Y | |
| Dynamic tool callbacks | Y | – | In-process tools need `createSdkMcpServer` with zod-typed `tool()` definitions or an `McpServer` from `@modelcontextprotocol/sdk` (Agent SDK reference, `createSdkMcpServer`); the driver does not build one, and refuses `launch.dynamicTools` |
| MCP apps | (not in §1.2) | – | `Query.readMcpResource` reads only `ui://` resources and the SDK has no tool-call method (SDK `Query`) |
| Command / file-change approval | Y | Y | |
| File-read approval | Y | Y | |
| Approvals from subagents | – | Y | `CanUseTool` options carry `agentID` "if running within the context of a sub-agent" (SDK `CanUseTool`) |
| Structured questions | Y | Y | |
| Todo list / proposed plan | Y/Y | Y/Y | |
| Subagents / exposes child thread ids | Y/– | Y/– | |
| Wait for / close subagents | –/– | –/Y | `Query.stopTask(taskId)` stops a running task, and a subagent is a task (`task_started` with `task_type: "local_agent"`) |
| Accepts system / developer context | Y/Y | Y/Y, through `system` and `first_user_message` | |
| Can generate summaries | Y | – (`context.summaries`) | No SDK call summarizes a conversation; `textGeneration` covers text from host input |
| Native turn / item / request id strength | weak/strong/strong | weak/strong/strong | |
| Policy enforcement | native | native | |
| Read-only runtime mode | (not in §1.2) | – | `PermissionMode` has no read-only mode (`default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto`) |
| Background tasks list / stop / await | (not in §1.2) | Y/Y/Y | `task_started` and `task_notification` messages, `Query.stopTask` |

Runtime modes map to permission modes: `approval_required` to `default`,
`auto_accept_edits` to `acceptEdits`, `auto` to `auto`, `full_access` to
`bypassPermissions` (the driver sets `allowDangerouslySkipPermissions` so a
live thread can switch to it), and the `plan` interaction mode to `plan`.

## The 42 optional members

`test/drivers/claude/capabilities.test.ts` lists each with its outcome and
exercises every supported one against the fake SDK.

| Member | Outcome | Why, when left out |
|---|---|---|
| `Session.readSnapshot`, `forkThread`, `unloadThread`, `backgroundTasks.list`, `.stop`, `.await`, `stopSubagent`, `ext` | supported | |
| `Session.rollbackThread` | absent | No native rollback to the start (above) |
| `Session.compactThread` | absent | The SDK has no compaction call; `/compact` is a prompt the host can send |
| `Session.injectHistory` | absent | The SDK has no history injection |
| `Session.mcpApps.*` | absent | See MCP apps above |
| `Session.contextWindow`, `canReuseContextUsage` | absent | `ModelInfo` reports no context window |
| `Session.uploadFeedback` | absent | The SDK has no feedback upload |
| `Instance.invalidateCaches`, `maintenance.advisory`, `auth.methods`, `.state`, `.reportRuntimeFailure`, `.start`, `.respond`, `.cancel`, `.logout`, `catalog.refresh`, `limits.current`, `.accountKey`, `textGeneration.generate`, `nativeSessions.list`, `.delete`, `.archive` | supported | |
| `Instance.auth.complete` | rejects `unsupported{auth.complete}` | Sign-in runs in `claude auth login`; no callback comes back |
| `Instance.auth.transferProfile`, `.transferSession` | absent | Claude has no credential handover |
| `Instance.workspace.snapshot` | absent | Commands and skills come only from a running query |
| `Instance.limits.consumeResetCredit` | absent | The SDK has no reset credits |
| `Instance.usageHistory.scan` | absent | The SDK keeps no usage history |
| `Instance.subProviders.*` | absent | Claude has no sub-providers |

## Account, catalog and limits

- **Auth.** A managed profile is an Anthropic API key the instance stores in
  the host's secrets (`claude/api-key`, through `auth.start` and
  `auth.respond` with method `api-key`); it is `configured`. Otherwise the
  ambient sign-in is what `claude auth status --json` says: `loggedIn: true`
  is `authenticated`, `false` is `unauthenticated`, a cloud `apiProvider`
  (Bedrock, Vertex, ...) is `unknown`, and a failed check is `unavailable`.
  Method `claude-login` tells the user to run `claude auth login`.
  `auth.logout` removes the instance's key; the ambient sign-in belongs to the
  user. A runtime auth failure poisons the failing scope for 30 seconds.
- **Probe.** `probe()` loads the SDK, finds the user's `claude` and runs
  `claude --version`; `probe({ deep: true })` also runs `claude auth status
  --json`. Nothing else.
- **Catalog.** `Query.supportedModels()` from a query that loads no settings,
  MCP servers or tools, persists nothing and is closed at once; cached until
  `catalog.refresh()` or `invalidateCaches()`.
- **Limits.** Rate limit events (`rate_limit_event`) update the instance's
  windows (`five_hour` is `5h`, `seven_day` is `weekly`, `overage` is
  `credits`, others are `x:claude.<type>`) and each session emits
  `limits.updated`.
- **Text generation.** A one-turn query with `tools: []`, no MCP servers, no
  settings files and nothing persisted (`toolsDisabled: "native"`); with a
  schema, `outputFormat` returns `structured_output`.
- **Native sessions.** `listSessions({ dir })` (50 per page; the cursor is the
  offset), `archiveSession` and `deleteSession`. These SDK functions run in
  the host's process and read the Claude config directory that process's
  environment names (`CLAUDE_CONFIG_DIR`, by default `~/.claude`).

## Extensions

Each is listed in `capabilities.extensions` with version `1`. Payloads are in
`spec/v1/extensions/claude.schema.json` and `ari.goal.schema.json`.

- **`claude.hooks`.** `ext("claude.hooks", "set", { threadId, hooks })` sets
  command hooks for the thread's live query with `Query.applyFlagSettings`
  (`null` removes them). The driver runs every query with
  `includeHookEvents`, and each hook message becomes an `x:claude.hook`
  event (`phase` `started`, `progress` or `response`).
- **`claude.fileCheckpoints`.** Every query runs with
  `enableFileCheckpointing`. `ext("claude.fileCheckpoints", "rewind", {
  threadId, turnId, dryRun? })` calls `Query.rewindFiles` with the turn's
  prompt uuid and returns Claude's answer.
- **`ari.goal`** (derived). Claude's SDK mode has no goal call. The driver
  reads the goal only from what Claude Code confirms in the transcript
  (`getSessionMessages`). Claude Code records a `/goal` prompt as a tagged
  command row and its answer as a tagged `<local-command-stdout>` row:
  `Goal set: <condition>` sets the goal and `Goal cleared: <condition>`
  clears it; a refusal (a condition over 4000 characters, for example) or a
  status answer changes nothing. A `SetGoal` call sets the goal only when its
  result says "The goal is set"; with `ask_user` (the tool's default) it only
  proposes the goal to the user. Prompts after the goal was set are turns of
  the goal run (`turnIds`). After a turn that ran `/goal` or called `SetGoal`
  ends, the driver reads the transcript again and emits
  `x:ari.goal.updated` (thread-level, `derived: true`) when the goal was set,
  replaced or cleared. `ext("ari.goal", "get", { threadId })` reads it from
  the transcript. `set` and `clear` are `unsupported`: the host sends
  `/goal ...` as a turn.

## Known limits

- **A steer that races the end of its turn.** Claude Code has no refusal for
  a late steer: a prompt that reaches an idle session starts a new turn. When
  the turn ends after the driver last heard from it but before the steer
  arrives, the steer runs as a further native turn inside the host's turn
  instead of returning `prompt_required`. The conformance harness gives this
  reason for the kit's `steer-after-end.race` check.
- **`ari.goal` through `ext`** is computed by the driver, so the conformance
  kit's check that an extension call reaches the agent does not apply to it
  (`capability-honesty.ext.ari.goal`).
- **The `full_access` reply.** Under `full_access` Claude Code asks for no
  ordinary approval, so the kit's check of the narrowest `full_access` reply
  has nothing to check (`idempotent-responses.full-access`).
- **A goal Claude Code records as a system row.** Claude Code 2.1.330 can
  also record a local command's output as a `system` row of subtype
  `local_command`. The pinned SDK's `getSessionMessages` drops that row's
  content (and returns the row only with `includeSystemMessages`), so a goal
  confirmed only there is not visible to the driver, which then reports no
  goal rather than guess one from the prompt.
- **Pending requests** die with the query: `canUseTool` is a live callback.

## Tests

`test/drivers/claude/` holds the fake SDK (`fake-sdk.ts`, typed by the
pinned SDK), the type-level proof that the driver's own SDK types match the
SDK (`sdk-types.ts`, which `sdk-types.test.ts` also compiles with planted
mistakes to show each is caught), the conformance harness and suite, and the tests for
the driver's quirks, launch context, availability, capability honesty and
metadata. `SOURCES.md` lists the vendor sources and pinned versions.

`user-claude-code.test.ts` gives the driver a fake SDK on disk
(`fixture-sdk/sdk.mjs`, plain JavaScript like the real `sdk.mjs`, laid out by
`sdk-fixture.ts`) through its loader, with a decoy native package beside the
SDK, and a fake of the user's `claude` (a shell script on the host's `PATH`
that logs each invocation): a `claude` that is older, missing, unreadable or
newer, and a `claude update` that shows at the next `status()`.
`availability.test.ts` hides the SDK from Node's resolver and checks the
message names the npm command. `npm-sdk.test.ts` runs the `claude` cases
under Node with the SDK imported by name (a module hook points the name at
the fake), and checks a turn runs the user's `claude` or `executablePath`
and never the decoy. `real-sdk-launch.test.ts` has the pinned SDK's own
`sdk.mjs` start a fake `claude` for a session with an MCP server: no
deprecation warning, the exact launch arguments, and the server over stdin.
`test/standalone/claude-sdk.e2e.ts` runs the standalone `ari-driver` with no
`node` or `bun` on `PATH`, no config and no SDK on disk: a turn completes
through the compiled-in SDK on a fake `claude` that speaks the SDK's
stream-json protocol in shell built-ins, and with `executablePath`; an older
or missing `claude` is refused; Claude Code and its group end when
`ari-driver` is killed; and the executable holds the SDK's code and none of
Claude Code. The turn and kill cases run again through `ari-driver` under
Node, with the SDK's name resolved to a copy of the pinned `sdk.mjs` beside
a decoy.

`replay.test.ts` and `recorder.test.ts` cover the native recorder
(`pnpm run record:claude`): they record the six recording scenarios from the
fake SDK, replay them through a fresh driver, and check the recorder keeps the
user's Claude setup out. `credential-copy-back-node.test.ts` (Node only) has
another Claude Code session save a refresh at the moment between the
copy-back's comparison of the user's `.credentials.json` and its replace,
and while it holds Claude Code's write lock; no refresh is lost.
[docs/recordings.md](../recordings.md) describes the format and says how to
record against the real Claude Code.
