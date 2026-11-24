// Honest capabilities. docs/drivers/pi.md lists every declared capability next
// to the proposal's §1.2 Pi column, with a source for each difference. The 44
// optional members of inventories D and E each have an outcome here: left out,
// rejected with `unsupported{capability}`, or supported and exercised below
// (the conformance run exercises the session members again in scenario 14).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PI_AUTH_METHODS, piCapabilities } from "../../../src/drivers/pi/index.ts";
import { isAriError, toCallError } from "../../../src/index.ts";
import type { Instance, Session } from "../../../src/index.ts";
import { checkRunsAgainstPiTypes } from "./pi-types.ts";
import { openPiTestRig, policy } from "./rig.ts";
import type { PiTestRig } from "./rig.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Outcome = { readonly outcome: "absent" } | { readonly outcome: "unsupported"; readonly capability: string } | { readonly outcome: "supported" };

/** The driver's outcome for each optional member of `Session` (inventory D) and `Instance` (inventory E). */
const OUTCOMES: { readonly [member: string]: Outcome } = {
  "Session.readSnapshot": { outcome: "supported" },
  "Session.forkThread": { outcome: "supported" },
  "Session.rollbackThread": { outcome: "supported" },
  "Session.compactThread": { outcome: "supported" },
  "Session.injectHistory": { outcome: "absent" },
  "Session.unloadThread": { outcome: "supported" },
  "Session.backgroundTasks.list": { outcome: "absent" },
  "Session.backgroundTasks.stop": { outcome: "absent" },
  "Session.backgroundTasks.await": { outcome: "absent" },
  "Session.stopSubagent": { outcome: "absent" },
  "Session.mcpApps.listTools": { outcome: "absent" },
  "Session.mcpApps.callTool": { outcome: "absent" },
  "Session.mcpApps.readResource": { outcome: "absent" },
  "Session.contextWindow": { outcome: "supported" },
  "Session.canReuseContextUsage": { outcome: "absent" },
  "Session.uploadFeedback": { outcome: "absent" },
  "Session.ext": { outcome: "absent" },
  "Instance.invalidateCaches": { outcome: "absent" },
  "Instance.maintenance.advisory": { outcome: "absent" },
  "Instance.maintenance.install": { outcome: "absent" },
  "Instance.maintenance.update": { outcome: "absent" },
  "Instance.auth.methods": { outcome: "supported" },
  "Instance.auth.state": { outcome: "supported" },
  "Instance.auth.reportRuntimeFailure": { outcome: "supported" },
  "Instance.auth.start": { outcome: "supported" },
  "Instance.auth.complete": { outcome: "unsupported", capability: "auth.complete" },
  "Instance.auth.respond": { outcome: "supported" },
  "Instance.auth.cancel": { outcome: "supported" },
  "Instance.auth.logout": { outcome: "supported" },
  "Instance.auth.transferProfile": { outcome: "absent" },
  "Instance.auth.transferSession": { outcome: "absent" },
  "Instance.catalog.refresh": { outcome: "absent" },
  "Instance.workspace.snapshot": { outcome: "absent" },
  "Instance.limits.current": { outcome: "absent" },
  "Instance.limits.accountKey": { outcome: "absent" },
  "Instance.limits.consumeResetCredit": { outcome: "absent" },
  "Instance.usageHistory.scan": { outcome: "absent" },
  "Instance.textGeneration.generate": { outcome: "absent" },
  "Instance.nativeSessions.list": { outcome: "absent" },
  "Instance.nativeSessions.delete": { outcome: "absent" },
  "Instance.nativeSessions.archive": { outcome: "absent" },
  "Instance.subProviders.list": { outcome: "absent" },
  "Instance.subProviders.set": { outcome: "absent" },
  "Instance.subProviders.disable": { outcome: "absent" },
};

const rigs: PiTestRig[] = [];
after(async () => {
  for (const rig of rigs) await rig.close();
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

test("the outcome table covers exactly the 44 optional Session and Instance members", () => {
  const members = optionalMembers();
  assert.equal(members.length, 44);
  assert.deepEqual(Object.keys(OUTCOMES).sort(), [...members].sort());
});

test("each member the driver does not support is left out or rejects with unsupported{capability}", async () => {
  const rig = await openPiTestRig();
  rigs.push(rig);
  const { session } = await rig.open();
  for (const [member, outcome] of Object.entries(OUTCOMES)) {
    const [owner, ...rest] = member.split(".");
    const target: object = owner === "Session" ? session : rig.instance;
    const value = memberOf(target, rest.join("."));
    if (outcome.outcome === "absent") assert.equal(value, undefined, `${member} is present but declared unsupported`);
    else assert.equal(typeof value, "function", `${member} is missing`);
  }
  await assert.rejects(rig.instance.auth!.complete({ flowId: "pi-flow-1", callbackUrl: "http://127.0.0.1/cb" }), (error: unknown) => {
    assert.ok(isAriError(error, "unsupported"));
    assert.equal((toCallError(error) as { capability?: string }).capability, "auth.complete");
    return true;
  });
});

test("each session member the driver supports works against Pi", async () => {
  const rig = await openPiTestRig();
  rigs.push(rig);
  const opened = await rig.open();
  const session: Session = opened.session;
  const thread = await session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
  const started = await session.startTurn({ threadId: thread.id, clientTurnKey: "c1", intent: "start", content: [{ type: "text", text: "Remember me." }] });
  assert.equal(started.status, "accepted");
  if (started.status !== "accepted") return;
  const native = await rig.nextTurn();
  await native.say("Noted.");
  await native.complete();
  await rig.terminal(opened.events, started.turnId);

  const snapshot = await session.readSnapshot!(thread.id);
  assert.deepEqual(
    snapshot.turns.map((turn) => turn.id),
    [started.turnId],
  );
  assert.ok(snapshot.items.some((item) => item.kind === "assistant_message" && item.text === "Noted."));

  await session.compactThread!(thread.id);
  assert.equal((await rig.inspect(thread))?.compactions, 1);

  const fork = await session.forkThread!({ threadId: thread.id, at: { type: "latest" } });
  assert.notEqual(fork.id, thread.id);
  assert.deepEqual((await rig.inspect(fork))?.prompts, ["Remember me."]);

  const rolledBack = await session.rollbackThread!({ threadId: thread.id, to: { type: "start" } });
  assert.equal(rolledBack.turns.length, 0);
  assert.deepEqual((await rig.inspect(thread))?.prompts, []);

  assert.equal(session.contextWindow!("fake/fake-small"), 128000);
  assert.equal(session.contextWindow!("fake/unknown"), undefined);

  await session.unloadThread!(thread.id);
  assert.equal((await rig.inspect(thread))?.loaded, false);
  const resumed = await session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd) });
  assert.equal(resumed.id, thread.id);
  assert.equal((await rig.inspect(thread))?.loaded, true);
});

test("an untouched thread survives unloadThread: it resumes as itself in the same session and in a fresh one", async () => {
  const rig = await openPiTestRig();
  rigs.push(rig);
  const first = await rig.open();
  const runTurn = async (opened: Awaited<ReturnType<PiTestRig["open"]>>, threadId: string, text: string) => {
    const started = await opened.session.startTurn({ threadId, clientTurnKey: text, intent: "start", content: [{ type: "text", text }] });
    assert.equal(started.status, "accepted");
    if (started.status !== "accepted") throw new Error("not accepted");
    const native = await rig.nextTurn();
    await native.complete();
    assert.equal((await rig.terminal(opened.events, started.turnId)).status, "completed");
    assert.equal(opened.events.find((event) => event.body.type === "turn.terminal" && event.body.turnId === started.turnId)?.threadId, threadId);
  };

  // Threads with no messages: Pi has written no file for them yet (createEmpty).
  const thread = await first.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
  const other = await first.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
  assert.equal(fs.existsSync(thread.handle!), false);

  await first.session.unloadThread!(thread.id);
  assert.equal((await rig.inspect(thread))?.loaded, false);
  const again = await first.session.resumeThread({ native: { handle: thread.handle! }, policy: policy(rig.cwd) });
  assert.equal(again.id, thread.id);
  assert.equal(again.native.id, thread.native.id);
  assert.equal(again.handle, thread.handle);
  await runTurn(first, thread.id, "Back in the same session.");

  await first.session.unloadThread!(other.id);
  await first.session.close();
  const second = await rig.open();
  const resumed = await second.session.resumeThread({ native: { handle: other.handle! }, policy: policy(rig.cwd) });
  assert.equal(resumed.id, other.id);
  assert.equal(resumed.native.id, other.native.id);
  await runTurn(second, resumed.id, "Back in a fresh session.");

  for (const opened of [first, second]) {
    assert.equal(
      opened.events.some((event) => event.body.type === "session.replaced"),
      false,
      "no untouched thread was replaced by a new session",
    );
  }
  assert.deepEqual((await rig.inspect(thread))?.prompts, ["Back in the same session."]);
  assert.deepEqual((await rig.inspect(other))?.prompts, ["Back in a fresh session."]);
});

test("each auth member the driver supports works", async () => {
  const rig = await openPiTestRig();
  rigs.push(rig);
  const auth = rig.instance.auth!;
  assert.deepEqual(
    auth.methods().map((method) => method.id),
    PI_AUTH_METHODS.map((method) => method.id),
  );
  assert.equal((await auth.state()).status, "authenticated");
  const flow = await auth.start({ ownerSessionId: "s", methodId: "api-key", callback: { mode: "client" } });
  assert.deepEqual(
    flow.fields?.map((field) => field.id),
    ["apiKey"],
  );
  const login = await auth.start({ ownerSessionId: "s", methodId: "pi-login", callback: { mode: "client" } });
  assert.match(login.instructions ?? "", /pi auth login fake/);
  assert.equal((await auth.respond!({ flowId: flow.flowId, values: { apiKey: "sk-test" } })).status, "configured");
  assert.deepEqual(
    rig.host.storedSecrets().map((secret) => `${secret.namespace}/${secret.key}`),
    ["pi/api-key"],
  );
  const poisoned = await auth.reportRuntimeFailure!({ code: "401", message: "rejected" });
  assert.equal(poisoned.evidence, "runtime_poison");
  assert.equal(poisoned.scope, "managed_profile");
  assert.equal((await auth.cancel(flow.flowId)).evidence, "runtime_poison");
  await auth.logout!();
  assert.equal(rig.host.storedSecrets().length, 0);
  assert.equal((await auth.state()).scope, "ambient");
  await assert.rejects(auth.start({ ownerSessionId: "s", methodId: "oauth", callback: { mode: "client" } }), (error: unknown) => isAriError(error, "not_found"));
  void (rig.instance as Instance);
});

/** Every leaf of the capabilities object, as `path` and its JSON value. */
function leaves(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [[prefix, JSON.stringify(value)]];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix === "" ? key : `${prefix}.${key}`));
}

test("docs/drivers/pi.md lists every declared capability with its value, and a source for each difference from §1.2", () => {
  const docs = fs.readFileSync(path.join(ROOT, "docs/drivers/pi.md"), "utf8");
  const rows = new Map<string, string[]>();
  for (const line of docs.split("\n")) {
    const match = /^\| `([^`]+)` \|(.*)\|\s*$/.exec(line);
    if (match !== null) rows.set(match[1]!, match[2]!.split("|").map((cell) => cell.trim()));
  }
  for (const [capability, declared] of leaves(piCapabilities())) {
    if (capability === "ariVersion") continue;
    const row = rows.get(capability);
    assert.ok(row !== undefined, `docs/drivers/pi.md has no row for ${capability}`);
    assert.equal(row[0], `\`${declared}\``, `docs/drivers/pi.md shows ${capability} as ${row[0]}; the driver declares ${declared}`);
    const proposal = row[1] ?? "";
    const note = row[2] ?? "";
    const differs = (proposal === "Y" && declared !== "true") || (proposal === "–" && declared === "true");
    if (differs) assert.match(note, /Pi docs|pi\.dev|github\.com|pi-coding-agent/, `${capability} differs from §1.2 (${proposal}) without a source`);
  }
});

test("every frame and session file line of these tests matches Pi's published types", () => {
  const checked = checkRunsAgainstPiTypes(rigs.map((rig) => rig.harness));
  assert.ok(checked.frames > 0);
  assert.deepEqual(checked.diagnostics, []);
});
