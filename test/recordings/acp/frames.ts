// What the ACP traffic in a stdio recording says about approvals and turns,
// read off the recorded frames:
//   - the answers the driver sent the agent. An ACP agent asks with a
//     `session/request_permission` request on its stdout, offering options of
//     a kind (`allow_once`, `allow_always`, `reject_once`, `reject_always`);
//     the driver answers on stdin with the id of one option, or `cancelled`;
//   - each host turn's own frames: the driver's `session/prompt` request and
//     the agent's response to it, which ends the turn. A failed scenario check
//     about a turn depended on them.

import type { Frame, RecordedFrame, Recording } from "../format.ts";
import type { NativeAnswer } from "../scenarios.ts";
import type { DependedOnFrame } from "../sequencer.ts";

type Message = { readonly id?: unknown; readonly method?: unknown; readonly params?: unknown; readonly result?: unknown };

/** The approval answers the driver sent, in order, each with the kind of the option it picked. `frames` are the recording's frames, or the outbound ones a replay matched with the inbound ones. */
export function acpNativeAnswers(frames: readonly Frame[], lines?: readonly number[]): NativeAnswer[] {
  // Each agent request for permission, by its process and JSON-RPC id: the kind of each option it offered.
  const asked = new Map<string, Map<string, string>>();
  const answers: NativeAnswer[] = [];
  frames.forEach((frame, index) => {
    const message = frame["message"] as Message | undefined;
    if (typeof message !== "object" || message === null) return;
    const key = `${String(frame["proc"])}:${JSON.stringify(message.id)}`;
    if (frame.dir === "in" && frame.kind === "stdout" && message.method === "session/request_permission") {
      const options = ((message.params as { options?: unknown } | undefined)?.options ?? []) as Array<{ optionId?: unknown; kind?: unknown }>;
      asked.set(key, new Map(options.map((option) => [String(option.optionId), String(option.kind)])));
      return;
    }
    if (frame.dir !== "out" || frame.kind !== "stdin" || !asked.has(key) || message.result === undefined) return;
    const outcome = (message.result as { outcome?: { outcome?: unknown; optionId?: unknown } } | null)?.outcome;
    const line = lines?.[index];
    const at = line === undefined ? {} : { line };
    if (outcome?.outcome === "cancelled") answers.push({ decision: "cancel", ...at });
    else if (outcome?.outcome === "selected") {
      const kind = asked.get(key)!.get(String(outcome.optionId));
      if (kind === "allow_once") answers.push({ decision: "accept", scope: "once", ...at });
      else if (kind === "allow_always") answers.push({ decision: "accept", ...at });
      else if (kind === "reject_once" || kind === "reject_always") answers.push({ decision: "decline", ...at });
    }
    asked.delete(key);
  });
  return answers;
}

/**
 * Each host turn's recorded frames, in the order the turns started: the
 * driver's `session/prompt` request (each prompt of the scenario is one) and
 * the agent's response to it, the same process's stdout frame with the
 * request's id and a result or an error, when the recording holds one.
 */
export function acpTurnFrames(recording: Recording): Array<{ readonly request: RecordedFrame; readonly response?: RecordedFrame }> {
  const turns: Array<{ request: RecordedFrame; response?: RecordedFrame }> = [];
  recording.frames.forEach((entry, index) => {
    const message = entry.frame["message"] as Message | undefined;
    if (entry.frame.kind !== "stdin" || message?.method !== "session/prompt") return;
    const response = recording.frames.slice(index + 1).find((later) => {
      const answer = later.frame["message"] as (Message & { readonly error?: unknown }) | undefined;
      return later.frame.kind === "stdout" && later.frame["proc"] === entry.frame["proc"] && answer?.method === undefined && JSON.stringify(answer?.id) === JSON.stringify(message.id) && (answer?.result !== undefined || answer?.error !== undefined);
    });
    turns.push({ request: entry, ...(response === undefined ? {} : { response }) });
  });
  return turns;
}

/**
 * The recorded frames a failed check about `turns` (indexes into the
 * scenario's prompts) depended on: for each turn, the response that ended it,
 * which names the line of the turn's request too; the request itself when no
 * response answers it.
 */
export function acpTurnsDependedOn(recording: Recording, turns: readonly number[]): DependedOnFrame[] {
  const recorded = acpTurnFrames(recording);
  return turns.flatMap((index) => {
    const turn = recorded[index];
    if (turn === undefined) return [];
    if (turn.response === undefined) return [{ line: turn.request.line, frame: turn.request.frame, why: `the request of turn ${index + 1}, which no recorded response answers` }];
    return [{ line: turn.response.line, frame: turn.response.frame, why: `the response that ended turn ${index + 1}, requested at line ${turn.request.line}` }];
  });
}
