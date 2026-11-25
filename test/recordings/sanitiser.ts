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
//   - the value of every other variable of the environment whose name ends
//     in _KEY, _TOKEN, _SECRET or _PASSWORD, when it is 8 characters or
//     more, with <NAME> (the recorded server and Claude Code can see the
//     user's environment, and a tool can print it);
//   - email addresses with <EMAIL>;
//   - the string value under a key that names an account or organisation id
//     (`chatgpt-account-id`, `x-opencode-org-id`, `organizationUuid`, ...,
//     ACCOUNT_ID_KEY and ORG_ID_KEY) with <ACCOUNT_ID> or <ORG_ID>, in both
//     directions: OpenCode 2.1.2's model list carries the user's ChatGPT
//     account id and OpenCode organisation id as request headers of their
//     models;
//   - account details, in both directions, with fixed neutral values of the
//     same type, so a driver still parses them (NEUTRAL_FIELD_RULES): the
//     plan name (<PLAN>), a rate-limit report (NEUTRAL_RATE_LIMIT_INFO), a
//     credential's expiry time (NEUTRAL_TIME), the process id (NEUTRAL_PID),
//     a temp directory (NEUTRAL_TMP_PATH), a socket path
//     (NEUTRAL_SOCKET_PATH) and the machine's shell (NEUTRAL_SHELL);
//   - with `recordedModel`, a model list keeps only the recorded model: in
//     OpenCode 2.x's `GET /api/model` answer (an array of objects with a
//     string providerID and modelID) with only the fields a driver reads, so
//     which providers the user is signed in to, and how, stays out; in Claude
//     Code's `initializationResult().models` (objects with a string value and
//     resolvedModel) whole, so the models the user's plan offers stay out;
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

/** Any other variable whose name ends in one of these holds a secret: its value never reaches a recording either. */
export const SECRET_NAME_SUFFIXES = ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD"] as const;

/** Shorter values of those variables stay: a short value (`1`, `true`, `none`) would match ordinary text. */
export const SECRET_VALUE_MIN_LENGTH = 8;

/** The variables of `env`, besides SECRET_VARIABLES, whose values the sanitiser replaces. */
export function secretVariablesOf(env: { readonly [name: string]: string | undefined }): string[] {
  return Object.entries(env)
    .filter(([name, value]) => value !== undefined && value.length >= SECRET_VALUE_MIN_LENGTH && !(SECRET_VARIABLES as readonly string[]).includes(name) && SECRET_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    .map(([name]) => name)
    .sort();
}

export const PLACEHOLDERS = {
  workspace: "<WORKSPACE>",
  path: "<PATH>",
  home: "<HOME>",
  user: "<USER>",
  email: "<EMAIL>",
  otherHome: "<OTHER_HOME>",
  token: "<TOKEN>",
  accountId: "<ACCOUNT_ID>",
  orgId: "<ORG_ID>",
  plan: "<PLAN>",
} as const;

/** 2100-01-01T00:00:00Z: the neutral reset time of a rate limit and expiry time of a credential, far in the future. */
export const NEUTRAL_TIME = { seconds: 4_102_444_800, milliseconds: 4_102_444_800_000, iso: "2100-01-01T00:00:00.000Z" } as const;
/** The neutral process id of a native process (Claude Code's `initializationResult().pid`, OpenCode's `GET /api/info` pid). */
export const NEUTRAL_PID = 1000;
/** The neutral temp directory (OpenCode's `GET /api/info` paths.tmp). */
export const NEUTRAL_TMP_PATH = "/tmp/ari-recording";
/** The neutral socket path (Claude Code's `messaging_socket_path`). */
export const NEUTRAL_SOCKET_PATH = "/tmp/ari-recording/agent.sock";
/** The neutral shell (OpenCode's `shell.created` event names the machine's login shell). */
export const NEUTRAL_SHELL = "/bin/sh";
/** The neutral rate-limit report (Claude Code's `rate_limit_event` rate_limit_info, `SDKRateLimitInfo`): allowed, nothing used, resetting at NEUTRAL_TIME. */
export const NEUTRAL_RATE_LIMIT_INFO = { status: "allowed", rateLimitType: "five_hour", utilization: 0, resetsAt: NEUTRAL_TIME.seconds } as const;

/**
 * Account details replaced whole by a fixed neutral value of the same type,
 * keyed on the field. A key is compared without case, `-` or `_`; a value of
 * another type than the rule's stays as it is.
 */
export const NEUTRAL_FIELD_RULES: ReadonlyArray<{ readonly what: string; readonly key: RegExp; readonly neutral: (value: unknown) => unknown }> = [
  // Claude Code's `subscriptionType` ("Claude Max") in initializationResult().account, and other names of a plan.
  { what: "plan name", key: /^(?:subscriptiontype|subscriptionplan|subscriptiontier|planname|plantype|plantier|ratelimittier)$/, neutral: (value) => (typeof value === "string" ? PLACEHOLDERS.plan : value) },
  // Claude Code's rate_limit_event: status, window, utilization, reset time, threshold and overage state.
  { what: "rate-limit report", key: /^ratelimitinfo$/, neutral: (value) => (typeof value === "object" && value !== null && !Array.isArray(value) ? { ...NEUTRAL_RATE_LIMIT_INFO } : value) },
  // Claude Code's `credential_expires_at` in result messages, and other credential expiry times.
  {
    what: "credential expiry",
    key: /(?:credential|token|oauth|auth|login)expir(?:es|y|ation)(?:at|time)?$/,
    neutral: (value) => (typeof value === "string" ? NEUTRAL_TIME.iso : typeof value === "number" ? (value > 100_000_000_000 ? NEUTRAL_TIME.milliseconds : NEUTRAL_TIME.seconds) : value),
  },
  { what: "process id", key: /^(?:pid|ppid|processid)$/, neutral: (value) => (typeof value === "number" ? NEUTRAL_PID : value) },
  // OpenCode's `GET /api/info` paths.tmp, which names the temp directory of the machine's session.
  { what: "temp directory", key: /^(?:tmp|tmpdir|temp|tempdir|tmppath|temppath)$/, neutral: (value) => (typeof value === "string" ? NEUTRAL_TMP_PATH : value) },
  // Claude Code's `messaging_socket_path`, /tmp/cc-socks/<pid>.sock.
  { what: "socket path", key: /socket(?:path|file)$/, neutral: (value) => (typeof value === "string" ? NEUTRAL_SOCKET_PATH : value) },
  // OpenCode's `shell.created` event: the path of the shell the command ran in, the user's login shell.
  { what: "shell", key: /^shell$/, neutral: (value) => (typeof value === "string" && /^(?:[/\\]|[A-Za-z]:[/\\])/.test(value) ? NEUTRAL_SHELL : value) },
];

/** The fields of a model list entry a driver reads (the OpenCode driver's `models()`: enabled, providerID, modelID, name, limit.context). */
function readModelFields(entry: { readonly [key: string]: unknown }): { [key: string]: unknown } {
  const limit = entry["limit"];
  const context = typeof limit === "object" && limit !== null && !Array.isArray(limit) ? (limit as { [key: string]: unknown })["context"] : undefined;
  return {
    providerID: entry["providerID"],
    modelID: entry["modelID"],
    ...(entry["name"] === undefined ? {} : { name: entry["name"] }),
    ...(entry["enabled"] === undefined ? {} : { enabled: entry["enabled"] }),
    ...(context === undefined ? {} : { limit: { context } }),
  };
}

type Entry = { readonly [key: string]: unknown };

/** Every element is an object whose `fields` are all strings. */
function entriesWith(value: readonly unknown[], fields: readonly string[]): boolean {
  return value.length > 0 && value.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) && fields.every((field) => typeof (entry as Entry)[field] === "string"));
}

/** A key whose value identifies an account, compared without case, `-` or `_`: `chatgpt-account-id`, `account_id`, `accountUuid`. */
export const ACCOUNT_ID_KEY = /accountid$|accountuuid$/;
/** A key whose value identifies an organisation, compared the same way: `x-opencode-org-id`, `organization_id`, `organizationUuid`. */
export const ORG_ID_KEY = /(?:org|organization|organisation)(?:id|uuid)$/;

/** The placeholder for the value under `key` when the key names an account or organisation id. */
function idPlaceholder(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const plain = key.toLowerCase().replace(/[-_]/g, "");
  if (ACCOUNT_ID_KEY.test(plain)) return PLACEHOLDERS.accountId;
  if (ORG_ID_KEY.test(plain)) return PLACEHOLDERS.orgId;
  return undefined;
}

export interface SanitiserInput {
  /** The recording's temp workspace. */
  readonly workspace: string;
  /** The environment the recorder (or the replay) runs in: HOME, PATH, USER, LOGNAME, the credential variables and every other secret variable come from it. */
  readonly env: { readonly [name: string]: string | undefined };
  /** The OS user name; os.userInfo().username when left out. USER and LOGNAME are replaced too when they differ from it. */
  readonly user?: string;
  /** For each object key, the values that are protocol words there; an inbound value that is one keeps the user name. */
  readonly protocolWords?: { readonly [key: string]: readonly string[] };
  /** The `provider/model` the recording used: a model list keeps only that model. Without it, a model list stays whole. */
  readonly recordedModel?: string;
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
  // A secret is not a path: its value is replaced as it is, never resolved on disk.
  for (const name of secretVariablesOf(input.env)) {
    const value = input.env[name]!;
    if (!exact.some((entry) => entry.value === value)) exact.push({ value, placeholder: `<${name}>` });
  }
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

  const neutralRules = (key: string | undefined): ReadonlyArray<(typeof NEUTRAL_FIELD_RULES)[number]> => {
    if (key === undefined) return [];
    const plain = key.toLowerCase().replace(/[-_]/g, "");
    return NEUTRAL_FIELD_RULES.filter((rule) => rule.key.test(plain));
  };

  /** `key` is the object key the value sits under (array elements take their array's key). */
  const walk = (value: unknown, side: FrameSide, key: string | undefined): unknown => {
    for (const rule of neutralRules(key)) {
      const neutral = rule.neutral(value);
      if (neutral !== value) return neutral;
    }
    if (Array.isArray(value) && input.recordedModel !== undefined) {
      const model = input.recordedModel;
      const entries = value as readonly Entry[];
      // OpenCode 2.x GET /api/model: every model of every provider the user is signed in to.
      if (entriesWith(value, ["providerID", "modelID"])) return entries.filter((entry) => `${String(entry["providerID"])}/${String(entry["modelID"])}` === model).map((entry) => walk(readModelFields(entry), side, key));
      // Claude Code's initializationResult().models: the models the user's plan offers, and which is the default.
      if (entriesWith(value, ["value", "resolvedModel"])) return entries.filter((entry) => entry["value"] === model || entry["resolvedModel"] === model).map((entry) => walk(entry, side, key));
    }
    if (typeof value === "string") {
      const id = idPlaceholder(key);
      if (id !== undefined && value !== "") return id;
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
