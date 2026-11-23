// `ari/host`: the host toolkit. The event grammar validator, the event
// reducer, the request ledger, the capability guard and fallback planner, the
// optional approval reviewer and the replay recorder. Browser-safe: nothing
// reachable from here imports a Node built-in.

export {
  EVENT_GRAMMAR_RULES,
  EventGrammar,
  EventGrammarError,
  ITEM_REQUIRED_FIELDS,
  TERMINAL_ITEM_STATUSES,
  TURN_REQUIRED_FIELDS,
} from "./event-grammar.ts";
export type { EventGrammarMode, EventGrammarOptions, EventGrammarRule, EventGrammarViolation } from "./event-grammar.ts";

export { emptyReducedSession, reduceEvent, reduceEvents } from "./reducer.ts";
export type { ReducedSession } from "./reducer.ts";

export { RequestLedger } from "./request-ledger.ts";
export type { RequestLedgerOptions } from "./request-ledger.ts";

export { forkCapabilityPath, forkChangesDirectory, guardSession, startTurnCapabilityPath } from "./capability-guard.ts";

export { planFallback } from "./fallback-planner.ts";
export type { FallbackPlan, FallbackRequest, FallbackStep } from "./fallback-planner.ts";

export {
  APPROVAL_SCOPE_ORDER,
  applyApprovalVerdict,
  fullAccessAutoReply,
  narrowestOption,
  reviewRequest,
  scopeRank,
} from "./approval-reviewer.ts";
export type { ApprovalReviewContext, ApprovalReviewer, ApprovalVerdict } from "./approval-reviewer.ts";

export { ReplayRecorder, fixtureEvents, parseFixture, replayEvents, serializeFixture } from "./replay-recorder.ts";
export type { ReplayRecorderOptions } from "./replay-recorder.ts";

export * from "../generated/fixture.ts";
