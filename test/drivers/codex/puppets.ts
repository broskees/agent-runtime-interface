// Scenario scripts (puppets) for the fake Codex app-server
// (./fake-app-server.ts) run as `codex app-server` by the fake `codex`
// (./fake-codex-cli.ts): each plays one turn the way Codex would play one of
// the six recording scenarios, so the Codex recorder can be proven end to end
// without the real Codex. A puppet tells the scenario by the turn's prompt and
// answers from the thread's history, as a model answers from its context: the
// word a later turn repeats is the one an earlier prompt of the thread gave.
// Prompts, words, markers and commands come from the scenario module.
//
// The approval scenarios ask one command approval the way pinned Codex asks
// for an ordinary command: `accept` and `cancel` (protocol/src/approvals.rs:
// 379–411). The command item then completes with its output, or, when the
// host cancelled, completes `declined` and the turn aborts: a `cancel` is
// ReviewDecision::Abort (app-server/src/bespoke_event_handling.rs:2137–2140).

import type { ThreadItem } from "../../../src/drivers/codex/generated/protocol.ts";
import { SCENARIOS } from "../../recordings/scenarios.ts";
import type { Scenario } from "../../recordings/scenarios.ts";
import type { CodexNativeTurn, FakeCodexWorld } from "./fake-app-server.ts";

export interface CodexPuppetOptions {
  /** Text added to every reply: what the fake loaded of the user's Codex setup, if anything. */
  readonly extraText?: string;
  /** What the approval command prints; the scenario's marker when left out. */
  readonly commandOutput?: string;
  /** The answer of the simple scenario; `ok` when left out. */
  readonly reply?: string;
  /** Notifications the app-server sends first in every turn, as they are (a `threadId` or `turnId` of null becomes the turn's): a test plants values the sanitiser must replace. */
  readonly planted?: ReadonlyArray<{ readonly method: string; readonly params: { readonly [key: string]: unknown } }>;
}

const REMEMBER = /remember this word for later: ([a-z]+)/i;

/** The scenario whose prompts hold this one. The second prompts of multi_turn and resume are the same; either plays it the same way. */
export function scenarioOf(prompt: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.prompts.some((each) => prompt.endsWith(each)));
}

/** Reports a command item the way Codex does: started, its output, completed (or declined, with no output). */
function commandItem(world: FakeCodexWorld, turn: CodexNativeTurn, itemId: string, command: string, outcome: { readonly output: string } | "declined"): void {
  const live = world.turn(turn.nativeTurnId);
  if (live === undefined) throw new Error(`turn ${turn.nativeTurnId} is no longer running`);
  const server = live.server;
  const cwd = server.thread(turn.nativeThreadId).cwd;
  const started: ThreadItem = { type: "commandExecution", id: itemId, command, commandActions: [{ type: "unknown", command }], cwd, status: "inProgress", source: "agent" };
  server.notify("item/started", { threadId: turn.nativeThreadId, turnId: turn.nativeTurnId, item: started, startedAtMs: Date.now() });
  if (outcome === "declined") {
    const declined = { ...started, status: "declined" } as ThreadItem;
    server.notify("item/completed", { threadId: turn.nativeThreadId, turnId: turn.nativeTurnId, item: declined, completedAtMs: Date.now() });
    live.stored.items.push(declined);
    return;
  }
  server.notify("item/commandExecution/outputDelta", { threadId: turn.nativeThreadId, turnId: turn.nativeTurnId, itemId, delta: outcome.output });
  const done = { ...started, status: "completed", aggregatedOutput: outcome.output, exitCode: 0, durationMs: 5 } as ThreadItem;
  server.notify("item/completed", { threadId: turn.nativeThreadId, turnId: turn.nativeTurnId, item: done, completedAtMs: Date.now() });
  live.stored.items.push(done);
}

/** Plays one turn of the fake app-server. */
export async function playCodexTurn(world: FakeCodexWorld, turn: CodexNativeTurn, options: CodexPuppetOptions = {}): Promise<void> {
  const scenario = scenarioOf(turn.prompt);
  if (scenario === undefined) throw new Error(`no scenario sends the prompt ${JSON.stringify(turn.prompt)}`);
  const extra = options.extraText === undefined || options.extraText === "" ? "" : `\n${options.extraText}`;
  const say = (text: string): Promise<void> => turn.say(`${text}${extra}`);
  const server = world.turn(turn.nativeTurnId)?.server;
  // A planted notification's `threadId` or `turnId` given as null is this turn's.
  for (const planted of options.planted ?? []) server?.notify(planted.method, { ...planted.params, ...(planted.params["threadId"] === null ? { threadId: turn.nativeThreadId } : {}), ...(planted.params["turnId"] === null ? { turnId: turn.nativeTurnId } : {}) });
  const index = scenario.prompts.findIndex((each) => turn.prompt.endsWith(each));
  switch (scenario.name) {
    case "simple":
      await say(options.reply ?? "ok");
      return turn.complete();
    case "multi_turn":
    case "resume": {
      if (index === 0) await say("ok");
      else {
        const word = (world.inspect(turn.nativeThreadId)?.prompts ?? []).map((prompt) => REMEMBER.exec(prompt)?.[1]).find((each) => each !== undefined);
        await say(word ?? "I do not remember a word.");
      }
      return turn.complete();
    }
    case "approval_allowed":
    case "approval_denied": {
      const argv = ["/bin/sh", "-c", scenario.command!];
      // The command as the approval request shows it.
      const shown = argv.join(" ");
      const approval = await turn.requestApproval({
        kind: "command",
        command: argv,
        options: [
          { optionId: "allow", label: "Allow", decision: "accept" },
          { optionId: "deny", label: "Deny", decision: "decline" },
        ],
      });
      const reply = await approval.nextReply();
      if (reply !== "allow") {
        // `cancel`: Codex declines the command and aborts the turn.
        commandItem(world, turn, approval.itemId, shown, "declined");
        return turn.finishCancelled();
      }
      commandItem(world, turn, approval.itemId, shown, { output: options.commandOutput ?? `${scenario.marker!}\n` });
      await say("done");
      return turn.complete();
    }
    case "interrupt":
      await say("1\n2\n3\n");
      await turn.stopRequested();
      return turn.finishCancelled();
  }
}
