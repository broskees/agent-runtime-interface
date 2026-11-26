// The driver rules for the fx driver.

import { FX_DEFAULT_CONFIG, fxDriver } from "../../../src/drivers/fx/index.ts";
import { FX_UPDATE_STEP, meta } from "../../../src/meta/fx.ts";
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
  // fx's tested range is >=0.0.13 <0.0.18 (docs/drivers/fx.md, "Tested versions"); fx prints the bare version.
  versions: {
    minimum: "0.0.13",
    updateStep: FX_UPDATE_STEP,
    atMinimum: "0.0.13",
    aboveRange: "0.0.18",
    aboveVersion: "0.0.18",
    belowMinimum: "0.0.12",
    belowVersion: "0.0.12",
    realOutput: { file: "fx.txt", version: "0.0.17" },
  },
  session: acpSessionMembers(false),
  instance: acpInstanceMembers(),
  launch: "fx acp",
});
