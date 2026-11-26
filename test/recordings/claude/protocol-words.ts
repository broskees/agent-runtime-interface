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
      ],
      "variants": {
        "assistant": "message[type=assistant]",
        "auth_status": "message[type=auth_status]",
        "conversation_reset": "message[type=conversation_reset]",
        "prompt_suggestion": "message[type=prompt_suggestion]",
        "rate_limit_event": "message[type=rate_limit_event]",
        "result": "message[type=result]",
        "stream_event": "message[type=stream_event]",
        "system": "message[type=system]",
        "tool_progress": "message[type=tool_progress]",
        "tool_use_summary": "message[type=tool_use_summary]",
        "user": "message[type=user]"
      }
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
      ],
      "variants": {
        "content_block_delta": "message.event[type=content_block_delta]",
        "content_block_start": "message.event[type=content_block_start]",
        "content_block_stop": "message.event[type=content_block_stop]",
        "message_delta": "message.event[type=message_delta]",
        "message_start": "message.event[type=message_start]",
        "message_stop": "message.event[type=message_stop]"
      }
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
      ],
      "variants": {
        "advisor_tool_result": "message.event.content_block[type=advisor_tool_result]",
        "bash_code_execution_tool_result": "message.event.content_block[type=bash_code_execution_tool_result]",
        "code_execution_tool_result": "message.event.content_block[type=code_execution_tool_result]",
        "compaction": "message.event.content_block[type=compaction]",
        "container_upload": "message.event.content_block[type=container_upload]",
        "fallback": "message.event.content_block[type=fallback]",
        "mcp_tool_listing": "message.event.content_block[type=mcp_tool_listing]",
        "mcp_tool_result": "message.event.content_block[type=mcp_tool_result]",
        "mcp_tool_use": "message.event.content_block[type=mcp_tool_use]",
        "redacted_thinking": "message.event.content_block[type=redacted_thinking]",
        "server_tool_use": "message.event.content_block[type=server_tool_use]",
        "text": "message.event.content_block[type=text]",
        "text_editor_code_execution_tool_result": "message.event.content_block[type=text_editor_code_execution_tool_result]",
        "thinking": "message.event.content_block[type=thinking]",
        "tool_search_tool_result": "message.event.content_block[type=tool_search_tool_result]",
        "tool_use": "message.event.content_block[type=tool_use]",
        "web_fetch_tool_result": "message.event.content_block[type=web_fetch_tool_result]",
        "web_search_tool_result": "message.event.content_block[type=web_search_tool_result]"
      }
    }
  },
  "message.event.content_block.caller": {
    "type": {
      "words": [
        "code_execution_20250825",
        "code_execution_20260120",
        "direct"
      ],
      "variants": {
        "code_execution_20250825": "message.event.content_block.caller[type=code_execution_20250825]",
        "code_execution_20260120": "message.event.content_block.caller[type=code_execution_20260120]",
        "direct": "message.event.content_block.caller[type=direct]"
      }
    }
  },
  "message.event.content_block.caller[type=code_execution_20250825]": {
    "type": {
      "words": [
        "code_execution_20250825"
      ]
    }
  },
  "message.event.content_block.caller[type=code_execution_20260120]": {
    "type": {
      "words": [
        "code_execution_20260120"
      ]
    }
  },
  "message.event.content_block.caller[type=direct]": {
    "type": {
      "words": [
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
      ],
      "variants": {
        "char_location": "message.event.content_block.citations[type=char_location]",
        "content_block_location": "message.event.content_block.citations[type=content_block_location]",
        "page_location": "message.event.content_block.citations[type=page_location]",
        "search_result_location": "message.event.content_block.citations[type=search_result_location]",
        "web_search_result_location": "message.event.content_block.citations[type=web_search_result_location]"
      }
    }
  },
  "message.event.content_block.citations[type=char_location]": {
    "type": {
      "words": [
        "char_location"
      ]
    }
  },
  "message.event.content_block.citations[type=content_block_location]": {
    "type": {
      "words": [
        "content_block_location"
      ]
    }
  },
  "message.event.content_block.citations[type=page_location]": {
    "type": {
      "words": [
        "page_location"
      ]
    }
  },
  "message.event.content_block.citations[type=search_result_location]": {
    "type": {
      "words": [
        "search_result_location"
      ]
    }
  },
  "message.event.content_block.citations[type=web_search_result_location]": {
    "type": {
      "words": [
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
      ],
      "variants": {
        "advisor_redacted_result": "message.event.content_block.content[type=advisor_redacted_result]",
        "advisor_result": "message.event.content_block.content[type=advisor_result]",
        "advisor_tool_result_error": "message.event.content_block.content[type=advisor_tool_result_error]",
        "bash_code_execution_result": "message.event.content_block.content[type=bash_code_execution_result]",
        "bash_code_execution_tool_result_error": "message.event.content_block.content[type=bash_code_execution_tool_result_error]",
        "code_execution_result": "message.event.content_block.content[type=code_execution_result]",
        "code_execution_tool_result_error": "message.event.content_block.content[type=code_execution_tool_result_error]",
        "encrypted_code_execution_result": "message.event.content_block.content[type=encrypted_code_execution_result]",
        "text": "message.event.content_block[type=text]",
        "text_editor_code_execution_create_result": "message.event.content_block.content[type=text_editor_code_execution_create_result]",
        "text_editor_code_execution_str_replace_result": "message.event.content_block.content[type=text_editor_code_execution_str_replace_result]",
        "text_editor_code_execution_tool_result_error": "message.event.content_block.content[type=text_editor_code_execution_tool_result_error]",
        "text_editor_code_execution_view_result": "message.event.content_block.content[type=text_editor_code_execution_view_result]",
        "tool_search_tool_result_error": "message.event.content_block.content[type=tool_search_tool_result_error]",
        "tool_search_tool_search_result": "message.event.content_block.content[type=tool_search_tool_search_result]",
        "web_fetch_result": "message.event.content_block.content[type=web_fetch_result]",
        "web_fetch_tool_result_error": "message.event.content_block.content[type=web_fetch_tool_result_error]",
        "web_search_result": "message.event.content_block.content[type=web_search_result]",
        "web_search_tool_result_error": "message.event.content_block.content[type=web_search_tool_result_error]"
      }
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
      ],
      "variants": {
        "bash_code_execution_output": "message.event.content_block.content.content[type=bash_code_execution_output]",
        "code_execution_output": "message.event.content_block.content.content[type=code_execution_output]",
        "document": "message.event.content_block.content.content[type=document]"
      }
    }
  },
  "message.event.content_block.content.content.citations": {},
  "message.event.content_block.content.content.source": {
    "media_type": {
      "words": [
        "application/pdf",
        "text/plain"
      ],
      "variants": {
        "application/pdf": "message.event.content_block.content.content.source[media_type=application/pdf]",
        "text/plain": "message.event.content_block.content.content.source[media_type=text/plain]"
      }
    },
    "type": {
      "words": [
        "base64",
        "text"
      ]
    }
  },
  "message.event.content_block.content.content.source[media_type=application/pdf]": {
    "media_type": {
      "words": [
        "application/pdf"
      ]
    },
    "type": {
      "words": [
        "base64"
      ]
    }
  },
  "message.event.content_block.content.content.source[media_type=text/plain]": {
    "media_type": {
      "words": [
        "text/plain"
      ]
    },
    "type": {
      "words": [
        "text"
      ]
    }
  },
  "message.event.content_block.content.content[type=bash_code_execution_output]": {
    "type": {
      "words": [
        "bash_code_execution_output"
      ]
    }
  },
  "message.event.content_block.content.content[type=code_execution_output]": {
    "type": {
      "words": [
        "code_execution_output"
      ]
    }
  },
  "message.event.content_block.content.content[type=document]": {
    "citations": {
      "place": "message.event.content_block.content.content.citations"
    },
    "source": {
      "place": "message.event.content_block.content.content.source"
    },
    "type": {
      "words": [
        "document"
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
  "message.event.content_block.content[type=advisor_redacted_result]": {
    "type": {
      "words": [
        "advisor_redacted_result"
      ]
    }
  },
  "message.event.content_block.content[type=advisor_result]": {
    "type": {
      "words": [
        "advisor_result"
      ]
    }
  },
  "message.event.content_block.content[type=advisor_tool_result_error]": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "max_uses_exceeded",
        "model_not_found",
        "overloaded",
        "prompt_too_long",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "advisor_tool_result_error"
      ]
    }
  },
  "message.event.content_block.content[type=bash_code_execution_result]": {
    "content": {
      "place": "message.event.content_block.content.content[type=bash_code_execution_output]"
    },
    "type": {
      "words": [
        "bash_code_execution_result"
      ]
    }
  },
  "message.event.content_block.content[type=bash_code_execution_tool_result_error]": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "output_file_too_large",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "bash_code_execution_tool_result_error"
      ]
    }
  },
  "message.event.content_block.content[type=code_execution_result]": {
    "content": {
      "place": "message.event.content_block.content.content[type=code_execution_output]"
    },
    "type": {
      "words": [
        "code_execution_result"
      ]
    }
  },
  "message.event.content_block.content[type=code_execution_tool_result_error]": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "code_execution_tool_result_error"
      ]
    }
  },
  "message.event.content_block.content[type=encrypted_code_execution_result]": {
    "content": {
      "place": "message.event.content_block.content.content[type=code_execution_output]"
    },
    "type": {
      "words": [
        "encrypted_code_execution_result"
      ]
    }
  },
  "message.event.content_block.content[type=text_editor_code_execution_create_result]": {
    "type": {
      "words": [
        "text_editor_code_execution_create_result"
      ]
    }
  },
  "message.event.content_block.content[type=text_editor_code_execution_str_replace_result]": {
    "type": {
      "words": [
        "text_editor_code_execution_str_replace_result"
      ]
    }
  },
  "message.event.content_block.content[type=text_editor_code_execution_tool_result_error]": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "file_not_found",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "text_editor_code_execution_tool_result_error"
      ]
    }
  },
  "message.event.content_block.content[type=text_editor_code_execution_view_result]": {
    "file_type": {
      "words": [
        "image",
        "pdf",
        "text"
      ]
    },
    "type": {
      "words": [
        "text_editor_code_execution_view_result"
      ]
    }
  },
  "message.event.content_block.content[type=tool_search_tool_result_error]": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "tool_search_tool_result_error"
      ]
    }
  },
  "message.event.content_block.content[type=tool_search_tool_search_result]": {
    "tool_references": {
      "place": "message.event.content_block.content.tool_references"
    },
    "type": {
      "words": [
        "tool_search_tool_search_result"
      ]
    }
  },
  "message.event.content_block.content[type=web_fetch_result]": {
    "content": {
      "place": "message.event.content_block.content.content[type=document]"
    },
    "type": {
      "words": [
        "web_fetch_result"
      ]
    }
  },
  "message.event.content_block.content[type=web_fetch_tool_result_error]": {
    "error_code": {
      "words": [
        "content_too_large",
        "invalid_tool_input",
        "max_uses_exceeded",
        "too_many_requests",
        "unavailable",
        "unsupported_content_type",
        "url_not_accessible",
        "url_not_allowed",
        "url_not_in_prior_context",
        "url_too_long"
      ]
    },
    "type": {
      "words": [
        "web_fetch_tool_result_error"
      ]
    }
  },
  "message.event.content_block.content[type=web_search_result]": {
    "type": {
      "words": [
        "web_search_result"
      ]
    }
  },
  "message.event.content_block.content[type=web_search_tool_result_error]": {
    "error_code": {
      "words": [
        "invalid_tool_input",
        "max_uses_exceeded",
        "query_too_long",
        "request_too_large",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "web_search_tool_result_error"
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
      ],
      "variants": {
        "tool_addition": "message.event.content_block.tool_changes[type=tool_addition]",
        "tool_removal": "message.event.content_block.tool_changes[type=tool_removal]"
      }
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
      ],
      "variants": {
        "mcp_tool_reference": "message.event.content_block.tool_changes.tool[type=mcp_tool_reference]",
        "mcp_toolset_reference": "message.event.content_block.tool_changes.tool[type=mcp_toolset_reference]",
        "tool_definition": "message.event.content_block.tool_changes.tool[type=tool_definition]",
        "tool_reference": "message.event.content_block.tool_changes.tool[type=tool_reference]"
      }
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
      ],
      "variants": {
        "all": "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results[type=all]",
        "except": "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results[type=except]",
        "none": "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results[type=none]",
        "only": "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results[type=only]"
      }
    }
  },
  "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results.tools": {
    "type": {
      "words": [
        "tool_reference"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results[type=all]": {
    "type": {
      "words": [
        "all"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results[type=except]": {
    "tools": {
      "place": "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results.tools"
    },
    "type": {
      "words": [
        "except"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results[type=none]": {
    "type": {
      "words": [
        "none"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results[type=only]": {
    "tools": {
      "place": "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results.tools"
    },
    "type": {
      "words": [
        "only"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool.definition.url_sources.user_input": {
    "type": {
      "words": [
        "all",
        "none"
      ],
      "variants": {
        "all": "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results[type=all]",
        "none": "message.event.content_block.tool_changes.tool.definition.url_sources.client_tool_results[type=none]"
      }
    }
  },
  "message.event.content_block.tool_changes.tool.definition.user_location": {
    "type": {
      "words": [
        "approximate"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool[type=mcp_tool_reference]": {
    "type": {
      "words": [
        "mcp_tool_reference"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool[type=mcp_toolset_reference]": {
    "type": {
      "words": [
        "mcp_toolset_reference"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool[type=tool_definition]": {
    "definition": {
      "place": "message.event.content_block.tool_changes.tool.definition"
    },
    "type": {
      "words": [
        "tool_definition"
      ]
    }
  },
  "message.event.content_block.tool_changes.tool[type=tool_reference]": {
    "type": {
      "words": [
        "tool_reference"
      ]
    }
  },
  "message.event.content_block.tool_changes[type=tool_addition]": {
    "tool": {
      "place": "message.event.content_block.tool_changes.tool"
    },
    "type": {
      "words": [
        "tool_addition"
      ]
    }
  },
  "message.event.content_block.tool_changes[type=tool_removal]": {
    "tool": {
      "place": "message.event.content_block.tool_changes[type=tool_removal].tool"
    },
    "type": {
      "words": [
        "tool_removal"
      ]
    }
  },
  "message.event.content_block.tool_changes[type=tool_removal].tool": {
    "type": {
      "words": [
        "mcp_tool_reference",
        "mcp_toolset_reference",
        "tool_reference"
      ],
      "variants": {
        "mcp_tool_reference": "message.event.content_block.tool_changes.tool[type=mcp_tool_reference]",
        "mcp_toolset_reference": "message.event.content_block.tool_changes.tool[type=mcp_toolset_reference]",
        "tool_reference": "message.event.content_block.tool_changes.tool[type=tool_reference]"
      }
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
  "message.event.content_block[type=advisor_tool_result]": {
    "content": {
      "place": "message.event.content_block[type=advisor_tool_result].content"
    },
    "type": {
      "words": [
        "advisor_tool_result"
      ]
    }
  },
  "message.event.content_block[type=advisor_tool_result].content": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "max_uses_exceeded",
        "model_not_found",
        "overloaded",
        "prompt_too_long",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "advisor_redacted_result",
        "advisor_result",
        "advisor_tool_result_error"
      ],
      "variants": {
        "advisor_redacted_result": "message.event.content_block.content[type=advisor_redacted_result]",
        "advisor_result": "message.event.content_block.content[type=advisor_result]",
        "advisor_tool_result_error": "message.event.content_block.content[type=advisor_tool_result_error]"
      }
    }
  },
  "message.event.content_block[type=bash_code_execution_tool_result]": {
    "content": {
      "place": "message.event.content_block[type=bash_code_execution_tool_result].content"
    },
    "type": {
      "words": [
        "bash_code_execution_tool_result"
      ]
    }
  },
  "message.event.content_block[type=bash_code_execution_tool_result].content": {
    "content": {
      "place": "message.event.content_block.content.content[type=bash_code_execution_output]"
    },
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "output_file_too_large",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "bash_code_execution_result",
        "bash_code_execution_tool_result_error"
      ],
      "variants": {
        "bash_code_execution_result": "message.event.content_block.content[type=bash_code_execution_result]",
        "bash_code_execution_tool_result_error": "message.event.content_block.content[type=bash_code_execution_tool_result_error]"
      }
    }
  },
  "message.event.content_block[type=code_execution_tool_result]": {
    "content": {
      "place": "message.event.content_block[type=code_execution_tool_result].content"
    },
    "type": {
      "words": [
        "code_execution_tool_result"
      ]
    }
  },
  "message.event.content_block[type=code_execution_tool_result].content": {
    "content": {
      "place": "message.event.content_block.content.content[type=code_execution_output]"
    },
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "code_execution_result",
        "code_execution_tool_result_error",
        "encrypted_code_execution_result"
      ],
      "variants": {
        "code_execution_result": "message.event.content_block.content[type=code_execution_result]",
        "code_execution_tool_result_error": "message.event.content_block.content[type=code_execution_tool_result_error]",
        "encrypted_code_execution_result": "message.event.content_block.content[type=encrypted_code_execution_result]"
      }
    }
  },
  "message.event.content_block[type=compaction]": {
    "tool_changes": {
      "place": "message.event.content_block.tool_changes"
    },
    "type": {
      "words": [
        "compaction"
      ]
    }
  },
  "message.event.content_block[type=container_upload]": {
    "type": {
      "words": [
        "container_upload"
      ]
    }
  },
  "message.event.content_block[type=fallback]": {
    "from": {
      "place": "message.event.content_block.from"
    },
    "to": {
      "place": "message.event.content_block.from"
    },
    "trigger": {
      "place": "message.event.content_block.trigger"
    },
    "type": {
      "words": [
        "fallback"
      ]
    }
  },
  "message.event.content_block[type=mcp_tool_listing]": {
    "tools": {
      "place": "message.event.content_block.tools"
    },
    "type": {
      "words": [
        "mcp_tool_listing"
      ]
    }
  },
  "message.event.content_block[type=mcp_tool_result]": {
    "content": {
      "place": "message.event.content_block[type=text]"
    },
    "type": {
      "words": [
        "mcp_tool_result"
      ]
    }
  },
  "message.event.content_block[type=mcp_tool_use]": {
    "type": {
      "words": [
        "mcp_tool_use"
      ]
    }
  },
  "message.event.content_block[type=redacted_thinking]": {
    "type": {
      "words": [
        "redacted_thinking"
      ]
    }
  },
  "message.event.content_block[type=server_tool_use]": {
    "caller": {
      "place": "message.event.content_block.caller"
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
    "type": {
      "words": [
        "server_tool_use"
      ]
    }
  },
  "message.event.content_block[type=text]": {
    "citations": {
      "place": "message.event.content_block.citations"
    },
    "type": {
      "words": [
        "text"
      ]
    }
  },
  "message.event.content_block[type=text_editor_code_execution_tool_result]": {
    "content": {
      "place": "message.event.content_block[type=text_editor_code_execution_tool_result].content"
    },
    "type": {
      "words": [
        "text_editor_code_execution_tool_result"
      ]
    }
  },
  "message.event.content_block[type=text_editor_code_execution_tool_result].content": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "file_not_found",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "file_type": {
      "words": [
        "image",
        "pdf",
        "text"
      ]
    },
    "type": {
      "words": [
        "text_editor_code_execution_create_result",
        "text_editor_code_execution_str_replace_result",
        "text_editor_code_execution_tool_result_error",
        "text_editor_code_execution_view_result"
      ],
      "variants": {
        "text_editor_code_execution_create_result": "message.event.content_block.content[type=text_editor_code_execution_create_result]",
        "text_editor_code_execution_str_replace_result": "message.event.content_block.content[type=text_editor_code_execution_str_replace_result]",
        "text_editor_code_execution_tool_result_error": "message.event.content_block.content[type=text_editor_code_execution_tool_result_error]",
        "text_editor_code_execution_view_result": "message.event.content_block.content[type=text_editor_code_execution_view_result]"
      }
    }
  },
  "message.event.content_block[type=thinking]": {
    "type": {
      "words": [
        "thinking"
      ]
    }
  },
  "message.event.content_block[type=tool_search_tool_result]": {
    "content": {
      "place": "message.event.content_block[type=tool_search_tool_result].content"
    },
    "type": {
      "words": [
        "tool_search_tool_result"
      ]
    }
  },
  "message.event.content_block[type=tool_search_tool_result].content": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "tool_references": {
      "place": "message.event.content_block.content.tool_references"
    },
    "type": {
      "words": [
        "tool_search_tool_result_error",
        "tool_search_tool_search_result"
      ],
      "variants": {
        "tool_search_tool_result_error": "message.event.content_block.content[type=tool_search_tool_result_error]",
        "tool_search_tool_search_result": "message.event.content_block.content[type=tool_search_tool_search_result]"
      }
    }
  },
  "message.event.content_block[type=tool_use]": {
    "caller": {
      "place": "message.event.content_block.caller"
    },
    "type": {
      "words": [
        "tool_use"
      ]
    }
  },
  "message.event.content_block[type=web_fetch_tool_result]": {
    "caller": {
      "place": "message.event.content_block.caller"
    },
    "content": {
      "place": "message.event.content_block[type=web_fetch_tool_result].content"
    },
    "type": {
      "words": [
        "web_fetch_tool_result"
      ]
    }
  },
  "message.event.content_block[type=web_fetch_tool_result].content": {
    "content": {
      "place": "message.event.content_block.content.content[type=document]"
    },
    "error_code": {
      "words": [
        "content_too_large",
        "invalid_tool_input",
        "max_uses_exceeded",
        "too_many_requests",
        "unavailable",
        "unsupported_content_type",
        "url_not_accessible",
        "url_not_allowed",
        "url_not_in_prior_context",
        "url_too_long"
      ]
    },
    "type": {
      "words": [
        "web_fetch_result",
        "web_fetch_tool_result_error"
      ],
      "variants": {
        "web_fetch_result": "message.event.content_block.content[type=web_fetch_result]",
        "web_fetch_tool_result_error": "message.event.content_block.content[type=web_fetch_tool_result_error]"
      }
    }
  },
  "message.event.content_block[type=web_search_tool_result]": {
    "caller": {
      "place": "message.event.content_block.caller"
    },
    "content": {
      "place": "message.event.content_block[type=web_search_tool_result].content"
    },
    "type": {
      "words": [
        "web_search_tool_result"
      ]
    }
  },
  "message.event.content_block[type=web_search_tool_result].content": {
    "error_code": {
      "words": [
        "invalid_tool_input",
        "max_uses_exceeded",
        "query_too_long",
        "request_too_large",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "web_search_result",
        "web_search_tool_result_error"
      ],
      "variants": {
        "web_search_result": "message.event.content_block.content[type=web_search_result]",
        "web_search_tool_result_error": "message.event.content_block.content[type=web_search_tool_result_error]"
      }
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
      ],
      "variants": {
        "clear_thinking_20251015": "message.event.context_management.applied_edits[type=clear_thinking_20251015]",
        "clear_tool_uses_20250919": "message.event.context_management.applied_edits[type=clear_tool_uses_20250919]"
      }
    }
  },
  "message.event.context_management.applied_edits[type=clear_thinking_20251015]": {
    "type": {
      "words": [
        "clear_thinking_20251015"
      ]
    }
  },
  "message.event.context_management.applied_edits[type=clear_tool_uses_20250919]": {
    "type": {
      "words": [
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
      ],
      "variants": {
        "thinking_dropped": "message.event.input_transformations[type=thinking_dropped]",
        "thinking_mismatch_allowed": "message.event.input_transformations[type=thinking_mismatch_allowed]"
      }
    }
  },
  "message.event.input_transformations[type=thinking_dropped]": {
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
        "thinking_dropped"
      ]
    }
  },
  "message.event.input_transformations[type=thinking_mismatch_allowed]": {
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
  "message.event[type=content_block_delta]": {
    "delta": {
      "place": "message.event[type=content_block_delta].delta"
    },
    "type": {
      "words": [
        "content_block_delta"
      ]
    }
  },
  "message.event[type=content_block_delta].delta": {
    "citation": {
      "place": "message.event.content_block.citations"
    },
    "type": {
      "words": [
        "citations_delta",
        "compaction_delta",
        "input_json_delta",
        "signature_delta",
        "text_delta",
        "thinking_delta"
      ],
      "variants": {
        "citations_delta": "message.event[type=content_block_delta].delta[type=citations_delta]",
        "compaction_delta": "message.event[type=content_block_delta].delta[type=compaction_delta]",
        "input_json_delta": "message.event[type=content_block_delta].delta[type=input_json_delta]",
        "signature_delta": "message.event[type=content_block_delta].delta[type=signature_delta]",
        "text_delta": "message.event[type=content_block_delta].delta[type=text_delta]",
        "thinking_delta": "message.event[type=content_block_delta].delta[type=thinking_delta]"
      }
    }
  },
  "message.event[type=content_block_delta].delta[type=citations_delta]": {
    "citation": {
      "place": "message.event.content_block.citations"
    },
    "type": {
      "words": [
        "citations_delta"
      ]
    }
  },
  "message.event[type=content_block_delta].delta[type=compaction_delta]": {
    "type": {
      "words": [
        "compaction_delta"
      ]
    }
  },
  "message.event[type=content_block_delta].delta[type=input_json_delta]": {
    "type": {
      "words": [
        "input_json_delta"
      ]
    }
  },
  "message.event[type=content_block_delta].delta[type=signature_delta]": {
    "type": {
      "words": [
        "signature_delta"
      ]
    }
  },
  "message.event[type=content_block_delta].delta[type=text_delta]": {
    "type": {
      "words": [
        "text_delta"
      ]
    }
  },
  "message.event[type=content_block_delta].delta[type=thinking_delta]": {
    "type": {
      "words": [
        "thinking_delta"
      ]
    }
  },
  "message.event[type=content_block_start]": {
    "content_block": {
      "place": "message.event.content_block"
    },
    "type": {
      "words": [
        "content_block_start"
      ]
    }
  },
  "message.event[type=content_block_stop]": {
    "type": {
      "words": [
        "content_block_stop"
      ]
    }
  },
  "message.event[type=message_delta]": {
    "context_management": {
      "place": "message.event.context_management"
    },
    "delta": {
      "place": "message.event[type=message_delta].delta"
    },
    "input_transformations": {
      "place": "message.event.input_transformations"
    },
    "type": {
      "words": [
        "message_delta"
      ]
    },
    "usage": {
      "place": "message.event.usage"
    }
  },
  "message.event[type=message_delta].delta": {
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
    }
  },
  "message.event[type=message_start]": {
    "message": {
      "place": "message.event.message"
    },
    "type": {
      "words": [
        "message_start"
      ]
    }
  },
  "message.event[type=message_stop]": {
    "type": {
      "words": [
        "message_stop"
      ]
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
      ],
      "variants": {
        "assistant": "message.message[role=assistant]",
        "system": "message.message[role=system]",
        "user": "message.message[role=user]"
      }
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
      ],
      "variants": {
        "advisor_tool_result": "message.event.content_block[type=advisor_tool_result]",
        "bash_code_execution_tool_result": "message.message.content[type=bash_code_execution_tool_result]",
        "code_execution_tool_result": "message.message.content[type=code_execution_tool_result]",
        "compaction": "message.event.content_block[type=compaction]",
        "container_upload": "message.message.content[type=container_upload]",
        "document": "message.pasted_content[type=document]",
        "fallback": "message.event.content_block[type=fallback]",
        "image": "message.pasted_content[type=image]",
        "mcp_tool_listing": "message.event.content_block[type=mcp_tool_listing]",
        "mcp_tool_result": "message.event.content_block[type=mcp_tool_result]",
        "mcp_tool_use": "message.event.content_block[type=mcp_tool_use]",
        "redacted_thinking": "message.message.content[type=redacted_thinking]",
        "search_result": "message.pasted_content[type=search_result]",
        "server_tool_use": "message.message.content[type=server_tool_use]",
        "text": "message.message.content[type=text]",
        "text_editor_code_execution_tool_result": "message.message.content[type=text_editor_code_execution_tool_result]",
        "thinking": "message.message.content[type=thinking]",
        "tool_result": "message.pasted_content[type=tool_result]",
        "tool_search_tool_result": "message.message.content[type=tool_search_tool_result]",
        "tool_use": "message.message.content[type=tool_use]",
        "web_fetch_tool_result": "message.message.content[type=web_fetch_tool_result]",
        "web_search_tool_result": "message.message.content[type=web_search_tool_result]"
      }
    }
  },
  "message.message.content.caller": {
    "type": {
      "words": [
        "code_execution_20250825",
        "code_execution_20260120",
        "direct"
      ],
      "variants": {
        "code_execution_20250825": "message.message.content.caller[type=code_execution_20250825]",
        "code_execution_20260120": "message.message.content.caller[type=code_execution_20260120]",
        "direct": "message.message.content.caller[type=direct]"
      }
    }
  },
  "message.message.content.caller[type=code_execution_20250825]": {
    "type": {
      "words": [
        "code_execution_20250825"
      ]
    }
  },
  "message.message.content.caller[type=code_execution_20260120]": {
    "type": {
      "words": [
        "code_execution_20260120"
      ]
    }
  },
  "message.message.content.caller[type=direct]": {
    "type": {
      "words": [
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
      ],
      "variants": {
        "advisor_redacted_result": "message.event.content_block.content[type=advisor_redacted_result]",
        "advisor_result": "message.event.content_block.content[type=advisor_result]",
        "advisor_tool_result_error": "message.event.content_block.content[type=advisor_tool_result_error]",
        "bash_code_execution_result": "message.message.content.content[type=bash_code_execution_result]",
        "bash_code_execution_tool_result_error": "message.message.content.content[type=bash_code_execution_tool_result_error]",
        "browser_state": "message.pasted_content.content[type=browser_state]",
        "code_execution_result": "message.message.content.content[type=code_execution_result]",
        "code_execution_tool_result_error": "message.message.content.content[type=code_execution_tool_result_error]",
        "document": "message.pasted_content[type=document]",
        "encrypted_code_execution_result": "message.message.content.content[type=encrypted_code_execution_result]",
        "image": "message.pasted_content[type=image]",
        "search_result": "message.pasted_content[type=search_result]",
        "text": "message.message.content[type=text]",
        "text_editor_code_execution_create_result": "message.message.content.content[type=text_editor_code_execution_create_result]",
        "text_editor_code_execution_str_replace_result": "message.message.content.content[type=text_editor_code_execution_str_replace_result]",
        "text_editor_code_execution_tool_result_error": "message.message.content.content[type=text_editor_code_execution_tool_result_error]",
        "text_editor_code_execution_view_result": "message.message.content.content[type=text_editor_code_execution_view_result]",
        "tool_reference": "message.pasted_content.content.tool_references",
        "tool_search_tool_result_error": "message.message.content.content[type=tool_search_tool_result_error]",
        "tool_search_tool_search_result": "message.message.content.content[type=tool_search_tool_search_result]",
        "web_fetch_result": "message.message.content.content[type=web_fetch_result]",
        "web_fetch_tool_result_error": "message.message.content.content[type=web_fetch_tool_result_error]",
        "web_search_result": "message.message.content.content[type=web_search_result]",
        "web_search_tool_result_error": "message.message.content.content[type=web_search_tool_result_error]"
      }
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
      ],
      "variants": {
        "bash_code_execution_output": "message.message.content.content.content[type=bash_code_execution_output]",
        "code_execution_output": "message.message.content.content.content[type=code_execution_output]",
        "document": "message.message.content.content.content[type=document]",
        "text": "message.pasted_content[type=text]"
      }
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
      ],
      "variants": {
        "base64": "message.message.content.content.content.source[type=base64]",
        "content": "message.pasted_content.source[type=content]",
        "file": "message.pasted_content[type=document].source[type=file]",
        "text": "message.message.content.content.content.source[type=text]",
        "url": "message.pasted_content[type=document].source[type=url]"
      }
    }
  },
  "message.message.content.content.content.source[type=base64]": {
    "media_type": {
      "words": [
        "application/pdf"
      ]
    },
    "type": {
      "words": [
        "base64"
      ]
    }
  },
  "message.message.content.content.content.source[type=text]": {
    "media_type": {
      "words": [
        "text/plain"
      ]
    },
    "type": {
      "words": [
        "text"
      ]
    }
  },
  "message.message.content.content.content[type=bash_code_execution_output]": {
    "type": {
      "words": [
        "bash_code_execution_output"
      ]
    }
  },
  "message.message.content.content.content[type=code_execution_output]": {
    "type": {
      "words": [
        "code_execution_output"
      ]
    }
  },
  "message.message.content.content.content[type=document]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "citations": {
      "place": "message.message.content.content.content[type=document].citations"
    },
    "source": {
      "place": "message.message.content.content.content.source"
    },
    "type": {
      "words": [
        "document"
      ]
    }
  },
  "message.message.content.content.content[type=document].citations": {},
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
  "message.message.content.content[type=bash_code_execution_result]": {
    "content": {
      "place": "message.message.content.content.content[type=bash_code_execution_output]"
    },
    "type": {
      "words": [
        "bash_code_execution_result"
      ]
    }
  },
  "message.message.content.content[type=bash_code_execution_tool_result_error]": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "output_file_too_large",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "bash_code_execution_tool_result_error"
      ]
    }
  },
  "message.message.content.content[type=code_execution_result]": {
    "content": {
      "place": "message.message.content.content.content[type=code_execution_output]"
    },
    "type": {
      "words": [
        "code_execution_result"
      ]
    }
  },
  "message.message.content.content[type=code_execution_tool_result_error]": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "code_execution_tool_result_error"
      ]
    }
  },
  "message.message.content.content[type=encrypted_code_execution_result]": {
    "content": {
      "place": "message.message.content.content.content[type=code_execution_output]"
    },
    "type": {
      "words": [
        "encrypted_code_execution_result"
      ]
    }
  },
  "message.message.content.content[type=text_editor_code_execution_create_result]": {
    "type": {
      "words": [
        "text_editor_code_execution_create_result"
      ]
    }
  },
  "message.message.content.content[type=text_editor_code_execution_str_replace_result]": {
    "type": {
      "words": [
        "text_editor_code_execution_str_replace_result"
      ]
    }
  },
  "message.message.content.content[type=text_editor_code_execution_tool_result_error]": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "file_not_found",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "text_editor_code_execution_tool_result_error"
      ]
    }
  },
  "message.message.content.content[type=text_editor_code_execution_view_result]": {
    "file_type": {
      "words": [
        "image",
        "pdf",
        "text"
      ]
    },
    "type": {
      "words": [
        "text_editor_code_execution_view_result"
      ]
    }
  },
  "message.message.content.content[type=tool_search_tool_result_error]": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "tool_search_tool_result_error"
      ]
    }
  },
  "message.message.content.content[type=tool_search_tool_search_result]": {
    "tool_references": {
      "place": "message.message.content.content.tool_references"
    },
    "type": {
      "words": [
        "tool_search_tool_search_result"
      ]
    }
  },
  "message.message.content.content[type=web_fetch_result]": {
    "content": {
      "place": "message.message.content.content.content[type=document]"
    },
    "type": {
      "words": [
        "web_fetch_result"
      ]
    }
  },
  "message.message.content.content[type=web_fetch_tool_result_error]": {
    "error_code": {
      "words": [
        "content_too_large",
        "invalid_tool_input",
        "max_uses_exceeded",
        "too_many_requests",
        "unavailable",
        "unsupported_content_type",
        "url_not_accessible",
        "url_not_allowed",
        "url_not_in_prior_context",
        "url_too_long"
      ]
    },
    "type": {
      "words": [
        "web_fetch_tool_result_error"
      ]
    }
  },
  "message.message.content.content[type=web_search_result]": {
    "type": {
      "words": [
        "web_search_result"
      ]
    }
  },
  "message.message.content.content[type=web_search_tool_result_error]": {
    "error_code": {
      "words": [
        "invalid_tool_input",
        "max_uses_exceeded",
        "query_too_long",
        "request_too_large",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "web_search_tool_result_error"
      ]
    }
  },
  "message.message.content[type=bash_code_execution_tool_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "content": {
      "place": "message.message.content[type=bash_code_execution_tool_result].content"
    },
    "type": {
      "words": [
        "bash_code_execution_tool_result"
      ]
    }
  },
  "message.message.content[type=bash_code_execution_tool_result].content": {
    "content": {
      "place": "message.message.content.content.content[type=bash_code_execution_output]"
    },
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "output_file_too_large",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "bash_code_execution_result",
        "bash_code_execution_tool_result_error"
      ],
      "variants": {
        "bash_code_execution_result": "message.message.content.content[type=bash_code_execution_result]",
        "bash_code_execution_tool_result_error": "message.message.content.content[type=bash_code_execution_tool_result_error]"
      }
    }
  },
  "message.message.content[type=code_execution_tool_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "content": {
      "place": "message.message.content[type=code_execution_tool_result].content"
    },
    "type": {
      "words": [
        "code_execution_tool_result"
      ]
    }
  },
  "message.message.content[type=code_execution_tool_result].content": {
    "content": {
      "place": "message.message.content.content.content[type=code_execution_output]"
    },
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "code_execution_result",
        "code_execution_tool_result_error",
        "encrypted_code_execution_result"
      ],
      "variants": {
        "code_execution_result": "message.message.content.content[type=code_execution_result]",
        "code_execution_tool_result_error": "message.message.content.content[type=code_execution_tool_result_error]",
        "encrypted_code_execution_result": "message.message.content.content[type=encrypted_code_execution_result]"
      }
    }
  },
  "message.message.content[type=container_upload]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "type": {
      "words": [
        "container_upload"
      ]
    }
  },
  "message.message.content[type=redacted_thinking]": {
    "type": {
      "words": [
        "redacted_thinking"
      ]
    }
  },
  "message.message.content[type=server_tool_use]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "caller": {
      "place": "message.message.content.caller"
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
      ],
      "variants": {
        "advisor": "message.event.content_block[type=server_tool_use]",
        "bash_code_execution": "message.message.content[type=server_tool_use]",
        "code_execution": "message.message.content[type=server_tool_use]",
        "text_editor_code_execution": "message.message.content[type=server_tool_use]",
        "tool_search_tool_bm25": "message.message.content[type=server_tool_use]",
        "tool_search_tool_regex": "message.message.content[type=server_tool_use]",
        "web_fetch": "message.message.content[type=server_tool_use]",
        "web_search": "message.message.content[type=server_tool_use]"
      }
    },
    "type": {
      "words": [
        "server_tool_use"
      ]
    }
  },
  "message.message.content[type=text]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "citations": {
      "place": "message.message.content[type=text].citations"
    },
    "type": {
      "words": [
        "text"
      ]
    }
  },
  "message.message.content[type=text].citations": {
    "type": {
      "words": [
        "char_location",
        "content_block_location",
        "page_location",
        "search_result_location",
        "web_search_result_location"
      ],
      "variants": {
        "char_location": "message.message.content[type=text].citations[type=char_location]",
        "content_block_location": "message.message.content[type=text].citations[type=content_block_location]",
        "page_location": "message.message.content[type=text].citations[type=page_location]",
        "search_result_location": "message.message.content[type=text].citations[type=search_result_location]",
        "web_search_result_location": "message.message.content[type=text].citations[type=web_search_result_location]"
      }
    }
  },
  "message.message.content[type=text].citations[type=char_location]": {
    "type": {
      "words": [
        "char_location"
      ]
    }
  },
  "message.message.content[type=text].citations[type=content_block_location]": {
    "type": {
      "words": [
        "content_block_location"
      ]
    }
  },
  "message.message.content[type=text].citations[type=page_location]": {
    "type": {
      "words": [
        "page_location"
      ]
    }
  },
  "message.message.content[type=text].citations[type=search_result_location]": {
    "type": {
      "words": [
        "search_result_location"
      ]
    }
  },
  "message.message.content[type=text].citations[type=web_search_result_location]": {
    "type": {
      "words": [
        "web_search_result_location"
      ]
    }
  },
  "message.message.content[type=text_editor_code_execution_tool_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "content": {
      "place": "message.message.content[type=text_editor_code_execution_tool_result].content"
    },
    "type": {
      "words": [
        "text_editor_code_execution_tool_result"
      ]
    }
  },
  "message.message.content[type=text_editor_code_execution_tool_result].content": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "file_not_found",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "file_type": {
      "words": [
        "image",
        "pdf",
        "text"
      ]
    },
    "type": {
      "words": [
        "text_editor_code_execution_create_result",
        "text_editor_code_execution_str_replace_result",
        "text_editor_code_execution_tool_result_error",
        "text_editor_code_execution_view_result"
      ],
      "variants": {
        "text_editor_code_execution_create_result": "message.message.content.content[type=text_editor_code_execution_create_result]",
        "text_editor_code_execution_str_replace_result": "message.message.content.content[type=text_editor_code_execution_str_replace_result]",
        "text_editor_code_execution_tool_result_error": "message.message.content.content[type=text_editor_code_execution_tool_result_error]",
        "text_editor_code_execution_view_result": "message.message.content.content[type=text_editor_code_execution_view_result]"
      }
    }
  },
  "message.message.content[type=thinking]": {
    "type": {
      "words": [
        "thinking"
      ]
    }
  },
  "message.message.content[type=tool_search_tool_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "content": {
      "place": "message.message.content[type=tool_search_tool_result].content"
    },
    "type": {
      "words": [
        "tool_search_tool_result"
      ]
    }
  },
  "message.message.content[type=tool_search_tool_result].content": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "tool_references": {
      "place": "message.message.content.content.tool_references"
    },
    "type": {
      "words": [
        "tool_search_tool_result_error",
        "tool_search_tool_search_result"
      ],
      "variants": {
        "tool_search_tool_result_error": "message.message.content.content[type=tool_search_tool_result_error]",
        "tool_search_tool_search_result": "message.message.content.content[type=tool_search_tool_search_result]"
      }
    }
  },
  "message.message.content[type=tool_use]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "caller": {
      "place": "message.message.content.caller"
    },
    "type": {
      "words": [
        "tool_use"
      ]
    }
  },
  "message.message.content[type=web_fetch_tool_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "caller": {
      "place": "message.message.content.caller"
    },
    "content": {
      "place": "message.message.content[type=web_fetch_tool_result].content"
    },
    "type": {
      "words": [
        "web_fetch_tool_result"
      ]
    }
  },
  "message.message.content[type=web_fetch_tool_result].content": {
    "content": {
      "place": "message.message.content.content.content[type=document]"
    },
    "error_code": {
      "words": [
        "content_too_large",
        "invalid_tool_input",
        "max_uses_exceeded",
        "too_many_requests",
        "unavailable",
        "unsupported_content_type",
        "url_not_accessible",
        "url_not_allowed",
        "url_not_in_prior_context",
        "url_too_long"
      ]
    },
    "type": {
      "words": [
        "web_fetch_result",
        "web_fetch_tool_result_error"
      ],
      "variants": {
        "web_fetch_result": "message.message.content.content[type=web_fetch_result]",
        "web_fetch_tool_result_error": "message.message.content.content[type=web_fetch_tool_result_error]"
      }
    }
  },
  "message.message.content[type=web_search_tool_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "caller": {
      "place": "message.message.content.caller"
    },
    "content": {
      "place": "message.message.content[type=web_search_tool_result].content"
    },
    "type": {
      "words": [
        "web_search_tool_result"
      ]
    }
  },
  "message.message.content[type=web_search_tool_result].content": {
    "error_code": {
      "words": [
        "invalid_tool_input",
        "max_uses_exceeded",
        "query_too_long",
        "request_too_large",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "web_search_result",
        "web_search_tool_result_error"
      ],
      "variants": {
        "web_search_result": "message.message.content.content[type=web_search_result]",
        "web_search_tool_result_error": "message.message.content.content[type=web_search_tool_result_error]"
      }
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
      ],
      "variants": {
        "messages_changed": "message.message.diagnostics.cache_miss_reason[type=messages_changed]",
        "model_changed": "message.message.diagnostics.cache_miss_reason[type=model_changed]",
        "previous_message_not_found": "message.message.diagnostics.cache_miss_reason[type=previous_message_not_found]",
        "system_changed": "message.message.diagnostics.cache_miss_reason[type=system_changed]",
        "tools_changed": "message.message.diagnostics.cache_miss_reason[type=tools_changed]",
        "unavailable": "message.message.diagnostics.cache_miss_reason[type=unavailable]"
      }
    }
  },
  "message.message.diagnostics.cache_miss_reason[type=messages_changed]": {
    "type": {
      "words": [
        "messages_changed"
      ]
    }
  },
  "message.message.diagnostics.cache_miss_reason[type=model_changed]": {
    "type": {
      "words": [
        "model_changed"
      ]
    }
  },
  "message.message.diagnostics.cache_miss_reason[type=previous_message_not_found]": {
    "type": {
      "words": [
        "previous_message_not_found"
      ]
    }
  },
  "message.message.diagnostics.cache_miss_reason[type=system_changed]": {
    "type": {
      "words": [
        "system_changed"
      ]
    }
  },
  "message.message.diagnostics.cache_miss_reason[type=tools_changed]": {
    "type": {
      "words": [
        "tools_changed"
      ]
    }
  },
  "message.message.diagnostics.cache_miss_reason[type=unavailable]": {
    "type": {
      "words": [
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
  "message.message[role=assistant]": {
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
  "message.message[role=system]": {
    "content": {
      "place": "message.pasted_content[type=text]"
    },
    "role": {
      "words": [
        "system"
      ]
    }
  },
  "message.message[role=user]": {
    "content": {
      "place": "message.pasted_content"
    },
    "role": {
      "words": [
        "user"
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
      ],
      "variants": {
        "auto-continuation": "message.origin[kind=auto-continuation]",
        "channel": "message.origin[kind=channel]",
        "coordinator": "message.origin[kind=coordinator]",
        "human": "message.origin[kind=human]",
        "observer": "message.origin[kind=observer]",
        "observer-activity": "message.origin[kind=observer-activity]",
        "peer": "message.origin[kind=peer]",
        "task-notification": "message.origin[kind=task-notification]",
        "unclassified": "message.origin[kind=unclassified]"
      }
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
  "message.origin[kind=auto-continuation]": {
    "kind": {
      "words": [
        "auto-continuation"
      ]
    }
  },
  "message.origin[kind=channel]": {
    "kind": {
      "words": [
        "channel"
      ]
    }
  },
  "message.origin[kind=coordinator]": {
    "kind": {
      "words": [
        "coordinator"
      ]
    }
  },
  "message.origin[kind=human]": {
    "kind": {
      "words": [
        "human"
      ]
    }
  },
  "message.origin[kind=observer-activity]": {
    "kind": {
      "words": [
        "observer-activity"
      ]
    }
  },
  "message.origin[kind=observer]": {
    "kind": {
      "words": [
        "observer"
      ]
    }
  },
  "message.origin[kind=peer]": {
    "fromMode": {
      "words": [
        "bypass",
        "prompting"
      ]
    },
    "kind": {
      "words": [
        "peer"
      ]
    }
  },
  "message.origin[kind=task-notification]": {
    "kind": {
      "words": [
        "task-notification"
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
  "message.origin[kind=unclassified]": {
    "kind": {
      "words": [
        "unclassified"
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
      ],
      "variants": {
        "bash_code_execution_tool_result": "message.pasted_content[type=bash_code_execution_tool_result]",
        "code_execution_tool_result": "message.pasted_content[type=code_execution_tool_result]",
        "container_upload": "message.pasted_content[type=container_upload]",
        "document": "message.pasted_content[type=document]",
        "image": "message.pasted_content[type=image]",
        "redacted_thinking": "message.pasted_content[type=redacted_thinking]",
        "search_result": "message.pasted_content[type=search_result]",
        "server_tool_use": "message.pasted_content[type=server_tool_use]",
        "text": "message.pasted_content[type=text]",
        "text_editor_code_execution_tool_result": "message.pasted_content[type=text_editor_code_execution_tool_result]",
        "thinking": "message.pasted_content[type=thinking]",
        "tool_result": "message.pasted_content[type=tool_result]",
        "tool_search_tool_result": "message.pasted_content[type=tool_search_tool_result]",
        "tool_use": "message.pasted_content[type=tool_use]",
        "web_fetch_tool_result": "message.pasted_content[type=web_fetch_tool_result]",
        "web_search_tool_result": "message.pasted_content[type=web_search_tool_result]"
      }
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
      ],
      "variants": {
        "code_execution_20250825": "message.pasted_content.caller[type=code_execution_20250825]",
        "code_execution_20260120": "message.pasted_content.caller[type=code_execution_20260120]",
        "direct": "message.pasted_content.caller[type=direct]"
      }
    }
  },
  "message.pasted_content.caller[type=code_execution_20250825]": {
    "type": {
      "words": [
        "code_execution_20250825"
      ]
    }
  },
  "message.pasted_content.caller[type=code_execution_20260120]": {
    "type": {
      "words": [
        "code_execution_20260120"
      ]
    }
  },
  "message.pasted_content.caller[type=direct]": {
    "type": {
      "words": [
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
      ],
      "variants": {
        "bash_code_execution_result": "message.pasted_content.content[type=bash_code_execution_result]",
        "bash_code_execution_tool_result_error": "message.pasted_content.content[type=bash_code_execution_tool_result_error]",
        "browser_state": "message.pasted_content.content[type=browser_state]",
        "code_execution_result": "message.pasted_content.content[type=code_execution_result]",
        "code_execution_tool_result_error": "message.pasted_content.content[type=code_execution_tool_result_error]",
        "document": "message.pasted_content[type=document]",
        "encrypted_code_execution_result": "message.pasted_content.content[type=encrypted_code_execution_result]",
        "image": "message.pasted_content[type=image]",
        "search_result": "message.pasted_content[type=search_result]",
        "text": "message.pasted_content[type=text]",
        "text_editor_code_execution_create_result": "message.pasted_content.content[type=text_editor_code_execution_create_result]",
        "text_editor_code_execution_str_replace_result": "message.pasted_content.content[type=text_editor_code_execution_str_replace_result]",
        "text_editor_code_execution_tool_result_error": "message.pasted_content.content[type=text_editor_code_execution_tool_result_error]",
        "text_editor_code_execution_view_result": "message.pasted_content.content[type=text_editor_code_execution_view_result]",
        "tool_reference": "message.pasted_content.content.tool_references",
        "tool_search_tool_result_error": "message.pasted_content.content[type=tool_search_tool_result_error]",
        "tool_search_tool_search_result": "message.pasted_content.content[type=tool_search_tool_search_result]",
        "web_fetch_result": "message.pasted_content.content[type=web_fetch_result]",
        "web_fetch_tool_result_error": "message.pasted_content.content[type=web_fetch_tool_result_error]",
        "web_search_result": "message.pasted_content.content[type=web_search_result]",
        "web_search_tool_result_error": "message.pasted_content.content[type=web_search_tool_result_error]"
      }
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
      "place": "message.pasted_content[type=document].source"
    },
    "type": {
      "words": [
        "bash_code_execution_output",
        "code_execution_output",
        "document",
        "text"
      ],
      "variants": {
        "bash_code_execution_output": "message.pasted_content.content.content[type=bash_code_execution_output]",
        "code_execution_output": "message.pasted_content.content.content[type=code_execution_output]",
        "document": "message.pasted_content[type=document]",
        "text": "message.pasted_content[type=text]"
      }
    }
  },
  "message.pasted_content.content.content[type=bash_code_execution_output]": {
    "type": {
      "words": [
        "bash_code_execution_output"
      ]
    }
  },
  "message.pasted_content.content.content[type=code_execution_output]": {
    "type": {
      "words": [
        "code_execution_output"
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
      ],
      "variants": {
        "download_completed": "message.pasted_content.content.state_changes[type=download_completed]",
        "download_failed": "message.pasted_content.content.state_changes[type=download_failed]",
        "download_started": "message.pasted_content.content.state_changes[type=download_started]",
        "tab_opened": "message.pasted_content.content.state_changes[type=tab_opened]"
      }
    }
  },
  "message.pasted_content.content.state_changes[type=download_completed]": {
    "type": {
      "words": [
        "download_completed"
      ]
    }
  },
  "message.pasted_content.content.state_changes[type=download_failed]": {
    "type": {
      "words": [
        "download_failed"
      ]
    }
  },
  "message.pasted_content.content.state_changes[type=download_started]": {
    "type": {
      "words": [
        "download_started"
      ]
    }
  },
  "message.pasted_content.content.state_changes[type=tab_opened]": {
    "type": {
      "words": [
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
  "message.pasted_content.content[type=bash_code_execution_result]": {
    "content": {
      "place": "message.pasted_content.content.content[type=bash_code_execution_output]"
    },
    "type": {
      "words": [
        "bash_code_execution_result"
      ]
    }
  },
  "message.pasted_content.content[type=bash_code_execution_tool_result_error]": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "output_file_too_large",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "bash_code_execution_tool_result_error"
      ]
    }
  },
  "message.pasted_content.content[type=browser_state]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "state_changes": {
      "place": "message.pasted_content.content.state_changes"
    },
    "tabs": {
      "place": "message.pasted_content.content.tabs"
    },
    "type": {
      "words": [
        "browser_state"
      ]
    }
  },
  "message.pasted_content.content[type=code_execution_result]": {
    "content": {
      "place": "message.pasted_content.content.content[type=code_execution_output]"
    },
    "type": {
      "words": [
        "code_execution_result"
      ]
    }
  },
  "message.pasted_content.content[type=code_execution_tool_result_error]": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "code_execution_tool_result_error"
      ]
    }
  },
  "message.pasted_content.content[type=encrypted_code_execution_result]": {
    "content": {
      "place": "message.pasted_content.content.content[type=code_execution_output]"
    },
    "type": {
      "words": [
        "encrypted_code_execution_result"
      ]
    }
  },
  "message.pasted_content.content[type=text_editor_code_execution_create_result]": {
    "type": {
      "words": [
        "text_editor_code_execution_create_result"
      ]
    }
  },
  "message.pasted_content.content[type=text_editor_code_execution_str_replace_result]": {
    "type": {
      "words": [
        "text_editor_code_execution_str_replace_result"
      ]
    }
  },
  "message.pasted_content.content[type=text_editor_code_execution_tool_result_error]": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "file_not_found",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "text_editor_code_execution_tool_result_error"
      ]
    }
  },
  "message.pasted_content.content[type=text_editor_code_execution_view_result]": {
    "file_type": {
      "words": [
        "image",
        "pdf",
        "text"
      ]
    },
    "type": {
      "words": [
        "text_editor_code_execution_view_result"
      ]
    }
  },
  "message.pasted_content.content[type=tool_search_tool_result_error]": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "tool_search_tool_result_error"
      ]
    }
  },
  "message.pasted_content.content[type=tool_search_tool_search_result]": {
    "tool_references": {
      "place": "message.pasted_content.content.tool_references"
    },
    "type": {
      "words": [
        "tool_search_tool_search_result"
      ]
    }
  },
  "message.pasted_content.content[type=web_fetch_result]": {
    "content": {
      "place": "message.pasted_content[type=document]"
    },
    "type": {
      "words": [
        "web_fetch_result"
      ]
    }
  },
  "message.pasted_content.content[type=web_fetch_tool_result_error]": {
    "error_code": {
      "words": [
        "content_too_large",
        "invalid_tool_input",
        "max_uses_exceeded",
        "too_many_requests",
        "unavailable",
        "unsupported_content_type",
        "url_not_accessible",
        "url_not_allowed",
        "url_not_in_prior_context",
        "url_too_long"
      ]
    },
    "type": {
      "words": [
        "web_fetch_tool_result_error"
      ]
    }
  },
  "message.pasted_content.content[type=web_search_result]": {
    "type": {
      "words": [
        "web_search_result"
      ]
    }
  },
  "message.pasted_content.content[type=web_search_tool_result_error]": {
    "error_code": {
      "words": [
        "invalid_tool_input",
        "max_uses_exceeded",
        "query_too_long",
        "request_too_large",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "web_search_tool_result_error"
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
      ],
      "variants": {
        "base64": "message.pasted_content.source[type=base64]",
        "content": "message.pasted_content.source[type=content]",
        "file": "message.pasted_content.source[type=file]",
        "text": "message.pasted_content.source[type=text]",
        "url": "message.pasted_content.source[type=url]"
      }
    }
  },
  "message.pasted_content.source.content": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "citations": {
      "place": "message.pasted_content[type=text].citations"
    },
    "source": {
      "place": "message.pasted_content[type=image].source"
    },
    "transformations": {
      "place": "message.pasted_content.transformations"
    },
    "type": {
      "words": [
        "image",
        "text"
      ],
      "variants": {
        "image": "message.pasted_content[type=image]",
        "text": "message.pasted_content[type=text]"
      }
    }
  },
  "message.pasted_content.source[type=base64]": {
    "media_type": {
      "words": [
        "application/pdf",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp"
      ],
      "variants": {
        "application/pdf": "message.pasted_content.source[type=base64][media_type=application/pdf]",
        "image/gif": "message.pasted_content.source[type=base64][media_type=image/gif]",
        "image/jpeg": "message.pasted_content.source[type=base64][media_type=image/gif]",
        "image/png": "message.pasted_content.source[type=base64][media_type=image/gif]",
        "image/webp": "message.pasted_content.source[type=base64][media_type=image/gif]"
      }
    },
    "type": {
      "words": [
        "base64"
      ]
    }
  },
  "message.pasted_content.source[type=base64][media_type=application/pdf]": {
    "media_type": {
      "words": [
        "application/pdf"
      ]
    },
    "type": {
      "words": [
        "base64"
      ]
    }
  },
  "message.pasted_content.source[type=base64][media_type=image/gif]": {
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
        "base64"
      ]
    }
  },
  "message.pasted_content.source[type=content]": {
    "content": {
      "place": "message.pasted_content.source.content"
    },
    "type": {
      "words": [
        "content"
      ]
    }
  },
  "message.pasted_content.source[type=file]": {
    "type": {
      "words": [
        "file"
      ]
    }
  },
  "message.pasted_content.source[type=text]": {
    "media_type": {
      "words": [
        "text/plain"
      ]
    },
    "type": {
      "words": [
        "text"
      ]
    }
  },
  "message.pasted_content.source[type=url]": {
    "type": {
      "words": [
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
  "message.pasted_content[type=bash_code_execution_tool_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "content": {
      "place": "message.pasted_content[type=bash_code_execution_tool_result].content"
    },
    "type": {
      "words": [
        "bash_code_execution_tool_result"
      ]
    }
  },
  "message.pasted_content[type=bash_code_execution_tool_result].content": {
    "content": {
      "place": "message.pasted_content.content.content[type=bash_code_execution_output]"
    },
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "output_file_too_large",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "bash_code_execution_result",
        "bash_code_execution_tool_result_error"
      ],
      "variants": {
        "bash_code_execution_result": "message.pasted_content.content[type=bash_code_execution_result]",
        "bash_code_execution_tool_result_error": "message.pasted_content.content[type=bash_code_execution_tool_result_error]"
      }
    }
  },
  "message.pasted_content[type=code_execution_tool_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "content": {
      "place": "message.pasted_content[type=code_execution_tool_result].content"
    },
    "type": {
      "words": [
        "code_execution_tool_result"
      ]
    }
  },
  "message.pasted_content[type=code_execution_tool_result].content": {
    "content": {
      "place": "message.pasted_content.content.content[type=code_execution_output]"
    },
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "code_execution_result",
        "code_execution_tool_result_error",
        "encrypted_code_execution_result"
      ],
      "variants": {
        "code_execution_result": "message.pasted_content.content[type=code_execution_result]",
        "code_execution_tool_result_error": "message.pasted_content.content[type=code_execution_tool_result_error]",
        "encrypted_code_execution_result": "message.pasted_content.content[type=encrypted_code_execution_result]"
      }
    }
  },
  "message.pasted_content[type=container_upload]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "type": {
      "words": [
        "container_upload"
      ]
    }
  },
  "message.pasted_content[type=document]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "citations": {
      "place": "message.pasted_content[type=document].citations"
    },
    "source": {
      "place": "message.pasted_content[type=document].source"
    },
    "type": {
      "words": [
        "document"
      ]
    }
  },
  "message.pasted_content[type=document].citations": {},
  "message.pasted_content[type=document].source": {
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
      ],
      "variants": {
        "base64": "message.pasted_content.source[type=base64][media_type=application/pdf]",
        "content": "message.pasted_content.source[type=content]",
        "file": "message.pasted_content[type=document].source[type=file]",
        "text": "message.pasted_content.source[type=text]",
        "url": "message.pasted_content[type=document].source[type=url]"
      }
    }
  },
  "message.pasted_content[type=document].source[type=file]": {
    "type": {
      "words": [
        "file"
      ]
    }
  },
  "message.pasted_content[type=document].source[type=url]": {
    "type": {
      "words": [
        "url"
      ]
    }
  },
  "message.pasted_content[type=image]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "source": {
      "place": "message.pasted_content[type=image].source"
    },
    "transformations": {
      "place": "message.pasted_content.transformations"
    },
    "type": {
      "words": [
        "image"
      ]
    }
  },
  "message.pasted_content[type=image].source": {
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
      ],
      "variants": {
        "base64": "message.pasted_content.source[type=base64][media_type=image/gif]",
        "file": "message.pasted_content[type=image].source[type=file]",
        "url": "message.pasted_content[type=image].source[type=url]"
      }
    }
  },
  "message.pasted_content[type=image].source[type=file]": {
    "type": {
      "words": [
        "file"
      ]
    }
  },
  "message.pasted_content[type=image].source[type=url]": {
    "type": {
      "words": [
        "url"
      ]
    }
  },
  "message.pasted_content[type=redacted_thinking]": {
    "type": {
      "words": [
        "redacted_thinking"
      ]
    }
  },
  "message.pasted_content[type=search_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "citations": {
      "place": "message.pasted_content[type=document].citations"
    },
    "content": {
      "place": "message.pasted_content[type=text]"
    },
    "type": {
      "words": [
        "search_result"
      ]
    }
  },
  "message.pasted_content[type=server_tool_use]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "caller": {
      "place": "message.pasted_content.caller"
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
    "type": {
      "words": [
        "server_tool_use"
      ]
    }
  },
  "message.pasted_content[type=text]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "citations": {
      "place": "message.pasted_content[type=text].citations"
    },
    "type": {
      "words": [
        "text"
      ]
    }
  },
  "message.pasted_content[type=text].citations": {
    "type": {
      "words": [
        "char_location",
        "content_block_location",
        "page_location",
        "search_result_location",
        "web_search_result_location"
      ],
      "variants": {
        "char_location": "message.pasted_content[type=text].citations[type=char_location]",
        "content_block_location": "message.pasted_content[type=text].citations[type=content_block_location]",
        "page_location": "message.pasted_content[type=text].citations[type=page_location]",
        "search_result_location": "message.pasted_content[type=text].citations[type=search_result_location]",
        "web_search_result_location": "message.pasted_content[type=text].citations[type=web_search_result_location]"
      }
    }
  },
  "message.pasted_content[type=text].citations[type=char_location]": {
    "type": {
      "words": [
        "char_location"
      ]
    }
  },
  "message.pasted_content[type=text].citations[type=content_block_location]": {
    "type": {
      "words": [
        "content_block_location"
      ]
    }
  },
  "message.pasted_content[type=text].citations[type=page_location]": {
    "type": {
      "words": [
        "page_location"
      ]
    }
  },
  "message.pasted_content[type=text].citations[type=search_result_location]": {
    "type": {
      "words": [
        "search_result_location"
      ]
    }
  },
  "message.pasted_content[type=text].citations[type=web_search_result_location]": {
    "type": {
      "words": [
        "web_search_result_location"
      ]
    }
  },
  "message.pasted_content[type=text_editor_code_execution_tool_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "content": {
      "place": "message.pasted_content[type=text_editor_code_execution_tool_result].content"
    },
    "type": {
      "words": [
        "text_editor_code_execution_tool_result"
      ]
    }
  },
  "message.pasted_content[type=text_editor_code_execution_tool_result].content": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "file_not_found",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "file_type": {
      "words": [
        "image",
        "pdf",
        "text"
      ]
    },
    "type": {
      "words": [
        "text_editor_code_execution_create_result",
        "text_editor_code_execution_str_replace_result",
        "text_editor_code_execution_tool_result_error",
        "text_editor_code_execution_view_result"
      ],
      "variants": {
        "text_editor_code_execution_create_result": "message.pasted_content.content[type=text_editor_code_execution_create_result]",
        "text_editor_code_execution_str_replace_result": "message.pasted_content.content[type=text_editor_code_execution_str_replace_result]",
        "text_editor_code_execution_tool_result_error": "message.pasted_content.content[type=text_editor_code_execution_tool_result_error]",
        "text_editor_code_execution_view_result": "message.pasted_content.content[type=text_editor_code_execution_view_result]"
      }
    }
  },
  "message.pasted_content[type=thinking]": {
    "type": {
      "words": [
        "thinking"
      ]
    }
  },
  "message.pasted_content[type=tool_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "content": {
      "place": "message.pasted_content[type=tool_result].content"
    },
    "type": {
      "words": [
        "tool_result"
      ]
    }
  },
  "message.pasted_content[type=tool_result].content": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "citations": {
      "place": "message.pasted_content.citations"
    },
    "content": {
      "place": "message.pasted_content[type=text]"
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
    "transformations": {
      "place": "message.pasted_content.transformations"
    },
    "type": {
      "words": [
        "browser_state",
        "document",
        "image",
        "search_result",
        "text",
        "tool_reference"
      ],
      "variants": {
        "browser_state": "message.pasted_content.content[type=browser_state]",
        "document": "message.pasted_content[type=document]",
        "image": "message.pasted_content[type=image]",
        "search_result": "message.pasted_content[type=search_result]",
        "text": "message.pasted_content[type=text]",
        "tool_reference": "message.pasted_content.content.tool_references"
      }
    }
  },
  "message.pasted_content[type=tool_search_tool_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "content": {
      "place": "message.pasted_content[type=tool_search_tool_result].content"
    },
    "type": {
      "words": [
        "tool_search_tool_result"
      ]
    }
  },
  "message.pasted_content[type=tool_search_tool_result].content": {
    "error_code": {
      "words": [
        "execution_time_exceeded",
        "invalid_tool_input",
        "too_many_requests",
        "unavailable"
      ]
    },
    "tool_references": {
      "place": "message.pasted_content.content.tool_references"
    },
    "type": {
      "words": [
        "tool_search_tool_result_error",
        "tool_search_tool_search_result"
      ],
      "variants": {
        "tool_search_tool_result_error": "message.pasted_content.content[type=tool_search_tool_result_error]",
        "tool_search_tool_search_result": "message.pasted_content.content[type=tool_search_tool_search_result]"
      }
    }
  },
  "message.pasted_content[type=tool_use]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "caller": {
      "place": "message.pasted_content.caller"
    },
    "type": {
      "words": [
        "tool_use"
      ]
    }
  },
  "message.pasted_content[type=web_fetch_tool_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "caller": {
      "place": "message.pasted_content.caller"
    },
    "content": {
      "place": "message.pasted_content[type=web_fetch_tool_result].content"
    },
    "type": {
      "words": [
        "web_fetch_tool_result"
      ]
    }
  },
  "message.pasted_content[type=web_fetch_tool_result].content": {
    "content": {
      "place": "message.pasted_content[type=document]"
    },
    "error_code": {
      "words": [
        "content_too_large",
        "invalid_tool_input",
        "max_uses_exceeded",
        "too_many_requests",
        "unavailable",
        "unsupported_content_type",
        "url_not_accessible",
        "url_not_allowed",
        "url_not_in_prior_context",
        "url_too_long"
      ]
    },
    "type": {
      "words": [
        "web_fetch_result",
        "web_fetch_tool_result_error"
      ],
      "variants": {
        "web_fetch_result": "message.pasted_content.content[type=web_fetch_result]",
        "web_fetch_tool_result_error": "message.pasted_content.content[type=web_fetch_tool_result_error]"
      }
    }
  },
  "message.pasted_content[type=web_search_tool_result]": {
    "cache_control": {
      "place": "message.pasted_content.cache_control"
    },
    "caller": {
      "place": "message.pasted_content.caller"
    },
    "content": {
      "place": "message.pasted_content[type=web_search_tool_result].content"
    },
    "type": {
      "words": [
        "web_search_tool_result"
      ]
    }
  },
  "message.pasted_content[type=web_search_tool_result].content": {
    "error_code": {
      "words": [
        "invalid_tool_input",
        "max_uses_exceeded",
        "query_too_long",
        "request_too_large",
        "too_many_requests",
        "unavailable"
      ]
    },
    "type": {
      "words": [
        "web_search_result",
        "web_search_tool_result_error"
      ],
      "variants": {
        "web_search_result": "message.pasted_content.content[type=web_search_result]",
        "web_search_tool_result_error": "message.pasted_content.content[type=web_search_tool_result_error]"
      }
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
      ],
      "variants": {
        "not_applied": "message.usage.fallback_credit.status[type=not_applied]",
        "redeemed": "message.usage.fallback_credit.status[type=redeemed]"
      }
    }
  },
  "message.usage.fallback_credit.status[type=not_applied]": {
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
        "not_applied"
      ]
    }
  },
  "message.usage.fallback_credit.status[type=redeemed]": {
    "type": {
      "words": [
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
      ],
      "variants": {
        "advisor_message": "message.usage.iterations[type=advisor_message]",
        "compaction": "message.usage.iterations[type=compaction]",
        "fallback_message": "message.usage.iterations[type=fallback_message]",
        "message": "message.usage.iterations[type=message]"
      }
    }
  },
  "message.usage.iterations[type=advisor_message]": {
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
        "advisor_message"
      ]
    }
  },
  "message.usage.iterations[type=compaction]": {
    "cache_creation": {
      "place": "message.usage.cache_creation"
    },
    "type": {
      "words": [
        "compaction"
      ]
    }
  },
  "message.usage.iterations[type=fallback_message]": {
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
        "fallback_message"
      ]
    }
  },
  "message.usage.iterations[type=message]": {
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
  "message[type=assistant]": {
    "context_usage": {
      "place": "message.context_usage"
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
    "message": {
      "place": "message.event.message"
    },
    "type": {
      "words": [
        "assistant"
      ]
    },
    "usage_report": {
      "place": "message.usage_report"
    }
  },
  "message[type=auth_status]": {
    "type": {
      "words": [
        "auth_status"
      ]
    }
  },
  "message[type=conversation_reset]": {
    "trigger": {
      "words": [
        "clear",
        "fresh_session",
        "onboarding",
        "plan_mode_exit"
      ]
    },
    "type": {
      "words": [
        "conversation_reset"
      ]
    }
  },
  "message[type=prompt_suggestion]": {
    "type": {
      "words": [
        "prompt_suggestion"
      ]
    }
  },
  "message[type=rate_limit_event]": {
    "rate_limit_info": {
      "place": "message.rate_limit_info"
    },
    "type": {
      "words": [
        "rate_limit_event"
      ]
    }
  },
  "message[type=result]": {
    "deferred_tool_use": {
      "place": "message.deferred_tool_use"
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
    "modelUsage": {
      "place": "message.modelUsage"
    },
    "origin": {
      "place": "message.origin"
    },
    "permission_denials": {
      "place": "message.permission_denials"
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
    "subtype": {
      "words": [
        "error_during_execution",
        "error_max_budget_usd",
        "error_max_structured_output_retries",
        "error_max_turns",
        "success"
      ],
      "variants": {
        "error_during_execution": "message[type=result][subtype=error_during_execution]",
        "error_max_budget_usd": "message[type=result][subtype=error_during_execution]",
        "error_max_structured_output_retries": "message[type=result][subtype=error_during_execution]",
        "error_max_turns": "message[type=result][subtype=error_during_execution]",
        "success": "message[type=result][subtype=success]"
      }
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
    "type": {
      "words": [
        "result"
      ]
    },
    "usage": {
      "place": "message[type=result].usage"
    }
  },
  "message[type=result].usage": {
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
  "message[type=result][subtype=error_during_execution]": {
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
    "invalid_config_file": {
      "place": "message.invalid_config_file"
    },
    "modelUsage": {
      "place": "message.modelUsage"
    },
    "origin": {
      "place": "message.origin"
    },
    "permission_denials": {
      "place": "message.permission_denials"
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
    "subtype": {
      "words": [
        "error_during_execution",
        "error_max_budget_usd",
        "error_max_structured_output_retries",
        "error_max_turns"
      ]
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
    "type": {
      "words": [
        "result"
      ]
    },
    "usage": {
      "place": "message[type=result].usage"
    }
  },
  "message[type=result][subtype=success]": {
    "deferred_tool_use": {
      "place": "message.deferred_tool_use"
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
    "modelUsage": {
      "place": "message.modelUsage"
    },
    "origin": {
      "place": "message.origin"
    },
    "permission_denials": {
      "place": "message.permission_denials"
    },
    "subtype": {
      "words": [
        "success"
      ]
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
    "type": {
      "words": [
        "result"
      ]
    },
    "usage": {
      "place": "message[type=result].usage"
    }
  },
  "message[type=stream_event]": {
    "event": {
      "place": "message.event"
    },
    "type": {
      "words": [
        "stream_event"
      ]
    }
  },
  "message[type=system]": {
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
    "mode": {
      "words": [
        "select",
        "synthesize"
      ]
    },
    "no_response": {
      "place": "message.no_response"
    },
    "outcome": {
      "words": [
        "cancelled",
        "error",
        "success"
      ]
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
        "low",
        "medium"
      ]
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
    "subtype": {
      "words": [
        "api_retry",
        "background_tasks_changed",
        "commands_changed",
        "compact_boundary",
        "control_request_progress",
        "elicitation_complete",
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
        "task_notification",
        "task_progress",
        "task_started",
        "task_updated",
        "thinking_tokens",
        "worker_shutting_down"
      ],
      "variants": {
        "api_retry": "message[type=system][subtype=api_retry]",
        "background_tasks_changed": "message[type=system][subtype=background_tasks_changed]",
        "commands_changed": "message[type=system][subtype=commands_changed]",
        "compact_boundary": "message[type=system][subtype=compact_boundary]",
        "control_request_progress": "message[type=system][subtype=control_request_progress]",
        "elicitation_complete": "message[type=system][subtype=elicitation_complete]",
        "files_persisted": "message[type=system][subtype=files_persisted]",
        "hook_progress": "message[type=system][subtype=hook_progress]",
        "hook_response": "message[type=system][subtype=hook_response]",
        "hook_started": "message[type=system][subtype=hook_started]",
        "informational": "message[type=system][subtype=informational]",
        "init": "message[type=system][subtype=init]",
        "local_command_output": "message[type=system][subtype=local_command_output]",
        "memory_recall": "message[type=system][subtype=memory_recall]",
        "mirror_error": "message[type=system][subtype=mirror_error]",
        "model_refusal_fallback": "message[type=system][subtype=model_refusal_fallback]",
        "model_refusal_no_fallback": "message[type=system][subtype=model_refusal_no_fallback]",
        "notification": "message[type=system][subtype=notification]",
        "permission_denied": "message[type=system][subtype=permission_denied]",
        "plugin_install": "message[type=system][subtype=plugin_install]",
        "session_state_changed": "message[type=system][subtype=session_state_changed]",
        "session_writes_lost": "message[type=system][subtype=session_writes_lost]",
        "status": "message[type=system][subtype=status]",
        "task_notification": "message[type=system][subtype=task_notification]",
        "task_progress": "message[type=system][subtype=task_progress]",
        "task_started": "message[type=system][subtype=task_started]",
        "task_updated": "message[type=system][subtype=task_updated]",
        "thinking_tokens": "message[type=system][subtype=thinking_tokens]",
        "worker_shutting_down": "message[type=system][subtype=worker_shutting_down]"
      }
    },
    "tasks": {
      "place": "message.tasks"
    },
    "trigger": {
      "words": [
        "refusal"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    },
    "usage": {
      "place": "message[type=system].usage"
    },
    "view_mode": {
      "words": [
        "default",
        "focus"
      ]
    }
  },
  "message[type=system].usage": {},
  "message[type=system][subtype=api_retry]": {
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
    "no_response": {
      "place": "message.no_response"
    },
    "subtype": {
      "words": [
        "api_retry"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=background_tasks_changed]": {
    "subtype": {
      "words": [
        "background_tasks_changed"
      ]
    },
    "tasks": {
      "place": "message.tasks"
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=commands_changed]": {
    "commands": {
      "place": "message.commands"
    },
    "subtype": {
      "words": [
        "commands_changed"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=compact_boundary]": {
    "compact_metadata": {
      "place": "message.compact_metadata"
    },
    "subtype": {
      "words": [
        "compact_boundary"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=control_request_progress]": {
    "status": {
      "words": [
        "api_retry",
        "started"
      ]
    },
    "subtype": {
      "words": [
        "control_request_progress"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=elicitation_complete]": {
    "subtype": {
      "words": [
        "elicitation_complete"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=files_persisted]": {
    "failed": {
      "place": "message.failed"
    },
    "files": {
      "place": "message.files"
    },
    "subtype": {
      "words": [
        "files_persisted"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=hook_progress]": {
    "subtype": {
      "words": [
        "hook_progress"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=hook_response]": {
    "outcome": {
      "words": [
        "cancelled",
        "error",
        "success"
      ]
    },
    "subtype": {
      "words": [
        "hook_response"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=hook_started]": {
    "subtype": {
      "words": [
        "hook_started"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=informational]": {
    "level": {
      "words": [
        "info",
        "notice",
        "suggestion",
        "warning"
      ]
    },
    "subtype": {
      "words": [
        "informational"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=init]": {
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
    "effort": {
      "words": [
        "high",
        "low",
        "max",
        "medium",
        "xhigh"
      ]
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
    "mcp_servers": {
      "place": "message.mcp_servers"
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
    "plugin_errors": {
      "place": "message.plugin_errors"
    },
    "plugins": {
      "place": "message.plugins"
    },
    "subtype": {
      "words": [
        "init"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    },
    "view_mode": {
      "words": [
        "default",
        "focus"
      ]
    }
  },
  "message[type=system][subtype=local_command_output]": {
    "subtype": {
      "words": [
        "local_command_output"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=memory_recall]": {
    "memories": {
      "place": "message.memories"
    },
    "mode": {
      "words": [
        "select",
        "synthesize"
      ]
    },
    "subtype": {
      "words": [
        "memory_recall"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=mirror_error]": {
    "key": {
      "place": "message.key"
    },
    "subtype": {
      "words": [
        "mirror_error"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=model_refusal_fallback]": {
    "direction": {
      "words": [
        "retry",
        "revert",
        "sticky"
      ]
    },
    "scope": {
      "words": [
        "local",
        "session"
      ]
    },
    "subtype": {
      "words": [
        "model_refusal_fallback"
      ]
    },
    "trigger": {
      "words": [
        "refusal"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=model_refusal_no_fallback]": {
    "subtype": {
      "words": [
        "model_refusal_no_fallback"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=notification]": {
    "priority": {
      "words": [
        "high",
        "immediate",
        "low",
        "medium"
      ]
    },
    "subtype": {
      "words": [
        "notification"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=permission_denied]": {
    "subtype": {
      "words": [
        "permission_denied"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=plugin_install]": {
    "status": {
      "words": [
        "completed",
        "failed",
        "installed",
        "started"
      ]
    },
    "subtype": {
      "words": [
        "plugin_install"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=session_state_changed]": {
    "state": {
      "words": [
        "idle",
        "requires_action",
        "running"
      ]
    },
    "subtype": {
      "words": [
        "session_state_changed"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=session_writes_lost]": {
    "error_code": {
      "words": [
        "EDQUOT",
        "ENOSPC"
      ]
    },
    "lost": {
      "words": [
        "global_config",
        "transcript"
      ]
    },
    "subtype": {
      "words": [
        "session_writes_lost"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=status]": {
    "compact_result": {
      "words": [
        "failed",
        "success"
      ]
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
    "status": {
      "words": [
        "compacting",
        "requesting"
      ]
    },
    "subtype": {
      "words": [
        "status"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=task_notification]": {
    "reason": {
      "words": [
        "worker_restart"
      ]
    },
    "resource_links": {
      "place": "message.resource_links"
    },
    "status": {
      "words": [
        "completed",
        "failed",
        "stopped"
      ]
    },
    "subtype": {
      "words": [
        "task_notification"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    },
    "usage": {
      "place": "message[type=system][subtype=task_notification].usage"
    }
  },
  "message[type=system][subtype=task_notification].usage": {},
  "message[type=system][subtype=task_progress]": {
    "subtype": {
      "words": [
        "task_progress"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    },
    "usage": {
      "place": "message[type=system][subtype=task_progress].usage"
    }
  },
  "message[type=system][subtype=task_progress].usage": {},
  "message[type=system][subtype=task_started]": {
    "subtype": {
      "words": [
        "task_started"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=task_updated]": {
    "patch": {
      "place": "message.patch"
    },
    "subtype": {
      "words": [
        "task_updated"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=thinking_tokens]": {
    "subtype": {
      "words": [
        "thinking_tokens"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=system][subtype=worker_shutting_down]": {
    "subtype": {
      "words": [
        "worker_shutting_down"
      ]
    },
    "type": {
      "words": [
        "system"
      ]
    }
  },
  "message[type=tool_progress]": {
    "subagent_retry": {
      "place": "message.subagent_retry"
    },
    "type": {
      "words": [
        "tool_progress"
      ]
    }
  },
  "message[type=tool_use_summary]": {
    "type": {
      "words": [
        "tool_use_summary"
      ]
    }
  },
  "message[type=user]": {
    "message": {
      "place": "message[type=user].message"
    },
    "origin": {
      "place": "message.origin"
    },
    "pasted_content": {
      "place": "message.pasted_content"
    },
    "priority": {
      "words": [
        "later",
        "next",
        "now"
      ]
    },
    "type": {
      "words": [
        "user"
      ]
    }
  },
  "message[type=user].message": {
    "content": {
      "place": "message.pasted_content"
    },
    "role": {
      "words": [
        "assistant",
        "system",
        "user"
      ],
      "variants": {
        "assistant": "message[type=user].message[role=assistant]",
        "system": "message.message[role=system]",
        "user": "message.message[role=user]"
      }
    }
  },
  "message[type=user].message[role=assistant]": {
    "content": {
      "place": "message.pasted_content"
    },
    "role": {
      "words": [
        "assistant"
      ]
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
      ],
      "variants": {
        "addDirectories": "options.suggestions[type=addDirectories]",
        "addRules": "options.suggestions[type=addRules]",
        "removeDirectories": "options.suggestions[type=removeDirectories]",
        "removeRules": "options.suggestions[type=removeRules]",
        "replaceRules": "options.suggestions[type=replaceRules]",
        "setMode": "options.suggestions[type=setMode]"
      }
    }
  },
  "options.suggestions.rules": {},
  "options.suggestions[type=addDirectories]": {
    "destination": {
      "words": [
        "cliArg",
        "localSettings",
        "projectSettings",
        "session",
        "userSettings"
      ]
    },
    "type": {
      "words": [
        "addDirectories"
      ]
    }
  },
  "options.suggestions[type=addRules]": {
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
    "rules": {
      "place": "options.suggestions.rules"
    },
    "type": {
      "words": [
        "addRules"
      ]
    }
  },
  "options.suggestions[type=removeDirectories]": {
    "destination": {
      "words": [
        "cliArg",
        "localSettings",
        "projectSettings",
        "session",
        "userSettings"
      ]
    },
    "type": {
      "words": [
        "removeDirectories"
      ]
    }
  },
  "options.suggestions[type=removeRules]": {
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
    "rules": {
      "place": "options.suggestions.rules"
    },
    "type": {
      "words": [
        "removeRules"
      ]
    }
  },
  "options.suggestions[type=replaceRules]": {
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
    "rules": {
      "place": "options.suggestions.rules"
    },
    "type": {
      "words": [
        "replaceRules"
      ]
    }
  },
  "options.suggestions[type=setMode]": {
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
    "type": {
      "words": [
        "setMode"
      ]
    }
  },
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
