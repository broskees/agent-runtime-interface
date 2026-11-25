// Starting the OpenCode 2.x server the recorder records against:
// `opencode serve --hostname 127.0.0.1 --port 0`, with an environment that
// keeps the user's own OpenCode setup out (docs/recordings.md, "How the
// OpenCode recorder keeps the user's setup out").
//
// What OpenCode 2.1.2 reads, from its source at tag v2.1.2 (commit a517687):
//   - its global directories from the XDG base directories, else from under
//     HOME (`packages/util/src/global-roots.ts`): config `$XDG_CONFIG_HOME/opencode`,
//     data `$XDG_DATA_HOME/opencode` (its database, with sessions and
//     sign-ins), state and cache likewise;
//   - `~/.claude` and `~/.agents` from HOME (`packages/core/src/config/discovery.ts`);
//   - the variables OPENCODE_CONFIG, OPENCODE_CONFIG_DIR, OPENCODE_CONFIG_CONTENT,
//     OPENCODE_DB, OPENCODE_TEST_HOME and more (`packages/cli/src/server-process.ts`,
//     `packages/util/src/global.ts`, `packages/cli/src/database-path.ts`);
//   - project config from the session's directory upwards, unless
//     OPENCODE_DISABLE_PROJECT_CONFIG is set; `.claude` directories unless
//     OPENCODE_DISABLE_CLAUDE_CODE is set (`packages/cli/src/server-process.ts`).
// So the server gets its own HOME and XDG base directories inside the
// recording's workspace, no OPENCODE_* variable of the user's, project config
// and `.claude` directories off, and its own password. Everything else in the
// recorder's environment (PATH, and the provider keys OpenCode reads from it)
// passes through.

import { spawn } from "node:child_process";
import type { OpencodeLayout } from "./run.ts";

export const OPENCODE_SERVE_ARGS: readonly string[] = ["serve", "--hostname", "127.0.0.1", "--port", "0"];

/** A running OpenCode server: where it listens, its password, and how to stop it. */
export interface OpencodeServerHandle {
  readonly url: string;
  readonly password: string;
  stop(): Promise<void>;
}

/** The environment `opencode serve` runs with: the recorder's own, less HOME, the XDG base directories and every OPENCODE_* variable, plus the workspace's own. */
export function opencodeServeEnvironment(layout: OpencodeLayout, source: { readonly [name: string]: string | undefined }, password: string): { [name: string]: string } {
  const replaced = new Set(["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]);
  const env: { [name: string]: string } = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || replaced.has(name) || name.startsWith("OPENCODE_")) continue;
    env[name] = value;
  }
  return {
    ...env,
    HOME: layout.home,
    XDG_CONFIG_HOME: layout.configHome,
    XDG_DATA_HOME: layout.dataHome,
    XDG_STATE_HOME: layout.stateHome,
    XDG_CACHE_HOME: layout.cacheHome,
    OPENCODE_PASSWORD: password,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
  };
}

export interface StartOpencodeServeInput {
  readonly layout: OpencodeLayout;
  /** The whole environment of the server, from `opencodeServeEnvironment`. */
  readonly env: { readonly [name: string]: string };
  readonly password: string;
  /** The `opencode` executable, looked up on the environment's PATH; `opencode` by default. */
  readonly executable?: string;
  /** How long to wait for the server to say where it listens; 60 s by default. */
  readonly timeoutMs?: number;
}

/** Starts `opencode serve` in the workspace's `cwd/` and waits until it prints `listening on <url>` (2.1.2 prints `Server listening on <url>`). */
export function startOpencodeServe(input: StartOpencodeServeInput): Promise<OpencodeServerHandle> {
  const child = spawn(input.executable ?? "opencode", [...OPENCODE_SERVE_ARGS], { cwd: input.layout.cwd, env: { ...input.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("error", () => {
      exited = true;
      resolve();
    });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const stop = async (): Promise<void> => {
    if (exited) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exit;
    clearTimeout(timer);
  };
  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void stop().then(() => reject(new Error(`${message}${stderr.trim() === "" ? "" : `; its stderr ends: ${stderr.trim()}`}`)));
    };
    const timer = setTimeout(() => fail(`opencode serve did not say where it listens within ${input.timeoutMs ?? 60_000} ms`), input.timeoutMs ?? 60_000);
    child.once("error", (error) => fail(`opencode serve could not start: ${error.message}`));
    void exit.then(() => fail("opencode serve exited before it listened"));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      stdout = (stdout + chunk).slice(-64 * 1024);
      const match = /listening on (https?:\/\/[^\s]+)/i.exec(stdout);
      if (match === null) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url: match[1]!.replace(/\/+$/, ""), password: input.password, stop });
    });
  });
}
