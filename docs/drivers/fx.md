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
(`test/drivers/fx/fx.test.ts`). A host shows the provider first and
re-reads the models after changing it.

## Config

| Field | Default | Meaning |
|---|---|---|
| `command` | `fx` | The fx executable. |
| `configDependencies` | `{ "model": ["provider"] }` | Keep it: it is how fx's model list is tied to its provider. |
| `maxProtocolVersion`, `forkAcrossDirectories` | `1`, `false` | As for the [ACP base driver](acp.md#config). |

## Tested versions

None: no fx release was available to test against, so the driver declares
the range `*` and `status()` reports the version `fx --version` prints
without an advisory. It is tested against a fake that speaks ACP v1 with fx's
provider and model options.

## Capabilities

The proposal's §1.2 has no column for this provider (its Grok column was
unreadable, and Antigravity, fx, Kiro and registry agents were not
extracted), so the nearest column, the ACP base, is compared. This driver
declares what the ACP base driver declares ([acp.md](acp.md#capabilities)),
with the differences in the last rows.

| Capability | §1.2 ACP base | This driver | Source for the difference |
|---|---|---|---|
| Switch model mid-session | – | Y | ACP session config options (`session/set_config_option`) |
| Roll back thread | Y | – | ACP defines no rollback method |
| Fork thread / fork from a turn | –/– | agent/– | Draft `session/fork`, declared when the agent advertises it |
| Steer by interrupt + restart | Y | – | A host fallback (`planFallback`), not a provider capability |
| Queued messages / interrupt | Y/Y | –/Y | ACP has no native queue; the host queues |
| MCP tools | – | Y | `session/new` takes `mcpServers` |
| Structured questions | Y | – | The driver does not advertise ACP elicitation |
| Todo list / proposed plan | Y/– | Y/v2 | v2 markdown plans |
| Accepts system / developer context | –/– | agent/first message | `systemPrompt` capability of `session/new` |
| Can generate summaries | Y | – | ACP has no summary method |
| ID strength (turn / item / request) | weak/weak/weak | none/weak/weak | ACP has no turn id |
| Policy enforcement | client-boundary | `client_boundary` | |
| Config option dependencies | (not in §1.2) | model `dependsOn` provider | fx's provider and model options, as fx clients configure them |

## Optional members

As the [ACP base driver](acp.md#optional-members-44); `test/drivers/fx/rules.test.ts`
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
- The ACP protocol: see [acp.md](acp.md) and `test/drivers/acp/SOURCES.md`.
