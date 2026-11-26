// One ARI session over the Claude Agent SDK. Each thread is one Claude
// session (a transcript Claude Code keeps) run by one `query()`: one Claude
// Code process reading the prompts this driver streams in, so the session
// model is one process per thread.
//
// - The driver picks each new thread's Claude session id up front (the
//   `sessionId` option, as a host-side runner would), so the thread has its
//   id, and the host's per-thread tool server, before the process starts.
//   Host and launch MCP servers are given with `Query.setMcpServers` right
//   after the process starts and before the first prompt, which is also how
//   a later change reaches a live thread.
// - Every prompt carries a uuid the driver picks; Claude keeps it in the
//   transcript and echoes it on the turn's frames, so turn ids follow from
//   native data. A retried `startTurn` with the same `clientTurnKey` returns
//   the first result and sends nothing.
// - A turn settles only on Claude's `result` message, on Stop, or when the
//   process dies. A steer is a prompt with priority "now": Claude ends the
//   running native turn (terminal_reason aborted_*) and reads the steer next,
//   so the host's turn spans both native turns and settles on the result
//   that answers the steer.
// - Permission prompts arrive through `canUseTool` and wait, as `live`
//   requests, until the host answers with `respond`.
// - Host instructions reach Claude only through the claude_code system
//   prompt's `append`, with `snapshot: false` so Claude Code never records
//   them in its transcript, and turn instructions lead the turn's prompt.

import { realpath } from "node:fs/promises";
import { callErrors } from "../../errors.ts";
import { deriveId } from "../../driver-kit/ids.ts";
import { EventSequencer } from "../../driver-kit/sequencer.ts";
import { truncateUtf8 } from "../../driver-kit/truncate.ts";
import type { BackgroundTaskSummary, TaskInfo } from "../../generated/background.ts";
import type { Capabilities } from "../../generated/capabilities.ts";
import type { ContentBlock } from "../../generated/common.ts";
import type { ConfigChangePlan, RuntimePolicy } from "../../generated/config.ts";
import type { Failure } from "../../generated/errors.ts";
import type { AriEvent, AriEventBody } from "../../generated/events.ts";
import { AriGoalGetParamsSchema } from "../../generated/extensions/ari.goal.ts";
import type { AriGoal } from "../../generated/extensions/ari.goal.ts";
import { ClaudeHooksSetParamsSchema, ClaudeRewindParamsSchema } from "../../generated/extensions/claude.ts";
import type { ClaudeHookEventData, ClaudeHookMatcher, ClaudeRewindResult } from "../../generated/extensions/claude.ts";
import type { OpenSessionInput } from "../../generated/instance.ts";
import type { Item, ItemPatch } from "../../generated/item.ts";
import type { Request } from "../../generated/request.ts";
import type {
  AppliedThread,
  AwaitBackgroundTasksInput,
  AwaitBackgroundTasksResult,
  BackgroundTaskListOptions,
  CreateThreadInput,
  EventsOptions,
  ForkThreadInput,
  InterruptTurnInput,
  LaunchContext,
  LaunchMcpServer,
  PlanConfigChangeInput,
  RespondInput,
  RespondResult,
  ResumeThreadInput,
  StartTurnInput,
  StartTurnResult,
  StopBackgroundTaskInput,
  StopSubagentInput,
  TurnContext,
} from "../../generated/session.ts";
import type { Subagent, SubagentOutcome } from "../../generated/subagent.ts";
import type { Thread, ThreadSnapshot, Turn } from "../../generated/thread.ts";
import type { LimitStatus } from "../../generated/usage.ts";
import type { ClaudeDriverConfig } from "../../meta/claude.ts";
import type { HostServices, Session } from "../../runtime.ts";
import { CLAUDE_CAPABILITIES } from "./capabilities.ts";
import {
  CLAUDE_IDENTITY_VERSION,
  approvalAnswers,
  asRecord,
  asString,
  claudeMcpConfig,
  failureFromResult,
  isAbortedResult,
  isAuthFailure,
  itemIdFor,
  permissionModeFor,
  promptItemIdFor,
  providerTurnIdFor,
  providerTurnRef,
  questionsFrom,
  requestIdFor,
  requestKindFor,
  strongRef,
  subagentIdFor,
  taskIdFor,
  threadIdFor,
  toolItemFields,
  toolItemKind,
  toolResultText,
  turnIdFor,
  usageFromResult,
} from "./mapping.ts";
import type { ClaudeApprovalAnswer } from "./mapping.ts";
import type {
  ClaudeAssistantMessage,
  ClaudeCanUseToolOptions,
  ClaudeCommandsChangedMessage,
  ClaudeContentBlockParam,
  ClaudeHookMessage,
  ClaudeHookSettings,
  ClaudeImageMediaType,
  ClaudeInitMessage,
  ClaudeMcpServerConfig,
  ClaudeMessage,
  ClaudePermissionResult,
  ClaudeQuery,
  ClaudeQueryOptions,
  ClaudeRateLimitEvent,
  ClaudeRateLimitInfo,
  ClaudeResultMessage,
  ClaudeSdk,
  ClaudeSessionMessage,
  ClaudeStreamEventMessage,
  ClaudeSystemMessage,
  ClaudeTaskNotificationMessage,
  ClaudeTaskStartedMessage,
  ClaudeTaskUpdatedMessage,
  ClaudeUserMessage,
  ClaudeUserMessageOut,
  ClaudeUuid,
  ClaudeApiRetryMessage,
} from "./sdk.ts";

/** What a session needs from its instance. */
export interface ClaudeSessionContext {
  readonly host: HostServices<ClaudeDriverConfig>;
  readonly config: ClaudeDriverConfig;
  readonly sdk: ClaudeSdk;
  /** `pathToClaudeCodeExecutable`, when the config names one. */
  readonly executablePath: string | undefined;
  readonly sessionId: string;
  /** A new UUID for Claude: a new thread's or fork's session id, or a prompt's id. */
  newUuid(): string;
  /** The environment a query starts with: the instance's own, without credentials it did not configure. */
  environment(): Promise<{ [name: string]: string }>;
  /** Records a rate limit event and returns the instance's limit status. */
  rateLimited(info: ClaudeRateLimitInfo): LimitStatus;
  /** A live turn failed on the account's credentials. */
  authFailed(message: string): Promise<void>;
  /** The session closed. */
  closed(): void;
}

/** The extension namespaces this session serves. */
const EXT_HOOKS = "claude.hooks";
const EXT_FILE_CHECKPOINTS = "claude.fileCheckpoints";
const EXT_GOAL = "ari.goal";

/** The prompts a query reads: the driver pushes, Claude Code reads in order. */
class PromptQueue implements AsyncIterable<ClaudeUserMessage> {
  readonly #items: ClaudeUserMessage[] = [];
  #waiting: ((result: IteratorResult<ClaudeUserMessage>) => void) | undefined;
  #ended = false;

  push(message: ClaudeUserMessage): void {
    if (this.#ended) throw callErrors.invalidState("query_ended", "The thread's Claude Code process has ended");
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting({ value: message, done: false });
      return;
    }
    this.#items.push(message);
  }

  end(): void {
    this.#ended = true;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeUserMessage> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** One running `query()`. */
interface LiveQuery {
  readonly query: ClaudeQuery;
  readonly input: PromptQueue;
  readonly abort: AbortController;
  /** The text the query appended to Claude Code's system prompt when it started; a running query cannot change it. */
  readonly append: string | undefined;
  /** Set when the driver closed it, with the reason. */
  closedBy: "interrupt" | "unload" | "release" | "close" | "fork" | "relaunch" | undefined;
  ended: boolean;
  initialized: boolean;
  /** Settles once Claude Code answered `initialize`, or rejects with why it did not start. */
  readonly ready: Promise<void>;
  readonly startFailed: (error: Error) => void;
  readonly endWaiters: Set<() => void>;
}

interface ItemState {
  readonly id: string;
  readonly kind: string;
  open: boolean;
}

interface ActiveTurn {
  readonly id: string;
  /** The uuid of the prompt that started it; undefined for a turn Claude started. */
  readonly promptUuid: string | undefined;
  readonly origin: "user" | "provider_initiated";
  readonly hostTag: string | undefined;
  readonly clientTurnKey: string | undefined;
  readonly startedAt: string;
  /** Steers sent into this turn and not yet answered by a result. */
  readonly steers: Set<string>;
  interrupting: boolean;
  /** Items by native key (`<message id>:<block index>`, a tool_use id). */
  readonly items: Map<string, ItemState>;
  /** Assistant frames seen per API message id, to number their blocks. */
  readonly blocksSeen: Map<string, number>;
  streamMessageId: string | undefined;
  readonly requests: Set<string>;
  assistantError: string | undefined;
  assistantText: string | undefined;
  rejectedLimit: ClaudeRateLimitInfo | undefined;
  model: string | undefined;
  /** The turn ran Claude Code's /goal command or called SetGoal: once it ends, the goal is read again from the transcript. */
  goalMayChange: boolean;
}

interface QueuedTurn {
  readonly id: string;
  readonly promptUuid: string;
  readonly hostTag: string | undefined;
  readonly clientTurnKey: string;
  readonly text: string;
}

interface TaskState {
  readonly nativeId: string;
  readonly id: string;
  readonly kind: "terminal" | "subagent" | "tool";
  readonly title: string;
  readonly toolUseId: string | undefined;
  readonly turnId: string | undefined;
  readonly startedAt: string;
  status: "running" | "completed" | "failed" | "stopped";
  awaited: boolean;
  summary: string | undefined;
  readonly settled: Set<() => void>;
}

interface ClaudeThread {
  thread: Thread;
  readonly nativeId: string;
  readonly cwd: string;
  readonly persist: boolean;
  launch: LaunchContext;
  systemContext: string | undefined;
  policy: RuntimePolicy;
  model: string | undefined;
  effort: ClaudeDriverConfig["effort"];
  live: LiveQuery | undefined;
  starting: Promise<LiveQuery> | undefined;
  turn: ActiveTurn | undefined;
  readonly queued: QueuedTurn[];
  /** Prompt uuids of the turns this session ran, by turn id. */
  readonly prompts: Map<string, string>;
  /** Steers this session sent, by prompt uuid, with the turn each joined: the transcript shows them as plain prompts. */
  readonly steers: Map<string, string>;
  readonly tasks: Map<string, TaskState>;
  providerTurns: number;
  commands: string[] | undefined;
  goal: AriGoal | null;
}

interface PendingRequest {
  readonly thread: ClaudeThread;
  request: Request;
  readonly answers: ReadonlyMap<string, ClaudeApprovalAnswer>;
  readonly input: Record<string, unknown>;
  readonly settle: (result: ClaudePermissionResult) => void;
  resolvedBy: string | undefined;
}

/** How a fresh query attaches to its Claude session. */
type StartMode =
  | { readonly kind: "new" }
  | { readonly kind: "resume" }
  | { readonly kind: "fork"; readonly sourceId: string; readonly at: string | undefined };

/** The directory as the OS resolves it, so a path through a symbolic link names the same thread as the real path. */
async function canonicalDirectory(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch {
    throw callErrors.validation([{ message: `The working directory ${directory} does not exist`, path: ["cwd"] }]);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function joinText(parts: ReadonlyArray<string | undefined>): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part !== "");
  return kept.length === 0 ? undefined : kept.join("\n\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const IMAGE_TYPES = new Set<string>(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** The `claude.hooks` params as Claude Code's settings `hooks`: the same shape, copied field by field. */
function hookSettings(hooks: { [event: string]: ClaudeHookMatcher[] }): ClaudeHookSettings {
  const settings: ClaudeHookSettings = {};
  for (const [event, matchers] of Object.entries(hooks)) {
    settings[event] = matchers.map((matcher) => ({
      ...(matcher.matcher === undefined ? {} : { matcher: matcher.matcher }),
      hooks: matcher.hooks.map((hook) => ({
        type: "command" as const,
        command: hook.command,
        ...(hook.args === undefined ? {} : { args: [...hook.args] }),
        ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
        ...(hook.statusMessage === undefined ? {} : { statusMessage: hook.statusMessage }),
        ...(hook.once === undefined ? {} : { once: hook.once }),
        ...(hook.async === undefined ? {} : { async: hook.async }),
      })),
    }));
  }
  return settings;
}

/** The text of a main-thread user transcript entry, or undefined for tool results and other content. */
function userTextOf(entry: ClaudeSessionMessage): string | undefined {
  if (entry.type !== "user" || entry.parent_tool_use_id !== null) return undefined;
  const content = asRecord(entry.message)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  if (content.some((block) => asRecord(block)["type"] === "tool_result")) return undefined;
  const texts = content.flatMap((block) => (asRecord(block)["type"] === "text" && typeof asRecord(block)["text"] === "string" ? [asRecord(block)["text"] as string] : []));
  return texts.length === 0 ? undefined : texts.join("\n\n");
}

/** A prompt that runs Claude Code's /goal command. */
const GOAL_COMMAND = /^\/goal(?:\s|$)/;
/** How Claude Code 2.1.330's /goal command answers when it set or cleared the goal, and SetGoal's result when it set one. */
const GOAL_SET = "Goal set: ";
const GOAL_CLEARED = "Goal cleared: ";
const SET_GOAL_DONE = "The goal is set";

/**
 * The slash command a transcript row records. Claude Code writes a command
 * the user ran as tagged text: `<command-name>/goal</command-name>`,
 * `<command-message>goal</command-message>`, `<command-args>…</command-args>`.
 */
function slashCommandIn(text: string): { name: string; args: string } | undefined {
  const start = text.trimStart();
  if (!start.startsWith("<command-name>") && !start.startsWith("<command-message>")) return undefined;
  const name = /<command-name>\/?([^<]*)<\/command-name>/.exec(text)?.[1];
  if (name === undefined || name === "") return undefined;
  return { name, args: (/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "").trim() };
}

function slashCommandOf(entry: ClaudeSessionMessage): { name: string; args: string } | undefined {
  const text = userTextOf(entry);
  return text === undefined ? undefined : slashCommandIn(text);
}

/** What a local command printed, from the tagged output row Claude Code writes after the command row. */
function localCommandOutputOf(entry: ClaudeSessionMessage): string | undefined {
  const text = userTextOf(entry)?.trim();
  if (text === undefined) return undefined;
  return /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(text)?.[1];
}

/**
 * The prompt text of a user transcript entry, or undefined when it is not a
 * prompt: tool results, and the rows Claude Code writes around a local
 * command (its caveat and its output). A command row reads as the command
 * the user typed.
 */
function promptTextOf(entry: ClaudeSessionMessage): string | undefined {
  const text = userTextOf(entry);
  if (text === undefined || /^\s*<local-command-(?:stdout|stderr|caveat)>/.test(text)) return undefined;
  const command = slashCommandIn(text);
  return command === undefined ? text : `/${command.name}${command.args === "" ? "" : ` ${command.args}`}`;
}

export class ClaudeSession implements Session {
  readonly id: string;
  readonly #context: ClaudeSessionContext;
  readonly #open: OpenSessionInput;
  readonly #events: EventSequencer;
  readonly #threads = new Map<string, ClaudeThread>();
  readonly #requests = new Map<string, PendingRequest>();
  readonly #responses = new Map<string, Promise<RespondResult | void>>();
  readonly #turnKeys = new Map<string, Promise<StartTurnResult>>();
  #closed = false;

  constructor(context: ClaudeSessionContext, open: OpenSessionInput) {
    this.id = context.sessionId;
    this.#context = context;
    this.#open = open;
    this.#events = new EventSequencer({ sessionId: this.id });
    this.#emit({ type: "capabilities.updated", capabilities: CLAUDE_CAPABILITIES });
    this.#emit({ type: "session.state", state: "ready" });
  }

  capabilities(): Capabilities {
    return CLAUDE_CAPABILITIES;
  }

  events(options?: EventsOptions): AsyncIterable<AriEvent> {
    return this.#events.events(options);
  }

  #emit(body: AriEventBody, envelope: { threadId?: string | undefined; turnId?: string | undefined; hostTag?: string | undefined } = {}): void {
    if (this.#events.closed) return;
    this.#events.emit({
      body,
      ...(envelope.threadId === undefined ? {} : { threadId: envelope.threadId }),
      ...(envelope.turnId === undefined ? {} : { turnId: envelope.turnId }),
      ...(envelope.hostTag === undefined ? {} : { hostTag: envelope.hostTag }),
    });
  }

  #emitTurn(thread: ClaudeThread, turn: ActiveTurn, body: AriEventBody): void {
    this.#emit(body, { threadId: thread.thread.id, turnId: turn.id, hostTag: turn.hostTag });
  }

  #live(): void {
    if (this.#closed) throw callErrors.invalidState("session_closed", "The session is closed");
  }

  #thread(threadId: string): ClaudeThread {
    const thread = this.#threads.get(threadId);
    if (thread === undefined) throw callErrors.notFound({ resource: "thread", id: threadId });
    if (thread.thread.status === "closed") throw callErrors.invalidState("thread_closed", `Thread ${threadId} is closed`);
    return thread;
  }

  // Threads.

  async createThread(input: CreateThreadInput): Promise<AppliedThread> {
    this.#live();
    const cwd = await canonicalDirectory(input.cwd);
    const thread = this.#newThread({
      nativeId: this.#context.newUuid(),
      cwd,
      persist: input.persistSession !== false,
      launch: input.launch,
      systemContext: joinText([input.context?.system, input.context?.developer]),
      policy: input.policy,
      config: input.config,
      ...(input.title === undefined ? {} : { title: input.title }),
    });
    try {
      await this.#ensureQuery(thread, { kind: "new" });
    } catch (error) {
      this.#forget(thread);
      throw error;
    }
    this.#announce(thread);
    return this.#applied(thread);
  }

  async resumeThread(input: ResumeThreadInput): Promise<AppliedThread> {
    this.#live();
    const nativeId = "handle" in input.native ? input.native.handle : input.native.id;
    const known = [...this.#threads.values()].find((candidate) => candidate.nativeId === nativeId && candidate.thread.status !== "closed");
    if (known !== undefined) {
      // A history read changes nothing: it reports what the thread runs with.
      if (input.purpose === "history") return this.#applied(known);
      const launch = input.launch === undefined ? known.launch : this.#mergeLaunch(input.launch);
      const live = known.live !== undefined && !known.live.ended ? known.live : undefined;
      if (live !== undefined && this.#appendFor(known, launch) !== live.append) return this.#relaunch(known, live, launch, input);
      known.launch = launch;
      if (live === undefined) {
        if (input.policy !== undefined) known.policy = input.policy;
        this.#applyConfig(known, input.config);
        await this.#ensureQuery(known, { kind: "resume" });
        return this.#applied(known);
      }
      // The running query takes the rest through its control methods; the thread records each change once Claude Code took it.
      await this.#applyLiveConfig(known, live, input.config);
      if (input.policy !== undefined && permissionModeFor(input.policy) !== permissionModeFor(known.policy)) await live.query.setPermissionMode(permissionModeFor(input.policy));
      if (input.policy !== undefined) known.policy = input.policy;
      await this.#giveMcpServers(known, live);
      return this.#applied(known);
    }
    const requested = input.policy === undefined ? undefined : await canonicalDirectory(input.policy.cwd);
    const info = nativeId === null ? undefined : await this.#context.sdk.getSessionInfo(nativeId, requested === undefined ? undefined : { dir: requested });
    if (nativeId === null || info === undefined) return this.#replacement(input, nativeId, "missing");
    const cwd = info.cwd ?? requested;
    if (cwd === undefined) throw callErrors.validation([{ message: "Claude does not record this session's directory; pass policy.cwd", path: ["policy", "cwd"] }]);
    const policy = input.policy ?? { mode: "approval_required", interaction: "default", cwd };
    const thread = this.#newThread({
      nativeId,
      cwd,
      persist: true,
      launch: input.launch,
      systemContext: undefined,
      policy,
      config: input.config,
      ...(info.customTitle === undefined ? {} : { title: info.customTitle }),
    });
    if (input.purpose === "history") {
      thread.thread = { ...thread.thread, status: "unloaded" };
      this.#announce(thread);
      return this.#applied(thread);
    }
    try {
      await this.#ensureQuery(thread, { kind: "resume" });
    } catch (error) {
      // Claude Code refused to resume the session (held by another process, or gone): start afresh and say so.
      this.#forget(thread);
      return this.#replacement(input, nativeId, `locked: ${errorText(error)}`);
    }
    this.#announce(thread);
    if (input.quiet !== true) await this.#replayHistory(thread);
    return this.#applied(thread);
  }

  /**
   * A live thread with new instructions. Claude Code reads its system prompt
   * only when a query starts, so the driver ends the running query and
   * resumes the session in a new one that carries the new append. It refuses
   * while the thread has work that would end with the old query.
   */
  async #relaunch(thread: ClaudeThread, live: LiveQuery, launch: LaunchContext, input: ResumeThreadInput): Promise<AppliedThread> {
    const pendingRequest = [...this.#requests.values()].some((pending) => pending.thread === thread && pending.request.status === "pending");
    const runningTask = [...thread.tasks.values()].some((task) => task.status === "running");
    if (thread.turn !== undefined || thread.queued.length > 0 || pendingRequest || runningTask) {
      throw callErrors.invalidState(
        "thread_busy",
        `Thread ${thread.thread.id} has a turn, request or background task running; Claude Code takes new instructions only in a new query, which would end them`,
      );
    }
    const transcript = (await this.#context.sdk.getSessionInfo(thread.nativeId, { dir: thread.cwd })) !== undefined;
    if (!transcript && thread.prompts.size > 0) {
      throw callErrors.invalidState("not_resumable", `Claude Code keeps no transcript for thread ${thread.thread.id}, so a new query could not carry its conversation`);
    }
    thread.launch = launch;
    if (input.policy !== undefined) thread.policy = input.policy;
    this.#applyConfig(thread, input.config);
    this.#closeQuery(live, "relaunch");
    await this.#whenEnded(live);
    // A session with no message yet has no transcript to resume: it starts again under the same id.
    await this.#ensureQuery(thread, transcript ? { kind: "resume" } : { kind: "new" });
    return this.#applied(thread);
  }

  /** A fresh native session in place of one that cannot be resumed. */
  async #replacement(input: ResumeThreadInput, previousNativeId: string | null, reason: string): Promise<AppliedThread> {
    const cwd = input.policy === undefined ? undefined : await canonicalDirectory(input.policy.cwd);
    if (cwd === undefined) throw callErrors.notFound({ resource: "Claude session", id: previousNativeId ?? "(none)", message: `Claude session ${String(previousNativeId)} cannot be resumed (${reason}) and no policy.cwd was given to start a fresh one` });
    const thread = this.#newThread({ nativeId: this.#context.newUuid(), cwd, persist: true, launch: input.launch, systemContext: undefined, policy: input.policy!, config: input.config });
    try {
      await this.#ensureQuery(thread, { kind: "new" });
    } catch (error) {
      this.#forget(thread);
      throw error;
    }
    this.#announce(thread);
    this.#emit(
      { type: "session.replaced", ...(previousNativeId === null ? {} : { previousNativeId }), reason, contextLost: true, showRuntimeNote: true },
      { threadId: thread.thread.id },
    );
    return this.#applied(thread);
  }

  #newThread(input: {
    nativeId: string;
    cwd: string;
    persist: boolean;
    launch: LaunchContext | undefined;
    systemContext: string | undefined;
    policy: RuntimePolicy;
    config: { [key: string]: unknown } | undefined;
    title?: string;
    forkedFrom?: Thread["forkedFrom"];
  }): ClaudeThread {
    const id = threadIdFor(input.nativeId);
    const at = nowIso();
    const thread: ClaudeThread = {
      thread: {
        id,
        native: strongRef(input.nativeId),
        cwd: input.cwd,
        status: "idle",
        handle: input.nativeId,
        createdAt: at,
        updatedAt: at,
        identityVersion: CLAUDE_IDENTITY_VERSION,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.forkedFrom === undefined ? {} : { forkedFrom: input.forkedFrom, parentThreadId: input.forkedFrom.threadId }),
      },
      nativeId: input.nativeId,
      cwd: input.cwd,
      persist: input.persist,
      launch: this.#mergeLaunch(input.launch),
      systemContext: input.systemContext,
      policy: input.policy,
      model: this.#context.config.model,
      effort: this.#context.config.effort,
      live: undefined,
      starting: undefined,
      turn: undefined,
      queued: [],
      prompts: new Map(),
      steers: new Map(),
      tasks: new Map(),
      providerTurns: 0,
      commands: undefined,
      goal: null,
    };
    this.#applyConfig(thread, input.config);
    this.#threads.set(id, thread);
    return thread;
  }

  /** The thread's first event, once its query runs (or, for a history read, once it is known). */
  #announce(thread: ClaudeThread): void {
    this.#emit({ type: "thread.upsert", thread: { ...thread.thread } }, { threadId: thread.thread.id });
  }

  /** Forgets a thread whose query never started; it was never announced. */
  #forget(thread: ClaudeThread): void {
    this.#threads.delete(thread.thread.id);
  }

  #mergeLaunch(launch: LaunchContext | undefined): LaunchContext {
    if ((launch?.dynamicTools ?? []).length > 0) {
      throw callErrors.unsupported("tools.dynamicTools", "The Claude driver does not serve dynamic tools; give the host's tools as an MCP server");
    }
    const session = this.#open.launch;
    return {
      appendSystemPrompt: [...(session?.appendSystemPrompt ?? []), ...(launch?.appendSystemPrompt ?? [])],
      developerPrompt: [...(session?.developerPrompt ?? []), ...(launch?.developerPrompt ?? [])],
      mcpServers: [...(session?.mcpServers ?? []), ...(launch?.mcpServers ?? [])],
      dynamicTools: [...(session?.dynamicTools ?? []), ...(launch?.dynamicTools ?? [])],
    };
  }

  #applyConfig(thread: ClaudeThread, config: { [key: string]: unknown } | undefined): void {
    const model = config?.["model"];
    if (typeof model === "string" && model !== "") thread.model = model;
    const effort = config?.["effort"];
    if (typeof effort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(effort)) thread.effort = effort as ClaudeDriverConfig["effort"];
  }

  #applied(thread: ClaudeThread): AppliedThread {
    const appliedConfig: { [key: string]: unknown } = {};
    if (thread.model !== undefined) appliedConfig["model"] = thread.model;
    if (thread.effort !== undefined) appliedConfig["effort"] = thread.effort;
    return { ...thread.thread, ...(Object.keys(appliedConfig).length === 0 ? {} : { appliedConfig }) };
  }

  #setThreadStatus(thread: ClaudeThread, status: Thread["status"]): void {
    if (thread.thread.status === status || thread.thread.status === "closed") return;
    const updatedAt = nowIso();
    thread.thread = { ...thread.thread, status, updatedAt };
    this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id, status, updatedAt } }, { threadId: thread.thread.id });
  }

  // Queries.

  /** The thread's running query, starting one (fresh, resumed or forked) when it has none. */
  async #ensureQuery(thread: ClaudeThread, mode: StartMode = { kind: "resume" }): Promise<LiveQuery> {
    if (thread.live !== undefined && !thread.live.ended) return thread.live;
    thread.starting ??= this.#startQuery(thread, mode).finally(() => {
      thread.starting = undefined;
    });
    return thread.starting;
  }

  /** The text appended to Claude Code's system prompt: the launch's instructions, then the thread's context. */
  #appendFor(thread: ClaudeThread, launch: LaunchContext): string | undefined {
    return joinText([...(launch.appendSystemPrompt ?? []), ...(launch.developerPrompt ?? []), thread.systemContext]);
  }

  async #queryOptions(thread: ClaudeThread, mode: StartMode, abort: AbortController, append: string | undefined): Promise<ClaudeQueryOptions> {
    const config = this.#context.config;
    const identity: Partial<ClaudeQueryOptions> =
      mode.kind === "new"
        ? { sessionId: thread.nativeId }
        : mode.kind === "resume"
          ? { resume: thread.nativeId }
          : { resume: mode.sourceId, forkSession: true, sessionId: thread.nativeId, ...(mode.at === undefined ? {} : { resumeSessionAt: mode.at }) };
    return {
      cwd: thread.cwd,
      env: await this.#context.environment(),
      ...(thread.policy.additionalRoots === undefined || thread.policy.additionalRoots.length === 0 ? {} : { additionalDirectories: [...thread.policy.additionalRoots] }),
      ...(thread.model === undefined ? {} : { model: thread.model }),
      ...(thread.effort === undefined ? {} : { effort: thread.effort }),
      permissionMode: permissionModeFor(thread.policy),
      // Lets the host switch a live thread to full access later; the mode itself comes from the host's policy.
      allowDangerouslySkipPermissions: true,
      canUseTool: (toolName, input, options) => this.#canUseTool(thread, toolName, input, options),
      // Claude Code's own prompt. `snapshot: false` keeps the host's text out of the transcript and lets a resume carry a new one.
      systemPrompt: { type: "preset", preset: "claude_code", snapshot: false, ...(append === undefined ? {} : { append }) },
      ...(config.settingSources === undefined ? {} : { settingSources: [...config.settingSources] }),
      includePartialMessages: true,
      includeHookEvents: true,
      enableFileCheckpointing: true,
      perTaskStopAffordance: true,
      persistSession: thread.persist,
      ...identity,
      ...(this.#context.executablePath === undefined ? {} : { pathToClaudeCodeExecutable: this.#context.executablePath }),
      abortController: abort,
      stderr: (data: string) => this.#context.host.diagnostics.log({ level: "debug", msg: `claude: ${data.trimEnd()}` }),
    };
  }

  async #startQuery(thread: ClaudeThread, mode: StartMode): Promise<LiveQuery> {
    const abort = new AbortController();
    const append = this.#appendFor(thread, thread.launch);
    const options = await this.#queryOptions(thread, mode, abort, append);
    const input = new PromptQueue();
    let startFailed: (error: Error) => void = () => undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      startFailed = reject;
    });
    failed.catch(() => undefined);
    const query = this.#context.sdk.query({ prompt: input, options });
    const ready = Promise.race([query.initializationResult().then(() => undefined), failed]);
    ready.catch(() => undefined);
    const live: LiveQuery = { query, input, abort, append, closedBy: undefined, ended: false, initialized: false, ready, startFailed, endWaiters: new Set() };
    void this.#pump(thread, live);
    const timeoutMs = this.#open.handshakeTimeoutMs ?? 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(callErrors.transport(`Claude Code did not start within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      await Promise.race([ready, timeout]);
    } catch (error) {
      this.#closeQuery(live, "close");
      throw error instanceof Error && "callError" in error ? error : callErrors.transport(`Claude Code did not start: ${errorText(error)}`);
    } finally {
      clearTimeout(timer);
    }
    live.initialized = true;
    thread.live = live;
    if (thread.thread.status === "unloaded") this.#setThreadStatus(thread, "idle");
    try {
      await this.#giveMcpServers(thread, live);
    } catch (error) {
      this.#closeQuery(live, "close");
      thread.live = undefined;
      throw error;
    }
    return live;
  }

  /** The thread's MCP servers, under the names the host chose, through `setMcpServers` before any prompt. */
  async #giveMcpServers(thread: ClaudeThread, live: LiveQuery): Promise<void> {
    const servers: Record<string, ClaudeMcpServerConfig> = {};
    const add = (server: LaunchMcpServer, alwaysLoad: boolean): void => {
      try {
        servers[server.name] = claudeMcpConfig(server, alwaysLoad);
      } catch (error) {
        throw callErrors.unsupported("mcp.acceptsHostServers", errorText(error));
      }
    };
    for (const server of thread.launch.mcpServers ?? []) add(server, server.alwaysLoad === true);
    try {
      const hostServer = await this.#context.host.hostTools.mcpServerFor(thread.thread.id, { transport: "http" });
      add({ ...hostServer.config, name: hostServer.name }, hostServer.alwaysLoad === true);
    } catch (error) {
      if (error instanceof Error && "callError" in error && (error as { callError: { code: string } }).callError.code === "unsupported") throw error;
      this.#context.host.diagnostics.log({ level: "info", msg: `The host gave no tool server for thread ${thread.thread.id}: ${errorText(error)}` });
    }
    const result = await live.query.setMcpServers(servers);
    const failed = Object.entries(result.errors);
    if (failed.length > 0) {
      this.#emit({ type: "notice", level: "warning", code: "mcp_server_failed", text: failed.map(([name, message]) => `MCP server ${name}: ${message}`).join("\n") }, { threadId: thread.thread.id });
    }
  }

  #closeQuery(live: LiveQuery, reason: NonNullable<LiveQuery["closedBy"]>): void {
    if (live.ended) return;
    live.closedBy ??= reason;
    live.input.end();
    live.query.close();
  }

  /** Waits until the query's stream has ended. */
  #whenEnded(live: LiveQuery): Promise<void> {
    if (live.ended) return Promise.resolve();
    return new Promise((resolve) => live.endWaiters.add(resolve));
  }

  async #pump(thread: ClaudeThread, live: LiveQuery): Promise<void> {
    let failure: unknown;
    try {
      for await (const message of live.query) this.#onMessage(thread, live, message);
    } catch (error) {
      failure = error;
    }
    this.#onQueryEnded(thread, live, failure);
  }

  #onQueryEnded(thread: ClaudeThread, live: LiveQuery, error: unknown): void {
    live.ended = true;
    live.input.end();
    live.startFailed(error instanceof Error ? error : new Error(error === undefined ? "Claude Code exited before it started" : String(error)));
    for (const wake of live.endWaiters) wake();
    live.endWaiters.clear();
    if (thread.live === live) thread.live = undefined;
    if (!live.initialized) return;
    const reason = live.closedBy;
    // Background tasks run inside the Claude Code process and end with it.
    for (const task of thread.tasks.values()) if (task.status === "running") this.#settleTask(thread, task, "stopped", undefined);
    for (const pending of [...this.#requests.values()]) {
      if (pending.thread === thread && pending.request.status === "pending") this.#closeRequest(pending, "expired");
    }
    const turn = thread.turn;
    if (turn !== undefined) {
      if (reason !== undefined) {
        this.#settleTurn(thread, turn, "interrupted", undefined);
      } else {
        const failure: Failure = {
          class: "transport_error",
          message: `Claude Code exited during the turn${error === undefined ? "" : `: ${errorText(error)}`}`,
          code: "process_exit",
          retryable: true,
        };
        this.#settleTurn(thread, turn, "failed", failure);
      }
    }
    for (const queued of thread.queued.splice(0)) {
      const failure: Failure = { class: "transport_error", message: "Claude Code exited before the queued turn started", code: "process_exit", retryable: true };
      this.#emit({ type: "turn.upsert", turn: { id: queued.id, status: "failed", failure, completedAt: nowIso() } }, { threadId: thread.thread.id, turnId: queued.id, hostTag: queued.hostTag });
      this.#emit({ type: "turn.terminal", turnId: queued.id, status: "failed", failure, threadDisposition: "reusable" }, { threadId: thread.thread.id, turnId: queued.id, hostTag: queued.hostTag });
    }
    if (thread.thread.status === "running") this.#setThreadStatus(thread, "idle");
    if (reason === undefined && !this.#closed) {
      this.#emit({ type: "notice", level: "warning", code: "process_exit", text: `Claude Code exited${error === undefined ? "" : `: ${errorText(error)}`}; the next turn resumes the session.` }, { threadId: thread.thread.id });
    }
  }

  // Messages.

  #onMessage(thread: ClaudeThread, live: LiveQuery, message: ClaudeMessage): void {
    if (thread.live !== undefined && thread.live !== live) return;
    switch (message.type) {
      case "system":
        this.#onSystem(thread, message as ClaudeSystemMessage);
        return;
      case "stream_event":
        this.#onStreamEvent(thread, message as ClaudeStreamEventMessage);
        return;
      case "assistant":
        this.#onAssistant(thread, message as ClaudeAssistantMessage);
        return;
      case "user":
        this.#onUser(thread, message as ClaudeUserMessageOut);
        return;
      case "result":
        this.#onResult(thread, live, message as ClaudeResultMessage);
        return;
      case "rate_limit_event":
        this.#onRateLimit(thread, message as ClaudeRateLimitEvent);
        return;
      default:
        return;
    }
  }

  #onSystem(thread: ClaudeThread, message: ClaudeSystemMessage): void {
    switch (message.subtype) {
      case "init": {
        const init = message as ClaudeInitMessage;
        if (thread.turn !== undefined) thread.turn.model = init.model;
        if (thread.commands === undefined || thread.commands.join("\n") !== init.slash_commands.join("\n")) {
          thread.commands = [...init.slash_commands];
          this.#emit({ type: "commands.updated", commands: init.slash_commands.map((name) => ({ name })) }, { threadId: thread.thread.id });
        }
        return;
      }
      case "commands_changed": {
        const changed = message as ClaudeCommandsChangedMessage;
        thread.commands = changed.commands.map((command) => command.name);
        this.#emit(
          { type: "commands.updated", commands: changed.commands.map((command) => ({ name: command.name, description: command.description, ...(command.argumentHint === "" ? {} : { argumentHint: command.argumentHint }) })) },
          { threadId: thread.thread.id },
        );
        return;
      }
      case "task_started":
        this.#onTaskStarted(thread, message as ClaudeTaskStartedMessage);
        return;
      case "task_notification": {
        const notification = message as ClaudeTaskNotificationMessage;
        const task = thread.tasks.get(notification.task_id);
        if (task !== undefined) this.#settleTask(thread, task, notification.status, notification.summary);
        return;
      }
      case "task_updated": {
        const updated = message as ClaudeTaskUpdatedMessage;
        const task = thread.tasks.get(updated.task_id);
        const status = updated.patch.status;
        if (task === undefined || status === undefined) return;
        if (status === "completed" || status === "failed") this.#settleTask(thread, task, status, updated.patch.error);
        else if (status === "killed") this.#settleTask(thread, task, "stopped", updated.patch.error);
        return;
      }
      case "api_retry": {
        const retry = message as ClaudeApiRetryMessage;
        const turn = thread.turn;
        this.#emit({ type: "retry", attempt: retry.attempt, maxAttempts: retry.max_retries, retryDelayMs: retry.retry_delay_ms }, { threadId: thread.thread.id, turnId: turn?.id, hostTag: turn?.hostTag });
        return;
      }
      case "compact_boundary": {
        const turn = thread.turn;
        const id = itemIdFor(thread.thread.id, `compact:${message.uuid}`);
        this.#emit(
          { type: "item.upsert", item: { id, kind: "compaction", native: strongRef(message.uuid), status: "completed", ...(turn === undefined ? {} : { turnId: turn.id }), completedAt: nowIso() } },
          { threadId: thread.thread.id, turnId: turn?.id, hostTag: turn?.hostTag },
        );
        return;
      }
      case "hook_started":
      case "hook_progress":
      case "hook_response": {
        const hook = message as ClaudeHookMessage;
        const turn = thread.turn;
        this.#emit(
          {
            type: "x:claude.hook",
            data: {
              phase: hook.subtype.slice("hook_".length),
              hookId: hook.hook_id,
              hookName: hook.hook_name,
              hookEvent: hook.hook_event,
              ...(hook.output === undefined || hook.output === "" ? {} : { output: hook.output }),
              ...(hook.outcome === undefined ? {} : { outcome: hook.outcome }),
              ...(hook.exit_code === undefined ? {} : { exitCode: hook.exit_code }),
            } satisfies ClaudeHookEventData,
            fallback: { title: `Hook ${hook.hook_name} (${hook.hook_event})`, ...(hook.output === undefined || hook.output === "" ? {} : { text: hook.output }) },
          },
          { threadId: thread.thread.id, turnId: turn?.id, hostTag: turn?.hostTag },
        );
        return;
      }
      default:
        return;
    }
  }

  /** The turn a main-thread frame belongs to; Claude starting a turn on its own opens one. */
  #turnFor(thread: ClaudeThread, frameUuid: string): ActiveTurn {
    if (thread.turn !== undefined) return thread.turn;
    const ordinal = thread.providerTurns;
    thread.providerTurns += 1;
    const native = providerTurnRef(ordinal, frameUuid);
    const turn = this.#openTurn(thread, { id: providerTurnIdFor(thread.thread.id, native), promptUuid: undefined, origin: "provider_initiated", hostTag: undefined, clientTurnKey: undefined });
    this.#emitTurn(thread, turn, { type: "turn.upsert", turn: { id: turn.id, threadId: thread.thread.id, native, origin: "provider_initiated", status: "running", startedAt: turn.startedAt } });
    return turn;
  }

  #openTurn(thread: ClaudeThread, input: Pick<ActiveTurn, "id" | "promptUuid" | "origin" | "hostTag" | "clientTurnKey">): ActiveTurn {
    const turn: ActiveTurn = {
      ...input,
      startedAt: nowIso(),
      steers: new Set(),
      interrupting: false,
      items: new Map(),
      blocksSeen: new Map(),
      streamMessageId: undefined,
      requests: new Set(),
      assistantError: undefined,
      assistantText: undefined,
      rejectedLimit: undefined,
      model: thread.model,
      goalMayChange: false,
    };
    thread.turn = turn;
    if (input.promptUuid !== undefined) thread.prompts.set(turn.id, input.promptUuid);
    this.#setThreadStatus(thread, "running");
    return turn;
  }

  #upsertItem(thread: ClaudeThread, turn: ActiveTurn, nativeKey: string, patch: Omit<ItemPatch, "id"> & { kind?: string }): string {
    const existing = turn.items.get(nativeKey);
    const id = existing?.id ?? itemIdFor(thread.thread.id, nativeKey);
    if (existing === undefined) {
      const kind = patch.kind ?? "tool_call";
      turn.items.set(nativeKey, { id, kind, open: patch.status === "running" || patch.status === "pending" || patch.status === "waiting" });
      const item = { id, native: strongRef(nativeKey), turnId: turn.id, startedAt: nowIso(), ...patch, kind, status: patch.status ?? "running" } as Item;
      this.#emitTurn(thread, turn, { type: "item.upsert", item });
      return id;
    }
    if (patch.status !== undefined) existing.open = patch.status === "running" || patch.status === "pending" || patch.status === "waiting";
    const { kind: _kind, ...rest } = patch;
    this.#emitTurn(thread, turn, { type: "item.upsert", item: { id, ...rest } });
    return id;
  }

  #onStreamEvent(thread: ClaudeThread, message: ClaudeStreamEventMessage): void {
    if (message.parent_tool_use_id !== null) return;
    const event = asRecord(message.event);
    const turn = this.#turnFor(thread, message.uuid);
    switch (event["type"]) {
      case "message_start":
        turn.streamMessageId = asString(asRecord(event["message"])["id"]);
        return;
      case "content_block_start": {
        const block = asRecord(event["content_block"]);
        const index = event["index"];
        if (turn.streamMessageId === undefined || typeof index !== "number") return;
        const key = `${turn.streamMessageId}:${index}`;
        if (block["type"] === "text") this.#upsertItem(thread, turn, key, { kind: "assistant_message", status: "running", text: "" });
        else if (block["type"] === "thinking") this.#upsertItem(thread, turn, key, { kind: "reasoning", status: "running", reasoning: "" });
        return;
      }
      case "content_block_delta": {
        const delta = asRecord(event["delta"]);
        const index = event["index"];
        if (turn.streamMessageId === undefined || typeof index !== "number") return;
        const item = turn.items.get(`${turn.streamMessageId}:${index}`);
        if (item === undefined || !item.open) return;
        if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
          this.#emitTurn(thread, turn, { type: "item.delta", itemId: item.id, field: "text", chunk: delta["text"] });
        } else if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
          this.#emitTurn(thread, turn, { type: "item.delta", itemId: item.id, field: "reasoning", chunk: delta["thinking"] });
        }
        return;
      }
      default:
        return;
    }
  }

  #onAssistant(thread: ClaudeThread, message: ClaudeAssistantMessage): void {
    const turn = this.#turnFor(thread, message.uuid);
    const parentToolUseId = message.parent_tool_use_id;
    const parentItem = parentToolUseId === null ? undefined : turn.items.get(parentToolUseId);
    if (parentToolUseId === null && message.error !== undefined) turn.assistantError = message.error;
    const seen = turn.blocksSeen.get(message.message.id) ?? 0;
    message.message.content.forEach((block, offset) => {
      const index = seen + offset;
      const key = `${message.message.id}:${index}`;
      if (block.type === "text" && parentToolUseId === null) {
        const text = (block as { text: string }).text;
        turn.assistantText = text;
        this.#upsertItem(thread, turn, key, { kind: "assistant_message", status: "completed", text, completedAt: nowIso() });
      } else if (block.type === "thinking" && parentToolUseId === null) {
        this.#upsertItem(thread, turn, key, { kind: "reasoning", status: "completed", reasoning: (block as { thinking: string }).thinking, completedAt: nowIso() });
      } else if (block.type === "tool_use") {
        const tool = block as { id: string; name: string; input: unknown };
        this.#upsertItem(thread, turn, tool.id, {
          ...toolItemFields(tool.name, tool.input, thread.cwd),
          status: "running",
          ...(parentItem === undefined ? {} : { parentItemId: parentItem.id }),
        });
        // A SetGoal call alone sets nothing: its result says whether Claude Code set the goal or only proposed it.
        if (tool.name === "SetGoal" && parentToolUseId === null) turn.goalMayChange = true;
      }
    });
    turn.blocksSeen.set(message.message.id, seen + message.message.content.length);
  }

  #onUser(thread: ClaudeThread, message: ClaudeUserMessageOut): void {
    if (message.isReplay === true) return;
    const turn = thread.turn;
    if (turn === undefined) return;
    const content = Array.isArray(message.message.content) ? message.message.content : [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
      const item = turn.items.get(block["tool_use_id"]);
      if (item === undefined) continue;
      const output = toolResultText(block["content"]);
      const limit = this.#open.payloadLimits?.maxToolOutputBytes;
      const capped = limit === undefined ? { text: output, truncated: false } : truncateUtf8(output, limit);
      this.#upsertItem(thread, turn, block["tool_use_id"], {
        status: block["is_error"] === true ? "failed" : "completed",
        output: capped.text,
        ...(capped.truncated ? { truncated: true } : {}),
        completedAt: nowIso(),
      });
    }
  }

  #onRateLimit(thread: ClaudeThread, event: ClaudeRateLimitEvent): void {
    const limits = this.#context.rateLimited(event.rate_limit_info);
    const turn = thread.turn;
    if (turn !== undefined && event.rate_limit_info.status === "rejected") turn.rejectedLimit = event.rate_limit_info;
    this.#emit({ type: "limits.updated", limits }, { threadId: thread.thread.id, turnId: turn?.id, hostTag: turn?.hostTag });
  }

  #onResult(thread: ClaudeThread, live: LiveQuery, result: ClaudeResultMessage): void {
    if (!live.initialized && result.startup_failure_reason !== undefined) {
      live.startFailed(new Error(`Claude Code refused to start (${result.startup_failure_reason}): ${(result.errors ?? []).join("; ")}`));
      return;
    }
    const turn = thread.turn;
    if (turn === undefined) return;
    for (const uuid of result.user_message_uuids ?? []) turn.steers.delete(uuid);
    const aborted = isAbortedResult(result);
    const failure = aborted ? undefined : failureFromResult(result, { assistantError: turn.assistantError, assistantText: turn.assistantText, rejectedLimit: turn.rejectedLimit });
    this.#emitTurn(thread, turn, { type: "usage.updated", usage: usageFromResult(result, turn.model) });
    // A steer still to run belongs to this turn: Claude ended the native turn to read it (or ended it just before it arrived).
    if (turn.steers.size > 0 && !turn.interrupting && failure === undefined) return;
    if (turn.interrupting || aborted) this.#settleTurn(thread, turn, "interrupted", undefined, result);
    else if (failure !== undefined) {
      this.#settleTurn(thread, turn, "failed", failure, result);
      if (isAuthFailure(failure)) void this.#context.authFailed(failure.message);
    } else this.#settleTurn(thread, turn, "completed", undefined, result);
    this.#startQueued(thread);
  }

  #settleTurn(thread: ClaudeThread, turn: ActiveTurn, status: "completed" | "interrupted" | "failed", failure: Failure | undefined, result?: ClaudeResultMessage): void {
    if (thread.turn !== turn) return;
    thread.turn = undefined;
    const itemStatus = status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed";
    for (const [key, item] of turn.items) {
      if (item.open) this.#upsertItem(thread, turn, key, { status: itemStatus, completedAt: nowIso() });
    }
    for (const requestId of turn.requests) {
      const pending = this.#requests.get(requestId);
      if (pending !== undefined && pending.request.status === "pending") this.#closeRequest(pending, "cancelled");
    }
    const completedAt = nowIso();
    this.#emitTurn(thread, turn, {
      type: "turn.upsert",
      turn: {
        id: turn.id,
        status,
        completedAt,
        ...(failure === undefined ? {} : { failure }),
        ...(result === undefined ? {} : { usage: usageFromResult(result, turn.model) }),
        ...(turn.model === undefined ? {} : { model: turn.model }),
      },
    });
    this.#emitTurn(thread, turn, { type: "turn.terminal", turnId: turn.id, status, ...(failure === undefined ? {} : { failure }), threadDisposition: "reusable" });
    if (thread.queued.length === 0) this.#setThreadStatus(thread, "idle");
    if (turn.goalMayChange) void this.#refreshGoal(thread);
  }

  /** Claude dequeues a "later" prompt as soon as the running turn ends. */
  #startQueued(thread: ClaudeThread): void {
    if (thread.turn !== undefined) return;
    const next = thread.queued.shift();
    if (next === undefined) return;
    const turn = this.#openTurn(thread, { id: next.id, promptUuid: next.promptUuid, origin: "user", hostTag: next.hostTag, clientTurnKey: next.clientTurnKey });
    this.#emitTurn(thread, turn, { type: "turn.upsert", turn: { id: turn.id, status: "running", startedAt: turn.startedAt } });
    this.#emitPrompt(thread, turn, next.promptUuid, next.text);
    if (GOAL_COMMAND.test(next.text)) turn.goalMayChange = true;
  }

  #emitPrompt(thread: ClaudeThread, turn: ActiveTurn, promptUuid: string, text: string): void {
    const at = nowIso();
    this.#emitTurn(thread, turn, {
      type: "item.upsert",
      item: { id: promptItemIdFor(thread.thread.id, promptUuid), kind: "user_message", native: strongRef(promptUuid), status: "completed", turnId: turn.id, text, startedAt: at, completedAt: at },
    });
  }

  // Tasks and subagents.

  #onTaskStarted(thread: ClaudeThread, started: ClaudeTaskStartedMessage): void {
    if (thread.tasks.has(started.task_id)) return;
    const turn = thread.turn;
    const subagent = started.task_type === "local_agent";
    const task: TaskState = {
      nativeId: started.task_id,
      id: subagent ? subagentIdFor(thread.thread.id, started.task_id) : taskIdFor(thread.thread.id, started.task_id),
      kind: subagent ? "subagent" : started.task_type === "local_bash" ? "terminal" : "tool",
      title: started.description,
      toolUseId: started.tool_use_id,
      turnId: turn?.id,
      startedAt: nowIso(),
      status: "running",
      awaited: false,
      summary: undefined,
      settled: new Set(),
    };
    thread.tasks.set(started.task_id, task);
    if (subagent) {
      const parentItem = started.tool_use_id === undefined ? undefined : turn?.items.get(started.tool_use_id);
      const record: Subagent = {
        id: task.id,
        native: strongRef(started.task_id),
        parentThreadId: thread.thread.id,
        status: "running",
        name: started.subagent_type ?? started.description,
        ...(started.prompt === undefined ? {} : { prompt: started.prompt }),
        ...(turn === undefined ? {} : { parentTurnId: turn.id }),
        ...(parentItem === undefined ? {} : { parentItemId: parentItem.id }),
        startedAt: task.startedAt,
      };
      this.#emit({ type: "subagent.upsert", subagent: record }, { threadId: thread.thread.id, turnId: turn?.id, hostTag: turn?.hostTag });
      if (parentItem !== undefined && started.tool_use_id !== undefined && turn !== undefined) this.#upsertItem(thread, turn, started.tool_use_id, { subagentId: task.id });
    }
    this.#emitBackground(thread);
  }

  #settleTask(thread: ClaudeThread, task: TaskState, status: "completed" | "failed" | "stopped", summary: string | undefined): void {
    if (task.status !== "running") return;
    task.status = status;
    task.summary = summary;
    if (task.kind === "subagent") {
      const subagentStatus = status === "stopped" ? "cancelled" : status;
      const outcome: SubagentOutcome = { status: subagentStatus, ...(summary === undefined || summary === "" ? {} : { summary }) };
      this.#emit({ type: "subagent.upsert", subagent: { id: task.id, status: subagentStatus, completedAt: nowIso(), outcome } }, { threadId: thread.thread.id });
    }
    this.#emitBackground(thread);
    for (const wake of task.settled) wake();
    task.settled.clear();
  }

  #emitBackground(thread: ClaudeThread): void {
    const tasks: BackgroundTaskSummary[] = [...thread.tasks.values()]
      .filter((task) => task.status === "running")
      .map((task) => ({ id: task.id, kind: task.kind, status: task.status, title: task.title, threadId: thread.thread.id, ...(task.turnId === undefined ? {} : { turnId: task.turnId }), startedAt: task.startedAt }));
    this.#emit({ type: "background.updated", tasks }, { threadId: thread.thread.id });
  }

  #taskById(threadId: string, taskId: string): { thread: ClaudeThread; task: TaskState } {
    const thread = this.#thread(threadId);
    const task = [...thread.tasks.values()].find((candidate) => candidate.id === taskId);
    if (task === undefined) throw callErrors.notFound({ resource: "background task", id: taskId });
    return { thread, task };
  }

  /** Asks Claude Code to stop a task and waits for its `task_notification` (or for the process to end, which ends it too). */
  async #stopTask(thread: ClaudeThread, task: TaskState): Promise<void> {
    if (task.status !== "running") return;
    const live = thread.live;
    if (live === undefined || live.ended) {
      this.#settleTask(thread, task, "stopped", undefined);
      return;
    }
    const settled = new Promise<void>((resolve) => task.settled.add(resolve));
    await live.query.stopTask(task.nativeId);
    await Promise.race([settled, this.#whenEnded(live)]);
  }

  backgroundTasks = {
    list: async (threadId: string, options?: BackgroundTaskListOptions): Promise<TaskInfo[]> => {
      const thread = this.#thread(threadId);
      return [...thread.tasks.values()]
        .filter((task) => task.kind !== "subagent" || options?.includeSubagents === true)
        .map((task) => ({
          id: task.id,
          kind: task.kind,
          status: task.status,
          title: task.title,
          threadId,
          ...(task.turnId === undefined ? {} : { turnId: task.turnId }),
          startedAt: task.startedAt,
          ...(task.kind === "subagent" ? { subagentId: task.id } : {}),
          ...(task.summary === undefined ? {} : { output: task.summary }),
          awaited: task.awaited,
        }));
    },
    stop: async (input: StopBackgroundTaskInput): Promise<void> => {
      const { thread, task } = this.#taskById(input.threadId, input.taskId);
      await this.#stopTask(thread, task);
    },
    await: async (input: AwaitBackgroundTasksInput): Promise<AwaitBackgroundTasksResult> => {
      const thread = this.#thread(input.threadId);
      const matched: string[] = [];
      for (const task of thread.tasks.values()) {
        if (!input.taskIds.includes(task.id)) continue;
        task.awaited = input.awaited;
        matched.push(task.id);
      }
      return { matched };
    },
  };

  async stopSubagent(input: StopSubagentInput): Promise<SubagentOutcome | void> {
    this.#live();
    for (const thread of this.#threads.values()) {
      const task = [...thread.tasks.values()].find((candidate) => candidate.kind === "subagent" && candidate.id === input.subagentId);
      if (task === undefined) continue;
      // A stop asked for before the subagent started (a later run under the same id) must not stop it.
      if (input.requestedAt !== undefined && Date.parse(input.requestedAt) < Date.parse(task.startedAt)) return { status: task.status === "running" ? "running" : task.status };
      await this.#stopTask(thread, task);
      const status = task.status === "stopped" ? "cancelled" : task.status;
      return { status, ...(task.summary === undefined || task.summary === "" ? {} : { summary: task.summary }) };
    }
    throw callErrors.notFound({ resource: "subagent", id: input.subagentId });
  }

  // Turns.

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    this.#live();
    const thread = this.#thread(input.threadId);
    if (input.intent !== "start" && input.intent !== "queue" && input.intent !== "steer") return { status: "unsupported", capability: `turns.${String(input.intent)}` };
    const key = `${input.threadId}\u0000${input.clientTurnKey}`;
    const earlier = this.#turnKeys.get(key);
    if (earlier !== undefined) return earlier;
    const started = this.#startTurn(thread, input);
    this.#turnKeys.set(key, started);
    started.catch(() => this.#turnKeys.delete(key));
    return started;
  }

  async #startTurn(thread: ClaudeThread, input: StartTurnInput): Promise<StartTurnResult> {
    const active = thread.turn;
    if (input.intent === "steer") {
      // A steer reaches only the turn the host means, while the driver still sees it running.
      if (active === undefined || (input.expectedTurnId !== undefined && input.expectedTurnId !== active.id)) return { status: "prompt_required" };
      const live = thread.live;
      if (live === undefined || live.ended) return { status: "prompt_required" };
      if (input.clearPendingPermissions === true) {
        for (const requestId of active.requests) {
          const pending = this.#requests.get(requestId);
          if (pending !== undefined && pending.request.status === "pending") {
            pending.settle({ behavior: "deny", message: "The user sent a new message instead." });
            this.#closeRequest(pending, "cancelled");
          }
        }
      }
      const uuid = this.#context.newUuid() as ClaudeUuid;
      const content = await this.#content(input.content, input.context);
      active.steers.add(uuid);
      thread.steers.set(uuid, active.id);
      live.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid, priority: "now" });
      this.#emitPrompt(thread, active, uuid, this.#plainText(input.content));
      return { status: "accepted", turnId: active.id, accepted: "steered", providerMessageId: uuid };
    }
    if (input.intent === "queue" && active !== undefined) {
      const live = thread.live;
      if (live === undefined || live.ended) throw callErrors.invalidState("query_ended", "The thread's Claude Code process ended; start a new turn");
      const uuid = this.#context.newUuid() as ClaudeUuid;
      const content = await this.#content(input.content, input.context);
      const id = turnIdFor(thread.thread.id, uuid);
      const text = this.#plainText(input.content);
      thread.queued.push({ id, promptUuid: uuid, hostTag: input.hostTag, clientTurnKey: input.clientTurnKey, text });
      thread.prompts.set(id, uuid);
      this.#emit(
        {
          type: "turn.upsert",
          turn: { id, threadId: thread.thread.id, native: strongRef(uuid), origin: "user", status: "pending", clientTurnKey: input.clientTurnKey, ...(input.hostTag === undefined ? {} : { hostTag: input.hostTag }) },
        },
        { threadId: thread.thread.id, turnId: id, hostTag: input.hostTag },
      );
      live.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid, priority: "later" });
      return { status: "accepted", turnId: id, accepted: "queued", providerMessageId: uuid };
    }
    if (active !== undefined) throw callErrors.invalidState("previous_turn_active", `Turn ${active.id} is still running on thread ${thread.thread.id}`);
    const live = await this.#ensureQuery(thread);
    await this.#applyTurnSettings(thread, live, input);
    const content = await this.#content(input.content, input.context);
    const uuid = this.#context.newUuid() as ClaudeUuid;
    const id = turnIdFor(thread.thread.id, uuid);
    const turn = this.#openTurn(thread, { id, promptUuid: uuid, origin: "user", hostTag: input.hostTag, clientTurnKey: input.clientTurnKey });
    this.#emitTurn(thread, turn, {
      type: "turn.upsert",
      turn: {
        id,
        threadId: thread.thread.id,
        native: strongRef(uuid),
        origin: "user",
        status: "running",
        clientTurnKey: input.clientTurnKey,
        ...(input.hostTag === undefined ? {} : { hostTag: input.hostTag }),
        startedAt: turn.startedAt,
        ...(thread.model === undefined ? {} : { model: thread.model }),
      },
    });
    const text = this.#plainText(input.content);
    this.#emitPrompt(thread, turn, uuid, text);
    if (GOAL_COMMAND.test(text)) turn.goalMayChange = true;
    live.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid });
    return { status: "accepted", turnId: id, accepted: "started", providerMessageId: uuid };
  }

  /**
   * Model and effort reach a running query through its control methods. The
   * thread records a value only once Claude Code took it, so the thread's
   * model and effort are always what the query runs.
   */
  async #applyLiveConfig(thread: ClaudeThread, live: LiveQuery, config: { [key: string]: unknown } | undefined): Promise<void> {
    const model = config?.["model"];
    if (typeof model === "string" && model !== "" && model !== thread.model) {
      await live.query.setModel(model);
      thread.model = model;
    }
    const effort = config?.["effort"];
    if (typeof effort === "string" && effort !== thread.effort && ["low", "medium", "high", "xhigh", "max"].includes(effort)) {
      await live.query.applyFlagSettings({ effortLevel: effort as NonNullable<ClaudeDriverConfig["effort"]> });
      thread.effort = effort as ClaudeDriverConfig["effort"];
    }
  }

  /** Per-turn model, effort and policy go through the query's control methods before the prompt. */
  async #applyTurnSettings(thread: ClaudeThread, live: LiveQuery, input: StartTurnInput): Promise<void> {
    await this.#applyLiveConfig(thread, live, input.config);
    if (input.policy !== undefined && permissionModeFor(input.policy) !== permissionModeFor(thread.policy)) {
      await live.query.setPermissionMode(permissionModeFor(input.policy));
    }
    if (input.policy !== undefined) thread.policy = input.policy;
  }

  #plainText(content: readonly ContentBlock[]): string {
    return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");
  }

  /** The prompt's content blocks: turn instructions first, then the host's content. Attachments are read through the host. */
  async #content(content: readonly ContentBlock[], context: TurnContext | undefined): Promise<ClaudeContentBlockParam[]> {
    const blocks: ClaudeContentBlockParam[] = [];
    for (const text of [context?.system, context?.developer, ...(context?.synthetic ?? []).map((entry) => entry.text)]) {
      if (text !== undefined && text !== "") blocks.push({ type: "text", text });
    }
    for (const block of content) {
      switch (block.type) {
        case "text":
          blocks.push({ type: "text", text: block.text });
          break;
        case "image":
          if (block.data !== undefined) {
            const mime = block.mimeType ?? "image/png";
            if (!IMAGE_TYPES.has(mime)) throw callErrors.validation([{ message: `Claude takes JPEG, PNG, GIF or WebP images, not ${mime}`, path: ["content"] }]);
            blocks.push({ type: "image", source: { type: "base64", media_type: mime as ClaudeImageMediaType, data: block.data } });
          } else if (block.url !== undefined) {
            blocks.push({ type: "image", source: { type: "url", url: block.url } });
          } else if (block.attachmentRef !== undefined) {
            blocks.push(await this.#attachment(block.attachmentRef, block.mimeType));
          }
          break;
        case "file":
          blocks.push(await this.#attachment(block.attachmentRef, block.mimeType, block.name));
          break;
        case "resource_link":
          blocks.push({ type: "text", text: block.name === undefined ? block.uri : `${block.name} (${block.uri})` });
          break;
        default:
          break;
      }
    }
    return blocks;
  }

  async #attachment(ref: string, mimeType: string | undefined, name?: string): Promise<ClaudeContentBlockParam> {
    const info = await this.#context.host.attachments.resolve(ref);
    if (info === null) throw callErrors.attachmentUnreadable(ref, `Attachment ${ref} cannot be read`);
    const mime = mimeType ?? info.mime;
    const { readFile } = await import("node:fs/promises");
    if (IMAGE_TYPES.has(mime)) {
      const bytes = await readFile(info.path).catch(() => {
        throw callErrors.attachmentUnreadable(ref, `Attachment ${ref} cannot be read`);
      });
      return { type: "image", source: { type: "base64", media_type: mime as ClaudeImageMediaType, data: bytes.toString("base64") } };
    }
    if (mime === "application/pdf") {
      const bytes = await readFile(info.path).catch(() => {
        throw callErrors.attachmentUnreadable(ref, `Attachment ${ref} cannot be read`);
      });
      return { type: "document", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") }, ...(name === undefined ? {} : { title: name }) };
    }
    const text = mime.startsWith("text/")
      ? await readFile(info.path, "utf8").catch(() => null)
      : ((await this.#context.host.attachments.extractText?.(ref)) ?? null);
    if (text === null) throw callErrors.attachmentUnreadable(ref, `Claude cannot read ${mime} attachments`);
    return { type: "document", source: { type: "text", media_type: "text/plain", data: text }, ...(name === undefined ? {} : { title: name }) };
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    this.#live();
    const thread = [...this.#threads.values()].find((candidate) => candidate.turn?.id === input.turnId || candidate.queued.some((queued) => queued.id === input.turnId));
    if (thread === undefined) return;
    const turn = thread.turn;
    if (turn === undefined || turn.id !== input.turnId) {
      throw callErrors.invalidState("turn_queued", `Turn ${input.turnId} has not started; Claude Code runs a queued prompt once the running turn ends`);
    }
    turn.interrupting = true;
    const live = thread.live;
    if (live === undefined || live.ended) {
      this.#settleTurn(thread, turn, "interrupted", undefined);
      return;
    }
    if (input.restartRuntime === true) {
      this.#closeQuery(live, "interrupt");
      await this.#whenEnded(live);
      return;
    }
    try {
      await live.query.interrupt();
    } catch {
      // Stop always ends the turn: a process that cannot take the interrupt is ended instead.
      this.#closeQuery(live, "interrupt");
      await this.#whenEnded(live);
    }
  }

  // Requests.

  async #canUseTool(thread: ClaudeThread, toolName: string, input: Record<string, unknown>, options: ClaudeCanUseToolOptions): Promise<ClaudePermissionResult> {
    const turn = thread.turn;
    const id = requestIdFor(thread.thread.id, options.requestId);
    const item = turn?.items.get(options.toolUseID);
    const kind = requestKindFor(toolName);
    // The agent id is the subagent's task id; Claude may ask before the driver has read that task's task_started.
    const subagentId = options.agentID === undefined ? undefined : subagentIdFor(thread.thread.id, options.agentID);
    const answers = kind === "user_input" ? [] : approvalAnswers(options.suggestions, options.suppressAlwaysAllowRule === true);
    const fields = toolItemFields(toolName, input, thread.cwd);
    const request: Request = {
      id,
      native: strongRef(options.requestId),
      kind,
      origin: {
        threadId: thread.thread.id,
        ...(turn === undefined ? {} : { turnId: turn.id }),
        ...(item === undefined ? {} : { itemId: item.id }),
        ...(subagentId === undefined ? {} : { subagentId }),
      },
      subject: {
        ...(fields.command === undefined || fields.command === null ? {} : { command: fields.command, cwd: thread.cwd }),
        ...(fields.paths === undefined || fields.paths === null ? (options.blockedPath === undefined ? {} : { paths: [options.blockedPath] }) : { paths: fields.paths }),
        tool: { ...(fields.tool?.server === undefined ? {} : { server: fields.tool.server }), name: fields.tool?.name ?? toolName, input: input as never },
      },
      ...(kind === "user_input" ? { questions: questionsFrom(input) } : { options: answers.map((answer) => answer.option) }),
      allowCustomAnswer: kind === "user_input",
      allowFeedback: kind !== "user_input",
      response: { mode: "live" },
      survivesRestart: false,
      status: "pending",
      ...(options.matchedAskRule === undefined ? {} : { fullAccessOverride: "ask_rule" }),
    };
    let settle: (result: ClaudePermissionResult) => void = () => undefined;
    const answered = new Promise<ClaudePermissionResult>((resolve) => {
      settle = resolve;
    });
    const pending: PendingRequest = { thread, request, answers: new Map(answers.map((answer) => [answer.option.optionId, answer])), input, settle, resolvedBy: undefined };
    this.#requests.set(id, pending);
    turn?.requests.add(id);
    if (item !== undefined && turn !== undefined && options.toolUseID !== undefined) this.#upsertItem(thread, turn, options.toolUseID, { status: "waiting", requestId: id });
    this.#emit({ type: "request.upsert", request }, { threadId: thread.thread.id, turnId: turn?.id, hostTag: turn?.hostTag });
    options.signal.addEventListener(
      "abort",
      () => {
        if (pending.request.status === "pending") this.#closeRequest(pending, "cancelled");
        settle({ behavior: "deny", message: "The request was cancelled." });
      },
      { once: true },
    );
    const result = await answered;
    const current = thread.turn;
    if (item !== undefined && current !== undefined && current === turn && result.behavior === "allow") this.#upsertItem(thread, current, options.toolUseID, { status: "running" });
    return result;
  }

  #closeRequest(pending: PendingRequest, status: "resolved" | "expired" | "cancelled"): void {
    pending.request = { ...pending.request, status };
    const turnId = pending.request.origin.turnId;
    this.#emit({ type: "request.upsert", request: { id: pending.request.id, status } }, { threadId: pending.thread.thread.id, turnId });
  }

  async respond(input: RespondInput): Promise<RespondResult | void> {
    this.#live();
    const key = `${input.requestId}\u0000${input.responseKey}`;
    const earlier = this.#responses.get(key);
    if (earlier !== undefined) return earlier;
    const pending = this.#requests.get(input.requestId);
    if (pending === undefined) throw callErrors.notFound({ resource: "request", id: input.requestId });
    if (pending.request.status !== "pending") {
      throw callErrors.invalidState(`request_${pending.request.status}`, `Request ${input.requestId} is ${pending.request.status}${pending.resolvedBy === undefined ? "" : ` (answered with responseKey ${pending.resolvedBy})`}`);
    }
    const result = this.#answer(pending, input);
    pending.resolvedBy = input.responseKey;
    const outcome = Promise.resolve().then(() => {
      pending.settle(result);
      this.#closeRequest(pending, "resolved");
      return undefined;
    });
    this.#responses.set(key, outcome);
    return outcome;
  }

  /** The permission result for a response; throws `validation` for an answer the request does not offer. */
  #answer(pending: PendingRequest, input: RespondInput): ClaudePermissionResult {
    if (pending.request.kind === "user_input") {
      const questions = pending.request.questions ?? [];
      const answers: { [question: string]: string } = {};
      for (const question of questions) {
        const answer = input.answers?.[question.id];
        const chosen = answer?.optionIds ?? [];
        for (const optionId of chosen) {
          if (!(question.options ?? []).some((option) => option.id === optionId)) {
            throw callErrors.validation([{ message: `question ${question.id} has no option ${optionId}`, path: ["answers", question.id, "optionIds"] }]);
          }
        }
        const value = [...chosen, ...(answer?.text === undefined || answer.text === "" ? [] : [answer.text])].join(", ") || (questions.length === 1 ? input.custom : undefined);
        if (value === undefined || value === "") throw callErrors.validation([{ message: `question ${question.id} has no answer`, path: ["answers", question.id] }]);
        answers[question.prompt] = value;
      }
      return { behavior: "allow", updatedInput: { ...pending.input, answers } };
    }
    if (input.optionId === undefined) {
      if (input.custom !== undefined) return { behavior: "deny", message: input.custom, decisionClassification: "user_reject" };
      throw callErrors.validation([{ message: "an approval needs optionId", path: ["optionId"] }]);
    }
    const answer = pending.answers.get(input.optionId);
    if (answer === undefined) throw callErrors.validation([{ message: `request ${pending.request.id} has no option ${input.optionId}`, path: ["optionId"] }]);
    if (input.scope !== undefined && answer.option.scope !== undefined && answer.option.scope !== input.scope) {
      throw callErrors.validation([{ message: `option ${input.optionId} reaches ${answer.option.scope}, not ${input.scope}`, path: ["scope"] }]);
    }
    return answer.answer(input.feedback);
  }

  // Snapshots and forks.

  /** The transcript of a thread's Claude session, as Claude Code keeps it. */
  async #transcript(thread: ClaudeThread): Promise<ClaudeSessionMessage[]> {
    return this.#context.sdk.getSessionMessages(thread.nativeId, { dir: thread.cwd });
  }

  async readSnapshot(threadId: string): Promise<ThreadSnapshot> {
    this.#live();
    const thread = this.#thread(threadId);
    const transcript = await this.#transcript(thread);
    const turns: Turn[] = [];
    const items: Item[] = [];
    const toolItems = new Map<string, Item>();
    const blocksSeen = new Map<string, number>();
    let current: Turn | undefined;
    for (const entry of transcript) {
      const prompt = promptTextOf(entry);
      const steered = thread.steers.get(entry.uuid);
      if (prompt !== undefined && steered !== undefined && current?.id === steered) {
        items.push({ id: promptItemIdFor(thread.thread.id, entry.uuid), kind: "user_message", native: strongRef(entry.uuid), status: "completed", turnId: steered, text: prompt });
        continue;
      }
      if (prompt !== undefined) {
        const id = turnIdFor(thread.thread.id, entry.uuid);
        const live = thread.turn?.id === id ? thread.turn : undefined;
        current = {
          id,
          threadId: thread.thread.id,
          native: strongRef(entry.uuid),
          origin: "user",
          status: live === undefined ? "completed" : "running",
          ...(live?.hostTag === undefined ? {} : { hostTag: live.hostTag }),
        };
        turns.push(current);
        items.push({ id: promptItemIdFor(thread.thread.id, entry.uuid), kind: "user_message", native: strongRef(entry.uuid), status: "completed", turnId: id, text: prompt });
        continue;
      }
      if (current === undefined || entry.parent_tool_use_id !== null) continue;
      const message = asRecord(entry.message);
      const content = Array.isArray(message["content"]) ? (message["content"] as unknown[]) : [];
      if (entry.type === "assistant") {
        const messageId = asString(message["id"]) ?? entry.uuid;
        const seen = blocksSeen.get(messageId) ?? 0;
        content.forEach((raw, offset) => {
          const block = asRecord(raw);
          const key = `${messageId}:${seen + offset}`;
          if (block["type"] === "text" && typeof block["text"] === "string") {
            items.push({ id: itemIdFor(thread.thread.id, key), kind: "assistant_message", native: strongRef(key), status: "completed", turnId: current!.id, text: block["text"] });
          } else if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
            items.push({ id: itemIdFor(thread.thread.id, key), kind: "reasoning", native: strongRef(key), status: "completed", turnId: current!.id, reasoning: block["thinking"] });
          } else if (block["type"] === "tool_use" && typeof block["id"] === "string" && typeof block["name"] === "string") {
            const fields = toolItemFields(block["name"], block["input"], thread.cwd);
            const item = { id: itemIdFor(thread.thread.id, block["id"]), native: strongRef(block["id"]), turnId: current!.id, ...fields, kind: toolItemKind(block["name"]), status: "completed" } as Item;
            toolItems.set(block["id"], item);
            items.push(item);
          }
        });
        blocksSeen.set(messageId, seen + content.length);
      } else if (entry.type === "user") {
        for (const raw of content) {
          const block = asRecord(raw);
          if (block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
          const item = toolItems.get(block["tool_use_id"]);
          if (item === undefined) continue;
          item.output = toolResultText(block["content"]);
          if (block["is_error"] === true) item.status = "failed";
        }
      }
    }
    const requests = [...this.#requests.values()].filter((pending) => pending.thread === thread && pending.request.status === "pending").map((pending) => pending.request);
    const subagents: Subagent[] = [...thread.tasks.values()]
      .filter((task) => task.kind === "subagent")
      .map((task) => ({ id: task.id, native: strongRef(task.nativeId), parentThreadId: thread.thread.id, status: task.status === "stopped" ? "cancelled" : task.status, name: task.title }));
    return { thread: { ...thread.thread }, turns, items, requests, subagents };
  }

  /** True for a transcript entry that is a prompt which started a turn (not a tool result, not a steer this session sent). */
  #startsTurn(thread: ClaudeThread, entry: ClaudeSessionMessage): boolean {
    return promptTextOf(entry) !== undefined && !thread.steers.has(entry.uuid);
  }

  /** The uuid of a turn's prompt: from this session's turns, else from the transcript. */
  async #promptUuid(thread: ClaudeThread, turnId: string): Promise<string> {
    const known = thread.prompts.get(turnId);
    if (known !== undefined) return known;
    for (const entry of await this.#transcript(thread)) {
      if (this.#startsTurn(thread, entry) && turnIdFor(thread.thread.id, entry.uuid) === turnId) return entry.uuid;
    }
    throw callErrors.notFound({ resource: "turn", id: turnId });
  }

  /** The uuid of the last transcript entry of a turn: where a fork that keeps the turn resumes. */
  async #turnEnd(thread: ClaudeThread, turnId: string): Promise<string> {
    const transcript = await this.#transcript(thread);
    const start = transcript.findIndex((entry) => this.#startsTurn(thread, entry) && turnIdFor(thread.thread.id, entry.uuid) === turnId);
    if (start < 0) throw callErrors.notFound({ resource: "turn", id: turnId });
    let end = start;
    for (let index = start + 1; index < transcript.length; index += 1) {
      if (this.#startsTurn(thread, transcript[index]!)) break;
      end = index;
    }
    return transcript[end]!.uuid;
  }

  async forkThread(input: ForkThreadInput): Promise<Thread> {
    this.#live();
    const source = this.#thread(input.threadId);
    if (input.cwd !== undefined && input.cwd !== source.cwd) {
      throw callErrors.unsupported("threads.fork.crossCwd", "Claude keeps transcripts per project directory, so a fork stays in its source's directory");
    }
    if (input.at.type === "item") throw callErrors.unsupported("threads.fork.fromItem");
    if (source.turn !== undefined) throw callErrors.invalidState("turn_active", `Thread ${source.thread.id} has a running turn; fork it once the turn ends`);
    const at = input.at.type === "turn" ? await this.#turnEnd(source, input.at.turnId) : undefined;
    const fork = this.#newThread({
      nativeId: this.#context.newUuid(),
      cwd: source.cwd,
      persist: source.persist,
      launch: undefined,
      systemContext: source.systemContext,
      policy: input.policy ?? source.policy,
      config: { ...(source.model === undefined ? {} : { model: source.model }), ...(source.effort === undefined ? {} : { effort: source.effort }), ...input.config },
      forkedFrom: { threadId: source.thread.id, ...(input.at.type === "turn" ? { turnId: input.at.turnId } : {}) },
    });
    fork.launch = source.launch;
    try {
      await this.#ensureQuery(fork, { kind: "fork", sourceId: source.nativeId, at });
    } catch (error) {
      this.#forget(fork);
      throw error;
    }
    this.#announce(fork);
    return { ...fork.thread };
  }

  async unloadThread(threadId: string): Promise<void> {
    this.#live();
    const thread = this.#thread(threadId);
    if (thread.turn !== undefined) throw callErrors.invalidState("turn_active", `Thread ${threadId} has a running turn`);
    const live = thread.live;
    if (live !== undefined) {
      this.#closeQuery(live, "unload");
      await this.#whenEnded(live);
    }
    this.#setThreadStatus(thread, "unloaded");
  }

  canRelease(): boolean {
    if (this.#closed) return false;
    for (const thread of this.#threads.values()) {
      if (thread.turn !== undefined || thread.queued.length > 0 || thread.starting !== undefined) return false;
      if ([...thread.tasks.values()].some((task) => task.status === "running")) return false;
    }
    return ![...this.#requests.values()].some((pending) => pending.request.status === "pending");
  }

  async release(): Promise<void> {
    this.#live();
    if (!this.canRelease()) throw callErrors.invalidState("not_releasable", "A turn, request or background task is still running");
    const ending: Promise<void>[] = [];
    for (const thread of this.#threads.values()) {
      const live = thread.live;
      if (live === undefined) continue;
      this.#closeQuery(live, "release");
      ending.push(this.#whenEnded(live));
    }
    await Promise.all(ending);
  }

  // Config.

  async planConfigChange(input: PlanConfigChangeInput): Promise<ConfigChangePlan> {
    this.#thread(input.threadId);
    for (const [key, value] of Object.entries(input.changes)) {
      if (key === "model" && typeof value === "string" && value !== "") continue;
      if (key === "effort" && typeof value === "string" && ["low", "medium", "high", "xhigh", "max"].includes(value)) continue;
      return { type: "reject", reason: `Claude takes only model and effort changes in a session, not ${key}` };
    }
    // The next startTurn's config reaches Query.setModel / applyFlagSettings before its prompt.
    return { type: "apply_next_turn" };
  }

  // Extensions.

  async ext(ns: string, method: string, params: unknown): Promise<unknown> {
    this.#live();
    if (ns === EXT_FILE_CHECKPOINTS) {
      if (method !== "rewind") throw callErrors.unsupported(`extensions.${ns}.${method}`);
      const input = ClaudeRewindParamsSchema.parse(params);
      const thread = this.#thread(input.threadId);
      const uuid = await this.#promptUuid(thread, input.turnId);
      const live = await this.#ensureQuery(thread);
      const result = await live.query.rewindFiles(uuid, { dryRun: input.dryRun === true });
      const answer: ClaudeRewindResult = {
        canRewind: result.canRewind,
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.filesChanged === undefined ? {} : { filesChanged: result.filesChanged }),
        ...(result.insertions === undefined ? {} : { insertions: result.insertions }),
        ...(result.deletions === undefined ? {} : { deletions: result.deletions }),
      };
      return answer;
    }
    if (ns === EXT_HOOKS) {
      if (method !== "set") throw callErrors.unsupported(`extensions.${ns}.${method}`);
      const input = ClaudeHooksSetParamsSchema.parse(params);
      const live = await this.#ensureQuery(this.#thread(input.threadId));
      await live.query.applyFlagSettings({ hooks: input.hooks === null ? null : hookSettings(input.hooks) });
      return null;
    }
    if (ns === EXT_GOAL) {
      if (method !== "get") {
        throw callErrors.unsupported(`extensions.${ns}.${method}`, "Claude sets goals with its /goal command in a turn the host sends; the driver reads them from the transcript");
      }
      const input = AriGoalGetParamsSchema.parse(params);
      return this.#goalFromTranscript(this.#thread(input.threadId));
    }
    throw callErrors.unsupported(`extensions.${ns}`);
  }

  /** Reads the goal again from the transcript and announces it when Claude Code set, replaced or cleared one. */
  async #refreshGoal(thread: ClaudeThread): Promise<void> {
    let goal: AriGoal | null;
    try {
      goal = await this.#goalFromTranscript(thread);
    } catch (error) {
      this.#context.host.diagnostics.log({ level: "warn", msg: `The goal of thread ${thread.thread.id} could not be read from the transcript: ${errorText(error)}` });
      return;
    }
    const known = thread.goal;
    if (goal === null ? known === null : known !== null && known.objective === goal.objective && known.status === goal.status) return;
    thread.goal = goal === null ? null : { ...goal, updatedAt: nowIso() };
    const data = thread.goal;
    this.#emit({ type: "x:ari.goal.updated", data, fallback: { title: data === null ? "Goal cleared" : "Goal", ...(data === null ? {} : { text: data.objective }) } }, { threadId: thread.thread.id });
  }

  /**
   * The goal as Claude Code confirmed it in the transcript. Claude Code
   * 2.1.330 records its /goal command as a tagged command row and the
   * command's answer as a tagged output row: "Goal set: <condition>" sets
   * the goal, "Goal cleared: <condition>" clears it, and any other answer (a
   * refusal, the status) changes nothing. A SetGoal call sets the goal only
   * when its result says so; with ask_user it only proposes the goal to the
   * user. Prompts after the goal was set are turns of the goal run.
   */
  async #goalFromTranscript(thread: ClaudeThread): Promise<AriGoal | null> {
    let goal: AriGoal | null = null;
    let turnId: string | undefined;
    let command: string | undefined;
    const setGoalCalls = new Map<string, string>();
    for (const entry of await this.#transcript(thread)) {
      const output = localCommandOutputOf(entry);
      if (output !== undefined) {
        if (command === "goal" && output.startsWith(GOAL_SET)) goal = { threadId: thread.thread.id, objective: output.slice(GOAL_SET.length), status: "active", derived: true, turnIds: turnId === undefined ? [] : [turnId] };
        else if (command === "goal" && output.startsWith(GOAL_CLEARED)) goal = null;
        continue;
      }
      if (this.#startsTurn(thread, entry)) {
        turnId = turnIdFor(thread.thread.id, entry.uuid);
        command = slashCommandOf(entry)?.name;
        if (goal !== null && command !== "goal") goal = { ...goal, turnIds: [...(goal.turnIds ?? []), turnId] };
        continue;
      }
      if (entry.parent_tool_use_id !== null) continue;
      const content = asRecord(entry.message)["content"];
      for (const raw of Array.isArray(content) ? content : []) {
        const block = asRecord(raw);
        if (entry.type === "assistant" && block["type"] === "tool_use" && block["name"] === "SetGoal" && typeof block["id"] === "string") {
          const condition = asString(asRecord(block["input"])["condition"]);
          if (condition !== undefined) setGoalCalls.set(block["id"], condition);
        } else if (entry.type === "user" && block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") {
          const condition = setGoalCalls.get(block["tool_use_id"]);
          if (condition === undefined || block["is_error"] === true || !toolResultText(block["content"]).startsWith(SET_GOAL_DONE)) continue;
          goal = { threadId: thread.thread.id, objective: condition, status: "active", derived: true, turnIds: turnId === undefined ? [] : [turnId] };
        }
      }
    }
    return goal;
  }

  // History.

  /** Replays a resumed thread's stored turns as events, so the host's view holds them. */
  async #replayHistory(thread: ClaudeThread): Promise<void> {
    const snapshot = await this.readSnapshot(thread.thread.id);
    for (const turn of snapshot.turns) {
      if (turn.status !== "completed") continue;
      this.#emit({ type: "turn.upsert", turn }, { threadId: thread.thread.id, turnId: turn.id });
      for (const item of snapshot.items) if (item.turnId === turn.id) this.#emit({ type: "item.upsert", item }, { threadId: thread.thread.id, turnId: turn.id });
      this.#emit({ type: "turn.terminal", turnId: turn.id, status: "completed", threadDisposition: "reusable" }, { threadId: thread.thread.id, turnId: turn.id });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const ending: Promise<void>[] = [];
    for (const thread of this.#threads.values()) {
      const live = thread.live;
      if (live !== undefined) {
        this.#closeQuery(live, "close");
        ending.push(this.#whenEnded(live));
      }
      const starting = thread.starting;
      if (starting !== undefined) {
        ending.push(
          starting.then(
            (started) => {
              this.#closeQuery(started, "close");
              return this.#whenEnded(started);
            },
            () => undefined,
          ),
        );
      }
    }
    await Promise.all(ending);
    for (const pending of this.#requests.values()) {
      if (pending.request.status === "pending") {
        pending.settle({ behavior: "deny", message: "The session closed." });
        this.#closeRequest(pending, "expired");
      }
    }
    for (const thread of this.#threads.values()) this.#setThreadStatus(thread, "closed");
    this.#emit({ type: "session.state", state: "stopped" });
    this.#events.close();
    this.#context.closed();
  }

  /** For the instance: whether any thread of this session holds the Claude session. */
  holds(nativeId: string): boolean {
    return [...this.#threads.values()].some((thread) => thread.nativeId === nativeId && thread.live !== undefined);
  }
}

/** The ARI session id for the `ordinal`th session an instance opens. */
export function sessionIdFor(instanceId: string, ordinal: number): string {
  return deriveId({ kind: "session", native: { id: null, strength: "none", ordinal }, identityVersion: CLAUDE_IDENTITY_VERSION, scope: instanceId });
}
