# Changelog: antigravity driver

## Unreleased

- As for the `acp` driver: `forkAcrossDirectories` now defaults to `true`, so a
  fork into another directory asks `agy`; a resume replaces a session only when
  `agy` reports it missing; and resuming a thread the session already holds
  applies the new config and policy, or refuses naming what cannot change.
- Added the antigravity driver (`ari/drivers/antigravity`,
  `ari/meta/antigravity`): the Antigravity CLI as an ACP agent, `agy acp`.
- The config's `profile` chooses whose Antigravity profile `agy` uses.
  `user`, the default, also for a config that names no `profile`: `agy acp`
  with nothing added, so an instance uses the user's own sign-in, settings
  and conversations, and every such instance shares the user's one Google
  account. `instance`: a profile directory private to the instance,
  `agy acp --gemini-dir <stateDir>/profile --app-data-dir antigravity-acp`
  with `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1`, as every instance had in earlier
  builds; the two go together because `agy` 1.5.x keeps one OS keyring entry
  across profiles. `create()` refuses any other value. An instance from an
  earlier build that should keep its own profile, with its sign-in and
  conversations in `<stateDir>/profile`, needs `profile: "instance"`.
- Fixed-choice prompts; `rollbackThread` refused before anything is touched.
- `agy` gets the environment the host gives it, Google credentials included;
  only the host's `envPolicy.stripAmbient` keeps a variable out. A session
  starts under any policy: the `env_policy_incomplete` refusal and
  `ANTIGRAVITY_STRIPPED_VARIABLES` of an earlier build are gone, and so are the
  CLI manifest's `envScrubPrefixes`.
- Runs the `agy` the user installed (`command`, by default `agy` on `PATH`)
  and never downloads, installs or updates one. The managed install an earlier
  build offered (`installation: "managed"`, `releaseManifestUrl`, `version`,
  `maintenance.install` and `maintenance.update`) is gone: a config that still
  names one of those settings is refused by `create()` with a `validation`
  error that says ARI no longer installs `agy` and how to install it.
- An `agy` older than the minimum, 1.5.0 (the lower bound of the tested
  range), is refused: `status()` is `unavailable` with `driver_unavailable`
  and `openSession` rejects with it before any agent starts, naming the
  version found, its path, the minimum and the update step, `agy update`.
  Above the tested range an `agy` still runs, with an `untested_version`
  advisory.
- Fixed: instances shared one Google sign-in. `agy` 1.5.x keeps the sign-in
  in the OS keyring's one entry (service `gemini`, account `antigravity`)
  whatever the profile, and reads neither `AGY_ACP_FORCE_FILE_STORAGE` nor
  `GEMINI_HOME`, which the driver set. The driver now sets
  `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` instead, with `profile: "instance"`,
  so `agy` keeps each such instance's sign-in in its own
  `<stateDir>/profile/antigravity-acp/antigravity-oauth-token` and leaves the
  keyring alone. Only those instances without a working profile credential
  need to sign in with
  `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy acp --login --gemini-dir <stateDir>/profile --app-data-dir antigravity-acp`.
  With `profile: "user"` an instance is signed in when the user's own `agy`
  is; `agy acp --login` signs that in.
- The CLI's self-updater is off (`AGY_CLI_DISABLE_AUTO_UPDATE=true`) for the
  version command, `agy --version`, only, so a status check never updates
  the binary it checks. Sessions no longer get the switch, in either profile;
  an earlier build gave it to them too.
