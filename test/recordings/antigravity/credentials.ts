// Where the Antigravity CLI keeps a Google sign-in in a file, and where the
// recorder puts its copy. docs/recordings.md, "How Antigravity finds the
// sign-in", gives the sources.
//
// `agy` 1.5.x keeps the sign-in in the OS keyring (Secret Service on Linux,
// service `gemini`, account `antigravity`), and in the file
// `antigravity-oauth-token` in its app data directory when the keyring is
// bypassed or unreachable, or when AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set,
// as the driver sets it. The app data directory is
// `<gemini dir>/<app data dir>`: `~/.gemini/antigravity-cli` for the user's
// own `agy` (`--gemini-dir` defaults to `.gemini` in the home directory and
// `--app-data-dir` to `antigravity-cli`), and
// `<profile>/antigravity-acp` for the driver's `agy acp --gemini-dir <profile>
// --app-data-dir antigravity-acp`.

import * as path from "node:path";

/** The file `agy` keeps a Google sign-in in when it does not use the keyring. */
export const ANTIGRAVITY_SIGN_IN_FILE = "antigravity-oauth-token";

/** The app data directory of the user's own `agy`, under its gemini directory. */
export const USER_APP_DATA_DIRECTORY = "antigravity-cli";

/** The app data directory the driver gives `agy acp` (`--app-data-dir antigravity-acp`). */
export const DRIVER_APP_DATA_DIRECTORY = "antigravity-acp";

/** The user's sign-in file: `~/.gemini/antigravity-cli/antigravity-oauth-token`, or undefined without a HOME. */
export function userSignInFile(env: { readonly [name: string]: string | undefined }): string | undefined {
  const home = env["HOME"]?.trim();
  return home === undefined || home === "" ? undefined : path.join(home, ".gemini", USER_APP_DATA_DIRECTORY, ANTIGRAVITY_SIGN_IN_FILE);
}

/** Where the recorded `agy acp` looks for it: `<profile>/antigravity-acp/antigravity-oauth-token`. */
export function profileSignInFile(profile: string): string {
  return path.join(profile, DRIVER_APP_DATA_DIRECTORY, ANTIGRAVITY_SIGN_IN_FILE);
}
