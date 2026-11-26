// The ACP protocol words: for each object key an ACP agent can put in a
// message to the client, the string values the vendored ACP schemas
// (vendor-schemas/acp/schema-v2.0.0-beta.3/) allow there. The sanitiser keeps
// the user name in an inbound value that is one of its key's words, so an
// account named `text` keeps `"type": "text"`. Derived by
// ./derive-protocol-words.ts; test/recordings/protocol-words.test.ts fails
// when this list and the derivation differ. After a schema bump, run
// `node test/recordings/acp/derive-protocol-words.ts` and paste the result.

export const ACP_PROTOCOL_WORDS: { readonly [key: string]: readonly string[] } = {
  "apiType": [
    "anthropic",
    "azure",
    "bedrock",
    "openai",
    "vertex"
  ],
  "audience": [
    "assistant",
    "user"
  ],
  "category": [
    "mode",
    "model",
    "model_config",
    "speed",
    "thought_level"
  ],
  "fileType": [
    "binary",
    "directory",
    "symlink",
    "text"
  ],
  "format": [
    "date",
    "date-time",
    "email",
    "git_patch",
    "uri"
  ],
  "jsonrpc": [
    "2.0"
  ],
  "kind": [
    "allow_always",
    "allow_once",
    "delete",
    "edit",
    "execute",
    "fetch",
    "move",
    "other",
    "read",
    "reject_always",
    "reject_once",
    "search",
    "switch_mode",
    "think"
  ],
  "method": [
    "$/cancel_request",
    "auth/status_update",
    "elicitation/complete",
    "elicitation/create",
    "fs/read_text_file",
    "fs/write_text_file",
    "mcp/message",
    "session/request_permission",
    "session/update",
    "terminal/create",
    "terminal/kill",
    "terminal/output",
    "terminal/release",
    "terminal/wait_for_exit"
  ],
  "mode": [
    "form",
    "url"
  ],
  "operation": [
    "add",
    "copy",
    "delete",
    "modify",
    "move"
  ],
  "position": [
    "after",
    "before"
  ],
  "priority": [
    "high",
    "low",
    "medium"
  ],
  "sessionUpdate": [
    "agent_message",
    "agent_message_chunk",
    "agent_thought",
    "agent_thought_chunk",
    "available_commands_update",
    "compaction_summary_chunk",
    "compaction_update",
    "config_option_update",
    "current_mode_update",
    "cursor_update",
    "notice",
    "plan",
    "plan_removed",
    "plan_update",
    "prompt_suggestions_update",
    "replay_complete",
    "session_info_update",
    "session_message",
    "session_message_chunk",
    "state_update",
    "subagent_update",
    "terminal_output_chunk",
    "terminal_update",
    "tool_call",
    "tool_call_content_chunk",
    "tool_call_update",
    "usage_update",
    "user_message",
    "user_message_chunk"
  ],
  "severity": [
    "error",
    "info",
    "warning"
  ],
  "state": [
    "authenticated",
    "idle",
    "not_required",
    "requires_action",
    "running",
    "unauthenticated",
    "unknown"
  ],
  "status": [
    "cancelled",
    "completed",
    "failed",
    "in_progress",
    "open",
    "paused",
    "pending",
    "saved"
  ],
  "stopReason": [
    "cancelled",
    "end_turn",
    "error",
    "max_tokens",
    "max_turn_requests",
    "refusal"
  ],
  "supported": [
    "anthropic",
    "azure",
    "bedrock",
    "openai",
    "vertex"
  ],
  "theme": [
    "dark",
    "light"
  ],
  "type": [
    "agent",
    "agent_message",
    "agent_thought",
    "array",
    "audio",
    "boolean",
    "command",
    "compaction",
    "content",
    "diff",
    "image",
    "integer",
    "items",
    "markdown",
    "number",
    "object",
    "resource",
    "resource_link",
    "select",
    "session",
    "session_message",
    "skill",
    "string",
    "subagent",
    "terminal",
    "text",
    "tool_call",
    "user_message"
  ]
};
