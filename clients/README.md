# ARI clients for Rust, Python and Go

Three thin clients for `ari/wire`: newline-delimited JSON-RPC 2.0 on the stdio of an
`ari-driver` process. They let a host written in Rust, Python or Go run any ARI driver, and with
the standalone `ari-driver` executable no Node is needed at all (proposal §17.11).

| Directory | Package | Events | Errors |
|---|---|---|---|
| `rust/` | crate `ari-client` (`ari_client`) | `Subscription<AriEvent>`, a tokio `Stream` of `Result<AriEvent, CallError>` | `CallError` |
| `python/` | package `ari-client` (`ari_client`), Python 3.11+ | `Subscription[AriEvent]`, an asyncio `AsyncIterator` | `AriCallError` holding the `CallError` |
| `go/` | module `ari-go`, package `ari` | `*Stream[AriEvent]`, a typed channel `C` plus `Err()` | `*ari.Error` holding the `CallError` |

## What is generated and what is written by hand

`clients/codegen/` reads `json-schema/*.schema.json` and `spec/v1/methods.json` and writes:

- `rust/src/generated.rs`, `python/src/ari_client/_generated.py` and `go/generated.go`: one type
  for every wire definition, the method version table, one client method per call a host makes
  (`session_start_turn`, `SessionStartTurn`, ...), and the `Host` trait, base class or interface
  with one method per call a driver makes (`host/*`).
- `pnpm run codegen:clients` writes them; `pnpm run codegen:clients:check` (a gate step) fails
  when a committed file differs. The Go output goes through `gofmt`.

The hand-written part of each client is the framing only: request ids, answering the driver's
`host/*` calls while the host's own calls are pending, streams, the handshake checks, and
`MemoryHost`. No driver logic is reimplemented.

## Forward compatibility

- Every tagged union (`AriEventBody`, `CallError`, `ContentBlock`, `StartTurnResult`, ...) decodes
  a variant this client does not know as `Unrecognized` (Rust), `Unrecognized<Union>` (Python and
  Go), with its raw JSON. That covers `x:` extension events and variants a newer ARI adds. They
  encode back exactly as they came.
- Every enum keeps a value it does not know: `Unrecognized(String)` in Rust, a member whose
  `recognized` is false in Python, any string (with `Recognized()`) in Go.
- Optional fields that may also be `null` (the patch fields of `*.upsert` events) keep the
  difference between absent and `null`: `Option<Option<T>>` in Rust, `UNSET` and `None` in
  Python, `Nullable[T]` in Go.

## The host side

The clients offer no process delegation (`host.capabilities.process` is false): `ari-driver`
spawns the agents itself with the `envPolicy` passed to `initialize`. `MemoryHost` answers
`host/config.get` with the config given for each instance, keeps secrets and coordination leases
in memory, records diagnostics, lets background work run and resolves no attachments. Every
other host service answers `unsupported` until a host implements it. A config watch is answered
with a stream that ends at once.

When the driver's output ends, every pending call fails with a `transport` call error and every
open stream ends with that error.

## Running the tests

The tests spawn the standalone `ari-driver` and the compiled fake Pi and ACP agents from
`build/standalone/linux-x64/` (or `ARI_STANDALONE_DIR`), with a `PATH` that holds only the fake
`pi`, and complete a turn with an approval for `pi` and for `acp`.

```sh
pnpm run build:binary      # node scripts/build-binary.ts --fakes
pnpm run test:rust         # cargo test --locked
pnpm run test:python       # uv run --locked pytest
pnpm run test:go           # go test ./...
```
