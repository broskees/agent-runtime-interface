// The fake pi finds a session by id the way pinned Pi does. Pi's own
// SessionManager (the pinned package) writes the stored session and shows
// which lookups find it: by id, a session made in the directory pi starts in
// is a local match, and one made elsewhere only a global one. For a global
// match `pi --session <id>` asks "Fork this session into current directory?"
// on stdin before RPC starts, and on any answer but y or yes prints
// "Aborted." and exits 0 without answering (dist/main.js 227–253, 347–360).
// The fake must answer, ask and exit the same way; the driver never gives Pi
// a bare id (quirks.test.ts).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { FAKE_PI, framesUnder } from "./harness.ts";
import { checkRunsAgainstPiTypes } from "./pi-types.ts";

/** The parts of Pi's SessionManager this test uses. The pinned package's own declarations do not compile under this repository's settings, so the import is untyped. */
interface PiSessionManager {
  getSessionFile(): string | undefined;
  getSessionId(): string;
  appendMessage(message: { role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }): string;
}
const PI_PACKAGE: string = "@earendil-works/pi-coding-agent";
const { SessionManager } = (await import(PI_PACKAGE)) as {
  SessionManager: {
    create(cwd: string, sessionDir: string): PiSessionManager;
    findById(cwd: string, id: string, sessionDir: string): string | undefined;
    listAll(sessionDir: string): Promise<Array<{ id: string; path: string; cwd: string }>>;
  };
};

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-pi-fake-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, "home");
const sessions = path.join(root, "sessions");
const workspaceA = path.join(root, "workspace-a");
const workspaceB = path.join(root, "workspace-b");
for (const directory of [home, sessions, workspaceA, workspaceB]) fs.mkdirSync(directory);

// A session Pi itself stored, made in workspace A.
const stored = SessionManager.create(workspaceA, sessions);
stored.appendMessage({ role: "user", content: [{ type: "text", text: "Asked in workspace A." }], timestamp: Date.now() });
const storedId = stored.getSessionId();
const storedFile = stored.getSessionFile()!;

interface FakeRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The RPC responses the fake wrote. */
  readonly responses: Array<{ command?: string; success?: boolean; data?: { sessionId?: string; sessionFile?: string } }>;
}

/** Runs the fake in `cwd`, writes `input`, and ends its input once it answered a command or exited. */
async function runFake(cwd: string, args: readonly string[], input: string): Promise<FakeRun> {
  const child = spawn(process.execPath, [FAKE_PI, "--mode", "rpc", "--session-dir", sessions, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", HOME: home, FAKE_PI_TRACE_DIRECTORY: path.join(root, "traces") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  child.stdin.on("error", () => undefined);
  child.stdin.write(input);
  const deadline = Date.now() + 10_000;
  let code: number | null | undefined;
  void exited.then((value) => (code = value));
  while (code === undefined && !stdout.includes('"type":"response"') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  child.stdin.end();
  const finalCode = await exited;
  // The question ends without a newline, so the first JSON line after a "y" follows it on the same line.
  const responses = stdout
    .split("\n")
    .filter((line) => line.includes("{"))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as FakeRun["responses"][number] & { type?: string })
    .filter((record) => record.type === "response");
  return { code: finalCode, stdout, stderr, responses };
}

const GET_STATE = `${JSON.stringify({ id: "probe-1", type: "get_state" })}\n`;

test("Pi's own lookup: by id, the stored session is a local match only from the directory it was made in", async () => {
  assert.equal(SessionManager.findById(workspaceA, storedId, sessions), storedFile);
  assert.equal(SessionManager.findById(workspaceB, storedId, sessions), undefined);
  assert.ok((await SessionManager.listAll(sessions)).some((session) => session.id === storedId && session.cwd === workspaceA));
});

test("from the directory the session was made in, pi --session <id> opens it and answers over RPC", async () => {
  const run = await runFake(workspaceA, ["--session", storedId], GET_STATE);
  assert.equal(run.responses[0]?.data?.sessionId, storedId);
  assert.equal(run.responses[0]?.data?.sessionFile, storedFile);
});

test("from another directory, pi --session <id> asks to fork on stdin, takes the RPC command as its answer, and exits without answering", async () => {
  const run = await runFake(workspaceB, ["--session", storedId], GET_STATE);
  assert.equal(run.code, 0);
  assert.match(run.stdout, new RegExp(`Session found in different project: ${workspaceA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n`));
  assert.match(run.stdout, /Fork this session into current directory\? \[y\/N\] Aborted\.\n/);
  assert.deepEqual(run.responses, [], "no RPC answer");
});

test("answering y forks the session into the current directory; pi --fork <id> forks without asking", async () => {
  const confirmed = await runFake(workspaceB, ["--session", storedId], `y\n${GET_STATE}`);
  const forkedFile = confirmed.responses[0]?.data?.sessionFile;
  assert.ok(forkedFile !== undefined, confirmed.stdout + confirmed.stderr);
  assert.notEqual(confirmed.responses[0]?.data?.sessionId, storedId);
  const header = JSON.parse(fs.readFileSync(forkedFile, "utf8").split("\n")[0]!) as { cwd?: string; parentSession?: string };
  assert.equal(header.cwd, workspaceB);
  assert.equal(header.parentSession, storedFile);

  const forked = await runFake(workspaceB, ["--fork", storedId], GET_STATE);
  assert.doesNotMatch(forked.stdout, /Fork this session/);
  assert.notEqual(forked.responses[0]?.data?.sessionId, storedId);
});

test("an id no session has makes pi exit 1", async () => {
  const run = await runFake(workspaceB, ["--session", "ffffffff-0000-4000-8000-000000000000"], GET_STATE);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /No session found matching 'ffffffff-0000-4000-8000-000000000000'/);
});

test("every frame and session file line of these runs matches Pi's published types", () => {
  const frames = framesUnder(root);
  assert.ok(frames.length > 0);
  assert.deepEqual(checkRunsAgainstPiTypes([{ frames, root }]).diagnostics, []);
});
