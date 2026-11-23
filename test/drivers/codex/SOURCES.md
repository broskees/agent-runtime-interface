# Protocol sources of the fake Codex CLI

The fake in `fake-app-server.ts` speaks the Codex app-server protocol of
https://github.com/openai/codex at tag `rust-v0.172.0`, commit
`3d86e43b075adeba2193ec5c22ac92f55afd82e6`.

| Source | URL or path | Pinned at |
|---|---|---|
| App-server protocol JSON Schema (every frame the fake sends and the driver sends is validated against it) | `vendor-schemas/codex/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex_app_server_protocol.schemas.json`, from https://github.com/openai/codex/tree/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/app-server-protocol/schema/precomputed | commit `3d86e43b075adeba2193ec5c22ac92f55afd82e6`, sha256 `b0ba23a68f1985e614f2036c630f1b86307951f6348607bea3ce48f94b724ee6` |
| Request to response type names | https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/app-server-protocol/src/protocol/common.rs (`client_request_definitions!`, `server_request_definitions!`) | commit `3d86e43b075adeba2193ec5c22ac92f55afd82e6` |
| App-server README (thread list filters, read state, memory, errors) | `vendor-schemas/codex/3d86e43b075adeba2193ec5c22ac92f55afd82e6/app-server-README.md`, from https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/app-server/README.md | commit `3d86e43b075adeba2193ec5c22ac92f55afd82e6` |
| JSON-RPC error codes (`-32600` invalid request, `-32603` internal) | https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/app-server/src/error_code.rs | commit `3d86e43b075adeba2193ec5c22ac92f55afd82e6` |
| Steer refusals: `no active turn to steer`, `expected active turn id ... but found ...` | https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/app-server/src/request_processors/turn_processor.rs | commit `3d86e43b075adeba2193ec5c22ac92f55afd82e6` |
| Resume failures: `no rollout found for thread id ...` (missing), `error resuming thread: ... already has an active writer` (another process holds the rollout writer lock) | https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/app-server/src/request_processors/thread_processor.rs and https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/rollout/src/writer_lock.rs | commit `3d86e43b075adeba2193ec5c22ac92f55afd82e6` |
| `codex login status` output (stderr lines, exit codes) | https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/cli/src/login.rs (`run_login_status`) | commit `3d86e43b075adeba2193ec5c22ac92f55afd82e6` |
| `codex --version` output (`codex-cli <version>`) and the `resume` and `fork` subcommands | https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/cli/src/main.rs | commit `3d86e43b075adeba2193ec5c22ac92f55afd82e6` |
| `CODEX_HOME` must exist | https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/utils/home-dir/src/lib.rs | commit `3d86e43b075adeba2193ec5c22ac92f55afd82e6` |
| Frame order of a real app-server (answer before `turn/started`, server request ids from 0, `serverRequest/resolved` after an answer, subagent activity items, async question items) | Recorded app-server transcripts of Codex 0.156.1 in a public MIT-licensed host's test fixtures, read for protocol knowledge only; no file of theirs is copied | read 2026-11-23 |

No vendor SDK package is involved: the driver runs the user's `codex` CLI.
