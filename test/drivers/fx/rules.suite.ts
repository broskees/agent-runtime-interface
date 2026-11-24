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
  agentArgs: ["--config-options", JSON.stringify(FX_OPTIONS_V1)],
  missing: { config: { ...FX_DEFAULT_CONFIG }, binary: "fx" },
  // fx's tested range is >=0.0.13 <0.0.18 (docs/drivers/fx.md, "Tested versions").
  versions: { tested: "fx 0.0.17", testedVersion: "0.0.17", untested: "fx 0.0.12", untestedVersion: "0.0.12" },
  session: acpSessionMembers(false),
  instance: acpInstanceMembers(),
  launch: "fx acp",
});
