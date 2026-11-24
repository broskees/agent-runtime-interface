// The Claude tap: wraps the SDK module a recorder hands to the driver's
// `loadSdk`, passes every call through to it unchanged, and records the
// traffic in both directions as frames (./frames.ts): the `query()` options,
// each prompt the driver streams, each control call and SDK session call
// with its result, each message the query yields, the end of each stream,
// and each `canUseTool` call with the driver's answer.
//
// A frame is recorded when it crosses the boundary: an outbound frame when
// the driver makes the call (a prompt when the driver writes it), an inbound
// frame when the driver receives it.

import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Frame } from "../format.ts";
import { CLAUDE_QUERY_CALLS, errorJson, jsonSafe, pullPrompts, queryOptionsFrame } from "./frames.ts";
import type { ClaudeSdkModule } from "./frames.ts";

export interface ClaudeTap {
  /** The wrapped module, to hand to the driver. */
  readonly sdk: ClaudeSdkModule;
  /** Resolves true once every query's stream has ended (its `end` or `error` frame is recorded), or false after `timeoutMs`. */
  settled(timeoutMs: number): Promise<boolean>;
}

export function tapClaudeSdk(sdk: ClaudeSdkModule, record: (frame: Frame) => void): ClaudeTap {
  let queries = 0;
  let calls = 0;
  let permissions = 0;
  const open = new Set<string>();
  const waiters = new Set<() => void>();

  const ended = (queryId: string): void => {
    open.delete(queryId);
    for (const waiter of [...waiters]) waiter();
  };

  const call = async <T>(queryId: string | null, method: string, args: unknown[], invoke: () => Promise<T>): Promise<T> => {
    calls += 1;
    const id = calls;
    record({ dir: "out", kind: "call", id, query: queryId, method, args: jsonSafe(args) });
    try {
      const value = await invoke();
      record({ dir: "in", kind: "result", id, ...(value === undefined ? {} : { value: jsonSafe(value) }) });
      return value;
    } catch (error) {
      record({ dir: "in", kind: "result", id, error: errorJson(error) });
      throw error;
    }
  };

  const tapCanUseTool =
    (queryId: string, canUseTool: CanUseTool): CanUseTool =>
    async (toolName, input, options) => {
      permissions += 1;
      const id = `p${permissions}`;
      const { signal, ...rest } = options;
      record({ dir: "in", kind: "can_use_tool", id, query: queryId, toolName, input: jsonSafe(input), options: jsonSafe(rest) });
      let answered = false;
      const onAbort = (): void => {
        if (!answered) record({ dir: "in", kind: "can_use_tool_abort", id, query: queryId });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await canUseTool(toolName, input, options);
        answered = true;
        record({ dir: "out", kind: "permission", id, query: queryId, result: jsonSafe(result) });
        return result;
      } catch (error) {
        answered = true;
        record({ dir: "out", kind: "permission", id, query: queryId, error: errorJson(error) });
        throw error;
      }
    };

  const tapQuery = (queryId: string, real: Query): Query => {
    let done = false;
    const finish = (frame: Frame): void => {
      if (done) return;
      done = true;
      record(frame);
      ended(queryId);
    };
    const own = new Map<PropertyKey, unknown>();
    own.set("next", async (): Promise<IteratorResult<SDKMessage, void>> => {
      try {
        const result = await real.next();
        if (result.done === true) finish({ dir: "in", kind: "end", query: queryId });
        else record({ dir: "in", kind: "message", query: queryId, message: jsonSafe(result.value) });
        return result;
      } catch (error) {
        finish({ dir: "in", kind: "error", query: queryId, error: errorJson(error) });
        throw error;
      }
    });
    for (const method of CLAUDE_QUERY_CALLS) {
      own.set(method, (...args: unknown[]) => call(queryId, method, args, () => (real[method] as (...each: unknown[]) => Promise<unknown>).apply(real, args)));
    }
    own.set("close", (): void => {
      calls += 1;
      record({ dir: "out", kind: "call", id: calls, query: queryId, method: "close", args: [] });
      real.close();
    });
    const proxy: Query = new Proxy(real, {
      get(target, property) {
        if (property === Symbol.asyncIterator) return () => proxy;
        if (own.has(property)) return own.get(property);
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    return proxy;
  };

  const tapped: ClaudeSdkModule = {
    query: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
      queries += 1;
      const queryId = `q${queries}`;
      const driverOptions = params.options ?? {};
      const streaming = typeof params.prompt !== "string";
      record({ dir: "out", kind: "query", query: queryId, prompt: streaming ? "stream" : { text: params.prompt }, options: queryOptionsFrame(driverOptions) });
      const prompt =
        typeof params.prompt === "string" ? params.prompt : pullPrompts(params.prompt, (message) => record({ dir: "out", kind: "prompt", query: queryId, message: jsonSafe(message) }));
      const options: Options = { ...driverOptions, ...(driverOptions.canUseTool === undefined ? {} : { canUseTool: tapCanUseTool(queryId, driverOptions.canUseTool) }) };
      open.add(queryId);
      return tapQuery(queryId, sdk.query({ prompt, options }));
    },
    getSessionInfo: (...args) => call(null, "getSessionInfo", args, () => sdk.getSessionInfo(...args)),
    getSessionMessages: (...args) => call(null, "getSessionMessages", args, () => sdk.getSessionMessages(...args)),
    listSessions: (...args) => call(null, "listSessions", args, () => sdk.listSessions(...args)),
    deleteSession: (...args) => call(null, "deleteSession", args, () => sdk.deleteSession(...args)),
    archiveSession: (...args) => call(null, "archiveSession", args, () => sdk.archiveSession(...args)),
  };

  return {
    sdk: tapped,
    settled: (timeoutMs) =>
      new Promise<boolean>((resolve) => {
        if (open.size === 0) return resolve(true);
        const timer = setTimeout(() => {
          waiters.delete(check);
          resolve(false);
        }, timeoutMs);
        const check = (): void => {
          if (open.size > 0) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(true);
        };
        waiters.add(check);
      }),
  };
}
