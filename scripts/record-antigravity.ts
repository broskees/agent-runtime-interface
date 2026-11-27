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
//   --list-models     open an isolated thread, send no prompts and write no tape
// Environment:
//   ARI_RECORD_ANTIGRAVITY_MODEL  the model to record with, one `agy acp` offers;
//                                 the first Flash model it offers by default. A
//                                 model it does not offer stops the recorder
//                                 before the first prompt
//   ARI_RECORD_ANTIGRAVITY_EFFORT  pin the ACP thought_level for an explicit model
//   ARI_RECORD_ANTIGRAVITY_VERSION  require this exact installed agy version
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
  const { AntigravitySignInMissingError, AntigravityWorkspaceCustomizedError, AntigravityWorkspaceInHomeError, describeAntigravityRun, failuresOf, recordAntigravity } = await import("../test/recordings/antigravity/record.ts");
  const { safeAntigravityFailure } = await import("../test/recordings/antigravity/record.ts");
  const listModels = argv.length === 1 && argv[0] === "--list-models";
  let parsed: RecordArguments;
  try {
    parsed = parseRecordArguments(listModels ? [] : argv, SCENARIO_NAMES, DEFAULT_ANTIGRAVITY_RECORDINGS);
  } catch (error) {
    process.stderr.write(`record-antigravity: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const outcomes = await recordAntigravity({
    ...(parsed.scenarios.length === 0 ? {} : { scenarios: parsed.scenarios as Array<(typeof SCENARIO_NAMES)[number]> }),
    outDir: parsed.outDir,
    source: "live",
    listModels,
    ...(process.env["ARI_RECORD_ANTIGRAVITY_VERSION"] === undefined ? {} : { requireVersion: process.env["ARI_RECORD_ANTIGRAVITY_VERSION"] }),
    env: process.env,
    log: (line) => process.stdout.write(`record-antigravity: ${line}\n`),
  });
  const stop = outcomes.flatMap(failuresOf).find((failure) => failure instanceof AntigravityModelChoiceError || failure instanceof AntigravitySignInMissingError || failure instanceof AntigravityWorkspaceInHomeError || failure instanceof AntigravityWorkspaceCustomizedError);
  if (stop !== undefined) process.stderr.write(`record-antigravity: stopped before the first prompt. ${safeAntigravityFailure(stop)}\n`);
  // Every recovery file and every kept workspace, whatever else failed.
  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  if (listModels && failed.length === 0) {
    for (const model of outcomes[0]?.offeredModels ?? []) if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(model)) process.stdout.write(`model: ${model}\n`);
  }
  const stream = failed.length === 0 ? process.stdout : process.stderr;
  for (const line of describeAntigravityRun(outcomes, parsed.outDir)) stream.write(`record-antigravity: ${line}\n`);
  if (stop !== undefined) return 2;
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT) {
  process.exitCode = await main(process.argv.slice(2));
}
