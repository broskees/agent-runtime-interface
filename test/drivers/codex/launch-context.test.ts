// No host prompts and host-chosen names: the driver writes no instructions of
// its own into Codex's frames, the host's instructions reach Codex only
// through the channel the driver declares, host tool servers appear only
// under the names the host chose, and nothing of the launch context is ever
// written to a file.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import { isAriError } from "../../../src/index.ts";
import { codexRig, policy } from "./rig.ts";
import type { CodexTestRig } from "./rig.ts";

let rig: CodexTestRig | undefined;
afterEach(async () => {
  await rig?.cleanup();
  rig = undefined;
});

/** Every `to_codex` request the fake took, as one JSON text per frame. */
function sentTexts(current: CodexTestRig): string[] {
  return current.world.requests.map((request) => JSON.stringify({ method: request.method, params: request.params }));
}

function walk(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const MARKERS = {
  appendSystem: "MARKER-APPEND-SYSTEM-7f3a",
  developerPrompt: "MARKER-DEVELOPER-PROMPT-91c2",
  contextSystem: "MARKER-CONTEXT-SYSTEM-4be1",
  contextDeveloper: "MARKER-CONTEXT-DEVELOPER-0d77",
  turnDeveloper: "MARKER-TURN-DEVELOPER-62aa",
  synthetic: "MARKER-SYNTHETIC-c815",
};

describe("no host prompts and host-chosen names", () => {
  test("with no LaunchContext and no context, thread and turn frames carry no instruction text the driver wrote", async () => {
    rig = await codexRig();
    const first = await rig.open();
    const thread = await first.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const started = await first.session.startTurn({ threadId: thread.id, clientTurnKey: "t-1", intent: "start", content: [{ type: "text", text: "Hello." }] });
    await (await rig.nextTurn()).complete();
    await first.until(() => first.bodies("turn.terminal").find((body) => body.turnId === (started as { turnId: string }).turnId), "the turn to end");
    await first.session.close();
    const second = await rig.open();
    await second.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd) });

    const start = rig.requests("thread/start").at(-1)!;
    assert.deepEqual(Object.keys(start).sort(), ["approvalPolicy", "approvalsReviewer", "cwd", "sandbox"]);
    const turn = rig.requests("turn/start").at(-1)!;
    assert.deepEqual(turn["input"], [{ type: "text", text: "Hello.", text_elements: [] }]);
    assert.equal(turn["additionalContext"], undefined);
    const resume = rig.requests("thread/resume").at(-1)!;
    for (const params of [start, turn, resume]) {
      for (const key of ["baseInstructions", "developerInstructions", "personality", "additionalContext"]) assert.equal(params[key], undefined, `${key} in ${JSON.stringify(params)}`);
    }
    // The resume config holds only the host's tool server, which the host named.
    assert.deepEqual(Object.keys(resume["config"] as object), [`mcp_servers.host-tools-${thread.id}`]);
  });

  test("a new thread has the host's per-thread tool server before its first turn runs, and keeps the launch servers", async () => {
    rig = await codexRig({ host: { mcpServerName: (threadId) => `orchestrator-${threadId.slice(-6)}` } });
    const opened = await rig.open();
    const launch = { mcpServers: [{ name: "host-preview", transport: "http", url: "http://127.0.0.1:4555/mcp" }] };
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), launch });
    const hostName = `orchestrator-${thread.id.slice(-6)}`;
    assert.deepEqual(rig.host.calls.filter((call) => call.operation === "hostTools.mcpServerFor").map((call) => call.args), [[thread.id, { transport: "http" }]]);
    // Codex has the servers loaded before any turn: they are the thread's live config.
    assert.deepEqual(rig.world.storedThread(thread.native.id!)!.settings.mcpServers.sort(), [hostName, "host-preview"].sort());
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "first", intent: "start", content: [{ type: "text", text: "Use the tools." }] });
    const first = await rig.nextTurn();
    assert.deepEqual([...first.settings.mcpServers].sort(), [hostName, "host-preview"].sort(), "the first turn runs with the host's tool server");
    await first.complete();
    await opened.until(() => opened.bodies("turn.terminal").find((body) => body.turnId === (started as { turnId: string }).turnId), "the first turn to end");
    // Codex refuses a resume before the first turn, and ignores a resume's config while the thread is loaded, so the driver archives and unarchives the new thread first.
    assert.deepEqual(
      rig.world.requests.filter((request) => request.params !== null && (request.params as { threadId?: string }).threadId === thread.native.id).map((request) => request.method).slice(0, 4),
      ["thread/archive", "thread/unarchive", "thread/resume", "turn/start"],
    );
    const nativeSessions = await rig.instance.nativeSessions!.list({ cwd: rig.cwd });
    assert.ok(nativeSessions.items.some((item) => item.id === thread.native.id), "the thread is not left archived");
  });

  test("the replacement thread after a failed resume keeps that resume's launch context, and gets the host's tool server before its first turn", async () => {
    rig = await codexRig();
    const first = await rig.open();
    const thread = await first.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    await first.session.close();
    rig.world.lock(thread.native.id!);
    const second = await rig.open();
    const launch = { appendSystemPrompt: [MARKERS.appendSystem], mcpServers: [{ name: "host-preview", transport: "http", url: "http://127.0.0.1:4555/mcp" }] };
    const replacement = await second.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd), launch });
    assert.notEqual(replacement.native.id, thread.native.id);
    await second.until(() => second.bodies("session.replaced")[0], "session.replaced");
    const start = rig.requests("thread/start").at(-1)!;
    assert.match(String(start["developerInstructions"]), new RegExp(MARKERS.appendSystem));
    assert.deepEqual(Object.keys(start["config"] as object), ["mcp_servers.host-preview"]);
    assert.deepEqual(rig.world.storedThread(replacement.native.id!)!.settings.mcpServers.sort(), [`host-tools-${replacement.id}`, "host-preview"].sort());
    const started = await second.session.startTurn({ threadId: replacement.id, clientTurnKey: "after", intent: "start", content: [{ type: "text", text: "Go on." }] });
    const turn = await rig.nextTurn();
    assert.deepEqual([...turn.settings.mcpServers].sort(), [`host-tools-${replacement.id}`, "host-preview"].sort());
    assert.match(String(rig.requests("thread/resume").at(-1)!["developerInstructions"]), new RegExp(MARKERS.appendSystem));
    await turn.complete();
    await second.until(() => second.bodies("turn.terminal").find((body) => body.turnId === (started as { turnId: string }).turnId), "the turn to end");
  });

  test("a fork gets the source's launch MCP servers in thread/fork, and the host's tool server for the fork before its first turn", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    const launch = { mcpServers: [{ name: "host-preview", transport: "http", url: "http://127.0.0.1:4555/mcp" }] };
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), launch });
    const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "one", intent: "start", content: [{ type: "text", text: "One." }] });
    await (await rig.nextTurn()).complete();
    await opened.until(() => opened.bodies("turn.terminal").find((body) => body.turnId === (started as { turnId: string }).turnId), "the turn to end");
    const fork = await opened.session.forkThread!({ threadId: thread.id, at: { type: "latest" } });
    assert.deepEqual(rig.requests("thread/fork").at(-1)!["config"], { "mcp_servers.host-preview": { url: "http://127.0.0.1:4555/mcp" } });
    const forkStarted = await opened.session.startTurn({ threadId: fork.id, clientTurnKey: "fork", intent: "start", content: [{ type: "text", text: "On the fork." }] });
    const turn = await rig.nextTurn();
    assert.equal(turn.nativeThreadId, fork.native.id);
    assert.deepEqual([...turn.settings.mcpServers].sort(), [`host-tools-${fork.id}`, "host-preview"].sort());
    await turn.complete();
    await opened.until(() => opened.bodies("turn.terminal").find((body) => body.turnId === (forkStarted as { turnId: string }).turnId), "the fork's turn to end");
  });

  test("launch.appendSystemPrompt and context markers reach Codex through the developer channel the driver lists", async () => {
    rig = await codexRig();
    const opened = await rig.open();
    assert.deepEqual(opened.session.capabilities().context.instructionChannels, ["developer"]);
    const thread = await opened.session.createThread({
      cwd: rig.cwd,
      policy: policy(rig.cwd),
      launch: { appendSystemPrompt: [MARKERS.appendSystem], developerPrompt: [MARKERS.developerPrompt] },
      context: { system: MARKERS.contextSystem, developer: MARKERS.contextDeveloper },
    });
    const instructions = String(rig.requests("thread/start").at(-1)!["developerInstructions"]);
    for (const marker of [MARKERS.appendSystem, MARKERS.developerPrompt, MARKERS.contextSystem, MARKERS.contextDeveloper]) assert.ok(instructions.includes(marker), `${marker} missing from developerInstructions`);

    await opened.session.startTurn({
      threadId: thread.id,
      clientTurnKey: "c-1",
      intent: "start",
      content: [{ type: "text", text: "Go." }],
      context: { developer: MARKERS.turnDeveloper, synthetic: [{ key: "file:README.md", text: MARKERS.synthetic }] },
    });
    const turn = rig.requests("turn/start").at(-1)!;
    assert.deepEqual(turn["additionalContext"], {
      "host.instructions": { kind: "application", value: MARKERS.turnDeveloper },
      "file:README.md": { kind: "untrusted", name: "file:README.md", value: MARKERS.synthetic },
    });
    await (await rig.nextTurn()).complete();
    // A fork keeps the thread's launch instructions; so does a resume that passes them again.
    await opened.until(() => (opened.session.canRelease() ? true : undefined), "the turn to end");
    await opened.session.forkThread!({ threadId: thread.id, at: { type: "latest" } });
    assert.ok(String(rig.requests("thread/fork").at(-1)!["developerInstructions"]).includes(MARKERS.appendSystem));
  });

  test("host tool MCP servers appear only under the names the host chose", async () => {
    rig = await codexRig({ host: { mcpServerName: (threadId) => `orchestrator-${threadId.slice(-6)}` } });
    const first = await rig.open();
    const launch = { mcpServers: [{ name: "host-preview", transport: "http", url: "http://127.0.0.1:4555/mcp", headers: { Authorization: "Bearer t" } }] };
    const thread = await first.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), launch });
    assert.deepEqual(rig.requests("thread/start").at(-1)!["config"], { "mcp_servers.host-preview": { url: "http://127.0.0.1:4555/mcp", http_headers: { Authorization: "Bearer t" } } });
    await first.session.close();

    const second = await rig.open();
    await second.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd), launch });
    const asked = rig.host.calls.filter((call) => call.operation === "hostTools.mcpServerFor");
    assert.deepEqual(asked.at(-1)!.args, [thread.id, { transport: "http" }]);
    const hostName = `orchestrator-${thread.id.slice(-6)}`;
    assert.deepEqual(Object.keys(rig.requests("thread/resume").at(-1)!["config"] as object).sort(), [`mcp_servers.${hostName}`, "mcp_servers.host-preview"].sort());

    // No other MCP server name appears in anything the driver sent.
    const names = new Set(sentTexts(rig).flatMap((text) => [...text.matchAll(/mcp_servers\.([^"]+)"/g)].map((match) => match[1]!)));
    assert.deepEqual([...names].sort(), [hostName, "host-preview"].sort());
    await assert.rejects(second.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), launch: { mcpServers: [{ name: "old", transport: "sse", url: "http://127.0.0.1:1/sse" }] } }), (error) => isAriError(error, "unsupported"));
  });

  test("LaunchContext values are never written to a file under Codex's config directories or the instance's paths", async () => {
    rig = await codexRig();
    const home = path.join(rig.root, "home");
    const codexHome = path.join(home, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "fake-large"\n');
    const before = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    const opened = await rig.open();
    const launch = {
      appendSystemPrompt: [MARKERS.appendSystem],
      developerPrompt: [MARKERS.developerPrompt],
      mcpServers: [{ name: "host-tools", transport: "stdio", command: "host-tools", args: [MARKERS.synthetic] }],
    };
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), launch, context: { developer: MARKERS.contextDeveloper } });
    await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "f-1", intent: "start", content: [{ type: "text", text: "Go." }], context: { developer: MARKERS.turnDeveloper } });
    await (await rig.nextTurn()).complete();
    await opened.session.close();
    const again = await rig.open();
    await again.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd), launch });
    await again.session.close();
    // The markers did reach Codex, in frames only.
    assert.ok(sentTexts(rig).some((text) => text.includes(MARKERS.appendSystem)));
    const spawnedHome = rig.host.spawns.find((spawn) => spawn.args?.[0] === "app-server")!.environment["HOME"];
    assert.equal(spawnedHome, home, "the app-server ran with the temporary HOME");

    const files = [...walk(home), ...walk(rig.host.paths.stateDir), ...walk(rig.host.paths.cacheDir), ...walk(rig.host.paths.tmpDir)];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const marker of Object.values(MARKERS)) assert.ok(!text.includes(marker), `${file} holds ${marker}`);
    }
    assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), before);
  });
});
