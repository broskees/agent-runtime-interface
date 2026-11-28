// The rules every driver meets, checked for one ACP driver (the base or a
// flavor): honest optional members (42 of them), a missing runtime that fails
// loudly only when used, no host prompts and host-chosen names, and its
// metadata, docs and changelog. Each driver's `rules.suite.ts` calls
// `driverRuleTests` with its profile.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { validateCliManifest } from "../../../src/cli-manifests/index.ts";
import { IconSchema, isAriError } from "../../../src/index.ts";
import type { FakeHostOptions } from "../../../src/conformance/index.ts";
import { parseVersion } from "../../../src/drivers/acp/driver.ts";
import type { DriverMeta } from "../../../src/meta/acp.ts";
import type { Driver, Instance, Session } from "../../../src/runtime.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import type { HostPaths } from "../../../src/index.ts";
import { openRig } from "./rig.ts";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";

/** The 17 optional Session members (inventory D) and 25 optional Instance members (inventory E). */
export const OPTIONAL_SESSION_MEMBERS = [
  "readSnapshot",
  "forkThread",
  "rollbackThread",
  "compactThread",
  "injectHistory",
  "unloadThread",
  "backgroundTasks.list",
  "backgroundTasks.stop",
  "backgroundTasks.await",
  "stopSubagent",
  "mcpApps.listTools",
  "mcpApps.callTool",
  "mcpApps.readResource",
  "contextWindow",
  "canReuseContextUsage",
  "uploadFeedback",
  "ext",
] as const;

export const OPTIONAL_INSTANCE_MEMBERS = [
  "invalidateCaches",
  "maintenance.advisory",
  "auth.methods",
  "auth.state",
  "auth.reportRuntimeFailure",
  "auth.start",
  "auth.complete",
  "auth.respond",
  "auth.cancel",
  "auth.logout",
  "auth.transferProfile",
  "auth.transferSession",
  "catalog.refresh",
  "workspace.snapshot",
  "limits.current",
  "limits.accountKey",
  "limits.consumeResetCredit",
  "usageHistory.scan",
  "textGeneration.generate",
  "nativeSessions.list",
  "nativeSessions.delete",
  "nativeSessions.archive",
  "subProviders.list",
  "subProviders.set",
  "subProviders.disable",
] as const;

export type Outcome = "absent" | "unsupported" | "supported";

/** The ACP protocol versions every ACP driver is tested against, as status() advisories and the generic drivers' metadata state them. */
export const ACP_TESTED_PROTOCOL_RANGE = "1 - 2";

export interface DriverProfile<Config> {
  readonly kind: string;
  readonly driver: Driver<Config>;
  readonly meta: DriverMeta;
  /** A config whose agent the fake host can run. */
  readonly config: Config;
  readonly executable: string;
  readonly protocol: 1 | 2;
  readonly agentArgs?: readonly string[];
  readonly hostOptions?: (instanceId: string, paths: HostPaths) => Partial<FakeHostOptions<Config>>;
  /** A config whose agent is not installed, and what the error must name. */
  readonly missing: { readonly config: Config; readonly binary?: string; readonly package?: string };
  /**
   * For a driver that runs a vendor's CLI: its minimum (the lower bound of its tested range) and the vendor's update
   * step, `--version` lines the fake prints (at the minimum, above the tested range, below the minimum), and the CLI's
   * real `--version` output, a committed file under test/fixtures/cli-version-output/, with the version it holds.
   */
  readonly versions?: {
    readonly minimum: string;
    readonly updateStep: string;
    readonly atMinimum: string;
    readonly aboveRange: string;
    readonly aboveVersion: string;
    readonly belowMinimum: string;
    readonly belowVersion: string;
    readonly realOutput: { readonly file: string; readonly version: string };
  };
  /** For a driver that runs any agent (its tested range is the ACP protocol versions): the version status() reports. */
  readonly reportedVersion?: string;
  /** What the driver does with each optional member; `supported` members are exercised below. */
  readonly session: { readonly [member in (typeof OPTIONAL_SESSION_MEMBERS)[number]]: Outcome };
  readonly instance: { readonly [member in (typeof OPTIONAL_INSTANCE_MEMBERS)[number]]: Outcome };
  /** Exercises an instance member the driver supports (beyond the session members this module exercises). */
  readonly exerciseInstance?: (instance: Instance, member: string, cwd: string) => Promise<void>;
  /** The executable's own launch command and arguments, as docs/drivers/<kind>.md states them. */
  readonly launch: string;
}

function member(target: object, dotted: string): unknown {
  let value: unknown = target;
  for (const part of dotted.split(".")) {
    if (value === null || value === undefined) return undefined;
    value = (value as { [key: string]: unknown })[part];
  }
  return value;
}

const ALL_SESSION_ABSENT = Object.fromEntries(OPTIONAL_SESSION_MEMBERS.map((name) => [name, "absent"])) as DriverProfile<unknown>["session"];
const ALL_INSTANCE_ABSENT = Object.fromEntries(OPTIONAL_INSTANCE_MEMBERS.map((name) => [name, "absent"])) as DriverProfile<unknown>["instance"];

/** The members every ACP driver handles alike: ext works, forkThread is present (gated by the agent's fork capability), the rest are left out. */
export function acpSessionMembers(forks: boolean, overrides: Partial<DriverProfile<unknown>["session"]> = {}): DriverProfile<unknown>["session"] {
  return { ...ALL_SESSION_ABSENT, forkThread: forks ? "supported" : "unsupported", ext: "supported", ...overrides };
}

export function acpInstanceMembers(overrides: Partial<DriverProfile<unknown>["instance"]> = {}): DriverProfile<unknown>["instance"] {
  return { ...ALL_INSTANCE_ABSENT, ...overrides };
}

function rigOptions<Config>(profile: DriverProfile<Config>, extraArgs: readonly string[] = [], fakeHost: Partial<FakeHostOptions<Config>> = {}) {
  return {
    name: profile.kind,
    driver: profile.driver,
    config: profile.config,
    executable: profile.executable,
    protocol: profile.protocol,
    // The fake reads the first occurrence of an argument, so a test's own arguments go first.
    agentArgs: [...extraArgs, ...(profile.agentArgs ?? [])],
    ...(profile.hostOptions === undefined ? {} : { hostOptions: profile.hostOptions }),
    fakeHost,
  };
}

/** A temporary HOME with the XDG directories under it. */
function temporaryHome(): { home: string; env: { [name: string]: string } } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ari-acp-home-"));
  const env: { [name: string]: string } = { HOME: home };
  for (const [name, sub] of [["XDG_CONFIG_HOME", ".config"], ["XDG_DATA_HOME", ".local/share"], ["XDG_STATE_HOME", ".local/state"], ["XDG_CACHE_HOME", ".cache"]] as const) {
    env[name] = path.join(home, sub);
    fs.mkdirSync(env[name]!, { recursive: true });
  }
  return { home, env };
}

/** Files under `root` whose content contains any of `markers`. */
function filesContaining(root: string, markers: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && markers.some((marker) => fs.readFileSync(full, "utf8").includes(marker))) found.push(full);
    }
  };
  walk(root);
  return found;
}

export function driverRuleTests<Config>(profile: DriverProfile<Config>): void {
  const { kind } = profile;

  test(`${kind}: the 42 optional members are absent, reject with unsupported, or work`, async () => {
    const outcomes = { ...profile.session, ...profile.instance };
    assert.equal(Object.keys(outcomes).length, 42);
    const rig = await openRig(rigOptions(profile));
    try {
      const { session } = await rig.open();
      const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
      for (const name of OPTIONAL_SESSION_MEMBERS) {
        const expected = profile.session[name];
        const value = member(session, name);
        if (expected === "absent") {
          assert.equal(value, undefined, `Session.${name} should be left out`);
          continue;
        }
        assert.equal(typeof value, "function", `Session.${name} should be present`);
        await exerciseSessionMember(session as Session, name, expected, thread.id, rig.otherCwd);
      }
      for (const name of OPTIONAL_INSTANCE_MEMBERS) {
        const expected = profile.instance[name];
        const value = member(rig.instance, name);
        if (expected === "absent") {
          assert.equal(value, undefined, `Instance.${name} should be left out`);
          continue;
        }
        assert.equal(typeof value, "function", `Instance.${name} should be present`);
        assert.ok(profile.exerciseInstance !== undefined, `no exercise for Instance.${name}`);
        await profile.exerciseInstance(rig.instance, name, rig.cwd);
      }
    } finally {
      await rig.cleanup();
    }
  });

  test(`${kind}: importing the driver and its metadata loads no vendor package and spawns nothing`, () => {
    const script = `
      import { registerHooks, syncBuiltinESMExports } from "node:module";
      import childProcess from "node:child_process";
      const resolved = [];
      registerHooks({ resolve(specifier, context, next) { resolved.push(specifier); return next(specifier, context); } });
      const spawned = [];
      for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = (...args) => { spawned.push(name); throw new Error("spawned"); };
      syncBuiltinESMExports();
      await import(${JSON.stringify(path.join(REPO_ROOT, "src", "drivers", kind, "index.ts"))});
      await import(${JSON.stringify(path.join(REPO_ROOT, "src", "meta", `${kind}.ts`))});
      process.stdout.write(JSON.stringify({ resolved, spawned }));
    `;
    // The hooks of node:module are Node's; Bun has none, so the child runs on Node whichever runtime runs this test.
    const result = spawnSync(NODE_EXECUTABLE, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const { resolved, spawned } = JSON.parse(result.stdout) as { resolved: string[]; spawned: string[] };
    assert.deepEqual(spawned, []);
    const bare = resolved.filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:") && !specifier.startsWith("file:"));
    assert.deepEqual(bare, [], "no package outside this one is loaded");
  });

  test(`${kind}: with its agent missing, create() succeeds, status() names what to install, and openSession rejects with driver_unavailable`, async () => {
    const rig = await openRig({ ...rigOptions(profile), config: profile.missing.config, fakeHost: { resolveExecutable: async () => null } });
    try {
      const status = await rig.instance.status();
      assert.equal(status.state, "unavailable");
      assert.equal(status.installed, false);
      assert.equal(status.error?.code, "driver_unavailable");
      const error = status.error as { binary?: string; package?: string };
      if (profile.missing.binary !== undefined) assert.equal(error.binary, profile.missing.binary);
      if (profile.missing.package !== undefined) assert.equal(error.package, profile.missing.package);
      await assert.rejects(rig.instance.openSession({}), (rejection) => isAriError(rejection, "driver_unavailable"));
      assert.equal(rig.host.spawns.length, 0, "nothing was started");
    } finally {
      await rig.cleanup();
    }
  });

  test(`${kind}: with its agent present, status() reports the version found, and an advisory outside the tested ${profile.versions === undefined ? "ACP protocol versions" : "release range"}`, async () => {
    assert.ok((profile.versions === undefined) !== (profile.reportedVersion === undefined), "the profile names a release range or a reported version, not both");
    if (profile.versions === undefined) {
      // A driver that runs any agent is tested against ACP protocol versions; a session that negotiated one of them leaves no advisory.
      assert.equal(profile.meta.testedVersions.range, ACP_TESTED_PROTOCOL_RANGE);
      const rig = await openRig(rigOptions(profile));
      try {
        await rig.open();
        const status = await rig.instance.status();
        assert.equal(status.state, "ready");
        assert.equal(status.version, profile.reportedVersion);
        assert.equal(status.advisory, undefined);
      } finally {
        await rig.cleanup();
      }
      return;
    }
    const { versions } = profile;
    assert.ok(profile.meta.testedVersions.range.startsWith(`>=${versions.minimum} `), "the minimum is the lower bound of the tested range");
    // At the minimum: available, no advisory. Above the tested range: available, with the untested_version advisory.
    for (const [line, version, advised] of [
      [versions.atMinimum, versions.minimum, false],
      [versions.aboveRange, versions.aboveVersion, true],
    ] as const) {
      const rig = await openRig(rigOptions(profile, ["--print-version", line]));
      try {
        const status = await rig.instance.status();
        assert.equal(status.state, "ready", line);
        assert.equal(status.version, version);
        assert.equal(status.error, undefined);
        if (!advised) assert.equal(status.advisory, undefined);
        else {
          assert.equal(status.advisory?.kind, "untested_version");
          assert.equal(status.advisory?.currentVersion, version);
          assert.equal(status.advisory?.testedRange, profile.meta.testedVersions.range);
        }
      } finally {
        await rig.cleanup();
      }
    }
  });

  if (profile.versions !== undefined) {
    const versions = profile.versions;

    test(`${kind}: reads the vendor's real --version output and refuses old CLIs in status and openSession before any agent starts`, async () => {
      const output = fs.readFileSync(path.join(REPO_ROOT, "test", "fixtures", "cli-version-output", versions.realOutput.file), "utf8");
      assert.equal(parseVersion(output), versions.realOutput.version);
      // The fake appends a newline, so remove the one already present in stdout.
      const real = await openRig(rigOptions(profile, ["--print-version", output.replace(/\n$/, "")]));
      try {
        assert.equal((await real.instance.status()).version, versions.realOutput.version);
      } finally {
        await real.cleanup();
      }
      const rig = await openRig(rigOptions(profile, ["--print-version", versions.belowMinimum]));
      try {
        const where = await rig.host.process.resolveExecutable(profile.executable);
        assert.ok(where !== null);
        const status = await rig.instance.status();
        assert.equal(status.state, "unavailable");
        assert.equal(status.installed, true);
        assert.equal(status.version, versions.belowVersion);
        assert.equal(status.advisory, undefined);
        assert.equal(status.error?.code, "driver_unavailable");
        const error = status.error as { message: string; binary?: string; installHint?: string };
        for (const part of [versions.belowVersion, where, versions.minimum, versions.updateStep]) assert.ok(error.message.includes(part), `the message names ${part}: ${error.message}`);
        assert.equal(error.binary, profile.missing.binary);
        assert.equal(error.installHint, versions.updateStep);
        const probe = await rig.instance.probe();
        assert.equal(probe.installed, true);
        assert.equal(probe.version, versions.belowVersion);
        assert.deepEqual(probe.error, status.error);
        await assert.rejects(rig.instance.openSession({}), (rejection) => isAriError(rejection, "driver_unavailable") && rejection.message === error.message);
        assert.ok(rig.host.spawns.length > 0, "the version was asked for");
        assert.deepEqual(
          rig.host.spawns.filter((spawn) => spawn.purpose !== "probe" || spawn.args?.[0] !== "--version"),
          [],
          "nothing but the version command ran: no agent started",
        );
      } finally {
        await rig.cleanup();
      }
    });
  }

  test(`${kind}: an agent that answers an ACP protocol version outside 1 and 2 cannot start a session, and status() gives an advisory that names it`, async () => {
    // A release-range driver's agent prints a version inside its range, so the only advisory can be the protocol's.
    // The fake speaks v1 here: the SDK's v2 agent refuses to answer with any version but 2.
    const rig = await openRig({ ...rigOptions(profile, ["--answer-protocol", "3", ...(profile.versions === undefined ? [] : ["--print-version", profile.versions.atMinimum])]), protocol: 1 });
    try {
      assert.equal((await rig.instance.status()).advisory, undefined, "no session has negotiated yet");
      await assert.rejects(rig.instance.openSession({}), (error) => isAriError(error, "protocol"));
      const status = await rig.instance.status();
      assert.equal(status.state, "ready");
      assert.equal(status.advisory?.kind, "untested_version");
      assert.equal(status.advisory?.currentVersion, "3");
      assert.equal(status.advisory?.testedRange, ACP_TESTED_PROTOCOL_RANGE);
      assert.match(status.advisory?.message ?? "", /protocol version 3/);
    } finally {
      await rig.cleanup();
    }
  });

  for (const systemPrompt of [true, false]) {
    test(`${kind}: on resume, the host's launch instructions reach the agent through the channels the driver lists, for a resumed session and for the fresh one that replaces a missing session (agent ${systemPrompt ? "takes" : "does not take"} a system prompt)`, async () => {
      const rig = await openRig(rigOptions(profile, systemPrompt ? ["--system-prompt"] : []));
      try {
        const first = await rig.open();
        const kept = await first.session.createThread({ cwd: rig.cwd, policy: rig.policy() });
        await first.session.close();
        // The agent has no session `lost` (resource_not_found), so resuming it starts a fresh session.
        const lost = "ari-missing-session";
        const { session, waitFor } = await rig.open({ launch: { appendSystemPrompt: ["ARI_RESUME_SYSTEM"], developerPrompt: ["ARI_RESUME_DEVELOPER"] } });
        const resumed = await session.resumeThread({ native: { handle: kept.handle! }, policy: rig.policy() });
        const replaced = await session.resumeThread({ native: { handle: lost }, policy: rig.policy() });
        assert.equal(resumed.native.id, kept.native.id);
        assert.notEqual(replaced.native.id, lost, "a fresh session replaced the missing one");
        for (const thread of [resumed, replaced]) {
          for (const text of ["Begin.", "Again."]) {
            const started = await session.startTurn({ threadId: thread.id, clientTurnKey: `${thread.id}:${text}`, intent: "start", content: [{ type: "text", text }] });
            assert.equal(started.status, "accepted");
            const native = await rig.nextTurn();
            await native.complete();
            await waitFor((event) => event.body.type === "turn.terminal" && started.status === "accepted" && event.body.turnId === started.turnId, `turn.terminal of "${text}"`);
          }
        }
        const sent = rig.harness.frames.filter((frame) => frame.from === "client").map((frame) => frame.message as { method?: string; params?: { [key: string]: unknown } });
        const reopened = sent.find((message) => (message.method === "session/resume" || message.method === "session/load") && message.params?.["sessionId"] === kept.native.id)!.params!;
        const fresh = sent.filter((message) => message.method === "session/new").at(-1)!.params!;
        for (const [nativeId, opening] of [
          [resumed.native.id, reopened],
          [replaced.native.id, fresh],
        ] as const) {
          const prompts = sent.filter((message) => message.method === "session/prompt" && message.params?.["sessionId"] === nativeId).map((message) => JSON.stringify(message.params?.["prompt"]));
          assert.equal(prompts.length, 2);
          if (systemPrompt) {
            assert.match(JSON.stringify(opening["systemPrompt"]), /ARI_RESUME_SYSTEM/, "system: on the request that opens the session");
            assert.doesNotMatch(prompts[0]!, /ARI_RESUME_SYSTEM/);
          } else {
            assert.equal(opening["systemPrompt"], undefined);
            assert.match(prompts[0]!, /ARI_RESUME_SYSTEM/, "first_user_message: in the first prompt");
          }
          assert.match(prompts[0]!, /ARI_RESUME_DEVELOPER/, "first_user_message: in the first prompt");
          assert.match(prompts[0]!, /Begin\./);
          assert.doesNotMatch(prompts[1]!, /ARI_RESUME_/, "only the first prompt carries the instructions");
        }
      } finally {
        await rig.cleanup();
      }
    });
  }

  test(`${kind}: without launch context or host context, the frames that create a thread and start a turn carry no text the driver wrote`, async () => {
    const rig = await openRig(rigOptions(profile, ["--system-prompt"]));
    try {
      const { session, waitFor } = await rig.open();
      const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy() });
      await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Exactly this." }] });
      const native = await rig.nextTurn();
      assert.equal(native.prompt, "Exactly this.");
      await native.complete();
      await waitFor((event) => event.body.type === "turn.terminal", "turn.terminal");
      const sent = rig.harness.frames.filter((frame) => frame.from === "client").map((frame) => frame.message as { method?: string; params?: { [key: string]: unknown } });
      const created = sent.find((message) => message.method === "session/new")!;
      assert.equal(created.params?.["systemPrompt"], undefined);
      assert.deepEqual(created.params?.["mcpServers"], []);
      assert.deepEqual(sent.find((message) => message.method === "session/prompt")!.params?.["prompt"], [{ type: "text", text: "Exactly this." }]);
    } finally {
      await rig.cleanup();
    }
  });

  for (const systemPrompt of [true, false]) {
    test(`${kind}: host instructions reach the agent through the channels the driver lists (agent ${systemPrompt ? "takes" : "does not take"} a system prompt), and no launch value is written to a file`, async () => {
      const { home, env } = temporaryHome();
      const markers = ["ARI_MARKER_APPEND_SYSTEM", "ARI_MARKER_DEVELOPER", "ARI_MARKER_MCP"];
      const rig = await openRig(rigOptions(profile, systemPrompt ? ["--system-prompt"] : [], { ambientEnvironment: env }));
      try {
        const server = await rig.host.hostTools.mcpServerFor("thread-to-be", { transport: "stdio" });
        const { session, waitFor } = await rig.open({
          launch: { appendSystemPrompt: ["ARI_MARKER_APPEND_SYSTEM"], mcpServers: [{ ...server.config, env: { TOKEN_HINT: "ARI_MARKER_MCP" }, ...(server.alwaysLoad === undefined ? {} : { alwaysLoad: server.alwaysLoad }) }] },
        });
        const channels = session.capabilities().context.instructionChannels;
        assert.deepEqual(channels, systemPrompt ? ["system", "first_user_message"] : ["first_user_message"]);
        const thread = await session.createThread({ cwd: rig.cwd, policy: rig.policy(), context: { developer: "ARI_MARKER_DEVELOPER" } });
        await session.startTurn({ threadId: thread.id, clientTurnKey: "k1", intent: "start", content: [{ type: "text", text: "Begin." }] });
        const native = await rig.nextTurn();
        await native.complete();
        await waitFor((event) => event.body.type === "turn.terminal", "turn.terminal");
        const sent = rig.harness.frames.filter((frame) => frame.from === "client").map((frame) => frame.message as { method?: string; params?: { [key: string]: unknown } });
        const created = sent.find((message) => message.method === "session/new")!.params!;
        const prompt = JSON.stringify(sent.find((message) => message.method === "session/prompt")!.params?.["prompt"]);
        if (systemPrompt) {
          assert.match(JSON.stringify(created["systemPrompt"]), /ARI_MARKER_APPEND_SYSTEM/, "system: on session/new");
          assert.doesNotMatch(prompt, /ARI_MARKER_APPEND_SYSTEM/);
        } else {
          assert.equal(created["systemPrompt"], undefined);
          assert.match(prompt, /ARI_MARKER_APPEND_SYSTEM/, "first_user_message: in the first prompt");
        }
        assert.match(prompt, /ARI_MARKER_DEVELOPER/, "first_user_message: in the first prompt");
        assert.match(prompt, /Begin\./);
        // Host tool servers appear only under the name the host chose.
        const servers = created["mcpServers"] as Array<{ name: string; command?: string }>;
        assert.deepEqual(servers.map((entry) => entry.name), [server.name]);
        assert.equal(servers[0]!.command, server.config.command);
        // Nothing from the launch context was written to a file: not under HOME, nor under the instance's paths.
        assert.deepEqual(filesContaining(home, markers), []);
        assert.deepEqual(filesContaining(rig.host.paths.stateDir, markers), []);
        assert.deepEqual(filesContaining(rig.host.paths.cacheDir, markers), []);
      } finally {
        await rig.cleanup();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test(`${kind}: metadata, config schema, CLI manifest, docs and changelog`, () => {
    const { meta, driver } = profile;
    assert.equal(meta.kind, kind);
    assert.equal(driver.kind, kind);
    assert.ok(meta.label.length > 0);
    assert.ok(IconSchema.is(meta.icon), "the icon is a valid Icon");
    assert.deepEqual(driver.metadata, meta.metadata);
    assert.equal(driver.configSchema, meta.configSchema);
    const properties = Object.keys((meta.configSchema as { properties: object }).properties);
    for (const field of Object.keys(meta.formHints)) assert.ok(properties.includes(field), `form hint ${field} names a config field`);
    const ajv = new Ajv2020({ strict: true });
    const validate = ajv.compile(meta.configSchema as object);
    assert.ok(validate(driver.defaultConfig()), JSON.stringify(validate.errors));
    assert.ok(!validate({ ...(driver.defaultConfig() as object), unknownField: true }), "the schema refuses unknown fields");
    // The declared range is the one status() judges by (the advisory tests above): a release range, or the ACP protocol versions.
    if (profile.versions !== undefined) assert.match(meta.testedVersions.range, /^>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+$/, "a vendor release range");
    else assert.equal(meta.testedVersions.range, ACP_TESTED_PROTOCOL_RANGE, "the ACP protocol versions");
    assert.ok(meta.testedVersions.what.length > 0, "the driver says what was tested");
    if (driver.cliManifest !== undefined) assert.deepEqual(validateCliManifest(driver.cliManifest), driver.cliManifest);
    const docs = fs.readFileSync(path.join(REPO_ROOT, "docs", "drivers", `${kind}.md`), "utf8");
    assert.ok(docs.includes(`ari/drivers/${kind}`) && docs.includes(profile.launch), `docs/drivers/${kind}.md describes the driver and its launch`);
    assert.match(docs, /\| Capability \|/, "the docs hold the capability table");
    const changelog = fs.readFileSync(path.join(REPO_ROOT, "changelogs", `${kind}.md`), "utf8");
    assert.ok(changelog.includes(kind));
  });
}

async function exerciseSessionMember(session: Session, name: string, expected: Outcome, threadId: string, otherCwd: string): Promise<void> {
  switch (name) {
    case "forkThread": {
      if (expected === "unsupported") {
        await assert.rejects(session.forkThread!({ threadId, at: { type: "latest" } }), (error) => isAriError(error, "unsupported"));
        return;
      }
      const fork = await session.forkThread!({ threadId, at: { type: "latest" } });
      assert.notEqual(fork.id, threadId);
      await assert.rejects(session.forkThread!({ threadId, at: { type: "turn", turnId: "turn_x" } }), (error) => isAriError(error, "unsupported"));
      void otherCwd;
      return;
    }
    case "rollbackThread":
      assert.equal(expected, "unsupported");
      await assert.rejects(session.rollbackThread!({ threadId, to: { type: "start" } }), (error) => isAriError(error, "unsupported") && error.callError.code === "unsupported" && error.callError.capability === "threads.rollback");
      return;
    case "ext": {
      const result = (await session.ext!("acp", "_ari/echo", { text: "hello" })) as { echoed: unknown; call: number };
      assert.deepEqual(result.echoed, { text: "hello" }, "the agent's own answer");
      assert.ok(result.call >= 1);
      await assert.rejects(session.ext!("other.ns", "_x", {}), (error) => isAriError(error, "unsupported"));
      return;
    }
    default:
      throw new Error(`no exercise for Session.${name}`);
  }
}
