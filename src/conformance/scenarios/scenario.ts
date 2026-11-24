// The shape of a conformance scenario, and helpers several scenarios share.
// Scenarios import no test runner: they throw `ConformanceFailure` when a
// check fails and `ScenarioNotApplicable` when a declared capability rules
// them out; the runner turns that into a result.

import { hasCapability } from "../../capabilities.ts";
import type { Capabilities } from "../../generated/capabilities.ts";
import type { RuntimeMode } from "../../generated/config.ts";
import type { Item } from "../../generated/item.ts";
import type { Request } from "../../generated/request.ts";
import type { OpenedSession, ScenarioContext } from "../context.ts";
import type { NativeApproval, NativeApprovalHandle, NativeApprovalOption } from "../harness.ts";

export interface Scenario {
  /** 1 to 15, the order of the acceptance criteria's inventory and of docs/conformance.md. */
  readonly id: number;
  /** Stable key; harness reasons are keyed by it. */
  readonly key: string;
  readonly title: string;
  run(context: ScenarioContext): Promise<void>;
}

/** Approval request kinds, as opposed to questions and elicitation. */
export const APPROVAL_REQUEST_KINDS: ReadonlySet<string> = new Set(["command", "file_read", "file_change", "permission"]);

/** Item kinds that are a turn's messages or thinking rather than a tool. */
const NON_TOOL_ITEM_KINDS: ReadonlySet<string> = new Set(["user_message", "assistant_message", "reasoning", "system_notice", "error", "compaction"]);

export function isToolItem(item: Pick<Item, "kind">): boolean {
  return !NON_TOOL_ITEM_KINDS.has(item.kind);
}

/**
 * The approval kind the kit asks the native agent for: a command approval when
 * the driver declares `approvals.command`, else a file-change approval. Ends
 * the scenario as not applicable when the driver declares neither.
 */
export function approvalKind(context: ScenarioContext, capabilities: Capabilities): NativeApproval["kind"] {
  if (hasCapability(capabilities, "approvals.command")) return "command";
  if (hasCapability(capabilities, "approvals.fileChange")) return "file_change";
  context.requireCapability(capabilities, "approvals.command");
  return "command";
}

/** A native approval of `kind` with `options`. */
export function approval(kind: NativeApproval["kind"], options: readonly NativeApprovalOption[]): NativeApproval {
  return kind === "command" ? { kind, command: ["git", "status"], options } : { kind, path: "README.md", options };
}

/** The first runtime mode the driver supports in which approvals reach the host (not `full_access`). */
export function supervisedMode(capabilities: Capabilities): RuntimeMode | undefined {
  const modes: RuntimeMode[] = ["approval_required", "auto_accept_edits", "read_only", "auto"];
  return modes.find((mode) => hasCapability(capabilities, `runtimePolicy.modes.${mode}`));
}

/** The native option id the driver sees for the kit's `optionId`: the harness's mapping when it gave one, else the id itself. */
export function nativeOptionId(handle: Pick<NativeApprovalHandle, "nativeOptionIds">, optionId: string): string {
  return handle.nativeOptionIds?.[optionId] ?? optionId;
}

/** Waits for a pending request that offers the native option `optionId`. */
export function pendingRequestOffering(context: ScenarioContext, opened: OpenedSession, optionId: string): Promise<Request> {
  return context.until(() => {
    for (const request of context.reduced(opened).requests.values()) {
      if (request.status === "pending" && (request.options ?? []).some((option) => option.optionId === optionId)) return request;
    }
    return undefined;
  }, `a pending request offering native option "${optionId}"`);
}

/** The assistant text of `turnId`, folded from the session's events. */
export function assistantText(context: ScenarioContext, opened: OpenedSession, turnId: string): string {
  const state = context.reduced(opened);
  const inTurn = new Set<string>();
  for (const event of opened.events.events) {
    if (event.turnId === turnId && event.body.type === "item.upsert") inTurn.add(event.body.item.id);
  }
  let text = "";
  for (const item of state.items.values()) {
    if (item.kind === "assistant_message" && (item.turnId === turnId || inTurn.has(item.id))) text += item.text ?? "";
  }
  return text;
}
