// A one-time live check that the standalone `ari-driver` (the Bun-built
// executable from scripts/build-binary.ts) runs the real Claude Code. With no
// `node` and no `bun` on its PATH it:
//   1. runs `maintenance.install` on a `claude` instance, which downloads the
//      pinned Claude Agent SDK, and only the SDK, from the npm registry
//      (https://registry.npmjs.org, the driver default) and verifies it;
//   2. prints `instance/status`, which must report the pinned SDK version;
//   3. runs one turn, "Reply with exactly the word: ok", on the `haiku` model
//      with the user's Claude sign-in, and prints every event.
// It spends the user's Claude quota, so it runs only with ARI_LIVE_RECORD=1,
// checked before it loads anything else or starts anything. No gate step and
// no CI workflow sets ARI_LIVE_RECORD, and nothing runs this script for them.
//
// Usage: ARI_LIVE_RECORD=1 node scripts/live-claude-standalone.ts [--binary <path>] [--no-turn]
//   --binary   the ari-driver to run; build/standalone/<this platform>/ari-driver by default
//              (`pnpm run build:binary` builds it)
//   --no-turn  steps 1 and 2 only: install and status, no turn and so no quota spent
// Environment:
//   TMPDIR                   where the workspace goes, the SDK install with it; it must be outside HOME
//   ARI_RECORD_CLAUDE_MODEL  the model; Claude Code's `haiku` alias by default
//
// The session is kept apart from the user's own Claude setup exactly as the
// Claude recorder keeps it (test/recordings/claude/run.ts, whose code this
// reuses): a temp workspace whose `claude-config/` is CLAUDE_CONFIG_DIR and
// whose `claude-home/` is HOME, for both ari-driver and Claude Code;
// `settingSources: []`, so no user, project or local settings, CLAUDE.md or
// hooks; auto memory, claude.ai MCP connectors and nonessential traffic off;
// and a host that gives the session no MCP server. The sign-in: the user's
// `.credentials.json` is copied into the isolated config dir, and a copy
// Claude Code refreshed goes back to the user's file under Claude Code's own
// write lock, or into a recovery file beside it
// (test/recordings/credential-file.ts and recovery.ts, shared by the
// recorders), so a rotated token is never lost. The workspace is removed
// at the end unless it holds the only copy of a refreshed sign-in.
//
// It hashes the user's Claude settings files (settings.json and CLAUDE.md in
// the Claude config dir, and ~/.claude.json) before and after, and fails when
// one changed. It never reads any other file of the user's Claude setup.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
// Type-only: erased before the script runs, so it loads nothing.
import type { AriEvent } from "../src/index.ts";
import { LIVE_RECORD_VARIABLE } from "./record-claude.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "..");

export const LIVE_CHECK_PROMPT = "Reply with exactly the word: ok";

/** Programs a host without Node or Bun would not have on its PATH. */
const NODE_AND_BUN_PROGRAMS = ["node", "nodejs", "npm", "npx", "corepack", "pnpm", "yarn", "bun", "bunx"];

function log(line: string): void {
  process.stdout.write(`live-claude-standalone: ${line}\n`);
}

/** JSON with every `email` value replaced, so a printed status or event names no account. */
function printable(value: unknown): string {
  return JSON.stringify(value, (key, field: unknown) => (key === "email" && typeof field === "string" ? "<redacted>" : field));
}

async function main(argv: readonly string[]): Promise<number> {
  if (process.env[LIVE_RECORD_VARIABLE] !== "1") {
    process.stderr.write(
      `live-claude-standalone: refusing to start a real Claude session. This runs one turn on the real Claude Code through the standalone ari-driver and spends your Claude quota; set ${LIVE_RECORD_VARIABLE}=1 to run it, for example \`${LIVE_RECORD_VARIABLE}=1 node scripts/live-claude-standalone.ts\`.\n`,
    );
    return 2;
  }
  // Only now: nothing above loads the driver or starts a process.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { createHash } = await import("node:crypto");
  const { executableName, hostTarget } = await import("./build-binary.ts");
  const { CLAUDE_SDK_VERSION } = await import("../src/meta/claude.ts");
  const { CLAUDE_INSTALL_RECORD, managedClaudeSdkDirectory } = await import("../src/drivers/claude/install.ts");
  const { createCoordination, createNodeHostServices } = await import("../src/node/index.ts");
  const { startAriDriver } = await import("../src/wire/index.ts");
  const { CLAUDE_CREDENTIAL_FILE, claudeCredentialLock, recordModel, userCredentialFile } = await import("../test/recordings/claude/record.ts");
  const { CLAUDE_RECORDER_INSTANCE_ID, claudeInstanceEnvironment, claudeRecorderConfig, createClaudeLayout } = await import("../test/recordings/claude/run.ts");
  const { copyCredentialFile, returnCredentialFile } = await import("../test/recordings/credential-file.ts");
  const { CredentialsKeptError } = await import("../test/recordings/recovery.ts");

  const target = hostTarget();
  let binary = target === undefined ? undefined : path.join(REPO_ROOT, "build", "standalone", target, executableName("ari-driver", target));
  let runTurn = true;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--binary" && argv[index + 1] !== undefined && argv[index + 1] !== "") {
      binary = path.resolve(argv[index + 1]!);
      index += 1;
    } else if (argv[index] === "--no-turn") {
      runTurn = false;
    } else {
      process.stderr.write(`live-claude-standalone: unknown argument ${JSON.stringify(argv[index])}; the options are --binary <path> and --no-turn\n`);
      return 2;
    }
  }
  if (binary === undefined || !fs.existsSync(binary)) {
    process.stderr.write(`live-claude-standalone: no ari-driver at ${binary ?? `build/standalone/<target> (this platform, ${process.platform}-${process.arch}, is no release target)`}; run \`pnpm run build:binary\` first, or name one with --binary\n`);
    return 2;
  }
  const userCredential = userCredentialFile(process.env);
  if (userCredential === undefined || !fs.existsSync(userCredential)) {
    process.stderr.write(`live-claude-standalone: no Claude sign-in at ${userCredential ?? "~/.claude/.credentials.json"}; run \`claude auth login\` first\n`);
    return 2;
  }
  const home = process.env["HOME"] ?? os.homedir();
  const userConfigDir = path.dirname(userCredential);
  // A file the user does not have hashes as "missing", so one created during the run counts as a change too.
  const watched = [path.join(userConfigDir, "settings.json"), path.join(home, ".claude.json"), path.join(userConfigDir, "CLAUDE.md")];
  const hashes = (): Map<string, string> => new Map(watched.map((file) => [file, fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "missing"]));
  const before = hashes();
  for (const [file, hash] of before) log(`before: sha256 ${hash}  ${file}`);

  const layout = createClaudeLayout("ari-claude-standalone-live-");
  const outsideHome = path.relative(fs.realpathSync(home), layout.root).startsWith("..");
  if (!outsideHome) {
    fs.rmSync(layout.root, { recursive: true, force: true });
    process.stderr.write(`live-claude-standalone: the workspace would be ${layout.root}, inside ${home}; set TMPDIR to a directory outside it\n`);
    return 2;
  }
  log(`workspace ${layout.root}`);

  // A PATH as a host without Node or Bun has it: this machine's /usr/local/bin and /usr/bin, without those programs.
  const bin = path.join(layout.root, "bin");
  fs.mkdirSync(bin, { mode: 0o700 });
  let linked = 0;
  for (const directory of [...new Set(["/usr/local/bin", "/usr/bin", "/bin"].filter((each) => fs.existsSync(each)).map((each) => fs.realpathSync(each)))]) {
    for (const name of fs.readdirSync(directory)) {
      if (NODE_AND_BUN_PROGRAMS.includes(name) || fs.existsSync(path.join(bin, name))) continue;
      fs.symlinkSync(path.join(directory, name), path.join(bin, name));
      linked += 1;
    }
  }
  const onPath = NODE_AND_BUN_PROGRAMS.filter((name) => fs.existsSync(path.join(bin, name)));
  if (onPath.length > 0) {
    fs.rmSync(layout.root, { recursive: true, force: true });
    throw new Error(`${onPath.join(", ")} would be on the PATH`);
  }
  log(`PATH ${bin}: ${linked} programs from /usr/local/bin and /usr/bin, none of ${NODE_AND_BUN_PROGRAMS.join(", ")}`);

  const instanceEnvironment = claudeInstanceEnvironment(layout, { PATH: bin });
  // ari-driver gets the same environment: the SDK's session functions run in it and read CLAUDE_CONFIG_DIR.
  const driverEnvironment = {
    ...instanceEnvironment,
    XDG_CONFIG_HOME: path.join(layout.home, ".config"),
    XDG_DATA_HOME: path.join(layout.home, ".local", "share"),
    XDG_STATE_HOME: path.join(layout.home, ".local", "state"),
    XDG_CACHE_HOME: path.join(layout.home, ".cache"),
  };
  const model = recordModel(process.env);
  // Over the wire a config is plain JSON values.
  const config: { [field: string]: unknown } = { ...claudeRecorderConfig(model) };
  // A refreshed sign-in goes back under Claude Code's own write lock, so another Claude Code session cannot save between the comparison and the replace.
  const credential = copyCredentialFile(userCredential, path.join(layout.configDir, CLAUDE_CREDENTIAL_FILE), CLAUDE_CREDENTIAL_FILE, claudeCredentialLock(userCredential))!;

  const failures: string[] = [];
  let workspaceKept = false;
  try {
    const host = await createNodeHostServices<typeof config>({
      hostRoot: path.join(layout.root, "host"),
      instanceId: CLAUDE_RECORDER_INSTANCE_ID,
      config: { get: async () => ({ config }) },
      attachments: { resolve: async () => null },
      hostTools: {
        mcpServerFor: async () => {
          throw new Error("the live check gives the session no tool server");
        },
      },
      callbacks: { register: async (flowId) => ({ url: `http://127.0.0.1:9/${flowId}` }) },
      coordination: createCoordination(),
      writeDiagnostic: (record) => log(`diagnostic: ${printable(record)}`),
      baseEnv: driverEnvironment,
    });
    log(`starting ${binary} claude, config ${JSON.stringify(config)}`);
    const connection = await startAriDriver({ driver: "claude", command: [binary], env: driverEnvironment, cwd: layout.cwd, envPolicy: { stripAmbient: [] } });
    try {
      const instance = await connection.driver.create(host, { instanceId: CLAUDE_RECORDER_INSTANCE_ID, config, environment: instanceEnvironment });
      try {
        log(`instance/status before the install: ${printable(await instance.status())}`);
        const started = Date.now();
        await instance.maintenance!.install!();
        log(`maintenance.install finished in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        const installed = managedClaudeSdkDirectory(host.paths.cacheDir);
        const record = JSON.parse(fs.readFileSync(path.join(installed, CLAUDE_INSTALL_RECORD), "utf8")) as { files: Array<{ path: string; size: number; sha256: string }> };
        log(`installed in ${installed}: ${record.files.length} files`);
        for (const file of record.files.filter((each) => each.path === "package.json" || each.path === "sdk.mjs")) {
          log(`  ${file.path}: ${file.size} bytes, sha256 ${file.sha256}`);
        }
        const status = await instance.status();
        log(`instance/status after the install: ${printable(status)}`);
        // No turn on an install the status does not report: the turn would spend quota to prove nothing.
        if (status.installed !== true || status.version !== CLAUDE_SDK_VERSION) throw new Error(`instance/status does not report SDK ${CLAUDE_SDK_VERSION} installed, so the turn was not run`);
        if (!runTurn) log("--no-turn: no turn run");
        else {
          const session = await instance.openSession({});
          const events: AriEvent[] = [];
          void (async () => {
            for await (const event of session.events()) {
              events.push(event);
              log(`event: ${printable(event)}`);
            }
          })();
          try {
            const thread = await session.createThread({ cwd: layout.cwd, policy: { mode: "approval_required", interaction: "default", cwd: layout.cwd } });
            log(`turn: ${JSON.stringify(LIVE_CHECK_PROMPT)} on ${model}`);
            const accepted = await session.startTurn({ threadId: thread.id, clientTurnKey: "live-check-1", intent: "start", content: [{ type: "text", text: LIVE_CHECK_PROMPT }] });
            log(`startTurn: ${printable(accepted)}`);
            const deadline = Date.now() + 180_000;
            for (;;) {
              const terminal = events.find((event) => event.body.type === "turn.terminal");
              if (terminal !== undefined) {
                const terminalStatus = terminal.body.type === "turn.terminal" ? terminal.body.status : undefined;
                log(`turn.terminal ${terminalStatus}`);
                if (terminalStatus !== "completed") failures.push(`the turn ended ${terminalStatus}, not completed`);
                break;
              }
              if (Date.now() > deadline) {
                failures.push("no turn.terminal within 180 s");
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          } finally {
            await session.close();
          }
        }
      } finally {
        await instance.dispose();
      }
    } finally {
      await connection.close();
      const tail = connection.stderrTail().trim();
      if (tail !== "") log(`ari-driver stderr: ${tail}`);
      await host.dispose();
    }
  } catch (error) {
    failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    // Claude Code and ari-driver have exited: a sign-in Claude Code refreshed goes back now, or into the recovery file.
    const refreshed = fs.existsSync(credential.copy) && !fs.readFileSync(credential.copy).equals(credential.original);
    try {
      returnCredentialFile(credential, "Claude Code");
      log(refreshed ? `Claude Code refreshed the sign-in; the refreshed one went back to ${credential.real}` : "Claude Code did not change the sign-in");
    } catch (error) {
      if (error instanceof CredentialsKeptError) failures.push(`${error.message} (the recovery file is ${error.recoveryFile}; keep it until you have used it)`);
      else {
        workspaceKept = true;
        failures.push(`${error instanceof Error ? error.message : String(error)}. The workspace ${layout.root} is kept: its claude-config/${CLAUDE_CREDENTIAL_FILE} may hold the only copy of a refreshed sign-in. Write it over ${credential.real}, then delete the workspace.`);
      }
    }
    if (!workspaceKept) fs.rmSync(layout.root, { recursive: true, force: true });
  }

  const after = hashes();
  for (const [file, hash] of after) {
    const same = before.get(file) === hash;
    log(`after:  sha256 ${hash}  ${file} (${same ? "unchanged" : "CHANGED"})`);
    if (!same) failures.push(`${file} changed during the run`);
  }
  if (failures.length === 0) {
    log(`passed: SDK ${CLAUDE_SDK_VERSION} installed${runTurn ? " and a turn completed" : ""} through ${binary}`);
    return 0;
  }
  for (const failure of failures) process.stderr.write(`live-claude-standalone: FAILED: ${failure}\n`);
  return 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT) {
  process.exitCode = await main(process.argv.slice(2));
}
