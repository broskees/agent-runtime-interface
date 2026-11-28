// Codex sign-in: the ambient account is what `codex login status` reports; an
// API key or handed-over ChatGPT tokens make a managed profile whose Codex
// home is the instance's state directory; the browser sign-in uses the host's
// callback service and hands the provider's redirect to Codex's own login
// listener; only this instance answers Codex's token refresh requests.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { CODEX_TRANSFER_FORMAT } from "../../../src/drivers/codex/index.ts";
import { isAriError } from "../../../src/index.ts";
import { codexRig, policy } from "./rig.ts";
import type { CodexTestRig } from "./rig.ts";

let rig: CodexTestRig | undefined;
afterEach(async () => {
  await rig?.cleanup();
  rig = undefined;
});

const OWNER = "session_owner";

describe("codex sign-in", () => {
  test("the ambient account's state is what codex login status reports", async () => {
    const expected = { authenticated: "authenticated", unauthenticated: "unauthenticated", unknown: "unknown", unavailable: "unavailable", api_key: "configured" } as const;
    for (const [ambientAuth, status] of Object.entries(expected) as Array<[keyof typeof expected, string]>) {
      rig = await codexRig({ ambientAuth });
      const state = await rig.instance.auth!.state();
      assert.equal(state.status, status, `codex login status for ${ambientAuth}`);
      assert.equal(state.scope, "ambient");
      assert.deepEqual(rig.host.spawns.at(-1)!.args, ["login", "status"]);
      assert.deepEqual(rig.instance.auth!.credentialBinding, { owner: "provider", key: "codex:ambient" });
      if (status === "unauthenticated") await assert.rejects(rig.instance.openSession({}), (error) => isAriError(error, "auth_required"));
      await rig.cleanup();
      rig = undefined;
    }
  });

  test("codex gets the instance's environment, credentials included, in its checks and its app-server; the host's stripAmbient alone keeps a credential out", async () => {
    // Fake values only.
    const environment = { OPENAI_API_KEY: "sk-fake-instance", CODEX_API_KEY: "fake-codex-key", OPENAI_ADMIN_KEY: "fake-admin-key" };
    for (const stripAmbient of [[], ["OPENAI_*"]]) {
      rig = await codexRig({ environment, host: { envPolicy: { stripAmbient } } });
      await rig.instance.probe({ deep: true });
      const opened = await rig.open();
      await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
      const spawns = rig.host.spawns;
      for (const first of ["--version", "login", "app-server"]) assert.ok(spawns.some((spawn) => spawn.args?.[0] === first), `codex ${first} ran`);
      const stripped = stripAmbient.length > 0;
      for (const spawn of spawns) {
        const what = `codex ${spawn.args?.slice(0, 2).join(" ")} under stripAmbient ${JSON.stringify(stripAmbient)}`;
        assert.equal(spawn.environment["OPENAI_API_KEY"], stripped ? undefined : "sk-fake-instance", what);
        assert.equal(spawn.environment["OPENAI_ADMIN_KEY"], stripped ? undefined : "fake-admin-key", what);
        assert.equal(spawn.environment["CODEX_API_KEY"], "fake-codex-key", what);
      }
      await rig.cleanup();
      rig = undefined;
    }
  });

  test("an API key entered through auth.respond makes a managed profile: Codex's home is the instance's state directory", async () => {
    rig = await codexRig({ ambientAuth: "unauthenticated" });
    assert.deepEqual(rig.instance.auth!.methods().map((method) => [method.id, method.kind]), [["chatgpt", "oauth_browser"], ["device-code", "device_code"], ["api-key", "api_key"]]);
    const flow = await rig.instance.auth!.start({ ownerSessionId: OWNER, methodId: "api-key", callback: { mode: "client" } });
    assert.deepEqual(flow.fields?.map((field) => field.id), ["apiKey"]);
    const state = await rig.instance.auth!.respond!({ flowId: flow.flowId, values: { apiKey: "sk-entered" } });
    assert.deepEqual(state, { status: "configured", evidence: "passive", scope: "managed_profile" });
    assert.deepEqual(rig.host.storedSecrets().map((secret) => [secret.namespace, secret.key, new TextDecoder().decode(secret.value)]), [["codex", "api-key", "sk-entered"]]);
    assert.deepEqual(rig.instance.auth!.credentialBinding, { owner: "host", key: "codex:codex-test" });
    assert.equal(rig.instance.continuationKey, "codex:managed:codex-test");

    const opened = await rig.open();
    const spawn = rig.host.spawns.find((candidate) => candidate.args?.[0] === "app-server")!;
    assert.equal(spawn.environment["CODEX_HOME"], rig.host.paths.stateDir);
    assert.deepEqual(rig.world.logins.map((login) => [login.type, login.params["apiKey"]]), [["apiKey", "sk-entered"]]);
    await opened.session.close();
    await rig.open();
    assert.equal(rig.world.logins.length, 1, "a second app-server on the same home finds the key already signed in");

    await rig.instance.auth!.logout!();
    assert.deepEqual(rig.host.storedSecrets(), []);
    assert.equal((await rig.instance.auth!.state()).scope, "ambient");
    await assert.rejects(rig.instance.auth!.respond!({ flowId: flow.flowId, values: { apiKey: "" } }), (error) => isAriError(error, "not_found"));
  });

  test("the managed ChatGPT sign-in handoff: transferProfile signs every session in with the tokens, and only this instance answers Codex's refresh", async () => {
    rig = await codexRig({ ambientAuth: "unauthenticated" });
    await assert.rejects(rig.instance.auth!.transferProfile!({ format: "codex.auth_json", data: "{}" }), (error) => isAriError(error, "validation"));
    await assert.rejects(rig.instance.auth!.transferProfile!({ format: CODEX_TRANSFER_FORMAT, data: "not json" }), (error) => isAriError(error, "validation"));
    await assert.rejects(rig.instance.auth!.transferProfile!({ format: CODEX_TRANSFER_FORMAT, data: JSON.stringify({ accessToken: "a" }) }), (error) => isAriError(error, "validation"));
    const tokens = { accessToken: "access-1", chatgptAccountId: "account-42", chatgptPlanType: "plus" };
    const state = await rig.instance.auth!.transferProfile!({ format: CODEX_TRANSFER_FORMAT, data: JSON.stringify(tokens), account: { id: "account-42" } });
    assert.deepEqual(state, { status: "configured", evidence: "passive", scope: "managed_profile", account: { id: "account-42", plan: "plus" } });
    assert.deepEqual(rig.instance.auth!.credentialBinding, { owner: "host", key: "codex:codex-test" });

    const opened = await rig.open();
    const thread = await opened.session.createThread({ cwd: rig.cwd, policy: policy(rig.cwd) });
    assert.ok(thread.id.startsWith("thread_"));
    assert.deepEqual(rig.world.logins.at(-1), { type: "chatgptAuthTokens", params: { type: "chatgptAuthTokens", accessToken: "access-1", chatgptAccountId: "account-42", chatgptPlanType: "plus" } });
    assert.equal(rig.host.spawns.find((candidate) => candidate.args?.[0] === "app-server")!.environment["CODEX_HOME"], rig.host.paths.stateDir);
    assert.deepEqual(await rig.world.requestTokenRefresh(), { accessToken: "access-1", chatgptAccountId: "account-42", chatgptPlanType: "plus" });

    // The host hands over fresh tokens; Codex's next refresh gets them.
    await rig.instance.auth!.transferProfile!({ format: CODEX_TRANSFER_FORMAT, data: JSON.stringify({ ...tokens, accessToken: "access-2" }) });
    assert.deepEqual(await rig.world.requestTokenRefresh(), { accessToken: "access-2", chatgptAccountId: "account-42", chatgptPlanType: "plus" });
  });

  test("browser sign-in with a server callback: the host registers the flow, and auth.complete hands the redirect to Codex's login listener", async () => {
    rig = await codexRig({ ambientAuth: "unauthenticated" });
    const flow = await rig.instance.auth!.start({ ownerSessionId: OWNER, methodId: "chatgpt", callback: { mode: "server" } });
    const registered = rig.host.calls.filter((call) => call.operation === "callbacks.register");
    assert.deepEqual(registered.map((call) => call.args), [[flow.flowId]]);
    assert.ok(flow.url?.startsWith("https://auth.openai.com/oauth/authorize?"));
    const redirect = new URL(flow.url!).searchParams.get("redirect_uri")!;
    assert.match(flow.instructions ?? "", new RegExp(redirect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await assert.rejects(rig.instance.auth!.complete({ flowId: flow.flowId, callbackUrl: `https://evil.example/auth/callback?code=x&state=${flow.flowId}` }), (error) => isAriError(error, "validation"));
    await assert.rejects(rig.instance.auth!.complete({ flowId: "login-unknown", callbackUrl: `${redirect}?code=x` }), (error) => isAriError(error, "not_found"));

    const completed = await rig.instance.auth!.complete({ flowId: flow.flowId, callbackUrl: `${redirect}?code=the-code&state=${flow.flowId}` });
    assert.equal(completed.actionRequired, undefined);
    assert.deepEqual([...rig.world.stores.values()].map((store) => store.account), [{ type: "chatgpt", email: "someone@example.com", planType: "plus" }]);
  });

  test("device-code sign-in gives the code and the verification address; cancel reaches Codex", async () => {
    rig = await codexRig();
    const flow = await rig.instance.auth!.start({ ownerSessionId: OWNER, methodId: "device-code", callback: { mode: "client" } });
    assert.equal(flow.userCode, "FAKE-1234");
    assert.equal(flow.verificationUrl, "https://auth.openai.com/codex/device");
    await rig.instance.auth!.cancel(flow.flowId);
    assert.deepEqual(rig.requests("account/login/cancel"), [{ loginId: flow.flowId }]);
    await assert.rejects(rig.instance.auth!.start({ ownerSessionId: OWNER, methodId: "password", callback: { mode: "client" } }), (error) => isAriError(error, "not_found"));
  });

  test("a runtime auth failure poisons only its scope until its advertised expiry", async () => {
    rig = await codexRig();
    const poisoned = await rig.instance.auth!.reportRuntimeFailure!({ code: "401", message: "unauthorized" });
    assert.equal(poisoned.status, "unauthenticated");
    assert.equal(poisoned.evidence, "runtime_poison");
    assert.equal(poisoned.scope, "ambient");
    const ttl = Date.parse(poisoned.poisonExpiresAt!) - Date.now();
    assert.ok(ttl > 25_000 && ttl <= 30_000, `poison lasts ${ttl} ms`);
    await assert.rejects(rig.instance.openSession({}), (error) => isAriError(error, "auth_required"));
  });
});
