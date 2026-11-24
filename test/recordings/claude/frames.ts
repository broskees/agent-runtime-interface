// The frames of a Claude native recording: the traffic between the ARI
// Claude driver and the Claude Agent SDK module it loads. docs/recordings.md
// documents each kind.
//
//   out query               the driver called `query()`: its options and prompt mode
//   out prompt              the driver's prompt stream yielded one SDKUserMessage
//   out call                the driver called a Query control method or an SDK
//                           session function, with its arguments
//   in  result              what that call returned, or the error it threw
//   in  message             the query's stream yielded one SDKMessage
//   in  end                 the query's stream ended
//   in  error               the query's stream threw
//   in  can_use_tool        the SDK called the driver's canUseTool
//   in  can_use_tool_abort  the SDK aborted that call's signal before the driver answered
//   out permission          the driver's answer to canUseTool, or the error it threw
//   in  stderr              the SDK called the driver's stderr callback with a chunk

import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import type * as ClaudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import type { Frame, FrameDirection } from "../format.ts";
import type { NativeAnswer } from "../scenarios.ts";
import type { IgnoredField } from "../sequencer.ts";

/** The part of the SDK module the driver loads, typed by the pinned SDK. */
export type ClaudeSdkModule = Pick<typeof ClaudeAgentSdk, "query" | "getSessionInfo" | "getSessionMessages" | "listSessions" | "deleteSession" | "archiveSession">;

/** A loaded SDK as the driver's `loadSdk` returns it. */
export interface ClaudeRuntime {
  readonly sdk: ClaudeSdkModule;
  readonly version: string | undefined;
  readonly claudeCodeVersion: string | undefined;
  readonly bundledExecutable: string | null;
}

export const CLAUDE_FRAME_KINDS: ReadonlyArray<{ readonly kind: string; readonly dir: FrameDirection }> = [
  { kind: "query", dir: "out" },
  { kind: "prompt", dir: "out" },
  { kind: "call", dir: "out" },
  { kind: "result", dir: "in" },
  { kind: "message", dir: "in" },
  { kind: "end", dir: "in" },
  { kind: "error", dir: "in" },
  { kind: "can_use_tool", dir: "in" },
  { kind: "can_use_tool_abort", dir: "in" },
  { kind: "permission", dir: "out" },
  { kind: "stderr", dir: "in" },
];

/** The Query control methods the driver calls that answer with a promise. */
export const CLAUDE_QUERY_CALLS = ["interrupt", "setPermissionMode", "setModel", "setMcpServers", "applyFlagSettings", "stopTask", "rewindFiles", "initializationResult", "supportedModels"] as const satisfies ReadonlyArray<keyof Query>;

/** The SDK functions the driver calls. */
export const CLAUDE_MODULE_CALLS = ["getSessionInfo", "getSessionMessages", "listSessions", "deleteSession", "archiveSession"] as const satisfies ReadonlyArray<keyof ClaudeSdkModule>;

/** The fields Claude replay leaves out of the comparison. docs/recordings.md lists the same, with the same reasons. */
export const CLAUDE_IGNORED_FIELDS: readonly IgnoredField[] = [
  {
    driver: "claude",
    kind: "query",
    field: "options.env.CLAUDE_AGENT_SDK_CLIENT_APP",
    reason: "the driver sets it to ari/ followed by the ARI version, which changes with every ARI release",
  },
  {
    driver: "claude",
    kind: "query",
    field: "options.env.ANTHROPIC_API_KEY",
    reason: "present only when the recorder ran with ANTHROPIC_API_KEY set; a replay has no key, and a recording holds only its placeholder",
  },
];

/** A value as a frame holds it: JSON, with functions and abort objects named instead of dropped. */
export function jsonSafe<T>(value: T): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(value, (_key, each: unknown) => {
      if (typeof each === "function") return "<function>";
      if (typeof AbortController !== "undefined" && each instanceof AbortController) return "<AbortController>";
      if (typeof AbortSignal !== "undefined" && each instanceof AbortSignal) return "<AbortSignal>";
      if (each instanceof Error) return { name: each.name, message: each.message };
      if (typeof each === "bigint") return each.toString();
      return each;
    }),
  );
}

/** An error as a frame holds it. */
export function errorJson(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
}

/** The error a replay throws for a recorded one. */
export function errorFrom(recorded: unknown): Error {
  const shape = (recorded ?? {}) as { name?: unknown; message?: unknown };
  const error = new Error(typeof shape.message === "string" ? shape.message : JSON.stringify(recorded));
  if (typeof shape.name === "string") error.name = shape.name;
  return error;
}

/** A query's options as the `query` frame holds them. */
export function queryOptionsFrame(options: Options | undefined): unknown {
  return jsonSafe(options ?? {});
}

/** The approval answers the driver sent to Claude Code, read off its `permission` frames. */
export function claudeNativeAnswers(frames: ReadonlyArray<Frame | { readonly line: number; readonly frame: Frame }>): NativeAnswer[] {
  const answers: NativeAnswer[] = [];
  for (const entry of frames) {
    const frame = "frame" in entry && typeof entry.frame === "object" ? (entry.frame as Frame) : (entry as Frame);
    const line = "frame" in entry && typeof entry.line === "number" ? entry.line : undefined;
    if (frame.dir !== "out" || frame.kind !== "permission") continue;
    const result = frame["result"] as { behavior?: unknown; updatedPermissions?: unknown[]; interrupt?: unknown } | null | undefined;
    if (result === undefined || result === null) continue;
    const at = line === undefined ? {} : { line };
    if (result.behavior === "allow") answers.push({ decision: "accept", ...((result.updatedPermissions ?? []).length === 0 ? { scope: "once" as const } : {}), ...at });
    else if (result.behavior === "deny") answers.push({ decision: result.interrupt === true ? "cancel" : "decline", ...at });
  }
  return answers;
}

/**
 * Reads the driver's prompt stream as fast as the driver writes it, calls
 * `onMessage` for each message, and hands them on in order. The tap and the
 * replay SDK both read this way, so a prompt's place among the frames is the
 * moment the driver sent it, whoever consumes it.
 */
export function pullPrompts<T>(source: AsyncIterable<T>, onMessage: (message: T) => void): AsyncIterable<T> {
  const buffer: T[] = [];
  let ended = false;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  void (async () => {
    try {
      for await (const message of source) {
        onMessage(message);
        buffer.push(message);
        wake?.();
      }
    } catch (error) {
      failure = { error };
    }
    ended = true;
    wake?.();
  })();
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<T, undefined>> => {
        for (;;) {
          const message = buffer.shift();
          if (message !== undefined) return { value: message, done: false };
          if (failure !== undefined) throw failure.error;
          if (ended) return { value: undefined, done: true };
          await new Promise<void>((resolve) => {
            wake = () => {
              wake = undefined;
              resolve();
            };
          });
        }
      },
      return: async (): Promise<IteratorResult<T, undefined>> => {
        ended = true;
        return { value: undefined, done: true };
      },
    }),
  };
}

/** The session ids and prompt uuids the driver gives Claude during recording and replay: a fixed sequence, so both runs choose the same ids. */
export function fixedUuids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `a11ce000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}
