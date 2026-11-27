// What the Codex app-server traffic in a stdio recording says about approvals
// and turns, read off the recorded frames, and the fields Codex replay leaves
// out of the comparison:
//   - the answers the driver sent Codex. Codex asks with an
//     `item/commandExecution/requestApproval` or `item/fileChange/requestApproval`
//     request on its stdout; the driver answers on stdin with a decision:
//     `accept` (this call only), `acceptForSession`, an exec-policy or network
//     amendment, `decline`, or `cancel` (decline and stop the turn);
//   - each host turn's own frames: the driver's `turn/start` request, Codex's
//     answer naming the turn, and the `turn/completed` notification that ends
//     it. A failed scenario check about a turn depended on them.
// Codex frames carry no "jsonrpc" member (docs/drivers/codex.md, "Frames").

import type { Frame, RecordedFrame, Recording } from "../format.ts";
import type { NativeAnswer } from "../scenarios.ts";
import type { DependedOnFrame, IgnoredField } from "../sequencer.ts";

/** The fields Codex replay leaves out of the comparison. docs/recordings.md, "Fields replay ignores", lists the same, with the same reasons. */
export const CODEX_IGNORED_FIELDS: readonly IgnoredField[] = [
  {
    driver: "codex",
    kind: "stdin",
    field: "message.params.clientInfo.version",
    reason: "the driver's initialize request names the ARI version, which changes with every ARI release",
  },
];

type Message = { readonly id?: unknown; readonly method?: unknown; readonly params?: unknown; readonly result?: unknown; readonly error?: unknown };

const APPROVAL_REQUESTS: ReadonlySet<string> = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);

/** The approval answers the driver sent, in order. `frames` are the recording's frames, or the outbound ones a replay matched with the inbound ones. */
export function codexNativeAnswers(frames: readonly Frame[], lines?: readonly number[]): NativeAnswer[] {
  // Each approval Codex asked for, by its process and JSON-RPC id.
  const asked = new Set<string>();
  const answers: NativeAnswer[] = [];
  frames.forEach((frame, index) => {
    const message = frame["message"] as Message | undefined;
    if (typeof message !== "object" || message === null) return;
    const key = `${String(frame["proc"])}:${JSON.stringify(message.id)}`;
    if (frame.dir === "in" && frame.kind === "stdout" && typeof message.method === "string" && APPROVAL_REQUESTS.has(message.method)) {
      asked.add(key);
      return;
    }
    if (frame.dir !== "out" || frame.kind !== "stdin" || message.method !== undefined || !asked.has(key) || message.result === undefined) return;
    asked.delete(key);
    const decision = (message.result as { decision?: unknown } | null)?.decision;
    const line = lines?.[index];
    const at = line === undefined ? {} : { line };
    if (decision === "accept") answers.push({ decision: "accept", scope: "once", ...at });
    else if (decision === "acceptForSession" || (typeof decision === "object" && decision !== null && ("acceptWithExecpolicyAmendment" in decision || "applyNetworkPolicyAmendment" in decision))) answers.push({ decision: "accept", ...at });
    else if (decision === "decline") answers.push({ decision: "decline", ...at });
    else if (decision === "cancel") answers.push({ decision: "cancel", ...at });
  });
  return answers;
}

/**
 * Each host turn's recorded frames, in the order the turns started: the
 * driver's `turn/start` request (each prompt of the scenario is one), Codex's
 * answer to it (the same process's stdout frame with the request's id), and
 * the `turn/completed` notification of the turn that answer names, when the
 * recording holds them.
 */
export function codexTurnFrames(recording: Recording): Array<{ readonly request: RecordedFrame; readonly answer?: RecordedFrame; readonly completed?: RecordedFrame }> {
  const turns: Array<{ request: RecordedFrame; answer?: RecordedFrame; completed?: RecordedFrame }> = [];
  recording.frames.forEach((entry, index) => {
    const message = entry.frame["message"] as Message | undefined;
    if (entry.frame.kind !== "stdin" || message?.method !== "turn/start") return;
    const later = recording.frames.slice(index + 1).filter((each) => each.frame.kind === "stdout" && each.frame["proc"] === entry.frame["proc"]);
    const answer = later.find((each) => {
      const reply = each.frame["message"] as Message | undefined;
      return reply?.method === undefined && JSON.stringify(reply?.id) === JSON.stringify(message.id) && (reply?.result !== undefined || reply?.error !== undefined);
    });
    const turnId = (answer?.frame["message"] as { result?: { turn?: { id?: unknown } } } | undefined)?.result?.turn?.id;
    const completed =
      turnId === undefined
        ? undefined
        : later.find((each) => {
            const note = each.frame["message"] as { method?: unknown; params?: { turn?: { id?: unknown } } } | undefined;
            return note?.method === "turn/completed" && note.params?.turn?.id === turnId;
          });
    turns.push({ request: entry, ...(answer === undefined ? {} : { answer }), ...(completed === undefined ? {} : { completed }) });
  });
  return turns;
}

/**
 * The recorded frames a failed check about `turns` (indexes into the
 * scenario's prompts) depended on: for each turn, the `turn/completed` that
 * ended it, which names the line of the turn's request too; else Codex's
 * answer to the request; else the request itself.
 */
export function codexTurnsDependedOn(recording: Recording, turns: readonly number[]): DependedOnFrame[] {
  const recorded = codexTurnFrames(recording);
  return turns.flatMap((index) => {
    const turn = recorded[index];
    if (turn === undefined) return [];
    if (turn.completed !== undefined) return [{ line: turn.completed.line, frame: turn.completed.frame, why: `the turn/completed that ended turn ${index + 1}, started at line ${turn.request.line}` }];
    if (turn.answer !== undefined) return [{ line: turn.answer.line, frame: turn.answer.frame, why: `the answer to turn ${index + 1}'s turn/start at line ${turn.request.line}, which no recorded turn/completed ends` }];
    return [{ line: turn.request.line, frame: turn.request.frame, why: `the turn/start of turn ${index + 1}, which no recorded answer names` }];
  });
}
