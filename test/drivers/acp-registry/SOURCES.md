# Where the acp-registry driver's fake comes from

## Protocol

The fake agent is `test/drivers/acp/fake-agent.ts`, written with the official
ACP SDK, `@agentclientprotocol/sdk` **2.9.1** (with `zod` 4.6.7), and every
frame of the conformance run is checked against ACP's JSON Schemas, release
`schema-v2.0.0-beta.3` (commit `94824f11ec78f7a6699323a9342e47fa5edf2530` of
https://github.com/agentclientprotocol/agent-client-protocol), vendored in
`vendor-schemas/acp/schema-v2.0.0-beta.3/`. `test/drivers/acp/SOURCES.md` has
the file digests, and `test/drivers/acp/vendor.test.ts` checks them.

## The ACP Registry

- Manifest and index format: the ACP Agent Registry RFD,
  https://agentclientprotocol.com/rfds/acp-agent-registry.md, and the registry
  docs, https://agentclientprotocol.com/get-started/registry.md.
- The live index, https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json,
  read 2026-11-23: format `1.0.0`, 46 agents. Its distributions (counted in
  `docs/drivers/acp-registry.md`) set which kinds `fixtures.ts` covers:
  a sha256-checked tar.gz binary, an npx package, a uvx package, a zip
  archive and a tar.gz without a digest.
- The installed agent's command is replaced, in the conformance run, by
  `test/drivers/acp/fake-agent.ts` speaking ACP v2.
