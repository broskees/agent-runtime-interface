// Type-level proof that the driver's own description of the Claude Agent SDK
// (src/drivers/claude/sdk.ts) matches the pinned SDK devDependency
// (@anthropic-ai/claude-agent-sdk 0.3.330). `pnpm run typecheck` fails when
// either side drifts:
//
// - Sent: the SDK module is assignable to the driver's `ClaudeSdk`. Its
//   functions are function declarations, so their parameters are checked
//   contravariantly: every prompt, option (canUseTool and its permission
//   results included) and MCP config the driver can pass is one the SDK
//   accepts. Query's methods are method declarations, which TypeScript
//   compares bivariantly, so each method the driver calls is also checked
//   explicitly: the driver's argument types must be assignable to the SDK's,
//   and the SDK's answers to what the driver expects.
// - Read: every field the driver reads from a message exists in the SDK's
//   type for that message, and every SDK message of that kind is assignable
//   to the driver's view of it.
//
// The fake SDK (fake-sdk.ts) is typed by the SDK itself, and the harness
// hands it to the driver as `ClaudeSdk`, so every frame either side
// produces in any test is checked against the vendor's types.

import type * as ClaudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import type {
  AccountInfo,
  McpSetServersResult,
  ModelInfo,
  Query,
  RewindFilesResult,
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKCommandsChangedMessage,
  SDKCompactBoundaryMessage,
  SDKControlInitializeResponse,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKPartialAssistantMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKSessionInfo,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SessionMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type { BetaTextBlock, BetaThinkingBlock, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import type {
  ClaudeAccountInfo,
  ClaudeApiRetryMessage,
  ClaudeAssistantMessage,
  ClaudeCommandsChangedMessage,
  ClaudeCompactBoundaryMessage,
  ClaudeHookMessage,
  ClaudeInitMessage,
  ClaudeInitializeResult,
  ClaudeModelInfo,
  ClaudeQuery,
  ClaudeRateLimitEvent,
  ClaudeRateLimitInfo,
  ClaudeResultMessage,
  ClaudeRewindResult,
  ClaudeSdk,
  ClaudeSessionInfo,
  ClaudeSessionMessage,
  ClaudeSetServersResult,
  ClaudeSlashCommand,
  ClaudeStreamEventMessage,
  ClaudeTaskNotificationMessage,
  ClaudeTaskStartedMessage,
  ClaudeTaskUpdatedMessage,
  ClaudeUserMessage,
  ClaudeUserMessageOut,
} from "../../../src/drivers/claude/sdk.ts";
import type { FakeSdkModule } from "./fake-sdk.ts";

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
/** Every key of every member of a union. */
type AnyKey<T> = T extends unknown ? keyof T : never;
/** True when every field `View` names exists in `Real` (in some member of a union) and every `Real` is a `View`. */
type Covers<View, Real> = [Exclude<keyof View, AnyKey<Real>>] extends [never] ? Extends<Real, View> : { readonly missingInSdk: Exclude<keyof View, AnyKey<Real>> };

// Sent: the SDK module is what the driver calls.

type SdkModule = Pick<typeof ClaudeAgentSdk, "query" | "getSessionInfo" | "getSessionMessages" | "listSessions" | "deleteSession" | "archiveSession">;
export const sdkModuleIsDriverSdk = (sdk: SdkModule): ClaudeSdk => sdk;
export const fakeIsDriverSdk = (sdk: FakeSdkModule): ClaudeSdk => sdk;
export type PromptsTheSdkAccepts = Assert<Extends<ClaudeUserMessage, SDKUserMessage>>;
export type OptionsTheSdkAccepts = Assert<Extends<NonNullable<Parameters<ClaudeSdk["query"]>[0]["options"]>, NonNullable<Parameters<typeof ClaudeAgentSdk.query>[0]["options"]>>>;

/** For each Query method the driver calls: its arguments are the SDK's, and the SDK's answer is what it reads. */
type MethodMatches<Name extends keyof ClaudeQuery & keyof Query> = ClaudeQuery[Name] extends (...args: infer DriverArgs) => infer DriverResult
  ? Query[Name] extends (...args: infer SdkArgs) => infer SdkResult
    ? [Extends<DriverArgs, SdkArgs>, Extends<Awaited<SdkResult>, Awaited<DriverResult>>] extends [true, true]
      ? true
      : { readonly method: Name; readonly argumentsAccepted: Extends<DriverArgs, SdkArgs>; readonly answerRead: Extends<Awaited<SdkResult>, Awaited<DriverResult>> }
    : false
  : false;

export type QueryMethods = [
  Assert<MethodMatches<"interrupt">>,
  Assert<MethodMatches<"setPermissionMode">>,
  Assert<MethodMatches<"setModel">>,
  Assert<MethodMatches<"setMcpServers">>,
  Assert<MethodMatches<"applyFlagSettings">>,
  Assert<MethodMatches<"stopTask">>,
  Assert<MethodMatches<"rewindFiles">>,
  Assert<MethodMatches<"initializationResult">>,
  Assert<MethodMatches<"supportedModels">>,
  Assert<MethodMatches<"close">>,
  Assert<Extends<Query, AsyncIterable<SDKUserMessage | SDKAssistantMessage | SDKResultMessage> | AsyncIterable<unknown>>>,
];

// Read: every field the driver reads is the SDK's.

export type MessagesRead = [
  Assert<Covers<ClaudeAssistantMessage, SDKAssistantMessage>>,
  Assert<Covers<{ type: "text"; text: string }, BetaTextBlock>>,
  Assert<Covers<{ type: "thinking"; thinking: string }, BetaThinkingBlock>>,
  Assert<Covers<{ type: "tool_use"; id: string; name: string; input: unknown }, BetaToolUseBlock>>,
  Assert<Covers<ClaudeUserMessageOut, SDKUserMessage | SDKUserMessageReplay>>,
  Assert<Covers<ClaudeStreamEventMessage, SDKPartialAssistantMessage>>,
  Assert<Covers<ClaudeResultMessage, SDKResultMessage>>,
  Assert<Covers<ClaudeInitMessage, SDKSystemMessage>>,
  Assert<Covers<ClaudeTaskStartedMessage, SDKTaskStartedMessage>>,
  Assert<Covers<ClaudeTaskNotificationMessage, SDKTaskNotificationMessage>>,
  Assert<Covers<ClaudeTaskUpdatedMessage, SDKTaskUpdatedMessage>>,
  Assert<Covers<ClaudeApiRetryMessage, SDKAPIRetryMessage>>,
  Assert<Covers<ClaudeCompactBoundaryMessage, SDKCompactBoundaryMessage>>,
  Assert<Covers<ClaudeHookMessage, SDKHookStartedMessage | SDKHookProgressMessage | SDKHookResponseMessage>>,
  Assert<Covers<ClaudeCommandsChangedMessage, SDKCommandsChangedMessage>>,
  Assert<Covers<ClaudeRateLimitEvent, SDKRateLimitEvent>>,
  Assert<Covers<ClaudeRateLimitInfo, SDKRateLimitInfo>>,
  Assert<Covers<ClaudeInitializeResult, SDKControlInitializeResponse>>,
  Assert<Covers<ClaudeModelInfo, ModelInfo>>,
  Assert<Covers<ClaudeSlashCommand, SlashCommand>>,
  Assert<Covers<ClaudeAccountInfo, AccountInfo>>,
  Assert<Covers<ClaudeRewindResult, RewindFilesResult>>,
  Assert<Covers<ClaudeSetServersResult, McpSetServersResult>>,
  Assert<Covers<ClaudeSessionInfo, SDKSessionInfo>>,
  Assert<Covers<ClaudeSessionMessage, SessionMessage>>,
];
