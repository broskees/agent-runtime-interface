# Changelog: fx driver

## Unreleased

- Added the fx driver (`ari/drivers/fx`, `ari/meta/fx`): the fx agent as an
  ACP agent, `fx acp`.
- fx's model option depends on its provider option (`dependsOn: ["provider"]`)
  on every option list fx sends.
- Tested range `>=0.0.13 <0.0.18` (fx 0.0.13 to 0.0.17), with an
  `untested_version` advisory above it.
- Runs the `fx` the user installed and never downloads, installs or updates
  one. An `fx` older than the minimum, 0.0.13 (the lower bound of the tested
  range), is refused: `status()` is `unavailable` with `driver_unavailable`
  and `openSession` rejects with it before any agent starts, naming the
  version found, its path, the minimum and the update step, `fx upgrade`.
  Above the tested range an `fx` still runs, with an `untested_version`
  advisory.
- `fx` gets the host's environment and the instance's `environment`,
  credentials included, minus only the host's `envPolicy.stripAmbient`.
