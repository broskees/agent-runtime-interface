// The driver rules for the kiro driver.

import { KIRO_DEFAULT_CONFIG, kiroDriver } from "../../../src/drivers/kiro/index.ts";
import { KIRO_UPDATE_STEP, meta } from "../../../src/meta/kiro.ts";
import { acpInstanceMembers, acpSessionMembers, driverRuleTests } from "../acp/driver-rules.ts";
import { KIRO_OPTIONS_V1 } from "./fixtures.ts";

driverRuleTests({
  kind: "kiro",
  driver: kiroDriver,
  meta,
  config: { ...KIRO_DEFAULT_CONFIG },
  executable: "kiro-cli",
  protocol: 1,
  agentArgs: ["--load", "--config-options", JSON.stringify(KIRO_OPTIONS_V1), "--print-version", "kiro-cli 3.0.0"],
  missing: { config: { ...KIRO_DEFAULT_CONFIG }, binary: "kiro-cli" },
  versions: {
    minimum: "3.0.0",
    updateStep: KIRO_UPDATE_STEP,
    atMinimum: "kiro-cli 3.0.0",
    aboveRange: "kiro-cli 4.0.0",
    aboveVersion: "4.0.0",
    belowMinimum: "kiro-cli 2.40.1",
    belowVersion: "2.40.1",
    realOutput: { file: "kiro-cli.txt", version: "3.0.0" },
  },
  session: acpSessionMembers(false),
  instance: acpInstanceMembers(),
  launch: "kiro-cli acp --agent-engine=v3 --auth-method=cli",
});
