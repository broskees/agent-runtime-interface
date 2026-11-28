# The Muse driver (`ari/drivers/muse`)

`ari/drivers/muse` drives Muse Code over the Muse Session Protocol (MSP). It
runs the user's own `muse` CLI as `muse serve`, one host per thread, through
the host's `process.spawn`, and speaks MSP over the child's stdio with the
`Connection` class of the Muse SDK, `@muse-code/sdk`. The SDK is an optional
peer (`^1.4.25`) that the driver loads with a dynamic `import()` only when it
is needed. Importing `ari/drivers/muse` or `ari/meta/muse` loads no vendor
code and spawns nothing.

The driver is tested against Muse Code and `@muse-code/sdk` `>=1.4.25 <1.4.26`
(`MUSE_TESTED_VERSIONS`). The SDK versions in lockstep with Muse Code
(`@muse-code/sdk` X.Y.Z pairs with Muse Code X.Y.Z, its README says), so one
range covers both. An SDK outside it, or a `muse` above it, gets an
`untested_version` advisory in `status()` and `maintenance.advisory()`; a
`muse` below it is refused (see "The user's own `muse`, and its minimum").

Muse's public documentation is thin (the proposal's §14), so the protocol
record is the SDK's published types (`dist/src/msp.d.ts`), the SDK's
repository at its 1.4.25 mirror commit `e6ef4a64473d` (the stable schema bundle
and the golden wire transcripts under `schema/msp/`), the MSP guides at
https://meta-models.github.io/muse-code-sdk/1.4/, and T3 Code's public Muse
adapter, read for protocol knowledge only:
https://github.com/pingdotgg/t3code/tree/be6ff17f5171c8a55969ec74af46ff1d86666c3a/packages/provider-muse.
`test/drivers/muse/SOURCES.md` lists each source and what the fake takes from
it.

## Config

| Field | Meaning |
|---|---|
| `binaryPath` | The `muse` executable: a name looked up on `PATH`, or a path. Default `muse`. |
| `extraArgs` | Extra arguments for `muse serve`, after `serve`. |
| `model` | The model for new threads (`session/start` `modelId`). Muse's default when unset. |
| `providerId` | The provider routing for new threads and model changes. Muse's default when unset. |
| `reasoningEffort` | The reasoning effort for new turns (`none` ... `ultra`). The model's default when unset. |

`ari/meta/muse` holds the config schema, form hints, label, icon, the tested
range, `MUSE_MINIMUM_VERSION` and `MUSE_CLI_UPDATE_STEP`, with no Node
built-in.

## The user's own `muse`, and its minimum

ARI runs the `muse` the user installed, found on `PATH` or at the path the
config names, and never downloads, installs or updates one. Lookup and
`muse --version` use the same instance environment additions. The process
owner interprets `PATH` (including spellings such as `Path` on Windows).
The minimum is
Muse Code 1.4.25, the lower bound of the tested range `>=1.4.25 <1.4.26`. With
an older `muse`, `status()` is `unavailable` with `driver_unavailable` (with
`installed: true` and the version found), and `openSession` rejects with the
same error before any `muse serve` starts: the only process that runs is `muse
--version`. The error names the version found, the path, the minimum and Muse
Code's update step:

```text
Muse Code 1.4.7 (/home/me/.local/bin/muse) is older than 1.4.25, the oldest version this driver supports. Update Muse Code by running its installer again: `curl -fsSL https://dev.meta.ai/install.sh | bash`.
```

The update step is Muse Code's own: its changelog says "For install and
upgrade steps, see the Muse Code overview" ([Muse Code
changelog](https://dev.meta.ai/docs/muse-code/changelog)), and the overview's
step is the one-line installer, `curl -fsSL https://dev.meta.ai/install.sh |
bash` ([Muse Code, Install](https://dev.meta.ai/docs/muse-code#install)).
`muse --help` 1.4.7 lists no update command. A `muse` above the tested range
still runs, with an `untested_version` advisory. The SDK's version is not held
to the minimum: an SDK outside the range gets only the advisory. `muse
--version` prints `Muse Code 1.4.7 (1.4.7-R6101.1)`
(`test/fixtures/cli-version-output/muse.txt`).

## How it runs

- **One host per thread** (`sessionModel: "process_per_thread"`). A v1 MSP host
  accepts one connection, and its connection lifetime is the process lifetime.
  The driver spawns `muse serve` for each thread, with `--disable-sandbox` when
  the thread's runtime mode is `full_access`: that flag is fixed when the host
  starts. A host that dies takes only its own thread's turn with it.
- **The driver builds the SDK's `Connection` around its own transport**
  instead of letting `MuseClient.spawn` start the host, because the process
  must come from the ARI host's `process.spawn`: the host's environment policy
  then applies, and a host that delegates processes (over `ari/wire`) can run
  it. The handshake is the SDK's own: `initialize` (client name `ari`,
  requesting the `sessionMcp` capability), check MSP envelope version 1, then
  the `initialized` notification.
- **Ids come from the connection's single minter.** The driver mints the Muse
  session id (sent as `session/start` `sessionId`) and every turn id (sent as
  the `turn/start` `commandId`; Muse makes a fresh turn's id from it) with
  `Connection.mintCommandId()`. `createMuseDriver({ mintCommandId })` swaps the
  SDK's UUIDv7 minter for another one, which the SDK documents as the seam for
  deterministic transcripts; the conformance harness uses a counter, so two
  rigs that do the same things get the same ids.
- **Parking.** `unloadThread` and `release` close a host's stdin: MSP drains in
  order (a running turn ends `cancelled`, the session closes with reason
  `hostShutdown`, the writer lease is released) and the process exits. The next
  turn, or `resumeThread`, starts a host and sends `session/resume`.
- **Environment.** Every `muse` process gets the host's environment and the
  instance's `environment`, an inherited `META_API_KEY` included, minus only
  what the host's `envPolicy.stripAmbient` names, plus `MUSE_NO_AUTO_UPDATE=1`. A
  managed key (below) is passed as `META_API_KEY` and wins over an inherited
  one.
- **Workspace roots** are canonical (`fs.realpath`), so a workspace reached
  through a symbolic link gives the same thread.

## Mapping Muse's protocol

| ARI | MSP |
|---|---|
| `createThread` | `hostTools.mcpServerFor(threadId)`, then `session/start` with the driver's `sessionId`, `workspaceRoot`, `approvalMode`, `permissionProfile`, `modelId`, and `config.mcpServers` |
| `resumeThread` | `session/resume` (`excludeItems` when `quiet`, else the stored items are replayed as settled turns, the last one as Muse's `lastTurn` says), then `session/setApprovalMode`. The turn the answer names as running (`activeTurnId`) runs in ARI too, and the approvals and questions Muse re-issues right after the answer (`pendingRequests`) are its requests. A session that is missing (-32020 `sessionNotFound`) or leased by another host (-32021 `sessionInUse`) falls back to a fresh `session/start` with `session.replaced` and `contextLost: true`. On a thread this session holds loaded, a new `launch` replaces the thread's: its instructions go before the next turn's text, and new MCP servers reload the session on a new host, which is refused with `invalid_state` while a turn or request is open |
| `startTurn` start | `session/setModel` when the model changes, then `turn/start` (`commandId` = turn id, `reasoningEffort`) |
| `startTurn` queue | `turn/start` with `ifBusy: "queue"`; the answer's `disposition: "queued"` names the queued turn, announced `pending` until Muse's `turn/started` |
| `startTurn` steer | `turn/steer` with `expectedTurnId`; a steer whose turn already ended is `prompt_required`, a steer the busy session runtime refuses is sent again, and any other refusal is an error (see "Steer refusal") |
| `interruptTurn` | `turn/interrupt` on the running turn, `turn/unqueue` on a queued one. An unqueue the busy session runtime refuses (`runtime_busy`) is sent again under its first `commandId`, as the SDK's `Session.run` does, until Muse takes it, or until Muse starts the turn, which is then interrupted. Each wait ends when the turn ends, and the resends stop 30 s after the first busy refusal with `invalid_state` `runtime_busy`, the turn still queued |
| `respond` (approval) | `approval/decide` with the chosen `choiceId` and the approval's `currentRequirementId` |
| `respond` (question) | `userInput/answer`: one answer per question, `selectedLabel`, `selectedLabels` or `freeText` (`note` beside a selection) |
| `readSnapshot` | `session/read` with `excludeItems: false`; an unloaded thread is read through a short-lived host, because `session/read` takes no lease. A turn is `running` when it is the session's `activeTurnId`; otherwise it ended as this session saw it end, or, for the last turn, as Muse's `lastTurn` says (`failed` with its failure, or `cancelled`). Muse stores no terminal for older turns, so an older turn this session did not see end is `completed` |
| `compactThread` | `session/compact`; a `noop` answer is `invalid_state` with Muse's reason |
| `forkThread`, `rollbackThread` | reject with `unsupported` (`threads.fork`, `threads.rollback`) before sending anything |
| `planConfigChange` | `model` and `reasoningEffort` apply on the next turn; anything else is refused |
| `catalog.list` | `model/list` on a short-lived host |
| `limits.current` | `usage/read` on a short-lived host |

Events:

- `turn/started` starts a turn; only `turn/completed` settles it (`completed`;
  `cancelled` is `interrupted` after Stop, else `cancelled`; `failed` with the
  failure below), or `turn/unqueued` for a queued turn taken back, or the
  host's exit (`failed`, class `transport_error`). No timer settles a turn.
- Items follow Muse's revisions (an item is applied only at a higher
  revision). `userMessage`, `agentMessage` and `reasoning` are
  `user_message`, `assistant_message` and `reasoning`; `toolCall` is
  `command_execution` for shell tools, `file_read` and `file_change` for read
  and write tools with a path, `web_search` for web tools, else `tool_call`;
  `subagent` is `subagent_spawn` with a `subagent.upsert`; `compaction` and
  `systemNotice` keep their kinds; any other kind is `x:muse.<kind>` with the
  Muse item as `data`. `item/delta` on `text`, `output` and `summary.<n>` is
  `item.delta` on `text`, `output` and `reasoning`.
- Approvals and questions arrive as `approval/requested` and
  `userInput/requested` and, for a client that must answer, as the server
  requests `approval/request` and `userInput/request`; after a resume only the
  server request comes. The driver keeps one request per approval id or
  user-input id and answers each server request with the empty presentation
  receipt `{}`. `approval/updated` refreshes the choices; `approval/resolved`
  and `userInput/settled` resolve the request.
- Approval choices keep Muse's `choiceId` as the native option id.
  `approved` is `accept` (`once`), `approvedForSession` is
  `accept_for_session` (`session`), `approvedPolicyAmendment` is
  `accept_always` with the grant's reach: `session` for a session grant; for a
  `localPersistent` grant, `project` for a shell command-prefix rule ("Saved
  command-prefix rules apply only within this root", `ApprovalSubject` in
  `msp.d.ts`) and `global` for any other saved rule, whose reach the driver
  cannot see. `denied` is `decline`, `abort` is `cancel`.
- A subagent's approval (`subagentOrigin`) is a request whose origin names the
  subagent and no turn: the child's run is not a turn of the thread.
- `session/todoListChanged` is `plan.upsert` (one plan per thread).
- Usage: each `session/tokenUsage` is `usage.updated` with the turn's running
  total, the `turn/completed` `usage` is the turn's total (on its last
  `turn.upsert` and a `usage.updated`), `session/contextUsage` is thread
  usage with `contextUsedTokens` and `contextMaxTokens`, and `usage/changed`
  is `limits.updated` (the window is `5h` for a 300-minute window, plus
  `weekly`; a percentage of 100 or more is `limited`).
- Failures: a `TurnError` with `quota` is `usage_limit` with the reset time;
  `authRequired` is `permission_error`; `contextOverflow` and `configError`
  are `validation_error`; anything else is `provider_error`.

## Accounts and sign-in

MSP has no sign-in check: its stable surface has no account method. So the
ambient account (the user's own `muse login`) is always `unknown`, and an auth
failure shows on the first turn; the host reports it with
`auth.reportRuntimeFailure`, which poisons that scope for 30 seconds.

| Method | What it does |
|---|---|
| `api-key` (`api_key`) | Stores a Meta API key in the host's secrets (`muse` / `api-key`). Every `muse serve` gets it as `META_API_KEY`. The state is then `configured` (`managed_profile`). `auth.logout` deletes it. |
| `muse-login` (`terminal_cli`) | Returns instructions to run `muse login` in a terminal. |

`auth.complete` rejects with `unsupported`: neither method returns through a
callback URL. `auth.logout` on the ambient account rejects with `unsupported`:
sign out with `muse` itself.

## Capabilities against the proposal's §1.2 Muse column

The third column is the proposal's §1.2 Muse column (Y or –), "not in §1.2"
where it has no row. Every difference names its source.

| Capability | Declared | §1.2 Muse | Notes and sources |
|---|---|---|---|
| `sessions.multipleThreads` | `true` | not in §1.2 | One host per thread. |
| `sessions.switchModel` | `true` | Y | `session/setModel`. |
| `sessions.switchRuntimeMode` | `false` | – | The `--disable-sandbox` flag of a full-access thread is fixed when its host starts. |
| `sessions.pendingRequestsSurviveRestart` | `false` | not in §1.2 | A pending approval belongs to the host that asked; after a restart Muse may resolve it `abort` and ask again under a new id (`ApprovalChange` `restartRecovered`, `msp.d.ts`). What Muse re-issues after a `session/resume` the driver takes as a request of the running turn, under the id Muse gives it. |
| `sessions.release` | `true` | not in §1.2 | Closes every host; the next turn resumes. |
| `sessions.feedbackUpload` | `false` | not in §1.2 | Not built: `feedback/submit` exists in MSP 1.4.25. |
| `sessions.contextUsageReuse` | `false` | not in §1.2 | |
| `threads.createEmpty` | `true` | not in §1.2 | `session/start`. |
| `threads.readSnapshot` | `true` | Y | `session/read`. |
| `threads.rollback` | `false` | – | MSP has no conversation rollback. |
| `threads.compact` | `true` | not in §1.2 | `session/compact`. |
| `threads.injectHistory` | `false` | not in §1.2 | MSP has no history injection. |
| `threads.unload` | `true` | not in §1.2 | Closes the thread's host. |
| `threads.exposesNativeIds` | `true` | not in §1.2 | |
| `threads.fork.*` | `false` | –/– | MSP 1.4.25 has `session/fork`, but it cuts only at a turn boundary Muse accepts ("Muse rejects completed-turn forks", T3 adapter `adapter.ts`), and this plan rules a Muse fork out. |
| `turns.interrupt` | `true` | Y | `turn/interrupt`. |
| `turns.steer` | `true` | Y | `turn/steer` with `expectedTurnId`. |
| `turns.queue` | `true` | Y | `turn/start` `ifBusy: "queue"` answers with the queued turn's id (commands-and-idempotency guide). |
| `turns.emitsStarted` | `true` | not in §1.2 | `turn/started`. |
| `turns.terminalStatus` | `"strong"` | not in §1.2 | `turn/completed` is authoritative. |
| `turns.multiNativeTurnsPerRequest` | `false` | not in §1.2 | Goals are not driven. |
| `turns.steeringInterruptsTools` | `false` | not in §1.2 | A steer joins the running turn (sessions-and-turns guide). |
| `streaming.assistantText` | `true` | not in §1.2 | `item/delta` `text`. |
| `streaming.reasoning` | `true` | not in §1.2 | `item/delta` `summary.<n>`. |
| `streaming.toolOutput` | `true` | Y | `item/delta` `output`. |
| `streaming.planText` | `false` | – | |
| `tools.mcp` | `true` | Y | Per-session `config.mcpServers`. |
| `tools.dynamicTools` | `false` | – | |
| `tools.mcpApps` | `false` | not in §1.2 | MSP has no MCP app methods. |
| `tools.exposesToolItemIds` | `true` | not in §1.2 | |
| `approvals.command` | `true` | Y | `shell` subjects. |
| `approvals.fileRead` | `true` | Y | `fileAccess` with `access: "read"`. |
| `approvals.fileChange` | `true` | Y | `fileAccess` with `access: "write"`. |
| `approvals.permission` | `true` | not in §1.2 | `network`, `tool`, `process` and other subjects. |
| `approvals.fromSubagents` | `true` | Y | `subagentOrigin` approvals on the parent session. |
| `planning.todoList` | `true` | Y | `session/todoListChanged`. |
| `planning.proposedPlan` | `false` | – | |
| `planning.planUpdates` | `true` | not in §1.2 | `plan.upsert`. |
| `planning.structuredQuestions` | `true` | Y | `userInput/request`. |
| `subagents.supported` | `true` | Y | `subagent` items. |
| `subagents.exposesThreadIds` | `false` | – | |
| `subagents.lifecycle` | `true` | not in §1.2 | `subagent.upsert` from each item revision. |
| `subagents.wait`, `subagents.stop` | `false` | –/– | |
| `context.instructionChannels` | `["first_user_message"]` | –/– | §1.2 has "–/–" for system and developer context. MSP 1.4.25 added `SessionConfig.developerPrompt` on `session/start` and `session/resume`, but a nonblank value replaces Muse's settings-derived developer instructions (`msp.d.ts`), so the driver does not use it; see below. |
| `context.syntheticContext` | `false` | not in §1.2 | |
| `context.summaries` | `false` | – | |
| `context.handoffSummaries` | `false` | not in §1.2 | |
| `checkpointing.*` | `false` | not in §1.2 | |
| `identity` | strong / strong / strong / strong | strong/strong/strong | Session, turn, item, approval and user-input ids are Muse's. |
| `runtimePolicy.modes` | `approval_required`, `full_access` | "not in literal" | Muse has two matching postures (T3 adapter `sdk.ts`): `promptUnmatched` with profile `:ask-me`, and `allowAll` with `:unrestricted` and `muse serve --disable-sandbox`. Enforcement is `native`: Muse's own policy and sandbox decide, and resolve approvals by `policy` themselves (`ApprovalResolvedBy`, `msp.d.ts`). |
| `runtimePolicy.switchInSession` | `false` | – | As `switchRuntimeMode`. |
| `requests.responseModes` | `["live"]` | not in §1.2 | |
| `requests.allowCustomAnswer` | `true` | not in §1.2 | A question takes `freeText`; an approval only one of Muse's choices. |
| `requests.approvalScopes` | once, session, `accept_always` at session, project, global | not in §1.2 | See the choice mapping above. |
| `background.*` | `false` | not in §1.2 | Not built: `task/list` and `task/stop` exist in MSP 1.4.25. `tasksEndWithProcess` is `true`. |
| `mcp` | `stdio`, `http`; scope `thread` | not in §1.2 | `SessionMcpServerConfig` has `stdio` and `streamableHttp`, per session. |
| `sessionModel` | `"process_per_thread"` | not in §1.2 | |
| `externallyOwned` | `false` | not in §1.2 | |
| `diffs` | emits `false` | not in §1.2 | Muse serves patches by reference (`patchRef`), not inline. |
| `contextWindowReporting` | `true` | not in §1.2 | `model/list` `contextLimit`. |
| `extensions` | none | not checked (§14) | |

## The 42 optional members

| Member | Outcome |
|---|---|
| `readSnapshot`, `compactThread`, `unloadThread`, `contextWindow` | supported |
| `forkThread`, `rollbackThread` | reject with `unsupported{capability: "threads.fork"}` and `"threads.rollback"` |
| `injectHistory`, `backgroundTasks.*`, `stopSubagent`, `mcpApps.*`, `canReuseContextUsage`, `uploadFeedback`, `ext` | absent |
| `invalidateCaches`, `catalog.refresh` | supported (`model/list`) |
| `maintenance.advisory` | supported: `untested_version` outside `>=1.4.25 <1.4.26` |
| `auth.methods`, `.state`, `.reportRuntimeFailure`, `.start`, `.respond`, `.cancel`, `.logout` | supported |
| `auth.complete` | rejects with `unsupported{capability: "auth.complete"}` |
| `auth.transferProfile`, `auth.transferSession` | absent |
| `workspace.snapshot` | absent |
| `limits.current`, `limits.accountKey` | supported (`usage/read`) |
| `limits.consumeResetCredit`, `usageHistory.scan`, `textGeneration.generate` | absent |
| `nativeSessions.*`, `subProviders.*` | absent |

`test/drivers/muse/capabilities.suite.ts` lists all 42 and exercises each
supported member against the fake `muse serve`.

## Host instructions and tools

- **`first_user_message`.** Host instructions (`launch.appendSystemPrompt`,
  `launch.developerPrompt`, and `context` on `createThread` and `resumeThread`)
  go into the next turn the driver sends on the thread, as a text part before
  the host's own text; a turn's own `context` goes into that turn. The host's
  own text goes as `displayText` ("never model-visible"), so the user message
  Muse echoes shows only the host's words. With no launch context and no
  context, the driver sends no text of its own: `turn/start` carries exactly
  the host's content.
- **Why not `config.developerPrompt`.** MSP 1.4.25 takes developer
  instructions "for this session only" on `session/start` and
  `session/resume`, but "a nonblank value replaces the settings-derived
  developer instructions" (`SessionConfig.developerPrompt`, `msp.d.ts`).
  Sending the host's text there would silently drop the user's and Muse's own
  developer context, which changes what the model sees beyond what the host
  asked for.
- **Host tools.** The driver chooses the session id before `session/start`,
  so it knows the ARI thread id and calls `hostTools.mcpServerFor(threadId,
  { transport: "http" })` first. The host's server and `launch.mcpServers` go
  into `session/start` and `session/resume` as `config.mcpServers`, keyed by
  the names the host chose: stdio servers as `stdio`, HTTP servers as
  `streamableHttp`; an `sse` server, or a stdio server with a `cwd`, is
  refused, because Muse's per-session servers have neither. Per-session MCP
  servers need the host's `sessionMcp` grant; without it the driver refuses
  rather than drop the servers.
- The driver writes no file, and never touches Muse's own config.

## Resuming conversations ARI did not create

The driver resumes any stored Muse session the host names with
`session/resume`, whoever started it. For a session this ARI session has not
seen, `policy.cwd` is required (`validation` otherwise). The host's
LaunchContext is all it adds: the instructions go before the next turn's text,
as above, and the MCP servers go into `session/resume` as `config.mcpServers`
under the names the host chose. A session Muse does not have, or one another
Muse host holds the lease on, is replaced by a fresh session with
`session.replaced` (`contextLost: true`) when the host passed `policy`;
otherwise the error is returned. The driver lists no native sessions
(`nativeSessions` is absent).

A resume with `purpose: "history"` checks the session with `session/read` on
a short-lived host, which takes no lease and loads nothing, so no writer
starts and no MCP server reaches Muse. It replays nothing as events;
`readSnapshot` reads the history the same way. The thread stays `unloaded`,
so a turn needs an interactive resume first (`invalid_state`
`thread_unloaded`). A session Muse does not have is `not_found`, never
replaced. A thread this session holds is reported as it is.

## Steer refusal

Muse answers a refused `turn/steer` with -32030 `commandRejected` and a
`reason`. The SDK's `Connection` keeps the reason and `retryable`, but it
resends only `overloaded` and `backpressured`, never `commandRejected`. The
driver reads the reason:

- `already_terminal`: the turn already ended (the SDK's own test "a durably
  rejected steer retires to the composer" answers a finished turn's steer
  this way). The host gets `prompt_required`. So does any refusal that
  arrives after this session saw the turn end.
- `runtime_busy`: the session runtime was busy and wrote nothing (the SDK
  changelog: "MSP clients get a retryable `commandRejected` (`runtime_busy`)
  instead of an internal error when a session is busy and refuses
  `turn/start` or `turn/steer`"). The turn still runs, so `prompt_required`
  would be wrong: a fresh `turn/start` on the thread is refused while it runs.
  The driver sends the steer again under its first `commandId`, after the
  SDK connection's own backoff (a random wait under 50 ms, doubling to 2 s),
  until Muse takes it (`accepted`, `steered`) or the turn ends. A turn that
  ends first never got the steer, so the host then gets `prompt_required`.
  The SDK's own `Session.run` resends a busy `turn/unqueue` the same way.
  A `runtime_busy` refusal that says `retryable: false` is not resent.
- **Every wait is bounded.** The SDK sets no deadline on a command's answer
  and does not settle one on a turn notification. So the driver waits for
  each steer answer, and each backoff, only until the turn ends (its
  `turn.terminal`); then the call settles. It answers `accepted` when Muse's
  steered user message, which carries the steer's `commandId`, already shows
  Muse took it, and `prompt_required` otherwise. Resends after a first
  `runtime_busy` stop 30 s after that refusal (`MUSE_BUSY_LIMIT_MS`, at least
  15 sends at the 2 s backoff ceiling); the call then fails with
  `invalid_state`, reason `runtime_busy`, and the turn goes on. An answer that
  arrives after the call settled and says Muse took the steer is reported once
  as a `notice` (level `warning`, code `muse.steer_taken_late`) on the turn;
  the call keeps its first answer, and Muse's steered message appears on the
  turn as an item.
- Any other refusal is an `invalid_state` error with Muse's reason, because
  the turn may still run. `turn/start` refusals carry Muse's reason the same
  way; the driver does not resend a busy `turn/start` (nothing bounds that
  wait).

## CLI manifest

`MUSE_CLI_MANIFEST` is `{ binary: "muse", args: { fresh: [] } }`. It names no
resume or fork arguments and no MCP injection, because Muse's public
documentation names no such CLI flags.

## Conformance

`test/drivers/muse/conformance.suite.ts` runs all 15 scenarios with the real
SDK `Connection` against the fake `muse serve` of
`test/drivers/muse/fake-muse.ts`; all 15 pass. One check is not exercised, with
the harness's reason: `auth-states.unavailable` (the driver runs no sign-in
check, so none can fail). Every frame the fake and the driver exchange in every
Muse test file is type-checked against the SDK's own wire types when the file
ends (`test/drivers/muse/frames.ts`); `frames.suite.ts` shows planted mistakes
are caught. `sdk-types.ts` proves the driver's own SDK types match the SDK's.
All Muse suites run in one test process, `test/drivers/muse-driver.test.ts`,
so their TypeScript compiles do not run beside each other during the gate.
