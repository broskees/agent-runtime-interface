// A second Antigravity recorder run in a process of its own, for the
// recorder suite's test of two runs that share the user's sign-in
// (./recorder.suite.ts): `<node or bun> record-in-child.ts <options as JSON>`
// records the simple scenario against the fake `agy` on the options' PATH and
// prints what became of it as JSON. The options are recordAntigravity's,
// less the scenarios and the source.

import { recordAntigravity } from "../../recordings/antigravity/record.ts";
import type { RecordAntigravityOptions } from "../../recordings/antigravity/record.ts";

/** What the test reads back: the outcome, with the error as its name and message. */
export interface ChildRecordOutcome {
  readonly scenario: string;
  readonly workspace: string;
  readonly workspaceKept: boolean;
  readonly file?: string;
  readonly recoveryFile?: string;
  readonly error?: { readonly name: string; readonly message: string };
}

const options = JSON.parse(process.argv[2] ?? "{}") as Omit<RecordAntigravityOptions, "scenarios" | "source">;
const outcomes = await recordAntigravity({ ...options, scenarios: ["simple"], source: "fake" });
const report: ChildRecordOutcome[] = outcomes.map((outcome) => ({
  scenario: outcome.scenario,
  workspace: outcome.workspace,
  workspaceKept: outcome.workspaceKept,
  ...(outcome.file === undefined ? {} : { file: outcome.file }),
  ...(outcome.recoveryFile === undefined ? {} : { recoveryFile: outcome.recoveryFile }),
  ...(outcome.error === undefined ? {} : { error: { name: outcome.error.name, message: outcome.error.message } }),
}));
process.stdout.write(`${JSON.stringify(report)}\n`);
