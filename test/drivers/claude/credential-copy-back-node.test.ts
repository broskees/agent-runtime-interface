// A refreshed Claude sign-in goes back to the user's `.credentials.json`
// without losing a refresh that another Claude Code session on the same
// sign-in saves at the same moment. Claude Code saves a refreshed sign-in
// under its own write lock, the directory `.storage-write.lock` in its config
// dir, and only when the stored refresh token is still the one it used
// (docs/recordings.md, "How Claude Code finds the sign-in"). The copy-back
// that the Claude recorder and scripts/live-claude-standalone.ts use
// (test/recordings/credential-file.ts with `claudeCredentialLock`) holds the
// same lock from its comparison of the user's file to its replace.
//
// To make the other session save at exactly the moment between the
// comparison and the replace, the test patches `fs.renameSync` and carries it
// into credential-file.ts's `node:fs` import with
// `module.syncBuiltinESMExports()`, which Bun 1.3.14 does not support;
// test/bun-excluded.txt leaves this file out of the Bun run.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";
import { claudeCredentialLock } from "../../recordings/claude/record.ts";
import { copyCredentialFile, returnCredentialFile } from "../../recordings/credential-file.ts";
import { CredentialsKeptError, recoveryFileFor } from "../../recordings/recovery.ts";

/** node:fs as a CommonJS module, whose functions syncBuiltinESMExports() copies into every `node:fs` import. */
const patchableFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const realRenameSync = patchableFs.renameSync;

const temporary: string[] = [];
after(() => {
  patchableFs.renameSync = realRenameSync;
  syncBuiltinESMExports();
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

const signIn = (who: string, refreshToken: string): string => JSON.stringify({ claudeAiOauth: { accessToken: `access-${who}`, refreshToken, expiresAt: 1 } });
/** The user's sign-in when the recorder copied it. */
const ORIGINAL = signIn("original", "refresh-0");
/** What the recorded session saved in its copy after it refreshed with refresh-0. */
const RECORDED = signIn("recorded-session", "refresh-1-recorded");
/** What another Claude Code session got when it refreshed with refresh-0 too. */
const OTHER = signIn("other-session", "refresh-1-other");

interface UserConfig {
  readonly root: string;
  readonly configDir: string;
  readonly real: string;
  readonly copy: string;
}

/** A temp Claude config dir holding the user's sign-in, and a workspace for the recorder's copy. */
function userConfig(): UserConfig {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-claude-copy-back-")));
  temporary.push(root);
  const configDir = path.join(root, "user-claude");
  fs.mkdirSync(configDir, { mode: 0o700 });
  const real = path.join(configDir, ".credentials.json");
  fs.writeFileSync(real, ORIGINAL, { mode: 0o600 });
  return { root, configDir, real, copy: path.join(root, "workspace", "claude-config", ".credentials.json") };
}

/**
 * One attempt by another Claude Code session to save the sign-in it refreshed
 * with `usedRefreshToken`, as Claude Code 2.1.330 saves one: it takes its lock
 * (mkdir `<config dir>/.storage-write.lock`), reads the stored sign-in, writes
 * only when the stored refresh token is still the one it used (else it keeps
 * the stored one: "raced"), as a staged file renamed over the credential
 * file, and lets go. "locked" when the lock was held: Claude Code tries again.
 */
function otherSessionSaves(configDir: string, usedRefreshToken: string, refreshed: string): "saved" | "raced" | "locked" {
  const lock = path.join(configDir, ".storage-write.lock");
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "locked";
    throw error;
  }
  try {
    const file = path.join(configDir, ".credentials.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { claudeAiOauth?: { refreshToken?: string } };
    if (stored.claudeAiOauth?.refreshToken !== usedRefreshToken) return "raced";
    const staged = `${file}.tmp.other-session`;
    fs.writeFileSync(staged, refreshed, { mode: 0o600 });
    realRenameSync(staged, file);
    return "saved";
  } finally {
    fs.rmdirSync(lock);
  }
}

/** Every sign-in value still anywhere the user can find it: their credential file and the run's recovery file. */
function survivingSignIns(real: string): string[] {
  const recovery = recoveryFileFor(real);
  const kept = fs.existsSync(recovery) ? (JSON.parse(fs.readFileSync(recovery, "utf8")) as Array<{ value: string; olderValues?: string[] }>).flatMap((record) => [record.value, ...(record.olderValues ?? [])]) : [];
  return [fs.readFileSync(real, "utf8"), ...kept];
}

for (const moment of ["between the copy-back's comparison and its replace", "just before the copy-back compares"] as const) {
  test(`when another Claude Code session saves a refresh ${moment}, neither its refresh nor the recorded session's is lost`, () => {
    const { configDir, real, copy } = userConfig();
    const credential = copyCredentialFile(real, copy, ".credentials.json", claudeCredentialLock(real, 2_000))!;
    fs.writeFileSync(copy, RECORDED);
    const attempts: Array<"saved" | "raced" | "locked"> = [];
    let raced = false;
    if (moment === "just before the copy-back compares") {
      attempts.push(otherSessionSaves(configDir, "refresh-0", OTHER));
      raced = true;
    }
    // The copy-back's replace of the user's file is a rename onto it, after it compared the file with the original.
    patchableFs.renameSync = (from: fs.PathLike, to: fs.PathLike) => {
      if (!raced && to === real) {
        raced = true;
        attempts.push(otherSessionSaves(configDir, "refresh-0", OTHER));
      }
      realRenameSync(from, to);
    };
    syncBuiltinESMExports();
    let error: unknown;
    try {
      returnCredentialFile(credential, "Claude Code");
    } catch (thrown) {
      error = thrown;
    } finally {
      patchableFs.renameSync = realRenameSync;
      syncBuiltinESMExports();
    }
    // Claude Code tries a save again after it found the lock held (10 retries, 100 ms to 1 s apart).
    if (attempts.at(-1) === "locked") attempts.push(otherSessionSaves(configDir, "refresh-0", OTHER));

    const report = JSON.stringify({ attempts, error: error instanceof Error ? error.message : error, real: fs.readFileSync(real, "utf8") });
    assert.equal(raced, true, "the other session tried to save at that moment");
    const surviving = survivingSignIns(real);
    assert.ok(surviving.includes(RECORDED), `the recorded session's refresh survives: ${report}`);
    if (attempts.includes("saved")) assert.ok(surviving.includes(OTHER), `the refresh the other session saved survives: ${report}`);
    else assert.deepEqual(attempts, ["locked", "raced"], `the other session waited for the lock, then found the newer sign-in and kept it: ${report}`);
    if (fs.readFileSync(real, "utf8") !== RECORDED) {
      assert.ok(error instanceof CredentialsKeptError && error.recoveryFile === recoveryFileFor(real), `the copy-back says where it kept the recorded session's refresh: ${report}`);
    }
    assert.equal(fs.existsSync(path.join(configDir, ".storage-write.lock")), false, "nobody holds the lock afterwards");
    assert.deepEqual(fs.readdirSync(configDir).filter((name) => name.includes(".ari-recorder-") && name !== path.basename(recoveryFileFor(real))), [], "no staged file is left");
  });
}

test("the copy-back waits while another Claude Code session holds the lock, and writes back only after it let go", async () => {
  const { root, configDir, real, copy } = userConfig();
  const lock = path.join(configDir, ".storage-write.lock");
  const seenAtRelease = path.join(root, "seen-at-release");
  const credential = copyCredentialFile(real, copy, ".credentials.json", claudeCredentialLock(real, 20_000))!;
  fs.writeFileSync(copy, RECORDED);
  // Another Claude Code session is inside its lock, and lets go 500 ms after it started: from its own process, since the copy-back blocks this one while it waits.
  fs.mkdirSync(lock);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const holder = spawn(
    NODE_EXECUTABLE,
    ["-e", `const fs = require("node:fs"); setTimeout(() => { fs.copyFileSync(${JSON.stringify(real)}, ${JSON.stringify(seenAtRelease)}); fs.rmdirSync(${JSON.stringify(lock)}); }, 500);`],
    {
      stdio: "ignore",
      env: { PATH: process.env["PATH"] ?? "", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") },
    },
  );
  const exited = new Promise<number | null>((resolve) => holder.once("exit", resolve));
  try {
    returnCredentialFile(credential, "Claude Code");
    assert.equal(await exited, 0);
    assert.equal(fs.readFileSync(seenAtRelease, "utf8"), ORIGINAL, "while the other session held the lock, the user's file was not replaced");
    assert.equal(fs.readFileSync(real, "utf8"), RECORDED, "after it let go, the refreshed sign-in went back");
    assert.equal(fs.existsSync(recoveryFileFor(real)), false, "nothing needed the recovery file");
    assert.equal(fs.existsSync(lock), false, "the copy-back let go of the lock");
  } finally {
    if (holder.exitCode === null) holder.kill();
  }
});
