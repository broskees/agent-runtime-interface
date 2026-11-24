# Changelog: `ari/drivers/cursor`

## 0.1.0 (unreleased)

First release of the Cursor driver, tested against `@cursor/sdk` 1.4.2
(range `>=1.4.2 <1.5.0`; ari's optional peer range is `^1.4.2`).

- Runs Cursor's local agent through the Cursor TypeScript SDK inside the host's
  Node process (`sessionModel: "in_process"`). The SDK is loaded with a dynamic
  `import()` the first time an instance needs it; without it, `status()` is
  `unavailable` naming `@cursor/sdk` and `openSession` rejects with
  `driver_unavailable`.
- One SDK agent per thread, one run per turn. Agents live in a
  `JsonlLocalAgentStore` under the instance's state directory. Turns settle
  only when `run.wait()` resolves.
- Steer through `run.steer()` (`prompt_required` when Cursor answers
  `revert_to_followup`), Stop through `run.cancel()`, compaction through
  `agent.summarize()`, unload and release through `agent.close()` and
  `Agent.resume`.
- Runtime modes `read_only` (a tool allowlist of reading tools) and
  `full_access`; interaction modes `default` and `plan`.
- Items from Cursor's interaction updates (`send({ onDelta })`): messages,
  reasoning, tools, `createPlan` proposed plans streamed into `plan`,
  `updateTodos` todo lists and thread plans, `task` subagents with their
  lifecycle, and usage. Item ids come from positions in the run and the kind
  of item; turn ids from run ids; thread ids from agent ids.
- No fork, rollback, approvals, questions, snapshots, queue or extensions:
  those members are left out.
- Host instructions go at the top of the first prompt of a thread (and of a
  resumed thread); launch MCP servers go to `Agent.create` and `Agent.resume`,
  and the host's per-thread tool server to every run. A resume's MCP servers
  join the thread's and go with every later run.
- `resumeThread` opens only agents the instance created (recorded in
  `<stateDir>/cursor-created-agents.json`); another agent in the store is
  refused with `validation`, untouched. On a thread the session holds, a
  `read_only`/`full_access` change reopens the agent with its tools; another
  working directory, or a mode change while a run is going, is refused with
  `invalid_state`.
- Each turn sends with `local.force`, so an empty thread runs after a
  release, an unload, a closed session or a restart (Cursor's store reserves
  the first run for the handle that created the agent). The decision and the
  send run under a per-agent lock shared by the instance's sessions: while a
  run of the instance holds the agent or is being started on it, a turn is
  refused with `invalid_state`, so no live run is expired.
- An instance needs its state directory to itself: the first session takes
  `<stateDir>/cursor-instance.lock`, and a second instance there is refused
  with `invalid_state` (`state_dir_in_use`).
- A replacement agent for a lost thread gets every host instruction the
  thread was given, once, at the top of its first prompt.
- Cursor's tools inherit the host process's environment, which the SDK gives
  no way to change; `envPolicy` does not reach them (see the driver's docs,
  "Limits").
- Sign-in: a stored API key (`configured`), else the SDK's stored login,
  checked with `Cursor.me()`; `apiKey` is always passed, so an inherited
  `CURSOR_API_KEY` never signs in. 30-second runtime auth poison.
