# ACP base driver (`ari/drivers/acp`)

`ari/drivers/acp` runs any agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) on stdio.
The user names the agent: the driver spawns the configured `command` with
its `args` through the host's `process.spawn`, speaks newline-delimited
JSON-RPC 2.0 with it, and maps ACP onto ARI. `ari/meta/acp` holds its label,
icon, config schema and form hints, and imports nothing at run time.

The four flavor drivers are this driver with a fixed launch and a few
quirks: [`grok`](grok.md), [`fx`](fx.md), [`kiro`](kiro.md) and
[`antigravity`](antigravity.md). Build your own with
`createAcpDriver(flavor)`.

ARI installs no agent. The user installs it and names its `command` here.
That includes agents from the [ACP Registry](https://agentclientprotocol.com/get-started/registry):
install one with its own installer, then point `command` and `args` at it.
There is no `acp-registry` driver; an earlier build had one that installed
registry agents.

```ts
import { acpDriver } from "ari/drivers/acp";

const instance = await acpDriver.create(host, {
  instanceId: "my-agent",
  config: { ...acpDriver.defaultConfig(), command: "my-acp-agent", args: ["acp"] },
  environment: {},
});
```

## Config

| Field | Default | Meaning |
|---|---|---|
| `command` | `""` | The agent executable, found on PATH unless it is a path. Until it is set, `status()` reports `setup_required`. |
| `args` | `[]` | Arguments that start the agent in ACP mode. |
| `env` | `{}` | Extra environment variables for the agent, set over the instance's `environment`. Not for credentials: config is not secret. |
| `versionArgs` | `["--version"]` | What `probe()` runs to read the agent's version. |
| `maxProtocolVersion` | `1` | The newest ACP version to request. ACP v2 is in Preview and ACP's migration guide suggests clients request it opt-in, so the default asks for v1; set `2` to ask for v2 (a v1 agent still answers with v1). |
| `forkAcrossDirectories` | `true` | Whether `forkThread` asks the agent for a fork into another directory. The agent may refuse a destination; `false` refuses every such fork before the agent hears of it. |
| `configDependencies` | `{}` | Dependencies between the agent's config options that ACP cannot state, as option id to the ids it depends on. |

## How ACP maps onto ARI

- **Environment.** Every agent process and version command gets the host's
  environment and the instance's `environment`, credentials included, minus
  only what the host's `envPolicy.stripAmbient` names, with the flavor's own
  variables (`env` here) over them. The same holds for every flavor: `grok`,
  `kiro`, `fx` and `antigravity`.
- **Versions.** `initialize` asks for `maxProtocolVersion`; the agent answers
  with the version it speaks, and the connection uses that version's frames
  from then on. The driver's ACP clients are typed by tables generated from
  ACP's own v1 and v2 JSON Schemas (`scripts/codegen-acp.ts`, vendored in
  `vendor-schemas/acp/schema-v2.0.0-beta.3/`, drift-checked by
  `pnpm run codegen:acp:check`). The package does not depend on
  `@agentclientprotocol/sdk`; tests use it for their fake agents.
- **Threads.** One ACP session is one ARI thread; the agent process (one per
  ARI session) holds as many as the host creates. Thread ids derive from the
  ACP session id. `cwd` is resolved to its real path first, so a workspace
  reached through a symbolic link gives the same thread.
- **Turns.** ACP has no turn ids; a turn is its position in the thread
  (identity `none`).
  - v1: the `session/prompt` response ends the turn; its `stopReason` gives
    the status.
  - v2: the `session/prompt` response only says the prompt was accepted
    (`startTurn` returns its `messageId` as `providerMessageId`). The turn
    ends on the `state_update` that reports `idle` after the turn's work was
    reported `running` or `requires_action`; an idle snapshot that comes
    before that is an earlier state repeated, and ends nothing. A `running`
    state with no turn open is work the agent started itself: a turn with
    `origin: "provider_initiated"`.
  - Stop reasons: `end_turn` completes; `cancelled` interrupts; v2 `error`
    fails with `provider_error`; `max_tokens`, `max_turn_requests` and
    `refusal` complete with a warning notice. Nothing settles a turn on a
    timer: only the agent's answer or its process exiting does (then the
    turn fails with `transport_error`, thread `broken`; the next call starts
    the agent again and loads the thread's session).
- **Items are upserts.** An assistant message (or a thought, as `reasoning`)
  is one item whose text grows with its chunks. ACP v1 has no end-of-message
  signal, so a message settles when any other update arrives, or when the
  turn ends; a v2 whole-message update (`agent_message`) carries the finished
  message, so it settles it and replaces what the chunks built. A tool call is
  one item: created by its first `tool_call` (v1) or `tool_call_update`
  (v2), patched by later ones under each version's own rule:
  - v2 (`ToolCallUpdate` in the vendored schema): an omitted field keeps
    its value, `null` clears it (a `null` title or `locations` clears the
    item's `title` or `paths`), a value replaces it.
  - v1 ([Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls.md)):
    "Only the fields being changed need to be included", and `null` clears
    nothing. For `rawInput` and `rawOutput` the docs say omission and `null`
    "both leave the previously reported value unchanged", and for `name`
    "Omission and `null` both leave the existing name unchanged". Clearing
    with `null` is new in v2 ([v2 migration](https://agentclientprotocol.com/protocol/v2/migration.md):
    `tool_call_update` is "Now an explicit upsert with omit/`null`/value
    patch semantics"). A concrete value, including `[]`, still replaces.

  The item's `output` is the agent's `rawOutput` when it sent one, else the
  text of the tool's content; its `tool` field always carries the stored
  input and `rawOutput` (as `result`), because an ARI patch replaces `tool`
  whole. A v2 `user_message` replaces a user message's content and a
  `user_message_chunk` appends to it (`UserMessage`): the first one in a
  turn the host started is the agent's copy of the prompt, so it updates the
  turn's user item rather than opening another. That item shows only the
  host's own words: while the agent's copy matches what the driver sent
  (whole, or the chunks so far), it keeps the host's text, and a copy the
  agent changed (a redaction, say) shows the agent's text without the
  instructions the driver put first. Later user messages open their own user
  items. v1 user chunks only echo the prompt and are ignored. Tool kinds map to item kinds (`read` to
  `file_read`, `edit`/`delete`/`move` to `file_change`, `search` to
  `file_search`, `execute` to `command_execution`, `fetch` to `web_search`,
  others to `tool_call`); diff content becomes `changes` (with diff text
  unless `openSession({ emitDiffs: false })`). Plans become `todo_list`
  items; v2 markdown plans become `proposed_plan` items.
- **Requests.** `session/request_permission` becomes a `live` request whose
  options keep the agent's own option ids; `respond` answers with that id,
  never a label. `allow_once` is `accept` reaching `once`; `allow_always`
  is `accept_always` reaching `project` (ACP says the choice is remembered,
  not how widely, so the driver claims the widest reach a local agent can
  have). Under `full_access` the driver answers itself with the narrowest
  accepting option. On Stop, v1 pending requests are answered `cancelled`;
  v2 agents cancel them with `$/cancel_request`.
- **Config options** become ARI config options (`scope: "thread"`,
  `changeEffect: "next_turn"`); values passed to `createThread` or
  `startTurn` are sent with `session/set_config_option` first. Every list the
  agent sends keeps the `dependsOn` from `configDependencies`.
- **Host instructions.** `launch.appendSystemPrompt` and `context.system`
  go in `session/new`'s `systemPrompt` when the agent advertises it (channel
  `system`), else at the top of the thread's first prompt; `launch.developerPrompt`
  and `context.developer` always go at the top of the first prompt (channel
  `first_user_message`). Without them, the driver adds no text of its own.
  Instructions sent in the first prompt never appear in the turn's
  `user_message` item, which holds the host's content only.
  `resumeThread` does the same with its `launch`: `system` goes in the
  `systemPrompt` of `session/resume` or `session/load` (both versions take
  one) or of the `session/new` that replaces a session the agent could not
  open, and the rest goes at the top of the first prompt after the resume.
- **Resume.** v2 and v1 agents that advertise it get `session/resume`; v1
  agents that only load get `session/load`, whose replayed history is not
  reported as live output. ACP v2 sends the session's current state after
  any replay and before the resume response ([current-state
  synchronization](https://agentclientprotocol.com/protocol/v2/session-setup.md#current-state-synchronization));
  the driver applies it once the thread is registered, so work already
  `running` becomes a `provider_initiated` turn that the agent's later `idle`
  settles. A session the agent reports missing (`resource_not_found`) is
  replaced by a fresh one, with `session.replaced` and `contextLost: true`;
  any other refusal goes to the caller.
- **Resume of a held thread.** A resume of a session this ARI session holds
  open sends no `session/resume`: its `config` and `policy` take effect at
  once (`session/set_config_option`), and its first-prompt instructions go
  at the top of the next prompt. ACP fixes a session's MCP servers and
  system prompt when it opens it, so a resume that brings other ones is
  refused with `invalid_state` (`session_open`), as is any change while a
  turn runs (`turn_active`).
- **Host tools.** `launch.mcpServers` go to `session/new` under exactly the
  names the host gave them. ACP fixes a session's MCP servers in
  `session/new`, before an ARI thread id exists, so the driver does not call
  `hostTools.mcpServerFor` itself: a host that wants per-thread host tools
  calls it and passes the result in `launch`.
- **Extension `acp`.** Vendor `_meta` objects (on `initialize`, `session/new`,
  prompt results, updates, tool calls, permission requests and their options)
  reach the host as `x:acp.meta` events; session updates the driver does not
  map arrive as `x:acp.update` events, and so does v1 `current_mode_update`,
  which also updates the thread's `effectiveMode`.
  `session.ext("acp", "_method", params)` sends an ACP extension request.
  Schemas: `spec/v1/extensions/acp.schema.json`.

## Resuming conversations ARI did not create

The driver resumes any ACP session the host names, whoever created it: it
keeps no record of which sessions it started. `resumeThread` sends
`session/resume` (v2, or v1 when the agent advertises it) or `session/load`
(v1) for that id in the directory `policy.cwd` names; for a session this ARI
session has not seen, a missing `policy.cwd` is refused with `validation`. The
request carries only what the host supplied: the host's MCP servers under the
names it chose, and its launch instructions (`systemPrompt` where the agent
takes one, the rest in the thread's first prompt). When the agent reports
the session missing (`resource_not_found`), the driver starts a fresh session
in that directory and emits `session.replaced` with `contextLost: true`. Any
other error goes to the caller as the agent gave it: ACP has no error for a
session another process holds, so the driver cannot tell a held session from
another failure. An agent that can neither resume nor load sessions refuses
with `unsupported` (`acp.session/resume`). The driver lists no native
sessions (`nativeSessions` is absent). The five flavors below share this
behaviour.

A resume with `purpose: "history"` of a session this ARI session does not
hold is refused with `unsupported` (`resumeThread.purpose.history`), and the
driver sends nothing: ACP opens a session only to run it (`session/resume`,
`session/load`), so there is no read-only history. A thread this session
holds is reported as it is.

## Capabilities

The proposal's §1.2 column for the ACP base, against what this driver
declares. "Agent" means it depends on what the agent advertises in
`initialize`.

| Capability | §1.2 ACP base | This driver | Source for the difference |
|---|---|---|---|
| Switch model mid-session | – | agent | ACP has no model method; `session/set_config_option` changes a running session's option in the `model` category ([v1](https://agentclientprotocol.com/protocol/v1/session-config-options.md), [v2](https://agentclientprotocol.com/protocol/v2/session-config-options.md)). Declared while a thread's agent offers such an option; `capabilities.updated` reports the change |
| Switch runtime mode mid-session | – | – | |
| Read thread snapshot | – | – | |
| Roll back thread | Y | – | ACP defines no rollback method in v1 or v2 (the `x-method` tables of `vendor-schemas/acp/schema-v2.0.0-beta.3`); host checkpoints stay in the host (proposal §16) |
| Fork thread / fork from a turn | –/– | agent/– | Draft `session/fork` ([RFD](https://agentclientprotocol.com/rfds/session-fork.md)), declared when the agent advertises `session.fork`; forking at a position needs session cursors, which this driver does not use |
| Fork into another directory | (not in §1.2) | agent | The RFD lets an agent refuse a fork into a different `cwd`. `crossCwd` follows `forkAcrossDirectories` (default `true`): the driver asks the agent, and a refusal fails that fork with the agent's error while later forks are still asked |
| Fork from a subagent thread | – | – | |
| Steer an active turn | – | – | |
| Steer by interrupt + restart | Y | – | ACP has no method that changes a running prompt: the client cancels it with `session/cancel` and, once the turn ends, sends another `session/prompt` ([v1 prompt turn, "Cancellation"](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#cancellation)). The host does that through `interruptTurn` and `startTurn` (its `planFallback`), so the driver declares no steering |
| Queued messages / interrupt | Y/Y | –/Y | v1 has no queue; a v2 agent may insert a prompt into running work ([prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle.md)), which is not a separate queued turn; the host queues |
| Streams tool output | Y | Y | |
| Streams plan text | – | – | |
| MCP tools | – | Y | `session/new` takes `mcpServers` in both versions ([v2 migration](https://agentclientprotocol.com/protocol/v2/migration.md), "MCP server configuration") |
| Dynamic tool callbacks | – | – | |
| Command / file-change approval | Y | Y | |
| File-read approval | Y | Y | |
| Approvals from subagents | – | – | |
| Structured questions | Y | – | ACP elicitation needs the client's `elicitation` capability ([v2 elicitation](https://agentclientprotocol.com/protocol/v2/elicitation.md)); this driver does not advertise it |
| Todo list / proposed plan | Y/– | Y/v2 | v2 `plan_update` markdown plans ([v2 agent plan](https://agentclientprotocol.com/protocol/v2/agent-plan.md)) |
| Subagents / exposes child thread IDs | –/– | –/– | |
| Wait for / close subagents | –/– | –/– | |
| Accepts system / developer context | –/– | agent/first message | v1 `sessionCapabilities.systemPrompt` and v2 `session.systemPrompt` (schema `SessionSystemPromptCapabilities`) |
| Can generate summaries | Y | – | Neither version's method list has a summary request ([v1 overview](https://agentclientprotocol.com/protocol/v1/overview.md), [v2 overview](https://agentclientprotocol.com/protocol/v2/overview.md), "Agent"); a compaction summary comes only when the agent compacts on its own ([v1 prompt turn, "Session compaction"](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#session-compaction)) |
| Native turn / item / request ID strength | weak/weak/weak | none/weak/weak | ACP has no turn id ([prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle.md)) |
| Policy enforcement | client-boundary | `client_boundary` for every mode | |
| Session model | (not in §1.2) | `process_per_session` | `openSession` starts one agent process for the ARI session, and its threads share it (an ACP connection holds many sessions: [v2 session setup](https://agentclientprotocol.com/protocol/v2/session-setup.md)). None of the four named `SessionModel` values says that; the schema allows other strings |

Runtime modes: `approval_required` and `full_access` are supported, both
`client_boundary`; the others are declared off. `requests.allowCustomAnswer`
is false, `responseModes` is `live`. Diffs are emitted and can be turned off.

### The mode the agent reports

ACP has no runtime mode of ARI's: the driver enforces a host's mode only in
how it answers permission requests (`full_access` answers each itself with
the narrowest accepting option). A policy without `mode` enforces nothing:
every permission request goes to the host, and the agent applies its own
mode. The agent reports that mode as the current value of the select option
it offers in the `mode` category (config options supersede modes), else as
v1 `modes.currentModeId` in the response that opened the session
(`session/new`, `session/resume`, `session/load`, `session/fork`), updated
by each `config_option_update` and `current_mode_update`. ARI knows no
meaning for an agent's mode ids, so the thread's `effectiveMode` reports the
agent's id as given (`{ mode: "<id>", source: "harness" }`), or no mode when
the agent offers neither; a flavor maps the ids it has evidence for
([antigravity](antigravity.md), [kiro](kiro.md), [grok](grok.md)). A host's
mode is reported with `source: "host"`. A turn's or a held thread's resume
policy that names no mode keeps the thread's mode. A
`current_mode_update` still reaches the host as `x:acp.update` too.

## Optional members (42)

| Members | Outcome |
|---|---|
| `forkThread` | Present. Works when the agent advertises `session/fork` (at `latest`; `fromTurn` and `fromItem` reject `unsupported`); otherwise rejects `unsupported{threads.fork}` |
| `ext` | Works for namespace `acp`; any other namespace rejects `unsupported` |
| The other 15 Session members (`readSnapshot`, `rollbackThread`, `compactThread`, `injectHistory`, `unloadThread`, `backgroundTasks.*`, `stopSubagent`, `mcpApps.*`, `contextWindow`, `canReuseContextUsage`, `uploadFeedback`) | Left out |
| All 25 optional Instance members (`invalidateCaches`, `maintenance.advisory`, `auth.*`, `catalog.refresh`, `workspace.snapshot`, `limits.*`, `usageHistory.scan`, `textGeneration.generate`, `nativeSessions.*`, `subProviders.*`) | Left out. Agents sign in through their own CLI, so `auth` is left out and an ACP `-32000` becomes `auth_required` |

`test/drivers/acp/rules.suite.ts` checks every one of the 42.

## Missing agent

Importing the driver starts nothing. With `command` not found, `create()`
succeeds, `status()` reports `unavailable` with a `driver_unavailable` error
naming the binary, and `openSession` rejects with `driver_unavailable`.
`probe()` only resolves the executable and runs it with `versionArgs`.

## Tested versions

The base driver runs any agent, so its vendor is the protocol: it is tested
against ACP protocol versions 1 and 2 at schema release
`schema-v2.0.0-beta.3` (`testedVersions.range` is `1 - 2`). The driver
cannot speak another version, so an agent that answers `initialize` with one
fails `openSession` with a `protocol` error, and from then on `status()`
gives an `untested_version` advisory naming the version it answered
(`testedRange: "1 - 2"`). Every flavor gives the same protocol advisory; a
flavor with a fixed vendor CLI also gives one for a release outside its own
range. `test/drivers/acp/driver-rules.ts` checks both for all five drivers.

## Tests

- `test/drivers/acp/conformance.suite.ts`: all 15 scenarios against an agent
  written with `@agentclientprotocol/sdk` 2.9.1, once over v1 and once over
  v2, with every frame checked against ACP's schema.
- `test/drivers/acp/protocol.suite.ts`: negotiation, the v2 lifecycle, upserts,
  fork constraints, `dependsOn`, native option ids, `_meta` passthrough.
- `test/drivers/acp/standalone.suite.ts`: the self-contained fake agent under
  real `ari/node` host services.
- `test/drivers/acp/frames.suite.ts`: every recording the ACP suites make
  (conformance, protocol, rules, flavor and standalone runs) checked against
  ACP's schema, with the number of recordings per test file pinned.
- `test/drivers/acp/SOURCES.md`: where the fakes' protocol comes from.

## Not done

- ACP authentication (`authenticate`, `auth/login`), elicitation, subagents
  and session list/delete are not mapped. The driver reads v1 session modes
  for the thread's `effectiveMode` but never sets one
  (`session/set_mode`).
- A v1 agent that can neither resume nor load sessions cannot resume:
  `resumeThread` refuses with `unsupported` (`acp.session/resume`).
- A v2 tool call's `kind` and `status` reset by `null` are not applied: an
  ARI item keeps the kind it opened with, and ACP agents do not move a tool
  call back to `pending`. (Under v1, `null` changes nothing anyway.)
