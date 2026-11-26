// Codex's own lock on its sign-in, taken from Node and Bun.
//
// Codex 0.172.0 commits a sign-in (a refresh, a login, a logout, a workspace
// switch) only while it holds an exclusive lock on `auth.lock` in its home:
// `lock_for_write` opens that file read-write, creating it and never
// truncating it, and calls Rust's `File::lock` (codex-rs/login/src/auth/
// storage.rs:189–212), around the whole read, compare and write
// (login/src/auth/manager.rs:1023, 1090, 1261, 1768;
// manager/workspace_switching.rs:344). It waits for as long as another holds
// the lock, and never removes the file. Each save takes a second lock,
// `auth.json.lock`, only inside the first (login/src/auth/storage_commit.rs:
// 29–68), so whoever holds `auth.lock` keeps every Codex commit out. Network
// requests hold neither (storage_commit.rs:1–2).
//
// Rust's `File::lock` on Linux is flock(2): a lock on the open file, which the
// kernel drops when its holder closes the file or exits, so no lock is ever
// left stale, and which a POSIX record lock (fcntl) does not see. Node cannot
// take one: node:fs has no flock, and node:ffi exists only in Node 26, as an
// experimental module (Node 22 and 24 lack it, and CI runs both). Bun's
// node:fs has none either. So the recorder holds the lock through
// util-linux's `flock` command: `flock` takes it, then runs a shell that says
// so and waits for its stdin to close. docs/recordings.md, "How Codex finds the
// sign-in", gives the evidence and the window that remains.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** The file Codex locks around each commit of its sign-in, in its home. */
export const CODEX_SIGN_IN_LOCK = "auth.lock";

/** The command the recorder takes Codex's lock with. */
export const FLOCK_COMMAND = "flock";

/** flock's exit code when another holder kept the lock past the wait. */
const STILL_HELD = 75;

/** What the holder's shell prints once flock holds the lock. */
const HELD = "held";

type Env = { readonly [name: string]: string | undefined };

/** The recorder cannot run `flock`, so it could not take Codex's lock: it stops before it starts `codex`. */
export class CodexSignInLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSignInLockError";
  }
}

/** Stops with a CodexSignInLockError unless `flock` runs from `env`'s PATH. */
export function checkFlockRuns(env: Env): void {
  const run = spawnSync(FLOCK_COMMAND, ["--version"], { encoding: "utf8", env: { PATH: env["PATH"] ?? "" }, timeout: 10_000 });
  if (run.error === undefined && run.status === 0) return;
  const why = run.error !== undefined ? run.error.message : `it exited with ${run.status ?? run.signal}`;
  throw new CodexSignInLockError(
    `the recorder could not run ${FLOCK_COMMAND} (${why}), which it needs to take Codex's own lock, ${CODEX_SIGN_IN_LOCK}, when it puts a refreshed sign-in back; it stopped before it started codex. Install util-linux's ${FLOCK_COMMAND} on PATH, then record again. See "How Codex finds the sign-in" in docs/recordings.md.`,
  );
}

/** Codex's lock, held by the recorder until `release`. */
export interface HeldCodexSignInLock {
  readonly file: string;
  /** Lets go of the lock, and resolves once the holder exited. */
  release(): Promise<void>;
}

/**
 * Takes Codex's lock in `codexHome` as Codex takes it, through `flock` on
 * `env`'s PATH, waiting up to `waitMs` while another holds it. Resolves
 * undefined when another held it all that time: the recorder never breaks it.
 * Rejects when `flock` cannot run or fails.
 */
export async function takeCodexSignInLock(codexHome: string, waitMs: number, env: Env): Promise<HeldCodexSignInLock | undefined> {
  const file = path.join(codexHome, CODEX_SIGN_IN_LOCK);
  // As Codex opens it: read-write, created when missing, never truncated, with the default permissions.
  fs.closeSync(fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT));
  // flock holds the lock itself (--close keeps it from the shell), so killing flock lets go at once.
  const holder = spawn(FLOCK_COMMAND, ["--exclusive", "--close", "--timeout", String(waitMs / 1000), "--conflict-exit-code", String(STILL_HELD), file, "sh", "-c", `echo ${HELD}; exec cat >/dev/null`], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: env["PATH"] ?? "" },
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => holder.once("exit", (code, signal) => resolve({ code, signal })));
  const failed = new Promise<Error>((resolve) => holder.once("error", resolve));
  // A holder that already exited closed its stdin: ending it then is no error.
  holder.stdin.on("error", () => undefined);
  let errors = "";
  holder.stderr.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
  let output = "";
  const held = new Promise<void>((resolve) => {
    holder.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(HELD)) resolve();
    });
  });
  const first = await Promise.race([held.then(() => ({ held: true as const })), exited.then((exit) => ({ exit })), failed.then((error) => ({ error }))]);
  if ("error" in first) throw new Error(`${FLOCK_COMMAND} could not run: ${first.error.message}`);
  if ("exit" in first) {
    if (first.exit.code === STILL_HELD) return undefined;
    throw new Error(`${FLOCK_COMMAND} exited with ${first.exit.code ?? first.exit.signal} before it held ${file}${errors.trim() === "" ? "" : `: ${errors.trim()}`}`);
  }
  return {
    file,
    release: async () => {
      holder.stdin.end();
      const kill = setTimeout(() => holder.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(kill);
    },
  };
}
