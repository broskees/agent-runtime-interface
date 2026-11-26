// The driver rules for the antigravity driver, which runs the user's own
// `agy` and has no `maintenance` member: ARI never installs `agy`.

import { ANTIGRAVITY_DEFAULT_CONFIG, antigravityDriver } from "../../../src/drivers/antigravity/index.ts";
import { ANTIGRAVITY_UPDATE_STEP, meta } from "../../../src/meta/antigravity.ts";
import { acpInstanceMembers, acpSessionMembers, driverRuleTests } from "../acp/driver-rules.ts";

driverRuleTests({
  kind: "antigravity",
  driver: antigravityDriver,
  meta,
  config: { ...ANTIGRAVITY_DEFAULT_CONFIG },
  executable: "agy",
  protocol: 1,
  // `agy --version` prints the bare version (test/fixtures/cli-version-output/agy.txt).
  agentArgs: ["--print-version", "1.5.17"],
  missing: { config: { ...ANTIGRAVITY_DEFAULT_CONFIG }, binary: "agy" },
  versions: {
    minimum: "1.5.0",
    updateStep: ANTIGRAVITY_UPDATE_STEP,
    atMinimum: "1.5.0",
    aboveRange: "1.6.0",
    aboveVersion: "1.6.0",
    belowMinimum: "1.4.9",
    belowVersion: "1.4.9",
    realOutput: { file: "agy.txt", version: "1.5.17" },
  },
  session: acpSessionMembers(false, { rollbackThread: "unsupported" }),
  instance: acpInstanceMembers(),
  launch: "agy acp --gemini-dir",
});
