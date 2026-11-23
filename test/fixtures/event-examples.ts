// One valid body per event variant (all 19), with the name of a required
// field whose removal makes the body invalid. Later suites (for example the
// Effect schema cross-check) reuse these 19 valid and 19 invalid examples.

import * as ari from "../../src/index.ts";
import type { AriEvent, AriEventBody, Validator } from "../../src/index.ts";
import { fullCapabilities } from "./capabilities.ts";

export interface EventBodyExample {
  /** The `type` of the body, or `x:` for the extension variant. */
  readonly variant: string;
  /** The validator for this variant alone. */
  readonly validator: Validator<unknown>;
  readonly body: AriEventBody;
  /** A required field (other than `type`) that the invalid example omits. */
  readonly requiredField: string;
}

const native = { id: "native-1", strength: "strong" } as const;

export const EVENT_BODY_EXAMPLES: readonly EventBodyExample[] = [
  {
    variant: "session.state",
    validator: ari.SessionStateBodySchema,
    body: { type: "session.state", state: "ready" },
    requiredField: "state",
  },
  {
    variant: "session.replaced",
    validator: ari.SessionReplacedBodySchema,
    body: { type: "session.replaced", previousNativeId: "old-1", reason: "native session locked", contextLost: true },
    requiredField: "contextLost",
  },
  {
    variant: "capabilities.updated",
    validator: ari.CapabilitiesUpdatedBodySchema,
    body: { type: "capabilities.updated", capabilities: fullCapabilities() },
    requiredField: "capabilities",
  },
  {
    variant: "config.updated",
    validator: ari.ConfigUpdatedBodySchema,
    body: {
      type: "config.updated",
      options: [
        {
          id: "model",
          category: "model",
          label: "Model",
          type: "select",
          values: [{ id: "fast", label: "Fast" }],
          current: "fast",
          scope: "thread",
          dependsOn: ["provider"],
          changeEffect: "next_turn",
        },
      ],
    },
    requiredField: "options",
  },
  {
    variant: "commands.updated",
    validator: ari.CommandsUpdatedBodySchema,
    body: { type: "commands.updated", commands: [{ name: "review", description: "Review changes" }], skills: [{ name: "lint" }] },
    requiredField: "commands",
  },
  {
    variant: "thread.upsert",
    validator: ari.ThreadUpsertBodySchema,
    body: {
      type: "thread.upsert",
      thread: { id: "thread-1", native, cwd: "/work/repo", status: "idle", title: null },
      retainedNativeTurnIds: ["nt-1"],
    },
    requiredField: "thread",
  },
  {
    variant: "turn.upsert",
    validator: ari.TurnUpsertBodySchema,
    body: { type: "turn.upsert", turn: { id: "turn-1", threadId: "thread-1", native, origin: "user", status: "running" } },
    requiredField: "turn",
  },
  {
    variant: "item.upsert",
    validator: ari.ItemUpsertBodySchema,
    body: { type: "item.upsert", item: { id: "item-1", kind: "assistant_message", native, status: "running", text: "" } },
    requiredField: "item",
  },
  {
    variant: "item.delta",
    validator: ari.ItemDeltaBodySchema,
    body: { type: "item.delta", itemId: "item-1", field: "text", chunk: "Hel" },
    requiredField: "chunk",
  },
  {
    variant: "request.upsert",
    validator: ari.RequestUpsertBodySchema,
    body: {
      type: "request.upsert",
      request: {
        id: "request-1",
        native,
        kind: "command",
        origin: { threadId: "thread-1", turnId: "turn-1" },
        subject: { command: ["git", "push"], cwd: "/work/repo" },
        options: [
          { optionId: "approved", label: "Allow once", decision: "accept", scope: "once" },
          { optionId: "approved_for_session", label: "Allow for session", decision: "accept_for_session", scope: "session" },
          { optionId: "denied", label: "Deny", decision: "decline" },
        ],
        allowCustomAnswer: false,
        allowFeedback: true,
        response: { mode: "live" },
        survivesRestart: false,
        status: "pending",
      },
    },
    requiredField: "request",
  },
  {
    variant: "subagent.upsert",
    validator: ari.SubagentUpsertBodySchema,
    body: { type: "subagent.upsert", subagent: { id: "sub-1", native, parentThreadId: "thread-1", status: "running", name: "explorer" } },
    requiredField: "subagent",
  },
  {
    variant: "plan.upsert",
    validator: ari.PlanUpsertBodySchema,
    body: {
      type: "plan.upsert",
      plan: { id: "plan-1", threadId: "thread-1", entries: [{ text: "Write the test", status: "in_progress" }] },
    },
    requiredField: "plan",
  },
  {
    variant: "background.updated",
    validator: ari.BackgroundUpdatedBodySchema,
    body: { type: "background.updated", tasks: [{ id: "task-1", kind: "terminal", status: "running", title: "dev server" }] },
    requiredField: "tasks",
  },
  {
    variant: "usage.updated",
    validator: ari.UsageUpdatedBodySchema,
    body: { type: "usage.updated", usage: { scope: "turn", inputTokens: 1200, outputTokens: 300, contextUsedTokens: 9000, contextMaxTokens: 200000 } },
    requiredField: "usage",
  },
  {
    variant: "limits.updated",
    validator: ari.LimitsUpdatedBodySchema,
    body: {
      type: "limits.updated",
      limits: { windows: [{ window: "5h", utilization: 0.4, resetsAt: "2026-11-23T18:00:00Z" }], limited: false },
    },
    requiredField: "limits",
  },
  {
    variant: "notice",
    validator: ari.NoticeBodySchema,
    body: { type: "notice", level: "warning", code: "model_rerouted", text: "The provider switched models." },
    requiredField: "text",
  },
  {
    variant: "retry",
    validator: ari.RetryBodySchema,
    body: { type: "retry", attempt: 2, maxAttempts: 5, retryDelayMs: 1000 },
    requiredField: "attempt",
  },
  {
    variant: "turn.terminal",
    validator: ari.TurnTerminalBodySchema,
    body: {
      type: "turn.terminal",
      turnId: "turn-1",
      status: "failed",
      failure: { class: "usage_limit", message: "Limit reached", retryable: true, resetAt: "2026-11-23T18:00:00Z" },
      threadDisposition: "reusable",
      childTurnsContinue: false,
    },
    requiredField: "threadDisposition",
  },
  {
    variant: "x:",
    validator: ari.ExtensionEventBodySchema,
    body: { type: "x:vendor.note", data: { note: "hello" }, fallback: { title: "Vendor note", text: "hello" } },
    requiredField: "data",
  },
];

/** The body without its required field. */
export function withoutRequiredField(example: EventBodyExample): Record<string, unknown> {
  const { [example.requiredField]: _removed, ...rest } = example.body as unknown as Record<string, unknown>;
  return rest;
}

/** Wraps a body in a valid envelope. */
export function envelope(body: unknown, seq = 1): AriEvent {
  return { seq, at: "2026-11-23T12:00:00Z", sessionId: "session-1", threadId: "thread-1", body: body as AriEventBody };
}
