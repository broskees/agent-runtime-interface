// One Codex scenario through a fresh ARI Codex driver, the same way for a
// recording and for its replay: the same temp workspace layout, the same
// driver config (the recorded model among it), the same host. Only the
// process service differs: the tapped real one (starting `codex`, or a fake
// `codex` in tests) when recording, the replay process service when
// replaying.
//
// The workspace (one temp directory per scenario) holds:
//   cwd/            the thread's working directory, the root of its own Git
//                   repository (`cwd/.git`): Codex reads AGENTS.md,
//                   AGENTS.override.md, `.codex/` and `.agents/skills` in the
//                   folder it works in and each parent folder up to the
//                   project root, the nearest folder holding `.git`, and stops
//                   there (codex-rs/core/src/agents_md.rs:7–18), so it reads
//                   none of the workspace's parents
//   codex-home/     CODEX_HOME for `codex`: the recorder's `config.toml`
//                   (CODEX_RECORDER_CONFIG, ./credentials.ts) and the copy
//                   of the user's sign-in, `auth.json`; Codex keeps its
//                   config, plugins, memories, skills, rules, sessions and
//                   state database (thread goals) here, so none of the
//                   user's reach it
//   user-home/      HOME for `codex`, empty (not "home/": a path under it would
//                   read <WORKSPACE>/home/..., which the scan takes for a path
//                   starting /home/); Codex reads `~/.agents/skills` from it
//   xdg-config/, xdg-data/, xdg-state/, xdg-cache/, xdg-runtime/
//                   the XDG base directories for `codex`
//   tmp/            TMPDIR for `codex`
//   instances/      the host's directories for the driver instance
//
// The model: the driver starts every thread with the model of its config
// (`thread/start`'s `model`), and Codex resumes a thread with the model it
// ran with (app-server thread_processor.rs:305–334), so the recorder puts the
// model it chose in the driver config, and a replay the header's.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFakeHost } from "../../../src/conformance/fake-host.ts";
import type { DiagnosticEntry, HostToolServer } from "../../../src/generated/host.ts";
import type { Request } from "../../../src/generated/request.ts";
import { codexDriver } from "../../../src/drivers/codex/index.ts";
import type { CodexDriverConfig } from "../../../src/drivers/codex/index.ts";
import type { HostServices, Session } from "../../../src/runtime.ts";
import { runScenario } from "../scenarios.ts";
import { CODEX_RECORDER_CONFIG } from "./credentials.ts";
import type { NativeProgress, Scenario, ScenarioRun } from "../scenarios.ts";

export const CODEX_RECORDER_INSTANCE_ID = "codex-recorder";

export interface CodexLayout {
  readonly root: string;
  readonly cwd: string;
  /** CODEX_HOME for `codex`. */
  readonly codexHome: string;
  /** HOME for `codex`. */
  readonly home: string;
  readonly configHome: string;
  readonly dataHome: string;
  readonly stateHome: string;
  readonly cacheHome: string;
  readonly runtimeDir: string;
  readonly tmp: string;
  /** The host's state directory for the instance. */
  readonly stateDir: string;
}

/** Makes `directory` the root of a Git repository of its own, with the least one holds: HEAD, objects/ and refs/, which Git looks for. */
function makeOwnRepository(directory: string): void {
  const git = path.join(directory, ".git");
  for (const each of ["objects", path.join("refs", "heads"), path.join("refs", "tags")]) fs.mkdirSync(path.join(git, each), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(git, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
}

/** A fresh temp workspace, by its real path, whose `cwd/` is the root of its own Git repository, with the recorder's config in its Codex home. */
export function createCodexLayout(prefix: string): CodexLayout {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const instance = path.join(root, "instances", CODEX_RECORDER_INSTANCE_ID);
  const layout: CodexLayout = {
    root,
    cwd: path.join(root, "cwd"),
    codexHome: path.join(root, "codex-home"),
    home: path.join(root, "user-home"),
    configHome: path.join(root, "xdg-config"),
    dataHome: path.join(root, "xdg-data"),
    stateHome: path.join(root, "xdg-state"),
    cacheHome: path.join(root, "xdg-cache"),
    runtimeDir: path.join(root, "xdg-runtime"),
    tmp: path.join(root, "tmp"),
    stateDir: path.join(instance, "state"),
  };
  for (const directory of [layout.cwd, layout.codexHome, layout.home, layout.configHome, layout.dataHome, layout.stateHome, layout.cacheHome, layout.runtimeDir, layout.tmp, layout.stateDir, path.join(instance, "cache"), path.join(instance, "tmp")]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  makeOwnRepository(layout.cwd);
  fs.writeFileSync(path.join(layout.codexHome, "config.toml"), CODEX_RECORDER_CONFIG, { mode: 0o600 });
  return layout;
}

/** The driver config every recording and replay uses: the user's `codex` on PATH, with the recorded model. */
export function codexRecorderConfig(model: string): CodexDriverConfig {
  return { ...codexDriver.defaultConfig(), model };
}

/**
 * The environment rule of the recorder's host: it strips every CODEX_ and
 * OPENAI_ variable of the recorder's environment. Codex reads many: its home
 * and state database (`CODEX_HOME`, `CODEX_SQLITE_HOME`), sign-ins
 * (`OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`,
 * `OPENAI_IDENTITY_TOKEN_FILE`), endpoints (`OPENAI_BASE_URL`,
 * `CODEX_AUTHAPI_BASE_URL`) and more (codex-rs at tag rust-v0.172.0). The
 * CLI manifest's own three (`OPENAI_API_KEY`, `CODEX_API_KEY`,
 * `OPENAI_ADMIN_KEY`) are among them. The recorder then sets `CODEX_HOME`
 * itself.
 */
export const CODEX_RECORDER_ENV_POLICY = { stripAmbient: ["CODEX_*", "OPENAI_*"] };

export interface CodexScenarioInput {
  readonly scenario: Scenario;
  readonly layout: CodexLayout;
  /** The process service the driver spawns `codex` through: the tapped real one, or the replay's. */
  readonly process: HostServices["process"];
  /** The model the driver starts the thread with. */
  readonly model: string;
  readonly timeoutMs: number;
  readonly mayApprove?: (request: Request) => boolean;
  readonly native?: NativeProgress;
  /** Wraps each session the host opens; tests use it to play a host that behaves differently. */
  readonly wrapSession?: (session: Session) => Session;
}

export interface CodexScenarioResult {
  readonly run: ScenarioRun;
  /** What the driver logged to the host's diagnostics. */
  readonly diagnostics: readonly DiagnosticEntry[];
}

/**
 * The tool server the recorder's host names for every thread: an HTTP MCP
 * server on the discard port of the loopback address, where nothing listens
 * on an ordinary machine, so Codex's connection is refused at once and the
 * session gets no tools. The Codex driver asks the host for a thread's server
 * on every `thread/resume` and passes it in the request's config (its
 * `mcp_servers.<name>`), and fails the resume when the host has none.
 *
 * The server carries an Authorization header of its own, so Codex's MCP
 * client looks up no OAuth credentials for it in any store, keyring or file,
 * before it connects: it skips the lookup when the server's headers hold an
 * Authorization (codex-rs/rmcp-client/src/rmcp_client.rs:1459–1470, and
 * auth_status.rs:161–164 for the server's sign-in status).
 */
export const CODEX_RECORDER_TOOL_SERVER: HostToolServer = {
  name: "ari-recorder-tools",
  config: { name: "ari-recorder-tools", transport: "http", url: "http://127.0.0.1:9/ari-recorder/no-tools", headers: { Authorization: "Bearer none" } },
  alwaysLoad: false,
};

/** A host with the recorder's process service, and a tool server for threads that serves nothing (CODEX_RECORDER_TOOL_SERVER). */
export function codexRecorderHost(layout: CodexLayout, process: HostServices["process"]): HostServices<CodexDriverConfig> & { readonly diagnosticEntries: readonly DiagnosticEntry[] } {
  const base = path.dirname(layout.stateDir);
  const paths = { stateDir: layout.stateDir, cacheDir: path.join(base, "cache"), tmpDir: path.join(base, "tmp") };
  const host = createFakeHost<CodexDriverConfig>({ paths, envPolicy: CODEX_RECORDER_ENV_POLICY });
  return {
    ...host,
    process,
    hostTools: {
      ...host.hostTools,
      mcpServerFor: async () => CODEX_RECORDER_TOOL_SERVER,
    },
  };
}

/** Plays `scenario` through a fresh Codex driver whose `codex` processes start through `input.process`. */
export async function runCodexScenario(input: CodexScenarioInput): Promise<CodexScenarioResult> {
  const host = codexRecorderHost(input.layout, input.process);
  const instance = await codexDriver.create(host, { instanceId: CODEX_RECORDER_INSTANCE_ID, config: codexRecorderConfig(input.model), environment: {} });
  try {
    const run = await runScenario(input.scenario, {
      openSession: async () => {
        const session = await instance.openSession({});
        return input.wrapSession === undefined ? session : input.wrapSession(session);
      },
      cwd: input.layout.cwd,
      timeoutMs: input.timeoutMs,
      ...(input.mayApprove === undefined ? {} : { mayApprove: input.mayApprove }),
      ...(input.native === undefined ? {} : { native: input.native }),
    });
    return { run, diagnostics: host.diagnosticEntries };
  } finally {
    await instance.dispose();
  }
}
