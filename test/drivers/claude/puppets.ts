// Scenario scripts (puppets) for the fake Claude SDK: each makes the fake
// play one of the six recording scenarios the way Claude Code would, so the
// recorder can be proven end to end without a real agent. A puppet answers
// from the session's transcript, as a model answers from its context: the
// word a later turn repeats is the one an earlier prompt in the transcript
// gave. Prompts, words, markers and commands come from the scenario module.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ClaudeRuntime } from "../../recordings/claude/frames.ts";
import type { Scenario } from "../../recordings/scenarios.ts";
import { FakeClaudeWorld, entryPrompt } from "./fake-sdk.ts";
import type { FakeTurn } from "./fake-sdk.ts";
import { FAKE_SDK_VERSION } from "./harness.ts";

export interface PuppetOptions {
  /** Runs at the start of each native turn, before the puppet acts. */
  readonly onTurn?: (turn: FakeTurn, index: number, world: FakeClaudeWorld) => void | Promise<void>;
  /** The Claude Code process dies in the first turn, so the scenario fails. */
  readonly crash?: boolean;
  /** What the approval command prints, given the query's working directory; the scenario's marker when left out. */
  readonly bashOutput?: (cwd: string) => string;
  /** The answer of the simple scenario; `ok` when left out. */
  readonly reply?: string;
}

export interface Puppet {
  readonly world: FakeClaudeWorld;
  /** The puppet's own failure, if it hit one. */
  failure(): Error | undefined;
}

const REMEMBER = /remember this word for later: ([a-z]+)/i;

/** The word an earlier prompt of the session asked to remember, read from the transcript. */
function rememberedWord(world: FakeClaudeWorld, sessionId: string): string {
  const session = world.sessions.get(sessionId);
  for (const entry of session?.entries ?? []) {
    const match = REMEMBER.exec(entryPrompt(entry) ?? "");
    if (match !== null) return match[1]!;
  }
  return "I do not remember a word.";
}

async function play(world: FakeClaudeWorld, scenario: Scenario, turn: FakeTurn, index: number, options: PuppetOptions): Promise<void> {
  switch (scenario.name) {
    case "simple":
      await turn.say(options.reply ?? "ok");
      return turn.complete();
    case "multi_turn":
    case "resume":
      await turn.say(index === 0 ? "ok" : rememberedWord(world, turn.sessionId));
      return turn.complete();
    case "approval_allowed":
    case "approval_denied": {
      const cwd = world.queries.at(-1)!.cwd;
      const result = await turn.runBash(scenario.command!, options.bashOutput?.(cwd) ?? `${scenario.marker!}\n`);
      await turn.say(result === undefined || result.behavior === "allow" ? "done" : "The command was refused, so I stopped.");
      return turn.complete();
    }
    case "interrupt":
      await turn.say("1\n2\n3\n");
      await turn.stopRequested();
      return turn.finishCancelled();
  }
}

/** Starts a fake Claude Code installation that plays `scenario`. */
export function startPuppet(scenario: Scenario, options: PuppetOptions = {}): Puppet {
  const world = new FakeClaudeWorld();
  let failure: Error | undefined;
  void (async () => {
    for (let index = 0; index < scenario.prompts.length; index += 1) {
      const turn = await world.nextTurn();
      await options.onTurn?.(turn, index, world);
      if (options.crash === true) return turn.exitProcess();
      await play(world, scenario, turn, index, options);
    }
  })().catch((error: unknown) => {
    failure = error instanceof Error ? error : new Error(String(error));
  });
  return { world, failure: () => failure };
}

/** The runtime the driver's `loadSdk` returns for a puppet's world. */
export function puppetRuntime(puppet: Puppet): ClaudeRuntime {
  return { sdk: puppet.world.sdk, version: FAKE_SDK_VERSION, claudeCodeVersion: "2.1.330" };
}

/** Rewrites the credential copy in the query's Claude config dir, as Claude Code does when it refreshes a token. */
export function refreshCredential(world: FakeClaudeWorld, content: string): string {
  const configDir = world.queries.at(-1)?.options.env?.["CLAUDE_CONFIG_DIR"];
  if (configDir === undefined) throw new Error("the query names no CLAUDE_CONFIG_DIR");
  const file = path.join(configDir, ".credentials.json");
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}
