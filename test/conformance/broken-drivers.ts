// Deliberately broken variants of the reference driver, at least one per
// conformance scenario and one for each rule a scenario guards. Each one
// wraps the honest reference driver and adds exactly one bug, the way
// production drivers have broken: a quiet timer that settles turns, a steer
// that silently starts a new turn, a resume that swaps native sessions
// without saying so, a declared capability that returns a well-shaped result
// and does nothing, and so on. test/conformance/broken.test.ts runs each
// against its scenario and asserts the scenario fails for that reason.

import * as fs from "node:fs";
import * as path from "node:path";
import { createConformanceSuite, referenceHarness } from "../../src/conformance/index.ts";
import type { ConformanceHarness, ReferenceDriverConfig } from "../../src/conformance/index.ts";
import { EventSequencer } from "../../src/driver-kit/index.ts";
import { callErrors } from "../../src/index.ts";
import type { AriEvent, AriEventBody, AuthState, Capabilities, Driver, HostServices, Instance, Session, Thread } from "../../src/index.ts";
import { childProcessHarness } from "./child-process-harness.ts";

/** `target` with some members replaced. Every other member is the target's own, bound to it so private fields keep working. */
export function override<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(object, property) {
      if (Object.hasOwn(overrides, property)) return (overrides as { [key: PropertyKey]: unknown })[property];
      const value = Reflect.get(object, property, object) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
    },
    has(object, property) {
      return Object.hasOwn(overrides, property) || property in object;
    },
  });
}

type Envelope = Pick<AriEvent, "threadId" | "turnId" | "hostTag">;

/** A session whose event stream is rewritten event by event, renumbered so `seq` stays gap-free. */
export interface RewrittenSession {
  readonly session: Session;
  /** Adds an event of the wrapper's own. */
  inject(body: AriEventBody, envelope?: Envelope): void;
}

export function rewriteEvents(inner: Session, rewrite: (event: AriEvent, pass: (body?: AriEventBody, envelope?: Envelope) => void) => void): RewrittenSession {
  const sequencer = new EventSequencer({ sessionId: inner.id });
  const inject = (body: AriEventBody, envelope: Envelope = {}): void => {
    if (sequencer.closed) return;
    sequencer.emit({
      body,
      ...(envelope.threadId === undefined ? {} : { threadId: envelope.threadId }),
      ...(envelope.turnId === undefined ? {} : { turnId: envelope.turnId }),
      ...(envelope.hostTag === undefined ? {} : { hostTag: envelope.hostTag }),
    });
  };
  void (async () => {
    for await (const event of inner.events()) {
      rewrite(event, (body = event.body, envelope = event) => inject(body, envelope));
    }
    sequencer.close();
  })();
  return { session: override(inner, { events: (options?: { fromSeq?: number }) => sequencer.events(options?.fromSeq === undefined ? {} : { fromSeq: options.fromSeq }) }), inject };
}

type CreateInput = Parameters<Driver<ReferenceDriverConfig>["create"]>[1];

interface Breakage {
  readonly instance?: (instance: Instance, host: HostServices<ReferenceDriverConfig>, input: CreateInput) => Instance;
  readonly session?: (session: Session, host: HostServices<ReferenceDriverConfig>) => Session;
}

export function breakDriver(driver: Driver<ReferenceDriverConfig>, breakage: Breakage): Driver<ReferenceDriverConfig> {
  return override(driver, {
    async create(host: HostServices<ReferenceDriverConfig>, input: CreateInput) {
      const created = await driver.create(host, input);
      const instance = breakage.instance?.(created, host, input) ?? created;
      const breakSession = breakage.session;
      if (breakSession === undefined) return instance;
      return override(instance, { openSession: async (options: Parameters<Instance["openSession"]>[0]) => breakSession(await instance.openSession(options), host) });
    },
  });
}

/** The reference harness with its driver broken. */
export function brokenHarness(name: string, breakage: Breakage, config: Partial<ReferenceDriverConfig> = {}): ConformanceHarness<ReferenceDriverConfig> {
  const base = referenceHarness({ config, name });
  return {
    ...base,
    name,
    async setup(request) {
      const rig = await base.setup(request);
      return { ...rig, driver: breakDriver(rig.driver, breakage) };
    },
  };
}

/** The child-process harness (real files, the agent in a real process) with its driver broken. Call `cleanup` when done. */
export function brokenChildHarness(name: string, breakage: Breakage): ConformanceHarness<ReferenceDriverConfig> & { cleanup(): void } {
  const base = childProcessHarness();
  return {
    ...base,
    name,
    async setup(request) {
      const rig = await base.setup(request);
      return { ...rig, driver: breakDriver(rig.driver, breakage) };
    },
  };
}

/** The reference harness with some session members replaced. */
function brokenSession(name: string, overrides: (session: Session) => Partial<Session>): ConformanceHarness<ReferenceDriverConfig> {
  return brokenHarness(name, { session: (session) => override(session, overrides(session)) });
}

/** A session that refuses every new turn on a thread once a turn there ended with `status`, as if the ended turn were still running. */
function keepsEndedTurnActive(session: Session, status: string): Session {
  const busy = new Set<string>();
  const rewritten = rewriteEvents(session, (event, pass) => {
    const body = event.body;
    if (body.type === "turn.terminal" && body.status === status && event.threadId !== undefined) busy.add(event.threadId);
    pass();
  });
  return override(rewritten.session, {
    startTurn(input: Parameters<Session["startTurn"]>[0]) {
      if (input.intent === "start" && busy.has(input.threadId)) return Promise.reject(callErrors.invalidState("previous_turn_active"));
      return session.startTurn(input);
    },
  });
}

/** Runs one scenario against `harness` and returns its result. */
export async function runScenario(harness: ConformanceHarness<ReferenceDriverConfig>, scenario: number | string, timeoutMs = 1500) {
  const suite = createConformanceSuite(harness, { scenarios: [scenario], timeoutMs });
  const [only] = suite.order;
  if (only === undefined) throw new Error(`no scenario ${String(scenario)}`);
  return suite.run(only);
}

/** The broken variants, by the scenario each must fail, with the failure reason it must produce. */
export const BROKEN_VARIANTS: ReadonlyArray<{
  readonly scenario: number;
  readonly bug: string;
  readonly reason: RegExp;
  /** A harness with `cleanup` holds real files; the caller calls it when the scenario is done. */
  readonly harness: () => ConformanceHarness<ReferenceDriverConfig> & { cleanup?(): void };
}> = [
  {
    scenario: 1,
    bug: "streams a delta before the assistant message item opens",
    reason: /item\/opens-before-delta/,
    harness: () =>
      brokenHarness("delta before open", {
        session: (session) =>
          rewriteEvents(session, (event, pass) => {
            const body = event.body;
            if (body.type === "item.upsert" && body.item.kind === "assistant_message") pass({ type: "item.delta", itemId: body.item.id, field: "text", chunk: "early" });
            pass();
          }).session,
      }),
  },
  {
    scenario: 2,
    bug: "reports a completed turn as interrupted",
    reason: /status "interrupted" after the provider completed the turn/,
    harness: () =>
      brokenHarness("completion as interrupt", {
        session: (session) =>
          rewriteEvents(session, (event, pass) => {
            const body = event.body;
            pass(body.type === "turn.terminal" && body.status === "completed" ? { ...body, status: "interrupted" } : body);
          }).session,
      }),
  },
  {
    scenario: 2,
    bug: "settles the turn when the assistant message ends",
    reason: /settled turn .* when its assistant message ended, before the provider completed the turn/,
    harness: () =>
      brokenHarness("message end ends the turn", {
        session: (session) => {
          const settled = new Set<string>();
          const rewritten = rewriteEvents(session, (event, pass) => {
            const body = event.body;
            const turnId = body.type === "turn.terminal" ? body.turnId : event.turnId;
            if (turnId !== undefined && settled.has(turnId)) return;
            pass();
            if (turnId !== undefined && body.type === "item.upsert" && body.item.status === "completed" && body.item.text !== undefined && body.item.kind !== "user_message") {
              settled.add(turnId);
              rewritten.inject({ type: "turn.terminal", turnId, status: "completed", threadDisposition: "reusable" }, { threadId: event.threadId, turnId });
            }
          });
          return rewritten.session;
        },
      }),
  },
  {
    scenario: 2,
    bug: "reports a completed turn's thread as reusable but keeps the turn active, so the next prompt is refused",
    reason: /turn .* ended "completed" with threadDisposition "reusable", but the thread refused the next turn: invalid_state/,
    harness: () => brokenHarness("completed turn stays active", { session: (session) => keepsEndedTurnActive(session, "completed") }),
  },
  {
    scenario: 3,
    bug: "reports an interrupted turn's thread as reusable but keeps the turn active, so the next prompt is refused",
    reason: /turn .* ended "interrupted" with threadDisposition "reusable", but the thread refused the next turn: invalid_state/,
    harness: () => brokenHarness("interrupted turn stays active", { session: (session) => keepsEndedTurnActive(session, "interrupted") }),
  },
  {
    scenario: 4,
    bug: "reports a failed turn's thread as reusable but keeps the turn active, so the next prompt is refused",
    reason: /turn .* ended "failed" with threadDisposition "reusable", but the thread refused the next turn: invalid_state/,
    harness: () => brokenHarness("failed turn stays active", { session: (session) => keepsEndedTurnActive(session, "failed") }),
  },
  {
    scenario: 3,
    bug: "ends the turn locally on Stop without telling the agent",
    reason: /waiting for the native agent to be asked to stop the turn/,
    harness: () =>
      brokenHarness("stop never reaches the agent", {
        session: (session) => {
          const rewritten = rewriteEvents(session, (_event, pass) => pass());
          return override(rewritten.session, {
            async interruptTurn(input: { turnId: string }) {
              rewritten.inject({ type: "turn.terminal", turnId: input.turnId, status: "interrupted", threadDisposition: "reusable" }, { turnId: input.turnId });
            },
          });
        },
      }),
  },
  {
    scenario: 4,
    bug: "classifies a usage limit as a generic provider error",
    reason: /a usage limit was classified as "provider_error"/,
    harness: () =>
      brokenHarness("usage limit as provider error", {
        session: (session) =>
          rewriteEvents(session, (event, pass) => {
            const body = event.body;
            const failure = body.type === "turn.terminal" ? body.failure : body.type === "turn.upsert" ? body.turn.failure : undefined;
            if (failure?.class !== "usage_limit") {
              pass();
              return;
            }
            const generic = { class: "provider_error", message: failure.message, retryable: true };
            if (body.type === "turn.terminal") pass({ ...body, failure: generic });
            else if (body.type === "turn.upsert") pass({ ...body, turn: { ...body.turn, failure: generic } });
          }).session,
      }),
  },
  {
    scenario: 5,
    bug: "leaves the turn open when the agent process dies",
    reason: /timed out .* turn\.terminal .* after the native process exited/,
    harness: () =>
      brokenHarness("process exit leaves the turn open", {
        session: (session) =>
          rewriteEvents(session, (event, pass) => {
            const body = event.body;
            if (body.type === "turn.terminal" && body.failure?.class === "transport_error") return;
            pass();
          }).session,
      }),
  },
  {
    scenario: 6,
    bug: "settles a turn after 30 seconds without a frame (a quiet timer)",
    reason: /settled turn .* about 30\.\d s into a 36\.5 s pause after the tool result/,
    harness: () =>
      brokenHarness("30-second quiet timer", {
        session: (session) => {
          const timers = new Map<string, ReturnType<typeof setTimeout>>();
          const settledByTimer = new Set<string>();
          const rewritten = rewriteEvents(session, (event, pass) => {
            const body = event.body;
            const turnId = body.type === "turn.terminal" ? body.turnId : event.turnId;
            if (turnId !== undefined && settledByTimer.has(turnId)) return;
            pass();
            if (turnId === undefined) return;
            clearTimeout(timers.get(turnId));
            if (body.type === "turn.terminal") return;
            // An ordinary timer, re-armed on every event of the turn.
            timers.set(
              turnId,
              setTimeout(() => {
                settledByTimer.add(turnId);
                rewritten.inject({ type: "turn.terminal", turnId, status: "completed", threadDisposition: "reusable" }, { threadId: event.threadId, turnId });
              }, 30_000),
            );
          });
          return rewritten.session;
        },
      }),
  },
  {
    scenario: 6,
    bug: "settles a turn as soon as a tool result arrives",
    reason: /settled turn .* as soon as the tool result arrived, before the provider completed it/,
    harness: () =>
      brokenHarness("tool result ends the turn", {
        session: (session) => {
          const settled = new Set<string>();
          const rewritten = rewriteEvents(session, (event, pass) => {
            const body = event.body;
            const turnId = body.type === "turn.terminal" ? body.turnId : event.turnId;
            if (turnId !== undefined && settled.has(turnId)) return;
            pass();
            if (turnId !== undefined && body.type === "item.upsert" && body.item.status === "completed" && body.item.output !== undefined) {
              settled.add(turnId);
              rewritten.inject({ type: "turn.terminal", turnId, status: "completed", threadDisposition: "reusable" }, { threadId: event.threadId, turnId });
            }
          });
          return rewritten.session;
        },
      }),
  },
  {
    scenario: 6,
    bug: "settles a turn from one 30-second quiet timer it allocates when the session opens and refreshes on every event",
    reason: /settled turn .* about 30\.\d s into a 36\.5 s pause after the tool result/,
    harness: () =>
      brokenHarness("quiet timer from session open", {
        session: (session) => {
          let active: { turnId: string; threadId: string | undefined } | undefined;
          const settledByTimer = new Set<string>();
          // One ordinary Node timer for the whole session, allocated before any turn starts.
          const timer = setTimeout(() => {
            if (active === undefined) return;
            settledByTimer.add(active.turnId);
            rewritten.inject({ type: "turn.terminal", turnId: active.turnId, status: "completed", threadDisposition: "reusable" }, { threadId: active.threadId, turnId: active.turnId });
            active = undefined;
          }, 30_000);
          timer.unref();
          const rewritten = rewriteEvents(session, (event, pass) => {
            const body = event.body;
            const turnId = body.type === "turn.terminal" ? body.turnId : event.turnId;
            if (turnId !== undefined && settledByTimer.has(turnId)) return;
            pass();
            if (turnId === undefined) return;
            if (body.type === "turn.terminal") {
              if (active?.turnId === turnId) active = undefined;
              return;
            }
            active = { turnId, threadId: event.threadId };
            timer.refresh();
          });
          return override(rewritten.session, {
            async close() {
              clearTimeout(timer);
              await session.close();
            },
          });
        },
      }),
  },
  {
    scenario: 7,
    bug: "surfaces the provider's \"no active turn\" refusal of a steer as an error unless it already heard the turn end",
    reason: /a steer that raced the end of turn .* failed with protocol: .*; expected \{ status: "prompt_required" \}/,
    harness: () =>
      brokenHarness("steer refusal unmapped", {
        session: (session) => {
          const ended = new Set<string>();
          const rewritten = rewriteEvents(session, (event, pass) => {
            if (event.body.type === "turn.terminal") ended.add(event.body.turnId);
            pass();
          });
          return override(rewritten.session, {
            async startTurn(input: Parameters<Session["startTurn"]>[0]) {
              const result = await session.startTurn(input);
              // The driver maps the refusal only when its own state already says the turn ended.
              if (input.intent === "steer" && result.status === "prompt_required" && input.expectedTurnId !== undefined && !ended.has(input.expectedTurnId)) {
                throw callErrors.protocol("agent error -32021", `turn ${input.expectedTurnId} is not running`);
              }
              return result;
            },
          });
        },
      }),
  },
  {
    scenario: 7,
    bug: "starts a new, untracked turn when a steer arrives after the turn ended",
    reason: /a steer after turn .* ended returned .*"accepted"/,
    harness: () =>
      brokenHarness("late steer starts a turn", {
        session: (session) =>
          override(session, {
            startTurn: (input: Parameters<Session["startTurn"]>[0]) => {
              if (input.intent !== "steer") return session.startTurn(input);
              const { expectedTurnId: _expected, ...rest } = input;
              return session.startTurn({ ...rest, intent: "start", clientTurnKey: `${input.clientTurnKey}:as-start` });
            },
          }),
      }),
  },
  {
    scenario: 8,
    bug: "turns an approval with two accept_always options into a question",
    reason: /classified as a "user_input" request/,
    harness: () =>
      brokenHarness("duplicate always options as a question", {
        session: (session) =>
          rewriteEvents(session, (event, pass) => {
            const body = event.body;
            const options = body.type === "request.upsert" ? body.request.options : undefined;
            if (body.type === "request.upsert" && options !== undefined && options !== null && options.filter((option) => option.decision === "accept_always").length >= 2) {
              const { options: _options, ...request } = body.request;
              pass({
                ...body,
                request: {
                  ...request,
                  kind: "user_input",
                  questions: [{ id: "choice", type: "single_select", prompt: "How should the agent proceed?", options: options.map((option) => ({ id: option.optionId, label: option.label })) }],
                },
              });
              return;
            }
            pass();
          }).session,
      }),
  },
  {
    scenario: 8,
    bug: "keeps both accept_always options in the request but answers the provider with the first option of the chosen decision",
    reason: /the provider got option "allow-session"; the host chose "allow-prefix"/,
    harness: () =>
      brokenHarness("collapses options by decision", {
        session: (session) => {
          const options = new Map<string, ReadonlyArray<{ optionId: string; decision: string }>>();
          const rewritten = rewriteEvents(session, (event, pass) => {
            const body = event.body;
            if (body.type === "request.upsert" && body.request.options !== undefined && body.request.options !== null) options.set(body.request.id, body.request.options);
            pass();
          });
          return override(rewritten.session, {
            respond(input: Parameters<Session["respond"]>[0]) {
              const offered = options.get(input.requestId) ?? [];
              const chosen = offered.find((option) => option.optionId === input.optionId);
              const first = offered.find((option) => option.decision === chosen?.decision);
              return session.respond(first === undefined ? input : { ...input, optionId: first.optionId });
            },
          });
        },
      }),
  },
  {
    scenario: 9,
    bug: "answers a resume of a locked or missing native session with a placeholder thread that no native session backs",
    reason: /the replacement thread .* after resuming a locked native session could not run a turn/,
    harness: () =>
      brokenHarness("phantom fallback", {
        session: (session) => {
          const rewritten = rewriteEvents(session, (_event, pass) => pass());
          return override(rewritten.session, {
            async resumeThread(input: Parameters<Session["resumeThread"]>[0]) {
              const { policy, ...withoutPolicy } = input;
              try {
                // Without a policy the reference driver refuses to fall back, so locked and missing sessions throw here.
                return await session.resumeThread(withoutPolicy);
              } catch (error) {
                if (policy === undefined) throw error;
                const nativeId = "handle" in input.native ? input.native.handle : (input.native.id ?? "unknown");
                const placeholder = `${nativeId}-local-placeholder`;
                const thread: Thread = { id: `thread-${placeholder}`, native: { id: placeholder, strength: "strong" }, cwd: policy.cwd, status: "idle", handle: placeholder };
                rewritten.inject({ type: "session.replaced", previousNativeId: nativeId, reason: "The native session is gone.", contextLost: true }, { threadId: thread.id });
                rewritten.inject({ type: "thread.upsert", thread }, { threadId: thread.id });
                return thread;
              }
            },
          });
        },
      }),
  },
  {
    scenario: 9,
    bug: "answers a resume of an available native session with the thread it remembers, without loading the native session",
    reason: /the thread .* resumed from an available native session could not run a turn/,
    harness: () => {
      // Threads by native id, across every session of the instance.
      const remembered = new Map<string, Thread>();
      return brokenHarness("resume without loading", {
        session: (session) => {
          const rewritten = rewriteEvents(session, (event, pass) => {
            const body = event.body;
            if (body.type === "thread.upsert" && body.thread.native !== undefined && body.thread.native.id !== null && body.thread.cwd !== undefined) {
              remembered.set(body.thread.native.id, body.thread as Thread);
            }
            pass();
          });
          return override(rewritten.session, {
            async resumeThread(input: Parameters<Session["resumeThread"]>[0]) {
              const nativeId = "handle" in input.native ? input.native.handle : input.native.id;
              const known = nativeId === null ? undefined : remembered.get(nativeId);
              if (known === undefined || nativeId === null) return session.resumeThread(input);
              // Only the first resume takes the shortcut; later ones (a locked session) go to the driver.
              remembered.delete(nativeId);
              rewritten.inject({ type: "thread.upsert", thread: known }, { threadId: known.id });
              return known;
            },
          });
        },
      });
    },
  },
  {
    scenario: 9,
    bug: "swaps in a fresh native session silently when the old one is locked or missing",
    reason: /timed out .* session\.replaced after resuming a locked native session/,
    harness: () =>
      brokenHarness("silent session swap", {
        session: (session) =>
          rewriteEvents(session, (event, pass) => {
            if (event.body.type !== "session.replaced") pass();
          }).session,
      }),
  },
  {
    scenario: 10,
    bug: "treats a configured but unchecked credential as signed out",
    reason: /auth\.state\(\) reports "unauthenticated"; expected "configured"/,
    harness: () =>
      brokenHarness("configured blocks Send", {
        instance: (instance) => {
          const auth = instance.auth!;
          const state = async () => {
            const real = await auth.state();
            return real.status === "configured" ? { ...real, status: "unauthenticated" } : real;
          };
          return override(instance, {
            auth: override(auth, { state }),
            async openSession(options: Parameters<Instance["openSession"]>[0]) {
              if ((await state()).status === "unauthenticated") throw callErrors.authRequired(auth.methods());
              return instance.openSession(options);
            },
          });
        },
      }),
  },
  {
    scenario: 10,
    bug: "passes credentials from the instance's inherited environment to the agent",
    reason: /inherited credentials reached reference-agent: REFERENCE_AGENT_API_KEY/,
    harness: () =>
      brokenHarness("inherited credentials leak", {
        instance: (instance, host, input) => {
          // The broken driver copies the environment it was created with into every spawn.
          const spawn = host.process.spawn.bind(host.process);
          (host.process as { spawn: typeof spawn }).spawn = (request) => spawn({ ...request, env: { ...input.environment, ...request.env } });
          return instance;
        },
      }),
  },
  {
    scenario: 10,
    bug: "reports a managed profile's runtime auth poison under the ambient scope",
    reason: /the runtime auth poison names scope "ambient"; the failure was in scope "managed_profile"/,
    harness: () =>
      brokenHarness("poison in the wrong scope", {
        instance: (instance) => {
          const auth = instance.auth!;
          const rescoped = (state: AuthState): AuthState => (state.evidence === "runtime_poison" ? { ...state, scope: "ambient" } : state);
          return override(instance, {
            auth: override(auth, {
              state: async () => rescoped(await auth.state()),
              reportRuntimeFailure: async (failure: Parameters<NonNullable<typeof auth.reportRuntimeFailure>>[0]) => rescoped(await auth.reportRuntimeFailure!(failure)),
            }),
          });
        },
      }),
  },
  {
    scenario: 10,
    bug: "keeps a poisoned instance signed out after the poison's advertised expiry",
    reason: /after the runtime auth poison expired, auth\.state\(\) reports "unauthenticated" in scope "managed_profile"; before the failure it was "configured"/,
    harness: () =>
      brokenHarness("poison never lifts", {
        instance: (instance) => {
          const auth = instance.auth!;
          let poisoned = false;
          const state = async (): Promise<AuthState> => {
            const real = await auth.state();
            if (real.evidence === "runtime_poison") poisoned = true;
            if (!poisoned || real.evidence === "runtime_poison") return real;
            // The underlying poison expired, but the driver still says signed out.
            return { status: "unauthenticated", evidence: "passive", scope: real.scope };
          };
          return override(instance, {
            auth: override(auth, {
              state,
              reportRuntimeFailure: async (failure: Parameters<NonNullable<typeof auth.reportRuntimeFailure>>[0]) => {
                poisoned = true;
                return auth.reportRuntimeFailure!(failure);
              },
            }),
            async openSession(options: Parameters<Instance["openSession"]>[0]) {
              if ((await state()).status === "unauthenticated") throw callErrors.authRequired(auth.methods());
              return instance.openSession(options);
            },
          });
        },
      }),
  },
  {
    scenario: 11,
    bug: "ignores the requested working directory and runs every thread in one fixed directory",
    reason: /the thread created in \/workspace\/project reports cwd \/workspace\/other; the host asked for \/workspace\/project/,
    harness: () =>
      brokenSession("cwd ignored", (session) => ({
        createThread(input: Parameters<Session["createThread"]>[0]) {
          const fixed = "/workspace/other";
          return session.createThread({ ...input, cwd: fixed, policy: { ...input.policy, cwd: fixed } });
        },
      })),
  },
  {
    scenario: 11,
    bug: "reports the workspace path as given instead of the path the agent resolved",
    reason: /reports cwd \/workspace\/link-to-project; through the real path it reports \/workspace\/project/,
    harness: () =>
      brokenHarness("cwd as given", {
        session: (session) => {
          let given: string | undefined;
          const rewritten = rewriteEvents(session, (event, pass) => {
            const body = event.body;
            if (body.type === "thread.upsert" && body.thread.cwd !== undefined && given !== undefined) pass({ ...body, thread: { ...body.thread, cwd: given } });
            else pass();
          });
          return override(rewritten.session, {
            async createThread(input: Parameters<Session["createThread"]>[0]) {
              given = input.cwd;
              return { ...(await session.createThread(input)), cwd: input.cwd };
            },
          });
        },
      }),
  },
  {
    scenario: 12,
    bug: "caches a token from probe() in the secret store and takes a lease",
    reason: /probe\(\) made mutating host calls: secrets\.set/,
    harness: () =>
      brokenHarness("probe writes secrets", {
        instance: (instance, host) =>
          override(instance, {
            async probe(options?: Parameters<Instance["probe"]>[0]) {
              await host.secrets.set("reference", "probe-cache", new TextEncoder().encode("token"));
              await host.coordination.acquire("reference-probe", 1000);
              return instance.probe(options);
            },
          }),
      }),
  },
  {
    scenario: 12,
    bug: "opens a native session from probe(), which writes session files",
    reason: /probe\(\) wrote files under the instance's paths: \/instances\/.*\/state\/sessions\/session-1\.json/,
    harness: () =>
      brokenHarness("probe opens a session", {
        instance: (instance) =>
          override(instance, {
            async probe(options?: Parameters<Instance["probe"]>[0]) {
              const session = await instance.openSession({});
              await session.createThread({ cwd: "/workspace/project", policy: { mode: "approval_required", interaction: "default", cwd: "/workspace/project" } });
              await session.close();
              return instance.probe(options);
            },
          }),
      }),
  },
  {
    scenario: 12,
    bug: "writes a scratch file under the instance's tmpDir during probe() and deletes it before returning",
    reason: /probe\(\) wrote files under the instance's paths: .*\/tmp\/provider-probe\.json/,
    harness: () =>
      brokenChildHarness("probe scratch file", {
        instance: (instance, host) =>
          override(instance, {
            async probe(options?: Parameters<Instance["probe"]>[0]) {
              const scratch = path.join(host.paths.tmpDir, "provider-probe.json");
              fs.writeFileSync(scratch, "{}");
              fs.readFileSync(scratch, "utf8");
              fs.unlinkSync(scratch);
              return instance.probe(options);
            },
          }),
      }),
  },
  {
    scenario: 13,
    bug: "numbers replayed events from 1 again when reconnecting with fromSeq",
    reason: /events\(\{ fromSeq: \d+ \}\) gave .* where the live stream had/,
    harness: () =>
      brokenHarness("replay renumbers", {
        session: (session) =>
          override(session, {
            events(options?: { fromSeq?: number }) {
              const fromSeq = options?.fromSeq ?? 1;
              const source = session.events(options);
              return (async function* renumbered() {
                for await (const event of source) yield { ...event, seq: event.seq - fromSeq + 1 };
              })();
            },
          }),
      }),
  },
  {
    scenario: 14,
    bug: "declares readSnapshot off while still serving it",
    reason: /readSnapshot: the driver declares threads\.readSnapshot off, but the call returned/,
    harness: () =>
      brokenHarness("snapshot declared off", {
        session: (session) =>
          override(session, {
            capabilities(): Capabilities {
              const real = session.capabilities();
              return { ...real, threads: { ...real.threads, readSnapshot: false } };
            },
          }),
      }),
  },
  {
    scenario: 14,
    bug: "declares forks from an item on while rejecting them",
    reason: /forkThread fromItem: the driver declares threads\.fork\.fromItem on, but the call failed: unsupported/,
    harness: () =>
      brokenHarness("fork from item declared on", {
        session: (session) =>
          override(session, {
            capabilities(): Capabilities {
              const real = session.capabilities();
              return { ...real, threads: { ...real.threads, fork: { ...real.threads.fork, fromItem: true } } };
            },
          }),
      }),
  },
  {
    scenario: 14,
    bug: "declares forks into another directory but forks into the source thread's directory",
    reason: /forkThread crossCwd: the host asked for \/workspace\/other, and the fork reports cwd \/workspace\/project/,
    harness: () =>
      brokenSession("cross-directory fork stays put", (session) => ({
        capabilities(): Capabilities {
          const real = session.capabilities();
          return { ...real, threads: { ...real.threads, fork: { ...real.threads.fork, crossCwd: true } } };
        },
        forkThread(input: Parameters<NonNullable<Session["forkThread"]>>[0]) {
          const { cwd: _dropped, ...sameDirectory } = input;
          return session.forkThread!(sameDirectory);
        },
      })),
  },
  {
    scenario: 14,
    bug: "declares compaction and answers compactThread without compacting",
    reason: /compactThread: the native session holds 0 compactions after the call, as many as before: compaction had no effect/,
    harness: () => brokenSession("no-op compaction", () => ({ compactThread: async () => undefined })),
  },
  {
    scenario: 14,
    bug: "declares sessions.release but vetoes every release and rejects release() as unsupported",
    reason: /release: the driver declares sessions\.release on, but canRelease\(\) stayed false .* so release can never be exercised/,
    harness: () =>
      brokenSession("release never allowed", () => ({
        canRelease: () => false,
        release: () => Promise.reject(callErrors.unsupported("sessions.release")),
      })),
  },
  {
    scenario: 14,
    bug: "declares sessions.release and answers release() without parking anything",
    reason: /release: the native session behind thread .* is still loaded after release\(\)/,
    harness: () => brokenSession("no-op release", () => ({ release: async () => undefined })),
  },
  {
    scenario: 14,
    bug: "declares thread snapshots and returns a snapshot without the thread's turns",
    reason: /readSnapshot: the snapshot of thread .* lacks turns? .* that ran on it/,
    harness: () =>
      brokenSession("empty snapshot", (session) => ({
        readSnapshot: async (threadId: string) => ({ ...(await session.readSnapshot!(threadId)), turns: [], items: [] }),
      })),
  },
  {
    scenario: 14,
    bug: "declares forks and returns a well-formed thread that no native session backs",
    reason: /forkThread at latest: the fork .* could not run a turn: not_found/,
    harness: () => {
      let forks = 0;
      return brokenSession("phantom fork", (session) => ({
        forkThread: async (input: Parameters<NonNullable<Session["forkThread"]>>[0]): Promise<Thread> => {
          // Forks from an item or into another directory stay the driver's own.
          if (input.at.type === "item" || input.cwd !== undefined) return session.forkThread!(input);
          forks += 1;
          return { id: `thread-phantom-fork-${forks}`, native: { id: `phantom-fork-${forks}`, strength: "strong" }, cwd: input.cwd ?? "/workspace/project", status: "idle", forkedFrom: { threadId: input.threadId } };
        },
      }));
    },
  },
  {
    scenario: 14,
    bug: "declares forks from a turn but forks at the latest turn instead",
    reason: /forkThread fromTurn: the fork from turn .* holds 2 native turns, as many as the source thread, where that turn was the first of 2: the fork point was ignored/,
    harness: () =>
      brokenSession("fork point ignored", (session) => ({
        forkThread: (input: Parameters<NonNullable<Session["forkThread"]>>[0]) => session.forkThread!(input.at.type === "turn" ? { ...input, at: { type: "latest" } } : input),
      })),
  },
  {
    scenario: 14,
    bug: "declares rollback and returns an emptied snapshot without rolling back the native session",
    reason: /rollbackThread: the native session still holds 2 turns after a rollback to the start/,
    harness: () =>
      brokenSession("no-op rollback", (session) => ({
        rollbackThread: async (input: Parameters<NonNullable<Session["rollbackThread"]>>[0]) => ({ ...(await session.readSnapshot!(input.threadId)), turns: [], items: [] }),
      })),
  },
  {
    scenario: 14,
    bug: "declares history injection and reports it consumed without sending it to the agent",
    reason: /injectHistory: the native session received 0 of the 2 injected messages/,
    harness: () => brokenSession("no-op injection", () => ({ injectHistory: async () => ({ consumed: true }) })),
  },
  {
    scenario: 14,
    bug: "declares unloading and answers unloadThread without unloading the native session",
    reason: /unloadThread: the native session behind thread .* is still loaded after unloadThread/,
    harness: () => brokenSession("no-op unload", () => ({ unloadThread: async () => undefined })),
  },
  {
    scenario: 14,
    bug: "declares background.stop and answers stop without stopping the task",
    reason: /backgroundTasks\.stop: task .* still runs after stop/,
    harness: () => brokenSession("no-op background stop", (session) => ({ backgroundTasks: { ...session.backgroundTasks!, stop: async () => undefined } })),
  },
  {
    scenario: 14,
    bug: "declares background.await and matches no task",
    reason: /backgroundTasks\.await: matched \[\]; the host awaited the running task/,
    harness: () => brokenSession("await matches nothing", (session) => ({ backgroundTasks: { ...session.backgroundTasks!, await: async () => ({ matched: [] }) } })),
  },
  {
    scenario: 14,
    bug: "declares subagents.stop and reports a subagent stopped without stopping it",
    reason: /waiting for subagent .* to stop after stopSubagent/,
    harness: () => brokenSession("no-op subagent stop", () => ({ stopSubagent: async () => ({ status: "cancelled" }) })),
  },
  {
    scenario: 14,
    bug: "declares context window reporting and reports no window for a catalog model",
    reason: /contextWindow: the catalog gives reference-small a context window of 128000, but contextWindow\("reference-small"\) returned undefined/,
    harness: () => brokenSession("no context window", () => ({ contextWindow: () => undefined })),
  },
  {
    scenario: 14,
    bug: "declares context-usage reuse and refuses it even between the same model",
    reason: /canReuseContextUsage\("reference-small", "reference-small"\) returned false: usage from a model always applies to the same model/,
    harness: () => brokenSession("never reuses usage", () => ({ canReuseContextUsage: () => false })),
  },
  {
    scenario: 14,
    bug: "declares MCP apps and lists no tools for a server that serves one",
    reason: /mcpApps\.listTools: the tools of reference-tools \[\] lack the tool "echo"/,
    harness: () => brokenSession("no MCP tools", (session) => ({ mcpApps: { ...session.mcpApps!, listTools: async () => [] } })),
  },
  {
    scenario: 15,
    bug: "caches responses by responseKey alone, so a second request answered with the same key never reaches the agent",
    reason: /waiting for the native agent to get the reply to a second request answered with the same responseKey/,
    harness: () =>
      brokenSession("responses keyed by responseKey only", (session) => {
        const receipts = new Map<string, ReturnType<Session["respond"]>>();
        return {
          respond(input: Parameters<Session["respond"]>[0]) {
            const prior = receipts.get(input.responseKey);
            if (prior !== undefined) return prior;
            const receipt = session.respond(input);
            receipts.set(input.responseKey, receipt);
            return receipt;
          },
        };
      }),
  },
  {
    scenario: 15,
    bug: "sends every response to the agent, so a repeated responseKey answers twice",
    reason: /responses with the same \(requestId, responseKey\) had different outcomes: .*rejected invalid_state/,
    harness: () => {
      let attempt = 0;
      return brokenHarness("responses not idempotent", {
        session: (session) =>
          override(session, {
            respond(input: Parameters<Session["respond"]>[0]) {
              attempt += 1;
              return session.respond({ ...input, responseKey: `${input.responseKey}#${attempt}` });
            },
          }),
      });
    },
  },
  {
    scenario: 15,
    bug: "reports an \"always\" option as reaching only once, so the host's full_access auto-reply widens",
    reason: /the narrowest accepting option is "approve-always"; the provider's narrowest is "approve-once"/,
    harness: () =>
      brokenHarness(
        "always mislabelled as once",
        {
          session: (session) =>
            rewriteEvents(session, (event, pass) => {
              const body = event.body;
              if (body.type === "request.upsert" && body.request.options !== undefined && body.request.options !== null) {
                pass({ ...body, request: { ...body.request, options: body.request.options.map((option) => (option.decision === "accept_always" ? { ...option, scope: "once" } : option)) } });
                return;
              }
              pass();
            }).session,
        },
        { fullAccessReplies: "host" },
      ),
  },
];
