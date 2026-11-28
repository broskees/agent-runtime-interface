// The ARI bridge: a small Pi extension the driver loads into every Pi process
// with `pi --extension <file>`. Pi leaves permission policy, host MCP servers
// and session-tree navigation to extensions (Pi docs: extensions.md, mcp.md),
// so the bridge does exactly five things and nothing else:
//
// 1. It gates tool calls by the thread's ARI runtime mode. When a call needs
//    the user, it asks through Pi's extension UI (`ctx.ui.select`), which RPC
//    mode turns into an `extension_ui_request`. The dialog's title is a JSON
//    descriptor the driver reads (`parseApprovalTitle`), and each option
//    string is a native option id.
// 2. It reports Pi's own working directory (`ctx.cwd`, which Pi resolves) as
//    a `setStatus` record under the key `ari`, so a thread started in a
//    directory reached through a symbolic link reports the real one.
// 3. It adds three commands the driver sends as prompts (Pi runs an extension
//    command at once and never adds it to the conversation): `/ari-mcp <json>`
//    registers the host's MCP servers with `pi.registerMcpServer`, under the
//    names the host chose, so nothing is written to Pi's `mcp.json`;
//    `/ari-rewind <entry>` moves the session's leaf with `ctx.navigateTree`
//    and persists the move as a label entry, so rollback and fork from a turn
//    stay in Pi's own session file; `/ari-context <json>` holds host
//    instructions for the next run only.
// 4. Its `before_agent_start` handler appends those held instructions to that
//    one run's system prompt.
// 5. `/ari-persist` writes the session's header, as Pi's session manager holds
//    it, to the session file when Pi has not written that file yet, and then
//    stops Pi with `ctx.shutdown()`. Pi writes a session file only once it
//    holds a message, and `--session <file>` of a missing file starts a
//    different session there (Pi's SessionManager._setSessionFile), so a
//    thread without messages needs its header on disk to reopen as itself.
//    The running session manager is not told about the file and could not
//    append to it (its first write creates the file exclusively), so the
//    process must not go on: in RPC mode Pi shuts down once the command has
//    answered and the session is idle. The driver sends it only when it stops
//    an idle process.
//
// The bridge never writes instructions of its own into the model's prompt.
// Its one setting, the runtime mode, arrives in the environment variable
// `ARI_PI_BRIDGE`, which it deletes once read.

/** The environment variable that carries the bridge's settings. */
export const BRIDGE_SETTINGS_VARIABLE = "ARI_PI_BRIDGE";

/** The bridge's file name under the instance's cache directory. */
export const BRIDGE_FILE_NAME = "ari-pi-bridge.ts";

/** The `setStatus` key under which the bridge reports Pi's working directory. */
export const BRIDGE_STATUS_KEY = "ari";

export const MCP_COMMAND = "ari-mcp";
export const REWIND_COMMAND = "ari-rewind";
export const CONTEXT_COMMAND = "ari-context";
export const PERSIST_COMMAND = "ari-persist";

/** The ARI runtime modes the bridge enforces. */
export type BridgeMode = "read_only" | "approval_required" | "auto_accept_edits" | "full_access";

/** An MCP server as `pi.registerMcpServer` takes it. */
export interface BridgeMcpServer {
  readonly name: string;
  readonly config: { readonly [field: string]: unknown };
}

/** What the driver passes to the bridge in `ARI_PI_BRIDGE`. `mode: null`: the host left the mode to Pi, so the bridge gates no tool. */
export interface BridgeSettings {
  readonly mode: BridgeMode | null;
}

/** One option of an approval dialog, as the bridge describes it in the dialog's title. */
export interface ApprovalDescriptorOption {
  readonly id: string;
  readonly label: string;
  readonly decision: string;
  readonly scope?: string;
}

/** The JSON title of the bridge's approval dialog. */
export interface ApprovalDescriptor {
  readonly ari: "approval";
  readonly kind: string;
  readonly tool: string;
  readonly input: unknown;
  readonly options: readonly ApprovalDescriptorOption[];
}

/** The descriptor in a `select` title, or undefined when the dialog is not the bridge's approval. */
export function parseApprovalTitle(title: string): ApprovalDescriptor | undefined {
  if (!title.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(title);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as { ari?: unknown; kind?: unknown; tool?: unknown; input?: unknown; options?: unknown };
  if (candidate.ari !== "approval" || typeof candidate.kind !== "string" || typeof candidate.tool !== "string" || !Array.isArray(candidate.options)) return undefined;
  const options: ApprovalDescriptorOption[] = [];
  for (const option of candidate.options as unknown[]) {
    if (typeof option !== "object" || option === null) return undefined;
    const { id, label, decision, scope } = option as { id?: unknown; label?: unknown; decision?: unknown; scope?: unknown };
    if (typeof id !== "string" || typeof label !== "string" || typeof decision !== "string") return undefined;
    options.push({ id, label, decision, ...(typeof scope === "string" ? { scope } : {}) });
  }
  return { ari: "approval", kind: candidate.kind, tool: candidate.tool, input: candidate.input, options };
}

/**
 * The extension's source. Pi hands it the `ExtensionAPI` object; it reads
 * `process.env`, and imports only `node:fs` for `/ari-persist`.
 * `pi /*: ExtensionAPI *\/` marks the parameter the committed type check
 * annotates with Pi's own type.
 */
export const PI_BRIDGE_SOURCE = String.raw`// ARI bridge for Pi. Written by the ARI Pi driver; loaded with pi --extension.
// It adds nothing to the model's prompt except text the host gave for one run.
import { existsSync, writeFileSync } from "node:fs";

const SETTINGS_VARIABLE = "ARI_PI_BRIDGE";
const STATUS_KEY = "ari";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const FILE_CHANGE_TOOLS = ["edit", "write"];
const OPTIONS = [
  { id: "allow-once", label: "Allow once", decision: "accept", scope: "once" },
  { id: "allow-session", label: "Allow for the rest of this Pi process", decision: "accept_for_session", scope: "session" },
  { id: "decline", label: "Decline", decision: "decline" },
];

function readSettings() {
  const text = process.env[SETTINGS_VARIABLE];
  // Without settings the bridge fails closed: every tool that is not read-only asks.
  if (text === undefined || text === "") return { mode: "approval_required" };
  try {
    const parsed = JSON.parse(text);
    // null: the host left the mode to Pi, which asks before nothing, so the bridge gates nothing.
    if (parsed.mode === null) return { mode: null };
    return { mode: typeof parsed.mode === "string" ? parsed.mode : "approval_required" };
  } catch {
    return { mode: "approval_required" };
  }
}

function verdictFor(mode, toolName) {
  if (mode === null || mode === "full_access" || READ_ONLY_TOOLS.includes(toolName)) return "allow";
  if (mode === "read_only") return "block";
  if (mode === "auto_accept_edits" && FILE_CHANGE_TOOLS.includes(toolName)) return "allow";
  return "ask";
}

function approvalKind(toolName) {
  if (toolName === "bash") return "command";
  if (FILE_CHANGE_TOOLS.includes(toolName)) return "file_change";
  return "permission";
}

export default function ariBridge(pi /*: ExtensionAPI */) {
  const settings = readSettings();
  delete process.env[SETTINGS_VARIABLE];

  const allowedForProcess = new Set();
  let pendingContext = "";

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, JSON.stringify({ cwd: ctx.cwd }));
  });

  pi.on("tool_call", async (event, ctx) => {
    const verdict = verdictFor(settings.mode, event.toolName);
    if (verdict === "allow") return undefined;
    if (verdict === "block") return { block: true };
    const key = event.toolName === "bash" ? "bash:" + String(event.input.command) : event.toolName;
    if (allowedForProcess.has(key)) return undefined;
    const title = JSON.stringify({ ari: "approval", kind: approvalKind(event.toolName), tool: event.toolName, input: event.input, options: OPTIONS });
    const choice = await ctx.ui.select(title, OPTIONS.map((option) => option.id), { signal: ctx.signal });
    if (choice === "allow-once") return undefined;
    if (choice === "allow-session") {
      allowedForProcess.add(key);
      return undefined;
    }
    return { block: true };
  });

  pi.registerCommand("ari-mcp", {
    description: "Register the host's MCP servers for this session (used by ARI)",
    handler: async (args) => {
      const parsed = JSON.parse(args);
      for (const server of parsed.servers) pi.registerMcpServer(server.name, server.config);
    },
  });

  pi.registerCommand("ari-rewind", {
    description: "Move the session leaf to an entry (used by ARI for rollback and forks)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await ctx.navigateTree(args.trim(), { summarize: false, label: "ari-rewind" });
    },
  });

  pi.registerCommand("ari-context", {
    description: "Hold host instructions for the next run (used by ARI)",
    handler: async (args) => {
      const parsed = JSON.parse(args);
      if (typeof parsed.text !== "string" || parsed.text === "") return;
      pendingContext = pendingContext === "" ? parsed.text : pendingContext + "\n\n" + parsed.text;
    },
  });

  pi.registerCommand("ari-persist", {
    description: "Write the session header if pi has not written the session file yet, then shut pi down (used by ARI to stop pi)",
    handler: async (_args, ctx) => {
      const file = ctx.sessionManager.getSessionFile();
      const header = ctx.sessionManager.getHeader();
      // Exclusive create: a file pi wrote meanwhile is never overwritten.
      if (file !== undefined && header !== null && !existsSync(file)) writeFileSync(file, JSON.stringify(header) + "\n", { flag: "wx" });
      // This session manager cannot append to a file it did not create, so this pi must not go on.
      ctx.shutdown();
    },
  });

  pi.on("before_agent_start", (event) => {
    if (pendingContext === "") return undefined;
    const text = pendingContext;
    pendingContext = "";
    return { systemPrompt: event.systemPrompt + "\n\n" + text };
  });
}
`;
