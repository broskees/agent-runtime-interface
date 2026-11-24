// The one sanitiser every recorder runs each frame through before it writes,
// and every replay runs each outbound frame through before it compares, so
// both sides are compared in the same placeholder form.
//
// It replaces, in every string and every object key (a frame's own format
// fields, `dir`, `kind`, `query`, `id`, `method`, `toolName` and
// `contentType`, stay as the tap wrote them when they hold a string, a
// number, a boolean or null):
//   - the recording's temp workspace (and its real path) with <WORKSPACE>;
//   - a string that is exactly the value of PATH with <PATH> (PATH differs
//     between the recording machine and the replay machine);
//   - $HOME (and its real path) with <HOME>;
//   - the values of ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and
//     CLAUDE_CODE_OAUTH_TOKEN with <ANTHROPIC_API_KEY> and so on;
//   - email addresses with <EMAIL>;
//   - the OS user name (os.userInfo().username, and the values of USER and
//     LOGNAME where they differ) with <USER>. How depends on what the string
//     is:
//       - in an inbound frame (what the agent and the machine produced: tool
//         output, assistant text, stderr, file contents), every whole-word
//         occurrence, in every string value, except a value that is one of
//         the protocol words of its key (the driver kit's `protocolWords`,
//         for Claude derived from the pinned sdk.d.ts). So the owner column
//         of an `ls -l` is replaced, and `type: "user"` stays on an account
//         named `user`;
//       - in an outbound frame (what the driver sent, built from the scenario
//         and the host's config) and in every object key, only where the
//         name is a whole segment of a path (/srv/<name>/x, C:\Users\<name>,
//         ~<name>/x). A prompt or option the driver sends is then the same
//         on every account, and a recording made on one account replays on
//         another;
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
  /** The environment the recorder (or the replay) runs in: HOME, PATH, USER, LOGNAME and the credential variables come from it. */
  readonly env: { readonly [name: string]: string | undefined };
  /** The OS user name; os.userInfo().username when left out. USER and LOGNAME are replaced too when they differ from it. */
  readonly user?: string;
  /** For each object key, the values that are protocol words there; an inbound value that is one keeps the user name. */
  readonly protocolWords?: { readonly [key: string]: readonly string[] };
}

/** Which way a frame went: `in` from the native side, `out` from the driver. */
export type FrameSide = "in" | "out";

/**
 * Sanitises a value. A frame is sanitised by its own direction; any other
 * value by `side`, which defaults to `in` (the rule that replaces more).
 */
export type Sanitiser = <T>(value: T, side?: FrameSide) => T;

/**
 * The fields the recording format itself defines: a frame keeps them as the
 * tap wrote them when they hold a string, a number, a boolean or null. An
 * object or array under one of these names (an OpenCode request's `query`,
 * which holds the request's query parameters) is sanitised like any value.
 */
export const FRAME_FORMAT_FIELDS: ReadonlySet<string> = new Set(["dir", "kind", "query", "id", "method", "toolName", "contentType"]);

function isScalar(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isFrame(value: unknown): value is { readonly dir: FrameSide; readonly kind: string; readonly [field: string]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const frame = value as { dir?: unknown; kind?: unknown };
  return (frame.dir === "in" || frame.dir === "out") && typeof frame.kind === "string";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function realPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
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

// A filesystem path inside a string: it starts with /, \, ~ or a drive letter, at the
// start of the string or after a character that cannot be part of a path, and runs
// to the next space, quote, bracket or separator of a list.
const PATH_TOKEN = /(?<![A-Za-z0-9._~-])(?:[A-Za-z]:[\\/]|[/\\~])[^\s"'`<>|,;()[\]{}]*/g;

/** The user names the sanitiser replaces: the OS user's, and USER and LOGNAME when they differ. */
export function userNames(input: Pick<SanitiserInput, "env" | "user">): string[] {
  const names = [input.user ?? osUser(), input.env["USER"], input.env["LOGNAME"]];
  return [...new Set(names.filter((name): name is string => name !== undefined && name !== "" && !/[/\\\s]/.test(name)))];
}

/** `path` with every segment that is one of `names` (or `~` and one of them) replaced by <USER>. */
function withoutUserSegments(path: string, names: ReadonlySet<string>): string {
  return path
    .split(/([/\\:])/)
    .map((segment) => (names.has(segment) ? PLACEHOLDERS.user : segment.startsWith("~") && names.has(segment.slice(1)) ? `~${PLACEHOLDERS.user}` : segment))
    .join("");
}

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
  const users = new Set(userNames(input));
  const names = [...users].sort((a, b) => b.length - a.length);
  // A whole word: not next to a letter, a digit or an underscore. "joe-laptop" and "joe's" hold the word; "joey" and "joe_x" do not.
  const userWord = names.length === 0 ? undefined : new RegExp(`(?<![A-Za-z0-9_])(?:${names.map(escapeRegExp).join("|")})(?![A-Za-z0-9_])`, "g");
  const protocolWords = new Map(Object.entries(input.protocolWords ?? {}).map(([key, words]) => [key, new Set(words)]));

  /** `word` replaces every whole-word user name (inbound values); `path` only path segments (outbound values and every key). */
  const text = (value: string, rule: "word" | "path"): string => {
    if (searchPath !== undefined && value === searchPath) return PLACEHOLDERS.path;
    let result = value;
    for (const entry of exact) result = result.split(entry.value).join(entry.placeholder);
    // Emails before the user name: a user name inside an address would otherwise break the address apart and keep its domain.
    result = result.replace(EMAIL_PATTERN, PLACEHOLDERS.email);
    if (userWord !== undefined) {
      result = rule === "word" ? result.replace(userWord, PLACEHOLDERS.user) : result.replace(PATH_TOKEN, (token) => withoutUserSegments(token, users));
    }
    result = result.replace(OTHER_HOME_PATTERN, (_match, before: string) => `${before}${PLACEHOLDERS.otherHome}`);
    for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, PLACEHOLDERS.token);
    result = result.replace(BEARER_PATTERN, `Bearer ${PLACEHOLDERS.token}`);
    return result;
  };

  /** `key` is the object key the value sits under (array elements take their array's key). */
  const walk = (value: unknown, side: FrameSide, key: string | undefined): unknown => {
    if (typeof value === "string") {
      const protocolWord = key !== undefined && protocolWords.get(key)?.has(value) === true;
      return text(value, side === "in" && !protocolWord ? "word" : "path");
    }
    if (Array.isArray(value)) return value.map((each) => walk(each, side, key));
    if (typeof value === "object" && value !== null) {
      const out: { [key: string]: unknown } = {};
      for (const [field, entry] of Object.entries(value)) out[text(field, "path")] = walk(entry, side, field);
      return out;
    }
    return value;
  };

  return <T>(value: T, side?: FrameSide): T => {
    if (side === undefined && isFrame(value)) {
      const out: { [key: string]: unknown } = {};
      for (const [field, entry] of Object.entries(value)) {
        const kept = FRAME_FORMAT_FIELDS.has(field) && isScalar(entry);
        out[FRAME_FORMAT_FIELDS.has(field) ? field : text(field, "path")] = kept ? entry : walk(entry, value.dir, field);
      }
      return out as T;
    }
    return walk(value, side ?? "in", undefined) as T;
  };
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
