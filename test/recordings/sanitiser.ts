// The one sanitiser every recorder runs each frame through before it writes,
// and every replay runs each outbound frame through before it compares, so
// both sides are compared in the same placeholder form.
//
// It replaces, in every string and every object key:
//   - the recording's temp workspace (and its real path) with <WORKSPACE>;
//   - a string that is exactly the value of PATH with <PATH> (PATH differs
//     between the recording machine and the replay machine);
//   - $HOME (and its real path) with <HOME>;
//   - the values of ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and
//     CLAUDE_CODE_OAUTH_TOKEN with <ANTHROPIC_API_KEY> and so on;
//   - email addresses with <EMAIL>;
//   - the OS user name, as a whole word, with <USER>;
// then the rest of what the scan (scripts/check-recordings.ts) refuses:
//   - another user's home directory (/home/<name>, /Users/<name>, /root)
//     with <OTHER_HOME>;
//   - token patterns (sk-ant-..., sk-..., gh?_..., xox?-..., AKIA...,
//     "Bearer <token>") with <TOKEN>.
// Exact values go first, longest first, so a path inside the workspace is
// replaced whole.

import * as fs from "node:fs";
import * as os from "node:os";

/** The credential variables whose values never reach a recording. */
export const SECRET_VARIABLES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

export const PLACEHOLDERS = {
  workspace: "<WORKSPACE>",
  path: "<PATH>",
  home: "<HOME>",
  user: "<USER>",
  email: "<EMAIL>",
  otherHome: "<OTHER_HOME>",
  token: "<TOKEN>",
} as const;

export interface SanitiserInput {
  /** The recording's temp workspace. */
  readonly workspace: string;
  /** The environment the recorder (or the replay) runs in: HOME, PATH, the user and the credential variables come from it. */
  readonly env: { readonly [name: string]: string | undefined };
  /** The OS user name; defaults to the env's USER or LOGNAME, then os.userInfo(). */
  readonly user?: string;
}

export type Sanitiser = <T>(value: T) => T;

function realPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function osUser(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

// What the scan refuses, as replacements. Each regex is global.
export const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const OTHER_HOME_PATTERN = /(^|[^A-Za-z0-9._~-])(?:\/home\/[^/\s"'`<>]*|\/Users\/[^/\s"'`<>]*|\/root(?=\/))/g;
const TOKEN_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]*/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]*/g,
  /xox[baprs]-[A-Za-z0-9-]*/g,
  /AKIA[0-9A-Z]{16}/g,
];
const BEARER_PATTERN = /Bearer [A-Za-z0-9._~+/=-]{20,}/g;

/** Builds the sanitiser for one recording (or one replay). */
export function createSanitiser(input: SanitiserInput): Sanitiser {
  const exact: Array<{ value: string; placeholder: string }> = [];
  const add = (value: string | undefined, placeholder: string): void => {
    if (value === undefined || value === "" || value === "/") return;
    for (const each of new Set([value, realPath(value)])) {
      if (!exact.some((entry) => entry.value === each)) exact.push({ value: each, placeholder });
    }
  };
  // PATH differs from machine to machine; it is replaced only where a string is the whole value.
  const searchPath = input.env["PATH"] === "" ? undefined : input.env["PATH"];
  add(input.workspace, PLACEHOLDERS.workspace);
  add(input.env["HOME"], PLACEHOLDERS.home);
  for (const name of SECRET_VARIABLES) add(input.env[name], `<${name}>`);
  exact.sort((a, b) => b.value.length - a.value.length);
  const user = input.user ?? input.env["USER"] ?? input.env["LOGNAME"] ?? osUser();
  const userPattern = user === undefined || user === "" ? undefined : new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(user)}(?![A-Za-z0-9_-])`, "g");

  const text = (value: string): string => {
    if (searchPath !== undefined && value === searchPath) return PLACEHOLDERS.path;
    let result = value;
    for (const entry of exact) result = result.split(entry.value).join(entry.placeholder);
    // Emails before the user name: a user name inside an address would otherwise break the address apart and keep its domain.
    result = result.replace(EMAIL_PATTERN, PLACEHOLDERS.email);
    if (userPattern !== undefined) result = result.replace(userPattern, PLACEHOLDERS.user);
    result = result.replace(OTHER_HOME_PATTERN, (_match, before: string) => `${before}${PLACEHOLDERS.otherHome}`);
    for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, PLACEHOLDERS.token);
    result = result.replace(BEARER_PATTERN, `Bearer ${PLACEHOLDERS.token}`);
    return result;
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null) {
      const out: { [key: string]: unknown } = {};
      for (const [key, entry] of Object.entries(value)) out[text(key)] = walk(entry);
      return out;
    }
    return value;
  };
  return <T>(value: T): T => walk(value) as T;
}

/** Puts a replay's own workspace where the recording says <WORKSPACE>, in every string of an inbound frame. */
export function restoreWorkspace<T>(value: T, workspace: string): T {
  const walk = (each: unknown): unknown => {
    if (typeof each === "string") return each.split(PLACEHOLDERS.workspace).join(workspace);
    if (Array.isArray(each)) return each.map(walk);
    if (typeof each === "object" && each !== null) {
      const out: { [key: string]: unknown } = {};
      for (const [key, entry] of Object.entries(each)) out[walk(key) as string] = walk(entry);
      return out;
    }
    return each;
  };
  return walk(value) as T;
}
