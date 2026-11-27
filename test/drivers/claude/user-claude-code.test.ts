// The user's own Claude Code decides whether the claude driver is
// available. The SDK here is a fake on disk (sdk-fixture.ts), which the
// driver's loader imports by file URL, with the decoy native package npm
// would put beside it. Every query runs the user's Claude Code: a fake
// `claude` on the host's PATH, never the decoy. A `claude` that is missing,
// prints no version or is older than the version the pinned SDK bundles
// leaves the driver unavailable with an error that names the fix, and starts
// no Claude Code session; a newer one runs with an advisory; a `claude
// update` shows at the next status() without a restart.
//
// npm-sdk.test.ts runs the same cases with the SDK imported by name, and
// test/standalone/claude-sdk.e2e.ts through the standalone ari-driver with
// the real SDK compiled in. No test here reaches the network or starts a
// real Claude Code.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { AriEvent } from "../../../src/index.ts";
import { createClaudeDriver } from "../../../src/drivers/claude/index.ts";
import type { ClaudeDriverConfig, ClaudeDriverOptions } from "../../../src/drivers/claude/index.ts";
import type { ClaudeSdk } from "../../../src/drivers/claude/sdk.ts";
import { CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION, CLAUDE_TESTED_CLAUDE_CODE_VERSION, CLAUDE_TESTED_VERSIONS } from "../../../src/meta/claude.ts";
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

describe("the user's Claude Code decides whether the claude driver is available", () => {
  /** An instance whose loader imports the fake SDK from an npm layout under `where.root`, with the decoy native package beside it, and `bin` its host's PATH. */
  async function prepared(where: ReturnType<typeof scratch>) {
    const decoy = writeFixtureSdkDirectory(path.join(where.root, "sdk"), CLAUDE_SDK_VERSION, "the native package beside the SDK");
    const entry = path.join(where.root, "sdk", "node_modules", ...CLAUDE_SDK_PACKAGE.split("/"), "sdk.mjs");
    const loadSdk = async () => ({ sdk: (await import(pathToFileURL(entry).href)) as ClaudeSdk, version: CLAUDE_SDK_VERSION, claudeCodeVersion: CLAUDE_TESTED_CLAUDE_CODE_VERSION });
    return { ...(await claudeInstance(where, {}, { loadSdk })), decoy };
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

describe("the pinned SDK", () => {
  const sdkRoot = fs.realpathSync(path.join(REPO_ROOT, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/")));
  const pinned = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8")) as { version: string; optionalDependencies: { [name: string]: string } };

  test("the pinned version is the SDK devDependency, inside the tested range", () => {
    const repository = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { devDependencies: { [name: string]: string } };
    assert.equal(CLAUDE_SDK_VERSION, repository.devDependencies[CLAUDE_SDK_PACKAGE]);
    assert.equal(CLAUDE_SDK_VERSION, pinned.version);
    assert.equal(satisfiesVersionRange(CLAUDE_SDK_VERSION, CLAUDE_TESTED_VERSIONS), true);
  });

  test("the decoy sits where the pinned SDK would look for its native Claude Code: a platform package its package.json lists", () => {
    assert.equal(pinned.optionalDependencies[sdkNativePackage().pkg], CLAUDE_SDK_VERSION);
  });
});
