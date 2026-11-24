# Changelog: `ari/drivers/pi`

## Unreleased

First version of the Pi driver, tested against `@earendil-works/pi-coding-agent`
1.6.0 (`pi` `>=1.6.0 <2.0.0`).

- Runs the user's own `pi` in RPC mode (`pi --mode rpc`), found through the
  host's `process.resolveExecutable`, one process per thread, with session
  files under the instance's state directory.
- Loads the ARI bridge extension into every Pi process: tool calls gated by
  the ARI runtime mode (`read_only`, `approval_required`,
  `auto_accept_edits`, `full_access`), Pi's working directory reported back,
  and the `/ari-mcp`, `/ari-rewind`, `/ari-context` and `/ari-persist`
  commands.
- Threads: create, resume (`--session`, in the directory the session file
  records, with `session.replaced` when Pi cannot resume), read snapshot,
  fork at latest or from a turn (`pi --fork`, also into another directory),
  roll back (persisted in the session file), compact, unload, release. A
  thread without messages comes back as itself after unload or release: the
  bridge writes Pi's header before the process stops, and every restart
  checks Pi's session id.
- Resumes only session files really inside the instance's state directory
  (symbolic links followed), so host instructions are never written into a
  session the user's own pi keeps. A resume by session id finds the file
  itself and gives Pi the path, so it works from any directory without Pi's
  fork question.
- Turns: start, steer (with `prompt_required` when Pi queued the steer after
  the run ended), interrupt; settlement only on `agent_settled` or process
  exit.
- Requests: the bridge's approvals with native option ids; other extensions'
  `select`, `confirm`, `input` and `editor` dialogs as questions.
- Host instructions through the system prompt (`--append-system-prompt`, and
  per run through the bridge); host MCP servers registered under the host's
  names.
- Sign-in: a stored API key (`configured`), or Pi's own `pi auth check`
  for the ambient account; runtime auth poison per scope.
- `ari/meta/pi`: label, icon, config schema and form hints.
