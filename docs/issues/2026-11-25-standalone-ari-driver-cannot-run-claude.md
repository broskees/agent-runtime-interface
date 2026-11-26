# The standalone `ari-driver` cannot run the `claude` driver

Reported 2026-11-25 from the CoChat Companion build (plan `ari-sessions-companion`,
found while planning; ARI pinned at `c61f7f3e5f31215f72f69c6f361f047cc936d4dc`).
Checked against `main` at `e40e1e6`.

## Summary

The standalone `ari-driver` executable (`bun build --compile`, one per release
target) answers `instance/status` for `claude` with `driver_unavailable`, and
there is no way to make it available. The `codex` driver works from the same
binary, because it needs only the `codex` CLI on `PATH`. Under Node, with
`@anthropic-ai/claude-agent-sdk` installed, the same `claude` driver works
(`installed: true`, SDK 0.3.330).

Hosts that use the standalone binary so their users need no Node, such as
CoChat Companion, therefore cannot offer Claude Code at all.

## Why it happens

- `scripts/build-binary.ts` (header comment, lines ~21-24, and `compile()` at
  ~98-101) passes every optional vendor SDK in `peerDependencies` as
  `--external`, so `@anthropic-ai/claude-agent-sdk` is not in the bundle. The
  comment says a driver whose SDK is missing reports it in `status()`, "as it
  does under Node when the package is not installed".
- `src/drivers/claude/sdk.ts` `loadClaudeSdk()` does
  `import("@anthropic-ai/claude-agent-sdk")` (via `SDK_SPECIFIER`). Inside a
  Bun-compiled executable that bare specifier does not resolve against a
  `node_modules` on disk. During planning it failed with `node_modules` in the
  working directory, with `node_modules` beside the executable, and with
  `NODE_PATH` set. So the Node behaviour ("install the package and it works")
  has no equivalent for the standalone binary: the install hint it prints
  cannot be followed.
- The SDK also runs a native `claude` binary from a platform package
  (`nativeBinaryCandidates()` in `sdk.ts`), found relative to the SDK's own
  files, so bundling the SDK's JavaScript alone is not enough.

## Reproduce

1. Build the standalone binary for this host: `node scripts/build-binary.ts`
   (or take a release asset).
2. Start it: `ari-driver claude`, send `initialize`, `driver/create`, then
   `instance/status`.
3. The status reports `driver_unavailable` naming
   `@anthropic-ai/claude-agent-sdk`, whatever is installed where.
4. Compare: `node ./src/wire/cli.ts claude` (or the Node bin) in a project with
   the SDK installed reports it installed.

## What a fix should guarantee

A host that ships only the standalone `ari-driver` can run the `claude` driver
on every release target, with a documented, testable way to provide whatever
it needs (bundled, or installed at a path the binary is told about). The
`status()` message must name a step the user can actually take.

## Possible approaches (not prescriptive; each needs a decision)

1. **Bundle the SDK into the standalone binary**, and provision its native
   `claude` binary per target beside the executable (the build comment already
   anticipates "native binaries provisioned beside the executable"). Needs a
   check that the SDK's licence allows redistributing it inside ARI's release
   assets; I did not check it.
2. **Load an installed SDK from an explicit path**: a driver config field (or
   environment variable) naming the SDK's directory, loaded with an absolute
   file URL instead of a bare specifier, plus the native binary found the way
   `sdk.ts` already does. The user installs the SDK with npm once.
3. **Drive the `claude` CLI directly** (its stream-JSON mode) instead of
   through the SDK, the way `codex` uses only its CLI. Largest change; removes
   the SDK dependency from the standalone path entirely.

## Tests that would prove it

- The standalone end-to-end suite (`test/standalone/standalone-binary.e2e.ts`)
  gains a `claude` case: with no `node` or `bun` on `PATH`, `instance/status`
  reports the driver available (with a fake or recorded `claude`), and a turn
  completes, as it already does for `pi` and `acp`.
- A negative case: with the SDK absent, the status message names the exact
  step that makes it available for the standalone binary.

## Who depends on this

CoChat Companion (`cochat-companion`, branch `feat/ari-sessions`) downloads the
standalone `ari-driver` for the owner's platform (SHA-256 pinned) and offers
"Claude Code on <machine>" and "Codex on <machine>" in CoChat. Until this is
fixed, a release build of Companion can offer only Codex. Its end-to-end phase
on a real Mac checks both.

## Resolution

Fixed by approach 2 plus a managed install (plan
`standalone-claude-20261125-190353`, phase 1): commit `f1a8db3`, then
`2a29185`, which tightens the install's integrity checks, lays the install
out as npm does and adds its repair. Approach 1 was ruled out: the
SDK's licence is Anthropic's ("SEE LICENSE IN README.md"), not MIT, so ARI
does not redistribute it.

- **`sdkDirectory`**, a new `claude` config field, names a directory where
  `npm install @anthropic-ai/claude-agent-sdk` ran. The driver imports
  `<sdkDirectory>/node_modules/@anthropic-ai/claude-agent-sdk` by its entry
  module's file URL, which a Bun-compiled executable can load (Bun 1.3.14,
  checked by hand), and finds the native binary beside it as the SDK does.
- **`maintenance.install` and `maintenance.update`**, now declared and
  implemented, download the pinned SDK 0.3.330 and the platform's native
  package from an npm registry (`sdkRegistry`, by default
  `https://registry.npmjs.org`) and unpack them with `ari/node`'s installer
  into the instance's cache directory, as one directory laid out as npm lays
  it out, so the SDK finds its native binary by itself. No Node or npm is
  needed. Only a sha512, sha384 or sha256 `dist.integrity` is accepted; both
  tarballs are checked before either is unpacked, and again as they are
  unpacked. A record of every file lets `status()` report a damaged install,
  naming `maintenance.install` and `sdkDirectory`, and `maintenance.install`
  repair it. The SDK's `sdk.mjs` imports only Node built-ins, so no peer
  package is installed.
- **Status names a real step.** Without an SDK, the standalone executable
  names `maintenance.install` and `sdkDirectory` only; under Node the
  message still names `npm install @anthropic-ai/claude-agent-sdk` too.
- **No SDK code ships.** `check:package` fails on a shipped file holding
  `CLAUDE_CODE_SDK_READS_SESSION_STATE`, a string unique to the SDK's
  `sdk.mjs`, and the end-to-end test checks the executable for it.

Tests:

- `test/standalone/claude-sdk.e2e.ts` (run by `pnpm run test:binary`): with
  no `node` or `bun` on `PATH`, the standalone `ari-driver` loads a fake SDK
  from `sdkDirectory` and completes a turn; installs it with
  `maintenance.install` from a local registry and completes a turn; reports
  `driver_unavailable` naming `maintenance.install` and `sdkDirectory` and no
  `npm install`; and holds no SDK code. The first two also run through
  `ari-driver` under Node.
- `test/drivers/claude/sdk-install.test.ts`: the same routes in process, a
  tampered SDK or native tarball that installs nothing, the digests a
  manifest must offer (sha1 and `shasum` refused), a download changed on disk
  after it was checked, two concurrent installs that end with one intact
  install, the default registry, the repair of six kinds of damage, the
  release targets' native packages, and the SDK's run-time imports.
  `test/drivers/claude/sdk-install-node.test.ts` changes a download while it
  is unpacked. The e2e test also repairs a missing `sdk.mjs` and a truncated
  native binary through the standalone `ari-driver`.
- `test/node/installer.test.ts`: the installer's `prepare` and `isIntact`
  hooks and `npmRegistryFetch`'s `strongIntegrityOnly`.
- `test/drivers/claude/availability.test.ts`: under Node without the package,
  the message names `npm install @anthropic-ai/claude-agent-sdk`.
- `test/package.test.ts`: the package check fails a staged or packed package
  that ships the SDK's `sdk.mjs`.

Phase 2 of the same plan checked it live on 2026-11-25 with
`ARI_LIVE_RECORD=1 node scripts/live-claude-standalone.ts`: with no `node`
or `bun` on `PATH`, the standalone `ari-driver` installed the real SDK
0.3.330 and its `linux-x64` native package from `registry.npmjs.org`,
`instance/status` reported 0.3.330, and a `haiku` turn on the user's Claude
sign-in completed. Before it, commit `b045e58` made the install record each
file's mode, so an install whose native binary lost its execute bit is
reported damaged and repaired (both repair tables above gained that case).
