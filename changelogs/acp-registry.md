# Changelog: acp-registry driver

## Unreleased

- Added the acp-registry driver (`ari/drivers/acp-registry`,
  `ari/meta/acp-registry`): ACP Registry agents as `subProviders`, installed
  through `ari/node`'s adapter installer (sha256-checked tar archives only;
  never npx or uvx) and leased while a session runs them.
