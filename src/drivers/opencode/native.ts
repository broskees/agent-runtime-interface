// What the session needs from an OpenCode server, whatever its generation.
// `v1.ts` speaks OpenCode 1.x through `@opencode-ai/sdk`, `v2.ts` OpenCode 2.x
// through `@opencode/client`; both turn the server's events into the neutral
// `NativeEvent`s below, so `session.ts` holds one set of rules for both.

/** An OpenCode permission rule, as both generations evaluate it: the last rule that matches wins. */
export interface NativeRule {
  /** 1.x calls this `permission`, 2.x `action`: the tool or permission name, with `*` wildcards. */
  readonly action: string;
  /** 1.x calls this `pattern`, 2.x `resource`. */
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

export interface NativeSessionInfo {
  readonly id: string;
  /** The directory the server runs the session in. */
  readonly directory: string;
  readonly parentId?: string;
  readonly title?: string;
}

/** One message of a native session's history, reduced to what ARI snapshots and forks need. */
export interface NativeMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  /** User: the prompt text. Assistant: its text parts, joined. */
  readonly text: string;
  readonly reasoning: string;
  /** An assistant message's text and reasoning parts, named as the live events name them. */
  readonly parts: ReadonlyArray<{ readonly id: string; readonly field: "text" | "reasoning"; readonly text: string }>;
  readonly tools: ReadonlyArray<NativeToolState>;
  readonly time: number;
  /** For an assistant message: the model that wrote it, as `provider/model`. */
  readonly model?: string;
  /** For an assistant message that ended with an error. */
  readonly error?: NativeError;
  /** Set on a user message that steered a running turn instead of starting one (2.x inbox delivery). */
  readonly steer?: boolean;
}

export interface NativeToolState {
  readonly callId: string;
  readonly tool: string;
  readonly status: "pending" | "running" | "completed" | "error";
  readonly input: unknown;
  readonly output?: string;
  readonly error?: string;
  readonly title?: string;
  /** A child session the tool runs (OpenCode's `task` tool). */
  readonly childSessionId?: string;
}

export interface NativeError {
  readonly kind: "aborted" | "usage_limit" | "auth" | "provider";
  readonly message: string;
  readonly code?: string;
  /** For a usage limit: when it resets, as an ISO time, when the server said. */
  readonly resetAt?: string;
}

export interface NativeQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly header?: string;
  readonly kind: "single_select" | "multi_select" | "text";
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string; readonly description?: string }>;
  readonly allowCustom: boolean;
}

export type NativeEvent =
  /** The server started working on the session: a turn runs. */
  | { readonly type: "busy"; readonly sessionId: string }
  /** The server finished: the authoritative end of the running turn. */
  | { readonly type: "idle"; readonly sessionId: string; readonly outcome: "completed" | "interrupted" | "failed"; readonly error?: NativeError }
  /** The server admitted a user message: a prompt, or (2.x) a steer the driver tagged as one. */
  | { readonly type: "user"; readonly sessionId: string; readonly messageId: string; readonly text: string; readonly steer: boolean }
  | { readonly type: "part"; readonly sessionId: string; readonly messageId: string; readonly partId: string; readonly field: "text" | "reasoning"; readonly delta?: string; readonly text?: string; readonly done: boolean }
  | { readonly type: "tool"; readonly sessionId: string; readonly messageId: string; readonly state: NativeToolState }
  | {
      readonly type: "permission";
      readonly sessionId: string;
      readonly requestId: string;
      readonly action: string;
      readonly resources: readonly string[];
      readonly always: readonly string[];
      readonly metadata: { readonly [key: string]: unknown };
      readonly callId?: string;
    }
  | { readonly type: "permission.replied"; readonly sessionId: string; readonly requestId: string; readonly reply: string }
  | { readonly type: "question"; readonly sessionId: string; readonly requestId: string; readonly title: string; readonly questions: readonly NativeQuestion[] }
  | { readonly type: "question.closed"; readonly sessionId: string; readonly requestId: string }
  | { readonly type: "error"; readonly sessionId: string; readonly error: NativeError }
  | { readonly type: "session"; readonly info: NativeSessionInfo }
  | { readonly type: "compaction"; readonly sessionId: string; readonly status: "started" | "ended" }
  | { readonly type: "retry"; readonly sessionId: string; readonly attempt: number; readonly retryDelayMs: number | null }
  | { readonly type: "todos"; readonly sessionId: string; readonly todos: ReadonlyArray<{ readonly id?: string; readonly text: string; readonly status: string }> }
  | { readonly type: "usage"; readonly sessionId: string; readonly model?: string; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number };

export interface PromptInput {
  readonly sessionId: string;
  readonly directory: string;
  readonly text: string;
  /** Files as `file://` URLs. */
  readonly files: ReadonlyArray<{ readonly url: string; readonly name: string; readonly mime: string }>;
  /** Host instructions for this turn (1.x `system`; 2.x keeps them as a session instruction entry). */
  readonly system: string | undefined;
  readonly model: string | undefined;
  readonly agent: string | undefined;
}

export interface McpEntry {
  readonly name: string;
  readonly directory: string;
  readonly config: { readonly type: "local"; readonly command: string[]; readonly environment?: { [name: string]: string } } | { readonly type: "remote"; readonly url: string; readonly headers?: { [name: string]: string } };
}

export interface CatalogModel {
  readonly id: string;
  readonly label: string;
  readonly contextWindow?: number;
}

/** One OpenCode server, of either generation, as the session drives it. */
export interface NativeRuntime {
  readonly generation: 1 | 2;
  /** The server's version, as it reported it. */
  readonly version: string;
  /** Subscribes to the events of a directory (1.x serves one event stream per directory; 2.x one for all). Resolves once the server confirmed the subscription. */
  watch(directory: string, onEvent: (event: NativeEvent) => void, onEnd: (error: unknown) => void): Promise<{ close(): void }>;
  createSession(input: { readonly directory: string; readonly title?: string; readonly rules: readonly NativeRule[]; readonly model?: string; readonly agent?: string }): Promise<NativeSessionInfo>;
  /** Undefined when the server has no such session. */
  getSession(sessionId: string, directory: string | undefined): Promise<NativeSessionInfo | undefined>;
  setRules(sessionId: string, directory: string, rules: readonly NativeRule[]): Promise<void>;
  getRules(sessionId: string, directory: string): Promise<readonly NativeRule[]>;
  /** The session's whole history, oldest first, whatever order and pages the server answers in. */
  messages(sessionId: string, directory: string): Promise<NativeMessage[]>;
  /** Sends a prompt. The server names the message; 2.x says its id in the answer, 1.x only in its events. */
  prompt(input: PromptInput): Promise<{ readonly messageId?: string }>;
  /** 2.x only: a steer that joins the running execution and never starts one. `joined` is false when it could not join it. */
  steer?(input: PromptInput): Promise<{ readonly joined: boolean; readonly messageId?: string }>;
  interrupt(sessionId: string, directory: string): Promise<void>;
  replyPermission(sessionId: string, directory: string, requestId: string, reply: "once" | "always" | "reject"): Promise<void>;
  replyQuestion(sessionId: string, directory: string, requestId: string, answers: ReadonlyArray<readonly string[]> | undefined, questions: readonly NativeQuestion[]): Promise<void>;
  /** A copy of the session holding the messages before `beforeMessageId`, or all of them. */
  fork(sessionId: string, directory: string, beforeMessageId: string | undefined): Promise<NativeSessionInfo>;
  /** Drops the session's messages from `messageId` on. */
  revert(sessionId: string, directory: string, messageId: string): Promise<void>;
  compact(sessionId: string, directory: string, model: string | undefined): Promise<void>;
  addMcp(entry: McpEntry): Promise<void>;
  removeMcp(name: string, directory: string): Promise<void>;
  models(directory: string): Promise<{ models: CatalogModel[]; defaultModel?: string }>;
}
