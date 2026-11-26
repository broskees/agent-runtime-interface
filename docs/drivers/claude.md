# The `claude` driver

`ari/drivers/claude` runs Claude Code through the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`). `ari/meta/claude` holds what a host shows
before loading it: the label, the icon, the config schema with form hints and
the tested versions.

## Install

The SDK is an optional peer of `ari`:

```sh
npm install ari @anthropic-ai/claude-agent-sdk
```

The driver is tested against SDK **0.3.330**, which bundles Claude Code
**2.1.330** (`CLAUDE_TESTED_VERSIONS` is `>=0.3.330 <0.3.331`). The peer
range is `^0.3.330`. Another SDK version works, and `status().advisory` says
it is untested.

The SDK carries the native Claude Code binary in a platform package
(`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, an optional dependency).
A package manager that skips optional dependencies leaves it out.

### Without Node: the standalone `ari-driver`

The standalone `ari-driver` executable (built with `bun build --compile`)
cannot import a package by name: Bun resolves a bare specifier against the
executable's embedded file system, never against a `node_modules` on disk.
So `npm install` next to it does not help. A host that ships only the
executable provides the SDK in one of two ways:

- **`maintenance.install`** (or `maintenance.update`) on the instance
  downloads SDK **0.3.330** (`CLAUDE_SDK_VERSION`) and the native package for
  the host's platform (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`, glibc
  before musl on Linux, the order the SDK itself uses) from an npm registry,
  `https://registry.npmjs.org` unless the config's `sdkRegistry` names
  another. It needs no Node and no `npm`. The result is one directory, laid
  out as npm lays the SDK out:

  ```
  <cacheDir>/adapters/@anthropic-ai/claude-agent-sdk/0.3.330/
    package.json, sdk.mjs, ...                                the SDK
    node_modules/@anthropic-ai/claude-agent-sdk-<os>-<arch>/  its native binary
    .ari-install.json                                         each file's size, mode and sha256
  ```

  So the SDK finds its native binary by itself, exactly as in an npm install,
  and the driver never names it in `pathToClaudeCodeExecutable`. Naming it
  would change two SDK defaults: a resume would start Claude Code without
  `--await-initialize`, and MCP servers given in `Options.mcpServers` would
  draw the `CLAUDE_SDK_MCP_SERVERS_ARGV_DEPRECATED` warning. `ari/node`'s
  installer publishes the directory with one rename, under a lock per
  version, so it holds both packages or neither, and two installs at once
  end with one whole install.
- **Integrity.** The install accepts only a `dist.integrity` in sha512,
  sha384 or sha256 (the W3C Subresource Integrity algorithms; npm publishes
  sha512), and when several are listed the strongest decides. A manifest
  that offers only a sha1 integrity or the sha1 `shasum`, or no digest, is
  refused with `protocol` / `no_integrity`. Both tarballs are downloaded and
  checked before either is unpacked, so a tarball that does not match
  (`protocol` / `integrity_mismatch`) leaves nothing installed. What is
  unpacked is exactly what was checked: each download is checked again
  against the digest taken while it was verified, just before unpacking and
  once more as its bytes stream into the extractor.
- **Repair.** `.ari-install.json`, written before the directory is
  published, lists every file with its size, permission bits and sha256.
  Loading the SDK checks that every listed file is there with its size and
  every execute bit it was installed with, and the sha256 of the SDK's own
  files, the JavaScript the driver imports; the 381 MB native binary is
  checked by size and mode only. An install that fails the check (a missing
  `sdk.mjs`, a missing or truncated binary, a binary that lost its execute
  permission, a changed `sdk.mjs`, no record, or a record without modes,
  which installs before modes were recorded have) is reported unavailable
  with `Run maintenance.install on this instance to repair it, or set
  sdkDirectory in the driver config ...`.
  `maintenance.install` checks every file's sha256, so it also finds a
  same-size change to the binary, and reinstalls a directory that is not
  whole. A whole install is not downloaded again; `update` installs the
  version this driver pins, which a newer ARI may have moved. Nothing
  removes older versions yet.
- **`sdkDirectory`** in the driver config names a directory where
  `npm install @anthropic-ai/claude-agent-sdk` ran (for example
  `npm install --prefix /opt/claude-agent-sdk @anthropic-ai/claude-agent-sdk`,
  then `sdkDirectory: "/opt/claude-agent-sdk"`). The driver loads
  `<sdkDirectory>/node_modules/@anthropic-ai/claude-agent-sdk` from there.

Either way the driver imports the SDK's entry module by its file URL. The
SDK's `sdk.mjs` imports only Node built-ins (it bundles everything else; its
peers `zod`, `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` serve its
type declarations), so the SDK and its native package are all it needs. The
driver looks in this order: `sdkDirectory`, then a managed install, then the
package by name (under Node). Under Node all three work.

**Why ARI does not bundle the SDK.** The SDK's licence is Anthropic's
("SEE LICENSE IN README.md", Anthropic's legal agreements), not MIT. ARI
redistributes none of it: the npm tarball and the standalone executable hold
no SDK code, and `check:package` and `test/standalone/claude-sdk.e2e.ts`
check both for `CLAUDE_CODE_SDK_READS_SESSION_STATE`, a string unique to the
SDK's `sdk.mjs`. The user's machine downloads the SDK from the npm registry,
as `npm install` would.

## How the driver runs Claude Code

- **Loading.** Importing the driver or its metadata loads no vendor code and
  spawns nothing; `create()` only reads whether the instance keeps an API key.
  The first `status()`, `probe()`, `catalog.list()` or `openSession()` loads
  the SDK with a dynamic `import()` and finds the native binary the way the
  SDK does (its platform packages, glibc before musl on Linux).
- **Missing runtime.** Without the SDK, `status()` and `probe()` report
  `installed: false` with a `driver_unavailable` error naming
  `@anthropic-ai/claude-agent-sdk`, and `openSession` rejects with it. Under
  Node the message names `npm install @anthropic-ai/claude-agent-sdk`,
  `maintenance.install` and `sdkDirectory`; in the standalone `ari-driver`
  (recognized by its modules' `/$bunfs/` or `B:/~BUN/` URLs) it names only
  `maintenance.install` and `sdkDirectory`, the two steps that work there. A
  `sdkDirectory` without the SDK is reported with the path the driver read.
  A managed install that is not whole names `maintenance.install`, which
  repairs it, and `sdkDirectory` (see "Repair" above). Without the native
  binary, the error names the platform package and the binary and says to
  reinstall without `--omit=optional` (in the `sdkDirectory`, when one is
  set), to run `maintenance.install`, or to set `executablePath`. A
  configured `executablePath` goes through the host's
  `process.resolveExecutable` (a bare name on `PATH`, a path with a directory
  part as it stands); when it names no executable file, `status()` reports
  the driver unavailable with an error naming it, and `openSession` rejects.
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
- **Environment.** `Options.env` replaces Claude Code's whole environment. It
  is the instance's `environment`, minus `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` and minus the host's
  `envPolicy.stripAmbient`, plus the instance's own API key when it has one,
  plus `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` (a refused resume then comes
  back as a result naming the reason).

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

## The 44 optional members

`test/drivers/claude/capabilities.test.ts` lists each with its outcome and
exercises every supported one against the fake SDK, except the two
`maintenance` members that download the SDK.

| Member | Outcome | Why, when left out |
|---|---|---|
| `Session.readSnapshot`, `forkThread`, `unloadThread`, `backgroundTasks.list`, `.stop`, `.await`, `stopSubagent`, `ext` | supported | |
| `Session.rollbackThread` | absent | No native rollback to the start (above) |
| `Session.compactThread` | absent | The SDK has no compaction call; `/compact` is a prompt the host can send |
| `Session.injectHistory` | absent | The SDK has no history injection |
| `Session.mcpApps.*` | absent | See MCP apps above |
| `Session.contextWindow`, `canReuseContextUsage` | absent | `ModelInfo` reports no context window |
| `Session.uploadFeedback` | absent | The SDK has no feedback upload |
| `Instance.maintenance.install`, `.update` | supported | Download the SDK (above); tested against a local npm registry in `sdk-install.test.ts` and `test/standalone/claude-sdk.e2e.ts` |
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
- **Probe.** `probe()` loads the SDK and finds the binary; `probe({ deep:
  true })` also runs `claude auth status --json`. Nothing else.
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

`sdk-install.test.ts` covers loading the SDK from `sdkDirectory` and
`maintenance.install` against a fake SDK on disk (`fixture-sdk/sdk.mjs`,
plain JavaScript like the real `sdk.mjs`, and a shell-script native
`claude`, laid out by `sdk-fixture.ts`) and a local npm registry: the
install and its layout, a tampered tarball that installs nothing, which
digests a manifest must offer, a download changed on disk after it was
checked, two installs at once, the default registry, the repair of eight
kinds of damage, and that the pinned SDK needs nothing else at run time.
`sdk-install-node.test.ts` (Node only) changes a download while it is being
unpacked. `test/standalone/claude-sdk.e2e.ts` runs the same fixture through
the standalone `ari-driver` with no `node` or `bun` on `PATH`, and through
`ari-driver` under Node: both routes, the repair of a missing `sdk.mjs`, of
a truncated binary and of a binary that lost its execute permission, the
message with no SDK, and that the executable holds no SDK code.

`replay.test.ts` and `recorder.test.ts` cover the native recorder
(`pnpm run record:claude`): they record the six recording scenarios from the
fake SDK, replay them through a fresh driver, and check the recorder keeps the
user's Claude setup out. [docs/recordings.md](../recordings.md) describes the
format and says how to record against the real Claude Code.
