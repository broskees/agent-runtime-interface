# Changelog: `ari/drivers/codex`

## 0.1.0 (unreleased)

First version of the Codex driver.

- Runs `codex app-server` through the host's process service and speaks the
  app-server JSON-RPC protocol with a client generated from the protocol's
  JSON Schema, vendored at Codex tag `rust-v0.172.0` (commit
  `3d86e43b075adeba2193ec5c22ac92f55afd82e6`). Tested against Codex CLI
  `>=0.172.0 <0.173.0`; other versions get an `untested_version` advisory.
- Threads: create, resume (with `session.replaced` when the thread is missing
  or held by another process), snapshot, fork from a turn or into another
  directory, roll back, compact, inject history, unload, release.
- Turns: start, steer with `expectedTurnId` (`prompt_required` after the turn
  ended), interrupt; settlement only on `turn/completed` or process exit; goal
  runs with `provider_initiated` turns and the shared `ari.goal` extension.
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
