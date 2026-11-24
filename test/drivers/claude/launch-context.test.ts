// Host instructions and names: without a LaunchContext or context the
// driver adds no instruction text of its own; with them, each marker
// reaches Claude through a channel the driver declares; host MCP servers
// appear only under the names the host chose; and nothing from the
// LaunchContext is written under Claude's config directory. Thread
// creation, resume (in a new session and of a live thread) and fork are
// each checked.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CAPABILITIES } from "../../../src/drivers/claude/index.ts";
import { FakeClaudeWorld } from "./fake-sdk.ts";
import { openClaudeRig } from "./rig.ts";
import type { ClaudeRig } from "./rig.ts";

const MARKERS = {
  appendSystemPrompt: "ARI-MARKER-launch-append-system",
  developerPrompt: "ARI-MARKER-launch-developer",
  threadSystem: "ARI-MARKER-thread-system",
  threadDeveloper: "ARI-MARKER-thread-developer",
  turnSystem: "ARI-MARKER-turn-system",
  turnDeveloper: "ARI-MARKER-turn-developer",
  synthetic: "ARI-MARKER-turn-synthetic",
  resumeAppend: "ARI-MARKER-resume-append",
  launchServer: "ari-marker-launch-server",
  launchCommand: "ari-marker-launch-command",
} as const;

function queryOptions(rig: ClaudeRig): Options[] {
  return rig.world.calls.flatMap((call) => (call.kind === "query" ? [call.options] : []));
}

/** Every string in an options object, callbacks and controllers aside. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null && !(value instanceof AbortController)) return Object.entries(value).flatMap(([key, field]) => (key === "env" ? [] : strings(field)));
  return [];
}

function filesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

describe("claude driver: host instructions and host-chosen names", () => {
  test("without a LaunchContext or context, creating, resuming and forking a thread and starting a turn carry no instruction text the driver wrote", async () => {
    const rig = await openClaudeRig();
    try {
      const thread = await rig.thread();
      await rig.simpleTurn(thread.id, "Just the host's words.");
      const { session } = await rig.openAnother();
      await session.resumeThread({ native: { handle: thread.handle! }, policy: rig.policy() });
      const fork = await rig.session.forkThread!({ threadId: thread.id, at: { type: "latest" } });
      await rig.simpleTurn(fork.id, "In the fork.");
      const options = queryOptions(rig);
      assert.equal(options.length, 3);
      for (const option of options) {
        // Claude Code's own prompt, with nothing appended, never recorded in the transcript.
        assert.deepEqual(option.systemPrompt, { type: "preset", preset: "claude_code", snapshot: false });
        const texts = strings(option).filter((text) => text.includes(" "));
        assert.deepEqual(texts, [], `the driver put text into query options: ${JSON.stringify(texts)}`);
      }
      for (const prompt of rig.world.prompts()) {
        assert.ok(Array.isArray(prompt.message.content));
        assert.deepEqual(prompt.message.content.map((block) => block.type), ["text"]);
      }
      assert.deepEqual(rig.world.prompts().map((prompt) => (Array.isArray(prompt.message.content) ? (prompt.message.content[0] as { text: string }).text : prompt.message.content)), ["Just the host's words.", "In the fork."]);
    } finally {
      await rig.cleanup();
    }
  });

  test("each marker reaches Claude through a declared channel: thread instructions through the system prompt's append, turn instructions through the turn's prompt; resume and fork carry them", async () => {
    assert.deepEqual(CLAUDE_CAPABILITIES.context.instructionChannels, ["system", "first_user_message"]);
    const rig = await openClaudeRig({ open: { launch: { appendSystemPrompt: [MARKERS.appendSystemPrompt], developerPrompt: [MARKERS.developerPrompt] } } });
    try {
      const thread = await rig.thread({ context: { system: MARKERS.threadSystem, developer: MARKERS.threadDeveloper } });
      const created = queryOptions(rig).at(-1)!;
      const append = (created.systemPrompt as { append?: string }).append ?? "";
      for (const marker of [MARKERS.appendSystemPrompt, MARKERS.developerPrompt, MARKERS.threadSystem, MARKERS.threadDeveloper]) assert.ok(append.includes(marker), `${marker} is not in the system prompt`);
      assert.equal((created.systemPrompt as { snapshot?: boolean }).snapshot, false);

      const { turnId, native } = await rig.turn(thread.id, "Work.", { context: { system: MARKERS.turnSystem, developer: MARKERS.turnDeveloper, synthetic: [{ key: "k", text: MARKERS.synthetic }] } });
      const prompt = rig.world.prompts().at(-1)!;
      assert.deepEqual(prompt.message.content, [
        { type: "text", text: MARKERS.turnSystem },
        { type: "text", text: MARKERS.turnDeveloper },
        { type: "text", text: MARKERS.synthetic },
        { type: "text", text: "Work." },
      ]);
      assert.equal(native.prompt.includes(MARKERS.turnDeveloper), true);
      await native.complete();
      await rig.terminal(turnId);

      // A resume in a fresh session of the same instance carries the session's launch text again.
      const { session } = await rig.openAnother({ launch: { appendSystemPrompt: [MARKERS.appendSystemPrompt] } });
      await session.resumeThread({ native: { handle: thread.handle! }, policy: rig.policy() });
      const resumed = queryOptions(rig).at(-1)!;
      assert.equal(resumed.resume, thread.handle);
      assert.ok(((resumed.systemPrompt as { append?: string }).append ?? "").includes(MARKERS.appendSystemPrompt));
      // A fork carries its source's launch and thread instructions.
      await rig.session.forkThread!({ threadId: thread.id, at: { type: "latest" } });
      const forked = queryOptions(rig).at(-1)!;
      assert.equal(forked.forkSession, true);
      for (const marker of [MARKERS.appendSystemPrompt, MARKERS.threadDeveloper]) assert.ok(((forked.systemPrompt as { append?: string }).append ?? "").includes(marker));
    } finally {
      await rig.cleanup();
    }
  });

  test("a resume of a live thread with new instructions reopens its query with resume, so Claude Code reads the new append; the same instructions keep the query", async () => {
    const rig = await openClaudeRig();
    const append = (options: Options): string | undefined => (options.systemPrompt as { append?: string }).append;
    try {
      const thread = await rig.thread({ launch: { appendSystemPrompt: [MARKERS.appendSystemPrompt] } });
      const handle = thread.handle!;
      await rig.simpleTurn(thread.id, "Work.");
      const first = rig.world.queries.at(-1)!;
      // The same instructions again: the running query already has them.
      await rig.session.resumeThread({ native: { handle }, launch: { appendSystemPrompt: [MARKERS.appendSystemPrompt] } });
      assert.equal(queryOptions(rig).length, 1);
      // New instructions: a running query's system prompt cannot change, so Claude Code resumes the session in a new query that has them.
      await rig.session.resumeThread({ native: { handle }, launch: { appendSystemPrompt: [MARKERS.resumeAppend] } });
      assert.equal(queryOptions(rig).length, 2);
      const resumed = queryOptions(rig).at(-1)!;
      assert.equal(resumed.resume, handle);
      assert.equal(append(resumed), MARKERS.resumeAppend);
      assert.equal(first.alive, false, "the old query still runs");
      const turnId = await rig.simpleTurn(thread.id, "Work again.");
      assert.equal(rig.world.queries.at(-1)!.alive, true);
      assert.equal(rig.world.calls.filter((call) => call.kind === "prompt").at(-1)?.sessionId, handle);
      assert.equal((await rig.terminal(turnId)).status, "completed");
      // While a turn runs the query cannot be replaced: the resume is refused and changes nothing.
      const running = await rig.turn(thread.id, "Long work.");
      await assert.rejects(rig.session.resumeThread({ native: { handle }, launch: { appendSystemPrompt: ["ARI-MARKER-refused"] } }), (error: { callError?: { code: string } }) => error.callError?.code === "invalid_state");
      assert.equal(queryOptions(rig).length, 2);
      await running.native.complete();
      await rig.terminal(running.turnId);
      // A thread with no transcript yet starts its session again under the same id, with the new append.
      const fresh = await rig.thread({ launch: { appendSystemPrompt: [MARKERS.appendSystemPrompt] } });
      await rig.session.resumeThread({ native: { handle: fresh.handle! }, launch: { appendSystemPrompt: [MARKERS.resumeAppend] } });
      const restarted = queryOptions(rig).at(-1)!;
      assert.equal(queryOptions(rig).length, 4);
      assert.deepEqual([restarted.sessionId, restarted.resume, append(restarted)], [fresh.handle, undefined, MARKERS.resumeAppend]);
      await rig.simpleTurn(fresh.id, "First words.");
    } finally {
      await rig.cleanup();
    }
  });

  test("host MCP servers reach Claude only under the names hostTools.mcpServerFor returned and the host gave the launch servers, on create, resume and fork", async () => {
    const rig = await openClaudeRig({
      open: { launch: { mcpServers: [{ name: MARKERS.launchServer, transport: "stdio", command: MARKERS.launchCommand }] } },
      host: { mcpServerName: (threadId) => `host-chose-${threadId.slice(-6)}` },
    });
    try {
      const thread = await rig.thread();
      await rig.simpleTurn(thread.id, "Hi.");
      const { session } = await rig.openAnother({ launch: { mcpServers: [{ name: MARKERS.launchServer, transport: "stdio", command: MARKERS.launchCommand }] } });
      await session.resumeThread({ native: { handle: thread.handle! }, policy: rig.policy() });
      const fork = await rig.session.forkThread!({ threadId: thread.id, at: { type: "latest" } });
      const asked = rig.host.calls.filter((call) => call.operation === "hostTools.mcpServerFor").map((call) => call.args[0]);
      assert.deepEqual(asked, [thread.id, thread.id, fork.id]);
      const sets = rig.world.calls.filter((call) => call.kind === "setMcpServers");
      assert.equal(sets.length, 3);
      for (const [index, threadId] of [thread.id, thread.id, fork.id].entries()) {
        const call = sets[index]!;
        assert.ok(call.kind === "setMcpServers");
        assert.deepEqual(Object.keys(call.servers).sort(), [MARKERS.launchServer, `host-chose-${threadId.slice(-6)}`].sort());
      }
      // No query option names an MCP server: every server goes through setMcpServers, which a later change can replace.
      for (const options of queryOptions(rig)) assert.equal(options.mcpServers, undefined);
    } finally {
      await rig.cleanup();
    }
  });

  test("LaunchContext values are never written under Claude's config directory in a temp HOME, though Claude Code keeps its transcripts there", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ari-claude-home-"));
    const rig = await openClaudeRig({
      writeTranscripts: true,
      environment: { HOME: home, PATH: "/usr/bin:/bin" },
      open: {
        launch: {
          appendSystemPrompt: [MARKERS.appendSystemPrompt],
          developerPrompt: [MARKERS.developerPrompt],
          mcpServers: [{ name: MARKERS.launchServer, transport: "stdio", command: MARKERS.launchCommand }],
        },
      },
    });
    try {
      const thread = await rig.thread({ context: { developer: MARKERS.threadDeveloper } });
      await rig.simpleTurn(thread.id, "First.");
      const { session } = await rig.openAnother({ launch: { appendSystemPrompt: [MARKERS.appendSystemPrompt], mcpServers: [{ name: MARKERS.launchServer, transport: "stdio", command: MARKERS.launchCommand }] } });
      const resumed = await session.resumeThread({ native: { handle: thread.handle! }, policy: rig.policy() });
      const resumedTurn = await session.startTurn({ threadId: resumed.id, clientTurnKey: "after-resume", intent: "start", content: [{ type: "text", text: "Second." }] });
      const native = await rig.world.nextTurn();
      await native.complete();
      assert.equal(resumedTurn.status, "accepted");
      const fork = await rig.session.forkThread!({ threadId: thread.id, at: { type: "latest" } });
      await rig.simpleTurn(fork.id, "Third.");
      const files = filesUnder(path.join(home, ".claude"));
      assert.ok(files.length >= 2, `Claude Code kept no transcripts under ${home}: ${files.join(", ")}`);
      for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        for (const marker of [MARKERS.appendSystemPrompt, MARKERS.developerPrompt, MARKERS.threadDeveloper, MARKERS.launchServer, MARKERS.launchCommand]) {
          assert.ok(!text.includes(marker), `${file} holds ${marker}`);
        }
      }
      // Every query ran with the instance's HOME, so the check above looked where Claude Code writes.
      for (const options of queryOptions(rig)) assert.equal(options.env?.["HOME"], home);
    } finally {
      await rig.cleanup();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("the check above can see a leak: Claude Code records an appended prompt in the transcript unless snapshot is false", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ari-claude-home-"));
    try {
      const world = new FakeClaudeWorld({ writeTranscripts: true });
      async function* prompts() {
        yield { type: "user" as const, message: { role: "user" as const, content: "hello" }, parent_tool_use_id: null };
      }
      const query = world.sdk.query({ prompt: prompts(), options: { cwd: home, env: { HOME: home }, sessionId: world.newUuid(), systemPrompt: { type: "preset", preset: "claude_code", append: MARKERS.appendSystemPrompt } } });
      const turn = await world.nextTurn();
      await turn.complete();
      for await (const message of query) void message;
      const leaked = filesUnder(path.join(home, ".claude")).some((file) => fs.readFileSync(file, "utf8").includes(MARKERS.appendSystemPrompt));
      assert.equal(leaked, true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
