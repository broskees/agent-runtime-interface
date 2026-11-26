# `claude` driver changelog

## Unreleased

First version of `ari/drivers/claude` and `ari/meta/claude`.

- Runs the user's own Claude Code through the Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk`, an optional peer, `^0.3.330`), loaded
  with a dynamic `import()`. Tested against SDK 0.3.330, which bundles Claude
  Code 2.1.330.
- ARI never downloads or ships Claude Code. Every query runs the user's
  `claude`: the configured `executablePath`, else `claude` on the host's
  `PATH`, passed to the SDK as `pathToClaudeCodeExecutable`, wherever the SDK
  comes from (npm under Node, `sdkDirectory` or `maintenance.install`). The
  native Claude Code package npm installs beside the SDK is never run. Every
  query also sets `mcpServersDelivery: "initialize"`, as the SDK recommends
  for an app that starts its own Claude Code, so no MCP server goes on its
  command line and the SDK's `CLAUDE_SDK_MCP_SERVERS_ARGV_DEPRECATED` warning
  never fires.
- The minimum is Claude Code 2.1.330 (`CLAUDE_TESTED_CLAUDE_CODE_VERSION`),
  the version the pinned SDK bundles, read from `claude --version`. No
  `claude` found: `driver_unavailable` saying Claude Code is not installed,
  how to install it (Anthropic's native installer) and `executablePath`. An
  older one: `driver_unavailable` naming the version, its path, the minimum,
  `claude update` and `executablePath`. One whose version cannot be read:
  `driver_unavailable` naming its path and what it printed. `openSession`
  rejects the same way before any session starts. A newer one runs, with an
  `untested_version` advisory. `ari/meta/claude` exports
  `CLAUDE_CODE_INSTALL_HINT` and `CLAUDE_CODE_UPDATE_HINT`; it no longer
  exports `CLAUDE_BINARY_HINT` or `claudeDirectoryBinaryHint`, and
  `ari/drivers/claude` no longer exports `nativeBinaryCandidates`.
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
  driver unavailable, naming it.
- Ambient sign-in from `claude auth status --json`, or an API key the
  instance stores; 30-second runtime auth poison per scope.
- Catalog from `supportedModels()`, limits from rate limit events, text
  generation without tools, native sessions through `listSessions`,
  `archiveSession` and `deleteSession`.
- Runs in the standalone `ari-driver`, which cannot import a package by name:
  the `sdkDirectory` config field loads the SDK from a directory where it is
  installed, and `maintenance.install` and `maintenance.update` download the
  pinned SDK (0.3.330), and only the SDK, from an npm registry
  (`sdkRegistry`, by default `https://registry.npmjs.org`) into the
  instance's cache directory. Only a sha512, sha384 or sha256
  `dist.integrity` is accepted, the tarball is checked before it is unpacked,
  and what is unpacked is what was checked. A record of every file (its size
  and sha256) lets `status()` report an install that is not whole, among it
  one an earlier ARI made with a native Claude Code package beside the SDK,
  and `maintenance.install` repair it with the SDK alone. Both routes import
  the SDK by file URL. The SDK stays out of ARI's package and executables
  (its licence is Anthropic's).
- Without an SDK, the standalone `ari-driver` names `maintenance.install` and
  `sdkDirectory`; under Node the message also names `npm install`.
