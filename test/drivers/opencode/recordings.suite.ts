// The OpenCode recorder and replay, end to end against the fake OpenCode 2.x
// server. The recording function scripts/record-opencode.ts calls records all
// six scenarios through the recording proxy, with the driver in
// external-server mode (source `fake`); each recording holds every request,
// response and server-sent event, in order; each replays through a fresh
// driver against the replay server with every scenario assertion passing.
// Replay fails loudly, naming the file, the line and both frames, when a
// request differs, when recorded frames are left over or never taken, and
// when a recorded inbound frame is missing.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { scanRecordingText } from "../../../scripts/check-recordings.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { encodeRecording, readRecording } from "../../recordings/format.ts";
import type { Frame, Recording } from "../../recordings/format.ts";
import { OPENCODE_IGNORED_FIELDS, opencodeNativeAnswers } from "../../recordings/opencode/frames.ts";
import { OPENCODE_PROTOCOL_WORDS } from "../../recordings/opencode/protocol-words.ts";
import { recordOpencode } from "../../recordings/opencode/record.ts";
import type { OpencodeRecordOutcome } from "../../recordings/opencode/record.ts";
import { startRecordingProxy } from "../../recordings/opencode/proxy.ts";
import { replayOpencode } from "../../recordings/opencode/replay.ts";
import { startTurnAfterItsText } from "../../recordings/late-start-turn.ts";
import { FRAME_FORMAT_FIELDS } from "../../recordings/sanitiser.ts";
import { SCENARIOS, SCENARIO_NAMES, checkScenario } from "../../recordings/scenarios.ts";
import type { ScenarioName } from "../../recordings/scenarios.ts";
import { ReplayDriftError, showFrame } from "../../recordings/sequencer.ts";
import { fakeOpencodeServers } from "./puppets.ts";
import type { FakeOpencodeServer, OpencodePuppetOptions } from "./puppets.ts";

const DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), "ari-opencode-recordings-"));
process.on("exit", () => fs.rmSync(DIRECTORY, { recursive: true, force: true }));

const MODEL = "fake/fake-small";

interface Recorded {
  readonly outcomes: OpencodeRecordOutcome[];
  readonly servers: FakeOpencodeServer[];
}

/** Records `scenarios` from fresh fake servers through the recording function, with the recorder's environment `env`. */
async function recordFake(label: string, env: { [name: string]: string | undefined }, scenarios: readonly ScenarioName[] = SCENARIO_NAMES, puppet: OpencodePuppetOptions = {}, user?: string): Promise<Recorded> {
  const servers: FakeOpencodeServer[] = [];
  const outcomes = await recordOpencode({
    scenarios,
    outDir: path.join(DIRECTORY, label),
    source: "fake",
    env: { ARI_RECORD_OPENCODE_MODEL: MODEL, PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env },
    startServer: fakeOpencodeServers(servers, puppet),
    timeoutMs: 20_000,
    ...(user === undefined ? {} : { user }),
  });
  return { outcomes, servers };
}

let recorded: Promise<Recorded> | undefined;

/** Records all six scenarios from the fake once for this file. */
function recordAll(): Promise<Recorded> {
  recorded ??= recordFake("recordings", { HOME: fs.mkdtempSync(path.join(DIRECTORY, "home-")), USER: "ari-test-user" });
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

/**
 * `frames` with each HTTP answer in the run of inbound frames around
 * `index` moved to the run's start or to its end, the events keeping their
 * order. The server sends its answers and its events over different
 * connections, so a recording can hold them in either order; a test that
 * depends on the order fixes it with this.
 */
function withAnswers(frames: readonly Frame[], index: number, where: "first" | "last"): Frame[] {
  let start = index;
  while (start > 0 && frames[start - 1]!.dir === "in") start -= 1;
  let end = index;
  while (end + 1 < frames.length && frames[end + 1]!.dir === "in") end += 1;
  const run = frames.slice(start, end + 1);
  const answers = run.filter((frame) => frame.kind === "response" && frame["stream"] !== true);
  const events = run.filter((frame) => !answers.includes(frame));
  return [...frames.slice(0, start), ...(where === "first" ? [...answers, ...events] : [...events, ...answers]), ...frames.slice(end + 1)];
}

const framesOf = (recording: Recording, kind: string): Frame[] => recording.frames.filter((entry) => entry.frame.kind === kind).map((entry) => entry.frame);

test("the OpenCode recording function records all six scenarios from the fake 2.x server, through the recording proxy, each to its own file with source fake", async () => {
  const { outcomes, servers } = await recordAll();
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
      { driver: "opencode", vendor: "opencode", vendorVersion: "2.1.2", sdk: "@opencode/client", sdkVersion: "2.1.2", model: MODEL, scenario: outcome.scenario, source: "fake" },
    );
    assert.match(recording.header.recorded, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(outcome.frames, recording.frames.length);
    assert.ok(!fs.existsSync(outcome.workspace), `${outcome.scenario}: the temp workspace is gone`);
  }
  assert.equal(servers.length, 6, "one fake server per scenario");
  for (const { world, puppet } of servers) {
    assert.deepEqual([...new Set(world.violations)], [], "the fake saw only frames that match the pinned schemas");
    assert.equal(puppet.failure(), undefined);
  }
});

test("each OpenCode recording holds every HTTP request (method, path, query, body), its response (status, body) and every server-sent event, in the order the server sent them", async () => {
  const { outcomes, servers } = await recordAll();
  for (const [index, name] of SCENARIO_NAMES.entries()) {
    const recording = await recordingOf(name);
    const world = servers[index]!.world;
    // The fake's own log of what it received and sent, from its side of the proxy, with the workspace as the recording names it.
    const workspace = outcomes[index]!.workspace;
    const asRecorded = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll(workspace, "<WORKSPACE>")) as unknown;
    const requests = framesOf(recording, "request");
    const allReceived = world.frames.filter((frame) => frame.direction === "request").map((frame) => frame.body as { path: string; query: { [name: string]: string }; body: unknown });
    // The recorder asked the server itself first, not through the proxy: its version, and the models it offers.
    assert.deepEqual(
      allReceived.slice(0, 2).map((frame) => asRecorded({ path: frame.path, query: frame.query })),
      [
        { path: "/api/info", query: {} },
        { path: "/api/model", query: { "location[directory]": "<WORKSPACE>/cwd" } },
      ],
    );
    const received = allReceived.slice(2);
    assert.deepEqual(
      requests.map((frame) => asRecorded({ path: frame["path"], query: frame["query"], body: frame["body"] })),
      received.map((frame) => asRecorded({ path: frame.path, query: frame.query, body: frame.body })),
      `${name}: every request the fake received, in order`,
    );
    for (const frame of requests) assert.ok(typeof frame["method"] === "string" && typeof frame["path"] === "string" && typeof frame["query"] === "object", `${name}: ${JSON.stringify(frame)}`);
    const answers = framesOf(recording, "response").filter((frame) => frame["stream"] !== true);
    const sent = world.frames.filter((frame) => frame.direction === "response").slice(2);
    assert.deepEqual(
      answers.map((frame) => asRecorded({ status: frame["status"], body: frame["body"] })),
      sent.map((frame) => asRecorded({ status: frame.status, body: frame.body })),
      `${name}: every response the fake sent, in order`,
    );
    const events = framesOf(recording, "event").map((frame) => frame["event"] as { id: string; type: string });
    assert.deepEqual(
      events.filter((event) => event.type !== "server.connected").map((event) => event.id),
      world.frames.filter((frame) => frame.direction === "event").map((frame) => (frame.body as { id: string }).id),
      `${name}: every event the fake published, in order`,
    );
    // Each exchange: a request, then its one answer; a stream's events between its response and its close.
    const seen = new Map<number, string[]>();
    for (const { frame } of recording.frames) {
      const id = Number(frame["id"]);
      const before = seen.get(id) ?? [];
      if (frame.kind === "request") assert.deepEqual(before, [], `${name}: exchange ${id} starts with its request`);
      else assert.equal(before[0], "request", `${name}: exchange ${id} has its request before its ${frame.kind}`);
      if (frame.kind === "event") assert.ok(before.includes("response"), `${name}: exchange ${id} streams after its response`);
      assert.ok(!before.includes("close") && !before.includes("end"), `${name}: nothing of exchange ${id} follows its end`);
      seen.set(id, [...before, frame.kind]);
    }
    for (const [id, kinds] of seen) {
      assert.ok(kinds.includes("response") || kinds.includes("dropped") || kinds.includes("close"), `${name}: exchange ${id} has an answer`);
      assert.equal(kinds.filter((kind) => kind === "response").length, 1, `${name}: exchange ${id} has one response`);
    }
    const streams = requests.filter((frame) => frame["path"] === "/api/event").map((frame) => Number(frame["id"]));
    assert.deepEqual(
      streams.map((id) => seen.get(id)!.at(-1)),
      streams.map(() => "close"),
      `${name}: the driver closed each event stream it opened, and the recording says so`,
    );
    const paths = requests.map((frame) => `${String(frame["method"])} ${String(frame["path"]).replace(/ses_[0-9a-z]+/g, "{session}").replace(/per_[0-9a-z]+/g, "{request}")}`);
    const prompts = requests.filter((frame) => /\/prompt$/.test(String(frame["path"]))).map((frame) => (frame["body"] as { text: string }).text);
    assert.deepEqual(prompts, [...SCENARIOS.find((scenario) => scenario.name === name)!.prompts], `${name}: every prompt the driver sent, in order`);
    assert.ok(paths.includes("GET /api/info") && paths.includes("POST /api/session") && paths.includes("GET /api/event"), `${name}: ${paths.join(", ")}`);
    if (name === "approval_allowed" || name === "approval_denied") {
      assert.ok(paths.includes("POST /api/session/{session}/permission/{request}/reply"), `${name}: ${paths.join(", ")}`);
      assert.ok(events.some((event) => event.type === "permission.asked"));
      assert.deepEqual(
        opencodeNativeAnswers(recording.frames).map((answer) => answer.decision),
        [name === "approval_allowed" ? "accept" : "decline"],
      );
    }
    if (name === "interrupt") assert.ok(paths.includes("POST /api/session/{session}/interrupt") && events.some((event) => event.type === "session.execution.interrupted"), name);
    if (name === "resume") assert.ok(streams.length === 2 && paths.includes("GET /api/session/{session}"), `${name}: two sessions, two streams, and the resume's read of the session: ${paths.join(", ")}`);
  }
});

for (const name of SCENARIO_NAMES) {
  test(`${name}: the OpenCode recording replays through a fresh driver against the replay server, and every scenario assertion holds`, async () => {
    const recording = await recordingOf(name);
    const { run, replay } = await replayOpencode(recording);
    assert.ok(replay.sequencer.done());
    assert.equal(replay.sequencer.matchedOutbound().length, recording.frames.filter((entry) => entry.frame.dir === "out").length);
    assert.equal(run.scenario.name, name);
  });
}

test("interrupt: when the turn's text reaches the host before startTurn resolves, the host still interrupts at the turn's first text and the OpenCode replay passes", async () => {
  const recording = await recordingOf("interrupt");
  const { run, replay } = await replayOpencode(recording, { timeoutMs: 5_000, wrapSession: startTurnAfterItsText });
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

test("the OpenCode replay server imports neither driver code nor the fake server, directly or through other modules, type-only imports included", () => {
  // The walk finds driver code and the fake where they are.
  const runner = reachedFrom("test/recordings/opencode/run.ts");
  assert.ok(runner.includes("src/drivers/opencode/index.ts"), runner.join(", "));
  const puppets = reachedFrom("test/drivers/opencode/puppets.ts");
  assert.ok(puppets.includes("test/drivers/opencode/fake-opencode.ts"), puppets.join(", "));
  const reached = reachedFrom("test/recordings/opencode/replay-server.ts");
  assert.ok(reached.length > 3, reached.join(", "));
  assert.deepEqual(
    reached.filter((file) => file.startsWith("src/drivers/") || file.startsWith("test/drivers/")),
    [],
  );
});

// Drift.

function assertDrift(error: unknown, file: string, line: number, parts: RegExp[]): true {
  assert.ok(error instanceof Error, String(error));
  assert.ok(error.message.startsWith(`${file}:${line}: `), `the error names ${file}:${line}: ${error.message.slice(0, 400)}`);
  for (const part of parts) assert.match(error.message, part);
  return true;
}

for (const name of SCENARIO_NAMES) {
  test(`${name}: OpenCode replay fails, naming the file, the line and both frames, when the driver sends a request other than the next recorded one`, async () => {
    const recording = await recordingOf(name);
    const index = recording.frames.findIndex((entry) => entry.frame.kind === "request" && /\/prompt$/.test(String(entry.frame["path"])));
    const { file } = editedCopy(recording, "changed-prompt", (frames) => {
      (frames[index]!["body"] as { text: string }).text = "Reply with a word the driver never sends";
    });
    const line = recording.frames[index]!.line;
    await assert.rejects(replayOpencode(file, { timeoutMs: 10_000 }), (error: unknown) => {
      assert.ok(error instanceof ReplayDriftError, String(error));
      assert.equal(error.line, line);
      return assertDrift(error, file, line, [
        /replay drift: the driver sent a frame other than the next recorded one/,
        /first difference at body\.text/,
        new RegExp(`recorded \\(line ${line}\\): .*a word the driver never sends`),
        new RegExp(`sent: .*${escape(SCENARIOS.find((each) => each.name === name)!.prompts[0]!.slice(0, 30))}`),
      ]);
    });
  });

  test(`${name}: OpenCode replay fails, naming the file, the line and both frames, when the scenario ends with recorded frames left`, async () => {
    const recording = await recordingOf(name);
    const extra: Frame = { dir: "out", kind: "request", id: 999, method: "POST", path: "/api/session/ses_never/interrupt", query: {} };
    const { file } = editedCopy(recording, "appended", (frames) => frames.push(extra));
    const line = recording.frames.at(-1)!.line + 1;
    await assert.rejects(replayOpencode(file, { timeoutMs: 10_000 }), (error: unknown) =>
      assertDrift(error, file, line, [
        /replay drift: the scenario ended with 1 recorded frame\(s\) not replayed/,
        new RegExp(`next recorded \\(line ${line}\\): \\{"dir":"out","kind":"request","id":999`),
        new RegExp(`last replayed \\(line ${line - 1}\\): \\{"dir":"out","kind":"close"`),
      ]),
    );
  });

  test(`${name}: OpenCode replay fails, naming the file, the line and both frames, when a recorded inbound frame is removed, whichever order the HTTP answers and the events around it hold`, async () => {
    const recording = await recordingOf(name);
    // The event that ends the first turn's execution: without it the turn never ends.
    const terminal = recording.frames.find((entry) => entry.frame.kind === "event" && /^session\.execution\.(succeeded|failed|interrupted)$/.test(String((entry.frame["event"] as { type: string }).type)))!.frame;
    const original = recording.frames.map((entry) => entry.frame);
    const removals = (["first", "last"] as const).map(async (where) => {
      // The HTTP answer around the terminal event comes first, or last: both orders are recordings the server can produce.
      const ordered = withAnswers(original, original.indexOf(terminal), where);
      const whole = editedCopy(recording, `answers-${where}`, (frames) => frames.splice(0, frames.length, ...structuredClone(ordered)));
      await replayOpencode(whole.file);
      const gap = ordered.indexOf(terminal);
      const { file } = editedCopy(recording, `answers-${where}-removed-terminal`, (frames) => frames.splice(0, frames.length, ...structuredClone(ordered.filter((frame) => frame !== terminal))));
      // Replay delivers every inbound frame after the gap, then waits at the next outbound frame for a driver that waits for the missing event.
      const copy = await readRecording(file);
      const stall = copy.frames.findIndex((entry, position) => position >= gap && entry.frame.dir === "out");
      const next = copy.frames[stall]!;
      const last = copy.frames[stall - 1]!;
      assert.equal(last.frame.dir, "in", `answers ${where}: replay delivered the frames after the gap`);
      await assert.rejects(replayOpencode(file, { timeoutMs: 4_000 }), (error: unknown) => {
        assert.ok(error instanceof Error, String(error));
        const shown = error.message.slice(0, 1200);
        assert.ok(error.message.startsWith(`${file}:${next.line}: replay stalled: the ${name} scenario waited 4000 ms for turn.terminal`), `answers ${where}: ${shown}`);
        assert.ok(error.message.includes(`\n  next recorded (line ${next.line}): ${showFrame(next.frame)}\n`), `answers ${where}: ${shown}`);
        assert.ok(error.message.includes(`\n  last replayed (line ${last.line}): ${showFrame(last.frame)}`), `answers ${where}: ${shown}`);
        return true;
      });
    });
    await Promise.all(removals);
  });

  for (const [label, extra] of [
    ["an extra event on a stream the driver closed", (id: number): Frame => ({ dir: "in", kind: "event", id, event: { id: "evt_extra", type: "server.heartbeat", data: {} } })],
    ["an extra end of a stream the driver closed", (id: number): Frame => ({ dir: "in", kind: "end", id })],
  ] as const) {
    test(`${name}: OpenCode replay fails, naming the file, the line and the frame, when the recording holds ${label}, which the driver never takes`, async () => {
      const recording = await recordingOf(name);
      const close = recording.frames.at(-1)!;
      assert.equal(close.frame.kind, "close", "a recording ends with the driver closing its last event stream");
      const frame = extra(Number(close.frame["id"]));
      const { file } = editedCopy(recording, label.replace(/ /g, "-"), (frames) => frames.push(frame));
      const line = close.line + 1;
      const lastInbound = recording.frames.findLast((entry) => entry.frame.dir === "in")!;
      await assert.rejects(replayOpencode(file, { timeoutMs: 10_000 }), (error: unknown) =>
        assertDrift(error, file, line, [
          /replay drift: the scenario ended with 1 recorded inbound frame\(s\) the driver never took/,
          new RegExp(`not taken \\(line ${line}\\): ${escape(JSON.stringify(frame))}`),
          new RegExp(`last taken by the driver \\(line ${lastInbound.line}\\): ${escape(JSON.stringify(lastInbound.frame))}`),
        ]),
      );
    });
  }
}

test("OpenCode replay fails, naming the file, the line and both frames around the gap, when a recording holds the response to a request it lacks, whichever order that response and the events after it hold", async () => {
  const recording = await recordingOf("simple");
  const original = recording.frames.map((entry) => entry.frame);
  const request = original.find((frame) => frame.kind === "request" && frame["path"] === "/api/session")!;
  for (const where of ["first", "last"] as const) {
    // The session's answer comes before the session.created event, or after it: the server can send either.
    const ordered = withAnswers(original, original.indexOf(request) + 1, where);
    const gap = ordered.indexOf(request);
    const { file } = editedCopy(recording, `answers-${where}-skipped-request`, (frames) => frames.splice(0, frames.length, ...structuredClone(ordered.filter((frame) => frame !== request))));
    // Replay delivers the inbound frames after the gap until it meets the answer to the request the tape lacks.
    const copy = await readRecording(file);
    const orphan = copy.frames.findIndex((entry, position) => position >= gap && entry.frame.kind === "response" && entry.frame["id"] === request["id"]);
    assert.ok(copy.frames.slice(gap, orphan).every((entry) => entry.frame.dir === "in"), `answers ${where}: only inbound frames lie between the gap and the orphaned answer`);
    const answer = copy.frames[orphan]!;
    const last = copy.frames[orphan - 1]!;
    await assert.rejects(replayOpencode(file, { timeoutMs: 10_000 }), (error: unknown) =>
      assertDrift(error, file, answer.line, [
        new RegExp(`replay could not deliver the recorded frame: the frame answers exchange ${String(request["id"])}, which the driver has not started`),
        new RegExp(`\\n  recorded \\(line ${answer.line}\\): ${escape(showFrame(answer.frame))}\\n`),
        new RegExp(`\\n  last replayed \\(line ${last.line}\\): ${escape(showFrame(last.frame))}$`),
      ]),
    );
  }
});

test("approval_allowed: OpenCode replay fails when the event with the command's result is removed: the command's output never reaches the host", async () => {
  const recording = await recordingOf("approval_allowed");
  const index = recording.frames.findIndex((entry) => entry.frame.kind === "event" && (entry.frame["event"] as { type: string }).type === "session.tool.success");
  assert.ok(index !== -1, "the recording holds the command's result");
  const { file } = editedCopy(recording, "removed-tool-success", (frames) => frames.splice(index, 1));
  await assert.rejects(replayOpencode(file, { timeoutMs: 10_000 }), /scenario approval_allowed: a command or tool item completed with the marker in its output/);
});

test("OpenCode replay ignores no field: a change to a request's query or body fails, and the code's list is empty", async () => {
  assert.deepEqual(OPENCODE_IGNORED_FIELDS, []);
  const recording = await recordingOf("simple");
  const models = recording.frames.findIndex((entry) => entry.frame.kind === "request" && entry.frame["path"] === "/api/model");
  const query = editedCopy(recording, "model-query", (frames) => {
    (frames[models]!["query"] as { [name: string]: string })["location[directory]"] = "<WORKSPACE>/elsewhere";
  });
  await assert.rejects(replayOpencode(query.file), /first difference at query\.location\[directory\]: recorded "<WORKSPACE>\/elsewhere", sent ""/);
  const create = recording.frames.findIndex((entry) => entry.frame.kind === "request" && entry.frame["path"] === "/api/session");
  const body = editedCopy(recording, "create-rules", (frames) => {
    (frames[create]!["body"] as { permissions: Array<{ effect: string }> }).permissions[0]!.effect = "allow";
  });
  await assert.rejects(replayOpencode(body.file), /first difference at body\.permissions\.0\.effect: recorded "allow", sent "ask"/);
  const method = editedCopy(recording, "method", (frames) => {
    frames[create] = { ...frames[create]!, method: "PUT" };
  });
  await assert.rejects(replayOpencode(method.file), /first difference at method: recorded "PUT", sent "POST"/);
});

test("the scenario checks read the approval answers off the recorded reply requests", async () => {
  for (const name of ["approval_allowed", "approval_denied"] as const) {
    const recording = await recordingOf(name);
    const { run } = await replayOpencode(recording);
    const frames = recording.frames.map((entry) => entry.frame);
    checkScenario(run, opencodeNativeAnswers(frames));
    const withoutReply = frames.filter((frame) => !(frame.kind === "request" && /\/permission\/[^/]+\/reply$/.test(String(frame["path"]))));
    assert.throws(() => checkScenario(run, opencodeNativeAnswers(withoutReply)), name === "approval_allowed" ? /allow-once answer reached the native side/ : /decline answer reached the native side/);
    const flipped = frames.map((frame) => (frame.kind === "request" && /\/permission\/[^/]+\/reply$/.test(String(frame["path"])) ? { ...frame, body: { decision: name === "approval_allowed" ? "always" : "once" } } : frame));
    assert.throws(() => checkScenario(run, opencodeNativeAnswers(flipped)), /reached the native side as a recorded outbound frame/);
  }
});

for (const [recordedAs, replayedAs] of [
  ["user", "text"],
  ["text", "user"],
] as const) {
  test(`OpenCode recordings made on an account named ${recordedAs} keep the protocol words and replay on an account named ${replayedAs}`, async () => {
    const home = fs.mkdtempSync(path.join(DIRECTORY, `home-${recordedAs}-`));
    const { outcomes } = await recordFake(`account-${recordedAs}`, { HOME: home, USER: recordedAs, LOGNAME: recordedAs }, SCENARIO_NAMES, {}, recordedAs);
    for (const outcome of outcomes) {
      assert.equal(outcome.error, undefined, `${outcome.scenario}: ${outcome.error?.message}`);
      const text = fs.readFileSync(outcome.file!, "utf8");
      assert.ok(text.includes('"type":"session.text.delta"') && text.includes('"type":"user"') && text.includes('"contentType":"text/event-stream"'), `${outcome.scenario}: the protocol words are intact`);
      // Outside the protocol words a value that is the account's name is free text and goes: on an account named text, the models' capability lists ["text"].
      const capabilities = /"(input|output)":\["<USER>"\]/g;
      if (recordedAs === "user") assert.doesNotMatch(text, capabilities);
      assert.ok(!text.replace(capabilities, "").includes('"<USER>"'), `${outcome.scenario}: no other whole value became the user placeholder`);
      await replayOpencode(outcome.file!, { user: replayedAs, env: { ...process.env, USER: replayedAs, LOGNAME: replayedAs } });
    }
  });
}

/** Every place in a recording where `name` is a whole word, other than a protocol word of its key or a frame's format field. */
function wholeWordsOf(name: string, frames: readonly Frame[]): string[] {
  const word = new RegExp(`(?<![A-Za-z0-9_])${escape(name)}(?![A-Za-z0-9_])`);
  const found: string[] = [];
  const walk = (value: unknown, key: string | undefined, at: string): void => {
    if (typeof value === "string") {
      if (key !== undefined && OPENCODE_PROTOCOL_WORDS[key]?.includes(value)) return;
      if (word.test(value)) found.push(`${at}: ${JSON.stringify(value)}`);
    } else if (Array.isArray(value)) value.forEach((each, index) => walk(each, key, `${at}[${index}]`));
    else if (typeof value === "object" && value !== null) for (const [field, entry] of Object.entries(value)) walk(entry, field, `${at}.${field}`);
  };
  frames.forEach((frame, index) => {
    for (const [field, entry] of Object.entries(frame)) if (!FRAME_FORMAT_FIELDS.has(field) || typeof entry === "object") walk(entry, field, `frame ${index + 2}.${field}`);
  });
  return found;
}

test("the OpenCode recorder sanitises what it writes: no workspace path, no HOME, no OS user name in command output or replies, and the scan passes", async () => {
  const osName = os.userInfo().username;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-opencode-sanitise-")));
  const listing = `drwx------ 2 ${osName} ${osName} 4096 Nov 24 12:00 ${home}/project\n`;
  try {
    const { outcomes } = await recordFake("sanitise", { HOME: home, USER: "ari-recorder-user" }, SCENARIO_NAMES, {
      reply: `${osName} said ok, from ${home}/notes and ari-recorder-user@example.org.`,
      commandOutput: `${listing}${SCENARIOS.find((scenario) => scenario.name === "approval_allowed")!.marker!}\n`,
    });
    for (const outcome of outcomes) {
      assert.equal(outcome.error, undefined, `${outcome.scenario}: ${outcome.error?.message}`);
      const text = fs.readFileSync(outcome.file!, "utf8");
      assert.ok(!text.includes(outcome.workspace), `${outcome.scenario}: the workspace path`);
      assert.ok(text.includes("<WORKSPACE>/cwd"), `${outcome.scenario}: the workspace placeholder`);
      assert.ok(!text.includes(home), `${outcome.scenario}: the HOME`);
      const frames = (await readRecording(outcome.file!)).frames.map((entry) => entry.frame);
      assert.deepEqual(wholeWordsOf(osName, frames), [], `${outcome.scenario}: the OS user name is nowhere in the recording but in protocol words`);
      assert.deepEqual(scanRecordingText(text, outcome.file!, { home }), [], outcome.scenario);
      if (outcome.scenario === "simple") assert.ok(text.includes("<USER> said ok, from <HOME>/notes and <EMAIL>."), "the reply, sanitised");
      if (outcome.scenario === "approval_allowed") assert.ok(text.includes("drwx------ 2 <USER> <USER> 4096"), "the command output, sanitised");
      await replayOpencode(outcome.file!);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a GEMINI_API_KEY of the recorder's environment that a tool prints is replaced in the OpenCode recording, and the recording replays", async () => {
  // A synthetic key in the shape of a Google API key; the scan's token patterns do not know it.
  const key = "AIzaSyAriSyntheticGeminiKeyForTests000";
  const marker = SCENARIOS.find((scenario) => scenario.name === "approval_allowed")!.marker!;
  const { outcomes } = await recordFake("gemini-key", { HOME: fs.mkdtempSync(path.join(DIRECTORY, "home-")), USER: "ari-test-user", GEMINI_API_KEY: key }, ["approval_allowed"], { commandOutput: `GEMINI_API_KEY=${key}\n${marker}\n` });
  const outcome = outcomes[0]!;
  assert.equal(outcome.error, undefined, outcome.error?.message);
  const text = fs.readFileSync(outcome.file!, "utf8");
  assert.ok(!text.includes(key), "the key's value is nowhere in the recording");
  assert.ok(text.includes("GEMINI_API_KEY=<GEMINI_API_KEY>"), "the command's output holds the placeholder");
  await replayOpencode(outcome.file!);
});

test("the recording proxy records and passes on the body the client reads when the server compresses its answer (the real OpenCode 2.1.2 gzips GET /api/model)", async () => {
  const catalog = { data: [{ providerID: "anthropic", modelID: "claude-haiku-5-5", name: "Claude Haiku 5.5", limit: { context: 200_000 } }] };
  const json = JSON.stringify(catalog);
  const encoders: { [path: string]: [string, (bytes: Buffer) => Buffer] } = {
    "/api/model": ["gzip", zlib.gzipSync],
    "/api/deflated": ["deflate", zlib.deflateSync],
    "/api/brotli": ["br", zlib.brotliCompressSync],
  };
  // The upstream compresses whatever the client accepts, as a server may.
  const upstream = http.createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
      response.end(zlib.gzipSync(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\ndata: ${json}\n\n`));
      return;
    }
    const [encoding, encode] = encoders[url.split("?")[0]!] ?? ["identity", (bytes: Buffer) => bytes];
    response.writeHead(200, { "content-type": "application/json", "content-encoding": encoding });
    response.end(encode(Buffer.from(json, "utf8")));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const frames: Frame[] = [];
  const proxy = await startRecordingProxy({ upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, record: (frame) => frames.push(frame) });
  /** One GET through the proxy, as a client that accepts every encoding: the raw bytes and headers the driver's connection carries. */
  const get = (route: string): Promise<{ headers: http.IncomingHttpHeaders; raw: string }> =>
    new Promise((resolve, reject) => {
      http.get(`${proxy.url}${route}`, { headers: { "accept-encoding": "gzip, deflate, br" } }, (answer) => {
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("end", () => resolve({ headers: answer.headers, raw: Buffer.concat(chunks).toString("utf8") }));
        answer.on("error", reject);
      }).on("error", reject);
    });
  try {
    for (const route of ["/api/model?location%5Bdirectory%5D=", "/api/deflated", "/api/brotli", "/api/plain"]) {
      const { headers, raw } = await get(route);
      assert.equal(headers["content-encoding"], undefined, `${route}: the driver gets no encoded body`);
      assert.deepEqual(JSON.parse(raw), catalog, `${route}: the driver reads the catalog`);
    }
    const events = await get("/api/event");
    assert.equal(events.headers["content-encoding"], undefined);
    assert.ok(events.raw.includes(`data: ${json}`), events.raw);
    const responses = frames.filter((frame) => frame.kind === "response" && frame["stream"] !== true);
    assert.equal(responses.length, 4);
    for (const frame of responses) assert.deepEqual(frame["body"], catalog, `the frame holds the decompressed body: ${JSON.stringify(frame).slice(0, 200)}`);
    assert.deepEqual(
      frames.filter((frame) => frame.kind === "event").map((frame) => frame["event"]),
      [{ type: "server.connected", data: {} }, catalog],
    );
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
