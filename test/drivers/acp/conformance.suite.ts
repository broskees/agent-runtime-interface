// The ACP base driver passes the conformance suite against an agent written
// with the official ACP SDK, once over ACP v1 and once over ACP v2. The agent
// forks into another directory (`--fork-cross-cwd`): with its default config
// the driver asks for such forks and declares `crossCwd`, so the kit checks
// that they work. An agent that refuses one is in protocol.suite.ts.

import { ACP_DEFAULT_CONFIG, acpDriver } from "../../../src/drivers/acp/index.ts";
import { acpConformance } from "./conformance-suite.ts";

acpConformance({
  name: "acp driver, ACP v1 agent",
  driver: acpDriver,
  config: { ...ACP_DEFAULT_CONFIG, command: "fake-acp-agent", maxProtocolVersion: 1 },
  executable: "fake-acp-agent",
  protocol: 1,
  agentArgs: ["--fork", "--fork-cross-cwd", "--meta"],
});

acpConformance({
  name: "acp driver, ACP v2 agent",
  driver: acpDriver,
  config: { ...ACP_DEFAULT_CONFIG, command: "fake-acp-agent", maxProtocolVersion: 2 },
  executable: "fake-acp-agent",
  protocol: 2,
  agentArgs: ["--fork", "--fork-cross-cwd", "--meta"],
});
