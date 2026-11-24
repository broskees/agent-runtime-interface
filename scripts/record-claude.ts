// The Claude recorder (`pnpm run record:claude`): runs the recording
// scenarios through the ARI Claude driver against the real Claude Code, by
// the pinned Claude Agent SDK, and writes one sanitised native recording per
// scenario. It spends the user's Claude quota, so it runs only with
// ARI_LIVE_RECORD=1, and it checks that before it loads the SDK or starts
// anything. No gate step and no CI workflow sets ARI_LIVE_RECORD.
//
// Usage: ARI_LIVE_RECORD=1 node scripts/record-claude.ts [--out <dir>] [scenario ...]
//   scenario  any of simple, multi_turn, approval_allowed, approval_denied,
//             interrupt, resume; all six when none is named
//   --out     where the recordings go; test/drivers/claude/recordings/ by default
// Environment:
//   ARI_RECORD_CLAUDE_MODEL  the model to record with; Claude Code's `haiku` alias by default
//   ANTHROPIC_API_KEY        when set, the driver instance uses this key instead of the sign-in
//
// docs/recordings.md says how the session is kept apart from the user's own
// Claude setup and how to refresh the recordings.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
// Type-only: erased before the script runs, so it loads nothing.
import type { ClaudeRuntime } from "../test/recordings/claude/frames.ts";

export const LIVE_RECORD_VARIABLE = "ARI_LIVE_RECORD";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "..");
export const DEFAULT_CLAUDE_RECORDINGS = path.join(REPO_ROOT, "test", "drivers", "claude", "recordings");

export interface RecordArguments {
  readonly scenarios: string[];
  readonly outDir: string;
}

export function parseRecordArguments(argv: readonly string[], known: readonly string[], defaultOut: string): RecordArguments {
  const scenarios: string[] = [];
  let outDir = defaultOut;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value === "") throw new Error("--out needs a directory");
      outDir = path.resolve(value);
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option ${argument}`);
    } else if (!known.includes(argument)) {
      throw new Error(`unknown scenario ${JSON.stringify(argument)}; the scenarios are ${known.join(", ")}`);
    } else if (!scenarios.includes(argument)) {
      scenarios.push(argument);
    }
  }
  return { scenarios, outDir };
}

async function main(argv: readonly string[]): Promise<number> {
  if (process.env[LIVE_RECORD_VARIABLE] !== "1") {
    process.stderr.write(
      `record-claude: refusing to start a real Claude session. This records against the real Claude Code and spends your Claude quota; set ${LIVE_RECORD_VARIABLE}=1 to run it, for example \`${LIVE_RECORD_VARIABLE}=1 pnpm run record:claude\`.\n`,
    );
    return 2;
  }
  // Only now: these load the driver, and the recording function loads the SDK.
  const { SCENARIO_NAMES } = await import("../test/recordings/scenarios.ts");
  const { recordClaude } = await import("../test/recordings/claude/record.ts");
  const { loadClaudeSdk } = await import("../src/drivers/claude/sdk.ts");
  let parsed: RecordArguments;
  try {
    parsed = parseRecordArguments(argv, SCENARIO_NAMES, DEFAULT_CLAUDE_RECORDINGS);
  } catch (error) {
    process.stderr.write(`record-claude: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const outcomes = await recordClaude({
    ...(parsed.scenarios.length === 0 ? {} : { scenarios: parsed.scenarios as Array<(typeof SCENARIO_NAMES)[number]> }),
    outDir: parsed.outDir,
    source: "live",
    env: process.env,
    loadSdk: async () => {
      const runtime = await loadClaudeSdk();
      // loadClaudeSdk imports @anthropic-ai/claude-agent-sdk itself, so its module is the SDK's own.
      return runtime as unknown as ClaudeRuntime;
    },
    log: (line) => process.stdout.write(`record-claude: ${line}\n`),
  });
  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  process.stdout.write(`record-claude: ${outcomes.length - failed.length} of ${outcomes.length} scenario(s) passed; recordings in ${parsed.outDir}\n`);
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT) {
  process.exitCode = await main(process.argv.slice(2));
}
