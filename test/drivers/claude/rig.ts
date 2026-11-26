// A Claude driver on a fake host and the fake SDK, for tests outside the
// conformance kit. It collects the session's events and waits on them.

import * as fs from "node:fs";
import type { FakeHost, FakeHostOptions } from "../../../src/conformance/fake-host.ts";
import { createFakeHost } from "../../../src/conformance/fake-host.ts";
import type { AriEvent } from "../../../src/generated/events.ts";
import type { OpenSessionInput } from "../../../src/generated/instance.ts";
import type { AppliedThread, CreateThreadInput, StartTurnInput } from "../../../src/generated/session.ts";
import type { RuntimePolicy } from "../../../src/generated/config.ts";
import { createClaudeDriver } from "../../../src/drivers/claude/index.ts";
import type { ClaudeDriverConfig, ClaudeSdkLoader } from "../../../src/drivers/claude/index.ts";
import type { Driver, Instance, Session } from "../../../src/runtime.ts";
import { createConformanceWorkspace, instanceDirectories } from "../../helpers/conformance.ts";
import { FakeClaudeWorld } from "./fake-sdk.ts";
import type { FakeAmbientAuth, FakeTurn } from "./fake-sdk.ts";
import { FAKE_CLAUDE_BINARY, FAKE_SDK_VERSION, fakeClaudeSpawn } from "./harness.ts";

export interface ClaudeRigOptions {
  readonly ambientAuth?: FakeAmbientAuth;
  readonly managedKey?: string;
  readonly config?: ClaudeDriverConfig;
  readonly open?: OpenSessionInput;
  readonly environment?: { [name: string]: string };
  readonly host?: Partial<FakeHostOptions<ClaudeDriverConfig>>;
  readonly writeTranscripts?: boolean;
  /** Overrides what the loader reports (for example another SDK version). */
  readonly runtime?: { version?: string };
  /** What the fake `claude --version` prints; the Claude Code the pinned SDK bundles when left out. */
  readonly claudeVersionLine?: string;
  readonly loadSdk?: ClaudeSdkLoader;
}

/** Collects a session's events as they come. */
export class EventLog {
  readonly events: AriEvent[] = [];
  readonly #done: Promise<void>;
  constructor(session: Session) {
    this.#done = (async () => {
      for await (const event of session.events()) this.events.push(event);
    })();
  }
  find(predicate: (event: AriEvent) => boolean): AriEvent | undefined {
    return this.events.find(predicate);
  }
  filter(predicate: (event: AriEvent) => boolean): AriEvent[] {
    return this.events.filter(predicate);
  }
  ended(): Promise<void> {
    return this.#done;
  }
}

/** Polls until `check` returns a value, or fails after `timeoutMs`. */
export async function until<T>(check: () => T | undefined | false, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export interface ClaudeRig {
  readonly world: FakeClaudeWorld;
  readonly driver: Driver<ClaudeDriverConfig>;
  readonly host: FakeHost<ClaudeDriverConfig>;
  readonly instance: Instance;
  readonly session: Session;
  readonly log: EventLog;
  readonly cwd: string;
  readonly otherCwd: string;
  readonly root: string;
  policy(mode?: RuntimePolicy["mode"]): RuntimePolicy;
  thread(input?: Partial<CreateThreadInput>): Promise<AppliedThread>;
  /** Starts a turn and returns its id with the fake's native turn. */
  turn(threadId: string, text: string, extra?: Partial<StartTurnInput>): Promise<{ turnId: string; native: FakeTurn }>;
  /** Waits for a turn's terminal event. */
  terminal(turnId: string): Promise<Extract<AriEvent["body"], { type: "turn.terminal" }>>;
  /** Runs a turn that says `reply` and completes. */
  simpleTurn(threadId: string, text: string, reply?: string): Promise<string>;
  /** Opens another session on the same instance. */
  openAnother(input?: OpenSessionInput): Promise<{ session: Session; log: EventLog }>;
  cleanup(): Promise<void>;
}

let keys = 0;

export async function openClaudeRig(options: ClaudeRigOptions = {}): Promise<ClaudeRig> {
  const { workspace, root, cleanup } = createConformanceWorkspace("ari-claude-test-");
  const world = new FakeClaudeWorld({ ambientAuth: options.ambientAuth ?? "authenticated", writeTranscripts: options.writeTranscripts === true });
  const driver = createClaudeDriver({
    loadSdk:
      options.loadSdk ??
      (async () => ({
        sdk: world.sdk,
        version: options.runtime?.version ?? FAKE_SDK_VERSION,
        claudeCodeVersion: "2.1.330",
      })),
    newUuid: () => world.newUuid(),
  });
  const host = createFakeHost<ClaudeDriverConfig>({
    paths: instanceDirectories(root, "claude-test"),
    spawn: fakeClaudeSpawn(world, options.claudeVersionLine),
    resolveExecutable: async (name) => (name === "claude" ? FAKE_CLAUDE_BINARY : null),
    envScrubPrefixes: driver.cliManifest?.envScrubPrefixes ?? [],
    ...(options.managedKey === undefined ? {} : { secrets: [{ namespace: "claude", key: "api-key", value: options.managedKey }] }),
    ...options.host,
  });
  const instance = await driver.create(host, { instanceId: "claude-test", config: options.config ?? {}, environment: options.environment ?? { PATH: "/usr/bin:/bin" } });
  const session = await instance.openSession(options.open ?? {});
  const log = new EventLog(session);
  const opened: Session[] = [session];
  const cwd = workspace.cwd;
  const policy = (mode: RuntimePolicy["mode"] = "approval_required"): RuntimePolicy => ({ mode, interaction: "default", cwd });
  const terminal = async (turnId: string) => {
    const event = await until(() => log.find((candidate) => candidate.body.type === "turn.terminal" && candidate.body.turnId === turnId), `turn.terminal for ${turnId}`);
    return event.body as Extract<AriEvent["body"], { type: "turn.terminal" }>;
  };
  const rig: ClaudeRig = {
    world,
    driver,
    host,
    instance,
    session,
    log,
    cwd,
    otherCwd: workspace.otherCwd!,
    root,
    policy,
    thread: (input = {}) => session.createThread({ cwd, policy: policy(), ...input }),
    async turn(threadId, text, extra = {}) {
      keys += 1;
      const started = await session.startTurn({ threadId, clientTurnKey: `rig-${keys}`, intent: "start", content: [{ type: "text", text }], ...extra });
      if (started.status !== "accepted") throw new Error(`startTurn answered ${JSON.stringify(started)}`);
      const native = await world.nextTurn();
      return { turnId: started.turnId, native };
    },
    terminal,
    async simpleTurn(threadId, text, reply = "Done.") {
      const { turnId, native } = await rig.turn(threadId, text);
      await native.say(reply);
      await native.complete();
      await terminal(turnId);
      return turnId;
    },
    async openAnother(input = {}) {
      const another = await instance.openSession(input);
      opened.push(another);
      return { session: another, log: new EventLog(another) };
    },
    async cleanup() {
      for (const each of opened) await each.close();
      await instance.dispose();
      cleanup();
      if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return rig;
}
