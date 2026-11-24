# Where the fx driver's fake comes from

## Protocol

The fake agent is `test/drivers/acp/fake-agent.ts`, written with the official
ACP SDK, `@agentclientprotocol/sdk` **2.9.1** (with `zod` 4.6.7), and every
frame of the conformance run is checked against ACP's JSON Schemas, release
`schema-v2.0.0-beta.3` (commit `94824f11ec78f7a6699323a9342e47fa5edf2530` of
https://github.com/agentclientprotocol/agent-client-protocol), vendored in
`vendor-schemas/acp/schema-v2.0.0-beta.3/`. `test/drivers/acp/SOURCES.md` has
the file digests, and `test/drivers/acp/vendor.suite.ts` checks them.

## fx

- fx publishes no ACP documentation this phase could find. The launch
  (`fx acp`), the option ids (`provider`, `model`, `mode`, `effort`) and the
  dependency of the model list on the provider come from a public open-source
  ACP client of fx, at the commit cited in `docs/drivers/fx.md` (the
  repository rule on host names keeps its name out of `test/`).
- `fixtures.ts` holds the provider and model options in ACP v1's
  `SessionConfigOption` shape, which the schema checks.
