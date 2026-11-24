// The Claude protocol words: for each object key the pinned SDK can put in
// an inbound frame, the string literals its types allow as that key's value.
// Derived from @anthropic-ai/claude-agent-sdk 0.3.330's sdk.d.ts (and the
// @anthropic-ai/sdk types it imports) by ./derive-protocol-words.ts;
// test/recordings/protocol-words.test.ts fails when this list and the
// derivation differ. To refresh after an SDK bump, run
// `node test/recordings/claude/derive-protocol-words.ts` and paste its words here.
//
// The sanitiser leaves a value at one of these keys alone when the value is
// one of the key's words: `type: "user"` and `role: "user"` stay on an
// account named `user`. Any other value at the key is free text like any other.

export const CLAUDE_PROTOCOL_WORDS: { readonly [key: string]: readonly string[] } = {
  allowed_callers: ["code_execution_20250825", "code_execution_20260120", "code_execution_20260521", "direct"],
  apiKeySource: ["/login managed key", "ANTHROPIC_API_KEY", "apiKeyHelper", "none", "oauth", "org", "project", "temporary", "user"],
  apiProvider: ["anthropicAws", "anthropicGoogleCloud", "bedrock", "firstParty", "foundry", "gateway", "mantle", "vertex"],
  behavior: ["allow", "ask", "deny"],
  category: ["bio", "cyber", "frontier_llm", "general_harms", "reasoning_extraction"],
  compact_result: ["failed", "success"],
  costBasis: ["list", "managed", "unknown"],
  destination: ["cliArg", "localSettings", "projectSettings", "session", "userSettings"],
  direction: ["retry", "revert", "sticky"],
  effort: ["high", "low", "max", "medium", "xhigh"],
  error: ["account_on_hold", "authentication_failed", "billing_error", "cloud_credential_error", "invalid_request", "max_output_tokens", "model_not_found", "oauth_org_not_allowed", "overloaded", "rate_limit", "server_error", "unknown", "verification_required"],
  errorCode: ["credits_required"],
  error_code: ["EDQUOT", "ENOSPC", "content_too_large", "execution_time_exceeded", "file_not_found", "invalid_tool_input", "max_uses_exceeded", "model_not_found", "output_file_too_large", "overloaded", "prompt_too_long", "query_too_long", "request_too_large", "too_many_requests", "unavailable", "unsupported_content_type", "url_not_accessible", "url_not_allowed", "url_not_in_prior_context", "url_too_long"],
  fast_mode_disabled_reason: ["disabled_by_env", "extra_usage_disabled", "free", "model_not_allowed", "network_error", "not_first_party", "pending", "preference", "sdk_opt_in_required", "unknown"],
  fast_mode_state: ["cooldown", "off", "on"],
  file_type: ["image", "pdf", "text"],
  first_stream_post_queued_behind: ["durable_post", "ephemeral_post", "hold", "none", "retry_backoff"],
  first_text_post_queued_behind: ["durable_post", "ephemeral_post", "hold", "none", "retry_backoff"],
  fromMode: ["bypass", "prompting"],
  kind: ["auto-continuation", "buffer", "channel", "compaction_window", "coordinator", "deferred", "free", "hard_limit", "human", "observer", "observer-activity", "peer", "task-notification", "unclassified", "used"],
  level: ["info", "notice", "suggestion", "warning"],
  limitScope: ["channel", "group_pool", "service"],
  lost: ["global_config", "transcript"],
  media_type: ["application/pdf", "image/gif", "image/jpeg", "image/png", "image/webp", "text/plain"],
  mode: ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan", "select", "synthesize"],
  model: ["claude-fable-5", "claude-fable-5-1", "claude-fable-5-2", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5", "claude-mythos-5", "claude-mythos-5-1", "claude-mythos-5-2", "claude-mythos-preview", "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5"],
  name: ["advisor", "bash", "bash_code_execution", "code_execution", "computer", "memory", "str_replace_based_edit_tool", "str_replace_editor", "text_editor_code_execution", "tool_search_tool_bm25", "tool_search_tool_regex", "web_fetch", "web_search"],
  outcome: ["cancelled", "error", "success"],
  overageDisabledReason: ["fetch_error", "group_zero_credit_limit", "member_level_disabled", "member_zero_credit_limit", "no_limits_configured", "org_level_disabled", "org_level_disabled_until", "org_service_level_disabled", "out_of_credits", "overage_not_provisioned", "seat_tier_level_disabled", "seat_tier_zero_credit_limit", "unknown"],
  overageStatus: ["allowed", "allowed_warning", "rejected"],
  oversized_image: ["downsize", "error"],
  permissionMode: ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"],
  priority: ["high", "immediate", "later", "low", "medium", "next", "now"],
  rateLimitType: ["five_hour", "overage", "seven_day", "seven_day_opus", "seven_day_overage_included", "seven_day_sonnet"],
  reason: ["body_mismatch", "continuation_excluded", "continuation_only", "end_user_binding_mismatch", "expired", "invalid_target_model", "model_binding_mismatch", "not_enabled", "organization_binding_mismatch", "prefix_binding_mismatch", "reprice_unavailable", "temporarily_unavailable", "variant_fields_present", "worker_restart", "wrong_organization", "wrong_platform", "wrong_workspace"],
  response_inclusion: ["excluded", "full"],
  role: ["assistant", "system", "user"],
  scope: ["local", "organization", "personal", "session", "team"],
  service_tier: ["batch", "priority", "standard"],
  speed: ["fast", "standard"],
  startup_failure_reason: ["bypass_root", "cli_version_too_old", "config_file_invalid", "cwd_unavailable", "gateway_access_denied", "gateway_signin_required", "initialize_fields_not_delivered", "initialize_not_first", "managed_settings_invalid", "managed_settings_not_delivered", "org_config_refused", "org_config_required_unavailable", "org_pin_api_key_conflict", "org_pin_mismatch", "org_verify_failed", "provider_not_allowed", "proxy_invalid", "remote_settings_required_unavailable", "sandbox_required_unavailable", "session_held_by_background", "shell_tool_missing", "temp_dir_unusable", "worktree_resume_refused", "worktree_unverified"],
  state: ["idle", "requires_action", "running"],
  status: ["allowed", "allowed_warning", "api_retry", "compacting", "completed", "failed", "installed", "killed", "paused", "pending", "rejected", "requesting", "running", "started", "stopped"],
  stop_reason: ["compaction", "end_turn", "max_tokens", "model_context_window_exceeded", "pause_turn", "refusal", "stop_sequence", "tool_use"],
  subkind: ["external-event", "peer-send-message", "projects-relay", "scheduled-trigger", "session-inbox"],
  subtype: ["api_retry", "background_tasks_changed", "commands_changed", "compact_boundary", "control_request_progress", "elicitation_complete", "error_during_execution", "error_max_budget_usd", "error_max_structured_output_retries", "error_max_turns", "files_persisted", "hook_progress", "hook_response", "hook_started", "informational", "init", "local_command_output", "memory_recall", "mirror_error", "model_refusal_fallback", "model_refusal_no_fallback", "notification", "permission_denied", "plugin_install", "session_state_changed", "session_writes_lost", "status", "success", "task_notification", "task_progress", "task_started", "task_updated", "thinking_tokens", "worker_shutting_down"],
  supportedEffortLevels: ["high", "low", "max", "medium", "xhigh"],
  terminal_reason: ["aborted_streaming", "aborted_tools", "api_error", "background_requested", "blocking_limit", "budget_exhausted", "completed", "hook_stopped", "image_error", "malformed_tool_use_exhausted", "max_turns", "model_error", "prompt_too_long", "rapid_refill_breaker", "stop_hook_prevented", "structured_output_retry_exhausted", "tool_deferred", "tool_deferred_unavailable", "turn_setup_failed"],
  trigger: ["auto", "clear", "fresh_session", "manual", "onboarding", "plan_mode_exit", "refusal"],
  ttl: ["1h", "5m"],
  type: ["addDirectories", "addRules", "advisor_20260301", "advisor_message", "advisor_redacted_result", "advisor_result", "advisor_tool_result", "advisor_tool_result_error", "all", "anthropic", "approximate", "assistant", "auth_status", "base64", "bash_20241022", "bash_20250124", "bash_code_execution_output", "bash_code_execution_result", "bash_code_execution_tool_result", "bash_code_execution_tool_result_error", "browser_state", "browser_toolset_20260801", "char_location", "citations_delta", "clear_thinking_20251015", "clear_tool_uses_20250919", "code_execution_20250522", "code_execution_20250825", "code_execution_20260120", "code_execution_20260521", "code_execution_output", "code_execution_result", "code_execution_tool_result", "code_execution_tool_result_error", "compaction", "compaction_delta", "computer_20241022", "computer_20250124", "computer_20251124", "computer_toolset_20260801", "container_upload", "content", "content_block_delta", "content_block_location", "content_block_start", "content_block_stop", "conversation_reset", "custom", "direct", "document", "download_completed", "download_failed", "download_started", "encrypted_code_execution_result", "ephemeral", "except", "fallback", "fallback_message", "file", "image", "input_json_delta", "mcp_tool_listing", "mcp_tool_reference", "mcp_tool_result", "mcp_tool_use", "mcp_toolset", "mcp_toolset_reference", "memory_20250818", "message", "message_delta", "message_start", "message_stop", "messages_changed", "model_changed", "none", "not_applied", "object", "only", "page_location", "previous_message_not_found", "prompt_suggestion", "rate_limit_event", "redacted_thinking", "redeemed", "refusal", "removeDirectories", "removeRules", "replaceRules", "result", "search_result", "search_result_location", "server_tool_use", "setMode", "signature_delta", "stream_event", "system", "system_changed", "tab_opened", "text", "text_delta", "text_editor_20241022", "text_editor_20250124", "text_editor_20250429", "text_editor_20250728", "text_editor_code_execution_create_result", "text_editor_code_execution_str_replace_result", "text_editor_code_execution_tool_result", "text_editor_code_execution_tool_result_error", "text_editor_code_execution_view_result", "thinking", "thinking_delta", "thinking_dropped", "thinking_mismatch_allowed", "tool_addition", "tool_definition", "tool_progress", "tool_reference", "tool_removal", "tool_result", "tool_search_tool_bm25", "tool_search_tool_bm25_20251119", "tool_search_tool_regex", "tool_search_tool_regex_20251119", "tool_search_tool_result", "tool_search_tool_result_error", "tool_search_tool_search_result", "tool_use", "tool_use_summary", "tools_changed", "unavailable", "url", "user", "web_fetch_20250910", "web_fetch_20260209", "web_fetch_20260309", "web_fetch_20260318", "web_fetch_result", "web_fetch_tool_result", "web_fetch_tool_result_error", "web_search_20250305", "web_search_20260209", "web_search_20260318", "web_search_result", "web_search_result_location", "web_search_tool_result", "web_search_tool_result_error"],
  view_mode: ["default", "focus"],
};
