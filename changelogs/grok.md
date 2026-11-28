# Changelog: grok driver

## Unreleased

- Added the grok driver (`ari/drivers/grok`, `ari/meta/grok`): Grok Build's
  CLI as an ACP agent, `grok --permission-mode default agent stdio`.
- As an ACP flavor, it takes the base driver's resume and fork changes: a
  resume replaces only a session the agent reports missing, a resume of a
  held thread applies or refuses its settings, a history resume is
  `unsupported`, and a fork into another directory is asked of the agent
  (`forkAcrossDirectories` defaults to `true`). See the `acp` changelog.
- Probes run `grok --version` with the updater off. Tested range
  `>=1.0.70 <1.1.0`.
- `grok` gets the environment the host gives it, inherited `XAI_` variables
  included; only the host's `envPolicy.stripAmbient` keeps a variable out.
  The CLI manifest no longer scrubs `XAI_`.
- Runs the `grok` the user installed and never downloads, installs or updates
  one. A `grok` older than the minimum, 1.0.70 (the lower bound of the tested
  range), is refused: `status()` is `unavailable` with `driver_unavailable`
  and `openSession` rejects with it before any agent starts, naming the
  version found, its path, the minimum and the update step, `grok update`.
  Above the tested range a `grok` still runs, with an `untested_version`
  advisory.
- A thread whose policy names no mode still runs in Grok's `default`
  permission mode, which `--permission-mode default` fixes for the session's
  one process; it reports `approval_required`. The user's own Grok
  permission mode never applies.
