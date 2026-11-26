# Follow-ups from the ARI package build

Recorded 2026-11-25. Verifiers found these during the ARI package build
(checked against `main` at `c61f7f3`). None failed an acceptance criterion, and
Joe ruled them follow-ups. Each names where to look.

## Conformance kit: checks a wrong driver can still pass

- **A crash reported as a usage limit.** A forced process exit labelled as
  quota exhaustion passes `src/conformance/scenarios/turns.ts:203–208`, so a
  host could show a usage limit for a crash.
- **A lasting permission labelled `once`.** A persistent prefix permission
  labelled `once` passes `src/conformance/scenarios/requests.ts:50–70` and
  `:141–184`; neither checks the option's real reach.
- **Stub answers.** `src/conformance/scenarios/capabilities.ts:353–369` credits
  a background-task await that echoes its input ids without looking anything
  up, and `:653–659` cannot tell an always-undefined context window from a
  valid unknown answer.
- **Wrong results after real work.** The capability checks do not catch a
  `stopSubagent` that reports `completed` after a real cancellation, a
  `readSnapshot` missing every assistant item, or history injection that
  changes the assistant role and reports `consumed: false`
  (`capabilities.ts:399–439,526–548`).
- **The `idempotent-responses.full-access` check key.** Any harness can skip
  scenario 15's full-access branch with this key and a one-line reason, true
  or not (`requests.ts:142–149`, `src/conformance/context.ts:207–222`). It is
  justified for Codex; other harnesses should have to prove their reason.

## Drivers

- **Claude goals confirmed only in a system row.** A `/goal` whose only
  confirmation is a `system`/`local_command` transcript row is not recovered,
  because the pinned Agent SDK's `getSessionMessages` drops that row's content
  (`src/drivers/claude/session.ts:1870–1879`, `docs/drivers/claude.md`).
  Revisit when the SDK returns it.
- **Muse calls with no clock deadline.** If a live Muse host sends neither a
  reply nor a turn end, the first `turn/steer` send or a `turn/interrupt` waits
  forever (`src/drivers/muse/session.ts:627–631,735–738`). Every wait ends with
  the turn, but none has a wall-clock limit.

## Rust, Python and Go clients

- **No `turn.terminal` when the driver dies.** `docs/wire.md` says a client in
  another language should make a failed `turn.terminal` for each unsettled turn
  when the driver dies. The three clients end their streams with a transport
  error instead (`clients/rust/src/client.rs:317–326`,
  `clients/go/client.go:341–355`, the Python `_read_loop`). Nothing hangs.
- **No process delegation.** `initialize` hard-codes `process: false`
  (`client.rs:110`, `_client.py:91`, `client.go:100`), and no client can send
  `host/process.output`, `host/process.exit` or `host/config.changed`, so a
  remote or sandboxed host in these languages cannot delegate spawns.
- **Four framing departures from `docs/wire.md`.** None answers a non-JSON line
  with -32700 or a batch with -32600; a core method at another major version is
  reported as `core_method_missing`, not `core_method_version_mismatch`; the
  helper rule is not applied locally; and Rust answers undecodable host params
  with -32000, not -32602 (`client.rs:295`).
