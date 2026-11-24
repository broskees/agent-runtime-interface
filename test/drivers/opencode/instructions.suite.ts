// No host prompts and host-chosen names. Without a LaunchContext and without
// context, the frames that create or resume a session and start a turn carry
// no instruction text the driver wrote. With markers in
// `launch.appendSystemPrompt` and `context.developer`, each marker reaches
// OpenCode through the system channel (`context.instructionChannels`): 1.x
// `session.prompt_async` `system`, 2.x the session's instruction entry. Host
// MCP servers appear only under the names `hostTools.mcpServerFor` returned.
// Resume carries the LaunchContext as creation does. Nothing is written under
// the provider's config directories, checked against a temp HOME.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import type { Frame, Generation } from "./fake-opencode.ts";
import { openOpencodeTestRig, policy } from "./rig.ts";
import type { OpencodeTestRig } from "./rig.ts";

const rigs: OpencodeTestRig[] = [];
after(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});

const LAUNCH_MARKER = "LAUNCH-MARKER-7f3a";
const DEVELOPER_MARKER = "DEVELOPER-MARKER-91bc";
const TURN_MARKER = "TURN-MARKER-55de";
const RESUME_MARKER = "RESUME-MARKER-c2a1";

function requests(frames: readonly Frame[], operations: readonly string[]): Frame[] {
  return frames.filter((frame) => frame.direction === "request" && operations.includes(frame.operation));
}

/** The text a request carried: its query and body as JSON. */
function carried(frame: Frame): string {
  return JSON.stringify(frame.body);
}

function tempHome(): { env: { [name: string]: string }; root: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-opencode-home-")));
  const env = { HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache") };
  for (const directory of Object.values(env)) fs.mkdirSync(directory, { recursive: true });
  return { env, root };
}

function filesContaining(root: string, needles: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (needles.some((needle) => fs.readFileSync(full, "utf8").includes(needle))) found.push(full);
    }
  };
  walk(root);
  return found;
}

for (const generation of [1, 2] as Generation[]) {
  describe(`OpenCode ${generation}.x`, () => {
    const promptOperation = generation === 1 ? "session.prompt_async" : "session.prompt";
    const threadOperations = ["session.create", "session.get", "session.fork", "session.update"];
    const instructionOperations = generation === 1 ? [promptOperation] : ["experimental.session.instructions.entry.put"];

    test("without a LaunchContext or context, no frame carries instruction text the driver wrote", async () => {
      const rig = await openOpencodeTestRig({ generation });
      rigs.push(rig);
      const opened = await rig.open();
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "plain", intent: "start", content: [{ type: "text", text: "Just this." }] });
      assert.equal(started.status, "accepted");
      const native = await rig.nextTurn();
      await native.complete();
      await opened.session.close();
      const resumed = await rig.open();
      await resumed.session.resumeThread({ native: { id: thread.native.id!, strength: "strong" }, policy: policy(rig.cwd) });
      const prompts = requests(rig.world.frames, [promptOperation]);
      assert.equal(prompts.length, 1);
      const body = (prompts[0]!.body as { body: { [key: string]: unknown } }).body;
      assert.equal(body["system"], undefined, "the prompt carries no system text");
      if (generation === 1) assert.deepEqual(body["parts"], [{ type: "text", text: "Just this." }]);
      else assert.equal(body["text"], "Just this.");
      assert.equal(requests(rig.world.frames, ["experimental.session.instructions.entry.put"]).length, 0, "no instruction entry was written");
      for (const frame of requests(rig.world.frames, threadOperations)) {
        const body = (frame.body as { body?: { [key: string]: unknown } }).body ?? {};
        assert.equal(body["system"], undefined);
        assert.equal(body["instructions"], undefined);
      }
      assert.equal(rig.world.sessions.get(thread.native.id!)!.instructions.size, 0);
    });

    test("launch and context markers reach OpenCode's system channel, on create and on resume; MCP names are the host's; nothing lands under HOME", async () => {
      const home = tempHome();
      const rig = await openOpencodeTestRig({ generation, host: { ambientEnvironment: home.env, mcpServerName: (threadId) => `host-chosen-${threadId.slice(-6)}` } });
      rigs.push(rig);
      const opened = await rig.open({ launch: { appendSystemPrompt: [LAUNCH_MARKER], mcpServers: [{ name: "launch-tools", transport: "http", url: "http://127.0.0.1:1/mcp" }] } });
      assert.deepEqual(opened.session.capabilities().context.instructionChannels, ["system"]);
      const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), context: { developer: DEVELOPER_MARKER } });
      const started = await opened.session.startTurn({ threadId: thread.id, clientTurnKey: "marked", intent: "start", content: [{ type: "text", text: "Hello." }], context: { system: TURN_MARKER } });
      assert.equal(started.status, "accepted");
      const native = await rig.nextTurn();
      await native.complete();
      const instructionText = requests(rig.world.frames, instructionOperations).map(carried).join("\n");
      for (const marker of [LAUNCH_MARKER, DEVELOPER_MARKER, TURN_MARKER]) assert.ok(instructionText.includes(marker), `${marker} did not reach the system channel`);
      // OpenCode holds them where the model reads them: 1.x on the user message, 2.x in the session's instruction entries.
      const stored = rig.world.sessions.get(thread.native.id!)!;
      const held = generation === 1 ? (stored.messages.find((message) => message.role === "user")?.system ?? "") : [...stored.instructions.values()].join("\n");
      for (const marker of [LAUNCH_MARKER, DEVELOPER_MARKER, TURN_MARKER]) assert.ok(held.includes(marker), `OpenCode does not hold ${marker}`);

      // MCP servers reach OpenCode only under the names the host chose.
      const hostNames = rig.host.calls.filter((call) => call.operation === "hostTools.mcpServerFor").map((call) => `host-chosen-${(call.args as [string])[0].slice(-6)}`);
      const added = requests(rig.world.frames, generation === 1 ? ["mcp.add"] : ["experimental.mcp.add"]).map((frame) => {
        const sent = frame.body as { path: string; body: { name?: string } };
        return generation === 1 ? String(sent.body.name) : decodeURIComponent(sent.path.split("/").at(-1) ?? "");
      });
      assert.deepEqual(new Set(added), new Set([...hostNames, "launch-tools"]), "every MCP entry the driver added has a name the host chose");
      const entryNames = [...[...rig.world.servers].flatMap((server) => [...server.mcp.values()].flatMap((entries) => [...entries.keys()]))];
      assert.deepEqual(new Set(entryNames), new Set([...hostNames, "launch-tools"]));

      // A resume in a fresh session carries its own LaunchContext exactly as creation does.
      await opened.session.close();
      const resumed = await rig.open();
      const thread2 = await resumed.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd), launch: { appendSystemPrompt: [RESUME_MARKER] } });
      const again = await resumed.session.startTurn({ threadId: thread2.id, clientTurnKey: "again", intent: "start", content: [{ type: "text", text: "Again." }] });
      assert.equal(again.status, "accepted");
      const native2 = await rig.nextTurn();
      await native2.complete();
      const latest = requests(rig.world.frames, instructionOperations).at(-1)!;
      assert.ok(carried(latest).includes(RESUME_MARKER), "the resumed thread's launch prompt reached OpenCode");
      assert.ok(!carried(latest).includes(DEVELOPER_MARKER), "the old thread context did not come back with the resume");
      const resumedEntries = [...rig.world.servers].filter((server) => server.alive).flatMap((server) => [...(server.mcp.get(rig.cwd)?.keys() ?? [])]);
      assert.ok(resumedEntries.some((name) => name.startsWith("host-chosen-")), "the resumed thread got the host's tool server again");

      // Nothing the host launched with was written under the temp HOME's config, data or state directories, and the server's environment carries no LaunchContext.
      assert.deepEqual(filesContaining(home.root, [LAUNCH_MARKER, DEVELOPER_MARKER, TURN_MARKER, RESUME_MARKER, "launch-tools", "host-chosen-"]), []);
      for (const spawn of rig.world.spawns) {
        const environment = JSON.stringify(spawn.env);
        for (const marker of [LAUNCH_MARKER, DEVELOPER_MARKER, TURN_MARKER, RESUME_MARKER, "launch-tools"]) assert.ok(!environment.includes(marker), `the opencode environment carries ${marker}`);
        assert.equal(spawn.env["OPENCODE_CONFIG_CONTENT"], undefined);
        assert.equal(spawn.env["HOME"], home.env["HOME"], "the server runs with the temp HOME");
      }
      fs.rmSync(home.root, { recursive: true, force: true });
    });
  });
}
