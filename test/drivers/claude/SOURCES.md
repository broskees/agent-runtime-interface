# Sources for the fake Claude Agent SDK

The fake (`fake-sdk.ts`) follows these sources. Versions are pinned in
`package.json` devDependencies and must match this list.

| Source | Version | Used for |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` (npm), `sdk.d.ts` and `sdk-tools.d.ts` | 0.3.330 (published 2026-11-20; bundles Claude Code 2.1.330, `claudeCodeVersion` in its package.json) | Every type the fake and the driver exchange: `query`, `Options`, `Query`, `SDKMessage` and its members, `CanUseTool`, `PermissionResult`, `PermissionUpdate`, `SessionMessage`, `SDKSessionInfo`, `ModelInfo`, the session functions. `ProposeGoalInput` for `SetGoal`. |
| `@anthropic-ai/claude-agent-sdk` (npm), `sdk.mjs` | 0.3.330 | How the SDK finds its native binary (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]/claude`, glibc first) and the "Native CLI binary ... not found" failure. Read, not run. |
| `@anthropic-ai/sdk` (npm) | 1.12.0 | `BetaMessage`, `BetaUsage`, `BetaRawMessageStreamEvent`, `MessageParam`: the Messages API shapes inside SDK messages. A peer of the Agent SDK, needed to type-check its declarations. |
| `@modelcontextprotocol/sdk` (npm) | 1.32.2 | Types the Agent SDK's declarations import. A peer, needed to type-check them. |
| `zod` (npm) | 4.6.7 | Types the Agent SDK's declarations import. A peer, needed to type-check them. |
| Agent SDK TypeScript reference, https://docs.claude.com/en/docs/agent-sdk/typescript (served from https://code.claude.com/docs/en/agent-sdk/typescript) | read 2026-11-23 | Behaviour: streaming input; prompt `priority` (`now` interrupts the running turn and is read next, `later` waits for the turn to end, `next` folds into it, a prompt to an idle session starts a turn); `shouldQuery: false`; result fields (`terminal_reason` values, `user_message_uuid(s)`, `startup_failure_reason` with `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1`, `structured_output`); `resume`, `forkSession`, `resumeSessionAt`, `sessionId`; `systemPrompt.snapshot` (the prompt is recorded in the transcript unless `snapshot: false`); `setMcpServers`, `stopTask` ("a task_notification with status 'stopped' will be emitted"), `rewindFiles` (needs `enableFileCheckpointing`), `applyFlagSettings`; `includeHookEvents`; `AskUserQuestion` answers in `updatedInput.answers`; `getSessionInfo`, `getSessionMessages`, `listSessions`, `archiveSession`, `deleteSession`. |
| The bundled Claude Code 2.1.330 binary's embedded JavaScript | 0.3.330's `@anthropic-ai/claude-agent-sdk-linux-x64` | Read with `grep -a`, never run: the list of `terminal_reason` values, and that a turn stopped for a `now` prompt ends with `terminal_reason` `aborted_streaming` or `aborted_tools`. |
| `claude auth --help` and `claude auth status --help` on the installed Claude Code | 2.1.319 | That `claude auth status` exists and prints JSON by default (`--json`). Help text only. |
| Public bug reports on `claude auth status` output, https://github.com/anthropics/claude-code/issues/76168 and https://github.com/anthropics/claude-code/issues/84394 | read 2026-11-23 | The JSON shape `{ "loggedIn": ..., "authMethod": ..., "apiProvider": ... }` and that it exits 0 whether signed in or not. |

Protocol notes were also read from a reference host's public MIT-licensed
Claude adapter (named in the phase report): that a steer with priority "now"
first yields a result with `terminal_reason` `aborted_streaming` or
`aborted_tools`, and that an interrupted turn's result may be a `success`
with `is_error: false` and an abort `terminal_reason`. No code or names were
copied.

## What the fake models, and what it leaves out

- One fake Claude Code installation per rig (`FakeClaudeWorld`): a transcript
  store by session id, every query ("process"), and the puppet's turns. Ids
  start over in every rig.
- Claude Code writes a session's transcript only once it holds a message;
  `getSessionInfo` of an empty or unknown session is `undefined`.
- `resume` of an unknown session exits; of a session marked held (the kit's
  `lockSession`) it writes the `session_held_by_background` startup failure
  result (with `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1`) and exits.
- Permission modes: `bypassPermissions` runs every tool without asking,
  `acceptEdits` runs edits without asking; otherwise `canUseTool` is called.
  The kit's options become `suggestions` with settings destinations
  (`localSettings`, `userSettings`, `projectSettings`, `session`), because
  Claude's permission results carry no option ids.
- With `writeTranscripts`, transcripts are mirrored to
  `<CLAUDE_CONFIG_DIR or HOME/.claude>/projects/<cwd>/<session>.jsonl`, with
  the system prompt recorded unless `snapshot: false`, and only ever under
  the OS temp directory.
- Left out: real model output, compaction, MCP servers (`setMcpServers` is
  recorded and answered), Query methods the driver does not call (they
  throw), and the CLI's own settings files.
