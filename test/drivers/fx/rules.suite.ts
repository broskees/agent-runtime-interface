// The driver rules for the fx driver.

import { FX_DEFAULT_CONFIG, fxDriver } from "../../../src/drivers/fx/index.ts";
import { meta } from "../../../src/meta/fx.ts";
import { acpInstanceMembers, acpSessionMembers, driverRuleTests } from "../acp/driver-rules.ts";
import { FX_OPTIONS_V1 } from "./fixtures.ts";

driverRuleTests({
  kind: "fx",
  driver: fxDriver,
  meta,
  config: { ...FX_DEFAULT_CONFIG },
  executable: "fx",
  protocol: 1,
  agentArgs: ["--config-options", JSON.stringify(FX_OPTIONS_V1), "--print-version", "fx 0.9.0"],
  missing: { config: { ...FX_DEFAULT_CONFIG }, binary: "fx" },
  reportedVersion: "0.9.0",
  session: acpSessionMembers(false),
  instance: acpInstanceMembers(),
  launch: "fx acp",
});
