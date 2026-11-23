// The optional host-side approval reviewer. Where a provider has no native
// "auto" classifier, a host may review each approval request itself (an LLM
// judge, a restrict-only repository policy, an audit log). The reviewer lives
// in the host toolkit only: no driver may import this module, and the repository
// rule checker fails when a file under src/drivers/ reaches it.
//
// Applying a verdict never widens permissions. The helper picks, among the
// request's own options, the narrowest one that matches the verdict by the
// option's real scope: `once` before `session` before `project` before
// `global`. An option without a `scope` is ranked by its decision (`accept`
// and `decline` as `once`, `accept_for_session` as `session`, anything else as
// `global`), and an unknown scope ranks after `global`. A `full_access`
// auto-reply is an approve verdict, so it too takes the narrowest accepting
// option.
//
// A request that carries `fullAccessOverride` (for example `ask_rule` or
// `provider_check`, or any other value) is one the provider says must reach
// the user even under `full_access`. Neither a `full_access` auto-reply nor a
// reviewer's approval answers it; a reviewer may still deny it, because a
// denial never widens anything.

import type { RuntimePolicy } from "../generated/config.ts";
import type { ApprovalScope, Request, RequestOption } from "../generated/request.ts";
import type { RespondInput } from "../generated/session.ts";

/** What a reviewer decided about one request. */
export type ApprovalVerdict =
  /** Approve. `maxScope` caps how far the approval may reach; without it, the narrowest accepting option is used. */
  | { readonly decision: "approve"; readonly maxScope?: ApprovalScope; readonly reason?: string }
  | { readonly decision: "deny"; readonly reason?: string }
  /** Leave the request to the user. */
  | { readonly decision: "ask_user"; readonly reason?: string };

export interface ApprovalReviewContext {
  readonly policy?: RuntimePolicy;
}

/** A host-side reviewer of approval requests. Optional; never part of a driver. */
export interface ApprovalReviewer {
  review(request: Request, context: ApprovalReviewContext): ApprovalVerdict | Promise<ApprovalVerdict>;
}

/** Approval scopes from narrowest to widest. */
export const APPROVAL_SCOPE_ORDER: readonly ApprovalScope[] = ["once", "session", "project", "global"];

const ACCEPT_DECISIONS: ReadonlySet<string> = new Set(["accept", "accept_for_session", "accept_always"]);
const DECLINE_DECISIONS: ReadonlySet<string> = new Set(["decline", "cancel"]);

/** The rank of an option's reach: 0 for `once` up to 3 for `global`, 4 for an unknown scope. */
export function scopeRank(option: Pick<RequestOption, "decision" | "scope">): number {
  const rank = APPROVAL_SCOPE_ORDER.indexOf(option.scope ?? scopeImpliedByDecision(option.decision));
  return rank === -1 ? APPROVAL_SCOPE_ORDER.length : rank;
}

/** The reach assumed for an option that does not state its scope. Unknown decisions are assumed to reach furthest. */
function scopeImpliedByDecision(decision: RequestOption["decision"]): ApprovalScope {
  if (decision === "accept" || decision === "decline") return "once";
  if (decision === "accept_for_session") return "session";
  return "global";
}

/**
 * The narrowest option of `request` whose decision is an accept (`approve`) or
 * a decline (`deny`), or undefined when there is none. For `approve`, an
 * option wider than `maxScope` is never chosen. Among options of equal reach,
 * `decline` is preferred to `cancel`, and otherwise the request's order wins.
 */
export function narrowestOption(
  request: Pick<Request, "options">,
  decision: "approve" | "deny",
  maxScope?: ApprovalScope,
): RequestOption | undefined {
  const wanted = decision === "approve" ? ACCEPT_DECISIONS : DECLINE_DECISIONS;
  const cap = maxScope === undefined ? Number.POSITIVE_INFINITY : scopeRank({ decision: "accept", scope: maxScope });
  let best: RequestOption | undefined;
  for (const option of request.options ?? []) {
    if (!wanted.has(option.decision)) continue;
    const rank = scopeRank(option);
    if (decision === "approve" && rank > cap) continue;
    if (best === undefined) {
      best = option;
      continue;
    }
    const bestRank = scopeRank(best);
    if (rank < bestRank || (rank === bestRank && option.decision === "decline" && best.decision === "cancel")) best = option;
  }
  return best;
}

/**
 * Applies a verdict to a pending request: the `respond` input that answers it
 * with the narrowest matching option, or undefined when the request is not
 * pending, the verdict is `ask_user`, no option matches, or the verdict
 * approves a request that carries `fullAccessOverride` (it must reach the
 * user). Send the result through the request ledger.
 */
export function applyApprovalVerdict(request: Request, verdict: ApprovalVerdict, responseKey: string): RespondInput | undefined {
  if (request.status !== "pending" || verdict.decision === "ask_user") return undefined;
  if (verdict.decision === "approve" && request.fullAccessOverride !== undefined && request.fullAccessOverride !== null) return undefined;
  const option =
    verdict.decision === "approve" ? narrowestOption(request, "approve", verdict.maxScope) : narrowestOption(request, "deny");
  if (option === undefined) return undefined;
  const input: RespondInput = { requestId: request.id, responseKey, optionId: option.optionId };
  if (option.scope !== undefined) input.scope = option.scope;
  // A deny tells the agent why, when the request takes feedback.
  if (verdict.decision === "deny" && verdict.reason !== undefined && request.allowFeedback) input.feedback = verdict.reason;
  return input;
}

/**
 * The auto-reply a host sends under a `full_access` policy: the narrowest
 * accepting option. Undefined for a request that carries `fullAccessOverride`,
 * which must reach the user.
 */
export function fullAccessAutoReply(request: Request, responseKey: string): RespondInput | undefined {
  return applyApprovalVerdict(request, { decision: "approve" }, responseKey);
}

/** Runs `reviewer` on a pending request and applies its verdict. */
export async function reviewRequest(
  reviewer: ApprovalReviewer,
  request: Request,
  context: ApprovalReviewContext,
  responseKey: string,
): Promise<{ verdict: ApprovalVerdict; response: RespondInput | undefined }> {
  const verdict = await reviewer.review(request, context);
  return { verdict, response: applyApprovalVerdict(request, verdict, responseKey) };
}
