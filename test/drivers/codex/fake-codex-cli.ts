// A fake `codex` executable for the Codex recorder's tests, run as
// `node test/drivers/codex/fake-codex-cli.ts <args>` by a small `codex` script
// a test puts on PATH (./fake-codex.ts). It answers the three commands the
// driver runs, with the fake app-server of ./fake-app-server.ts in this
// process:
//   - `--version` prints `codex-cli 0.172.0-fake`;
//   - `login status` says what Codex says for the sign-in file it finds,
//     `auth.json` in the Codex home (CODEX_HOME, else ~/.codex): `Logged in
//     using ChatGPT` for one holding tokens, `API key configured` for one
//     holding OPENAI_API_KEY, else `Not logged in` (exit 1), on stderr as
//     codex-rs/cli/src/login.rs prints them;
//   - `app-server` serves the app-server protocol on this process's stdin
//     and stdout, frame for frame what the fake app-server sends and takes,
//     and plays each turn with the scenario puppets (./puppets.ts). It keeps
//     its threads in `fake-codex-store.json` in the Codex home, as Codex keeps
//     rollouts and its state database there, so a later `app-server` of the
//     same home resumes them. It writes one line of its own to stderr when it
//     starts. Ended by a signal, it ends by the same signal; when its stdin
//     closes it exits 0.
//
// Like `codex`, `app-server` loads the user's setup from where its
// environment and working directory say (./user-setup.ts), and repeats every
// setup file it loaded in its replies, so a test sees in the recording what
// leaked. It appends what it saw to the JSON lines file in
// ARI_FAKE_CODEX_REPORT: its process id, arguments, environment and
// directory, what it loaded, and the sign-in it found. Variables steer it in
// a test:
//   ARI_FAKE_CODEX_ROTATE      at its first turn, Codex refreshes the sign-in:
//                              the refresh token in its auth.json becomes this
//                              value (written to a new file renamed over the
//                              old one, as codex-rs/login/src/auth/storage.rs
//                              FileAuthStorage::save does)
//   ARI_FAKE_CODEX_TOUCH       at its first turn, the file this names gets the
//                              content of ARI_FAKE_CODEX_TOUCH_VALUE, as when
//                              another codex changes the user's sign-in
//   ARI_FAKE_CODEX_BREAK       at its first turn, the file this names becomes
//                              a directory, so nothing can read or replace it
//   ARI_FAKE_CODEX_CRASH       the app-server dies at its first turn
//   ARI_FAKE_CODEX_MODELS      what `model/list` answers, as JSON (Model[])
//   ARI_FAKE_CODEX_REPLY       the simple scenario's answer
//   ARI_FAKE_CODEX_OUTPUT      what the approval command prints
//   ARI_FAKE_CODEX_PLANT       a notification ({ method, params }), or a list
//                              of them, the app-server sends first in every
//                              turn
//   ARI_FAKE_CODEX_WIRE        a JSON lines file that gets every line on the
//                              app-server's stdin ("in"), stdout ("out") and
//                              stderr ("err"), with its process id, in order

import * as fs from "node:fs";
import * as path from "node:path";
import { FakeCodexStore, FakeCodexWorld } from "./fake-app-server.ts";
import type { FakeCodexStoreSnapshot } from "./fake-app-server.ts";
import { FAKE_CODEX_CLI_VERSION, FAKE_CODEX_RECORDER_MODELS } from "./fake-codex.ts";
import { playCodexTurn } from "./puppets.ts";
import type { CodexPuppetOptions } from "./puppets.ts";
import { codexHomeOf, loadedCodexSetup } from "./user-setup.ts";

const SIGN_IN_FILE = "auth.json";
const STORE_FILE = "fake-codex-store.json";

function report(entry: { readonly [key: string]: unknown }): void {
  const file = process.env["ARI_FAKE_CODEX_REPORT"];
  if (file !== undefined && file !== "") fs.appendFileSync(file, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

function wire(direction: "in" | "out" | "err", line: string): void {
  const file = process.env["ARI_FAKE_CODEX_WIRE"];
  if (file !== undefined && file !== "") fs.appendFileSync(file, `${JSON.stringify({ pid: process.pid, direction, line })}\n`);
}

function environment(): { [name: string]: string } {
  const env: { [name: string]: string } = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  return env;
}

/** The sign-in in the Codex home: what `login status` reports for it. */
function signInState(codexHome: string | undefined): "authenticated" | "api_key" | "unauthenticated" {
  if (codexHome === undefined) return "unauthenticated";
  let auth: { OPENAI_API_KEY?: unknown; tokens?: unknown };
  try {
    auth = JSON.parse(fs.readFileSync(path.join(codexHome, SIGN_IN_FILE), "utf8")) as typeof auth;
  } catch {
    return "unauthenticated";
  }
  if (typeof auth.tokens === "object" && auth.tokens !== null) return "authenticated";
  if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY !== "") return "api_key";
  return "unauthenticated";
}

/** Rotates the refresh token in the Codex home's auth.json, as Codex does when it refreshes a ChatGPT sign-in: a new file renamed over the old one. */
function rotateRefreshToken(codexHome: string, refreshToken: string): void {
  const file = path.join(codexHome, SIGN_IN_FILE);
  const auth = JSON.parse(fs.readFileSync(file, "utf8")) as { tokens?: { [key: string]: unknown }; last_refresh?: string };
  auth.tokens = { ...(auth.tokens ?? {}), refresh_token: refreshToken };
  auth.last_refresh = "2026-11-25T12:00:00Z";
  const staged = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staged, JSON.stringify(auth, null, 2), { mode: 0o600 });
  fs.renameSync(staged, file);
}

/** Calls `onLine` with each line of `chunks` as it completes, and passes each chunk on. */
function lines(onLine: (line: string) => void): (chunk: string) => void {
  let partial = "";
  return (chunk) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop()!;
    for (const line of parts) onLine(line);
  };
}

function appServer(args: readonly string[]): void {
  const env = environment();
  const codexHome = codexHomeOf(env);
  const signInFile = codexHome === undefined ? undefined : path.join(codexHome, SIGN_IN_FILE);
  const loaded = loadedCodexSetup(env, process.cwd());
  report({ loaded, signIn: signInFile !== undefined && fs.existsSync(signInFile) ? fs.readFileSync(signInFile, "utf8") : null, ...(signInFile === undefined ? {} : { signInFile }) });

  const models = env["ARI_FAKE_CODEX_MODELS"] === undefined ? FAKE_CODEX_RECORDER_MODELS : (JSON.parse(env["ARI_FAKE_CODEX_MODELS"]) as typeof FAKE_CODEX_RECORDER_MODELS);
  const world = new FakeCodexWorld({ ambientAuth: signInState(codexHome), realpath: (value) => fs.realpathSync(value), version: FAKE_CODEX_CLI_VERSION, models });
  const storeFile = codexHome === undefined ? undefined : path.join(codexHome, STORE_FILE);
  if (codexHome !== undefined && storeFile !== undefined && fs.existsSync(storeFile)) world.stores.set(codexHome, FakeCodexStore.restore(codexHome, JSON.parse(fs.readFileSync(storeFile, "utf8")) as FakeCodexStoreSnapshot));
  const save = (): void => {
    const store = codexHome === undefined ? undefined : world.stores.get(codexHome);
    if (store !== undefined && storeFile !== undefined) fs.writeFileSync(storeFile, JSON.stringify(store.snapshot()));
  };

  const child = world.spawn({ command: "codex", args: [...args], environment: env });
  const started = `fake codex ${FAKE_CODEX_CLI_VERSION}: serving the app-server protocol on stdio`;
  wire("err", started);
  process.stderr.write(`${started}\n`);
  const inbound = lines((line) => wire("in", line));
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    inbound(chunk);
    void child.write(chunk).catch(() => undefined);
  });
  process.stdin.on("end", () => void child.closeStdin());
  const pass = async (stream: AsyncIterable<Uint8Array>, to: NodeJS.WriteStream, direction: "out" | "err"): Promise<void> => {
    const decoder = new TextDecoder();
    const each = lines((line) => wire(direction, line));
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      each(text);
      to.write(text);
    }
  };
  const outputs = Promise.all([pass(child.stdout, process.stdout, "out"), pass(child.stderr, process.stderr, "err")]);

  const planted = env["ARI_FAKE_CODEX_PLANT"] === undefined ? undefined : (JSON.parse(env["ARI_FAKE_CODEX_PLANT"]) as NonNullable<CodexPuppetOptions["planted"]>[number] | NonNullable<CodexPuppetOptions["planted"]>);
  const puppet: CodexPuppetOptions = {
    extraText: loaded.join("\n"),
    ...(env["ARI_FAKE_CODEX_REPLY"] === undefined ? {} : { reply: env["ARI_FAKE_CODEX_REPLY"] }),
    ...(env["ARI_FAKE_CODEX_OUTPUT"] === undefined ? {} : { commandOutput: env["ARI_FAKE_CODEX_OUTPUT"] }),
    ...(planted === undefined ? {} : { planted: Array.isArray(planted) ? planted : [planted] }),
  };
  void (async () => {
    let turns = 0;
    for (;;) {
      const next = await world.turnQueue.next();
      if (next.done === true) return;
      const turn = next.value;
      turns += 1;
      if (turns === 1) {
        if (env["ARI_FAKE_CODEX_ROTATE"] !== undefined && codexHome !== undefined) rotateRefreshToken(codexHome, env["ARI_FAKE_CODEX_ROTATE"]);
        if (env["ARI_FAKE_CODEX_TOUCH"] !== undefined) fs.writeFileSync(env["ARI_FAKE_CODEX_TOUCH"], env["ARI_FAKE_CODEX_TOUCH_VALUE"] ?? "changed by another codex");
        if (env["ARI_FAKE_CODEX_BREAK"] !== undefined) {
          fs.rmSync(env["ARI_FAKE_CODEX_BREAK"], { force: true });
          fs.mkdirSync(env["ARI_FAKE_CODEX_BREAK"]);
        }
        if (env["ARI_FAKE_CODEX_CRASH"] === "1") {
          await turn.exitProcess();
          continue;
        }
      }
      void playCodexTurn(world, turn, puppet).catch((error: unknown) => {
        process.stderr.write(`fake codex: the puppet failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }
  })();

  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void child.kill(signal));
  // Once the app-server is gone and its output passed on, keep the threads and end the way it ended.
  void (async () => {
    const exit = await child.exited;
    await outputs;
    save();
    world.dispose();
    if (exit.signal !== null) {
      process.removeAllListeners(exit.signal);
      process.stdout.write("", () => process.kill(process.pid, exit.signal as NodeJS.Signals));
    } else process.stdout.write("", () => process.exit(exit.code ?? 1));
  })();
}

function oneShot(args: readonly string[]): void {
  const env = environment();
  const world = new FakeCodexWorld({ ambientAuth: signInState(codexHomeOf(env)), realpath: (value) => fs.realpathSync(value), version: FAKE_CODEX_CLI_VERSION });
  const child = world.spawn({ command: "codex", args: [...args], environment: env });
  void (async () => {
    const decoder = new TextDecoder();
    const pass = async (stream: AsyncIterable<Uint8Array>, to: NodeJS.WriteStream): Promise<void> => {
      for await (const chunk of stream) to.write(decoder.decode(chunk));
    };
    await Promise.all([pass(child.stdout, process.stdout), pass(child.stderr, process.stderr)]);
    const exit = await child.exited;
    process.exitCode = exit.code ?? 1;
  })();
}

const args = process.argv.slice(2);
report({ args, env: environment(), cwd: process.cwd() });
if (args[0] === "app-server") appServer(args);
else oneShot(args);
