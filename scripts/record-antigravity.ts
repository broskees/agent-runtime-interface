// The Antigravity recorder (`pnpm run record:antigravity`): runs the recording
// scenarios through the ARI Antigravity driver against the real Antigravity
// CLI (`agy acp`), which it starts with a temp profile, HOME and XDG
// directories of its own behind a process tap, and writes one sanitised
// native recording per scenario. It spends the user's Antigravity quota, so
// it runs only with ARI_LIVE_RECORD=1, and it checks that before it loads
// anything or starts any process. No gate step and no CI workflow sets
// ARI_LIVE_RECORD.
//
// Usage: ARI_LIVE_RECORD=1 node scripts/record-antigravity.ts [--out <dir>] [scenario ...]
//   scenario  any of simple, multi_turn, approval_allowed, approval_denied,
//             interrupt, resume; all six when none is named
//   --out     where the recordings go; test/drivers/antigravity/recordings/ by default
// Environment:
//   ARI_RECORD_ANTIGRAVITY_MODEL  the model to record with, one `agy acp` offers;
//                                 the first Flash model it offers by default. A
//                                 model it does not offer stops the recorder
//                                 before the first prompt, listing the models
//
// docs/recordings.md says how `agy` is kept apart from the user's own
// Antigravity setup, how the sign-in reaches it, and how to refresh the
// recordings.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_RECORD_VARIABLE, parseRecordArguments } from "./record-claude.ts";
import type { RecordArguments } from "./record-claude.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "..");
export const DEFAULT_ANTIGRAVITY_RECORDINGS = path.join(REPO_ROOT, "test", "drivers", "antigravity", "recordings");

async function main(argv: readonly string[]): Promise<number> {
  if (process.env[LIVE_RECORD_VARIABLE] !== "1") {
    process.stderr.write(
      `record-antigravity: refusing to start the real Antigravity CLI. This records against the real agy and spends your Antigravity quota; set ${LIVE_RECORD_VARIABLE}=1 to run it, for example \`${LIVE_RECORD_VARIABLE}=1 pnpm run record:antigravity\`.\n`,
    );
    return 2;
  }
  // Only now: these load the driver and start processes.
  const { SCENARIO_NAMES } = await import("../test/recordings/scenarios.ts");
  const { AntigravityModelChoiceError } = await import("../test/recordings/antigravity/run.ts");
  const { AntigravitySignInMissingError, AntigravityWorkspaceInHomeError, describeAntigravityRun, failuresOf, recordAntigravity } = await import("../test/recordings/antigravity/record.ts");
  let parsed: RecordArguments;
  try {
    parsed = parseRecordArguments(argv, SCENARIO_NAMES, DEFAULT_ANTIGRAVITY_RECORDINGS);
  } catch (error) {
    process.stderr.write(`record-antigravity: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const outcomes = await recordAntigravity({
    ...(parsed.scenarios.length === 0 ? {} : { scenarios: parsed.scenarios as Array<(typeof SCENARIO_NAMES)[number]> }),
    outDir: parsed.outDir,
    source: "live",
    env: process.env,
    log: (line) => process.stdout.write(`record-antigravity: ${line}\n`),
  });
  const stop = outcomes.flatMap(failuresOf).find((failure) => failure instanceof AntigravityModelChoiceError || failure instanceof AntigravitySignInMissingError || failure instanceof AntigravityWorkspaceInHomeError);
  if (stop !== undefined) process.stderr.write(`record-antigravity: stopped before the first prompt. ${stop.message}\n`);
  // Every recovery file and every kept workspace, whatever else failed.
  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  const stream = failed.length === 0 ? process.stdout : process.stderr;
  for (const line of describeAntigravityRun(outcomes, parsed.outDir)) stream.write(`record-antigravity: ${line}\n`);
  if (stop !== undefined) return 2;
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT) {
  process.exitCode = await main(process.argv.slice(2));
}
