// The driver rules (honest optional members, a missing agent, host prompts and
// names, metadata) for the ACP base driver, over ACP v2.

import { ACP_DEFAULT_CONFIG, acpDriver } from "../../../src/drivers/acp/index.ts";
import { meta } from "../../../src/meta/acp.ts";
import { acpInstanceMembers, acpSessionMembers, driverRuleTests } from "./driver-rules.ts";

driverRuleTests({
  kind: "acp",
  driver: acpDriver,
  meta,
  config: { ...ACP_DEFAULT_CONFIG, command: "fake-acp-agent", maxProtocolVersion: 2 },
  executable: "fake-acp-agent",
  protocol: 2,
  agentArgs: ["--fork"],
  missing: { config: { ...ACP_DEFAULT_CONFIG, command: "missing-acp-agent" }, binary: "missing-acp-agent" },
  reportedVersion: "1.4.2",
  session: acpSessionMembers(true),
  instance: acpInstanceMembers(),
  launch: "configured `command`",
});
