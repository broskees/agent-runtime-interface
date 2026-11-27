# Google Antigravity driver (`ari/drivers/antigravity`)

`ari/drivers/antigravity` runs the Google Antigravity CLI the user installed
over ACP. It is the [ACP base driver](acp.md) with Antigravity's launch and
quirks. `ari/meta/antigravity` holds its label, icon, config schema and form
hints. ARI never downloads, installs or updates the Antigravity CLI (`agy`).

## Launch

`agy acp --gemini-dir <stateDir>/profile --app-data-dir antigravity-acp`

with `GEMINI_HOME=<stateDir>/profile`, `AGY_ACP_FORCE_FILE_STORAGE=1` and
`AGY_CLI_DISABLE_AUTO_UPDATE=1`.

## Quirks

- **A profile per instance.** Each instance's sign-in, settings and session
  files live in its own `<stateDir>/profile` (mode 0700, created when a
  session opens, never by a probe), with file-based credential storage, so
  two instances never share a Google account.
- **Ambient Google credentials are stripped.** A host strips them with
  `process.envPolicy.stripAmbient`. The driver cannot strip variables itself
  (`SpawnRequest` adds variables; it removes none), so it declares them and
  checks the host: the CLI manifest's `envScrubPrefixes` (`GEMINI_`,
  `GOOGLE_`, `GCLOUD_`, `CLOUDSDK_`, `AGY_`) cover every name in
  `ANTIGRAVITY_STRIPPED_VARIABLES` (`GEMINI_API_KEY`, `GOOGLE_API_KEY`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`,
  `GOOGLE_CLOUD_LOCATION`, `GOOGLE_CLOUD_QUOTA_PROJECT`,
  `GOOGLE_GENAI_USE_VERTEXAI`, `GCLOUD_PROJECT`, `CLOUDSDK_CORE_PROJECT`,
  `AGY_ACP_CCPA_PROJECT`, `AGY_ACP_ENABLE_OAUTH`, `GEMINI_HOME`), and
  `openSession` rejects with `invalid_state` (`env_policy_incomplete`, naming
  the missing ones) when the host's `envPolicy` would let one through. A host
  that builds its `envPolicy` from the manifest (as the conformance kit's
  fake host and a manifest-honouring host do, with `PREFIX*` entries) passes.
- **Fixed-choice prompts.** `requests.allowCustomAnswer` is false; a
  `custom` answer rejects with `unsupported`.
- **No conversation rollback.** Antigravity can checkpoint the workspace but
  cannot roll back its conversation. `rollbackThread` is present and rejects
  with `unsupported{threads.rollback}` before it reads or writes any file,
  calls the host or sends a frame (`test/drivers/antigravity/antigravity.suite.ts`
  watches all three). `checkpointing.workspace` stays false: the driver
  exposes no checkpoint extension.

## Config

| Field | Default | Meaning |
|---|---|---|
| `command` | `agy` | The user's Antigravity CLI: a name found on `PATH`, or a path. |
| `maxProtocolVersion`, `forkAcrossDirectories`, `configDependencies` | `1`, `false`, `{}` | As for the [ACP base driver](acp.md#config). |

There is no managed install. An earlier version could install `agy` itself
(`installation: "managed"`, with `releaseManifestUrl` and `version`); those
settings are gone, and `create()` refuses a config that still names one of
them with a `validation` error that names them and says how to install `agy`:

```text
ARI no longer downloads, installs or updates the Antigravity CLI (agy), so the config may not name installation. Remove it; the driver runs the agy on PATH, or the one `command` names. Install the Antigravity CLI yourself: `curl -fsSL https://antigravity.google/cli/install.sh | bash` on macOS and Linux, or `irm https://antigravity.google/cli/install.ps1 | iex` in Windows PowerShell.
```

The install commands are Google's own
([Antigravity CLI README, Installation](https://github.com/google-antigravity/antigravity-cli#installation)).

## Tested versions

The Antigravity CLI `>=1.5.0 <1.6.0` (`agy acp` 1.5.x; the ACP registry
lists `antigravity-acp` 1.5.2). `status()` reports the version, an
`untested_version` advisory above that range, and `driver_unavailable` below
it (next section).

## The user's own `agy`, and its minimum

ARI runs the `agy` the user installed, found on `PATH` or at the path the
config names, and never downloads, installs or updates one. The minimum is the
Antigravity CLI 1.5.0, the lower bound of the tested range `>=1.5.0 <1.6.0`.
With an older `agy`, `status()` is `unavailable` with `driver_unavailable`
(with `installed: true` and the version found), and `openSession` rejects with
the same error before any agent starts: the only process that runs is `agy
--version`. The error names the version found, the path, the minimum and
Antigravity's update step:

```text
Google Antigravity 1.4.9 (/usr/local/bin/agy) is older than 1.5.0, the oldest version this driver supports. Update the Antigravity CLI with `agy update`.
```

The update step is Antigravity's own: "update your CLI binary to the latest
version using `agy update`" ([Antigravity CLI, Changelog
command](https://antigravity.google/docs/cli/commands/changelog/)); `agy
--help` 1.5.17 lists `update Update CLI`. An `agy` above the tested range
still runs, with an `untested_version` advisory. `agy --version` prints the
bare version, such as `1.5.17` (`test/fixtures/cli-version-output/agy.txt`).

## Resuming conversations ARI did not create

The Antigravity driver is the ACP base driver with the `agy acp` launch, so it
resumes the way [the `acp`
driver](acp.md#resuming-conversations-ari-did-not-create) does: it asks the
agent for any session id the host names, with only the host's LaunchContext,
and replaces a session the agent cannot resume with a fresh one and
`session.replaced`. It lists no native sessions. Each instance runs `agy` with
its own profile directory, which holds that instance's session files, so a
session the user's own `agy` keeps in their profile is not found there and is
replaced.

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
| Roll back thread | Y | present, rejects `unsupported` | Antigravity cannot roll back its conversation |
| Custom answers to prompts | (not in §1.2) | – | Antigravity's permission prompts take fixed choices |

## Optional members

As the [ACP base driver](acp.md#optional-members-44), except that
`rollbackThread` is present and rejects `unsupported`. The instance has no
`maintenance` member (no `maintenance.install`, `maintenance.update` or
`maintenance.advisory`): ARI never installs or updates `agy`, so over
`ari/wire` its `InstanceDescriptor.members` lists none of them.
`test/drivers/antigravity/rules.suite.ts` checks all 44, and
`test/standalone/user-installed-cli.e2e.ts` checks the standalone
`ari-driver`.

## Missing CLI

With `agy` not on PATH, `create()` succeeds, `status()` is `unavailable`
with `driver_unavailable` naming `agy`, and `openSession` rejects with
`driver_unavailable`.

## Sources

- ACP registry entry `antigravity-acp` 1.5.2 (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json),
  and Antigravity's docs link there: https://antigravity.google/docs/ide/extensions.
- T3 Code's public Antigravity code, read for the launch arguments, the
  environment it strips and sets, and the rollback rule only, at commit
  `67c442a17e6e5d6c9f768714820cecb5f15d4f9b`:
  https://github.com/pingdotgg/t3code/blob/67c442a17e6e5d6c9f768714820cecb5f15d4f9b/apps/server/src/provider/antigravityAuthSupport.ts and
  https://github.com/pingdotgg/t3code/blob/be6ff17f5171c8a55969ec74af46ff1d86666c3a/docs/internals/providers.md (cited by the proposal §1.3).
- Google's Antigravity CLI README, for the install commands:
  https://github.com/google-antigravity/antigravity-cli#installation; and
  the Antigravity CLI docs, for the update step:
  https://antigravity.google/docs/cli/commands/changelog/.
