// Honest capabilities. docs/drivers/cursor.md lists every declared capability
// next to the proposal's §1.2 Cursor column, with a source for each
// difference. The 44 optional members of inventories D and E each have an
// outcome here: left out, rejected with `unsupported{capability}`, or
// supported and exercised below (the conformance run exercises the session
// members again in scenario 14).

import "./setup-env.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CURSOR_AUTH_METHODS, cursorCapabilities } from "../../../src/drivers/cursor/index.ts";
import { CapabilitiesSchema, isAriError, toCallError } from "../../../src/index.ts";
import type { Session } from "../../../src/index.ts";
import { MANAGED_KEY } from "./harness.ts";
import { openCursorRig, policy } from "./rig.ts";
import type { CursorTestRig } from "./rig.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Outcome = { readonly outcome: "absent" } | { readonly outcome: "unsupported"; readonly capability: string } | { readonly outcome: "supported" };

/** The driver's outcome for each optional member of `Session` (inventory D) and `Instance` (inventory E). */
const OUTCOMES: { readonly [member: string]: Outcome } = {
  "Session.readSnapshot": { outcome: "absent" },
  "Session.forkThread": { outcome: "absent" },
  "Session.rollbackThread": { outcome: "absent" },
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
  "Session.contextWindow": { outcome: "absent" },
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

const rigs: CursorTestRig[] = [];
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

test("the declared capabilities are valid and match the docs table", () => {
  const capabilities = cursorCapabilities();
  assert.ok(CapabilitiesSchema.is(capabilities));
  const docs = fs.readFileSync(path.join(ROOT, "docs/drivers/cursor.md"), "utf8");
  const flatten = (value: unknown, prefix: string): Array<[string, unknown]> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value).flatMap(([key, inner]) => flatten(inner, prefix === "" ? key : `${prefix}.${key}`)) : [[prefix, value]];
  for (const [field, value] of flatten(capabilities, "")) {
    if (field === "ariVersion") continue;
    const row = docs.split("\n").find((line) => line.startsWith(`| \`${field}\` |`));
    assert.ok(row !== undefined, `docs/drivers/cursor.md has no row for ${field}`);
    assert.ok(row.includes(`| \`${JSON.stringify(value)}\` |`), `docs/drivers/cursor.md shows ${field} other than ${JSON.stringify(value)}: ${row}`);
  }
});

test("the outcome table covers exactly the 44 optional Session and Instance members", () => {
  const members = optionalMembers();
  assert.equal(members.length, 44);
  assert.deepEqual(Object.keys(OUTCOMES).sort(), [...members].sort());
});

test("each member the driver does not support is left out or rejects with unsupported{capability}", async () => {
  const rig = await openCursorRig();
  rigs.push(rig);
  const { session } = await rig.open();
  for (const [member, outcome] of Object.entries(OUTCOMES)) {
    const [owner, ...rest] = member.split(".");
    const target: object = owner === "Session" ? session : rig.instance;
    const value = memberOf(target, rest.join("."));
    if (outcome.outcome === "absent") assert.equal(value, undefined, `${member} is present but declared unsupported`);
    else assert.equal(typeof value, "function", `${member} is missing`);
  }
  await assert.rejects(rig.instance.auth!.complete({ flowId: "cursor-flow-1", callbackUrl: "http://127.0.0.1/cb" }), (error: unknown) => {
    assert.ok(isAriError(error, "unsupported"));
    assert.equal((toCallError(error) as { capability?: string }).capability, "auth.complete");
    return true;
  });
});

test("each session member the driver supports works against Cursor", async () => {
  const rig = await openCursorRig();
  rigs.push(rig);
  const opened = await rig.open();
  const session: Session = opened.session;
  const thread = await session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
  const { turnId, run } = await rig.turn(session, thread.id, "Remember me.");
  await run.say("Noted.");
  await run.endTurn();
  run.finish();
  assert.equal((await rig.terminal(opened.events, turnId)).status, "completed");

  // compactThread runs Cursor's agent.summarize().
  await session.compactThread!(thread.id);
  assert.equal(rig.world.agentFor(thread.native.id!)?.compactions, 1);

  // unloadThread closes the agent handle; the next turn reopens it with Agent.resume.
  await session.unloadThread!(thread.id);
  assert.equal(rig.world.agentFor(thread.native.id!)?.handles.size, 0);
  await rig.until(opened.events, (event) => (event.body.type === "thread.upsert" && event.body.thread.id === thread.id && event.body.thread.status === "unloaded" ? true : undefined), "the thread reported unloaded");
  const resumesBefore = rig.world.resumes.length;
  const again = await rig.turn(session, thread.id, "Still there?");
  assert.equal(rig.world.resumes.length, resumesBefore + 1, "the unloaded thread reopened with Agent.resume");
  await again.run.endTurn();
  again.run.finish();
  assert.equal((await rig.terminal(opened.events, again.turnId)).status, "completed");
  assert.deepEqual(rig.world.agentFor(thread.native.id!)?.prompts, ["Remember me.", "Still there?"]);
});

test("each instance member the driver supports works", async () => {
  const rig = await openCursorRig({ signedIn: false });
  rigs.push(rig);
  const auth = rig.instance.auth!;
  assert.deepEqual(
    auth.methods().map((method) => method.id),
    CURSOR_AUTH_METHODS.map((method) => method.id),
  );
  assert.equal((await auth.state()).status, "unauthenticated");
  const flow = await auth.start({ ownerSessionId: "host", methodId: "api-key", callback: { mode: "client" } });
  assert.deepEqual(
    flow.fields?.map((field) => field.id),
    ["apiKey"],
  );
  assert.equal((await auth.cancel(flow.flowId)).status, "unauthenticated");
  const stored = await auth.respond!({ flowId: flow.flowId, values: { apiKey: MANAGED_KEY } });
  assert.equal(stored.status, "configured");
  assert.equal(stored.scope, "managed_profile");
  assert.ok(rig.host.calls.some((call) => call.operation === "secrets.set" && call.args[0] === "cursor" && call.args[1] === "api-key"));
  const poisoned = await auth.reportRuntimeFailure!({ code: "401", message: "rejected" });
  assert.equal(poisoned.evidence, "runtime_poison");
  assert.equal(poisoned.status, "unauthenticated");
  await auth.logout!();
  assert.ok(rig.host.calls.some((call) => call.operation === "secrets.delete" && call.args[0] === "cursor" && call.args[1] === "api-key"));
  await assert.rejects(auth.start({ ownerSessionId: "host", methodId: "browser", callback: { mode: "client" } }), (error: unknown) => isAriError(error, "not_found"));
});

test("unsupported intents and policies are refused with the capability that is off", async () => {
  const rig = await openCursorRig();
  rigs.push(rig);
  const { session } = await rig.open();
  const thread = await session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
  assert.deepEqual(await session.startTurn({ threadId: thread.id, clientTurnKey: "q", intent: "queue", content: [{ type: "text", text: "Later." }] }), { status: "unsupported", capability: "turns.queue" });
  assert.deepEqual(await session.startTurn({ threadId: thread.id, clientTurnKey: "s", intent: "start", content: [{ type: "text", text: "Go." }], context: { synthetic: [{ key: "k", text: "v" }] } }), {
    status: "unsupported",
    capability: "context.syntheticContext",
  });
  assert.deepEqual(await session.startTurn({ threadId: thread.id, clientTurnKey: "m", intent: "start", content: [{ type: "text", text: "Go." }], policy: policy(rig.cwd, "read_only") }), {
    status: "unsupported",
    capability: "sessions.switchRuntimeMode",
  });
  for (const mode of ["approval_required", "auto_accept_edits", "auto"] as const) {
    await assert.rejects(session.createThread({ cwd: rig.cwd, policy: { mode, interaction: "default", cwd: rig.cwd } }), (error: unknown) => {
      assert.ok(isAriError(error, "unsupported"));
      assert.equal((toCallError(error) as { capability?: string }).capability, `runtimePolicy.modes.${mode}`);
      return true;
    });
  }
  await assert.rejects(session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd), launch: { dynamicTools: [{ name: "lookup", inputSchema: { type: "object" } }] } }), (error: unknown) => {
    assert.ok(isAriError(error, "unsupported"));
    assert.equal((toCallError(error) as { capability?: string }).capability, "tools.dynamicTools");
    return true;
  });
  // No request exists to answer: Cursor raises none.
  await assert.rejects(session.respond({ requestId: "request_x", responseKey: "k", optionId: "allow" }), (error: unknown) => isAriError(error, "not_found"));
});
