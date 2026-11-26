// The verifier's reproduction of the copy-back race, through the Codex
// recorder: the fake codex rotates the refresh token, and another codex
// saves its own refresh of the user's sign-in at the very moment between the
// copy-back's comparison of the user's `auth.json` and its replace. Codex
// 0.172.0 saves a refresh only under flock(2) on `auth.lock` in its home, and
// only while the stored sign-in is still the one it refreshed
// (codex-rs/login/src/auth/storage.rs:189–212, manager.rs:1768–1802); it
// waits for the lock as long as another holds it. Neither refresh may be
// lost.
//
// To act at exactly that moment, the test patches `fs.renameSync` and carries
// it into test/recordings/credential-file.ts's `node:fs` import with
// `module.syncBuiltinESMExports()`, which Bun 1.3.14 does not support;
// test/bun-excluded.txt leaves this file out of the Bun run. The other codex
// is a child process, `flock` on the same `auth.lock`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";
import { recordCodex } from "../../recordings/codex/record.ts";
import { recoveryFileFor } from "../../recordings/recovery.ts";
import { FAKE_SIGN_IN, fakeCodexOnPath } from "./fake-codex.ts";

/** node:fs as a CommonJS module, whose functions syncBuiltinESMExports() copies into every `node:fs` import. */
const patchableFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const realRenameSync = patchableFs.renameSync;

const DIRECTORY = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-codex-copy-back-")));
after(() => {
  patchableFs.renameSync = realRenameSync;
  syncBuiltinESMExports();
  fs.rmSync(DIRECTORY, { recursive: true, force: true });
});

const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const withRefreshToken = (refreshToken: string): string => {
  const auth = JSON.parse(FAKE_SIGN_IN) as { tokens: { [key: string]: unknown } };
  return JSON.stringify({ ...auth, tokens: { ...auth.tokens, refresh_token: refreshToken } }, null, 2);
};
/** The user's sign-in when the recorder copied it: FAKE_SIGN_IN, refresh token fake-refresh-0001. */
const USED = "fake-refresh-0001";
/** What another codex got when it refreshed with fake-refresh-0001 too. */
const OTHER = withRefreshToken("fake-refresh-other-codex");

const refreshTokenOf = (text: string): unknown => (JSON.parse(text) as { tokens?: { refresh_token?: unknown } }).tokens?.refresh_token;

/**
 * One attempt by another codex to save the sign-in it refreshed with
 * fake-refresh-0001, as Codex 0.172.0 saves one: under flock on `auth.lock`
 * it reads the stored sign-in and writes only while its refresh token is
 * still the one it used ("raced" else), a new file renamed over the old.
 * "locked" when the lock was held and `wait` is false: Codex would wait.
 */
function otherCodexSaves(codexHome: string, wait: boolean): "saved" | "raced" | "locked" {
  const save = `const fs = require("node:fs"); const [file, used, refreshed] = process.argv.slice(1); if (JSON.parse(fs.readFileSync(file, "utf8")).tokens?.refresh_token !== used) process.exit(3); fs.writeFileSync(file + ".other-codex", refreshed, { mode: 0o600 }); fs.renameSync(file + ".other-codex", file);`;
  const run = spawnSync("flock", [...(wait ? [] : ["--nonblock"]), "--conflict-exit-code", "4", path.join(codexHome, "auth.lock"), NODE_EXECUTABLE, "-e", save, path.join(codexHome, "auth.json"), USED, OTHER], { encoding: "utf8", env: { PATH, HOME: DIRECTORY } });
  if (run.status === 0) return "saved";
  if (run.status === 3) return "raced";
  if (run.status === 4) return "locked";
  throw new Error(`the other codex's save failed: ${run.status} ${run.stderr} ${run.error?.message ?? ""}`);
}

/** Every sign-in value still anywhere the user can find it: their auth.json and the run's recovery file. */
function survivingSignIns(real: string): string[] {
  const recovery = recoveryFileFor(real);
  const kept = fs.existsSync(recovery) ? (JSON.parse(fs.readFileSync(recovery, "utf8")) as Array<{ value: string; olderValues?: string[] }>).flatMap((record) => [record.value, ...(record.olderValues ?? [])]) : [];
  return [fs.readFileSync(real, "utf8"), ...kept];
}

test("when another codex saves a refresh between the copy-back's comparison of the user's auth.json and its replace, neither its refresh nor the recorded codex's is lost", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(DIRECTORY, "user-home-")));
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(codexHome, { mode: 0o700 });
  const real = path.join(codexHome, "auth.json");
  fs.writeFileSync(real, FAKE_SIGN_IN, { mode: 0o600 });
  const fake = fakeCodexOnPath(DIRECTORY);
  const attempts: Array<"saved" | "raced" | "locked"> = [];
  // The copy-back's replace of the user's file is a rename onto it, after it compared the file with the original.
  patchableFs.renameSync = (from: fs.PathLike, to: fs.PathLike) => {
    if (attempts.length === 0 && to === real) attempts.push(otherCodexSaves(codexHome, false));
    realRenameSync(from, to);
  };
  syncBuiltinESMExports();
  let outcomes;
  try {
    outcomes = await recordCodex({
      scenarios: ["simple"],
      outDir: fs.mkdtempSync(path.join(DIRECTORY, "out-")),
      source: "fake",
      env: { PATH: `${fake.bin}${path.delimiter}${PATH}`, USER: "ari-test-user", HOME: home, ...fake.env, ARI_FAKE_CODEX_ROTATE: "fake-refresh-recorded-codex" },
      timeoutMs: 20_000,
      systemConfigDir: path.join(DIRECTORY, "no-etc-codex"),
    });
  } finally {
    patchableFs.renameSync = realRenameSync;
    syncBuiltinESMExports();
  }
  // Codex waits for its lock; once the recorder let go, the other codex tries again.
  if (attempts.at(-1) === "locked") attempts.push(otherCodexSaves(codexHome, true));

  const outcome = outcomes[0]!;
  const report = JSON.stringify({ attempts, error: outcome.error?.message, real: refreshTokenOf(fs.readFileSync(real, "utf8")), recovery: fs.existsSync(recoveryFileFor(real)) });
  assert.ok(attempts.length > 0, `the other codex tried to save at that moment: ${report}`);
  const surviving = survivingSignIns(real);
  assert.ok(surviving.some((text) => refreshTokenOf(text) === "fake-refresh-recorded-codex"), `the recorded codex's refresh survives: ${report}`);
  if (attempts.includes("saved")) assert.ok(surviving.includes(OTHER), `the refresh the other codex saved survives: ${report}`);
  else assert.deepEqual(attempts, ["locked", "raced"], `the other codex waited for the lock, then found the newer sign-in and kept it: ${report}`);
  if (refreshTokenOf(fs.readFileSync(real, "utf8")) !== "fake-refresh-recorded-codex") assert.equal(outcome.recoveryFile, recoveryFileFor(real), `the run says where it kept the recorded codex's refresh: ${report}`);
  else assert.equal(outcome.error, undefined, report);
  assert.equal(spawnSync("flock", ["--nonblock", path.join(codexHome, "auth.lock"), "true"], { env: { PATH } }).status, 0, "nobody holds Codex's lock afterwards");
  assert.deepEqual(fs.readdirSync(codexHome).filter((name) => name.includes(".ari-recorder-") && name !== path.basename(recoveryFileFor(real))), [], "no staged file is left");
  assert.ok(!fs.existsSync(outcome.workspace), "the workspace is removed");
});
