// The capability guard: wraps a `Session` so that a call to a capability-gated
// member whose capability is off rejects with `unsupported{capability}` and
// never reaches the driver. The gates are the `capability` fields of
// spec/v1/methods.json, plus the gates that depend on arguments:
//
//   readSnapshot          threads.readSnapshot
//   forkThread            threads.fork, plus threads.fork.fromTurn for
//                         `at: { type: "turn" }` and threads.fork.fromItem for
//                         `at: { type: "item" }`
//   rollbackThread        threads.rollback
//   compactThread         threads.compact
//   injectHistory         threads.injectHistory
//   unloadThread          threads.unload
//   backgroundTasks.*     background.list, background.stop, background.await
//   stopSubagent          subagents.stop
//   mcpApps.*             tools.mcpApps
//   contextWindow         contextWindowReporting (synchronous: throws)
//   canReuseContextUsage  sessions.contextUsageReuse (synchronous: throws)
//   uploadFeedback        sessions.feedbackUpload
//   ext(ns, ...)          `ns` listed in capabilities.extensions
//   startTurn             intent `steer` needs turns.steer and intent `queue`
//                         needs turns.queue; when off, startTurn resolves to
//                         `{ status: "unsupported", capability }` as the
//                         Session contract says, without reaching the driver.
//
// The guard reads `session.capabilities()` on every call, so a
// `capabilities.updated` change applies at once. Members the driver leaves out
// stay absent; every other member passes through unchanged.

import { hasCapability } from "../capabilities.ts";
import { callErrors } from "../errors.ts";
import type { Capabilities } from "../generated/capabilities.ts";
import type { ForkThreadInput, StartTurnInput, StartTurnResult } from "../generated/session.ts";
import type { Session } from "../runtime.ts";

/** The capability path a `forkThread` call needs, which depends on where it forks from. */
export function forkCapabilityPath(input: Pick<ForkThreadInput, "at">): string {
  if (input.at.type === "turn") return "threads.fork.fromTurn";
  if (input.at.type === "item") return "threads.fork.fromItem";
  return "threads.fork";
}

/** The capability path a `startTurn` intent needs, or undefined for `start`, which every driver supports. */
export function startTurnCapabilityPath(input: Pick<StartTurnInput, "intent">): string | undefined {
  if (input.intent === "steer") return "turns.steer";
  if (input.intent === "queue") return "turns.queue";
  return undefined;
}

function extensionListed(capabilities: Capabilities, ns: string): boolean {
  return capabilities.extensions.some((extension) => extension.ns === ns);
}

/** Returns a `Session` that refuses capability-gated calls whose capability is off. */
export function guardSession(session: Session): Session {
  /** Rejects when `path` is off; otherwise runs `call`. */
  const gated = <Result>(path: string, call: () => Promise<Result>): Promise<Result> => {
    if (!hasCapability(session.capabilities(), path)) return Promise.reject(callErrors.unsupported(path));
    return call();
  };

  const guarded: Session = {
    get id() {
      return session.id;
    },
    capabilities: () => session.capabilities(),
    events: (options) => session.events(options),
    createThread: (input) => session.createThread(input),
    resumeThread: (input) => session.resumeThread(input),
    canRelease: () => session.canRelease(),
    release: () => session.release(),
    startTurn: (input): Promise<StartTurnResult> => {
      const path = startTurnCapabilityPath(input);
      if (path !== undefined && !hasCapability(session.capabilities(), path)) {
        return Promise.resolve({ status: "unsupported", capability: path });
      }
      return session.startTurn(input);
    },
    interruptTurn: (input) => session.interruptTurn(input),
    respond: (input) => session.respond(input),
    planConfigChange: (input) => session.planConfigChange(input),
    close: () => session.close(),
  };

  const { readSnapshot, forkThread, rollbackThread, compactThread, injectHistory, unloadThread } = session;
  if (readSnapshot !== undefined) {
    guarded.readSnapshot = (threadId) => gated("threads.readSnapshot", () => readSnapshot.call(session, threadId));
  }
  if (forkThread !== undefined) {
    guarded.forkThread = (input) =>
      gated("threads.fork", () => gated(forkCapabilityPath(input), () => forkThread.call(session, input)));
  }
  if (rollbackThread !== undefined) {
    guarded.rollbackThread = (input) => gated("threads.rollback", () => rollbackThread.call(session, input));
  }
  if (compactThread !== undefined) {
    guarded.compactThread = (threadId) => gated("threads.compact", () => compactThread.call(session, threadId));
  }
  if (injectHistory !== undefined) {
    guarded.injectHistory = (input) => gated("threads.injectHistory", () => injectHistory.call(session, input));
  }
  if (unloadThread !== undefined) {
    guarded.unloadThread = (threadId) => gated("threads.unload", () => unloadThread.call(session, threadId));
  }

  const backgroundTasks = session.backgroundTasks;
  if (backgroundTasks !== undefined) {
    guarded.backgroundTasks = {
      list: (threadId, options) => gated("background.list", () => backgroundTasks.list(threadId, options)),
      stop: (input) => gated("background.stop", () => backgroundTasks.stop(input)),
      await: (input) => gated("background.await", () => backgroundTasks.await(input)),
    };
  }

  const { stopSubagent, uploadFeedback, ext, contextWindow, canReuseContextUsage } = session;
  if (stopSubagent !== undefined) {
    guarded.stopSubagent = (input) => gated("subagents.stop", () => stopSubagent.call(session, input));
  }

  const mcpApps = session.mcpApps;
  if (mcpApps !== undefined) {
    guarded.mcpApps = {
      listTools: (threadId, server) => gated("tools.mcpApps", () => mcpApps.listTools(threadId, server)),
      callTool: (threadId, server, tool, args) => gated("tools.mcpApps", () => mcpApps.callTool(threadId, server, tool, args)),
      readResource: (threadId, server, uri) => gated("tools.mcpApps", () => mcpApps.readResource(threadId, server, uri)),
    };
  }

  if (uploadFeedback !== undefined) {
    guarded.uploadFeedback = (input) => gated("sessions.feedbackUpload", () => uploadFeedback.call(session, input));
  }
  if (ext !== undefined) {
    guarded.ext = (ns, method, params) => {
      if (!extensionListed(session.capabilities(), ns)) return Promise.reject(callErrors.unsupported(`extensions.${ns}`));
      return ext.call(session, ns, method, params);
    };
  }
  if (contextWindow !== undefined) {
    guarded.contextWindow = (model, cwd) => {
      if (!hasCapability(session.capabilities(), "contextWindowReporting")) throw callErrors.unsupported("contextWindowReporting");
      return contextWindow.call(session, model, cwd);
    };
  }
  if (canReuseContextUsage !== undefined) {
    guarded.canReuseContextUsage = (previousModel, nextModel) => {
      if (!hasCapability(session.capabilities(), "sessions.contextUsageReuse")) throw callErrors.unsupported("sessions.contextUsageReuse");
      return canReuseContextUsage.call(session, previousModel, nextModel);
    };
  }

  return guarded;
}
