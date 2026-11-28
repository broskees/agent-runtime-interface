// Antigravity's quirks: the user's own `agy` profile and sign-in by default,
// or a profile directory per instance (`profile: "instance"`), with sign-in
// and resume following the profile; the self-updater off for the version
// command only; ambient Google
// credentials passed through unless the host's environment policy strips them
// (a policy that strips nothing starts a session), fixed-choice
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
  antigravityDriver,
} from "../../../src/drivers/antigravity/index.ts";
import type { AntigravityConfig } from "../../../src/drivers/antigravity/index.ts";
import type { AriEvent } from "../../../src/generated/events.ts";
import { isAriError } from "../../../src/index.ts";
import type { Instance, Session } from "../../../src/runtime.ts";
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

test("by default an instance runs agy acp on the user's own profile: no profile flags, no file storage switch, no updater switch and no profile directory, and the agent gets the ambient environment as it is, Google credentials included", async () => {
  assert.equal(ANTIGRAVITY_DEFAULT_CONFIG.profile, "user");
  // A config saved before `profile` existed names none: it gets the user's own profile too.
  const { profile: _profile, ...unset } = ANTIGRAVITY_DEFAULT_CONFIG;
  const instances = await Promise.all(
    [
      ["agy-one", { ...ANTIGRAVITY_DEFAULT_CONFIG }],
      ["agy-two", { ...ANTIGRAVITY_DEFAULT_CONFIG, profile: "user" }],
      ["agy-unset", unset],
    ].map(([instanceId, config]) =>
      openRig({ name: "antigravity", driver: antigravityDriver, config: config as AntigravityConfig, executable: "agy", protocol: 1, agentArgs: AGY_VERSION, instanceId: instanceId as string, fakeHost: { ambientEnvironment: GOOGLE_AMBIENT } }),
    ),
  );
  try {
    for (const rig of instances) {
      await rig.open();
      const runtime = rig.host.spawns.find((spawn) => spawn.purpose === "runtime")!;
      assert.equal(runtime.command, "agy");
      assert.deepEqual(runtime.args, ["acp"], "agy finds the user's own profile, settings, conversations and sign-in where it always does");
      for (const name of ["AGY_CLI_FORCE_FILE_TOKEN_STORAGE", "AGY_CLI_DISABLE_AUTO_UPDATE", "AGY_ACP_FORCE_FILE_STORAGE"]) assert.equal(runtime.environment[name], undefined, `the driver sets no ${name}`);
      assert.equal(fs.existsSync(`${rig.host.paths.stateDir}/profile`), false, "no private profile directory");
      // The host strips nothing, so every inherited variable reaches agy unchanged; the driver sets no GEMINI_HOME of its own.
      for (const [name, value] of Object.entries(GOOGLE_AMBIENT)) assert.equal(runtime.environment[name], value, `${name} passed through`);
    }
  } finally {
    for (const rig of instances) await rig.cleanup();
  }
});

test("profile instance gives each instance its own profile directory: agy acp --gemini-dir <stateDir>/profile --app-data-dir antigravity-acp with AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1, and no updater switch", async () => {
  const instances = await Promise.all(
    ["agy-one", "agy-two"].map((instanceId) =>
      openRig({ name: "antigravity", driver: antigravityDriver, config: { ...ANTIGRAVITY_DEFAULT_CONFIG, profile: "instance" }, executable: "agy", protocol: 1, agentArgs: AGY_VERSION, instanceId, fakeHost: { ambientEnvironment: GOOGLE_AMBIENT } }),
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
      assert.equal(runtime.environment["AGY_CLI_DISABLE_AUTO_UPDATE"], undefined, "the driver turns off no self-updater for a session");
      // agy 1.5.x reads neither; the driver sets only what it reads.
      assert.equal(runtime.environment["AGY_ACP_FORCE_FILE_STORAGE"], undefined);
      assert.equal((fs.statSync(profile).mode & 0o777).toString(8), "700");
      for (const [name, value] of Object.entries(GOOGLE_AMBIENT)) assert.equal(runtime.environment[name], value, `${name} passed through`);
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

test("two instances with profile instance on a desktop whose keyring holds a Google sign-in each keep their own sign-in in their own profile, and neither reads or changes the keyring's", async () => {
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

/** The user's own sign-in file, where `agy` keeps it without a reachable keyring: `~/.gemini/antigravity-cli/antigravity-oauth-token` (`--gemini-dir` defaults to `.gemini`, `--app-data-dir` to `antigravity-cli`, `agy acp --help`). */
function userSignInFileIn(home: string): string {
  return path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

test("instances on the user's own profile all use the user's one Google sign-in, as the user's own agy does: the keyring's on a desktop, else the user's ~/.gemini/antigravity-cli/antigravity-oauth-token, and a refresh goes back there", async () => {
  const simple = SCENARIOS.find((scenario) => scenario.name === "simple")!;
  const user = { ...ANTIGRAVITY_DEFAULT_CONFIG };
  for (const machineKind of ["desktop", "no keyring"] as const) {
    const machine = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-antigravity-user-")));
    const fake = fakeAgyOnPath(machine);
    // The fake stands in for the keyring with this file; an empty name is a machine without one.
    const keyring = machineKind === "desktop" ? path.join(machine, "keyring-gemini-antigravity") : "";
    const bus = path.join(machine, "session-bus");
    fs.writeFileSync(bus, "");
    const first = createAntigravityLayout("ari-antigravity-user-a-");
    const second = createAntigravityLayout("ari-antigravity-user-b-");
    // Both instances run as the same user, so they share one HOME.
    const home = first.home;
    const store = keyring === "" ? userSignInFileIn(home) : keyring;
    const signIn = JSON.stringify({ token: { access_token: "fake-access-user", refresh_token: "fake-refresh-user" }, auth_method: "consumer" });
    const refreshed = JSON.stringify({ token: { access_token: "fake-access-user2", refresh_token: "fake-refresh-user2" }, auth_method: "consumer" });
    fs.mkdirSync(path.dirname(store), { recursive: true, mode: 0o700 });
    fs.writeFileSync(store, signIn, { mode: 0o600 });
    try {
      for (const [layout, extra] of [[first, { ARI_FAKE_AGY_REFRESH: refreshed }], [second, {}]] as const) {
        const service = desktopProcessService({ ...layout, home }, { bin: fake.bin, keyring, bus, env: { ...fake.env, ...extra } });
        try {
          await runAntigravityScenario({ scenario: simple, layout, process: service, models: recordingModelChooser({}), timeoutMs: 20_000, config: user });
        } finally {
          await service.dispose();
        }
      }
      const acp = fake.processes().filter((each) => each.args[0] === "acp");
      assert.deepEqual(acp.map((each) => each.args), [["acp"], ["acp"]], machineKind);
      assert.deepEqual(
        acp.map((each) => [each.signInStore, each.signInFile, each.signIn]),
        [
          [keyring === "" ? "file" : "keyring", store, signIn],
          [keyring === "" ? "file" : "keyring", store, refreshed],
        ],
        `${machineKind}: both used the user's one sign-in, and the second found the first one's refresh`,
      );
      assert.equal(fs.readFileSync(store, "utf8"), refreshed, `${machineKind}: the refresh went back to the user's sign-in`);
      for (const layout of [first, second]) assert.equal(fs.existsSync(layout.profile), false, `${machineKind}: no private profile`);
    } finally {
      for (const directory of [first.root, second.root, machine]) fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

/** An Antigravity instance whose agents start through `service`, with the host's directories in `layout`. */
async function antigravityInstanceOn(layout: AntigravityLayout, service: ProcessService, config: AntigravityConfig, instanceId: string): Promise<Instance> {
  const base = path.dirname(layout.stateDir);
  const host = createFakeHost<AntigravityConfig>({ config, envPolicy: ANTIGRAVITY_RECORDER_ENV_POLICY, paths: { stateDir: layout.stateDir, cacheDir: path.join(base, "cache"), tmpDir: path.join(base, "tmp") } });
  return antigravityDriver.create({ ...host, process: service }, { instanceId, config, environment: {} });
}

test("resume follows the profile: an instance on the user's own profile resumes a conversation another instance on it had, and an instance with profile instance, which has its own conversations, replaces it with a fresh one and says so", async () => {
  const machine = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-antigravity-resume-")));
  const fake = fakeAgyOnPath(machine);
  const bus = path.join(machine, "session-bus");
  fs.writeFileSync(bus, "");
  const layouts = ["a", "b", "c"].map((name) => createAntigravityLayout(`ari-antigravity-resume-${name}-`));
  const [first, second, third] = layouts as [AntigravityLayout, AntigravityLayout, AntigravityLayout];
  // One user, so one HOME, and one project folder all three work in.
  const home = first.home;
  const cwd = first.cwd;
  const policy = { cwd, mode: "approval_required", interaction: "default" } as const;
  const open = async (layout: AntigravityLayout, config: AntigravityConfig, instanceId: string): Promise<{ instance: Instance; session: Session; service: ProcessService }> => {
    const service = desktopProcessService({ ...layout, home, cwd }, { bin: fake.bin, keyring: "", bus, env: fake.env });
    const instance = await antigravityInstanceOn(layout, service, config, instanceId);
    return { instance, session: await instance.openSession({}), service };
  };
  const close = async (opened: { instance: Instance; service: ProcessService }): Promise<void> => {
    await opened.instance.dispose();
    await opened.service.dispose();
  };
  try {
    const original = await open(first, { ...ANTIGRAVITY_DEFAULT_CONFIG }, "agy-user-a");
    const thread = await original.session.createThread({ cwd, policy });
    const handle = thread.handle ?? thread.native.id!;
    await close(original);

    const user = await open(second, { ...ANTIGRAVITY_DEFAULT_CONFIG }, "agy-user-b");
    try {
      const resumed = await user.session.resumeThread({ native: { handle }, policy });
      assert.equal(resumed.native.id, thread.native.id, "the user's own profile holds the conversation");
      assert.deepEqual((await keptEvents(user.session)).filter((event) => event.body.type === "session.replaced"), [], "nothing was replaced");
    } finally {
      await close(user);
    }

    const own = await open(third, { ...ANTIGRAVITY_DEFAULT_CONFIG, profile: "instance" }, "agy-instance-c");
    try {
      // The fake numbers sessions per profile, so the fresh one may reuse the old id; the event says what happened.
      await own.session.resumeThread({ native: { handle }, policy });
      const said = (await keptEvents(own.session)).filter((event) => event.body.type === "session.replaced");
      assert.deepEqual(
        said.map((event) => (event.body.type === "session.replaced" ? [event.body.previousNativeId, event.body.contextLost, event.body.reason] : [])),
        [[thread.native.id, true, `The ACP agent could not resume session ${thread.native.id}: Resource not found: ${thread.native.id}`]],
        "its own profile does not hold the conversation, so a fresh one replaced it, and the host is told the old context is gone",
      );
    } finally {
      await close(own);
    }
    const acp = fake.processes().filter((each) => each.args[0] === "acp");
    assert.deepEqual(acp.map((each) => each.args), [["acp"], ["acp"], ["acp", "--gemini-dir", third.profile, "--app-data-dir", "antigravity-acp"]]);
  } finally {
    for (const directory of [...layouts.map((layout) => layout.root), machine]) fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** Every event the session kept so far: a kept event comes at once, and when none is left the next would wait, so the macrotask wins. */
async function keptEvents(session: Session): Promise<AriEvent[]> {
  const events = session.events({ fromSeq: 1 })[Symbol.asyncIterator]();
  const kept: AriEvent[] = [];
  try {
    for (;;) {
      const next = await Promise.race([events.next(), new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined)))]);
      if (next === undefined || next.done === true) return kept;
      kept.push(next.value);
    }
  } finally {
    await events.return?.();
  }
}

test("a profile other than user or instance is refused before anything runs: it would decide whose sign-in agy uses", async () => {
  for (const profile of ["private", "", "Instance"]) {
    const config = { ...ANTIGRAVITY_DEFAULT_CONFIG, profile } as unknown as AntigravityConfig;
    const host = createFakeHost<AntigravityConfig>({ config });
    await assert.rejects(antigravityDriver.create(host, { instanceId: "bad-profile", config, environment: {} }), (error: unknown) => {
      assert.ok(isAriError(error, "validation"), String(error));
      assert.equal(error.message, `The Antigravity profile must be "user" (the user's own agy profile and sign-in) or "instance" (a profile private to this instance), not ${JSON.stringify(profile)}.`);
      const issues = error.callError.code === "validation" ? (error.callError.issues ?? []) : [];
      assert.deepEqual(issues.map((issue) => issue.path), [["profile"]]);
      return true;
    });
    assert.deepEqual(host.spawns, [], "nothing ran");
  }
});

test("a host policy that strips nothing starts a session, and the variables a host policy names never reach agy", async () => {
  // The instance's own environment holds credentials too (fake values), and they pass through the same way.
  const instanceEnvironment = { GEMINI_CLI_IDE_TOKEN: "instance-token", GOOGLE_GENAI_API_KEY: "instance-genai" };
  const given = { ...GOOGLE_AMBIENT, ...instanceEnvironment };
  for (const stripAmbient of [[], ["GOOGLE_API_KEY", "GEMINI_*"]]) {
    const rig = await openRig({
      name: "antigravity",
      driver: antigravityDriver,
      config: { ...ANTIGRAVITY_DEFAULT_CONFIG },
      executable: "agy",
      protocol: 1,
      agentArgs: AGY_VERSION,
      environment: instanceEnvironment,
      fakeHost: { ambientEnvironment: GOOGLE_AMBIENT, envPolicy: { stripAmbient } },
    });
    try {
      await rig.open();
      const spawns = rig.host.spawns;
      const runtime = spawns.find((spawn) => spawn.purpose === "runtime")!;
      assert.ok(runtime !== undefined, `a session started under stripAmbient ${JSON.stringify(stripAmbient)}`);
      const named = (name: string): boolean => stripAmbient.some((entry) => (entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry));
      assert.ok(spawns.some((spawn) => spawn.purpose === "probe"), "the version command ran");
      for (const [name, value] of Object.entries(given)) {
        for (const spawn of spawns) {
          if (named(name)) assert.equal(spawn.environment[name], undefined, `the host stripped ${name} from ${spawn.args?.join(" ")}`);
          else assert.equal(spawn.environment[name], value, `${name} reached ${spawn.args?.join(" ")}`);
        }
      }
    } finally {
      await rig.cleanup();
    }
  }
});

test("a policy without a mode leaves agy's own mode: the thread reports its mode option as an ARI mode, plan as the plan interaction, and an id it does not know by name", async () => {
  // agy 1.5's mode option, as the committed recordings show it.
  const mode = (current: string) => ({
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: current,
    options: [
      { value: "default", name: "Default", description: "Ask before edits and commands, per your permission settings." },
      { value: "accept-edits", name: "Accept edits", description: "Approve file edits in the workspace without asking." },
      { value: "auto", name: "Auto", description: "Approve edits and safe commands; ask before irreversible actions." },
      { value: "plan", name: "Plan", description: "Plan carefully before executing a task." },
    ],
  });
  const expected: Array<[string, unknown]> = [
    ["default", { mode: "approval_required", interaction: "default", source: "harness" }],
    ["accept-edits", { mode: "auto_accept_edits", interaction: "default", source: "harness" }],
    ["auto", { mode: "auto", interaction: "default", source: "harness" }],
    ["plan", { interaction: "plan", source: "harness" }],
  ];
  for (const [current, report] of expected) {
    const rig = await openRig({ name: `antigravity-${current}`, driver: antigravityDriver, config: { ...ANTIGRAVITY_DEFAULT_CONFIG }, executable: "agy", protocol: 1, agentArgs: [...AGY_VERSION, "--config-options", JSON.stringify([mode(current)])] });
    try {
      const { session } = await rig.open();
      const thread = await session.createThread({ cwd: rig.cwd, policy: { interaction: "default", cwd: rig.cwd } });
      assert.deepEqual(thread.effectiveMode, report, `agy mode ${current}`);
      const sets = rig.harness.frames.filter((frame) => frame.from === "client" && (frame.message as { method?: string }).method === "session/set_config_option");
      assert.equal(sets.length, 0, "the driver changed agy's mode");
    } finally {
      await rig.cleanup();
    }
  }
  // A mode id the driver has no evidence for keeps agy's name; legacy v1 modes count when no mode option is offered.
  const rig = await openRig({ name: "antigravity-unknown", driver: antigravityDriver, config: { ...ANTIGRAVITY_DEFAULT_CONFIG }, executable: "agy", protocol: 1, agentArgs: [...AGY_VERSION, "--modes", JSON.stringify({ currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] })] });
  try {
    const { session } = await rig.open();
    const thread = await session.createThread({ cwd: rig.cwd, policy: { interaction: "default", cwd: rig.cwd } });
    assert.deepEqual(thread.effectiveMode, { mode: "yolo", source: "harness" });
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


test("the driver runs the agy its command config names: agy on PATH by default, or the path the config gives; only its version command runs with the self-updater off, in either profile", async () => {
  for (const [command, profile] of [["agy", "user"], ["/opt/antigravity/bin/agy", "user"], ["agy", "instance"]] as const) {
    const rig = await openRig({ name: "antigravity", driver: antigravityDriver, config: { ...ANTIGRAVITY_DEFAULT_CONFIG, command, profile }, executable: "agy", protocol: 1, agentArgs: AGY_VERSION });
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
      // A status check must not update the binary it checks.
      for (const probe of rig.host.spawns.filter((spawn) => spawn.purpose === "probe")) assert.equal(probe.environment["AGY_CLI_DISABLE_AUTO_UPDATE"], "true");
      const runtime = spawns.find((spawn) => spawn.purpose === "runtime");
      assert.equal(runtime?.command, command, "the session runs that agy");
      assert.equal(runtime?.args?.[0], "acp");
      assert.equal(rig.host.spawns.find((spawn) => spawn.purpose === "runtime")!.environment["AGY_CLI_DISABLE_AUTO_UPDATE"], undefined, `${profile}: the driver turns off no self-updater for a session`);
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
    assert.equal(rig.instance.maintenance, undefined, "no maintenance member, not even maintenance.advisory");
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
