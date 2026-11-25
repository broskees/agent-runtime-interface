// One Claude scenario through a fresh ARI Claude driver, the same way for a
// recording and for its replay: the same temp workspace layout, the same
// environment for Claude Code, the same driver config and the same fixed id
// sequence. Only the SDK module differs: the tapped real (or fake) SDK when
// recording, the replay SDK when replaying.
//
// The workspace (one temp directory per scenario) holds:
//   cwd/            the thread's working directory
//   claude-home/    HOME for Claude Code, empty (not "home/": a path
//                   under it would read <WORKSPACE>/home/..., which the
//                   scan takes for a path starting /home/)
//   claude-config/  CLAUDE_CONFIG_DIR for Claude Code: settings, transcripts,
//                   plugins and its global config file all live here, so
//                   the user's own ~/.claude and ~/.claude.json are never read
//   instances/      the host's directories for the driver instance
//
// Claude Code also runs with settingSources [] (no user, project or local
// settings, and so no CLAUDE.md, hooks, agents or skills from files), auto
// memory off, claude.ai MCP connectors off and nonessential traffic off.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFakeHost } from "../../../src/conformance/fake-host.ts";
import type { DiagnosticEntry } from "../../../src/generated/host.ts";
import { createClaudeDriver } from "../../../src/drivers/claude/index.ts";
import type { ClaudeDriverConfig } from "../../../src/drivers/claude/index.ts";
import type { HostServices, Session } from "../../../src/runtime.ts";
import { runScenario } from "../scenarios.ts";
import type { NativeProgress, Scenario, ScenarioRun } from "../scenarios.ts";
import { fixedUuids } from "./frames.ts";
import type { ClaudeRuntime } from "./frames.ts";

/** Claude Code's cheapest model alias, the recorder's default. */
export const DEFAULT_RECORD_MODEL = "haiku";

export const CLAUDE_RECORDER_INSTANCE_ID = "claude-recorder";

export interface ClaudeLayout {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly configDir: string;
}

/** A fresh temp workspace, by its real path. */
export function createClaudeLayout(prefix: string): ClaudeLayout {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const layout = { root, cwd: path.join(root, "cwd"), home: path.join(root, "claude-home"), configDir: path.join(root, "claude-config") };
  for (const directory of [layout.cwd, layout.home, layout.configDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return layout;
}

/** The environment the driver instance hands Claude Code: nothing of the user's but PATH. */
export function claudeInstanceEnvironment(layout: ClaudeLayout, source: { readonly [name: string]: string | undefined }): { [name: string]: string } {
  return {
    PATH: source["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: layout.home,
    CLAUDE_CONFIG_DIR: layout.configDir,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  };
}

/** The driver config every recording and replay uses: the model, and no settings files. */
export function claudeRecorderConfig(model: string): ClaudeDriverConfig {
  return { model, settingSources: [] };
}

export interface ClaudeScenarioInput {
  readonly scenario: Scenario;
  readonly runtime: ClaudeRuntime;
  readonly layout: ClaudeLayout;
  /** The recorder's (or the replay's) own environment; only PATH reaches Claude Code. */
  readonly sourceEnv: { readonly [name: string]: string | undefined };
  readonly model: string;
  /** An Anthropic API key the instance keeps as its own (a managed profile). */
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly native?: NativeProgress;
  /** Wraps each session the host opens; tests use it to play a host that behaves differently. */
  readonly wrapSession?: (session: Session) => Session;
}

export interface ClaudeScenarioResult {
  readonly run: ScenarioRun;
  /** What the driver logged to the host's diagnostics, among it each stderr line from Claude Code. */
  readonly diagnostics: readonly DiagnosticEntry[];
}

/** A host with no tool server for threads: the recorded session gets no MCP server at all. */
function recorderHost(layout: ClaudeLayout, apiKey: string | undefined, envScrubPrefixes: readonly string[]): HostServices<ClaudeDriverConfig> & { readonly diagnosticEntries: readonly DiagnosticEntry[] } {
  const base = path.join(layout.root, "instances", CLAUDE_RECORDER_INSTANCE_ID);
  const paths = { stateDir: path.join(base, "state"), cacheDir: path.join(base, "cache"), tmpDir: path.join(base, "tmp") };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const host = createFakeHost<ClaudeDriverConfig>({
    paths,
    envScrubPrefixes,
    ...(apiKey === undefined ? {} : { secrets: [{ namespace: "claude", key: "api-key", value: apiKey }] }),
  });
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

/** Plays `scenario` through a fresh driver over `runtime`. */
export async function runClaudeScenario(input: ClaudeScenarioInput): Promise<ClaudeScenarioResult> {
  const driver = createClaudeDriver({ loadSdk: async () => input.runtime, newUuid: fixedUuids() });
  const host = recorderHost(input.layout, input.apiKey, driver.cliManifest?.envScrubPrefixes ?? []);
  const instance = await driver.create(host, {
    instanceId: CLAUDE_RECORDER_INSTANCE_ID,
    config: claudeRecorderConfig(input.model),
    environment: claudeInstanceEnvironment(input.layout, input.sourceEnv),
  });
  try {
    const run = await runScenario(input.scenario, {
      openSession: async () => {
        const session = await instance.openSession({});
        return input.wrapSession === undefined ? session : input.wrapSession(session);
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
