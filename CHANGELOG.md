# Changelog

Each driver also has its own changelog under [`changelogs/`](changelogs/).

## Unreleased

The first version. Nothing is published yet.

### Contract (`ari`, `ari/json-schema/*`)

- The ARI wire contract, version 1, as JSON Schema draft 2020-12 under
  `spec/v1/`, with `methods.json` listing every `ari/wire` method, and the
  shared experimental extension `ari.goal`.
- Generated TypeScript types and zero-dependency validators implementing
  Standard Schema v1 and Standard JSON Schema v1. Unknown enum values and `x:`
  extension variants validate and come back unchanged.
- Call errors with type guards, failure classes, the patch helper, capability
  helpers and the `Driver`, `Instance`, `Session` and `HostServices`
  interfaces in the root export.
- Published schema copies under `ari/json-schema/*`.

### Toolkits

- `ari/host`: the event grammar validator (`strict`, `warn`, `repair`), the
  event reducer, the request ledger, the capability guard and fallback
  planner, the approval reviewer hook and the replay recorder with its
  versioned fixture format.
- `ari/driver-kit`: the event sequencer, deterministic ID derivation, an
  NDJSON framer, a JSON-RPC 2.0 peer and UTF-8 truncation.
- `ari/cli-manifests`: CLI launch manifests and launch building for fresh,
  resume and fork launches.
- `ari/conformance`: 15 conformance scenarios, a recording fake host, a
  `node:test` adapter, virtual time and an in-memory reference driver.
- `ari/node`: process spawning with environment rules and process-group
  cleanup, file-backed secrets, an atomic managed adapter installer, instance
  paths, coordination leases, diagnostics and sign-in callbacks.

### Wire and clients

- `ari/wire`: newline-delimited JSON-RPC 2.0 on stdio, with a handshake that
  negotiates the contract, grammar, method and persistence versions; host
  services across the wire, with optional process delegation; and the
  `ari-driver` bin.
- A standalone `ari-driver` executable built with `bun build --compile`.
- Thin Rust (`ari-client`), Python (`ari-client`) and Go (`ari-go`) clients
  generated from the JSON Schema.

### Drivers (`ari/drivers/<name>`, `ari/meta/<name>`)

- `pi`, `acp` (ACP v1 and v2), the ACP flavors `grok`, `fx`, `kiro`,
  `acp-registry` and `antigravity`, `codex`, `claude`, `opencode` (1.x and
  2.x servers), `cursor` and `muse`.

### Effect

- `ari/effect`: Effect services, session events as a `Stream`, tagged call
  errors and generated Effect schemas. `effect@^4` is an optional peer.

### Packaging and release

- The tarball is packed with `scripts/pack.ts`: its `package.json` leaves out
  the repository-only `development` export condition, so every condition a
  consumer's tools resolve names a shipped file.
- CI runs the gate on Node 22, 24 and 26 and on Bun. The release workflow
  publishes with npm trusted publishing and provenance, refuses runtime
  dependencies and attaches `ari-driver` binaries for five platforms to the
  GitHub release.
