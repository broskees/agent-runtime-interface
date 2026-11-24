// The driver rules for the grok driver.

import { GROK_DEFAULT_CONFIG, grokDriver } from "../../../src/drivers/grok/index.ts";
import { meta } from "../../../src/meta/grok.ts";
import { acpInstanceMembers, acpSessionMembers, driverRuleTests } from "../acp/driver-rules.ts";

driverRuleTests({
  kind: "grok",
  driver: grokDriver,
  meta,
  config: { ...GROK_DEFAULT_CONFIG },
  executable: "grok",
  protocol: 1,
  missing: { config: { ...GROK_DEFAULT_CONFIG }, binary: "grok" },
  versions: { tested: "grok 1.0.70 (f50904eaee6c)", testedVersion: "1.0.70", untested: "grok 1.2.0 (0123456789ab)", untestedVersion: "1.2.0" },
  session: acpSessionMembers(false),
  instance: acpInstanceMembers(),
  launch: "grok --permission-mode default agent stdio",
});
