# Changelog

Each driver also has its own changelog under [`changelogs/`](changelogs/).

## Unreleased

The first version. Nothing is published yet.

ARI installs nothing. It never downloads, unpacks, installs or updates a
vendor CLI, an agent or an SDK package; the user or the host installs every
one of them, and a driver whose CLI or SDK is missing reports
`driver_unavailable` naming what to install.

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
  `node:test` adapter (which also runs under `bun test`), virtual time and an
  in-memory reference driver.
- `ari/node`: process spawning with environment rules and process-group
  cleanup, file-backed secrets, instance paths, coordination leases,
  diagnostics and sign-in callbacks.

### Wire and clients

- `ari/wire`: newline-delimited JSON-RPC 2.0 on stdio, with a handshake that
  negotiates the contract, grammar, method and persistence versions; host
  services across the wire, with optional process delegation; and the
  `ari-driver` bin.
- A standalone `ari-driver` executable built with `bun build --compile`.
- Thin Rust (`ari-client`), Python (`ari-client`) and Go (`ari-go`) clients
  generated from the JSON Schema.

### Drivers (`ari/drivers/<name>`, `ari/meta/<name>`)

- `pi`, `acp` (ACP v1 and v2), the ACP flavors `grok`, `fx`, `kiro` and
  `antigravity`, `codex`, `claude`, `opencode` (1.x and 2.x servers),
  `cursor` and `muse`.

### Removed: every installation feature

Earlier builds of this unreleased version could install things. All of it is
gone:

- The `acp-registry` driver (`ari/drivers/acp-registry`,
  `ari/meta/acp-registry`), which installed ACP Registry agents. Install the
  agent yourself and run it with the `acp` driver, which runs any ACP agent
  you name with `command` and `args`.
- The wire methods `instance/maintenance.install` and
  `instance/maintenance.update`, and `Instance.maintenance.install` and
  `.update`, from the contract, the wire code, the JSON Schemas and the Rust,
  Python and Go clients. `maintenance.advisory` stays. The `SpawnPurpose`
  value `install` is gone too; a purpose is still any string.
- The `claude` driver's `maintenance.install` and `maintenance.update`, which
  downloaded the Claude Agent SDK, and its `sdkRegistry` config field. The
  host installs the SDK: next to ari under Node, or in a directory named by
  `sdkDirectory`, the only way for the standalone `ari-driver`.
- `ari/node`'s managed adapter installer (`createAdapterInstaller`,
  `npmRegistryFetch`, install leases, `<cacheDir>/adapters/`), its tar
  extractor (`extractTarball`) and `DEFAULT_HANDSHAKE_TIMEOUT_MS`.

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
