// A flock(2) lock held from Node and Bun, which cannot take one themselves:
// node:fs has no flock, node:ffi exists only in Node 26, as an experimental
// module (Node 22 and 24 lack it, and CI runs both), and Bun's node:fs has
// none either. So a recorder holds the lock through util-linux's `flock`
// command. A flock(2) lock belongs to the open file, and the kernel drops it
// when its holder exits, so no lock is ever left stale.
//
// The holder fails closed. `flock --no-fork` takes the lock and then becomes
// a shell that runs only shell builtins, so the shell itself holds the lock
// for as long as it lives, and nothing it runs can fail and end it. It says
// `held` only after it read the recorder's `ready` line, and `released`
// only after it read the recorder's `release` line. A holder that says
// `released` was alive, and so held the lock, from `held` until the release.
// Anything else at release (it ended first, or ended another way) means the
// lock may have been lost, and release() fails.
//
// The Codex recorder takes Codex's own locks this way (./codex/sign-in-lock.ts),
// and the Antigravity recorder its lock on the folder of the user's sign-in
// file (./antigravity/record.ts, `returnAntigravitySignIn`). Each copy-back
// takes a failed release as a lost lock and keeps the refreshed sign-in in
// its recovery file.

import { spawn } from "node:child_process";

/** The command a recorder takes a flock(2) lock with. */
export const FLOCK_COMMAND = "flock";

/** flock's exit code when another holder kept the lock past the wait. */
const STILL_HELD = 75;

/**
 * The holder's shell, run by `flock --no-fork` once it took the lock: only
 * builtins (`read`, `[`, `echo`, `exit`). It ends 0 only after it said
 * `released`, and 3 in every other way.
 */
const HOLDER_SCRIPT = `read -r line && [ "$line" = ready ] && echo held && read -r line && [ "$line" = release ] && echo released && exit 0; exit 3`;

type Env = { readonly [name: string]: string | undefined };

/** The holder may not have held the lock until the release: the copy-back must take the lock as lost. */
export class FlockLostError extends Error {
  readonly file: string;
  /** What the holder did instead of saying `released` and exiting 0. */
  readonly why: string;
  constructor(file: string, why: string) {
    super(`the lock on ${file} may have been lost before the recorder let go: ${why}`);
    this.name = "FlockLostError";
    this.file = file;
    this.why = why;
  }
}

/** A flock(2) lock, held by the recorder until `release`. */
export interface HeldFlock {
  readonly file: string;
  /**
   * Lets go of the lock, and resolves once the holder exited. Rejects with
   * a FlockLostError when the holder may not have held the lock until now:
   * it did not say `released` in answer to the release, or did not exit 0.
   */
  release(): Promise<void>;
}

/**
 * Takes an exclusive flock(2) lock on `file`, a file or a folder that already
 * exists (flock creates a missing file), through `flock` on `env`'s PATH,
 * waiting up to `waitMs` while another holds it. Resolves once the process
 * holding the lock said so. Resolves undefined when another held it all that
 * time: the recorder never breaks it. Rejects when `flock` or the holder's
 * shell cannot run, or the holder ends before it says it holds the lock.
 */
export async function holdFlock(file: string, waitMs: number, env: Env): Promise<HeldFlock | undefined> {
  const holder = spawn(FLOCK_COMMAND, ["--no-fork", "--exclusive", "--timeout", String(waitMs / 1000), "--conflict-exit-code", String(STILL_HELD), file, "sh", "-c", HOLDER_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: env["PATH"] ?? "" },
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => holder.once("exit", (code, signal) => resolve({ code, signal })));
  const closed = new Promise<void>((resolve) => holder.once("close", () => resolve()));
  const failed = new Promise<Error>((resolve) => holder.once("error", resolve));
  // A holder that already exited closed its stdin: writing to it then is no error.
  holder.stdin.on("error", () => undefined);
  let errors = "";
  holder.stderr.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
  const lines: string[] = [];
  const waiting = new Map<string, () => void>();
  let partial = "";
  holder.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop()!;
    for (const line of parts) {
      lines.push(line);
      waiting.get(line)?.();
    }
  });
  /** Resolves once the holder printed `line`. */
  const said = (line: string): Promise<void> => (lines.includes(line) ? Promise.resolve() : new Promise((resolve) => waiting.set(line, resolve)));
  // The holder reads this only once it holds the lock.
  holder.stdin.write("ready\n");
  const first = await Promise.race([said("held").then(() => ({ held: true as const })), exited.then((exit) => ({ exit })), failed.then((error) => ({ error }))]);
  if ("error" in first) throw new Error(`${FLOCK_COMMAND} could not run: ${first.error.message}`);
  if ("exit" in first) {
    if (first.exit.code === STILL_HELD) return undefined;
    throw new Error(`${FLOCK_COMMAND} exited with ${first.exit.code ?? first.exit.signal} before it held ${file}${errors.trim() === "" ? "" : `: ${errors.trim()}`}`);
  }
  return {
    file,
    release: async () => {
      holder.stdin.end("release\n");
      const kill = setTimeout(() => holder.kill("SIGKILL"), 5_000);
      const exit = await exited;
      clearTimeout(kill);
      // `close` comes once the holder's output ended too, so every line it wrote is in. Output still open after 5 s counts as no `released`.
      let late: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([closed, new Promise<void>((resolve) => (late = setTimeout(resolve, 5_000)))]);
      clearTimeout(late);
      const released = lines.includes("released");
      if (released && exit.code === 0) return;
      throw new FlockLostError(file, `its holder ${released ? "said it let go" : "did not say it let go"} and ended with ${exit.code ?? exit.signal}`);
    },
  };
}
