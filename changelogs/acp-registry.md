# Changelog: acp-registry driver

## Unreleased

- Added the acp-registry driver (`ari/drivers/acp-registry`,
  `ari/meta/acp-registry`): ACP Registry agents as `subProviders`, installed
  through `ari/node`'s adapter installer (sha256-checked tar archives only;
  never npx or uvx) and leased while a session runs them.
- Tested against ACP protocol versions 1 and 2, with each agent at the
  version the registry lists; `status()` gives an advisory when the index
  the instance last read lists another version than the installed one.
