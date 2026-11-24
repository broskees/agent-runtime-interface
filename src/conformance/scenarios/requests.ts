// Scenarios 8 and 15: how native approvals are classified, and how responses
// to them behave.

import type { ScenarioContext } from "../context.ts";
import { hasCapability } from "../../capabilities.ts";
import type { Request } from "../../generated/request.ts";
import type { RespondInput } from "../../generated/session.ts";
import { fullAccessAutoReply } from "../../host/approval-reviewer.ts";
import { brief } from "../util.ts";
import { describeError } from "./sessions.ts";
import { APPROVAL_REQUEST_KINDS, approval, approvalKind, nativeOptionId, pendingRequestOffering, supervisedMode } from "./scenario.ts";
import type { Scenario } from "./scenario.ts";

const ACCEPTING = new Set(["accept", "accept_for_session", "accept_always"]);
const DECLINING = new Set(["decline", "cancel"]);

export const duplicateAlwaysScenario: Scenario = {
  id: 8,
  key: "duplicate-always-options",
  title: "A native approval with two accept_always options is classified as an approval, not a question",
  async run(context: ScenarioContext) {
    const rig = await context.rig();
    const created = await context.instance(rig);
    const opened = await context.openSession(created);
    const capabilities = opened.capabilities();
    const kind = approvalKind(context, capabilities);
    context.requireCapability(capabilities, "requests.responseModes", "live");
    const mode = supervisedMode(capabilities);
    if (mode === undefined) context.requireCapability(capabilities, "runtimePolicy.modes.approval_required");
    const thread = await context.createThread(opened, { mode });

    const { turnId, native } = await context.beginTurn(opened, rig, thread.id, "Check the repository status.");
    const handle = await context.wait(
      native.requestApproval(
        approval(kind, [
          { optionId: "allow-session", label: "Allow for this session", decision: "accept_always" },
          { optionId: "allow-prefix", label: "Always allow commands that start with git status", decision: "accept_always" },
          { optionId: "reject", label: "Reject", decision: "decline" },
        ]),
      ),
      "the native agent to ask for an approval",
    );
    const request = await context.until(() => {
      for (const candidate of context.reduced(opened).requests.values()) {
        if (candidate.status === "pending" && candidate.origin.threadId === thread.id) return candidate;
      }
      return undefined;
    }, "a pending request for the native approval");

    context.check(
      APPROVAL_REQUEST_KINDS.has(request.kind),
      `an approval whose options are two accept_always and a decline was classified as a ${brief(request.kind)} request; expected an approval kind (${[...APPROVAL_REQUEST_KINDS].join(", ")})`,
    );
    context.check((request.questions ?? []).length === 0, `the approval was turned into questions: ${brief(request.questions)}`);
    const options = request.options ?? [];
    for (const [kitOptionId, accepting] of [
      ["allow-session", true],
      ["allow-prefix", true],
      ["reject", false],
    ] as const) {
      const optionId = nativeOptionId(handle, kitOptionId);
      const option = options.find((candidate) => candidate.optionId === optionId);
      context.check(option !== undefined, `the request lost native option ${optionId}; options are ${brief(options)}`);
      const expected = accepting ? ACCEPTING : DECLINING;
      context.check(expected.has(option.decision), `native option ${optionId} has decision ${brief(option.decision)}; expected one of ${[...expected].join(", ")}`);
    }

    // The second of the two accept_always options, so a driver that answers by decision alone sends the wrong one.
    await context.wait(opened.session.respond({ requestId: request.id, responseKey: "duplicate-always-1", optionId: nativeOptionId(handle, "allow-prefix") }), "respond");
    const reply = await context.wait(handle.nextReply(), "the native agent to get the reply");
    context.check(reply === "allow-prefix", `the provider got option ${brief(reply)}; the host chose "allow-prefix"`);
    await context.wait(native.complete(), "the native agent to complete the turn");
    await context.terminal(opened, turnId);
  },
};

export const idempotentResponsesScenario: Scenario = {
  id: 15,
  key: "idempotent-responses",
  title: "Responses are idempotent by (requestId, responseKey), and a full_access auto-reply picks the narrowest accepting option",
  async run(context: ScenarioContext) {
    const rig = await context.rig();
    const created = await context.instance(rig);
    const opened = await context.openSession(created);
    const capabilities = opened.capabilities();
    const kind = approvalKind(context, capabilities);
    context.requireCapability(capabilities, "requests.responseModes", "live");
    const mode = supervisedMode(capabilities);
    if (mode === undefined) context.requireCapability(capabilities, "runtimePolicy.modes.approval_required");

    // The same (requestId, responseKey) reaches the provider once and returns the same result.
    const thread = await context.createThread(opened, { mode });
    const first = await context.beginTurn(opened, rig, thread.id, "Run the build.");
    const handle = await context.wait(
      first.native.requestApproval(
        approval(kind, [
          { optionId: "approve-once", label: "Allow once", decision: "accept" },
          { optionId: "reject", label: "Reject", decision: "decline" },
        ]),
      ),
      "the native agent to ask for an approval",
    );
    const request = await pendingRequestOffering(context, opened, nativeOptionId(handle, "approve-once"));
    const input: RespondInput = { requestId: request.id, responseKey: "idempotent-1", optionId: nativeOptionId(handle, "approve-once") };
    const outcomes = await Promise.allSettled([
      context.wait(opened.session.respond(input), "the first respond"),
      context.wait(opened.session.respond({ ...input }), "a concurrent respond with the same key"),
    ]);
    outcomes.push(...(await Promise.allSettled([context.wait(opened.session.respond({ ...input }), "a later respond with the same key")])));
    const described = outcomes.map((outcome) => (outcome.status === "fulfilled" ? `resolved ${brief(outcome.value ?? null)}` : `rejected ${describeError(outcome.reason)}`));
    context.check(
      outcomes[0]!.status === "fulfilled" && described.every((text) => text === described[0]),
      `three responses with the same (requestId, responseKey) had different outcomes: ${described.join("; ")}`,
    );
    const reply = await context.wait(handle.nextReply(), "the native agent to get the reply");
    context.check(reply === "approve-once", `the provider got option ${brief(reply)}; the host chose "approve-once"`);

    // Another request in the same session answered with the same responseKey is another pair: it reaches the provider too.
    const againHandle = await context.wait(
      first.native.requestApproval(
        approval(kind, [
          { optionId: "approve-again", label: "Allow once", decision: "accept" },
          { optionId: "reject-again", label: "Reject", decision: "decline" },
        ]),
      ),
      "the native agent to ask for a second approval",
    );
    const again = await pendingRequestOffering(context, opened, nativeOptionId(againHandle, "approve-again"));
    context.check(again.id !== request.id, `the second native approval reached the host as the first request ${request.id}`);
    await context.wait(
      opened.session.respond({ requestId: again.id, responseKey: input.responseKey, optionId: nativeOptionId(againHandle, "approve-again") }),
      `a respond to a second request with the same responseKey "${input.responseKey}"`,
    );
    const againReply = await context.wait(againHandle.nextReply(), `the native agent to get the reply to a second request answered with the same responseKey "${input.responseKey}"`);
    context.check(againReply === "approve-again", `the provider got option ${brief(againReply)} for the second request; the host chose "approve-again"`);
    await context.wait(first.native.complete(), "the native agent to complete the turn");
    await context.terminal(opened, first.turnId);
    const replies = await context.wait(handle.replies(), "the native agent's replies");
    context.check(replies.length === 1, `three responses with one (requestId, responseKey) reached the provider ${replies.length} times: ${brief(replies)}`);
    await opened.close();

    // Under full_access, the reply that goes out is the narrowest accepting option.
    if (!hasCapability(capabilities, "runtimePolicy.modes.full_access")) {
      context.note("the full_access auto-reply was not checked: the driver declares runtimePolicy.modes.full_access off");
      return;
    }
    const fullAccess = await context.openSession(created);
    const fullThread = await context.createThread(fullAccess, { mode: "full_access" });
    const second = await context.beginTurn(fullAccess, rig, fullThread.id, "Deploy the site.");
    const fullHandle = await context.wait(
      second.native.requestApproval(
        approval(kind, [
          { optionId: "approve-always", label: "Always allow", decision: "accept_always" },
          { optionId: "approve-once", label: "Allow once", decision: "accept" },
          { optionId: "reject", label: "Reject", decision: "decline" },
        ]),
      ),
      "the native agent to ask for an approval under full_access",
    );
    let driverReply: string | undefined;
    void fullHandle.nextReply().then((optionId) => {
      driverReply = optionId;
    });
    const outcome = await context.until((): { by: "driver"; optionId: string } | { by: "host"; request: Request } | undefined => {
      if (driverReply !== undefined) return { by: "driver", optionId: driverReply };
      for (const candidate of context.reduced(fullAccess).requests.values()) {
        if (candidate.status === "pending" && (candidate.options ?? []).some((option) => option.optionId === nativeOptionId(fullHandle, "approve-once"))) return { by: "host", request: candidate };
      }
      return undefined;
    }, "the driver to answer the full_access approval or hand it to the host");

    if (outcome.by === "driver") {
      context.check(outcome.optionId === "approve-once", `under full_access the driver answered with ${brief(outcome.optionId)}; the narrowest accepting option is "approve-once"`);
      context.note("the driver answered the full_access approval itself");
    } else {
      const autoReply = fullAccessAutoReply(outcome.request, "full-access-1");
      context.check(autoReply !== undefined, `the host found no accepting option to auto-reply with in ${brief(outcome.request.options)}`);
      context.check(
        autoReply.optionId === nativeOptionId(fullHandle, "approve-once"),
        `by the scopes the driver reported (${brief(outcome.request.options)}), the narrowest accepting option is ${brief(autoReply.optionId)}; the provider's narrowest is ${brief(nativeOptionId(fullHandle, "approve-once"))}`,
      );
      await context.wait(fullAccess.session.respond(autoReply), "respond with the full_access auto-reply");
      const sent = await context.wait(fullHandle.nextReply(), "the native agent to get the reply");
      context.check(sent === "approve-once", `the host auto-replied "approve-once" and the provider got ${brief(sent)}: the driver widened the reply`);
      context.note("the driver handed the full_access approval to the host, which auto-replied");
    }
    await context.wait(second.native.complete(), "the native agent to complete the turn");
    await context.terminal(fullAccess, second.turnId);
  },
};
