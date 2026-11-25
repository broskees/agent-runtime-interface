// What the ACP traffic in a stdio recording says about approvals: the answers
// the driver sent the agent, read off the recorded frames. An ACP agent asks
// with a `session/request_permission` request on its stdout, offering options
// of a kind (`allow_once`, `allow_always`, `reject_once`, `reject_always`);
// the driver answers on stdin with the id of one option, or `cancelled`.

import type { Frame } from "../format.ts";
import type { NativeAnswer } from "../scenarios.ts";

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
