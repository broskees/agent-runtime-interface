// An in-memory Session with every member, for host-toolkit tests. It records
// each call that reaches it, and its turns emit real events through the
// driver kit's sequencer: createThread opens a thread; startTurn starts a turn,
// streams an answer and settles it.

import type { Capabilities, Session, StartTurnResult, Thread } from "../../src/index.ts";
import { EventSequencer } from "../../src/driver-kit/index.ts";

export interface FakeSession extends Session {
  /** Every call that reached the session, by member path, in order. */
  readonly calls: Array<{ readonly member: string; readonly args: readonly unknown[] }>;
  readonly sequencer: EventSequencer;
  setCapabilities(capabilities: Capabilities): void;
}

export function fakeSession(initial: Capabilities, sessionId = "session-fake"): FakeSession {
  let capabilities = initial;
  let tick = 0;
  const sequencer = new EventSequencer({ sessionId, clock: () => new Date(Date.UTC(2026, 10, 23, 12, 0, tick++)).toISOString() });
  const calls: Array<{ member: string; args: readonly unknown[] }> = [];
  const threads = new Map<string, Thread>();
  let turnCount = 0;

  const called = (member: string, ...args: unknown[]): void => {
    calls.push({ member, args });
  };

  const session: FakeSession = {
    id: sessionId,
    calls,
    sequencer,
    setCapabilities(next) {
      capabilities = next;
      sequencer.emit({ body: { type: "capabilities.updated", capabilities: next } });
    },
    capabilities: () => capabilities,
    events: (options) => sequencer.events(options),
    async createThread(input) {
      called("createThread", input);
      const thread: Thread = { id: `thread-${threads.size + 1}`, native: { id: `n-thread-${threads.size + 1}`, strength: "strong" }, cwd: input.cwd, status: "idle" };
      threads.set(thread.id, thread);
      sequencer.emit({ threadId: thread.id, body: { type: "thread.upsert", thread } });
      return { ...thread, appliedConfig: { model: "fast" } };
    },
    async resumeThread(input) {
      called("resumeThread", input);
      const thread: Thread = { id: "thread-resumed", native: { id: "n-resumed", strength: "strong" }, cwd: "/work", status: "idle" };
      return thread;
    },
    async readSnapshot(threadId) {
      called("readSnapshot", threadId);
      const thread = threads.get(threadId);
      if (thread === undefined) throw new Error(`no thread ${threadId}`);
      return { thread, turns: [], items: [], requests: [] };
    },
    async forkThread(input) {
      called("forkThread", input);
      return { id: "thread-fork", native: { id: "n-fork", strength: "strong" }, cwd: input.cwd ?? "/work", status: "idle", forkedFrom: { threadId: input.threadId } };
    },
    async rollbackThread(input) {
      called("rollbackThread", input);
      const thread = threads.get(input.threadId)!;
      return { thread, turns: [], items: [], requests: [] };
    },
    async compactThread(threadId) {
      called("compactThread", threadId);
    },
    async injectHistory(input) {
      called("injectHistory", input);
      return { consumed: true };
    },
    async unloadThread(threadId) {
      called("unloadThread", threadId);
    },
    canRelease() {
      called("canRelease");
      return true;
    },
    async release() {
      called("release");
    },
    async startTurn(input): Promise<StartTurnResult> {
      called("startTurn", input);
      turnCount += 1;
      const turnId = `turn-${turnCount}`;
      const itemId = `item-${turnCount}`;
      const envelope = { threadId: input.threadId, turnId };
      sequencer.emit({
        ...envelope,
        body: { type: "turn.upsert", turn: { id: turnId, threadId: input.threadId, native: { id: `n-${turnId}`, strength: "strong" }, origin: "user", status: "running" } },
      });
      sequencer.emit({ ...envelope, body: { type: "item.upsert", item: { id: itemId, kind: "assistant_message", native: { id: `n-${itemId}`, strength: "strong" }, status: "running", turnId } } });
      sequencer.emit({ ...envelope, body: { type: "item.delta", itemId, field: "text", chunk: "Hello" } });
      sequencer.emit({ ...envelope, body: { type: "item.upsert", item: { id: itemId, status: "completed", text: "Hello" } } });
      sequencer.emit({ ...envelope, body: { type: "turn.terminal", turnId, status: "completed", threadDisposition: "reusable" } });
      return { status: "accepted", turnId, accepted: "started" };
    },
    async interruptTurn(input) {
      called("interruptTurn", input);
    },
    async respond(input) {
      called("respond", input);
      return { followUpPrompt: [{ type: "text", text: `answered ${input.requestId}` }] };
    },
    backgroundTasks: {
      async list(threadId, options) {
        called("backgroundTasks.list", threadId, options);
        return [{ id: "task-1", kind: "terminal", status: "running" }];
      },
      async stop(input) {
        called("backgroundTasks.stop", input);
      },
      async await(input) {
        called("backgroundTasks.await", input);
        return { matched: input.taskIds };
      },
    },
    async stopSubagent(input) {
      called("stopSubagent", input);
      return { status: "cancelled" };
    },
    mcpApps: {
      async listTools(threadId, server) {
        called("mcpApps.listTools", threadId, server);
        return [{ name: "search" }];
      },
      async callTool(threadId, server, tool, args) {
        called("mcpApps.callTool", threadId, server, tool, args);
        return { content: [] };
      },
      async readResource(threadId, server, uri) {
        called("mcpApps.readResource", threadId, server, uri);
        return { contents: [] };
      },
    },
    async planConfigChange(input) {
      called("planConfigChange", input);
      return { type: "apply_next_turn" };
    },
    contextWindow(model, cwd) {
      called("contextWindow", model, cwd);
      return 200_000;
    },
    canReuseContextUsage(previousModel, nextModel) {
      called("canReuseContextUsage", previousModel, nextModel);
      return previousModel === nextModel;
    },
    async uploadFeedback(input) {
      called("uploadFeedback", input);
      return { feedbackId: "feedback-1" };
    },
    async ext(ns, method, params) {
      called("ext", ns, method, params);
      return { ns, method };
    },
    async close() {
      called("close");
      sequencer.close();
    },
  };
  return session;
}
