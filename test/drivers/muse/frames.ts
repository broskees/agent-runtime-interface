// Every MSP frame the fake Muse host and the driver exchange, type-checked
// against the pinned SDK's own wire types (@muse-code/sdk 1.4.25,
// dist/src/msp.js): each frame becomes a typed object literal in a generated
// TypeScript file that the TypeScript compiler checks, so a missing required
// member, a wrong type, an unknown member or a method the stable surface does
// not list is a compile error naming the frame.
//
// The fake records every frame it reads or writes into `FRAME_LOG`. Importing
// this module registers a `node:test` `after` hook on the importing test
// file's root, so every test file that runs the fake checks all of its frames
// when it ends, and fails when one does not type-check.

import * as path from "node:path";
import { after } from "node:test";
import ts from "typescript";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
/** The generated file lives beside this one, so `@muse-code/sdk` resolves from this repository's own node_modules. */
const CHECK_FILE = path.join(HERE, "__muse_frames_check__.ts");

/** Which side wrote the frame: the driver's SDK connection (`client`) or the Muse host (`server`). */
export type FrameDirection = "client" | "server";

export interface RecordedFrame {
  readonly direction: FrameDirection;
  /** `request`, `notification`, `result` or `error`. */
  readonly shape: "request" | "notification" | "result" | "error";
  /** The method: of the request, the notification, or the request a response answers. */
  readonly method: string;
  readonly frame: unknown;
}

export interface FrameProblem {
  readonly frame: RecordedFrame;
  readonly message: string;
}

/** The type each frame must have, by direction and shape. Requests and notifications the client sends; results and errors and server requests the host sends; and the client's results for server requests. */
function frameType(frame: RecordedFrame): string {
  const method = JSON.stringify(frame.method);
  if (frame.shape === "error") return "WireError";
  if (frame.direction === "client") {
    if (frame.shape === "request") return `ClientRequest<${method}>`;
    if (frame.shape === "notification") return `WireNotification<${method}>`;
    return `ClientResult<${method}>`;
  }
  if (frame.shape === "request") return `ServerRequest<${method}>`;
  if (frame.shape === "notification") return `WireNotification<${method}>`;
  return `ServerResult<${method}>`;
}

const PRELUDE = `import type { ErrorObject, JsonRpcVersion, MspMethodMap, MspNotificationMap, MspServerRequestMap, RequestId } from "@muse-code/sdk/dist/src/msp.js";
type Params<P> = [P] extends [undefined] ? { params?: undefined } : { params: P };
type ClientRequest<M extends keyof MspMethodMap> = { jsonrpc: JsonRpcVersion; id: RequestId; method: M } & Params<MspMethodMap[M]["params"]>;
type ServerResult<M extends keyof MspMethodMap> = { jsonrpc: JsonRpcVersion; id: RequestId; result: MspMethodMap[M]["result"] };
type ServerRequest<M extends keyof MspServerRequestMap> = { jsonrpc: JsonRpcVersion; id: RequestId; method: M; params: MspServerRequestMap[M]["params"] };
type ClientResult<M extends keyof MspServerRequestMap> = { jsonrpc: JsonRpcVersion; id: RequestId; result: MspServerRequestMap[M]["result"] };
type WireNotification<M extends keyof MspNotificationMap> = { jsonrpc: JsonRpcVersion; method: M; emittedAtMs?: number } & Params<MspNotificationMap[M]>;
type WireError = { jsonrpc: JsonRpcVersion; id: RequestId | null; error: ErrorObject };
`;

function compilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(REPO_ROOT, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (parsed === undefined) throw new Error("tsconfig.json did not parse");
  return { ...parsed.options, noEmit: true };
}

/** Type-checks `frames` against the SDK's wire types and returns each frame that does not check, with the compiler's message. */
export function checkFrames(frames: readonly RecordedFrame[]): FrameProblem[] {
  if (frames.length === 0) return [];
  const lines = [PRELUDE];
  const firstLine = PRELUDE.split("\n").length;
  frames.forEach((frame, index) => {
    lines.push(`export const frame${index}: ${frameType(frame)} = ${JSON.stringify(frame.frame)};`);
  });
  const text = lines.join("\n");
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (fileName) => (path.resolve(fileName) === CHECK_FILE ? text : readFile(fileName));
  host.fileExists = (fileName) => path.resolve(fileName) === CHECK_FILE || fileExists(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    path.resolve(fileName) === CHECK_FILE ? ts.createSourceFile(fileName, text, languageVersion, true) : getSourceFile(fileName, languageVersion, onError, shouldCreate);
  const program = ts.createProgram({ rootNames: [CHECK_FILE], options, host });
  const source = program.getSourceFile(CHECK_FILE);
  if (source === undefined) throw new Error("the generated frame check file did not load");
  const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  const problems: FrameProblem[] = [];
  for (const diagnostic of diagnostics) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      problems.push({ frame: { direction: "client", shape: "request", method: "(prelude)", frame: null }, message });
      continue;
    }
    const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line;
    // The prelude ends with a newline and the join adds one more, so frame 0 is on line `firstLine` (0-based).
    const index = line - firstLine;
    const frame = frames[index] ?? { direction: "client" as const, shape: "request" as const, method: "(prelude)", frame: null };
    problems.push({ frame, message });
  }
  return problems;
}

/** The frames this test process recorded, oldest first. */
export class FrameLog {
  readonly frames: RecordedFrame[] = [];

  record(frame: RecordedFrame): void {
    this.frames.push(frame);
  }

  /** The frames once each: equal frames type-check alike. */
  distinct(): RecordedFrame[] {
    const seen = new Set<string>();
    const kept: RecordedFrame[] = [];
    for (const frame of this.frames) {
      const key = JSON.stringify([frame.direction, frame.shape, frame.method, frame.frame]);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(frame);
    }
    return kept;
  }
}

/** Every frame of this test process. */
export const FRAME_LOG = new FrameLog();

/** Every host the fake started in this test process, so the check can tell a test file that ran Muse from one that did not. */
export const HOSTS_STARTED = { count: 0 };

function describe(problem: FrameProblem): string {
  const frame = JSON.stringify(problem.frame.frame);
  return `${problem.frame.direction} ${problem.frame.shape} ${problem.frame.method}: ${problem.message.split("\n").slice(0, 4).join(" / ")}\n  ${frame.length > 400 ? `${frame.slice(0, 400)}...` : frame}`;
}

after(() => {
  if (HOSTS_STARTED.count === 0) return;
  if (FRAME_LOG.frames.length === 0) throw new Error(`the fake Muse host started ${HOSTS_STARTED.count} times but recorded no frame`);
  const problems = checkFrames(FRAME_LOG.distinct());
  if (problems.length > 0) {
    throw new Error(`${problems.length} MSP frames do not type-check against @muse-code/sdk 1.4.25:\n${problems.slice(0, 10).map(describe).join("\n")}`);
  }
});
