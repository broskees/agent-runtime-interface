// Deliberately broken variants of the reference driver, one per conformance
// scenario (two where a scenario guards two separate rules). Each one wraps
// the honest reference driver and adds exactly the bug its scenario exists to
// catch, the way production drivers have broken: a quiet timer that settles
// turns, a steer that silently starts a new turn, a resume that swaps native
// sessions without saying so, and so on. test/conformance/broken.test.ts runs
// each against its scenario and asserts the scenario fails for that reason.

import { createConformanceSuite, referenceHarness } from "../../src/conformance/index.ts";
import type { ConformanceHarness, ReferenceDriverConfig } from "../../src/conformance/index.ts";
import { EventSequencer } from "../../src/driver-kit/index.ts";
import { callErrors } from "../../src/index.ts";
import type { AriEvent, AriEventBody, Capabilities, Driver, HostServices, Instance, Session } from "../../src/index.ts";

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
  readonly harness: () => ConformanceHarness<ReferenceDriverConfig>;
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
