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
- v2 tool patches keep omitted fields and clear `null` ones; a v2
  `user_message` updates the turn's user item; resume applies the agent's
  current-state snapshot, so running work becomes a `provider_initiated`
  turn.
- `resumeThread` passes launch instructions on: `systemPrompt` on
  `session/resume`, `session/load` or the replacing `session/new`, the rest
  in the first prompt.
- `switchModel` is declared only while the agent offers a `model` option;
  `sessionModel` is `process_per_session`.
- Tested against ACP protocol versions 1 and 2 (`testedVersions.range`
  `1 - 2`); `status()` gives an advisory after an agent answers another.
