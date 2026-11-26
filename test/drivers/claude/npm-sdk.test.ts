// The claude driver under Node with the SDK imported by name, as `npm
// install @anthropic-ai/claude-agent-sdk` leaves it: the SDK, and its native
// Claude Code package beside it. The driver runs the user's own Claude Code
// (`claude` on the host's PATH, or `executablePath`), never that native
// package, and the same version rule holds: a `claude` that is missing,
// prints no version or is older than the version the pinned SDK bundles
// leaves the driver unavailable and starts no session; a newer one runs with
// an advisory.
//
// Each case runs in a fresh Node process whose module hook resolves the
// package name to a fake SDK in a temp directory, with a decoy native package
// beside it (sdk-fixture.ts): the repository's own devDependency would bring
// the real native Claude Code. The user's Claude Code is a fake shell script.
// The child registers node:module hooks, which Bun lacks, so it runs on Node
// whichever runtime runs this test. Nothing reaches the network.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION } from "../../../src/meta/claude.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";
import { MINIMUM_VERSION_LINE, fakeClaudeInvocations, fakeClaudeSessions, writeFakeClaude, writeFixtureSdkDirectory } from "./sdk-fixture.ts";

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

/** A temp root with an npm install of the fake SDK and its decoy native package under `npm/`, an empty `bin/` (the host's PATH) and `project/`. */
function npmInstall(): { root: string; bin: string; project: string; sdkEntry: string; decoy: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-claude-npm-")));
  temporary.push(root);
  const decoy = writeFixtureSdkDirectory(path.join(root, "npm"), CLAUDE_SDK_VERSION, "the native package npm installed beside the SDK");
  const where = { root, bin: path.join(root, "bin"), project: path.join(root, "project"), sdkEntry: path.join(root, "npm", "node_modules", ...CLAUDE_SDK_PACKAGE.split("/"), "sdk.mjs"), decoy };
  fs.mkdirSync(where.bin);
  fs.mkdirSync(where.project);
  return where;
}

interface ChildRun {
  readonly status: { state: string; installed: boolean; version?: string; advisory?: { kind: string; message: string; currentVersion?: string; testedRange?: string }; error?: { code: string; message: string; binary?: string } };
  readonly advisory: unknown;
  readonly opened: "opened" | { code: string; message: string };
  readonly turn?: { status: string | undefined; events: string };
}

/** In a fresh Node process: the default claude driver, which imports the SDK by name, on Node host services whose PATH is `bin`; status, then one turn if a session opens. */
function inChild(where: ReturnType<typeof npmInstall>, config: { [field: string]: unknown }): ChildRun {
  const script = `
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const sdkUrl = pathToFileURL(${JSON.stringify(where.sdkEntry)}).href;
// The package name resolves to the npm install in the temp directory, as it would from a project that installed it.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === ${JSON.stringify(CLAUDE_SDK_PACKAGE)}) return { url: sdkUrl, format: "module", shortCircuit: true };
    return next(specifier, context);
  },
});
const load = (relative) => import(pathToFileURL(${JSON.stringify(REPO_ROOT)} + "/" + relative).href);
const { claudeDriver } = await load("src/drivers/claude/index.ts");
const { createCoordination, createNodeHostServices } = await load("src/node/index.ts");
const config = ${JSON.stringify(config)};
const host = await createNodeHostServices({
  hostRoot: ${JSON.stringify(path.join(where.root, "host"))},
  instanceId: "claude-npm",
  config: { get: async () => ({ config }) },
  attachments: { resolve: async () => null },
  hostTools: { mcpServerFor: async () => { throw new Error("this host serves no tools"); } },
  callbacks: { register: async (flowId) => ({ url: "http://127.0.0.1:9/" + flowId }) },
  coordination: createCoordination(),
  writeDiagnostic: () => undefined,
  baseEnv: { PATH: ${JSON.stringify(where.bin)} },
});
const instance = await claudeDriver.create(host, { instanceId: "claude-npm", config, environment: {} });
const status = await instance.status();
const advisory = await instance.maintenance.advisory().catch((error) => ({ rejected: error.callError ?? String(error) }));
let opened = "opened";
let turn;
try {
  const session = await instance.openSession({});
  const events = [];
  void (async () => { for await (const event of session.events()) events.push(event); })();
  const cwd = ${JSON.stringify(where.project)};
  const thread = await session.createThread({ cwd, policy: { mode: "approval_required", interaction: "default", cwd } });
  await session.startTurn({ threadId: thread.id, clientTurnKey: "npm-1", intent: "start", content: [{ type: "text", text: "Say hello" }] });
  const deadline = Date.now() + 15000;
  for (;;) {
    const terminal = events.find((event) => event.body.type === "turn.terminal");
    if (terminal !== undefined) { turn = { status: terminal.body.status, events: JSON.stringify(events) }; break; }
    if (Date.now() > deadline) { turn = { status: undefined, events: JSON.stringify(events) }; break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await session.close();
} catch (error) {
  opened = error.callError ? { code: error.callError.code, message: error.callError.message } : { code: "thrown", message: String(error) };
}
await instance.dispose();
await host.dispose();
process.stdout.write(JSON.stringify({ status, advisory, opened, turn }));
`;
  const output = execFileSync(NODE_EXECUTABLE, ["--input-type=module", "-e", script], { cwd: REPO_ROOT, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: where.root }, timeout: 60_000 });
  return JSON.parse(output) as ChildRun;
}

/** What the fixture SDK's reply says when the driver ran the Claude Code at `file`, which greets with `greeting`. */
function ranOn(file: string, greeting: string): string {
  return `from the Claude Code at ${file} (named in pathToClaudeCodeExecutable), which answered: ${greeting}`;
}

/** The driver is unavailable with `driver_unavailable`, openSession rejected the same way, and nothing started a Claude Code session. */
function refused(run: ChildRun, where: ReturnType<typeof npmInstall>, claude: string | undefined): string {
  assert.equal(run.status.state, "unavailable", JSON.stringify(run.status));
  assert.equal(run.status.installed, false);
  assert.equal(run.status.error?.code, "driver_unavailable");
  assert.deepEqual(run.opened, { code: "driver_unavailable", message: run.status.error?.message });
  if (claude !== undefined) assert.deepEqual(fakeClaudeSessions(claude), [], "no Claude Code session started");
  assert.deepEqual(fakeClaudeInvocations(where.decoy), [], "the native package npm installed beside the SDK never ran");
  return run.status.error!.message;
}

describe("the claude driver under Node, with the SDK and its native package installed by npm, runs the user's Claude Code", () => {
  test("a turn runs the claude on PATH, never the native package beside the SDK", () => {
    const where = npmInstall();
    const claude = writeFakeClaude(path.join(where.bin, "claude"), { versionLine: MINIMUM_VERSION_LINE, greeting: "the user's claude on PATH" });
    const run = inChild(where, {});
    assert.equal(run.status.state, "ready", JSON.stringify(run.status));
    assert.equal(run.status.version, CLAUDE_SDK_VERSION);
    assert.equal(run.status.advisory, undefined);
    assert.equal(run.turn?.status, "completed", run.turn?.events);
    assert.ok(run.turn?.events.includes(ranOn(claude, "the user's claude on PATH")), run.turn?.events);
    assert.equal(fakeClaudeSessions(claude).length, 1);
    assert.deepEqual(fakeClaudeInvocations(where.decoy), [], "the native package npm installed beside the SDK never ran");
  });

  test("with executablePath set, that Claude Code runs instead of the claude on PATH", () => {
    const where = npmInstall();
    const onPath = writeFakeClaude(path.join(where.bin, "claude"), { versionLine: MINIMUM_VERSION_LINE, greeting: "the user's claude on PATH" });
    const configured = writeFakeClaude(path.join(where.root, "elsewhere", "claude"), { versionLine: MINIMUM_VERSION_LINE, greeting: "the configured claude" });
    const run = inChild(where, { executablePath: configured });
    assert.equal(run.turn?.status, "completed", run.turn?.events);
    assert.ok(run.turn?.events.includes(ranOn(configured, "the configured claude")), run.turn?.events);
    assert.equal(fakeClaudeInvocations(configured)[0], "--version", "the driver checked the configured Claude Code's version before it ran it");
    assert.deepEqual(fakeClaudeInvocations(onPath), []);
    assert.deepEqual(fakeClaudeInvocations(where.decoy), []);
  });

  test("a claude older than the minimum is driver_unavailable naming its version, its path, the minimum and how to update", () => {
    const where = npmInstall();
    const claude = writeFakeClaude(path.join(where.bin, "claude"), { versionLine: "2.1.319 (Claude Code)", greeting: "an old claude" });
    const message = refused(inChild(where, {}), where, claude);
    assert.ok(message.startsWith(`Claude Code 2.1.319 at ${claude} is older than 2.1.330, the oldest version this driver runs (the one ${CLAUDE_SDK_PACKAGE} ${CLAUDE_SDK_VERSION} bundles).`), message);
    assert.match(message, /Update Claude Code to 2\.1\.330 or newer \(run claude update,/);
    assert.match(message, /set executablePath in the driver config/);
  });

  test("no claude at all is driver_unavailable saying Claude Code is not installed, how to install it, and executablePath", () => {
    const where = npmInstall();
    const message = refused(inChild(where, {}), where, undefined);
    assert.ok(message.startsWith("Claude Code is not installed: no claude executable was found on PATH."), message);
    assert.match(message, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
    assert.match(message, /set executablePath in the driver config/);
  });

  test("a claude whose version cannot be read is driver_unavailable naming its path and what it printed", () => {
    const where = npmInstall();
    const claude = writeFakeClaude(path.join(where.bin, "claude"), { versionLine: "Welcome to Claude!", greeting: "not a version" });
    const message = refused(inChild(where, {}), where, claude);
    assert.ok(message.startsWith(`The version of the Claude Code at ${claude} cannot be read: ${claude} --version exited with code 0 and printed "Welcome to Claude!".`), message);
  });

  test("a claude newer than the minimum is available with an untested_version advisory, and runs", () => {
    const where = npmInstall();
    const claude = writeFakeClaude(path.join(where.bin, "claude"), { versionLine: "2.2.0 (Claude Code)", greeting: "a newer claude" });
    const run = inChild(where, {});
    assert.equal(run.status.state, "ready", JSON.stringify(run.status));
    assert.deepEqual(run.status.advisory, {
      kind: "untested_version",
      message: `Claude Code 2.2.0 at ${claude} is newer than 2.1.330, the version this driver is tested against: it runs, but this version is untested.`,
      currentVersion: "2.2.0",
      testedRange: "2.1.330",
    });
    assert.deepEqual(run.advisory, run.status.advisory);
    assert.equal(run.turn?.status, "completed", run.turn?.events);
    assert.ok(run.turn?.events.includes(ranOn(claude, "a newer claude")), run.turn?.events);
    assert.deepEqual(fakeClaudeInvocations(where.decoy), []);
  });
});
