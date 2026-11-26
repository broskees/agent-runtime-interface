// The Claude protocol words, by place (../protocol-places.ts): for every spot
// of an inbound Claude frame the pinned SDK's types describe, the string
// literals they allow as each key's value there, and where each object value
// goes on. Derived from @anthropic-ai/claude-agent-sdk 0.3.330's sdk.d.ts
// (and the @anthropic-ai/sdk types it imports) by ./derive-protocol-words.ts;
// test/recordings/protocol-words.test.ts fails when this and the derivation
// differ. To refresh after an SDK bump, run
// `node test/recordings/claude/derive-protocol-words.ts` and put its output
// here.
//
// The sanitiser keeps the user name in an inbound string only where the
// value is one of the words of its place's key: `type: "user"` of an SDK
// message and `role: "user"` of its `message` stay on an account named
// `user`. A value anywhere else (free text, an opaque tool result, a tool's
// name) is free text like any other.

import type { ProtocolWords } from "../protocol-places.ts";

export const CLAUDE_PROTOCOL_WORDS: ProtocolWords = {
  "": {
    "message": {
      "place": "message"
    },
    "options": {
      "place": "options"
    },
    "value": {
      "place": "value"
    }
  },
  "message": {
    "apiKeySource": {
      "words": [
        "/login managed key",
        "ANTHROPIC_API_KEY",
        "apiKeyHelper",
        "none",
        "oauth",
        "org",
        "project",
        "temporary",
        "user"
      ]
    },
    "commands": {
      "place": "message.commands"
    },
    "compact_metadata": {
      "place": "message.compact_metadata"
    },
    "compact_result": {
      "words": [
        "failed",
        "success"
      ]
    },
    "context_usage": {
      "place": "message.context_usage"
    },
    "deferred_tool_use": {
      "place": "message.deferred_tool_use"
    },
    "direction": {
      "words": [
        "retry",
        "revert",
        "sticky"
      ]
    },
    "effort": {
      "words": [
        "high",
        "low",
        "max",
        "medium",
        "xhigh"
      ]
    },
    "error": {
      "words": [
        "account_on_hold",
        "authentication_failed",
        "billing_error",
        "cloud_credential_error",
        "invalid_request",
        "max_output_tokens",
        "model_not_found",
        "oauth_org_not_allowed",
        "overloaded",
        "rate_limit",
        "server_error",
        "unknown",
        "verification_required"
      ]
    },
    "error_code": {
      "words": [
        "EDQUOT",
        "ENOSPC"
      ]
    },
    "event": {
      "place": "message.event"
    },
    "failed": {
      "place": "message.failed"
    },
    "fast_mode_disabled_reason": {
      "words": [
        "disabled_by_env",
        "extra_usage_disabled",
        "free",
        "model_not_allowed",
        "network_error",
        "not_first_party",
        "pending",
        "preference",
        "sdk_opt_in_required",
        "unknown"
      ]
    },
    "fast_mode_state": {
      "words": [
        "cooldown",
        "off",
        "on"
      ]
    },
    "files": {
      "place": "message.files"
    },
    "first_stream_post_queued_behind": {
      "words": [
        "durable_post",
        "ephemeral_post",
        "hold",
        "none",
        "retry_backoff"
      ]
    },
    "first_text_post_queued_behind": {
      "words": [
        "durable_post",
        "ephemeral_post",
        "hold",
        "none",
        "retry_backoff"
      ]
    },
    "invalid_config_file": {
      "place": "message.invalid_config_file"
    },
    "key": {
      "place": "message.key"
    },
    "level": {
      "words": [
        "info",
        "notice",
        "suggestion",
        "warning"
      ]
    },
    "lost": {
      "words": [
        "global_config",
        "transcript"
      ]
    },
    "mcp_servers": {
      "place": "message.mcp_servers"
    },
    "memories": {
      "place": "message.memories"
    },
    "message": {
      "place": "message.message"
    },
    "mode": {
      "words": [
        "select",
        "synthesize"
      ]
    },
    "modelUsage": {
      "place": "message.modelUsage"
    },
    "no_response": {
      "place": "message.no_response"
    },
    "origin": {
      "place": "message.origin"
    },
    "outcome": {
      "words": [
        "cancelled",
        "error",
        "success"
      ]
    },
    "pasted_content": {
      "place": "message.pasted_content"
    },
    "patch": {
      "place": "message.patch"
    },
    "permissionMode": {
      "words": [
        "acceptEdits",
        "auto",
        "bypassPermissions",
        "default",
        "dontAsk",
        "plan"
      ]
    },
    "permission_denials": {
      "place": "message.permission_denials"
    },
    "plugin_errors": {
      "place": "message.plugin_errors"
    },
    "plugins": {
      "place": "message.plugins"
    },
    "priority": {
      "words": [
        "high",
        "immediate",
        "later",
        "low",
        "medium",
        "next",
        "now"
      ]
    },
    "rate_limit_info": {
      "place": "message.rate_limit_info"
    },
    "reason": {
      "words": [
        "worker_restart"
      ]
    },
    "resource_links": {
      "place": "message.resource_links"
    },
    "scope": {
      "words": [
        "local",
        "session"
      ]
    },
    "startup_failure_reason": {
      "words": [
        "bypass_root",
        "cli_version_too_old",
        "config_file_invalid",
        "cwd_unavailable",
        "gateway_access_denied",
        "gateway_signin_required",
        "initialize_fields_not_delivered",
        "initialize_not_first",
        "managed_settings_invalid",
        "managed_settings_not_delivered",
        "org_config_refused",
        "org_config_required_unavailable",
        "org_pin_api_key_conflict",
        "org_pin_mismatch",
        "org_verify_failed",
        "provider_not_allowed",
        "proxy_invalid",
        "remote_settings_required_unavailable",
        "sandbox_required_unavailable",
        "session_held_by_background",
        "shell_tool_missing",
        "temp_dir_unusable",
        "worktree_resume_refused",
        "worktree_unverified"
      ]
    },
    "state": {
      "words": [
        "idle",
        "requires_action",
        "running"
      ]
    },
    "status": {
      "words": [
        "api_retry",
        "compacting",
        "completed",
        "failed",
        "installed",
        "requesting",
        "started",
        "stopped"
      ]
    },
    "subagent_retry": {
      "place": "message.subagent_retry"
    },
    "subtype": {
      "words": [
        "api_retry",
        "background_tasks_changed",
        "commands_changed",
        "compact_boundary",
        "control_request_progress",
        "elicitation_complete",
        "error_during_execution",
        "error_max_budget_usd",
        "error_max_structured_output_retries",
        "error_max_turns",
        "files_persisted",
        "hook_progress",
        "hook_response",
        "hook_started",
        "informational",
        "init",
        "local_command_output",
        "memory_recall",
        "mirror_error",
        "model_refusal_fallback",
        "model_refusal_no_fallback",
        "notification",
        "permission_denied",
        "plugin_install",
        "session_state_changed",
        "session_writes_lost",
        "status",
        "success",
        "task_notification",
        "task_progress",
        "task_started",
        "task_updated",
        "thinking_tokens",
        "worker_shutting_down"
      ]
    },
    "tasks": {
      "place": "message.tasks"
    },
    "terminal_reason": {
      "words": [
        "aborted_streaming",
        "aborted_tools",
        "api_error",
        "background_requested",
        "blocking_limit",
        "budget_exhausted",
        "completed",
        "hook_stopped",
        "image_error",
        "malformed_tool_use_exhausted",
        "max_turns",
        "model_error",
        "prompt_too_long",
        "rapid_refill_breaker",
        "stop_hook_prevented",
        "structured_output_retry_exhausted",
        "tool_deferred",
        "tool_deferred_unavailable",
        "turn_setup_failed"
      ]
    },
    "trigger": {
      "words": [
        "clear",
        "fresh_session",
        "onboarding",
        "plan_mode_exit",
        "refusal"
      ]
    },
    "type": {
      "words": [
        "assistant",
        "auth_status",
        "conversation_reset",
        "prompt_suggestion",
        "rate_limit_event",
        "result",
        "stream_event",
        "system",
        "tool_progress",
        "tool_use_summary",
        "user"
      ]
    },
    "usage": {
      "place": "message.usage"
    },
    "usage_report": {
      "place": "message.usage_report"
    },
    "view_mode": {
      "words": [
        "default",
        "focus"
      ]
    }
  },
  "message.commands": {},
  "message.compact_metadata": {
    "preserved_messages": {
      "place": "message.compact_metadata.preserved_messages"
    },
    "preserved_segment": {
      "place": "message.compact_metadata.preserved_segment"
    },
    "trigger": {
      "words": [
        "auto",
        "manual"
      ]
    }
  },
  "message.compact_metadata.preserved_messages": {},
  "message.compact_metadata.preserved_segment": {},
  "message.context_usage": {
    "agents": {
      "place": "message.context_usage.agents"
    },
    "categories": {
      "place": "message.context_usage.categories"
    },
    "mcp_tools": {
      "place": "message.context_usage.mcp_tools"
    },
    "memory_files": {
      "place": "message.context_usage.memory_files"
    },
    "over_limit": {
      "place": "message.context_usage.over_limit"
    },
    "skills": {
      "place": "message.context_usage.skills"
    }
  },
  "message.context_usage.agents": {},
  "message.context_usage.categories": {
    "kind": {
      "words": [
        "buffer",
        "deferred",
        "free",
        "used"
      ]
    }
  },
  "message.context_usage.mcp_tools": {},
  "message.context_usage.memory_files": {},
  "message.context_usage.over_limit": {
    "kind": {
      "words": [
        "compaction_window",
        "hard_limit"
      ]
    }
  },
  "message.context_usage.skills": {},
  "message.deferred_tool_use": {
    "input": {
      "place": "message.deferred_tool_use.input"
    }
  },
  "message.deferred_tool_use.input": {
    "*": {}
  },
  "message.event": {
    "content_block": {
      "place": "message.event.content_block"
    },
    "context_management": {
      "place": "message.event.context_management"
    },
    "delta": {
      "place": "message.event.delta"
    },
    "input_transformations": {
      "place": "message.event.input_transformations"
    },
    "message": {
      "place": "message.event.message"
    },
    "type": {
      "words": [
        "content_block_delta",
        "content_block_start",
        "content_block_stop",
        "message_delta",
        "message_start",
        "message_stop"
      ]
    },
    "usage": {
      "place": "message.event.usage"
    }
  },
  "message.event.content_block": {
    "caller": {
      "place": "message.event.content_block.caller"
    },
    "citations": {
      "place": "message.event.content_block.citations"
    },
    "content": {
      "place": "message.event.content_block.content"
    },
    "from": {
      "place": "message.event.content_block.from"
    },
    "input": {
      "place": "message.event.content_block.input"
    },
    "name": {
      "words": [
        "advisor",
        "bash_code_execution",
        "code_execution",
        "text_editor_code_execution",
        "tool_search_tool_bm25",
        "tool_search_tool_regex",
        "web_fetch",
        "web_search"
      ]
    },
    "to": {
      "place": "message.event.content_block.from"
    },
    "tool_changes": {
      "place": "message.event.content_block.tool_changes"
    },
    "tools": {
      "place": "message.event.content_block.tools"
    },
    "trigger": {
      "place": "message.event.content_block.trigger"
    },
    "type": {
      "words": [
        "advisor_tool_result",
        "bash_code_execution_tool_result",
        "code_execution_tool_result",
        "compaction",
        "container_upload",
        "fallback",
        "mcp_tool_listing",
        "mcp_tool_result",
        "mcp_tool_use",
        "redacted_thinking",
        "server_tool_use",
        "text",
        "text_editor_code_execution_tool_result",
        "thinking",
        "tool_search_tool_result",
        "tool_use",
        "web_fetch_tool_result",
        "web_search_tool_result"
      ]
    }
  },
  "message.event.content_block.caller": {
    "type": {
      "words": [
        "code_execution_20250825",
        "code_execution_20260120",
        "direct"
      ]
    }
  },
  "message.event.content_block.citations": {
    "type": {
      "words": [
        "char_location",
        "content_block_location",
        "page_location",
        "search_result_location",
        "web_search_result_location"
      ]
    }
  },
  "message.event.content_block.content": {
    "citations": {
      "place": "message.event.content_block.citations"
    },
    "content": {
      "place": "message.event.content_block.content.content"
    },
    "error_code": {
      "words": [
        "content_too_large",
        "execution_time_exceeded",
        "file_not_found",
        "invalid_tool_input",
        "max_uses_exceeded",
        "model_not_found",
        "output_file_too_large",
        "overloaded",
        "prompt_too_long",
        "query_too_long",
        "request_too_large",
        "too_many_requests",
        "unavailable",
        "unsupported_content_type",
        "url_not_accessible",
        "url_not_allowed",
        "url_not_in_prior_context",
        "url_too_long"
      ]
    },
    "file_type": {
      "words": [
        "image",
        "pdf",
        "text"
      ]
    },
    "tool_references": {
      "place": "message.event.content_block.content.tool_references"
    },
    "type": {
      "words": [
        "advisor_redacted_result",
        "advisor_result",
        "advisor_tool_result_error",
        "bash_code_execution_result",
        "bash_code_execution_tool_result_error",
        "code_execution_result",
        "code_execution_tool_result_error",
        "encrypted_code_execution_result",
        "text",
        "text_editor_code_execution_create_result",
        "text_editor_code_execution_str_replace_result",
        "text_editor_code_execution_tool_result_error",
        "text_editor_code_execution_view_result",
        "tool_search_tool_result_error",
        "tool_search_tool_search_result",
        "web_fetch_result",
        "web_fetch_tool_result_error",
        "web_search_result",
        "web_search_tool_result_error"
      ]
    }
  },
  "message.event.content_block.content.content": {
    "citations": {
      "place": "message.event.content_block.content.content.citations"
    },
    "source": {
      "place": "message.event.content_block.content.content.source"
    },
    "type": {
      "words": [
        "bash_code_execution_output",
        "code_execution_output",
        "document"
      ]
    }
  },
  "message.event.content_block.content.content.citations": {},
  "message.event.content_block.content.content.source": {
    "media_type": {
      "words": [
        "application/pdf",
        "text/plain"
      ]
    },
    "type": {
      "words": [
        "base64",
        "text"
      ]
    }
  },
  "message.event.content_block.content.tool_references": {
    "type": {
      "words": [
        "tool_reference"
      ]
    }
  },
  "message.event.content_block.from": {
    "model": {
      "words": [
        "claude-fable-5",
        "claude-fable-5-1",
        "claude-fable-5-2",
        "claude-haiku-4-5",
        "claude-haiku-4-5-20251001",
        "claude-haiku-5-5",
        "claude-mythos-5",
        "claude-mythos-5-1",
        "claude-mythos-5-2",
        "claude-mythos-preview",
        "claude-opus-4-5",
        "claude-opus-4-5-20251101",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-opus-5",
        "claude-opus-5-5",
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "claude-sonnet-5-5"
      ]
    }
  },
  "message.event.content_block.input": {
    "*": {}
  },
  "message.event.content_block.tool_changes": {
    "tool": {
      "place": "message.event.content_block.tool_changes.tool"
    },
    "type": {
      "words": [
        "tool_addition",
        "tool_removal"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool": {
    "definition": {
      "place": "message.event.content_block.tool_changes.tool.definition"
    },
    "type": {
      "words": [
        "mcp_tool_reference",
        "mcp_toolset_reference",
        "tool_definition",
        "tool_reference"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool.definition": {
    "allowed_callers": {
      "words": [
        "code_execution_20250825",
        "code_execution_20260120",
        "code_execution_20260521",
        "direct"
      ]
    },
    "cache_control": {
      "place": "message.event.content_block.tool_changes.tool.definition.cache_control"
    },
    "caching": {
      "place": "message.event.content_block.tool_changes.tool.definition.cache_control"
    },
    "citations": {
      "place": "message.event.content_block.tool_changes.tool.definition.citations"
    },
    "configs": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs"
    },
    "default_config": {
      "place": "message.event.content_block.tool_changes.tool.definition.default_config"
    },
    "input_examples": {
      "place": "message.event.content_block.tool_changes.tool.definition.input_examples"
    },
    "input_schema": {
      "place": "message.event.content_block.tool_changes.tool.definition.input_schema"
    },
    "model": {
      "words": [
        "claude-fable-5",
        "claude-fable-5-1",
        "claude-fable-5-2",
        "claude-haiku-4-5",
        "claude-haiku-4-5-20251001",
        "claude-haiku-5-5",
        "claude-mythos-5",
        "claude-mythos-5-1",
        "claude-mythos-5-2",
        "claude-mythos-preview",
        "claude-opus-4-5",
        "claude-opus-4-5-20251101",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-opus-5",
        "claude-opus-5-5",
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "claude-sonnet-5-5"
      ]
    },
    "name": {
      "words": [
        "advisor",
        "bash",
        "code_execution",
        "computer",
        "memory",
        "str_replace_based_edit_tool",
        "str_replace_editor",
        "tool_search_tool_bm25",
        "tool_search_tool_regex",
        "web_fetch",
        "web_search"
      ]
    },
    "response_inclusion": {
      "words": [
        "excluded",
        "full"
      ]
    },
    "tools": {
      "place": "message.event.content_block.tool_changes.tool.definition.tools"
    },
    "type": {
      "words": [
        "advisor_20260301",
        "bash_20241022",
        "bash_20250124",
        "browser_toolset_20260801",
        "code_execution_20250522",
        "code_execution_20250825",
        "code_execution_20260120",
        "code_execution_20260521",
        "computer_20241022",
        "computer_20250124",
        "computer_20251124",
        "computer_toolset_20260801",
        "custom",
        "mcp_toolset",
        "memory_20250818",
        "text_editor_20241022",
        "text_editor_20250124",
        "text_editor_20250429",
        "text_editor_20250728",
        "tool_search_tool_bm25",
        "tool_search_tool_bm25_20251119",
        "tool_search_tool_regex",
        "tool_search_tool_regex_20251119",
        "web_fetch_20250910",
        "web_fetch_20260209",
        "web_fetch_20260309",
        "web_fetch_20260318",
        "web_search_20250305",
        "web_search_20260209",
        "web_search_20260318"
      ]
    },
    "url_sources": {
      "place": "message.event.content_block.tool_changes.tool.definition.url_sources"
    },
    "user_location": {
      "place": "message.event.content_block.tool_changes.tool.definition.user_location"
    }
  },
  "message.event.content_block.tool_changes.tool.definition.cache_control": {
    "ttl": {
      "words": [
        "1h",
        "5m"
      ]
    },
    "type": {
      "words": [
        "ephemeral"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool.definition.citations": {},
  "message.event.content_block.tool_changes.tool.definition.configs": {
    "*": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.*"
    },
    "close_tab": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.close_tab"
    },
    "cursor_position": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.cursor_position"
    },
    "double_click": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.double_click"
    },
    "file_upload": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.file_upload"
    },
    "find": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.find"
    },
    "form_input": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.form_input"
    },
    "get_page_text": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.get_page_text"
    },
    "hold_key": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.hold_key"
    },
    "hover": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.hover"
    },
    "javascript_exec": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.javascript_exec"
    },
    "key": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.key"
    },
    "left_click": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.left_click"
    },
    "left_click_drag": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.left_click_drag"
    },
    "left_mouse_down": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.left_mouse_down"
    },
    "left_mouse_up": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.left_mouse_up"
    },
    "list_tabs": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.list_tabs"
    },
    "middle_click": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.middle_click"
    },
    "mouse_move": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.mouse_move"
    },
    "navigate": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.navigate"
    },
    "new_tab": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.new_tab"
    },
    "read_console": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.read_console"
    },
    "read_network": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.read_network"
    },
    "read_page": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.read_page"
    },
    "right_click": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.right_click"
    },
    "screenshot": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.screenshot"
    },
    "scroll": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.scroll"
    },
    "scroll_to": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.scroll_to"
    },
    "switch_tab": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.switch_tab"
    },
    "triple_click": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.triple_click"
    },
    "type": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.type"
    },
    "wait": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.wait"
    },
    "zoom": {
      "place": "message.event.content_block.tool_changes.tool.definition.configs.zoom"
    }
  },
  "message.event.content_block.tool_changes.tool.definition.configs.*": {},
  "message.event.content_block.tool_changes.tool.definition.configs.close_tab": {},
  "message.event.content_block.tool_changes.tool.definition.configs.cursor_position": {},
  "message.event.content_block.tool_changes.tool.definition.configs.double_click": {},
  "message.event.content_block.tool_changes.tool.definition.configs.file_upload": {},
  "message.event.content_block.tool_changes.tool.definition.configs.find": {},
  "message.event.content_block.tool_changes.tool.definition.configs.form_input": {},
  "message.event.content_block.tool_changes.tool.definition.configs.get_page_text": {},
  "message.event.content_block.tool_changes.tool.definition.configs.hold_key": {},
  "message.event.content_block.tool_changes.tool.definition.configs.hover": {},
  "message.event.content_block.tool_changes.tool.definition.configs.javascript_exec": {},
  "message.event.content_block.tool_changes.tool.definition.configs.key": {},
  "message.event.content_block.tool_changes.tool.definition.configs.left_click": {},
  "message.event.content_block.tool_changes.tool.definition.configs.left_click_drag": {},
  "message.event.content_block.tool_changes.tool.definition.configs.left_mouse_down": {},
  "message.event.content_block.tool_changes.tool.definition.configs.left_mouse_up": {},
  "message.event.content_block.tool_changes.tool.definition.configs.list_tabs": {},
  "message.event.content_block.tool_changes.tool.definition.configs.middle_click": {},
  "message.event.content_block.tool_changes.tool.definition.configs.mouse_move": {},
  "message.event.content_block.tool_changes.tool.definition.configs.navigate": {},
  "message.event.content_block.tool_changes.tool.definition.configs.new_tab": {},
  "message.event.content_block.tool_changes.tool.definition.configs.read_console": {},
  "message.event.content_block.tool_changes.tool.definition.configs.read_network": {},
  "message.event.content_block.tool_changes.tool.definition.configs.read_page": {},
  "message.event.content_block.tool_changes.tool.definition.configs.right_click": {},
  "message.event.content_block.tool_changes.tool.definition.configs.screenshot": {},
  "message.event.content_block.tool_changes.tool.definition.configs.scroll": {},
  "message.event.content_block.tool_changes.tool.definition.configs.scroll_to": {},
  "message.event.content_block.tool_changes.tool.definition.configs.switch_tab": {},
  "message.event.content_block.tool_changes.tool.definition.configs.triple_click": {},
  "message.event.content_block.tool_changes.tool.definition.configs.type": {},
  "message.event.content_block.tool_changes.tool.definition.configs.wait": {},
  "message.event.content_block.tool_changes.tool.definition.configs.zoom": {},
  "message.event.content_block.tool_changes.tool.definition.default_config": {},
  "message.event.content_block.tool_changes.tool.definition.input_examples": {
    "*": {}
  },
  "message.event.content_block.tool_changes.tool.definition.input_schema": {
    "*": {},
    "properties": {
      "place": "message.event.content_block.tool_changes.tool.definition.input_schema.properties"
    },
    "required": {},
    "type": {
      "words": [
        "object"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool.definition.input_schema.properties": {
    "*": {}
  },
  "message.event.content_block.tool_changes.tool.definition.tools": {
    "input_schema": {
      "place": "message.event.content_block.tool_changes.tool.definition.tools.input_schema"
    }
  },
  "message.event.content_block.tool_changes.tool.definition.tools.input_schema": {
    "*": {}
  },
  "message.event.content_block.tool_changes.tool.definition.url_sources": {
    "client_tool_results": {
      "place": "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results"
    },
    "server_tool_results": {
      "place": "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results"
    },
    "user_input": {
      "place": "message.event.content_block.tool_changes.tool.definition.url_sources.user_input"
    }
  },
  "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results": {
    "tools": {
      "place": "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results.tools"
    },
    "type": {
      "words": [
        "all",
        "except",
        "none",
        "only"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results.tools": {
    "type": {
      "words": [
        "tool_reference"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool.definition.url_sources.user_input": {
    "type": {
      "words": [
        "all",
        "none"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool.definition.user_location": {
    "type": {
      "words": [
        "approximate"
      ]
    }
  },
  "message.event.content_block.tools": {
    "input_schema": {
      "place": "message.event.content_block.tools.input_schema"
    }
  },
  "message.event.content_block.tools.input_schema": {
    "*": {}
  },
  "message.event.content_block.trigger": {
    "category": {
      "words": [
        "bio",
        "cyber",
        "frontier_llm",
        "general_harms",
        "reasoning_extraction"
      ]
    },
    "type": {
      "words": [
        "refusal"
      ]
    }
  },
  "message.event.context_management": {
    "applied_edits": {
      "place": "message.event.context_management.applied_edits"
    }
  },
  "message.event.context_management.applied_edits": {
    "type": {
      "words": [
        "clear_thinking_20251015",
        "clear_tool_uses_20250919"
      ]
    }
  },
  "message.event.delta": {
    "citation": {
      "place": "message.event.content_block.citations"
    },
    "container": {
      "place": "message.message.container"
    },
    "stop_details": {
      "place": "message.message.stop_details"
    },
    "stop_reason": {
      "words": [
        "compaction",
        "end_turn",
        "max_tokens",
        "model_context_window_exceeded",
        "pause_turn",
        "refusal",
        "stop_sequence",
        "tool_use"
      ]
    },
    "type": {
      "words": [
        "citations_delta",
        "compaction_delta",
        "input_json_delta",
        "signature_delta",
        "text_delta",
        "thinking_delta"
      ]
    }
  },
  "message.event.input_transformations": {
    "reason": {
      "words": [
        "end_user_binding_mismatch",
        "model_binding_mismatch",
        "organization_binding_mismatch",
        "prefix_binding_mismatch"
      ]
    },
    "type": {
      "words": [
        "thinking_dropped",
        "thinking_mismatch_allowed"
      ]
    }
  },
  "message.event.message": {
    "container": {
      "place": "message.message.container"
    },
    "content": {
      "place": "message.event.content_block"
    },
    "context_management": {
      "place": "message.event.context_management"
    },
    "diagnostics": {
      "place": "message.message.diagnostics"
    },
    "input_transformations": {
      "place": "message.event.input_transformations"
    },
    "model": {
      "words": [
        "claude-fable-5",
        "claude-fable-5-1",
        "claude-fable-5-2",
        "claude-haiku-4-5",
        "claude-haiku-4-5-20251001",
        "claude-haiku-5-5",
        "claude-mythos-5",
        "claude-mythos-5-1",
        "claude-mythos-5-2",
        "claude-mythos-preview",
        "claude-opus-4-5",
        "claude-opus-4-5-20251101",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-opus-5",
        "claude-opus-5-5",
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "claude-sonnet-5-5"
      ]
    },
    "role": {
      "words": [
        "assistant"
      ]
    },
    "stop_details": {
      "place": "message.message.stop_details"
    },
    "stop_reason": {
      "words": [
        "compaction",
        "end_turn",
        "max_tokens",
        "model_context_window_exceeded",
        "pause_turn",
        "refusal",
        "stop_sequence",
        "tool_use"
      ]
    },
    "type": {
      "words": [
        "message"
      ]
    },
    "usage": {
      "place": "message.message.usage"
    }
  },
  "message.event.usage": {
    "fallback_credit": {
      "place": "message.usage.fallback_credit"
    },
    "iterations": {
      "place": "message.usage.iterations"
    },
    "output_tokens_details": {
      "place": "message.usage.output_tokens_details"
    },
    "server_tool_use": {
      "place": "message.usage.server_tool_use"
    }
  },
  "message.failed": {},
  "message.files": {},
  "message.invalid_config_file": {},
  "message.key": {},
  "message.mcp_servers": {},
  "message.memories": {
    "scope": {
      "words": [
        "organization",
        "personal",
        "team"
      ]
    }
  },
  "message.message": {
    "container": {
      "place": "message.message.container"
    },
    "content": {
      "place": "message.message.content"
    },
    "context_management": {
      "place": "message.event.context_management"
    },
    "diagnostics": {
      "place": "message.message.diagnostics"
    },
    "input_transformations": {
      "place": "message.event.input_transformations"
    },
    "model": {
      "words": [
        "claude-fable-5",
        "claude-fable-5-1",
        "claude-fable-5-2",
        "claude-haiku-4-5",
        "claude-haiku-4-5-20251001",
        "claude-haiku-5-5",
        "claude-mythos-5",
        "claude-mythos-5-1",
        "claude-mythos-5-2",
        "claude-mythos-preview",
        "claude-opus-4-5",
        "claude-opus-4-5-20251101",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-opus-5",
        "claude-opus-5-5",
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "claude-sonnet-5-5"
      ]
    },
    "role": {
      "words": [
        "assistant",
        "system",
        "user"
      ]
    },
    "stop_details": {
      "place": "message.message.stop_details"
    },
    "stop_reason": {
      "words": [
        "compaction",
        "end_turn",
        "max_tokens",
        "model_context_window_exceeded",
        "pause_turn",
        "refusal",
        "stop_sequence",
        "tool_use"
      ]
    },
    "type": {
      "words": [
        "message"
      ]
    },
    "usage": {
      "place": "message.message.usage"
    }
  },
  "message.message.container": {
    "skills": {
      "place": "message.message.container.skills"
    }
  },
  "message.message.container.skills": {
    "type": {
      "words": [
        "anthropic",
        "custom"
      ]
    }
  },
  "message.message.content": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "caller": {
      "place": "message.message.content.caller"
    },
    "citations": {
      "place": "message.message.content.citations"
    },
    "content": {
      "place": "message.message.content.content"
    },
    "from": {
      "place": "message.event.content_block.from"
    },
    "input": {
      "place": "message.event.content_block.input"
    },
    "name": {
      "words": [
        "advisor",
        "bash_code_execution",
        "code_execution",
        "text_editor_code_execution",
        "tool_search_tool_bm25",
        "tool_search_tool_regex",
        "web_fetch",
        "web_search"
      ]
    },
    "source": {
      "place": "message.pasted_content.source"
    },
    "to": {
      "place": "message.event.content_block.from"
    },
    "tool_changes": {
      "place": "message.event.content_block.tool_changes"
    },
    "tools": {
      "place": "message.event.content_block.tools"
    },
    "transformations": {
      "place": "message.pasted_content.transformations"
    },
    "trigger": {
      "place": "message.event.content_block.trigger"
    },
    "type": {
      "words": [
        "advisor_tool_result",
        "bash_code_execution_tool_result",
        "code_execution_tool_result",
        "compaction",
        "container_upload",
        "document",
        "fallback",
        "image",
        "mcp_tool_listing",
        "mcp_tool_result",
        "mcp_tool_use",
        "redacted_thinking",
        "search_result",
        "server_tool_use",
        "text",
        "text_editor_code_execution_tool_result",
        "thinking",
        "tool_result",
        "tool_search_tool_result",
        "tool_use",
        "web_fetch_tool_result",
        "web_search_tool_result"
      ]
    }
  },
  "message.message.content.caller": {
    "type": {
      "words": [
        "code_execution_20250825",
        "code_execution_20260120",
        "direct"
      ]
    }
  },
  "message.message.content.citations": {
    "type": {
      "words": [
        "char_location",
        "content_block_location",
        "page_location",
        "search_result_location",
        "web_search_result_location"
      ]
    }
  },
  "message.message.content.content": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "citations": {
      "place": "message.message.content.citations"
    },
    "content": {
      "place": "message.message.content.content.content"
    },
    "error_code": {
      "words": [
        "content_too_large",
        "execution_time_exceeded",
        "file_not_found",
        "invalid_tool_input",
        "max_uses_exceeded",
        "model_not_found",
        "output_file_too_large",
        "overloaded",
        "prompt_too_long",
        "query_too_long",
        "request_too_large",
        "too_many_requests",
        "unavailable",
        "unsupported_content_type",
        "url_not_accessible",
        "url_not_allowed",
        "url_not_in_prior_context",
        "url_too_long"
      ]
    },
    "file_type": {
      "words": [
        "image",
        "pdf",
        "text"
      ]
    },
    "source": {
      "place": "message.pasted_content.source"
    },
    "state_changes": {
      "place": "message.pasted_content.content.state_changes"
    },
    "tabs": {
      "place": "message.pasted_content.content.tabs"
    },
    "tool_references": {
      "place": "message.message.content.content.tool_references"
    },
    "transformations": {
      "place": "message.pasted_content.transformations"
    },
    "type": {
      "words": [
        "advisor_redacted_result",
        "advisor_result",
        "advisor_tool_result_error",
        "bash_code_execution_result",
        "bash_code_execution_tool_result_error",
        "browser_state",
        "code_execution_result",
        "code_execution_tool_result_error",
        "document",
        "encrypted_code_execution_result",
        "image",
        "search_result",
        "text",
        "text_editor_code_execution_create_result",
        "text_editor_code_execution_str_replace_result",
        "text_editor_code_execution_tool_result_error",
        "text_editor_code_execution_view_result",
        "tool_reference",
        "tool_search_tool_result_error",
        "tool_search_tool_search_result",
        "web_fetch_result",
        "web_fetch_tool_result_error",
        "web_search_result",
        "web_search_tool_result_error"
      ]
    }
  },
  "message.message.content.content.content": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "citations": {
      "place": "message.message.content.content.content.citations"
    },
    "source": {
      "place": "message.message.content.content.content.source"
    },
    "type": {
      "words": [
        "bash_code_execution_output",
        "code_execution_output",
        "document",
        "text"
      ]
    }
  },
  "message.message.content.content.content.citations": {
    "type": {
      "words": [
        "char_location",
        "content_block_location",
        "page_location",
        "search_result_location",
        "web_search_result_location"
      ]
    }
  },
  "message.message.content.content.content.source": {
    "content": {
      "place": "message.pasted_content.source.content"
    },
    "media_type": {
      "words": [
        "application/pdf",
        "text/plain"
      ]
    },
    "type": {
      "words": [
        "base64",
        "content",
        "file",
        "text",
        "url"
      ]
    }
  },
  "message.message.content.content.tool_references": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "type": {
      "words": [
        "tool_reference"
      ]
    }
  },
  "message.message.diagnostics": {
    "cache_miss_reason": {
      "place": "message.message.diagnostics.cache_miss_reason"
    }
  },
  "message.message.diagnostics.cache_miss_reason": {
    "type": {
      "words": [
        "messages_changed",
        "model_changed",
        "previous_message_not_found",
        "system_changed",
        "tools_changed",
        "unavailable"
      ]
    }
  },
  "message.message.stop_details": {
    "category": {
      "words": [
        "bio",
        "cyber",
        "frontier_llm",
        "general_harms",
        "reasoning_extraction"
      ]
    },
    "type": {
      "words": [
        "refusal"
      ]
    }
  },
  "message.message.usage": {
    "cache_creation": {
      "place": "message.usage.cache_creation"
    },
    "fallback_credit": {
      "place": "message.usage.fallback_credit"
    },
    "iterations": {
      "place": "message.usage.iterations"
    },
    "output_tokens_details": {
      "place": "message.usage.output_tokens_details"
    },
    "server_tool_use": {
      "place": "message.usage.server_tool_use"
    },
    "service_tier": {
      "words": [
        "batch",
        "priority",
        "standard"
      ]
    },
    "speed": {
      "words": [
        "fast",
        "standard"
      ]
    }
  },
  "message.modelUsage": {
    "*": {
      "place": "message.modelUsage.*"
    }
  },
  "message.modelUsage.*": {
    "costBasis": {
      "words": [
        "list",
        "managed",
        "unknown"
      ]
    }
  },
  "message.no_response": {},
  "message.origin": {
    "fromMode": {
      "words": [
        "bypass",
        "prompting"
      ]
    },
    "kind": {
      "words": [
        "auto-continuation",
        "channel",
        "coordinator",
        "human",
        "observer",
        "observer-activity",
        "peer",
        "task-notification",
        "unclassified"
      ]
    },
    "subkind": {
      "words": [
        "external-event",
        "peer-send-message",
        "projects-relay",
        "scheduled-trigger",
        "session-inbox"
      ]
    }
  },
  "message.pasted_content": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "caller": {
      "place": "message.pasted_content.caller"
    },
    "citations": {
      "place": "message.pasted_content.citations"
    },
    "content": {
      "place": "message.pasted_content.content"
    },
    "name": {
      "words": [
        "bash_code_execution",
        "code_execution",
        "text_editor_code_execution",
        "tool_search_tool_bm25",
        "tool_search_tool_regex",
        "web_fetch",
        "web_search"
      ]
    },
    "source": {
      "place": "message.pasted_content.source"
    },
    "transformations": {
      "place": "message.pasted_content.transformations"
    },
    "type": {
      "words": [
        "bash_code_execution_tool_result",
        "code_execution_tool_result",
        "container_upload",
        "document",
        "image",
        "redacted_thinking",
        "search_result",
        "server_tool_use",
        "text",
        "text_editor_code_execution_tool_result",
        "thinking",
        "tool_result",
        "tool_search_tool_result",
        "tool_use",
        "web_fetch_tool_result",
        "web_search_tool_result"
      ]
    }
  },
  "message.pasted_content.cache_control": {
    "ttl": {
      "words": [
        "1h",
        "5m"
      ]
    },
    "type": {
      "words": [
        "ephemeral"
      ]
    }
  },
  "message.pasted_content.caller": {
    "type": {
      "words": [
        "code_execution_20250825",
        "code_execution_20260120",
        "direct"
      ]
    }
  },
  "message.pasted_content.citations": {
    "type": {
      "words": [
        "char_location",
        "content_block_location",
        "page_location",
        "search_result_location",
        "web_search_result_location"
      ]
    }
  },
  "message.pasted_content.content": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "citations": {
      "place": "message.pasted_content.citations"
    },
    "content": {
      "place": "message.pasted_content.content.content"
    },
    "error_code": {
      "words": [
        "content_too_large",
        "execution_time_exceeded",
        "file_not_found",
        "invalid_tool_input",
        "max_uses_exceeded",
        "output_file_too_large",
        "query_too_long",
        "request_too_large",
        "too_many_requests",
        "unavailable",
        "unsupported_content_type",
        "url_not_accessible",
        "url_not_allowed",
        "url_not_in_prior_context",
        "url_too_long"
      ]
    },
    "file_type": {
      "words": [
        "image",
        "pdf",
        "text"
      ]
    },
    "source": {
      "place": "message.pasted_content.source"
    },
    "state_changes": {
      "place": "message.pasted_content.content.state_changes"
    },
    "tabs": {
      "place": "message.pasted_content.content.tabs"
    },
    "tool_references": {
      "place": "message.pasted_content.content.tool_references"
    },
    "transformations": {
      "place": "message.pasted_content.transformations"
    },
    "type": {
      "words": [
        "bash_code_execution_result",
        "bash_code_execution_tool_result_error",
        "browser_state",
        "code_execution_result",
        "code_execution_tool_result_error",
        "document",
        "encrypted_code_execution_result",
        "image",
        "search_result",
        "text",
        "text_editor_code_execution_create_result",
        "text_editor_code_execution_str_replace_result",
        "text_editor_code_execution_tool_result_error",
        "text_editor_code_execution_view_result",
        "tool_reference",
        "tool_search_tool_result_error",
        "tool_search_tool_search_result",
        "web_fetch_result",
        "web_fetch_tool_result_error",
        "web_search_result",
        "web_search_tool_result_error"
      ]
    }
  },
  "message.pasted_content.content.content": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "citations": {
      "place": "message.pasted_content.citations"
    },
    "source": {
      "place": "message.pasted_content.content.content.source"
    },
    "type": {
      "words": [
        "bash_code_execution_output",
        "code_execution_output",
        "document",
        "text"
      ]
    }
  },
  "message.pasted_content.content.content.source": {
    "content": {
      "place": "message.pasted_content.source.content"
    },
    "media_type": {
      "words": [
        "application/pdf",
        "text/plain"
      ]
    },
    "type": {
      "words": [
        "base64",
        "content",
        "file",
        "text",
        "url"
      ]
    }
  },
  "message.pasted_content.content.state_changes": {
    "type": {
      "words": [
        "download_completed",
        "download_failed",
        "download_started",
        "tab_opened"
      ]
    }
  },
  "message.pasted_content.content.tabs": {},
  "message.pasted_content.content.tool_references": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "type": {
      "words": [
        "tool_reference"
      ]
    }
  },
  "message.pasted_content.source": {
    "content": {
      "place": "message.pasted_content.source.content"
    },
    "media_type": {
      "words": [
        "application/pdf",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp",
        "text/plain"
      ]
    },
    "type": {
      "words": [
        "base64",
        "content",
        "file",
        "text",
        "url"
      ]
    }
  },
  "message.pasted_content.source.content": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "citations": {
      "place": "message.pasted_content.source.content.citations"
    },
    "source": {
      "place": "message.pasted_content.source.content.source"
    },
    "transformations": {
      "place": "message.pasted_content.transformations"
    },
    "type": {
      "words": [
        "image",
        "text"
      ]
    }
  },
  "message.pasted_content.source.content.citations": {
    "type": {
      "words": [
        "char_location",
        "content_block_location",
        "page_location",
        "search_result_location",
        "web_search_result_location"
      ]
    }
  },
  "message.pasted_content.source.content.source": {
    "media_type": {
      "words": [
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp"
      ]
    },
    "type": {
      "words": [
        "base64",
        "file",
        "url"
      ]
    }
  },
  "message.pasted_content.transformations": {
    "oversized_image": {
      "words": [
        "downsize",
        "error"
      ]
    }
  },
  "message.patch": {
    "status": {
      "words": [
        "completed",
        "failed",
        "killed",
        "paused",
        "pending",
        "running"
      ]
    }
  },
  "message.permission_denials": {
    "tool_input": {
      "place": "message.deferred_tool_use.input"
    }
  },
  "message.plugin_errors": {
    "managed_lock": {
      "place": "message.plugin_errors.managed_lock"
    }
  },
  "message.plugin_errors.managed_lock": {},
  "message.plugins": {},
  "message.rate_limit_info": {
    "errorCode": {
      "words": [
        "credits_required"
      ]
    },
    "limitScope": {
      "words": [
        "channel",
        "group_pool",
        "service"
      ]
    },
    "overageDisabledReason": {
      "words": [
        "fetch_error",
        "group_zero_credit_limit",
        "member_level_disabled",
        "member_zero_credit_limit",
        "no_limits_configured",
        "org_level_disabled",
        "org_level_disabled_until",
        "org_service_level_disabled",
        "out_of_credits",
        "overage_not_provisioned",
        "seat_tier_level_disabled",
        "seat_tier_zero_credit_limit",
        "unknown"
      ]
    },
    "overageStatus": {
      "words": [
        "allowed",
        "allowed_warning",
        "rejected"
      ]
    },
    "rateLimitType": {
      "words": [
        "five_hour",
        "overage",
        "seven_day",
        "seven_day_opus",
        "seven_day_overage_included",
        "seven_day_sonnet"
      ]
    },
    "status": {
      "words": [
        "allowed",
        "allowed_warning",
        "rejected"
      ]
    }
  },
  "message.resource_links": {
    "annotations": {
      "place": "message.deferred_tool_use.input"
    }
  },
  "message.subagent_retry": {},
  "message.tasks": {},
  "message.usage": {
    "cache_creation": {
      "place": "message.usage.cache_creation"
    },
    "fallback_credit": {
      "place": "message.usage.fallback_credit"
    },
    "iterations": {
      "place": "message.usage.iterations"
    },
    "output_tokens_details": {
      "place": "message.usage.output_tokens_details"
    },
    "server_tool_use": {
      "place": "message.usage.server_tool_use"
    },
    "service_tier": {
      "words": [
        "batch",
        "priority",
        "standard"
      ]
    },
    "speed": {
      "words": [
        "fast",
        "standard"
      ]
    }
  },
  "message.usage.cache_creation": {},
  "message.usage.fallback_credit": {
    "status": {
      "place": "message.usage.fallback_credit.status"
    }
  },
  "message.usage.fallback_credit.status": {
    "reason": {
      "words": [
        "body_mismatch",
        "continuation_excluded",
        "continuation_only",
        "expired",
        "invalid_target_model",
        "not_enabled",
        "reprice_unavailable",
        "temporarily_unavailable",
        "variant_fields_present",
        "wrong_organization",
        "wrong_platform",
        "wrong_workspace"
      ]
    },
    "type": {
      "words": [
        "not_applied",
        "redeemed"
      ]
    }
  },
  "message.usage.iterations": {
    "cache_creation": {
      "place": "message.usage.cache_creation"
    },
    "model": {
      "words": [
        "claude-fable-5",
        "claude-fable-5-1",
        "claude-fable-5-2",
        "claude-haiku-4-5",
        "claude-haiku-4-5-20251001",
        "claude-haiku-5-5",
        "claude-mythos-5",
        "claude-mythos-5-1",
        "claude-mythos-5-2",
        "claude-mythos-preview",
        "claude-opus-4-5",
        "claude-opus-4-5-20251101",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-opus-5",
        "claude-opus-5-5",
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "claude-sonnet-5-5"
      ]
    },
    "type": {
      "words": [
        "advisor_message",
        "compaction",
        "fallback_message",
        "message"
      ]
    }
  },
  "message.usage.output_tokens_details": {},
  "message.usage.server_tool_use": {},
  "message.usage_report": {
    "rate_limits": {
      "place": "message.usage_report.rate_limits"
    },
    "session": {
      "place": "message.usage_report.session"
    }
  },
  "message.usage_report.rate_limits": {
    "extra_usage": {
      "place": "message.usage_report.rate_limits.extra_usage"
    },
    "limits": {
      "place": "message.usage_report.rate_limits.limits"
    }
  },
  "message.usage_report.rate_limits.extra_usage": {},
  "message.usage_report.rate_limits.limits": {
    "scope": {
      "place": "message.usage_report.rate_limits.limits.scope"
    }
  },
  "message.usage_report.rate_limits.limits.scope": {
    "model": {
      "place": "message.usage_report.rate_limits.limits.scope.model"
    },
    "surface": {
      "place": "message.usage_report.rate_limits.limits.scope.surface"
    }
  },
  "message.usage_report.rate_limits.limits.scope.model": {},
  "message.usage_report.rate_limits.limits.scope.surface": {},
  "message.usage_report.session": {
    "model_usage": {
      "place": "message.modelUsage"
    }
  },
  "options": {
    "matchedAskRule": {
      "place": "options.matchedAskRule"
    },
    "mcpServer": {
      "place": "options.mcpServer"
    },
    "signal": {
      "place": "options.signal"
    },
    "suggestions": {
      "place": "options.suggestions"
    }
  },
  "options.matchedAskRule": {},
  "options.mcpServer": {},
  "options.signal": {},
  "options.suggestions": {
    "behavior": {
      "words": [
        "allow",
        "ask",
        "deny"
      ]
    },
    "destination": {
      "words": [
        "cliArg",
        "localSettings",
        "projectSettings",
        "session",
        "userSettings"
      ]
    },
    "mode": {
      "words": [
        "acceptEdits",
        "auto",
        "bypassPermissions",
        "default",
        "dontAsk",
        "plan"
      ]
    },
    "rules": {
      "place": "options.suggestions.rules"
    },
    "type": {
      "words": [
        "addDirectories",
        "addRules",
        "removeDirectories",
        "removeRules",
        "replaceRules",
        "setMode"
      ]
    }
  },
  "options.suggestions.rules": {},
  "value": {
    "account": {
      "place": "value.account"
    },
    "agents": {
      "place": "value.agents"
    },
    "commands": {
      "place": "message.commands"
    },
    "errors": {
      "place": "value.errors"
    },
    "fast_mode_disabled_reason": {
      "words": [
        "disabled_by_env",
        "extra_usage_disabled",
        "free",
        "model_not_allowed",
        "network_error",
        "not_first_party",
        "pending",
        "preference",
        "sdk_opt_in_required",
        "unknown"
      ]
    },
    "fast_mode_state": {
      "words": [
        "cooldown",
        "off",
        "on"
      ]
    },
    "models": {
      "place": "value.models"
    },
    "sdk_mcp_manifests_parked": {
      "place": "value.sdk_mcp_manifests_parked"
    },
    "supportedEffortLevels": {
      "words": [
        "high",
        "low",
        "max",
        "medium",
        "xhigh"
      ]
    },
    "type": {
      "words": [
        "assistant",
        "system",
        "user"
      ]
    }
  },
  "value.account": {
    "apiProvider": {
      "words": [
        "anthropicAws",
        "anthropicGoogleCloud",
        "bedrock",
        "firstParty",
        "foundry",
        "gateway",
        "mantle",
        "vertex"
      ]
    }
  },
  "value.agents": {},
  "value.errors": {
    "*": {}
  },
  "value.models": {
    "supportedEffortLevels": {
      "words": [
        "high",
        "low",
        "max",
        "medium",
        "xhigh"
      ]
    }
  },
  "value.sdk_mcp_manifests_parked": {
    "*": {
      "words": [
        "already_connected",
        "malformed",
        "not_honoured",
        "parked",
        "protocol_version_mismatch"
      ]
    }
  }
};
