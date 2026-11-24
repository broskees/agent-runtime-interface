// Antigravity's quirks: a profile directory per instance, ambient Google
// credentials stripped through the host's environment policy, fixed-choice
// permission prompts, a rollback refused before anything is touched, and a
// managed install that every running session holds a lease on.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  ANTIGRAVITY_DEFAULT_CONFIG,
  ANTIGRAVITY_PACKAGE,
  ANTIGRAVITY_STRIPPED_VARIABLES,
  antigravityDriver,
  antigravityTarget,
  createAntigravityDriver,
} from "../../../src/drivers/antigravity/index.ts";
import type { AntigravityConfig } from "../../../src/drivers/antigravity/index.ts";
import { isAriError } from "../../../src/index.ts";
import { createAdapterInstaller } from "../../../src/node/installer.ts";
import { fixtureFetch } from "../acp/fixture-fetch.ts";
import { openRig, until } from "../acp/rig.ts";
import { watchInstanceFiles } from "../../helpers/conformance.ts";

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
      openRig({ name: "antigravity", driver: antigravityDriver, config: { ...ANTIGRAVITY_DEFAULT_CONFIG }, executable: "agy", protocol: 1, instanceId, fakeHost: { ambientEnvironment: GOOGLE_AMBIENT } }),
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
  const rig = await openRig({ name: "antigravity", driver: antigravityDriver, config: { ...ANTIGRAVITY_DEFAULT_CONFIG }, executable: "agy", protocol: 1 });
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

/** A managed CLI release: a tar.gz holding `antigravity`, and the manifest that names it. */
function release(version: string): { manifestUrl: string; manifest: object; archiveUrl: string; archive: Uint8Array } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-antigravity-release-"));
  try {
    fs.writeFileSync(path.join(directory, "antigravity"), "#!/bin/sh\necho antigravity\n", { mode: 0o755 });
    const archivePath = path.join(directory, "cli.tar.gz");
    const result = spawnSync("tar", ["-czf", archivePath, "-C", directory, "antigravity"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const archive = new Uint8Array(fs.readFileSync(archivePath));
    const target = antigravityTarget(process.platform, process.arch)!;
    const archiveUrl = `https://storage.invalid/antigravity-cli/${version}/cli.tar.gz`;
    return {
      manifestUrl: `https://manifests.invalid/manifests/${target}.json`,
      manifest: { version, url: archiveUrl, sha512: createHash("sha512").update(archive).digest("hex") },
      archiveUrl,
      archive,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const MANAGED: AntigravityConfig = { ...ANTIGRAVITY_DEFAULT_CONFIG, installation: "managed", releaseManifestUrl: "https://manifests.invalid/manifests" };

test("a managed install is installed through the adapter installer, and a running session holds a lease on its version", async () => {
  const published = release("1.5.2");
  const fetch = fixtureFetch({ [published.manifestUrl]: published.manifest, [published.archiveUrl]: published.archive });
  const rig = await openRig({ name: "antigravity", driver: createAntigravityDriver({ fetch }), config: MANAGED, executable: "antigravity", protocol: 1 });
  try {
    // Not installed yet: the probe says so without downloading anything, and no session starts.
    const before = await rig.instance.probe();
    assert.equal(before.installed, false);
    assert.equal(before.error?.code, "driver_unavailable");
    assert.equal((before.error as { package?: string }).package, ANTIGRAVITY_PACKAGE);
    assert.deepEqual(fetch.requested, []);
    await assert.rejects(rig.instance.openSession({}), (error) => isAriError(error, "driver_unavailable"));

    await rig.instance.maintenance!.install!();
    assert.deepEqual(fetch.requested, [published.manifestUrl, published.archiveUrl]);
    const executable = `${rig.host.paths.cacheDir}/adapters/${ANTIGRAVITY_PACKAGE}/1.5.2/antigravity`;
    assert.ok((fs.statSync(executable).mode & 0o100) !== 0, "the installed CLI is executable");
    assert.equal((await rig.instance.probe()).version, "1.5.2");
    assert.equal(await rig.instance.maintenance!.advisory(), null, "1.5.2 is a tested version");

    const { session } = await rig.open();
    const runtime = rig.host.spawns.find((spawn) => spawn.purpose === "runtime")!;
    assert.equal(runtime.command, executable);
    const leases = `${rig.host.paths.cacheDir}/adapters/${ANTIGRAVITY_PACKAGE}/.leases/1.5.2`;
    assert.equal(fs.readdirSync(leases).length, 1, "the session holds a lease");
    const installer = createAdapterInstaller({ cacheDir: rig.host.paths.cacheDir, fetchTarball: () => (async function* () {})() });
    assert.deepEqual(await installer.cleanup(), [], "cleanup keeps the leased version while the session runs");
    assert.ok(fs.existsSync(executable));

    await session.close();
    await until(() => (fs.readdirSync(leases).length === 0 ? true : undefined), "the lease to end with the agent process");
    assert.deepEqual((await installer.cleanup()).map((removed) => removed.version), ["1.5.2"], "without a session, cleanup may remove it");
  } finally {
    await rig.cleanup();
  }
});

test("a managed install refuses an archive that does not match the manifest's sha512", async () => {
  const published = release("1.5.2");
  const tampered = new Uint8Array(published.archive);
  tampered[tampered.length - 1] ^= 0xff;
  const fetch = fixtureFetch({ [published.manifestUrl]: published.manifest, [published.archiveUrl]: tampered });
  const rig = await openRig({ name: "antigravity", driver: createAntigravityDriver({ fetch }), config: MANAGED, executable: "antigravity", protocol: 1 });
  try {
    await assert.rejects(rig.instance.maintenance!.install!(), (error) => isAriError(error));
    assert.equal(fs.existsSync(`${rig.host.paths.cacheDir}/adapters/${ANTIGRAVITY_PACKAGE}/1.5.2`), false);
    assert.equal((await rig.instance.probe()).installed, false);
  } finally {
    await rig.cleanup();
  }
});

test("maintenance.update installs a newer release beside the running one, and advisory() flags an installed version outside the tested range", async () => {
  const first = release("1.5.2");
  const newer = release("1.6.0");
  const routes: { [url: string]: unknown } = { [first.manifestUrl]: first.manifest, [first.archiveUrl]: first.archive, [newer.archiveUrl]: newer.archive };
  const fetch = fixtureFetch(routes);
  const rig = await openRig({ name: "antigravity", driver: createAntigravityDriver({ fetch }), config: MANAGED, executable: "antigravity", protocol: 1 });
  try {
    await rig.instance.maintenance!.install!();
    assert.equal((await rig.instance.probe()).version, "1.5.2");
    // The release manifest moves on to 1.6.0.
    routes[newer.manifestUrl] = newer.manifest;
    await rig.instance.maintenance!.update!();
    assert.ok(fs.existsSync(`${rig.host.paths.cacheDir}/adapters/${ANTIGRAVITY_PACKAGE}/1.6.0/antigravity`));
    assert.ok(fs.existsSync(`${rig.host.paths.cacheDir}/adapters/${ANTIGRAVITY_PACKAGE}/1.5.2/antigravity`), "the older version stays until cleanup");
    assert.equal((await rig.instance.probe()).version, "1.6.0", "sessions run the newest installed version");
    const advisory = await rig.instance.maintenance!.advisory();
    assert.equal(advisory?.kind, "untested_version");
    assert.equal(advisory?.currentVersion, "1.6.0");
    assert.equal(advisory?.testedRange, ">=1.5.0 <1.6.0");
  } finally {
    await rig.cleanup();
  }
});
