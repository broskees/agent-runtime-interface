// A refreshed Codex sign-in goes back to the user's `auth.json` under Codex's
// own locks: `auth.lock` in its home and the commit lock beside the resolved
// target. Here another codex is a `flock` process, which takes the same lock
// as Rust's File::lock on Linux.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { copyCodexSignIn, returnCodexSignIn } from "../../recordings/codex/record.ts";
import { takeCodexSignInLock } from "../../recordings/codex/sign-in-lock.ts";
import { CredentialsKeptError, recoveryFileFor } from "../../recordings/recovery.ts";
import { dyingHolderBin, lockHolderBin } from "../../helpers/lock-holder-bins.ts";

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

const ENV = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
const signIn = (refreshToken: string): string => JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "fake-id-token", access_token: "fake-access-token", refresh_token: refreshToken, account_id: "fake-account" } }, null, 2);
const ORIGINAL = signIn("fake-refresh-0001");
const RECORDED = signIn("fake-refresh-recorded");

/** A user's Codex home holding ORIGINAL, and the recorder's copy of it, which the recorded codex refreshed to RECORDED. */
function refreshedCopy(linked = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-codex-lock-")));
  temporary.push(root);
  const codexHome = path.join(root, "user-codex");
  fs.mkdirSync(codexHome, { mode: 0o700 });
  const real = path.join(codexHome, "auth.json");
  const target = linked ? path.join(root, "shared.credentials") : real;
  fs.writeFileSync(target, ORIGINAL, { mode: 0o600 });
  if (linked) {
    fs.symlinkSync("../shared.credentials", path.join(codexHome, "auth-link"));
    fs.symlinkSync("auth-link", real);
  }
  const credential = copyCodexSignIn(real, path.join(root, "workspace", "codex-home", "auth.json"))!;
  fs.writeFileSync(credential.copy, RECORDED);
  return { root, codexHome, real, target, credential, lock: path.join(codexHome, "auth.lock"), commitLock: linked ? path.join(root, "shared.json.lock") : path.join(codexHome, "auth.json.lock") };
}

/** Whether another process could take flock(2) on `lock` now. */
function lockIsFree(lock: string): boolean {
  return spawnSync("flock", ["--nonblock", "--conflict-exit-code", "4", lock, "true"], { env: ENV }).status === 0;
}

/** Another codex inside its commit: a `flock` on `lock` that becomes a shell running `script` with the lock held (one process, so stopping it lets go), and lets go when it ends. Resolves once it holds the lock. */
async function anotherCodexHolds(lock: string, script: string): Promise<{ exited: Promise<number | null>; stop: () => void }> {
  const holder = spawn("flock", ["--no-fork", "--exclusive", lock, "sh", "-c", `echo held; ${script}`], { stdio: ["ignore", "pipe", "inherit"], env: ENV });
  const exited = new Promise<number | null>((resolve) => holder.once("exit", resolve));
  await new Promise<void>((resolve) => holder.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("held") && resolve()));
  return { exited, stop: () => holder.kill() };
}

test("while the recorder holds Codex's lock, flock(2) on auth.lock, which Codex's File::lock takes, is refused; after it lets go, it is granted", async () => {
  const { lock } = refreshedCopy();
  const held = await takeCodexSignInLock(lock, 1_000, ENV);
  assert.ok(held !== undefined, "the lock was free");
  try {
    assert.equal(held.file, lock);
    assert.equal(lockIsFree(lock), false, "another codex would wait");
  } finally {
    await held.release();
  }
  assert.equal(lockIsFree(lock), true, "after release another codex gets it at once");
});

test("the copy-back waits while another codex holds auth.lock, and writes the refreshed sign-in back only after it let go", async () => {
  const { root, real, credential, lock } = refreshedCopy();
  const seen = path.join(root, "seen-at-release");
  // The other codex holds the lock for 700 ms, then, still holding it, looks at the user's file.
  const other = await anotherCodexHolds(lock, `sleep 0.7; cp ${JSON.stringify(real)} ${JSON.stringify(seen)}`);
  try {
    const started = Date.now();
    await returnCodexSignIn(credential, ENV, 20_000);
    assert.ok(Date.now() - started >= 400, "the copy-back waited for the lock");
    assert.equal(await other.exited, 0);
    assert.equal(fs.readFileSync(seen, "utf8"), ORIGINAL, "while the other codex held the lock, the user's file was not replaced");
    assert.equal(fs.readFileSync(real, "utf8"), RECORDED, "after it let go, the refreshed sign-in went back");
    assert.equal(fs.existsSync(recoveryFileFor(real)), false, "nothing needed the recovery file");
    assert.equal(lockIsFree(lock), true, "the copy-back let go of the lock");
  } finally {
    other.stop();
  }
});

test("when another codex keeps auth.lock past the wait, the copy-back never breaks it: it leaves the user's file and keeps the refreshed sign-in in the recovery file", async () => {
  const { real, credential, lock } = refreshedCopy();
  const other = await anotherCodexHolds(lock, "exec sleep 30");
  try {
    await assert.rejects(
      returnCodexSignIn(credential, ENV, 500),
      (error: unknown) =>
        error instanceof CredentialsKeptError &&
        error.recoveryFile === recoveryFileFor(real) &&
        error.message.startsWith(`another codex held its lock ${lock} for 0.5 s, so the recorder did not write the sign-in codex refreshed back to ${real}; it kept the refreshed sign-in in ${recoveryFileFor(real)}`),
    );
    assert.equal(fs.readFileSync(real, "utf8"), ORIGINAL, "the user's file is as the other codex left it");
    const records = JSON.parse(fs.readFileSync(recoveryFileFor(real), "utf8")) as Array<{ id: string; value: string }>;
    assert.deepEqual(records.map((record) => [record.id, record.value]), [["auth.json", RECORDED]], "the refreshed sign-in is not lost");
    assert.equal(lockIsFree(lock), false, "the other codex still holds its lock");
  } finally {
    other.stop();
    await other.exited;
  }
});

test("when the holders of Codex's locks end before the copy-back lets go, it takes the locks as lost and also keeps the refreshed sign-in in the recovery file", async () => {
  const { root, real, credential } = refreshedCopy();
  // flock runs a holder that says held, then ends without being told to let go; PATH holds only the test's own folders.
  const env = { PATH: [dyingHolderBin(root), lockHolderBin(root)].join(path.delimiter) };
  await assert.rejects(
    returnCodexSignIn(credential, env, 1_000, 1_000),
    (error: unknown) =>
      error instanceof CredentialsKeptError &&
      error.recoveryFile === recoveryFileFor(real) &&
      error.message.startsWith(`the recorder wrote the sign-in codex refreshed back to ${real}, but the lock on `) &&
      error.message.includes("may have been lost before it let go"),
  );
  const records = JSON.parse(fs.readFileSync(recoveryFileFor(real), "utf8")) as Array<{ id: string; value: string }>;
  assert.deepEqual(records.map((record) => [record.id, record.value]), [["auth.json", RECORDED]], "the refreshed sign-in is in the recovery file");
});

test("a copy the recorded codex did not change goes nowhere and takes no lock: the user's Codex home gets no auth.lock", async () => {
  const { codexHome, real, credential } = refreshedCopy();
  fs.writeFileSync(credential.copy, ORIGINAL);
  await returnCodexSignIn(credential, ENV, 1_000);
  assert.deepEqual(fs.readdirSync(codexHome), ["auth.json"]);
  assert.equal(fs.readFileSync(real, "utf8"), ORIGINAL);
});

test("copy-back follows a relative link chain, preserves it and locks beside the resolved target", async () => {
  const { codexHome, real, target, credential, lock, commitLock } = refreshedCopy(true);
  assert.equal(fs.lstatSync(credential.copy).isSymbolicLink(), false);
  await returnCodexSignIn(credential, ENV);
  assert.equal(fs.readlinkSync(real), "auth-link");
  assert.equal(fs.readlinkSync(path.join(codexHome, "auth-link")), "../shared.credentials");
  assert.equal(fs.readFileSync(target, "utf8"), RECORDED);
  assert.equal(fs.readFileSync(real, "utf8"), RECORDED);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(commitLock).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(codexHome, "auth.json.lock")), false);
  assert.equal(fs.existsSync(recoveryFileFor(real)), false);
  assert.equal(lockIsFree(lock), true);
  assert.equal(lockIsFree(commitLock), true);
});

for (const failure of ["held", "unopenable", "retargeted", "dangling", "hard-linked", "read-only"] as const) {
  test(`copy-back goes to recovery when the commit lock or target is ${failure}`, async () => {
    const { root, real, target, credential, lock, commitLock } = refreshedCopy(true);
    const alternate = path.join(root, "alternate.json");
    const originalLink = fs.readlinkSync(real);
    let expectedLink = originalLink;
    let other: Awaited<ReturnType<typeof anotherCodexHolds>> | undefined;
    let expectedError: RegExp;
    switch (failure) {
      case "held":
        other = await anotherCodexHolds(commitLock, "exec sleep 30");
        expectedError = /another codex held its lock .*shared\.json\.lock/;
        break;
      case "unopenable":
        fs.mkdirSync(commitLock);
        expectedError = /could not take Codex's lock .*shared\.json\.lock/;
        break;
      case "retargeted":
        fs.writeFileSync(alternate, ORIGINAL);
        fs.unlinkSync(real);
        expectedLink = "../alternate.json";
        fs.symlinkSync(expectedLink, real);
        expectedError = /resolves to a different target/;
        break;
      case "dangling":
        fs.unlinkSync(target);
        expectedError = /ENOENT/;
        break;
      case "hard-linked":
        fs.linkSync(target, alternate);
        expectedError = /not a regular file with one link/;
        break;
      case "read-only":
        fs.chmodSync(target, 0o400);
        expectedError = /read-only/;
        break;
    }
    const recovery = recoveryFileFor(real);
    try {
      await assert.rejects(returnCodexSignIn(credential, ENV, 2_000, 200), (error: unknown) =>
        error instanceof CredentialsKeptError && error.recoveryFile === recovery && expectedError.test(error.message));
      assert.equal(fs.readlinkSync(real), expectedLink);
      if (failure === "dangling") assert.equal(fs.existsSync(target), false, "a missing file is not recreated");
      else assert.equal(fs.readFileSync(target, "utf8"), ORIGINAL);
      if (failure === "retargeted" || failure === "hard-linked") assert.equal(fs.readFileSync(alternate, "utf8"), ORIGINAL);
      assert.deepEqual(JSON.parse(fs.readFileSync(recovery, "utf8")), [{ id: "auth.json", value: RECORDED }]);
      assert.equal(fs.statSync(recovery).mode & 0o777, 0o600);
      assert.equal(lockIsFree(lock), true, "the recorder released its home lock");
      if (other !== undefined) assert.equal(lockIsFree(commitLock), false, "the recorder did not break the other writer's lock");
    } finally {
      other?.stop();
      await other?.exited;
    }
  });
}
