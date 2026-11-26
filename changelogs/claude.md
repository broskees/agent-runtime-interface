# `claude` driver changelog

## Unreleased

First version of `ari/drivers/claude` and `ari/meta/claude`.

- Runs Claude Code through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`,
  an optional peer, `^0.3.330`), loaded with a dynamic `import()`. Tested
  against SDK 0.3.330, which bundles Claude Code 2.1.330.
- One `query()` per thread in streaming input mode; the driver picks session
  and prompt uuids, so ids follow from native data.
- Permission prompts (`canUseTool`) are `live` requests answered with
  `respond`; options are named after the answer Claude gets (`allow`,
  `allow:<settings destination>`, `deny`, `deny:interrupt`), with each
  destination's real scope. `AskUserQuestion` is a `user_input` request.
- Steer (`priority: "now"`, interrupting pending tools), queue
  (`priority: "later"`), Stop, fork from a turn (`forkSession` with
  `resumeSessionAt`), resume with `session.replaced` for a missing or held
  session, unload and release.
- Model, effort, permission mode and MCP server changes through
  `setModel`, `applyFlagSettings`, `setPermissionMode` and `setMcpServers`;
  MCP servers keep `alwaysLoad`.
- Background tasks and subagents from `task_*` messages; `stopTask` backs
  `backgroundTasks.stop` and `stopSubagent`.
- Extensions `claude.hooks` (settings hooks and `x:claude.hook` events),
  `claude.fileCheckpoints` (`rewindFiles`) and the derived `ari.goal`, which
  holds only what Claude Code confirms in the transcript: the `/goal`
  command's `Goal set` and `Goal cleared` output, and a `SetGoal` result that
  says the goal is set.
- A resume of a live thread applies a new model and effort to the running
  query, and a new system prompt append by resuming the session in a new
  query; it rejects with `invalid_state` while the thread has work running.
- A configured `executablePath` that names no executable file reports the
  driver unavailable.
- Ambient sign-in from `claude auth status --json`, or an API key the
  instance stores; 30-second runtime auth poison per scope.
- Catalog from `supportedModels()`, limits from rate limit events, text
  generation without tools, native sessions through `listSessions`,
  `archiveSession` and `deleteSession`.
- Runs in the standalone `ari-driver`, which cannot import a package by name:
  the `sdkDirectory` config field loads the SDK from a directory where it is
  installed, and `maintenance.install` and `maintenance.update` download the
  pinned SDK (0.3.330) and the platform's native package from an npm registry
  (`sdkRegistry`, by default `https://registry.npmjs.org`) into the
  instance's cache directory, as one directory laid out as npm lays it out,
  so the SDK finds its native binary by itself. Only a sha512, sha384 or
  sha256 `dist.integrity` is accepted, both tarballs are checked before
  either is unpacked, and what is unpacked is what was checked. A record of
  every file (its size, mode and sha256) lets `status()` report an install
  that is not whole, among it a native binary that lost its execute bit, and
  `maintenance.install` repair it. Both routes import the SDK by file URL.
  The SDK stays out of ARI's package and executables (its licence is
  Anthropic's).
- Without an SDK, the standalone `ari-driver` names `maintenance.install` and
  `sdkDirectory`; under Node the message also names `npm install`.
