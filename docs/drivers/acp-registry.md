# ACP Registry driver (`ari/drivers/acp-registry`)

`ari/drivers/acp-registry` installs and runs agents from the
[ACP Registry](https://agentclientprotocol.com/get-started/registry). It is
the [ACP base driver](acp.md) whose agent is chosen from the registry.
`ari/meta/acp-registry` holds its label, icon, config schema and form hints.

## Choosing and installing an agent

- `instance.subProviders.list(cwd)` reads the registry index
  (`registryUrl`, by default
  https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) and
  returns one `SubProvider` per agent: id, name, description, version, icon,
  whether it is installed and whether it is the instance's agent.
- `subProviders.set({ cwd, providerId })` picks an agent and installs its
  build for this platform through `ari/node`'s adapter installer into
  `<cacheDir>/adapters/<agent id>/<version>`, checking the download against
  the registry's sha256. Nothing is run to install: never npx, uvx or a
  package manager. A host persists the choice as `agentId` (and
  `agentVersion`) in the instance's config.
- `subProviders.disable({ cwd, providerId })` drops the choice.
- `openSession` runs the installed build's `cmd` with its `args` and
  `env` (the command must stay inside the install directory), and holds an
  installer lease on that version until the agent process exits.
- `probe()` only looks on disk: no network, no install.

## What the installer can install

`ari/node`'s installer unpacks one tar or tar.gz archive and installs no
dependencies. In the registry index of 2026-11-23 (46 agents), for
`linux-x86_64`:

| Distribution | Agents | Installed by this driver |
|---|---|---|
| binary, tar.gz | 19 | yes, when the build has a sha256 |
| binary, zip | 2 (antigravity-acp, junie) | no: the installer reads tar only |
| binary, tar.bz2 | 1 (goose) | no |
| binary, a bare executable | 2 (muse-code, sigit) | no |
| npx | 20 | no: needs npx and the package's dependencies |
| uvx | 2 | no: needs uvx |

`subProviders.set` refuses the others with `invalid_state`
(`distribution_unsupported`) and says why, before downloading anything; a
build without a sha256 is refused too. Antigravity has its own driver
([antigravity.md](antigravity.md)), which runs the `agy` the user installed
instead of the registry's zip.

## Config

| Field | Default | Meaning |
|---|---|---|
| `registryUrl` | the ACP Registry CDN | The registry index. |
| `agentId` | `""` | The agent to run. Until one is chosen, `status()` is `setup_required`. |
| `agentVersion` | `""` | The installed version to run; empty for the newest installed. |
| `maxProtocolVersion`, `forkAcrossDirectories`, `configDependencies` | `1`, `false`, `{}` | As for the [ACP base driver](acp.md#config). |

## Tested versions

The driver runs whichever agent the user picks, so it is tested against the
protocol and the registry: ACP protocol versions 1 and 2 at schema release
`schema-v2.0.0-beta.3` (`testedVersions.range` is `1 - 2`), registry index
format `1.0.0`, and each agent at the version the index lists. `status()`
reports the installed version and gives an `untested_version` advisory:

- after the agent answered `initialize` with another protocol version, as
  for the [ACP base driver](acp.md#tested-versions);
- when the index the instance last read (through `subProviders.list` or
  `set`, or a session start) lists another version of the agent than the
  installed one (`latestVersion` and `testedRange` give the listed version),
  or no longer lists the agent. `status()` reads nothing from the network
  itself, so before the instance has read the index it gives no such
  advisory.

`test/drivers/acp-registry/registry.suite.ts` checks the listed-version
advisory, and `test/drivers/acp-registry/rules.suite.ts` the protocol one.

## Resuming conversations ARI did not create

The ACP Registry driver is the ACP base driver with the agent the host chose
from the registry, so it resumes the way [the `acp`
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
| Sub-providers | (not in §1.2) | list, set, disable | The ACP Agent Registry RFD's manifest and index (https://agentclientprotocol.com/rfds/acp-agent-registry.md) |

## Optional members

As the [ACP base driver](acp.md#optional-members-44), plus
`subProviders.list`, `subProviders.set` and `subProviders.disable`, which
work; `test/drivers/acp-registry/rules.suite.ts` checks all 44.

## Missing agent

With the chosen agent not installed, `create()` succeeds, `status()` is
`unavailable` with `driver_unavailable` naming the agent id as the package
to install, and `openSession` rejects with `driver_unavailable`;
`subProviders.set` installs it.

## Sources

- ACP Agent Registry RFD: https://agentclientprotocol.com/rfds/acp-agent-registry.md;
  registry docs: https://agentclientprotocol.com/get-started/registry.md;
  the live index above (read 2026-11-23, registry format 1.0.0, 46 agents).
- T3 Code's public registry provider was consulted for how a client uses the
  registry, at commit `67c442a17e6e5d6c9f768714820cecb5f15d4f9b`: https://github.com/pingdotgg/t3code/blob/67c442a17e6e5d6c9f768714820cecb5f15d4f9b/packages/provider-acp-registry/src/settings.ts.
