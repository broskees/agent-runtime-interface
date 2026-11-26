// Where the Codex CLI finds a user's setup, for a given environment and
// working directory, from the pinned source (codex-rs/ at tag rust-v0.172.0,
// commit 3d86e43b):
//   - the Codex home: `CODEX_HOME` when set and not empty, else `~/.codex`
//     (utils/home-dir/src/lib.rs:13–60). In it: the user's `config.toml`
//     (config/src/loader/local.rs:122), which holds MCP servers
//     (`[mcp_servers.<name>]`, config/src/mcp_edit.rs:13–21) and enabled
//     plugins (`[plugins]`, core-plugins/src/loader.rs:722–760);
//     `managed_config.toml` (config/src/loader/layer_io.rs:232); the user's
//     `AGENTS.md` and `AGENTS.override.md` (core/src/agents_md.rs:44–47);
//     memories in `memories/` and `memories_v2/`
//     (protocol/src/memory_version.rs:17–22, core/src/config/mod.rs:3869);
//     skills in `skills/` (ext/skills/src/host_roots.rs:151–157); exec-policy
//     rules in `rules/` (core/src/exec_policy.rs:966); installed plugins in
//     `plugins/` (core-plugins/src/store.rs:26–27); the state database,
//     which keeps thread goals, `state_5.sqlite` (state/src/sqlite.rs:53), in
//     `CODEX_SQLITE_HOME` when set, else in the Codex home
//     (core/src/config/mod.rs:295–305, 4529–4540);
//   - skills in `~/.agents/skills` (ext/skills/src/host_roots.rs:159–165);
//   - the project: `AGENTS.md`, `AGENTS.override.md`, `.codex/` and
//     `.agents/skills` of the working directory and each parent folder up to
//     the project root, the nearest folder holding `.git`, and of the working
//     directory alone outside a repository (core/src/agents_md.rs:7–18,
//     config/src/project_root_markers.rs:5, ext/skills/src/host_roots.rs).
// The system configuration (`/etc/codex/`) and managed preferences are left
// out: they are the machine's, not the user's, and no recorder isolates them
// (docs/recordings.md).
// The fake `codex` (./fake-codex-cli.ts) loads these and repeats what it
// loaded in its replies, so a test sees in the recording what leaked.

import * as fs from "node:fs";
import * as path from "node:path";

type Env = { readonly [name: string]: string | undefined };

function set(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** The Codex home for `env`: CODEX_HOME, else `~/.codex`; undefined without either. */
export function codexHomeOf(env: Env): string | undefined {
  const named = set(env["CODEX_HOME"]);
  if (named !== undefined) return named;
  const home = set(env["HOME"]);
  return home === undefined ? undefined : path.join(home, ".codex");
}

/** The root of the repository `directory` is in: the nearest folder, itself included, that holds `.git`; undefined outside a repository. */
export function repositoryRoot(directory: string): string | undefined {
  for (let folder = directory; ; folder = path.dirname(folder)) {
    if (fs.existsSync(path.join(folder, ".git"))) return folder;
    if (path.dirname(folder) === folder) return undefined;
  }
}

/** The files and directories the Codex CLI reads a user's setup from, for `env` and the working directory `cwd`. */
export function codexSetupSources(env: Env, cwd: string): string[] {
  const sources: string[] = [];
  const codexHome = codexHomeOf(env);
  if (codexHome !== undefined) {
    for (const name of ["config.toml", "managed_config.toml", "AGENTS.md", "AGENTS.override.md", "memories", "memories_v2", "skills", "rules", "plugins"]) sources.push(path.join(codexHome, name));
  }
  const sqliteHome = set(env["CODEX_SQLITE_HOME"]) ?? codexHome;
  if (sqliteHome !== undefined) sources.push(path.join(sqliteHome, "state_5.sqlite"));
  const home = set(env["HOME"]);
  if (home !== undefined) sources.push(path.join(home, ".agents", "skills"));
  const workspace = path.resolve(cwd);
  const root = repositoryRoot(workspace);
  for (let directory = workspace; ; directory = path.dirname(directory)) {
    for (const name of ["AGENTS.md", "AGENTS.override.md", ".codex", path.join(".agents", "skills")]) sources.push(path.join(directory, name));
    if (root === undefined || directory === root || path.dirname(directory) === directory) break;
  }
  return sources;
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

/** The text of every setup file the Codex CLI would load for `env` and `cwd`, each with its path. */
export function loadedCodexSetup(env: Env, cwd: string): string[] {
  const budget = { left: 200 };
  return codexSetupSources(env, cwd).flatMap((source) => filesUnder(source, budget));
}
