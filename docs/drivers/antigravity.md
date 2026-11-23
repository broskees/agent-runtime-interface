# Google Antigravity driver (`ari/drivers/antigravity`)

`ari/drivers/antigravity` runs the Google Antigravity CLI over ACP. It is the
[ACP base driver](acp.md) with Antigravity's launch and quirks.
`ari/meta/antigravity` holds its label, icon, config schema and form hints.

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
  calls the host or sends a frame (`test/drivers/antigravity/antigravity.test.ts`
  watches all three). `checkpointing.workspace` stays false: the driver
  exposes no checkpoint extension.
- **Managed installs and leases.** With `installation: "managed"`,
  `maintenance.install()` (and `update()`) reads
  `<releaseManifestUrl>/<os>_<amd64|arm64>.json` (`version`, `url`,
  `sha512`), downloads the tar.gz over https, checks its sha512 and installs
  it through `ari/node`'s adapter installer into
  `<cacheDir>/adapters/antigravity-cli/<version>`. Every session holds an
  installer lease on its version until its agent process exits, so cleanup
  never removes a running CLI. Probes only look on disk; a missing managed
  install is `unavailable` with `driver_unavailable` naming
  `antigravity-cli`. `maintenance.advisory()` reports an installed version
  outside the tested range. Windows builds are a bare `agy.exe`, which the
  tar-only installer cannot unpack; managed installs are tested on Linux.

## Config

| Field | Default | Meaning |
|---|---|---|
| `installation` | `path` | `path`: run `command`. `managed`: run the version `maintenance.install()` installed. |
| `command` | `agy` | The user's Antigravity CLI when `installation` is `path`. |
| `releaseManifestUrl` | Antigravity's release manifests | Where managed installs read releases. |
| `version` | `latest` | Managed installs: `latest` or a pinned version. |
| `maxProtocolVersion`, `forkAcrossDirectories`, `configDependencies` | `1`, `false`, `{}` | As for the [ACP base driver](acp.md#config). |

## Tested versions

The Antigravity CLI `>=1.5.0 <1.6.0` (`agy acp` 1.5.x; the ACP registry
lists `antigravity-acp` 1.5.2). `status()` reports the version and an
`untested_version` advisory outside that range.

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
| Roll back thread | Y | present, rejects `unsupported` | Antigravity cannot roll back its conversation |
| Custom answers to prompts | (not in §1.2) | – | Antigravity's permission prompts take fixed choices |

## Optional members

As the [ACP base driver](acp.md#optional-members-44), except that
`rollbackThread` is present and rejects `unsupported`, and with
`installation: "managed"` the instance has `maintenance.advisory`,
`maintenance.install` and `maintenance.update` (exercised in
`antigravity.test.ts`). `test/drivers/antigravity/rules.test.ts` checks all 44
for the default `path` installation.

## Missing CLI

With `agy` not on PATH, `create()` succeeds, `status()` is `unavailable`
with `driver_unavailable` naming `agy`, and `openSession` rejects with
`driver_unavailable`.

## Sources

- ACP registry entry `antigravity-acp` 1.5.2 (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json),
  and Antigravity's docs link there: https://antigravity.google/docs/ide/extensions.
- T3 Code's public Antigravity code, read for the launch arguments, the
  environment it strips and sets, the release manifest and rollback rule only,
  at commit `67c442a17e6e5d6c9f768714820cecb5f15d4f9b`:
  https://github.com/pingdotgg/t3code/blob/67c442a17e6e5d6c9f768714820cecb5f15d4f9b/apps/server/src/provider/antigravityAuthSupport.ts,
  https://github.com/pingdotgg/t3code/blob/67c442a17e6e5d6c9f768714820cecb5f15d4f9b/apps/server/src/provider/antigravityCliRelease.ts,
  https://github.com/pingdotgg/t3code/blob/67c442a17e6e5d6c9f768714820cecb5f15d4f9b/apps/server/src/provider/AntigravityInstallation.ts and
  https://github.com/pingdotgg/t3code/blob/be6ff17f5171c8a55969ec74af46ff1d86666c3a/docs/internals/providers.md (cited by the proposal §1.3).
