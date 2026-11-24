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
  and the host's per-thread tool server to every run.
- Sign-in: a stored API key (`configured`), else the SDK's stored login,
  checked with `Cursor.me()`; `apiKey` is always passed, so an inherited
  `CURSOR_API_KEY` never signs in. 30-second runtime auth poison.
