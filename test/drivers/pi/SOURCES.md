# Sources for the Pi driver and its fake

The Pi driver (`src/drivers/pi/`) and the fake `pi` it is tested against
(`test/drivers/pi/fake-pi.ts`) follow Pi's published protocol at one pinned
version.

## Pinned version

- npm package: `@earendil-works/pi-coding-agent@1.6.0` (the `pi` CLI), pinned
  as a devDependency in `package.json`. It is the `latest` tag on npm as of
  2026-11-23.
- Its docs ship in the package (`docs/*.md`) and match
  https://pi.dev/docs/latest/ on 2026-11-23.
- Source repository: https://github.com/earendil-works/pi
  (`packages/coding-agent`), at the commit published as 1.6.0.

## Documents

| Document | Used for |
|---|---|
| https://pi.dev/docs/latest/rpc (`docs/rpc.md`) | `pi --mode rpc`; strict JSONL framing (split on LF only, strip a trailing CR, never split on U+2028 or U+2029); command ids and responses; prompt acceptance versus completion; `agent_settled`; parse errors; shutdown by closing stdin or SIGTERM |
| https://pi.dev/docs/latest/rpc-commands (`docs/rpc-commands.md`) | `prompt` (`disposition` `started`, `queued`, `handled`; extension commands run at once), `steer`, `follow_up`, `abort` (answers once idle), `clear_queue`, `get_state`, `get_messages`, `get_entries` (all entries in append order, `leafId`), `set_model`, `set_thinking_level`, `compact`, `get_available_models`, `set_session_name`, `fork`, `get_commands` |
| https://pi.dev/docs/latest/json (`docs/json.md`) | Session events: `agent_start`, `turn_start`, `message_start`, `message_update` (delta-only, with `usage`), `message_end`, `turn_end`, `tool_execution_*`, `queue_update`, `compaction_*`, `auto_retry_*`, `agent_end`, `agent_settled`, `extension_error` |
| https://pi.dev/docs/latest/rpc-extension-ui (`docs/rpc-extension-ui.md`) | `extension_ui_request` (`select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, ...) and `extension_ui_response` (`value`, `confirmed`, `cancelled`) |
| https://pi.dev/docs/latest/message-types (`docs/message-types.md`) | `AgentMessage` shapes: user, assistant (`stopReason`, `errorMessage`, `usage`), tool results |
| https://pi.dev/docs/latest/session-format (`docs/session-format.md`) | Session files: header, entries as a tree by `parentId`, `label` entries, file name `<timestamp>_<session id>.jsonl`, the system message that keeps the prompt's sections |
| https://pi.dev/docs/latest/sessions (`docs/sessions.md`) | A session keeps the working directory it was created in; `--fork` copies a session into the current directory |
| https://pi.dev/docs/latest/cli (`docs/cli.md`) | `--version`, `--session`, `--fork`, `--session-dir`, `--no-session`, `--model`, `--thinking`, `--api-key` (only with `--model`), `--append-system-prompt`, `--extension`, `pi auth check --json --no-refresh` |
| https://pi.dev/docs/latest/mcp (`docs/mcp.md`) | MCP server config (stdio and streamable HTTP, no SSE), `exposure: "direct"`, `pi.registerMcpServer` from extensions, `mcp.json` taking precedence |
| https://pi.dev/docs/latest/extensions (`docs/extensions.md`) | Extension events (`session_start`, `tool_call`, `before_agent_start`), `registerCommand`, `ctx.ui.select`, `ctx.navigateTree`, `ctx.sessionManager` (`getSessionFile`, `getHeader`), the `permission-gate.ts` and `subagent/` examples |
| https://pi.dev/docs/latest/providers (`docs/providers.md`) | Provider credential variables (`PI_CREDENTIAL_VARIABLES`) |
| https://pi.dev/docs/latest/security (`docs/security.md`) | Pi asks no approval before tool calls |

## Source files read for behaviour the docs leave open

All in `@earendil-works/pi-coding-agent@1.6.0` (`dist/`), or its dependency
`@earendil-works/pi-agent-core@1.6.0`:

| File | Behaviour |
|---|---|
| `dist/modes/rpc/rpc-types.d.ts` | `RpcCommand`, `RpcResponse`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`: the types frames are checked against |
| `dist/modes/rpc/rpc-mode.js` | The `prompt` response is written once preflight succeeds; extension commands answer `handled` after they ran; the bridge's `session_start` status is written before any command is read |
| `dist/core/agent-session.js` | `steer` queues even when no run is active (`_queueUserInput`); `navigateTree` moves the leaf, and with a label persists it as a label entry; a prompt's user message is a text block followed by its images (1573–1582), and so is a steer's or follow-up's (1891–1910); the prompt's sections, the `--append-system-prompt` addendum among them, are persisted as a system message (825–830, 1394–1399); a `before_agent_start` system prompt is sent but not recorded |
| `dist/core/system-prompt.js` | `--append-system-prompt` becomes the `addendum` section (96–97) |
| `dist/core/session-manager.js` | A session file is written once it holds a user or assistant message (`_persist`, with an exclusive create); a missing `--session` path starts a new session there, and a file holding only a header reopens that session (`_setSessionFile`); `SessionManager.open` takes the cwd from the file's header (1347–1368) and keeps the file where it is, whatever `--session-dir` says; `--fork` copies every entry into the directory pi runs in; no session lock |
| `dist/main.js` | `--session <id>` that matches no session exits with an error; ids are looked up only in `--session-dir` when it is given; the runtime works in the session manager's cwd (772–776); `pi auth check` prints JSON and exits 0, 1 or 2 |
| `dist/cli/auth-check.js` | `ready`, `not_ready` and `invalid` (`invalid_state`) results |
| `pi-agent-core/dist/agent-loop.js` | Steers are handed to the model before its next response, also after a final answer; follow-ups run in the same agent run |
| `@earendil-works/pi-ai/dist/utils/retry.js` | The wording of quota and plan-limit errors |

## Types the tests check against

`test/drivers/pi/pi-types.ts` type-checks, with the TypeScript compiler,
every frame the driver sent (`RpcCommand | RpcExtensionUIResponse`), every
frame the fake sent (`RpcResponse | JsonAgentSessionEvent |
RpcExtensionUIRequest`, plus the RPC-only `extension_error` event that json.md
documents), every line of every session file the fakes wrote (`SessionHeader |
SessionEntry`), every user message among them as Pi builds it (Pi's user
message with block content, never a string, which Pi's own type would also
allow), and the bridge extension's source (`ExtensionAPI`), all from
`@earendil-works/pi-coding-agent@1.6.0`.

The fake appends every frame it reads or writes to a trace file
(`*.fake-pi-trace.ndjson`, in `FAKE_PI_TRACE_DIRECTORY` or its session
directory), so the frames of a fake without a puppet channel are checked too.
`conformance.test.ts`, `quirks.test.ts`, `capabilities.test.ts`,
`instructions.test.ts` and `availability.test.ts` run the check over every
frame of their runs.

