// No host prompts and host-chosen names. Without launch context or
// instructions, nothing the driver sends Pi to create or resume a thread or
// to start a turn carries text the driver wrote. With them, each marker
// reaches Pi through the system channel the driver declares. Host tool
// servers reach Pi only under the names the host returned, and launch values
// are never written under the provider's own config directory: the driver's
// session files live in its state directory, and it refuses to resume a
// session file the user's own pi keeps, because Pi records launch prompts in
// the file it opens.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { piCapabilities } from "../../../src/drivers/pi/index.ts";
import { isAriError, toCallError } from "../../../src/index.ts";
import type { Session } from "../../../src/index.ts";
import { checkRunsAgainstPiTypes } from "./pi-types.ts";
import { openPiTestRig, policy } from "./rig.ts";
import type { PiTestRig } from "./rig.ts";

const rigs: PiTestRig[] = [];
const homes: string[] = [];
after(async () => {
  for (const rig of rigs) await rig.close();
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

function sentPrompts(rig: PiTestRig): string[] {
  return rig.harness.frames.filter((frame) => frame.direction === "in" && frame.record["type"] === "prompt").map((frame) => String(frame.record["message"]));
}

function filesContaining(root: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (fs.readFileSync(full, "utf8").includes(needle)) found.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found;
}

async function turn(rig: PiTestRig, session: Awaited<ReturnType<PiTestRig["open"]>>, threadId: string, text: string, context?: { system?: string; developer?: string }) {
  const started = await session.session.startTurn({ threadId, clientTurnKey: `k-${text}`, intent: "start", content: [{ type: "text", text }], ...(context === undefined ? {} : { context }) });
  assert.equal(started.status, "accepted");
  if (started.status !== "accepted") throw new Error("not accepted");
  const native = await rig.nextTurn();
  await native.complete();
  await rig.terminal(session.events, started.turnId);
}

test("without launch context or instructions, the driver sends Pi no text of its own", async () => {
  const rig = await openPiTestRig({ host: { mcpServerName: () => "host-tools" } });
  rigs.push(rig);
  const session = await rig.open();
  const thread = await session.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
  await turn(rig, session, thread.id, "Exactly what the host wrote.");
  await session.session.close();
  const resumed = await rig.open();
  await resumed.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd) });
  await turn(rig, resumed, thread.id, "A second message.");

  for (const spawn of rig.host.spawns) {
    assert.ok(!(spawn.args ?? []).includes("--append-system-prompt"), `pi was started with ${JSON.stringify(spawn.args)}`);
    assert.ok(!(spawn.args ?? []).includes("--system-prompt"));
  }
  // Each prompt is the host's own text, the bridge's MCP registration, which holds only the host's server,
  // or the bridge's /ari-persist, which carries no text and writes only Pi's own session header.
  for (const prompt of sentPrompts(rig)) {
    if (prompt === "/ari-persist") continue;
    if (prompt.startsWith("/ari-mcp ")) {
      const servers = (JSON.parse(prompt.slice("/ari-mcp ".length)) as { servers: Array<{ name: string }> }).servers;
      assert.deepEqual(
        servers.map((server) => server.name),
        ["host-tools"],
      );
      continue;
    }
    assert.ok(["Exactly what the host wrote.", "A second message."].includes(prompt), `the driver sent Pi the prompt ${JSON.stringify(prompt)}`);
  }
  for (const frame of rig.harness.frames.filter((candidate) => candidate.direction === "in")) {
    const type = String(frame.record["type"]);
    assert.ok(["prompt", "get_state", "get_entries", "get_available_models", "extension_ui_response"].includes(type), `the driver sent ${type}`);
  }
});

test("launch prompts and instructions reach Pi through the declared system channel, and never a file under the provider's home", async () => {
  assert.ok(piCapabilities().context.instructionChannels.includes("system"));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-pi-home-")));
  homes.push(home);
  const homeEnvironment = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") };
  const rig = await openPiTestRig({ host: { ambientEnvironment: homeEnvironment, mcpServerName: (threadId) => `host-${threadId.slice(-6)}` } });
  rigs.push(rig);
  const session = await rig.open({ launch: { appendSystemPrompt: ["MARKER-APPEND-7f3a"], mcpServers: [{ name: "launch-docs", transport: "http", url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer MARKER-TOKEN-91c2" } }] } });
  const thread = await session.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), context: { developer: "MARKER-DEVELOPER-55d0" } });
  await turn(rig, session, thread.id, "Go.", { system: "MARKER-TURN-c0de" });

  const launchArgs = rig.host.spawns.find((spawn) => spawn.args?.includes("--extension"))?.args ?? [];
  const appended = launchArgs.flatMap((argument, index) => (launchArgs[index - 1] === "--append-system-prompt" ? [argument] : []));
  assert.deepEqual(appended, ["MARKER-APPEND-7f3a", "MARKER-DEVELOPER-55d0"]);
  const contextFrames = sentPrompts(rig).filter((prompt) => prompt.startsWith("/ari-context "));
  assert.deepEqual(contextFrames, [`/ari-context ${JSON.stringify({ text: "MARKER-TURN-c0de" })}`]);

  // A parked thread starts again with the same launch prompts.
  await session.session.release();
  await turn(rig, session, thread.id, "Again.");
  const restart = rig.host.spawns.filter((spawn) => spawn.args?.includes("--session")).at(-1)?.args ?? [];
  assert.ok(restart.includes("MARKER-APPEND-7f3a") && restart.includes("MARKER-DEVELOPER-55d0"));

  // Pi keeps its prompt in the session file, which lives in the instance's state directory, so the scan can find markers.
  assert.ok(filesContaining(path.dirname(path.dirname(thread.handle!)), "MARKER-APPEND-7f3a").length > 0);
  for (const marker of ["MARKER-APPEND-7f3a", "MARKER-DEVELOPER-55d0", "MARKER-TURN-c0de", "MARKER-TOKEN-91c2", "launch-docs"]) {
    assert.deepEqual(filesContaining(home, marker), [], `${marker} was written under the provider's home`);
  }
  for (const spawn of rig.host.spawns) assert.equal(spawn.environment["HOME"], home, "pi ran with the temporary home");
});

test("a session file the user's own pi keeps is never resumed, so launch prompts cannot be written into it", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-pi-home-")));
  homes.push(home);
  const rig = await openPiTestRig({ host: { ambientEnvironment: { HOME: home } } });
  rigs.push(rig);
  // A session standalone pi wrote under ~/.pi/agent/sessions, in Pi's own format.
  const nativeId = "11111111-2222-4333-8444-555555555555";
  const userSessions = path.join(home, ".pi", "agent", "sessions", "--work--");
  fs.mkdirSync(userSessions, { recursive: true });
  const userFile = path.join(userSessions, `2026-11-20T10-00-00-000Z_${nativeId}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: nativeId, timestamp: "2026-11-20T10:00:00.000Z", cwd: rig.cwd },
    { type: "message", id: "00000001", parentId: null, timestamp: "2026-11-20T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "My own question." }], timestamp: 1 } },
    { type: "message", id: "00000002", parentId: "00000001", timestamp: "2026-11-20T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "My own answer." }], api: "fake-messages", provider: "fake", model: "fake-small", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } },
  ];
  fs.writeFileSync(userFile, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  const before = fs.readFileSync(userFile, "utf8");

  const session = await rig.open({ launch: { appendSystemPrompt: ["MARKER-RESUME-4b1e"] } });
  const spawnsBefore = rig.host.spawns.length;
  const sessionsDirectory = path.join(rig.host.paths.stateDir, "sessions");
  const outside: Array<Parameters<Session["resumeThread"]>[0]["native"]> = [
    { handle: userFile },
    // A path that only looks as if it were inside the state directory.
    { handle: path.join(sessionsDirectory, "..", "..", path.relative(path.dirname(path.dirname(sessionsDirectory)), userFile)) },
    // Pi reads a relative path against its own directory.
    { handle: path.relative(rig.cwd, userFile) },
    // Pi reads an "id" with a slash as a path too.
    { id: userFile, strength: "strong" },
  ];
  for (const native of outside) {
    await assert.rejects(session.session.resumeThread({ native, policy: policy(rig.cwd) }), (error: unknown) => {
      assert.ok(isAriError(error, "validation"), `${JSON.stringify(native)} rejected with ${String(error)}`);
      assert.match(JSON.stringify((toCallError(error) as { issues?: unknown }).issues), /resumes only session files under/);
      return true;
    });
  }
  assert.equal(rig.host.spawns.length, spawnsBefore, "pi was never started on the user's file");
  assert.equal(fs.readFileSync(userFile, "utf8"), before, "the user's session file is unchanged");
  assert.deepEqual(filesContaining(home, "MARKER-RESUME-4b1e"), []);
});

test("every frame and session file line of these tests matches Pi's published types", () => {
  const checked = checkRunsAgainstPiTypes(rigs.map((rig) => rig.harness));
  assert.ok(checked.frames > 0);
  assert.deepEqual(checked.diagnostics, []);
});
