// The Claude recorder and replay, end to end against the fake Claude SDK.
// The recording function scripts/record-claude.ts calls records all six
// scenarios from the fake (source `fake`); each recording holds both
// directions; each replays through a fresh driver over the replay SDK with
// every scenario assertion passing. Replay fails loudly, naming the file,
// the line and both frames, when an outbound frame differs, when recorded
// frames are left over, and when a recorded inbound frame is missing.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { CLAUDE_IGNORED_FIELDS, claudeNativeAnswers } from "../../recordings/claude/frames.ts";
import { recordClaude } from "../../recordings/claude/record.ts";
import type { ClaudeRecordOutcome } from "../../recordings/claude/record.ts";
import { replayClaude } from "../../recordings/claude/replay.ts";
import { createClaudeReplaySdk } from "../../recordings/claude/replay-sdk.ts";
import { startTurnAfterItsText } from "../../recordings/late-start-turn.ts";
import { createSanitiser } from "../../recordings/sanitiser.ts";
import { encodeRecording, parseRecording, readRecording } from "../../recordings/format.ts";
import type { Frame, Recording, RecordingMetadata } from "../../recordings/format.ts";
import { SCENARIOS, SCENARIO_NAMES, checkScenario, settledItems } from "../../recordings/scenarios.ts";
import type { ScenarioName, ScenarioRun } from "../../recordings/scenarios.ts";
import { ReplayDriftError } from "../../recordings/sequencer.ts";
import { puppetRuntime, startPuppet } from "./puppets.ts";

const DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), "ari-claude-recordings-"));
process.on("exit", () => fs.rmSync(DIRECTORY, { recursive: true, force: true }));

let recorded: Promise<ClaudeRecordOutcome[]> | undefined;

/** Records all six scenarios from the fake once for this file, through the recorder's own recording function. */
function recordAll(): Promise<ClaudeRecordOutcome[]> {
  recorded ??= (async () => {
    const home = fs.mkdtempSync(path.join(DIRECTORY, "home-"));
    return recordClaude({
      outDir: path.join(DIRECTORY, "recordings"),
      source: "fake",
      env: { HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin", USER: "ari-test-user" },
      loadSdk: async (scenario) => puppetRuntime(startPuppet(scenario)),
      timeoutMs: 20_000,
    });
  })();
  return recorded;
}

async function recordingOf(name: ScenarioName): Promise<Recording> {
  const outcome = (await recordAll()).find((each) => each.scenario === name)!;
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

const kinds = (recording: Recording, dir: "out" | "in"): string[] => recording.frames.filter((entry) => entry.frame.dir === dir).map((entry) => entry.frame.kind);

test("the recording function records all six scenarios from the fake SDK, each to its own file with source fake", async () => {
  const outcomes = await recordAll();
  assert.deepEqual(
    outcomes.map((outcome) => outcome.scenario),
    [...SCENARIO_NAMES],
  );
  for (const outcome of outcomes) {
    assert.equal(outcome.error, undefined, `${outcome.scenario}: ${outcome.error?.message}`);
    assert.equal(outcome.file, path.join(DIRECTORY, "recordings", `${outcome.scenario}.ndjson`));
    const recording = await readRecording(outcome.file!);
    assert.equal(recording.header.source, "fake");
    assert.equal(recording.header.scenario, outcome.scenario);
    assert.equal(recording.header.driver, "claude");
    assert.equal(recording.header.vendor, "claude-code");
    assert.equal(recording.header.vendorVersion, "2.1.330");
    assert.equal(recording.header.sdk, "@anthropic-ai/claude-agent-sdk");
    assert.equal(recording.header.sdkVersion, "0.3.330");
    assert.equal(recording.header.model, "haiku");
    assert.match(recording.header.recorded, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(outcome.frames, recording.frames.length);
    assert.ok(!fs.existsSync(outcome.workspace), `${outcome.scenario}: the temp workspace is gone`);
  }
});

test("each recording holds both directions: query options, prompts and control calls out; messages, call results and canUseTool calls in, with the driver's answers out", async () => {
  for (const name of SCENARIO_NAMES) {
    const recording = await recordingOf(name);
    const scenario = SCENARIOS.find((each) => each.name === name)!;
    const out = kinds(recording, "out");
    const inbound = kinds(recording, "in");
    const query = recording.frames.find((entry) => entry.frame.kind === "query")!.frame;
    const options = query["options"] as { [key: string]: unknown };
    assert.equal(options["cwd"], "<WORKSPACE>/cwd", name);
    assert.equal(options["model"], "haiku", name);
    assert.deepEqual(options["settingSources"], [], name);
    assert.equal(options["canUseTool"], "<function>", name);
    const prompts = recording.frames.filter((entry) => entry.frame.kind === "prompt").map((entry) => (entry.frame["message"] as { message: { content: Array<{ text: string }> } }).message.content[0]!.text);
    assert.deepEqual(prompts, [...scenario.prompts], `${name}: every prompt the driver sent, in order`);
    const methods = recording.frames.filter((entry) => entry.frame.kind === "call").map((entry) => entry.frame["method"]);
    assert.ok(methods.includes("initializationResult") && methods.includes("setMcpServers") && methods.includes("close"), `${name}: ${methods.join(", ")}`);
    const results = recording.frames.filter((entry) => entry.frame.kind === "result");
    assert.equal(results.length, methods.filter((method) => method !== "close").length, `${name}: every call but close has its result`);
    assert.ok(inbound.includes("message") && inbound.includes("end"), name);
    const messageTypes = recording.frames.filter((entry) => entry.frame.kind === "message").map((entry) => (entry.frame["message"] as { type: string }).type);
    assert.ok(messageTypes.includes("system") && messageTypes.includes("assistant") && messageTypes.includes("result"), `${name}: ${messageTypes.join(", ")}`);
    if (name === "approval_allowed" || name === "approval_denied") {
      assert.ok(inbound.includes("can_use_tool"), name);
      assert.ok(out.includes("permission"), name);
      const answers = claudeNativeAnswers(recording.frames);
      assert.deepEqual(
        answers.map((answer) => answer.decision),
        [name === "approval_allowed" ? "accept" : "decline"],
      );
    }
    if (name === "interrupt") assert.ok(methods.includes("interrupt"), name);
    if (name === "resume") assert.ok(methods.includes("getSessionInfo") && kinds(recording, "out").filter((kind) => kind === "query").length === 2, name);
  }
});

for (const name of SCENARIO_NAMES) {
  test(`${name}: the recording replays through a fresh driver over the replay SDK, and every scenario assertion holds`, async () => {
    const recording = await recordingOf(name);
    const { run, replay } = await replayClaude(recording);
    assert.ok(replay.sequencer.done());
    assert.equal(replay.sequencer.matchedOutbound().length, recording.frames.filter((entry) => entry.frame.dir === "out").length);
    assert.equal(run.scenario.name, name);
  });
}

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

test("interrupt: when the turn's text reaches the host before startTurn resolves, the host still interrupts at the turn's first text and the Claude replay passes", async () => {
  const recording = await recordingOf("interrupt");
  const { run, replay } = await replayClaude(recording, { timeoutMs: 5_000, wrapSession: startTurnAfterItsText });
  assert.ok(replay.sequencer.done());
  const [turnId] = run.turnIds;
  const messages = new Set(run.events.flatMap((event) => (event.body.type === "item.upsert" && event.body.item.kind === "assistant_message" ? [event.body.item.id] : [])));
  const firstText = run.events.find(
    (event) =>
      event.turnId === turnId &&
      ((event.body.type === "item.delta" && messages.has(event.body.itemId) && event.body.field === "text" && event.body.chunk !== "") ||
        (event.body.type === "item.upsert" && messages.has(event.body.item.id) && typeof event.body.item.text === "string" && event.body.item.text !== "")),
  );
  assert.ok(firstText !== undefined, "the turn's text is kept, attributed to the turn");
  assert.deepEqual(run.interrupted, { turnId, afterSeq: firstText.seq }, "the host interrupted at the first text, which came before startTurn resolved");
});

test("approval_allowed: replay fails when the message with the command's result is removed: the command's output never reaches the host", async () => {
  const recording = await recordingOf("approval_allowed");
  const index = recording.frames.findIndex((entry) => entry.frame.kind === "message" && (entry.frame["message"] as { type: string }).type === "user");
  assert.ok(index !== -1, "the recording holds the command's result");
  const { file } = editedCopy(recording, "removed-tool-result", (frames) => frames.splice(index, 1));
  await assert.rejects(replayClaude(file, { timeoutMs: 10_000 }), /scenario approval_allowed: a command or tool item completed with the marker in its output/);
});

test("approval_denied: replay fails when the message with the declined command's result is removed: the command would show as completed", async () => {
  const recording = await recordingOf("approval_denied");
  const index = recording.frames.findIndex((entry) => entry.frame.kind === "message" && (entry.frame["message"] as { type: string }).type === "user");
  assert.ok(index !== -1, "the recording holds the declined command's result");
  const { file } = editedCopy(recording, "removed-denial-result", (frames) => frames.splice(index, 1));
  await assert.rejects(replayClaude(file, { timeoutMs: 10_000 }), /scenario approval_denied: no command item completed/);
});

test("interrupt: replay fails, naming the file and the line, when the result of the driver's interrupt call is removed, instead of waiting for ever", async () => {
  const recording = await recordingOf("interrupt");
  const call = recording.frames.find((entry) => entry.frame.kind === "call" && entry.frame["method"] === "interrupt")!;
  const index = recording.frames.findIndex((entry) => entry.frame.kind === "result" && entry.frame["id"] === call.frame["id"]);
  assert.ok(index !== -1, "the recording holds the interrupt call's result");
  const { file } = editedCopy(recording, "removed-interrupt-result", (frames) => frames.splice(index, 1));
  await assert.rejects(replayClaude(file, { timeoutMs: 3_000 }), (error: unknown) => {
    assert.ok(error instanceof Error, String(error));
    assert.match(error.message, new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+: replay stalled: the interrupt scenario waited 3000 ms for the host's answers and interrupt to settle`), error.message.slice(0, 600));
    return true;
  });
});

test("the replay SDK imports neither driver code nor the fake SDK, directly or through other modules, type-only imports included", () => {
  // The walk finds driver code where it is: the rig imports the driver and the fake.
  const rig = reachedFrom("test/drivers/claude/rig.ts");
  assert.ok(rig.includes("src/drivers/claude/index.ts") && rig.includes("test/drivers/claude/fake-sdk.ts"), rig.join(", "));
  const reached = reachedFrom("test/recordings/claude/replay-sdk.ts");
  assert.ok(reached.length > 3, reached.join(", "));
  assert.deepEqual(
    reached.filter((file) => file.startsWith("src/drivers/") || file.startsWith("test/drivers/")),
    [],
  );
});

test("the scenario checks reject a run that breaks what the scenario promises", async () => {
  const runs = new Map<ScenarioName, { run: ScenarioRun; frames: Frame[] }>();
  for (const name of SCENARIO_NAMES) {
    const recording = await recordingOf(name);
    const { run } = await replayClaude(recording);
    runs.set(name, { run, frames: recording.frames.map((entry) => entry.frame) });
  }
  const withTerminal = (run: ScenarioRun, status: string): ScenarioRun => ({
    ...run,
    events: run.events.map((event) => (event.body.type === "turn.terminal" ? { ...event, body: { ...event.body, status } } : event)),
  });
  const withoutItemsOf = (run: ScenarioRun, kind: string): ScenarioRun => ({
    ...run,
    events: run.events.filter((event) => !(event.body.type === "item.upsert" && event.body.item.kind === kind)),
  });
  const reject = (name: ScenarioName, run: ScenarioRun, frames: Frame[], why: RegExp): void => {
    assert.throws(() => checkScenario(run, claudeNativeAnswers(frames)), why, name);
  };
  const simple = runs.get("simple")!;
  reject("simple", withTerminal(simple.run, "failed"), simple.frames, /the turn completed/);
  reject("simple", withoutItemsOf(simple.run, "assistant_message"), simple.frames, /a settled assistant message with non-empty text/);
  const multi = runs.get("multi_turn")!;
  reject("multi_turn", withTerminal(multi.run, "interrupted"), multi.frames, /both turns completed/);
  reject("multi_turn", withoutItemsOf(multi.run, "assistant_message"), multi.frames, /the second turn's text/);
  const allowed = runs.get("approval_allowed")!;
  reject("approval_allowed", allowed.run, allowed.frames.filter((frame) => frame.kind !== "permission"), /allow-once answer reached the native side/);
  reject("approval_allowed", { ...allowed.run, requests: [] }, allowed.frames, /a request of kind command reached the host/);
  reject("approval_allowed", withoutItemsOf(allowed.run, "command_execution"), allowed.frames, /a command or tool item completed/);
  const denied = runs.get("approval_denied")!;
  reject("approval_denied", denied.run, denied.frames.filter((frame) => frame.kind !== "permission"), /decline answer reached the native side/);
  // The declined command's item, as if it had run and completed with the marker in its output.
  const commandItem = denied.run.events.find((event) => event.body.type === "item.upsert" && event.body.item.kind === "command_execution")!;
  const commandItemId = (commandItem.body as { item: { id: string } }).item.id;
  const leaked: ScenarioRun = {
    ...denied.run,
    events: [...denied.run.events, { ...commandItem, body: { type: "item.upsert", item: { id: commandItemId, status: "completed", output: `${SCENARIOS[3]!.marker!}\n` } } }],
  };
  reject("approval_denied", leaked, denied.frames, /no completed command or tool item's output holds the marker/);
  // The marker streamed as an output delta while the item was open, and a settling upsert that sets only the status: the reducer keeps the streamed output.
  const opening = denied.run.events.indexOf(commandItem);
  const streamed: ScenarioRun = {
    ...denied.run,
    events: [
      ...denied.run.events.slice(0, opening + 1),
      { ...commandItem, body: { type: "item.delta", itemId: commandItemId, field: "output", chunk: `${SCENARIOS[3]!.marker!}\n` } },
      ...denied.run.events.slice(opening + 1).filter((event) => !(event.body.type === "item.upsert" && event.body.item.id === commandItemId)),
      { ...commandItem, body: { type: "item.upsert", item: { id: commandItemId, status: "completed" } } },
    ],
  };
  const reduced = settledItems(streamed.events).find((entry) => entry.item.id === commandItemId)!.item;
  assert.equal(reduced.status, "completed");
  assert.equal(reduced.output, `${SCENARIOS[3]!.marker!}\n`, "the ARI reducer appends the streamed output");
  reject("approval_denied", streamed, denied.frames, /no completed command or tool item's output holds the marker/);
  // An assistant message whose text only streamed still counts as text, as a host shows it.
  const simpleText = simple.run.events.find((event) => event.body.type === "item.upsert" && event.body.item.kind === "assistant_message")!;
  const simpleTextId = (simpleText.body as { item: { id: string } }).item.id;
  const deltasOnly: ScenarioRun = {
    ...simple.run,
    events: simple.run.events.map((event) =>
      event.body.type === "item.upsert" && event.body.item.id === simpleTextId ? { ...event, body: { ...event.body, item: { ...event.body.item, text: undefined } as typeof event.body.item } } : event,
    ),
  };
  assert.ok(simple.run.events.some((event) => event.body.type === "item.delta" && event.body.itemId === simpleTextId), "the fake streams its text");
  checkScenario(deltasOnly, claudeNativeAnswers(simple.frames));
  const interrupt = runs.get("interrupt")!;
  reject("interrupt", withTerminal(interrupt.run, "completed"), interrupt.frames, /the turn ended interrupted/);
  const { interrupted: _interrupted, ...notInterrupted } = interrupt.run;
  reject("interrupt", notInterrupted, interrupt.frames, /the host interrupted the turn after its first assistant text/);
  const resume = runs.get("resume")!;
  reject("resume", { ...resume.run, events: [...resume.run.events, { ...resume.run.events.at(-1)!, body: { type: "session.replaced", reason: "test", contextLost: true } }] }, resume.frames, /no session\.replaced/);
  reject("resume", { ...resume.run, sessionIds: resume.run.sessionIds.slice(0, 1) }, resume.frames, /resumed in a second session/);
});

for (const [recordedAs, replayedAs] of [
  ["user", "root"],
  ["root", "user"],
] as const) {
  test(`recordings made on an account named ${recordedAs} keep the SDK's protocol words and replay on an account named ${replayedAs}`, async () => {
    const home = fs.mkdtempSync(path.join(DIRECTORY, `home-${recordedAs}-`));
    const outcomes = await recordClaude({
      outDir: path.join(DIRECTORY, `account-${recordedAs}`),
      source: "fake",
      env: { HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin", USER: recordedAs, LOGNAME: recordedAs },
      user: recordedAs,
      loadSdk: async (scenario) => puppetRuntime(startPuppet(scenario)),
      timeoutMs: 20_000,
    });
    for (const outcome of outcomes) {
      assert.equal(outcome.error, undefined, `${outcome.scenario}: ${outcome.error?.message}`);
      const text = fs.readFileSync(outcome.file!, "utf8");
      assert.ok(text.includes('"role":"user"') && text.includes('"type":"user"') && text.includes('"type":"assistant"'), `${outcome.scenario}: the protocol words are intact`);
      assert.ok(!text.includes('"<USER>"'), `${outcome.scenario}: no whole value became the user placeholder`);
      await replayClaude(outcome.file!, { user: replayedAs, env: { ...process.env, USER: replayedAs, LOGNAME: replayedAs } });
    }
  });
}

test("what Claude Code writes to stderr is recorded as an inbound frame and handed to the driver's stderr callback on replay", async () => {
  const home = fs.mkdtempSync(path.join(DIRECTORY, "home-stderr-"));
  const line = "claude-code: a warning on stderr\n";
  const [outcome] = await recordClaude({
    scenarios: ["simple"],
    outDir: path.join(DIRECTORY, "stderr"),
    source: "fake",
    env: { HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    loadSdk: async (scenario) =>
      puppetRuntime(
        startPuppet(scenario, {
          onTurn: (_turn, _index, world) => {
            const stderr = world.queries.at(-1)!.options.stderr;
            assert.ok(stderr !== undefined, "the driver gives Claude Code a stderr callback");
            stderr(line);
          },
        }),
      ),
    timeoutMs: 20_000,
  });
  assert.equal(outcome!.error, undefined, outcome!.error?.message);
  const recording = await readRecording(outcome!.file!);
  assert.deepEqual(
    recording.frames.filter((entry) => entry.frame.kind === "stderr").map((entry) => entry.frame),
    [{ dir: "in", kind: "stderr", query: "q1", data: line }],
  );
  const { diagnostics } = await replayClaude(recording);
  assert.ok(
    diagnostics.some((entry) => entry.msg === "claude: claude-code: a warning on stderr"),
    `the driver logged the replayed stderr line: ${JSON.stringify(diagnostics.map((entry) => entry.msg))}`,
  );
});

// Drift.

function assertDrift(error: unknown, file: string, line: number, parts: RegExp[]): true {
  assert.ok(error instanceof Error, String(error));
  assert.ok(error.message.startsWith(`${file}:${line}: `), `the error names ${file}:${line}: ${error.message.slice(0, 300)}`);
  for (const part of parts) assert.match(error.message, part);
  return true;
}

for (const name of SCENARIO_NAMES) {
  test(`${name}: replay fails, naming the file, the line and both frames, when the driver sends an outbound frame other than the next recorded one`, async () => {
    const recording = await recordingOf(name);
    const index = recording.frames.findIndex((entry) => entry.frame.kind === "prompt");
    const { file } = editedCopy(recording, "changed-prompt", (frames) => {
      const message = frames[index]!["message"] as { message: { content: Array<{ text: string }> } };
      message.message.content[0]!.text = "Reply with a word the driver never sends";
    });
    const line = recording.frames[index]!.line;
    await assert.rejects(replayClaude(file, { timeoutMs: 10_000 }), (error: unknown) => {
      assert.ok(error instanceof ReplayDriftError, String(error));
      assert.equal(error.line, line);
      return assertDrift(error, file, line, [
        /replay drift: the driver sent a frame other than the next recorded one/,
        /first difference at message\.message\.content\.0\.text/,
        new RegExp(`recorded \\(line ${line}\\): .*a word the driver never sends`),
        new RegExp(`sent: .*${escape(SCENARIOS.find((each) => each.name === name)!.prompts[0]!.slice(0, 30))}`),
      ]);
    });
  });

  test(`${name}: replay fails, naming the file, the line and both frames, when the scenario ends with recorded frames left`, async () => {
    const recording = await recordingOf(name);
    const extra: Frame = { dir: "out", kind: "call", id: 999, query: "q1", method: "interrupt", args: [] };
    const { file } = editedCopy(recording, "appended", (frames) => frames.push(extra));
    const line = recording.frames.at(-1)!.line + 1;
    await assert.rejects(replayClaude(file, { timeoutMs: 10_000 }), (error: unknown) =>
      assertDrift(error, file, line, [
        /replay drift: the scenario ended with 1 recorded frame\(s\) not replayed/,
        new RegExp(`next recorded \\(line ${line}\\): \\{"dir":"out","kind":"call","id":999`),
        new RegExp(`last replayed \\(line ${line - 1}\\): \\{"dir":"in","kind":"end"`),
      ]),
    );
  });

  test(`${name}: replay fails, naming the file, the line and both frames, when a recorded inbound frame is removed`, async () => {
    const recording = await recordingOf(name);
    // The result message that ends the first turn: without it the turn never ends.
    const index = recording.frames.findIndex((entry) => entry.frame.kind === "message" && (entry.frame["message"] as { type: string }).type === "result");
    const removed = recording.frames[index]!;
    const { file } = editedCopy(recording, "removed-result", (frames) => frames.splice(index, 1));
    await assert.rejects(replayClaude(file, { timeoutMs: 5_000 }), (error: unknown) => {
      assert.ok(error instanceof Error, String(error));
      const match = new RegExp(`^${escape(file)}:(\\d+): replay stalled: the ${name} scenario waited 5000 ms for turn\\.terminal`).exec(error.message);
      assert.ok(match !== null, error.message.slice(0, 400));
      // The copy lost one line, so the frame after the removed one now sits on its line.
      assert.equal(Number(match[1]), removed.line, error.message.slice(0, 400));
      assert.match(error.message, new RegExp(`next recorded \\(line ${removed.line}\\): \\{"dir":"out"`));
      assert.match(error.message, new RegExp(`last replayed \\(line ${removed.line - 1}\\): \\{"dir":"in"`));
      return true;
    });
  });
}

for (const name of SCENARIO_NAMES) {
  for (const [label, extra] of [
    ["an extra end of the stream", (query: string): Frame => ({ dir: "in", kind: "end", query })],
    ["an extra message", (query: string): Frame => ({ dir: "in", kind: "message", query, message: { type: "system", subtype: "status", status: null, uuid: "00000000-0000-4000-8000-0000000000ff", session_id: "a11ce000-0000-4000-8000-000000000001" } })],
  ] as const) {
    test(`${name}: replay fails, naming the file, the line and the frame, when the recording holds ${label} the driver never takes`, async () => {
      const recording = await recordingOf(name);
      const lastQuery = String(recording.frames.at(-1)!.frame["query"]);
      const frame = extra(lastQuery);
      const { file } = editedCopy(recording, label.replace(/ /g, "-"), (frames) => frames.push(frame));
      const line = recording.frames.at(-1)!.line + 1;
      await assert.rejects(replayClaude(file, { timeoutMs: 10_000 }), (error: unknown) =>
        assertDrift(error, file, line, [
          /replay drift: the scenario ended with 1 recorded inbound frame\(s\) the driver never took/,
          new RegExp(`not taken \\(line ${line}\\): ${escape(JSON.stringify(frame))}`),
          // The last frame the driver did take: the stream's real end, on the line before.
          new RegExp(`last taken by the driver \\(line ${line - 1}\\): ${escape(JSON.stringify(recording.frames.at(-1)!.frame))}`),
        ]),
      );
    });
  }
}

test("at the replay SDK, a query the driver starts but never reads leaves its recorded message and end untaken, and finish names them", async () => {
  const frames: Frame[] = [
    { dir: "out", kind: "query", query: "q1", prompt: "stream", options: {} },
    { dir: "in", kind: "message", query: "q1", message: { type: "system", subtype: "init", uuid: "00000000-0000-4000-8000-000000000001", session_id: "s" } },
    { dir: "in", kind: "end", query: "q1" },
  ];
  const metadata: RecordingMetadata = { driver: "claude", vendor: "claude-code", vendorVersion: "2.1.330", sdk: "@anthropic-ai/claude-agent-sdk", sdkVersion: "0.3.330", model: "haiku", scenario: "simple", recorded: "2026-11-24", source: "fake" };
  const file = path.join(DIRECTORY, "copies", "never-read.ndjson");
  const recording = parseRecording(encodeRecording(metadata, frames), file);
  const noPrompts = async function* (): AsyncGenerator<never> {};
  for (const reads of [0, 1]) {
    const replay = createClaudeReplaySdk(recording, { workspace: DIRECTORY, sanitise: createSanitiser({ workspace: DIRECTORY, env: {} }) });
    const query = replay.sdk.query({ prompt: noPrompts(), options: {} });
    for (let index = 0; index < reads; index += 1) assert.equal((await query.next()).done, false);
    assert.equal(await replay.sequencer.whenTaken(100), false);
    assert.equal(replay.sequencer.done(), false);
    const line = 3 + reads;
    assert.throws(
      () => replay.sequencer.finish(),
      (error: unknown) =>
        assertDrift(error, file, line, [
          /the driver never took/,
          new RegExp(`not taken \\(line ${line}\\): ${escape(JSON.stringify(frames[line - 2]))}`),
          reads === 0 ? /last taken by the driver \(line none\): \(none\)/ : new RegExp(`last taken by the driver \\(line 3\\): ${escape(JSON.stringify(frames[1]))}`),
        ]),
    );
  }
  // A driver that reads to the end takes everything.
  const replay = createClaudeReplaySdk(recording, { workspace: DIRECTORY, sanitise: createSanitiser({ workspace: DIRECTORY, env: {} }) });
  const query = replay.sdk.query({ prompt: noPrompts(), options: {} });
  assert.equal((await query.next()).done, false);
  assert.equal((await query.next()).done, true);
  assert.equal((await query.next()).done, true, "the stream gives nothing after its end");
  assert.equal(await replay.sequencer.whenTaken(100), true);
  replay.sequencer.finish();
  assert.equal(replay.sequencer.done(), true);
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("replay leaves out exactly the ignored fields: a change to one passes, a change to its neighbour fails", async () => {
  assert.deepEqual(
    CLAUDE_IGNORED_FIELDS.map((entry) => `${entry.kind} ${entry.field}`),
    ["query options.env.CLAUDE_AGENT_SDK_CLIENT_APP", "query options.env.ANTHROPIC_API_KEY"],
  );
  const recording = await recordingOf("simple");
  const index = recording.frames.findIndex((entry) => entry.frame.kind === "query");
  const env = (frames: Frame[]): { [name: string]: string } => (frames[index]!["options"] as { env: { [name: string]: string } }).env;
  const ignored = editedCopy(recording, "client-app", (frames) => {
    env(frames)["CLAUDE_AGENT_SDK_CLIENT_APP"] = "ari/99.0.0";
    env(frames)["ANTHROPIC_API_KEY"] = "<ANTHROPIC_API_KEY>";
  });
  await replayClaude(ignored.file);
  const neighbour = editedCopy(recording, "auto-memory", (frames) => {
    env(frames)["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "0";
  });
  await assert.rejects(replayClaude(neighbour.file), /first difference at options\.env\.CLAUDE_CODE_DISABLE_AUTO_MEMORY: recorded "0", sent "1"/);
});
