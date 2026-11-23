# Changelog: acp driver

## Unreleased

- Added the ACP base driver (`ari/drivers/acp`, `ari/meta/acp`): runs any
  Agent Client Protocol agent on stdio, speaking ACP v1 or v2 as the agent
  negotiates (`maxProtocolVersion`, default 1).
- ACP clients typed by tables generated from ACP's v1 and v2 JSON Schemas,
  release `schema-v2.0.0-beta.3`, with a drift check (`codegen:acp:check`).
- v2 turns are accepted by the `session/prompt` response and settle on the
  `idle` `state_update`; updates are applied as upserts.
- Fork (draft `session/fork`) when the agent advertises it, with `crossCwd`
  from config and turned off when the agent refuses another directory.
- Permission replies use the agent's own option ids; `full_access` answers
  with the narrowest accepting option; enforcement is `client_boundary`.
- Config options keep `dependsOn` from `configDependencies`.
- Vendor `_meta` and unmapped updates pass through as `x:acp.meta` and
  `x:acp.update`; `ext("acp", "_method", params)` sends extension requests.
