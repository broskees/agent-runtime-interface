// The antigravity driver passes the conformance suite against the SDK-based
// fake ACP agent standing in for `agy acp`. The fake host strips what the
// driver's CLI manifest names, which covers every ambient Google credential.

import { ANTIGRAVITY_DEFAULT_CONFIG, antigravityDriver } from "../../../src/drivers/antigravity/index.ts";
import { acpConformance } from "../acp/conformance-suite.ts";

acpConformance({
  name: "antigravity driver",
  driver: antigravityDriver,
  config: { ...ANTIGRAVITY_DEFAULT_CONFIG },
  executable: "agy",
  protocol: 1,
  agentArgs: ["--print-version", "agy 1.5.2"],
  inheritedCredentials: ["GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
});
