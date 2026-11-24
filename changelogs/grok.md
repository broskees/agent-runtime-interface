# Changelog: grok driver

## Unreleased

- Added the grok driver (`ari/drivers/grok`, `ari/meta/grok`): Grok Build's
  CLI as an ACP agent, `grok --permission-mode default agent stdio`.
- Probes run `grok --version` with the updater off; inherited `XAI_`
  variables are scrubbed. Tested range `>=1.0.70 <1.1.0`.
