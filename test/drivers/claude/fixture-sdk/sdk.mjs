// A stand-in for the entry module of `@anthropic-ai/claude-agent-sdk`, for
// tests that make the claude driver load an SDK from a directory on disk
// (the `sdkDirectory` config field, or a managed install). The tests copy it
// into a package laid out as the real one is (see sdk-fixture.ts).
//
// Like the real `sdk.mjs` it is plain JavaScript that imports only Node
// built-ins, so the standalone ari-driver can load it by file URL. It finds
// its native Claude Code binary as the real SDK does:
// `options.pathToClaudeCodeExecutable`, else the first of its platform
// packages that resolves from this file, else it throws the real SDK's error.
// Each query runs that binary once with `--version`, and answers each prompt
// with an init message, one assistant message and a success result whose
// text quotes the binary's answer, so a test sees which binary ran. It
// spawns nothing else and reaches no network.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** The SDK's platform packages for this process, in the SDK's own order. */
function nativeCandidates() {
  const extension = process.platform === "win32" ? ".exe" : "";
  const report = typeof process.report?.getReport === "function" ? process.report.getReport() : undefined;
  const musl = process.platform === "linux" && report !== undefined && report.header?.glibcVersionRuntime === undefined;
  const packages =
    process.platform === "linux"
      ? musl
        ? [`${PACKAGE}-linux-${process.arch}-musl`, `${PACKAGE}-linux-${process.arch}`]
        : [`${PACKAGE}-linux-${process.arch}`, `${PACKAGE}-linux-${process.arch}-musl`]
      : [`${PACKAGE}-${process.platform}-${process.arch}`];
  return packages.map((name) => `${name}/claude${extension}`);
}

function findExecutable(options) {
  if (options.pathToClaudeCodeExecutable !== undefined) return options.pathToClaudeCodeExecutable;
  const require = createRequire(fileURLToPath(import.meta.url));
  for (const candidate of nativeCandidates()) {
    try {
      const resolved = require.resolve(candidate);
      if (existsSync(resolved)) return resolved;
    } catch {
      // The next candidate.
    }
  }
  throw new Error(`Native CLI binary for ${process.platform}-${process.arch} not found. Reinstall ${PACKAGE} without --omit=optional, or set options.pathToClaudeCodeExecutable.`);
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

export function query({ prompt, options = {} }) {
  const executable = findExecutable(options);
  const native = execFileSync(executable, ["--version"], { encoding: "utf8", env: options.env ?? {} }).trim();
  const sessionId = options.sessionId ?? options.resume ?? randomUUID();
  const model = options.model ?? "fixture-model";
  const pending = [];
  let wake = () => {};
  let closed = false;
  let answered = 0;
  const push = (message) => {
    pending.push(message);
    wake();
  };

  void (async () => {
    for await (const message of prompt) {
      if (closed) return;
      answered += 1;
      const text = `fixture SDK reply ${answered}, from the native binary that answered: ${native}`;
      push({ type: "system", subtype: "init", uuid: randomUUID(), session_id: sessionId, cwd: options.cwd ?? process.cwd(), model, claude_code_version: native, slash_commands: [], permissionMode: options.permissionMode ?? "default", tools: [] });
      push({
        type: "assistant",
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { id: `msg_fixture_${answered}`, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: USAGE },
      });
      push({
        type: "result",
        subtype: "success",
        uuid: randomUUID(),
        session_id: sessionId,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 1,
        duration_api_ms: 1,
        usage: USAGE,
        modelUsage: {},
        permission_denials: [],
        result: text,
        stop_reason: "end_turn",
        terminal_reason: "completed",
        ...(message.uuid === undefined ? {} : { user_message_uuid: message.uuid, user_message_uuids: [message.uuid] }),
      });
    }
  })();

  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (pending.length > 0) {
          yield pending.shift();
          continue;
        }
        if (closed) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
    initializationResult: async () => ({ models: [{ value: model, displayName: "Fixture model", description: "" }], commands: [], account: {} }),
    supportedModels: async () => [{ value: model, displayName: "Fixture model", description: "" }],
    setMcpServers: async (servers) => ({ added: Object.keys(servers), removed: [], errors: {} }),
    setPermissionMode: async () => undefined,
    setModel: async () => undefined,
    applyFlagSettings: async () => undefined,
    interrupt: async () => undefined,
    stopTask: async () => undefined,
    rewindFiles: async () => ({ canRewind: false, error: "the fixture SDK keeps no checkpoints" }),
    close: () => {
      closed = true;
      wake();
    },
  };
}

export const getSessionInfo = async () => undefined;
export const getSessionMessages = async () => [];
export const listSessions = async () => [];
export const deleteSession = async () => undefined;
export const archiveSession = async () => undefined;
