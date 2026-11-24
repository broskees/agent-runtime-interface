# Sources of the Cursor driver and its fake

The driver and the fake SDK (`fake-sdk.ts`) follow the Cursor TypeScript SDK at
one pinned version:

- **Package:** `@cursor/sdk@1.4.2` on npm
  (<https://www.npmjs.com/package/@cursor/sdk>, tarball
  `https://registry.npmjs.org/@cursor/sdk/-/sdk-1.4.2.tgz`, integrity
  `sha512-IMeIZtLvVX5w6rOS34bfBQt2b/WsMm+6lLU6vdlia0E6RuuXup+aVXyJrzvVAfnI7pK8bPPc7Gx1dvxy7ci+1Q==`).
  It is ari's pinned devDependency (`package.json`), so the type checks and
  the fake's real half run against exactly this version. The platform
  package `@cursor/sdk-linux-x64@1.4.2` comes with it.
- **Docs:** <https://cursor.com/docs/sdk/typescript>, read on 2026-11-23
  (Overview, Authentication, Creating agents, Replacing the system prompt,
  SDKAgent, Run, Streaming, Cancelling a run, Steering a run in flight,
  Per-run model override, Conversation mode, Streaming raw deltas, Per-send
  options, Stream events, Interaction updates, Resuming agents, Cursor.auth,
  MCP servers, Subagents, Background subagents, Restricting the toolset,
  Sandbox options, Auto-review, Local agent stores, Errors, Known
  limitations).

## What each part follows

| Behaviour | Source in `@cursor/sdk@1.4.2` |
|---|---|
| The members the driver calls and every type it sends and reads | `dist/esm/stubs.d.ts` (`Agent`, `Cursor`), `agent.d.ts` (`SDKAgent`, `SendOptions`), `run.d.ts` (`Run`, `RunResult`, `RunError`, `SteerAckOutcome`), `options.d.ts` (`AgentOptions`, `LocalAgentOptions`, `McpServerConfig`, `ToolName`), `types/delta-types.d.ts` and `vendor/cursor-sdk-shared/delta-types.d.ts` (`InteractionUpdate`), `vendor/cursor-sdk-shared/tool-call-types.d.ts` (`ToolCall`), `auth/credential-store.d.ts` (`StoredSdkCredentials`, `FileCredentialStore`), `store/jsonl-local-agent-store.d.ts` |
| Agent creation and resume: option validation, the agent rows in the store, `AgentNotFoundError` for an agent the store lacks for that working directory, model resolution against `CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON` | the real SDK itself: the fake calls `Agent.create` and `Agent.resume` of the installed package (`dist/esm/index.js`, `createAgent`, `resumeAgent`, `resolveLocalModelSelection`, `listModelsForLocalValidation`) |
| A local `send()`: the RUNNING status first, which updates become stream messages and how, `onDelta` awaited for every update except the summary ones, an explicit model required, URL images refused | `dist/esm/index.js`, class `Qr` `sendImpl`, and `src/agent/run-interaction-accumulator.ts` (`apply`, `mergeIntoConversation`) |
| Which run a `send()` or `summarize()` gets: the queued first run `Agent.create` reserves, for the handle it returned only; else a follow-up run, refused ("Agent … already has active run") while the agent's active run is not terminal; `local.force` expires that run first (`expired`, `force_send`); the run marked starting, then terminal before `wait()` resolves, and cancelled at once by `cancel()` | the real SDK itself: the fake calls the real handle's `getRunForSend` and its store's `markRunStarting` and `markRunTerminal` (`dist/esm/index.js`, class `Qr` `getRunForSend` and `expireActiveRunForForceSend`; `src/agent/store/local-agent-store.ts` `createAgent`, `createFollowUpRun`, `markRunTerminal`; class `Tr` `cancel`). These are internals of 1.4.2; the fake fails loudly if they are missing. Run ids stay the fake's own deterministic ones; the store's are random |
| A local `Run`: `stream()`, `wait()`, `cancel()` (status cancelled at once, a CANCELLED status message, then the abort), `steer()` | `dist/esm/index.js`, class `Tr` |
| `steer()` answers: `complete_delivered` while the turn runs, `revert_to_followup` once it ended or for empty text | `dist/esm/977.js`, the local session runner's `steer` (`revert_to_followup` on every path where no generation runs); a delivered steer is appended as `user-message-appended` |
| Usage totals: input plus output tokens | `dist/esm/index.js`, `src/agent/usage-types.ts` |
| Error classes and codes: `AuthenticationError`, `RateLimitError` (`PRO_USER_USAGE_LIMIT`, `RATE_LIMITED`, ...), `NetworkError` (`unavailable`, ...), `UnknownAgentError`, `ConfigurationError`, `AgentNotFoundError` (`agent_not_found`) | `dist/esm/index.js`, `src/agent/errors.ts`; the fake throws the SDK's own classes |
| Credential resolution: `apiKey`, then `CURSOR_API_KEY`, then the stored login | `dist/esm/index.js`, the stored-credentials module (`Lc`) |
| No requests: a local run answers its own interaction queries | `dist/esm/977.js`, `ClientInteractionController` and the local query responder (questions rejected, plans and mode switches approved) |
| The per-workspace data directory, `$CURSOR_DATA_DIR/projects/<workspace>` or `~/.cursor/projects/<workspace>`; the transcript `agent-transcripts/<id>/<id>.jsonl`; MCP descriptors `mcps/<server>/SERVER_METADATA.json` and `STATUS.md` | `dist/esm/977.js`, `ko`, `_o`, `WB`, `LocalTranscriptWriter` (`qB`), `DF`, `McpFileSystemWriter` (`writeServerDirectory`); `dist/esm/index.js`, workspace-paths (`r_`, `sh`) |
| Cursor's tools inherit `process.env`, and no option changes that | `dist/esm/977.js`: the shell spawner and the fallback shell executor (`{ ...process.env, ... }`), the command executor registered beside the shell, the git and hg helpers; the local resource provider registers the `shellStreamArgs` and background shell executors on the same core executor whatever `overrideShellExecutor` and `suppressDefaultShellExecutor` say (`options.d.ts` `LocalSubagentResourceProviderFields`) |
| Valid tool names for `AgentOptions.tools` | the real SDK's own list, which `real-sdk.test.ts` reads from its `ConfigurationError` |

The shapes of real interaction updates (which come first for a tool call, a
`partial-tool-call` before `tool-call-started`; a `step-completed` after a
text step; a delivered steer followed by `user-message-appended`) were read
from recorded transcripts of real local runs that another project publishes
under the MIT license. Nothing was copied from them.

The fake checks every update it sends with the SDK's own
`InteractionUpdateSchema`, and `sdk-types.test.ts` checks the driver's types
against the SDK's.
