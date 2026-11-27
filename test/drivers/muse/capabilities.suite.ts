// Capability honesty for the Muse driver: all 42 optional members of the
// Session and Instance interfaces (inventories D and E) with the driver's
// outcome for each. A member the driver does not support is absent or rejects
// with `unsupported{capability}`; each member it supports is exercised here
// against the fake `muse serve`, with a check of its effect.
// docs/drivers/muse.md gives the reason for each member left out.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { MUSE_CAPABILITIES, MUSE_TESTED_VERSIONS } from "../../../src/drivers/muse/index.ts";
import { isAriError } from "../../../src/index.ts";
import type { Instance, Session, Thread } from "../../../src/index.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { museRig, policy, until } from "./rig.ts";
import type { MuseTestRig, OpenedMuseSession } from "./rig.ts";

type Outcome = "supported" | { readonly unsupported: string } | "absent";

/** The driver's outcome for each optional member: it works, it rejects with `unsupported` naming the capability, or the driver leaves it out. */
export const MUSE_OPTIONAL_MEMBERS: { readonly [member: string]: Outcome } = {
  // Session (inventory D).
  "Session.readSnapshot": "supported",
  "Session.forkThread": { unsupported: "threads.fork" },
  "Session.rollbackThread": { unsupported: "threads.rollback" },
  "Session.compactThread": "supported",
  "Session.injectHistory": "absent",
  "Session.unloadThread": "supported",
  "Session.backgroundTasks.list": "absent",
  "Session.backgroundTasks.stop": "absent",
  "Session.backgroundTasks.await": "absent",
  "Session.stopSubagent": "absent",
  "Session.mcpApps.listTools": "absent",
  "Session.mcpApps.callTool": "absent",
  "Session.mcpApps.readResource": "absent",
  "Session.contextWindow": "supported",
  "Session.canReuseContextUsage": "absent",
  "Session.uploadFeedback": "absent",
  "Session.ext": "absent",
  // Instance (inventory E).
  "Instance.invalidateCaches": "supported",
  "Instance.maintenance.advisory": "supported",
  "Instance.auth.methods": "supported",
  "Instance.auth.state": "supported",
  "Instance.auth.reportRuntimeFailure": "supported",
  "Instance.auth.start": "supported",
  "Instance.auth.complete": { unsupported: "auth.complete" },
  "Instance.auth.respond": "supported",
  "Instance.auth.cancel": "supported",
  "Instance.auth.logout": "supported",
  "Instance.auth.transferProfile": "absent",
  "Instance.auth.transferSession": "absent",
  "Instance.catalog.refresh": "supported",
  "Instance.workspace.snapshot": "absent",
  "Instance.limits.current": "supported",
  "Instance.limits.accountKey": "supported",
  "Instance.limits.consumeResetCredit": "absent",
  "Instance.usageHistory.scan": "absent",
  "Instance.textGeneration.generate": "absent",
  "Instance.nativeSessions.list": "absent",
  "Instance.nativeSessions.delete": "absent",
  "Instance.nativeSessions.archive": "absent",
  "Instance.subProviders.list": "absent",
  "Instance.subProviders.set": "absent",
  "Instance.subProviders.disable": "absent",
};

function member(target: object, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((value, key) => (value === undefined || value === null ? undefined : (value as { [key: string]: unknown })[key]), target);
}

describe("muse capability honesty: the 42 optional members", () => {
  test("the table lists exactly the optional Session and Instance members of methods.json", () => {
    const methods = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "spec", "v1", "methods.json"), "utf8")) as { methods: Array<{ interface?: string; member?: string; optional?: boolean }> };
    const optional = methods.methods.filter((entry) => (entry.interface === "Session" || entry.interface === "Instance") && entry.optional === true).map((entry) => `${entry.interface}.${entry.member}`);
    assert.equal(optional.length, 42);
    assert.deepEqual(Object.keys(MUSE_OPTIONAL_MEMBERS).sort(), optional.sort());
  });

  let rig: MuseTestRig;
  let opened: OpenedMuseSession;
  let session: Session;
  let instance: Instance;
  let thread: Thread;

  before(async () => {
    rig = await museRig({ fake: { subscriptionUsage: { observedAtMs: 1, tier: "pro", window: { usedPercent: 10, windowDurationMins: 300, resetsAtMs: Date.parse("2026-11-24T00:00:00Z") }, weekly: { usedPercent: 5, resetsAtMs: Date.parse("2026-11-30T00:00:00Z") } } } });
    instance = rig.instance;
    opened = await rig.open();
    session = opened.session;
    thread = await session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    for (const prompt of ["Start the server.", "Add a test."]) {
      const started = await session.startTurn({ threadId: thread.id, clientTurnKey: prompt, intent: "start", content: [{ type: "text", text: prompt }] });
      const native = await rig.nextTurn();
      await native.say("Done.");
      await native.complete();
      const turnId = (started as { turnId: string }).turnId;
      await until(() => opened.bodies("turn.terminal").find((body) => body.turnId === turnId), "the turn to end");
    }
  });
  after(async () => rig.cleanup());

  test("each member left out is absent, each refused one rejects with unsupported naming its capability, and each supported one is a function", async () => {
    for (const [name, outcome] of Object.entries(MUSE_OPTIONAL_MEMBERS)) {
      const [owner, ...rest] = name.split(".");
      const target = owner === "Session" ? session : instance;
      const value = member(target, rest.join("."));
      if (outcome === "absent") assert.equal(value, undefined, `${name} is declared absent but present`);
      else assert.equal(typeof value, "function", `${name} is declared ${outcome === "supported" ? "supported" : "refused"} but not a function`);
    }
    await assert.rejects(session.forkThread!({ threadId: thread.id, at: { type: "latest" } }), (error) => isAriError(error, "unsupported") && error.callError.code === "unsupported" && error.callError.capability === "threads.fork");
    await assert.rejects(session.rollbackThread!({ threadId: thread.id, to: { type: "start" } }), (error) => isAriError(error, "unsupported") && error.callError.code === "unsupported" && error.callError.capability === "threads.rollback");
    await assert.rejects(instance.auth!.complete({ flowId: "x", callbackUrl: "http://localhost/" }), (error) => isAriError(error, "unsupported") && error.callError.code === "unsupported" && error.callError.capability === "auth.complete");
  });

  test("the declared capabilities agree with the members: each gate is on exactly when its member works", () => {
    const caps = MUSE_CAPABILITIES;
    assert.equal(caps.threads.readSnapshot, true);
    assert.equal(caps.threads.compact, true);
    assert.equal(caps.threads.unload, true);
    assert.equal(caps.threads.injectHistory, false);
    assert.equal(caps.threads.rollback || caps.checkpointing.conversationRollback, false);
    assert.equal(caps.threads.fork.supported, false);
    assert.equal(caps.background.list || caps.background.stop || caps.background.await, false);
    assert.equal(caps.subagents.stop, false);
    assert.equal(caps.tools.mcpApps, false);
    assert.equal(caps.contextWindowReporting, true);
    assert.equal(caps.sessions.contextUsageReuse, false);
    assert.equal(caps.sessions.feedbackUpload, false);
    assert.equal(caps.sessions.release, true);
    assert.deepEqual(caps.extensions, []);
    assert.equal(caps.sessionModel, "process_per_thread");
  });

  test("readSnapshot holds both turns and their prompts, from Muse's own items", async () => {
    const snapshot = await session.readSnapshot!(thread.id);
    assert.equal(snapshot.thread.id, thread.id);
    assert.equal(snapshot.turns.length, 2);
    assert.deepEqual(
      snapshot.items.filter((item) => item.kind === "user_message").map((item) => item.text),
      ["Start the server.", "Add a test."],
    );
  });

  test("compactThread compacts the native session", async () => {
    const before = rig.world.inspect(thread.native.id!)!.compactions;
    await session.compactThread!(thread.id);
    assert.equal(rig.world.inspect(thread.native.id!)!.compactions, before + 1);
  });

  test("contextWindow answers each model's context limit from Muse's catalog", () => {
    assert.equal(session.contextWindow!("muse-large-2"), 200000);
    assert.equal(session.contextWindow!("unknown-model"), undefined);
  });

  test("unloadThread unloads the native session, and resumeThread brings it back to run a turn", async () => {
    await session.unloadThread!(thread.id);
    assert.equal(rig.world.inspect(thread.native.id!)!.loaded, false);
    await session.resumeThread({ native: thread.native, policy: policy(rig.cwd) });
    assert.equal(rig.world.inspect(thread.native.id!)!.loaded, true);
    const started = await session.startTurn({ threadId: thread.id, clientTurnKey: "after-unload", intent: "start", content: [{ type: "text", text: "Third." }] });
    const native = await rig.nextTurn();
    await native.complete();
    await until(() => opened.bodies("turn.terminal").find((body) => body.turnId === (started as { turnId: string }).turnId), "the turn to end");
    assert.deepEqual(rig.world.inspect(thread.native.id!)!.prompts, ["Start the server.", "Add a test.", "Third."]);
  });

  test("auth: methods, state, start, respond, cancel, reportRuntimeFailure and logout work on a managed key; the ambient account is unknown", async () => {
    assert.deepEqual(
      instance.auth!.methods().map((method) => [method.id, method.kind]),
      [
        ["api-key", "api_key"],
        ["muse-login", "terminal_cli"],
      ],
    );
    assert.deepEqual(await instance.auth!.state(), { status: "unknown", evidence: "passive", scope: "ambient" });
    assert.deepEqual(instance.auth!.credentialBinding, { owner: "provider", key: "muse:ambient" });
    await assert.rejects(instance.auth!.logout!(), (error) => isAriError(error, "unsupported"));
    const terminal = await instance.auth!.start({ ownerSessionId: session.id, methodId: "muse-login", callback: { mode: "server" } });
    assert.match(terminal.instructions ?? "", /muse login/);
    await instance.auth!.cancel(terminal.flowId);
    const flow = await instance.auth!.start({ ownerSessionId: session.id, methodId: "api-key", callback: { mode: "server" } });
    assert.deepEqual(flow.fields?.map((field) => field.id), ["apiKey"]);
    assert.deepEqual(await instance.auth!.respond!({ flowId: flow.flowId, values: { apiKey: "meta-key" } }), { status: "configured", evidence: "passive", scope: "managed_profile" });
    assert.equal(new TextDecoder().decode((await rig.host.secrets.get("muse", "api-key"))!), "meta-key");
    assert.deepEqual(instance.auth!.credentialBinding, { owner: "host", key: "muse:muse-test" });
    const poisoned = await instance.auth!.reportRuntimeFailure!({ message: "401" });
    assert.equal(poisoned.status, "unauthenticated");
    assert.equal(poisoned.evidence, "runtime_poison");
    assert.equal(poisoned.scope, "managed_profile");
    await instance.auth!.logout!();
    assert.equal(await rig.host.secrets.get("muse", "api-key"), null);
    assert.equal((await instance.auth!.state()).scope, "ambient");
  });

  test("catalog.refresh reads model/list again; invalidateCaches drops the cached catalog", async () => {
    await instance.catalog.list();
    const before = rig.requests("model/list").length;
    await instance.catalog.refresh!();
    assert.equal(rig.requests("model/list").length, before + 1);
    await instance.invalidateCaches!();
    await instance.catalog.list();
    assert.equal(rig.requests("model/list").length, before + 2);
  });

  test("limits.current reads usage/read; accountKey names the account", async () => {
    const limits = await instance.limits!.current();
    assert.equal(limits.limited, false);
    assert.deepEqual(limits.windows.map((window) => window.window), ["5h", "weekly"]);
    assert.equal(instance.limits!.accountKey(), "muse:ambient");
  });

  test("maintenance.advisory is null inside the tested range", async () => {
    assert.equal(MUSE_TESTED_VERSIONS, ">=1.4.25 <1.4.26");
    assert.equal(await instance.maintenance!.advisory(), null);
  });
});
