// No host prompts and host-chosen names. Without launch context or
// instructions, nothing the driver sends Cursor to create or resume an agent
// or to start a run carries text the driver wrote. With them, each marker
// reaches Cursor through the channel the driver declares, the top of the
// thread's first prompt, on creation and on resume alike. Host tool servers
// reach Cursor only under the names the host returned. And the driver writes
// launch values into no Cursor config file: checked against a temporary HOME,
// once with Cursor's data directory in its default place under that HOME
// (where Cursor's SDK itself keeps the conversation's transcript and a
// descriptor per MCP server) and once with CURSOR_DATA_DIR elsewhere, which
// leaves nothing of them under HOME at all.

import "./setup-env.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { cursorCapabilities } from "../../../src/drivers/cursor/index.ts";
import type { AriEvent, Session } from "../../../src/index.ts";
import { cursorWorkspaceFolder } from "./fake-sdk.ts";
import { openCursorRig, policy } from "./rig.ts";
import type { CursorTestRig } from "./rig.ts";

const rigs: CursorTestRig[] = [];
const homes: string[] = [];
after(async () => {
  for (const rig of rigs) await rig.close();
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

function filesContaining(root: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.includes(needle) || fs.readFileSync(full, "utf8").includes(needle)) found.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found;
}

function sentTexts(rig: CursorTestRig): string[] {
  return rig.world.sends.map((send) => (typeof send.message === "string" ? send.message : send.message.text));
}

async function runTurn(rig: CursorTestRig, session: Session, events: AriEvent[], threadId: string, text: string, context?: { system?: string; developer?: string }): Promise<string> {
  const { turnId, run } = await rig.turn(session, threadId, text, context === undefined ? {} : { context });
  await run.say("Done.");
  await run.endTurn();
  run.finish();
  assert.equal((await rig.terminal(events, turnId)).status, "completed");
  return turnId;
}

test("without launch context or instructions, the driver sends Cursor no text of its own", async () => {
  const rig = await openCursorRig({ host: { mcpServerName: () => "host-tools" } });
  rigs.push(rig);
  const first = await rig.open();
  const thread = await first.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
  await runTurn(rig, first.session, first.events, thread.id, "Exactly what the host wrote.");
  await first.session.close();
  const second = await rig.open();
  await second.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd) });
  await runTurn(rig, second.session, second.events, thread.id, "A second message.");

  assert.deepEqual(sentTexts(rig), ["Exactly what the host wrote.", "A second message."]);
  for (const options of [...rig.world.creations, ...rig.world.resumes.map((resume) => resume.options ?? {})]) {
    assert.equal(options.systemPrompt, undefined, "no system prompt of the driver's own");
    assert.equal(options.agents, undefined, "no subagent prompts of the driver's own");
    assert.equal(options.mcpServers, undefined, "no MCP server the host did not give");
    assert.equal(options.name, undefined);
  }
  // Each run carries the host's own tool server, under the name the host gave, and nothing else.
  for (const send of rig.world.sends) assert.deepEqual(Object.keys(send.options?.mcpServers ?? {}), ["host-tools"]);
  assert.ok(rig.host.calls.filter((call) => call.operation === "hostTools.mcpServerFor").length >= 1);
});

test("launch prompts and instructions reach Cursor at the top of the first prompt, on creation and on resume", async () => {
  assert.deepEqual(cursorCapabilities().context.instructionChannels, ["first_user_message"]);
  const rig = await openCursorRig();
  rigs.push(rig);
  const first = await rig.open({ launch: { appendSystemPrompt: ["MARKER-APPEND-7f3a"] } });
  const thread = await first.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), context: { developer: "MARKER-DEVELOPER-55d0" } });
  const turnId = await runTurn(rig, first.session, first.events, thread.id, "Go.", { system: "MARKER-TURN-c0de" });
  await runTurn(rig, first.session, first.events, thread.id, "And again.");
  assert.deepEqual(sentTexts(rig), ["MARKER-APPEND-7f3a\n\nMARKER-DEVELOPER-55d0\n\nMARKER-TURN-c0de\n\nGo.", "And again."]);
  // The turn's user item holds the host's own words.
  const prompt = await rig.until(first.events, (event) => (event.body.type === "item.upsert" && event.turnId === turnId && event.body.item.kind === "user_message" ? event.body.item : undefined), "the prompt item");
  assert.equal(prompt.text, "Go.");
  await first.session.close();

  // A resumed thread carries its launch context exactly as creation does.
  const second = await rig.open({ launch: { developerPrompt: ["MARKER-RESUME-91aa"], mcpServers: [{ name: "launch-docs", transport: "http", url: "http://127.0.0.1:9/mcp" }] } });
  await second.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd) });
  await runTurn(rig, second.session, second.events, thread.id, "Continue.");
  assert.equal(sentTexts(rig).at(-1), "MARKER-RESUME-91aa\n\nContinue.");
  const resume = rig.world.resumes.at(-1)!;
  assert.deepEqual(Object.keys(resume.options?.mcpServers ?? {}), ["launch-docs"], "Agent.resume gets the launch MCP servers again");
});

test("host tool servers reach Cursor only under the names the host returned", async () => {
  const rig = await openCursorRig({ host: { mcpServerName: (threadId) => `host-${threadId.slice(-6)}` } });
  rigs.push(rig);
  const { session, events } = await rig.open({ launch: { mcpServers: [{ name: "launch-docs", transport: "http", url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer token" } }, { name: "local-files", transport: "stdio", command: "files-mcp", args: ["--root", rig.cwd] }] } });
  const thread = await session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
  await runTurn(rig, session, events, thread.id, "Use the tools.");
  const hostName = `host-${thread.id.slice(-6)}`;
  assert.deepEqual(rig.world.creations.at(-1)?.mcpServers, {
    "launch-docs": { type: "http", url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer token" } },
    "local-files": { type: "stdio", command: "files-mcp", args: ["--root", rig.cwd] },
  });
  assert.deepEqual(Object.keys(rig.world.sends.at(-1)?.options?.mcpServers ?? {}).sort(), ["launch-docs", "local-files", hostName].sort());
  const call = rig.host.calls.find((candidate) => candidate.operation === "hostTools.mcpServerFor");
  assert.deepEqual(call?.args, [thread.id, { transport: "http" }]);
});

/** Opens a rig with HOME at a temporary directory, runs a thread with launch markers, and returns the home and the workspace. */
async function runWithMarkers(dataDirectory: string | undefined): Promise<{ home: string; rig: CursorTestRig }> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-cursor-home-")));
  homes.push(home);
  const saved = { home: process.env["HOME"], data: process.env["CURSOR_DATA_DIR"] };
  process.env["HOME"] = home;
  if (dataDirectory === undefined) delete process.env["CURSOR_DATA_DIR"];
  else process.env["CURSOR_DATA_DIR"] = dataDirectory;
  try {
    const rig = await openCursorRig();
    rigs.push(rig);
    const { session, events } = await rig.open({
      launch: { appendSystemPrompt: ["MARKER-APPEND-3c1d"], mcpServers: [{ name: "MARKER-SERVER-launch-docs", transport: "http", url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer MARKER-TOKEN-91c2" } }] },
    });
    const thread = await session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), context: { developer: "MARKER-DEVELOPER-6e0f" } });
    await runTurn(rig, session, events, thread.id, "Go.", { system: "MARKER-TURN-2b7a" });
    return { home, rig };
  } finally {
    if (saved.home === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved.home;
    if (saved.data === undefined) delete process.env["CURSOR_DATA_DIR"];
    else process.env["CURSOR_DATA_DIR"] = saved.data;
  }
}

const MARKERS = ["MARKER-APPEND-3c1d", "MARKER-DEVELOPER-6e0f", "MARKER-TURN-2b7a", "MARKER-SERVER-launch-docs", "MARKER-TOKEN-91c2"];

test("launch values are never written to a Cursor config file under the provider's home", async () => {
  const { home, rig } = await runWithMarkers(undefined);
  const cursorHome = path.join(home, ".cursor");
  const dataDirectory = path.join(cursorHome, "projects");
  for (const marker of MARKERS) {
    const found = filesContaining(home, marker);
    // Cursor's config files (mcp.json, hooks.json, rules, sdk/auth.json, ...) and anything else under HOME: none.
    assert.deepEqual(
      found.filter((file) => !file.startsWith(`${dataDirectory}${path.sep}`)),
      [],
      `${marker} was written under the provider's home`,
    );
    assert.deepEqual(filesContaining(path.join(rig.cwd, ".cursor"), marker), [], `${marker} was written under the workspace's .cursor`);
  }
  // What the SDK itself keeps in its data directory under HOME: the transcript holds the first prompt,
  // first-message instructions included, and each inline MCP server has a descriptor by its name.
  const project = path.join(dataDirectory, cursorWorkspaceFolder(rig.cwd));
  for (const marker of ["MARKER-APPEND-3c1d", "MARKER-DEVELOPER-6e0f", "MARKER-TURN-2b7a"]) {
    assert.ok(
      filesContaining(home, marker).every((file) => file.startsWith(path.join(project, "agent-transcripts") + path.sep)),
      `${marker} is only in Cursor's transcript`,
    );
  }
  assert.ok(filesContaining(home, "MARKER-SERVER-launch-docs").every((file) => file.startsWith(path.join(project, "mcps") + path.sep)));
  assert.deepEqual(filesContaining(home, "MARKER-TOKEN-91c2"), [], "MCP headers are kept in memory only");
  // The driver's own store, which holds the conversation, is under the instance's state directory.
  assert.ok(fs.existsSync(path.join(rig.host.paths.stateDir, "cursor-agents", "agents.ndjson")));
});

test("with CURSOR_DATA_DIR outside HOME, nothing of the launch values is written under HOME at all", async () => {
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-cursor-data-")));
  homes.push(data);
  const { home } = await runWithMarkers(data);
  for (const marker of MARKERS) assert.deepEqual(filesContaining(home, marker), [], `${marker} was written under HOME`);
  assert.ok(filesContaining(data, "MARKER-APPEND-3c1d").length > 0, "Cursor's transcript went to CURSOR_DATA_DIR");
});
