// The kiro driver passes the conformance suite against the SDK-based fake ACP
// agent standing in for `kiro-cli acp --agent-engine=v3`, which, like Kiro,
// loads stored sessions with `session/load` and offers an `autopilot` option.

import { KIRO_DEFAULT_CONFIG, kiroDriver } from "../../../src/drivers/kiro/index.ts";
import { acpConformance } from "../acp/conformance-suite.ts";
import { KIRO_OPTIONS_V1 } from "./fixtures.ts";

acpConformance({
  name: "kiro driver",
  driver: kiroDriver,
  config: { ...KIRO_DEFAULT_CONFIG },
  executable: "kiro-cli",
  protocol: 1,
  agentArgs: ["--load", "--config-options", JSON.stringify(KIRO_OPTIONS_V1), "--print-version", "kiro-cli 3.0.0"],
});
