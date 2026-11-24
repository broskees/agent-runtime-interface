# fx driver (`ari/drivers/fx`)

`ari/drivers/fx` runs the multi-provider fx agent over ACP. It is the
[ACP base driver](acp.md) with fx's launch and quirk. `ari/meta/fx` holds its
label, icon, config schema and form hints.

## Launch

`fx acp`, the fx executable in ACP mode on stdio. Every fx instance on a
machine shares the machine's fx login.

## Quirk: the model depends on the provider

fx offers a `provider` select and a `model` select whose values change with
the provider. ACP config options cannot state a dependency, so the driver's
default `configDependencies` is `{ "model": ["provider"] }`: the ARI model
option carries `dependsOn: ["provider"]` on every option list fx sends,
including the list fx sends again after the provider changes
(`test/drivers/fx/fx.suite.ts`). A host shows the provider first and
re-reads the models after changing it.

## Config

| Field | Default | Meaning |
|---|---|---|
| `command` | `fx` | The fx executable. |
| `configDependencies` | `{ "model": ["provider"] }` | Keep it: it is how fx's model list is tied to its provider. |
| `maxProtocolVersion`, `forkAcrossDirectories` | `1`, `false` | As for the [ACP base driver](acp.md#config). |

## Tested versions

`>=0.0.13 <0.0.18`: fx 0.0.13 to 0.0.17. `status()` reports the version
`fx --version` prints and gives an `untested_version` advisory outside that
range (and the [ACP protocol advisory](acp.md#tested-versions)).

No fx binary ran. The range comes from the release the fake's protocol
facts come from, the way Kiro's range comes from Kiro's docs and registry
entry. Those facts (the `fx acp` launch and the `provider`, `model`, `mode`
and `effort` options) come from T3 Code's fx provider at commit `67c442a`
(see Sources), which describes fx 0.0.13 ("fx 0.0.13 has no such mode",
"fx 0.0.13 answers a cancelled prompt with `stopReason: cancelled`") and
fx 0.0.14 and later ("fx 0.0.14+"). That commit is dated 2026-11-23; the
newest fx release then was 0.0.17, of 2026-11-14
([vercel-labs/fx releases](https://github.com/vercel-labs/fx/releases):
0.0.13 on 2026-10-04 to 0.0.17). fx is pre-1.0, so the range stops at the
next unreleased patch, 0.0.18. The fake speaks ACP v1 with fx's provider and
model options; `test/drivers/fx/rules.suite.ts` checks `fx 0.0.17` (no
advisory) and `fx 0.0.12` (advisory).

## Resuming conversations ARI did not create

The fx driver is the ACP base driver with the `fx acp` launch, so it resumes
the way [the `acp` driver](acp.md#resuming-conversations-ari-did-not-create)
does: it asks the agent for any session id the host names, with only the
host's LaunchContext, and replaces a session the agent cannot resume with a
fresh one and `session.replaced`. It lists no native sessions.

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
| Config option dependencies | (not in §1.2) | model `dependsOn` provider | fx's provider and model options, as fx clients configure them |

## Optional members

As the [ACP base driver](acp.md#optional-members-44); `test/drivers/fx/rules.suite.ts`
checks all 44.

## Missing CLI

With `fx` not on PATH, `create()` succeeds, `status()` is `unavailable`
with `driver_unavailable` naming `fx`, and `openSession` rejects with
`driver_unavailable`.

## Sources

- fx publishes no ACP documentation this driver could find; the launch
  command (`fx acp`) and the option ids (`provider`, `model`, `mode`,
  `effort`) come from T3 Code's public fx provider, read for those facts only,
  at commit `67c442a17e6e5d6c9f768714820cecb5f15d4f9b`:
  https://github.com/pingdotgg/t3code/blob/67c442a17e6e5d6c9f768714820cecb5f15d4f9b/packages/provider-fx/src/server/acpSupport.ts and
  https://github.com/pingdotgg/t3code/blob/67c442a17e6e5d6c9f768714820cecb5f15d4f9b/packages/provider-fx/src/settings.ts.
- fx's release dates: https://github.com/vercel-labs/fx/releases (read on
  2026-11-23; the newest release was 0.0.17), for the tested range.
- The ACP protocol: see [acp.md](acp.md) and `test/drivers/acp/SOURCES.md`.
