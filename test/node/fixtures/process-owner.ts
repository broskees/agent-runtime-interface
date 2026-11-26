// A host process for test/node/owner-death.test.ts: it uses ari/node's
// process service directly (no ari-driver), starts one fake agent of each
// kind its arguments name, prints `[{ pid, grandchildPid }]` as one JSON line,
// and then waits to be killed.
//
//   node test/node/fixtures/process-owner.ts plain ignore-term

import { createProcessService } from "../../../src/node/index.ts";
import { fakeAgentArgs, readFirstLine } from "../../helpers/fake-agent.ts";
import type { FakeAgentKind } from "../../helpers/fake-agent.ts";

const service = createProcessService({ envPolicy: { stripAmbient: [] } });
const agents: Array<{ pid: number; grandchildPid: number }> = [];
for (const kind of process.argv.slice(2) as FakeAgentKind[]) {
  const child = await service.spawn({ command: "/bin/sh", args: fakeAgentArgs(kind), purpose: "runtime" });
  agents.push({ pid: child.pid!, grandchildPid: Number(await readFirstLine(child.stdout)) });
}
process.stdout.write(`${JSON.stringify(agents)}\n`);
setInterval(() => undefined, 60_000);
