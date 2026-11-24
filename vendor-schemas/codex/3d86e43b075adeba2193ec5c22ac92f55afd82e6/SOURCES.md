# Codex app-server protocol, vendored

Upstream: https://github.com/openai/codex, tag `rust-v0.172.0`, commit
`3d86e43b075adeba2193ec5c22ac92f55afd82e6` (2026-11-23). These files are dev inputs to
`scripts/codegen-codex.ts`; nothing here ships in the package.

| File | What it is | sha256 |
|---|---|---|
| `codex_app_server_protocol.schemas.json` | The app-server protocol JSON Schema (draft-07), experimental API included. Upstream precomputes it: `codex-rs/app-server-protocol/schema/precomputed/app-server-exports-experimental.json.zst`, member `json_schema["codex_app_server_protocol.schemas.json"]`, written out unchanged. The stable export lacks `thread/backgroundTerminals/*`, `thread/memory/read` and `thread/readState/update`, which the driver uses, so the experimental export is vendored. | `b0ba23a68f1985e614f2036c630f1b86307951f6348607bea3ce48f94b724ee6` |
| `app-server-README.md` | `codex-rs/app-server/README.md` at the same commit, unchanged: notes on thread list filters, read state, memory summaries, MCP apps and errors. | `cf724138fc1913270430d72f6bc2a03b0d31ee59bb14ba425290c9e24d161104` |
| `hand-written-additions.json` | **Hand-written, not upstream output.** The schema names each request's params but not its response type; this file names the responses that do not follow the `<X>Params` to `<X>Response` rule, copied from `client_request_definitions!` in `codex-rs/app-server-protocol/src/protocol/common.rs` at the same commit. | `4d4ee61142f294ba523280cdc3e656420b0d065614409335728eb552ef6db463` |

To re-vendor at a newer tag: decompress that tag's precomputed experimental
export, write the member above to `codex_app_server_protocol.schemas.json` in
a directory named after the tag's commit, copy the README, update
`CODEX_SOURCE` in `scripts/codegen-codex.ts` and the hashes here, then run
`pnpm run codegen`.
