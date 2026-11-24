// The frame check of frames.ts is a real check: frames the SDK's wire types
// accept compile cleanly, and each planted mistake (a missing required member,
// a member of the wrong type, an unknown member, a method the stable surface
// does not list, a server request answered with the wrong shape) is caught and
// pinned to its frame. Every Muse test file runs the same check over all of its
// frames when it ends (the `after` hook frames.ts registers).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkFrames } from "./frames.ts";
import type { RecordedFrame } from "./frames.ts";

const SESSION = "0198f0aa-1111-7000-8000-0000000000aa";
const TURN = "018f6a1e-9b3c-7c21-a54a-2f30bd3c9f10";
const RANGE = { stream: { kind: "run", id: TURN }, first: { id: "018f9008-71aa-7000-8000-000000000001", sequence: 1 }, last: { id: "018f9008-71aa-7000-8000-000000000001", sequence: 1 } };

/** Frames from the SDK repository's text-run-single-turn and approval-round-trip transcripts. */
const VALID: RecordedFrame[] = [
  { direction: "client", shape: "request", method: "initialize", frame: { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "ari", title: "ARI", version: "1.0.0" }, capabilities: { requestedCapabilities: ["sessionMcp"] } } } },
  { direction: "client", shape: "notification", method: "initialized", frame: { jsonrpc: "2.0", method: "initialized" } },
  { direction: "client", shape: "request", method: "turn/start", frame: { jsonrpc: "2.0", id: 3, method: "turn/start", params: { sessionId: SESSION, commandId: TURN, input: [{ type: "text", text: "Run the agent test suite" }] } } },
  { direction: "server", shape: "result", method: "turn/start", frame: { jsonrpc: "2.0", id: 3, result: { commandId: TURN, status: "accepted", turnId: TURN, startedNewTurn: true, disposition: "started" } } },
  { direction: "server", shape: "notification", method: "turn/started", frame: { jsonrpc: "2.0", method: "turn/started", params: { sessionId: SESSION, viewCursor: `v10:${SESSION}:4`, sourceRange: RANGE, turnId: TURN, commandId: TURN }, emittedAtMs: 1754590940000 } },
  { direction: "server", shape: "notification", method: "item/delta", frame: { jsonrpc: "2.0", method: "item/delta", params: { sessionId: SESSION, viewCursor: `v10:${SESSION}:7`, itemId: "0198f0ac-4242-7000-8000-000000000042", field: "text", delta: "All 214 tests pass" } } },
  { direction: "server", shape: "request", method: "approval/request", frame: { jsonrpc: "2.0", id: 1, method: "approval/request", params: { sessionId: SESSION, viewCursor: `v10:${SESSION}:7`, sourceRange: RANGE, approvalId: "a1", turnId: TURN, taskId: "t1", itemId: "i1", toolCallId: "call_1", toolName: "write_file", rawArgs: "{}", subject: { kind: "fileAccess", path: "/w/Cargo.toml", access: "write" }, currentRequirementId: { approvalId: "a1", sourceIndex: 0 }, availableChoices: [{ choiceId: "allow_once", label: "Allow once", decision: "approved", scope: "once" }], protectedWrite: false, judgeEscalated: false } } },
  { direction: "client", shape: "result", method: "approval/request", frame: { jsonrpc: "2.0", id: 1, result: {} } },
  { direction: "server", shape: "error", method: "turn/steer", frame: { jsonrpc: "2.0", id: 9, error: { code: -32030, message: "turn is not running", data: { kind: "commandRejected", commandId: TURN, reason: "turn_not_running" } } } },
  { direction: "client", shape: "request", method: "usage/read", frame: { jsonrpc: "2.0", id: 5, method: "usage/read" } },
];

describe("muse frame check against @muse-code/sdk 1.4.25 wire types", () => {
  test("frames the SDK's wire types accept compile cleanly", () => {
    assert.deepEqual(
      checkFrames(VALID).map((problem) => `${problem.frame.method}: ${problem.message}`),
      [],
    );
  });

  test("a missing member, a wrong type, an unknown member, an unlisted method and a misshapen reply are each caught and pinned to their frame", () => {
    const planted: RecordedFrame[] = [
      ...VALID,
      // turn/start without its required input.
      { direction: "client", shape: "request", method: "turn/start", frame: { jsonrpc: "2.0", id: 20, method: "turn/start", params: { sessionId: SESSION, commandId: TURN } } },
      // turn/completed whose terminal is a number.
      { direction: "server", shape: "notification", method: "turn/completed", frame: { jsonrpc: "2.0", method: "turn/completed", params: { sessionId: SESSION, viewCursor: "v", sourceRange: RANGE, turnId: TURN, terminal: 7 } } },
      // approval/decide with a member MSP does not define.
      { direction: "client", shape: "request", method: "approval/decide", frame: { jsonrpc: "2.0", id: 21, method: "approval/decide", params: { sessionId: SESSION, commandId: "c", approvalId: "a1", requirementId: { approvalId: "a1", sourceIndex: 0 }, choiceId: "allow_once", optionId: "allow_once" } } },
      // A method the stable surface does not list.
      { direction: "client", shape: "request", method: "thread/start", frame: { jsonrpc: "2.0", id: 22, method: "thread/start", params: {} } },
      // A session/start answer without its session.
      { direction: "server", shape: "result", method: "session/start", frame: { jsonrpc: "2.0", id: 23, result: { viewCursor: "v" } } },
    ];
    const problems = checkFrames(planted);
    const pinned = (method: string, id: number | undefined): string[] =>
      problems.filter((problem) => problem.frame.method === method && (id === undefined || (problem.frame.frame as { id?: number }).id === id)).map((problem) => problem.message);
    assert.match(pinned("turn/start", 20).join("\n"), /input/);
    assert.match(pinned("turn/completed", undefined).join("\n"), /number/);
    assert.match(pinned("approval/decide", 21).join("\n"), /optionId/);
    assert.match(pinned("thread/start", 22).join("\n"), /thread\/start/);
    assert.match(pinned("session/start", 23).join("\n"), /session/);
    // None of the valid frames is blamed.
    for (const problem of problems) assert.ok(!VALID.includes(problem.frame), `a valid frame was blamed: ${problem.message}`);
  });
});
