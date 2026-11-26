// The ari.goal extension holds only what Claude Code confirms, read from the
// transcript and marked derived. Claude Code 2.1.330 sets a goal two ways:
// its /goal command, which records the command and its output
// ("Goal set: <condition>", "Goal cleared: <condition>", or a refusal) as
// tagged transcript rows, and its SetGoal tool, whose result says whether the
// goal is set or only proposed to the user. A prompt or a tool call alone
// sets nothing. The second test reads a transcript in the form Claude Code
// writes it with the pinned SDK's own getSessionMessages.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import type { ClaudeSdk } from "../../../src/drivers/claude/index.ts";
import { openClaudeRig, until } from "./rig.ts";
import type { ClaudeRig } from "./rig.ts";

/** The data of every x:ari.goal.updated event, in order. */
function goalUpdates(rig: ClaudeRig): unknown[] {
  return rig.log.events.flatMap((event) => (event.body.type === "x:ari.goal.updated" ? [(event.body as { data: unknown }).data] : []));
}

let keys = 0;

/** Sends a prompt Claude Code answers without a model turn (a refused or clearing /goal) and waits for its turn to end. */
async function commandTurn(rig: ClaudeRig, threadId: string, text: string): Promise<string> {
  keys += 1;
  const started = await rig.session.startTurn({ threadId, clientTurnKey: `goal-command-${keys}`, intent: "start", content: [{ type: "text", text }] });
  assert.equal(started.status, "accepted");
  if (started.status !== "accepted") throw new Error("unreachable");
  assert.equal((await rig.terminal(started.turnId)).status, "completed");
  return started.turnId;
}

describe("claude driver: ari.goal from what Claude Code confirms", () => {
  test("a /goal prompt sets the goal only once Claude Code's command output says so; a refused condition and a SetGoal proposal set nothing", async () => {
    const rig = await openClaudeRig();
    try {
      const thread = await rig.thread();
      const get = () => rig.session.ext!("ari.goal", "get", { threadId: thread.id });
      // Claude Code refuses a condition over 4000 characters with its own output and runs no model turn.
      const tooLong = `/goal ${"x".repeat(4001)}`;
      const refused = await commandTurn(rig, thread.id, tooLong);
      assert.deepEqual(goalUpdates(rig), [], "the driver announced a goal Claude Code refused");
      assert.equal(await get(), null);

      // An accepted condition: Claude Code records "Goal set: …" and works on it.
      const { turnId, native } = await rig.turn(thread.id, "/goal the build is green");
      await native.say("Working on it.");
      await native.complete();
      await rig.terminal(turnId);
      const set = (await until(() => goalUpdates(rig)[0], "the goal update")) as { updatedAt: string };
      assert.deepEqual(set, { threadId: thread.id, objective: "the build is green", status: "active", derived: true, turnIds: [turnId], updatedAt: set.updatedAt });
      // Later turns join the goal, and each command shows as the text the host sent.
      const second = await rig.simpleTurn(thread.id, "Keep going.");
      assert.deepEqual(await get(), { threadId: thread.id, objective: "the build is green", status: "active", derived: true, turnIds: [turnId, second] });
      const snapshot = await rig.session.readSnapshot!(thread.id);
      assert.deepEqual(snapshot.turns.map((turn) => turn.id), [refused, turnId, second]);
      assert.deepEqual(snapshot.items.filter((item) => item.kind === "user_message").map((item) => item.text), [tooLong, "/goal the build is green", "Keep going."]);
      assert.equal(goalUpdates(rig).length, 1);

      // /goal clear: Claude Code answers "Goal cleared: …" without a model turn.
      await commandTurn(rig, thread.id, "/goal clear");
      await until(() => goalUpdates(rig).length === 2, "the goal to clear");
      assert.equal(goalUpdates(rig)[1], null);
      assert.equal(await get(), null);

      // SetGoal with ask_user (its default) only proposes the goal to the user: the tool result says so, and nothing is set.
      const proposal = await rig.turn(thread.id, "Make the tests pass.");
      await proposal.native.proposeGoal("all tests pass", { askUser: true });
      await proposal.native.complete();
      await rig.terminal(proposal.turnId);
      assert.equal(await get(), null);
      assert.equal(goalUpdates(rig).length, 2);
      // Without ask_user Claude Code sets it and says so in the result.
      const direct = await rig.turn(thread.id, "Set the goal yourself.");
      await direct.native.proposeGoal("all tests in test/auth pass", { askUser: false });
      await direct.native.complete();
      await rig.terminal(direct.turnId);
      const proposed = (await until(() => goalUpdates(rig)[2], "the SetGoal update")) as { objective: string; turnIds: string[] };
      assert.deepEqual([proposed.objective, proposed.turnIds], ["all tests in test/auth pass", [direct.turnId]]);
      await assert.rejects(rig.session.ext!("ari.goal", "set", { threadId: thread.id, objective: "x" }), (error: { callError?: { capability?: string } }) => error.callError?.capability === "extensions.ari.goal.set");

      // A fresh session reads the same goal back from the transcript alone.
      const { session } = await rig.openAnother();
      const resumed = await session.resumeThread({ native: { handle: thread.handle! }, purpose: "history", policy: rig.policy() });
      assert.deepEqual(await session.ext!("ari.goal", "get", { threadId: resumed.id }), { threadId: thread.id, objective: "all tests in test/auth pass", status: "active", derived: true, turnIds: [direct.turnId] });
    } finally {
      await rig.cleanup();
    }
  });

  test("a thread read for history recovers the goal from the rows Claude Code writes, as the pinned SDK's getSessionMessages returns them", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ari-claude-goal-"));
    const previousConfigDir = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = path.join(home, ".claude");
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(home, "project-")));
    const projectDir = path.join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(projectDir, { recursive: true });
    let ids = 0;
    /** Writes a transcript as Claude Code 2.1.330 does for a local command: a caveat, the tagged command, its tagged output, then the conversation. */
    const seed = (sessionId: string, rows: ReadonlyArray<{ type: "user" | "assistant"; content: unknown; isMeta?: boolean }>): string[] => {
      let parentUuid: string | null = null;
      const uuids: string[] = [];
      const lines = rows.map((row) => {
        ids += 1;
        const uuid = `2b2b2b2b-0000-4000-8000-${String(ids).padStart(12, "0")}`;
        const message = row.type === "user" ? { role: "user", content: row.content } : { id: `msg_${ids}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: row.content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        const line = { parentUuid, isSidechain: false, userType: "external", cwd, sessionId, version: "2.1.330", type: row.type, message, uuid, timestamp: new Date(Date.UTC(2026, 10, 23, 12, 0, ids)).toISOString(), ...(row.isMeta === true ? { isMeta: true } : {}) };
        parentUuid = uuid;
        uuids.push(uuid);
        return JSON.stringify(line);
      });
      fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
      return uuids;
    };
    const caveat = { type: "user", isMeta: true, content: "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>" } as const;
    const command = (args: string) => ({ type: "user", content: `<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>${args}</command-args>` }) as const;
    const output = (text: string) => ({ type: "user", content: `<local-command-stdout>${text}</local-command-stdout>` }) as const;
    const reply = (text: string) => ({ type: "assistant", content: [{ type: "text", text }] }) as const;
    const prompt = (text: string) => ({ type: "user", content: text }) as const;

    const setId = "3c3c3c3c-0000-4000-8000-000000000001";
    const setRows = seed(setId, [caveat, command("the build is green"), output("Goal set: the build is green"), { type: "user", isMeta: true, content: "Work toward the goal: the build is green" }, reply("Working on it."), prompt("Keep going."), reply("Still on it.")]);
    const refusedId = "3c3c3c3c-0000-4000-8000-000000000002";
    seed(refusedId, [caveat, command("x".repeat(4001)), output("Goal condition is limited to 4000 characters (got 4001)"), prompt("Then just build it."), reply("Built.")]);
    const clearedId = "3c3c3c3c-0000-4000-8000-000000000003";
    seed(clearedId, [caveat, command("ship it"), output("Goal set: ship it"), reply("Shipping."), caveat, command("clear"), output("Goal cleared: ship it")]);

    const real = await import("@anthropic-ai/claude-agent-sdk");
    // The pinned SDK's own reader returns the tagged rows (the caveat is meta and left out); the driver must read the goal from these.
    const returned = await real.getSessionMessages(setId, { dir: cwd });
    assert.deepEqual(returned.map((row) => row.uuid), [setRows[1], setRows[2], setRows[4], setRows[5], setRows[6]]);
    const sdk: ClaudeSdk = {
      query: () => {
        throw new Error("a history read started Claude Code");
      },
      getSessionInfo: real.getSessionInfo,
      getSessionMessages: real.getSessionMessages,
      listSessions: real.listSessions,
      deleteSession: real.deleteSession,
      archiveSession: real.archiveSession,
    };
    const rig = await openClaudeRig({ loadSdk: async () => ({ sdk, version: "0.3.330", claudeCodeVersion: "2.1.330" }) });
    try {
      const policy = { mode: "approval_required", interaction: "default", cwd } as const;
      const resumed = await rig.session.resumeThread({ native: { handle: setId }, purpose: "history", policy });
      const snapshot = await rig.session.readSnapshot!(resumed.id);
      assert.deepEqual(snapshot.items.filter((item) => item.kind === "user_message").map((item) => item.text), ["/goal the build is green", "Keep going."]);
      assert.deepEqual(await rig.session.ext!("ari.goal", "get", { threadId: resumed.id }), {
        threadId: resumed.id,
        objective: "the build is green",
        status: "active",
        derived: true,
        turnIds: snapshot.turns.map((turn) => turn.id),
      });
      for (const nativeId of [refusedId, clearedId]) {
        const other = await rig.session.resumeThread({ native: { handle: nativeId }, purpose: "history", policy });
        assert.equal(await rig.session.ext!("ari.goal", "get", { threadId: other.id }), null, `the goal of ${nativeId}`);
      }
    } finally {
      await rig.cleanup();
      if (previousConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previousConfigDir;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
