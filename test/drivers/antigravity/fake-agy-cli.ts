// A fake `agy` executable for the Antigravity recorder's tests, run as
// `node test/drivers/antigravity/fake-agy-cli.ts <args>` by a small `agy`
// script a test puts on PATH:
//   - `--version` prints `1.5.17-fake`;
//   - `acp ...` runs the fake ACP agent (test/drivers/acp/fake-agent.ts, built
//     on the official ACP SDK) as `agy acp` would run: ACP on this process's
//     stdin and stdout, passed to and from the agent line by line, and the
//     agent's puppet on an IPC channel this process drives with the scenario
//     puppets (./puppets.ts). It writes one line of its own to stderr when it
//     starts, and passes on what the agent writes there. The agent speaks ACP
//     v1, keeps its sessions under the `--gemini-dir` it was given, so a later
//     `agy acp` of the same profile resumes them, and offers a model option.
//     Ended by a signal, it ends by the same signal.
//
// Like `agy`, `acp` loads the user's setup from where its environment and
// `--gemini-dir` say (./user-setup.ts), and repeats every setup file it loaded
// in its replies, so a test sees in the recording what leaked. It keeps its
// sign-in where `agy` 1.5.16 and later keep it (`signInStore` below): in the
// OS keyring's one entry, which every profile shares, unless
// AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set or the session bus is unreachable;
// then in `<gemini dir>/<app data dir>/antigravity-oauth-token`. Like 1.5.x it
// reads neither GEMINI_HOME nor AGY_ACP_FORCE_FILE_STORAGE. It appends what it
// saw to the JSON lines file in ARI_FAKE_AGY_REPORT: its arguments,
// environment and directory, what it loaded, and the sign-in it found and
// where. Variables steer it in a test:
//   ARI_FAKE_AGY_KEYRING       a file standing in for the OS keyring's entry
//                              (service `gemini`, account `antigravity`);
//                              without it the machine has no keyring
//   ARI_FAKE_AGY_REFRESH       at its first turn, the sign-in it uses (the
//                              keyring entry or the file) gets this content,
//                              as when agy refreshes a token
//   ARI_FAKE_AGY_TOUCH         at its first turn, the file this names gets the
//                              content of ARI_FAKE_AGY_TOUCH_VALUE, as when
//                              another agy changes the user's sign-in meanwhile
//   ARI_FAKE_AGY_BREAK         at its first turn, the file this names becomes
//                              a directory, so nothing can read or replace it
//   ARI_FAKE_AGY_CRASH         the agent dies at its first turn
//   ARI_FAKE_AGY_MODELS        the model option's values, as JSON
//                              [{ "value", "name" }]; its current value is the first
//   ARI_FAKE_AGY_REPLY         the simple scenario's answer
//   ARI_FAKE_AGY_OUTPUT        what the approval command prints
//   ARI_FAKE_AGY_PLANT         a session/update (JSON), or a list of them, the
//                              agent sends first in every turn
//   ARI_FAKE_AGY_WIRE          a JSON lines file that gets every line on its
//                              stdin ("in"), stdout ("out") and stderr ("err"),
//                              as the agent's side saw them, in order

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FAKE_AGENT, PuppetChannel } from "../acp/harness.ts";
import { FAKE_AGY_MODELS, FAKE_AGY_VERSION } from "./fake-agy.ts";
import { playAgyTurn } from "./puppets.ts";
import type { AgyPuppetOptions } from "./puppets.ts";
import { loadedAntigravitySetup } from "./user-setup.ts";

const SIGN_IN_FILE = "antigravity-oauth-token";

function report(entry: { readonly [key: string]: unknown }): void {
  const file = process.env["ARI_FAKE_AGY_REPORT"];
  if (file !== undefined && file !== "") fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * Where the sign-in is kept, as `agy` 1.5.16 and later choose: the file when
 * AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set (1.5.16 logs "Using file-based token
 * storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set"), when the machine
 * has no keyring, or when the session bus is unreachable (a
 * DBUS_SESSION_BUS_ADDRESS of `unix:path=<p>` with nothing at `<p>`; agy then
 * falls back to the file); else the keyring's one entry, whatever the profile.
 * `logLine` is what agy's log says about it, in the words agy 1.5.10 to 1.5.16
 * logged.
 */
function signInStore(env: NodeJS.ProcessEnv, profileFile: string): { store: "keyring" | "file"; file: string; logLine?: string } {
  const keyring = env["ARI_FAKE_AGY_KEYRING"];
  const bus = /^unix:path=(.+)$/.exec(env["DBUS_SESSION_BUS_ADDRESS"] ?? "")?.[1];
  if ((env["AGY_CLI_FORCE_FILE_TOKEN_STORAGE"] ?? "") !== "") return { store: "file", file: profileFile, logLine: "composite_token_storage.go:207] Using file-based token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set" };
  if (keyring === undefined || keyring === "") return { store: "file", file: profileFile, logLine: "composite_token_storage.go:176] Using file-based token storage because no D-Bus session bus detected" };
  if (bus !== undefined && !fs.existsSync(bus)) return { store: "file", file: profileFile, logLine: `composite_token_storage.go:586] Failed to load stored token from keyring, falling back to file: dial unix ${bus}: connect: no such file or directory` };
  return { store: "keyring", file: keyring };
}

function acp(args: readonly string[]): void {
  const env = process.env;
  const home = env["HOME"] ?? "/";
  const geminiDir = path.resolve(home, option(args, "--gemini-dir") ?? ".gemini");
  const appDataDir = option(args, "--app-data-dir") ?? "antigravity-cli";
  const { store: signInKind, file: signIn, logLine } = signInStore(env, path.join(geminiDir, appDataDir, SIGN_IN_FILE));
  // agy logs to <app data dir>/log/ ("Other editors (ACP)").
  const log = path.join(geminiDir, appDataDir, "log");
  fs.mkdirSync(log, { recursive: true });
  fs.appendFileSync(path.join(log, "acp-fake.log"), `I1125 00:00:00.000000 1 server.go:2782] Language server version: ${FAKE_AGY_VERSION}\n${logLine === undefined ? "" : `I1125 00:00:00.000001 1 ${logLine}\n`}`);
  const loaded = loadedAntigravitySetup(env, process.cwd(), geminiDir, appDataDir);
  report({ loaded, signIn: fs.existsSync(signIn) ? fs.readFileSync(signIn, "utf8") : null, signInFile: signIn, signInStore: signInKind });

  const models = env["ARI_FAKE_AGY_MODELS"] === undefined ? FAKE_AGY_MODELS : (JSON.parse(env["ARI_FAKE_AGY_MODELS"]) as Array<{ value: string; name: string }>);
  const configOptions = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: models[0]?.value ?? "", options: models }];
  const store = path.join(geminiDir, "fake-acp-store");
  const child = childProcess.spawn(process.execPath, [FAKE_AGENT, "--protocol", "1", "--store", store, "--config-options", JSON.stringify(configOptions)], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
  // The wire, line by line, as the agent's side sees it.
  const wire = env["ARI_FAKE_AGY_WIRE"];
  const pass = (from: NodeJS.ReadableStream, to: NodeJS.WritableStream, direction: "in" | "out" | "err"): void => {
    let partial = "";
    from.setEncoding?.("utf8");
    from.on("data", (chunk: string) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop()!;
      for (const line of lines) {
        if (wire !== undefined && wire !== "") fs.appendFileSync(wire, `${JSON.stringify({ direction, line })}\n`);
        to.write(`${line}\n`);
      }
    });
  };
  child.stdin!.on("error", () => undefined);
  pass(process.stdin, child.stdin!, "in");
  pass(child.stdout!, process.stdout, "out");
  pass(child.stderr!, process.stderr, "err");
  const started = `fake agy ${FAKE_AGY_VERSION}: serving ACP on stdio`;
  if (wire !== undefined && wire !== "") fs.appendFileSync(wire, `${JSON.stringify({ direction: "err", line: started })}\n`);
  process.stderr.write(`${started}\n`);
  const planted = env["ARI_FAKE_AGY_PLANT"] === undefined ? undefined : (JSON.parse(env["ARI_FAKE_AGY_PLANT"]) as { [key: string]: unknown } | Array<{ [key: string]: unknown }>);
  const puppet: AgyPuppetOptions = {
    extraText: loaded.join("\n"),
    ...(env["ARI_FAKE_AGY_REPLY"] === undefined ? {} : { reply: env["ARI_FAKE_AGY_REPLY"] }),
    ...(env["ARI_FAKE_AGY_OUTPUT"] === undefined ? {} : { commandOutput: env["ARI_FAKE_AGY_OUTPUT"] }),
    ...(planted === undefined ? {} : { planted: Array.isArray(planted) ? planted : [planted] }),
  };
  let turns = 0;
  const channel: PuppetChannel = new PuppetChannel(child, (turn) => {
    turns += 1;
    const first = turns === 1;
    void (async () => {
      if (first) {
        if (env["ARI_FAKE_AGY_REFRESH"] !== undefined) fs.writeFileSync(signIn, env["ARI_FAKE_AGY_REFRESH"]);
        if (env["ARI_FAKE_AGY_TOUCH"] !== undefined) fs.writeFileSync(env["ARI_FAKE_AGY_TOUCH"], env["ARI_FAKE_AGY_TOUCH_VALUE"] ?? "changed by another agy");
        if (env["ARI_FAKE_AGY_BREAK"] !== undefined) {
          fs.rmSync(env["ARI_FAKE_AGY_BREAK"], { force: true });
          fs.mkdirSync(env["ARI_FAKE_AGY_BREAK"]);
        }
        if (env["ARI_FAKE_AGY_CRASH"] === "1") {
          channel.fire("exitProcess");
          return;
        }
      }
      await playAgyTurn(channel, turn, puppet);
    })().catch((error: unknown) => {
      process.stderr.write(`fake agy: the puppet failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => child.kill(signal));
  // Once the agent is gone and its output passed on, end the way it ended.
  let outputs = 0;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const finish = (): void => {
    if (exit === undefined || outputs < 2) return;
    if (exit.signal !== null) {
      process.removeAllListeners(exit.signal);
      process.kill(process.pid, exit.signal);
    }
    else process.exit(exit.code ?? 1);
  };
  for (const stream of [child.stdout!, child.stderr!]) stream.once("end", () => ((outputs += 1), finish()));
  child.once("exit", (code, signal) => {
    exit = { code, signal };
    finish();
  });
}

const args = process.argv.slice(2);
report({ args, env: { ...process.env }, cwd: process.cwd() });
if (args[0] === "--version") {
  process.stdout.write(`${FAKE_AGY_VERSION}\n`);
} else if (args[0] === "acp") {
  acp(args.slice(1));
} else {
  process.stderr.write(`fake agy: unknown command ${args.join(" ")}\n`);
  process.exitCode = 1;
}
