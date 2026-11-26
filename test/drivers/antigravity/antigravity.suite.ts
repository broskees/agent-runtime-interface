// Antigravity's quirks: a profile directory per instance, ambient Google
// credentials stripped through the host's environment policy, fixed-choice
// permission prompts, a rollback refused before anything is touched, and the
// user's own `agy`: the driver runs the one its `command` names and never
// installs one, so a config that still names a setting of the managed install
// ARI used to offer is refused.

import assert from "node:assert/strict";
import * as fs from "node:fs";
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
import { watchInstanceFiles } from "../../helpers/conformance.ts";

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
      assert.equal(runtime.environment["GEMINI_HOME"], profile, "the instance's own profile, not the inherited GEMINI_HOME");
      assert.equal(runtime.environment["AGY_ACP_FORCE_FILE_STORAGE"], "1");
      assert.equal(runtime.environment["AGY_CLI_DISABLE_AUTO_UPDATE"], "1");
      assert.equal((fs.statSync(profile).mode & 0o777).toString(8), "700");
      for (const name of ANTIGRAVITY_STRIPPED_VARIABLES) if (name !== "GEMINI_HOME") assert.equal(runtime.environment[name], undefined, `${name} was stripped`);
      assert.equal(runtime.environment["PATH"], "/usr/bin");
    }
    assert.notEqual(profiles[0], profiles[1]);
  } finally {
    for (const rig of instances) await rig.cleanup();
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
