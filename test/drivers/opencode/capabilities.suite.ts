// Honest capabilities. docs/drivers/opencode.md lists every declared
// capability for OpenCode 1.x and 2.x next to the proposal's §1.2 columns,
// with a source for each difference. The 44 optional members of inventories D
// and E each have an outcome per generation here: left out, rejected with
// `unsupported{capability}`, or supported and exercised below (the conformance
// runs exercise the session members again in scenario 14).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PERMISSION_RULES_EXTENSION, opencodeCapabilities } from "../../../src/drivers/opencode/index.ts";
import { isAriError, toCallError } from "../../../src/index.ts";
import type { Generation } from "./fake-opencode.ts";
import { openOpencodeTestRig, policy } from "./rig.ts";
import type { OpencodeTestRig } from "./rig.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Outcome = { readonly outcome: "absent" } | { readonly outcome: "unsupported"; readonly capability: string } | { readonly outcome: "supported" };

const absent: Outcome = { outcome: "absent" };
const supported: Outcome = { outcome: "supported" };

/** The driver's outcome for each optional member of `Session` (inventory D) and `Instance` (inventory E), by generation. */
function outcomes(generation: Generation): { readonly [member: string]: Outcome } {
  return {
    "Session.readSnapshot": supported,
    "Session.forkThread": supported,
    "Session.rollbackThread": supported,
    "Session.compactThread": supported,
    "Session.injectHistory": absent,
    // A thread parks by stopping its own 1.x server; a 2.x server serves every session of the instance.
    "Session.unloadThread": generation === 1 ? supported : { outcome: "unsupported", capability: "threads.unload" },
    "Session.backgroundTasks.list": absent,
    "Session.backgroundTasks.stop": absent,
    "Session.backgroundTasks.await": absent,
    "Session.stopSubagent": absent,
    "Session.mcpApps.listTools": absent,
    "Session.mcpApps.callTool": absent,
    "Session.mcpApps.readResource": absent,
    "Session.contextWindow": supported,
    "Session.canReuseContextUsage": absent,
    "Session.uploadFeedback": absent,
    "Session.ext": supported,
    "Instance.invalidateCaches": absent,
    "Instance.maintenance.advisory": absent,
    "Instance.maintenance.install": absent,
    "Instance.maintenance.update": absent,
    "Instance.auth.methods": absent,
    "Instance.auth.state": absent,
    "Instance.auth.reportRuntimeFailure": absent,
    "Instance.auth.start": absent,
    "Instance.auth.complete": absent,
    "Instance.auth.respond": absent,
    "Instance.auth.cancel": absent,
    "Instance.auth.logout": absent,
    "Instance.auth.transferProfile": absent,
    "Instance.auth.transferSession": absent,
    "Instance.catalog.refresh": absent,
    "Instance.workspace.snapshot": absent,
    "Instance.limits.current": absent,
    "Instance.limits.accountKey": absent,
    "Instance.limits.consumeResetCredit": absent,
    "Instance.usageHistory.scan": absent,
    "Instance.textGeneration.generate": absent,
    "Instance.nativeSessions.list": absent,
    "Instance.nativeSessions.delete": absent,
    "Instance.nativeSessions.archive": absent,
    "Instance.subProviders.list": absent,
    "Instance.subProviders.set": absent,
    "Instance.subProviders.disable": absent,
  };
}

const rigs: OpencodeTestRig[] = [];
after(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});

function memberOf(target: object, dotted: string): unknown {
  let node: unknown = target;
  for (const segment of dotted.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as { [key: string]: unknown })[segment];
  }
  return node;
}

function optionalMembers(): string[] {
  const methods = JSON.parse(fs.readFileSync(path.join(ROOT, "spec/v1/methods.json"), "utf8")) as { methods: Array<{ interface?: string; member?: string; optional?: boolean }> };
  return methods.methods.filter((entry) => entry.optional === true && (entry.interface === "Session" || entry.interface === "Instance")).map((entry) => `${entry.interface}.${entry.member}`);
}

for (const generation of [1, 2] as const) {
  test(`${generation}.x: the outcome table covers exactly the 44 optional Session and Instance members`, () => {
    const members = optionalMembers();
    assert.equal(members.length, 44);
    assert.deepEqual(Object.keys(outcomes(generation)).sort(), [...members].sort());
  });

  test(`${generation}.x: each member the driver does not support is left out or rejects with unsupported{capability}`, async () => {
    const rig = await openOpencodeTestRig({ generation });
    rigs.push(rig);
    const { session } = await rig.open();
    const thread = await session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    for (const [member, outcome] of Object.entries(outcomes(generation))) {
      const [owner, ...rest] = member.split(".");
      const value = memberOf(owner === "Session" ? session : rig.instance, rest.join("."));
      if (outcome.outcome === "absent") assert.equal(value, undefined, `${member} is present but declared unsupported`);
      else assert.equal(typeof value, "function", `${member} is missing`);
      if (outcome.outcome === "unsupported") {
        const call = (value as (...args: unknown[]) => Promise<unknown>).bind(owner === "Session" ? session : rig.instance);
        await assert.rejects(call(thread.id), (error: unknown) => {
          assert.ok(isAriError(error, "unsupported"), `${member} rejected with ${String(error)}`);
          assert.equal((toCallError(error) as { capability?: string }).capability, outcome.capability);
          return true;
        });
      }
    }
    // The capabilities say the same.
    const declared = session.capabilities();
    assert.equal(declared.threads.unload, generation === 1);
    assert.equal(declared.sessions.release, generation === 1);
    if (generation === 2) {
      assert.equal(session.canRelease(), false);
      await assert.rejects(session.release(), (error: unknown) => isAriError(error, "unsupported") && (toCallError(error) as { capability?: string }).capability === "sessions.release");
    }
  });

  test(`${generation}.x: each session member the driver supports works against OpenCode`, async () => {
    const rig = await openOpencodeTestRig({ generation });
    rigs.push(rig);
    const opened = await rig.open();
    const session = opened.session;
    const thread = await session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const turnIds: string[] = [];
    for (const text of ["Remember me.", "And this."]) {
      const started = await session.startTurn({ threadId: thread.id, clientTurnKey: text, intent: "start", content: [{ type: "text", text }] });
      assert.equal(started.status, "accepted");
      if (started.status !== "accepted") return;
      turnIds.push(started.turnId);
      const native = await rig.nextTurn();
      await native.say("Noted.");
      await native.complete();
      await rig.terminal(opened.events, started.turnId);
    }

    const snapshot = await session.readSnapshot!(thread.id);
    assert.deepEqual(
      snapshot.turns.map((turn) => turn.id),
      turnIds,
      "the snapshot names the turns the live events named",
    );
    assert.ok(snapshot.items.some((item) => item.kind === "assistant_message" && item.text === "Noted."));
    const liveItems = new Set(opened.events.flatMap((event) => (event.body.type === "item.upsert" ? [event.body.item.id] : [])));
    for (const item of snapshot.items) assert.ok(liveItems.has(item.id), `snapshot item ${item.id} (${item.kind}) has an id the live events never used`);

    await session.compactThread!(thread.id);
    assert.equal(rig.inspect(thread)?.compactions, 1);

    const fork = await session.forkThread!({ threadId: thread.id, at: { type: "latest" } });
    assert.notEqual(fork.id, thread.id);
    assert.deepEqual(rig.inspect(fork)?.prompts, ["Remember me.", "And this."]);
    const fromTurn = await session.forkThread!({ threadId: thread.id, at: { type: "turn", turnId: turnIds[1]! } });
    assert.deepEqual(rig.inspect(fromTurn)?.prompts, ["Remember me."], "a fork from a turn holds the history before it");
    await assert.rejects(session.forkThread!({ threadId: thread.id, at: { type: "latest" }, cwd: rig.otherCwd }), (error: unknown) => isAriError(error, "unsupported"));

    const rolledBack = await session.rollbackThread!({ threadId: thread.id, to: { type: "turn", turnId: turnIds[0]! } });
    assert.deepEqual(
      rolledBack.turns.map((turn) => turn.id),
      [turnIds[0]],
    );
    assert.deepEqual(rig.inspect(thread)?.prompts, ["Remember me."]);
    const toStart = await session.rollbackThread!({ threadId: thread.id, to: { type: "start" } });
    assert.equal(toStart.turns.length, 0);
    assert.deepEqual(rig.inspect(thread)?.prompts, []);

    assert.equal(session.contextWindow!("fake/fake-small"), 128000);
    assert.equal(session.contextWindow!("fake/unknown"), undefined);

    const rules = (await session.ext!(PERMISSION_RULES_EXTENSION, "get", { threadId: thread.id })) as { rules: unknown[] };
    assert.ok(rules.rules.length > 0);

    if (generation === 1) {
      await session.unloadThread!(thread.id);
      assert.equal(rig.inspect(thread)?.loaded, false);
      const resumed = await session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd) });
      assert.equal(resumed.id, thread.id);
      assert.equal(rig.inspect(thread)?.loaded, true);
      assert.equal(session.canRelease(), true);
      await session.release();
      assert.equal(rig.inspect(thread)?.loaded, false);
    }
  });
}

for (const generation of [1, 2] as const) {
  // 30 turns are 60 messages: more than one 2.x page (50, newest first), so only a driver that pages through the history and orders it gets this right.
  test(`${generation}.x: snapshots, forks from a turn and rollbacks read the whole history in order, past OpenCode's first page`, async () => {
    const rig = await openOpencodeTestRig({ generation });
    rigs.push(rig);
    const opened = await rig.open();
    const session = opened.session;
    const thread = await session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    const turnIds: string[] = [];
    const prompts: string[] = [];
    for (let index = 1; index <= 30; index += 1) {
      const text = `Prompt ${index}.`;
      const started = await session.startTurn({ threadId: thread.id, clientTurnKey: text, intent: "start", content: [{ type: "text", text }] });
      assert.equal(started.status, "accepted");
      if (started.status !== "accepted") return;
      turnIds.push(started.turnId);
      prompts.push(text);
      const native = await rig.nextTurn();
      await native.say(`Reply ${index}.`);
      await native.complete();
      await rig.terminal(opened.events, started.turnId);
    }
    assert.equal(rig.world.sessions.get(thread.native.id!)!.messages.length, 60);

    const snapshot = await session.readSnapshot!(thread.id);
    assert.deepEqual(
      snapshot.turns.map((turn) => turn.id),
      turnIds,
      "every turn, oldest first",
    );
    for (const [index, turnId] of turnIds.entries()) {
      const items = snapshot.items.filter((item) => item.turnId === turnId);
      assert.deepEqual(
        items.map((item) => [item.kind, item.kind === "user_message" || item.kind === "assistant_message" ? item.text : undefined]),
        [
          ["user_message", `Prompt ${index + 1}.`],
          ["assistant_message", `Reply ${index + 1}.`],
        ],
        `turn ${index + 1} holds its own prompt and reply`,
      );
    }

    const fromTurn = await session.forkThread!({ threadId: thread.id, at: { type: "turn", turnId: turnIds[29]! } });
    assert.deepEqual(rig.inspect(fromTurn)?.prompts, prompts.slice(0, 29), "a fork from the last turn holds the 29 turns before it");

    const rolledBack = await session.rollbackThread!({ threadId: thread.id, to: { type: "turn", turnId: turnIds[26]! } });
    assert.deepEqual(
      rolledBack.turns.map((turn) => turn.id),
      turnIds.slice(0, 27),
    );
    assert.deepEqual(rig.inspect(thread)?.prompts, prompts.slice(0, 27), "rolling back to turn 27 keeps turns 1 to 27");
  });
}

test("2.x: a fork of a thread with no turns is refused as OpenCode refuses it, and leaves no thread behind", async () => {
  const rig = await openOpencodeTestRig({ generation: 2 });
  rigs.push(rig);
  const opened = await rig.open();
  const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
  const sessions = rig.world.sessions.size;
  await assert.rejects(opened.session.forkThread!({ threadId: thread.id, at: { type: "latest" } }), (error: unknown) => {
    assert.ok(isAriError(error, "invalid_state"), `the fork was refused with ${String(error)}`);
    assert.equal((toCallError(error) as { reason?: string }).reason, "empty_thread");
    return true;
  });
  assert.equal(rig.world.sessions.size, sessions, "OpenCode made no session");
});

/** Every leaf of the capabilities object, as `path` and its JSON value. */
function leaves(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [[prefix, JSON.stringify(value)]];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix === "" ? key : `${prefix}.${key}`));
}

test("docs/drivers/opencode.md lists every declared capability for 1.x and 2.x, and a source for each difference from §1.2", () => {
  const docs = fs.readFileSync(path.join(ROOT, "docs/drivers/opencode.md"), "utf8");
  const rows = new Map<string, string[]>();
  for (const line of docs.split("\n")) {
    const match = /^\| `([^`]+)` \|(.*)\|\s*$/.exec(line);
    if (match !== null) rows.set(match[1]!, match[2]!.split("|").map((cell) => cell.trim()));
  }
  const v1 = new Map(leaves(opencodeCapabilities({ generation: 1, external: false })));
  const v2 = new Map(leaves(opencodeCapabilities({ generation: 2, external: false })));
  for (const capability of new Set([...v1.keys(), ...v2.keys()])) {
    if (capability === "ariVersion") continue;
    const row = rows.get(capability);
    assert.ok(row !== undefined, `docs/drivers/opencode.md has no row for ${capability}`);
    assert.equal(row[0], `\`${v1.get(capability)}\``, `docs show ${capability} for 1.x as ${row[0]}; the driver declares ${v1.get(capability)}`);
    assert.equal(row[1], `\`${v2.get(capability)}\``, `docs show ${capability} for 2.x as ${row[1]}; the driver declares ${v2.get(capability)}`);
    const note = row[4] ?? "";
    for (const [index, declared] of [
      [2, v1.get(capability)],
      [3, v2.get(capability)],
    ] as const) {
      const proposal = row[index] ?? "";
      const differs = (proposal === "Y" && declared !== "true") || (proposal === "–" && declared === "true");
      if (differs) assert.match(note, /OpenCode|opencode|1\.19\.6|2\.1\.2|OpenAPI/, `${capability} differs from §1.2 (${proposal}) without a source`);
    }
  }
  // An external server changes the session model and parking; the docs say so.
  for (const generation of [1, 2] as const) {
    const external = opencodeCapabilities({ generation, external: true });
    assert.equal(external.sessionModel, "external");
    assert.equal(external.externallyOwned, true);
  }
  assert.match(docs, /`external`/);
});
