// Before it starts codex, the Codex recorder establishes where the user's
// Codex keeps its sign-in (test/recordings/codex/credential-store.ts): it
// reads only `cli_auth_credentials_store`, at the top level of four TOML
// files, the first that sets it winning. The reader must read that key as a
// TOML parser does, so that no `[`, `=` or key inside a string, an array or a
// table is taken for the setting, or hides it.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { CodexCredentialStoreError, TomlReadError, checkCodexCredentialStore, codexStoreSources, topLevelTomlValue } from "../../recordings/codex/credential-store.ts";

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

const KEY = "cli_auth_credentials_store";

test("the reader finds the top-level cli_auth_credentials_store however TOML may write it, and only there", () => {
  const cases: Array<[string, ReturnType<typeof topLevelTomlValue>]> = [
    [`${KEY} = "keyring"\n`, { kind: "string", text: "keyring" }],
    [`${KEY}='auto'`, { kind: "string", text: "auto" }],
    [`"${KEY}" = "keyring"`, { kind: "string", text: "keyring" }],
    [`'${KEY}' = "keyring"`, { kind: "string", text: "keyring" }],
    [` \t${KEY}\t=\t"keyring" # a comment\n`, { kind: "string", text: "keyring" }],
    [`${KEY} = "\\u006beyring"`, { kind: "string", text: "keyring" }],
    [`${KEY} = "\\U0000006Beyring"`, { kind: "string", text: "keyring" }],
    [`${KEY} = """keyring"""`, { kind: "string", text: "keyring" }],
    [`${KEY} = """\nkey\\\n    ring"""`, { kind: "string", text: "keyring" }],
    [`${KEY} = '''\nkeyring'''`, { kind: "string", text: "keyring" }],
    [`model = "m"\r\n${KEY} = "keyring"\r\n`, { kind: "string", text: "keyring" }],
    [`\uFEFF${KEY} = "keyring"`, { kind: "string", text: "keyring" }],
    [`${KEY} = "File"`, { kind: "string", text: "File" }],
    [`${KEY} = 1`, { kind: "other" }],
    [`${KEY} = keyring`, { kind: "other" }],
    [`${KEY} = ["keyring"]`, { kind: "other" }],
    [`${KEY}.mode = "keyring"\n${KEY}.other = 1`, { kind: "other" }],
    // Not at the top level: after a table header, a key is that table's.
    [`model = "m"\n[profiles.work]\n${KEY} = "keyring"\n`, undefined],
    [`[[skills]]\n${KEY} = "keyring"`, undefined],
    // Other keys that hold the name.
    [`${KEY}_x = "keyring"\nmcp_oauth_credentials_store = "keyring"\nx.${KEY} = "keyring"`, undefined],
    // A table header, a key or a newline inside a string, an array or an inline table is neither.
    [`notes = """\n[not a table]\n${KEY} = "file"\n"""\n${KEY} = "keyring"`, { kind: "string", text: "keyring" }],
    [`notes = '''\n[not a table]\n${KEY} = 'file'\n'''\n${KEY} = "keyring"`, { kind: "string", text: "keyring" }],
    [`quote = "say \\"[x]\\" and \\\\"\n${KEY} = "keyring"`, { kind: "string", text: "keyring" }],
    [`list = [\n  [1, 2], # [x]\n  "a,]",\n  { k = "]" },\n]\n${KEY} = "keyring"`, { kind: "string", text: "keyring" }],
    [`point = { x = 1, y = "}", z = [1] }\n${KEY} = "keyring"`, { kind: "string", text: "keyring" }],
    [`when = 1979-05-27 07:32:00Z\nflag = true\nn = -1_000.5e3\n${KEY} = "keyring"`, { kind: "string", text: "keyring" }],
    ["", undefined],
    [`# ${KEY} = "keyring"\n`, undefined],
  ];
  for (const [text, expected] of cases) assert.deepEqual(topLevelTomlValue(text, KEY), expected, JSON.stringify(text));
});

test("the reader throws, naming the line and never quoting the text, where the text is no TOML it can read or sets the store twice", () => {
  const cases: Array<[string, RegExp]> = [
    [`${KEY} = "file"\n${KEY} = "keyring"`, /^line 2: cli_auth_credentials_store is set more than once$/],
    [`${KEY} = "file"\n${KEY}.x = 1`, /^line 2: cli_auth_credentials_store is set more than once$/],
    [`model = "m"\ntoken = "sk-secret-0001\n`, /^line 2: a string does not end on its line$/],
    [`a = """never ends sk-secret-0001`, /^line 1: a multi-line string does not end$/],
    [`${KEY} = "file" "sk-secret-0001"`, /^line 1: a value is followed by more than a comment$/],
    [`${KEY} =\n`, /^line 1: a value is missing, or is none TOML has$/],
    [`${KEY} "keyring"`, /^line 1: a key has no =$/],
    [`${KEY} = "\\q"`, /^line 1: a string holds an escape TOML does not have$/],
    [`list = [1 2]`, /^line 1: an array's values are not separated by commas$/],
  ];
  for (const [text, expected] of cases) {
    assert.throws(
      () => topLevelTomlValue(text, KEY),
      (error: unknown) => error instanceof TomlReadError && expected.test(error.message) && !error.message.includes("sk-secret"),
      JSON.stringify(text),
    );
  }
});

/** A Codex home and a stand-in for /etc/codex, holding `files` (by path below a root with `home/` and `etc/`). */
function setup(files: { readonly [relative: string]: string }): { home: string; etc: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-codex-store-")));
  temporary.push(root);
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  return { home: path.join(root, "home"), etc: path.join(root, "etc") };
}

test("the store check reads the four files the pinned loader takes the store from, the one that wins first, and stops unless that one says file or none says anything", () => {
  const { home, etc } = setup({});
  assert.deepEqual(
    codexStoreSources(home, etc).map((source) => [source.file, source.role]),
    [
      [path.join(etc, "requirements.toml"), "a system requirement"],
      [path.join(etc, "managed_config.toml"), "the legacy managed configuration"],
      [path.join(home, "config.toml"), "your Codex configuration"],
      [path.join(etc, "config.toml"), "the system configuration"],
    ],
  );
  assert.deepEqual(codexStoreSources(undefined, etc).length, 3, "without a Codex home, only the system's files");
  // None of the files exists: the store is file, Codex's default.
  checkCodexCredentialStore(home, etc, path.join(home, "auth.json"));
  const stops = (files: { [relative: string]: string }): CodexCredentialStoreError | undefined => {
    const where = setup(files);
    try {
      checkCodexCredentialStore(where.home, where.etc, path.join(where.home, "auth.json"));
      return undefined;
    } catch (error) {
      assert.ok(error instanceof CodexCredentialStoreError, String(error));
      return error;
    }
  };
  assert.equal(stops({ "home/config.toml": `${KEY} = "file"\n` }), undefined);
  assert.equal(stops({ "home/config.toml": `[tui]\n${KEY} = "keyring"\n` }), undefined, "a key below a table is not the store");
  assert.match(stops({ "home/config.toml": `${KEY} = "ephemeral"\n` })!.message, /sets cli_auth_credentials_store = "ephemeral", so your Codex keeps its sign-in only in the memory of each codex process, not in /);
  assert.match(stops({ "home/config.toml": `${KEY} = "File"\n` })!.message, /sets cli_auth_credentials_store = "File", so your Codex keeps its sign-in nowhere Codex accepts \(it takes file, keyring, auto or ephemeral\)/);
  assert.match(stops({ "home/config.toml": `${KEY} = 7\n` })!.message, /sets cli_auth_credentials_store, so your Codex keeps its sign-in nowhere Codex accepts \(the setting is no string\)/);
  const unreadable = stops({ "etc/requirements.toml/occupied": "" })!;
  assert.match(unreadable.message, /^the recorder could not read .+requirements\.toml, a system requirement \(.+\), so it cannot tell whether Codex keeps your sign-in in .+auth\.json; it stopped before it started codex\./);
  const garbled = stops({ "home/config.toml": `model = "m\n${KEY} = "file"\n` })!;
  assert.match(garbled.message, /^the recorder could not read cli_auth_credentials_store from .+config\.toml, your Codex configuration \(line 1: a string does not end on its line\)/);
  assert.equal(garbled.file.endsWith(path.join("home", "config.toml")), true);
});
