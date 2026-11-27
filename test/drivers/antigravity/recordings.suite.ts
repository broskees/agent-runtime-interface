// The Antigravity recorder and replay, end to end against the fake ACP agent
// (test/drivers/acp/fake-agent.ts) run as `agy acp` by a fake `agy` on PATH.
// The recording function scripts/record-antigravity.ts calls records all six
// scenarios through the process tap (source `fake`); each recording holds the
// spawn request with its variables' names only, every stdin and stdout line in
// order, the stderr lines and the exit; each replays through a fresh driver
// from createAntigravityDriver over the replay process service with every
// scenario assertion passing. Replay fails loudly, naming the file, the line
// and both frames, when the driver writes another frame, when recorded frames
// are left over, and when a recorded frame the outcome depends on is missing.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scanRecordingText } from "../../../scripts/check-recordings.ts";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { encodeRecording, readRecording } from "../../recordings/format.ts";
import { wholeWordsOf } from "../../recordings/whole-words.ts";
import type { Frame, Recording } from "../../recordings/format.ts";
import { acpNativeAnswers, acpTurnsDependedOn } from "../../recordings/acp/frames.ts";
import { ANTIGRAVITY_IGNORED_FIELDS } from "../../recordings/antigravity/frames.ts";
import { recordAntigravity } from "../../recordings/antigravity/record.ts";
import type { AntigravityRecordOutcome } from "../../recordings/antigravity/record.ts";
import { replayAntigravity } from "../../recordings/antigravity/replay.ts";
import { ACP_PROTOCOL_WORDS } from "../../recordings/acp/protocol-words.ts";
import { startTurnAfterItsText } from "../../recordings/late-start-turn.ts";
import { FRAME_FORMAT_FIELDS, NEUTRAL_PID, NEUTRAL_RATE_LIMIT_INFO, NEUTRAL_SHELL, NEUTRAL_SOCKET_PATH, NEUTRAL_TIME, NEUTRAL_TMP_PATH, PLACEHOLDERS, createSanitiser } from "../../recordings/sanitiser.ts";
import { SCENARIOS, SCENARIO_NAMES, ScenarioCheckError, checkScenario } from "../../recordings/scenarios.ts";
import type { ScenarioName, ScenarioRun } from "../../recordings/scenarios.ts";
import { ReplayCheckError, ReplayDriftError, showFrame } from "../../recordings/sequencer.ts";
import { resanitiseRecording } from "../../recordings/resanitise.ts";
import { FAKE_AGY_VERSION, fakeAgyOnPath } from "./fake-agy.ts";
import type { FakeAgy } from "./fake-agy.ts";

const DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), "ari-antigravity-recordings-"));
process.on("exit", () => fs.rmSync(DIRECTORY, { recursive: true, force: true }));

interface Recorded {
  readonly outcomes: AntigravityRecordOutcome[];
  readonly fake: FakeAgy;
  readonly env: { [name: string]: string };
}

/** Records `scenarios` from a fresh fake `agy` through the recording function, with the recorder's environment `env`. */
async function recordFake(label: string, env: { [name: string]: string } = {}, scenarios: readonly ScenarioName[] = SCENARIO_NAMES, user?: string): Promise<Recorded> {
  const fake = fakeAgyOnPath(DIRECTORY);
  const home = fs.mkdtempSync(path.join(DIRECTORY, "home-"));
  const recorderEnv = { PATH: `${fake.bin}${path.delimiter}${process.env["PATH"] ?? "/usr/bin:/bin"}`, HOME: home, USER: "ari-test-user", ...fake.env, ...env };
  const outcomes = await recordAntigravity({ scenarios, outDir: path.join(DIRECTORY, label), source: "fake", env: recorderEnv, timeoutMs: 20_000, ...(user === undefined ? {} : { user }) });
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
const isAcpOutput = (frame: Frame): boolean => frame.kind === "stdout" && frame["message"] !== undefined;

function acpSpawns(frames: readonly Frame[]): Frame[] {
  return frames.filter((frame) => frame.kind === "spawn" && (frame["args"] as string[])[0] === "acp");
}

test("the Antigravity recording function records all six scenarios from the fake ACP agent run as agy acp, through the process tap, each to its own file with source fake", async () => {
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
      { driver: "antigravity", vendor: "antigravity-cli", vendorVersion: FAKE_AGY_VERSION, sdk: "acp", sdkVersion: "schema-v2.0.0-beta.3", model: "fake-flash", scenario: outcome.scenario, source: "fake" },
    );
    assert.match(recording.header.recorded, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(outcome.frames, recording.frames.length);
    assert.ok(!fs.existsSync(outcome.workspace), `${outcome.scenario}: the temp workspace is gone`);
  }
  const acp = fake.processes().filter((each) => each.args[0] === "acp");
  assert.equal(acp.length, 7, "one agy acp per session: six scenarios, the resume scenario with two sessions");
  // scripts/record-antigravity.ts calls this same function.
  assert.match(fs.readFileSync(path.join(REPO_ROOT, "scripts", "record-antigravity.ts"), "utf8"), /const \{ AntigravitySignInMissingError, AntigravityWorkspaceCustomizedError, AntigravityWorkspaceInHomeError, describeAntigravityRun, failuresOf, recordAntigravity \} = await import\("\.\.\/test\/recordings\/antigravity\/record\.ts"\);/);
});

test("each Antigravity recording holds the spawn request with the names, never the values, of its variables, every stdin and stdout line in order, the stderr lines and the exit", async () => {
  const { outcomes, fake, env } = await recordAll();
  const recordings = await Promise.all(outcomes.map((outcome) => readRecording(outcome.file!)));
  const all: Frame[] = [];
  for (const recording of recordings) {
    const frames = recording.frames.map((entry) => entry.frame);
    const spawns = frames.filter((frame) => frame.kind === "spawn");
    const runtime = acpSpawns(frames);
    const count = recording.header.scenario === "resume" ? 2 : 1;
    assert.equal(runtime.length, count, recording.header.scenario);
    assert.equal(spawns.length, count * 2, "one probe and one ACP spawn per session");
    for (const [index, spawn] of runtime.entries()) {
      const probe = spawns[index * 2]!;
      const probeProc = probe["proc"];
      assert.equal(spawns[index * 2 + 1], spawn, "the probe precedes its ACP spawn");
      assert.deepEqual(frames.filter((frame) => frame["proc"] === probeProc), [
        { dir: "out", kind: "spawn", proc: probeProc, command: "agy", args: ["--version"], envNames: ["AGY_CLI_DISABLE_AUTO_UPDATE"], purpose: "probe", stdin: "ignore", timeoutMs: 10_000 },
        { dir: "in", kind: "stdout", proc: probeProc, text: FAKE_AGY_VERSION },
        { dir: "in", kind: "exit", proc: probeProc, code: 0, signal: null },
      ]);
      assert.ok(frames.indexOf(spawn) > frames.findIndex((frame) => frame["proc"] === probeProc && frame.kind === "exit"), "agy acp starts after the probe exits");
      assert.deepEqual(spawn, {
        dir: "out",
        kind: "spawn",
        proc: spawn["proc"],
        command: "agy",
        args: ["acp", "--gemini-dir", "<WORKSPACE>/instances/antigravity-recorder/state/profile", "--app-data-dir", "antigravity-acp"],
        envNames: ["AGY_ACP_FORCE_FILE_STORAGE", "AGY_CLI_DISABLE_AUTO_UPDATE", "GEMINI_HOME"],
        purpose: "runtime",
        stdin: "pipe",
      });
      const proc = spawn["proc"];
      const own = frames.filter((frame) => frame["proc"] === proc);
      assert.equal(own[0], spawn, "the spawn comes first");
      assert.deepEqual(
        own.filter((frame) => frame.kind === "exit"),
        [{ dir: "in", kind: "exit", proc, code: null, signal: "SIGTERM" }],
        "one exit: the driver ended the process when its session closed",
      );
      assert.ok(own.some((frame) => frame.kind === "kill"), "the driver's kill is recorded");
      assert.deepEqual(own.filter((frame) => frame.kind === "stderr").map((frame) => frame["text"]), [`fake agy ${FAKE_AGY_VERSION}: serving ACP on stdio`]);
    }
    all.push(...frames.filter((frame) => runtime.some((spawn) => frame["proc"] === spawn["proc"])));
  }
  // Every line on the pipes, as the agent's side saw it, after the recorder's sanitiser, in order: what the driver wrote, what the agent wrote back.
  const sanitise = createSanitiser({ workspace: path.join(DIRECTORY, "no-such-workspace"), env, protocolWords: ACP_PROTOCOL_WORDS, recordedModel: "fake-flash" });
  const wire = fake.wire();
  const sanitiseLine = (line: string, side: "in" | "out"): unknown => {
    let text = line;
    // Each scenario's own workspace, as the recorder of that scenario replaced it.
    for (const outcome of outcomes) text = text.split(outcome.workspace).join(PLACEHOLDERS.workspace);
    return sanitise(JSON.parse(text) as unknown, side);
  };
  assert.deepEqual(
    all.filter((frame) => frame.kind === "stdin").map((frame) => frame["message"]),
    wire.filter((entry) => entry.direction === "in").map((entry) => sanitiseLine(entry.line, "out")),
    "every stdin line, in order",
  );
  assert.deepEqual(
    all.filter((frame) => frame.kind === "stdout").map((frame) => frame["message"]),
    wire.filter((entry) => entry.direction === "out").map((entry) => sanitiseLine(entry.line, "in")),
    "every stdout line, in order",
  );
  assert.deepEqual(
    all.filter((frame) => frame.kind === "stderr").map((frame) => frame["text"]),
    wire.filter((entry) => entry.direction === "err").map((entry) => entry.line),
    "every stderr line",
  );
  // The ACP exchange itself: initialize, a session with the model chosen, prompts, approvals, a cancel, a resume.
  const methods = (name: ScenarioName): unknown[] => recordings.find((recording) => recording.header.scenario === name)!.frames.filter((entry) => entry.frame.kind === "stdin").map((entry) => messageOf(entry.frame)["method"]);
  assert.deepEqual(methods("simple"), ["initialize", "session/new", "session/set_config_option", "session/prompt"]);
  assert.deepEqual(methods("approval_allowed"), ["initialize", "session/new", "session/set_config_option", "session/prompt", undefined], "the approval answer is a JSON-RPC response");
  assert.deepEqual(methods("interrupt"), ["initialize", "session/new", "session/set_config_option", "session/prompt", "session/cancel"]);
  assert.deepEqual(methods("resume"), ["initialize", "session/new", "session/set_config_option", "session/prompt", "initialize", "session/resume", "session/set_config_option", "session/prompt"]);
  for (const name of ["approval_allowed", "approval_denied"] as const) {
    const recording = recordings.find((each) => each.header.scenario === name)!;
    assert.deepEqual(
      acpNativeAnswers(recording.frames.map((entry) => entry.frame)).map((answer) => [answer.decision, answer.scope]),
      [name === "approval_allowed" ? ["accept", "once"] : ["decline", undefined]],
    );
  }
});

for (const name of SCENARIO_NAMES) {
  test(`${name}: the Antigravity recording replays through a fresh driver from createAntigravityDriver over the replay process service, and every scenario assertion holds`, async () => {
    const recording = await recordingOf(name);
    const { run, replay } = await replayAntigravity(recording);
    assert.ok(replay.sequencer.done());
    assert.equal(replay.sequencer.matchedOutbound().length, recording.frames.filter((entry) => entry.frame.dir === "out").length);
    assert.equal(run.scenario.name, name);
  });
}

test("interrupt: when the turn's text reaches the host before startTurn resolves, the host still interrupts at the turn's first text and the Antigravity replay passes", async () => {
  const recording = await recordingOf("interrupt");
  const { run, replay } = await replayAntigravity(recording, { timeoutMs: 5_000, wrapSession: startTurnAfterItsText });
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

test("the replay process service imports neither driver code nor the fake agent, directly or through other modules, type-only imports included", () => {
  // The walk finds driver code and the fake where they are.
  const runner = reachedFrom("test/recordings/antigravity/run.ts");
  assert.ok(runner.includes("src/drivers/antigravity/index.ts"), runner.join(", "));
  const fake = reachedFrom("test/drivers/antigravity/fake-agy-cli.ts");
  assert.ok(fake.includes("test/drivers/acp/harness.ts"), fake.join(", "));
  const reached = reachedFrom("test/recordings/stdio/replay-process.ts");
  assert.ok(reached.length > 3, reached.join(", "));
  assert.deepEqual(
    reached.filter((file) => file.startsWith("src/drivers/") || file.startsWith("test/drivers/")),
    [],
  );
  assert.ok(!fs.readFileSync(path.join(REPO_ROOT, "test", "recordings", "stdio", "replay-process.ts"), "utf8").includes("fake-agent"));
});

// Drift.

function assertDrift(error: unknown, file: string, line: number, parts: RegExp[]): true {
  assert.ok(error instanceof Error, String(error));
  assert.ok(error.message.startsWith(`${file}:${line}: `), `the error names ${file}:${line}: ${error.message.slice(0, 600)}`);
  for (const part of parts) assert.match(error.message, part);
  return true;
}

/** The response that ends the first turn: ACP v1 answers session/prompt with the turn's stop reason. */
function turnEnd(recording: Recording): { index: number; line: number; frame: Frame } {
  const prompt = recording.frames.find((entry) => entry.frame.kind === "stdin" && messageOf(entry.frame)["method"] === "session/prompt")!;
  const id = messageOf(prompt.frame)["id"];
  const index = recording.frames.findIndex((entry) => entry.frame.kind === "stdout" && entry.frame["proc"] === prompt.frame["proc"] && messageOf(entry.frame)["id"] === id && messageOf(entry.frame)["result"] !== undefined);
  return { index, line: recording.frames[index]!.line, frame: recording.frames[index]!.frame };
}

for (const name of SCENARIO_NAMES) {
  test(`${name}: Antigravity replay fails, naming the file, the line and both frames, when the driver writes a stdin frame other than the next recorded one`, async () => {
    const recording = await recordingOf(name);
    const index = recording.frames.findIndex((entry) => entry.frame.kind === "stdin" && messageOf(entry.frame)["method"] === "session/prompt");
    const { file } = editedCopy(recording, "changed-prompt", (frames) => {
      ((messageOf(frames[index]!)["params"] as { prompt: Array<{ text: string }> }).prompt[0]!).text = "Reply with a word the driver never sends";
    });
    const line = recording.frames[index]!.line;
    await assert.rejects(replayAntigravity(file, { timeoutMs: 10_000 }), (error: unknown) => {
      assert.ok(error instanceof ReplayDriftError, String(error));
      assert.equal(error.line, line);
      return assertDrift(error, file, line, [
        /replay drift: the driver sent a frame other than the next recorded one/,
        /first difference at message\.params\.prompt\.0\.text/,
        new RegExp(`recorded \\(line ${line}\\): .*a word the driver never sends`),
        new RegExp(`sent: .*${escape(SCENARIOS.find((each) => each.name === name)!.prompts[0]!.slice(0, 30))}`),
      ]);
    });
  });

  test(`${name}: Antigravity replay fails, naming the file, the line and both frames, when the scenario ends with recorded frames the driver never sent or took`, async () => {
    const recording = await recordingOf(name);
    const proc = acpSpawns(recording.frames.map((entry) => entry.frame))[0]!["proc"];
    const extra: Frame = { dir: "out", kind: "stdin", proc, message: { jsonrpc: "2.0", id: 99, method: "session/close", params: { sessionId: "sess-never" } } };
    const answer: Frame = { dir: "in", kind: "stdout", proc, message: { jsonrpc: "2.0", id: 99, result: {} } };
    const line = recording.frames.at(-1)!.line + 1;
    const last = recording.frames.at(-1)!;
    // A request the driver never sends.
    const appended = editedCopy(recording, "appended", (frames) => frames.push(extra));
    await assert.rejects(replayAntigravity(appended.file, { timeoutMs: 10_000 }), (error: unknown) =>
      assertDrift(error, appended.file, line, [
        /replay drift: the scenario ended with 1 recorded frame\(s\) not replayed/,
        new RegExp(`next recorded \\(line ${line}\\): ${escape(JSON.stringify(extra))}`),
        new RegExp(`last replayed \\(line ${line - 1}\\): ${escape(showFrame(last.frame))}`),
      ]),
    );
    // Then also its answer on the first agy's stdout: that pipe stays open for it, and the driver, which closes a session once
    // the agent's stdout ends, waits for it. Replay stalls where the driver waited, and names the line the pipe waits for.
    const answered = editedCopy(recording, "appended-with-answer", (frames) => frames.push(extra, answer));
    const copy = await readRecording(answered.file);
    const exit = copy.frames.findIndex((entry) => entry.frame.kind === "exit" && entry.frame["proc"] === proc);
    const waiting = copy.frames[exit + 1]!;
    assert.equal(waiting.frame.dir, "out", "the driver's next frame after the first agy's exit: the appended request, or the resume's second spawn");
    await assert.rejects(replayAntigravity(answered.file, { timeoutMs: 2_000 }), (error: unknown) => {
      assert.ok(error instanceof Error, String(error));
      const shown = error.message.slice(0, 2000);
      assert.ok(error.message.startsWith(`${answered.file}:${waiting.line}: replay stalled: the ${name} scenario waited 2000 ms for the ${name === "resume" ? "first " : ""}session to close\n`), shown);
      assert.ok(error.message.includes(`\n  next recorded (line ${waiting.line}): ${showFrame(waiting.frame)}\n`), shown);
      assert.ok(error.message.includes(`\n  last replayed (line ${waiting.line - 1}): ${showFrame(copy.frames[exit]!.frame)}`), shown);
      assert.ok(error.message.endsWith(`\n  held open: the stdout of process ${proc}, which exited, ends after its line ${line + 1}: ${showFrame(answer)}`), shown);
      return true;
    });
  });

  test(`${name}: Antigravity replay fails, naming the file, the line and both frames, when the recorded stdout frame that ends the first turn is removed`, async () => {
    const recording = await recordingOf(name);
    const end = turnEnd(recording);
    assert.ok(end.index !== -1, "the recording holds the first turn's end");
    const { file } = editedCopy(recording, "removed-turn-end", (frames) => frames.splice(end.index, 1));
    // Replay delivers the inbound frames after the gap, then waits at the next outbound frame for a driver that waits for the turn's end.
    const copy = await readRecording(file);
    const stall = copy.frames.findIndex((entry, position) => position >= end.index && entry.frame.dir === "out");
    const next = copy.frames[stall]!;
    const last = copy.frames[stall - 1]!;
    await assert.rejects(replayAntigravity(file, { timeoutMs: 3_000 }), (error: unknown) => {
      assert.ok(error instanceof Error, String(error));
      const shown = error.message.slice(0, 1500);
      assert.ok(error.message.startsWith(`${file}:${next.line}: replay stalled: the ${name} scenario waited 3000 ms for turn.terminal`), shown);
      assert.ok(error.message.includes(`\n  next recorded (line ${next.line}): ${showFrame(next.frame)}\n`), shown);
      assert.ok(error.message.includes(`\n  last replayed (line ${last.line}): ${showFrame(last.frame)}`), shown);
      return true;
    });
  });
}

/** The ACP tool call a stdout frame is about: a session/update's toolCallId, or a permission request's tool call's. */
function toolCallOf(frame: Frame): string | undefined {
  if (!isAcpOutput(frame)) return undefined;
  const params = messageOf(frame)["params"] as { update?: { toolCallId?: string }; toolCall?: { toolCallId?: string } } | undefined;
  return params?.update?.toolCallId ?? params?.toolCall?.toolCallId;
}

/** The scenario check's error once replay is over: the file and the line of the frame the outcome depended on, the check, that frame, and the frame replayed last. */
function checkError(file: string, check: string, dependedOn: { line: number; frame: Frame }, named: string, last: { line: number; frame: Frame }): string {
  return `${file}:${dependedOn.line}: ${check}\n  depended on (line ${dependedOn.line}, the last recorded frame naming ${named}): ${showFrame(dependedOn.frame)}\n  last replayed (line ${last.line}): ${showFrame(last.frame)}`;
}

test("approval_allowed: Antigravity replay fails when the stdout frame with the command's result is removed, naming the file, the command's last recorded frame and the frame replayed last", async () => {
  const recording = await recordingOf("approval_allowed");
  const index = recording.frames.findIndex((entry) => isAcpOutput(entry.frame) && JSON.stringify(entry.frame["message"]).includes('"status":"completed","content"'));
  assert.ok(index !== -1, "the recording holds the command's result");
  const call = toolCallOf(recording.frames[index]!.frame)!;
  const { file } = editedCopy(recording, "removed-tool-result", (frames) => frames.splice(index, 1));
  const copy = await readRecording(file);
  // What is left of the command on the tape: its last frame says it is in progress, and the turn then ends.
  const dependedOn = copy.frames.findLast((entry) => toolCallOf(entry.frame) === call)!;
  assert.equal((messageOf(dependedOn.frame)["params"] as { update: { status: string } }).update.status, "in_progress");
  await assert.rejects(replayAntigravity(file, { timeoutMs: 10_000 }), (error: unknown) => {
    assert.ok(error instanceof ReplayCheckError, String(error));
    assert.equal(error.message, checkError(file, 'scenario approval_allowed: a command or tool item completed with the marker in its output (items: [["command_execution","completed",""]])', dependedOn, call, copy.frames.at(-1)!));
    return true;
  });
});

test("approval_denied: Antigravity replay fails when the stdout frame that fails the declined command is removed, naming the file, the command's last recorded frame and the frame replayed last", async () => {
  const recording = await recordingOf("approval_denied");
  const index = recording.frames.findIndex((entry) => isAcpOutput(entry.frame) && JSON.stringify(entry.frame["message"]).includes('"status":"failed"'));
  assert.ok(index !== -1, "the recording holds the declined command's end");
  const call = toolCallOf(recording.frames[index]!.frame)!;
  const { file } = editedCopy(recording, "removed-tool-failure", (frames) => frames.splice(index, 1));
  const copy = await readRecording(file);
  // What is left of the command on the tape: the permission request the host declined.
  const dependedOn = copy.frames.findLast((entry) => toolCallOf(entry.frame) === call)!;
  assert.equal(messageOf(dependedOn.frame)["method"], "session/request_permission");
  await assert.rejects(replayAntigravity(file, { timeoutMs: 10_000 }), (error: unknown) => {
    assert.ok(error instanceof ReplayCheckError, String(error));
    assert.equal(error.message, checkError(file, 'scenario approval_denied: no command item completed (items: [["command_execution","completed",""]])', dependedOn, call, copy.frames.at(-1)!));
    return true;
  });
});

/** Each turn's frames in `recording`: its session/prompt request and the response that ended it. */
function turnsOf(recording: Recording): Array<{ request: { index: number; line: number; frame: Frame }; response: { index: number; line: number; frame: Frame } }> {
  const turns: Array<{ request: { index: number; line: number; frame: Frame }; response: { index: number; line: number; frame: Frame } }> = [];
  recording.frames.forEach((entry, index) => {
    if (entry.frame.kind !== "stdin" || messageOf(entry.frame)["method"] !== "session/prompt") return;
    const id = messageOf(entry.frame)["id"];
    const answer = recording.frames.findIndex((later, position) => position > index && later.frame.kind === "stdout" && later.frame["proc"] === entry.frame["proc"] && messageOf(later.frame)["id"] === id && messageOf(later.frame)["result"] !== undefined);
    turns.push({ request: { index, line: entry.line, frame: entry.frame }, response: { index: answer, line: recording.frames[answer]!.line, frame: recording.frames[answer]!.frame } });
  });
  return turns;
}

/** The scenario check's error once replay is over, for a check about one turn: the file and the line of the response that ended it, the check, that response, and the frame replayed last. */
function turnCheckError(file: string, check: string, turn: number, frames: ReturnType<typeof turnsOf>[number], last: { line: number; frame: Frame }): string {
  return `${file}:${frames.response.line}: ${check}\n  depended on (line ${frames.response.line}, the response that ended turn ${turn}, requested at line ${frames.request.line}): ${showFrame(frames.response.frame)}\n  last replayed (line ${last.line}): ${showFrame(last.frame)}`;
}

const isReplyChunk = (frame: Frame): boolean => isAcpOutput(frame) && (messageOf(frame)["params"] as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "agent_message_chunk";

test("simple: when every frame of the reply is removed, Antigravity replay fails naming the file, the response that ended the turn and the frame replayed last", async () => {
  const recording = await recordingOf("simple");
  const { file } = editedCopy(recording, "removed-reply", (frames) => {
    for (let index = frames.length - 1; index >= 0; index -= 1) if (isReplyChunk(frames[index]!)) frames.splice(index, 1);
  });
  const copy = await readRecording(file);
  const [turn] = turnsOf(copy);
  await assert.rejects(replayAntigravity(file, { timeoutMs: 10_000 }), (error: unknown) => {
    assert.ok(error instanceof ReplayCheckError, String(error));
    assert.equal(error.message, turnCheckError(file, "scenario simple: a settled assistant message with non-empty text", 1, turn!, copy.frames.at(-1)!));
    return true;
  });
});

/**
 * A signed copy of `recording` whose reply in turn `turn` (1 for the first)
 * is one agent_message_chunk holding the whole text, as an agent may send
 * it; the fake agent sends each reply in two. Returns the copy and the
 * index of that sole chunk.
 */
function soleReplyChunk(recording: Recording, turn: number, label: string): { file: string; chunk: number; text: string } {
  const { request, response } = turnsOf(recording)[turn - 1]!;
  const chunks = recording.frames.flatMap((entry, index) => (index > request.index && index < response.index && isReplyChunk(entry.frame) ? [index] : []));
  assert.ok(chunks.length >= 2, `turn ${turn} of ${recording.header.scenario} replies in ${chunks.length} chunk(s)`);
  const text = chunks.map((index) => ((messageOf(recording.frames[index]!.frame)["params"] as { update: { content: { text: string } } }).update.content.text)).join("");
  const { file } = editedCopy(recording, label, (frames) => {
    ((messageOf(frames[chunks[0]!]!)["params"] as { update: { content: { text: string } } }).update.content).text = text;
    for (const index of chunks.slice(1).reverse()) frames.splice(index, 1);
  });
  return { file, chunk: chunks[0]!, text };
}

for (const [name, turn, check] of [
  ["simple", 1, () => "scenario simple: a settled assistant message with non-empty text"],
  ["multi_turn", 2, () => `scenario multi_turn: the second turn's text "" contains ${JSON.stringify(SCENARIOS.find((each) => each.name === "multi_turn")!.word)}`],
] as const) {
  test(`${name}: when the sole chunk of turn ${turn}'s reply is removed, Antigravity replay fails naming the file, the line, the response that ended the turn and the frame replayed last`, async () => {
    const recording = await recordingOf(name);
    // The reply as one chunk replays: the tape is sound before the chunk goes.
    const sole = soleReplyChunk(recording, turn, `sole-reply-chunk-${turn}`);
    assert.ok(sole.text.trim() !== "", "the reply holds text");
    await replayAntigravity(sole.file);
    const { file } = editedCopy(await readRecording(sole.file), `removed-sole-reply-chunk-${turn}`, (frames) => frames.splice(sole.chunk, 1));
    const copy = await readRecording(file);
    assert.equal(copy.frames.filter((entry, index) => index > turnsOf(copy)[turn - 1]!.request.index && index < turnsOf(copy)[turn - 1]!.response.index && isReplyChunk(entry.frame)).length, 0, "the turn holds no reply chunk");
    await assert.rejects(replayAntigravity(file, { timeoutMs: 10_000 }), (error: unknown) => {
      assert.ok(error instanceof ReplayCheckError, String(error));
      assert.equal(error.message, turnCheckError(file, check(), turn, turnsOf(copy)[turn - 1]!, copy.frames.at(-1)!));
      return true;
    });
  });
}

test("interrupt: when the response that ends the turn says end_turn instead of cancelled, Antigravity replay fails naming the file, that response and the frame replayed last", async () => {
  const recording = await recordingOf("interrupt");
  const [turn] = turnsOf(recording);
  assert.equal((messageOf(turn!.response.frame)["result"] as { stopReason: string }).stopReason, "cancelled");
  const { file } = editedCopy(recording, "turn-end-not-cancelled", (frames) => {
    (messageOf(frames[turn!.response.index]!)["result"] as { stopReason: string }).stopReason = "end_turn";
  });
  const copy = await readRecording(file);
  await assert.rejects(replayAntigravity(file, { timeoutMs: 10_000 }), (error: unknown) => {
    assert.ok(error instanceof ReplayCheckError, String(error));
    const check = (error.cause as Error).message;
    assert.ok(check.startsWith("scenario interrupt: the turn ended interrupted\n"), check);
    assert.equal(error.message, turnCheckError(file, check, 1, turnsOf(copy)[0]!, copy.frames.at(-1)!));
    return true;
  });
});

test("every scenario check that fails names the turns it looked at, and each of those turns has recorded frames to name: none falls back to naming nothing", async () => {
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
    const { run } = await replayAntigravity(recording);
    const native = acpNativeAnswers(recording.frames.map((entry) => entry.frame));
    let failed = 0;
    for (const [label, broken] of [
      ["every turn failed", withTerminal(run, "failed")],
      ["every turn interrupted", withTerminal(run, "interrupted")],
      ["no turn.terminal", withoutTerminals(run)],
      ["no assistant message", withoutItemsOf(run, ["assistant_message"])],
      ["no command or tool item", withoutItemsOf(run, ["command_execution", "tool_call", "mcp_tool_call", "dynamic_tool_call"])],
      ["one turn fewer", withoutLastTurn(run)],
      ["no interrupt", withoutInterrupt(run)],
      ["no answer reached the agent", run],
    ] as const) {
      let thrown: unknown;
      try {
        checkScenario(broken, label === "no answer reached the agent" ? [] : native);
      } catch (error) {
        thrown = error;
      }
      if (thrown === undefined) continue;
      failed += 1;
      assert.ok(thrown instanceof ScenarioCheckError, `${name}, ${label}: ${String(thrown)}`);
      assert.ok(thrown.turns.length > 0, `${name}, ${label}: ${thrown.message}`);
      assert.ok(acpTurnsDependedOn(recording, thrown.turns).length === thrown.turns.length, `${name}, ${label}: each turn the check looked at has a recorded response`);
    }
    assert.ok(failed >= 3, `${name}: ${failed} of the broken runs failed a check`);
  }
});

test("replay ends a process's pipes once its exit came and the lines recorded right after it were handed over: a line recorded after the exit still reaches the driver", async () => {
  const recording = await recordingOf("simple");
  const frames = recording.frames.map((entry) => entry.frame);
  const stderr = frames.findIndex((frame) => frame.kind === "stderr");
  const exit = frames.findIndex((frame) => frame.kind === "exit" && frame["proc"] === frames[stderr]!["proc"]);
  // The process's stderr line arrives after its exit, as when a process exits before its reader took the last chunk.
  const { file } = editedCopy(recording, "stderr-after-exit", (copy) => {
    const [line] = copy.splice(stderr, 1);
    copy.splice(exit, 0, line!);
  });
  const { replay } = await replayAntigravity(file);
  assert.ok(replay.sequencer.done());
});

test("a stderr line of the first agy recorded after the driver started the second replays: the ACP driver drains stderr apart from the exit, and the pipe stays open until its own last recorded line", async () => {
  const recording = await recordingOf("resume");
  const frames = recording.frames.map((entry) => entry.frame);
  const [first, second] = acpSpawns(frames);
  const stderr = frames.findIndex((frame) => frame.kind === "stderr" && frame["proc"] === first!["proc"]);
  const secondSpawn = frames.indexOf(second!);
  // The first process's stderr line now comes right after the driver started the second process.
  const { file, frames: edited } = editedCopy(recording, "stderr-after-next-spawn", (copy) => {
    const [line] = copy.splice(stderr, 1);
    copy.splice(secondSpawn, 0, line!);
  });
  const moved = edited.findIndex((frame) => frame.kind === "stderr" && frame["proc"] === first!["proc"]);
  assert.equal(edited[moved - 1]!.kind, "spawn");
  assert.equal(edited[moved - 1]!["proc"], second!["proc"]);
  const { replay } = await replayAntigravity(file);
  assert.ok(replay.sequencer.done());
});

test("what replay does not detect: a stdout or stderr line added right after its process's exit, which the driver reads to the end of its pipe and ignores", async () => {
  const recording = await recordingOf("simple");
  const proc = acpSpawns(recording.frames.map((entry) => entry.frame))[0]!["proc"];
  const { file } = editedCopy(recording, "late-lines", (frames) => {
    frames.push({ dir: "in", kind: "stdout", proc, message: { jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "usage_update", used: 1, size: 2 } } } });
    frames.push({ dir: "in", kind: "stderr", proc, text: "a late line" });
  });
  const { replay } = await replayAntigravity(file);
  assert.ok(replay.sequencer.done(), "the driver took both lines");
});

test("Antigravity replay ignores only the ARI version in the initialize request: a change to it passes, a change to the client's name fails, and the code's list is that one field", async () => {
  assert.deepEqual(
    ANTIGRAVITY_IGNORED_FIELDS.map((entry) => [entry.driver, entry.kind, entry.field]),
    [["antigravity", "stdin", "message.params.clientInfo.version"]],
  );
  const recording = await recordingOf("simple");
  const index = recording.frames.findIndex((entry) => entry.frame.kind === "stdin" && messageOf(entry.frame)["method"] === "initialize");
  const version = editedCopy(recording, "ari-version", (frames) => {
    ((messageOf(frames[index]!)["params"] as { clientInfo: { version: string } }).clientInfo).version = "0.0.0-another-release";
  });
  await replayAntigravity(version.file);
  const name = editedCopy(recording, "client-name", (frames) => {
    ((messageOf(frames[index]!)["params"] as { clientInfo: { name: string } }).clientInfo).name = "not-ari";
  });
  await assert.rejects(replayAntigravity(name.file), /first difference at message\.params\.clientInfo\.name: recorded "not-ari", sent "ari"/);
  const spawn = editedCopy(recording, "spawn-env", (frames) => {
    frames[0] = { ...frames[0]!, envNames: ["GEMINI_HOME"] };
  });
  await assert.rejects(replayAntigravity(spawn.file), /first difference at envNames/);
});

test("resanitise-recordings runs an Antigravity recording through the sanitiser again with the ACP protocol words, and one with nothing new to replace comes out byte-identical", async () => {
  const recording = await recordingOf("approval_allowed");
  const copy = path.join(DIRECTORY, "copies", "resanitise-approval_allowed.ndjson");
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(recording.file, copy);
  assert.equal(await resanitiseRecording(copy, { env: {}, user: "ari-nobody" }), false);
  assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(recording.file)));
  await replayAntigravity(copy);
});

test("the scenario checks read the approval answers off the recorded permission requests and the driver's answers", async () => {
  for (const name of ["approval_allowed", "approval_denied"] as const) {
    const recording = await recordingOf(name);
    const { run } = await replayAntigravity(recording);
    const frames = recording.frames.map((entry) => entry.frame);
    checkScenario(run, acpNativeAnswers(frames));
    const withoutAnswer = frames.filter((frame) => !(frame.kind === "stdin" && messageOf(frame)["result"] !== undefined));
    assert.throws(() => checkScenario(run, acpNativeAnswers(withoutAnswer)), name === "approval_allowed" ? /allow-once answer reached the native side/ : /decline answer reached the native side/);
  }
});

// Sanitising.

for (const [recordedAs, replayedAs] of [
  ["text", "user"],
  ["user", "text"],
] as const) {
  test(`Antigravity recordings made on an account named ${recordedAs} keep the ACP protocol words and replay on an account named ${replayedAs}`, async () => {
    const { outcomes } = await recordFake(`account-${recordedAs}`, { USER: recordedAs, LOGNAME: recordedAs }, SCENARIO_NAMES, recordedAs);
    for (const outcome of outcomes) {
      assert.equal(outcome.error, undefined, `${outcome.scenario}: ${outcome.error?.message}`);
      const text = fs.readFileSync(outcome.file!, "utf8");
      assert.ok(text.includes('"type":"text"') && text.includes('"sessionUpdate":"agent_message_chunk"') && text.includes('"method":"session/update"'), `${outcome.scenario}: the protocol words are intact`);
      await replayAntigravity(outcome.file!, { user: replayedAs, env: { ...process.env, USER: replayedAs, LOGNAME: replayedAs } });
    }
  });
}

test("the Antigravity recorder replaces the OS user name, a home path, an email, a secret environment value, an account id and each account detail in a recorded frame, the scan and check:recordings pass, and the recording replays", async () => {
  const osName = os.userInfo().username;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(DIRECTORY, "sanitise-home-")));
  const secret = "ari-synthetic-service-token-0001";
  const planted = {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: `${osName} asked from ${home}/notes, as ari-recorder-user@example.org, with ${secret} and /home/someone-else/x` },
    _meta: {
      "ari.test/account": {
        accountId: "acct-31f9c2",
        organizationId: "org-77d1e0",
        userTier: "g1-pro-tier",
        planType: "Google AI Pro",
        rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.82, resetsAt: 1796072400 },
        credential_expires_at: "2026-12-16T12:44:44.039Z",
        tokenExpiresAt: 1796000000000,
        pid: 2294915,
        tmp: "/var/tmp/opencode/session.1YX2c84S/agy",
        socketPath: "/run/user/1000/agy-2294915.sock",
        shell: "/usr/bin/zsh",
      },
    },
  };
  const listing = `drwx------ 2 ${osName} ${osName} 4096 Nov 25 12:00 ${home}/project\n`;
  const models = [
    { value: "fake-pro-high", name: "Fake Pro (High)" },
    { value: "fake-argon", name: "Fake Argon" },
    { value: "fake-flash", name: "Fake Flash" },
  ];
  const { outcomes } = await recordFake(
    "sanitise",
    {
      HOME: home,
      USER: "ari-recorder-user",
      ARI_TEST_SERVICE_TOKEN: secret,
      ARI_FAKE_AGY_PLANT: JSON.stringify(planted),
      // The fake streams a reply in two chunks, split in its middle; the name is in the second. A value split across chunks matches no rule (docs/recordings.md, the known limit of streamed text), so the home path and the email are planted whole.
      ARI_FAKE_AGY_REPLY: `The answer is ok, and the one who asked is ${osName}`,
      ARI_FAKE_AGY_OUTPUT: `${listing}${SCENARIOS.find((scenario) => scenario.name === "approval_allowed")!.marker!}\n`,
      ARI_FAKE_AGY_MODELS: JSON.stringify(models),
    },
    ["simple", "approval_allowed"],
  );
  const root = fs.mkdtempSync(path.join(DIRECTORY, "check-root-"));
  for (const outcome of outcomes) {
    assert.equal(outcome.error, undefined, `${outcome.scenario}: ${outcome.error?.message}`);
    const text = fs.readFileSync(outcome.file!, "utf8");
    const frames = (await readRecording(outcome.file!)).frames.map((entry) => entry.frame);
    assert.ok(!text.includes(outcome.workspace), `${outcome.scenario}: the workspace path`);
    assert.ok(!text.includes(home), `${outcome.scenario}: the HOME`);
    assert.deepEqual(wholeWordsOf(osName, frames, ACP_PROTOCOL_WORDS), [], `${outcome.scenario}: the OS user name is nowhere in the recording but in protocol words`);
    for (const leaked of ["ari-recorder-user@example.org", secret, "someone-else", "acct-31f9c2", "org-77d1e0", "g1-pro-tier", "Google AI Pro", "0.82", "1796072400", "2026-12-16", "1796000000000", "2294915", "session.1YX2c84S", "agy-2294915", "zsh", "fake-argon", "Fake Argon"]) {
      assert.ok(!text.includes(leaked), `${outcome.scenario}: ${leaked} is gone`);
    }
    const thought = frames.find((frame) => isAcpOutput(frame) && (messageOf(frame)["params"] as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "agent_thought_chunk")!;
    const update = (messageOf(thought)["params"] as { update: { content: { text: string }; _meta: { [key: string]: unknown } } }).update;
    assert.equal(update.content.text, `${PLACEHOLDERS.user} asked from ${PLACEHOLDERS.home}/notes, as ${PLACEHOLDERS.email}, with <ARI_TEST_SERVICE_TOKEN> and ${PLACEHOLDERS.otherHome}/x`);
    assert.deepEqual(update._meta["ari.test/account"], {
      accountId: PLACEHOLDERS.accountId,
      organizationId: PLACEHOLDERS.orgId,
      userTier: PLACEHOLDERS.plan,
      planType: PLACEHOLDERS.plan,
      rate_limit_info: NEUTRAL_RATE_LIMIT_INFO,
      credential_expires_at: NEUTRAL_TIME.iso,
      tokenExpiresAt: NEUTRAL_TIME.milliseconds,
      pid: NEUTRAL_PID,
      tmp: NEUTRAL_TMP_PATH,
      socketPath: NEUTRAL_SOCKET_PATH,
      shell: NEUTRAL_SHELL,
    });
    // The model picker keeps the recorded model and the one the agent had selected, which the driver compares before it changes the model.
    const created = frames.find((frame) => isAcpOutput(frame) && Array.isArray((messageOf(frame)["result"] as { configOptions?: unknown } | undefined)?.configOptions))!;
    const option = ((messageOf(created)["result"] as { configOptions: Array<{ currentValue: string; options: Array<{ value: string }> }> }).configOptions)[0]!;
    assert.equal(option.currentValue, "fake-pro-high");
    assert.deepEqual(option.options.map((entry) => entry.value), ["fake-pro-high", "fake-flash"]);
    if (outcome.scenario === "simple") assert.ok(text.includes(`asked is ${PLACEHOLDERS.user}"`), "the reply, sanitised");
    if (outcome.scenario === "approval_allowed") assert.ok(text.includes(`drwx------ 2 ${PLACEHOLDERS.user} ${PLACEHOLDERS.user} 4096`), "the command output, sanitised");
    assert.deepEqual(scanRecordingText(text, outcome.file!, { home }), [], outcome.scenario);
    const target = path.join(root, "test", "drivers", "antigravity", "recordings", path.basename(outcome.file!));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(outcome.file!, target);
    await replayAntigravity(outcome.file!);
  }
  // check:recordings itself, over a tree holding the recordings, run as the gate runs it.
  const check = spawnSync(NODE_EXECUTABLE, [path.join(REPO_ROOT, "scripts", "check-recordings.ts"), "--root", root], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") },
  });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /check-recordings: 2 recording file\(s\), no paths, emails or tokens/);
});

test("the Antigravity recorder replaces each kind of account detail as agy's ACP frames can carry it: a usage_update's token counts and cost, a quota's fractions, amounts and reset time, credit balances, and per-provider sign-in status; check:recordings passes and the recordings replay", async () => {
  // ACP's own usage report (UsageUpdate, with a Cost), and two session_info_update frames, whose _meta ACP leaves to the agent for custom metadata,
  // with a quota bucket and credits as the Antigravity CLI 1.5.17 binary names them, and a list of providers with their sign-in status.
  const usage = { sessionUpdate: "usage_update", used: 3271, size: 131072, cost: { amount: 0.02187, currency: "USD" } };
  const quota = {
    sessionUpdate: "session_info_update",
    _meta: { "ari.test/quota": { buckets: [{ modelId: "fake-flash", tokenType: "REQUESTS", remainingFraction: 0.239, remainingAmount: "412", resetTime: "2026-11-26T03:00:00Z" }], usedPromptCredits: 18307, availableFlowCredits: 1693 } },
  };
  const signIn = {
    sessionUpdate: "session_info_update",
    _meta: { "ari.test/auth": { providers: [{ id: "google-workspace", name: "Google Workspace", isAuthenticated: true }, { id: "vertex-ai", name: "Vertex AI", signedIn: true, needsAuth: false }], session: { isAuthenticated: false, needsAuth: true } } },
  };
  const { outcomes } = await recordFake("account-details", { ARI_FAKE_AGY_PLANT: JSON.stringify([usage, quota, signIn]) }, ["simple", "approval_allowed"]);
  const root = fs.mkdtempSync(path.join(DIRECTORY, "check-account-details-"));
  for (const outcome of outcomes) {
    assert.equal(outcome.error, undefined, `${outcome.scenario}: ${outcome.error?.message}`);
    const text = fs.readFileSync(outcome.file!, "utf8");
    for (const leaked of ["3271", "131072", "0.02187", "0.239", '"412"', "2026-11-26T03", "18307", "1693", "google-workspace", "Google Workspace", "vertex-ai", "Vertex AI"]) assert.ok(!text.includes(leaked), `${outcome.scenario}: ${leaked} is gone`);
    const updates = (await readRecording(outcome.file!)).frames.flatMap((entry) => {
      const params = isAcpOutput(entry.frame) ? (messageOf(entry.frame)["params"] as { update?: { sessionUpdate?: string } } | undefined) : undefined;
      return params?.update === undefined ? [] : [params.update];
    });
    // The planted report, and the one the fake agent sends at the end of every turn (1200 of 200000 tokens).
    const reports = updates.filter((update) => update.sessionUpdate === "usage_update");
    assert.deepEqual(reports, [{ sessionUpdate: "usage_update", used: 0, size: 0, cost: { amount: 0, currency: "USD" } }, { sessionUpdate: "usage_update", used: 0, size: 0 }]);
    assert.deepEqual(
      updates.filter((update) => update.sessionUpdate === "session_info_update"),
      [
        { sessionUpdate: "session_info_update", _meta: { "ari.test/quota": { buckets: [{ modelId: "fake-flash", tokenType: "REQUESTS", remainingFraction: 0, remainingAmount: "0", resetTime: NEUTRAL_TIME.iso }], usedPromptCredits: 0, availableFlowCredits: 0 } } },
        { sessionUpdate: "session_info_update", _meta: { "ari.test/auth": { providers: [], session: { isAuthenticated: true, needsAuth: false } } } },
      ],
    );
    assert.deepEqual(scanRecordingText(text, outcome.file!, {}), [], outcome.scenario);
    const target = path.join(root, "test", "drivers", "antigravity", "recordings", path.basename(outcome.file!));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(outcome.file!, target);
    const { run } = await replayAntigravity(outcome.file!);
    // The driver still parses the neutral report: the host saw it as usage.
    const usageEvents = run.events.flatMap((event) => (event.body.type === "usage.updated" ? [event.body.usage] : []));
    assert.deepEqual(usageEvents[0], { scope: "thread", contextUsedTokens: 0, contextMaxTokens: 0, costUsd: 0 });
  }
  const check = spawnSync(NODE_EXECUTABLE, [path.join(REPO_ROOT, "scripts", "check-recordings.ts"), "--root", root], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: fs.mkdtempSync(path.join(DIRECTORY, "check-home-")) } });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /check-recordings: 2 recording file\(s\), no paths, emails or tokens/);
});
