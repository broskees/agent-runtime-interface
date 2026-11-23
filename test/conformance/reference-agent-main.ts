// The reference agent as a real process. The protocol runs on stdin and
// stdout; the conformance harness drives the agent's puppet over the Node IPC
// channel: it sends `{ id, method, args }` and gets `{ id, result }` or
// `{ id, error }` back, and the agent sends `{ event: "turn", turnId, prompt }`
// for every turn it starts.
//
//   node reference-agent-main.ts [--version | --auth-status | --session-dir <dir>] --ambient-auth=<state>

import * as fs from "node:fs";
import { ReferenceAgent } from "../../src/conformance/index.ts";
import type { ReferenceAmbientAuth } from "../../src/conformance/index.ts";
import { FileReferenceStore } from "./file-store.ts";

const ambientFlag = process.argv.find((argument) => argument.startsWith("--ambient-auth="));
const ambientAuth = (ambientFlag?.slice("--ambient-auth=".length) ?? "authenticated") as ReferenceAmbientAuth;
const argv = process.argv.slice(2).filter((argument) => argument !== ambientFlag);

const send = (message: unknown): void => {
  if (process.connected) process.send?.(message);
};

const agent = new ReferenceAgent({
  argv,
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  io: {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    exit: (code) => {
      // Let stdout drain, then go.
      process.stdout.write("", () => process.exit(code ?? 1));
    },
  },
  storeFor: (directory) => new FileReferenceStore(directory),
  realpath: (path) => fs.realpathSync(path),
  ambientAuth,
  onTurn: (turn) => send({ event: "turn", ...turn }),
});

process.stdin.on("data", (chunk: Buffer) => agent.receive(new Uint8Array(chunk)));
process.stdin.on("end", () => agent.closeStdin());

type PuppetMethod =
  | "say"
  | "runTool"
  | "requestApproval"
  | "approvalReplies"
  | "nextApprovalReply"
  | "startBackgroundTask"
  | "spawnSubagent"
  | "nextSteer"
  | "complete"
  | "fail"
  | "stopRequested"
  | "finishCancelled"
  | "exitProcess";

process.on("message", (message: { id: number; method: PuppetMethod; args: unknown[] }) => {
  const call = agent[message.method] as (...args: unknown[]) => unknown;
  Promise.resolve()
    .then(() => call.apply(agent, message.args))
    .then(
      (result) => send({ id: message.id, result: result ?? null }),
      (error: unknown) => send({ id: message.id, error: error instanceof Error ? error.message : String(error) }),
    );
});

agent.start();
