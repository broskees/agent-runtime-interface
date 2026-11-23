// The driver rules for the antigravity driver, with the user's own CLI
// (`installation: "path"`). Managed installs, which add `maintenance`, are
// tested in antigravity.test.ts.

import { ANTIGRAVITY_DEFAULT_CONFIG, antigravityDriver } from "../../../src/drivers/antigravity/index.ts";
import { meta } from "../../../src/meta/antigravity.ts";
import { acpInstanceMembers, acpSessionMembers, driverRuleTests } from "../acp/driver-rules.ts";

driverRuleTests({
  kind: "antigravity",
  driver: antigravityDriver,
  meta,
  config: { ...ANTIGRAVITY_DEFAULT_CONFIG },
  executable: "agy",
  protocol: 1,
  missing: { config: { ...ANTIGRAVITY_DEFAULT_CONFIG }, binary: "agy" },
  versions: { tested: "agy 1.5.2", testedVersion: "1.5.2", untested: "agy 1.6.0", untestedVersion: "1.6.0" },
  session: acpSessionMembers(false, { rollbackThread: "unsupported" }),
  instance: acpInstanceMembers(),
  launch: "agy acp --gemini-dir",
});
