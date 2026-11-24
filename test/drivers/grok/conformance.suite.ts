// The grok driver passes the conformance suite against the SDK-based fake ACP
// agent standing in for `grok agent stdio` (Grok speaks ACP v1).

import { GROK_DEFAULT_CONFIG, grokDriver } from "../../../src/drivers/grok/index.ts";
import { acpConformance } from "../acp/conformance-suite.ts";

acpConformance({
  name: "grok driver",
  driver: grokDriver,
  config: { ...GROK_DEFAULT_CONFIG },
  executable: "grok",
  protocol: 1,
  agentArgs: ["--print-version", "grok 1.0.70 (fake)"],
  inheritedCredentials: ["XAI_API_KEY"],
});
