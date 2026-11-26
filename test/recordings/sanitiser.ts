// The one sanitiser every recorder runs each frame through before it writes,
// and every replay runs each outbound frame through before it compares, so
// both sides are compared in the same placeholder form.
//
// It replaces, in every string and every object key (a frame's own format
// fields, `dir`, `kind`, `query`, `id`, `method` and `contentType`, stay as
// the tap wrote them when they hold a string, a number, a boolean or null):
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
//     (NEUTRAL_SOCKET_PATH), the machine's shell (NEUTRAL_SHELL), a quota's
//     figures (0) and reset time (NEUTRAL_TIME), a credit balance (0), and
//     whether the user is signed in to a provider (true) or must sign in
//     (false);
//   - which providers the user is signed in to: a list whose every entry
//     holds a sign-in status, with [];
//   - ACP's usage figures, with 0: a `usage_update`'s tokens in context and
//     context window, a Cost's amount, and a Usage's token counts;
//   - with `recordedModel`, a model list keeps only the recorded model: in
//     OpenCode 2.x's `GET /api/model` answer (an array of objects with a
//     string providerID and modelID) with only the fields a driver reads, so
//     which providers the user is signed in to, and how, stays out; in Claude
//     Code's `initializationResult().models` (objects with a string value and
//     resolvedModel) whole, so the models the user's plan offers stay out; in
//     an ACP agent's model picker (a session config option of category
//     `model`) with the option's current value too, which the driver reads;
//   - the OS user name (os.userInfo().username, and the values of USER and
//     LOGNAME where they differ) with <USER>. How depends on what the string
//     is:
//       - in an inbound frame (what the agent and the machine produced: tool
//         output, assistant text, stderr, file contents, a tool's name),
//         every whole-word occurrence, in every string value, except a value
//         that is one of the protocol words of its key at its place: where
//         the pinned types put that word at that path of keys from the frame,
//         in the object type the object's own discriminant names (the driver
//         kit's `protocolWords`, ./protocol-places.ts; for Claude derived from
//         the pinned sdk.d.ts). So the owner column of an `ls -l` is
//         replaced, `type: "user"` of an SDK message stays on an account
//         named `user`, `name: "memory"` inside an opaque tool result goes on
//         an account named `memory`, and `name: "web_search"` of a
//         `tool_use` block goes on an account named `web_search` (only a
//         `server_tool_use` block's name may be that word);
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
import { FRAME_PLACE, slotAt, slotIn } from "./protocol-places.ts";
import type { ProtocolSlot, ProtocolWords } from "./protocol-places.ts";

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
 * The neutral rate-limit windows of a Codex rate-limit snapshot
 * (`RateLimitWindow`, under `primary` and `secondary`): nothing used, resetting
 * at NEUTRAL_TIME, a 5-hour primary and a weekly secondary window, the two the
 * Codex driver names (`5h`, `weekly`).
 */
export const NEUTRAL_RATE_LIMIT_WINDOWS = {
  primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: NEUTRAL_TIME.seconds },
  secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: NEUTRAL_TIME.seconds },
} as const;
/** The neutral credit balance of a Codex rate-limit snapshot (`CreditsSnapshot`, under `credits`): none, not unlimited, a balance of "0". */
export const NEUTRAL_CODEX_CREDITS = { hasCredits: false, unlimited: false, balance: "0" } as const;
/** The neutral spend-control limit of a Codex rate-limit snapshot (`SpendControlLimitSnapshot`, under `individualLimit`). */
export const NEUTRAL_SPEND_CONTROL_LIMIT = { limit: "0", remainingPercent: 0, resetsAt: NEUTRAL_TIME.seconds, used: "0" } as const;
/** The neutral reset credits of a Codex usage read (`RateLimitResetCreditsSummary`, under `rateLimitResetCredits`). */
export const NEUTRAL_RESET_CREDITS = { availableCount: 0, credits: [] } as const;

/** A key that says whether the user is signed in to a provider, compared without case, `-` or `_`. */
const SIGN_IN_STATUS_KEY = /^(?:is)?(?:signedin|loggedin|authenticated)$/;

/** A time as the neutral time of the same type: an ISO string, or seconds or milliseconds since the epoch by its size. */
function neutralTime(value: unknown): unknown {
  return typeof value === "string" ? NEUTRAL_TIME.iso : typeof value === "number" ? (value > 100_000_000_000 ? NEUTRAL_TIME.milliseconds : NEUTRAL_TIME.seconds) : value;
}

/** A figure as 0 of the same type: the number 0, or "0" for a number written as a string (a protobuf int64 in JSON). */
function neutralFigure(value: unknown): unknown {
  return typeof value === "number" ? 0 : typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) ? "0" : value;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A Codex rate-limit window (an object with a number `usedPercent`) as the neutral window of its place, `primary` or `secondary`. */
function neutralWindow(which: "primary" | "secondary"): (value: unknown) => unknown {
  return (value) => (isRecord(value) && typeof value["usedPercent"] === "number" ? { ...NEUTRAL_RATE_LIMIT_WINDOWS[which] } : value);
}

/**
 * Account details replaced whole by a fixed neutral value of the same type,
 * keyed on the field. A key is compared without case, `-` or `_`; a value of
 * another type than the rule's stays as it is.
 */
export const NEUTRAL_FIELD_RULES: ReadonlyArray<{ readonly what: string; readonly key: RegExp; readonly neutral: (value: unknown) => unknown }> = [
  // Claude Code's `subscriptionType` ("Claude Max") in initializationResult().account, and other names of a plan.
  // `userTier`, `userTierId` and `tierName` are the names the Antigravity CLI 1.5.17 binary gives the account's plan tier.
  { what: "plan name", key: /^(?:subscriptiontype|subscriptionplan|subscriptiontier|planname|plantype|plantier|ratelimittier|usertier|usertierid|tiername)$/, neutral: (value) => (typeof value === "string" ? PLACEHOLDERS.plan : value) },
  // Claude Code's rate_limit_event: status, window, utilization, reset time, threshold and overage state.
  { what: "rate-limit report", key: /^ratelimitinfo$/, neutral: (value) => (typeof value === "object" && value !== null && !Array.isArray(value) ? { ...NEUTRAL_RATE_LIMIT_INFO } : value) },
  // Claude Code's `credential_expires_at` in result messages, and other credential expiry times.
  { what: "credential expiry", key: /(?:credential|token|oauth|auth|login)expir(?:es|y|ation)(?:at|time)?$/, neutral: neutralTime },
  // A quota's figures, as the Antigravity CLI 1.5.17 binary names them for a quota bucket (`remainingFraction`, `remainingAmount`): 0.
  { what: "quota figure", key: /^(?:remaining|used|consumed)(?:fraction|amount)$/, neutral: neutralFigure },
  // A quota's or rate limit's reset time (the binary's `resetTime`): NEUTRAL_TIME.
  { what: "quota reset time", key: /^(?:quota)?resets?(?:time|at)$/, neutral: neutralTime },
  // A credit balance, as the binary names its credit figures (`usedPromptCredits`, `availableFlowCredits`, `monthlyPromptCredits`, `consumedCredits`, `availableCredits`): 0.
  { what: "credit balance", key: /credits$/, neutral: neutralFigure },
  // Codex's credit balance, a rate-limit snapshot's `credits` (CreditsSnapshot: hasCredits, unlimited, balance): replaced whole.
  { what: "Codex credit balance", key: /^credits$/, neutral: (value) => (isRecord(value) && typeof value["hasCredits"] === "boolean" ? { ...NEUTRAL_CODEX_CREDITS } : value) },
  // Codex's rate-limit windows, a rate-limit snapshot's `primary` and `secondary` (RateLimitWindow: usedPercent, windowDurationMins, resetsAt): replaced whole.
  { what: "Codex rate-limit window", key: /^primary$/, neutral: neutralWindow("primary") },
  { what: "Codex rate-limit window", key: /^secondary$/, neutral: neutralWindow("secondary") },
  // Codex's spend-control limit (SpendControlLimitSnapshot: limit, remainingPercent, resetsAt, used): replaced whole.
  { what: "Codex spend-control limit", key: /^individuallimit$/, neutral: (value) => (isRecord(value) && typeof value["remainingPercent"] === "number" ? { ...NEUTRAL_SPEND_CONTROL_LIMIT } : value) },
  // Codex's rate-limit reset credits (RateLimitResetCreditsSummary: availableCount, credits): none.
  { what: "Codex reset credits", key: /^ratelimitresetcredits$/, neutral: (value) => (isRecord(value) && typeof value["availableCount"] === "number" ? { ...NEUTRAL_RESET_CREDITS, credits: [] } : value) },
  // A usage percentage anywhere else (Codex's usedPercent and remainingPercent): 0.
  { what: "usage percentage", key: /^(?:used|remaining)percent$/, neutral: neutralFigure },
  // Whether the account reached a limit (Codex's rateLimitReachedType, spendControlReached): not reached.
  { what: "limit reached", key: /^ratelimitreachedtype$/, neutral: (value) => (typeof value === "string" ? null : value) },
  { what: "limit reached", key: /^spendcontrolreached$/, neutral: (value) => (typeof value === "boolean" ? false : value) },
  // Whether the user is signed in to a provider (the binary's `isAuthenticated`; `signedIn`, `loggedIn`): always true.
  { what: "sign-in status", key: SIGN_IN_STATUS_KEY, neutral: (value) => (typeof value === "boolean" ? true : value) },
  // Whether a provider still needs the user to sign in (the binary's `needs_auth`): always false.
  { what: "sign-in needed", key: /^needs(?:auth|signin|login)$/, neutral: (value) => (typeof value === "boolean" ? false : value) },
  { what: "process id", key: /^(?:pid|ppid|processid)$/, neutral: (value) => (typeof value === "number" ? NEUTRAL_PID : value) },
  // OpenCode's `GET /api/info` paths.tmp, which names the temp directory of the machine's session.
  { what: "temp directory", key: /^(?:tmp|tmpdir|temp|tempdir|tmppath|temppath)$/, neutral: (value) => (typeof value === "string" ? NEUTRAL_TMP_PATH : value) },
  // Claude Code's `messaging_socket_path`, /tmp/cc-socks/<pid>.sock.
  { what: "socket path", key: /socket(?:path|file)$/, neutral: (value) => (typeof value === "string" ? NEUTRAL_SOCKET_PATH : value) },
  // OpenCode's `shell.created` event: the path of the shell the command ran in, the user's login shell.
  { what: "shell", key: /^shell$/, neutral: (value) => (typeof value === "string" && /^(?:[/\\]|[A-Za-z]:[/\\])/.test(value) ? NEUTRAL_SHELL : value) },
  // Codex's `initialize` answer names the client's operating system, its version, the architecture and the terminal after the product (`codex_cli_rs/0.172.0 (Arch Linux Rolling; x86_64) xterm-256color`): only the product and its version stay.
  { what: "user agent", key: /^useragent$/, neutral: (value) => (typeof value === "string" && /\s/.test(value.trim()) ? value.trim().split(/\s+/)[0] : value) },
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

/**
 * An ACP session config option of category `model` (an ACP agent's model
 * picker, such as `agy acp`'s) with only the values a replay needs: the
 * recorded model and the value the option currently holds, which the driver
 * compares before it changes the model. The other values are the models the
 * user's account offers. Grouped values keep the same members; a group left
 * empty goes.
 */
function acpModelOptionWith(option: Entry, model: string): Entry {
  const kept = new Set([model, option["currentValue"]]);
  const values = (option["options"] as readonly unknown[]).flatMap((entry): unknown[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const members = (entry as Entry)["options"];
    if (Array.isArray(members)) {
      const inGroup = members.filter((member) => typeof member === "object" && member !== null && kept.has((member as Entry)["value"]));
      return inGroup.length === 0 ? [] : [{ ...(entry as Entry), options: inGroup }];
    }
    return kept.has((entry as Entry)["value"]) ? [entry] : [];
  });
  return { ...option, options: values };
}

/** A key as the rules compare it: without case, `-` or `_`. */
function plainKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

/** A list of providers, each with whether the user is signed in to it: which providers the user is signed in to. */
function isSignInList(value: readonly unknown[]): boolean {
  return value.length > 0 && value.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) && Object.keys(entry).some((field) => SIGN_IN_STATUS_KEY.test(plainKey(field))));
}

/** The token counts of an ACP Usage (the unstable `usage` of a prompt's result). */
const ACP_USAGE_TOKEN_FIELDS = ["totalTokens", "inputTokens", "outputTokens", "thoughtTokens", "cachedReadTokens", "cachedWriteTokens"] as const;

/**
 * An ACP usage report with its figures 0, keyed on ACP's fields: in a
 * `usage_update` session update (UsageUpdate) the tokens in context, `used`,
 * and the context window's `size`; in a Cost (`amount` and `currency`, under
 * `cost`) the `amount`; in a Usage (under `usage`, with `totalTokens`,
 * `inputTokens` and `outputTokens`) every token count. Anything else stays.
 */
function withNeutralAcpUsage(entry: Entry, key: string | undefined): Entry {
  const zeroed = (fields: readonly string[]): Entry => ({ ...entry, ...Object.fromEntries(fields.filter((field) => typeof entry[field] === "number").map((field) => [field, 0])) });
  if (entry["sessionUpdate"] === "usage_update") return zeroed(["used", "size"]);
  if (key === "cost" && typeof entry["amount"] === "number" && typeof entry["currency"] === "string") return zeroed(["amount"]);
  if (key === "usage" && ["totalTokens", "inputTokens", "outputTokens"].every((field) => typeof entry[field] === "number")) return zeroed(ACP_USAGE_TOKEN_FIELDS);
  return entry;
}

/** A key whose value identifies an account, compared without case, `-` or `_`: `chatgpt-account-id`, `account_id`, `accountUuid`. */
export const ACCOUNT_ID_KEY = /accountid$|accountuuid$/;
/** A key whose value identifies an organisation, compared the same way: `x-opencode-org-id`, `organization_id`, `organizationUuid`. */
export const ORG_ID_KEY = /(?:org|organization|organisation)(?:id|uuid)$/;

/** The placeholder for the value under `key` when the key names an account or organisation id. */
function idPlaceholder(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const plain = plainKey(key);
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
  /** The words the pinned types allow, by place (./protocol-places.ts); an inbound value that is one of its place's key's words keeps the user name. */
  readonly protocolWords?: ProtocolWords;
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
export const FRAME_FORMAT_FIELDS: ReadonlySet<string> = new Set(["dir", "kind", "query", "id", "method", "contentType"]);

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

/** What Bun 1.3.14's os.userInfo() reports as the user name when neither USER nor LOGNAME is set. */
const BUN_UNKNOWN_USER = "unknown";

/** The name /etc/passwd gives the user id `uid`, if the file has it (it has every local account on Linux; macOS keeps people elsewhere). */
function passwdName(uid: number): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync("/etc/passwd", "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    const [name, , id] = line.split(":");
    if (name !== undefined && name !== "" && id !== undefined && Number(id) === uid) return name;
  }
  return undefined;
}

/**
 * The OS user's name: os.userInfo().username, except where that is Bun's
 * "unknown" (Bun 1.3.14 takes the name from USER and LOGNAME, and reports
 * "unknown" when a launcher strips both). Then the name the user's id has in
 * /etc/passwd, else the name of the home directory when the user owns it.
 */
export function osUserName(): string | undefined {
  let info: os.UserInfo<string> | undefined;
  try {
    info = os.userInfo();
  } catch {
    info = undefined;
  }
  const reported = info?.username;
  if (reported !== undefined && reported !== "" && reported !== BUN_UNKNOWN_USER) return reported;
  const uid = typeof process.getuid === "function" ? process.getuid() : info?.uid;
  if (uid === undefined || uid < 0) return reported === "" ? undefined : reported;
  const named = passwdName(uid);
  if (named !== undefined) return named;
  const home = info?.homedir ?? os.homedir();
  try {
    if (home !== "" && fs.statSync(home).uid === uid) return home.split(/[/\\]/).filter((segment) => segment !== "").at(-1) ?? reported;
  } catch {
    // No home to look at.
  }
  return reported === "" ? undefined : reported;
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
  const names = [input.user ?? osUserName(), input.env["USER"], input.env["LOGNAME"]];
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
  const protocolWords: ProtocolWords = input.protocolWords ?? {};

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
    const plain = plainKey(key);
    return NEUTRAL_FIELD_RULES.filter((rule) => rule.key.test(plain));
  };

  /**
   * `key` is the object key the value sits under (array elements take their
   * array's key), and `slot` what the pinned types say of that key at the
   * value's place (undefined at an opaque place).
   */
  const walk = (value: unknown, side: FrameSide, key: string | undefined, slot: ProtocolSlot | undefined): unknown => {
    for (const rule of neutralRules(key)) {
      const neutral = rule.neutral(value);
      if (neutral !== value) return neutral;
    }
    // Which providers the user is signed in to: the list goes whole, the provider the recording used too.
    if (Array.isArray(value) && isSignInList(value)) return [];
    if (Array.isArray(value) && input.recordedModel !== undefined) {
      const model = input.recordedModel;
      const entries = value as readonly Entry[];
      // OpenCode 2.x GET /api/model: every model of every provider the user is signed in to.
      if (entriesWith(value, ["providerID", "modelID"])) return entries.filter((entry) => `${String(entry["providerID"])}/${String(entry["modelID"])}` === model).map((entry) => walk(readModelFields(entry), side, key, slot));
      // Claude Code's initializationResult().models: the models the user's plan offers, and which is the default.
      if (entriesWith(value, ["value", "resolvedModel"])) return entries.filter((entry) => entry["value"] === model || entry["resolvedModel"] === model).map((entry) => walk(entry, side, key, slot));
    }
    if (typeof value === "string") {
      const id = idPlaceholder(key);
      if (id !== undefined && value !== "") return id;
      const protocolWord = slot?.words?.includes(value) === true;
      return text(value, side === "in" && !protocolWord ? "word" : "path");
    }
    if (Array.isArray(value)) return value.map((each) => walk(each, side, key, slot));
    if (typeof value === "object" && value !== null) {
      // An ACP agent's model picker: only the recorded model and the current one stay.
      const picked = input.recordedModel !== undefined && (value as Entry)["category"] === "model" && Array.isArray((value as Entry)["options"]) ? acpModelOptionWith(value as Entry, input.recordedModel) : (value as Entry);
      const source = withNeutralAcpUsage(picked, key);
      const out: { [key: string]: unknown } = {};
      for (const [field, entry] of Object.entries(source)) out[text(field, "path")] = walk(entry, side, field, slotIn(protocolWords, slot, source, field));
      return out;
    }
    return value;
  };

  return <T>(value: T, side?: FrameSide): T => {
    if (side === undefined && isFrame(value)) {
      const out: { [key: string]: unknown } = {};
      for (const [field, entry] of Object.entries(value)) {
        const kept = FRAME_FORMAT_FIELDS.has(field) && isScalar(entry);
        out[FRAME_FORMAT_FIELDS.has(field) ? field : text(field, "path")] = kept ? entry : walk(entry, value.dir, field, slotAt(protocolWords, FRAME_PLACE, field));
      }
      return out as T;
    }
    // A value that is no frame has no place the pinned types describe.
    return walk(value, side ?? "in", undefined, undefined) as T;
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
