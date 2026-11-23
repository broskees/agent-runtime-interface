// Applying a reviewer verdict, or a full_access auto-reply, picks the
// narrowest matching option by real scope and never a wider one. (That no
// driver imports the reviewer is checked by the repository rule checker; see
// rule drivers-no-approval-reviewer in test/rules.test.ts.)

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Request, RequestOption } from "../../src/index.ts";
import { applyApprovalVerdict, fullAccessAutoReply, narrowestOption, reviewRequest } from "../../src/host/index.ts";
import type { ApprovalReviewer } from "../../src/host/index.ts";

function approval(options: RequestOption[], overrides: Partial<Request> = {}): Request {
  return {
    id: "request-1",
    native: { id: "n-request-1", strength: "strong" },
    kind: "command",
    origin: { threadId: "thread-1", turnId: "turn-1" },
    subject: { command: ["rm", "-rf", "build"] },
    options,
    allowCustomAnswer: false,
    allowFeedback: true,
    response: { mode: "live" },
    survivesRestart: false,
    status: "pending",
    ...overrides,
  };
}

const ALWAYS_PROJECT: RequestOption = { optionId: "always", label: "Always allow in this project", decision: "accept_always", scope: "project" };
const ONCE: RequestOption = { optionId: "once", label: "Allow once", decision: "accept", scope: "once" };
const SESSION: RequestOption = { optionId: "session", label: "Allow for session", decision: "accept_for_session", scope: "session" };
const REJECT_ALWAYS: RequestOption = { optionId: "reject-always", label: "Always deny", decision: "decline", scope: "project" };
const REJECT: RequestOption = { optionId: "reject", label: "Deny", decision: "decline", scope: "once" };

describe("approval reviewer", () => {
  test("a full_access auto-reply picks the once option over an accept_always of scope project", () => {
    const request = approval([ALWAYS_PROJECT, ONCE]);
    assert.deepEqual(fullAccessAutoReply(request, "auto-1"), { requestId: "request-1", responseKey: "auto-1", optionId: "once", scope: "once" });
  });

  test("a request that still reached the user under full access gets no auto-reply and no reviewer approval", () => {
    for (const fullAccessOverride of ["ask_rule", "provider_check", "x:vendor.policy"]) {
      const request = approval([ONCE, REJECT], { fullAccessOverride });
      assert.equal(fullAccessAutoReply(request, "auto-1"), undefined, fullAccessOverride);
      assert.equal(applyApprovalVerdict(request, { decision: "approve" }, "review-1"), undefined, fullAccessOverride);
      // Denying never widens anything, so a reviewer may still deny it.
      assert.equal(applyApprovalVerdict(request, { decision: "deny" }, "review-1")?.optionId, "reject");
    }
  });

  test("approve picks the narrowest accepting option whatever the order", () => {
    assert.equal(narrowestOption(approval([SESSION, ALWAYS_PROJECT]), "approve")?.optionId, "session");
    assert.equal(narrowestOption(approval([ALWAYS_PROJECT, SESSION, ONCE]), "approve")?.optionId, "once");
  });

  test("an option without a scope is ranked by its decision, and an unknown scope ranks widest", () => {
    const unscopedAlways: RequestOption = { optionId: "always", label: "Always", decision: "accept_always" };
    const unscopedSession: RequestOption = { optionId: "session", label: "Session", decision: "accept_for_session" };
    assert.equal(narrowestOption(approval([unscopedAlways, unscopedSession]), "approve")?.optionId, "session");
    const odd: RequestOption = { optionId: "odd", label: "Org-wide", decision: "accept", scope: "organization" };
    assert.equal(narrowestOption(approval([odd, ALWAYS_PROJECT]), "approve")?.optionId, "always");
  });

  test("maxScope caps an approval: no option within the cap means no auto-reply", () => {
    const request = approval([ALWAYS_PROJECT, REJECT]);
    assert.equal(applyApprovalVerdict(request, { decision: "approve", maxScope: "session" }, "k"), undefined);
    assert.equal(applyApprovalVerdict(request, { decision: "approve", maxScope: "project" }, "k")?.optionId, "always");
  });

  test("deny picks the narrowest declining option and passes the reason as feedback", () => {
    const request = approval([REJECT_ALWAYS, ONCE, REJECT]);
    assert.deepEqual(applyApprovalVerdict(request, { decision: "deny", reason: "outside the workspace" }, "k"), {
      requestId: "request-1",
      responseKey: "k",
      optionId: "reject",
      scope: "once",
      feedback: "outside the workspace",
    });
  });

  test("ask_user, a request that is not pending, or one with no matching option gets no reply", () => {
    assert.equal(applyApprovalVerdict(approval([ONCE]), { decision: "ask_user" }, "k"), undefined);
    assert.equal(applyApprovalVerdict(approval([ONCE], { status: "resolved" }), { decision: "approve" }, "k"), undefined);
    assert.equal(applyApprovalVerdict(approval([REJECT]), { decision: "approve" }, "k"), undefined);
    assert.equal(fullAccessAutoReply(approval([], { kind: "user_input", options: undefined }), "k"), undefined);
  });

  test("reviewRequest runs the hook and applies its verdict without widening", async () => {
    const seen: string[] = [];
    const reviewer: ApprovalReviewer = {
      review(request, context) {
        seen.push(`${request.id}:${context.policy?.mode ?? "none"}`);
        return Promise.resolve({ decision: "approve" });
      },
    };
    const outcome = await reviewRequest(reviewer, approval([ALWAYS_PROJECT, SESSION, ONCE]), { policy: { mode: "auto", interaction: "default", cwd: "/work" } }, "review-1");
    assert.deepEqual(seen, ["request-1:auto"]);
    assert.deepEqual(outcome.verdict, { decision: "approve" });
    assert.equal(outcome.response?.optionId, "once");
  });
});
