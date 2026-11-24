# ACP schemas, release schema-v2.0.0-beta.3

These are the Agent Client Protocol's own JSON Schemas (draft 2020-12) and
method-name tables, unchanged. `scripts/codegen-acp.ts` generates the `acp`
driver's protocol types from them (`src/drivers/acp/generated/v1.ts` and
`v2.ts`), and `pnpm run codegen:acp:check` (a gate step) fails when the
generated files drift from these schemas.

- Repository: https://github.com/agentclientprotocol/agent-client-protocol
- Tag: `schema-v2.0.0-beta.3` (commit `94824f11ec78f7a6699323a9342e47fa5edf2530`,
  also tagged `v1.21.2`), directory `schema/`.
- The four schema files are byte for byte the ones the npm package
  `@agentclientprotocol/sdk@2.9.1` ships in `schema/` (the test agents'
  devDependency); `test/drivers/acp/vendor.test.ts` checks both facts below.

| File | sha256 |
|---|---|
| v1/schema.json | 79fbeccc5cb5668259ee35ff7440ffd79eaf813742366ac06f707b98bbf789db |
| v1/schema.unstable.json | fae41cc0d11b89001cf129c68c37c9c7233068a6f3cc7d08fbb54b6d9d8c5688 |
| v1/meta.json | 061edb6efa8fb2aa2792459a86ec7268de5fe665bba48b2ffe7939df01481f88 |
| v1/meta.unstable.json | 99f1b10aca5c1cf516bc1eb330e980e2fafd4029249bbe4c8557119ae1800ffc |
| v2/schema.json | 48b0a9298527adf35d6ac217f9894fb716e93a17a8eca69eea7f26874dd42c0b |
| v2/schema.unstable.json | dccabd97e7867822dfb086a5090771d4bdc44e795a9143306623bb0db20b6199 |
| v2/meta.json | 5eac58a28615d399af1db8e3d636767a7e404f2df38c9668a1ba00b1989e0714 |
| v2/meta.unstable.json | 1447a753a555325ecdd13cdbf497154be9f3bcd228b3e956d4822ab4c5c44af2 |

`schema.unstable.json` is `schema.json` plus ACP's draft features; the driver
uses one of them, `session/fork` (RFD https://agentclientprotocol.com/rfds/session-fork.md),
so types and frame checks use the unstable files.

To update: download the four schema files and four meta files of a newer
schema release into a new `vendor-schemas/acp/<release>/` directory, set
`ACP_SCHEMA_RELEASE` in `scripts/codegen-acp.ts`, bump the
`@agentclientprotocol/sdk` devDependency to the release that ships the same
schemas, update this table and `test/drivers/acp/SOURCES.md`, and run
`pnpm run codegen:acp`.
