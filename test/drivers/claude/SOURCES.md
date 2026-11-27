# Sources for the fake Claude Agent SDK

The fake (`fake-sdk.ts`) follows these sources. Versions are pinned in
`package.json` devDependencies and must match this list.

| Source | Version | Used for |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` (npm), `sdk.d.ts` and `sdk-tools.d.ts` | 0.3.330 (published 2026-11-20; bundles Claude Code 2.1.330, `claudeCodeVersion` in its package.json) | Every type the fake and the driver exchange: `query`, `Options`, `Query`, `SDKMessage` and its members, `CanUseTool`, `PermissionResult`, `PermissionUpdate`, `SessionMessage`, `SDKSessionInfo`, `ModelInfo`, the session functions. `ProposeGoalInput` for `SetGoal`. |
| `@anthropic-ai/claude-agent-sdk` (npm), `sdk.mjs` | 0.3.330 | Where the SDK looks for its native Claude Code when no `pathToClaudeCodeExecutable` is set (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]/claude`, glibc first), so the tests put a decoy there (`sdkNativePackage` in `sdk-fixture.ts`) that the driver must never run, and the "Native CLI binary ... not found" failure. That it runs whatever `pathToClaudeCodeExecutable` names (directly, unless the path ends in `.js`, `.mjs`, `.ts`, `.tsx` or `.jsx`) and never checks its version. The launch arguments (`--output-format stream-json --verbose --input-format stream-json`, then `--flag=value` options) and the stream-json control protocol (`control_request` / `control_response` with `request_id`; `initialize`, `mcp_set_servers`) that `real-sdk-launch.test.ts`'s fake `claude` answers. `real-sdk-launch.test.ts` runs a copy of this file; nothing else does. |
| `@anthropic-ai/claude-agent-sdk` (npm), `sdk.mjs` and `package.json`, for the fixture SDK (`fixture-sdk/sdk.mjs`, `sdk-fixture.ts`) | 0.3.330 | The package layout the fixture copies (`exports["."].default` is `./sdk.mjs`, `claudeCodeVersion`), that `sdk.mjs` imports only Node built-ins (so a managed install needs no peer at run time), that it finds its native binary with `createRequire(import.meta.url).resolve(...)` unless `pathToClaudeCodeExecutable` is set, and the eight platform packages in `optionalDependencies`, all at the SDK's version. Also that setting `pathToClaudeCodeExecutable` turns off `readsInitializeAtBoot` (no `--await-initialize` on a resume), and that with `Options.mcpServers` holding a server Claude Code runs and no `mcpServersDelivery` it emits `CLAUDE_SDK_MCP_SERVERS_ARGV_DEPRECATED` once per process and puts the servers in `--mcp-config` (`sdk.mjs`, and `sdk.d.ts` on `mcpServersDelivery`, which recommends `'initialize'` to an app that starts its own Claude Code at or above the bundled version). Licence "SEE LICENSE IN README.md" (Anthropic's terms), from `npm view @anthropic-ai/claude-agent-sdk@0.3.330`. |
| Bun 1.3.14 docs (`docs/bundler/executables.mdx`) and source (`StandaloneModuleGraph` base paths `/$bunfs/` and `B:/~BUN/`, https://github.com/oven-sh/bun) | 1.3.14 | That a compiled executable's modules live under `/$bunfs/root/` (`B:/~BUN/root/` on Windows), where a bare import cannot reach a `node_modules` on disk. Checked by hand with Bun 1.3.14: `import(pathToFileURL(file).href)` of a module on disk works in a compiled executable, that module's `import.meta.url` is its disk URL, and its relative imports and `createRequire` lookups resolve on disk; the real SDK 0.3.330 loads that way. Also checked by hand: Bun keeps a module's parse error for the life of the process (a fixed file at the same URL still fails to import), while Node 26 retries; neither keeps a missing-file failure. So the driver checks the sha256 of the SDK's files before it imports them. |
| `@anthropic-ai/sdk` (npm) | 1.12.0 | `BetaMessage`, `BetaUsage`, `BetaRawMessageStreamEvent`, `MessageParam`: the Messages API shapes inside SDK messages. A peer of the Agent SDK, needed to type-check its declarations. |
| `@modelcontextprotocol/sdk` (npm) | 1.32.2 | Types the Agent SDK's declarations import. A peer, needed to type-check them. |
| `zod` (npm) | 4.6.7 | Types the Agent SDK's declarations import. A peer, needed to type-check them. |
| Agent SDK TypeScript reference, https://docs.claude.com/en/docs/agent-sdk/typescript (served from https://code.claude.com/docs/en/agent-sdk/typescript) | read 2026-11-23 | Behaviour: streaming input; prompt `priority` (`now` interrupts the running turn and is read next, `later` waits for the turn to end, `next` folds into it, a prompt to an idle session starts a turn); `shouldQuery: false`; result fields (`terminal_reason` values, `user_message_uuid(s)`, `startup_failure_reason` with `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1`, `structured_output`); `resume`, `forkSession`, `resumeSessionAt`, `sessionId`; `systemPrompt.snapshot` (the prompt is recorded in the transcript unless `snapshot: false`); `setMcpServers`, `stopTask` ("a task_notification with status 'stopped' will be emitted"), `rewindFiles` (needs `enableFileCheckpointing`), `applyFlagSettings`, `setModel`; `includeHookEvents`; `canUseTool` "not invoked for calls auto-approved by `allowedTools`, allow rules, or `permissionMode`" (Options table); `AskUserQuestion` answers in `updatedInput.answers`; `getSessionInfo`, `getSessionMessages`, `listSessions`, `archiveSession`, `deleteSession`. |
| The bundled Claude Code 2.1.330 binary's embedded JavaScript | 0.3.330's `@anthropic-ai/claude-agent-sdk-linux-x64` | Read with `grep -a` and `strings`, never run: the list of `terminal_reason` values, and that a turn stopped for a `now` prompt ends with `terminal_reason` `aborted_streaming` or `aborted_tools`. The `/goal` command: its answers (`Goal set: <condition>` then a model turn; `Goal cleared: <condition>` or `No goal set` for `clear`, `stop`, `off`, `reset`, `none`, `cancel`; `Goal condition is limited to 4000 characters (got <n>)`), each recorded as the tagged command and a `<local-command-stdout>` row. SetGoal's two results: "The goal is set, without an approval dialog. …" without `ask_user`, "Sent the goal proposal to the user for approval. …" with it. |
| `getSessionMessages` of the pinned SDK, run on transcripts a test writes | 0.3.330 | `goal.test.ts` writes a transcript in Claude Code's form (a meta caveat row, the tagged `/goal` command row, its tagged output row) and reads it with the real function, which returns the command and output rows as user rows and leaves the meta rows out. |
| `claude auth --help` and `claude auth status --help` on the installed Claude Code | 2.1.319 | That `claude auth status` exists and prints JSON by default (`--json`). Help text only. |
| `claude --version` on the installed Claude Code, and Anthropic's setup page https://code.claude.com/docs/en/setup | 2.1.319; read 2026-11-25 | That `claude --version` prints `<version> (Claude Code)` (`2.1.319 (Claude Code)` here; the page's example is `2.1.89 (Claude Code)`), which the fake `claude` copies and `parseClaudeCodeVersion` reads. The install commands the driver's hint names (`curl -fsSL https://claude.ai/install.sh \| bash`; `irm https://claude.ai/install.ps1 \| iex`) and the update command (`claude update`; package-manager installs upgrade through their manager). |
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

The process boundary tests use the installed SDK directly. The pinned
`sdk.d.ts` defines `spawnClaudeCodeProcess`, `SpawnOptions` and `SpawnedProcess`.
Its `sdk.mjs` calls the hook synchronously, attaches `exit` and `error`
listeners, and handles stderr itself only for its default spawn. The
[official TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript#spawnoptions)
also documents the forwarded abort signal: the SDK closes stdin first and
allows roughly two seconds for the CLI to exit before requesting teardown.
