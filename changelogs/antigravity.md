# Changelog: antigravity driver

## Unreleased

- Added the antigravity driver (`ari/drivers/antigravity`,
  `ari/meta/antigravity`): the Antigravity CLI as an ACP agent,
  `agy acp --gemini-dir <profile> --app-data-dir antigravity-acp`.
- A profile directory per instance; ambient Google credentials stripped
  through the host's `envPolicy`, which the driver checks; fixed-choice
  prompts; `rollbackThread` refused before anything is touched.
- Optional managed installs (`installation: "managed"`) through `ari/node`'s
  adapter installer, sha512-checked, leased while a session runs.
