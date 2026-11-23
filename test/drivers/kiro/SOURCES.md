# Where the kiro driver's fake comes from

## Protocol

The fake agent is `test/drivers/acp/fake-agent.ts`, written with the official
ACP SDK, `@agentclientprotocol/sdk` **2.9.1** (with `zod` 4.6.7), and every
frame of the conformance run is checked against ACP's JSON Schemas, release
`schema-v2.0.0-beta.3` (commit `94824f11ec78f7a6699323a9342e47fa5edf2530` of
https://github.com/agentclientprotocol/agent-client-protocol), vendored in
`vendor-schemas/acp/schema-v2.0.0-beta.3/`. `test/drivers/acp/SOURCES.md` has
the file digests, and `test/drivers/acp/vendor.test.ts` checks them.

## Kiro

- Kiro CLI ACP docs, https://kiro.dev/docs/cli/acp/ (page updated
  2026-11-18): `kiro-cli acp`, `--agent-engine` (`v1`, `v2`, `v3`),
  `loadSession: true`, sessions loaded with `session/load`, V3 turns settled
  by the `session/prompt` response (ACP v1).
- ACP registry entry `kiro` **3.0.0**
  (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json, read
  2026-11-23): `./kirocli/bin/kiro-cli acp --agent-engine=v3`.
- `--auth-method=cli` and the `autopilot` and `model` session options come
  from a public open-source ACP client of Kiro, cited in `docs/drivers/kiro.md`
  (the repository rule on host names keeps its name out of `test/`).
- The fake runs with `--load` (it advertises `loadSession` and replays
  history on `session/load`, as Kiro does) and offers `autopilot` and
  `model` (`fixtures.ts`).
