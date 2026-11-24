# Where the ACP driver's fakes come from

The `acp` driver and its five flavors are tested against fake ACP agents.
Their protocol comes from ACP's own published sources, at these pinned
versions. `test/drivers/acp/vendor.suite.ts` checks that the vendored schema
files and the SDK devDependency match this file.

## Protocol schema

- ACP JSON Schemas, release `schema-v2.0.0-beta.3`, commit
  `94824f11ec78f7a6699323a9342e47fa5edf2530` of
  https://github.com/agentclientprotocol/agent-client-protocol, vendored in
  `vendor-schemas/acp/schema-v2.0.0-beta.3/`:

| File | sha256 |
|---|---|
| v1/schema.json | 79fbeccc5cb5668259ee35ff7440ffd79eaf813742366ac06f707b98bbf789db |
| v1/schema.unstable.json | fae41cc0d11b89001cf129c68c37c9c7233068a6f3cc7d08fbb54b6d9d8c5688 |
| v2/schema.json | 48b0a9298527adf35d6ac217f9894fb716e93a17a8eca69eea7f26874dd42c0b |
| v2/schema.unstable.json | dccabd97e7867822dfb086a5090771d4bdc44e795a9143306623bb0db20b6199 |

- Every frame the fake agent sends and every frame a driver sends in the
  conformance runs is checked against these schemas
  (`test/drivers/acp/frames.ts`, run by each driver's `conformance.suite.ts`).

## Test agents

- `fake-agent.ts` is written with the official TypeScript SDK,
  `@agentclientprotocol/sdk` **2.9.1** (npm, integrity
  `sha512-8iJdxGa3SunLfzqLLb3RfQFmr4hnmWeAyeAK6MbkJiXJbrRlMRgKsVnDl/7Hu48yu/30gAlytNDzh5W77rv5SA==`),
  pinned exactly in `package.json` `devDependencies`, with its required peer
  `zod` **4.6.7**. It uses the SDK's v1 app (`@agentclientprotocol/sdk/unstable`)
  for ACP v1 and its v2 app (`@agentclientprotocol/sdk/experimental/v2/unstable`)
  for ACP v2, so the SDK parses every frame the driver sends.
- `standalone-agent.ts` is a self-contained ACP agent with no imports (it can
  be compiled into an executable that needs no Node). It follows the same
  schemas, and its frames are checked by `standalone.suite.ts`.

## Protocol documents read

- Overview and v1 pages: https://agentclientprotocol.com/protocol/v1/overview.md,
  `.../protocol/v1/prompt-turn.md`, `.../protocol/v1/session-setup.md`,
  `.../protocol/v1/tool-calls.md`, `.../protocol/v1/session-config-options.md`,
  `.../protocol/v1/extensibility.md` (read 2026-11-23).
- v2: https://agentclientprotocol.com/protocol/v2/migration.md,
  `.../protocol/v2/prompt-lifecycle.md`, `.../protocol/v2/session-setup.md`,
  `.../protocol/v2/tool-calls.md`, `.../protocol/v2/extensibility.md`
  (read 2026-11-23; v2 is in Preview).
- Fork: https://agentclientprotocol.com/rfds/session-fork.md (a fork may be
  refused for another working directory).
