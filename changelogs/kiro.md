# Changelog: kiro driver

## Unreleased

- Added the kiro driver (`ari/drivers/kiro`, `ari/meta/kiro`): Kiro CLI's V3
  harness as an ACP agent, `kiro-cli acp --agent-engine=v3 --auth-method=cli`.
- Kiro's `autopilot` option follows the thread's runtime mode (off when
  supervised, on under `full_access`). Tested range `>=3.0.0 <4.0.0`.
- Runs the `kiro-cli` the user installed and never downloads, installs or
  updates one. A `kiro-cli` older than the minimum, 3.0.0 (the lower bound of
  the tested range), is refused: `status()` is `unavailable` with
  `driver_unavailable` and `openSession` rejects with it before any agent
  starts, naming the version found, its path, the minimum and the update step,
  `kiro-cli update`. Above the tested range a `kiro-cli` still runs, with an
  `untested_version` advisory.
