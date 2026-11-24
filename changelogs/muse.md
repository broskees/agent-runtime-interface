# Changelog: `ari/drivers/muse`

## 0.1.0 (unreleased)

First version of the Muse Code driver.

- Speaks the Muse Session Protocol with the `Connection` of `@muse-code/sdk`
  (optional peer `^1.4.25`, loaded with a dynamic `import()`), over `muse
  serve` processes the host spawns, one per thread. Tested against Muse Code
  and `@muse-code/sdk` `>=1.4.25 <1.4.26`; other versions get an
  `untested_version` advisory.
- Threads: create (`session/start` with the driver's session id), resume
  (`session/resume`, with `session.replaced` when the session is missing or
  another host holds it), snapshot (`session/read`), compact
  (`session/compact`), unload, release. Fork and rollback reject with
  `unsupported`.
- Turns: start, queue (`ifBusy: "queue"`), steer (`turn/steer` with
  `expectedTurnId`; a late steer is `prompt_required`), interrupt
  (`turn/interrupt`, `turn/unqueue` for a queued turn). Turns settle only on
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
