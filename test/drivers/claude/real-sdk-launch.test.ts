// The pinned Claude Agent SDK itself (0.3.330's sdk.mjs) starting the user's
// Claude Code for the driver. The driver passes the user's `claude` as
// `pathToClaudeCodeExecutable` and sets `mcpServersDelivery: "initialize"`,
// the mode the SDK's sdk.d.ts recommends for an app that starts its own
// Claude Code at or above the bundled version. With an MCP server configured
// for the session, the SDK then emits no CLAUDE_SDK_MCP_SERVERS_ARGV_DEPRECATED
// warning, and the server and its secret never reach Claude Code's command
// line: it gets them over stdin.
//
// The SDK is a copy of the pinned package's sdk.mjs and package.json in a
// temp npm layout, which the driver's loader imports by file URL, with a
// decoy native Claude Code package beside it, so the SDK could never find the
// real native binary in this repository's node_modules. The user's Claude Code is a fake (a Node script named
// `claude` on the host's PATH) that records its arguments and the lines it
// reads, and answers the SDK's control requests and one prompt. Nothing
// reaches the network or starts a real Claude Code.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { AriEvent } from "../../../src/index.ts";
import { createClaudeDriver } from "../../../src/drivers/claude/index.ts";
import type { ClaudeDriverConfig } from "../../../src/drivers/claude/index.ts";
import type { ClaudeSdk, ClaudeSdkRuntime, ClaudeUserMessage } from "../../../src/drivers/claude/sdk.ts";
import { CLAUDE_SDK_PACKAGE } from "../../../src/meta/claude.ts";
import { createCoordination, createNodeHostServices, resolveExecutable } from "../../../src/node/index.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { fakeClaudeInvocations, writeDecoyNativePackage } from "./sdk-fixture.ts";

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

const SECRET = "fixture-mcp-secret-7f3a91";
const DEPRECATION = "CLAUDE_SDK_MCP_SERVERS_ARGV_DEPRECATED";

/**
 * A fake Claude Code for the real SDK: it appends `{ argv }` and then each
 * line it reads (`{ stdin }`) to `<its path>.log` as JSON lines, answers
 * `--version` and `auth status`, every control request with success
 * (`mcp_set_servers` with the servers added), and each prompt with an init
 * message, one assistant message and a success result.
 */
function fakeClaudeForTheSdk(node: string): string {
  return `#!${node}
"use strict";
const fs = require("node:fs");
const readline = require("node:readline");
const log = process.argv[1] + ".log";
const record = (entry) => fs.appendFileSync(log, JSON.stringify(entry) + "\\n");
const args = process.argv.slice(2);
record({ argv: args, pid: process.pid, cwd: process.cwd(), ambient: process.env.ANTHROPIC_API_KEY, sdk: process.env.CLAUDE_CODE_ENTRYPOINT });
if (args[0] === "--version") { process.stdout.write("2.1.330 (Claude Code)\\n"); process.exit(0); }
if (args[0] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }) + "\\n"); process.exit(0); }
process.stderr.write("stderr over the host process pipe\\n");
const at = args.indexOf("--session-id");
const sessionId = at === -1 ? "00000000-0000-4000-8000-000000000000" : args[at + 1];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let n = 0;
const uuid = () => "00000000-0000-4000-8000-" + String(++n).padStart(12, "0");
const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const message = JSON.parse(line);
  record({ stdin: message });
  if (message.type === "control_request") {
    const request = message.request;
    const response = request.subtype === "initialize" ? { commands: [], models: [], account: {}, pid: process.pid } : request.subtype === "mcp_set_servers" ? { added: Object.keys(request.servers), removed: [], errors: {} } : {};
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    return;
  }
  if (message.type !== "user") return;
  const text = "the user's claude answered the real SDK";
  send({ type: "system", subtype: "init", uuid: uuid(), session_id: sessionId, cwd: process.cwd(), model: "fake-model", claude_code_version: "2.1.330", slash_commands: [], permissionMode: "default", tools: [], mcp_servers: [] });
  send({ type: "assistant", uuid: uuid(), session_id: sessionId, parent_tool_use_id: null, message: { id: "msg_fake_1", type: "message", role: "assistant", model: "fake-model", content: [{ type: "text", text }], stop_reason: "end_turn", usage } });
  send({ type: "result", subtype: "success", uuid: uuid(), session_id: sessionId, is_error: false, num_turns: 1, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, usage, modelUsage: {}, permission_denials: [], result: text, stop_reason: "end_turn", terminal_reason: "completed", ...(message.uuid === undefined ? {} : { user_message_uuid: message.uuid, user_message_uuids: [message.uuid] }) });
});
`;
}

/** What the fake recorded: each launch's arguments, and every line it read. */
function recorded(claude: string): { launches: string[][]; stdin: Array<{ type?: string; request?: { subtype?: string; servers?: { [name: string]: unknown } } }> } {
  const entries = fs.existsSync(`${claude}.log`) ? fs.readFileSync(`${claude}.log`, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { argv?: string[]; stdin?: never }) : [];
  return {
    launches: entries.flatMap((entry) => (entry.argv !== undefined && entry.argv[0] === "--output-format" ? [entry.argv] : [])),
    stdin: entries.flatMap((entry) => (entry.stdin === undefined ? [] : [entry.stdin])),
  };
}

test("the real SDK starts the user's claude for the driver, emits no MCP argv deprecation warning, and keeps the MCP server off the command line", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-claude-real-sdk-")));
  temporary.push(root);
  // A copy of the pinned SDK in an npm layout, and the decoy where npm would put the native package.
  const pinned = fs.realpathSync(path.join(REPO_ROOT, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/")));
  const sdkPackage = path.join(root, "sdk", "node_modules", ...CLAUDE_SDK_PACKAGE.split("/"));
  fs.mkdirSync(sdkPackage, { recursive: true });
  for (const file of ["package.json", "sdk.mjs"]) fs.copyFileSync(path.join(pinned, file), path.join(sdkPackage, file));
  const decoy = writeDecoyNativePackage(path.join(root, "sdk", "node_modules"), "the native package beside the SDK");
  // The driver's loader for that copy, by file URL, as the standalone ari-driver's loader imports the SDK compiled into it.
  const { version, claudeCodeVersion } = JSON.parse(fs.readFileSync(path.join(sdkPackage, "package.json"), "utf8")) as { version: string; claudeCodeVersion: string };
  const loadCopy = async (): Promise<ClaudeSdkRuntime> => ({ sdk: (await import(pathToFileURL(path.join(sdkPackage, "sdk.mjs")).href)) as ClaudeSdk, version, claudeCodeVersion });
  // The user's claude on the host's PATH.
  const bin = path.join(root, "bin");
  const project = path.join(root, "project");
  fs.mkdirSync(bin);
  fs.mkdirSync(project);
  const node = process.versions["bun"] === undefined ? process.execPath : await resolveExecutable("node", process.env["PATH"]);
  assert.ok(node !== null, "a node on PATH runs the fake claude");
  const claude = path.join(bin, "claude");
  fs.writeFileSync(claude, fakeClaudeForTheSdk(node), { mode: 0o755 });

  const warnings: Array<{ code: string | undefined; message: string }> = [];
  const onWarning = (warning: Error & { code?: string }): void => {
    warnings.push({ code: warning.code, message: warning.message });
  };
  process.on("warning", onWarning);
  const diagnostics: string[] = [];
  const config: ClaudeDriverConfig = {};
  const host = await createNodeHostServices<ClaudeDriverConfig>({
    hostRoot: path.join(root, "host"),
    instanceId: "claude-real-sdk",
    config: { get: async () => ({ config }) },
    attachments: { resolve: async () => null },
    hostTools: {
      mcpServerFor: async () => {
        throw new Error("this host serves no tools");
      },
    },
    callbacks: { register: async (flowId) => ({ url: `http://127.0.0.1:9/${flowId}` }) },
    coordination: createCoordination(),
    writeDiagnostic: ({ msg }) => { diagnostics.push(msg); },
    baseEnv: { PATH: bin, HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), XDG_DATA_HOME: path.join(root, ".data"), XDG_STATE_HOME: path.join(root, ".state"), XDG_CACHE_HOME: path.join(root, ".cache"), ANTHROPIC_API_KEY: "fixture-ambient-key" },
  });
  const children: Array<{ pid: number | undefined; cwd: string | undefined }> = [];
  const spawn = host.process.spawn;
  host.process.spawn = async (request) => {
    const child = await spawn(request);
    if (request.purpose === "runtime") children.push({ pid: child.pid, cwd: request.cwd });
    return child;
  };
  const instance = await createClaudeDriver({ loadSdk: loadCopy }).create(host, { instanceId: "claude-real-sdk", config, environment: { HOME: root, PATH: bin } });
  try {
    const status = await instance.status();
    assert.equal(status.state, "ready", JSON.stringify(status));
    assert.equal(status.version, "0.3.330", "the copy of the pinned SDK loaded");
    const session = await instance.openSession({
      launch: { mcpServers: [{ name: "fixture-tools", transport: "stdio", command: "/bin/true", args: ["--serve"], env: { FIXTURE_TOKEN: SECRET } }] },
    });
    const events: AriEvent[] = [];
    void (async () => {
      for await (const event of session.events()) events.push(event);
    })();
    const thread = await session.createThread({ cwd: project, policy: { mode: "approval_required", interaction: "default", cwd: project } });
    await session.startTurn({ threadId: thread.id, clientTurnKey: "real-sdk-1", intent: "start", content: [{ type: "text", text: "Say hello" }] });
    const deadline = Date.now() + 20_000;
    let terminal: AriEvent | undefined;
    while ((terminal = events.find((event) => event.body.type === "turn.terminal")) === undefined) {
      if (Date.now() > deadline) throw new Error(`no turn.terminal within 20 s: ${JSON.stringify(events)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(terminal.body.type === "turn.terminal" ? terminal.body.status : undefined, "completed", JSON.stringify(events));
    assert.ok(JSON.stringify(events).includes("the user's claude answered the real SDK"), JSON.stringify(events));
    assert.ok(diagnostics.includes("claude: stderr over the host process pipe"), JSON.stringify(diagnostics));
    await session.close();

    assert.deepEqual(warnings.filter((warning) => warning.code === DEPRECATION), [], "the SDK warned about MCP servers on the command line");
    const { launches, stdin } = recorded(claude);
    assert.equal(launches.length, 1, "the SDK launched the user's claude once");
    const [argv] = launches as [string[]];
    // The launch arguments the user's claude received: no --mcp-config, and nothing of the server.
    assert.deepEqual(argv, [
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--permission-prompt-tool=stdio",
      "--permission-mode=default",
      "--allow-dangerously-skip-permissions",
      "--include-hook-events",
      "--include-partial-messages",
      `--session-id=${thread.handle}`,
    ]);
    assert.equal(argv.some((argument) => argument.includes(SECRET) || argument.includes("fixture-tools")), false, argv.join(" "));
    // It got the server, with its secret, over stdin, before the prompt.
    const subtypes = stdin.map((line) => (line.type === "control_request" ? line.request?.subtype : line.type));
    assert.deepEqual(subtypes.slice(0, 2), ["initialize", "mcp_set_servers"], JSON.stringify(subtypes));
    assert.ok(subtypes.indexOf("mcp_set_servers") < subtypes.indexOf("user"), JSON.stringify(subtypes));
    const servers = stdin.find((line) => line.request?.subtype === "mcp_set_servers")?.request?.servers;
    assert.deepEqual(servers, { "fixture-tools": { type: "stdio", command: "/bin/true", args: ["--serve"], env: { FIXTURE_TOKEN: SECRET } } });
    assert.deepEqual(fakeClaudeInvocations(decoy), [], "the native package beside the SDK never ran");
    await instance.catalog.list({ cwd: project });
    assert.equal(await instance.textGeneration!.generate({ kind: "title", input: "fixture" }), "the user's claude answered the real SDK");
    const launched = fs.readFileSync(`${claude}.log`, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv?: string[]; pid: number; cwd: string; ambient?: string; sdk?: string });
    const queries = launched.filter((entry) => entry.argv?.[0] === "--output-format");
    assert.equal(queries.length, 3, "session, catalog and text generation each launch one query");
    assert.deepEqual(children, queries.map(({ pid, cwd }) => ({ pid, cwd })), "all three real SDK children were spawned by the host");
    assert.deepEqual(queries.map(({ sdk, ambient }) => [sdk, ambient]), Array.from({ length: 3 }, () => ["sdk-ts", undefined]), "SDK additions are kept; the host's ambient API key is not inherited");
  } finally {
    await instance.dispose();
    await host.dispose();
  }

  // The control: the same SDK given MCP servers in Options.mcpServers with no delivery mode, as an app that ignores the deprecation would.
  // It warns, once per process, and puts the servers on the command line: what the driver's runs above did not do.
  const runtime = await loadCopy();
  const never = (async function* (): AsyncGenerator<ClaudeUserMessage> {
    await new Promise(() => undefined);
  })();
  const control = runtime.sdk.query({
    prompt: never,
    options: { cwd: project, env: { PATH: bin }, pathToClaudeCodeExecutable: claude, mcpServers: { "fixture-tools": { type: "stdio", command: "/bin/true", env: { FIXTURE_TOKEN: SECRET } } } },
  });
  try {
    const launched = Date.now() + 10_000;
    while (recorded(claude).launches.length < 4) {
      if (Date.now() > launched) throw new Error("the control query never launched the fake claude");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warnings.filter((warning) => warning.code === DEPRECATION).length, 1, "the warning this test looks for is one it can see");
    assert.ok(recorded(claude).launches[3]!.includes("--mcp-config"), "without the delivery mode the server goes on the command line");
  } finally {
    control.close();
    process.off("warning", onWarning);
  }
});
