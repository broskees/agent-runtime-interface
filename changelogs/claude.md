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
  `claude.fileCheckpoints` (`rewindFiles`) and the derived `ari.goal`.
- Ambient sign-in from `claude auth status --json`, or an API key the
  instance stores; 30-second runtime auth poison per scope.
- Catalog from `supportedModels()`, limits from rate limit events, text
  generation without tools, native sessions through `listSessions`,
  `archiveSession` and `deleteSession`.
