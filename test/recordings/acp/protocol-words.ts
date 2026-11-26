// The ACP protocol words, by place (../protocol-places.ts): for every spot of
// an inbound ACP frame the vendored ACP schemas
// (vendor-schemas/acp/schema-v2.0.0-beta.3/) describe, the string values they
// allow as each key's value there, and where each object value goes on.
// Derived by ./derive-protocol-words.ts; test/recordings/protocol-words.test.ts
// fails when this and the derivation differ. After a schema bump, run
// `node test/recordings/acp/derive-protocol-words.ts` and put its output here.
//
// The sanitiser keeps the user name in an inbound string only where the
// value is one of the words of its place's key: a content block's
// `"type": "text"` stays on an account named `text`. A value anywhere else
// (free text, the agent's `_meta`) is free text like any other.

import type { ProtocolWords } from "../protocol-places.ts";

export const ACP_PROTOCOL_WORDS: ProtocolWords = {
  "": {
    "message": {
      "place": "message"
    }
  },
  "message": {
    "error": {
      "place": "message.error"
    },
    "jsonrpc": {
      "words": [
        "2.0"
      ]
    },
    "method": {
      "words": [
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
      ]
    },
    "params": {
      "place": "message.params"
    },
    "result": {
      "place": "message.result"
    }
  },
  "message.error": {
    "data": {
      "place": "message.error.data"
    }
  },
  "message.error.data": {},
  "message.params": {
    "accounts": {
      "place": "message.params.accounts"
    },
    "env": {
      "place": "message.params.env"
    },
    "mode": {
      "words": [
        "form",
        "url"
      ]
    },
    "options": {
      "place": "message.params.options"
    },
    "requestedSchema": {
      "place": "message.params.requestedSchema"
    },
    "state": {
      "words": [
        "authenticated",
        "not_required",
        "unauthenticated",
        "unknown"
      ]
    },
    "subject": {
      "place": "message.params.subject"
    },
    "toolCall": {
      "place": "message.params.toolCall"
    },
    "update": {
      "place": "message.params.update"
    }
  },
  "message.params.accounts": {},
  "message.params.env": {},
  "message.params.options": {
    "kind": {
      "words": [
        "allow_always",
        "allow_once",
        "reject_always",
        "reject_once"
      ]
    }
  },
  "message.params.requestedSchema": {
    "properties": {
      "place": "message.params.requestedSchema.properties"
    },
    "type": {
      "words": [
        "object"
      ]
    }
  },
  "message.params.requestedSchema.properties": {
    "*": {
      "place": "message.params.requestedSchema.properties.*"
    }
  },
  "message.params.requestedSchema.properties.*": {
    "format": {
      "words": [
        "date",
        "date-time",
        "email",
        "uri"
      ]
    },
    "items": {
      "place": "message.params.requestedSchema.properties.*.items"
    },
    "oneOf": {
      "place": "message.params.requestedSchema.properties.*.oneOf"
    },
    "type": {
      "words": [
        "array",
        "boolean",
        "integer",
        "number",
        "string"
      ]
    }
  },
  "message.params.requestedSchema.properties.*.items": {
    "anyOf": {
      "place": "message.params.requestedSchema.properties.*.oneOf"
    },
    "type": {
      "words": [
        "string"
      ]
    }
  },
  "message.params.requestedSchema.properties.*.oneOf": {},
  "message.params.subject": {
    "toolCall": {
      "place": "message.params.subject.toolCall"
    },
    "type": {
      "words": [
        "command",
        "tool_call"
      ]
    }
  },
  "message.params.subject.toolCall": {
    "capabilities": {
      "place": "message.params.subject.toolCall.capabilities"
    },
    "content": {
      "place": "message.params.subject.toolCall.content"
    },
    "kind": {
      "words": [
        "delete",
        "edit",
        "execute",
        "fetch",
        "move",
        "other",
        "read",
        "search",
        "switch_mode",
        "think"
      ]
    },
    "locations": {
      "place": "message.params.subject.toolCall.locations"
    },
    "status": {
      "words": [
        "cancelled",
        "completed",
        "failed",
        "in_progress",
        "paused",
        "pending"
      ]
    }
  },
  "message.params.subject.toolCall.capabilities": {
    "cancel": {
      "place": "message.params.subject.toolCall.capabilities.cancel"
    }
  },
  "message.params.subject.toolCall.capabilities.cancel": {},
  "message.params.subject.toolCall.content": {
    "changes": {
      "place": "message.params.update.content.changes"
    },
    "content": {
      "place": "message.params.subject.toolCall.content.content"
    },
    "patch": {
      "place": "message.params.update.content.patch"
    },
    "type": {
      "words": [
        "content",
        "diff",
        "session",
        "terminal"
      ]
    }
  },
  "message.params.subject.toolCall.content.content": {
    "annotations": {
      "place": "message.params.subject.toolCall.content.content.annotations"
    },
    "icons": {
      "place": "message.params.update.content.icons"
    },
    "resource": {
      "place": "message.params.subject.toolCall.content.content.resource"
    },
    "type": {
      "words": [
        "audio",
        "image",
        "resource",
        "resource_link",
        "skill",
        "text"
      ]
    }
  },
  "message.params.subject.toolCall.content.content.annotations": {
    "audience": {
      "words": [
        "assistant",
        "user"
      ]
    }
  },
  "message.params.subject.toolCall.content.content.resource": {},
  "message.params.subject.toolCall.locations": {},
  "message.params.toolCall": {
    "content": {
      "place": "message.params.toolCall.content"
    },
    "kind": {
      "words": [
        "delete",
        "edit",
        "execute",
        "fetch",
        "move",
        "other",
        "read",
        "search",
        "switch_mode",
        "think"
      ]
    },
    "locations": {
      "place": "message.params.toolCall.locations"
    },
    "status": {
      "words": [
        "completed",
        "failed",
        "in_progress",
        "pending"
      ]
    }
  },
  "message.params.toolCall.content": {
    "content": {
      "place": "message.params.toolCall.content.content"
    },
    "type": {
      "words": [
        "content",
        "diff",
        "session",
        "terminal"
      ]
    }
  },
  "message.params.toolCall.content.content": {
    "annotations": {
      "place": "message.params.toolCall.content.content.annotations"
    },
    "resource": {
      "place": "message.params.toolCall.content.content.resource"
    },
    "type": {
      "words": [
        "audio",
        "image",
        "resource",
        "resource_link",
        "text"
      ]
    }
  },
  "message.params.toolCall.content.content.annotations": {
    "audience": {
      "words": [
        "assistant",
        "user"
      ]
    }
  },
  "message.params.toolCall.content.content.resource": {},
  "message.params.toolCall.locations": {},
  "message.params.update": {
    "anchor": {
      "place": "message.params.update.anchor"
    },
    "availableCommands": {
      "place": "message.params.update.availableCommands"
    },
    "background": {
      "place": "message.params.update.background"
    },
    "capabilities": {
      "place": "message.params.update.capabilities"
    },
    "configOptions": {
      "place": "message.result.configOptions"
    },
    "content": {
      "place": "message.params.update.content"
    },
    "cost": {
      "place": "message.params.update.cost"
    },
    "entries": {
      "place": "message.params.update.entries"
    },
    "error": {
      "place": "message.params.update.error"
    },
    "exitStatus": {
      "place": "message.params.update.exitStatus"
    },
    "kind": {
      "words": [
        "delete",
        "edit",
        "execute",
        "fetch",
        "move",
        "other",
        "read",
        "search",
        "switch_mode",
        "think"
      ]
    },
    "locations": {
      "place": "message.params.update.locations"
    },
    "output": {
      "place": "message.params.update.output"
    },
    "plan": {
      "place": "message.params.update.plan"
    },
    "sessionUpdate": {
      "words": [
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
      ]
    },
    "severity": {
      "words": [
        "error",
        "info",
        "warning"
      ]
    },
    "size": {
      "place": "message.params.update.size"
    },
    "state": {
      "words": [
        "idle",
        "requires_action",
        "running",
        "unknown"
      ],
      "place": "message.params.update.state"
    },
    "status": {
      "words": [
        "cancelled",
        "completed",
        "failed",
        "in_progress",
        "paused",
        "pending"
      ]
    },
    "stopReason": {
      "words": [
        "cancelled",
        "end_turn",
        "error",
        "max_tokens",
        "max_turn_requests",
        "refusal"
      ]
    },
    "suggestions": {
      "place": "message.params.update.suggestions"
    },
    "summary": {
      "place": "message.params.update.summary"
    },
    "usage": {
      "place": "message.params.update.usage"
    }
  },
  "message.params.update.anchor": {
    "position": {
      "words": [
        "after",
        "before"
      ]
    },
    "type": {
      "words": [
        "agent_message",
        "agent_thought",
        "compaction",
        "session_message",
        "tool_call",
        "user_message"
      ]
    }
  },
  "message.params.update.availableCommands": {
    "input": {
      "place": "message.params.update.availableCommands.input"
    },
    "type": {
      "words": [
        "command",
        "skill"
      ]
    }
  },
  "message.params.update.availableCommands.input": {
    "type": {
      "words": [
        "text"
      ]
    }
  },
  "message.params.update.background": {
    "type": {
      "words": [
        "subagent",
        "terminal",
        "tool_call"
      ]
    }
  },
  "message.params.update.capabilities": {
    "cancel": {
      "place": "message.params.update.capabilities.cancel"
    },
    "fork": {
      "place": "message.params.update.capabilities.fork"
    }
  },
  "message.params.update.capabilities.cancel": {},
  "message.params.update.capabilities.fork": {},
  "message.params.update.content": {
    "annotations": {
      "place": "message.params.update.content.annotations"
    },
    "changes": {
      "place": "message.params.update.content.changes"
    },
    "content": {
      "place": "message.params.update.summary"
    },
    "icons": {
      "place": "message.params.update.content.icons"
    },
    "patch": {
      "place": "message.params.update.content.patch"
    },
    "resource": {
      "place": "message.params.update.content.resource"
    },
    "type": {
      "words": [
        "audio",
        "content",
        "diff",
        "image",
        "resource",
        "resource_link",
        "session",
        "skill",
        "terminal",
        "text"
      ]
    }
  },
  "message.params.update.content.annotations": {
    "audience": {
      "words": [
        "assistant",
        "user"
      ]
    }
  },
  "message.params.update.content.changes": {
    "fileType": {
      "words": [
        "binary",
        "directory",
        "symlink",
        "text"
      ]
    },
    "operation": {
      "words": [
        "add",
        "copy",
        "delete",
        "modify",
        "move"
      ]
    }
  },
  "message.params.update.content.icons": {
    "theme": {
      "words": [
        "dark",
        "light"
      ]
    }
  },
  "message.params.update.content.patch": {
    "format": {
      "words": [
        "git_patch"
      ]
    }
  },
  "message.params.update.content.resource": {},
  "message.params.update.cost": {},
  "message.params.update.entries": {
    "priority": {
      "words": [
        "high",
        "low",
        "medium"
      ]
    },
    "status": {
      "words": [
        "completed",
        "in_progress",
        "pending"
      ]
    }
  },
  "message.params.update.error": {
    "data": {
      "place": "message.error.data"
    }
  },
  "message.params.update.exitStatus": {},
  "message.params.update.locations": {},
  "message.params.update.output": {},
  "message.params.update.plan": {
    "entries": {
      "place": "message.params.update.plan.entries"
    },
    "type": {
      "words": [
        "items",
        "markdown"
      ]
    }
  },
  "message.params.update.plan.entries": {
    "priority": {
      "words": [
        "high",
        "low",
        "medium"
      ]
    },
    "status": {
      "words": [
        "cancelled",
        "completed",
        "in_progress",
        "pending"
      ]
    }
  },
  "message.params.update.size": {},
  "message.params.update.state": {
    "background": {
      "place": "message.params.update.background"
    },
    "error": {
      "place": "message.error"
    },
    "state": {
      "words": [
        "idle",
        "requires_action",
        "running",
        "unknown"
      ]
    },
    "stopReason": {
      "words": [
        "cancelled",
        "end_turn",
        "error",
        "max_tokens",
        "max_turn_requests",
        "refusal"
      ]
    },
    "usage": {
      "place": "message.params.update.state.usage"
    }
  },
  "message.params.update.state.usage": {},
  "message.params.update.suggestions": {
    "prompt": {
      "place": "message.params.update.summary"
    }
  },
  "message.params.update.summary": {
    "annotations": {
      "place": "message.params.update.content.annotations"
    },
    "icons": {
      "place": "message.params.update.content.icons"
    },
    "resource": {
      "place": "message.params.update.content.resource"
    },
    "type": {
      "words": [
        "audio",
        "image",
        "resource",
        "resource_link",
        "skill",
        "text"
      ]
    }
  },
  "message.params.update.usage": {},
  "message.result": {
    "accounts": {
      "place": "message.params.accounts"
    },
    "agentCapabilities": {
      "place": "message.result.agentCapabilities"
    },
    "agentInfo": {
      "place": "message.result.agentInfo"
    },
    "authMethods": {
      "place": "message.result.authMethods"
    },
    "availableCommands": {
      "place": "message.result.availableCommands"
    },
    "capabilities": {
      "place": "message.result.capabilities"
    },
    "configOptions": {
      "place": "message.result.configOptions"
    },
    "info": {
      "place": "message.result.info"
    },
    "modes": {
      "place": "message.result.modes"
    },
    "providers": {
      "place": "message.result.providers"
    },
    "sessions": {
      "place": "message.result.sessions"
    },
    "state": {
      "words": [
        "authenticated",
        "not_required",
        "unauthenticated",
        "unknown"
      ],
      "place": "message.result.state"
    },
    "status": {
      "words": [
        "open",
        "saved"
      ]
    },
    "stopReason": {
      "words": [
        "cancelled",
        "end_turn",
        "max_tokens",
        "max_turn_requests",
        "refusal"
      ]
    },
    "usage": {
      "place": "message.result.usage"
    }
  },
  "message.result.agentCapabilities": {
    "auth": {
      "place": "message.result.agentCapabilities.auth"
    },
    "mcpCapabilities": {
      "place": "message.result.agentCapabilities.mcpCapabilities"
    },
    "promptCapabilities": {
      "place": "message.result.agentCapabilities.promptCapabilities"
    },
    "providers": {
      "place": "message.result.agentCapabilities.providers"
    },
    "sessionCapabilities": {
      "place": "message.result.agentCapabilities.sessionCapabilities"
    }
  },
  "message.result.agentCapabilities.auth": {
    "logout": {
      "place": "message.result.agentCapabilities.auth.logout"
    },
    "status": {
      "place": "message.result.agentCapabilities.auth.status"
    }
  },
  "message.result.agentCapabilities.auth.logout": {},
  "message.result.agentCapabilities.auth.status": {},
  "message.result.agentCapabilities.mcpCapabilities": {},
  "message.result.agentCapabilities.promptCapabilities": {},
  "message.result.agentCapabilities.providers": {},
  "message.result.agentCapabilities.sessionCapabilities": {
    "additionalDirectories": {
      "place": "message.result.agentCapabilities.sessionCapabilities.additionalDirectories"
    },
    "archive": {
      "place": "message.result.agentCapabilities.sessionCapabilities.archive"
    },
    "close": {
      "place": "message.result.agentCapabilities.sessionCapabilities.close"
    },
    "delete": {
      "place": "message.result.agentCapabilities.sessionCapabilities.delete"
    },
    "fork": {
      "place": "message.result.agentCapabilities.sessionCapabilities.fork"
    },
    "list": {
      "place": "message.result.agentCapabilities.sessionCapabilities.list"
    },
    "options": {
      "place": "message.result.agentCapabilities.sessionCapabilities.options"
    },
    "resume": {
      "place": "message.result.agentCapabilities.sessionCapabilities.resume"
    },
    "status": {
      "place": "message.result.agentCapabilities.sessionCapabilities.status"
    },
    "systemPrompt": {
      "place": "message.result.agentCapabilities.sessionCapabilities.systemPrompt"
    },
    "title": {
      "place": "message.result.agentCapabilities.sessionCapabilities.title"
    }
  },
  "message.result.agentCapabilities.sessionCapabilities.additionalDirectories": {},
  "message.result.agentCapabilities.sessionCapabilities.archive": {},
  "message.result.agentCapabilities.sessionCapabilities.close": {},
  "message.result.agentCapabilities.sessionCapabilities.delete": {},
  "message.result.agentCapabilities.sessionCapabilities.fork": {},
  "message.result.agentCapabilities.sessionCapabilities.list": {},
  "message.result.agentCapabilities.sessionCapabilities.options": {},
  "message.result.agentCapabilities.sessionCapabilities.resume": {},
  "message.result.agentCapabilities.sessionCapabilities.status": {},
  "message.result.agentCapabilities.sessionCapabilities.systemPrompt": {
    "mode": {
      "place": "message.result.agentCapabilities.sessionCapabilities.systemPrompt.mode"
    }
  },
  "message.result.agentCapabilities.sessionCapabilities.systemPrompt.mode": {
    "override": {
      "place": "message.result.agentCapabilities.sessionCapabilities.systemPrompt.mode.override"
    }
  },
  "message.result.agentCapabilities.sessionCapabilities.systemPrompt.mode.override": {},
  "message.result.agentCapabilities.sessionCapabilities.title": {},
  "message.result.agentInfo": {},
  "message.result.authMethods": {
    "env": {
      "place": "message.result.authMethods.env"
    },
    "type": {
      "words": [
        "agent",
        "terminal"
      ]
    }
  },
  "message.result.authMethods.env": {
    "*": {},
    "_meta": {},
    "name": {},
    "value": {}
  },
  "message.result.availableCommands": {
    "input": {
      "place": "message.result.availableCommands.input"
    },
    "type": {
      "words": [
        "command",
        "skill"
      ]
    }
  },
  "message.result.availableCommands.input": {
    "type": {
      "words": [
        "text"
      ]
    }
  },
  "message.result.capabilities": {
    "auth": {
      "place": "message.result.capabilities.auth"
    },
    "providers": {
      "place": "message.result.capabilities.providers"
    },
    "session": {
      "place": "message.result.capabilities.session"
    }
  },
  "message.result.capabilities.auth": {
    "status": {
      "place": "message.result.capabilities.auth.status"
    }
  },
  "message.result.capabilities.auth.status": {},
  "message.result.capabilities.providers": {},
  "message.result.capabilities.session": {
    "additionalDirectories": {
      "place": "message.result.capabilities.session.additionalDirectories"
    },
    "archive": {
      "place": "message.result.capabilities.session.archive"
    },
    "delete": {
      "place": "message.result.capabilities.session.delete"
    },
    "fork": {
      "place": "message.result.capabilities.session.fork"
    },
    "mcp": {
      "place": "message.result.capabilities.session.mcp"
    },
    "options": {
      "place": "message.result.capabilities.session.options"
    },
    "prompt": {
      "place": "message.result.capabilities.session.prompt"
    },
    "status": {
      "place": "message.result.capabilities.session.status"
    },
    "systemPrompt": {
      "place": "message.result.capabilities.session.systemPrompt"
    },
    "title": {
      "place": "message.result.capabilities.session.title"
    }
  },
  "message.result.capabilities.session.additionalDirectories": {},
  "message.result.capabilities.session.archive": {},
  "message.result.capabilities.session.delete": {},
  "message.result.capabilities.session.fork": {},
  "message.result.capabilities.session.mcp": {
    "acp": {
      "place": "message.result.capabilities.session.mcp.acp"
    },
    "http": {
      "place": "message.result.capabilities.session.mcp.http"
    },
    "stdio": {
      "place": "message.result.capabilities.session.mcp.stdio"
    }
  },
  "message.result.capabilities.session.mcp.acp": {},
  "message.result.capabilities.session.mcp.http": {},
  "message.result.capabilities.session.mcp.stdio": {},
  "message.result.capabilities.session.options": {},
  "message.result.capabilities.session.prompt": {
    "audio": {
      "place": "message.result.capabilities.session.prompt.audio"
    },
    "embeddedContext": {
      "place": "message.result.capabilities.session.prompt.embeddedContext"
    },
    "image": {
      "place": "message.result.capabilities.session.prompt.image"
    },
    "skill": {
      "place": "message.result.capabilities.session.prompt.skill"
    }
  },
  "message.result.capabilities.session.prompt.audio": {},
  "message.result.capabilities.session.prompt.embeddedContext": {},
  "message.result.capabilities.session.prompt.image": {},
  "message.result.capabilities.session.prompt.skill": {
    "inline": {
      "place": "message.result.capabilities.session.prompt.skill.inline"
    }
  },
  "message.result.capabilities.session.prompt.skill.inline": {},
  "message.result.capabilities.session.status": {},
  "message.result.capabilities.session.systemPrompt": {
    "mode": {
      "place": "message.result.capabilities.session.systemPrompt.mode"
    }
  },
  "message.result.capabilities.session.systemPrompt.mode": {
    "override": {
      "place": "message.result.capabilities.session.systemPrompt.mode.override"
    }
  },
  "message.result.capabilities.session.systemPrompt.mode.override": {},
  "message.result.capabilities.session.title": {},
  "message.result.configOptions": {
    "category": {
      "words": [
        "mode",
        "model",
        "model_config",
        "speed",
        "thought_level"
      ]
    },
    "options": {
      "place": "message.result.configOptions.options"
    },
    "type": {
      "words": [
        "boolean",
        "select"
      ]
    }
  },
  "message.result.configOptions.options": {
    "options": {
      "place": "message.result.configOptions.options.options"
    }
  },
  "message.result.configOptions.options.options": {},
  "message.result.info": {},
  "message.result.modes": {
    "availableModes": {
      "place": "message.result.modes.availableModes"
    }
  },
  "message.result.modes.availableModes": {},
  "message.result.providers": {
    "current": {
      "place": "message.result.providers.current"
    },
    "supported": {
      "words": [
        "anthropic",
        "azure",
        "bedrock",
        "openai",
        "vertex"
      ]
    }
  },
  "message.result.providers.current": {
    "apiType": {
      "words": [
        "anthropic",
        "azure",
        "bedrock",
        "openai",
        "vertex"
      ]
    }
  },
  "message.result.sessions": {},
  "message.result.state": {
    "background": {
      "place": "message.params.update.background"
    },
    "error": {
      "place": "message.params.update.error"
    },
    "state": {
      "words": [
        "idle",
        "requires_action",
        "running",
        "unknown"
      ]
    },
    "stopReason": {
      "words": [
        "cancelled",
        "end_turn",
        "error",
        "max_tokens",
        "max_turn_requests",
        "refusal"
      ]
    },
    "usage": {
      "place": "message.params.update.usage"
    }
  },
  "message.result.usage": {}
};
