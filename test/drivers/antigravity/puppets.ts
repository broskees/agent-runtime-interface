// Scenario scripts (puppets) for the fake ACP agent (test/drivers/acp/fake-agent.ts)
// run as `agy acp` by the fake `agy` (./fake-agy-cli.ts): each plays one turn
// the way an agent would play one of the six recording scenarios, so the
// Antigravity recorder can be proven end to end without the real agent. A
// puppet tells the scenario by the turn's prompt and answers from the
// session's history, as a model answers from its context: the word a later
// turn repeats is the one an earlier prompt of the session gave. Prompts,
// words, markers and commands come from the scenario module.
//
// The approval scenarios ask the host about one `execute` tool call; once the
// host answered, the tool call completes with the command's output, or fails
// when the host declined.

import type { PuppetChannel } from "../acp/harness.ts";
import { SCENARIOS } from "../../recordings/scenarios.ts";
import type { Scenario } from "../../recordings/scenarios.ts";

export interface AgyPuppetOptions {
  /** Text added to every reply: what the fake loaded of the user's Antigravity setup, if anything. */
  readonly extraText?: string;
  /** What the approval command prints; the scenario's marker when left out. */
  readonly commandOutput?: string;
  /** The answer of the simple scenario; `ok` when left out. */
  readonly reply?: string;
  /** The `session/update`s the agent sends first in every turn, as they are: a test plants values the sanitiser must replace. */
  readonly planted?: ReadonlyArray<{ readonly [key: string]: unknown }>;
}

export interface AgyTurn {
  readonly turnId: string;
  readonly sessionId: string;
  readonly prompt: string;
}

const REMEMBER = /remember this word for later: ([a-z]+)/i;

/** The scenario whose prompts hold this one. The second prompts of multi_turn and resume are the same; either plays it the same way. */
export function scenarioOf(prompt: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.prompts.some((each) => prompt.endsWith(each)));
}

/** Plays one turn of the fake agent behind `channel`. */
export async function playAgyTurn(channel: PuppetChannel, turn: AgyTurn, options: AgyPuppetOptions = {}): Promise<void> {
  const scenario = scenarioOf(turn.prompt);
  if (scenario === undefined) throw new Error(`no scenario sends the prompt ${JSON.stringify(turn.prompt)}`);
  const call = <T>(method: string, ...args: unknown[]): Promise<T> => channel.call<T>(method, turn.turnId, ...args);
  const extra = options.extraText === undefined || options.extraText === "" ? "" : `\n${options.extraText}`;
  const say = (text: string): Promise<void> => call("say", `${text}${extra}`);
  const update = (value: { readonly [key: string]: unknown }): Promise<void> => call("rawUpdate", value);
  for (const planted of options.planted ?? []) await update(planted);
  const index = scenario.prompts.findIndex((each) => turn.prompt.endsWith(each));
  switch (scenario.name) {
    case "simple":
      await say(options.reply ?? "ok");
      return call("complete");
    case "multi_turn":
    case "resume": {
      if (index === 0) await say("ok");
      else {
        const session = await channel.call<{ prompts: string[] } | null>("inspectSession", turn.sessionId);
        const word = (session?.prompts ?? []).map((prompt) => REMEMBER.exec(prompt)?.[1]).find((each) => each !== undefined);
        await say(word ?? "I do not remember a word.");
      }
      return call("complete");
    }
    case "approval_allowed":
    case "approval_denied": {
      const approvalId = await call<string>("requestApproval", {
        kind: "command",
        command: ["sh", "-c", scenario.command!],
        options: [
          { optionId: "allow", label: "Allow", decision: "accept" },
          { optionId: "deny", label: "Deny", decision: "decline" },
        ],
      });
      const toolCallId = await channel.call<string>("approvalToolCall", approvalId);
      const reply = await channel.call<string>("nextApprovalReply", approvalId);
      if (reply !== "allow") {
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
        await say("The command was refused, so I stopped.");
        return call("complete");
      }
      await update({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
      await update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: options.commandOutput ?? `${scenario.marker!}\n` } }] });
      await say("done");
      return call("complete");
    }
    case "interrupt":
      await say("1\n2\n3\n");
      await call("stopRequested");
      return call("finishCancelled");
  }
}
