// The OpenCode protocol words, by place (../protocol-places.ts): for every
// spot of an inbound OpenCode frame the pinned client's types describe, the
// string literals they allow as each key's value there, and where each object
// value goes on. Derived from @opencode/client 2.1.2's declarations
// (dist/promise/index.d.ts and the generated types it exports) by
// ./derive-protocol-words.ts; test/recordings/protocol-words.test.ts fails
// when this and the derivation differ. To refresh after a client bump, or
// when the driver calls another client method, run
// `node test/recordings/opencode/derive-protocol-words.ts` and put its output
// here.
//
// The sanitiser keeps the user name in an inbound string only where the
// value is one of the words of its place's key: an event's
// `type: "session.text.delta"` and a message's `role: "user"` stay on an
// account named `text` or `user`. A value anywhere else is free text like any
// other.

import type { ProtocolWords } from "../protocol-places.ts";

export const OPENCODE_PROTOCOL_WORDS: ProtocolWords = {
  "": {
    "body": {
      "place": "body"
    },
    "event": {
      "place": "event"
    }
  },
  "body": {
    "*": {
      "place": "body._tag"
    },
    "_tag": {
      "words": [
        "AgentNotFoundError",
        "CommandExecutionError",
        "CommandNotFoundError",
        "ConflictError",
        "FileNotFoundError",
        "ForbiddenError",
        "FormAlreadySettledError",
        "FormInvalidAnswerError",
        "FormNotFoundError",
        "InstructionEntryValueTooLargeError",
        "IntegrationAttemptNotFoundError",
        "IntegrationMethodNotFoundError",
        "IntegrationNotFoundError",
        "InvalidCursorError",
        "InvalidRequestError",
        "LocationNotFoundError",
        "McpServerNotFoundError",
        "MessageNotFoundError",
        "PermissionNotFoundError",
        "PermissionSavedNotFoundError",
        "ProjectNotFoundError",
        "ProviderNotFoundError",
        "PtyNotFoundError",
        "RpcError",
        "RpcInternalError",
        "ServiceUnavailableError",
        "SessionBusyError",
        "SessionNotFoundError",
        "ShellNotFoundError",
        "SkillNotFoundError",
        "UnauthorizedError",
        "UnknownError",
        "VcsInitNotSupportedError",
        "WorktreeError"
      ],
      "place": "body._tag"
    },
    "actualBytes": {
      "place": "body._tag"
    },
    "agent": {
      "place": "body._tag"
    },
    "agentID": {
      "place": "body._tag"
    },
    "attemptID": {
      "place": "body._tag"
    },
    "capabilities": {
      "place": "body.capabilities"
    },
    "command": {
      "place": "body._tag"
    },
    "cost": {
      "place": "body._tag"
    },
    "cursor": {
      "place": "body.cursor"
    },
    "data": {
      "place": "body.data"
    },
    "delivery": {
      "words": [
        "queue",
        "steer"
      ],
      "place": "body._tag"
    },
    "field": {
      "place": "body._tag"
    },
    "files": {
      "place": "body.files"
    },
    "fork": {
      "place": "body.fork"
    },
    "id": {
      "place": "body._tag"
    },
    "integrationID": {
      "place": "body._tag"
    },
    "interrupted": {
      "place": "body._tag"
    },
    "kind": {
      "place": "body._tag"
    },
    "location": {
      "place": "body.location"
    },
    "maxBytes": {
      "place": "body._tag"
    },
    "message": {
      "place": "body._tag"
    },
    "messageID": {
      "place": "body._tag"
    },
    "metadata": {
      "place": "body.metadata"
    },
    "methodID": {
      "place": "body._tag"
    },
    "model": {
      "place": "body.model"
    },
    "name": {
      "words": [
        "WorktreeError"
      ],
      "place": "body._tag"
    },
    "outcome": {
      "words": [
        "failed",
        "interrupted",
        "succeeded"
      ],
      "place": "body._tag"
    },
    "parentID": {
      "place": "body._tag"
    },
    "partID": {
      "place": "body._tag"
    },
    "path": {
      "place": "body._tag"
    },
    "paths": {
      "place": "body.paths"
    },
    "payload": {
      "place": "body.payload"
    },
    "permissions": {
      "place": "body.permissions"
    },
    "pid": {
      "place": "body._tag"
    },
    "projectID": {
      "place": "body._tag"
    },
    "providerID": {
      "place": "body._tag"
    },
    "ptyID": {
      "place": "body._tag"
    },
    "ref": {
      "place": "body._tag"
    },
    "requestID": {
      "place": "body._tag"
    },
    "resource": {
      "place": "body._tag"
    },
    "revert": {
      "place": "body.revert"
    },
    "server": {
      "place": "body._tag"
    },
    "service": {
      "place": "body._tag"
    },
    "sessionID": {
      "place": "body._tag"
    },
    "skill": {
      "place": "body._tag"
    },
    "snapshot": {
      "place": "body._tag"
    },
    "subpath": {
      "place": "body._tag"
    },
    "time": {
      "place": "body.time"
    },
    "title": {
      "place": "body._tag"
    },
    "tokens": {
      "place": "body.tokens"
    },
    "type": {
      "words": [
        "compaction",
        "rpc.internal",
        "rpc.invalid_output",
        "user"
      ],
      "place": "body._tag"
    },
    "urls": {
      "place": "body._tag"
    },
    "version": {
      "place": "body._tag"
    }
  },
  "body._tag": {
    "type": {
      "words": [
        "running"
      ]
    }
  },
  "body.capabilities": {
    "type": {
      "words": [
        "running"
      ]
    }
  },
  "body.cursor": {
    "type": {
      "words": [
        "running"
      ]
    }
  },
  "body.data": {
    "agents": {
      "place": "body.data.agents"
    },
    "body": {
      "place": "body.data.body"
    },
    "capabilities": {
      "place": "body.data.capabilities"
    },
    "compatibility": {
      "place": "body.data.compatibility"
    },
    "content": {
      "place": "body.data.content"
    },
    "cost": {
      "place": "body.data.cost"
    },
    "error": {
      "place": "body.data.error"
    },
    "exit": {
      "words": [
        "-Infinity",
        "Infinity",
        "NaN"
      ]
    },
    "files": {
      "place": "body.data.files"
    },
    "finish": {
      "words": [
        "content-filter",
        "error",
        "length",
        "stop",
        "tool-calls",
        "unknown"
      ]
    },
    "headers": {
      "place": "body.data.headers"
    },
    "limit": {
      "place": "body.data.limit"
    },
    "location": {
      "place": "body.data.location"
    },
    "metadata": {
      "place": "body.data.metadata"
    },
    "model": {
      "place": "body.data.model"
    },
    "native": {
      "place": "body.data.native"
    },
    "outcome": {
      "words": [
        "failed",
        "interrupted",
        "succeeded"
      ]
    },
    "output": {
      "place": "body.data.output"
    },
    "previous": {
      "place": "body.data.previous"
    },
    "reason": {
      "words": [
        "auto",
        "manual"
      ]
    },
    "retry": {
      "place": "body.data.retry"
    },
    "settings": {
      "place": "body.data.settings"
    },
    "skills": {
      "place": "body.data.skills"
    },
    "snapshot": {
      "place": "body.data.snapshot"
    },
    "status": {
      "words": [
        "active",
        "alpha",
        "beta",
        "completed",
        "deprecated",
        "exited",
        "failed",
        "killed",
        "running",
        "timeout"
      ]
    },
    "time": {
      "place": "body.data.time"
    },
    "tokens": {
      "place": "body.data.tokens"
    },
    "type": {
      "words": [
        "agent-switched",
        "assistant",
        "compaction",
        "idle",
        "location-switched",
        "model-switched",
        "running",
        "shell",
        "skill",
        "synthetic",
        "system",
        "user"
      ]
    },
    "variants": {
      "place": "body.data.variants"
    }
  },
  "body.data.agents": {
    "mention": {
      "place": "body.data.agents.mention"
    }
  },
  "body.data.agents.mention": {},
  "body.data.body": {
    "*": {}
  },
  "body.data.capabilities": {},
  "body.data.compatibility": {
    "cacheFormat": {
      "words": [
        "alibaba",
        "anthropic"
      ]
    },
    "maxTokensField": {
      "words": [
        "max_completion_tokens",
        "max_tokens"
      ]
    },
    "reasoningField": {
      "words": [
        "reasoning",
        "reasoning_content",
        "reasoning_text"
      ]
    }
  },
  "body.data.content": {
    "native": {
      "place": "body.data.native"
    },
    "state": {
      "place": "body.data.content.state"
    },
    "time": {
      "place": "body.data.content.time"
    },
    "type": {
      "words": [
        "reasoning",
        "text",
        "tool"
      ],
      "variants": {
        "reasoning": "body.data.content[type=reasoning]",
        "text": "body.data.content[type=text]",
        "tool": "body.data.content[type=tool]"
      }
    }
  },
  "body.data.content.state": {
    "content": {
      "place": "body.data.content.state.content"
    },
    "error": {
      "place": "body.data.error"
    },
    "input": {
      "place": "body.data.content.state.input"
    },
    "metadata": {
      "place": "body.data.content.state.metadata"
    },
    "status": {
      "words": [
        "completed",
        "error",
        "running",
        "streaming"
      ],
      "variants": {
        "completed": "body.data.content.state[status=completed]",
        "error": "body.data.content.state[status=error]",
        "running": "body.data.content.state[status=running]",
        "streaming": "body.data.content.state[status=streaming]"
      }
    }
  },
  "body.data.content.state.content": {
    "type": {
      "words": [
        "file",
        "text"
      ],
      "variants": {
        "file": "body.data.content.state.content[type=file]",
        "text": "event.data.content[type=text]"
      }
    }
  },
  "body.data.content.state.content[type=file]": {
    "type": {
      "words": [
        "file"
      ]
    }
  },
  "body.data.content.state.input": {
    "*": {
      "place": "body.metadata.type"
    }
  },
  "body.data.content.state.metadata": {
    "*": {
      "place": "body.metadata.type"
    }
  },
  "body.data.content.state[status=completed]": {
    "content": {
      "place": "body.data.content.state.content"
    },
    "input": {
      "place": "body.data.content.state[status=completed].input"
    },
    "metadata": {
      "place": "body.data.content.state[status=completed].metadata"
    },
    "status": {
      "words": [
        "completed"
      ]
    }
  },
  "body.data.content.state[status=completed].input": {
    "*": {
      "place": "body.metadata.type"
    }
  },
  "body.data.content.state[status=completed].metadata": {
    "*": {
      "place": "body.metadata.type"
    }
  },
  "body.data.content.state[status=error]": {
    "content": {
      "place": "body.data.content.state.content"
    },
    "error": {
      "place": "body.data.error"
    },
    "input": {
      "place": "body.data.content.state[status=error].input"
    },
    "metadata": {
      "place": "body.data.content.state[status=error].metadata"
    },
    "status": {
      "words": [
        "error"
      ]
    }
  },
  "body.data.content.state[status=error].input": {
    "*": {
      "place": "body.metadata.type"
    }
  },
  "body.data.content.state[status=error].metadata": {
    "*": {
      "place": "body.metadata.type"
    }
  },
  "body.data.content.state[status=running]": {
    "input": {
      "place": "body.data.content.state[status=running].input"
    },
    "metadata": {
      "place": "body.data.content.state[status=running].metadata"
    },
    "status": {
      "words": [
        "running"
      ]
    }
  },
  "body.data.content.state[status=running].input": {
    "*": {
      "place": "body.metadata.type"
    }
  },
  "body.data.content.state[status=running].metadata": {
    "*": {
      "place": "body.metadata.type"
    }
  },
  "body.data.content.state[status=streaming]": {
    "status": {
      "words": [
        "streaming"
      ]
    }
  },
  "body.data.content.time": {},
  "body.data.content[type=reasoning]": {
    "native": {
      "place": "body.data.native"
    },
    "time": {
      "place": "body.data.content[type=reasoning].time"
    },
    "type": {
      "words": [
        "reasoning"
      ]
    }
  },
  "body.data.content[type=reasoning].time": {},
  "body.data.content[type=text]": {
    "native": {
      "place": "body.data.native"
    },
    "type": {
      "words": [
        "text"
      ]
    }
  },
  "body.data.content[type=tool]": {
    "native": {
      "place": "body.data.native"
    },
    "state": {
      "place": "body.data.content.state"
    },
    "time": {
      "place": "body.data.content[type=tool].time"
    },
    "type": {
      "words": [
        "tool"
      ]
    }
  },
  "body.data.content[type=tool].time": {},
  "body.data.cost": {
    "cache": {
      "place": "body.data.cost.cache"
    },
    "tier": {
      "place": "body.data.cost.tier"
    }
  },
  "body.data.cost.cache": {},
  "body.data.cost.tier": {
    "type": {
      "words": [
        "context"
      ]
    }
  },
  "body.data.error": {
    "response": {
      "place": "body.data.error.response"
    }
  },
  "body.data.error.response": {},
  "body.data.files": {
    "mention": {
      "place": "body.data.agents.mention"
    },
    "source": {
      "place": "body.data.files.source"
    }
  },
  "body.data.files.source": {
    "type": {
      "words": [
        "inline",
        "uri"
      ],
      "variants": {
        "inline": "body.data.files.source[type=inline]",
        "uri": "body.data.files.source[type=uri]"
      }
    }
  },
  "body.data.files.source[type=inline]": {
    "type": {
      "words": [
        "inline"
      ]
    }
  },
  "body.data.files.source[type=uri]": {
    "type": {
      "words": [
        "uri"
      ]
    }
  },
  "body.data.headers": {
    "*": {}
  },
  "body.data.limit": {},
  "body.data.location": {},
  "body.data.metadata": {
    "*": {
      "place": "body.metadata.type"
    }
  },
  "body.data.model": {},
  "body.data.native": {
    "*": {
      "place": "body.metadata.type"
    }
  },
  "body.data.output": {},
  "body.data.previous": {
    "location": {
      "place": "body.data.location"
    }
  },
  "body.data.retry": {
    "error": {
      "place": "body.data.error"
    }
  },
  "body.data.settings": {
    "*": {},
    "compaction": {
      "place": "body.data.settings.compaction"
    },
    "encoding": {
      "words": [
        "gzip",
        "none",
        "zstd"
      ]
    }
  },
  "body.data.settings.compaction": {
    "type": {
      "words": [
        "native",
        "summary"
      ],
      "variants": {
        "native": "body.data.settings.compaction[type=native]",
        "summary": "body.data.settings.compaction[type=summary]"
      }
    }
  },
  "body.data.settings.compaction[type=native]": {
    "type": {
      "words": [
        "native"
      ]
    }
  },
  "body.data.settings.compaction[type=summary]": {
    "type": {
      "words": [
        "summary"
      ]
    }
  },
  "body.data.skills": {
    "mention": {
      "place": "body.data.agents.mention"
    }
  },
  "body.data.snapshot": {},
  "body.data.time": {},
  "body.data.tokens": {
    "cache": {
      "place": "body.tokens.cache"
    }
  },
  "body.data.variants": {
    "body": {
      "place": "body.data.variants.body"
    },
    "headers": {
      "place": "body.data.variants.headers"
    },
    "settings": {
      "place": "body.data.settings"
    }
  },
  "body.data.variants.body": {
    "*": {}
  },
  "body.data.variants.headers": {
    "*": {}
  },
  "body.files": {
    "status": {
      "words": [
        "added",
        "deleted",
        "modified"
      ]
    },
    "type": {
      "words": [
        "running"
      ]
    }
  },
  "body.fork": {
    "boundary": {
      "place": "body.fork.boundary"
    },
    "type": {
      "words": [
        "running"
      ]
    }
  },
  "body.fork.boundary": {
    "type": {
      "words": [
        "before",
        "through"
      ],
      "variants": {
        "before": "body.fork.boundary[type=before]",
        "through": "body.fork.boundary[type=through]"
      }
    }
  },
  "body.fork.boundary[type=before]": {
    "type": {
      "words": [
        "before"
      ]
    }
  },
  "body.fork.boundary[type=through]": {
    "type": {
      "words": [
        "through"
      ]
    }
  },
  "body.location": {
    "type": {
      "words": [
        "running"
      ]
    }
  },
  "body.metadata": {
    "*": {
      "place": "body.metadata.type"
    },
    "type": {
      "words": [
        "running"
      ],
      "place": "body.metadata.type"
    }
  },
  "body.metadata.type": {
    "*": {
      "place": "body.metadata.type"
    }
  },
  "body.model": {
    "type": {
      "words": [
        "running"
      ]
    }
  },
  "body.paths": {
    "type": {
      "words": [
        "running"
      ]
    }
  },
  "body.payload": {
    "agents": {
      "place": "body.data.agents"
    },
    "files": {
      "place": "body.data.files"
    },
    "metadata": {
      "place": "body.payload.metadata"
    },
    "skills": {
      "place": "body.data.skills"
    },
    "type": {
      "words": [
        "running"
      ]
    }
  },
  "body.payload.metadata": {
    "*": {
      "place": "body.metadata.type"
    }
  },
  "body.permissions": {
    "effect": {
      "words": [
        "allow",
        "ask",
        "deny"
      ]
    },
    "type": {
      "words": [
        "running"
      ]
    }
  },
  "body.revert": {
    "files": {
      "place": "body.revert.files"
    },
    "type": {
      "words": [
        "running"
      ]
    }
  },
  "body.revert.files": {
    "status": {
      "words": [
        "added",
        "deleted",
        "modified"
      ]
    }
  },
  "body.time": {
    "type": {
      "words": [
        "running"
      ]
    }
  },
  "body.tokens": {
    "cache": {
      "place": "body.tokens.cache"
    },
    "type": {
      "words": [
        "running"
      ]
    }
  },
  "body.tokens.cache": {},
  "event": {
    "data": {
      "place": "event.data"
    },
    "durable": {
      "place": "event.durable"
    },
    "location": {
      "place": "event.location"
    },
    "metadata": {
      "place": "event.metadata"
    },
    "type": {
      "words": [
        "agent.updated",
        "command.updated",
        "config.updated",
        "credential.switched",
        "credential.updated",
        "filesystem.changed",
        "form.cancelled",
        "form.created",
        "form.replied",
        "installation.update-available",
        "installation.updated",
        "integration.updated",
        "location.shutdown",
        "mcp.resources.changed",
        "mcp.status.changed",
        "model.updated",
        "models-dev.refreshed",
        "permission.asked",
        "permission.replied",
        "persistent-pty.added",
        "persistent-pty.removed",
        "plugin.updated",
        "project.updated",
        "provider.updated",
        "pty.created",
        "pty.deleted",
        "pty.exited",
        "pty.updated",
        "reference.updated",
        "server.connected",
        "session.agent.selected",
        "session.archived",
        "session.compaction.delta",
        "session.compaction.ended",
        "session.compaction.failed",
        "session.compaction.started",
        "session.created",
        "session.deleted",
        "session.execution.failed",
        "session.execution.interrupted",
        "session.execution.started",
        "session.execution.succeeded",
        "session.forked",
        "session.idle",
        "session.inbox.cancelled",
        "session.inbox.delivered",
        "session.inbox.delivery.changed",
        "session.inbox.enqueued",
        "session.instructions.updated",
        "session.metadata.updated",
        "session.model.selected",
        "session.moved",
        "session.permissions",
        "session.reasoning.delta",
        "session.reasoning.ended",
        "session.reasoning.started",
        "session.renamed",
        "session.retry.scheduled",
        "session.revert.cleared",
        "session.revert.committed",
        "session.revert.staged",
        "session.shell.ended",
        "session.shell.started",
        "session.skill.activated",
        "session.status",
        "session.step.ended",
        "session.step.failed",
        "session.step.started",
        "session.step.streamed",
        "session.synthetic",
        "session.text.delta",
        "session.text.ended",
        "session.text.started",
        "session.tool.called",
        "session.tool.failed",
        "session.tool.input.delta",
        "session.tool.input.ended",
        "session.tool.input.started",
        "session.tool.progress",
        "session.tool.success",
        "session.unarchived",
        "session.usage.updated",
        "session.viewed",
        "shell.created",
        "shell.deleted",
        "shell.exited",
        "skill.updated",
        "tui.command.execute",
        "tui.prompt.append",
        "tui.session.select",
        "tui.toast.show",
        "vcs.branch.updated",
        "websearch.updated",
        "worktree.resolved",
        "worktree.updated"
      ]
    }
  },
  "event.data": {
    "*": {},
    "action": {},
    "adopted": {},
    "agent": {},
    "answer": {
      "place": "event.data.answer"
    },
    "assistantMessageID": {},
    "at": {},
    "attempt": {},
    "boundary": {
      "place": "body.fork.boundary"
    },
    "branch": {},
    "canonical": {},
    "command": {
      "words": [
        "agent.cycle",
        "prompt.clear",
        "prompt.submit",
        "session.background",
        "session.compact",
        "session.first",
        "session.half.page.down",
        "session.half.page.up",
        "session.interrupt",
        "session.last",
        "session.line.down",
        "session.line.up",
        "session.list",
        "session.new",
        "session.page.down",
        "session.page.up"
      ]
    },
    "commands": {
      "place": "event.data.commands"
    },
    "content": {
      "place": "event.data.content"
    },
    "cost": {},
    "credentialID": {},
    "delivery": {
      "words": [
        "queue",
        "steer"
      ]
    },
    "delta": {
      "place": "event.data.delta"
    },
    "description": {},
    "directory": {},
    "duration": {},
    "error": {
      "place": "body.data.error"
    },
    "event": {
      "words": [
        "add",
        "change",
        "unlink"
      ]
    },
    "executed": {},
    "exit": {},
    "exitCode": {},
    "file": {},
    "files": {},
    "finish": {
      "words": [
        "content-filter",
        "error",
        "length",
        "stop",
        "tool-calls",
        "unknown"
      ]
    },
    "form": {
      "place": "event.data.form"
    },
    "icon": {
      "place": "event.data.icon"
    },
    "id": {},
    "idle": {},
    "inboxID": {},
    "info": {
      "place": "event.data.info"
    },
    "input": {
      "place": "event.data.input"
    },
    "inputID": {},
    "instructionEntries": {
      "place": "event.data.instructionEntries"
    },
    "instructions": {
      "place": "event.data.instructions"
    },
    "integrationID": {},
    "item": {
      "place": "event.data.item"
    },
    "location": {
      "place": "event.data.location"
    },
    "message": {},
    "metadata": {
      "place": "event.data.metadata"
    },
    "model": {
      "place": "body.data.model"
    },
    "name": {},
    "native": {
      "place": "event.data.native"
    },
    "ordinal": {},
    "output": {
      "place": "event.data.output"
    },
    "parentID": {},
    "permissions": {
      "place": "event.data.permissions"
    },
    "previous": {
      "place": "body.data.model"
    },
    "projectID": {},
    "ptyID": {},
    "rawFinish": {},
    "reason": {
      "words": [
        "auto",
        "inactivity",
        "manual",
        "shutdown",
        "superseded",
        "user"
      ]
    },
    "reply": {
      "words": [
        "always",
        "once",
        "reject"
      ]
    },
    "requestID": {},
    "resources": {},
    "revert": {
      "place": "event.data.revert"
    },
    "sandboxes": {},
    "save": {},
    "server": {},
    "sessionID": {},
    "shell": {
      "place": "event.data.shell"
    },
    "slug": {},
    "snapshot": {},
    "source": {
      "place": "event.data.source"
    },
    "started": {},
    "status": {
      "words": [
        "exited",
        "killed",
        "running",
        "timeout"
      ],
      "place": "event.data.status"
    },
    "subpath": {},
    "terminal": {
      "place": "event.data.terminal"
    },
    "text": {},
    "time": {
      "place": "event.data.time"
    },
    "title": {},
    "to": {},
    "tokens": {
      "place": "body.data.tokens"
    },
    "variant": {
      "words": [
        "error",
        "info",
        "success",
        "warning"
      ]
    },
    "vcs": {},
    "version": {}
  },
  "event.data.answer": {
    "*": {}
  },
  "event.data.commands": {},
  "event.data.content": {
    "type": {
      "words": [
        "file",
        "text"
      ],
      "variants": {
        "file": "event.data.content[type=file]",
        "text": "event.data.content[type=text]"
      }
    }
  },
  "event.data.content[type=file]": {
    "type": {
      "words": [
        "file"
      ]
    }
  },
  "event.data.content[type=text]": {
    "type": {
      "words": [
        "text"
      ]
    }
  },
  "event.data.delta": {
    "*": {}
  },
  "event.data.form": {
    "fields": {
      "place": "event.data.form.fields"
    },
    "metadata": {
      "place": "event.data.form.metadata"
    }
  },
  "event.data.form.fields": {
    "format": {
      "words": [
        "date",
        "date-time",
        "email",
        "uri"
      ]
    },
    "options": {
      "place": "event.data.form.fields.options"
    },
    "type": {
      "words": [
        "boolean",
        "external",
        "integer",
        "multiselect",
        "number",
        "string"
      ],
      "variants": {
        "boolean": "event.data.form.fields[type=boolean]",
        "external": "event.data.form.fields[type=external]",
        "integer": "event.data.form.fields[type=integer]",
        "multiselect": "event.data.form.fields[type=multiselect]",
        "number": "event.data.form.fields[type=number]",
        "string": "event.data.form.fields[type=string]"
      }
    },
    "when": {
      "place": "event.data.form.fields.when"
    }
  },
  "event.data.form.fields.options": {},
  "event.data.form.fields.when": {
    "op": {
      "words": [
        "eq",
        "neq"
      ]
    }
  },
  "event.data.form.fields[type=boolean]": {
    "type": {
      "words": [
        "boolean"
      ]
    },
    "when": {
      "place": "event.data.form.fields.when"
    }
  },
  "event.data.form.fields[type=external]": {
    "type": {
      "words": [
        "external"
      ]
    }
  },
  "event.data.form.fields[type=integer]": {
    "type": {
      "words": [
        "integer"
      ]
    },
    "when": {
      "place": "event.data.form.fields.when"
    }
  },
  "event.data.form.fields[type=multiselect]": {
    "options": {
      "place": "event.data.form.fields.options"
    },
    "type": {
      "words": [
        "multiselect"
      ]
    },
    "when": {
      "place": "event.data.form.fields.when"
    }
  },
  "event.data.form.fields[type=number]": {
    "type": {
      "words": [
        "number"
      ]
    },
    "when": {
      "place": "event.data.form.fields.when"
    }
  },
  "event.data.form.fields[type=string]": {
    "format": {
      "words": [
        "date",
        "date-time",
        "email",
        "uri"
      ]
    },
    "options": {
      "place": "event.data.form.fields.options"
    },
    "type": {
      "words": [
        "string"
      ]
    },
    "when": {
      "place": "event.data.form.fields.when"
    }
  },
  "event.data.form.metadata": {
    "*": {}
  },
  "event.data.icon": {},
  "event.data.info": {
    "metadata": {
      "place": "event.data.info.metadata"
    },
    "status": {
      "words": [
        "exited",
        "killed",
        "running",
        "timeout"
      ],
      "variants": {
        "exited": "event.data.info",
        "killed": "event.data.shell",
        "running": "event.data.info",
        "timeout": "event.data.shell"
      }
    },
    "time": {
      "place": "event.data.info.time"
    }
  },
  "event.data.info.metadata": {
    "*": {}
  },
  "event.data.info.time": {},
  "event.data.input": {
    "*": {}
  },
  "event.data.instructionEntries": {
    "value": {
      "place": "body.metadata.type"
    }
  },
  "event.data.instructions": {
    "*": {}
  },
  "event.data.item": {
    "delivery": {
      "words": [
        "queue",
        "steer"
      ]
    },
    "payload": {
      "place": "event.data.item.payload"
    },
    "type": {
      "words": [
        "compaction",
        "move",
        "synthetic",
        "user"
      ],
      "variants": {
        "compaction": "event.data.item[type=compaction]",
        "move": "event.data.item[type=move]",
        "synthetic": "event.data.item[type=synthetic]",
        "user": "event.data.item[type=user]"
      }
    }
  },
  "event.data.item.payload": {
    "agents": {
      "place": "body.data.agents"
    },
    "files": {
      "place": "body.data.files"
    },
    "location": {
      "place": "event.data.location"
    },
    "metadata": {
      "place": "event.data.item.payload.metadata"
    },
    "skills": {
      "place": "body.data.skills"
    }
  },
  "event.data.item.payload.metadata": {
    "*": {}
  },
  "event.data.item[type=compaction]": {
    "delivery": {
      "words": [
        "queue",
        "steer"
      ]
    },
    "payload": {
      "place": "event.data.item[type=compaction].payload"
    },
    "type": {
      "words": [
        "compaction"
      ]
    }
  },
  "event.data.item[type=compaction].payload": {},
  "event.data.item[type=move]": {
    "delivery": {
      "words": [
        "queue",
        "steer"
      ]
    },
    "payload": {
      "place": "event.data.item[type=move].payload"
    },
    "type": {
      "words": [
        "move"
      ]
    }
  },
  "event.data.item[type=move].payload": {
    "location": {
      "place": "event.data.location"
    }
  },
  "event.data.item[type=synthetic]": {
    "delivery": {
      "words": [
        "queue",
        "steer"
      ]
    },
    "payload": {
      "place": "event.data.item[type=synthetic].payload"
    },
    "type": {
      "words": [
        "synthetic"
      ]
    }
  },
  "event.data.item[type=synthetic].payload": {
    "metadata": {
      "place": "event.data.item[type=synthetic].payload.metadata"
    }
  },
  "event.data.item[type=synthetic].payload.metadata": {
    "*": {}
  },
  "event.data.item[type=user]": {
    "delivery": {
      "words": [
        "queue",
        "steer"
      ]
    },
    "payload": {
      "place": "event.data.item[type=user].payload"
    },
    "type": {
      "words": [
        "user"
      ]
    }
  },
  "event.data.item[type=user].payload": {
    "agents": {
      "place": "body.data.agents"
    },
    "files": {
      "place": "body.data.files"
    },
    "metadata": {
      "place": "event.data.item[type=user].payload.metadata"
    },
    "skills": {
      "place": "body.data.skills"
    }
  },
  "event.data.item[type=user].payload.metadata": {
    "*": {}
  },
  "event.data.location": {},
  "event.data.metadata": {
    "*": {
      "place": "body.metadata.type"
    }
  },
  "event.data.native": {
    "*": {}
  },
  "event.data.output": {},
  "event.data.permissions": {
    "effect": {
      "words": [
        "allow",
        "ask",
        "deny"
      ]
    }
  },
  "event.data.revert": {
    "files": {
      "place": "body.revert.files"
    }
  },
  "event.data.shell": {
    "metadata": {
      "place": "event.data.info.metadata"
    },
    "status": {
      "words": [
        "exited",
        "killed",
        "running",
        "timeout"
      ]
    },
    "time": {
      "place": "event.data.info.time"
    }
  },
  "event.data.source": {
    "type": {
      "words": [
        "tool"
      ]
    }
  },
  "event.data.status": {
    "action": {
      "place": "event.data.status.action"
    },
    "type": {
      "words": [
        "busy",
        "idle",
        "retry"
      ],
      "variants": {
        "busy": "event.data.status[type=busy]",
        "idle": "event.data.status[type=idle]",
        "retry": "event.data.status[type=retry]"
      }
    }
  },
  "event.data.status.action": {},
  "event.data.status[type=busy]": {
    "type": {
      "words": [
        "busy"
      ]
    }
  },
  "event.data.status[type=idle]": {
    "type": {
      "words": [
        "idle"
      ]
    }
  },
  "event.data.status[type=retry]": {
    "action": {
      "place": "event.data.status.action"
    },
    "type": {
      "words": [
        "retry"
      ]
    }
  },
  "event.data.terminal": {
    "output": {
      "place": "event.data.terminal.output"
    },
    "size": {
      "place": "event.data.terminal.size"
    },
    "status": {
      "words": [
        "exited",
        "running"
      ]
    }
  },
  "event.data.terminal.output": {},
  "event.data.terminal.size": {},
  "event.data.time": {},
  "event.durable": {},
  "event.location": {},
  "event.metadata": {
    "*": {}
  }
};
