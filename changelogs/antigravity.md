# Changelog: antigravity driver

## Unreleased

- Added the antigravity driver (`ari/drivers/antigravity`,
  `ari/meta/antigravity`): the Antigravity CLI as an ACP agent,
  `agy acp --gemini-dir <profile> --app-data-dir antigravity-acp`.
- A profile directory per instance; ambient Google credentials stripped
  through the host's `envPolicy`, which the driver checks; fixed-choice
  prompts; `rollbackThread` refused before anything is touched.
- Fixed: instances shared one Google sign-in. `agy` 1.5.x keeps the sign-in
  in the OS keyring's one entry (service `gemini`, account `antigravity`)
  whatever the profile, and reads neither `AGY_ACP_FORCE_FILE_STORAGE` nor
  `GEMINI_HOME`, which the driver set. The driver now sets
  `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` instead, so `agy` keeps each
  instance's sign-in in its own
  `<stateDir>/profile/antigravity-acp/antigravity-oauth-token` and leaves the
  keyring alone. An instance that ran before has no sign-in file and signs in
  once with
  `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy acp --login --gemini-dir <stateDir>/profile --app-data-dir antigravity-acp`.
- Optional managed installs (`installation: "managed"`) through `ari/node`'s
  adapter installer, sha512-checked, leased while a session runs.
