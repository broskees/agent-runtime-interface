# The Codex driver (`ari/drivers/codex`)

The Codex driver runs the user's own Codex CLI as `codex app-server` and
speaks the app-server JSON-RPC protocol over its stdio. Its protocol client
is generated from the app-server JSON Schema of Codex tag `rust-v0.172.0`
(commit `3d86e43b075adeba2193ec5c22ac92f55afd82e6`), vendored under
`vendor-schemas/codex/`. It is tested against Codex CLI versions
`>=0.172.0 <0.173.0`.

```ts
import { codexDriver } from "ari/drivers/codex";
import { CODEX_CONFIG_SCHEMA, CODEX_LABEL } from "ari/meta/codex";

const instance = await codexDriver.create(host, { instanceId: "codex", config: { binaryPath: "codex" }, environment: {} });
const session = await instance.openSession({ emitDiffs: false });
```

Importing the driver or its metadata loads no vendor code and spawns
nothing. `create()` only reads which managed credential the instance holds.

## Config

| Field | Meaning |
|---|---|
| `binaryPath` (required) | The `codex` executable: a name looked up on `PATH`, or a path. Default `codex`. |
| `extraArgs` | Extra arguments for `codex app-server`, for example `["-c", "model_reasoning_summary=detailed"]`. |
| `model` | The model for new threads; Codex's default when unset. |
| `reasoningEffort` | The reasoning effort for new turns; the model's default when unset. |

`ari/meta/codex` exports the label, the icon, `CODEX_CONFIG_SCHEMA`,
`CODEX_FORM_HINTS`, `codexDefaultConfig()`, `CODEX_TESTED_VERSIONS`,
`CODEX_MINIMUM_VERSION` and `CODEX_UPDATE_STEP`.

## The user's own `codex`, and its minimum

ARI runs the `codex` the user installed, found on `PATH` or at the path the
config names, and never downloads, installs or updates one. Lookup and
`codex --version` use the same instance environment additions. The process
owner interprets `PATH` (including spellings such as `Path` on Windows).
The minimum is
Codex CLI 0.172.0, the lower bound of the tested range `>=0.172.0 <0.173.0`.
With an older `codex`, `status()` is `unavailable` with `driver_unavailable`
(with `installed: true` and the version found), and `openSession` rejects with
the same error before any app-server starts: the only process that runs is
`codex --version`. The error names the version found, the path, the minimum
and Codex's update step:

```text
Codex CLI 0.100.0 (/usr/local/bin/codex) is older than 0.172.0, the oldest version this driver supports. Update Codex using your installation method (npm: `npm install -g @openai/codex`; Homebrew: `brew upgrade --cask codex`). For the standalone installer, rerun the installer from https://learn.chatgpt.com/docs/codex/cli. For a manually downloaded release binary, replace it with the appropriate binary from https://github.com/openai/codex/releases/latest. For other package managers, update with the manager that installed it.
```

OpenAI's [Codex CLI setup](https://learn.chatgpt.com/docs/codex/cli) gives the
update commands for npm, Homebrew and the standalone installers (macOS/Linux
and Windows). Its [GitHub quickstart](https://github.com/openai/codex#quickstart)
points to the [latest release](https://github.com/openai/codex/releases/latest)
for manual installs. The error does not assume a release or an installation
method supports self-update; OpenAI's [`codex update` documentation](https://learn.chatgpt.com/docs/developer-commands#cli-codex-update)
qualifies that command, and [Codex 0.100.0](https://github.com/openai/codex/blob/rust-v0.100.0/codex-rs/cli/src/main.rs#L54-L145)
does not have it.
A `codex` above the tested range still runs, with an `untested_version`
advisory. `codex --version` prints `codex-cli 0.172.0`
(`test/fixtures/cli-version-output/codex.txt`).

## How it runs

- **One app-server per session.** `openSession` spawns `codex app-server`
  through `host.process.spawn` and sends `initialize` with
  `experimentalApi: true` (the driver uses experimental methods such as
  `thread/backgroundTerminals/*`, `thread/memory/read` and
  `thread/readState/update`) and opts out of `turn/diff/updated`: file
  changes carry their own diffs. The session's threads all live in that
  process. `release()` stops the process when nothing runs; the next call
  starts a new one and resumes the threads (`thread/resume`). After the
  process dies, the next call does the same.
- **The instance's account connection.** Sign-in, the model catalog, limits
  and the native session list use a second app-server the instance starts on
  first use and stops on `dispose()`.
- **`probe()` runs only `codex --version`**, and `codex login status` when
  deep and the account is ambient. It never starts an app-server, which can
  start MCP servers and write state.
- **Frames.** Codex frames carry no `"jsonrpc"` member; the connection adds it
  for the driver kit's JSON-RPC peer and removes it again on the way out.

## Accounts and sign-in

An instance uses one of two accounts:

- **Ambient**: the user's own Codex sign-in in Codex's default home
  (`~/.codex`, or the `CODEX_HOME` the host passes). `auth.state()` is what
  `codex login status` reports: `Logged in using ...` is `authenticated`,
  `API key configured` is `configured`, `Not logged in` (exit 1) is
  `unauthenticated`, another failure is `unavailable`, and a line the driver
  does not know is `unknown`. `credentialBinding` is
  `{ owner: "provider", key: "codex:ambient" }`.
- **Managed profile**: a credential the instance keeps in the host's secrets
  (namespace `codex`). Its app-servers run with `CODEX_HOME` set to the
  instance's `stateDir` (Codex refuses a `CODEX_HOME` that does not exist,
  and the host creates `stateDir`). `credentialBinding` is
  `{ owner: "host", key: "codex:<instanceId>" }`, and `continuationKey` is
  `codex:managed:<instanceId>`. It is one of:
  - an **API key** (`auth.start({ methodId: "api-key" })`, then
    `auth.respond({ values: { apiKey } })`), which each new app-server gets
    through `account/login/start { type: "apiKey" }`;
  - **ChatGPT tokens handed over** from another machine
    (`auth.transferProfile({ format: "codex.chatgpt_auth_tokens", data })`,
    where `data` is JSON `{ accessToken, chatgptAccountId, chatgptPlanType? }`,
    the `CodexTransferredTokens` type of `spec/v1/extensions/codex.schema.json`).
    Each new app-server gets them through
    `account/login/start { type: "chatgptAuthTokens" }`. In that mode Codex
    never refreshes the tokens itself: it sends
    `account/chatgptAuthTokens/refresh`, and the driver answers with the
    latest tokens the host handed over. So only this destination refreshes
    the session, which is the managed sign-in handoff of the proposal's §1.3.

Sign-in methods: `chatgpt` (browser), `device-code` and `api-key`. For the
browser sign-in, Codex returns an authorization URL whose redirect goes to
Codex's own login listener on the machine where the app-server runs. With
`callback: { mode: "server" }`, the driver registers the flow with the host's
`callbacks` service and tells the user where to send the address when that
page cannot load on their device; the host then calls
`auth.complete({ flowId, callbackUrl })`, and the driver hands that address
to Codex's login listener, but only when it is a loopback address with the
same origin and path as Codex's redirect. Codex exchanges the code and stores
the tokens. `auth.cancel` sends `account/login/cancel`; `auth.logout` deletes
the managed credential, or sends `account/logout` for the ambient account.

A runtime auth failure (`auth.reportRuntimeFailure`) poisons the failing
scope for 30 seconds. The environment passes through: `codex --version`,
`codex login status` and every `codex app-server` get the host's environment
and the instance's `environment`, credentials such as `OPENAI_API_KEY` and
`CODEX_API_KEY` included, minus only what the host's `envPolicy.stripAmbient`
names. A host that wants a variable kept from Codex lists it there.

## Capabilities against the proposal's §1.2 Codex column

Sources cited below are files of Codex tag `rust-v0.172.0`: the vendored
schema `vendor-schemas/codex/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex_app_server_protocol.schemas.json`
("the schema") and the vendored app-server README ("the README").

| Capability | §1.2 Codex | Driver | Difference and its source |
|---|---|---|---|
| Switch model mid-session | Y | Y (`sessions.switchModel`) | |
| Switch runtime mode mid-session | Y | Y (`sessions.switchRuntimeMode`, `runtimePolicy.switchInSession`) | |
| Read thread snapshot | Y | Y (`thread/turns/list` with `itemsView: "full"`) | |
| Roll back thread | Y | Y (`thread/revert`) | `thread/rollback` was removed upstream; the README's "Thread rollback" section names `thread/revert` instead. |
| Fork thread / from a turn | Y/Y | Y/Y (`thread/fork`, `lastTurnId`, `cwd`) | `fromItem` is off: `ThreadForkParams` in the schema has `lastTurnId` and `beforeTurnId`, no item point. |
| Fork from a subagent thread | Y | – | Codex can fork any thread id (`ThreadForkParams.threadId`), but this driver does not expose subagent threads as ARI threads (`subagents.exposesThreadIds` is off), so a host has no subagent thread to name. |
| Steer an active turn | Y | Y (`turn/steer` with `expectedTurnId`) | |
| Steer by interrupt + restart | Y | host fallback | ARI has no capability for it; the host's `planFallback` plans it. |
| Queued messages / interrupt | Y/Y | –/Y | `thread/queue/add` answers with a `QueuedSubmission` (schema: `ThreadQueueAddResponse`), not a turn, so no turn id can be derived from native data when the host queues. The host queues instead. |
| Streams tool output | Y | Y | |
| Streams plan text | Y | Y (`item/plan/delta`) | |
| MCP tools | Y | Y (`mcp_servers.<name>` config overrides) | |
| Dynamic tool callbacks | Y | Y (`dynamicTools`, `item/tool/call` to `hostTools.callDynamicTool`) | |
| Command / file-change approval | Y | Y | |
| File-read approval | Y | – | The schema's `ServerRequest` union has no file-read approval; Codex governs reads with the sandbox policy. |
| Approvals from subagents | Y | – | An approval from a subagent carries the subagent thread's id (`CommandExecutionRequestApprovalParams.threadId`), which is not an ARI thread here; the driver declines such approvals. |
| Structured questions | Y | Y (`item/tool/requestUserInput`, live; async questions, message mode) | |
| Todo list / proposed plan | Y/Y | Y/Y (`turn/plan/updated` as `plan.upsert` and a `todo_list` item; `plan` items as `proposed_plan`) | |
| Subagents / exposes child thread IDs | Y/Y | Y/– | Subagents are reported (`subAgentActivity` items, `collabAgentToolCall` items) with their native thread id in `native`, but not as ARI threads. |
| Wait for / close subagents | Y/Y | –/Y | Closing is `turn/interrupt` on the subagent's thread. Waiting is a tool the model calls (`CollabAgentTool` `"wait"` in the schema); there is no client request to wait. |
| Accepts system / developer context | Y/Y | developer only | `ThreadStartParams.baseInstructions` replaces Codex's whole base prompt rather than adding to it, so host system and developer text both go to `developerInstructions` (thread start, resume, fork) and per-turn text to `additionalContext`. `context.instructionChannels` is `["developer"]`. |
| Can generate summaries | Y | – | No request returns a summary: `thread/compact/start` answers `{}` (schema: `ThreadCompactStartResponse`). Handoff summaries in `injectHistory` are accepted. |
| Native turn / item / request ID strength | strong/strong/strong | strong/strong/strong | A request's native id is the server request kind plus its item id (JSON-RPC ids restart at 0 per process). |
| Policy enforcement | native | native, all five modes | `auto` is `approvalsReviewer: "auto_review"`; every other mode names `"user"`. The driver names the reviewer on every start, resume, fork and per-turn policy, because Codex keeps a thread's reviewer when a request leaves it out (app-server `thread_processor.rs:4782–4791`, `5788–5794`). |

ARI additions the driver declares: `requests.responseModes` `live` and
`message`; `requests.approvalScopes` `accept`/`once`,
`accept_for_session`/`session`, `accept_always`/`global` (an exec-policy
amendment is saved in the user's rules for every project);
`turns.multiNativeTurnsPerRequest`; `background` list, stop and await, ending
with the process; `mcp` `stdio` and `http` (Codex has no SSE transport),
scope `thread`; `sessionModel` `process_per_instance` (one app-server per
session); `diffs` emitted and can be turned off; `contextWindowReporting`
from `thread/tokenUsage/updated`; and the extensions below.

## The 42 optional members

| Member | Outcome |
|---|---|
| `readSnapshot`, `forkThread`, `rollbackThread`, `compactThread`, `injectHistory`, `unloadThread` | supported |
| `backgroundTasks.list`, `.stop`, `.await` | supported (`thread/backgroundTerminals/list` and `/terminate`) |
| `stopSubagent` | supported (`turn/interrupt` on the subagent's thread) |
| `mcpApps.listTools`, `.callTool`, `.readResource` | supported (`mcpServerStatus/list`, `mcpServer/tool/call`, `mcpServer/resource/read`) |
| `contextWindow`, `canReuseContextUsage` | supported |
| `uploadFeedback` | supported (`feedback/upload`; the id is the conversation id Codex reports) |
| `ext` | supported (the five extensions below) |
| `invalidateCaches`, `catalog.refresh` | supported (`model/list`) |
| `maintenance.advisory` | supported: an `untested_version` advisory outside `>=0.172.0 <0.173.0` |
| `auth.methods`, `.state`, `.reportRuntimeFailure`, `.start`, `.complete`, `.respond`, `.cancel`, `.logout`, `.transferProfile` | supported |
| `auth.transferSession` | absent: Codex has no request that moves a thread to another account |
| `workspace.snapshot` | absent: not built in this version |
| `limits.current`, `.accountKey`, `.consumeResetCredit` | supported (`account/rateLimits/read`, `account/rateLimitResetCredit/consume`) |
| `usageHistory.scan` | absent: `account/usage/read` returns a summary, not records per time range |
| `textGeneration.generate` | absent: Codex has no tool-free generation request; a thread would still run tools |
| `nativeSessions.list`, `.delete`, `.archive` | supported (`thread/list`, `thread/delete`, `thread/archive`) |
| `subProviders.list`, `.set`, `.disable` | absent: Codex has no sub-provider registry |

`test/drivers/codex/capabilities.test.ts` lists all 42 and exercises each
supported member against the fake app-server.

## Turns, items and requests

- **Working directory.** A thread runs in `createThread`'s `cwd`, which is
  `thread/start`'s `cwd`, also when `policy.cwd` names another directory.
  Codex has one working directory per thread, and its sandbox roots are that
  directory and `policy.additionalRoots`. A fork runs in `forkThread`'s
  `cwd` when given, else in its source's directory.
- **Settlement.** A turn settles only on Codex's `turn/completed` (or when the
  process exits: `failed`, class `transport_error`, thread reusable after a
  resume). No timer settles a turn.
- **Goal runs.** Codex starts goal turns on its own: at once when an active
  goal is set on an idle thread, and after each completed turn while the goal
  stays active (`ext/goal/src/runtime.rs:223–239`). A `turn/started` the host
  did not ask for is `origin: "provider_initiated"`. Setting an active goal
  opens a goal run; when a host turn is running then, Codex counts that turn
  toward the goal and it leads the run. A host turn on a thread whose goal is
  active and has no open run opens one. Each turn Codex starts joins the open
  run: it carries the run's `hostTag` and `parentTurnId` (the run's first
  turn), and `x:ari.goal.updated` lists every turn of the run in `turnIds`.
  The run closes when the goal stops being active: Codex starts no more turns
  for it, and the run keeps its turns, so `ari.goal` `get` on a completed goal
  still lists them. A new active goal opens a new run. `ari.goal` `set`
  returns the goal as set, with `turnIds: []`; the events report the turns.
  Each native turn has its own `turn.terminal`.
- **A host turn that meets a goal turn.** `turn/start` on a thread with a
  running turn adds the input to that turn (`turn_processor.rs:722–763`).
  Only the `turn/start` answer names the host's turn: a `turn/started` that
  arrives before the answer while the goal is active is Codex's own. When the
  answer then names that turn, `startTurn` returns
  `{ accepted: "steered", turnId }` and the turn stays `provider_initiated`.
- **Interrupts.** Codex answers `turn/interrupt` only once the turn completed
  or aborted, just before its `turn/completed`
  (`turn_processor.rs:1550–1605`), so `interruptTurn` returns after the turn
  stopped. `no active turn to interrupt` and `expected active turn id ...`
  mean the turn already ended.
- **Async questions.** An `agentMessage` item with `delivery: "async"` and
  `questions` becomes a `user_input` request with `response: { mode:
  "message" }` and `survivesRestart: true`. It stays pending when its turn
  ends and when the process exits; a resumed thread raises it again while no
  later user message answered it. `respond({ answers })` marks it resolved and
  returns `followUpPrompt`, the user message the host sends as its next turn.
- **Approvals.** Codex decisions have no ids: a decision's canonical text is
  its native option id. A plain decision is its own text (`accept`,
  `acceptForSession`, `decline`, `cancel`); an exec-policy amendment is
  `acceptWithExecpolicyAmendment:` followed by the JSON prefix
  (`acceptWithExecpolicyAmendment:["git","status"]`); a network amendment is
  `applyNetworkPolicyAmendment:` followed by the JSON `[action, host]`
  (`applyNetworkPolicyAmendment:["allow","registry.npmjs.org"]`). Codex's
  ordinary command approval offers `accept`, at most one exec-policy
  amendment and `cancel`; a network approval offers `accept`,
  `acceptForSession`, an allowing network amendment and `cancel`
  (`protocol/src/approvals.rs:379–411`). Two broader accepting decisions stay
  two options of one `command` approval, never a question; so do any
  decisions the schema allows, such as two prefixes, which ordinary Codex
  does not produce. Under `full_access` (approval policy `never`) Codex asks
  nothing for ordinary commands (`core/src/exec_policy.rs:907–911`), only for
  a managed human checkpoint (`kind: "humanCommand"`), marked
  `fullAccessOverride: "ask_rule"`.
- **Steering.** `startTurn({ intent: "steer", expectedTurnId })` sends
  `turn/steer` with the native id of the turn the host named. When Codex
  answers `no active turn to steer` or `expected active turn id ...`, the
  driver returns `prompt_required`.
- **Diffs.** File-change items and file-change approval subjects carry each
  file's unified diff; `openSession({ emitDiffs: false })` leaves them out.
- **Limits.** `account/rateLimits/updated` becomes `limits.updated`: a 300
  minute window is `5h`, 1440 is `daily`, 10080 is `weekly`, credits are
  `credits`; a usage-limit failure takes its `resetAt` from Codex's latest
  snapshot.
- **Item kinds.** `userMessage` is `user_message`, `agentMessage`
  `assistant_message`, `reasoning` `reasoning`, `plan` `proposed_plan`,
  `commandExecution` `command_execution` (paths from its parsed actions),
  `fileChange` `file_change`, `mcpToolCall` `mcp_tool_call`,
  `dynamicToolCall` `dynamic_tool_call`, `collabAgentToolCall` with
  `spawnAgent` `subagent_spawn` (others `tool_call`), `webSearch`
  `web_search`, `imageView` `file_read`, review mode items `review`,
  `contextCompaction` `compaction`, `hookPrompt` `system_notice`; any other
  type is `x:codex.<type>` with a fallback.

## Extensions

Each is listed in `capabilities.extensions` with version `1`. Thread ids in
params and results are ARI ids. Types are in
`spec/v1/extensions/codex.schema.json`.

| Namespace | Methods | Events |
|---|---|---|
| `ari.goal` | `get`, `set { threadId, objective }`, `clear` (results: `AriGoal`, `derived: false`) | `x:ari.goal.updated`, fallback "Goal ..." |
| `codex.goal` | `get`, `set { threadId, objective?, status?, tokenBudget? }`, `clear` (results: `CodexGoal`, `{ cleared }`) | `x:codex.goal.updated` |
| `codex.review` | `start { threadId, target }`: runs a review turn on the thread, returns `{ threadId, turnId }` | review items, fallback titles |
| `codex.readState` | `read { threadId }`, `update { threadId, expectedRevision, operation }` | `x:codex.readState.changed` |
| `codex.memory` | `read { threadId }`: `{ threadId, summary }` | |

## Native sessions

`nativeSessions.list({ cwd, cursor })` takes Codex-only filters as `x:codex.*`
fields (the `CodexNativeSessionFilters` type): `x:codex.limit`,
`x:codex.searchTerm`, `x:codex.archived`, `x:codex.modelProviders`,
`x:codex.sourceKinds`, `x:codex.includedThreadIds` and
`x:codex.excludedThreadIds` (at most 100 each), `x:codex.useStateDbOnly`,
`x:codex.currentAccountOnly`, `x:codex.parentThreadId`,
`x:codex.ancestorThreadId`, `x:codex.projectId`, `x:codex.sortKey` and
`x:codex.sortDirection`. An unknown `x:codex.` field is refused with
`validation`. Each listed session carries `x:codex.modelProvider`.

## Resuming conversations ARI did not create

The driver resumes any Codex thread the host names, including one the user's
own `codex` started and every thread `nativeSessions.list` returns.
`resumeThread` sends `thread/resume` for that id with only what the host
supplied: its launch instructions as `developerInstructions`, and its MCP
servers, under the names `hostTools.mcpServerFor` and the host's launch gave,
as the request's `mcp_servers.<name>` config overrides. The driver writes
nothing to Codex's config files. A thread Codex has no rollout for, or one
another process holds open for writing, is replaced by a fresh thread with
`session.replaced` (`contextLost: true`) when the host passed `policy`;
without `policy` the error is returned.

A resume with `purpose: "history"` reads the thread with `thread/read` and
loads nothing: no `thread/resume`, so no writer starts, and no MCP server,
policy or instruction reaches Codex. It replays nothing as events;
`readSnapshot` reads the turns with `thread/turns/list`. The thread stays
`unloaded`, so a turn needs an interactive resume first (`invalid_state`
`thread_unloaded`). A thread Codex does not have is `not_found`, never
replaced. A thread this session holds is reported as it is.

## Host instructions and tools

With no launch context and no `context`, the driver sends no instruction
text. Host instructions (`launch.appendSystemPrompt`, `launch.developerPrompt`,
`context.system`, `context.developer`) go into `developerInstructions`;
per-turn ones into `additionalContext` (`application` kind), and synthetic
context into `additionalContext` entries of `untrusted` kind. MCP servers go
into the thread's config overrides as `mcp_servers.<name>`, under the name
the host gave: `launch.mcpServers` in `thread/start`, `thread/fork` and every
`thread/resume`, and the host's tool server from
`hostTools.mcpServerFor(threadId)` in every `thread/resume`.

**Known limit: a new or forked thread gets the host's tools only through
`launch.mcpServers`.** The host's per-thread server from
`hostTools.mcpServerFor(threadId)` reaches a thread from its first resume on,
not before its first turn. The pinned Codex source rules out a clean way to
add it earlier:

- Codex assigns the thread id: `ThreadStartParams` and `ThreadForkParams` in
  the schema have no thread-id field, so the ARI thread id, and with it the
  per-thread server, is known only after `thread/start` or `thread/fork`
  answered.
- Codex takes MCP servers only in the `config` of `thread/start`,
  `thread/fork` and a cold `thread/resume`. `thread/settings/update` has no
  `config` (schema: `ThreadSettingsUpdateParams`), and
  `config/mcpServer/reload` takes no parameters (schema) and reloads the
  servers Codex's config layers define, which the driver could change only by
  writing a config file.
- A resume before the thread's first turn fails with `no rollout found`
  (app-server `tests/suite/v2/thread_resume.rs:521–566`), and a resume of a
  thread the connection has loaded ignores its `config`
  (`thread_processor.rs:4900–4955`).
- Archiving the new thread would give it a rollout and unload it
  (`thread_processor.rs:1895–1904`), so an unarchive and a cold resume could
  apply the server. But Codex then runs the first turn's `SessionStart` hooks
  with source `resume` instead of `startup` or `fork`
  (`core/src/session/session.rs:2169–2180`, `core/src/session/turn.rs:412`),
  and those hooks can add model-visible context or stop the turn
  (`core/src/hook_runtime.rs:133–185`). Codex would also broadcast
  `thread/archived` and `thread/unarchived` to its other clients. The driver
  does not do this.

So the host passes its tools for a new or forked thread in
`launch.mcpServers`, under names it chooses. A fork gets its source's launch
servers in `thread/fork`. When a resume fails because the thread is missing
or held by another process, the replacement thread gets that resume's
`LaunchContext`. The driver writes no file.

## Regenerating the protocol client

`pnpm run codegen` regenerates `src/drivers/codex/generated/protocol.ts` from
the vendored schema; `pnpm run codegen:codex:check` (part of the gate) fails
when it is stale. `vendor-schemas/codex/<commit>/SOURCES.md` says how to
vendor a newer tag.

## Conformance

`test/drivers/codex/conformance.test.ts` runs all 15 conformance scenarios
against a fake Codex CLI (`test/drivers/codex/fake-app-server.ts`) that sends
only frames the vendored schema accepts and checks every frame the driver
sends. The fake follows the pinned Codex source where the driver depends on
it, and imports no driver code: the handshake, a second reply to a server
request (recorded as a problem, so a driver that answers twice fails),
interrupts answered after the turn aborted, `turn/start` steering into a
running turn, threads without a rollout until their first turn, approval
settings that persist, the approval shapes above, goal turns Codex starts
itself, `i32` terminal process ids and the `thread/list` id filters.
`fake-fidelity.test.ts` checks each against the fake directly, with the
pinned source lines. In the conformance run the model meets a goal in the
first turn Codex starts for it, so scenario 14's `ari.goal` call leaves no
turn running. The harness maps each kit approval option to the native option
id the driver shows, from the documented format above, not by calling the
driver. All 15 pass. Two checks are not exercised, each with the harness's
reason: the `codex.review` extension call in scenario 14 (it runs a turn on
the thread scenario 14 goes on to roll back; `quirks.test.ts` covers it), and
scenario 15's `full_access` reply (`idempotent-responses.full-access`): under
`full_access` the driver runs Codex with approval policy `never`, and Codex
then sends no ordinary approval, so there is no reply to check. The fake
refuses to ask for one rather than invent a reply.
