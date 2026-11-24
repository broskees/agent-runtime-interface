# Grok driver (`ari/drivers/grok`)

`ari/drivers/grok` runs xAI's Grok Build CLI as an ACP agent. It is the
[ACP base driver](acp.md) with Grok's launch and quirks. `ari/meta/grok`
holds its label, icon, config schema and form hints.

## Launch

`grok --permission-mode default agent stdio`

- `agent stdio` runs Grok without its UI, as an ACP agent on stdio
  (`grok agent --help` of Grok 1.0.70; the ACP registry entry `grok-build`
  1.0.93 launches `agent stdio` too).
- `--permission-mode default` makes Grok ask before it acts whatever the
  user's Grok config says, so a supervised thread never inherits an
  always-approve setting. Under `full_access` the ACP driver answers each
  permission request itself with the narrowest accepting option
  (`client_boundary`).
- `probe()` runs `grok --version` with `GROK_DISABLE_AUTOUPDATER=1`, so a
  health check never starts Grok's updater; sessions keep the user's update
  setting.
- The CLI manifest scrubs `XAI_` variables: an instance uses the Grok login
  it was set up with (`grok login`), never an `XAI_API_KEY` it inherited.
  Its terminal fallback is `grok`, `grok --resume <id>` and
  `grok --resume <id> --fork-session` (all in `grok --help`).

## Config

| Field | Default | Meaning |
|---|---|---|
| `command` | `grok` | The Grok CLI. |
| `maxProtocolVersion`, `forkAcrossDirectories`, `configDependencies` | `1`, `false`, `{}` | As for the [ACP base driver](acp.md#config). |

## Tested versions

Grok Build CLI `>=1.0.70 <1.1.0`: the launch was read from the installed
CLI 1.0.70's `--help` (never run against an account) and the ACP registry
entry `grok-build` 1.0.93. `status()` reports the version `grok --version`
prints and an `untested_version` advisory outside that range.

## Capabilities

The proposal's §1.2 has no column for this provider (its Grok column was
unreadable, and Antigravity, fx, Kiro and registry agents were not
extracted), so the nearest column, the ACP base, is compared. This driver
declares what the ACP base driver declares ([acp.md](acp.md#capabilities)),
with the differences in the last rows.

| Capability | §1.2 ACP base | This driver | Source for the difference |
|---|---|---|---|
| Switch model mid-session | – | agent | ACP has no model method; `session/set_config_option` changes an option in the `model` category. Declared while the agent offers one, with `capabilities.updated` on a change ([acp.md](acp.md#capabilities)) |
| Roll back thread | Y | – | ACP defines no rollback method |
| Fork thread / fork from a turn | –/– | agent/– | Draft `session/fork`, declared when the agent advertises it |
| Steer by interrupt + restart | Y | – | ACP has no method that changes a running prompt: cancel with `session/cancel`, then a new `session/prompt` ([v1 prompt turn, "Cancellation"](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#cancellation)); the host does that through `planFallback` |
| Queued messages / interrupt | Y/Y | –/Y | ACP has no native queue; the host queues |
| MCP tools | – | Y | `session/new` takes `mcpServers` |
| Structured questions | Y | – | The driver does not advertise ACP elicitation |
| Todo list / proposed plan | Y/– | Y/v2 | v2 markdown plans |
| Accepts system / developer context | –/– | agent/first message | `systemPrompt` capability of `session/new` |
| Can generate summaries | Y | – | Neither ACP version's method list has a summary request ([v1 overview](https://agentclientprotocol.com/protocol/v1/overview.md), [v2 overview](https://agentclientprotocol.com/protocol/v2/overview.md)) |
| ID strength (turn / item / request) | weak/weak/weak | none/weak/weak | ACP has no turn id |
| Policy enforcement | client-boundary | `client_boundary` | |
| Session model | (not in §1.2) | `process_per_session` | One agent process per ARI session, shared by its threads ([acp.md](acp.md#capabilities)) |
| Runtime mode enforcement | (not in §1.2) | `client_boundary` | Grok's own `--always-approve` is not used, so `full_access` is enforced by the driver's replies |

## Optional members

As the [ACP base driver](acp.md#optional-members-44): `ext` works, and
`forkThread` rejects `unsupported` unless Grok advertises `session/fork`;
the other 42 members are left out. `test/drivers/grok/rules.suite.ts`
checks all 44.

## Missing CLI

With `grok` not on PATH, `create()` succeeds, `status()` is
`unavailable` with `driver_unavailable` naming `grok`, and `openSession`
rejects with `driver_unavailable`.

## Sources

- `grok --help` and `grok agent --help` of Grok Build 1.0.70 (run locally).
- ACP registry entry `grok-build`: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json (read 2026-11-23).
- T3 Code's public provider, read for the launch arguments per runtime mode and
  the probe's updater switch only, at commit `67c442a17e6e5d6c9f768714820cecb5f15d4f9b`:
  https://github.com/pingdotgg/t3code/blob/67c442a17e6e5d6c9f768714820cecb5f15d4f9b/packages/provider-grok/src/server/acpSupport.ts and
  https://github.com/pingdotgg/t3code/blob/67c442a17e6e5d6c9f768714820cecb5f15d4f9b/packages/provider-grok/src/server/probeEnvironment.ts.
