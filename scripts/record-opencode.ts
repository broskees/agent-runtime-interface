// The OpenCode recorder (`pnpm run record:opencode`): runs the recording
// scenarios through the ARI OpenCode driver against the real OpenCode 2.x,
// which it starts as `opencode serve` in a temp workspace of its own, behind a
// recording proxy, and writes one sanitised native recording per scenario. It
// spends the user's model quota, so it runs only with ARI_LIVE_RECORD=1, and
// it checks that before it loads anything or starts any process. No gate step
// and no CI workflow sets ARI_LIVE_RECORD.
//
// Usage: ARI_LIVE_RECORD=1 ARI_RECORD_OPENCODE_MODEL=<provider/model> node scripts/record-opencode.ts [--out <dir>] [scenario ...]
//   scenario  any of simple, multi_turn, approval_allowed, approval_denied,
//             interrupt, resume; all six when none is named
//   --out     where the recordings go; test/drivers/opencode/recordings/ by default
// Environment:
//   ARI_RECORD_OPENCODE_MODEL  the model to record with, as provider/model; without
//                              it, or with a model the server does not offer, the
//                              recorder stops before the first prompt and lists the
//                              models the server offers
//
// docs/recordings.md says how the server is kept apart from the user's own
// OpenCode setup, how the sign-in reaches it, and how to refresh the recordings.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_RECORD_VARIABLE, parseRecordArguments } from "./record-claude.ts";
import type { RecordArguments } from "./record-claude.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "..");
export const DEFAULT_OPENCODE_RECORDINGS = path.join(REPO_ROOT, "test", "drivers", "opencode", "recordings");

async function main(argv: readonly string[]): Promise<number> {
  if (process.env[LIVE_RECORD_VARIABLE] !== "1") {
    process.stderr.write(
      `record-opencode: refusing to start a real OpenCode server. This records against the real OpenCode and spends your model quota; set ${LIVE_RECORD_VARIABLE}=1 to run it, for example \`${LIVE_RECORD_VARIABLE}=1 ARI_RECORD_OPENCODE_MODEL=<provider/model> pnpm run record:opencode\`.\n`,
    );
    return 2;
  }
  // Only now: these load the driver and start processes.
  const { SCENARIO_NAMES } = await import("../test/recordings/scenarios.ts");
  const { OpencodeModelChoiceError, describeOpencodeRun, failuresOf, recordOpencode } = await import("../test/recordings/opencode/record.ts");
  const { startOpencodeServe } = await import("../test/recordings/opencode/serve.ts");
  let parsed: RecordArguments;
  try {
    parsed = parseRecordArguments(argv, SCENARIO_NAMES, DEFAULT_OPENCODE_RECORDINGS);
  } catch (error) {
    process.stderr.write(`record-opencode: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const outcomes = await recordOpencode({
    ...(parsed.scenarios.length === 0 ? {} : { scenarios: parsed.scenarios as Array<(typeof SCENARIO_NAMES)[number]> }),
    outDir: parsed.outDir,
    source: "live",
    env: process.env,
    startServer: (input) => startOpencodeServe({ layout: input.layout, env: input.env, password: input.password }),
    log: (line) => process.stdout.write(`record-opencode: ${line}\n`),
  });
  const choice = outcomes.flatMap(failuresOf).find((failure) => failure instanceof OpencodeModelChoiceError);
  if (choice !== undefined) process.stderr.write(`record-opencode: stopped before the first prompt. ${choice.message}\n`);
  // Every recovery file and every kept workspace, whatever else failed.
  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  const stream = failed.length === 0 ? process.stdout : process.stderr;
  for (const line of describeOpencodeRun(outcomes, parsed.outDir)) stream.write(`record-opencode: ${line}\n`);
  if (choice !== undefined) return 2;
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT) {
  process.exitCode = await main(process.argv.slice(2));
}
