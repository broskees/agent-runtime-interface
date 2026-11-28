# Google Antigravity driver (`ari/drivers/antigravity`)

`ari/drivers/antigravity` runs the Google Antigravity CLI the user installed
over ACP. It is the [ACP base driver](acp.md) with Antigravity's launch and
quirks. `ari/meta/antigravity` holds its label, icon, config schema and form
hints. ARI never downloads, installs or updates the Antigravity CLI (`agy`).

## Launch

The config's `profile` chooses whose Antigravity profile `agy` uses.

- `profile: "user"`, the default (also when the config names no `profile`):
  `agy acp`, with no other argument and no variable of the driver's. `agy`
  uses the user's own profile, settings, conversations and sign-in, as when
  the user runs it.
- `profile: "instance"`:
  `agy acp --gemini-dir <stateDir>/profile --app-data-dir antigravity-acp`
  with `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1`. The instance gets a profile of
  its own.

The driver sets no other variable: `agy` 1.5.x reads neither
`AGY_ACP_FORCE_FILE_STORAGE` nor `GEMINI_HOME`, which earlier releases of this
driver set. Only the version command, `agy --version`, runs with
`AGY_CLI_DISABLE_AUTO_UPDATE=true`, the switch of the CLI's self-updater (next
section).

## Quirks

- **The user's own profile, by default.** With `profile: "user"` the driver
  adds nothing to `agy acp`, so `agy` finds everything where it always does:
  `--gemini-dir` defaults to `.gemini` in the home directory and
  `--app-data-dir` to `antigravity-cli` (`agy acp --help`). It reads the
  user's settings, rules, skills and MCP servers from `~/.gemini/`
  (Antigravity's docs, "Customization discovery" and "Settings"), keeps its
  conversations there, and finds the user's Google sign-in where it keeps it:
  in the OS keyring (Apple Keychain, the Secret Service on Linux, Windows
  Credential Manager), service `gemini` and account `antigravity`, or in
  `~/.gemini/antigravity-cli/antigravity-oauth-token` when the keyring is
  bypassed or unreachable ("Local silent keyring sign-in" on Antigravity's
  "Authenticate" page; [How Antigravity finds the
  sign-in](../recordings.md#how-antigravity-finds-the-sign-in)). Every
  instance with `profile: "user"` shares that one Google account, its quota
  and its conversations, with each other and with the user's own `agy`; a
  token one of them refreshes is the one all of them use next.
  `test/drivers/antigravity/antigravity.suite.ts` runs two such instances
  against a fake `agy`, on a desktop whose keyring holds the user's sign-in
  and on a machine without a keyring, and shows both use the user's one
  sign-in and the second finds the first one's refresh.
- **A profile per instance, on request.** With `profile: "instance"` the
  instance's sign-in, settings and session files live in its own
  `<stateDir>/profile` (mode 0700, created when a session opens, never by a
  probe), so two such instances never share a Google account. The profile
  flags and `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` always go together: `agy`
  1.5.x keeps a Google sign-in in the OS keyring's one entry, service
  `gemini` and account `antigravity`, whatever `--gemini-dir` and
  `--app-data-dir` say, so with the flags alone every `agy` on the machine
  would share it, the user's own included. With
  `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` set it keeps the sign-in in its file
  storage instead, `<stateDir>/profile/antigravity-acp/antigravity-oauth-token`,
  and logs "Using file-based token storage because
  AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set". It neither reads nor changes the
  keyring's entry then. `test/drivers/antigravity/antigravity.suite.ts` runs
  two such instances against a fake `agy` that keeps its sign-in where 1.5.16
  does, on a machine whose keyring holds one, and shows each finds and
  refreshes only its own profile's.
- **Signing in.** The driver signs in for no instance; `agy` says when it
  needs a sign-in, and an ACP `-32000` reaches the host as `auth_required`
  with `agy`'s own message ([acp.md](acp.md#optional-members-42)). Use the
  executable the instance configures; `--login` is "Log in with Google
  interactively, then exit (ACP terminal auth)" (`agy acp --help`).
  - `profile: "user"`: an instance is signed in when the user's own `agy` is.
    Otherwise sign that in once with `agy acp --login`, with no other flag or
    variable, so `agy` keeps the sign-in where it chooses, as for the user's
    own runs.
  - `profile: "instance"`: a new instance has no sign-in of its own, also when
    the user's own `agy` is signed in. Sign it in once with
    `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy acp --login --gemini-dir <stateDir>/profile --app-data-dir antigravity-acp`.
    Existing instances with a working profile credential do not need to sign
    in again. On Linux, `agy` can also use the profile file when the keyring
    is unreachable.
- **The self-updater runs as `agy` decides.** `status()` and `openSession`
  run `agy --version` with `AGY_CLI_DISABLE_AUTO_UPDATE=true`, so a status
  check never updates the binary it checks. `agy acp` gets no such switch
  from the driver, in either profile.
- **The environment passes through.** `agy` gets the environment the host
  gives it, Google credentials such as `GEMINI_API_KEY` and
  `GOOGLE_APPLICATION_CREDENTIALS` included, as it would in the user's shell.
  A host that wants a variable kept from the agent lists it in
  `process.envPolicy.stripAmbient`. A session starts under any policy, one
  that strips nothing included. The driver adds only
  `AGY_CLI_FORCE_FILE_TOKEN_STORAGE`, with `profile: "instance"`, and
  `AGY_CLI_DISABLE_AUTO_UPDATE`, to `agy --version`.
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
| `profile` | `user` | Whose Antigravity profile `agy` uses: `user`, the user's own sign-in, settings and conversations; or `instance`, a profile private to the instance, `<stateDir>/profile`, with a sign-in of its own ([Launch](#launch)). A config without it gets `user`; `create()` refuses any other value with a `validation` error. |
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
`session.replaced`. It lists no native sessions. What `agy` finds follows the
profile:

- `profile: "user"`: `agy` looks in the user's own profile, so it resumes a
  session the user's own `agy` keeps there, or one another such instance
  started.
- `profile: "instance"`: the instance's profile directory holds only that
  instance's session files, so a session the user's own `agy` or another
  instance keeps is not found there and is replaced.

`test/drivers/antigravity/antigravity.suite.ts` resumes one session in both
profiles. Every instance's `continuationKey` is `antigravity:<command>`, in
both profiles, as before.

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
  - `agy acp --help` of 1.5.17: `--gemini-dir`, `--app-data-dir` and `--login`,
    and the defaults `profile: "user"` relies on: `--gemini-dir` defaults to
    `.gemini` in the home directory and `--app-data-dir` to `antigravity-cli`.
  - Antigravity's "Authenticate" page (https://antigravity.google/docs/install),
    "Local silent keyring sign-in": "When launching `agy` on your local
    machine, the CLI attempts to access your operating system's native secure
    keyring".
- Antigravity's docs "Customization discovery"
  (https://antigravity.google/docs/customization-discovery) and "Settings"
  (https://antigravity.google/docs/settings), read 2026-11-25, for the
  user's setup under `~/.gemini/`.
