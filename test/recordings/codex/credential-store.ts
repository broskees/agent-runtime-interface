// Where the user's Codex keeps its CLI sign-in. The recorder copies only the
// file `auth.json` in the user's Codex home (./credentials.ts), so before it
// starts `codex` it makes sure Codex keeps the sign-in there: it reads the one
// setting that says, `cli_auth_credentials_store`, from each file the pinned
// loader takes it from, and nothing else of those files. It never reads the
// keyring.
//
// Codex 0.172.0 on Linux (codex-rs at tag rust-v0.172.0), the file that wins
// first:
//   - `/etc/codex/requirements.toml` (config/src/loader/mod.rs:775–777), a
//     system requirement: when it sets the store, Codex uses that store
//     whatever a config.toml says (core/src/config/mod.rs:4792–4797,
//     core/src/config/auth_keyring.rs:71–73);
//   - `/etc/codex/managed_config.toml`, the legacy managed configuration
//     (config/src/loader/layer_io.rs:22, 223–232), a config layer above every
//     other (config/src/loader/mod.rs:459–484). The loader also reads it as
//     requirements, but only for approval_policy, approvals_reviewer and
//     sandbox_mode (mod.rs:1000–1037), not for the store;
//   - the user's `config.toml` in the Codex home (CODEX_HOME, else ~/.codex);
//   - `/etc/codex/config.toml`, the system configuration (mod.rs:83, 275–292).
// Set nowhere, the store is `file` (config/src/types.rs:139–149). `keyring`
// and `auto` keep the sign-in in the OS keyring (`auto` reads the file only
// when the keyring holds none or fails, login/src/auth/storage.rs:593–620), and
// `ephemeral` in Codex's memory: then an `auth.json` need not hold the sign-in
// Codex uses. A local development build (version 0.0.0) takes `keyring` and
// `auto` for `file` (core/src/config/mod.rs:307–318); the recorder does not
// count on that. It reads only these four files: macOS managed preferences,
// cloud-managed configuration (whose requirements cannot set the store,
// config/src/requirements_layers/layer.rs:13–19), a `--profile` file and `-c`
// flags are not the recorder's to read.

import * as fs from "node:fs";
import * as path from "node:path";

/** The setting that says where Codex keeps the CLI sign-in (config/src/config_toml.rs:304). */
export const CODEX_STORE_SETTING = "cli_auth_credentials_store";

/** Where the pinned loader reads the system's Codex files on Unix. */
export const CODEX_SYSTEM_CONFIG_DIR = "/etc/codex";

/** One file the loader takes the setting from, and what the file is. */
export interface CodexStoreSource {
  readonly file: string;
  readonly role: "a system requirement" | "the legacy managed configuration" | "your Codex configuration" | "the system configuration";
}

/** The files Codex takes `cli_auth_credentials_store` from, the one that wins first. */
export function codexStoreSources(codexHome: string | undefined, systemDir: string): CodexStoreSource[] {
  return [
    { file: path.join(systemDir, "requirements.toml"), role: "a system requirement" },
    { file: path.join(systemDir, "managed_config.toml"), role: "the legacy managed configuration" },
    ...(codexHome === undefined ? [] : [{ file: path.join(codexHome, "config.toml"), role: "your Codex configuration" } as const]),
    { file: path.join(systemDir, "config.toml"), role: "the system configuration" },
  ];
}

/** Codex keeps the user's sign-in somewhere other than the file the recorder copies, or the recorder cannot tell where: it stops before it starts `codex`. */
export class CodexCredentialStoreError extends Error {
  /** The file that set the store, or that the recorder could not read. */
  readonly file: string;
  constructor(message: string, file: string) {
    super(message);
    this.name = "CodexCredentialStoreError";
    this.file = file;
  }
}

/** Where Codex keeps the sign-in with the store `value`, against the file the recorder copies. */
function whereKept(value: TopLevelValue, signInFile: string): string {
  if (value.kind !== "string") return "nowhere Codex accepts (the setting is no string)";
  if (value.text === "keyring") return `in your OS keyring, not in ${signInFile}`;
  if (value.text === "auto") return `in your OS keyring, and in ${signInFile} only when the keyring fails, so that file need not hold the sign-in it uses`;
  if (value.text === "ephemeral") return `only in the memory of each codex process, not in ${signInFile}`;
  return "nowhere Codex accepts (it takes file, keyring, auto or ephemeral)";
}

const SYSTEM_ROLES: ReadonlySet<CodexStoreSource["role"]> = new Set(["a system requirement", "the legacy managed configuration", "the system configuration"]);

/**
 * Stops unless the user's Codex keeps its sign-in in `signInFile`: unless the
 * first of `codexStoreSources` that sets `cli_auth_credentials_store` sets it
 * to `file`, or none sets it. The error names the setting, the file that set
 * it and what the user can do. A source that exists but cannot be read, or
 * whose text this reader cannot read, stops it too.
 */
export function checkCodexCredentialStore(codexHome: string | undefined, systemDir: string, signInFile: string): void {
  for (const source of codexStoreSources(codexHome, systemDir)) {
    let text: string;
    try {
      text = fs.readFileSync(source.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw new CodexCredentialStoreError(
        `the recorder could not read ${source.file}, ${source.role} (${error instanceof Error ? error.message : String(error)}), so it cannot tell whether Codex keeps your sign-in in ${signInFile}; it stopped before it started codex. Make the file readable, then record again. See "How Codex finds the sign-in" in docs/recordings.md.`,
        source.file,
      );
    }
    let value: TopLevelValue | undefined;
    try {
      value = topLevelTomlValue(text, CODEX_STORE_SETTING);
    } catch (error) {
      throw new CodexCredentialStoreError(
        `the recorder could not read ${CODEX_STORE_SETTING} from ${source.file}, ${source.role} (${error instanceof Error ? error.message : String(error)}), so it cannot tell whether Codex keeps your sign-in in ${signInFile}; it stopped before it started codex. See "How Codex finds the sign-in" in docs/recordings.md.`,
        source.file,
      );
    }
    if (value === undefined) continue;
    if (value.kind === "string" && value.text === "file") return;
    const setting = value.kind === "string" ? `${CODEX_STORE_SETTING} = ${JSON.stringify(value.text)}` : CODEX_STORE_SETTING;
    const machines = SYSTEM_ROLES.has(source.role) ? " (the file is the machine's, not yours: that needs root)" : "";
    const change = `set ${CODEX_STORE_SETTING} = "file" in ${source.file}, or remove the line${machines}, and sign in again with \`codex login\``;
    throw new CodexCredentialStoreError(
      `${source.file}, ${source.role}, sets ${setting}, so your Codex keeps its sign-in ${whereKept(value, signInFile)}. The recorder copies only ${signInFile} and never reads your keyring, so it stopped before it started codex. To record, ${change}, then record again. See "How Codex finds the sign-in" in docs/recordings.md.`,
      source.file,
    );
  }
}

/** A top-level TOML value: a string's text, or another kind of value (a number, a date, an array, a table). */
export type TopLevelValue = { readonly kind: "string"; readonly text: string } | { readonly kind: "other" };

/** The text is no TOML this reader can read. */
export class TomlReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlReadError";
  }
}

const ESCAPES: { readonly [letter: string]: string } = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", '"': '"', "\\": "\\" };
const BARE_KEY = /[A-Za-z0-9_-]/;
/** What ends a value that is no string, array or table: a number, a boolean, a date. */
const SCALAR_END = /[ \t\r\n,\]}#]/;

/**
 * The value `key` has at the top level of the TOML document `text` (in the
 * keys before its first table header), or undefined when it has none there.
 * A minimal reader, exact for what it reads: it reads the top level key by
 * key, every kind of string (with its escapes), arrays, inline tables,
 * comments and the other values, so a `[` or a `key =` inside a string or an
 * array is never taken for a table header or a key. It stops at the first
 * table header, after which a key belongs to that table. It throws a
 * TomlReadError, naming the line, where the text is not TOML it can read, and
 * when `key` is set twice. The error never quotes the text.
 */
export function topLevelTomlValue(text: string, key: string): TopLevelValue | undefined {
  let at = text.startsWith("\uFEFF") ? 1 : 0;
  const fail = (why: string): never => {
    throw new TomlReadError(`line ${text.slice(0, at).split("\n").length}: ${why}`);
  };
  const skipSpaces = (): void => {
    while (text[at] === " " || text[at] === "\t") at += 1;
  };
  const skipComment = (): void => {
    if (text[at] === "#") while (at < text.length && text[at] !== "\n") at += 1;
  };
  /** Takes a newline, if one is next. */
  const newline = (): boolean => {
    if (text[at] === "\n") at += 1;
    else if (text.startsWith("\r\n", at)) at += 2;
    else return false;
    return true;
  };
  /** Spaces, comments and newlines, as between the values of an array. */
  const skipBlank = (): void => {
    do {
      skipSpaces();
      skipComment();
    } while (newline());
  };

  const escape = (): string => {
    const letter = text[at];
    at += 1;
    if (letter !== undefined && ESCAPES[letter] !== undefined) return ESCAPES[letter];
    const digits = letter === "u" ? 4 : letter === "U" ? 8 : letter === "x" ? 2 : 0;
    const hex = text.slice(at, at + digits);
    if (digits === 0 || !new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(hex)) return fail("a string holds an escape TOML does not have");
    at += digits;
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return fail("a string escapes no Unicode scalar value");
    return String.fromCodePoint(code);
  };
  const basicString = (): string => {
    at += 1;
    let out = "";
    for (;;) {
      const char = text[at];
      if (char === undefined || char === "\n" || char === "\r") return fail("a string does not end on its line");
      at += 1;
      if (char === '"') return out;
      out += char === "\\" ? escape() : char;
    }
  };
  const literalString = (): string => {
    at += 1;
    const end = text.indexOf("'", at);
    if (end === -1 || /[\r\n]/.test(text.slice(at, end))) return fail("a string does not end on its line");
    const out = text.slice(at, end);
    at = end + 1;
    return out;
  };
  /** A `"""` or `'''` string: a newline right after the opening is not part of it; up to two quotes right before the closing are. */
  const multilineString = (quote: '"' | "'"): string => {
    const delimiter = quote.repeat(3);
    at += 3;
    newline();
    let out = "";
    for (;;) {
      if (at >= text.length) return fail("a multi-line string does not end");
      if (text.startsWith(delimiter, at)) {
        let quotes = 3;
        while (quotes < 5 && text[at + quotes] === quote) quotes += 1;
        at += quotes;
        return out + quote.repeat(quotes - 3);
      }
      const char = text[at]!;
      at += 1;
      if (quote === "'" || char !== "\\") {
        out += char;
        continue;
      }
      // A backslash that ends a line takes the newline and every space and newline after it.
      let after = at;
      while (text[after] === " " || text[after] === "\t") after += 1;
      if (text[after] === "\n" || text.startsWith("\r\n", after)) {
        at = after;
        while (at < text.length && /[ \t\r\n]/.test(text[at]!)) at += 1;
        continue;
      }
      out += escape();
    }
  };

  const simpleKey = (): string => {
    if (text.startsWith('"""', at) || text.startsWith("'''", at)) return fail("a key is a multi-line string");
    if (text[at] === '"') return basicString();
    if (text[at] === "'") return literalString();
    const start = at;
    while (at < text.length && BARE_KEY.test(text[at]!)) at += 1;
    if (at === start) return fail("a key is missing");
    return text.slice(start, at);
  };
  /** A key, dotted or not, as its parts. */
  const dottedKey = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipSpaces();
      parts.push(simpleKey());
      skipSpaces();
      if (text[at] !== ".") return parts;
      at += 1;
    }
  };

  const scalar = (): void => {
    const start = at;
    while (at < text.length && !SCALAR_END.test(text[at]!)) at += 1;
    // A date and a time may stand apart, with a space where the T goes: 1979-05-27 07:32:00Z.
    if (/^\d{4}-\d{2}-\d{2}$/.test(text.slice(start, at)) && text[at] === " " && /^\d{2}:/.test(text.slice(at + 1, at + 4))) {
      at += 1;
      while (at < text.length && !SCALAR_END.test(text[at]!)) at += 1;
    }
    if (!/^[A-Za-z0-9+\-._: ]+$/.test(text.slice(start, at))) fail("a value is missing, or is none TOML has");
  };
  const array = (): void => {
    at += 1;
    for (;;) {
      skipBlank();
      if (text[at] === "]") {
        at += 1;
        return;
      }
      value();
      skipBlank();
      if (text[at] === ",") at += 1;
      else if (text[at] === "]") {
        at += 1;
        return;
      } else fail("an array's values are not separated by commas");
    }
  };
  const inlineTable = (): void => {
    at += 1;
    for (;;) {
      skipBlank();
      if (text[at] === "}") {
        at += 1;
        return;
      }
      dottedKey();
      if (text[at] !== "=") fail("a key in an inline table has no =");
      at += 1;
      skipSpaces();
      value();
      skipBlank();
      if (text[at] === ",") at += 1;
      else if (text[at] === "}") {
        at += 1;
        return;
      } else fail("an inline table's keys are not separated by commas");
    }
  };
  const value = (): TopLevelValue => {
    if (text.startsWith('"""', at)) return { kind: "string", text: multilineString('"') };
    if (text.startsWith("'''", at)) return { kind: "string", text: multilineString("'") };
    if (text[at] === '"') return { kind: "string", text: basicString() };
    if (text[at] === "'") return { kind: "string", text: literalString() };
    if (text[at] === "[") array();
    else if (text[at] === "{") inlineTable();
    else scalar();
    return { kind: "other" };
  };

  let found: TopLevelValue | undefined;
  /** `key` was set as a table (`key.x = 1`), which TOML lets more than one line do. */
  let asTable = false;
  for (;;) {
    skipBlank();
    if (at >= text.length || text[at] === "[") return found;
    const parts = dottedKey();
    if (text[at] !== "=") fail("a key has no =");
    at += 1;
    skipSpaces();
    const each = value();
    if (parts[0] === key) {
      const table = parts.length > 1;
      if (found !== undefined && !(table && asTable)) fail(`${key} is set more than once`);
      found = table ? { kind: "other" } : each;
      asTable = table;
    }
    skipSpaces();
    skipComment();
    if (at < text.length && !newline()) fail("a value is followed by more than a comment");
  }
}
