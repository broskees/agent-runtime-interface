// Where the Codex CLI keeps a sign-in, and where the recorder puts its copy.
// docs/recordings.md, "How Codex finds the sign-in", gives the sources.
//
// Codex keeps a ChatGPT or API-key sign-in in `auth.json` in its home
// (codex-rs/login/src/auth/storage.rs:167–168, `get_auth_file`, read by
// `FileAuthStorage::load` at lines 263–271). That is file storage, Codex's
// default when `config.toml` sets no `cli_auth_credentials_store`
// (codex-rs/config/src/types.rs:139–149, codex-rs/core/src/config/mod.rs:
// 4792–4797); `keyring` or `auto` there keeps it in the OS keyring instead,
// which the recorder never reads. The home is CODEX_HOME when set and not
// empty, else `~/.codex` (codex-rs/utils/home-dir/src/lib.rs:13–60). A ChatGPT
// sign-in's refresh token rotates: Codex writes the refreshed tokens back to
// the same file, as a new file renamed over the old one (storage.rs:274–295).

import * as path from "node:path";

/** The file Codex keeps a sign-in in, in its home. */
export const CODEX_SIGN_IN_FILE = "auth.json";

/** The user's Codex home: CODEX_HOME, else `~/.codex`; undefined without either. */
export function userCodexHome(env: { readonly [name: string]: string | undefined }): string | undefined {
  const named = env["CODEX_HOME"]?.trim();
  if (named !== undefined && named !== "") return named;
  const home = env["HOME"]?.trim();
  return home === undefined || home === "" ? undefined : path.join(home, ".codex");
}

/** The user's sign-in file: `auth.json` in the user's Codex home, or undefined without one. */
export function userSignInFile(env: { readonly [name: string]: string | undefined }): string | undefined {
  const home = userCodexHome(env);
  return home === undefined ? undefined : path.join(home, CODEX_SIGN_IN_FILE);
}

/** Where the recorded `codex` looks for it: `auth.json` in the workspace's Codex home. */
export function workspaceSignInFile(codexHome: string): string {
  return path.join(codexHome, CODEX_SIGN_IN_FILE);
}
