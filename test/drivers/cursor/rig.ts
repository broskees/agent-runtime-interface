// A Cursor instance and session wired to a fake Cursor (fake-sdk.ts), for the
// driver's own tests outside the conformance kit. The fake host records every
// host-service call; the fake world records every SDK call.

import "./setup-env.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFakeHost } from "../../../src/conformance/index.ts";
import type { FakeHost, FakeHostOptions } from "../../../src/conformance/index.ts";
import { createCursorDriver } from "../../../src/drivers/cursor/index.ts";
import type { CursorConfig } from "../../../src/drivers/cursor/index.ts";
import type { AriEvent, Driver, Instance, OpenSessionInput, Session, TurnTerminalBody } from "../../../src/index.ts";
import { instanceDirectories } from "../../helpers/conformance.ts";
import { FakeCursorWorld } from "./fake-sdk.ts";
import type { FakeAmbientAuth, FakeRun } from "./fake-sdk.ts";
import { FAKE_SDK_VERSION, MANAGED_KEY } from "./harness.ts";

export interface CursorTestRig {
  readonly world: FakeCursorWorld;
  readonly driver: Driver<CursorConfig>;
  readonly host: FakeHost<CursorConfig>;
  readonly instance: Instance;
  readonly root: string;
  /** A real workspace directory, by its real path. */
  readonly cwd: string;
  /** The same directory through a symbolic link. */
  readonly linkedCwd: string;
  /** Opens a session and records its events. */
  open(input?: OpenSessionInput): Promise<{ session: Session; events: AriEvent[] }>;
  nextRun(): Promise<FakeRun>;
  until<T>(events: readonly AriEvent[], find: (event: AriEvent) => T | undefined, what: string): Promise<T>;
  terminal(events: readonly AriEvent[], turnId: string): Promise<TurnTerminalBody>;
  /** Starts a turn and returns its id and the fake run behind it. */
  turn(session: Session, threadId: string, text: string, extra?: Partial<Parameters<Session["startTurn"]>[0]>): Promise<{ turnId: string; run: FakeRun }>;
  close(): Promise<void>;
}

export interface CursorTestRigOptions {
  readonly config?: Partial<CursorConfig>;
  readonly host?: Partial<FakeHostOptions<CursorConfig>>;
  readonly managedProfile?: boolean;
  readonly ambientAuth?: FakeAmbientAuth;
  /** False: the SDK has no stored sign-in. */
  readonly signedIn?: boolean;
  readonly version?: string;
  /** The instance's `environment` (CreateInstanceRequest). */
  readonly environment?: { [name: string]: string };
  /** Reuse another rig's directory and fake Cursor, as a second instance or a restarted host would. */
  readonly share?: { readonly root: string; readonly world: FakeCursorWorld; readonly instanceId?: string };
}

let rigCount = 0;

export async function openCursorRig(options: CursorTestRigOptions = {}): Promise<CursorTestRig> {
  rigCount += 1;
  const root = options.share?.root ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-cursor-rig-")));
  const cwd = path.join(root, "project");
  const linkedCwd = path.join(root, "link-to-project");
  if (!fs.existsSync(cwd)) {
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "README.md"), "# Project\n");
    fs.symlinkSync(cwd, linkedCwd, "dir");
  }
  const world = options.share?.world ?? new FakeCursorWorld({ root: path.join(root, "cursor"), ambientAuth: options.ambientAuth ?? "authenticated", acceptedKeys: [MANAGED_KEY] });
  if (options.share === undefined) await world.storeSignIn(options.signedIn ?? true);
  const driver = createCursorDriver({ loadSdk: async () => ({ sdk: world.module, version: options.version ?? FAKE_SDK_VERSION }) });
  const instanceId = options.share?.instanceId ?? "cursor-test";
  const config: CursorConfig = { ...driver.defaultConfig(), ...options.config };
  const host = createFakeHost<CursorConfig>({
    config,
    paths: instanceDirectories(root, instanceId),
    secrets: options.managedProfile === true ? [{ namespace: "cursor", key: "api-key", value: MANAGED_KEY }] : [],
    label: `cursor-test-${rigCount}`,
    ...options.host,
  });
  const instance = await driver.create(host, { instanceId, config, environment: options.environment ?? {} });
  const sessions: Session[] = [];
  const until = async <T>(events: readonly AriEvent[], find: (event: AriEvent) => T | undefined, what: string): Promise<T> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      for (const event of events) {
        const found = find(event);
        if (found !== undefined) return found;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  return {
    world,
    driver,
    host,
    instance,
    root,
    cwd,
    linkedCwd,
    async open(input = {}) {
      const session = await instance.openSession(input);
      sessions.push(session);
      const events: AriEvent[] = [];
      void (async () => {
        for await (const event of session.events()) events.push(event);
      })();
      return { session, events };
    },
    nextRun: () => world.nextRun(),
    until,
    terminal: (events, turnId) => until(events, (event) => (event.body.type === "turn.terminal" && event.body.turnId === turnId ? event.body : undefined), `turn.terminal of ${turnId}`),
    async turn(session, threadId, text, extra = {}) {
      const started = await session.startTurn({ threadId, clientTurnKey: `key-${text}-${Math.random()}`, intent: "start", content: [{ type: "text", text }], ...extra });
      if (started.status !== "accepted") throw new Error(`startTurn returned ${JSON.stringify(started)}`);
      return { turnId: started.turnId, run: await world.nextRun() };
    },
    async close() {
      for (const session of sessions) await session.close().catch(() => undefined);
      await instance.dispose();
      if (options.share === undefined) {
        world.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

/** A policy for `cwd` in a mode. */
export function policy(cwd: string, mode: "read_only" | "full_access" | "approval_required" = "full_access", interaction: "default" | "plan" = "default") {
  return { mode, interaction, cwd };
}
