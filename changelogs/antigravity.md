# Changelog: antigravity driver

## Unreleased

- Added the antigravity driver (`ari/drivers/antigravity`,
  `ari/meta/antigravity`): the Antigravity CLI as an ACP agent,
  `agy acp --gemini-dir <profile> --app-data-dir antigravity-acp`.
- A profile directory per instance; ambient Google credentials stripped
  through the host's `envPolicy`, which the driver checks; fixed-choice
  prompts; `rollbackThread` refused before anything is touched.
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
  `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` instead, so `agy` keeps each
  instance's sign-in in its own
  `<stateDir>/profile/antigravity-acp/antigravity-oauth-token` and leaves the
  keyring alone. Only instances without a working profile credential need to
  sign in with
  `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy acp --login --gemini-dir <stateDir>/profile --app-data-dir antigravity-acp`.
- Disable the CLI self-updater with `AGY_CLI_DISABLE_AUTO_UPDATE=true` for
  version probes and sessions.
