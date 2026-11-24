// A self-contained fake ACP agent: one file, no imports, so it runs under
// Node or Bun as it is, and can be compiled into one executable that needs
// neither (`bun build --compile`). It speaks ACP v1 or v2, whichever the
// client asks for in `initialize` (v2 only when asked for), on stdin and
// stdout.
//
// Each prompt runs one scripted turn: the agent says it is working, asks for
// permission to run `echo hello` (options `allow`, allow once, and `reject`,
// reject once), reports the tool call's result according to the answer, says
// it is done and ends the turn. `session/cancel` ends the turn as cancelled.
//
// `--version` prints `standalone-acp-agent 1.0.0` and exits.

type Json = { [key: string]: unknown };
type Id = string | number;

const AGENT_VERSION = "1.0.0";

if (process.argv.includes("--version")) {
  process.stdout.write(`standalone-acp-agent ${AGENT_VERSION}\n`);
  process.exit(0);
}

let version = 1;
let nextOutgoingId = 1;
let sessionCounter = 0;
let toolCounter = 0;
let messageCounter = 0;
const waiting = new Map<Id, (message: Json) => void>();
const sessions = new Map<string, { cwd: string; turn: Turn | undefined }>();

interface Turn {
  readonly sessionId: string;
  cancelled: boolean;
  /** v1: answers the pending session/prompt. */
  readonly respond: ((result: Json) => void) | undefined;
}

function write(message: Json): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function reply(id: Id, result: Json): void {
  write({ id, result });
}

function fail(id: Id, code: number, message: string): void {
  write({ id, error: { code, message } });
}

function notify(method: string, params: Json): void {
  write({ method, params });
}

function request(method: string, params: Json): Promise<Json> {
  const id = nextOutgoingId;
  nextOutgoingId += 1;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    write({ id, method, params });
  });
}

function update(sessionId: string, value: Json): void {
  notify("session/update", { sessionId, update: value });
}

function say(turn: Turn, text: string): void {
  messageCounter += 1;
  const messageId = `standalone-message-${messageCounter}`;
  if (version === 1) {
    update(turn.sessionId, { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
    return;
  }
  update(turn.sessionId, { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
  update(turn.sessionId, { sessionUpdate: "agent_message", messageId, content: [{ type: "text", text }] });
}

function end(turn: Turn, stopReason: string): void {
  const session = sessions.get(turn.sessionId);
  if (session !== undefined && session.turn === turn) session.turn = undefined;
  if (version === 1) turn.respond?.({ stopReason });
  else update(turn.sessionId, { sessionUpdate: "state_update", state: "idle", stopReason });
}

async function runTurn(turn: Turn): Promise<void> {
  const session = sessions.get(turn.sessionId);
  const cwd = session === undefined ? "/" : session.cwd;
  say(turn, "Working on it.");
  toolCounter += 1;
  const toolCall = {
    toolCallId: `standalone-call-${toolCounter}`,
    title: "Run echo hello",
    kind: "execute",
    status: "pending",
    rawInput: { command: ["echo", "hello"] },
    locations: [{ path: cwd }],
  };
  update(turn.sessionId, version === 1 ? { sessionUpdate: "tool_call", ...toolCall } : { sessionUpdate: "tool_call_update", ...toolCall });
  const options = [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ];
  if (version === 2) update(turn.sessionId, { sessionUpdate: "state_update", state: "requires_action" });
  const answer =
    version === 1
      ? await request("session/request_permission", { sessionId: turn.sessionId, toolCall, options })
      : await request("session/request_permission", { sessionId: turn.sessionId, title: "Run echo hello?", subject: { type: "tool_call", toolCall }, options });
  if (turn.cancelled) return;
  if (version === 2) update(turn.sessionId, { sessionUpdate: "state_update", state: "running" });
  const outcome = ((answer["result"] as Json | undefined)?.["outcome"] ?? {}) as Json;
  const allowed = outcome["outcome"] === "selected" && outcome["optionId"] === "allow";
  update(turn.sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: toolCall.toolCallId,
    status: allowed ? "completed" : "failed",
    content: [{ type: "content", content: { type: "text", text: allowed ? "hello" : "permission denied" } }],
  });
  say(turn, allowed ? "Done." : "I was not allowed to run it.");
  end(turn, "end_turn");
}

function handleRequest(id: Id, method: string, params: Json): void {
  switch (method) {
    case "initialize": {
      const requested = params["protocolVersion"];
      version = requested === 2 ? 2 : 1;
      const info = { name: "standalone-acp-agent", version: AGENT_VERSION };
      if (version === 1) reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: info, authMethods: [] });
      else reply(id, { protocolVersion: 2, info, capabilities: { session: { mcp: { stdio: {} } } }, authMethods: [] });
      return;
    }
    case "session/new": {
      sessionCounter += 1;
      const sessionId = `standalone-session-${sessionCounter}`;
      sessions.set(sessionId, { cwd: typeof params["cwd"] === "string" ? params["cwd"] : "/", turn: undefined });
      reply(id, { sessionId });
      return;
    }
    case "session/prompt": {
      const sessionId = String(params["sessionId"]);
      const session = sessions.get(sessionId);
      if (session === undefined) {
        fail(id, -32002, `Resource not found: ${sessionId}`);
        return;
      }
      if (version === 1) {
        const turn: Turn = { sessionId, cancelled: false, respond: (result) => reply(id, result) };
        session.turn = turn;
        void runTurn(turn);
        return;
      }
      messageCounter += 1;
      const messageId = `standalone-user-${messageCounter}`;
      const turn: Turn = { sessionId, cancelled: false, respond: undefined };
      session.turn = turn;
      update(sessionId, { sessionUpdate: "user_message", messageId, content: params["prompt"] });
      update(sessionId, { sessionUpdate: "state_update", state: "running" });
      reply(id, { messageId });
      void runTurn(turn);
      return;
    }
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

function handleNotification(method: string, params: Json): void {
  if (method !== "session/cancel") return;
  const session = sessions.get(String(params["sessionId"]));
  const turn = session?.turn;
  if (turn === undefined) return;
  turn.cancelled = true;
  end(turn, "cancelled");
}

function handle(message: Json): void {
  const method = message["method"];
  const id = message["id"] as Id | undefined;
  if (typeof method === "string") {
    if (id === undefined) handleNotification(method, (message["params"] ?? {}) as Json);
    else handleRequest(id, method, (message["params"] ?? {}) as Json);
    return;
  }
  if (id !== undefined) {
    const resolve = waiting.get(id);
    waiting.delete(id);
    resolve?.(message);
  }
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffered += chunk;
  let newline = buffered.indexOf("\n");
  while (newline !== -1) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line !== "") {
      try {
        handle(JSON.parse(line) as Json);
      } catch {
        write({ id: null, error: { code: -32700, message: "Parse error" } });
      }
    }
    newline = buffered.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
