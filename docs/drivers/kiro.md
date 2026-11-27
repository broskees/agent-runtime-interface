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
v1). `status()` reports the version `kiro-cli --version` prints, an
`untested_version` advisory above that range, and `driver_unavailable` below
it (next section).

## The user's own `kiro-cli`, and its minimum

ARI runs the `kiro-cli` the user installed, found on `PATH` or at the path the
config names, and never downloads, installs or updates one. The minimum is
Kiro CLI 3.0.0, the lower bound of the tested range `>=3.0.0 <4.0.0`. With an
older `kiro-cli`, `status()` is `unavailable` with `driver_unavailable` (with
`installed: true` and the version found), and `openSession` rejects with the
same error before any agent starts: the only process that runs is `kiro-cli
--version`. The error names the version found, the path, the minimum and
Kiro's update step:

```text
Kiro 2.40.1 (/usr/local/bin/kiro-cli) is older than 3.0.0, the oldest version this driver supports. Update Kiro CLI with `kiro-cli update`.
```

The update step is Kiro's own. Kiro documents `kiro-cli update` as "Update
Kiro CLI to the latest version"; for a Kiro CLI a package manager installed,
it prints how to update with that package manager
([Kiro CLI commands, `kiro-cli update`](https://kiro.dev/docs/reference/cli-commands/#kiro-cli-update)). A
`kiro-cli` above the tested range still runs, with an `untested_version`
advisory. `kiro-cli --version` prints `kiro-cli <version>`, such as `kiro-cli
2.13.0` (`test/fixtures/cli-version-output/kiro-cli.txt`; Kiro CLI is closed
source, and the fixtures' `SOURCES.md` cites where the format comes from).

## Resuming conversations ARI did not create

The Kiro driver is the ACP base driver with the `kiro-cli acp` launch, so it
resumes the way [the `acp`
driver](acp.md#resuming-conversations-ari-did-not-create) does: it asks the
agent for any session id the host names, with only the host's LaunchContext,
and replaces a session the agent cannot resume with a fresh one and
`session.replaced`. It lists no native sessions.

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

As the [ACP base driver](acp.md#optional-members-42); `test/drivers/kiro/rules.suite.ts`
checks all 42.

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
