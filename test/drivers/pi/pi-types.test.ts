// The checks against Pi's published types catch what they should: the bridge
// source matches Pi's ExtensionAPI, and frames or session lines that Pi's
// types reject are rejected. conformance.test.ts and quirks.test.ts run the
// same check over every frame their fakes exchanged.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PI_BRIDGE_SOURCE } from "../../../src/drivers/pi/index.ts";
import { checkAgainstPiTypes, checkBridgeAgainstPiTypes } from "./pi-types.ts";

test("the bridge extension type-checks against Pi's ExtensionAPI, and a wrong event name does not", () => {
  assert.deepEqual(checkBridgeAgainstPiTypes(PI_BRIDGE_SOURCE), []);
  assert.ok(checkBridgeAgainstPiTypes(PI_BRIDGE_SOURCE.replace('pi.on("tool_call"', 'pi.on("tool_called"')).length > 0);
  assert.ok(checkBridgeAgainstPiTypes(PI_BRIDGE_SOURCE.replace("return { block: true };", "return { block: 1 };")).length > 0);
});

test("documented frames pass, and frames Pi's types reject fail", () => {
  const good = {
    sent: [
      { id: "a-1", type: "prompt", message: "Hello" },
      { type: "steer", message: "Also this" },
      { type: "extension_ui_response", id: "ui-1", value: "Allow" },
      { type: "extension_ui_response", id: "ui-2", cancelled: true },
    ],
    received: [
      { id: "a-1", type: "response", command: "prompt", success: true, data: { disposition: "started" } },
      { type: "response", command: "parse", success: false, error: "Failed to parse command" },
      { type: "agent_settled", aborted: false },
      { type: "extension_ui_request", id: "ui-1", method: "select", title: "Allow?", options: ["Allow", "Block"] },
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Hello" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], timestamp: 1 } },
    ],
    sessionLines: [
      { type: "session", version: 3, id: "s-1", timestamp: "2026-11-23T00:00:00.000Z", cwd: "/work" },
      { type: "label", id: "0000000b", parentId: "0000000a", timestamp: "2026-11-23T00:00:00.000Z", targetId: "0000000a", label: "ari-rewind" },
      { type: "message", id: "0000000c", parentId: "0000000b", timestamp: "2026-11-23T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 } },
    ],
  };
  assert.deepEqual(checkAgainstPiTypes(good), []);

  const bad: Array<[string, Parameters<typeof checkAgainstPiTypes>[0]]> = [
    ["a prompt without its message", { sent: [{ type: "prompt" }], received: [], sessionLines: [] }],
    ["a prompt with a field Pi does not have", { sent: [{ type: "prompt", message: "x", priority: 1 }], received: [], sessionLines: [] }],
    ["an unknown command", { sent: [{ type: "prompt_now", message: "x" }], received: [], sessionLines: [] }],
    ["agent_settled without aborted", { sent: [], received: [{ type: "agent_settled" }], sessionLines: [] }],
    ["a select request without options", { sent: [], received: [{ type: "extension_ui_request", id: "u", method: "select", title: "t" }], sessionLines: [] }],
    ["a session entry without a timestamp", { sent: [], received: [], sessionLines: [{ type: "label", id: "b", parentId: null, targetId: "a", label: "x" }] }],
    // Pi's message type allows a string, but Pi builds every RPC user message as blocks.
    ["a user message event whose content is a string", { sent: [], received: [{ type: "message_end", message: { role: "user", content: "Hello", timestamp: 1 } }], sessionLines: [] }],
    ["a stored user message whose content is a string", { sent: [], received: [], sessionLines: [{ type: "message", id: "c", parentId: null, timestamp: "2026-11-23T00:00:00.000Z", message: { role: "user", content: "Hello", timestamp: 1 } }] }],
    ["a user message in agent_end whose content is a string", { sent: [], received: [{ type: "agent_end", messages: [{ role: "user", content: "Hello", timestamp: 1 }], willRetry: false }], sessionLines: [] }],
  ];
  for (const [what, frames] of bad) assert.ok(checkAgainstPiTypes(frames).length > 0, `${what} passed the check`);
});
