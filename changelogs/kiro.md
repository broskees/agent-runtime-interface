# Changelog: kiro driver

## Unreleased

- Added the kiro driver (`ari/drivers/kiro`, `ari/meta/kiro`): Kiro CLI's V3
  harness as an ACP agent, `kiro-cli acp --agent-engine=v3 --auth-method=cli`.
- Kiro's `autopilot` option follows the thread's runtime mode (off when
  supervised, on under `full_access`). Tested range `>=3.0.0 <4.0.0`.
