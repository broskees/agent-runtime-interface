# Changelog: `ari/drivers/codex`

## 0.1.0 (unreleased)

First version of the Codex driver.

- Runs `codex app-server` through the host's process service and speaks the
  app-server JSON-RPC protocol with a client generated from the protocol's
  JSON Schema, vendored at Codex tag `rust-v0.172.0` (commit
  `3d86e43b075adeba2193ec5c22ac92f55afd82e6`). Tested against Codex CLI
  `>=0.172.0 <0.173.0`; a newer `codex` gets an `untested_version` advisory.
- Runs the `codex` the user installed and never downloads, installs or updates
  one. A `codex` older than the minimum, 0.172.0 (the lower bound of the
  tested range), is refused: `status()` is `unavailable` with
  `driver_unavailable` and `openSession` rejects with it before any app-server
  starts, naming the version found, its path and the minimum. Update using
  your installation method, not a self-update command the old CLI might lack.
  Above the tested range a `codex` still runs, with an
  `untested_version` advisory.
- Threads: create, resume (with `session.replaced` when the thread is missing
  or held by another process; the replacement keeps that resume's launch
  context), snapshot, fork from a turn or into another directory, roll back,
  compact, inject history, unload, release. A thread runs in `createThread`'s
  `cwd`. New and forked threads get the host's tools through
  `launch.mcpServers` (forks get their source's); the host's per-thread
  server from `hostTools.mcpServerFor` is passed on resume. Codex offers no
  clean way to add it before a new thread's first turn; the driver docs say
  why.
- Runtime modes: the approvals reviewer is named on every start, resume, fork
  and per-turn policy, so `auto` (`auto_review`) and the other modes (`user`)
  reach Codex on every path.
- Turns: start, steer with `expectedTurnId` (`prompt_required` after the turn
  ended), interrupt (returns once Codex answered, after the turn aborted);
  settlement only on `turn/completed` or process exit; goal runs with
  `provider_initiated` turns Codex starts itself and the shared `ari.goal`
  extension, whose `get` still lists a finished run's turns; a host
  `turn/start` that Codex adds to its own goal turn returns
  `accepted: "steered"`.
- Requests: command, file-change and permission approvals with
  decision-derived native option ids, live structured questions, MCP
  elicitations, async questions as `message`-mode requests that survive a
  restart, dynamic tool calls through the host.
- Background terminals, subagent stop, MCP apps, feedback upload, limits and
  reset credits, native session listing with `x:codex.*` filters, the model
  catalog.
- Sign-in: ambient account via `codex login status`; managed profiles with an
  API key or ChatGPT tokens handed over through `auth.transferProfile`
  (format `codex.chatgpt_auth_tokens`); browser sign-in through the host's
  callbacks; device code.
- Extensions: `ari.goal`, `codex.goal`, `codex.review`, `codex.readState`,
  `codex.memory`, each version `1`.
