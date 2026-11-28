# Changelog: `ari/drivers/muse`

## 0.1.0 (unreleased)

First version of the Muse Code driver.

- Speaks the Muse Session Protocol with the `Connection` of `@muse-code/sdk`
  (optional peer `^1.4.25`, loaded with a dynamic `import()`), over `muse
  serve` processes the host spawns, one per thread. Tested against Muse Code
  and `@muse-code/sdk` `>=1.4.25 <1.4.26`; an SDK outside it, or a newer
  `muse`, gets an `untested_version` advisory.
- Runs the `muse` the user installed and never downloads, installs or updates
  one. A `muse` older than the minimum, 1.4.25 (the lower bound of the tested
  range), is refused: `status()` is `unavailable` with `driver_unavailable`
  and `openSession` rejects with it before any `muse serve` starts, naming the
  version found, its path, the minimum and the update step, running Muse
  Code's installer again (`curl -fsSL https://dev.meta.ai/install.sh | bash`).
  Above the tested range a `muse` still runs, with an `untested_version`
  advisory.
- Threads: create (`session/start` with the driver's session id), resume
  (`session/resume`, with `session.replaced` when the session is missing or
  another host holds it; the running turn and the requests Muse re-issues
  after the answer are adopted; a new `launch` on a loaded thread reloads it
  with its MCP servers), snapshot (`session/read`; the last turn's status and
  failure from Muse's `lastTurn`), compact (`session/compact`), unload,
  release. Fork and rollback reject with `unsupported`.
- A resume with `purpose: "history"` checks the session with `session/read`
  (no lease) and loads nothing; the thread stays `unloaded`, and a missing
  session is `not_found`. An earlier build loaded the session as an
  interactive resume does.
- A resume of a loaded thread applies a new model with `session/setModel`
  and refuses another runtime mode with `unsupported`; an earlier build
  ignored both and reported success.
- A `reasoningEffort` the driver does not list goes to Muse in `turn/start`
  as given, and `planConfigChange` plans it for the next turn; an earlier
  build refused it with `validation` before Muse saw it.
- Turns: start, queue (`ifBusy: "queue"`), steer (`turn/steer` with
  `expectedTurnId`; a steer whose turn already ended, `already_terminal`, is
  `prompt_required`; a steer the busy runtime refuses, `runtime_busy`, is sent
  again under its `commandId` until Muse takes it or the turn ends, for at
  most 30 s; any other refusal is `invalid_state` with Muse's reason; the
  turn's end settles a steer whose answer has not come, and a late answer
  that says Muse took it is a `muse.steer_taken_late` notice), interrupt
  (`turn/interrupt`, `turn/unqueue` for a queued turn, sent again while the
  runtime is busy, under the same bounds). Turns settle only on
  `turn/completed`, `turn/unqueued` or the host's exit.
- Requests: approvals answered with `approval/decide` and Muse's own choice
  ids, questions answered with `userInput/answer`; approvals from subagents.
- Items, subagents, the todo list (`plan.upsert`), token and context usage
  (`usage.updated`) and subscription usage (`limits.updated`,
  `limits.current`).
- Host instructions through `first_user_message`; host tool servers in
  `config.mcpServers` under the host's names; no file written.
- Accounts: a managed Meta API key passed as `META_API_KEY`, or the user's own
  `muse login` (state `unknown`: MSP has no sign-in check); a runtime auth
  poison per scope.
- Every `muse` process gets the instance's environment, an inherited
  `META_API_KEY` included, minus only the host's `envPolicy.stripAmbient`; a
  managed key wins over it. `MUSE_CREDENTIAL_VARIABLES` and the CLI
  manifest's `envScrubPrefixes` are gone.
- A policy without a mode sends no `approvalMode`, `permissionProfile` or
  `--disable-sandbox`, and a resume calls no `session/setApprovalMode`. The
  thread's `effectiveMode` is the approval mode Muse reports, in Muse's own
  words: Muse does not report the permission profile that decides who
  answers, so ARI maps none of them.
