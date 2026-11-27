// The `claude` driver through the standalone `ari-driver`, which has the
// pinned Claude Agent SDK's JavaScript compiled in (scripts/build-binary.ts)
// and no Claude Code. With a PATH that holds no `node` and no `bun` (only,
// where a test says so, a fake of the user's Claude Code), an environment of
// nothing but a temp HOME, no driver config and no SDK on disk:
//   - status reports the compiled-in SDK's version, and a turn completes
//     through that SDK on the fake `claude` on PATH; with `executablePath`
//     set to a second fake, that one runs instead;
//   - a `claude` older than the minimum, or none at all, leaves the driver
//     `driver_unavailable` with the fix in the message, `openSession` rejects
//     the same way, and no Claude Code session starts;
//   - Claude Code, the child it started, its guard and its group end within
//     5 s of SIGKILLing ari-driver;
//   - the binary holds the SDK's code and no Claude Code executable.
// The turn and death cases run again through `ari-driver` under Node (the
// package's bin, dist/wire/cli.js), where the SDK comes from package
// resolution: a module hook resolves its name to a copy of the pinned
// sdk.mjs in the temp root, beside a decoy native Claude Code package, so the
// repository's own install, beside the real native Claude Code, never loads.
// The fakes of the user's Claude Code are shell scripts; nothing reaches the
// network or starts a real Claude Code.
//
// The gate runs it after the binary build (`pnpm run test:binary`).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLAUDE_SDK_CODE_MARKER } from "../../scripts/check-package.ts";
import type { AriEvent } from "../../src/index.ts";
import { CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION } from "../../src/meta/claude.ts";
import { createCoordination, createNodeHostServices } from "../../src/node/index.ts";
import { startAriDriver } from "../../src/wire/index.ts";
import { MINIMUM_VERSION_LINE, fakeClaudeInvocations, fakeClaudeSessions, sdkNativePackage, writeDecoyNativePackage, writeFakeClaude } from "../drivers/claude/sdk-fixture.ts";
import { NODE_EXECUTABLE } from "../helpers/runtime.ts";
import { killRecorded, recordAgents, survivorsAt } from "../helpers/process-groups.ts";
import type { RecordedAgent } from "../helpers/process-groups.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARI_DRIVER = path.join(ROOT, "build", "standalone", "linux-x64", "ari-driver");
const NODE_ARI_DRIVER = path.join(ROOT, "dist", "wire", "cli.js");
/** The pinned SDK as the lockfile installed it. */
const PINNED_SDK = fs.realpathSync(path.join(ROOT, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/")));

/**
 * A string unique to the SDK's sdk.mjs: the environment variable it sets for
 * every Claude Code process it starts. ARI's own code never names it.
 */
const SDK_MARKER = "CLAUDE_CODE_SDK_READS_SESSION_STATE";

/**
 * A string in Claude Code's own code, its system prompt, and not in the SDK's
 * sdk.mjs or ARI's code: a file that contains it holds Claude Code.
 */
const CLAUDE_CODE_MARKER = "You are Claude Code, Anthropic's official CLI for Claude";

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

/** A temp root with an empty `bin/` (the whole PATH, of the driver and of the host), `home/`, `project/` and the host's directory. */
function nodeFreeRoot(): { root: string; bin: string; project: string; env: { [name: string]: string } } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-standalone-claude-")));
  temporary.push(root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  for (const directory of [bin, home, project]) fs.mkdirSync(directory);
  const env = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  };
  assert.deepEqual(fs.readdirSync(bin), [], "the PATH holds nothing, so no node and no bun");
  return { root, bin, project, env };
}

type Where = ReturnType<typeof nodeFreeRoot>;

interface Runtime {
  readonly name: string;
  readonly built: string;
  /** The command that serves a driver; under Node it also lays out the SDK it resolves under `where.root` and returns the decoy beside it. */
  readonly start: (where: Where) => { readonly command: readonly string[]; readonly decoy?: string };
}

const STANDALONE: Runtime = { name: "the standalone ari-driver", built: "pnpm run build:binary", start: () => ({ command: [ARI_DRIVER] }) };

const UNDER_NODE: Runtime = {
  name: "ari-driver under Node",
  built: "pnpm run build",
  start(where) {
    const nodeModules = path.join(where.root, "sdk", "node_modules");
    const sdkPackage = path.join(nodeModules, ...CLAUDE_SDK_PACKAGE.split("/"));
    fs.mkdirSync(sdkPackage, { recursive: true });
    for (const file of ["package.json", "sdk.mjs"]) fs.copyFileSync(path.join(PINNED_SDK, file), path.join(sdkPackage, file));
    const decoy = writeDecoyNativePackage(nodeModules, "the native package beside the SDK");
    const hook = path.join(where.root, "resolve-sdk.mjs");
    fs.writeFileSync(
      hook,
      `// The package name resolves to the copy of the pinned SDK, as it would from a project that installed it there.
import { registerHooks } from "node:module";
const sdk = ${JSON.stringify(pathToFileURL(path.join(sdkPackage, "sdk.mjs")).href)};
registerHooks({ resolve: (specifier, context, next) => (specifier === ${JSON.stringify(CLAUDE_SDK_PACKAGE)} ? { url: sdk, format: "module", shortCircuit: true } : next(specifier, context)) });
`,
    );
    return { command: [NODE_EXECUTABLE, "--import", pathToFileURL(hook).href, NODE_ARI_DRIVER], decoy };
  },
};

function requireBuilt(runtime: Runtime): void {
  const file = runtime === STANDALONE ? ARI_DRIVER : NODE_ARI_DRIVER;
  assert.ok(fs.existsSync(file), `${path.relative(ROOT, file)} is missing; run \`${runtime.built}\` first`);
}

for (const { runtime, delegateProcesses } of [
  { runtime: UNDER_NODE, delegateProcesses: false },
  { runtime: STANDALONE, delegateProcesses: false },
  { runtime: UNDER_NODE, delegateProcesses: true },
]) {
  test(`the pinned SDK's Claude Code, grandchild, guard and group end within 5 s of SIGKILLing ${runtime.name}${delegateProcesses ? " with host-delegated processes" : ""}`, async () => {
    requireBuilt(runtime);
    const where = nodeFreeRoot();
    const { command } = runtime.start(where);
    const marker = path.join(where.project, "turn-started");
    // No JS runtime, even by absolute path. Stay alive after stdin EOF: only
    // the process guard should end the fake and the child it started.
    fs.writeFileSync(path.join(where.bin, "claude"), `#!/bin/sh
case "$1" in
  --version) echo '2.1.330 (Claude Code)'; exit;;
  auth) echo '{"loggedIn":false}'; exit;;
esac
while IFS= read -r line; do
  case "$line" in
    *'"type":"control_request"'*)
      id=\${line#*'"request_id":"'}
      id=\${id%%'"'*}
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[],"models":[],"account":{},"added":[],"removed":[],"errors":{}}}}\\n' "$id";;
    *'"type":"user"'*) break;;
  esac
done
/bin/sleep 120 &
printf '%s %s\\n' "$$" "$!" > turn-started
wait
`, { mode: 0o755 });
    const agents: RecordedAgent[] = [];
    const config = {};
    const host = await createNodeHostServices<typeof config>({
      hostRoot: path.join(where.root, "host"),
      instanceId: "claude-death",
      config: { get: async () => ({ config }) },
      attachments: { resolve: async () => null },
      hostTools: { mcpServerFor: async () => { throw new Error("the fixture offers no tools"); } },
      callbacks: { register: async () => { throw new Error("the fixture offers no sign-in"); } },
      coordination: createCoordination(),
      writeDiagnostic: () => undefined,
      baseEnv: where.env,
    });
    const connection = await startAriDriver({ driver: "claude", command: [...command], env: where.env, cwd: where.project, envPolicy: { stripAmbient: [] }, delegateProcesses });
    const exited = new Promise((resolve) => connection.child.once("exit", (_code, signal) => resolve(signal)));
    let reported: { pid: number; grandchildPid: number } | undefined;
    try {
      const instance = await connection.driver.create(host, { instanceId: "claude-death", config, environment: where.env });
      const session = await instance.openSession({ handshakeTimeoutMs: 15_000 });
      const thread = await session.createThread({ cwd: where.project, policy: { mode: "approval_required", interaction: "default", cwd: where.project } });
      await session.startTurn({ threadId: thread.id, clientTurnKey: "fixture-death", intent: "start", content: [{ type: "text", text: "fixture" }] });
      const deadline = Date.now() + 15_000;
      while (reported === undefined) {
        const pids = fs.existsSync(marker) && /^(\d+) (\d+)\n$/.exec(fs.readFileSync(marker, "utf8"));
        if (pids) reported = { pid: Number(pids[1]), grandchildPid: Number(pids[2]) };
        else if (Date.now() >= deadline) throw new Error("fake Claude Code did not read its prompt");
        else await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Record the group assertion without stopping the death experiment on
      // a regression. The old SDK-local spawn shares this test's group.
      let guardError: unknown;
      try { await recordAgents(agents, [reported]); } catch (error) { guardError = error; }
      const killedAt = Date.now();
      assert.equal(connection.child.kill("SIGKILL"), true);
      const survivors = await survivorsAt(agents, killedAt + 5_000);
      assert.equal(await exited, "SIGKILL");
      assert.deepEqual(survivors, [], `the SDK child must use a guarded group: ${String(guardError ?? "")}`);
      if (guardError !== undefined) throw guardError;
    } finally {
      connection.child.kill("SIGKILL");
      try {
        await connection.close();
      } finally {
        // killRecorded signals only the individual fixture pids if they share
        // an inherited group (the SDK-local-spawn regression case).
        killRecorded(agents);
        await host.dispose();
      }
    }
  });
}

/**
 * Writes a fake of the user's Claude Code for the real SDK at `file`, in
 * shell built-ins only, so it runs with no PATH at all. It appends each
 * invocation's arguments to `<file>.log` (see `fakeClaudeInvocations`), and
 * for a launch also the SDK's `CLAUDE_CODE_ENTRYPOINT` and
 * `CLAUDE_AGENT_SDK_VERSION` from its environment. It answers `--version`
 * with `versionLine`, `auth status` with a signed-out report, every control
 * request with success, and each prompt with an init message, one assistant
 * message whose text is `reply`, and a success result.
 */
function writeStreamJsonClaude(file: string, options: { readonly versionLine: string; readonly reply: string }): string {
  assert.match(options.versionLine + options.reply, /^[\w .()-]+$/, "the fake prints these inside single quotes and JSON strings");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const usage = '{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}';
  fs.writeFileSync(file, `#!/bin/sh
printf '%s\\n' "$*" >> "$0.log"
case "$1" in
  --version) echo '${options.versionLine}'; exit;;
  auth) echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'; exit;;
esac
printf 'launched by CLAUDE_CODE_ENTRYPOINT=%s CLAUDE_AGENT_SDK_VERSION=%s\\n' "$CLAUDE_CODE_ENTRYPOINT" "$CLAUDE_AGENT_SDK_VERSION" >> "$0.log"
session=
for argument in "$@"; do
  case "$argument" in --session-id=*) session=\${argument#--session-id=};; esac
done
while IFS= read -r line; do
  case "$line" in
    *'"type":"control_request"'*)
      id=\${line#*'"request_id":"'}
      id=\${id%%'"'*}
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[],"models":[],"account":{},"added":[],"removed":[],"errors":{}}}}\\n' "$id";;
    *'"type":"user"'*)
      prompt=\${line#*'"uuid":"'}
      prompt=\${prompt%%'"'*}
      printf '{"type":"system","subtype":"init","uuid":"00000000-0000-4000-8000-000000000001","session_id":"%s","cwd":"%s","model":"fake-model","claude_code_version":"2.1.330","slash_commands":[],"permissionMode":"default","tools":[],"mcp_servers":[]}\\n' "$session" "$PWD"
      printf '{"type":"assistant","uuid":"00000000-0000-4000-8000-000000000002","session_id":"%s","parent_tool_use_id":null,"message":{"id":"msg_fake_1","type":"message","role":"assistant","model":"fake-model","content":[{"type":"text","text":"${options.reply}"}],"stop_reason":"end_turn","usage":${usage}}}\\n' "$session"
      printf '{"type":"result","subtype":"success","uuid":"00000000-0000-4000-8000-000000000003","session_id":"%s","is_error":false,"num_turns":1,"total_cost_usd":0,"duration_ms":1,"duration_api_ms":1,"usage":${usage},"modelUsage":{},"permission_denials":[],"result":"${options.reply}","stop_reason":"end_turn","terminal_reason":"completed","user_message_uuid":"%s","user_message_uuids":["%s"]}\\n' "$session" "$prompt" "$prompt";;
  esac
done
`, { mode: 0o755 });
  return file;
}

/** What the fake at `file` logs when the real SDK, at the pinned version, launched it. */
const LAUNCHED_BY_THE_PINNED_SDK = `launched by CLAUDE_CODE_ENTRYPOINT=sdk-ts CLAUDE_AGENT_SDK_VERSION=${CLAUDE_SDK_VERSION}`;

/** Starts `runtime` serving the claude driver, and one instance with `config` on Node host services under `root` whose PATH is `bin`. */
async function claudeOver(runtime: Runtime, where: Where, config: { [field: string]: unknown }) {
  const { command, decoy } = runtime.start(where);
  const host = await createNodeHostServices<typeof config>({
    hostRoot: path.join(where.root, "host"),
    instanceId: "claude-standalone",
    config: { get: async () => ({ config }) },
    attachments: { resolve: async () => null },
    hostTools: {
      mcpServerFor: async () => {
        throw new Error("this host serves no tools");
      },
    },
    callbacks: { register: async (flowId) => ({ url: `http://127.0.0.1:9/${flowId}` }) },
    coordination: createCoordination(),
    writeDiagnostic: () => undefined,
    // The host finds the user's claude on this PATH, as a host without Node would.
    baseEnv: where.env,
  });
  const connection = await startAriDriver({ driver: "claude", command: [...command], env: where.env, cwd: where.project, envPolicy: { stripAmbient: [] } });
  assert.equal(connection.driver.kind, "claude");
  const instance = await connection.driver.create(host, { instanceId: "claude-standalone", config, environment: {} });
  return {
    host,
    instance,
    decoy,
    async close() {
      await instance.dispose();
      await connection.close();
      await host.dispose();
    },
  };
}

/** Runs one turn over the wire and resolves with its terminal status and every event's JSON. */
async function oneTurn(instance: Awaited<ReturnType<typeof claudeOver>>["instance"], cwd: string): Promise<{ status: string | undefined; events: string }> {
  const session = await instance.openSession({});
  const events: AriEvent[] = [];
  void (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  try {
    const thread = await session.createThread({ cwd, policy: { mode: "approval_required", interaction: "default", cwd } });
    const started = await session.startTurn({ threadId: thread.id, clientTurnKey: "standalone-claude-1", intent: "start", content: [{ type: "text", text: "Say hello" }] });
    assert.equal(started.status, "accepted");
    const deadline = Date.now() + 15_000;
    for (;;) {
      const terminal = events.find((event) => event.body.type === "turn.terminal");
      if (terminal !== undefined) return { status: terminal.body.type === "turn.terminal" ? terminal.body.status : undefined, events: JSON.stringify(events) };
      if (Date.now() > deadline) throw new Error(`no turn.terminal within 15 s: ${JSON.stringify(events)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await session.close();
  }
}

/** Every file under `directory`, as paths relative to it. */
function filesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)));
}

for (const runtime of [STANDALONE, UNDER_NODE]) {
  test(`${runtime.name} with no driver config completes a turn through the SDK, ${CLAUDE_SDK_VERSION}, on the user's claude on PATH`, async () => {
    requireBuilt(runtime);
    const where = nodeFreeRoot();
    const claude = writeStreamJsonClaude(path.join(where.bin, "claude"), { versionLine: MINIMUM_VERSION_LINE, reply: "the claude on PATH answered" });
    if (runtime === STANDALONE) {
      // No SDK on disk anywhere the binary is pointed at: the temp root holds only the fake claude,
      // and the binary does not name the SDK it was built from, so it cannot import that from disk either.
      assert.deepEqual(filesUnder(where.root), ["bin/claude"]);
      assert.equal(fs.readFileSync(ARI_DRIVER).includes(PINNED_SDK), false, `${path.relative(ROOT, ARI_DRIVER)} names ${PINNED_SDK}`);
    }
    const instance = await claudeOver(runtime, where, {});
    try {
      const status = await instance.instance.status();
      assert.equal(status.state, "ready", JSON.stringify(status));
      assert.equal(status.installed, true);
      assert.equal(status.version, CLAUDE_SDK_VERSION);
      const turn = await oneTurn(instance.instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes("the claude on PATH answered"), turn.events);
      // The user's claude is what ran: the SDK launched it, once, for the turn.
      const sessions = fakeClaudeSessions(claude);
      assert.equal(sessions.length, 1, fakeClaudeInvocations(claude).join("\n"));
      assert.match(sessions[0]!, /^--output-format stream-json --verbose --input-format stream-json /);
      assert.ok(fakeClaudeInvocations(claude).includes(LAUNCHED_BY_THE_PINNED_SDK), fakeClaudeInvocations(claude).join("\n"));
      if (instance.decoy !== undefined) assert.deepEqual(fakeClaudeInvocations(instance.decoy), [], "the native package beside the SDK never ran");
    } finally {
      await instance.close();
    }
  });

  test(`${runtime.name} with executablePath runs the configured Claude Code instead of the claude on PATH`, async () => {
    requireBuilt(runtime);
    const where = nodeFreeRoot();
    const onPath = writeStreamJsonClaude(path.join(where.bin, "claude"), { versionLine: MINIMUM_VERSION_LINE, reply: "the claude on PATH answered" });
    const configured = writeStreamJsonClaude(path.join(where.root, "elsewhere", "claude-nightly"), { versionLine: MINIMUM_VERSION_LINE, reply: "the configured claude answered" });
    const nightly = await claudeOver(runtime, where, { executablePath: configured });
    try {
      const status = await nightly.instance.status();
      assert.equal(status.version, CLAUDE_SDK_VERSION, JSON.stringify(status));
      const turn = await oneTurn(nightly.instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes("the configured claude answered"), turn.events);
      assert.equal(fakeClaudeInvocations(configured)[0], "--version", "the driver checked the configured Claude Code's version before it ran it");
      assert.equal(fakeClaudeSessions(configured).length, 1);
      assert.ok(fakeClaudeInvocations(configured).includes(LAUNCHED_BY_THE_PINNED_SDK), fakeClaudeInvocations(configured).join("\n"));
      assert.deepEqual(fakeClaudeInvocations(onPath), [], "the claude on PATH never ran");
      if (nightly.decoy !== undefined) assert.deepEqual(fakeClaudeInvocations(nightly.decoy), [], "the native package beside the SDK never ran");
    } finally {
      await nightly.close();
    }
  });
}

test(`the standalone ari-driver with a claude older than the minimum reports driver_unavailable naming its version, its path, the minimum and how to update, and starts no session`, async () => {
  requireBuilt(STANDALONE);
  const where = nodeFreeRoot();
  const claude = writeFakeClaude(path.join(where.bin, "claude"), { versionLine: "2.1.329 (Claude Code)", greeting: "the user's claude on PATH" });
  const standalone = await claudeOver(STANDALONE, where, {});
  try {
    const status = await standalone.instance.status();
    assert.equal(status.state, "unavailable", JSON.stringify(status));
    assert.equal(status.error?.code, "driver_unavailable");
    const message = status.error?.message ?? "";
    assert.ok(message.startsWith(`Claude Code 2.1.329 at ${claude} is older than 2.1.330, the oldest version this driver runs`), message);
    assert.match(message, /Update Claude Code to 2\.1\.330 or newer \(run claude update,/);
    assert.match(message, /set executablePath in the driver config/);
    await assert.rejects(standalone.instance.openSession({}), (error: { callError?: { code: string; message: string } }) => {
      assert.deepEqual({ code: error.callError?.code, message: error.callError?.message }, { code: "driver_unavailable", message });
      return true;
    });
    assert.deepEqual(fakeClaudeSessions(claude), [], "no Claude Code session started");
  } finally {
    await standalone.close();
  }
});

test(`the standalone ari-driver with no claude on PATH reports driver_unavailable saying Claude Code is not installed, how to install it, and executablePath`, async () => {
  requireBuilt(STANDALONE);
  const where = nodeFreeRoot();
  const standalone = await claudeOver(STANDALONE, where, {});
  try {
    const status = await standalone.instance.status();
    assert.equal(status.state, "unavailable", JSON.stringify(status));
    assert.equal(status.error?.code, "driver_unavailable");
    const message = status.error?.message ?? "";
    assert.ok(message.startsWith("Claude Code is not installed: no claude executable was found on PATH."), message);
    assert.match(message, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
    assert.match(message, /set executablePath in the driver config/);
    await assert.rejects(standalone.instance.openSession({}), (error: { callError?: { code: string; message: string } }) => {
      assert.deepEqual({ code: error.callError?.code, message: error.callError?.message }, { code: "driver_unavailable", message });
      return true;
    });
  } finally {
    await standalone.close();
  }
});

test("the standalone ari-driver holds the Claude Agent SDK's code and no Claude Code executable", () => {
  requireBuilt(STANDALONE);
  assert.equal(SDK_MARKER, CLAUDE_SDK_CODE_MARKER, "the package check looks for the same string");
  const sdkModule = fs.readFileSync(path.join(PINNED_SDK, "sdk.mjs"));
  assert.ok(sdkModule.includes(SDK_MARKER), `${SDK_MARKER} is in the pinned SDK's sdk.mjs`);
  assert.equal(sdkModule.includes(CLAUDE_CODE_MARKER), false, "the Claude Code marker is not in the SDK's own code");
  // This platform's native Claude Code package, which the SDK lists and npm would install beside it.
  const nativeClaude = createRequire(path.join(PINNED_SDK, "package.json")).resolve(`${sdkNativePackage().pkg}/${sdkNativePackage().binary}`);
  assert.ok(fs.readFileSync(nativeClaude).includes(CLAUDE_CODE_MARKER), `the Claude Code marker is in ${nativeClaude}`);

  const binary = fs.readFileSync(ARI_DRIVER);
  assert.ok(binary.includes(SDK_MARKER), `${path.relative(ROOT, ARI_DRIVER)} does not contain ${SDK_MARKER}: the SDK is not compiled in`);
  assert.equal(binary.includes(CLAUDE_CODE_MARKER), false, `${path.relative(ROOT, ARI_DRIVER)} contains Claude Code's code`);
  assert.ok(binary.length < fs.statSync(nativeClaude).size, `${path.relative(ROOT, ARI_DRIVER)} (${binary.length} bytes) is too large to hold no Claude Code executable (${fs.statSync(nativeClaude).size} bytes)`);
});
