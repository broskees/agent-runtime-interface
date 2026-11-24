// One OpenCode scenario through a fresh ARI OpenCode driver in external-server
// mode, the same way for a recording and for its replay: the same temp
// workspace layout, the same driver config and the same host. Only the server
// behind `serverUrl` differs: the recording proxy in front of `opencode serve`
// (or the fake) when recording, the replay server when replaying.
//
// The workspace (one temp directory per scenario) holds:
//   cwd/              the thread's working directory, and the server's
//   opencode-home/    HOME for `opencode serve`, empty (not "home/": a path
//                     under it would read <WORKSPACE>/home/..., which the scan
//                     takes for a path starting /home/)
//   xdg-config/, xdg-data/, xdg-state/, xdg-cache/
//                     XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME and
//                     XDG_CACHE_HOME for `opencode serve`: its config, its
//                     database (sessions and sign-ins), its state and caches
//   instances/        the host's directories for the driver instance
//
// Before it opens a second session (the resume scenario), the host waits until
// the server has seen the first session's event stream close. The driver closes
// that stream when the session closes and opens the next one at once, on
// another connection, so without the wait the server could see the new
// session's first request before the old stream's close, and a replay could
// see them the other way round.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFakeHost } from "../../../src/conformance/fake-host.ts";
import type { DiagnosticEntry } from "../../../src/generated/host.ts";
import { SERVER_PASSWORD_SECRET, createOpencodeDriver } from "../../../src/drivers/opencode/index.ts";
import type { OpencodeConfig } from "../../../src/drivers/opencode/index.ts";
import type { HostServices } from "../../../src/runtime.ts";
import { runScenario } from "../scenarios.ts";
import type { NativeProgress, Scenario, ScenarioRun } from "../scenarios.ts";

export const OPENCODE_RECORDER_INSTANCE_ID = "opencode-recorder";

/** How long the host waits for the server to see a closed session's event stream close. */
export const STREAM_CLOSE_WAIT_MS = 5_000;

export interface OpencodeLayout {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly configHome: string;
  readonly dataHome: string;
  readonly stateHome: string;
  readonly cacheHome: string;
}

/** A fresh temp workspace, by its real path. */
export function createOpencodeLayout(prefix: string): OpencodeLayout {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const layout: OpencodeLayout = {
    root,
    cwd: path.join(root, "cwd"),
    home: path.join(root, "opencode-home"),
    configHome: path.join(root, "xdg-config"),
    dataHome: path.join(root, "xdg-data"),
    stateHome: path.join(root, "xdg-state"),
    cacheHome: path.join(root, "xdg-cache"),
  };
  for (const directory of [layout.cwd, layout.home, layout.configHome, layout.dataHome, layout.stateHome, layout.cacheHome]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return layout;
}

/** The driver config every recording and replay uses: the server behind `serverUrl`, and the model. */
export function opencodeRecorderConfig(serverUrl: string, model: string): OpencodeConfig {
  return { binary: "opencode", serverUrl, model };
}

/** The server's side of a run: where the driver reaches it, and when the driver's event streams are closed. */
export interface OpencodeTransport {
  readonly url: string;
  whenStreamsClosed(timeoutMs: number): Promise<boolean>;
}

export interface OpencodeScenarioInput {
  readonly scenario: Scenario;
  readonly layout: OpencodeLayout;
  readonly transport: OpencodeTransport;
  /** The server password, the instance secret `opencode/server-password`. */
  readonly password: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly native?: NativeProgress;
}

export interface OpencodeScenarioResult {
  readonly run: ScenarioRun;
  /** What the driver logged to the host's diagnostics. */
  readonly diagnostics: readonly DiagnosticEntry[];
}

/** A host with no tool server for threads: the recorded session gets no MCP server at all. */
function recorderHost(layout: OpencodeLayout, password: string, envScrubPrefixes: readonly string[]): HostServices<OpencodeConfig> & { readonly diagnosticEntries: readonly DiagnosticEntry[] } {
  const base = path.join(layout.root, "instances", OPENCODE_RECORDER_INSTANCE_ID);
  const paths = { stateDir: path.join(base, "state"), cacheDir: path.join(base, "cache"), tmpDir: path.join(base, "tmp") };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const host = createFakeHost<OpencodeConfig>({ paths, envScrubPrefixes, secrets: [{ ...SERVER_PASSWORD_SECRET, value: password }] });
  return {
    ...host,
    hostTools: {
      ...host.hostTools,
      mcpServerFor: async () => {
        throw new Error("the recorder gives the session no tool server");
      },
    },
  };
}

/** Plays `scenario` through a fresh driver against the server behind `transport`. */
export async function runOpencodeScenario(input: OpencodeScenarioInput): Promise<OpencodeScenarioResult> {
  const driver = createOpencodeDriver();
  const host = recorderHost(input.layout, input.password, driver.cliManifest?.envScrubPrefixes ?? []);
  const instance = await driver.create(host, { instanceId: OPENCODE_RECORDER_INSTANCE_ID, config: opencodeRecorderConfig(input.transport.url, input.model), environment: {} });
  try {
    const run = await runScenario(input.scenario, {
      openSession: async () => {
        await input.transport.whenStreamsClosed(STREAM_CLOSE_WAIT_MS);
        return instance.openSession({});
      },
      cwd: input.layout.cwd,
      timeoutMs: input.timeoutMs,
      ...(input.native === undefined ? {} : { native: input.native }),
    });
    return { run, diagnostics: host.diagnosticEntries };
  } finally {
    await instance.dispose();
  }
}
