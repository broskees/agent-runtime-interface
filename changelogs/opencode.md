# Changelog: `ari/drivers/opencode`

## Unreleased

- First version of the OpenCode driver, for OpenCode 1.x servers through
  `@opencode-ai/sdk` (tested with 1.19.6) and 2.x servers through
  `@opencode/client` (tested with 2.1.2), both optional peers loaded with a
  dynamic `import()`.
- Runs the `opencode` the user installed and never downloads, installs or
  updates one. An `opencode` older than its generation's minimum, 1.19.6 for
  1.x or 2.1.2 for 2.x (the lower bounds of the tested ranges), is refused:
  `status()` is `unavailable` with
  `driver_unavailable` and `openSession` and `catalog.list` reject with it
  before any local server starts, naming the version found, its path, the
  minimum and the update step, `opencode upgrade`. Above
  the tested ranges an `opencode` still runs, with an `untested_version`
  advisory.
- Chooses the runtime by the server's version: `opencode --version`, or an
  external server's `GET /api/info` (2.x) or `GET /global/health` (1.x).
- Session models: `process_per_thread` (1.x, one `opencode serve` per thread),
  `process_per_instance` (2.x, one per instance) and `external` with
  `externallyOwned: true` for a configured `serverUrl`, which the driver never
  stops.
- Every server the driver starts gets the instance's environment except the
  server-password variables, which the driver sets itself. The CLI manifest's
  terminal launch keeps the environment as it is: its `envScrubPrefixes` of
  an earlier build are gone.
- Runtime modes as native OpenCode session permission rules; each thread's
  host MCP entry under the host's name, and deny rules for every other
  thread's entry on a shared server, its tools and its resources alike, kept
  current in the thread's subagent sessions too. Threads share an identical
  entry of one name; a different server under a name another thread holds is
  refused (`mcp_name_conflict`). A closing session takes its entries off
  before the other threads stop denying them, and reports a removal OpenCode
  did not confirm. A thread that drops an entry another thread still holds is
  denied it from then on, with its subagents.
- A resume without a policy invents no mode. The session keeps the
  permission rules OpenCode saved for it, followed by the host's rules and
  the denies of other threads' entries; an earlier build wrote
  `approval_required` over them, so a saved deny could vanish and a saved
  allow could start asking.
- A resume with `purpose: "history"` writes nothing to the session (no
  rules, no MCP entries, no instructions), leaves the thread `unloaded` and
  never replaces a missing session. An earlier build gave it rules and MCP
  entries as an interactive resume does.
- On a shared 1.x server, "always" is offered only for a grant that cannot
  match an MCP resource (a file read's `*` can), because 1.x checks its
  in-memory grants after every session's own rules.
- "Always" approvals report `scope: "project"`; a full_access auto-reply
  picks "once". Under full_access a request says why it still came
  (`ask_rule`, `provider_check`), except a 1.x subagent's, which the
  auto-reply answers.
- History is read whole and oldest first (2.x pages of 200 with cursors), so
  snapshots, forks from a turn and rollbacks are right past OpenCode's first
  page. A 2.x fork of a thread with no messages is `invalid_state`
  (`empty_thread`).
- A resume reads the LaunchContext it brings, also for a thread the session
  holds; without one, the thread keeps its own.
- 2.x steering through OpenCode's inbox (`delivery: "steer"`,
  `resume: false`), with `prompt_required` for a steer that missed its turn.
- Subagents (child sessions) with their own threads, questions and forms as
  `user_input` requests, 1.x todo lists.
- The `opencode.permissionRules` extension (`get`, `set`).
