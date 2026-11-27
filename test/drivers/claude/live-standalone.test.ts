// The reply check is pure: neither test starts a driver or loads the SDK.
import assert from "node:assert/strict";
import { test } from "node:test";
import { completedAssistantText } from "../../../scripts/live-claude-standalone.ts";
import type { AriEvent, AriEventBody } from "../../../src/index.ts";

function frames(...bodies: AriEventBody[]): AriEvent[] {
  return bodies.map((body, index) => ({ body, seq: index + 1, sessionId: "session", threadId: "thread", turnId: "turn", at: "2026-11-27T00:00:00Z" }));
}

test("the standalone smoke reads the full assistant reply from a settling patch without kind", () => {
  const events = frames(
    { type: "item.upsert", item: { id: "item", turnId: "turn", kind: "assistant_message", status: "running", text: "" } },
    { type: "item.delta", itemId: "item", field: "text", chunk: "ok" },
    { type: "item.upsert", item: { id: "item", status: "completed", text: "ok" } },
  );
  assert.equal(completedAssistantText(events, "turn"), "ok");
  assert.equal(completedAssistantText(events, "different-turn"), "");
});

test("the standalone smoke does not trim final text or count tool output or ephemeral text", () => {
  const events = frames(
    { type: "item.upsert", item: { id: "tool", turnId: "turn", kind: "tool_call", status: "completed", text: "ok" } },
    { type: "item.upsert", item: { id: "stream-only", turnId: "turn", kind: "assistant_message", status: "running", text: "" } },
    { type: "item.delta", itemId: "stream-only", field: "text", chunk: "ok" },
    { type: "item.upsert", item: { id: "stream-only", status: "completed" } },
    { type: "item.upsert", item: { id: "final", turnId: "turn", kind: "assistant_message", status: "completed", text: "ok " } },
  );
  assert.equal(completedAssistantText(events, "turn"), "ok ");
});
