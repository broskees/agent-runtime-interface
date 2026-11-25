// Where OpenCode 2.1.2 finds a user's setup (config, plugins, agents, MCP
// servers, instructions and skills), for a given environment and directory,
// from its source at tag v2.1.2:
//   - the global config directory: OPENCODE_CONFIG_DIR, else
//     `$XDG_CONFIG_HOME/opencode`, else `$HOME/.config/opencode`
//     (`packages/util/src/global.ts:79`, `packages/util/src/global-roots.ts:7`),
//     with its `opencode.json`, plugins, agents and the rest;
//   - `$HOME/.agents` always, `$HOME/.claude` unless OPENCODE_DISABLE_CLAUDE_CODE
//     is set (`packages/core/src/config/discovery.ts:69-70`,
//     `packages/cli/src/server-process.ts:128`);
//   - OPENCODE_CONFIG (a file) and OPENCODE_CONFIG_CONTENT (`packages/cli/src/server-process.ts`);
//   - unless OPENCODE_DISABLE_PROJECT_CONFIG is set, `opencode.json`,
//     `opencode.jsonc`, `.opencode/`, `.claude/` and `.agents/` in the
//     directory and every directory above it (`packages/core/src/config/discovery.ts:80-85`);
//   - the data directory, `$XDG_DATA_HOME/opencode`, else
//     `$HOME/.local/share/opencode`, whose database holds the sessions and
//     sign-ins (`packages/util/src/global-roots.ts:5`, `packages/cli/src/server-process.ts:114`).
// The fake `opencode` (./fake-opencode-cli.ts) loads these the same way, so a
// test sees what a real server would have loaded.

import * as fs from "node:fs";
import * as path from "node:path";

type Env = { readonly [name: string]: string | undefined };

function set(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/** The files and directories OpenCode 2.1.2 reads the user's setup from, for `env` and the directory `cwd`. */
export function opencodeSetupSources(env: Env, cwd: string): string[] {
  const home = set(env["OPENCODE_TEST_HOME"]) ?? set(env["HOME"]);
  const configHome = set(env["XDG_CONFIG_HOME"]) ?? (home === undefined ? undefined : path.join(home, ".config"));
  const config = set(env["OPENCODE_CONFIG_DIR"]) ?? (configHome === undefined ? undefined : path.join(configHome, "opencode"));
  const sources = [
    ...(config === undefined ? [] : [config]),
    ...(home === undefined ? [] : [path.join(home, ".agents"), ...(truthy(env["OPENCODE_DISABLE_CLAUDE_CODE"]) ? [] : [path.join(home, ".claude")])]),
    ...(set(env["OPENCODE_CONFIG"]) === undefined ? [] : [env["OPENCODE_CONFIG"]!]),
  ];
  if (!truthy(env["OPENCODE_CONFIG_PROJECT_DISABLE"] ?? env["OPENCODE_DISABLE_PROJECT_CONFIG"])) {
    for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
      for (const name of ["opencode.json", "opencode.jsonc", ".opencode", ".claude", ".agents"]) sources.push(path.join(directory, name));
      if (path.dirname(directory) === directory) break;
    }
  }
  return sources;
}

/** OpenCode 2.1.2's data directory for `env`. */
export function opencodeDataSource(env: Env): string | undefined {
  const home = set(env["HOME"]);
  const dataHome = set(env["XDG_DATA_HOME"]) ?? (home === undefined ? undefined : path.join(home, ".local", "share"));
  return dataHome === undefined ? undefined : path.join(dataHome, "opencode");
}

function filesUnder(source: string, budget: { left: number }): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(source);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    if (budget.left <= 0 || stat.size > 64 * 1024) return [];
    budget.left -= 1;
    return [`${source}: ${fs.readFileSync(source, "utf8")}`];
  }
  if (!stat.isDirectory()) return [];
  return fs
    .readdirSync(source)
    .sort()
    .flatMap((name) => filesUnder(path.join(source, name), budget));
}

/** The text of every setup file OpenCode 2.1.2 would load for `env` and `cwd`, with its path, plus OPENCODE_CONFIG_CONTENT. */
export function loadedOpencodeSetup(env: Env, cwd: string): string[] {
  const budget = { left: 200 };
  const content = set(env["OPENCODE_CONFIG_CONTENT"]);
  return [...opencodeSetupSources(env, cwd).flatMap((source) => filesUnder(source, budget)), ...(content === undefined ? [] : [`OPENCODE_CONFIG_CONTENT: ${content}`])];
}
