# Where the antigravity driver's fake comes from

## Protocol

The fake agent is `test/drivers/acp/fake-agent.ts`, written with the official
ACP SDK, `@agentclientprotocol/sdk` **2.9.1** (with `zod` 4.6.7), and every
frame of the conformance run is checked against ACP's JSON Schemas, release
`schema-v2.0.0-beta.3` (commit `94824f11ec78f7a6699323a9342e47fa5edf2530` of
https://github.com/agentclientprotocol/agent-client-protocol), vendored in
`vendor-schemas/acp/schema-v2.0.0-beta.3/`. `test/drivers/acp/SOURCES.md` has
the file digests, and `test/drivers/acp/vendor.suite.ts` checks them.

## Antigravity

- ACP registry entry `antigravity-acp` **1.5.2**
  (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json, read
  2026-11-23): Google's ACP server for Antigravity, distributed as zip
  archives per platform.
- The CLI launch (`agy acp --gemini-dir <profile> --app-data-dir antigravity-acp`),
  the environment it strips and sets, and the release manifest format
  (`version`, `url`, `sha512`, one `<os>_<arch>.json` per platform) come from
  a public open-source ACP client of Antigravity, at the commit cited in
  `docs/drivers/antigravity.md` (the repository rule on host names keeps its
  name out of `test/`), and from the proposal's §1.3 Antigravity row.
- `antigravity.suite.ts` builds a release tar.gz and its manifest in the test
  and serves them through a fake `fetch`.
