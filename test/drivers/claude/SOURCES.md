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
| Agent SDK TypeScript reference, https://docs.claude.com/en/docs/agent-sdk/typescript (served from https://code.claude.com/docs/en/agent-sdk/typescript) | read 2026-11-23 | Behaviour: streaming input; prompt `priority` (`now` interrupts the running turn and is read next, `later` waits for the turn to end, `next` folds into it, a prompt to an idle session starts a turn); `shouldQuery: false`; result fields (`terminal_reason` values, `user_message_uuid(s)`, `startup_failure_reason` with `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1`, `structured_output`); `resume`, `forkSession`, `resumeSessionAt`, `sessionId`; `systemPrompt.snapshot` (the prompt is recorded in the transcript unless `snapshot: false`); `setMcpServers`, `stopTask` ("a task_notification with status 'stopped' will be emitted"), `rewindFiles` (needs `enableFileCheckpointing`), `applyFlagSettings`, `setModel`; `includeHookEvents`; `canUseTool` "not invoked for calls auto-approved by `allowedTools`, allow rules, or `permissionMode`" (Options table); `AskUserQuestion` answers in `updatedInput.answers`; `getSessionInfo`, `getSessionMessages`, `listSessions`, `archiveSession`, `deleteSession`. |
| The bundled Claude Code 2.1.330 binary's embedded JavaScript | 0.3.330's `@anthropic-ai/claude-agent-sdk-linux-x64` | Read with `grep -a` and `strings`, never run: the list of `terminal_reason` values, and that a turn stopped for a `now` prompt ends with `terminal_reason` `aborted_streaming` or `aborted_tools`. The `/goal` command: its answers (`Goal set: <condition>` then a model turn; `Goal cleared: <condition>` or `No goal set` for `clear`, `stop`, `off`, `reset`, `none`, `cancel`; `Goal condition is limited to 4000 characters (got <n>)`), each recorded as the tagged command and a `<local-command-stdout>` row. SetGoal's two results: "The goal is set, without an approval dialog. …" without `ask_user`, "Sent the goal proposal to the user for approval. …" with it. |
| `getSessionMessages` of the pinned SDK, run on transcripts a test writes | 0.3.330 | `goal.test.ts` writes a transcript in Claude Code's form (a meta caveat row, the tagged `/goal` command row, its tagged output row) and reads it with the real function, which returns the command and output rows as user rows and leaves the meta rows out. |
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
  `acceptEdits` runs edits without asking, and then no permission reply
  exists; otherwise `canUseTool` is called.
  The kit's options become `suggestions` with settings destinations
  (`localSettings`, `userSettings`, `projectSettings`, `session`), because
  Claude's permission results carry no option ids.
- `setModel` and `applyFlagSettings` change the model and effort the
  process runs (`FakeQuery.model`, `FakeQuery.effort`).
- A session id is in use once its transcript exists or a running process
  holds it; an id that never got a message is free again after its process
  ended.
- `/goal` runs as Claude Code 2.1.330 runs it (see above): the transcript
  gets the tagged command row under the prompt's uuid and the tagged output
  row, and only `Goal set` goes on to a model turn; every other answer ends
  the prompt with a `result` and no model turn. SetGoal (`proposeGoal`) sets
  the goal only without `ask_user`.
- With `writeTranscripts`, transcripts are mirrored to
  `<CLAUDE_CONFIG_DIR or HOME/.claude>/projects/<cwd>/<session>.jsonl`, with
  the system prompt recorded unless `snapshot: false`, and only ever under
  the OS temp directory.
- Left out: real model output, compaction, MCP servers (`setMcpServers` is
  recorded and answered), Query methods the driver does not call (they
  throw), the CLI's own settings files, and the assistant message Claude
  Code streams with a local command's output (the driver reads goals from
  the transcript, not from the stream).
