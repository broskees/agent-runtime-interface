# ACP base driver (`ari/drivers/acp`)

`ari/drivers/acp` runs any agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) on stdio.
The user names the agent: the driver spawns the configured `command` with
its `args` through the host's `process.spawn`, speaks newline-delimited
JSON-RPC 2.0 with it, and maps ACP onto ARI. `ari/meta/acp` holds its label,
icon, config schema and form hints, and imports nothing at run time.

The five flavor drivers are this driver with a fixed launch and a few
quirks: [`grok`](grok.md), [`fx`](fx.md), [`kiro`](kiro.md),
[`acp-registry`](acp-registry.md) and [`antigravity`](antigravity.md).
Build your own with `createAcpDriver(flavor)`.

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
| `env` | `{}` | Extra environment variables for the agent. Not for credentials: config is not secret. |
| `versionArgs` | `["--version"]` | What `probe()` runs to read the agent's version. |
| `maxProtocolVersion` | `1` | The newest ACP version to request. ACP v2 is in Preview and ACP's migration guide suggests clients request it opt-in, so the default asks for v1; set `2` to ask for v2 (a v1 agent still answers with v1). |
| `forkAcrossDirectories` | `false` | Whether `forkThread` may move a fork into another directory. |
| `configDependencies` | `{}` | Dependencies between the agent's config options that ACP cannot state, as option id to the ids it depends on. |

## How ACP maps onto ARI

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
  (v2), patched by later ones. Tool kinds map to item kinds (`read` to
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
- **Host tools.** `launch.mcpServers` go to `session/new` under exactly the
  names the host gave them. ACP fixes a session's MCP servers in
  `session/new`, before an ARI thread id exists, so the driver does not call
  `hostTools.mcpServerFor` itself: a host that wants per-thread host tools
  calls it and passes the result in `launch`.
- **Extension `acp`.** Vendor `_meta` objects (on `initialize`, `session/new`,
  prompt results, updates, tool calls, permission requests and their options)
  reach the host as `x:acp.meta` events; session updates the driver does not
  map (for example v1 `current_mode_update`) arrive as `x:acp.update` events.
  `session.ext("acp", "_method", params)` sends an ACP extension request.
  Schemas: `spec/v1/extensions/acp.schema.json`.

## Capabilities

The proposal's §1.2 column for the ACP base, against what this driver
declares. "Agent" means it depends on what the agent advertises in
`initialize`.

| Capability | §1.2 ACP base | This driver | Source for the difference |
|---|---|---|---|
| Switch model mid-session | – | Y | ACP session config options: `session/set_config_option` changes a running session's model option ([v1](https://agentclientprotocol.com/protocol/v1/session-config-options.md), [v2](https://agentclientprotocol.com/protocol/v2/session-config-options.md)) |
| Switch runtime mode mid-session | – | – | |
| Read thread snapshot | – | – | |
| Roll back thread | Y | – | ACP defines no rollback method in v1 or v2 (the `x-method` tables of `vendor-schemas/acp/schema-v2.0.0-beta.3`); host checkpoints stay in the host (proposal §16) |
| Fork thread / fork from a turn | –/– | agent/– | Draft `session/fork` ([RFD](https://agentclientprotocol.com/rfds/session-fork.md)), declared when the agent advertises `session.fork`; forking at a position needs session cursors, which this driver does not use |
| Fork into another directory | (not in §1.2) | config, then agent | The RFD lets an agent refuse a fork into a different `cwd`; `crossCwd` starts from `forkAcrossDirectories`, and turns off (with `capabilities.updated`) when the agent refuses one |
| Fork from a subagent thread | – | – | |
| Steer an active turn | – | – | |
| Steer by interrupt + restart | Y | – | A host fallback, not a provider capability (proposal §6: unsupported steers go to `planFallback`) |
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
| Can generate summaries | Y | – | ACP has no summary method |
| Native turn / item / request ID strength | weak/weak/weak | none/weak/weak | ACP has no turn id ([prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle.md)) |
| Policy enforcement | client-boundary | `client_boundary` for every mode | |

Runtime modes: `approval_required` and `full_access` are supported, both
`client_boundary`; the others are declared off. `requests.allowCustomAnswer`
is false, `responseModes` is `live`. Diffs are emitted and can be turned off.

## Optional members (44)

| Members | Outcome |
|---|---|
| `forkThread` | Present. Works when the agent advertises `session/fork` (at `latest`; `fromTurn` and `fromItem` reject `unsupported`); otherwise rejects `unsupported{threads.fork}` |
| `ext` | Works for namespace `acp`; any other namespace rejects `unsupported` |
| The other 15 Session members (`readSnapshot`, `rollbackThread`, `compactThread`, `injectHistory`, `unloadThread`, `backgroundTasks.*`, `stopSubagent`, `mcpApps.*`, `contextWindow`, `canReuseContextUsage`, `uploadFeedback`) | Left out |
| All 27 optional Instance members (`invalidateCaches`, `maintenance.*`, `auth.*`, `catalog.refresh`, `workspace.snapshot`, `limits.*`, `usageHistory.scan`, `textGeneration.generate`, `nativeSessions.*`, `subProviders.*`) | Left out. Agents sign in through their own CLI, so `auth` is left out and an ACP `-32000` becomes `auth_required` |

`test/drivers/acp/rules.suite.ts` checks every one of the 44.

## Missing agent

Importing the driver starts nothing. With `command` not found, `create()`
succeeds, `status()` reports `unavailable` with a `driver_unavailable` error
naming the binary, and `openSession` rejects with `driver_unavailable`.
`probe()` only resolves the executable and runs it with `versionArgs`.
The base driver runs any agent, so it declares no tested agent versions and
gives no version advisory; it is tested against ACP protocol versions 1 and
2 at schema release `schema-v2.0.0-beta.3`.

## Tests

- `test/drivers/acp/conformance.suite.ts`: all 15 scenarios against an agent
  written with `@agentclientprotocol/sdk` 2.9.1, once over v1 and once over
  v2, with every frame checked against ACP's schema.
- `test/drivers/acp/protocol.suite.ts`: negotiation, the v2 lifecycle, upserts,
  fork constraints, `dependsOn`, native option ids, `_meta` passthrough.
- `test/drivers/acp/standalone.suite.ts`: the self-contained fake agent under
  real `ari/node` host services.
- `test/drivers/acp/SOURCES.md`: where the fakes' protocol comes from.

## Not done

- ACP authentication (`authenticate`, `auth/login`), elicitation, subagents,
  session list/delete and v1 session modes are not mapped; v1
  `current_mode_update` arrives as `x:acp.update`.
- A v1 agent that can neither resume nor load sessions gets a fresh session on
  resume, with `session.replaced` and `contextLost: true`.
