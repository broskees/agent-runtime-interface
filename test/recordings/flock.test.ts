// The recorders' flock(2) lock holder (./flock.ts) says a lock is held only
// while a live process holds it, and its release fails when the holder did
// not hold the lock until then. The Codex recorder takes its locks through
// it too (./codex/sign-in-lock.ts), so each case runs both ways in. Every
// holder here runs with a PATH of the test's own folders only.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { dyingHolderBin, lockHolderBin } from "../helpers/lock-holder-bins.ts";
import { takeCodexSignInLock } from "./codex/sign-in-lock.ts";
import { holdFlock } from "./flock.ts";
import type { HeldFlock } from "./flock.ts";

const DIRECTORY = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-flock-")));
after(() => fs.rmSync(DIRECTORY, { recursive: true, force: true }));

type Env = { readonly PATH: string };

/** The two ways a recorder takes a lock: the Antigravity recorder's on a folder, and the Codex recorder's on a lock file it creates. */
const WAYS_IN: ReadonlyArray<{ readonly label: string; readonly target: () => string; readonly take: (target: string, env: Env) => Promise<HeldFlock | undefined> }> = [
  { label: "holdFlock on a folder", target: () => fs.mkdtempSync(path.join(DIRECTORY, "folder-")), take: (target, env) => holdFlock(target, 1_000, env) },
  { label: "takeCodexSignInLock on auth.lock", target: () => path.join(fs.mkdtempSync(path.join(DIRECTORY, "codex-home-")), "auth.lock"), take: (target, env) => takeCodexSignInLock(target, 1_000, env) },
];

/** Whether another process could take flock(2) on `target` now. */
function lockIsFree(target: string, bin: string): boolean {
  return spawnSync(path.join(bin, "flock"), ["--exclusive", "--nonblock", "--conflict-exit-code", "75", target, "sh", "-c", ":"], { env: { PATH: bin } }).status === 0;
}

test("while the holder says a lock is held, nobody else can take it, even with only flock and sh on its PATH (no cat); after release the lock is free", async () => {
  for (const { label, target: makeTarget, take } of WAYS_IN) {
    const target = makeTarget();
    const bin = lockHolderBin(DIRECTORY);
    const held = await take(target, { PATH: bin });
    assert.ok(held !== undefined, `${label}: the lock was free, so the holder took it`);
    try {
      // Time for a holder that let go by mistake to have gone.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(lockIsFree(target, bin), false, `${label}: while the holder says the lock is held, another flock is refused`);
    } finally {
      await held.release();
    }
    assert.equal(lockIsFree(target, bin), true, `${label}: after release the lock is free`);
  }
});

test("when the holder says held but ends before it is told to let go, release fails, naming the lock", async () => {
  for (const { label, target: makeTarget, take } of WAYS_IN) {
    const target = makeTarget();
    const env = { PATH: [dyingHolderBin(DIRECTORY), lockHolderBin(DIRECTORY)].join(path.delimiter) };
    const held = await take(target, env);
    assert.ok(held !== undefined, `${label}: the holder said held`);
    await assert.rejects(held.release(), (error: unknown) => error instanceof Error && error.message.includes(`the lock on ${target} may have been lost`), label);
  }
});
