// A fake ACP agent built with the official TypeScript SDK
// (@agentclientprotocol/sdk, pinned in package.json and test/drivers/acp/SOURCES.md),
// so the driver is tested against real protocol code: the SDK parses every
// frame the driver sends against ACP's schema and answers bad ones itself.
//
// It runs as a child process: ACP frames on stdin and stdout, and a puppet
// channel on Node IPC that the driver never sees. It does nothing on its own:
// each prompt waits for the conformance kit's steps (say, run a tool, ask for
// an approval, complete, fail, exit).
//
// Arguments (others, such as a flavor's launch arguments, are ignored):
//   --version               print a version line and exit
//   --protocol 1|2          the ACP version to speak (v1 SDK app or v2 SDK app)
//   --store <dir>           where sessions are kept, one JSON file each
//   --fork                  advertise session/fork
//   --fork-cross-cwd        accept a fork into another directory (otherwise refuse it)
//   --system-prompt         advertise system prompts on session/new
//   --load                  v1: advertise session/load instead of session/resume
//   --config-options <json> session config options to offer, in the version's shape
//   --meta                  put vendor _meta on initialize, updates and tool calls
//   --print-version <text>  the version --version prints
//   --answer-protocol <n>   answer initialize with protocol version n (in the --protocol version's shape)
//   --resume-state <state>  v2: the current state a resume reports (default idle), as if work were already running

import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp1 from "@agentclientprotocol/sdk/unstable";
import * as acp2 from "@agentclientprotocol/sdk/experimental/v2/unstable";

interface StoredSession {
  sessionId: string;
  cwd: string;
  prompts: string[];
  locked: boolean;
  systemPrompt?: string;
  mcpServers?: string[];
}

interface NativeTool {
  name: string;
  input: unknown;
  output: string;
  path?: string;
}

interface NativeApprovalOption {
  optionId: string;
  label: string;
  decision: "accept" | "accept_for_session" | "accept_always" | "decline";
}

interface NativeApproval {
  kind: "command" | "file_change";
  command?: string[];
  path?: string;
  options: NativeApprovalOption[];
}

const argv = process.argv.slice(2);
function flag(name: string): boolean {
  return argv.includes(name);
}
function option(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

if (flag("--version")) {
  process.stdout.write(`${option("--print-version") ?? "fake-acp-agent 1.4.2"}\n`);
  process.exit(0);
}

const version = option("--protocol") === "1" ? 1 : 2;
const answeredProtocol = option("--answer-protocol") === undefined ? version : Number(option("--answer-protocol"));
const resumeState = option("--resume-state") ?? "idle";
const store = option("--store") ?? fs.mkdtempSync(path.join(process.env["TMPDIR"] ?? "/tmp", "fake-acp-"));
const configOptionsArg = option("--config-options");
fs.mkdirSync(store, { recursive: true });

// The session store, shared by every agent process of one rig.

function sessionFile(sessionId: string): string {
  return path.join(store, `${encodeURIComponent(sessionId)}.json`);
}
function loadSession(sessionId: string): StoredSession | undefined {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(sessionId), "utf8")) as StoredSession;
  } catch {
    return undefined;
  }
}
function saveSession(session: StoredSession): void {
  fs.writeFileSync(sessionFile(session.sessionId), JSON.stringify(session));
}
function nextSessionId(): string {
  const counter = path.join(store, "counter");
  const next = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
  fs.writeFileSync(counter, String(next));
  return `sess-${next}`;
}

// Puppet state.

interface LiveTurn {
  readonly turnId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly messageIds: { agent: number };
  finish: (stopReason: string, error?: { code: number; message: string }) => void;
  cancelled: boolean;
  stopWaiters: Array<(how: "cancel") => void>;
}

const loaded = new Set<string>();
const turns = new Map<string, LiveTurn>();
const activeBySession = new Map<string, LiveTurn>();
const approvals = new Map<string, { replies: string[]; waiters: Array<(reply: string) => void> }>();
const activity: { feedback: unknown[]; mcp: unknown[]; extensions: Array<{ params: unknown; result: unknown }> } = { feedback: [], mcp: [], extensions: [] };
let turnCounter = 0;
let toolCounter = 0;
let approvalCounter = 0;
let messageCounter = 0;
let echoCounter = 0;
const withMeta = flag("--meta");

function send(message: unknown): void {
  process.send?.(message);
}

function meta(where: string): { _meta?: { [key: string]: unknown } } {
  return withMeta ? { _meta: { "fake.vendor/where": where } } : {};
}

// Config options, in the shape of the negotiated version.
type AnyOption = { [key: string]: unknown };
const sessionOptions = new Map<string, AnyOption[]>();
function initialOptions(): AnyOption[] {
  return configOptionsArg === undefined ? [] : (JSON.parse(configOptionsArg) as AnyOption[]);
}
function optionsOf(sessionId: string): AnyOption[] {
  let options = sessionOptions.get(sessionId);
  if (options === undefined) {
    options = initialOptions();
    sessionOptions.set(sessionId, options);
  }
  return options;
}

// The two SDK apps. Each registers the same behavior in its version's shape.

type Client = { notify(method: string, params: unknown): Promise<void>; request(method: string, params: unknown): Promise<unknown> };
let client: Client | undefined;

async function update(sessionId: string, value: { [key: string]: unknown }): Promise<void> {
  await client!.notify("session/update", { sessionId, update: value, ...meta("notification") });
}

function startTurn(sessionId: string, prompt: string, finish: LiveTurn["finish"]): LiveTurn {
  const session = loadSession(sessionId);
  if (session === undefined) throw acp1.RequestError.resourceNotFound(sessionId);
  session.prompts.push(prompt);
  saveSession(session);
  turnCounter += 1;
  const turn: LiveTurn = { turnId: `turn-${turnCounter}`, sessionId, cwd: session.cwd, messageIds: { agent: 0 }, finish, cancelled: false, stopWaiters: [] };
  turns.set(turn.turnId, turn);
  activeBySession.set(sessionId, turn);
  return turn;
}

function promptText(prompt: ReadonlyArray<{ type: string; text?: string }>): string {
  return prompt.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

function newSession(cwd: string, systemPrompt: unknown, mcpServers: ReadonlyArray<{ name: string }> | undefined): StoredSession {
  const sessionId = nextSessionId();
  const text = (systemPrompt as { content?: Array<{ text?: string }> } | null | undefined)?.content?.map((block) => block.text ?? "").join("");
  const session: StoredSession = { sessionId, cwd, prompts: [], locked: false, ...(text === undefined ? {} : { systemPrompt: text }), mcpServers: (mcpServers ?? []).map((server) => server.name) };
  saveSession(session);
  loaded.add(sessionId);
  return session;
}

function resume(sessionId: string, cwd: string): StoredSession {
  const session = loadSession(sessionId);
  if (session === undefined) throw acp1.RequestError.resourceNotFound(sessionId);
  // A session another process holds cannot be opened here.
  if (session.locked) throw new acp1.RequestError(-32603, `Session ${sessionId} is already open in another process`);
  if (session.cwd !== cwd) throw acp1.RequestError.invalidParams(undefined, `session ${sessionId} lives in ${session.cwd}`);
  loaded.add(sessionId);
  return session;
}

function fork(sessionId: string, cwd: string): StoredSession {
  const source = loadSession(sessionId);
  if (source === undefined) throw acp1.RequestError.resourceNotFound(sessionId);
  if (cwd !== source.cwd && !flag("--fork-cross-cwd")) throw acp1.RequestError.invalidParams(undefined, "this agent forks only within the source session's directory");
  const forked: StoredSession = { sessionId: nextSessionId(), cwd, prompts: [...source.prompts], locked: false };
  saveSession(forked);
  loaded.add(forked.sessionId);
  return forked;
}

async function setOption(sessionId: string, configId: string, value: unknown): Promise<AnyOption[]> {
  const options = optionsOf(sessionId);
  const target = options.find((entry) => (entry["configId"] ?? entry["id"]) === configId);
  if (target === undefined) throw acp1.RequestError.invalidParams(undefined, `no config option ${configId}`);
  target["currentValue"] = value;
  // Options can depend on each other (fx's model list follows its provider), so the agent also re-announces
  // the list, before it answers, so the order of frames never depends on timing.
  await update(sessionId, { sessionUpdate: "config_option_update", configOptions: options });
  return options;
}

function echo(params: unknown): unknown {
  echoCounter += 1;
  const result = { echoed: params, call: echoCounter };
  activity.extensions.push({ params, result });
  return result;
}

const capabilitiesV1: acp1.AgentCapabilities = {
  loadSession: flag("--load"),
  promptCapabilities: { image: false, embeddedContext: false },
  mcpCapabilities: { http: true, sse: false },
  sessionCapabilities: {
    ...(flag("--load") ? {} : { resume: {} }),
    close: {},
    ...(flag("--fork") ? { fork: {} } : {}),
    ...(flag("--system-prompt") ? { systemPrompt: {} } : {}),
  },
  ...meta("capabilities"),
};

const capabilitiesV2: acp2.AgentCapabilities = {
  session: {
    mcp: { stdio: {}, http: {} },
    ...(flag("--fork") ? { fork: {} } : {}),
    ...(flag("--system-prompt") ? { systemPrompt: {} } : {}),
  },
  ...meta("capabilities"),
};

function buildV1(): acp1.AgentApp {
  return acp1
    .agent({ name: "fake-acp-agent" })
    .onRequest("initialize", async () => ({
      protocolVersion: answeredProtocol,
      agentCapabilities: capabilitiesV1,
      agentInfo: { name: "fake-acp-agent", version: "1.4.2" },
      authMethods: [],
      ...meta("initialize"),
    }))
    .onRequest("session/new", async ({ params }) => {
      const session = newSession(params.cwd, params.systemPrompt, params.mcpServers);
      return { sessionId: session.sessionId, configOptions: optionsOf(session.sessionId) as acp1.SessionConfigOption[], ...meta("session/new") };
    })
    .onRequest("session/resume", async ({ params }) => {
      resume(params.sessionId, params.cwd);
      return { configOptions: optionsOf(params.sessionId) as acp1.SessionConfigOption[] };
    })
    .onRequest("session/load", async ({ params, client: context }) => {
      const session = resume(params.sessionId, params.cwd);
      // session/load replays the history before it answers.
      for (const prompt of session.prompts) await context.notify("session/update", { sessionId: session.sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: prompt } } });
      return { configOptions: optionsOf(params.sessionId) as acp1.SessionConfigOption[] };
    })
    .onRequest("session/fork", async ({ params }) => {
      const forked = fork(params.sessionId, params.cwd);
      return { sessionId: forked.sessionId, configOptions: optionsOf(forked.sessionId) as acp1.SessionConfigOption[] };
    })
    .onRequest("session/close", async ({ params }) => {
      loaded.delete(params.sessionId);
      return {};
    })
    .onRequest("session/set_config_option", async ({ params }) => ({ configOptions: (await setOption(params.sessionId, params.configId, params.value)) as acp1.SessionConfigOption[] }))
    .onRequest("session/prompt", ({ params }) =>
      new Promise<acp1.PromptResponse>((resolve, reject) => {
        const turn = startTurn(params.sessionId, promptText(params.prompt as Array<{ type: string; text?: string }>), (stopReason, error) => {
          activeBySession.delete(params.sessionId);
          if (error !== undefined) reject(new acp1.RequestError(error.code, error.message));
          else resolve({ stopReason: stopReason as acp1.StopReason, ...meta("prompt") });
        });
        send({ event: "turn", turnId: turn.turnId, prompt: promptText(params.prompt as Array<{ type: string; text?: string }>) });
      }),
    )
    .onNotification("session/cancel", ({ params }) => {
      const turn = activeBySession.get(params.sessionId);
      if (turn === undefined) return;
      turn.cancelled = true;
      for (const waiter of turn.stopWaiters.splice(0)) waiter("cancel");
    })
    .onRequest("_ari/echo", (params: unknown) => params, ({ params }) => echo(params));
}

function buildV2(): acp2.AgentApp {
  return acp2
    .agent({ name: "fake-acp-agent" })
    .onRequest("initialize", async () => ({
      protocolVersion: answeredProtocol,
      info: { name: "fake-acp-agent", version: "1.4.2" },
      capabilities: capabilitiesV2,
      authMethods: [],
      ...meta("initialize"),
    }))
    .onRequest("session/new", async ({ params }) => {
      const session = newSession(params.cwd, params.systemPrompt, params.mcpServers as Array<{ name: string }> | undefined);
      return { sessionId: session.sessionId, configOptions: optionsOf(session.sessionId) as acp2.SessionConfigOption[], ...meta("session/new") };
    })
    .onRequest("session/resume", async ({ params, client: context }) => {
      resume(params.sessionId, params.cwd);
      // Every successful resume is preceded by the session's current state.
      await context.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "state_update", state: resumeState } as acp2.SessionUpdate });
      return { configOptions: optionsOf(params.sessionId) as acp2.SessionConfigOption[] };
    })
    .onRequest("session/fork", async ({ params }) => {
      const forked = fork(params.sessionId, params.cwd);
      return { sessionId: forked.sessionId, configOptions: optionsOf(forked.sessionId) as acp2.SessionConfigOption[] };
    })
    .onRequest("session/list", async () => ({ sessions: [] }))
    .onRequest("session/close", async ({ params }) => {
      loaded.delete(params.sessionId);
      return {};
    })
    .onRequest("session/set_config_option", async ({ params }) => ({ configOptions: (await setOption(params.sessionId, params.configId, params.value)) as acp2.SessionConfigOption[] }))
    .onRequest("session/prompt", async ({ params, client: context }) => {
      const text = promptText(params.prompt as Array<{ type: string; text?: string }>);
      messageCounter += 1;
      const messageId = `user-${messageCounter}`;
      const turn = startTurn(params.sessionId, text, (stopReason, error) => {
        activeBySession.delete(params.sessionId);
        void context.notify("session/update", {
          sessionId: params.sessionId,
          update: { sessionUpdate: "state_update", state: "idle", stopReason, ...(error === undefined ? {} : { error }) } as acp2.SessionUpdate,
        });
      });
      // The prompt is inserted: report it, report the work running, then acknowledge it.
      await context.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "user_message", messageId, content: params.prompt } });
      await context.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "state_update", state: "running" } });
      send({ event: "turn", turnId: turn.turnId, prompt: text });
      return { messageId, ...meta("prompt") };
    })
    .onNotification("session/cancel", ({ params }) => {
      const turn = activeBySession.get(params.sessionId);
      if (turn === undefined) return;
      turn.cancelled = true;
      for (const waiter of turn.stopWaiters.splice(0)) waiter("cancel");
    })
    .onRequest("_ari/echo", (params: unknown) => params, ({ params }) => echo(params));
}

// The puppet steps, in the negotiated version's frames.

function liveTurn(turnId: string): LiveTurn {
  const turn = turns.get(turnId);
  if (turn === undefined) throw new Error(`no turn ${turnId}`);
  return turn;
}

async function say(turnId: string, text: string): Promise<void> {
  const turn = liveTurn(turnId);
  const half = Math.ceil(text.length / 2);
  const pieces = [text.slice(0, half), text.slice(half)].filter((piece) => piece !== "");
  if (version === 1) {
    // v1 chunks need no message id; nothing marks the end of a message, so the agent reports its usage after the response.
    for (const piece of pieces) await update(turn.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } });
    await update(turn.sessionId, { sessionUpdate: "usage_update", used: 1200, size: 200000 });
    return;
  }
  turn.messageIds.agent += 1;
  messageCounter += 1;
  const messageId = `agent-${messageCounter}`;
  for (const piece of pieces) await update(turn.sessionId, { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: piece } });
  // A whole-message upsert carries the finished message.
  await update(turn.sessionId, { sessionUpdate: "agent_message", messageId, content: [{ type: "text", text }], ...meta("agent_message") });
}

async function runTool(turnId: string, tool: NativeTool): Promise<void> {
  const turn = liveTurn(turnId);
  toolCounter += 1;
  const toolCallId = `call-${toolCounter}`;
  const locations = tool.path === undefined ? [] : [{ path: path.join(turn.cwd, tool.path) }];
  const kind = tool.name.startsWith("read") || tool.name.startsWith("list") ? "read" : "other";
  const start = { toolCallId, title: tool.name, kind, status: "in_progress", rawInput: tool.input, locations, ...meta("tool_call") };
  await update(turn.sessionId, version === 1 ? { sessionUpdate: "tool_call", ...start } : { sessionUpdate: "tool_call_update", ...start });
  await update(turn.sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: tool.output } }] });
}

const OPTION_KINDS: { readonly [decision: string]: string } = { accept: "allow_once", accept_for_session: "allow_always", accept_always: "allow_always", decline: "reject_once" };

async function requestApproval(turnId: string, approval: NativeApproval): Promise<string> {
  const turn = liveTurn(turnId);
  approvalCounter += 1;
  toolCounter += 1;
  const approvalId = `approval-${approvalCounter}`;
  const toolCallId = `call-${toolCounter}`;
  const record = { replies: [] as string[], waiters: [] as Array<(reply: string) => void> };
  approvals.set(approvalId, record);
  const options = approval.options.map((entry) => ({ optionId: entry.optionId, name: entry.label, kind: OPTION_KINDS[entry.decision] ?? "reject_once" }));
  const toolCall = {
    toolCallId,
    title: approval.kind === "command" ? `Run ${(approval.command ?? []).join(" ")}` : `Edit ${approval.path ?? ""}`,
    kind: approval.kind === "command" ? "execute" : "edit",
    status: "pending",
    rawInput: approval.kind === "command" ? { command: approval.command } : { path: approval.path },
    locations: approval.path === undefined ? [] : [{ path: path.join(turn.cwd, approval.path) }],
  };
  await update(turn.sessionId, version === 1 ? { sessionUpdate: "tool_call", ...toolCall } : { sessionUpdate: "tool_call_update", ...toolCall });
  const params =
    version === 1
      ? { sessionId: turn.sessionId, toolCall, options, ...meta("permission") }
      : { sessionId: turn.sessionId, title: toolCall.title, subject: { type: "tool_call", toolCall }, options, ...meta("permission") };
  if (version === 2) await update(turn.sessionId, { sessionUpdate: "state_update", state: "requires_action" });
  void client!.request("session/request_permission", params).then(
    async (response) => {
      const outcome = (response as { outcome: { outcome: string; optionId?: string } }).outcome;
      const reply = outcome.outcome === "selected" ? (outcome.optionId ?? "") : "cancelled";
      record.replies.push(reply);
      for (const waiter of record.waiters.splice(0)) waiter(reply);
      if (version === 2 && activeBySession.get(turn.sessionId) === turn) await update(turn.sessionId, { sessionUpdate: "state_update", state: "running" });
    },
    () => undefined,
  );
  return approvalId;
}

function inspect(sessionId: string): unknown {
  const session = loadSession(sessionId);
  if (session === undefined || !loaded.has(sessionId)) return null;
  return { loaded: true, cwd: session.cwd, prompts: session.prompts, compactions: 0, injectedMessages: [], backgroundTasks: [], subagents: [] };
}

const puppet: { [method: string]: (...args: never[]) => unknown } = {
  say: (turnId: string, text: string) => say(turnId, text),
  runTool: (turnId: string, tool: NativeTool) => runTool(turnId, tool),
  requestApproval: (turnId: string, approval: NativeApproval) => requestApproval(turnId, approval),
  nextApprovalReply: (approvalId: string) =>
    new Promise<string>((resolve) => {
      const record = approvals.get(approvalId);
      if (record === undefined) throw new Error(`no approval ${approvalId}`);
      if (record.replies.length > 0) resolve(record.replies[0]!);
      else record.waiters.push(resolve);
    }),
  approvalReplies: (approvalId: string) => approvals.get(approvalId)?.replies ?? [],
  complete: (turnId: string) => liveTurn(turnId).finish("end_turn"),
  fail: (turnId: string, failure: { kind: string; message: string }) => liveTurn(turnId).finish("error", { code: -32603, message: failure.message }),
  stopRequested: (turnId: string) =>
    new Promise<"cancel">((resolve) => {
      const turn = liveTurn(turnId);
      if (turn.cancelled) resolve("cancel");
      else turn.stopWaiters.push(resolve);
    }),
  finishCancelled: (turnId: string) => liveTurn(turnId).finish("cancelled"),
  exitProcess: () => process.exit(3),
  rawUpdate: (turnId: string, value: { [key: string]: unknown }) => update(liveTurn(turnId).sessionId, value),
  // An update outside any prompt, for a session this process holds; false when it holds none.
  sessionUpdate: async (sessionId: string, value: { [key: string]: unknown }) => {
    if (!loaded.has(sessionId)) return false;
    await update(sessionId, value);
    return true;
  },
  inspectSession: (sessionId: string) => inspect(sessionId),
  activity: () => activity,
};

process.on("message", (message: { id: number; method: string; args: unknown[] }) => {
  const handler = puppet[message.method];
  void (async () => {
    try {
      if (handler === undefined) throw new Error(`unknown puppet method ${message.method}`);
      const result = await (handler as (...args: unknown[]) => unknown)(...message.args);
      if (message.id !== 0) send({ id: message.id, result: result ?? null });
    } catch (error) {
      if (message.id !== 0) send({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});

const stream = (version === 1 ? acp1.ndJsonStream : acp2.ndJsonStream)(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
if (version === 1) {
  const connection = buildV1().connect(stream);
  client = connection.client as unknown as Client;
  void connection.closed.then(() => process.exit(0));
} else {
  const connection = buildV2().connect(stream);
  client = connection.client as unknown as Client;
  void connection.closed.then(() => process.exit(0));
}
