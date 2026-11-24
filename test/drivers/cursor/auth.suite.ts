// Five-state sign-in, and the driver's part of dropping inherited
// credentials. Cursor's SDK resolves an API key as the `apiKey` option, then
// CURSOR_API_KEY in the process environment, then its stored login; the fake
// records which key each call resolved to, the SDK's way. The driver passes
// `apiKey` on every SDK call, so a CURSOR_API_KEY the host process (or the
// instance's environment) inherited never signs Cursor in. What the agent's
// own shell tools see is the host's process environment, which a driver
// running inside that process cannot change (docs/drivers/cursor.md, Limits).

import "./setup-env.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { isAriError } from "../../../src/index.ts";
import { FAKE_AMBIENT_KEY } from "./fake-sdk.ts";
import { MANAGED_KEY } from "./harness.ts";
import { openCursorRig, policy } from "./rig.ts";
import type { CursorTestRig } from "./rig.ts";

const rigs: CursorTestRig[] = [];
after(async () => {
  for (const rig of rigs) await rig.close();
});

const INHERITED = "crsr_inherited_key_the_instance_never_configured";

async function withInheritedKey<T>(body: () => Promise<T>): Promise<T> {
  const saved = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = INHERITED;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = saved;
  }
}

async function exercise(rig: CursorTestRig): Promise<void> {
  await rig.instance.status();
  await rig.instance.probe({ deep: true });
  await rig.instance.catalog.list();
  const { session, events } = await rig.open();
  const thread = await session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
  const { turnId, run } = await rig.turn(session, thread.id, "Hello.");
  assert.ok(run.authorized, "the run authenticated with a key Cursor accepts");
  await run.endTurn();
  run.finish();
  await rig.terminal(events, turnId);
  await session.unloadThread!(thread.id);
  const again = await rig.turn(session, thread.id, "Again.");
  await again.run.endTurn();
  again.run.finish();
  await rig.terminal(events, again.turnId);
}

test("an inherited CURSOR_API_KEY never signs Cursor in: every SDK call gets the instance's own key", async () => {
  await withInheritedKey(async () => {
    const rig = await openCursorRig({ managedProfile: true, environment: { CURSOR_API_KEY: INHERITED, PATH: "/usr/bin" } });
    rigs.push(rig);
    await exercise(rig);
    const calls = new Set(rig.world.keysUsed.map((use) => use.call));
    for (const call of ["Agent.create", "Agent.resume", "agent.send", "Cursor.models.list"]) assert.ok(calls.has(call), `${call} was exercised`);
    for (const use of rig.world.keysUsed) assert.equal(use.apiKey, MANAGED_KEY, `${use.call} resolved to ${String(use.apiKey)}`);
  });
});

test("an inherited CURSOR_API_KEY never signs Cursor in: the ambient account uses the SDK's stored login", async () => {
  await withInheritedKey(async () => {
    const rig = await openCursorRig({ environment: { CURSOR_API_KEY: INHERITED } });
    rigs.push(rig);
    await exercise(rig);
    assert.ok(rig.world.keysUsed.some((use) => use.call === "Cursor.me"));
    for (const use of rig.world.keysUsed) assert.equal(use.apiKey, FAKE_AMBIENT_KEY, `${use.call} resolved to ${String(use.apiKey)}`);
  });
});

test("with no stored key and no SDK login, Send is blocked before any SDK call could fall back to CURSOR_API_KEY", async () => {
  await withInheritedKey(async () => {
    const rig = await openCursorRig({ signedIn: false });
    rigs.push(rig);
    const state = await rig.instance.auth!.state();
    assert.deepEqual({ status: state.status, evidence: state.evidence, scope: state.scope }, { status: "unauthenticated", evidence: "passive", scope: "ambient" });
    assert.match(state.actionRequired?.reason ?? "", /API key|Cursor\.auth\.login/);
    await assert.rejects(rig.instance.openSession({}), (error: unknown) => isAriError(error, "auth_required"));
    await assert.rejects(rig.instance.catalog.list(), (error: unknown) => isAriError(error, "auth_required"));
    assert.deepEqual(rig.world.keysUsed, []);
  });
});

test("the five auth states: configured, authenticated, unauthenticated (none or expired), unknown and unavailable", async () => {
  const managed = await openCursorRig({ managedProfile: true, signedIn: false });
  rigs.push(managed);
  assert.deepEqual(await managed.instance.auth!.state(), { status: "configured", evidence: "passive", scope: "managed_profile" });

  const authenticated = await openCursorRig({ ambientAuth: "authenticated" });
  rigs.push(authenticated);
  assert.deepEqual(await authenticated.instance.auth!.state(), { status: "authenticated", evidence: "active", scope: "ambient", account: { email: "user@example.com" } });

  const expired = await openCursorRig({ signedIn: false });
  rigs.push(expired);
  await expired.world.storeSignIn(true, Date.now() - 1000);
  const expiredState = await expired.instance.auth!.state();
  assert.equal(expiredState.status, "unauthenticated");
  assert.match(expiredState.actionRequired?.reason ?? "", /expired/);

  const refused = await openCursorRig({ ambientAuth: "unauthenticated" });
  rigs.push(refused);
  assert.equal((await refused.instance.auth!.state()).status, "unauthenticated");
  assert.equal((await refused.instance.auth!.state()).evidence, "active");

  const unknown = await openCursorRig({ ambientAuth: "unknown" });
  rigs.push(unknown);
  assert.deepEqual(await unknown.instance.auth!.state(), { status: "unknown", evidence: "active", scope: "ambient" });

  // A check that cannot be answered never blocks Send: the stored login still signs the run in.
  const unavailable = await openCursorRig({ ambientAuth: "unavailable" });
  rigs.push(unavailable);
  assert.deepEqual(await unavailable.instance.auth!.state(), { status: "unavailable", evidence: "active", scope: "ambient" });
  const { session, events } = await unavailable.open();
  const thread = await session.createThread({ cwd: unavailable.cwd, policy: policy(unavailable.cwd) });
  const { turnId, run } = await unavailable.turn(session, thread.id, "Hello.");
  await run.endTurn();
  run.finish();
  assert.equal((await unavailable.terminal(events, turnId)).status, "completed");
});

test("the catalog is Cursor.models.list() for the account's key", async () => {
  const rig = await openCursorRig({ managedProfile: true });
  rigs.push(rig);
  const catalog = await rig.instance.catalog.list();
  assert.deepEqual(catalog, {
    models: [
      { id: "composer-2.5", label: "Composer 2.5", description: "Cursor's agent model", aliases: ["composer"] },
      { id: "gpt-5.5", label: "GPT-5.5" },
    ],
    defaultModelId: "composer-2.5",
  });
});
