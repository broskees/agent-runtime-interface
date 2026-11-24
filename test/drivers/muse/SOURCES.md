# Protocol sources of the fake Muse Code CLI

The fake in `fake-muse.ts` speaks the Muse Session Protocol (MSP) of Muse Code
1.4.25. The driver talks to it through the real SDK `Connection` of the pinned
devDependency.

| Source | URL or path | Pinned at |
|---|---|---|
| The Muse SDK (the driver's optional peer, a devDependency for types and tests). Its bundled wire types `dist/src/msp.d.ts` type every frame the fake builds, and `frames.ts` type-checks every frame the fake and the driver exchanged in every test against them; `dist/src/connection/connection.{d.ts,js}` is the `Connection` the driver runs | https://www.npmjs.com/package/@muse-code/sdk, `node_modules/@muse-code/sdk` | `@muse-code/sdk` `1.4.25` (`package.json` devDependency `"1.4.25"`; integrity `sha512-S4SLkixE7u1AHyNAlBYBMYg4tGGl6nsvwlm7eGA1ZBIzkqpagC9uuxUs6MXnVKs2L2O/LXhKcYMkmXkxwSDxWw==` as `pnpm-lock.yaml` records it) |
| The SDK's source repository at its 1.4.25 mirror commit: the stable MSP schema bundle and the golden wire transcripts the fake's frame order follows (`session-start`, `text-run-single-turn`, `approval-round-trip`, `approval-deny-round-trip`, `userinput-answer-round-trip`, `cancel-mid-turn`, `provider-failure-turn`, `compact-command-round-trip`, `compact-command-noop`, `pending-command-ack-reject`, `turn-interrupt-queued-successor`, `model-round-trip`, `resume-after-cursor`) | https://github.com/meta-models/muse-code-sdk/tree/e6ef4a64473d/schema/msp (`stable/msp.schema.json`, `transcripts/`) | commit `e6ef4a64473d` ("remirror: 1.4.25 from the internal source tree"), 2026-11-21 |
| MSP guides: one host per process and connection, the writer lease and `sessionInUse`, turn lifecycle and terminals, the two stop lanes, closing stdin as an orderly drain | https://meta-models.github.io/muse-code-sdk/1.4/guides/msp-concepts/sessions-and-turns/ | docs for Muse Code 1.4, generated from commit `277a7fe7b7a0138f86e86ee242b96cdde25dfe2b` |
| Commands and idempotency: client-minted `commandId`, a fresh turn's id is its `turn/start` `commandId`, a queued submit's id is minted at admission, payload identity, `commandRejected` reasons | https://meta-models.github.io/muse-code-sdk/1.4/guides/msp-concepts/commands-and-idempotency/ | same docs |
| `turn/steer`: "an id that is not the running turn is refused" | https://meta-models.github.io/muse-code-sdk/1.4/generated/msp/methods/turn-steer/ | same docs |
| The error table (codes and kinds, for example -32020 `sessionNotFound`, -32021 `sessionInUse`, -32030 `commandRejected`, -32050 to -32057 for approvals and questions) | `schema/msp/stable/msp.schema.json` `errors` at the commit above | commit `e6ef4a64473d` |
| Steer refusals: a finished turn's steer is -32030 `commandRejected` with reason `already_terminal` (the test "a durably rejected steer retires to the composer"); the busy session runtime refuses `turn/start` and `turn/steer` with a retryable `commandRejected`, reason `runtime_busy` | `clients/sdk-ts/test/facade-control-verbs.test.ts` lines 191-202 and `CHANGELOG.md` line 542 at the commit above; the installed SDK's `dist/src/facade/run.js` (a busy refusal "wrote nothing" and is resent under its first `commandId`) | commit `e6ef4a64473d`; `@muse-code/sdk` `1.4.25` |
| Requests outstanding at a resume: listed in `pendingRequests` and re-issued as server requests right after the `session/resume` answer, never by `session/read`; `lastTurn` on both answers restates the last `turn/completed` | the installed SDK's `README.md` lines 112-128 ("An approval still pending when you resume a session arrives right after the resume reply") and `dist/src/msp.d.ts` (`PendingRequestPointer`, `LastTurn`, `SessionResumeResult`, `SessionReadResult`, `ApprovalChange` `restartRecovered`); the `userinput-answer-round-trip` transcript lines 6-9 | `@muse-code/sdk` `1.4.25`; commit `e6ef4a64473d` |
| A public MIT-licensed host's Muse adapter (`provider-muse`), read for protocol knowledge only: `muse serve` flags (`--disable-sandbox` under full access), the approval mode and permission profile it selects per runtime mode (`allowAll` / `:unrestricted`, `promptUnmatched` / `:ask-me`), `META_API_KEY` as Muse's key variable, `MUSE_NO_AUTO_UPDATE`, and "MSP has no auth signal". No file or name of theirs is copied. The repository and URL are in docs/drivers/muse.md (this repository's rules keep host names out of `test/`) | `packages/provider-muse/src/server/{sdk,adapter,driver,status}.ts` of that repository | commit `be6ff17f5171c8a55969ec74af46ff1d86666c3a` |

## What the fake decides where the sources are silent

- **Steer refusal.** A steer whose `expectedTurnId` is not the running turn
  gets -32030 `commandRejected` with reason `already_terminal`, as the SDK's
  own test answers a finished turn's steer. That test is a fixture, not a
  promise about every stale steer; the fake uses it for every one. When a
  test sets `refuseSteer`, the session runtime refuses a steer of the running
  turn with the reason and retryability it returns, for example
  `runtime_busy`, and writes nothing. When the runtime is busy is not public,
  so the fake is busy only when a test says so.
- **Parked sessions.** `parkedSession` stores a session that no host holds
  whose turn waits on one question or approval, the state the
  `userinput-answer-round-trip` transcript resumes. A real host reaches it
  when it recovers a pending request after a restart under the same id
  (`ApprovalChange` `restartRecovered`); the fake does not model the other
  recovery (resolve `abort`, ask again under a new id). The host that resumes
  it takes the turn and re-issues the request after its answer.
- **Approvals under `allowAll`.** Which calls Muse's policy settles without
  asking is not public. The fake asks whenever the conformance kit's puppet
  asks, in every approval mode.
- **Ids.** The fake mints UUIDv7-shaped ids from a counter per rig, so two rigs
  that do the same things get the same ids.
- **Host death.** A killed or crashed fake host writes nothing; its sessions'
  running turns are over and their leases are free, as an OS-released lease
  is. The fake does not synthesize the `crash` terminal a real host writes on
  the next resume.
