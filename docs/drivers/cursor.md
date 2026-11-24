# The Cursor driver (`ari/drivers/cursor`)

The Cursor driver runs Cursor's coding agent through the Cursor TypeScript SDK,
[`@cursor/sdk`](https://cursor.com/docs/sdk/typescript). The SDK "runs the agent
loop inline in your Node process"; files come from disk, and every model call
goes to Cursor's hosted models. So the driver has no process of its own: its
session model is `in_process`, and `@cursor/sdk` is an optional peer of ari that
the driver loads with a dynamic `import()` the first time an instance needs it.

It is tested against `@cursor/sdk` `>=1.4.2 <1.5.0`: the types and the local
runtime of 1.4.2, the pinned devDependency. `test/drivers/cursor/SOURCES.md`
lists every source the driver and its fake follow.

The driver is thin on purpose (the proposal's §14: "thin capability set; host
fallbacks do the heavy lifting"). Cursor's SDK has no fork, no rollback and no
approval flow: `forkThread` and `rollbackThread` reject with `unsupported`, no
approval is declared, and the host's fallbacks apply.

```ts
import { cursorDriver } from "ari/drivers/cursor";

const instance = await cursorDriver.create(host, { instanceId: "cursor", config: { model: "composer-2.5" }, environment: {} });
const session = await instance.openSession({});
const thread = await session.createThread({ cwd: "/work", policy: { mode: "full_access", interaction: "default", cwd: "/work" } });
```

## Config

| Field | Meaning |
|---|---|
| `model` | The Cursor model id new threads start with. Default `composer-2.5`. Local Cursor agents need an explicit model (`AgentOptions.model`). `config.model` on `createThread`, `resumeThread` or `startTurn` picks another for that thread; Cursor keeps it for later runs. |
| `settingSources` | The on-disk Cursor settings the agent loads (`project`, `user`, `team`, `mdm`, `plugins` or `all`; the SDK's `local.settingSources`). Default `[]`: only what the host passes reaches the agent. |

`ari/meta/cursor` exports the label, icon, this schema and form hints without
loading the driver or the SDK.

## How it runs Cursor

- **One SDK agent per thread.** `createThread` calls `Agent.create` with the
  account's `apiKey`, the model, `local.cwd` (the directory's real path, so a
  workspace reached through a symbolic link is the same agent scope), the
  instance's agent store and the launch MCP servers. Cursor picks the agent id
  (`agent-<uuid>`).
- **The agent store is the instance's own.** The driver passes
  `local.store: new JsonlLocalAgentStore("<stateDir>/cursor-agents")`, so the
  agents, runs and conversation checkpoints live under the instance's state
  directory, not in the SDK's default SQLite store under
  `~/.cursor/projects/<workspace>/sdk-agent-store`. Cursor finds a local agent
  by its working directory as well as its id, so a resume needs the thread's
  directory.
- **One run per turn.** `startTurn` calls `agent.send()`; the run's id is the
  turn's native id. Its updates reach the driver through `send({ onDelta })`
  (the SDK awaits the callback before it handles the next update); the run's
  message stream (`run.stream()`) is only drained. The SDK's stream has no
  event that ends an assistant message, while `onDelta` has `step-completed`.
- **Settlement.** A turn settles only when `run.wait()` resolves. Cursor ends a
  run after every background subagent's result came back as a follow-up turn
  of the same run (docs, "Background subagents"), so a `turn-ended` update is
  not the end. Nothing settles a turn on a timer. `finished` completes the
  turn, `cancelled` interrupts it, and `error` fails it with the run's
  `RunError` (below). The thread stays `reusable`: the agent takes the next run
  after any outcome.
- **Steer** is `run.steer(text)`. Cursor answers `complete_delivered` when the
  running turn took the message, then appends it as a user message; the driver
  answers `accepted: "steered"`. It answers `revert_to_followup` when the turn
  did not take it, for example because the run's turn already ended; the host
  then gets `prompt_required`. A steer the driver knows came too late (no
  active turn, or another `expectedTurnId`) never reaches Cursor.
- **Stop** is `run.cancel()`. With `restartRuntime: true` the driver also
  closes the agent handle.
- **Compaction** is `agent.summarize()`, the CLI's `/summarize`, which Cursor
  runs as a run of its own; `compactThread` waits for it. Cursor refuses it
  before the agent has a saved conversation (`invalid_state`,
  `nothing_to_compact`).
- **Unload and release** close agent handles (`agent.close()`, which frees the
  SDK's local executor). The next use reopens the agent with `Agent.resume`.
- **Resume** is `Agent.resume(agentId, …)` with the same options as creation:
  the SDK keeps inline MCP servers, the tool allowlist and the model in memory
  only ("Pass them again on resume"). An agent the store does not hold for that
  directory fails with the SDK's `AgentNotFoundError`; with a `policy` the
  driver then creates a fresh agent and emits `session.replaced` with
  `contextLost: true`.

## Host instructions and host tools

- **Instructions** (`launch.appendSystemPrompt`, `launch.developerPrompt`,
  `context.system`, `context.developer`) go at the top of the thread's first
  prompt, before the host's text, separated by a blank line (channel
  `first_user_message`). Cursor's `systemPrompt` option replaces its whole
  coding-agent prompt ("The model loses the coding-assistant identity, tool-use
  protocol, and communication guidance") and is enabled per account, so it
  cannot carry host text that should be added. A resumed thread gets its
  `launch` instructions the same way, on its first prompt after the resume. The
  turn's `user_message` item holds the host's own words only. Without
  instructions the driver adds no text of its own.
- **MCP servers.** `launch.mcpServers` go to `Agent.create` and `Agent.resume`
  as inline servers, under exactly the names the host gave. Cursor picks the
  agent id, so the host's own per-thread tool server cannot be named before
  the thread exists: the driver calls `hostTools.mcpServerFor(threadId, {
  transport: "http" })` right after `Agent.create` returns and sends that
  server, with the launch servers, on every run (`send({ mcpServers })`, which
  the SDK documents as replacing the creation-time servers for that run). A
  run Cursor starts itself (the summary run of `compactThread`) has only the
  launch servers. `alwaysLoad` has nothing to set: Cursor's inline server
  config has no tool-search setting. A `read_only` thread offers the model no
  MCP tools (below).
- **Where Cursor writes them.** The driver writes no `LaunchContext` value to
  any file: not to `~/.cursor/mcp.json`, rules, hooks or any other Cursor
  config file, and not to the workspace's `.cursor/`. Its agent store, which
  holds the conversation, is under the instance's state directory. Cursor's
  SDK itself keeps per-workspace data in its data directory,
  `$CURSOR_DATA_DIR/projects/<workspace>`, by default
  `~/.cursor/projects/<workspace>`: the conversation's transcript (prompts
  included, so first-message instructions too) and a descriptor folder per
  inline MCP server, by server name (`dist/esm/977.js`, `LocalTranscriptWriter`
  and `McpFileSystemWriter`). The SDK reads `CURSOR_DATA_DIR` from the process
  environment, and changing it would change every Cursor agent of the host
  process, so the driver does not. A host that must keep host instructions out
  of `~/.cursor` sets `CURSOR_DATA_DIR` for its process.

## Items, subagents and plans

- **Ids.** A thread is a Cursor agent (`native.id` is the agent id, strong;
  `handle` is the agent id too). A turn is a run (the run id, strong). Cursor's
  updates carry no message ids, so an item is named by its position in the run
  (the prompt is 0, then every message segment and tool call in the order its
  first update arrived) and a fingerprint of its kind; a tool item also keeps
  Cursor's call id in `native.id`. The same updates give the same ids in any
  process, so replaying a recorded session gives the ids it gave live.
- **Requests.** Cursor raises none: a local run answers its own interaction
  queries (questions are rejected, plans and mode switches approved;
  `dist/esm/977.js`, `ClientInteractionController`). `respond` rejects with
  `not_found`; request ids have strength `none`.
- **Messages.** `text-delta` streams an `assistant_message`, `thinking-delta`
  a `reasoning` item; a segment ends at `step-completed`, at `thinking-completed`
  (reasoning), at the turn's end or when another kind of update arrives.
  `user-message-appended` (a delivered steer) is a `user_message`.
- **Tools.** `shell` is `command_execution` (`command`, `cwd`, output and exit
  code), `read` `file_read`, `edit`, `write` and `delete` `file_change` (with
  the edit's diff unless `openSession({ emitDiffs: false })`), `glob`, `grep`,
  `ls` and `semSearch` `file_search`, `mcp` `mcp_tool_call`, and other tools
  `tool_call`. A tool whose result is `{ status: "error" }` fails. Output is
  capped by `payloadLimits`.
- **Plans.** `createPlan` is a `proposed_plan` item whose `plan` streams as the
  model writes the arguments (`partial-tool-call` updates): `item.delta` on
  field `plan`. `updateTodos` is a `todo_list` item, and the thread's plan
  (`plan.upsert`, one per thread) gets the same entries.
- **Subagents.** A `task` tool call is a `subagent_spawn` item and a
  `subagent.upsert`: `running` from its first update, `completed` or `failed`
  when the call returns. A background subagent (`isBackground: true`) keeps
  running; Cursor's run waits for it, and it settles with the turn. Its
  activity inside (`tool-call-delta`) is not mapped.
- **Usage.** Each `turn-ended` update with usage becomes `usage.updated`
  (scope `turn`), with Cursor's own total: input plus output tokens.
- **Failures.** A run that ends `error` carries `{ message, code }`. Codes of
  usage and rate limits (`PRO_USER_USAGE_LIMIT`, `RATE_LIMITED`,
  `resource_exhausted`, ...) are `usage_limit`, auth codes `permission_error`,
  network codes (`unavailable`, `deadline_exceeded`, `TIMEOUT`, ...)
  `transport_error`, request codes (`BAD_MODEL_NAME`, `invalid_argument`, ...)
  `validation_error`, the rest `provider_error`. Cursor reports no reset time,
  so a usage-limit failure has no `resetAt`.

## Sign-in

The SDK resolves an API key as: the `apiKey` option, then `CURSOR_API_KEY` in
the process environment, then the login `Cursor.auth.login()` stored
(`~/.cursor/sdk/auth.json`). The driver always passes `apiKey` itself, so the
SDK never authenticates with a `CURSOR_API_KEY` the host process inherited:

- **Method `api-key`.** The host stores a Cursor user or service-account key
  (`auth.respond`); it is `configured` (passive, scope `managed_profile`) and
  used first.
- **The ambient account** is the SDK's stored sign-in, read with the SDK's
  `FileCredentialStore`. None, or an expired one, is `unauthenticated`;
  otherwise `Cursor.me()` checks the key: accepted is `authenticated`, refused
  (`AuthenticationError`) `unauthenticated`, a network failure (`NetworkError`)
  `unavailable`, anything else `unknown`.
- A runtime auth failure (`reportRuntimeFailure`) poisons its scope for 30
  seconds. `auth.complete` rejects `unsupported`: no Cursor sign-in returns
  through a callback URL. A `CURSOR_API_KEY` in the instance's `environment` is
  ignored.

## Probes and status

`probe()` loads the SDK and reports its version; `probe({ deep: true })` adds
the sign-in state. Neither writes a file, spawns anything or calls a mutating
host service. `status()` reports the version and an `untested_version`
advisory outside `>=1.4.2 <1.5.0`. Without `@cursor/sdk`, `create()` still
works, `status()` is `unavailable` with a `driver_unavailable` error naming the
package, and `openSession` rejects with it. The catalog is
`Cursor.models.list()`.

## Capabilities

The third column is the proposal's §1.2 Cursor column (Y or –), "not in §1.2"
where it has no row. Every difference names its source: the docs page
<https://cursor.com/docs/sdk/typescript> ("docs") or a file of
`@cursor/sdk` 1.4.2 under `dist/esm/`.

| Capability | Declared | §1.2 Cursor column | Notes and sources |
|---|---|---|---|
| `sessions.multipleThreads` | `true` | not in §1.2 | One SDK agent per thread, all in the host's process. |
| `sessions.switchModel` | `true` | Y | `send({ model })` is sticky (docs, "Per-run model override"). |
| `sessions.switchRuntimeMode` | `false` | – | The tool allowlist that enforces `read_only` is set when the agent handle opens (`AgentOptions.tools`). |
| `sessions.pendingRequestsSurviveRestart` | `false` | not in §1.2 | No requests. |
| `sessions.release` | `true` | not in §1.2 | `agent.close()` frees the local executor; `Agent.resume` reopens the agent. |
| `sessions.feedbackUpload` | `false` | not in §1.2 | |
| `sessions.contextUsageReuse` | `false` | not in §1.2 | |
| `threads.createEmpty` | `true` | not in §1.2 | `Agent.create` stores the agent before its first run (`index.js` `createAgent`). |
| `threads.readSnapshot` | `false` | Y | Cursor keeps no typed record of a run's prompt: the SDK turns only `user-message-appended` updates into user messages, and Cursor sends none for a run's own prompt (`index.js` `sendImpl`), and `Agent.messages.list` types each message `unknown` (`agent.d.ts` `AgentMessage`). |
| `threads.rollback` | `false` | – | |
| `threads.compact` | `true` | not in §1.2 | `agent.summarize()` (`agent.d.ts`). |
| `threads.injectHistory` | `false` | not in §1.2 | |
| `threads.unload` | `true` | not in §1.2 | `agent.close()`, then `Agent.resume`. |
| `threads.exposesNativeIds` | `true` | not in §1.2 | The agent id. |
| `threads.fork.supported` | `false` | – | |
| `threads.fork.fromTurn` | `false` | – | |
| `threads.fork.fromItem` | `false` | not in §1.2 | |
| `threads.fork.fromSubagent` | `false` | – | |
| `threads.fork.crossCwd` | `false` | not in §1.2 | |
| `turns.interrupt` | `true` | Y | `run.cancel()`. |
| `turns.steer` | `true` | – | `run.steer()` on local runs, added to the SDK since §1.2 was written (docs, "Steering a run in flight"; `run.d.ts` `SteerAckOutcome`). |
| `turns.queue` | `false` | Y | A local agent refuses a second `send()` while a run is active: "Agent … already has active run" (`index.js`, the local store's `createFollowUpRun`; `agent.d.ts`: `summarize()` "Like `send()`, throws while another run is active"). Hosts queue on their side. |
| `turns.emitsStarted` | `true` | not in §1.2 | |
| `turns.terminalStatus` | `"strong"` | not in §1.2 | `run.wait()`. |
| `turns.multiNativeTurnsPerRequest` | `false` | not in §1.2 | A background subagent's follow-up turn belongs to the same run, so one ARI turn. |
| `turns.steeringInterruptsTools` | `false` | not in §1.2 | A steer moves a running foreground subagent to the background, which keeps running (docs, "Steering a run in flight"). |
| `streaming.assistantText` | `true` | not in §1.2 | |
| `streaming.reasoning` | `true` | not in §1.2 | |
| `streaming.toolOutput` | `false` | Y | The SDK types shell output updates as `{ event: Record<string, unknown> }` (`types/delta-types.d.ts` `ShellOutputDeltaUpdate`), with no shape to map; output arrives with the tool's result. |
| `streaming.planText` | `true` | Y | `createPlan` arguments stream in `partial-tool-call` updates. |
| `tools.mcp` | `true` | Y | Inline `mcpServers`. |
| `tools.dynamicTools` | `false` | – | |
| `tools.mcpApps` | `false` | not in §1.2 | |
| `tools.exposesToolItemIds` | `true` | not in §1.2 | Tool items keep Cursor's call id in `native.id`. |
| `approvals.command` | `false` | – | |
| `approvals.fileRead` | `false` | – | |
| `approvals.fileChange` | `false` | – | |
| `approvals.permission` | `false` | not in §1.2 | |
| `approvals.fromSubagents` | `false` | – | |
| `planning.todoList` | `true` | Y | `updateTodos`. |
| `planning.proposedPlan` | `true` | Y | `createPlan`. |
| `planning.planUpdates` | `true` | not in §1.2 | The thread's plan follows `updateTodos`. |
| `planning.structuredQuestions` | `false` | – | A local run rejects the agent's questions itself (`977.js`). |
| `subagents.supported` | `true` | Y | The `task` tool. |
| `subagents.exposesThreadIds` | `false` | – | |
| `subagents.lifecycle` | `true` | not in §1.2 | |
| `subagents.wait` | `true` | Y | The run waits for its background subagents (docs, "Background subagents"). |
| `subagents.stop` | `false` | – | |
| `context.instructionChannels` | `["first_user_message"]` | – | §1.2 has "–/–" for system and developer context. `systemPrompt` replaces Cursor's prompt (docs, "Replacing the system prompt"), so host text goes in the first prompt. |
| `context.syntheticContext` | `false` | not in §1.2 | |
| `context.summaries` | `true` | Y | `agent.summarize()`. |
| `context.handoffSummaries` | `false` | not in §1.2 | |
| `checkpointing.workspace` | `false` | not in §1.2 | |
| `checkpointing.conversationRollback` | `false` | – | |
| `checkpointing.rollbackReturnsSnapshot` | `false` | not in §1.2 | |
| `identity.threadIds` | `"strong"` | not in §1.2 | |
| `identity.turnIds` | `"strong"` | strong | §1.2's ID row. |
| `identity.itemIds` | `"weak"` | weak | §1.2's ID row. |
| `identity.requestIds` | `"none"` | none | §1.2's ID row. |
| `identity.identityVersion` | `1` | not in §1.2 | |
| `runtimePolicy.modes.read_only.supported` | `true` | not in §1.2 | `AgentOptions.tools` offers only reading tools (`read`, `grep`, `glob`, `ls`, `semSearch`, `readLints`, `readTodos`, `updateTodos`, `createPlan`); no shell, edits, MCP or subagents. |
| `runtimePolicy.modes.read_only.enforcement` | `"native"` | native | Cursor offers the model only the listed tools. |
| `runtimePolicy.modes.approval_required.supported` | `false` | not in §1.2 | No approval flow in headless runs (docs, "Sandbox options"). |
| `runtimePolicy.modes.approval_required.enforcement` | `"native"` | native | |
| `runtimePolicy.modes.auto_accept_edits.supported` | `false` | not in §1.2 | |
| `runtimePolicy.modes.auto_accept_edits.enforcement` | `"native"` | native | |
| `runtimePolicy.modes.auto.supported` | `false` | not in §1.2 | `local.autoReview` falls back to running every call when the backend lacks the classifier (docs, "Auto-review"), so the mode cannot be promised. |
| `runtimePolicy.modes.auto.enforcement` | `"native"` | native | |
| `runtimePolicy.modes.full_access.supported` | `true` | not in §1.2 | A local agent's default: every tool runs (docs, "Sandbox options"). |
| `runtimePolicy.modes.full_access.enforcement` | `"native"` | native | |
| `runtimePolicy.interactionModes` | `["default","plan"]` | not in §1.2 | `mode: "plan"` (docs, "Conversation mode"). |
| `runtimePolicy.switchInSession` | `true` | not in §1.2 | The interaction mode is set per run; the runtime mode is not (`sessions.switchRuntimeMode`). |
| `requests.responseModes` | `[]` | not in §1.2 | No requests. |
| `requests.allowCustomAnswer` | `false` | not in §1.2 | |
| `requests.approvalScopes` | `[]` | not in §1.2 | |
| `background.list` | `false` | not in §1.2 | |
| `background.stop` | `false` | not in §1.2 | |
| `background.await` | `false` | not in §1.2 | |
| `background.tasksEndWithProcess` | `true` | not in §1.2 | The agent loop is part of the host's process. |
| `mcp.acceptsHostServers` | `["stdio","http","sse"]` | not in §1.2 | `McpServerConfig` (`options.d.ts`). |
| `mcp.scope` | `"thread"` | not in §1.2 | Inline servers per agent and per run. |
| `sessionModel` | `"in_process"` | not in §1.2 | The SDK runs the agent loop in the host's Node process (docs, "Overview"). |
| `externallyOwned` | `false` | not in §1.2 | |
| `diffs.emits` | `true` | not in §1.2 | The edit tool's `diffString`. |
| `diffs.canDisable` | `true` | not in §1.2 | `emitDiffs: false` leaves it out. |
| `contextWindowReporting` | `false` | not in §1.2 | `Cursor.models.list()` gives no context window. |
| `extensions` | `[]` | not in §1.2 | |

## Optional members

Of the 44 optional `Session` and `Instance` members, the driver implements
`compactThread`, `unloadThread` and the `auth` group. `forkThread` rejects
with `unsupported{capability: "threads.fork"}` and `rollbackThread` with
`unsupported{capability: "threads.rollback"}`, before any SDK call: Cursor's
SDK can neither fork nor rewind an agent's conversation. `auth.complete`
rejects with `unsupported{capability: "auth.complete"}`, because no Cursor
sign-in returns through a callback URL. Every other optional member is left
out.
`test/drivers/cursor/capabilities.test.ts` holds the full list.

## Limits

- The SDK runs inside the host's process, so its shell tools inherit the host's
  `process.env` (`977.js` builds every shell environment from `process.env`).
  The driver keeps inherited credentials from signing in, by always passing
  `apiKey`, but cannot hide the host's environment from the agent's tools.
- Cursor writes its transcripts and MCP descriptors under its data directory
  (see "Where Cursor writes them"); only `CURSOR_DATA_DIR` moves it.
- No snapshots, so a host that reloads a thread keeps its own history.
- Summary updates of an automatic compaction inside a run do not reach
  `onDelta` (`index.js` run-interaction-accumulator), so they are not shown.
- Cloud agents (`cloud` options) are not supported: the driver runs local
  agents only.

## Tests

- `test/drivers/cursor/conformance.test.ts`: all 15 scenarios against the fake
  SDK. Scenarios 8 and 15 do not apply (no approvals); the harness gives
  reasons for three checks: a locked session (Cursor's store has no lock), a
  usage limit's reset time (Cursor reports none) and inherited credentials in
  the agent's environment (the host's own `process.env`).
- `test/drivers/cursor/fake-sdk.ts`: the fake. It creates and resumes agents
  with the real SDK, offline, in the real `JsonlLocalAgentStore`; it fakes
  only the runs, and checks every update with the SDK's
  `InteractionUpdateSchema`.
- `test/drivers/cursor/real-sdk.test.ts`: the driver against the real SDK,
  offline: threads created, resumed and replaced, with every outbound
  connection refused.
- `test/drivers/cursor/sdk-types.test.ts`: the driver's SDK types against
  `@cursor/sdk` 1.4.2.
- `capabilities.test.ts`, `availability.test.ts`, `launch-context.test.ts`,
  `auth.test.ts`, `quirks.test.ts` and `meta.test.ts` cover the driver rules.
