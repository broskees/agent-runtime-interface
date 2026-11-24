# Where the grok driver's fake comes from

## Protocol

The fake agent is `test/drivers/acp/fake-agent.ts`, written with the official
ACP SDK, `@agentclientprotocol/sdk` **2.9.1** (with `zod` 4.6.7), and every
frame of the conformance run is checked against ACP's JSON Schemas, release
`schema-v2.0.0-beta.3` (commit `94824f11ec78f7a6699323a9342e47fa5edf2530` of
https://github.com/agentclientprotocol/agent-client-protocol), vendored in
`vendor-schemas/acp/schema-v2.0.0-beta.3/`. `test/drivers/acp/SOURCES.md` has
the file digests, and `test/drivers/acp/vendor.suite.ts` checks them.

## Grok

- Launch: `grok agent stdio` and the top-level `--permission-mode` option,
  from `grok --help` and `grok agent --help` of Grok Build **1.0.70**
  (`grok 1.0.70 (f50904eaee6c)`, the CLI installed on the build machine; only
  `--help` and `--version` were run).
- ACP registry entry `grok-build` **1.0.93**
  (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json, read
  2026-11-23): npx package `@xai-official/grok@1.0.93`, arguments
  `agent stdio`.
- Grok speaks ACP v1, so the fake answers `initialize` with version 1 and the
  version line `grok 1.0.70 (fake)`.
- The probe's updater switch (`GROK_DISABLE_AUTOUPDATER`) and the launch
  arguments per runtime mode come from a public open-source ACP client, cited
  in `docs/drivers/grok.md` (the repository rule on host names keeps its name
  out of `test/`).
