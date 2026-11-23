// The driver rules for the kiro driver.

import { KIRO_DEFAULT_CONFIG, kiroDriver } from "../../../src/drivers/kiro/index.ts";
import { meta } from "../../../src/meta/kiro.ts";
import { acpInstanceMembers, acpSessionMembers, driverRuleTests } from "../acp/driver-rules.ts";
import { KIRO_OPTIONS_V1 } from "./fixtures.ts";

driverRuleTests({
  kind: "kiro",
  driver: kiroDriver,
  meta,
  config: { ...KIRO_DEFAULT_CONFIG },
  executable: "kiro-cli",
  protocol: 1,
  agentArgs: ["--load", "--config-options", JSON.stringify(KIRO_OPTIONS_V1)],
  missing: { config: { ...KIRO_DEFAULT_CONFIG }, binary: "kiro-cli" },
  versions: { tested: "kiro-cli 3.0.0", testedVersion: "3.0.0", untested: "kiro-cli 2.40.1", untestedVersion: "2.40.1" },
  session: acpSessionMembers(false),
  instance: acpInstanceMembers(),
  launch: "kiro-cli acp --agent-engine=v3 --auth-method=cli",
});
