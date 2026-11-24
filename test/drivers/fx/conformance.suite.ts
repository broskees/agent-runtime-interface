// The fx driver passes the conformance suite against the SDK-based fake ACP
// agent standing in for `fx acp`, offering fx's provider and model options.

import { FX_DEFAULT_CONFIG, fxDriver } from "../../../src/drivers/fx/index.ts";
import { acpConformance } from "../acp/conformance-suite.ts";
import { FX_OPTIONS_V1 } from "./fixtures.ts";

acpConformance({
  name: "fx driver",
  driver: fxDriver,
  config: { ...FX_DEFAULT_CONFIG },
  executable: "fx",
  protocol: 1,
  agentArgs: ["--config-options", JSON.stringify(FX_OPTIONS_V1), "--print-version", "fx 0.9.0"],
});
