// The Codex recorder (`pnpm run record:codex`): runs the recording scenarios
// through the ARI Codex driver against the real Codex CLI
// (`codex app-server`), which it starts with a temp CODEX_HOME (holding only a
// copy of the user's sign-in), HOME and XDG directories of its own behind a
// process tap, and writes one sanitised native recording per scenario. It
// spends the user's Codex usage, so it runs only with ARI_LIVE_RECORD=1, and
// it checks that before it loads anything or starts any process. No gate step
// and no CI workflow sets ARI_LIVE_RECORD.
//
// Usage: ARI_LIVE_RECORD=1 node scripts/record-codex.ts [--out <dir>] [scenario ...]
//   scenario  any of simple, multi_turn, approval_allowed, approval_denied,
//             interrupt, resume; all six when none is named
//   --out     where the recordings go; test/drivers/codex/recordings/ by default
// Environment:
//   ARI_RECORD_CODEX_MODEL  the model to record with, one Codex lists; the first
//                           Luna, nano or mini model it lists by default. A
//                           model it does not list stops the recorder before
//                           the first prompt, listing the models
//
// docs/recordings.md says how `codex` is kept apart from the user's own Codex
// setup, how the sign-in reaches it, and how to refresh the recordings.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_RECORD_VARIABLE, parseRecordArguments } from "./record-claude.ts";
import type { RecordArguments } from "./record-claude.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "..");
export const DEFAULT_CODEX_RECORDINGS = path.join(REPO_ROOT, "test", "drivers", "codex", "recordings");

async function main(argv: readonly string[]): Promise<number> {
  if (process.env[LIVE_RECORD_VARIABLE] !== "1") {
    process.stderr.write(`record-codex: refusing to start the real Codex CLI. This records against the real codex and spends your Codex usage; set ${LIVE_RECORD_VARIABLE}=1 to run it, for example \`${LIVE_RECORD_VARIABLE}=1 pnpm run record:codex\`.\n`);
    return 2;
  }
  // Only now: these load the driver and start processes.
  const { SCENARIO_NAMES } = await import("../test/recordings/scenarios.ts");
  const { CodexModelChoiceError, CodexSignInMissingError, CodexWorkspaceCustomizedError, CodexWorkspaceInHomeError, describeCodexRun, failuresOf, recordCodex } = await import("../test/recordings/codex/record.ts");
  let parsed: RecordArguments;
  try {
    parsed = parseRecordArguments(argv, SCENARIO_NAMES, DEFAULT_CODEX_RECORDINGS);
  } catch (error) {
    process.stderr.write(`record-codex: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const outcomes = await recordCodex({
    ...(parsed.scenarios.length === 0 ? {} : { scenarios: parsed.scenarios as Array<(typeof SCENARIO_NAMES)[number]> }),
    outDir: parsed.outDir,
    source: "live",
    env: process.env,
    log: (line) => process.stdout.write(`record-codex: ${line}\n`),
  });
  const stop = outcomes.flatMap(failuresOf).find((failure) => failure instanceof CodexModelChoiceError || failure instanceof CodexSignInMissingError || failure instanceof CodexWorkspaceInHomeError || failure instanceof CodexWorkspaceCustomizedError);
  if (stop !== undefined) process.stderr.write(`record-codex: stopped before the first prompt. ${stop.message}\n`);
  // Every recovery file and every kept workspace, whatever else failed.
  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  const stream = failed.length === 0 ? process.stdout : process.stderr;
  for (const line of describeCodexRun(outcomes, parsed.outDir)) stream.write(`record-codex: ${line}\n`);
  if (stop !== undefined) return 2;
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT) {
  process.exitCode = await main(process.argv.slice(2));
}
