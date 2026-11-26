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
- The CLI launch (`agy acp --gemini-dir <profile> --app-data-dir antigravity-acp`)
  and the environment it strips and sets come from a public open-source ACP
  client of Antigravity, at the commit cited in `docs/drivers/antigravity.md`
  (the repository rule on host names keeps its name out of `test/`), and from
  the proposal's §1.3 Antigravity row.
- The fake prints a bare version for `--version`, as the real `agy` does
  (`test/fixtures/cli-version-output/agy.txt`, captured from `agy` 1.5.17).
  The driver runs the user's own `agy`; the install and update steps it names
  come from Google's docs, cited in `docs/drivers/antigravity.md`.
