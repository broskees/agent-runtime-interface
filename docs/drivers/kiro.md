# Kiro driver (`ari/drivers/kiro`)

`ari/drivers/kiro` runs Kiro CLI's V3 agent harness over ACP. It is the
[ACP base driver](acp.md) with Kiro's launch and quirks. `ari/meta/kiro`
holds its label, icon, config schema and form hints.

## Launch

`kiro-cli acp --agent-engine=v3 --auth-method=cli`

- `kiro-cli acp` serves ACP on stdio; `--agent-engine=v3` picks the V3
  harness whatever `acp.agentEngine` the user set, because older harnesses
  have another ACP surface (Kiro CLI docs, "Choose the agent harness").
- `--auth-method=cli` keeps access tokens inside Kiro. Sign in with
  `kiro-cli login`.
- Kiro advertises `loadSession`, so stored sessions come back through
  `session/load` (the driver suppresses the replayed history).

## Quirk: autopilot follows the runtime mode

Kiro's `autopilot` session option decides whether Kiro acts without asking.
The driver sets it from the thread's runtime mode whenever Kiro offers it:
off under `approval_required`, on under `full_access`
(`test/drivers/kiro/kiro.suite.ts`). The host's own config values win.

## Config

| Field | Default | Meaning |
|---|---|---|
| `command` | `kiro-cli` | The Kiro CLI. |
| `maxProtocolVersion`, `forkAcrossDirectories`, `configDependencies` | `1`, `false`, `{}` | As for the [ACP base driver](acp.md#config). |

## Tested versions

Kiro CLI `>=3.0.0 <4.0.0` (the ACP registry lists Kiro CLI 3.0.0 with this
launch; V3 settles turns from the `session/prompt` response, which is ACP
v1). `status()` reports the version `kiro-cli --version` prints and an
`untested_version` advisory outside that range.

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
| Runtime mode | (not in §1.2) | `client_boundary`, plus Kiro's `autopilot` | Kiro CLI docs and its `autopilot` session option |

## Optional members

As the [ACP base driver](acp.md#optional-members-44); `test/drivers/kiro/rules.suite.ts`
checks all 44.

## Missing CLI

With `kiro-cli` not on PATH, `create()` succeeds, `status()` is
`unavailable` with `driver_unavailable` naming `kiro-cli`, and
`openSession` rejects with `driver_unavailable`.

## Sources

- Kiro CLI ACP docs: https://kiro.dev/docs/cli/acp/ (page updated 2026-11-18).
- ACP registry entry `kiro` 3.0.0: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json.
- T3 Code's public Kiro provider, read for the launch arguments and the
  `autopilot` option only, at commit `67c442a17e6e5d6c9f768714820cecb5f15d4f9b`:
  https://github.com/pingdotgg/t3code/blob/67c442a17e6e5d6c9f768714820cecb5f15d4f9b/packages/provider-kiro/src/server/acpSupport.ts.
