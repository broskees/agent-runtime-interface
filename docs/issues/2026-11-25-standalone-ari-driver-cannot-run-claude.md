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
