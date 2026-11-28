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
  comes from (npm under Node, or the SDK compiled into the standalone
  `ari-driver`). The native Claude Code package npm installs beside the SDK
  is never run. Every
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
- A resume with `purpose: "history"` of a session Claude Code has no
  transcript for is `not_found`; an earlier build started a fresh session
  in its place when the host passed `policy`.
- A configured `executablePath` that names no executable file reports the
  driver unavailable, naming it.
- Ambient sign-in from `claude auth status --json`, or an API key the
  instance stores; 30-second runtime auth poison per scope.
- Claude Code gets the instance's environment, credentials included, minus
  only the host's `envPolicy.stripAmbient`. The instance's own key replaces
  `ANTHROPIC_API_KEY` and leaves out `ANTHROPIC_AUTH_TOKEN`, which Claude Code
  would use first. `claude --version` and `claude auth status` run in that same
  environment, never the host process's. `CLAUDE_CREDENTIAL_VARIABLES` and the
  CLI manifest's `envScrubPrefixes` are gone.
- Catalog from `supportedModels()`, limits from rate limit events, text
  generation without tools, native sessions through `listSessions`,
  `archiveSession` and `deleteSession`.
- ARI installs nothing. Under Node the host installs the SDK and the driver
  imports it by name; the npm package holds none of the SDK's code.
- The standalone `ari-driver`, which cannot import a package by name, has
  the pinned SDK 0.3.330's JavaScript compiled in, so its `claude` driver
  needs no SDK install and no config. It holds none of the SDK's 8 platform
  packages and no Claude Code: it runs the user's `claude`, with the same
  minimum. The SDK is © Anthropic PBC, under Anthropic's terms, not ARI's MIT
  License; `THIRD-PARTY-NOTICES.md`, attached to each release beside the
  binaries, says so.
- Under Node without the SDK, `status()` is `unavailable` with
  `driver_unavailable` and `openSession` rejects with it. The message says
  ARI does not install the SDK and names
  `npm install @anthropic-ai/claude-agent-sdk@0.3.330` next to ari.
- Removed: `maintenance.install` and `maintenance.update`, which an earlier
  build of this version offered to download the SDK into the instance's
  cache directory, the `sdkRegistry` config field they read, and the `fetch`
  option of `createClaudeDriver` they downloaded with. The config schema now
  refuses `sdkRegistry`.
- Removed: the `sdkDirectory` config field, which loaded the SDK from a
  directory the host installed it in and was the standalone `ari-driver`'s
  only way to get the SDK; the binary now has it compiled in. The config
  schema now refuses `sdkDirectory`. `ari/meta/claude` no longer exports
  `CLAUDE_SDK_INSTALL_COMMAND` or `CLAUDE_STANDALONE_INSTALL_HINT`, and
  `CLAUDE_INSTALL_HINT` names only the npm install next to ari.
