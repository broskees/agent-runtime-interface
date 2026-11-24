// No host prompts and host-chosen names. With no LaunchContext and no
// context, the frames that create a thread (`session/start`), resume it
// (`session/resume`) and start a turn (`turn/start`) carry no instruction text
// the driver wrote. With `launch.appendSystemPrompt`, `launch.developerPrompt`
// and `context` set to marker strings, each marker reaches Muse through the
// one channel the driver lists, `first_user_message`: a text part before the
// host's own text in the next turn, with the host's text as `displayText`.
// Host tool MCP servers reach `session/start` and `session/resume` only under
// the names the host chose. Nothing is written under the temporary HOME or the
// instance's directories.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { MUSE_CAPABILITIES } from "../../../src/drivers/muse/index.ts";
import type { LaunchContext } from "../../../src/index.ts";
import { museRig, policy, until } from "./rig.ts";

const SESSION_START_KEYS = ["approvalMode", "commandId", "config", "modelId", "permissionProfile", "providerId", "sessionId", "workspaceRoot"];
const SESSION_RESUME_KEYS = ["commandId", "config", "excludeItems", "modelId", "permissionProfile", "sessionId"];

/** Every file under `root`, with its text. */
function filesUnder(root: string): Array<{ file: string; text: string }> {
  if (!fs.existsSync(root)) return [];
  const found: Array<{ file: string; text: string }> = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push({ file: full, text: fs.readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return found;
}

describe("muse driver: host instructions and host-chosen names", () => {
  test("the driver lists the first_user_message channel and no other", () => {
    assert.deepEqual(MUSE_CAPABILITIES.context.instructionChannels, ["first_user_message"]);
  });

  test("with no launch context and no context, session/start, session/resume and turn/start carry no instruction text the driver wrote", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const turn = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "turn-1", intent: "start", content: [{ type: "text", text: "Hello." }] });
      const native = await rig.nextTurn();
      assert.equal(native.prompt, "Hello.");
      await native.complete();
      await until(() => opened.bodies("turn.terminal").find((body) => body.turnId === (turn as { turnId: string }).turnId), "the turn to end");
      await opened.session.unloadThread!(thread.id);
      await opened.session.resumeThread({ native: thread.native, policy: policy(rig.cwd), quiet: true });
      const second = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "turn-2", intent: "start", content: [{ type: "text", text: "Again." }] });
      const again = await rig.nextTurn();
      assert.equal(again.prompt, "Again.");
      await again.complete();
      await until(() => opened.bodies("turn.terminal").find((body) => body.turnId === (second as { turnId: string }).turnId), "the second turn to end");

      for (const start of rig.requests("session/start")) {
        for (const key of Object.keys(start)) assert.ok(SESSION_START_KEYS.includes(key), `session/start carries ${key}`);
        assert.deepEqual(Object.keys(start["config"] as object), ["mcpServers"]);
      }
      const resumes = rig.requests("session/resume");
      assert.equal(resumes.length, 1);
      for (const resume of resumes) {
        for (const key of Object.keys(resume)) assert.ok(SESSION_RESUME_KEYS.includes(key), `session/resume carries ${key}`);
        assert.deepEqual(Object.keys(resume["config"] as object), ["mcpServers"]);
      }
      const starts = rig.requests("turn/start");
      assert.deepEqual(starts.map((start) => start["input"]), [[{ type: "text", text: "Hello." }], [{ type: "text", text: "Again." }]]);
      for (const start of starts) assert.equal(start["displayText"], undefined);
    } finally {
      await rig.cleanup();
    }
  });

  test("launch prompts and context reach the next turn's first text part; the host's own text is the displayText and the user message", async () => {
    const rig = await museRig();
    try {
      const opened = await rig.open();
      const launch: LaunchContext = { appendSystemPrompt: ["MARKER-APPEND-SYSTEM"], developerPrompt: ["MARKER-LAUNCH-DEVELOPER"] };
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), launch, context: { system: "MARKER-CONTEXT-SYSTEM", developer: "MARKER-CONTEXT-DEVELOPER" } });
      // Nothing of the host's instructions goes into session/start: Muse's developerPrompt would replace its own developer instructions.
      assert.doesNotMatch(JSON.stringify(rig.requests("session/start")), /MARKER/);
      const first = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "turn-1", intent: "start", content: [{ type: "text", text: "Build it." }] });
      const native = await rig.nextTurn();
      const [sent] = rig.requests("turn/start");
      const input = sent!["input"] as Array<{ type: string; text: string }>;
      assert.equal(input.length, 2);
      for (const marker of ["MARKER-APPEND-SYSTEM", "MARKER-LAUNCH-DEVELOPER", "MARKER-CONTEXT-SYSTEM", "MARKER-CONTEXT-DEVELOPER"]) assert.match(input[0]!.text, new RegExp(marker));
      assert.deepEqual(input[1], { type: "text", text: "Build it." });
      assert.equal(sent!["displayText"], "Build it.");
      assert.match(native.prompt, /MARKER-APPEND-SYSTEM[\s\S]*Build it\./);
      const userItem = await until(() => opened.bodies("item.upsert").find((body) => body.item.kind === "user_message")?.item, "the user message");
      assert.equal(userItem.text, "Build it.");
      await native.complete();
      await until(() => opened.bodies("turn.terminal").find((body) => body.turnId === (first as { turnId: string }).turnId), "the turn to end");

      // A turn's own context goes into that turn; the launch instructions were sent once.
      const second = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "turn-2", intent: "start", content: [{ type: "text", text: "Next." }], context: { developer: "MARKER-TURN-DEVELOPER" } });
      const next = await rig.nextTurn();
      const secondInput = rig.requests("turn/start").at(-1)!["input"] as Array<{ type: string; text: string }>;
      assert.deepEqual(secondInput, [{ type: "text", text: "MARKER-TURN-DEVELOPER" }, { type: "text", text: "Next." }]);
      await next.complete();
      await until(() => opened.bodies("turn.terminal").find((body) => body.turnId === (second as { turnId: string }).turnId), "the second turn to end");

      // A resume with a launch context: its instructions go into the first turn after the resume.
      await opened.session.unloadThread!(thread.id);
      await opened.session.resumeThread({ native: thread.native, policy: policy(rig.cwd), launch: { appendSystemPrompt: ["MARKER-RESUME-SYSTEM"] }, quiet: true });
      assert.doesNotMatch(JSON.stringify(rig.requests("session/resume")), /MARKER/);
      const third = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "turn-3", intent: "start", content: [{ type: "text", text: "Resumed." }] });
      const resumed = await rig.nextTurn();
      assert.deepEqual(rig.requests("turn/start").at(-1)!["input"], [{ type: "text", text: "MARKER-RESUME-SYSTEM" }, { type: "text", text: "Resumed." }]);
      await resumed.complete();
      await until(() => opened.bodies("turn.terminal").find((body) => body.turnId === (third as { turnId: string }).turnId), "the third turn to end");

      // Nothing the host passed was written under the temporary HOME, its XDG directories or the instance's directories.
      for (const root of [rig.home, path.join(rig.root, "state"), path.join(rig.root, "cache"), path.join(rig.root, "tmp")]) {
        for (const { file, text } of filesUnder(root)) assert.doesNotMatch(text, /MARKER/, `${file} holds a host instruction`);
        assert.deepEqual(filesUnder(root).map((entry) => entry.file), [], `the driver wrote under ${root}`);
      }
    } finally {
      await rig.cleanup();
    }
  });

  test("host tool MCP servers reach session/start and session/resume only under the names the host chose", async () => {
    const rig = await museRig({ host: { mcpServerName: (threadId) => `acme-tools-${threadId.slice(-6)}` } });
    try {
      const opened = await rig.open({
        launch: {
          mcpServers: [
            { name: "acme-search", transport: "stdio", command: "acme-search", args: ["--stdio"], env: { ACME: "1" } },
            { name: "acme-docs", transport: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer x" } },
          ],
        },
      });
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const hostName = `acme-tools-${thread.id.slice(-6)}`;
      const [start] = rig.requests("session/start");
      const servers = (start!["config"] as { mcpServers: { [name: string]: unknown } }).mcpServers;
      assert.deepEqual(Object.keys(servers).sort(), ["acme-docs", "acme-search", hostName].sort());
      assert.deepEqual(servers["acme-search"], { transport: "stdio", command: "acme-search", args: ["--stdio"], env: { ACME: "1" } });
      assert.deepEqual(servers["acme-docs"], { transport: "streamableHttp", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer x" } });
      assert.deepEqual(servers[hostName], { transport: "streamableHttp", url: `http://127.0.0.1/ari-conformance/mcp/${encodeURIComponent(thread.id)}` });
      assert.deepEqual(rig.world.sessions.get(thread.native.id!)?.mcpServers, servers);
      await opened.session.unloadThread!(thread.id);
      await opened.session.resumeThread({ native: thread.native, policy: policy(rig.cwd), quiet: true });
      const [resume] = rig.requests("session/resume");
      assert.deepEqual(Object.keys((resume!["config"] as { mcpServers: object }).mcpServers).sort(), ["acme-docs", "acme-search", hostName].sort());
      // No other server name appears in any frame the driver sent.
      for (const request of rig.world.requests) {
        const config = (request.params as { config?: { mcpServers?: object } } | undefined)?.config;
        if (config?.mcpServers !== undefined) for (const name of Object.keys(config.mcpServers)) assert.ok(["acme-docs", "acme-search", hostName].includes(name), `${request.method} names MCP server ${name}`);
      }
      // A server Muse cannot take is refused before anything is sent.
      const before = rig.requests("session/start").length;
      await assert.rejects(opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), launch: { mcpServers: [{ name: "old", transport: "sse", url: "http://127.0.0.1:9/sse" }] } }));
      assert.equal(rig.requests("session/start").length, before);
    } finally {
      await rig.cleanup();
    }
  });
});
