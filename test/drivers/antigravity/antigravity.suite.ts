// Antigravity's quirks: a profile directory per instance, ambient Google
// credentials stripped through the host's environment policy, fixed-choice
// permission prompts, a rollback refused before anything is touched, and the
// user's own `agy`: the driver runs the one its `command` names and never
// installs one, so a config that still names a setting of the managed install
// ARI used to offer is refused.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createFakeHost } from "../../../src/conformance/index.ts";
import {
  ANTIGRAVITY_CONFIG_SCHEMA,
  ANTIGRAVITY_DEFAULT_CONFIG,
  ANTIGRAVITY_REMOVED_SETTINGS,
  ANTIGRAVITY_STRIPPED_VARIABLES,
  antigravityDriver,
} from "../../../src/drivers/antigravity/index.ts";
import type { AntigravityConfig } from "../../../src/drivers/antigravity/index.ts";
import { isAriError } from "../../../src/index.ts";
import { meta } from "../../../src/meta/antigravity.ts";
import { openRig } from "../acp/rig.ts";
import { createProcessService } from "../../../src/node/process.ts";
import type { ProcessService } from "../../../src/node/process.ts";
import { watchInstanceFiles } from "../../helpers/conformance.ts";
import { profileSignInFile } from "../../recordings/antigravity/credentials.ts";
import { ANTIGRAVITY_RECORDER_ENV_POLICY, createAntigravityLayout, recordingModelChooser, runAntigravityScenario } from "../../recordings/antigravity/run.ts";
import type { AntigravityLayout } from "../../recordings/antigravity/run.ts";
import { SCENARIOS } from "../../recordings/scenarios.ts";
import { fakeAgyOnPath } from "./fake-agy.ts";

/** The fake `agy` prints a tested version, bare as the real `agy --version` prints it (test/fixtures/cli-version-output/agy.txt). */
const AGY_VERSION = ["--print-version", "1.5.17"];

const GOOGLE_AMBIENT = {
  PATH: "/usr/bin",
  GOOGLE_APPLICATION_CREDENTIALS: "/home/someone/adc.json",
  GEMINI_API_KEY: "gemini-inherited",
  GOOGLE_API_KEY: "google-inherited",
  GOOGLE_CLOUD_PROJECT: "someone-project",
  GOOGLE_GENAI_USE_VERTEXAI: "true",
  GCLOUD_PROJECT: "someone-project",
  CLOUDSDK_CORE_PROJECT: "someone-project",
  GEMINI_HOME: "/home/someone/.gemini",
};

test("each instance gets its own profile directory, and ambient Google credentials never reach the agent", async () => {
  const instances = await Promise.all(
    ["agy-one", "agy-two"].map((instanceId) =>
      openRig({ name: "antigravity", driver: antigravityDriver, config: { ...ANTIGRAVITY_DEFAULT_CONFIG }, executable: "agy", protocol: 1, agentArgs: AGY_VERSION, instanceId, fakeHost: { ambientEnvironment: GOOGLE_AMBIENT } }),
    ),
  );
  try {
    const profiles: string[] = [];
    for (const rig of instances) {
      await rig.open();
      const runtime = rig.host.spawns.find((spawn) => spawn.purpose === "runtime")!;
      const profile = `${rig.host.paths.stateDir}/profile`;
      profiles.push(profile);
      assert.equal(runtime.command, "agy");
      assert.deepEqual(runtime.args, ["acp", "--gemini-dir", profile, "--app-data-dir", "antigravity-acp"]);
      // agy 1.5.16 and later keep the sign-in in their file storage, under the profile, only with this variable set.
      assert.equal(runtime.environment["AGY_CLI_FORCE_FILE_TOKEN_STORAGE"], "1");
      assert.equal(runtime.environment["AGY_CLI_DISABLE_AUTO_UPDATE"], "true");
      // agy 1.5.x reads neither; the driver sets only what it reads.
      assert.equal(runtime.environment["AGY_ACP_FORCE_FILE_STORAGE"], undefined);
      assert.equal(runtime.environment["GEMINI_HOME"], undefined, "the inherited GEMINI_HOME was stripped, and the driver sets none");
      assert.equal((fs.statSync(profile).mode & 0o777).toString(8), "700");
      for (const name of ANTIGRAVITY_STRIPPED_VARIABLES) assert.equal(runtime.environment[name], undefined, `${name} was stripped`);
      assert.equal(runtime.environment["PATH"], "/usr/bin");
    }
    assert.notEqual(profiles[0], profiles[1]);
  } finally {
    for (const rig of instances) await rig.cleanup();
  }
});

/**
 * The real process service, starting the fake `agy` on PATH on a machine whose
 * keyring holds a Google sign-in and whose session bus is there, as on a
 * desktop: the fake keeps its sign-in in that shared keyring entry unless it is
 * told to use its file storage.
 */
function desktopProcessService(layout: AntigravityLayout, machine: { readonly bin: string; readonly keyring: string; readonly bus: string; readonly env: { readonly [name: string]: string } }): ProcessService {
  const service = createProcessService({
    envPolicy: ANTIGRAVITY_RECORDER_ENV_POLICY,
    baseEnv: {
      PATH: `${machine.bin}${path.delimiter}${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      HOME: layout.home,
      XDG_CONFIG_HOME: layout.configHome,
      XDG_DATA_HOME: layout.dataHome,
      XDG_STATE_HOME: layout.stateHome,
      XDG_CACHE_HOME: layout.cacheHome,
      XDG_RUNTIME_DIR: layout.runtimeDir,
      TMPDIR: layout.tmp,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${machine.bus}`,
      ARI_FAKE_AGY_KEYRING: machine.keyring,
      ...machine.env,
    },
  });
  return {
    envPolicy: service.envPolicy,
    resolveExecutable: (name, options) => service.resolveExecutable(name, options),
    spawn: (request) => service.spawn({ ...request, cwd: request.cwd ?? layout.cwd }),
    dispose: () => service.dispose(),
  };
}

test("two instances on a desktop whose keyring holds a Google sign-in each keep their own sign-in in their own profile, and neither reads or changes the keyring's", async () => {
  const machine = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-antigravity-desktop-")));
  const fake = fakeAgyOnPath(machine);
  const keyring = path.join(machine, "keyring-gemini-antigravity");
  const bus = path.join(machine, "session-bus");
  const keyringSignIn = JSON.stringify({ token: { access_token: "fake-access-keyring", refresh_token: "fake-refresh-keyring" }, auth_method: "consumer" });
  fs.writeFileSync(keyring, keyringSignIn, { mode: 0o600 });
  fs.writeFileSync(bus, "");
  const signedIn = createAntigravityLayout("ari-antigravity-instance-a-");
  const neverSignedIn = createAntigravityLayout("ari-antigravity-instance-b-");
  const signInA = JSON.stringify({ token: { access_token: "fake-access-a", refresh_token: "fake-refresh-a" }, auth_method: "consumer" });
  const refreshedA = JSON.stringify({ token: { access_token: "fake-access-a2", refresh_token: "fake-refresh-a2" }, auth_method: "consumer" });
  fs.mkdirSync(path.dirname(profileSignInFile(signedIn.profile)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(profileSignInFile(signedIn.profile), signInA, { mode: 0o600 });
  const simple = SCENARIOS.find((scenario) => scenario.name === "simple")!;
  try {
    for (const [layout, extra] of [[signedIn, { ARI_FAKE_AGY_REFRESH: refreshedA }], [neverSignedIn, {}]] as const) {
      const service = desktopProcessService(layout, { bin: fake.bin, keyring, bus, env: { ...fake.env, ...extra } });
      try {
        await runAntigravityScenario({ scenario: simple, layout, process: service, models: recordingModelChooser({}), timeoutMs: 20_000 });
      } finally {
        await service.dispose();
      }
    }
    const acp = fake.processes().filter((each) => each.args[0] === "acp");
    const of = (layout: AntigravityLayout) => acp.filter((each) => each.args.includes(layout.profile));
    assert.equal(of(signedIn).length, 1);
    assert.equal(of(neverSignedIn).length, 1);
    for (const [layout, found] of [[signedIn, signInA], [neverSignedIn, null]] as const) {
      const started = of(layout)[0]!;
      assert.equal(started.signInStore, "file", `agy kept the sign-in of ${layout.profile} in its file storage, not in the keyring every profile shares`);
      assert.equal(started.signInFile, profileSignInFile(layout.profile));
      assert.equal(started.signIn, found, "agy found its own profile's sign-in, never the keyring's");
    }
    assert.equal(fs.readFileSync(profileSignInFile(signedIn.profile), "utf8"), refreshedA, "the refreshed sign-in went to the instance's own profile");
    assert.equal(fs.existsSync(profileSignInFile(neverSignedIn.profile)), false, "the other instance got no sign-in");
    assert.equal(fs.readFileSync(keyring, "utf8"), keyringSignIn, "the keyring's sign-in is unchanged");
  } finally {
    for (const directory of [signedIn.root, neverSignedIn.root, machine]) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a host whose environment policy would let Google credentials through gets no session", async () => {
  const rig = await openRig({
    name: "antigravity",
    driver: antigravityDriver,
    config: { ...ANTIGRAVITY_DEFAULT_CONFIG },
    executable: "agy",
    protocol: 1,
    agentArgs: AGY_VERSION,
    fakeHost: { ambientEnvironment: GOOGLE_AMBIENT, envPolicy: { stripAmbient: ["GOOGLE_API_KEY", "GEMINI_*"] } },
  });
  try {
    await assert.rejects(rig.instance.openSession({}), (error) => isAriError(error, "invalid_state") && /GOOGLE_APPLICATION_CREDENTIALS/.test(error.message) && !/GEMINI_API_KEY/.test(error.message));
    assert.equal(rig.host.spawns.length, 0);
  } finally {
    await rig.cleanup();
  }
});

test("permission prompts take fixed choices only, and rollback is refused before any file, host call or frame", async () => {
  const rig = await openRig({ name: "antigravity", driver: antigravityDriver, config: { ...ANTIGRAVITY_DEFAULT_CONFIG }, executable: "agy", protocol: 1, agentArgs: AGY_VERSION });
  try {
    const { session, waitFor } = await rig.open();
    assert.equal(session.capabilities().requests.allowCustomAnswer, false);
    assert.equal(session.capabilities().threads.rollback, false);
    const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
    await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Edit it" }] });
    const native = await rig.nextTurn();
    await native.requestApproval({ kind: "file_change", path: "README.md", options: [{ optionId: "yes", label: "Yes", decision: "accept" }, { optionId: "no", label: "No", decision: "decline" }] });
    const pending = await waitFor((event) => event.body.type === "request.upsert" && event.body.request.status === "pending", "the request");
    const request = pending.body.type === "request.upsert" ? pending.body.request : undefined;
    assert.equal(request?.allowCustomAnswer, false);
    await assert.rejects(session.respond({ requestId: request!.id, responseKey: "custom", custom: "do it differently" }), (error) => isAriError(error, "unsupported"));
    await session.respond({ requestId: request!.id, responseKey: "yes", optionId: "yes" });
    await native.complete();
    await waitFor((event) => event.body.type === "turn.terminal", "turn.terminal");

    const watch = await watchInstanceFiles(rig.host.paths);
    const mark = rig.host.mark();
    const frames = rig.harness.frames.length;
    await assert.rejects(session.rollbackThread!({ threadId: thread.id, to: { type: "start" } }), (error) => isAriError(error, "unsupported") && error.callError.code === "unsupported" && error.callError.capability === "threads.rollback");
    assert.deepEqual(await watch.stop(), [], "no file under the instance's paths changed");
    assert.deepEqual(rig.host.callsSince(mark), [], "no host service was called");
    assert.equal(rig.harness.frames.length, frames, "nothing was sent to the agent");
  } finally {
    await rig.cleanup();
  }
});


test("the driver runs the agy its command config names: agy on PATH by default, or the path the config gives", async () => {
  for (const command of ["agy", "/opt/antigravity/bin/agy"]) {
    const rig = await openRig({ name: "antigravity", driver: antigravityDriver, config: { ...ANTIGRAVITY_DEFAULT_CONFIG, command }, executable: "agy", protocol: 1, agentArgs: AGY_VERSION });
    try {
      assert.equal((await rig.instance.status()).version, "1.5.17");
      await rig.open();
      const spawns = rig.host.spawns.map((spawn) => ({ command: spawn.command, args: spawn.args, purpose: spawn.purpose }));
      assert.deepEqual(
        spawns.filter((spawn) => spawn.purpose === "probe"),
        [
          { command, args: ["--version"], purpose: "probe" },
          { command, args: ["--version"], purpose: "probe" },
        ],
        "status() and openSession asked that agy for its version",
      );
      for (const probe of rig.host.spawns.filter((spawn) => spawn.purpose === "probe")) assert.equal(probe.environment["AGY_CLI_DISABLE_AUTO_UPDATE"], "true");
      const runtime = spawns.find((spawn) => spawn.purpose === "runtime");
      assert.equal(runtime?.command, command, "the session runs that agy");
      assert.equal(runtime?.args?.[0], "acp");
    } finally {
      await rig.cleanup();
    }
  }
});

test("ARI installs no agy: the config schema, form hints and default config have no installation setting, and the instance has no maintenance member", async () => {
  const properties = Object.keys((ANTIGRAVITY_CONFIG_SCHEMA as { properties: object }).properties);
  assert.deepEqual([...ANTIGRAVITY_REMOVED_SETTINGS], ["installation", "releaseManifestUrl", "version"]);
  for (const setting of ANTIGRAVITY_REMOVED_SETTINGS) {
    assert.ok(!properties.includes(setting), `the config schema has no ${setting}`);
    assert.ok(!(setting in meta.formHints), `the form hints have no ${setting}`);
    assert.ok(!(setting in antigravityDriver.defaultConfig()), `the default config has no ${setting}`);
  }
  const rig = await openRig({ name: "antigravity", driver: antigravityDriver, config: { ...ANTIGRAVITY_DEFAULT_CONFIG }, executable: "agy", protocol: 1, agentArgs: AGY_VERSION });
  try {
    assert.equal(rig.instance.maintenance, undefined, "no maintenance.install, maintenance.update or maintenance.advisory");
  } finally {
    await rig.cleanup();
  }
});

test("a config that still names a setting of the old managed install is refused: ARI no longer installs agy, and the error says how to install it", async () => {
  const oldSettings: Array<{ readonly [setting: string]: string }> = [
    { installation: "managed" },
    { installation: "path" },
    { releaseManifestUrl: "https://manifests.invalid/manifests" },
    { version: "latest" },
    { installation: "managed", releaseManifestUrl: "https://manifests.invalid/manifests", version: "1.5.2" },
  ];
  for (const settings of oldSettings) {
    const config = { ...ANTIGRAVITY_DEFAULT_CONFIG, ...settings } as unknown as AntigravityConfig;
    const host = createFakeHost<AntigravityConfig>({ config });
    await assert.rejects(antigravityDriver.create(host, { instanceId: "old-config", config, environment: {} }), (error: unknown) => {
      assert.ok(isAriError(error, "validation"), String(error));
      assert.match(error.message, /ARI no longer downloads, installs or updates the Antigravity CLI \(agy\)/);
      assert.ok(error.message.includes("curl -fsSL https://antigravity.google/cli/install.sh | bash"), error.message);
      assert.ok(error.message.includes("irm https://antigravity.google/cli/install.ps1 | iex"), error.message);
      const issues = error.callError.code === "validation" ? (error.callError.issues ?? []) : [];
      assert.deepEqual(issues.map((issue) => issue.path), Object.keys(settings).map((setting) => [setting]));
      for (const setting of Object.keys(settings)) assert.ok(error.message.includes(setting), `the message names ${setting}`);
      return true;
    });
    assert.deepEqual(host.spawns, [], "nothing ran");
  }
});
