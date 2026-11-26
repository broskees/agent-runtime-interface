// The six scenarios every native recorder records and every replay test
// replays, for every driver: their prompts, runtime policy, what the host
// does, and what the ARI events must show. Recorders and replay tests take
// their prompts from here and hold none of their own.
//
// Prompts are short, harmless and deterministic in intent. The approval
// scenarios ask for one shell command that prints a marker string; the
// command builds the marker with printf, so the command text itself never
// holds the marker and only the command's output can.
//
// `runScenario` plays a scenario against any driver's ARI Session, with the
// host's actions, and checks every event against EventGrammar in strict
// mode. `checkScenario` asserts what the scenario promises, given the
// approval answers the driver's kit read off the native frames.

import assert from "node:assert/strict";
import { EventGrammar } from "../../src/host/event-grammar.ts";
import { reduceEvents } from "../../src/host/reducer.ts";
import type { AriEvent } from "../../src/generated/events.ts";
import type { Item, ItemKind } from "../../src/generated/item.ts";
import type { Request } from "../../src/generated/request.ts";
import type { RuntimePolicy } from "../../src/generated/config.ts";
import type { Session } from "../../src/runtime.ts";

export const SCENARIO_NAMES = ["simple", "multi_turn", "approval_allowed", "approval_denied", "interrupt", "resume"] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** What the host does while a scenario runs. */
export interface HostActions {
  /**
   * How the host answers each request: the once-only accept option, or the
   * decline option. An agent that offers no plain decline, only a decline
   * that also stops the turn (Codex's ordinary command approval offers
   * `accept` and `cancel`), gets that one.
   */
  readonly answer: "allow_once" | "decline";
  /** Calls `interruptTurn` once, as soon as the turn's first assistant text arrives. */
  readonly interruptAfterFirstText: boolean;
  /** Before this turn (an index into `prompts`), the host closes the session and resumes the thread by its native handle in a new one. */
  readonly resumeBeforeTurn?: number;
}

export interface Scenario {
  readonly name: ScenarioName;
  readonly summary: string;
  /** One prompt per turn, in order, all on one thread. */
  readonly prompts: readonly string[];
  /** The runtime policy's mode and interaction; the runner adds the workspace as `cwd`. */
  readonly policy: Pick<RuntimePolicy, "mode" | "interaction">;
  readonly host: HostActions;
  /** The word the first prompt gives and a later turn must repeat. */
  readonly word?: string;
  /** The string the approval command prints. */
  readonly marker?: string;
  /** The shell command the approval scenarios ask for. */
  readonly command?: string;
}

/** An approval answer as it reached the native side, read off the recorded outbound frames by the driver's kit. */
export interface NativeAnswer {
  /** `cancel` is a decline that also stops the turn. */
  readonly decision: "accept" | "decline" | "cancel";
  /** `once` for an answer that grants nothing beyond this one call. */
  readonly scope?: "once";
  /** The recording line of the frame that carried it, when known. */
  readonly line?: number;
}

const POLICY = { mode: "approval_required", interaction: "default" } as const;

function approvalCommand(marker: string): string {
  const [prefix, ...rest] = marker.split("-");
  return `printf '${prefix}-%s\\n' '${rest.join("-")}' | tee ari-marker.txt`;
}

const ALLOWED_MARKER = "ari-marker-allowed-7d3f";
const DENIED_MARKER = "ari-marker-denied-91c2";

function approvalPrompt(command: string): string {
  return `Run this exact shell command once with your Bash tool, in the current directory: ${command}\nIf the command is refused, do not try anything else. Then reply with exactly the word: done`;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "simple",
    summary: "one turn that answers with one word",
    prompts: ["Reply with exactly the word: ok"],
    policy: POLICY,
    host: { answer: "decline", interruptAfterFirstText: false },
  },
  {
    name: "multi_turn",
    summary: "two turns on one thread; the second repeats a word the first gave",
    prompts: ["Remember this word for later: marmalade. Reply with exactly the word: ok", "Which word did I ask you to remember? Reply with exactly that word and nothing else."],
    policy: POLICY,
    host: { answer: "decline", interruptAfterFirstText: false },
    word: "marmalade",
  },
  {
    name: "approval_allowed",
    summary: "a shell command the host allows once",
    prompts: [approvalPrompt(approvalCommand(ALLOWED_MARKER))],
    policy: POLICY,
    host: { answer: "allow_once", interruptAfterFirstText: false },
    marker: ALLOWED_MARKER,
    command: approvalCommand(ALLOWED_MARKER),
  },
  {
    name: "approval_denied",
    summary: "a shell command the host declines",
    prompts: [approvalPrompt(approvalCommand(DENIED_MARKER))],
    policy: POLICY,
    host: { answer: "decline", interruptAfterFirstText: false },
    marker: DENIED_MARKER,
    command: approvalCommand(DENIED_MARKER),
  },
  {
    name: "interrupt",
    summary: "a long answer the host interrupts after its first text",
    prompts: ["Count from 1 to 300, one number per line, with no other text."],
    policy: POLICY,
    host: { answer: "decline", interruptAfterFirstText: true },
  },
  {
    name: "resume",
    summary: "one turn, then the session closes and a new session resumes the thread for a second turn",
    prompts: ["Remember this word for later: lighthouse. Reply with exactly the word: ok", "Which word did I ask you to remember? Reply with exactly that word and nothing else."],
    policy: POLICY,
    host: { answer: "decline", interruptAfterFirstText: false, resumeBeforeTurn: 1 },
    word: "lighthouse",
  },
];

export function scenarioNamed(name: string): Scenario {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  if (scenario === undefined) throw new Error(`no scenario is named ${JSON.stringify(name)}; the scenarios are ${SCENARIO_NAMES.join(", ")}`);
  return scenario;
}

// Running a scenario.

/** What the native side looks like to the runner: a replay reports drift and where it stands. */
export interface NativeProgress {
  /** The native side's first failure (a replay drift), if any. */
  failure(): Error | undefined;
  /** Where the native side stands, for a report that the scenario waited too long. */
  describe(what: string): string;
  /** Calls `listener` whenever the native side moves on; returns a function that removes it. */
  onChange(listener: () => void): () => void;
}

export interface ScenarioHost {
  /** Opens a fresh Session on the instance the scenario runs on. Called once, and once more before a resumed turn. */
  openSession(): Promise<Session>;
  /** The workspace the thread runs in. */
  readonly cwd: string;
  /** How long the runner waits for any one thing before it reports a stall. */
  readonly timeoutMs: number;
  readonly native?: NativeProgress;
}

export interface HostRequest {
  readonly request: Request;
  /** The option the host answered with, if it answered. */
  readonly optionId?: string;
}

export interface ScenarioRun {
  readonly scenario: Scenario;
  readonly threadId: string;
  /** Each turn the host started, in order. */
  readonly turnIds: readonly string[];
  /** The session each of those turns ran in. A resumed session replays earlier turns as events of its own, which are not the host's turns. */
  readonly turnSessions: readonly string[];
  /** Every event of every session the scenario opened, in the order they came. */
  readonly events: readonly AriEvent[];
  readonly sessionIds: readonly string[];
  /** Every request that reached the host, with the host's answer. */
  readonly requests: readonly HostRequest[];
  /** The turn the host interrupted and the seq of the assistant text event it waited for. */
  readonly interrupted?: { readonly turnId: string; readonly afterSeq: number };
  /** The handle the resumed session named the thread by. */
  readonly resumedHandle?: string;
}

/** The scenario waited too long for something while the native side reported no failure. */
export class ScenarioStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioStallError";
  }
}

class Watch {
  readonly #listeners = new Set<() => void>();
  add(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

const TEXT_ITEM_KINDS: ReadonlySet<ItemKind> = new Set(["assistant_message"]);

/** Plays `scenario` as the host: starts its turns, answers requests, interrupts or resumes as it says. */
export async function runScenario(scenario: Scenario, host: ScenarioHost): Promise<ScenarioRun> {
  const grammar = new EventGrammar({ mode: "strict" });
  const watch = new Watch();
  const events: AriEvent[] = [];
  const sessionIds: string[] = [];
  const requests = new Map<string, { request: Request; optionId?: string }>();
  const itemKinds = new Map<string, ItemKind>();
  const turnIds: string[] = [];
  const turnSessions: string[] = [];
  const pending: Array<Promise<unknown>> = [];
  let failure: Error | undefined;
  let interrupted: { turnId: string; afterSeq: number } | undefined;
  let session: Session;
  const fail = (error: unknown): void => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    watch.notify();
  };
  const removeNative = host.native?.onChange(() => watch.notify());

  const act = (current: Session, event: AriEvent): void => {
    const body = event.body;
    if (body.type === "item.upsert" && body.item.kind !== undefined) itemKinds.set(body.item.id, body.item.kind);
    if (body.type === "request.upsert" && body.request.status === "pending" && body.request.kind !== undefined && !requests.has(body.request.id)) {
      const request = body.request as Request;
      const options = request.options ?? [];
      const option =
        scenario.host.answer === "allow_once"
          ? options.find((each) => each.decision === "accept" && (each.scope === undefined || each.scope === "once"))
          : (options.find((each) => each.decision === "decline") ?? options.find((each) => each.decision === "cancel"));
      requests.set(request.id, { request, ...(option === undefined ? {} : { optionId: option.optionId }) });
      if (option === undefined) {
        fail(new Error(`request ${request.id} (${request.kind}) offers no ${scenario.host.answer === "allow_once" ? "allow_once" : "decline or cancel"} option: ${JSON.stringify(options)}`));
        return;
      }
      pending.push(current.respond({ requestId: request.id, responseKey: `${scenario.name}-host-${requests.size}`, optionId: option.optionId }).catch(fail));
    }
    interruptOnText(current, event);
  };

  /** True for an event that carries assistant text. */
  const isAssistantText = (event: AriEvent): boolean => {
    const body = event.body;
    return (
      (body.type === "item.delta" && body.field === "text" && TEXT_ITEM_KINDS.has(itemKinds.get(body.itemId) ?? "error") && body.chunk !== "") ||
      (body.type === "item.upsert" && TEXT_ITEM_KINDS.has(body.item.kind ?? itemKinds.get(body.item.id) ?? "error") && typeof body.item.text === "string" && body.item.text !== "")
    );
  };

  /**
   * Interrupts the host's latest turn once, at its first assistant text. The
   * driver may admit a turn and stream its text before startTurn resolves, so
   * this runs for each event as it comes and again, over the session's events
   * so far, as soon as startTurn names the turn.
   */
  const interruptOnText = (current: Session, event: AriEvent): void => {
    if (!scenario.host.interruptAfterFirstText || interrupted !== undefined) return;
    const turnId = turnIds[turnIds.length - 1];
    if (turnId === undefined || event.turnId !== turnId || event.sessionId !== current.id || !isAssistantText(event)) return;
    interrupted = { turnId, afterSeq: event.seq };
    pending.push(current.interruptTurn({ turnId }).catch(fail));
  };

  const watchSession = (current: Session): Promise<void> => {
    sessionIds.push(current.id);
    return (async () => {
      try {
        for await (const event of current.events()) {
          grammar.observe(event);
          events.push(event);
          act(current, event);
          watch.notify();
        }
      } catch (error) {
        fail(error);
      }
    })();
  };

  const waitFor = <T>(check: () => T | undefined, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        remove();
        action();
      };
      const test = (): void => {
        const nativeFailure = host.native?.failure();
        if (nativeFailure !== undefined) return finish(() => reject(nativeFailure));
        if (failure !== undefined) {
          const error = failure;
          return finish(() => reject(error));
        }
        let value: T | undefined;
        try {
          value = check();
        } catch (error) {
          return finish(() => reject(error));
        }
        if (value === undefined) return;
        const found = value;
        finish(() => resolve(found));
      };
      const timer = setTimeout(() => {
        test();
        if (settled) return;
        const message = host.native === undefined ? `${scenario.name}: waited ${host.timeoutMs} ms for ${what}` : host.native.describe(`the ${scenario.name} scenario waited ${host.timeoutMs} ms for ${what}`);
        finish(() => reject(new ScenarioStallError(message)));
      }, host.timeoutMs);
      const remove = watch.add(test);
      test();
    });

  const terminalOf = (turnId: string, sessionId: string): Promise<AriEvent> =>
    waitFor(() => events.find((event) => event.sessionId === sessionId && event.body.type === "turn.terminal" && event.body.turnId === turnId), `turn.terminal of turn ${turnId}`);

  // Calls into the driver race the waiters, so a stall inside one is reported too.
  const call = <T>(promise: Promise<T>, what: string): Promise<T> => {
    let value: { v: T } | undefined;
    let error: { e: unknown } | undefined;
    promise.then(
      (result) => {
        value = { v: result };
        watch.notify();
      },
      (reason) => {
        error = { e: reason };
        watch.notify();
      },
    );
    return waitFor(() => {
      if (error !== undefined) throw error.e;
      return value;
    }, what).then((wrapped) => wrapped.v);
  };

  const policy: RuntimePolicy = { ...scenario.policy, cwd: host.cwd };
  session = await call(host.openSession(), "the first session to open");
  let watching = watchSession(session);
  let resumedHandle: string | undefined;
  try {
    const thread = await call(session.createThread({ cwd: host.cwd, policy }), "createThread");
    let threadId = thread.id;
    for (const [index, prompt] of scenario.prompts.entries()) {
      if (scenario.host.resumeBeforeTurn === index) {
        const handle = thread.handle ?? thread.native.id;
        if (handle === undefined || handle === null) throw new Error(`thread ${thread.id} has no native handle to resume by`);
        await call(session.close(), "the first session to close");
        await watching;
        session = await call(host.openSession(), "the second session to open");
        watching = watchSession(session);
        resumedHandle = handle;
        const resumed = await call(session.resumeThread({ native: { handle }, policy }), "resumeThread");
        threadId = resumed.id;
      }
      const started = await call(session.startTurn({ threadId, clientTurnKey: `${scenario.name}-turn-${index + 1}`, intent: "start", content: [{ type: "text", text: prompt }] }), `startTurn of turn ${index + 1}`);
      if (started.status !== "accepted") throw new Error(`startTurn of turn ${index + 1} answered ${JSON.stringify(started)}`);
      turnIds.push(started.turnId);
      turnSessions.push(session.id);
      // Text of this turn that came before startTurn resolved counts too.
      for (const event of [...events]) interruptOnText(session, event);
      watch.notify();
      await terminalOf(started.turnId, session.id);
    }
    // The host's answers and interrupt race the waiters too: a call the native side never answers is a stall, not a hang.
    await call(Promise.all(pending), "the host's answers and interrupt to settle");
    await call(session.close(), "the session to close");
    await watching;
    if (failure !== undefined) throw failure;
    return {
      scenario,
      threadId,
      turnIds,
      turnSessions,
      events,
      sessionIds,
      requests: [...requests.values()],
      ...(interrupted === undefined ? {} : { interrupted }),
      ...(resumedHandle === undefined ? {} : { resumedHandle }),
    };
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  } finally {
    removeNative?.();
  }
}

// Checking a scenario.

type Body<T extends AriEvent["body"]["type"]> = Extract<AriEvent["body"], { type: T }>;

/** One item as a host holds it once the run is over, with the session and turn it belongs to. */
export interface SettledItem {
  readonly item: Item;
  readonly sessionId: string;
  readonly turnId: string | undefined;
}

/**
 * Every item of the run as the ARI reducer (`reduceEvents` of ari/host) builds
 * it from each session's events: upserts applied in order and each
 * `item.delta` appended while its item is open, so the checks see exactly
 * what a host shows. An item's turn is its own `turnId`, else the turn its
 * events' envelopes name.
 */
export function settledItems(events: readonly AriEvent[]): SettledItem[] {
  const sessions = new Map<string, AriEvent[]>();
  for (const event of events) {
    const own = sessions.get(event.sessionId) ?? [];
    own.push(event);
    sessions.set(event.sessionId, own);
  }
  const settled: SettledItem[] = [];
  for (const [sessionId, own] of sessions) {
    const envelopeTurns = new Map<string, string>();
    for (const event of own) {
      const itemId = event.body.type === "item.upsert" ? event.body.item.id : event.body.type === "item.delta" ? event.body.itemId : undefined;
      if (itemId !== undefined && event.turnId !== undefined && !envelopeTurns.has(itemId)) envelopeTurns.set(itemId, event.turnId);
    }
    for (const item of reduceEvents(own).items.values()) settled.push({ item, sessionId, turnId: item.turnId ?? envelopeTurns.get(item.id) });
  }
  return settled;
}

const TOOL_ITEM_KINDS: ReadonlySet<string> = new Set(["command_execution", "tool_call", "mcp_tool_call", "dynamic_tool_call"]);

function terminals(run: ScenarioRun): Array<Body<"turn.terminal">> {
  return run.events.flatMap((event) => (event.body.type === "turn.terminal" ? [event.body] : []));
}

/** The turn.terminal events of the host's own turns, each from the session the turn ran in, in the order they came. */
function hostTerminals(run: ScenarioRun): AriEvent[] {
  return run.events.filter((event) => {
    const body = event.body;
    return body.type === "turn.terminal" && run.turnIds.some((turnId, index) => turnId === body.turnId && run.turnSessions[index] === event.sessionId);
  });
}

/** The items of one host turn, as the reducer built them in the session the turn ran in. */
function turnItems(run: ScenarioRun, index: number): Item[] {
  const turnId = run.turnIds[index];
  const sessionId = run.turnSessions[index];
  return settledItems(run.events)
    .filter((entry) => entry.turnId === turnId && entry.sessionId === sessionId)
    .map((entry) => entry.item);
}

/** The settled assistant messages of one host turn, with their text. */
function assistantTexts(run: ScenarioRun, index: number): string[] {
  return turnItems(run, index)
    .filter((item) => item.kind === "assistant_message" && item.status === "completed")
    .map((item) => item.text ?? "");
}

function requestsOfKind(run: ScenarioRun, kind: string): HostRequest[] {
  return run.requests.filter((entry) => entry.request.kind === kind);
}

function toolOutput(item: Item): string {
  return item.output ?? "";
}

/** What a scenario check looks at: the host's turns, by their index in the scenario's prompts, and any items of them. */
export interface CheckSubject {
  readonly turns: readonly number[];
  readonly items?: readonly Item[];
}

/**
 * A scenario check that failed, with what it looked at: a replay names the
 * recorded frames the outcome depended on from it (an item's native id, a
 * turn's own frames).
 */
export class ScenarioCheckError extends Error {
  readonly turns: readonly number[];
  readonly items: readonly Item[];
  constructor(failed: Error, subject: CheckSubject) {
    super(failed.message, { cause: failed });
    this.name = "ScenarioCheckError";
    this.turns = subject.turns;
    this.items = subject.items ?? [];
  }
}

/** Runs `check`, which looks at `subject`; a failure carries it. */
function about(subject: CheckSubject, check: () => void): void {
  try {
    check();
  } catch (error) {
    throw error instanceof Error ? new ScenarioCheckError(error, subject) : error;
  }
}

/** The assistant messages of one host turn, settled or not. */
function assistantMessages(run: ScenarioRun, index: number): Item[] {
  return turnItems(run, index).filter((item) => item.kind === "assistant_message");
}

/**
 * Asserts what the scenario promises. `native` is what reached the native
 * side, from the driver's kit. Every failed check throws a
 * ScenarioCheckError holding what it looked at: the turns, by their index in
 * the scenario's prompts, and the items of them it looked at.
 */
export function checkScenario(run: ScenarioRun, native: readonly NativeAnswer[]): void {
  const scenario = run.scenario;
  const where = `scenario ${scenario.name}`;
  const ends = terminals(run);
  const [firstTurn] = run.turnIds;
  const everyTurn = { turns: scenario.prompts.map((_prompt, index) => index) };
  const firstOnly = { turns: [0] };
  about(everyTurn, () => assert.equal(run.turnIds.length, scenario.prompts.length, `${where}: the host started one turn per prompt`));
  switch (scenario.name) {
    case "simple": {
      about(firstOnly, () => {
        assert.equal(ends.length, 1, `${where}: exactly one turn.terminal`);
        assert.equal(ends[0]!.status, "completed", `${where}: the turn completed`);
      });
      about({ turns: [0], items: assistantMessages(run, 0) }, () => assert.ok(assistantTexts(run, 0).some((text) => text.trim() !== ""), `${where}: a settled assistant message with non-empty text`));
      return;
    }
    case "multi_turn":
    case "resume": {
      const own = hostTerminals(run);
      about(everyTurn, () => {
        if (scenario.name === "multi_turn") assert.equal(ends.length, 2, `${where}: two turn.terminal events`);
        assert.deepEqual(
          own.map((event) => (event.body as Body<"turn.terminal">).turnId),
          run.turnIds,
          `${where}: each turn ended once, in the order they started`,
        );
        assert.deepEqual(
          own.map((event) => (event.body as Body<"turn.terminal">).status),
          ["completed", "completed"],
          `${where}: both turns completed`,
        );
        assert.deepEqual([...new Set(own.map((event) => event.threadId))], [run.threadId], `${where}: both turns ran on one thread`);
      });
      const second = assistantTexts(run, 1).join("\n");
      about({ turns: [1], items: assistantMessages(run, 1) }, () => assert.ok(second.toLowerCase().includes(scenario.word!), `${where}: the second turn's text ${JSON.stringify(second)} contains ${JSON.stringify(scenario.word)}`));
      if (scenario.name === "resume") {
        // The second session, the handle it resumed by, and the second turn in it: the second turn's frames, which follow the resume.
        about({ turns: [1] }, () => {
          assert.equal(run.sessionIds.length, 2, `${where}: the thread was resumed in a second session`);
          assert.equal(run.turnSessions[1], run.sessionIds[1], `${where}: the second turn ran in the second session`);
          assert.ok(run.resumedHandle !== undefined && run.resumedHandle !== "", `${where}: the second session resumed the thread by its native handle`);
        });
        about(everyTurn, () => {
          const firstEnd = run.events.indexOf(own[0]!);
          const secondSession = run.events.findIndex((event) => event.sessionId === run.sessionIds[1]);
          assert.ok(firstEnd !== -1 && secondSession > firstEnd, `${where}: the first turn completed before the second session opened`);
          assert.equal(run.events.filter((event) => event.body.type === "session.replaced").length, 0, `${where}: no session.replaced`);
        });
      }
      return;
    }
    case "approval_allowed":
    case "approval_denied": {
      const allowed = scenario.name === "approval_allowed";
      const commands = requestsOfKind(run, "command");
      const tools = turnItems(run, 0).filter((item) => TOOL_ITEM_KINDS.has(item.kind));
      about({ turns: [0], items: tools }, () => {
        assert.ok(commands.length > 0, `${where}: a request of kind command reached the host (requests: ${JSON.stringify(run.requests.map((entry) => entry.request.kind))})`);
        assert.ok(commands.every((entry) => entry.optionId !== undefined), `${where}: the host answered every command request`);
        // A cancel is a decline that also stops the turn: the host's decline where the agent offered no plain one.
        const answer = allowed ? native.find((entry) => entry.decision === "accept" && entry.scope === "once") : native.find((entry) => entry.decision === "decline" || entry.decision === "cancel");
        assert.ok(answer !== undefined, `${where}: the host's ${allowed ? "allow-once" : "decline"} answer reached the native side as a recorded outbound frame (native answers: ${JSON.stringify(native)})`);
      });
      about(firstOnly, () => assert.equal(ends.length, 1, `${where}: the turn reached a terminal`));
      if (allowed) {
        // The command ran: what it printed, the marker, reached the host.
        about({ turns: [0], items: tools }, () =>
          assert.ok(
            tools.some((item) => item.status === "completed" && toolOutput(item).includes(scenario.marker!)),
            `${where}: a command or tool item completed with the marker in its output (items: ${JSON.stringify(tools.map((item) => [item.kind, item.status, toolOutput(item)]))})`,
          ),
        );
        about(firstOnly, () => assert.equal(ends[0]!.status, "completed", `${where}: the turn completed`));
      } else {
        const shown = (items: readonly Item[]): string => JSON.stringify(items.map((item) => [item.kind, item.status, toolOutput(item)]));
        const leaked = tools.filter((item) => item.status === "completed" && toolOutput(item).includes(scenario.marker!));
        about({ turns: [0], items: leaked }, () => assert.ok(leaked.length === 0, `${where}: no completed command or tool item's output holds the marker (items: ${shown(leaked)})`));
        // The host declined every command, so none ran.
        const ran = tools.filter((item) => item.kind === "command_execution" && item.status === "completed");
        about({ turns: [0], items: ran }, () => assert.ok(ran.length === 0, `${where}: no command item completed (items: ${shown(ran)})`));
      }
      return;
    }
    case "interrupt": {
      about(firstOnly, () => {
        assert.ok(run.interrupted !== undefined && run.interrupted.turnId === firstTurn, `${where}: the host interrupted the turn after its first assistant text`);
        assert.equal(ends.length, 1, `${where}: exactly one turn.terminal`);
        assert.equal(ends[0]!.status, "interrupted", `${where}: the turn ended interrupted`);
        const end = run.events.find((event) => event.body.type === "turn.terminal")!;
        assert.ok(end.seq > run.interrupted!.afterSeq, `${where}: the turn ended after the text the host waited for`);
      });
      return;
    }
  }
}
