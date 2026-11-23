// The reference agent's native protocol: newline-delimited JSON-RPC 2.0 over
// the agent's stdin and stdout, in the style of Pi's RPC mode, ACP and the
// Codex app-server. It exists so the reference driver is a real stdio driver
// with a real native side, small enough to read in one sitting.
//
// Command line:
//   reference-agent --version              prints "reference-agent <version>" and exits
//   reference-agent --auth-status          prints one JSON line {"status": ...} and exits;
//                                          exits 1 when it cannot answer
//   reference-agent --session-dir <dir>    serves the protocol, keeping sessions in <dir>
//
// Driver to agent requests:
//   initialize {}                                   -> { agent, version }
//   session/new { cwd }                             -> { sessionId, cwd }   (cwd canonical)
//   session/load { sessionId }                      -> { sessionId, cwd }   or LOCKED / NOT_FOUND
//   session/prompt { sessionId, text, queue? }      -> { turnId, queued }   or TURN_ACTIVE
//   session/steer { sessionId, turnId, text }       -> {}                   or NO_ACTIVE_TURN
//   session/cancel { sessionId, turnId }            -> {}
//   session/snapshot { sessionId }                  -> StoredSession
//   session/fork { sessionId, atTurnId?, cwd? }     -> { sessionId, cwd }
//   session/rollback { sessionId, toTurnId? }       -> StoredSession
//   session/compact, session/unload { sessionId }   -> {}
//   session/inject { sessionId, messages }          -> {}
//   tasks/list { sessionId }                        -> { tasks }
//   tasks/stop { sessionId, taskId }                -> {}
//   tasks/await { sessionId, taskIds }              -> { matched }
//   subagent/stop { subagentId }                    -> { status }
//   mcp/listTools { server }, mcp/callTool { server, tool, args }, mcp/readResource { server, uri }
//   feedback/upload { sessionId }                   -> { feedbackId }
//   ext/echo { params }                             -> params
//
// Agent to driver:
//   permission/request { sessionId, turnId, permissionId, kind, command?, path?, options } -> { optionId }
//   session/update { sessionId, turnId, update }    (notification; `update` is a ReferenceUpdate)

/** JSON-RPC error codes the agent answers with. */
export const REFERENCE_ERRORS = {
  locked: -32010,
  notFound: -32011,
  turnActive: -32020,
  noActiveTurn: -32021,
} as const;

export const REFERENCE_AGENT_VERSION = "1.0.0";

/** The ambient account's sign-in state, as `--auth-status` reports it. */
export type ReferenceAmbientAuth = "authenticated" | "unauthenticated" | "unknown" | "unavailable";

export type ReferenceOptionKind = "allow_once" | "allow_session" | "allow_always" | "reject_once";

export interface ReferencePermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: ReferenceOptionKind;
}

export interface ReferencePermissionRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly permissionId: string;
  readonly kind: "command" | "file_change";
  readonly command?: readonly string[];
  readonly path?: string;
  readonly options: readonly ReferencePermissionOption[];
}

export type ReferenceStopReason = "end_turn" | "cancelled" | "error";

export interface ReferenceTurnError {
  readonly kind: "usage_limit" | "provider_error";
  readonly message: string;
  readonly resetAt?: string;
}

export type ReferenceUpdate =
  | { readonly type: "turn_started"; readonly turnId: string; readonly prompt: string }
  | { readonly type: "message_delta"; readonly messageId: string; readonly text: string }
  | { readonly type: "message_done"; readonly messageId: string; readonly text: string }
  | { readonly type: "tool_started"; readonly toolCallId: string; readonly name: string; readonly input: unknown; readonly path?: string }
  | { readonly type: "tool_done"; readonly toolCallId: string; readonly output: string }
  | { readonly type: "task_started"; readonly taskId: string; readonly title: string }
  | { readonly type: "task_finished"; readonly taskId: string; readonly status: "completed" | "stopped" }
  | { readonly type: "subagent_started"; readonly subagentId: string; readonly name: string }
  | { readonly type: "subagent_finished"; readonly subagentId: string; readonly status: "completed" | "cancelled" }
  | { readonly type: "turn_ended"; readonly turnId: string; readonly stopReason: ReferenceStopReason; readonly error?: ReferenceTurnError };

export interface ReferenceSessionUpdate {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly update: ReferenceUpdate;
}

export interface StoredItem {
  readonly id: string;
  readonly kind: "message" | "tool";
  text?: string;
  readonly name?: string;
  readonly input?: unknown;
  output?: string;
  readonly path?: string;
  status: "running" | "completed";
}

export interface StoredTurn {
  readonly turnId: string;
  readonly prompt: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  readonly items: StoredItem[];
}

export interface StoredTask {
  readonly taskId: string;
  readonly title: string;
  readonly turnId: string;
  status: "running" | "completed" | "stopped";
}

export interface StoredSession {
  readonly sessionId: string;
  readonly cwd: string;
  turns: StoredTurn[];
  readonly tasks: StoredTask[];
  injectedMessages: number;
  compactions: number;
}
