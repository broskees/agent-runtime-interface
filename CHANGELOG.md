# Changelog

Each driver also has its own changelog under [`changelogs/`](changelogs/).

## Unreleased

The first version. Nothing is published yet.

ARI installs nothing. It never downloads, unpacks, installs or updates a
vendor CLI, an agent or an SDK package; the user or the host installs every
one of them, and a driver whose CLI or SDK is missing reports
`driver_unavailable` naming what to install.

ARI passes the environment through. A host that wants a variable kept from
agents lists it in `envPolicy.stripAmbient`. No driver strips, refuses or
replaces a credential variable on its own; an instance's own stored
credential still wins over an inherited one. Every driver that starts
processes passes the instance's `environment` on to them, minus only what the
host's policy names; the ACP drivers passed none of it before.

ARI does not second-guess the user, the host or the vendor. A driver keeps
what a session saved, passes a value the vendor validates on to the vendor,
and reports a failure instead of replacing it with something else. Each
driver's changelog lists what changed:

- `opencode`: a resume without a policy keeps the session's saved permission
  rules instead of writing `approval_required` over them.
- A resume with `purpose: "history"` starts no writer, installs no MCP
  server, rewrites no permission and creates no conversation. `codex`,
  `opencode`, `claude` and `muse` read the stored thread and leave it
  `unloaded`; `acp` (and its flavors) and `pi`, which can open a session only
  to run it, refuse with `unsupported`. A missing session is `not_found`.
- A resume that fails for a reason other than a missing or held session
  returns the error instead of starting a fresh conversation (`acp` and its
  flavors, `claude`, `pi`).
- `pi` honours `persistSession: false` with Pi's `--no-session`; an earlier
  build saved the thread to disk anyway.
- A resume of a thread the session already holds applies its new launch,
  config and policy, or refuses naming what cannot change (`acp` and its
  flavors, `pi`, `muse`); an earlier build reported success and changed
  nothing.
- `acp` and its flavors ask the agent for a fork into another directory
  (`forkAcrossDirectories` defaults to `true`) and let it refuse one
  destination; an earlier build refused such forks by default and turned
  `crossCwd` off after one refusal.
- Smaller ones: `codex` passes every `x:codex.*` list filter and a named
  `permissions` profile in `policy.native` to Codex; `claude` accepts any
  unambiguous `claude --version` output and passes any `effort` on; `muse`
  passes any `reasoningEffort` on.
- `pi` and `opencode` find, probe and start their CLI with the instance's
  environment, as `codex` and `muse` do; an earlier build looked the CLI up
  on the host's `PATH`.

A host may leave the runtime mode to the harness. `RuntimePolicy.mode` is
optional: without it a driver sends the harness no permission override, so
the harness applies the user's own configuration for that workspace. Every
thread reports `effectiveMode`: the mode it runs in (an ARI mode, or the
vendor's own name when none fits), its interaction mode when known, and its
`source`, `host` or `harness`. A driver that cannot learn the mode reports
none. Each driver's changelog says what its harness reports:

- `claude`: no `permissionMode`; Claude Code's `system/init` and
  `system/status` report the mode. `codex`: no approval settings; every
  start, resume and fork answer and `thread/settings/updated` report them.
  `acp`: the agent's mode option or v1 mode id, as the agent names it;
  `antigravity` and `kiro` map theirs; `grok` stays in Grok's `default` mode,
  which its launch fixes. `muse`: Muse's approval mode, in its own words.
  `cursor`: `full_access`, the options it gives a thread without a mode.
  `opencode` and `pi`: unknown.
- A turn's policy, or a resume of a thread the session holds, that names no
  mode sends nothing, and the thread keeps its mode.
- `codex` and `claude` no longer record `approval_required` for a resume
  without a policy and send it again later; `codex` applies a loaded
  thread's resume policy and model with `thread/settings/update`, and
  refuses another launch or directory, naming it, where an earlier build
  returned the thread unchanged.

### Contract (`ari`, `ari/json-schema/*`)

- The ARI wire contract, version 1, as JSON Schema draft 2020-12 under
  `spec/v1/`, with `methods.json` listing every `ari/wire` method, and the
  shared experimental extension `ari.goal`.
- `RuntimePolicy.mode` is optional; `EffectiveMode` (`mode`, `interaction`,
  `source`) is new, carried by `Thread.effectiveMode` and
  `ThreadPatch.effectiveMode`. The Go, Python and Rust clients follow.
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
  resume and fork launches. A launch keeps the environment the host gives
  it. `CliLaunchManifest` has no `envScrubPrefixes`, and `scrubEnv` is gone:
  an earlier build let a manifest strip variables, which no driver does now.
- `ari/conformance`: 15 conformance scenarios, a recording fake host, a
  `node:test` adapter (which also runs under `bun test`), virtual time and an
  in-memory reference driver. The fake host strips nothing without an
  `envPolicy` and honours `inheritEnv: false`. Scenario 10 checks that
  inherited credentials reach the agent while the host strips nothing, and
  that none does once the host's `envPolicy.stripAmbient` names them.
  Scenario 2 runs on a thread whose policy names no mode, and every thread
  the kit creates must report `effectiveMode` with the right `source`.
- The capability guard asks for no `runtimePolicy.modes.<mode>` when a
  policy names no mode, and counts a turn that names none as no switch.
- `ari/node`: process spawning with environment rules and process-group
  cleanup, file-backed secrets, instance paths, coordination leases,
  diagnostics and sign-in callbacks.

### Wire and clients

- `ari/wire`: newline-delimited JSON-RPC 2.0 on stdio, with a handshake that
  negotiates the contract, grammar, method and persistence versions; host
  services across the wire, with optional process delegation; and the
  `ari-driver` bin.
- A standalone `ari-driver` executable built with `bun build --compile`. It
  includes the JavaScript of the Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk` 0.3.330, © Anthropic PBC, under
  Anthropic's terms, not ARI's MIT License), so its `claude` driver needs no
  SDK install and no config. It includes none of the SDK's platform packages
  and no Claude Code. The npm package holds no SDK code.
- Thin Rust (`ari-client`), Python (`ari-client`) and Go (`ari-go`) clients
  generated from the JSON Schema.

### Drivers (`ari/drivers/<name>`, `ari/meta/<name>`)

- `pi`, `acp` (ACP v1 and v2), the ACP flavors `grok`, `fx`, `kiro` and
  `antigravity`, `codex`, `claude`, `opencode` (1.x and 2.x servers),
  `cursor` and `muse`.
- `antigravity` uses the user's own `agy` profile and sign-in by default
  (`profile: "user"`); `profile: "instance"` gives an instance a private
  profile and sign-in, as every instance had in earlier builds. Only
  `agy --version` runs with the self-updater off.

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
  downloaded the Claude Agent SDK, and its `sdkRegistry` config field. Under
  Node the host installs the SDK next to ari; the standalone `ari-driver`
  includes it. The `sdkDirectory` config field, which an earlier build of
  this version added for the standalone `ari-driver`, is gone too.
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
  GitHub release, with `THIRD-PARTY-NOTICES.md`, the notice for the Claude
  Agent SDK code they include.
