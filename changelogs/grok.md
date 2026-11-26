# Changelog: grok driver

## Unreleased

- Added the grok driver (`ari/drivers/grok`, `ari/meta/grok`): Grok Build's
  CLI as an ACP agent, `grok --permission-mode default agent stdio`.
- Probes run `grok --version` with the updater off; inherited `XAI_`
  variables are scrubbed. Tested range `>=1.0.70 <1.1.0`.
- Runs the `grok` the user installed and never downloads, installs or updates
  one. A `grok` older than the minimum, 1.0.70 (the lower bound of the tested
  range), is refused: `status()` is `unavailable` with `driver_unavailable`
  and `openSession` rejects with it before any agent starts, naming the
  version found, its path, the minimum and the update step, `grok update`.
  Above the tested range a `grok` still runs, with an `untested_version`
  advisory.
