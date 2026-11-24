// The OpenCode protocol words: for each object key an OpenCode 2.x server can
// put in an inbound frame, the string literals its types allow as that key's
// value. Derived from @opencode/client 2.1.2's declarations
// (dist/promise/index.d.ts and the generated types it exports) by
// ./derive-protocol-words.ts; test/recordings/protocol-words.test.ts fails when
// this list and the derivation differ. To refresh after a client bump, or when
// the driver calls another client method, run
// `node test/recordings/opencode/derive-protocol-words.ts` and paste its words here.
//
// The sanitiser leaves a value at one of these keys alone when the value is
// one of the key's words: `type: "user"` and `type: "session.text.delta"`
// stay on an account named `user` or `text`. Any other value at the key is
// free text like any other.

export const OPENCODE_PROTOCOL_WORDS: { readonly [key: string]: readonly string[] } = {
  _tag: ["AgentNotFoundError", "CommandExecutionError", "CommandNotFoundError", "ConflictError", "FileNotFoundError", "ForbiddenError", "FormAlreadySettledError", "FormInvalidAnswerError", "FormNotFoundError", "InstructionEntryValueTooLargeError", "IntegrationAttemptNotFoundError", "IntegrationMethodNotFoundError", "IntegrationNotFoundError", "InvalidCursorError", "InvalidRequestError", "LocationNotFoundError", "McpServerNotFoundError", "MessageNotFoundError", "PermissionNotFoundError", "PermissionSavedNotFoundError", "ProjectNotFoundError", "ProviderNotFoundError", "PtyNotFoundError", "RpcError", "RpcInternalError", "ServiceUnavailableError", "SessionBusyError", "SessionNotFoundError", "ShellNotFoundError", "SkillNotFoundError", "UnauthorizedError", "UnknownError", "VcsInitNotSupportedError", "WorktreeError"],
  cacheFormat: ["alibaba", "anthropic"],
  command: ["agent.cycle", "prompt.clear", "prompt.submit", "session.background", "session.compact", "session.first", "session.half.page.down", "session.half.page.up", "session.interrupt", "session.last", "session.line.down", "session.line.up", "session.list", "session.new", "session.page.down", "session.page.up"],
  delivery: ["queue", "steer"],
  effect: ["allow", "ask", "deny"],
  encoding: ["gzip", "none", "zstd"],
  event: ["add", "change", "unlink"],
  exit: ["-Infinity", "Infinity", "NaN"],
  finish: ["content-filter", "error", "length", "stop", "tool-calls", "unknown"],
  format: ["date", "date-time", "email", "uri"],
  maxTokensField: ["max_completion_tokens", "max_tokens"],
  name: ["WorktreeError"],
  op: ["eq", "neq"],
  outcome: ["failed", "interrupted", "succeeded"],
  reason: ["auto", "inactivity", "manual", "shutdown", "superseded", "user"],
  reasoningField: ["reasoning", "reasoning_content", "reasoning_text"],
  reply: ["always", "once", "reject"],
  status: ["active", "added", "alpha", "beta", "completed", "deleted", "deprecated", "error", "exited", "failed", "killed", "modified", "running", "streaming", "timeout"],
  type: ["agent-switched", "agent.updated", "assistant", "before", "boolean", "busy", "command.updated", "compaction", "config.updated", "context", "credential.switched", "credential.updated", "external", "file", "filesystem.changed", "form.cancelled", "form.created", "form.replied", "idle", "inline", "installation.update-available", "installation.updated", "integer", "integration.updated", "location-switched", "location.shutdown", "mcp.resources.changed", "mcp.status.changed", "model-switched", "model.updated", "models-dev.refreshed", "move", "multiselect", "native", "number", "permission.asked", "permission.replied", "persistent-pty.added", "persistent-pty.removed", "plugin.updated", "project.updated", "provider.updated", "pty.created", "pty.deleted", "pty.exited", "pty.updated", "reasoning", "reference.updated", "retry", "rpc.internal", "rpc.invalid_output", "running", "server.connected", "session.agent.selected", "session.archived", "session.compaction.delta", "session.compaction.ended", "session.compaction.failed", "session.compaction.started", "session.created", "session.deleted", "session.execution.failed", "session.execution.interrupted", "session.execution.started", "session.execution.succeeded", "session.forked", "session.idle", "session.inbox.cancelled", "session.inbox.delivered", "session.inbox.delivery.changed", "session.inbox.enqueued", "session.instructions.updated", "session.metadata.updated", "session.model.selected", "session.moved", "session.permissions", "session.reasoning.delta", "session.reasoning.ended", "session.reasoning.started", "session.renamed", "session.retry.scheduled", "session.revert.cleared", "session.revert.committed", "session.revert.staged", "session.shell.ended", "session.shell.started", "session.skill.activated", "session.status", "session.step.ended", "session.step.failed", "session.step.started", "session.step.streamed", "session.synthetic", "session.text.delta", "session.text.ended", "session.text.started", "session.tool.called", "session.tool.failed", "session.tool.input.delta", "session.tool.input.ended", "session.tool.input.started", "session.tool.progress", "session.tool.success", "session.unarchived", "session.usage.updated", "session.viewed", "shell", "shell.created", "shell.deleted", "shell.exited", "skill", "skill.updated", "string", "summary", "synthetic", "system", "text", "through", "tool", "tui.command.execute", "tui.prompt.append", "tui.session.select", "tui.toast.show", "uri", "user", "vcs.branch.updated", "websearch.updated", "worktree.resolved", "worktree.updated"],
  variant: ["error", "info", "success", "warning"],
};
