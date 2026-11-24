// Scenario scripts (puppets) for the fake OpenCode 2.x server: the puppet
// plays each run of the fake the way OpenCode would play one of the six
// recording scenarios, so the recorder can be proven end to end without a real
// agent. It tells the scenario by the run's prompt, and answers from the
// session's history, as a model answers from its context: the word a later
// turn repeats is the one an earlier prompt of the session gave. Prompts,
// words, markers and commands come from the scenario module.

import type { StartServerInput } from "../../recordings/opencode/record.ts";
import type { OpencodeServerHandle } from "../../recordings/opencode/serve.ts";
import { SCENARIOS } from "../../recordings/scenarios.ts";
import type { Scenario } from "../../recordings/scenarios.ts";
import { FakeServer, FakeWorld } from "./fake-opencode.ts";
import type { FakeRun } from "./fake-opencode.ts";

export interface OpencodePuppetOptions {
  /** Runs at the start of each run, before the puppet acts. */
  readonly onTurn?: (run: FakeRun, index: number) => void | Promise<void>;
  /** Text added to every reply: what the fake loaded of the user's OpenCode setup, if anything. */
  readonly extraText?: string;
  /** The OpenCode server dies in the first run, so the scenario fails. */
  readonly crash?: boolean;
  /** What the approval command prints; the scenario's marker when left out. */
  readonly commandOutput?: string;
  /** The answer of the simple scenario; `ok` when left out. */
  readonly reply?: string;
}

export interface OpencodePuppet {
  /** The puppet's own failure, if it hit one. */
  failure(): Error | undefined;
}

const REMEMBER = /remember this word for later: ([a-z]+)/i;

/** The scenario whose prompts hold this one. The second prompts of multi_turn and resume are the same; either plays it the same way. */
function scenarioOf(prompt: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.prompts.includes(prompt));
}

/** The word an earlier prompt of the session asked to remember, read from the session's messages. */
function rememberedWord(run: FakeRun): string {
  for (const message of run.session.messages) {
    if (message.role !== "user") continue;
    const match = REMEMBER.exec(message.text);
    if (match !== null) return match[1]!;
  }
  return "I do not remember a word.";
}

async function play(run: FakeRun, options: OpencodePuppetOptions): Promise<void> {
  const scenario = scenarioOf(run.prompt);
  if (scenario === undefined) throw new Error(`no scenario sends the prompt ${JSON.stringify(run.prompt)}`);
  const extra = options.extraText === undefined || options.extraText === "" ? "" : `\n${options.extraText}`;
  const say = (text: string): Promise<void> => run.say(`${text}${extra}`);
  if (options.crash === true) {
    await run.exitProcess();
    return;
  }
  const index = scenario.prompts.indexOf(run.prompt);
  switch (scenario.name) {
    case "simple":
      await say(options.reply ?? "ok");
      return run.complete();
    case "multi_turn":
    case "resume":
      await say(index === 0 ? "ok" : rememberedWord(run));
      return run.complete();
    case "approval_allowed":
    case "approval_denied": {
      const command = scenario.command!;
      const handle = await run.requestApproval({
        kind: "command",
        command: command.split(" "),
        options: [
          { optionId: "allow", label: "Allow once", decision: "accept" },
          { optionId: "always", label: "Allow always", decision: "accept_always" },
          { optionId: "deny", label: "Reject", decision: "decline" },
        ],
      });
      const reply = await handle.nextReply();
      if (reply === "deny") {
        await say("The command was refused, so I stopped.");
        return run.complete();
      }
      await run.runCommand(command, options.commandOutput ?? `${scenario.marker!}\n`);
      await say("done");
      return run.complete();
    }
    case "interrupt":
      await say("1\n2\n3\n4\n5\n");
      await run.stopRequested();
      return run.finishCancelled();
  }
}

export interface FakeOpencodeServer {
  readonly world: FakeWorld;
  readonly server: FakeServer;
  readonly puppet: OpencodePuppet;
}

/**
 * A server starter for the recording function: each call starts the fake
 * OpenCode 2.x server in this process, with the password the recorder chose and
 * a puppet, and adds it to `started`. Its `stop` ends the fake's process.
 */
export function fakeOpencodeServers(started: FakeOpencodeServer[], options: OpencodePuppetOptions = {}): (input: StartServerInput) => Promise<OpencodeServerHandle> {
  return async ({ password }) => {
    const world = new FakeWorld(2);
    await world.ready();
    const server = new FakeServer(world, password);
    const url = await server.listen(() => undefined);
    started.push({ world, server, puppet: startOpencodePuppet(world, options) });
    return { url, password, stop: () => server.exit(0) };
  };
}

/** Plays every run the fake world starts, from now on, until the world's runs end. */
export function startOpencodePuppet(world: FakeWorld, options: OpencodePuppetOptions = {}): OpencodePuppet {
  let failure: Error | undefined;
  let runs = 0;
  void (async () => {
    for (;;) {
      const next = await world.turns.next();
      if (next.done === true) return;
      const run = next.value;
      const index = runs;
      runs += 1;
      void (async () => {
        await options.onTurn?.(run, index);
        await play(run, options);
      })().catch((error: unknown) => {
        failure ??= error instanceof Error ? error : new Error(String(error));
      });
    }
  })();
  return { failure: () => failure };
}
