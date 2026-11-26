// The Codex protocol words, by place (../protocol-places.ts): for every spot
// of an inbound Codex frame the vendored app-server schema
// (vendor-schemas/codex/3d86e43b075adeba2193ec5c22ac92f55afd82e6/, Codex tag
// rust-v0.172.0) describes, the string values it allows as each key's value
// there, and where each object value goes on. Derived by
// ./derive-protocol-words.ts; test/recordings/protocol-words.test.ts fails
// when this and the derivation differ. After a schema bump, or when the
// driver sends another request, run
// `node test/recordings/codex/derive-protocol-words.ts` and put its output
// here.
//
// The sanitiser keeps the user name in an inbound string only where the
// value is one of the words of its place's key: an item's
// `"type": "agentMessage"` and a turn's `"status": "completed"` stay on an
// account named like them. A value anywhere else (a command's output, an
// agent message's text) is free text like any other.

import type { ProtocolWords } from "../protocol-places.ts";

export const CODEX_PROTOCOL_WORDS: ProtocolWords = {
  "": {
    "message": {
      "place": "message"
    }
  },
  "message": {
    "error": {
      "place": "message.error"
    },
    "method": {
      "words": [
        "account/chatgptAuthTokens/refresh",
        "account/gatewayOAuth/changed",
        "account/login/completed",
        "account/rateLimits/updated",
        "account/updated",
        "app/list/updated",
        "applyPatchApproval",
        "attestation/generate",
        "autoApprovalReview/strictReviewRequired",
        "command/exec/outputDelta",
        "configWarning",
        "deprecationNotice",
        "error",
        "execCommandApproval",
        "externalAgentConfig/import/completed",
        "externalAgentConfig/import/progress",
        "fs/changed",
        "fuzzyFileSearch/sessionCompleted",
        "fuzzyFileSearch/sessionUpdated",
        "guardianWarning",
        "hook/completed",
        "hook/started",
        "item/agentMessage/delta",
        "item/autoApprovalReview/completed",
        "item/autoApprovalReview/started",
        "item/commandExecution/outputDelta",
        "item/commandExecution/requestApproval",
        "item/commandExecution/terminalInteraction",
        "item/completed",
        "item/fileChange/outputDelta",
        "item/fileChange/patchUpdated",
        "item/fileChange/requestApproval",
        "item/mcpToolCall/progress",
        "item/permissions/requestApproval",
        "item/plan/delta",
        "item/reasoning/summaryPartAdded",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/textDelta",
        "item/started",
        "item/tool/call",
        "item/tool/requestUserInput",
        "mcpServer/elicitation/request",
        "mcpServer/event/stream/notification",
        "mcpServer/oauthLogin/completed",
        "mcpServer/startupStatus/updated",
        "model/rerouted",
        "model/safetyBuffering/updated",
        "model/verification",
        "modelProvider/authRecoveryCompleted",
        "modelProvider/authRecoveryStarted",
        "process/exited",
        "process/outputDelta",
        "project/changed",
        "remoteControl/status/changed",
        "serverRequest/resolved",
        "skills/changed",
        "thread/archived",
        "thread/attachment/updated",
        "thread/closed",
        "thread/compacted",
        "thread/deleted",
        "thread/environment/connected",
        "thread/environment/disconnected",
        "thread/goal/cleared",
        "thread/goal/updated",
        "thread/name/updated",
        "thread/prediction/updated",
        "thread/project/updated",
        "thread/queue/changed",
        "thread/readState/changed",
        "thread/realtime/closed",
        "thread/realtime/error",
        "thread/realtime/item/completed",
        "thread/realtime/item/started",
        "thread/realtime/item/transcript/delta",
        "thread/realtime/itemAdded",
        "thread/realtime/outputAudio/delta",
        "thread/realtime/sdp",
        "thread/realtime/started",
        "thread/realtime/transcript/delta",
        "thread/realtime/transcript/done",
        "thread/reverted",
        "thread/search/partial",
        "thread/section/changed",
        "thread/settings/updated",
        "thread/started",
        "thread/status/changed",
        "thread/tokenUsage/updated",
        "thread/unarchived",
        "turn/completed",
        "turn/diff/updated",
        "turn/moderationMetadata",
        "turn/plan/updated",
        "turn/started",
        "warning",
        "windows/worldWritableWarning",
        "windowsSandbox/setupCompleted"
      ]
    },
    "params": {
      "place": "message.params"
    },
    "result": {
      "place": "message.result"
    }
  },
  "message.error": {},
  "message.params": {
    "action": {
      "place": "message.params.action"
    },
    "additionalPermissions": {
      "place": "message.params.additionalPermissions"
    },
    "audio": {
      "place": "message.params.audio"
    },
    "authMode": {
      "words": [
        "agentIdentity",
        "apikey",
        "bedrockAccessKeys",
        "bedrockApiKey",
        "chatgpt",
        "chatgptAuthTokens",
        "headers",
        "personalAccessToken"
      ]
    },
    "availableDecisions": {
      "words": [
        "accept",
        "acceptForSession",
        "cancel",
        "decline"
      ],
      "place": "message.params.availableDecisions"
    },
    "changeType": {
      "words": [
        "created",
        "deleted",
        "updated"
      ]
    },
    "changes": {
      "place": "message.params.changes"
    },
    "commandActions": {
      "place": "message.params.commandActions"
    },
    "data": {
      "place": "message.params.data"
    },
    "decisionSource": {
      "words": [
        "agent"
      ]
    },
    "error": {
      "place": "message.params.error"
    },
    "failureReason": {
      "words": [
        "reauthenticationRequired"
      ]
    },
    "fileChanges": {
      "place": "message.params.fileChanges"
    },
    "files": {
      "place": "message.params.files"
    },
    "goal": {
      "place": "message.params.goal"
    },
    "item": {
      "place": "message.params.item"
    },
    "itemTypeResults": {
      "place": "message.params.itemTypeResults"
    },
    "kind": {
      "words": [
        "command",
        "humanCommand",
        "writeStdin"
      ]
    },
    "mode": {
      "words": [
        "elevated",
        "form",
        "openai/form",
        "openai/userVerification",
        "openaiForm",
        "unelevated",
        "url"
      ]
    },
    "networkApprovalContext": {
      "place": "message.params.networkApprovalContext"
    },
    "notification": {
      "place": "message.params.notification"
    },
    "onboardingEntrypoint": {
      "words": [
        "life_sciences"
      ]
    },
    "operation": {
      "words": [
        "created",
        "deleted"
      ]
    },
    "parsedCmd": {
      "place": "message.params.parsedCmd"
    },
    "permissions": {
      "place": "message.params.permissions"
    },
    "plan": {
      "place": "message.params.plan"
    },
    "planType": {
      "words": [
        "business",
        "edu",
        "edu_plus",
        "edu_pro",
        "ent26",
        "enterprise",
        "enterprise_cbp_automation",
        "enterprise_cbp_usage_based",
        "free",
        "go",
        "plus",
        "pro",
        "prolite",
        "promax",
        "sci",
        "sci_plus",
        "self_serve_business_prolite",
        "self_serve_business_usage_based",
        "team",
        "unknown"
      ]
    },
    "proposedNetworkPolicyAmendments": {
      "place": "message.params.proposedNetworkPolicyAmendments"
    },
    "questions": {
      "place": "message.params.questions"
    },
    "range": {
      "place": "message.params.range"
    },
    "rateLimits": {
      "place": "message.params.rateLimits"
    },
    "readState": {
      "place": "message.params.readState"
    },
    "reason": {
      "words": [
        "highRiskCyberActivity",
        "unauthorized",
        "unknown",
        "workspaceRoutingReady"
      ]
    },
    "requestedSchema": {
      "place": "message.params.requestedSchema"
    },
    "result": {
      "place": "message.params.result"
    },
    "review": {
      "place": "message.params.review"
    },
    "run": {
      "place": "message.params.run"
    },
    "status": {
      "words": [
        "cancelled",
        "connected",
        "connecting",
        "disabled",
        "errored",
        "failed",
        "notReady",
        "ready",
        "started",
        "starting",
        "succeeded"
      ],
      "place": "message.params.status"
    },
    "stream": {
      "words": [
        "stderr",
        "stdout"
      ]
    },
    "thread": {
      "place": "message.params.thread"
    },
    "threadSettings": {
      "place": "message.params.threadSettings"
    },
    "tokenUsage": {
      "place": "message.params.tokenUsage"
    },
    "turn": {
      "place": "message.params.turn"
    },
    "verifications": {
      "words": [
        "trustedAccessForCyber"
      ]
    },
    "version": {
      "words": [
        "v1",
        "v2",
        "v3"
      ]
    }
  },
  "message.params.action": {
    "permissions": {
      "place": "message.params.permissions"
    },
    "protocol": {
      "words": [
        "http",
        "https",
        "socks5Tcp",
        "socks5Udp"
      ]
    },
    "source": {
      "words": [
        "shell",
        "unifiedExec"
      ]
    },
    "type": {
      "words": [
        "applyPatch",
        "command",
        "execve",
        "mcpToolCall",
        "networkAccess",
        "requestPermissions",
        "writeStdin"
      ],
      "variants": {
        "applyPatch": "message.params.action[type=applyPatch]",
        "command": "message.params.action[type=command]",
        "execve": "message.params.action[type=execve]",
        "mcpToolCall": "message.params.action[type=mcpToolCall]",
        "networkAccess": "message.params.action[type=networkAccess]",
        "requestPermissions": "message.params.action[type=requestPermissions]",
        "writeStdin": "message.params.action[type=writeStdin]"
      }
    }
  },
  "message.params.action[type=applyPatch]": {
    "type": {
      "words": [
        "applyPatch"
      ]
    }
  },
  "message.params.action[type=command]": {
    "source": {
      "words": [
        "shell",
        "unifiedExec"
      ]
    },
    "type": {
      "words": [
        "command"
      ]
    }
  },
  "message.params.action[type=execve]": {
    "source": {
      "words": [
        "shell",
        "unifiedExec"
      ]
    },
    "type": {
      "words": [
        "execve"
      ]
    }
  },
  "message.params.action[type=mcpToolCall]": {
    "type": {
      "words": [
        "mcpToolCall"
      ]
    }
  },
  "message.params.action[type=networkAccess]": {
    "protocol": {
      "words": [
        "http",
        "https",
        "socks5Tcp",
        "socks5Udp"
      ]
    },
    "type": {
      "words": [
        "networkAccess"
      ]
    }
  },
  "message.params.action[type=requestPermissions]": {
    "permissions": {
      "place": "message.params.permissions"
    },
    "type": {
      "words": [
        "requestPermissions"
      ]
    }
  },
  "message.params.action[type=writeStdin]": {
    "type": {
      "words": [
        "writeStdin"
      ]
    }
  },
  "message.params.additionalPermissions": {
    "fileSystem": {
      "place": "message.params.additionalPermissions.fileSystem"
    },
    "network": {
      "place": "message.params.additionalPermissions.network"
    }
  },
  "message.params.additionalPermissions.fileSystem": {
    "entries": {
      "place": "message.params.additionalPermissions.fileSystem.entries"
    }
  },
  "message.params.additionalPermissions.fileSystem.entries": {
    "access": {
      "words": [
        "deny",
        "read",
        "write"
      ]
    },
    "path": {
      "place": "message.params.additionalPermissions.fileSystem.entries.path"
    }
  },
  "message.params.additionalPermissions.fileSystem.entries.path": {
    "type": {
      "words": [
        "glob_pattern",
        "path",
        "special"
      ],
      "variants": {
        "glob_pattern": "message.params.additionalPermissions.fileSystem.entries.path[type=glob_pattern]",
        "path": "message.params.additionalPermissions.fileSystem.entries.path[type=path]",
        "special": "message.params.additionalPermissions.fileSystem.entries.path[type=special]"
      }
    },
    "value": {
      "place": "message.params.additionalPermissions.fileSystem.entries.path.value"
    }
  },
  "message.params.additionalPermissions.fileSystem.entries.path.value": {
    "kind": {
      "words": [
        "minimal",
        "project_roots",
        "root",
        "slash_tmp",
        "tmpdir",
        "unknown"
      ],
      "variants": {
        "minimal": "message.params.additionalPermissions.fileSystem.entries.path.value[kind=minimal]",
        "project_roots": "message.params.additionalPermissions.fileSystem.entries.path.value[kind=project_roots]",
        "root": "message.params.additionalPermissions.fileSystem.entries.path.value[kind=root]",
        "slash_tmp": "message.params.additionalPermissions.fileSystem.entries.path.value[kind=slash_tmp]",
        "tmpdir": "message.params.additionalPermissions.fileSystem.entries.path.value[kind=tmpdir]",
        "unknown": "message.params.additionalPermissions.fileSystem.entries.path.value[kind=unknown]"
      }
    }
  },
  "message.params.additionalPermissions.fileSystem.entries.path.value[kind=minimal]": {
    "kind": {
      "words": [
        "minimal"
      ]
    }
  },
  "message.params.additionalPermissions.fileSystem.entries.path.value[kind=project_roots]": {
    "kind": {
      "words": [
        "project_roots"
      ]
    }
  },
  "message.params.additionalPermissions.fileSystem.entries.path.value[kind=root]": {
    "kind": {
      "words": [
        "root"
      ]
    }
  },
  "message.params.additionalPermissions.fileSystem.entries.path.value[kind=slash_tmp]": {
    "kind": {
      "words": [
        "slash_tmp"
      ]
    }
  },
  "message.params.additionalPermissions.fileSystem.entries.path.value[kind=tmpdir]": {
    "kind": {
      "words": [
        "tmpdir"
      ]
    }
  },
  "message.params.additionalPermissions.fileSystem.entries.path.value[kind=unknown]": {
    "kind": {
      "words": [
        "unknown"
      ]
    }
  },
  "message.params.additionalPermissions.fileSystem.entries.path[type=glob_pattern]": {
    "type": {
      "words": [
        "glob_pattern"
      ]
    }
  },
  "message.params.additionalPermissions.fileSystem.entries.path[type=path]": {
    "type": {
      "words": [
        "path"
      ]
    }
  },
  "message.params.additionalPermissions.fileSystem.entries.path[type=special]": {
    "type": {
      "words": [
        "special"
      ]
    },
    "value": {
      "place": "message.params.additionalPermissions.fileSystem.entries.path.value"
    }
  },
  "message.params.additionalPermissions.network": {},
  "message.params.audio": {},
  "message.params.availableDecisions": {
    "acceptWithExecpolicyAmendment": {
      "place": "message.params.availableDecisions.acceptWithExecpolicyAmendment"
    },
    "applyNetworkPolicyAmendment": {
      "place": "message.params.availableDecisions.applyNetworkPolicyAmendment"
    }
  },
  "message.params.availableDecisions.acceptWithExecpolicyAmendment": {},
  "message.params.availableDecisions.applyNetworkPolicyAmendment": {
    "network_policy_amendment": {
      "place": "message.params.proposedNetworkPolicyAmendments"
    }
  },
  "message.params.changes": {
    "kind": {
      "place": "message.params.changes.kind"
    }
  },
  "message.params.changes.kind": {
    "type": {
      "words": [
        "add",
        "delete",
        "update"
      ],
      "variants": {
        "add": "message.params.changes.kind[type=add]",
        "delete": "message.params.changes.kind[type=delete]",
        "update": "message.params.changes.kind[type=update]"
      }
    }
  },
  "message.params.changes.kind[type=add]": {
    "type": {
      "words": [
        "add"
      ]
    }
  },
  "message.params.changes.kind[type=delete]": {
    "type": {
      "words": [
        "delete"
      ]
    }
  },
  "message.params.changes.kind[type=update]": {
    "type": {
      "words": [
        "update"
      ]
    }
  },
  "message.params.commandActions": {
    "type": {
      "words": [
        "listFiles",
        "read",
        "search",
        "unknown"
      ],
      "variants": {
        "listFiles": "message.params.commandActions[type=listFiles]",
        "read": "message.params.commandActions[type=read]",
        "search": "message.params.commandActions[type=search]",
        "unknown": "message.params.commandActions[type=unknown]"
      }
    }
  },
  "message.params.commandActions[type=listFiles]": {
    "type": {
      "words": [
        "listFiles"
      ]
    }
  },
  "message.params.commandActions[type=read]": {
    "type": {
      "words": [
        "read"
      ]
    }
  },
  "message.params.commandActions[type=search]": {
    "type": {
      "words": [
        "search"
      ]
    }
  },
  "message.params.commandActions[type=unknown]": {
    "type": {
      "words": [
        "unknown"
      ]
    }
  },
  "message.params.data": {
    "appMetadata": {
      "place": "message.params.data.appMetadata"
    },
    "branding": {
      "place": "message.params.data.branding"
    },
    "iconAssets": {
      "place": "message.params.data.iconAssets"
    },
    "iconDarkAssets": {
      "place": "message.params.data.iconDarkAssets"
    },
    "labels": {
      "place": "message.params.data.labels"
    },
    "thread": {
      "place": "message.params.thread"
    }
  },
  "message.params.data.appMetadata": {
    "review": {
      "place": "message.params.data.appMetadata.review"
    },
    "screenshots": {
      "place": "message.params.data.appMetadata.screenshots"
    }
  },
  "message.params.data.appMetadata.review": {},
  "message.params.data.appMetadata.screenshots": {},
  "message.params.data.branding": {},
  "message.params.data.iconAssets": {
    "*": {}
  },
  "message.params.data.iconDarkAssets": {
    "*": {}
  },
  "message.params.data.labels": {
    "*": {}
  },
  "message.params.error": {
    "codexErrorInfo": {
      "words": [
        "apiKeySpendLimitExceeded",
        "badRequest",
        "bioPolicy",
        "contextWindowExceeded",
        "cyberPolicy",
        "flexUnavailable",
        "inferenceHookDenied",
        "internalServerError",
        "misalignmentPolicyViolation",
        "modelNotFound",
        "organizationSpendLimitExceeded",
        "other",
        "policyCapacityUnavailable",
        "projectSpendLimitExceeded",
        "rateLimitExceeded",
        "sandboxError",
        "serverOverloaded",
        "sessionBudgetExceeded",
        "threadRollbackFailed",
        "tooManyDenials",
        "unauthorized",
        "usageLimitExceeded"
      ],
      "place": "message.params.error.codexErrorInfo"
    },
    "misalignment": {
      "place": "message.params.error.misalignment"
    }
  },
  "message.params.error.codexErrorInfo": {
    "activeTurnNotSteerable": {
      "place": "message.params.error.codexErrorInfo.activeTurnNotSteerable"
    },
    "httpConnectionFailed": {
      "place": "message.params.error.codexErrorInfo.httpConnectionFailed"
    },
    "responseStreamConnectionFailed": {
      "place": "message.params.error.codexErrorInfo.responseStreamConnectionFailed"
    },
    "responseStreamDisconnected": {
      "place": "message.params.error.codexErrorInfo.responseStreamDisconnected"
    },
    "responseTooManyFailedAttempts": {
      "place": "message.params.error.codexErrorInfo.responseTooManyFailedAttempts"
    }
  },
  "message.params.error.codexErrorInfo.activeTurnNotSteerable": {
    "turnKind": {
      "words": [
        "compact",
        "review"
      ]
    }
  },
  "message.params.error.codexErrorInfo.httpConnectionFailed": {},
  "message.params.error.codexErrorInfo.responseStreamConnectionFailed": {},
  "message.params.error.codexErrorInfo.responseStreamDisconnected": {},
  "message.params.error.codexErrorInfo.responseTooManyFailedAttempts": {},
  "message.params.error.misalignment": {
    "steer": {
      "place": "message.params.error.misalignment.steer"
    }
  },
  "message.params.error.misalignment.steer": {},
  "message.params.fileChanges": {
    "*": {
      "place": "message.params.fileChanges.*"
    }
  },
  "message.params.fileChanges.*": {
    "type": {
      "words": [
        "add",
        "delete",
        "update"
      ],
      "variants": {
        "add": "message.params.fileChanges.*[type=add]",
        "delete": "message.params.fileChanges.*[type=delete]",
        "update": "message.params.fileChanges.*[type=update]"
      }
    }
  },
  "message.params.fileChanges.*[type=add]": {
    "type": {
      "words": [
        "add"
      ]
    }
  },
  "message.params.fileChanges.*[type=delete]": {
    "type": {
      "words": [
        "delete"
      ]
    }
  },
  "message.params.fileChanges.*[type=update]": {
    "type": {
      "words": [
        "update"
      ]
    }
  },
  "message.params.files": {
    "match_type": {
      "words": [
        "directory",
        "file"
      ]
    }
  },
  "message.params.goal": {
    "status": {
      "words": [
        "active",
        "blocked",
        "budgetLimited",
        "complete",
        "paused",
        "usageLimited"
      ]
    }
  },
  "message.params.item": {
    "action": {
      "place": "message.params.item.action"
    },
    "agentsStates": {
      "place": "message.params.item.agentsStates"
    },
    "appContext": {
      "place": "message.params.item.appContext"
    },
    "changes": {
      "place": "message.params.changes"
    },
    "channels": {
      "place": "message.params.item.channels"
    },
    "commandActions": {
      "place": "message.params.commandActions"
    },
    "content": {
      "place": "message.params.item.content"
    },
    "contentItems": {
      "place": "message.params.item.contentItems"
    },
    "delivery": {
      "words": [
        "async"
      ]
    },
    "error": {
      "place": "message.params.item.error"
    },
    "failure": {
      "place": "message.params.item.failure"
    },
    "fragments": {
      "place": "message.params.item.fragments"
    },
    "inputImages": {
      "place": "message.params.item.inputImages"
    },
    "kind": {
      "words": [
        "completed",
        "interacted",
        "interrupted",
        "started"
      ]
    },
    "mcpAppUi": {
      "place": "message.params.item.mcpAppUi"
    },
    "memoryCitation": {
      "place": "message.params.item.memoryCitation"
    },
    "mode": {
      "words": [
        "start",
        "steer"
      ]
    },
    "moderation": {
      "place": "message.params.item.moderation"
    },
    "outcome": {
      "words": [
        "ended",
        "failed"
      ]
    },
    "output": {
      "place": "message.params.item.output"
    },
    "phase": {
      "words": [
        "commentary",
        "final_answer",
        "partial_answer"
      ]
    },
    "presentation": {
      "place": "message.params.item.presentation"
    },
    "questions": {
      "place": "message.params.item.questions"
    },
    "reason": {
      "words": [
        "chunk",
        "sessionEnd"
      ]
    },
    "result": {
      "place": "message.params.item.result"
    },
    "role": {
      "words": [
        "assistant",
        "user"
      ]
    },
    "source": {
      "words": [
        "agent",
        "unifiedExecInteraction",
        "unifiedExecStartup",
        "userShell"
      ]
    },
    "status": {
      "words": [
        "completed",
        "declined",
        "failed",
        "inProgress",
        "interrupted"
      ]
    },
    "tool": {
      "words": [
        "closeAgent",
        "followupTask",
        "interruptAgent",
        "listAgents",
        "resumeAgent",
        "sendInput",
        "sendMessage",
        "spawnAgent",
        "wait"
      ]
    },
    "type": {
      "words": [
        "agentMessage",
        "bemItemPromoted",
        "collabAgentToolCall",
        "commandExecution",
        "contextCompaction",
        "dynamicToolCall",
        "enteredReviewMode",
        "exitedReviewMode",
        "fileChange",
        "frame",
        "functionCallOutput",
        "hookPrompt",
        "imageGeneration",
        "imageView",
        "mcpToolCall",
        "plan",
        "realtimeSessionClosed",
        "realtimeSessionStarted",
        "reasoning",
        "sessionInputSaved",
        "sleep",
        "subAgentActivity",
        "transcriptSegment",
        "turnInputAccepted",
        "userMessage",
        "webSearch"
      ]
    }
  },
  "message.params.item.action": {
    "type": {
      "words": [
        "findInPage",
        "openPage",
        "other",
        "search"
      ],
      "variants": {
        "findInPage": "message.params.item.action[type=findInPage]",
        "openPage": "message.params.item.action[type=openPage]",
        "other": "message.params.item.action[type=other]",
        "search": "message.params.item.action[type=search]"
      }
    }
  },
  "message.params.item.action[type=findInPage]": {
    "type": {
      "words": [
        "findInPage"
      ]
    }
  },
  "message.params.item.action[type=openPage]": {
    "type": {
      "words": [
        "openPage"
      ]
    }
  },
  "message.params.item.action[type=other]": {
    "type": {
      "words": [
        "other"
      ]
    }
  },
  "message.params.item.action[type=search]": {
    "type": {
      "words": [
        "search"
      ]
    }
  },
  "message.params.item.agentsStates": {
    "*": {
      "place": "message.params.item.agentsStates.*"
    }
  },
  "message.params.item.agentsStates.*": {
    "status": {
      "words": [
        "completed",
        "errored",
        "interrupted",
        "notFound",
        "pendingInit",
        "running",
        "shutdown"
      ]
    }
  },
  "message.params.item.appContext": {},
  "message.params.item.channels": {
    "voice_transcript": {
      "place": "message.params.item.channels.voice_transcript"
    }
  },
  "message.params.item.channels.voice_transcript": {
    "role": {
      "words": [
        "assistant",
        "user"
      ]
    }
  },
  "message.params.item.content": {
    "detail": {
      "words": [
        "auto",
        "high",
        "low",
        "original"
      ]
    },
    "text_elements": {
      "place": "message.params.item.content.text_elements"
    },
    "type": {
      "words": [
        "audio",
        "image",
        "localAudio",
        "localImage",
        "mention",
        "skill",
        "text"
      ]
    }
  },
  "message.params.item.content.text_elements": {
    "byteRange": {
      "place": "message.params.item.content.text_elements.byteRange"
    }
  },
  "message.params.item.content.text_elements.byteRange": {},
  "message.params.item.contentItems": {
    "type": {
      "words": [
        "inputAudio",
        "inputImage",
        "inputText"
      ],
      "variants": {
        "inputAudio": "message.params.item.contentItems[type=inputAudio]",
        "inputImage": "message.params.item.contentItems[type=inputImage]",
        "inputText": "message.params.item.contentItems[type=inputText]"
      }
    }
  },
  "message.params.item.contentItems[type=inputAudio]": {
    "type": {
      "words": [
        "inputAudio"
      ]
    }
  },
  "message.params.item.contentItems[type=inputImage]": {
    "type": {
      "words": [
        "inputImage"
      ]
    }
  },
  "message.params.item.contentItems[type=inputText]": {
    "type": {
      "words": [
        "inputText"
      ]
    }
  },
  "message.params.item.error": {},
  "message.params.item.failure": {
    "type": {
      "words": [
        "usageLimitExceeded"
      ]
    }
  },
  "message.params.item.fragments": {},
  "message.params.item.inputImages": {},
  "message.params.item.mcpAppUi": {
    "preferredModelDisplayMode": {
      "words": [
        "fullscreen",
        "inline"
      ]
    }
  },
  "message.params.item.memoryCitation": {
    "entries": {
      "place": "message.params.item.memoryCitation.entries"
    }
  },
  "message.params.item.memoryCitation.entries": {},
  "message.params.item.moderation": {
    "display": {
      "place": "message.params.item.moderation.display"
    }
  },
  "message.params.item.moderation.display": {
    "annotation": {
      "place": "message.params.item.moderation.display.annotation"
    },
    "mode": {
      "words": [
        "block",
        "hide",
        "show"
      ],
      "variants": {
        "block": "message.params.item.moderation.display[mode=block]",
        "hide": "message.params.item.moderation.display[mode=hide]",
        "show": "message.params.item.moderation.display[mode=show]"
      }
    },
    "reason": {
      "place": "message.params.item.moderation.display.reason"
    },
    "replacement": {
      "place": "message.params.item.moderation.display.replacement"
    },
    "trustedContacts": {
      "words": [
        "check",
        "skip"
      ]
    }
  },
  "message.params.item.moderation.display.annotation": {
    "kind": {
      "words": [
        "wellbeingHelpline"
      ]
    },
    "subject": {
      "words": [
        "answer",
        "prompt"
      ]
    }
  },
  "message.params.item.moderation.display.reason": {
    "kind": {
      "words": [
        "cyber",
        "protection"
      ],
      "variants": {
        "cyber": "message.params.item.moderation.display.reason[kind=cyber]",
        "protection": "message.params.item.moderation.display.reason[kind=protection]"
      }
    }
  },
  "message.params.item.moderation.display.reason[kind=cyber]": {
    "kind": {
      "words": [
        "cyber"
      ]
    }
  },
  "message.params.item.moderation.display.reason[kind=protection]": {
    "kind": {
      "words": [
        "protection"
      ]
    }
  },
  "message.params.item.moderation.display.replacement": {
    "kind": {
      "words": [
        "wellbeingPromptHelpline"
      ]
    }
  },
  "message.params.item.moderation.display[mode=block]": {
    "mode": {
      "words": [
        "block"
      ]
    },
    "reason": {
      "place": "message.params.item.moderation.display.reason"
    }
  },
  "message.params.item.moderation.display[mode=hide]": {
    "mode": {
      "words": [
        "hide"
      ]
    },
    "replacement": {
      "place": "message.params.item.moderation.display.replacement"
    }
  },
  "message.params.item.moderation.display[mode=show]": {
    "annotation": {
      "place": "message.params.item.moderation.display.annotation"
    },
    "mode": {
      "words": [
        "show"
      ]
    },
    "trustedContacts": {
      "words": [
        "check",
        "skip"
      ]
    }
  },
  "message.params.item.output": {
    "detail": {
      "words": [
        "auto",
        "high",
        "low",
        "original"
      ]
    },
    "type": {
      "words": [
        "encrypted_content",
        "input_audio",
        "input_image",
        "input_text"
      ]
    }
  },
  "message.params.item.presentation": {
    "type": {
      "words": [
        "inlineMarkdown",
        "inlineVisualization",
        "wholeItem"
      ],
      "variants": {
        "inlineMarkdown": "message.params.item.presentation[type=inlineMarkdown]",
        "inlineVisualization": "message.params.item.presentation[type=inlineVisualization]",
        "wholeItem": "message.params.item.presentation[type=wholeItem]"
      }
    }
  },
  "message.params.item.presentation[type=inlineMarkdown]": {
    "type": {
      "words": [
        "inlineMarkdown"
      ]
    }
  },
  "message.params.item.presentation[type=inlineVisualization]": {
    "type": {
      "words": [
        "inlineVisualization"
      ]
    }
  },
  "message.params.item.presentation[type=wholeItem]": {
    "type": {
      "words": [
        "wholeItem"
      ]
    }
  },
  "message.params.item.questions": {},
  "message.params.item.result": {},
  "message.params.itemTypeResults": {
    "failures": {
      "place": "message.params.itemTypeResults.failures"
    },
    "itemType": {
      "words": [
        "AGENTS_MD",
        "COMMANDS",
        "CONFIG",
        "HOOKS",
        "MCP_SERVER_CONFIG",
        "MEMORY",
        "PLUGINS",
        "SESSIONS",
        "SKILLS",
        "SUBAGENTS"
      ]
    },
    "successes": {
      "place": "message.params.itemTypeResults.successes"
    }
  },
  "message.params.itemTypeResults.failures": {
    "itemType": {
      "words": [
        "AGENTS_MD",
        "COMMANDS",
        "CONFIG",
        "HOOKS",
        "MCP_SERVER_CONFIG",
        "MEMORY",
        "PLUGINS",
        "SESSIONS",
        "SKILLS",
        "SUBAGENTS"
      ]
    }
  },
  "message.params.itemTypeResults.successes": {
    "itemType": {
      "words": [
        "AGENTS_MD",
        "COMMANDS",
        "CONFIG",
        "HOOKS",
        "MCP_SERVER_CONFIG",
        "MEMORY",
        "PLUGINS",
        "SESSIONS",
        "SKILLS",
        "SUBAGENTS"
      ]
    }
  },
  "message.params.networkApprovalContext": {
    "protocol": {
      "words": [
        "http",
        "https",
        "socks5Tcp",
        "socks5Udp"
      ]
    }
  },
  "message.params.notification": {},
  "message.params.parsedCmd": {
    "type": {
      "words": [
        "list_files",
        "read",
        "search",
        "unknown"
      ],
      "variants": {
        "list_files": "message.params.parsedCmd[type=list_files]",
        "read": "message.params.parsedCmd[type=read]",
        "search": "message.params.parsedCmd[type=search]",
        "unknown": "message.params.parsedCmd[type=unknown]"
      }
    }
  },
  "message.params.parsedCmd[type=list_files]": {
    "type": {
      "words": [
        "list_files"
      ]
    }
  },
  "message.params.parsedCmd[type=read]": {
    "type": {
      "words": [
        "read"
      ]
    }
  },
  "message.params.parsedCmd[type=search]": {
    "type": {
      "words": [
        "search"
      ]
    }
  },
  "message.params.parsedCmd[type=unknown]": {
    "type": {
      "words": [
        "unknown"
      ]
    }
  },
  "message.params.permissions": {
    "fileSystem": {
      "place": "message.params.additionalPermissions.fileSystem"
    },
    "network": {
      "place": "message.params.additionalPermissions.network"
    }
  },
  "message.params.plan": {
    "status": {
      "words": [
        "completed",
        "inProgress",
        "pending"
      ]
    }
  },
  "message.params.proposedNetworkPolicyAmendments": {
    "action": {
      "words": [
        "allow",
        "deny"
      ]
    }
  },
  "message.params.questions": {
    "options": {
      "place": "message.params.questions.options"
    }
  },
  "message.params.questions.options": {},
  "message.params.range": {
    "end": {
      "place": "message.params.range.end"
    },
    "start": {
      "place": "message.params.range.end"
    }
  },
  "message.params.range.end": {},
  "message.params.rateLimits": {
    "credits": {
      "place": "message.params.rateLimits.credits"
    },
    "individualLimit": {
      "place": "message.params.rateLimits.individualLimit"
    },
    "planType": {
      "words": [
        "business",
        "edu",
        "edu_plus",
        "edu_pro",
        "ent26",
        "enterprise",
        "enterprise_cbp_automation",
        "enterprise_cbp_usage_based",
        "free",
        "go",
        "plus",
        "pro",
        "prolite",
        "promax",
        "sci",
        "sci_plus",
        "self_serve_business_prolite",
        "self_serve_business_usage_based",
        "team",
        "unknown"
      ]
    },
    "primary": {
      "place": "message.params.rateLimits.primary"
    },
    "rateLimitReachedType": {
      "words": [
        "rate_limit_reached",
        "workspace_member_credits_depleted",
        "workspace_member_usage_limit_reached",
        "workspace_owner_credits_depleted",
        "workspace_owner_usage_limit_reached"
      ]
    },
    "secondary": {
      "place": "message.params.rateLimits.primary"
    }
  },
  "message.params.rateLimits.credits": {},
  "message.params.rateLimits.individualLimit": {},
  "message.params.rateLimits.primary": {},
  "message.params.readState": {
    "firstUnread": {
      "place": "message.params.readState.firstUnread"
    }
  },
  "message.params.readState.firstUnread": {
    "type": {
      "words": [
        "threadStart",
        "turn"
      ],
      "variants": {
        "threadStart": "message.params.readState.firstUnread[type=threadStart]",
        "turn": "message.params.readState.firstUnread[type=turn]"
      }
    }
  },
  "message.params.readState.firstUnread[type=threadStart]": {
    "type": {
      "words": [
        "threadStart"
      ]
    }
  },
  "message.params.readState.firstUnread[type=turn]": {
    "type": {
      "words": [
        "turn"
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
      ],
      "variants": {
        "array": "message.params.requestedSchema.properties.*[type=array]",
        "boolean": "message.params.requestedSchema.properties.*[type=boolean]",
        "integer": "message.params.requestedSchema.properties.*[type=integer]",
        "number": "message.params.requestedSchema.properties.*[type=integer]",
        "string": "message.params.requestedSchema.properties.*[type=string]"
      }
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
  "message.params.requestedSchema.properties.*[type=array]": {
    "items": {
      "place": "message.params.requestedSchema.properties.*.items"
    },
    "type": {
      "words": [
        "array"
      ]
    }
  },
  "message.params.requestedSchema.properties.*[type=boolean]": {
    "type": {
      "words": [
        "boolean"
      ]
    }
  },
  "message.params.requestedSchema.properties.*[type=integer]": {
    "type": {
      "words": [
        "integer",
        "number"
      ]
    }
  },
  "message.params.requestedSchema.properties.*[type=string]": {
    "format": {
      "words": [
        "date",
        "date-time",
        "email",
        "uri"
      ]
    },
    "oneOf": {
      "place": "message.params.requestedSchema.properties.*.oneOf"
    },
    "type": {
      "words": [
        "string"
      ]
    }
  },
  "message.params.result": {
    "type": {
      "words": [
        "completed",
        "failed"
      ],
      "variants": {
        "completed": "message.params.result[type=completed]",
        "failed": "message.params.result[type=failed]"
      }
    }
  },
  "message.params.result[type=completed]": {
    "type": {
      "words": [
        "completed"
      ]
    }
  },
  "message.params.result[type=failed]": {
    "type": {
      "words": [
        "failed"
      ]
    }
  },
  "message.params.review": {
    "riskLevel": {
      "words": [
        "critical",
        "high",
        "low",
        "medium"
      ]
    },
    "status": {
      "words": [
        "aborted",
        "approved",
        "denied",
        "inProgress",
        "timedOut"
      ]
    },
    "userAuthorization": {
      "words": [
        "high",
        "low",
        "medium",
        "unknown"
      ]
    }
  },
  "message.params.run": {
    "entries": {
      "place": "message.params.run.entries"
    },
    "eventName": {
      "words": [
        "interrupt",
        "permissionRequest",
        "postCompact",
        "postModelRequest",
        "postToolUse",
        "preCompact",
        "preModelRequest",
        "preToolUse",
        "sessionEnd",
        "sessionStart",
        "stop",
        "subagentStart",
        "subagentStop",
        "userPromptSubmit"
      ]
    },
    "executionMode": {
      "words": [
        "async",
        "sync"
      ]
    },
    "handlerType": {
      "words": [
        "agent",
        "command",
        "mcpTool",
        "prompt"
      ]
    },
    "scope": {
      "words": [
        "thread",
        "turn"
      ]
    },
    "source": {
      "words": [
        "cloudManagedConfig",
        "cloudRequirements",
        "legacyManagedConfigFile",
        "legacyManagedConfigMdm",
        "mdm",
        "plugin",
        "project",
        "sessionFlags",
        "system",
        "unknown",
        "user"
      ]
    },
    "status": {
      "words": [
        "blocked",
        "completed",
        "failed",
        "running",
        "stopped"
      ]
    }
  },
  "message.params.run.entries": {
    "kind": {
      "words": [
        "context",
        "error",
        "feedback",
        "stop",
        "warning"
      ]
    }
  },
  "message.params.status": {
    "activeFlags": {
      "words": [
        "waitingOnApproval",
        "waitingOnUserInput"
      ]
    },
    "type": {
      "words": [
        "active",
        "idle",
        "notLoaded",
        "systemError"
      ],
      "variants": {
        "active": "message.params.status[type=active]",
        "idle": "message.params.status[type=idle]",
        "notLoaded": "message.params.status[type=notLoaded]",
        "systemError": "message.params.status[type=systemError]"
      }
    }
  },
  "message.params.status[type=active]": {
    "activeFlags": {
      "words": [
        "waitingOnApproval",
        "waitingOnUserInput"
      ]
    },
    "type": {
      "words": [
        "active"
      ]
    }
  },
  "message.params.status[type=idle]": {
    "type": {
      "words": [
        "idle"
      ]
    }
  },
  "message.params.status[type=notLoaded]": {
    "type": {
      "words": [
        "notLoaded"
      ]
    }
  },
  "message.params.status[type=systemError]": {
    "type": {
      "words": [
        "systemError"
      ]
    }
  },
  "message.params.thread": {
    "environments": {
      "place": "message.params.thread.environments"
    },
    "gitInfo": {
      "place": "message.params.thread.gitInfo"
    },
    "historyMode": {
      "words": [
        "legacy",
        "paginated"
      ]
    },
    "section": {
      "place": "message.params.thread.section"
    },
    "source": {
      "words": [
        "appServer",
        "cli",
        "exec",
        "unknown",
        "vscode"
      ],
      "place": "message.params.thread.source"
    },
    "status": {
      "place": "message.params.status"
    },
    "turns": {
      "place": "message.params.turn"
    }
  },
  "message.params.thread.environments": {},
  "message.params.thread.gitInfo": {},
  "message.params.thread.section": {
    "appearance": {
      "place": "message.params.thread.section.appearance"
    }
  },
  "message.params.thread.section.appearance": {},
  "message.params.thread.source": {
    "subAgent": {
      "words": [
        "compact",
        "memory_consolidation",
        "review"
      ],
      "place": "message.params.thread.source.subAgent"
    }
  },
  "message.params.thread.source.subAgent": {
    "thread_spawn": {
      "place": "message.params.thread.source.subAgent.thread_spawn"
    }
  },
  "message.params.thread.source.subAgent.thread_spawn": {},
  "message.params.threadSettings": {
    "activePermissionProfile": {
      "place": "message.result.activePermissionProfile"
    },
    "approvalPolicy": {
      "words": [
        "never",
        "on-request",
        "untrusted"
      ],
      "place": "message.result.approvalPolicy"
    },
    "approvalsReviewer": {
      "words": [
        "auto_review",
        "guardian_subagent",
        "user"
      ]
    },
    "collaborationMode": {
      "place": "message.result.collaborationMode"
    },
    "environments": {
      "place": "message.params.thread.environments"
    },
    "multiAgentMode": {
      "words": [
        "explicitRequestOnly",
        "proactive"
      ],
      "place": "message.result.multiAgentMode"
    },
    "personality": {
      "words": [
        "friendly",
        "none",
        "pragmatic"
      ]
    },
    "sandboxPolicy": {
      "place": "message.result.sandbox"
    },
    "summary": {
      "words": [
        "auto",
        "concise",
        "detailed",
        "none"
      ]
    }
  },
  "message.params.tokenUsage": {
    "last": {
      "place": "message.params.tokenUsage.last"
    },
    "total": {
      "place": "message.params.tokenUsage.last"
    }
  },
  "message.params.tokenUsage.last": {},
  "message.params.turn": {
    "error": {
      "place": "message.params.error"
    },
    "items": {
      "place": "message.params.turn.items"
    },
    "itemsView": {
      "words": [
        "full",
        "notLoaded",
        "summary"
      ]
    },
    "status": {
      "words": [
        "completed",
        "failed",
        "inProgress",
        "interrupted"
      ]
    }
  },
  "message.params.turn.items": {
    "action": {
      "place": "message.params.item.action"
    },
    "agentsStates": {
      "place": "message.params.item.agentsStates"
    },
    "appContext": {
      "place": "message.params.item.appContext"
    },
    "changes": {
      "place": "message.params.changes"
    },
    "commandActions": {
      "place": "message.params.commandActions"
    },
    "content": {
      "place": "message.params.item.content"
    },
    "contentItems": {
      "place": "message.params.item.contentItems"
    },
    "delivery": {
      "words": [
        "async"
      ]
    },
    "error": {
      "place": "message.params.item.error"
    },
    "failure": {
      "place": "message.params.item.failure"
    },
    "fragments": {
      "place": "message.params.item.fragments"
    },
    "inputImages": {
      "place": "message.params.item.inputImages"
    },
    "kind": {
      "words": [
        "completed",
        "interacted",
        "interrupted",
        "started"
      ]
    },
    "mcpAppUi": {
      "place": "message.params.item.mcpAppUi"
    },
    "memoryCitation": {
      "place": "message.params.item.memoryCitation"
    },
    "moderation": {
      "place": "message.params.item.moderation"
    },
    "output": {
      "place": "message.params.item.output"
    },
    "phase": {
      "words": [
        "commentary",
        "final_answer",
        "partial_answer"
      ]
    },
    "questions": {
      "place": "message.params.item.questions"
    },
    "result": {
      "place": "message.params.item.result"
    },
    "source": {
      "words": [
        "agent",
        "unifiedExecInteraction",
        "unifiedExecStartup",
        "userShell"
      ]
    },
    "status": {
      "words": [
        "completed",
        "declined",
        "failed",
        "inProgress",
        "interrupted"
      ]
    },
    "tool": {
      "words": [
        "closeAgent",
        "followupTask",
        "interruptAgent",
        "listAgents",
        "resumeAgent",
        "sendInput",
        "sendMessage",
        "spawnAgent",
        "wait"
      ]
    },
    "type": {
      "words": [
        "agentMessage",
        "collabAgentToolCall",
        "commandExecution",
        "contextCompaction",
        "dynamicToolCall",
        "enteredReviewMode",
        "exitedReviewMode",
        "fileChange",
        "functionCallOutput",
        "hookPrompt",
        "imageGeneration",
        "imageView",
        "mcpToolCall",
        "plan",
        "reasoning",
        "sleep",
        "subAgentActivity",
        "userMessage",
        "webSearch"
      ]
    }
  },
  "message.result": {
    "account": {
      "place": "message.result.account"
    },
    "activePermissionProfile": {
      "place": "message.result.activePermissionProfile"
    },
    "approvalPolicy": {
      "words": [
        "never",
        "on-request",
        "untrusted"
      ],
      "place": "message.result.approvalPolicy"
    },
    "approvalsReviewer": {
      "words": [
        "auto_review",
        "guardian_subagent",
        "user"
      ]
    },
    "collaborationMode": {
      "place": "message.result.collaborationMode"
    },
    "contents": {
      "place": "message.result.contents"
    },
    "data": {
      "place": "message.result.data"
    },
    "goal": {
      "place": "message.params.goal"
    },
    "initialTurnsPage": {
      "place": "message.result.initialTurnsPage"
    },
    "multiAgentMode": {
      "words": [
        "explicitRequestOnly",
        "proactive"
      ],
      "place": "message.result.multiAgentMode"
    },
    "outcome": {
      "words": [
        "alreadyRedeemed",
        "noCredit",
        "nothingToReset",
        "reset"
      ]
    },
    "rateLimitResetCredits": {
      "place": "message.result.rateLimitResetCredits"
    },
    "rateLimits": {
      "place": "message.params.rateLimits"
    },
    "rateLimitsByLimitId": {
      "place": "message.result.rateLimitsByLimitId"
    },
    "readState": {
      "place": "message.params.readState"
    },
    "readStates": {
      "place": "message.result.readStates"
    },
    "sandbox": {
      "place": "message.result.sandbox"
    },
    "status": {
      "words": [
        "canceled",
        "notFound",
        "notLoaded",
        "notSubscribed",
        "unsubscribed"
      ]
    },
    "thread": {
      "place": "message.params.thread"
    },
    "turn": {
      "place": "message.params.turn"
    },
    "type": {
      "words": [
        "amazonBedrock",
        "apiKey",
        "chatgpt",
        "chatgptAuthTokens",
        "chatgptDeviceCode"
      ]
    },
    "workspaceRouting": {
      "place": "message.result.workspaceRouting"
    }
  },
  "message.result.account": {
    "planType": {
      "words": [
        "business",
        "edu",
        "edu_plus",
        "edu_pro",
        "ent26",
        "enterprise",
        "enterprise_cbp_automation",
        "enterprise_cbp_usage_based",
        "free",
        "go",
        "plus",
        "pro",
        "prolite",
        "promax",
        "sci",
        "sci_plus",
        "self_serve_business_prolite",
        "self_serve_business_usage_based",
        "team",
        "unknown"
      ]
    },
    "type": {
      "words": [
        "amazonBedrock",
        "apiKey",
        "chatgpt",
        "gcp"
      ],
      "variants": {
        "amazonBedrock": "message.result.account[type=amazonBedrock]",
        "apiKey": "message.result.account[type=apiKey]",
        "chatgpt": "message.result.account[type=chatgpt]",
        "gcp": "message.result.account[type=gcp]"
      }
    }
  },
  "message.result.account[type=amazonBedrock]": {
    "type": {
      "words": [
        "amazonBedrock"
      ]
    }
  },
  "message.result.account[type=apiKey]": {
    "type": {
      "words": [
        "apiKey"
      ]
    }
  },
  "message.result.account[type=chatgpt]": {
    "planType": {
      "words": [
        "business",
        "edu",
        "edu_plus",
        "edu_pro",
        "ent26",
        "enterprise",
        "enterprise_cbp_automation",
        "enterprise_cbp_usage_based",
        "free",
        "go",
        "plus",
        "pro",
        "prolite",
        "promax",
        "sci",
        "sci_plus",
        "self_serve_business_prolite",
        "self_serve_business_usage_based",
        "team",
        "unknown"
      ]
    },
    "type": {
      "words": [
        "chatgpt"
      ]
    }
  },
  "message.result.account[type=gcp]": {
    "type": {
      "words": [
        "gcp"
      ]
    }
  },
  "message.result.activePermissionProfile": {},
  "message.result.approvalPolicy": {
    "granular": {
      "place": "message.result.approvalPolicy.granular"
    }
  },
  "message.result.approvalPolicy.granular": {},
  "message.result.collaborationMode": {
    "mode": {
      "words": [
        "default",
        "plan"
      ]
    },
    "settings": {
      "place": "message.result.collaborationMode.settings"
    }
  },
  "message.result.collaborationMode.settings": {},
  "message.result.contents": {},
  "message.result.data": {
    "authStatus": {
      "words": [
        "bearerToken",
        "notLoggedIn",
        "oAuth",
        "unknown",
        "unsupported"
      ]
    },
    "availabilityNux": {
      "place": "message.result.data.availabilityNux"
    },
    "availableAccessPrograms": {
      "place": "message.result.data.availableAccessPrograms"
    },
    "environments": {
      "place": "message.params.thread.environments"
    },
    "error": {
      "place": "message.params.error"
    },
    "gitInfo": {
      "place": "message.params.thread.gitInfo"
    },
    "historyMode": {
      "words": [
        "legacy",
        "paginated"
      ]
    },
    "inputModalities": {
      "words": [
        "audio",
        "image",
        "text"
      ]
    },
    "items": {
      "place": "message.params.turn.items"
    },
    "itemsView": {
      "words": [
        "full",
        "notLoaded",
        "summary"
      ]
    },
    "multiAgentVersion": {
      "words": [
        "disabled",
        "v1",
        "v2"
      ]
    },
    "resourceTemplates": {
      "place": "message.result.data.resourceTemplates"
    },
    "resources": {
      "place": "message.result.data.resources"
    },
    "runtimeStatus": {
      "words": [
        "authenticationRequired",
        "cancelled",
        "connected",
        "disabled",
        "failed",
        "notStarted",
        "starting"
      ]
    },
    "section": {
      "place": "message.params.thread.section"
    },
    "serverInfo": {
      "place": "message.result.data.serverInfo"
    },
    "serviceTiers": {
      "place": "message.result.data.serviceTiers"
    },
    "source": {
      "words": [
        "appServer",
        "cli",
        "exec",
        "unknown",
        "vscode"
      ],
      "place": "message.params.thread.source"
    },
    "status": {
      "words": [
        "completed",
        "failed",
        "inProgress",
        "interrupted"
      ],
      "place": "message.params.status"
    },
    "supportedReasoningEfforts": {
      "place": "message.result.data.supportedReasoningEfforts"
    },
    "tools": {
      "place": "message.result.data.tools"
    },
    "turns": {
      "place": "message.params.turn"
    },
    "upgradeInfo": {
      "place": "message.result.data.upgradeInfo"
    }
  },
  "message.result.data.availabilityNux": {},
  "message.result.data.availableAccessPrograms": {
    "cyber": {
      "words": [
        "daybreakBlue",
        "daybreakRed",
        "standard"
      ]
    },
    "daybreakAvailability": {
      "words": [
        "available",
        "default",
        "enrollmentRequired",
        "unavailableForModel"
      ]
    }
  },
  "message.result.data.resourceTemplates": {},
  "message.result.data.resources": {},
  "message.result.data.serverInfo": {},
  "message.result.data.serviceTiers": {},
  "message.result.data.supportedReasoningEfforts": {},
  "message.result.data.tools": {
    "*": {
      "place": "message.result.data.tools.*"
    }
  },
  "message.result.data.tools.*": {},
  "message.result.data.upgradeInfo": {},
  "message.result.initialTurnsPage": {
    "data": {
      "place": "message.params.turn"
    }
  },
  "message.result.multiAgentMode": {},
  "message.result.rateLimitResetCredits": {
    "credits": {
      "place": "message.result.rateLimitResetCredits.credits"
    }
  },
  "message.result.rateLimitResetCredits.credits": {
    "resetType": {
      "words": [
        "codexRateLimits",
        "unknown"
      ]
    },
    "status": {
      "words": [
        "available",
        "redeemed",
        "redeeming",
        "unknown"
      ]
    }
  },
  "message.result.rateLimitsByLimitId": {
    "*": {
      "place": "message.params.rateLimits"
    }
  },
  "message.result.readStates": {
    "*": {
      "place": "message.params.readState"
    }
  },
  "message.result.sandbox": {
    "networkAccess": {
      "words": [
        "enabled",
        "restricted"
      ]
    },
    "type": {
      "words": [
        "dangerFullAccess",
        "externalSandbox",
        "readOnly",
        "workspaceWrite"
      ],
      "variants": {
        "dangerFullAccess": "message.result.sandbox[type=dangerFullAccess]",
        "externalSandbox": "message.result.sandbox[type=externalSandbox]",
        "readOnly": "message.result.sandbox[type=readOnly]",
        "workspaceWrite": "message.result.sandbox[type=workspaceWrite]"
      }
    }
  },
  "message.result.sandbox[type=dangerFullAccess]": {
    "type": {
      "words": [
        "dangerFullAccess"
      ]
    }
  },
  "message.result.sandbox[type=externalSandbox]": {
    "networkAccess": {
      "words": [
        "enabled",
        "restricted"
      ]
    },
    "type": {
      "words": [
        "externalSandbox"
      ]
    }
  },
  "message.result.sandbox[type=readOnly]": {
    "type": {
      "words": [
        "readOnly"
      ]
    }
  },
  "message.result.sandbox[type=workspaceWrite]": {
    "type": {
      "words": [
        "workspaceWrite"
      ]
    }
  },
  "message.result.workspaceRouting": {
    "accountRoutingOverride": {
      "words": [
        "NO_CONSTRAINT",
        "us",
        "us_cr"
      ]
    }
  }
};
