// The claude driver without an SDK importable by name: it loads the SDK from
// the directory its `sdkDirectory` config field names, where the host
// installed it with npm. ARI installs nothing; a directory without the SDK is
// reported unavailable with the npm command that installs it there.
//
// Wherever the SDK comes from, every query runs the user's own Claude Code:
// here a fake `claude` on the host's PATH (sdk-fixture.ts), or the one
// `executablePath` names, never the decoy native package npm would put
// beside the SDK. A `claude` that is missing, prints no version or is older
// than the version the pinned SDK bundles leaves the driver unavailable with
// an error that names the fix, and starts no Claude Code session; a newer one
// runs with an advisory.
//
// These tests run the driver in this process against a fake SDK (see
// sdk-fixture.ts); test/standalone/claude-sdk.e2e.ts runs the same paths
// through the standalone ari-driver. No test here reaches the network or
// starts a real Claude Code.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import type { AriEvent } from "../../../src/index.ts";
import { createClaudeDriver } from "../../../src/drivers/claude/index.ts";
import type { ClaudeDriverConfig, ClaudeDriverOptions } from "../../../src/drivers/claude/index.ts";
import { isStandaloneExecutableModule } from "../../../src/drivers/claude/sdk.ts";
import { CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION, CLAUDE_TESTED_VERSIONS } from "../../../src/meta/claude.ts";
import { satisfiesVersionRange } from "../../../src/drivers/claude/instance.ts";
import { createCoordination, createNodeHostServices } from "../../../src/node/index.ts";
import type { Instance } from "../../../src/runtime.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { MINIMUM_VERSION_LINE, fakeClaudeInvocations, fakeClaudeSessions, sdkNativePackage, writeFakeClaude, writeFixtureSdkDirectory } from "./sdk-fixture.ts";

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

/** A temp root with `bin/` (the host's whole PATH, empty), `project/` (a thread's cwd) and room for the host's directories. */
function scratch(): { root: string; bin: string; project: string; hostRoot: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-claude-sdk-")));
  temporary.push(root);
  const where = { root, bin: path.join(root, "bin"), project: path.join(root, "project"), hostRoot: path.join(root, "host") };
  fs.mkdirSync(where.bin);
  fs.mkdirSync(where.project);
  return where;
}

/** The user's Claude Code on the host's PATH: a fake at the minimum version, unless `versionLine` says otherwise. */
function userClaude(bin: string, versionLine = MINIMUM_VERSION_LINE, versionExitCode = 0): string {
  return writeFakeClaude(path.join(bin, "claude"), { versionLine, versionExitCode, greeting: "the user's claude on PATH" });
}

/** What the fixture SDK's reply says when the driver ran the Claude Code at `file`, which greets with `greeting`. */
function ranOn(file: string, greeting = "the user's claude on PATH"): string {
  return `from the Claude Code at ${file} (named in pathToClaudeCodeExecutable), which answered: ${greeting}`;
}

/** A Claude instance on real Node host services rooted at `hostRoot`, whose PATH is `bin` alone. */
async function claudeInstance(where: { hostRoot: string; bin: string }, config: ClaudeDriverConfig, options: ClaudeDriverOptions = {}) {
  const host = await createNodeHostServices<ClaudeDriverConfig>({
    hostRoot: where.hostRoot,
    instanceId: "claude-sdk",
    config: { get: async () => ({ config }) },
    attachments: { resolve: async () => null },
    hostTools: {
      mcpServerFor: async () => {
        throw new Error("this host serves no tools");
      },
    },
    callbacks: { register: async (flowId) => ({ url: `http://127.0.0.1:9/${flowId}` }) },
    coordination: createCoordination(),
    writeDiagnostic: () => undefined,
    baseEnv: { PATH: where.bin },
  });
  const instance = await createClaudeDriver(options).create(host, { instanceId: "claude-sdk", config, environment: {} });
  return {
    host,
    instance,
    async dispose() {
      await instance.dispose();
      await host.dispose();
    },
  };
}

/** Runs one turn and resolves with its terminal status and every event's JSON. */
async function oneTurn(instance: Instance, cwd: string): Promise<{ status: string | undefined; events: string }> {
  const session = await instance.openSession({});
  const events: AriEvent[] = [];
  void (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  try {
    const thread = await session.createThread({ cwd, policy: { mode: "approval_required", interaction: "default", cwd } });
    await session.startTurn({ threadId: thread.id, clientTurnKey: "sdk-1", intent: "start", content: [{ type: "text", text: "Say hello" }] });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const terminal = events.find((event) => event.body.type === "turn.terminal");
      if (terminal !== undefined) return { status: terminal.body.type === "turn.terminal" ? terminal.body.status : undefined, events: JSON.stringify(events) };
      if (Date.now() > deadline) throw new Error(`no turn.terminal within 15 s: ${JSON.stringify(events)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await session.close();
  }
}

describe("the claude driver loads its SDK from sdkDirectory and runs the user's Claude Code", () => {
  test("status() reports the fixture's version, and a turn runs the claude on PATH, never the native package npm put beside the SDK", async () => {
    const where = scratch();
    const decoy = writeFixtureSdkDirectory(path.join(where.root, "sdk"), "0.3.330+fixture", "the native package beside the SDK");
    const claude = userClaude(where.bin);
    const { instance, dispose } = await claudeInstance(where, { sdkDirectory: path.join(where.root, "sdk") });
    try {
      const status = await instance.status();
      assert.equal(status.installed, true, JSON.stringify(status));
      assert.equal(status.version, "0.3.330+fixture");
      assert.equal(status.advisory, undefined, "the claude on PATH is the minimum, which is tested");
      const turn = await oneTurn(instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes(`fixture SDK reply 1, ${ranOn(claude)}`), turn.events);
      assert.equal(fakeClaudeSessions(claude).length, 1);
      assert.deepEqual(fakeClaudeInvocations(decoy), [], "the native package beside the SDK never ran");
      // The decoy sits where the pinned SDK would look for its native Claude Code: a platform package its sdk.mjs lists.
      const pinned = JSON.parse(fs.readFileSync(path.join(fs.realpathSync(path.join(REPO_ROOT, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/"))), "package.json"), "utf8")) as { optionalDependencies: { [name: string]: string } };
      assert.equal(pinned.optionalDependencies[sdkNativePackage().pkg], CLAUDE_SDK_VERSION);
    } finally {
      await dispose();
    }
  });

  test("with executablePath set, that Claude Code runs instead of the claude on PATH", async () => {
    const where = scratch();
    const decoy = writeFixtureSdkDirectory(path.join(where.root, "sdk"), CLAUDE_SDK_VERSION, "the native package beside the SDK");
    const onPath = userClaude(where.bin);
    const configured = writeFakeClaude(path.join(where.root, "elsewhere", "claude-nightly"), { versionLine: MINIMUM_VERSION_LINE, greeting: "the configured claude" });
    const { instance, dispose } = await claudeInstance(where, { sdkDirectory: path.join(where.root, "sdk"), executablePath: configured });
    try {
      const turn = await oneTurn(instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes(ranOn(configured, "the configured claude")), turn.events);
      assert.equal(fakeClaudeInvocations(configured)[0], "--version", "the driver checked the configured Claude Code's version before it ran it");
      assert.deepEqual(fakeClaudeInvocations(onPath), []);
      assert.deepEqual(fakeClaudeInvocations(decoy), []);
    } finally {
      await dispose();
    }
  });

  test("a directory without the SDK is reported unavailable naming it and the npm command that installs the SDK there, and openSession refuses", async () => {
    const where = scratch();
    userClaude(where.bin);
    const empty = path.join(where.root, "empty");
    const { instance, dispose } = await claudeInstance(where, { sdkDirectory: empty });
    try {
      const status = await instance.status();
      assert.equal(status.installed, false);
      assert.equal(status.error?.code, "driver_unavailable");
      const message = status.error?.message ?? "";
      assert.ok(message.includes(`sdkDirectory ${empty}`), message);
      assert.match(message, /node_modules\/@anthropic-ai\/claude-agent-sdk\/package\.json cannot be read/);
      assert.ok(message.includes(`npm install --prefix ${empty} ${CLAUDE_SDK_PACKAGE}@${CLAUDE_SDK_VERSION}`), message);
      assert.match(message, /ARI does not install it/);
      assert.doesNotMatch(message, /maintenance\./);
      await assert.rejects(instance.openSession({}), (error: { callError?: { code: string; message: string } }) => error.callError?.code === "driver_unavailable" && error.callError.message === message);
    } finally {
      await dispose();
    }
  });
});

describe("the user's Claude Code decides whether the claude driver is available with sdkDirectory", () => {
  /** An instance whose SDK comes from sdkDirectory, with the decoy native package beside the SDK and `bin` its host's PATH. */
  async function prepared(where: ReturnType<typeof scratch>) {
    const decoy = writeFixtureSdkDirectory(path.join(where.root, "sdk"), CLAUDE_SDK_VERSION, "the native package beside the SDK");
    return { ...(await claudeInstance(where, { sdkDirectory: path.join(where.root, "sdk") }, { loadSdk: async () => Promise.reject(new Error("not by name")) })), decoy };
  }

  /** status() is driver_unavailable, openSession rejects with the same error, and no Claude Code session started. */
  async function refused(instance: Instance, claude: string | undefined, decoy: string): Promise<{ message: string; binary: string | undefined }> {
    const status = await instance.status();
    assert.equal(status.state, "unavailable", JSON.stringify(status));
    assert.equal(status.installed, false);
    assert.equal(status.error?.code, "driver_unavailable");
    await assert.rejects(instance.openSession({}), (error: { callError?: { code: string; message: string } }) => {
      assert.deepEqual({ code: error.callError?.code, message: error.callError?.message }, { code: status.error?.code, message: status.error?.message });
      return true;
    });
    if (claude !== undefined) {
      assert.deepEqual(fakeClaudeSessions(claude), [], "no Claude Code session started");
      assert.ok(fakeClaudeInvocations(claude).every((line) => line === "--version"), fakeClaudeInvocations(claude).join("\n"));
    }
    assert.deepEqual(fakeClaudeInvocations(decoy), [], "the native package beside the SDK never ran");
    return { message: status.error!.message, binary: (status.error as { binary?: string }).binary };
  }

  test("after claude update replaces a too old claude, the next status() reports the driver ready, without a restart", async () => {
    const where = scratch();
    const claude = userClaude(where.bin, "2.1.319 (Claude Code)");
    const { instance, dispose } = await prepared(where);
    try {
      assert.equal((await instance.status()).error?.code, "driver_unavailable");
      // As `claude update` leaves it: a new file at the same path.
      fs.rmSync(claude);
      userClaude(where.bin, "2.1.330 (Claude Code)");
      const status = await instance.status();
      assert.equal(status.state, "ready", JSON.stringify(status));
      assert.equal((await oneTurn(instance, where.project)).status, "completed");
    } finally {
      await dispose();
    }
  });

  test("a claude older than the minimum is driver_unavailable naming its version, its path, the minimum and how to update", async () => {
    const where = scratch();
    const claude = userClaude(where.bin, "2.1.329 (Claude Code)");
    const { instance, dispose, decoy } = await prepared(where);
    try {
      const { message, binary } = await refused(instance, claude, decoy);
      assert.equal(binary, claude);
      assert.ok(message.startsWith(`Claude Code 2.1.329 at ${claude} is older than 2.1.330, the oldest version this driver runs`), message);
      assert.match(message, /Update Claude Code to 2\.1\.330 or newer \(run claude update,/);
      assert.match(message, /set executablePath in the driver config/);
    } finally {
      await dispose();
    }
  });

  test("no claude at all is driver_unavailable saying Claude Code is not installed, how to install it, and executablePath", async () => {
    const where = scratch();
    const { instance, dispose, decoy } = await prepared(where);
    try {
      const { message, binary } = await refused(instance, undefined, decoy);
      assert.equal(binary, "claude");
      assert.ok(message.startsWith("Claude Code is not installed: no claude executable was found on PATH."), message);
      assert.match(message, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
      assert.match(message, /set executablePath in the driver config/);
    } finally {
      await dispose();
    }
  });

  test("a claude whose version cannot be read is driver_unavailable naming its path and what it printed", async () => {
    const where = scratch();
    const claude = userClaude(where.bin, "claude: error while loading shared libraries: libnode.so.115", 127);
    const { instance, dispose, decoy } = await prepared(where);
    try {
      const { message, binary } = await refused(instance, claude, decoy);
      assert.equal(binary, claude);
      assert.ok(
        message.startsWith(`The version of the Claude Code at ${claude} cannot be read: ${claude} --version exited with code 127 and printed "claude: error while loading shared libraries: libnode.so.115".`),
        message,
      );
      assert.match(message, /set executablePath in the driver config/);
    } finally {
      await dispose();
    }
  });

  test("a claude newer than the minimum is available with an untested_version advisory, and runs", async () => {
    const where = scratch();
    const claude = userClaude(where.bin, "2.1.400 (Claude Code)");
    const { instance, dispose, decoy } = await prepared(where);
    try {
      const status = await instance.status();
      assert.equal(status.state, "ready", JSON.stringify(status));
      assert.equal(status.installed, true);
      assert.deepEqual(status.advisory, {
        kind: "untested_version",
        message: `Claude Code 2.1.400 at ${claude} is newer than 2.1.330, the version this driver is tested against: it runs, but this version is untested.`,
        currentVersion: "2.1.400",
        testedRange: "2.1.330",
      });
      assert.deepEqual(await instance.maintenance!.advisory(), status.advisory);
      const turn = await oneTurn(instance, where.project);
      assert.equal(turn.status, "completed", turn.events);
      assert.ok(turn.events.includes(ranOn(claude)), turn.events);
      assert.deepEqual(fakeClaudeInvocations(decoy), []);
    } finally {
      await dispose();
    }
  });
});

describe("the pinned SDK and the standalone executable", () => {
  const sdkRoot = fs.realpathSync(path.join(REPO_ROOT, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/")));
  const pinned = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8")) as { version: string };

  test("the pinned version is the SDK devDependency, inside the tested range", () => {
    const repository = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { devDependencies: { [name: string]: string } };
    assert.equal(CLAUDE_SDK_VERSION, repository.devDependencies[CLAUDE_SDK_PACKAGE]);
    assert.equal(CLAUDE_SDK_VERSION, pinned.version);
    assert.equal(satisfiesVersionRange(CLAUDE_SDK_VERSION, CLAUDE_TESTED_VERSIONS), true);
  });

  test("the standalone executable is recognized by its modules' URLs, on every release platform", () => {
    assert.equal(isStandaloneExecutableModule("file:///$bunfs/root/ari-driver"), true);
    assert.equal(isStandaloneExecutableModule("file:///B:/~BUN/root/ari-driver.exe"), true);
    assert.equal(isStandaloneExecutableModule("file:///b:/~BUN/root/ari-driver.exe"), true);
    assert.equal(isStandaloneExecutableModule(import.meta.url), false);
    assert.equal(isStandaloneExecutableModule("file:///home/me/project/node_modules/ari/dist/drivers/claude/sdk.js"), false);
    assert.equal(isStandaloneExecutableModule("file:///C:/Users/me/ari/dist/drivers/claude/sdk.js"), false);
  });
});
