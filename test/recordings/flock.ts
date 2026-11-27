// A flock(2) lock held from Node and Bun, which cannot take one themselves:
// node:fs has no flock, node:ffi exists only in Node 26, as an experimental
// module (Node 22 and 24 lack it, and CI runs both), and Bun's node:fs has
// none either. So a recorder holds the lock through util-linux's `flock`
// command: `flock` takes it, then runs a shell that says so and waits for its
// stdin to close. A flock(2) lock belongs to the open file, and the kernel
// drops it when its holder exits, so no lock is ever left stale.
//
// The Codex recorder takes Codex's own locks this way (./codex/sign-in-lock.ts),
// and the Antigravity recorder its lock on the folder of the user's sign-in
// file (./antigravity/record.ts, `returnAntigravitySignIn`).

import { spawn } from "node:child_process";

/** The command a recorder takes a flock(2) lock with. */
export const FLOCK_COMMAND = "flock";

/** flock's exit code when another holder kept the lock past the wait. */
const STILL_HELD = 75;

/** What the holder's shell prints once flock holds the lock. */
const HELD = "held";

type Env = { readonly [name: string]: string | undefined };

/** A flock(2) lock, held by the recorder until `release`. */
export interface HeldFlock {
  readonly file: string;
  /** Lets go of the lock, and resolves once the holder exited. */
  release(): Promise<void>;
}

/**
 * Takes an exclusive flock(2) lock on `file`, a file or a folder that already
 * exists (flock creates a missing file), through `flock` on `env`'s PATH,
 * waiting up to `waitMs` while another holds it. Resolves undefined when
 * another held it all that time: the recorder never breaks it. Rejects when
 * `flock` cannot run or fails.
 */
export async function holdFlock(file: string, waitMs: number, env: Env): Promise<HeldFlock | undefined> {
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
