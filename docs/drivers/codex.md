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
`CODEX_FORM_HINTS`, `codexDefaultConfig()` and `CODEX_TESTED_VERSIONS`.

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
scope for 30 seconds. Ambient OpenAI credentials (`OPENAI_API_KEY`,
`CODEX_API_KEY`, `OPENAI_ADMIN_KEY`) never reach Codex: the CLI manifest's
`envScrubPrefixes` names them, and the driver drops them from the instance's
own environment too.

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
| Policy enforcement | native | native, all five modes | |

ARI additions the driver declares: `requests.responseModes` `live` and
`message`; `requests.approvalScopes` `accept`/`once`,
`accept_for_session`/`session`, `accept_always`/`global` (an exec-policy
amendment is saved in the user's rules for every project);
`turns.multiNativeTurnsPerRequest`; `background` list, stop and await, ending
with the process; `mcp` `stdio` and `http` (Codex has no SSE transport),
scope `thread`; `sessionModel` `process_per_instance` (one app-server per
session); `diffs` emitted and can be turned off; `contextWindowReporting`
from `thread/tokenUsage/updated`; and the extensions below.

## The 44 optional members

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
| `maintenance.install`, `maintenance.update` | absent: updating the user's Codex belongs to the installer that owns it (Codex ships `codex update`) |
| `auth.methods`, `.state`, `.reportRuntimeFailure`, `.start`, `.complete`, `.respond`, `.cancel`, `.logout`, `.transferProfile` | supported |
| `auth.transferSession` | absent: Codex has no request that moves a thread to another account |
| `workspace.snapshot` | absent: not built in this version |
| `limits.current`, `.accountKey`, `.consumeResetCredit` | supported (`account/rateLimits/read`, `account/rateLimitResetCredit/consume`) |
| `usageHistory.scan` | absent: `account/usage/read` returns a summary, not records per time range |
| `textGeneration.generate` | absent: Codex has no tool-free generation request; a thread would still run tools |
| `nativeSessions.list`, `.delete`, `.archive` | supported (`thread/list`, `thread/delete`, `thread/archive`) |
| `subProviders.list`, `.set`, `.disable` | absent: Codex has no sub-provider registry |

`test/drivers/codex/capabilities.test.ts` lists all 44 and exercises each
supported member against the fake app-server.

## Turns, items and requests

- **Settlement.** A turn settles only on Codex's `turn/completed` (or when the
  process exits: `failed`, class `transport_error`, thread reusable after a
  resume). No timer settles a turn.
- **Goal runs.** Codex starts the next turn of an active goal on its own. A
  `turn/started` the host did not ask for is `origin: "provider_initiated"`.
  A host turn on a thread with an active goal opens a goal run; each turn
  Codex starts after it carries the run's `hostTag` and `parentTurnId` (the
  host's turn), and `x:ari.goal.updated` lists every turn of the run in
  `turnIds`. Each native turn has its own `turn.terminal`.
- **Async questions.** An `agentMessage` item with `delivery: "async"` and
  `questions` becomes a `user_input` request with `response: { mode:
  "message" }` and `survivesRestart: true`. It stays pending when its turn
  ends and when the process exits; a resumed thread raises it again while no
  later user message answered it. `respond({ answers })` marks it resolved and
  returns `followUpPrompt`, the user message the host sends as its next turn.
- **Approvals.** Codex decisions have no ids: a decision's canonical text is
  its native option id (`accept`, `acceptForSession`,
  `acceptWithExecpolicyAmendment:["git","status"]`, ...). Two "always"
  decisions (two command prefixes) stay two options of one `command`
  approval, never a question. Under `full_access` Codex asks only for a
  managed human checkpoint (`kind: "humanCommand"`), marked
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

## Host instructions and tools

With no launch context and no `context`, the driver sends no instruction
text. Host instructions (`launch.appendSystemPrompt`, `launch.developerPrompt`,
`context.system`, `context.developer`) go into `developerInstructions`;
per-turn ones into `additionalContext` (`application` kind), and synthetic
context into `additionalContext` entries of `untrusted` kind. MCP servers go
into the thread's config overrides as `mcp_servers.<name>`, under the name
the host gave: `launch.mcpServers` at start, resume and fork; the host's tool
server from `hostTools.mcpServerFor(threadId)` whenever a known thread is
resumed. Codex assigns thread ids itself and takes MCP servers only in
`thread/start`, `thread/resume` and `thread/fork`, so a new thread gets that
per-thread server from its first resume (a known limit: the host can pass the
server in `launch.mcpServers` at creation). The driver writes no file.

## Regenerating the protocol client

`pnpm run codegen` regenerates `src/drivers/codex/generated/protocol.ts` from
the vendored schema; `pnpm run codegen:codex:check` (part of the gate) fails
when it is stale. `vendor-schemas/codex/<commit>/SOURCES.md` says how to
vendor a newer tag.

## Conformance

`test/drivers/codex/conformance.test.ts` runs all 15 conformance scenarios
against a fake Codex CLI (`test/drivers/codex/fake-app-server.ts`) that sends
only frames the vendored schema accepts and checks every frame the driver
sends. All 15 pass; the `codex.review` extension call is checked in
`quirks.test.ts` instead of scenario 14, because it runs a turn on the
thread scenario 14 goes on to roll back.
