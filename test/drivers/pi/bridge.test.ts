// The bridge extension, run for real against a stand-in for Pi's ExtensionAPI.
// The fake pi does what the bridge does; these tests pin what that is: the
// `ari` status with Pi's working directory, the approval dialog's JSON title
// and option ids, the runtime-mode gate, the four commands, and that the
// bridge adds nothing to the prompt unless the host gave text for one run.
// pi-types.test.ts type-checks the same source against Pi's ExtensionAPI.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { BRIDGE_FILE_NAME, BRIDGE_SETTINGS_VARIABLE, PI_BRIDGE_SOURCE, parseApprovalTitle } from "../../../src/drivers/pi/index.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-pi-bridge-"));
const file = path.join(directory, BRIDGE_FILE_NAME);
fs.writeFileSync(file, PI_BRIDGE_SOURCE);
after(() => fs.rmSync(directory, { recursive: true, force: true }));

type Handler = (event: unknown, ctx: unknown) => unknown;

interface LoadedBridge {
  readonly emit: (event: string, payload: unknown, ctx?: unknown) => Promise<unknown>;
  readonly command: (name: string, args: string, ctx?: unknown) => Promise<void>;
  readonly mcp: Array<{ name: string; config: unknown }>;
}

async function load(mode: string | undefined): Promise<LoadedBridge> {
  if (mode === undefined) delete process.env[BRIDGE_SETTINGS_VARIABLE];
  else process.env[BRIDGE_SETTINGS_VARIABLE] = JSON.stringify({ mode });
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const mcp: Array<{ name: string; config: unknown }> = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, options),
    registerMcpServer: (name: string, config: unknown) => mcp.push({ name, config }),
  };
  const factory = ((await import(pathToFileURL(file).href)) as { default: (api: typeof pi) => void }).default;
  factory(pi);
  assert.equal(process.env[BRIDGE_SETTINGS_VARIABLE], undefined, "the bridge removes its settings from the environment tools inherit");
  return {
    mcp,
    emit: async (event, payload, ctx) => {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
      return result;
    },
    command: async (name, args, ctx) => {
      const command = commands.get(name);
      assert.ok(command !== undefined, `the bridge registers /${name}`);
      await command.handler(args, ctx);
    },
  };
}

function toolContext(answers: Array<string | undefined>) {
  const dialogs: Array<{ title: string; options: string[] }> = [];
  return {
    dialogs,
    ctx: {
      signal: undefined,
      ui: {
        select: async (title: string, options: string[]) => {
          dialogs.push({ title, options });
          return answers.shift();
        },
      },
    },
  };
}

test("on session start the bridge reports Pi's working directory under the status key ari", async () => {
  const bridge = await load("approval_required");
  const statuses: Array<[string, string]> = [];
  await bridge.emit("session_start", { type: "session_start", reason: "startup" }, { cwd: "/work/real", ui: { setStatus: (key: string, text: string) => statuses.push([key, text]) } });
  assert.deepEqual(statuses, [["ari", JSON.stringify({ cwd: "/work/real" })]]);
});

test("under approval_required the bridge asks with a JSON title the driver reads and option ids as Pi's options", async () => {
  const bridge = await load("approval_required");
  const { dialogs, ctx } = toolContext(["allow-once", "decline", "allow-session"]);
  const bash = { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "npm test" } };
  assert.equal(await bridge.emit("tool_call", bash, ctx), undefined, "allow-once lets the call run");
  assert.deepEqual(await bridge.emit("tool_call", bash, ctx), { block: true }, "decline blocks it");
  assert.equal(await bridge.emit("tool_call", bash, ctx), undefined);
  assert.equal(await bridge.emit("tool_call", bash, ctx), undefined, "allow-session is remembered for this process");
  assert.equal(dialogs.length, 3);

  const descriptor = parseApprovalTitle(dialogs[0]!.title);
  assert.ok(descriptor !== undefined);
  assert.equal(descriptor.kind, "command");
  assert.equal(descriptor.tool, "bash");
  assert.deepEqual(descriptor.input, { command: "npm test" });
  assert.deepEqual(
    dialogs[0]!.options,
    descriptor.options.map((option) => option.id),
  );
  assert.deepEqual(
    descriptor.options.map((option) => [option.id, option.decision, option.scope]),
    [
      ["allow-once", "accept", "once"],
      ["allow-session", "accept_for_session", "session"],
      ["decline", "decline", undefined],
    ],
  );

  const edit = await (async () => {
    const asked = toolContext(["allow-once"]);
    await bridge.emit("tool_call", { type: "tool_call", toolCallId: "call-2", toolName: "edit", input: { path: "a.ts", edits: [] } }, asked.ctx);
    return parseApprovalTitle(asked.dialogs[0]!.title);
  })();
  assert.equal(edit?.kind, "file_change");
  const read = toolContext([]);
  assert.equal(await bridge.emit("tool_call", { type: "tool_call", toolCallId: "call-3", toolName: "read", input: { path: "a.ts" } }, read.ctx), undefined);
  assert.equal(read.dialogs.length, 0, "read-only tools never ask");
});

test("the runtime mode decides which tools ask, run or are blocked", async () => {
  const cases: Array<[mode: string | undefined, tool: string, outcome: "ask" | "run" | "block"]> = [
    ["full_access", "bash", "run"],
    ["full_access", "write", "run"],
    ["read_only", "bash", "block"],
    ["read_only", "write", "block"],
    ["read_only", "grep", "run"],
    ["auto_accept_edits", "write", "run"],
    ["auto_accept_edits", "bash", "ask"],
    ["approval_required", "mcp__acme__deploy", "ask"],
    // Without settings the bridge fails closed.
    [undefined, "bash", "ask"],
  ];
  for (const [mode, tool, outcome] of cases) {
    const bridge = await load(mode);
    const { dialogs, ctx } = toolContext(["decline"]);
    const result = await bridge.emit("tool_call", { type: "tool_call", toolCallId: "c", toolName: tool, input: { command: "x", path: "x" } }, ctx);
    const seen = dialogs.length > 0 ? "ask" : result === undefined ? "run" : "block";
    assert.equal(seen, outcome, `${tool} under ${String(mode)}`);
  }
});

test("/ari-mcp registers the host's servers under their names, /ari-rewind moves and labels the leaf, /ari-context lasts one run", async () => {
  const bridge = await load("approval_required");
  await bridge.command("ari-mcp", JSON.stringify({ servers: [{ name: "host-tools-1", config: { type: "http", url: "http://127.0.0.1:9/mcp" } }] }));
  assert.deepEqual(bridge.mcp, [{ name: "host-tools-1", config: { type: "http", url: "http://127.0.0.1:9/mcp" } }]);

  const calls: unknown[] = [];
  await bridge.command("ari-rewind", " 0000000a \n", {
    waitForIdle: async () => calls.push("waitForIdle"),
    navigateTree: async (target: string, options: unknown) => calls.push(["navigateTree", target, options]),
  });
  assert.deepEqual(calls, ["waitForIdle", ["navigateTree", "0000000a", { summarize: false, label: "ari-rewind" }]]);

  assert.equal(await bridge.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "BASE" }), undefined, "no host text, no change to the prompt");
  await bridge.command("ari-context", JSON.stringify({ text: "Use tabs." }));
  await bridge.command("ari-context", JSON.stringify({ text: "Be brief." }));
  assert.deepEqual(await bridge.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "BASE" }), { systemPrompt: "BASE\n\nUse tabs.\n\nBe brief." });
  assert.equal(await bridge.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "BASE" }), undefined, "the text lasts one run");
});

test("/ari-persist writes Pi's own session header when Pi has not written the session file, and never touches a written one", async () => {
  const bridge = await load("approval_required");
  const sessionFile = path.join(directory, "sessions", "2026-11-23T00-00-00-000Z_00000000-0000-4000-8000-000000000abc.jsonl");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const header = { type: "session", version: 3, id: "00000000-0000-4000-8000-000000000abc", timestamp: "2026-11-23T00:00:00.000Z", cwd: "/work/real" };
  const ctx = { sessionManager: { getSessionFile: () => sessionFile, getHeader: () => header } };

  await bridge.command("ari-persist", "", ctx);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), `${JSON.stringify(header)}\n`);

  fs.writeFileSync(sessionFile, "lines pi wrote\n");
  await bridge.command("ari-persist", "", ctx);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), "lines pi wrote\n", "a file pi wrote is left alone");

  // A session without a file (pi --no-session) has nothing to write.
  await bridge.command("ari-persist", "", { sessionManager: { getSessionFile: () => undefined, getHeader: () => header } });
});

test("the bridge source holds no instruction text of its own", () => {
  // Its only strings that could reach the model are the host's, joined by blank lines.
  for (const phrase of ["You are", "you are", "Always", "assistant", "instructions:"]) {
    assert.ok(!PI_BRIDGE_SOURCE.includes(phrase), `the bridge contains "${phrase}"`);
  }
});
