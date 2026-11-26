// The Codex recorder and replay, end to end against the fake Codex app-server
// (./fake-app-server.ts) run as `codex app-server` by a fake `codex` on PATH.
// The recording function scripts/record-codex.ts calls records all six
// scenarios through the process tap (source `fake`); each recording holds the
// spawn requests with their variables' names only, every stdin and stdout
// line in order, the stderr lines and the exits; each replays through a fresh
// driver from `codexDriver` over the replay process service with every
// scenario assertion passing. Replay fails loudly, naming the file, the line
// and both frames, when the driver writes another frame, when recorded frames
// are left over, and when a recorded frame the outcome depends on is missing.
// The sanitiser replaces the OS user name, a home path, an email, a secret
// environment value, an account id and each account detail in a recorded
// Codex frame.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scanRecordingText } from "../../../scripts/check-recordings.ts";
import { isAriError } from "../../../src/errors.ts";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { encodeRecording, readRecording } from "../../recordings/format.ts";
import type { Frame, Recording } from "../../recordings/format.ts";
import { CODEX_IGNORED_FIELDS, codexNativeAnswers, codexTurnFrames, codexTurnsDependedOn } from "../../recordings/codex/frames.ts";
import { CODEX_PROTOCOL_WORDS } from "../../recordings/codex/protocol-words.ts";
import { recordCodex } from "../../recordings/codex/record.ts";
import type { CodexRecordOutcome } from "../../recordings/codex/record.ts";
import { replayCodex } from "../../recordings/codex/replay.ts";
import { startTurnAfterItsText } from "../../recordings/late-start-turn.ts";
import { NEUTRAL_CODEX_CREDITS, NEUTRAL_PID, NEUTRAL_RATE_LIMIT_INFO, NEUTRAL_RATE_LIMIT_WINDOWS, NEUTRAL_SHELL, NEUTRAL_SOCKET_PATH, NEUTRAL_SPEND_CONTROL_LIMIT, NEUTRAL_TIME, NEUTRAL_TMP_PATH, PLACEHOLDERS, createSanitiser } from "../../recordings/sanitiser.ts";
import { SCENARIOS, SCENARIO_NAMES, ScenarioCheckError, checkScenario } from "../../recordings/scenarios.ts";
import type { ScenarioName, ScenarioRun } from "../../recordings/scenarios.ts";
import { ReplayCheckError, ReplayDriftError, showFrame } from "../../recordings/sequencer.ts";
import { resanitiseRecording } from "../../recordings/resanitise.ts";
import { replacedProtocolWords, wholeWordsOf } from "../../recordings/whole-words.ts";
import { FAKE_CODEX_CLI_VERSION, FAKE_SIGN_IN, fakeCodexOnPath } from "./fake-codex.ts";
import type { FakeCodex } from "./fake-codex.ts";

const DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), "ari-codex-recordings-"));
process.on("exit", () => fs.rmSync(DIRECTORY, { recursive: true, force: true }));

interface Recorded {
  readonly outcomes: CodexRecordOutcome[];
  readonly fake: FakeCodex;
  readonly env: { [name: string]: string };
}

/** Records `scenarios` from a fresh fake `codex` through the recording function, with the recorder's environment `env` and a HOME holding a synthetic sign-in. */
async function recordFake(label: string, env: { [name: string]: string } = {}, scenarios: readonly ScenarioName[] = SCENARIO_NAMES, user?: string): Promise<Recorded> {
  const fake = fakeCodexOnPath(DIRECTORY);
  const home = fs.mkdtempSync(path.join(DIRECTORY, "home-"));
  fs.mkdirSync(path.join(home, ".codex"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), FAKE_SIGN_IN, { mode: 0o600 });
  const recorderEnv = { PATH: `${fake.bin}${path.delimiter}${process.env["PATH"] ?? "/usr/bin:/bin"}`, HOME: home, USER: "ari-test-user", ...fake.env, ...env };
  const systemConfigDir = fs.mkdtempSync(path.join(DIRECTORY, "etc-codex-"));
  const outcomes = await recordCodex({ scenarios, outDir: path.join(DIRECTORY, label), source: "fake", env: recorderEnv, systemConfigDir, timeoutMs: 20_000, ...(user === undefined ? {} : { user }) });
  return { outcomes, fake, env: recorderEnv };
}

let recorded: Promise<Recorded> | undefined;

/** Records all six scenarios from the fake once for this file. */
function recordAll(): Promise<Recorded> {
  recorded ??= recordFake("recordings");
  return recorded;
}

async function recordingOf(name: ScenarioName): Promise<Recording> {
  const outcome = (await recordAll()).outcomes.find((each) => each.scenario === name)!;
  return readRecording(outcome.file!);
}

/** Writes a signed copy of `recording` with `edit` applied to its frames, and returns the copy's path. */
function editedCopy(recording: Recording, label: string, edit: (frames: Frame[]) => void): { file: string; frames: Frame[] } {
  const frames = recording.frames.map((entry) => structuredClone(entry.frame));
  edit(frames);
  const { type: _type, format: _format, sha256: _sha256, ...metadata } = recording.header;
  const file = path.join(DIRECTORY, "copies", `${recording.header.scenario}-${label}.ndjson`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeRecording(metadata, frames));
  return { file, frames };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Message = { [key: string]: unknown };
const messageOf = (frame: Frame): Message => frame["message"] as Message;

/** The process ids of the fake's app-servers that served a session: not the recorder's model listing, which is not recorded. */
function sessionServers(fake: FakeCodex): Set<number> {
  const wire = fake.wire() as Array<{ pid: number; direction: string; line: string }>;
  const listing = new Set(wire.filter((entry) => entry.direction === "in" && entry.line.includes('"method":"model/list"')).map((entry) => entry.pid));
  return new Set(wire.map((entry) => entry.pid).filter((pid) => !listing.has(pid)));
}

test("the Codex recording function records all six scenarios from the fake app-server run as codex app-server, through the process tap, each to its own file with source fake", async () => {
  const { outcomes, fake } = await recordAll();
  assert.deepEqual(
    outcomes.map((outcome) => outcome.scenario),
    [...SCENARIO_NAMES],
  );
  for (const outcome of outcomes) {
    assert.equal(outcome.error, undefined, `${outcome.scenario}: ${outcome.error?.message}`);
    assert.equal(outcome.file, path.join(DIRECTORY, "recordings", `${outcome.scenario}.ndjson`));
    const recording = await readRecording(outcome.file!);
    assert.deepEqual(
      { driver: recording.header.driver, vendor: recording.header.vendor, vendorVersion: recording.header.vendorVersion, sdk: recording.header.sdk, sdkVersion: recording.header.sdkVersion, model: recording.header.model, scenario: recording.header.scenario, source: recording.header.source },
      { driver: "codex", vendor: "codex-cli", vendorVersion: FAKE_CODEX_CLI_VERSION, sdk: "codex-app-server", sdkVersion: "rust-v0.172.0", model: "fake-luna", scenario: outcome.scenario, source: "fake" },
    );
    assert.match(recording.header.recorded, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(outcome.frames, recording.frames.length);
    assert.ok(!fs.existsSync(outcome.workspace), `${outcome.scenario}: the temp workspace is gone`);
  }
  const processes = fake.processes();
  assert.equal(processes.filter((each) => each.args[0] === "--version").length, 13, "six untapped header probes and seven recorded session admission probes");
  assert.equal(processes.filter((each) => each.args[0] === "login").length, 7, "one codex login status per session: six scenarios, the resume scenario with two sessions");
  assert.equal(sessionServers(fake).size, 7, "one codex app-server per session");
  assert.equal(processes.filter((each) => each.args[0] === "app-server").length, 13, "and one per scenario for the model listing");
  // scripts/record-codex.ts calls this same function.
  assert.match(fs.readFileSync(path.join(REPO_ROOT, "scripts", "record-codex.ts"), "utf8"), /const \{ CodexModelChoiceError, CodexSignInMissingError, CodexWorkspaceCustomizedError, CodexWorkspaceInHomeError, describeCodexRun, failuresOf, recordCodex \} = await import\("\.\.\/test\/recordings\/codex\/record\.ts"\);/);
});

test("each Codex recording holds the spawn requests with the names, never the values, of their variables, every stdin and stdout line in order, the stderr lines and the exits", async () => {
  const { outcomes, fake, env } = await recordAll();
  const recordings = await Promise.all(outcomes.map((outcome) => readRecording(outcome.file!)));
  const appServerFrames: Frame[] = [];
  for (const recording of recordings) {
    const frames = recording.frames.map((entry) => entry.frame);
    const spawns = frames.filter((frame) => frame.kind === "spawn");
    const sessions = recording.header.scenario === "resume" ? 2 : 1;
    assert.equal(spawns.length, 3 * sessions, `${recording.header.scenario}: per session, codex --version, codex login status and codex app-server`);
    const serverProcs = new Set<unknown>();
    spawns.forEach((spawn, index) => {
      const proc = spawn["proc"];
      const own = frames.filter((frame) => frame["proc"] === proc);
      assert.equal(own[0], spawn, "the spawn comes first");
      const exits = own.filter((frame) => frame.kind === "exit");
      assert.equal(exits.length, 1, "one exit");
      const role = index % 3;
      if (role !== 2) {
        const isVersion = role === 0;
        assert.deepEqual(spawn, { dir: "out", kind: "spawn", proc, command: "codex", args: isVersion ? ["--version"] : ["login", "status"], envNames: [], purpose: "probe", stdin: "ignore", timeoutMs: 10_000 });
        const streams = own.slice(1).filter((frame) => frame.kind !== "exit");
        assert.deepEqual(streams, [isVersion
          ? { dir: "in", kind: "stdout", proc, text: `codex-cli ${FAKE_CODEX_CLI_VERSION}` }
          : { dir: "in", kind: "stderr", proc, text: "Logged in using ChatGPT" }]);
        assert.deepEqual(exits[0], { dir: "in", kind: "exit", proc, code: 0, signal: null });
        const nextSpawn = frames.indexOf(spawns[index + 1]!);
        assert.ok(frames.indexOf(streams[0]!) < nextSpawn && frames.indexOf(exits[0]!) < nextSpawn, "the probe's output and exit both precede the next spawn");
        return;
      }
      serverProcs.add(proc);
      assert.deepEqual(spawn, { dir: "out", kind: "spawn", proc, command: "codex", args: ["app-server"], envNames: [], purpose: "runtime", stdin: "pipe" }, "the driver's request: the recorder's CODEX_HOME is added below the tap, so neither its name nor its value is here");
      assert.ok(own.some((frame) => frame.kind === "close_stdin") && own.some((frame) => frame.kind === "kill"), "the driver's close of the app-server is recorded");
      assert.ok((exits[0]!["code"] === 0 && exits[0]!["signal"] === null) || (exits[0]!["code"] === null && exits[0]!["signal"] === "SIGTERM"), `the app-server exited when its stdin closed, or by the kill: ${JSON.stringify(exits[0])}`);
      assert.deepEqual(own.filter((frame) => frame.kind === "stderr").map((frame) => frame["text"]), [`fake codex ${FAKE_CODEX_CLI_VERSION}: serving the app-server protocol on stdio`]);
    });
    appServerFrames.push(...frames.filter((frame) => serverProcs.has(frame["proc"])));
    assert.ok(!JSON.stringify(frames).includes("codex-home/auth.json") && !JSON.stringify(frames).includes("fake-refresh"), "no sign-in in the recording");
  }
  // Every line on the session app-servers' pipes, as their side saw it, after the recorder's sanitiser, in order.
  const sanitise = createSanitiser({ workspace: path.join(DIRECTORY, "no-such-workspace"), env, protocolWords: CODEX_PROTOCOL_WORDS, recordedModel: "fake-luna" });
  const servers = sessionServers(fake);
  const wire = (fake.wire() as Array<{ pid: number; direction: "in" | "out" | "err"; line: string }>).filter((entry) => servers.has(entry.pid));
  const sanitiseLine = (line: string, kind: "stdin" | "stdout"): unknown => {
    let text = line;
    // Each scenario's own workspace, as the recorder of that scenario replaced it.
    for (const outcome of outcomes) text = text.split(outcome.workspace).join(PLACEHOLDERS.workspace);
    return (sanitise({ dir: kind === "stdin" ? "out" : "in", kind, proc: 0, message: JSON.parse(text) as unknown } as Frame) as Frame)["message"];
  };
  assert.deepEqual(
    appServerFrames.filter((frame) => frame.kind === "stdin").map((frame) => frame["message"]),
    wire.filter((entry) => entry.direction === "in").map((entry) => sanitiseLine(entry.line, "stdin")),
    "every stdin line, in order",
  );
  assert.deepEqual(
    appServerFrames.filter((frame) => frame.kind === "stdout").map((frame) => frame["message"]),
    wire.filter((entry) => entry.direction === "out").map((entry) => sanitiseLine(entry.line, "stdout")),
    "every stdout line, in order",
  );
  assert.deepEqual(
    appServerFrames.filter((frame) => frame.kind === "stderr").map((frame) => frame["text"]),
    wire.filter((entry) => entry.direction === "err").map((entry) => entry.line),
    "every stderr line of the app-servers",
  );
  // The app-server exchange itself: initialize, a thread with the model chosen, turns, approvals, an interrupt, a resume.
  const methods = (name: ScenarioName): unknown[] => recordings.find((recording) => recording.header.scenario === name)!.frames.filter((entry) => entry.frame.kind === "stdin").map((entry) => messageOf(entry.frame)["method"]);
  assert.deepEqual(methods("simple"), ["initialize", "initialized", "thread/start", "turn/start", "thread/backgroundTerminals/list"]);
  assert.deepEqual(methods("approval_allowed"), ["initialize", "initialized", "thread/start", "turn/start", undefined, "thread/backgroundTerminals/list"], "the approval answer is a JSON-RPC response");
  assert.deepEqual(methods("interrupt"), ["initialize", "initialized", "thread/start", "turn/start", "turn/interrupt", "thread/backgroundTerminals/list"]);
  assert.deepEqual(methods("resume"), ["initialize", "initialized", "thread/start", "turn/start", "thread/backgroundTerminals/list", "initialize", "initialized", "thread/resume", "thread/turns/list", "turn/start", "thread/backgroundTerminals/list"]);
  for (const recording of recordings) {
    const started = recording.frames.find((entry) => entry.frame.kind === "stdin" && messageOf(entry.frame)["method"] === "thread/start")!;
    assert.equal((messageOf(started.frame)["params"] as { model?: string }).model, "fake-luna", `${recording.header.scenario}: the thread runs with the recorded model`);
  }
  for (const name of ["approval_allowed", "approval_denied"] as const) {
    const recording = recordings.find((each) => each.header.scenario === name)!;
    assert.deepEqual(
      codexNativeAnswers(recording.frames.map((entry) => entry.frame)).map((answer) => [answer.decision, answer.scope]),
      [name === "approval_allowed" ? ["accept", "once"] : ["cancel", undefined]],
      "Codex offers an ordinary command accept and cancel; the host's decline is the cancel",
    );
  }
});

for (const name of SCENARIO_NAMES) {
  test(`${name}: the Codex recording replays through a fresh driver from codexDriver over the replay process service, and every scenario assertion holds`, async () => {
    const recording = await recordingOf(name);
    const { run, replay } = await replayCodex(recording);
    assert.ok(replay.sequencer.done());
    assert.equal(replay.sequencer.matchedOutbound().length, recording.frames.filter((entry) => entry.frame.dir === "out").length);
    assert.equal(run.scenario.name, name);
  });
}

test("interrupt: when the turn's text reaches the host before startTurn resolves, the host still interrupts at the turn's first text and the Codex replay passes", async () => {
  const recording = await recordingOf("interrupt");
  const { run, replay } = await replayCodex(recording, { timeoutMs: 5_000, wrapSession: startTurnAfterItsText });
  assert.ok(replay.sequencer.done());
  assert.equal(run.interrupted?.turnId, run.turnIds[0]);
});

/** Every repository file `entry` reaches through relative imports and exports, type-only ones included. */
function reachedFrom(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"|import\("(\.[^"]+)"\)/g)) {
      walk(path.resolve(path.dirname(file), match[1] ?? match[2]!));
    }
  };
  walk(path.join(REPO_ROOT, entry));
  return [...seen].map((file) => path.relative(REPO_ROOT, file).split(path.sep).join("/"));
}

test("the replay process service Codex replay uses imports neither driver code nor the fake app-server, directly or through other modules, type-only imports included", () => {
  // The walk finds driver code and the fake where they are.
  const runner = reachedFrom("test/recordings/codex/run.ts");
  assert.ok(runner.includes("src/drivers/codex/index.ts"), runner.join(", "));
  const fake = reachedFrom("test/drivers/codex/fake-codex-cli.ts");
  assert.ok(fake.includes("test/drivers/codex/fake-app-server.ts"), fake.join(", "));
  assert.ok(fs.readFileSync(path.join(REPO_ROOT, "test", "recordings", "codex", "replay.ts"), "utf8").includes('import { startStdioReplay } from "../stdio/replay-process.ts";'), "Codex replay plays through the shared replay process service");
  const reached = reachedFrom("test/recordings/stdio/replay-process.ts");
  assert.ok(reached.length > 3, reached.join(", "));
  assert.deepEqual(
    reached.filter((file) => file.startsWith("src/drivers/") || file.startsWith("test/drivers/") || file.startsWith("test/recordings/codex/")),
    [],
  );
  assert.ok(!fs.readFileSync(path.join(REPO_ROOT, "test", "recordings", "stdio", "replay-process.ts"), "utf8").includes("fake-app-server"));
});

// Drift.

function assertDrift(error: unknown, file: string, line: number, parts: RegExp[]): true {
  assert.ok(error instanceof Error, String(error));
  assert.ok(error.message.startsWith(`${file}:${line}: `), `the error names ${file}:${line}: ${error.message.slice(0, 600)}`);
  for (const part of parts) assert.match(error.message, part);
  return true;
}

/** The app-server process of the scenario's first session: its `initialize` request's process. */
function firstServer(recording: Recording): number {
  return Number(recording.frames.find((entry) => entry.frame.kind === "stdin" && messageOf(entry.frame)["method"] === "initialize")!.frame["proc"]);
}

test("Codex replay reports first-spawn drift when the session admission probe is changed or absent", async () => {
  const recording = await recordingOf("simple");
  const admission = recording.frames[0]!.frame;
  assert.equal(admission.kind, "spawn");
  assert.deepEqual(admission["args"], ["--version"]);
  const changed = editedCopy(recording, "changed-admission", (frames) => {
    frames[0] = { ...frames[0]!, args: ["version"] };
  });
  const absent = editedCopy(recording, "absent-admission", (frames) => {
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      if (frames[index]!["proc"] === admission["proc"]) frames.splice(index, 1);
    }
  });
  assert.deepEqual(absent.frames[0]?.["args"], ["login", "status"]);
  for (const { file, frames } of [changed, absent]) {
    const line = recording.frames[0]!.line;
    await assert.rejects(replayCodex(file), (error: unknown) => {
      assert.ok(error instanceof ReplayDriftError, String(error));
      assert.equal(error.file, file);
      assert.equal(error.line, line);
      assert.ok(error.message.includes(`\n  recorded (line ${line}): ${showFrame(frames[0])}`), error.message);
      assert.ok(error.message.includes(`\n  sent: ${showFrame(admission)}`), error.message);
      return true;
    });
  }
});

test("Codex replay refuses a prerelease reported by the admission probe even when the header names a supported release", async () => {
  const recording = await recordingOf("simple");
  const { file } = editedCopy(recording, "old-admission-version", (frames) => {
    const index = frames.findIndex((frame) => frame["proc"] === frames[0]!["proc"] && frame.kind === "stdout");
    const stdout = frames[index]!;
    assert.equal(stdout["text"], `codex-cli ${FAKE_CODEX_CLI_VERSION}`);
    frames[index] = { ...stdout, text: "codex-cli 0.172.0-fake" };
  });
  await assert.rejects(replayCodex(file), (error: unknown) => {
    assert.ok(isAriError(error, "driver_unavailable"), String(error));
    assert.match(error.message, /Codex CLI 0\.172\.0-fake .* is older than 0\.172\.0/);
    return true;
  });
});

for (const name of SCENARIO_NAMES) {
  test(`${name}: Codex replay fails, naming the file, the line and both frames, when the driver writes a stdin frame other than the next recorded one`, async () => {
    const recording = await recordingOf(name);
    const index = recording.frames.findIndex((entry) => entry.frame.kind === "stdin" && messageOf(entry.frame)["method"] === "turn/start");
    const { file } = editedCopy(recording, "changed-prompt", (frames) => {
      ((messageOf(frames[index]!)["params"] as { input: Array<{ text: string }> }).input[0]!).text = "Reply with a word the driver never sends";
    });
    const line = recording.frames[index]!.line;
    await assert.rejects(replayCodex(file, { timeoutMs: 10_000 }), (error: unknown) => {
      assert.ok(error instanceof ReplayDriftError, String(error));
      assert.equal(error.line, line);
      return assertDrift(error, file, line, [
        /replay drift: the driver sent a frame other than the next recorded one/,
        /first difference at message\.params\.input\.0\.text/,
        new RegExp(`recorded \\(line ${line}\\): .*a word the driver never sends`),
        new RegExp(`sent: .*${escape(SCENARIOS.find((each) => each.name === name)!.prompts[0]!.slice(0, 30))}`),
      ]);
    });
  });

  test(`${name}: Codex replay fails, naming the file, the line and both frames, when the scenario ends with recorded frames the driver never sent or took`, async () => {
    const recording = await recordingOf(name);
    const proc = firstServer(recording);
    const extra: Frame = { dir: "out", kind: "stdin", proc, message: { id: 99, method: "thread/list", params: { cwd: "<WORKSPACE>/cwd" } } };
    const answer: Frame = { dir: "in", kind: "stdout", proc, message: { id: 99, result: { data: [], nextCursor: null } } };
    const line = recording.frames.at(-1)!.line + 1;
    const last = recording.frames.at(-1)!;
    // A request the driver never sends.
    const appended = editedCopy(recording, "appended", (frames) => frames.push(extra));
    await assert.rejects(replayCodex(appended.file, { timeoutMs: 10_000 }), (error: unknown) =>
      assertDrift(error, appended.file, line, [
        /replay drift: the scenario ended with 1 recorded frame\(s\) not replayed/,
        new RegExp(`next recorded \\(line ${line}\\): ${escape(JSON.stringify(extra))}`),
        new RegExp(`last replayed \\(line ${line - 1}\\): ${escape(showFrame(last.frame))}`),
      ]),
    );
    // Then also its answer: the Codex driver does not wait for an app-server's stdout to end when it closes a session, so both are left over.
    const answered = editedCopy(recording, "appended-with-answer", (frames) => frames.push(extra, answer));
    await assert.rejects(replayCodex(answered.file, { timeoutMs: 10_000 }), (error: unknown) =>
      assertDrift(error, answered.file, line, [
        /replay drift: the scenario ended with 2 recorded frame\(s\) not replayed/,
        new RegExp(`next recorded \\(line ${line}\\): ${escape(JSON.stringify(extra))}`),
        new RegExp(`last replayed \\(line ${line - 1}\\): ${escape(showFrame(last.frame))}`),
      ]),
    );
  });

  test(`${name}: Codex replay fails, naming the file, the line and both frames, when the recorded turn/completed that ends the first turn is removed`, async () => {
    const recording = await recordingOf(name);
    const [turn] = codexTurnFrames(recording);
    assert.ok(turn?.completed !== undefined, "the recording holds the first turn's end");
    const index = recording.frames.indexOf(turn.completed);
    const { file } = editedCopy(recording, "removed-turn-end", (frames) => frames.splice(index, 1));
    // Replay delivers the inbound frames after the gap, then waits at the next outbound frame for a driver that waits for the turn's end.
    const copy = await readRecording(file);
    const stall = copy.frames.findIndex((entry, position) => position >= index && entry.frame.dir === "out");
    const next = copy.frames[stall]!;
    const last = copy.frames[stall - 1]!;
    await assert.rejects(replayCodex(file, { timeoutMs: 3_000 }), (error: unknown) => {
      assert.ok(error instanceof Error, String(error));
      const shown = error.message.slice(0, 1500);
      assert.ok(error.message.startsWith(`${file}:${next.line}: replay stalled: the ${name} scenario waited 3000 ms for turn.terminal`), shown);
      assert.ok(error.message.includes(`\n  next recorded (line ${next.line}): ${showFrame(next.frame)}\n`), shown);
      assert.ok(error.message.includes(`\n  last replayed (line ${last.line}): ${showFrame(last.frame)}`), shown);
      return true;
    });
  });
}

/** The command item a stdout frame is about: an item notification's command item, or an approval request's item. */
function commandOf(frame: Frame): string | undefined {
  if (frame.kind !== "stdout") return undefined;
  const params = messageOf(frame)["params"] as { item?: { type?: string; id?: string }; itemId?: string } | undefined;
  if (params?.item?.type === "commandExecution") return params.item.id;
  return messageOf(frame)["method"] === "item/commandExecution/requestApproval" ? params?.itemId : undefined;
}

/** The scenario check's error once replay is over: the file and the line of the frame the outcome depended on, the check, that frame, and the frame replayed last. */
function checkError(file: string, check: string, dependedOn: { line: number; frame: Frame }, named: string, last: { line: number; frame: Frame }): string {
  return `${file}:${dependedOn.line}: ${check}\n  depended on (line ${dependedOn.line}, the last recorded frame naming ${named}): ${showFrame(dependedOn.frame)}\n  last replayed (line ${last.line}): ${showFrame(last.frame)}`;
}

test("approval_allowed: Codex replay fails when the frames with the command's output are removed, naming the file, the command's last recorded frame and the frame replayed last", async () => {
  const recording = await recordingOf("approval_allowed");
  const server = firstServer(recording);
  const marker = SCENARIOS.find((each) => each.name === "approval_allowed")!.marker!;
  // The command's output streams in item/commandExecution/outputDelta and comes whole in its item/completed.
  const output = recording.frames.flatMap((entry, index) => (entry.frame["proc"] === server && commandOf(entry.frame) !== undefined && JSON.stringify(entry.frame).includes(marker) ? [index] : []));
  const deltas = recording.frames.filter((entry) => entry.frame["proc"] === server && entry.frame.kind === "stdout" && messageOf(entry.frame)["method"] === "item/commandExecution/outputDelta");
  assert.ok(output.length >= 1 && deltas.length >= 1, "the recording holds the command's output");
  const call = (messageOf(deltas[0]!.frame)["params"] as { itemId: string }).itemId;
  const { file } = editedCopy(recording, "removed-command-output", (frames) => {
    for (const index of [...output, ...deltas.map((entry) => recording.frames.indexOf(entry))].sort((a, b) => b - a)) frames.splice(index, 1);
  });
  const copy = await readRecording(file);
  assert.ok(copy.frames.every((entry) => entry.frame.dir === "out" || !JSON.stringify(entry.frame).includes(marker)), "no inbound frame holds the marker");
  // What is left of the command on the tape: Codex reporting that it started.
  const dependedOn = copy.frames.findLast((entry) => entry.frame.dir === "in" && JSON.stringify(entry.frame).includes(`"${call}"`))!;
  assert.equal(messageOf(dependedOn.frame)["method"], "item/started");
  await assert.rejects(replayCodex(file, { timeoutMs: 10_000 }), (error: unknown) => {
    assert.ok(error instanceof ReplayCheckError, String(error));
    const check = (error.cause as Error).message;
    assert.ok(check.startsWith("scenario approval_allowed: a command or tool item completed with the marker in its output"), check);
    assert.equal(error.message, checkError(file, check, dependedOn, call, copy.frames.at(-1)!));
    return true;
  });
});

test("approval_denied: Codex replay fails when the declined command's end says it completed with the marker in its output, naming the file, the command's last recorded frame and the frame replayed last", async () => {
  const recording = await recordingOf("approval_denied");
  const server = firstServer(recording);
  const completed = recording.frames.findIndex((entry) => entry.frame["proc"] === server && entry.frame.kind === "stdout" && messageOf(entry.frame)["method"] === "item/completed" && commandOf(entry.frame) !== undefined);
  assert.ok(completed !== -1, "the recording holds the declined command's end");
  const call = commandOf(recording.frames[completed]!.frame)!;
  assert.equal(((messageOf(recording.frames[completed]!.frame)["params"] as { item: { status: string } }).item.status), "declined");
  // The command's end as a completed command with the marker, as if Codex had run it.
  const { file } = editedCopy(recording, "declined-as-completed", (frames) => {
    const item = (messageOf(frames[completed]!)["params"] as { item: { status: string; aggregatedOutput?: string; exitCode?: number } }).item;
    item.status = "completed";
    item.aggregatedOutput = `${SCENARIOS.find((each) => each.name === "approval_denied")!.marker!}\n`;
    item.exitCode = 0;
  });
  const copy = await readRecording(file);
  const dependedOn = copy.frames.findLast((entry) => entry.frame.dir === "in" && JSON.stringify(entry.frame).includes(`"${call}"`))!;
  assert.equal(dependedOn.line, copy.frames[completed]!.line);
  await assert.rejects(replayCodex(file, { timeoutMs: 10_000 }), (error: unknown) => {
    assert.ok(error instanceof ReplayCheckError, String(error));
    const check = (error.cause as Error).message;
    assert.ok(check.startsWith("scenario approval_denied: no completed command or tool item's output holds the marker"), check);
    assert.equal(error.message, checkError(file, check, dependedOn, call, copy.frames.at(-1)!));
    return true;
  });
});

/** The scenario check's error once replay is over, for a check about one turn: the file and the line of the turn/completed that ended it, the check, that frame, and the frame replayed last. */
function turnCheckError(file: string, check: string, turn: number, frames: ReturnType<typeof codexTurnFrames>[number], last: { line: number; frame: Frame }): string {
  return `${file}:${frames.completed!.line}: ${check}\n  depended on (line ${frames.completed!.line}, the turn/completed that ended turn ${turn}, started at line ${frames.request.line}): ${showFrame(frames.completed!.frame)}\n  last replayed (line ${last.line}): ${showFrame(last.frame)}`;
}

const isReply = (frame: Frame): boolean => {
  if (frame.kind !== "stdout") return false;
  const message = messageOf(frame);
  const params = message["params"] as { item?: { type?: string } } | undefined;
  return message["method"] === "item/agentMessage/delta" || ((message["method"] === "item/started" || message["method"] === "item/completed") && params?.item?.type === "agentMessage");
};

for (const [name, turn, check] of [
  ["simple", 1, () => "scenario simple: a settled assistant message with non-empty text"],
  ["multi_turn", 2, () => `scenario multi_turn: the second turn's text "" contains ${JSON.stringify(SCENARIOS.find((each) => each.name === "multi_turn")!.word)}`],
] as const) {
  test(`${name}: when every frame of turn ${turn}'s reply is removed, Codex replay fails naming the file, the line, the turn/completed that ended the turn and the frame replayed last`, async () => {
    const recording = await recordingOf(name);
    const turns = codexTurnFrames(recording);
    const { request, completed } = turns[turn - 1]!;
    const from = recording.frames.indexOf(request);
    const to = recording.frames.indexOf(completed!);
    // The turn's summary in turn/completed names the reply too: it goes with the reply's own frames.
    const { file } = editedCopy(recording, `removed-reply-${turn}`, (frames) => {
      ((messageOf(frames[to]!)["params"] as { turn: { items: unknown[] } }).turn).items = [];
      for (let index = to - 1; index > from; index -= 1) if (isReply(frames[index]!)) frames.splice(index, 1);
    });
    const copy = await readRecording(file);
    await assert.rejects(replayCodex(file, { timeoutMs: 10_000 }), (error: unknown) => {
      assert.ok(error instanceof ReplayCheckError, String(error));
      assert.equal(error.message, turnCheckError(file, check(), turn, codexTurnFrames(copy)[turn - 1]!, copy.frames.at(-1)!));
      return true;
    });
  });
}

test("interrupt: when the turn/completed that ends the turn says completed instead of interrupted, Codex replay fails naming the file, that frame and the frame replayed last", async () => {
  const recording = await recordingOf("interrupt");
  const [turn] = codexTurnFrames(recording);
  const index = recording.frames.indexOf(turn!.completed!);
  assert.equal((messageOf(turn!.completed!.frame)["params"] as { turn: { status: string } }).turn.status, "interrupted");
  const { file } = editedCopy(recording, "turn-end-not-interrupted", (frames) => {
    ((messageOf(frames[index]!)["params"] as { turn: { status: string } }).turn).status = "completed";
  });
  const copy = await readRecording(file);
  await assert.rejects(replayCodex(file, { timeoutMs: 10_000 }), (error: unknown) => {
    assert.ok(error instanceof ReplayCheckError, String(error));
    const check = (error.cause as Error).message;
    assert.ok(check.startsWith("scenario interrupt: the turn ended interrupted\n"), check);
    assert.equal(error.message, turnCheckError(file, check, 1, codexTurnFrames(copy)[0]!, copy.frames.at(-1)!));
    return true;
  });
});

test("every Codex scenario check that fails names the turns it looked at, and each of those turns has recorded frames to name: none falls back to naming nothing", async () => {
  const withTerminal = (run: ScenarioRun, status: string): ScenarioRun => ({ ...run, events: run.events.map((event) => (event.body.type === "turn.terminal" ? { ...event, body: { ...event.body, status } } : event)) as ScenarioRun["events"] });
  const withoutTerminals = (run: ScenarioRun): ScenarioRun => ({ ...run, events: run.events.filter((event) => event.body.type !== "turn.terminal") });
  const withoutItemsOf = (run: ScenarioRun, kinds: readonly string[]): ScenarioRun => ({ ...run, events: run.events.filter((event) => !(event.body.type === "item.upsert" && kinds.includes(event.body.item.kind ?? ""))) });
  const withoutLastTurn = (run: ScenarioRun): ScenarioRun => ({ ...run, turnIds: run.turnIds.slice(0, -1), turnSessions: run.turnSessions.slice(0, -1) });
  const withoutInterrupt = (run: ScenarioRun): ScenarioRun => {
    const { interrupted: _interrupted, ...rest } = run;
    return rest;
  };
  for (const name of SCENARIO_NAMES) {
    const recording = await recordingOf(name);
    const { run } = await replayCodex(recording);
    const native = codexNativeAnswers(recording.frames.map((entry) => entry.frame));
    let failed = 0;
    for (const [label, broken] of [
      ["every turn failed", withTerminal(run, "failed")],
      ["every turn interrupted", withTerminal(run, "interrupted")],
      ["no turn.terminal", withoutTerminals(run)],
      ["no assistant message", withoutItemsOf(run, ["assistant_message"])],
      ["no command or tool item", withoutItemsOf(run, ["command_execution", "tool_call", "mcp_tool_call", "dynamic_tool_call"])],
      ["one turn fewer", withoutLastTurn(run)],
      ["no interrupt", withoutInterrupt(run)],
      ["no answer reached Codex", run],
    ] as const) {
      let thrown: unknown;
      try {
        checkScenario(broken, label === "no answer reached Codex" ? [] : native);
      } catch (error) {
        thrown = error;
      }
      if (thrown === undefined) continue;
      failed += 1;
      assert.ok(thrown instanceof ScenarioCheckError, `${name}, ${label}: ${String(thrown)}`);
      assert.ok(thrown.turns.length > 0, `${name}, ${label}: ${thrown.message}`);
      const named = codexTurnsDependedOn(recording, thrown.turns);
      assert.equal(named.length, thrown.turns.length, `${name}, ${label}: each turn the check looked at has a recorded frame`);
      assert.ok(named.every((entry) => entry.why.startsWith("the turn/completed that ended turn")), `${name}, ${label}: ${named.map((entry) => entry.why).join("; ")}`);
    }
    assert.ok(failed >= 3, `${name}: ${failed} of the broken runs failed a check`);
  }
});

test("replay ends a process's pipes once its exit came and the lines recorded for them were handed over: a stderr line recorded after the app-server's exit still reaches the driver", async () => {
  const recording = await recordingOf("simple");
  const frames = recording.frames.map((entry) => entry.frame);
  const proc = firstServer(recording);
  const exit = frames.findIndex((frame) => frame.kind === "exit" && frame["proc"] === proc);
  const stderr = frames.findIndex((frame) => frame.kind === "stderr" && frame["proc"] === proc);
  const { file } = editedCopy(recording, "stderr-after-exit", (copy) => {
    const [line] = copy.splice(stderr, 1);
    copy.splice(exit, 0, line!);
  });
  const { replay } = await replayCodex(file);
  assert.ok(replay.sequencer.done());
});

test("Codex replay ignores only the ARI version in the initialize request: a change to it passes, a change to the client's name fails, and the code's list is that one field", async () => {
  assert.deepEqual(
    CODEX_IGNORED_FIELDS.map((entry) => [entry.driver, entry.kind, entry.field]),
    [["codex", "stdin", "message.params.clientInfo.version"]],
  );
  const recording = await recordingOf("simple");
  const index = recording.frames.findIndex((entry) => entry.frame.kind === "stdin" && messageOf(entry.frame)["method"] === "initialize");
  const version = editedCopy(recording, "ari-version", (frames) => {
    ((messageOf(frames[index]!)["params"] as { clientInfo: { version: string } }).clientInfo).version = "0.0.0-another-release";
  });
  await replayCodex(version.file);
  const name = editedCopy(recording, "client-name", (frames) => {
    ((messageOf(frames[index]!)["params"] as { clientInfo: { name: string } }).clientInfo).name = "not-ari";
  });
  await assert.rejects(replayCodex(name.file), /first difference at message\.params\.clientInfo\.name: recorded "not-ari", sent "ari"/);
  const spawn = editedCopy(recording, "spawn-env", (frames) => {
    const at = frames.findIndex((frame) => frame.kind === "spawn" && (frame["args"] as string[])[0] === "app-server");
    frames[at] = { ...frames[at]!, envNames: ["CODEX_HOME"] };
  });
  await assert.rejects(replayCodex(spawn.file), /first difference at envNames/);
});

test("resanitise-recordings runs a Codex recording through the sanitiser again with the Codex protocol words, and one with nothing new to replace comes out byte-identical", async () => {
  const recording = await recordingOf("approval_allowed");
  const copy = path.join(DIRECTORY, "copies", "resanitise-approval_allowed.ndjson");
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(recording.file, copy);
  assert.equal(await resanitiseRecording(copy, { env: {}, user: "ari-nobody" }), false);
  assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(recording.file)));
  await replayCodex(copy);
});

test("the scenario checks read the approval answers off the recorded approval requests and the driver's answers", async () => {
  for (const name of ["approval_allowed", "approval_denied"] as const) {
    const recording = await recordingOf(name);
    const { run } = await replayCodex(recording);
    const frames = recording.frames.map((entry) => entry.frame);
    checkScenario(run, codexNativeAnswers(frames));
    const withoutAnswer = frames.filter((frame) => !(frame.kind === "stdin" && messageOf(frame)["result"] !== undefined));
    assert.throws(() => checkScenario(run, codexNativeAnswers(withoutAnswer)), name === "approval_allowed" ? /allow-once answer reached the native side/ : /decline answer reached the native side/);
  }
});

// Sanitising.

for (const [recordedAs, replayedAs] of [
  ["completed", "user"],
  ["user", "completed"],
] as const) {
  test(`Codex recordings made on an account named ${recordedAs} keep the app-server's protocol words and replay on an account named ${replayedAs}`, async () => {
    const { outcomes } = await recordFake(`account-${recordedAs}`, { USER: recordedAs, LOGNAME: recordedAs }, SCENARIO_NAMES, recordedAs);
    for (const outcome of outcomes) {
      assert.equal(outcome.error, undefined, `${outcome.scenario}: ${outcome.error?.message}`);
      const text = fs.readFileSync(outcome.file!, "utf8");
      assert.ok(text.includes('"method":"turn/completed"') && text.includes('"type":"userMessage"') && text.includes('"type":"text"'), `${outcome.scenario}: the protocol words are intact`);
      const frames = (await readRecording(outcome.file!)).frames.map((entry) => entry.frame);
      assert.deepEqual(replacedProtocolWords(recordedAs, PLACEHOLDERS.user, frames, CODEX_PROTOCOL_WORDS), [], `${outcome.scenario}: no protocol word became the user placeholder`);
      await replayCodex(outcome.file!, { user: replayedAs, env: { ...process.env, USER: replayedAs, LOGNAME: replayedAs } });
    }
  });
}

test("the Codex recorder replaces the OS user name, a home path, an email, a secret environment value, an account id and each kind of account detail (Codex's plan type, rate-limit windows and credit balance among them) in recorded Codex frames, the scan and check:recordings pass, and the recording replays", async () => {
  const osName = os.userInfo().username;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(DIRECTORY, "sanitise-home-")));
  fs.mkdirSync(path.join(home, ".codex"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), FAKE_SIGN_IN, { mode: 0o600 });
  const secret = "ari-synthetic-service-token-0001";
  // What Codex sends of the account: its plan and limits (account/rateLimits/updated, account/updated), and a tool's output naming the user, the account and the machine.
  const rateLimits = {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1796072400 },
    secondary: { usedPercent: 81, windowDurationMins: 10_080, resetsAt: 1796500000 },
    credits: { hasCredits: true, unlimited: false, balance: "1693.25" },
    individualLimit: { limit: "250.00", remainingPercent: 64, resetsAt: 1796600000, used: "90.17" },
    planType: "pro",
    rateLimitReachedType: "workspace_member_usage_limit_reached",
    spendControlReached: true,
  };
  const toolCall = {
    type: "mcpToolCall",
    id: "call_planted",
    server: "accounts",
    tool: "whoami",
    status: "completed",
    // A tool's arguments are JSON the schema does not describe: every other kind of account detail, as other agents name them.
    arguments: {
      accountId: "acct-31f9c2",
      organizationId: "org-77d1e0",
      subscriptionType: "ChatGPT Pro",
      rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.82, resetsAt: 1796072400 },
      credential_expires_at: "2026-12-16T12:44:44.039Z",
      tokenExpiresAt: 1796000000123,
      pid: 2294915,
      tmp: "/var/tmp/opencode/session.1YX2c84S/codex",
      socketPath: "/run/user/1000/codex-2294915.sock",
      shell: "/usr/bin/zsh",
      providers: [
        { id: "openai", isAuthenticated: true },
        { id: "azure-openai", signedIn: false },
      ],
    },
    result: { content: [{ type: "text", text: `${osName} asked from ${home}/notes, as ari-recorder-user@example.org, with ${secret} and /home/someone-else/x` }], structuredContent: null },
    error: null,
    durationMs: 3,
  };
  const planted = [
    { method: "account/updated", params: { authMode: "chatgpt", planType: "pro" } },
    { method: "account/rateLimits/updated", params: { rateLimits } },
    { method: "item/completed", params: { threadId: null, turnId: null, item: toolCall, completedAtMs: 1796000000000 } },
  ];
  const listing = `drwx------ 2 ${osName} ${osName} 4096 Nov 25 12:00 ${home}/project\n`;
  const { outcomes } = await recordFake(
    "sanitise",
    {
      HOME: home,
      USER: "ari-recorder-user",
      ARI_TEST_SERVICE_TOKEN: secret,
      ARI_FAKE_CODEX_PLANT: JSON.stringify(planted),
      // The fake streams a reply in two deltas, split in its middle; the name is in the second. A value split across deltas matches no rule (docs/recordings.md, the known limit of streamed text), so the home path and the email are planted whole.
      ARI_FAKE_CODEX_REPLY: `The answer is ok, and the one who asked is ${osName}`,
      ARI_FAKE_CODEX_OUTPUT: `${listing}${SCENARIOS.find((scenario) => scenario.name === "approval_allowed")!.marker!}\n`,
    },
    ["simple", "approval_allowed"],
  );
  const root = fs.mkdtempSync(path.join(DIRECTORY, "check-root-"));
  for (const outcome of outcomes) {
    assert.equal(outcome.error, undefined, `${outcome.scenario}: ${outcome.error?.message}`);
    const text = fs.readFileSync(outcome.file!, "utf8");
    const recording = await readRecording(outcome.file!);
    const frames = recording.frames.map((entry) => entry.frame);
    const server = firstServer(recording);
    const stdout = frames.filter((frame) => frame["proc"] === server && frame.kind === "stdout");
    assert.ok(!text.includes(outcome.workspace), `${outcome.scenario}: the workspace path`);
    assert.ok(!text.includes(home), `${outcome.scenario}: the HOME`);
    assert.deepEqual(wholeWordsOf(osName, frames, CODEX_PROTOCOL_WORDS), [], `${outcome.scenario}: the OS user name is nowhere in the recording but in protocol words`);
    for (const leaked of ["ari-recorder-user@example.org", secret, "someone-else", "acct-31f9c2", "org-77d1e0", "ChatGPT Pro", "0.82", "2026-12-16", "1796000000123", "2294915", "session.1YX2c84S", "codex-2294915", "zsh", "azure-openai", '"pro"', '"usedPercent":37', '"usedPercent":81', "1796072400", "1796500000", "1693.25", "250.00", "90.17", "1796600000", "workspace_member_usage_limit_reached", "(fake)"]) {
      assert.ok(!text.includes(leaked), `${outcome.scenario}: ${leaked} is gone`);
    }
    const tool = stdout.find((frame) => (messageOf(frame)["params"] as { item?: { id?: string } } | undefined)?.item?.id === "call_planted")!;
    const item = (messageOf(tool)["params"] as { item: typeof toolCall }).item;
    assert.equal(item.result.content[0]!.text, `${PLACEHOLDERS.user} asked from ${PLACEHOLDERS.home}/notes, as ${PLACEHOLDERS.email}, with <ARI_TEST_SERVICE_TOKEN> and ${PLACEHOLDERS.otherHome}/x`);
    assert.deepEqual(item.arguments, {
      accountId: PLACEHOLDERS.accountId,
      organizationId: PLACEHOLDERS.orgId,
      subscriptionType: PLACEHOLDERS.plan,
      rate_limit_info: NEUTRAL_RATE_LIMIT_INFO,
      credential_expires_at: NEUTRAL_TIME.iso,
      tokenExpiresAt: NEUTRAL_TIME.milliseconds,
      pid: NEUTRAL_PID,
      tmp: NEUTRAL_TMP_PATH,
      socketPath: NEUTRAL_SOCKET_PATH,
      shell: NEUTRAL_SHELL,
      providers: [],
    });
    const limits = stdout.find((frame) => messageOf(frame)["method"] === "account/rateLimits/updated")!;
    assert.deepEqual((messageOf(limits)["params"] as { rateLimits: unknown }).rateLimits, {
      limitId: "codex",
      limitName: null,
      primary: NEUTRAL_RATE_LIMIT_WINDOWS.primary,
      secondary: NEUTRAL_RATE_LIMIT_WINDOWS.secondary,
      credits: NEUTRAL_CODEX_CREDITS,
      individualLimit: NEUTRAL_SPEND_CONTROL_LIMIT,
      planType: PLACEHOLDERS.plan,
      rateLimitReachedType: null,
      spendControlReached: false,
    });
    const account = stdout.find((frame) => messageOf(frame)["method"] === "account/updated")!;
    assert.deepEqual(messageOf(account)["params"], { authMode: "chatgpt", planType: PLACEHOLDERS.plan });
    const initialized = stdout.find((frame) => typeof (messageOf(frame)["result"] as { userAgent?: unknown } | undefined)?.userAgent === "string")!;
    assert.equal((messageOf(initialized)["result"] as { userAgent: string }).userAgent, "codex_cli_rs/0.172.0", "the client's system after the product goes");
    if (outcome.scenario === "simple") assert.ok(text.includes(`asked is ${PLACEHOLDERS.user}"`), "the reply, sanitised");
    if (outcome.scenario === "approval_allowed") assert.ok(text.includes(`drwx------ 2 ${PLACEHOLDERS.user} ${PLACEHOLDERS.user} 4096`), "the command output, sanitised");
    assert.deepEqual(scanRecordingText(text, outcome.file!, { home }), [], outcome.scenario);
    const target = path.join(root, "test", "drivers", "codex", "recordings", path.basename(outcome.file!));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(outcome.file!, target);
    const { run } = await replayCodex(outcome.file!);
    // The driver still parses the neutral report: the host saw neutral limits.
    const reports = run.events.flatMap((event) => (event.body.type === "limits.updated" ? [event.body.limits] : []));
    assert.deepEqual(reports[0], {
      windows: [
        { window: "5h", utilization: 0, resetsAt: NEUTRAL_TIME.iso },
        { window: "weekly", utilization: 0, resetsAt: NEUTRAL_TIME.iso },
        { window: "credits", remaining: 0 },
      ],
      limited: false,
    });
  }
  // check:recordings itself, over a tree holding the recordings, run as the gate runs it.
  const check = spawnSync(NODE_EXECUTABLE, [path.join(REPO_ROOT, "scripts", "check-recordings.ts"), "--root", root], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") },
  });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /check-recordings: 2 recording file\(s\), no paths, emails or tokens/);
});
