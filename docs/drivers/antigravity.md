# Google Antigravity driver (`ari/drivers/antigravity`)

`ari/drivers/antigravity` runs the Google Antigravity CLI the user installed
over ACP. It is the [ACP base driver](acp.md) with Antigravity's launch and
quirks. `ari/meta/antigravity` holds its label, icon, config schema and form
hints. ARI never downloads, installs or updates the Antigravity CLI (`agy`).

## Launch

`agy acp --gemini-dir <stateDir>/profile --app-data-dir antigravity-acp`

with `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` and `AGY_CLI_DISABLE_AUTO_UPDATE=true`.
The driver sets no other variable: `agy` 1.5.x reads neither
`AGY_ACP_FORCE_FILE_STORAGE` nor `GEMINI_HOME`, which earlier releases of this
driver set.

## Quirks

- **A profile per instance.** Each instance's sign-in, settings and session
  files live in its own `<stateDir>/profile` (mode 0700, created when a
  session opens, never by a probe), so two instances never share a Google
  account. `agy` 1.5.x keeps a Google sign-in in the OS keyring (Apple
  Keychain, the Secret Service on Linux, Windows Credential Manager), in one
  entry, service `gemini` and account `antigravity`, whatever `--gemini-dir`
  and `--app-data-dir` say, so every `agy` on the machine would share it, the
  user's own included. With `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` set it keeps
  the sign-in in its file storage instead,
  `<stateDir>/profile/antigravity-acp/antigravity-oauth-token`, and logs
  "Using file-based token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is
  set". It neither reads nor changes the keyring's entry then.
  `test/drivers/antigravity/antigravity.suite.ts` runs two instances against
  a fake `agy` that keeps its sign-in where 1.5.16 does, on a machine whose
  keyring holds one, and shows each finds and refreshes only its own
  profile's.
- **Each instance signs in once.** A new instance has no sign-in of its own,
  also when the user's own `agy` is signed in, and the driver does not sign
  in for it. Sign it in once with
  `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy acp --login --gemini-dir <stateDir>/profile --app-data-dir antigravity-acp`
  (`--login`: "Log in with Google interactively, then exit (ACP terminal
  auth)", `agy acp --help`). Use the executable the instance configures.
  Existing instances with a working profile credential do not need to sign in
  again. On Linux, `agy` can also use the profile file when the keyring is
  unreachable.
- **The environment passes through.** `agy` gets the environment the host
  gives it, Google credentials such as `GEMINI_API_KEY` and
  `GOOGLE_APPLICATION_CREDENTIALS` included, as it would in the user's shell.
  A host that wants a variable kept from the agent lists it in
  `process.envPolicy.stripAmbient`. A session starts under any policy, one
  that strips nothing included. The driver adds only
  `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` and `AGY_CLI_DISABLE_AUTO_UPDATE`.
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

As the [ACP base driver](acp.md#optional-members-42), except that
`rollbackThread` is present and rejects `unsupported`. The instance has no
`maintenance` member (no `maintenance.advisory`): ARI never installs or
updates `agy`, so over `ari/wire` its `InstanceDescriptor.members` lists no
`maintenance` member.
`test/drivers/antigravity/rules.suite.ts` checks all 42, and
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
- Where `agy` 1.5.x keeps the sign-in, read 2026-11-25:
  - Antigravity CLI issue https://github.com/google-antigravity/antigravity-cli/issues/1610
    (open): 1.5.10 and 1.5.11 keep the Google sign-in in one keyring entry
    whatever `--gemini-dir` and `--app-data-dir` say, and ignore
    `AGY_ACP_FORCE_FILE_STORAGE`.
  - T3 Code issue https://github.com/pingdotgg/t3code/issues/41973, with the
    1.5.16 log line "Using file-based token storage because
    AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set" and the profile's
    `antigravity-acp/antigravity-oauth-token` (mode 0600) it then writes; and
    the pull requests https://github.com/pingdotgg/t3code/pull/41982 and
    https://github.com/pingdotgg/t3code/pull/42633, checked against 1.5.16
    with a live macOS Keychain: with the variable, a profile's own token
    file is used and the Keychain is not read; `acp --login` logs the file
    storage. The 1.5.16 entry of the CLI's changelog
    (https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)
    and the same issue show that 1.5.16 on macOS no longer keeps the sign-in
    in a file only because `SSH_CONNECTION` is set, so that variable is no
    way to isolate a profile.
  - The `agy` 1.5.15 and 1.5.17 binaries hold `AGY_CLI_FORCE_FILE_TOKEN_STORAGE`
    and the log text "Using file-based token storage because %s is set", and
    hold neither `AGY_ACP_FORCE_FILE_STORAGE` nor `GEMINI_HOME` (read with
    `strings`).
  - `agy acp --help` of 1.5.17: `--gemini-dir`, `--app-data-dir` and `--login`.
