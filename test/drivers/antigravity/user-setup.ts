// Where the Antigravity CLI finds a user's setup (settings, rules and
// instructions, skills, custom agents, plugins, hooks, MCP servers), for a
// given environment, directory and `--gemini-dir`, from Antigravity's docs
// (read 2026-11-25):
//   - "Customization discovery": personal customizations in `~/.gemini/config/`
//     (rules, skills, agents, plugins, `hooks.json`, `mcp_config.json`), plus
//     `~/.gemini/AGENTS.md` and `~/.gemini/GEMINI.md`; the CLI also loads
//     skills from `~/.gemini/antigravity-cli/skills/` and `~/.gemini/skills/`;
//     workspace customizations in `.agents/`, `AGENTS.md` and `GEMINI.md` of
//     the workspace folder and each parent folder up to the root of its
//     repository (the folder that holds `.git`), and of the workspace folder
//     alone outside a repository; and, when the repository's root holds
//     `.gemini/config.json` naming a `personal_customization_dir`
//     (`{user}` standing for USER), the `.agents/` folder in that directory;
//   - "Settings": the CLI's settings in `~/.gemini/antigravity-cli/settings.json`,
//     and its keybindings beside them;
//   - `~/.config/antigravity` (`$XDG_CONFIG_HOME/antigravity`), where the CLI
//     keeps plugin secrets (`plugin-secrets.json`).
// Antigravity does not say whether `--gemini-dir` moves `~/.gemini/config/`,
// so the fake reads both the home directory's `.gemini` and the gemini
// directory it was given.
// The fake `agy` (./fake-agy-cli.ts) loads these and repeats what it loaded in
// its replies, so a test sees in the recording what leaked.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Env = { readonly [name: string]: string | undefined };

function set(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** The files and directories the Antigravity CLI reads a user's setup from, for `env`, the directory `cwd`, and `agy acp`'s `--gemini-dir` and `--app-data-dir`. */
export function antigravitySetupSources(env: Env, cwd: string, geminiDir?: string, appDataDir = "antigravity-cli"): string[] {
  const home = set(env["HOME"]);
  const configHome = set(env["XDG_CONFIG_HOME"]) ?? (home === undefined ? undefined : path.join(home, ".config"));
  const geminiDirs = [...new Set([...(home === undefined ? [] : [path.join(home, ".gemini")]), ...(geminiDir === undefined ? [] : [path.resolve(home ?? "/", geminiDir)])])];
  const sources: string[] = [];
  for (const gemini of geminiDirs) {
    sources.push(path.join(gemini, "config"), path.join(gemini, "AGENTS.md"), path.join(gemini, "GEMINI.md"), path.join(gemini, "skills"));
    for (const appData of new Set(["antigravity-cli", appDataDir])) sources.push(path.join(gemini, appData, "settings.json"), path.join(gemini, appData, "keybindings.json"), path.join(gemini, appData, "skills"));
  }
  if (configHome !== undefined) sources.push(path.join(configHome, "antigravity"));
  const workspace = path.resolve(cwd);
  const root = repositoryRoot(workspace);
  for (let directory = workspace; ; directory = path.dirname(directory)) {
    for (const name of [".agents", "AGENTS.md", "GEMINI.md"]) sources.push(path.join(directory, name));
    if (root === undefined || directory === root) break;
  }
  const personal = root === undefined ? undefined : personalCustomizationDir(root, env);
  if (personal !== undefined) sources.push(path.join(personal, ".agents"));
  return sources;
}

/** The root of the repository `directory` is in: the nearest folder, itself included, that holds `.git`; undefined outside a repository. */
export function repositoryRoot(directory: string): string | undefined {
  for (let folder = directory; ; folder = path.dirname(folder)) {
    if (fs.existsSync(path.join(folder, ".git"))) return folder;
    if (path.dirname(folder) === folder) return undefined;
  }
}

/** The `personal_customization_dir` the repository's `.gemini/config.json` names, with `{user}` replaced, from the repository's root. */
function personalCustomizationDir(root: string, env: Env): string | undefined {
  let named: unknown;
  try {
    named = (JSON.parse(fs.readFileSync(path.join(root, ".gemini", "config.json"), "utf8")) as { personal_customization_dir?: unknown }).personal_customization_dir;
  } catch {
    return undefined;
  }
  if (typeof named !== "string" || named === "") return undefined;
  return path.resolve(root, named.split("{user}").join(set(env["USER"]) ?? os.userInfo().username));
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

/** The text of every setup file the Antigravity CLI would load for `env`, `cwd` and its gemini and app data directories, each with its path. */
export function loadedAntigravitySetup(env: Env, cwd: string, geminiDir?: string, appDataDir?: string): string[] {
  const budget = { left: 200 };
  return antigravitySetupSources(env, cwd, geminiDir, appDataDir).flatMap((source) => filesUnder(source, budget));
}
