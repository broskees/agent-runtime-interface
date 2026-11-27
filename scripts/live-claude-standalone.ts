// A one-time live check that the standalone `ari-driver` (the Bun-built
// executable from scripts/build-binary.ts) runs the real Claude Code. With no
// `node` and no `bun` on its PATH it:
//   1. starts a `claude` instance with no SDK config: the binary has the
//      pinned SDK compiled in, and the user's own Claude Code runs (ARI
//      installs nothing, and neither does this script);
//   2. prints `instance/status`, which must report the pinned SDK version;
//   3. runs one turn, "Reply with exactly the word: ok", on the `haiku` model
//      with the user's Claude sign-in, and prints every event.
// It spends the user's Claude quota, so it runs only with ARI_LIVE_RECORD=1,
// checked before it loads the driver or SDK or starts a process. No gate step and
// no CI workflow sets ARI_LIVE_RECORD, and nothing runs this script for them.
//
// Usage: ARI_LIVE_RECORD=1 node scripts/live-claude-standalone.ts [options]
//   --binary   the ari-driver to run; build/standalone/<this platform>/ari-driver by default
//              (`pnpm run build:binary` builds it)
//   --no-turn  steps 1 and 2 only: load the compiled-in SDK and status, no turn and so no quota spent
//   --claude   a separately integrity-verified temporary compatible CLI, if the installed one is too old
//   --attempt-dir <path>  existing private scratch directory; reuse it across interruptions
//   --driver-death       the separate second turn, allowed only after the exact-reply turn passed
// Environment:
//   TMPDIR                   where the workspace goes; it must be outside HOME
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
// It hashes the user's installed Claude executable and settings files
// (settings.json and CLAUDE.md in ~/.claude, and ~/.claude.json) before and after, and fails when
// one changed. It never reads any other file of the user's Claude setup.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
// Type-only: erased before the script runs, so it loads nothing.
import type { AriEvent } from "../src/index.ts";
import { reduceEvents } from "../src/host/reducer.ts";
import { LIVE_RECORD_VARIABLE } from "./record-claude.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "..");

export const LIVE_CHECK_PROMPT = "Reply with exactly the word: ok";

export function completedAssistantText(events: readonly AriEvent[], turnId: string): string {
  // The opening upsert carries kind; the settling upsert carries the full text.
  // Fold durable patches by item id rather than reading ephemeral deltas.
  const { items } = reduceEvents(events.filter((event) => event.turnId === turnId && event.body.type === "item.upsert"));
  return [...items.values()].filter((item) => item.kind === "assistant_message" && item.status === "completed").map((item) => item.text ?? "").join("");
}

/** Programs a host without Node or Bun would not have on its PATH. */
const NODE_AND_BUN_PROGRAMS = ["node", "nodejs", "npm", "npx", "corepack", "pnpm", "yarn", "bun", "bunx"];

function log(line: string): void {
  process.stdout.write(`live-claude-standalone: ${line}\n`);
}

/** JSON with every `email` value replaced, so a printed status or event names no account. */
function printable(value: unknown): string {
  return JSON.stringify(value, (key, field: unknown) => /email|token|secret|credential|authorization|api.?key/i.test(key) && typeof field === "string" ? "<redacted>" : field);
}

class SmokeFailure extends Error {}

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
  const { CLAUDE_SDK_VERSION, CLAUDE_TESTED_CLAUDE_CODE_VERSION } = await import("../src/meta/claude.ts");
  const { createCoordination, createNodeHostServices, resolveExecutable } = await import("../src/node/index.ts");
  const { startAriDriver } = await import("../src/wire/index.ts");
  const { CLAUDE_CREDENTIAL_FILE, claudeCredentialLock } = await import("../test/recordings/claude/record.ts");
  const { CLAUDE_RECORDER_INSTANCE_ID, claudeInstanceEnvironment, claudeRecorderConfig, createClaudeLayout } = await import("../test/recordings/claude/run.ts");
  const { copyCredentialFile, returnCredentialFile } = await import("../test/recordings/credential-file.ts");
  const { CredentialsKeptError } = await import("../test/recordings/recovery.ts");
  const { processGroupOf, survivorsAt } = await import("../test/helpers/process-groups.ts");

  const target = hostTarget();
  let binary = target === undefined ? undefined : path.join(REPO_ROOT, "build", "standalone", target, executableName("ari-driver", target));
  let runTurn = true;
  let driverDeath = false;
  let compatibleClaude: string | undefined;
  let attemptDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--binary" && argv[index + 1] !== undefined && argv[index + 1] !== "") {
      binary = path.resolve(argv[index + 1]!);
      index += 1;
    } else if (argv[index] === "--no-turn") {
      runTurn = false;
    } else if (argv[index] === "--driver-death") {
      driverDeath = true;
    } else if ((argv[index] === "--claude" || argv[index] === "--attempt-dir") && argv[index + 1]) {
      const value = path.resolve(argv[index + 1]!);
      if (argv[index] === "--claude") compatibleClaude = value;
      else attemptDir = value;
      index += 1;
    } else {
      process.stderr.write(`live-claude-standalone: unknown or incomplete option ${JSON.stringify(argv[index])}\n`);
      return 2;
    }
  }
  if (binary === undefined || !fs.existsSync(binary)) {
    process.stderr.write(`live-claude-standalone: no ari-driver at ${binary ?? `build/standalone/<target> (this platform, ${process.platform}-${process.arch}, is no release target)`}; run \`pnpm run build:binary\` first, or name one with --binary\n`);
    return 2;
  }
  if (driverDeath && (!runTurn || process.platform !== "linux")) {
    process.stderr.write("live-claude-standalone: --driver-death requires a turn and Linux /proc\n");
    return 2;
  }
  const home = process.env["HOME"] ?? os.homedir();
  const homeRealPath = fs.realpathSync(home);
  const outsideHome = (file: string): boolean => path.relative(homeRealPath, fs.realpathSync(file)).startsWith(`..${path.sep}`);
  if (runTurn && (attemptDir === undefined || !outsideHome(attemptDir) || (fs.statSync(attemptDir).mode & 0o077) !== 0)) {
    process.stderr.write("live-claude-standalone: a live turn requires --attempt-dir, an existing private directory outside HOME; reuse it across resumptions\n");
    return 2;
  }
  const attempt = attemptDir === undefined ? undefined : path.join(attemptDir, driverDeath ? "2-driver-death.attempted" : "1-exact-reply.attempted");
  const exactReplyPassed = attemptDir === undefined ? undefined : path.join(attemptDir, "1-exact-reply.passed");
  if (runTurn && (fs.existsSync(attempt!) || (driverDeath && !fs.existsSync(exactReplyPassed!)))) {
    process.stderr.write("live-claude-standalone: this turn was already attempted, or the required first turn did not pass; no turn run\n");
    return 2;
  }
  const installedClaude = await resolveExecutable("claude", process.env["PATH"]);
  if (installedClaude === null) {
    process.stderr.write("live-claude-standalone: the user's installed claude was not found on PATH\n");
    return 2;
  }
  const selectedClaude = compatibleClaude === undefined ? fs.realpathSync(installedClaude) : fs.realpathSync(compatibleClaude);
  if (compatibleClaude !== undefined && !outsideHome(selectedClaude)) {
    process.stderr.write("live-claude-standalone: --claude must name the compatible copy in scratch, outside HOME\n");
    return 2;
  }
  // Only this sign-in is eligible. Ignore ambient config paths, tokens, API keys and cloud providers.
  const userConfigDir = path.join(home, ".claude");
  const userCredential = path.join(userConfigDir, CLAUDE_CREDENTIAL_FILE);
  if (runTurn && (!fs.existsSync(userCredential) || fs.realpathSync(userCredential) !== path.join(homeRealPath, ".claude", CLAUDE_CREDENTIAL_FILE))) {
    process.stderr.write("live-claude-standalone: no local sign-in in ~/.claude/.credentials.json; no turn run\n");
    return 2;
  }
  // A file the user does not have hashes as "missing", so one created during the run counts as a change too.
  const watched = [path.join(userConfigDir, "settings.json"), path.join(home, ".claude.json"), path.join(userConfigDir, "CLAUDE.md"), installedClaude];
  const hashes = (): Map<string, string> => new Map(watched.map((file) => {
    if (!fs.existsSync(file)) return [file, "missing"];
    const real = fs.realpathSync(file);
    if (file !== installedClaude && real !== path.join(homeRealPath, path.relative(home, file))) throw new SmokeFailure(`refusing to hash a settings file linked outside its named path: ${file}`);
    return [file, `${createHash("sha256").update(fs.readFileSync(real)).digest("hex")}  ${real}`];
  }));
  const before = hashes();
  for (const [file, hash] of before) log(`before: sha256 ${hash}  ${file}`);

  const layout = createClaudeLayout("ari-claude-standalone-live-");
  if (!outsideHome(layout.root)) {
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
      const link = path.join(bin, name);
      if (name === "claude" || NODE_AND_BUN_PROGRAMS.includes(name) || fs.existsSync(link)) continue;
      try { fs.symlinkSync(path.join(directory, name), link); } catch (error) {
        // A dangling symlink in an earlier directory still occupies its name.
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      linked += 1;
    }
  }
  const onPath = NODE_AND_BUN_PROGRAMS.filter((name) => fs.existsSync(path.join(bin, name)));
  if (onPath.length > 0) {
    fs.rmSync(layout.root, { recursive: true, force: true });
    throw new Error(`${onPath.join(", ")} would be on the PATH`);
  }
  log(`PATH ${bin}: ${linked} programs from /usr/local/bin and /usr/bin, none of ${NODE_AND_BUN_PROGRAMS.join(", ")}`);
  fs.symlinkSync(selectedClaude, path.join(bin, "claude"));
  log(`Claude Code on the isolated PATH: ${selectedClaude}`);

  const instanceEnvironment = claudeInstanceEnvironment(layout, { PATH: bin });
  // ari-driver gets the same environment: the SDK's session functions run in it and read CLAUDE_CONFIG_DIR.
  const driverEnvironment = {
    ...instanceEnvironment,
    XDG_CONFIG_HOME: path.join(layout.home, ".config"),
    XDG_DATA_HOME: path.join(layout.home, ".local", "share"),
    XDG_STATE_HOME: path.join(layout.home, ".local", "state"),
    XDG_CACHE_HOME: path.join(layout.home, ".cache"),
  };
  const model = "haiku";
  // Over the wire a config is plain JSON values.
  const config: { [field: string]: unknown } = { ...claudeRecorderConfig(model) };

  const failures: string[] = [];
  let workspaceKept = false;
  let credential: ReturnType<typeof copyCredentialFile>;
  try {
    // Do not even copy a credential for the installed-CLI rejection check.
    if (runTurn) {
      credential = copyCredentialFile(userCredential, path.join(layout.configDir, CLAUDE_CREDENTIAL_FILE), CLAUDE_CREDENTIAL_FILE, claudeCredentialLock(userCredential));
      if (credential === undefined) throw new SmokeFailure("the local sign-in was not copied; no turn run");
    }
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
      writeDiagnostic: () => undefined, // Vendor stderr is not safe to print verbatim.
      baseEnv: driverEnvironment,
    });
    log(`starting ${binary} claude, config ${JSON.stringify(config)}`);
    let killedDriver = false;
    try {
      const connection = await startAriDriver({ driver: "claude", command: [binary], env: driverEnvironment, cwd: layout.cwd, envPolicy: { stripAmbient: [] } });
      try {
        const instance = await connection.driver.create(host, { instanceId: CLAUDE_RECORDER_INSTANCE_ID, config, environment: instanceEnvironment });
        const status = await instance.status();
        log(`instance/status: ${printable(status)}`);
        const older = status.state === "unavailable" && status.error?.code === "driver_unavailable" && status.error.message.includes(`is older than ${CLAUDE_TESTED_CLAUDE_CODE_VERSION}`) && status.error.message.includes("Update Claude Code");
        if (older && compatibleClaude === undefined && !runTurn) log("the installed Claude Code is too old; no turn run");
        else if (status.state !== "ready" || status.installed !== true || status.version !== CLAUDE_SDK_VERSION) {
          throw new SmokeFailure(`instance/status is not ready with SDK ${CLAUDE_SDK_VERSION}; no turn run`);
        } else if (!runTurn) log("--no-turn: no turn run");
        else {
          if (status.auth?.status !== "authenticated" || status.auth.scope !== "ambient") throw new SmokeFailure("no authenticated Claude sign-in in the isolated config; no turn run");
          const session = await instance.openSession({ handshakeTimeoutMs: 30_000 });
          const events: AriEvent[] = [];
          const eventsDone = (async () => {
            for await (const event of session.events()) {
              events.push(event);
              // Log the event stream without opaque vendor strings, including
              // error messages and model output other than the expected word.
              const body = event.body;
              const details = body.type === "turn.terminal" ? { status: body.status, failure: body.failure?.class }
                : body.type === "item.upsert" ? { kind: body.item.kind, status: body.item.status, ...(body.item.text === "ok" ? { text: "ok" } : {}) }
                : {};
              log(`event: ${printable({ type: body.type, ...details })}`);
            }
          })().catch(() => undefined);
          try {
            const thread = await session.createThread({ cwd: layout.cwd, policy: { mode: "approval_required", interaction: "default", cwd: layout.cwd } });
            // Reserve the attempt atomically before sending a prompt. Even an
            // interrupted attempt is spent; only the same ledger may be reused.
            fs.writeFileSync(attempt!, `${new Date().toISOString()}\n`, { flag: "wx", mode: 0o600, flush: true });
            log(`reserved live attempt ${driverDeath ? 2 : 1}/2 in ${attempt}`);
            log(`turn: ${JSON.stringify(LIVE_CHECK_PROMPT)} on ${model}`);
            const accepted = await session.startTurn({ threadId: thread.id, clientTurnKey: "live-check-1", intent: "start", content: [{ type: "text", text: LIVE_CHECK_PROMPT }] });
            log(`startTurn: ${printable(accepted)}`);
            if (accepted.status !== "accepted") throw new SmokeFailure("the live turn was not accepted");
            if (driverDeath) {
              const driverPid = connection.child.pid!;
              const children = fs.readFileSync(`/proc/${driverPid}/task/${driverPid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
              const pid = children.find((child) => {
                try { return fs.readlinkSync(`/proc/${child}/exe`) === selectedClaude; } catch { return false; }
              });
              if (pid === undefined || processGroupOf(pid) !== pid) throw new SmokeFailure("could not identify a live, guarded Claude Code child of ari-driver");
              if (events.some((event) => event.body.type === "turn.terminal" || event.body.type === "request.upsert")) throw new SmokeFailure("the turn ended or requested approval before the driver-death check");
              const driverExit = new Promise((resolve) => connection.child.once("exit", (_code, signal) => resolve(signal)));
              const killedAt = Date.now();
              log(`SIGKILL ari-driver pid ${driverPid}; Claude Code pid ${pid}, group ${pid}, from /proc`);
              if (!connection.child.kill("SIGKILL")) throw new SmokeFailure("could not SIGKILL this run's ari-driver");
              killedDriver = true;
              const survivors = await survivorsAt([{ pid, groupId: pid, guardPids: [], grandchildPid: undefined }], killedAt + 5_000);
              if (survivors.length > 0) {
                workspaceKept = true;
                throw new SmokeFailure(`still present at the 5 s deadline: ${survivors.join(", ")}; workspace kept at ${layout.root}`);
              }
              if (await driverExit !== "SIGKILL") throw new SmokeFailure("ari-driver did not exit by SIGKILL");
              log(`Claude Code pid ${pid} and group ${pid} gone within ${Date.now() - killedAt} ms`);
            } else {
              const deadline = Date.now() + 180_000;
              for (;;) {
                if (events.some((event) => event.body.type === "request.upsert")) throw new SmokeFailure("the turn requested approval; stopping without approving anything");
                const terminal = events.find((event) => event.body.type === "turn.terminal");
                if (terminal?.body.type === "turn.terminal") {
                  log(`turn.terminal ${terminal.body.status}`);
                  if (terminal.body.status !== "completed") throw new SmokeFailure(`the turn ended ${terminal.body.status} (${terminal.body.failure?.class ?? "no failure class"})`);
                  const reply = completedAssistantText(events, accepted.turnId);
                  if (reply !== "ok") throw new SmokeFailure("the completed reply was not exactly ok");
                  break;
                }
                if (Date.now() > deadline) throw new SmokeFailure("no turn.terminal within 180 s");
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
            }
          } finally {
            if (!killedDriver) await session.close();
            await eventsDone;
          }
        }
      } finally {
        // Connection close owns instance disposal and local process cleanup.
        try { await connection.close(); } catch {
          workspaceKept = credential !== undefined;
          throw new SmokeFailure(`could not confirm ari-driver shutdown; inspect the isolated workspace at ${layout.root}`);
        }
      }
    } finally {
      await host.dispose();
    }
  } catch (error) {
    failures.push(error instanceof SmokeFailure ? error.message : "unexpected smoke error (vendor error details withheld); no retry");
  } finally {
    // Claude Code and ari-driver have exited: a sign-in Claude Code refreshed goes back now, or into the recovery file.
    if (!workspaceKept && credential !== undefined) {
      try {
        const refreshed = fs.existsSync(credential.copy) && !fs.readFileSync(credential.copy).equals(credential.original);
        returnCredentialFile(credential, "Claude Code");
        log(refreshed ? `Claude Code refreshed the sign-in; the refreshed one went back to ${credential.real}` : "Claude Code did not change the sign-in");
      } catch (error) {
        if (error instanceof CredentialsKeptError) failures.push(`the recovery file is ${error.recoveryFile}; keep it until you have used it`);
        else {
          workspaceKept = true;
          failures.push(`the workspace ${layout.root} is kept: its claude-config/${CLAUDE_CREDENTIAL_FILE} may hold the only copy of a refreshed sign-in`);
        }
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
    if (runTurn && !driverDeath) fs.writeFileSync(exactReplyPassed!, "passed\n", { flag: "wx", mode: 0o600, flush: true });
    log(`passed: SDK ${CLAUDE_SDK_VERSION} compiled in${!runTurn ? " (no turn)" : driverDeath ? " and the Claude Code group ended" : " and the exact reply completed"} through ${binary}`);
    return 0;
  }
  for (const failure of failures) process.stderr.write(`live-claude-standalone: FAILED: ${failure}\n`);
  return 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`live-claude-standalone: ${error instanceof SmokeFailure ? error.message : "unexpected smoke error (details withheld); no retry"}\n`);
    process.exitCode = 1;
  }
}
