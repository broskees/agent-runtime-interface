// The driver rules for the grok driver.

import { GROK_DEFAULT_CONFIG, grokDriver } from "../../../src/drivers/grok/index.ts";
import { GROK_UPDATE_STEP, meta } from "../../../src/meta/grok.ts";
import { acpInstanceMembers, acpSessionMembers, driverRuleTests } from "../acp/driver-rules.ts";

driverRuleTests({
  kind: "grok",
  driver: grokDriver,
  meta,
  config: { ...GROK_DEFAULT_CONFIG },
  executable: "grok",
  protocol: 1,
  missing: { config: { ...GROK_DEFAULT_CONFIG }, binary: "grok" },
  versions: {
    minimum: "1.0.70",
    updateStep: GROK_UPDATE_STEP,
    atMinimum: "grok 1.0.70 (f50904eaee6c)",
    aboveRange: "grok 1.2.0 (0123456789ab)",
    aboveVersion: "1.2.0",
    belowMinimum: "grok 1.0.69 (0123456789ab)",
    belowVersion: "1.0.69",
    realOutput: { file: "grok.txt", version: "1.0.70" },
  },
  session: acpSessionMembers(false),
  instance: acpInstanceMembers(),
  launch: "grok --permission-mode default agent stdio",
});
