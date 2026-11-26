// The committed Codex tapes replay through a fresh driver without a CLI or credential.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scanRecordingText } from "../../../scripts/check-recordings.ts";
import type { SpawnRequest } from "../../../src/generated/host.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { CODEX_PROTOCOL_WORDS } from "../../recordings/codex/protocol-words.ts";
import { readPreAdmissionCodexCapture } from "../../recordings/codex/pre-admission.ts";
import { CODEX_SDK_NAME, CODEX_VENDOR_NAME, isCodexMarkerApproval } from "../../recordings/codex/record.ts";
import { replayCodex } from "../../recordings/codex/replay.ts";
import { CODEX_RECORDER_ENV_POLICY, createCodexLayout, runCodexScenario } from "../../recordings/codex/run.ts";
import { readRecording, sha256Hex } from "../../recordings/format.ts";
import { PLACEHOLDERS, createSanitiser } from "../../recordings/sanitiser.ts";
import { SCENARIO_NAMES, scenarioNamed } from "../../recordings/scenarios.ts";
import { ReplayDriftError } from "../../recordings/sequencer.ts";

const DIRECTORY = path.join(REPO_ROOT, "test", "drivers", "codex", "recordings");

test("the live Codex recordings cover exactly the scenarios in the shared scenario list", () => {
  assert.deepEqual(fs.readdirSync(DIRECTORY).sort(), SCENARIO_NAMES.map((name) => `${name}.ndjson`).sort());
});

for (const scenario of SCENARIO_NAMES) {
  test(`${scenario}: the live Codex 0.172.0 recording passes all scenario assertions on replay`, async () => {
    const file = path.join(DIRECTORY, `${scenario}.ndjson`);
    const recording = await readRecording(file); // Also checks the body checksum.
    const { header } = recording;
    assert.equal(header.driver, "codex");
    assert.equal(header.source, "live");
    assert.equal(header.scenario, scenario);
    assert.equal(header.vendor, CODEX_VENDOR_NAME);
    assert.equal(header.vendorVersion, "0.172.0");
    assert.equal(header.sdk, CODEX_SDK_NAME);
    assert.equal(header.sdkVersion, "rust-v0.172.0");
    assert.match(header.model, /\S/);
    const { run, replay } = await replayCodex(file, { preAdmissionLiveCapture: true });
    assert.equal(run.scenario.name, scenario);
    assert.deepEqual(replay.sequencer.recording, recording, "no frame or line number changed");
  });
}

const SIMPLE = path.join(DIRECTORY, "simple.ndjson");
const PROBE: SpawnRequest = { command: "codex", args: ["--version"], purpose: "probe", stdin: "ignore", timeoutMs: 10_000 };
const LOGIN: SpawnRequest = { ...PROBE, args: ["login", "status"] };
const SERVER: SpawnRequest = { command: "codex", args: ["app-server"], purpose: "runtime", stdin: "pipe" };

function driftAt(file: string, line: number, message: RegExp): (error: unknown) => true {
  return (error) => {
    assert.ok(error instanceof ReplayDriftError);
    assert.equal(error.file, file);
    assert.equal(error.line, line);
    assert.match(error.message, message);
    return true;
  };
}

test("default replay does not supply an admission probe even for a known live capture", async () => {
  await assert.rejects(replayCodex(SIMPLE), driftAt(SIMPLE, 2, /recorded "login", sent "--version"/));
});

test("pre-admission replay requires the original validated header and body, not just an old wire shape", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ari-codex-provenance-"));
  try {
    const text = fs.readFileSync(SIMPLE, "utf8");
    const newline = text.indexOf("\n");
    const header = JSON.parse(text.slice(0, newline));
    const body = text.slice(newline + 1);
    const edited = body.replace('"Logged in using ChatGPT"', '"changed synthetic status"');
    assert.notEqual(edited, body);
    const file = path.join(dir, "simple.ndjson");
    fs.writeFileSync(file, `${JSON.stringify(header)}\n${edited}`);
    await assert.rejects(replayCodex(file, { preAdmissionLiveCapture: true }), /body does not match the header's sha256/);
    fs.writeFileSync(file, `${JSON.stringify({ ...header, sha256: sha256Hex(edited) })}\n${edited}`);
    await assert.rejects(replayCodex(file, { preAdmissionLiveCapture: true }), /only for the six pinned live Codex captures/);
    fs.writeFileSync(file, `${JSON.stringify({ ...header, source: "fake" })}\n${body}`);
    await assert.rejects(replayCodex(file, { preAdmissionLiveCapture: true }), /only for the six pinned live Codex captures/);
    await assert.rejects(replayCodex(await readRecording(SIMPLE), { preAdmissionLiveCapture: true }), /requires a recording file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function transport(workspace: string) {
  return {
    workspace,
    sanitise: createSanitiser({ workspace, env: {}, protocolWords: CODEX_PROTOCOL_WORDS }),
    ignored: [],
    envPolicy: CODEX_RECORDER_ENV_POLICY,
  };
}

test("pre-admission replay rejects a wrong, missing, or extra probe and unexpected login or app-server spawns", async () => {
  const { startReplay } = await readPreAdmissionCodexCapture(SIMPLE);
  for (const wrong of [{ ...PROBE, timeoutMs: 1 }, { ...PROBE, args: ["--version", "extra"] }, LOGIN, SERVER]) {
    const replay = startReplay(transport(PLACEHOLDERS.workspace));
    await assert.rejects(replay.process.spawn(wrong), driftAt(SIMPLE, 2, /expected the compatibility admission probe/));
    await assert.rejects(replay.process.spawn(PROBE), (error) => error === replay.progress.failure());
  }
  for (const extra of [PROBE, SERVER, { ...LOGIN, args: ["login", "extra"] }]) {
    const replay = startReplay(transport(PLACEHOLDERS.workspace));
    await replay.process.spawn(PROBE);
    await assert.rejects(replay.process.spawn(extra), driftAt(SIMPLE, 2, /recorded \(line 2\).*"login","status"/));
  }
  for (const extraLogin of [true, false]) {
    const replay = startReplay(transport(PLACEHOLDERS.workspace));
    const probe = await replay.process.spawn(PROBE);
    let version = "";
    for await (const chunk of probe.stdout) version += new TextDecoder().decode(chunk);
    assert.equal(version, "codex-cli 0.172.0\n");
    assert.deepEqual(await probe.exited, { code: 0, signal: null });
    const login = await replay.process.spawn(LOGIN);
    for await (const _ of login.stderr) { /* drain the recorded login output */ }
    await login.exited;
    if (extraLogin) {
      await assert.rejects(replay.process.spawn(LOGIN), driftAt(SIMPLE, 5, /recorded \(line 5\).*"app-server"/));
    } else {
      const server = await replay.process.spawn(SERVER);
      await assert.rejects(server.write(new TextEncoder().encode('{"method":"unexpected"}\n')), driftAt(SIMPLE, 6, /recorded \(line 6\).*"initialize"/));
    }
  }
});

test("resume supplies exactly one admission probe before each recorded login, at lines 2 and 36", async () => {
  const { recording, startReplay } = await readPreAdmissionCodexCapture(path.join(DIRECTORY, "resume.ndjson"));
  const layout = createCodexLayout("ari-codex-probe-test-");
  try {
    const replay = startReplay(transport(layout.root));
    const outbound = recording.frames.filter(({ frame }) => frame.dir === "out");
    const probes: { line: number; nextArgs: unknown }[] = [];
    const process = {
      ...replay.process,
      async spawn(request: SpawnRequest) {
        const child = await replay.process.spawn(request);
        if (request.args?.[0] !== "--version") return child;
        const next = outbound[replay.sequencer.matchedOutbound().length]!;
        probes.push({ line: next.line, nextArgs: next.frame["args"] });
        return child;
      },
    };
    const { run } = await runCodexScenario({ scenario: scenarioNamed("resume"), layout, process, model: recording.header.model, native: replay.progress, timeoutMs: 10_000 });
    await replay.sequencer.whenTaken(500);
    replay.sequencer.finish();
    assert.equal(run.sessionIds.length, 2);
    assert.deepEqual(probes, [2, 36].map((line) => ({ line, nextArgs: ["login", "status"] })));
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("the live Codex recordings pass the privacy scan and carry only neutral account and machine details", async () => {
  let sawUsage = false;
  let sawRateLimits = false;
  let sawRemoteControl = false;
  for (const scenario of SCENARIO_NAMES) {
    const file = path.join(DIRECTORY, `${scenario}.ndjson`);
    assert.deepEqual(scanRecordingText(fs.readFileSync(file, "utf8"), file), []);
    const recording = await readRecording(file);
    const sanitise = createSanitiser({ workspace: PLACEHOLDERS.workspace, env: {}, user: "ari-no-such-user", protocolWords: CODEX_PROTOCOL_WORDS, recordedModel: recording.header.model });
    for (const { line, frame } of recording.frames) {
      assert.deepEqual(sanitise(frame), frame, `${scenario}.ndjson:${line} still holds something the sanitiser replaces`);
      const message = frame["message"] as { method?: string; params?: Record<string, unknown> } | undefined;
      sawUsage ||= message?.method === "thread/tokenUsage/updated";
      sawRateLimits ||= message?.method === "account/rateLimits/updated";
      sawRemoteControl ||= message?.method === "remoteControl/status/changed";
    }
  }
  assert.ok(sawUsage && sawRateLimits && sawRemoteControl, "the tapes exercise the native usage, rate limit, and remote control shapes");
});

test("the Codex sanitiser removes machine and usage values in the shapes found on the live wire", () => {
  const sanitise = createSanitiser({ workspace: PLACEHOLDERS.workspace, env: {}, user: "ari-no-such-user", protocolWords: CODEX_PROTOCOL_WORDS });
  const remote = { status: "disabled", serverName: "workstation-marker", installationId: "installation-marker", environmentId: null };
  const usage = { total: { totalTokens: 46 }, last: { totalTokens: 23 }, modelContextWindow: 128_000 };
  const sanitiseMessage = (message: object) => sanitise({ dir: "in", kind: "stdout", proc: 1, message }).message;
  assert.deepEqual(sanitiseMessage({ method: "remoteControl/status/changed", params: remote }), {
    method: "remoteControl/status/changed", params: { ...remote, serverName: "<SERVER_NAME>", installationId: "<INSTALLATION_ID>" },
  });
  assert.deepEqual(sanitiseMessage({ method: "thread/tokenUsage/updated", params: { tokenUsage: usage } }), {
    method: "thread/tokenUsage/updated", params: { tokenUsage: { ...usage, total: { totalTokens: 0 }, last: { totalTokens: 0 } } },
  });
  assert.deepEqual(sanitiseMessage({ method: "item/completed", params: { contentTokenCount: 7, item: { processId: "9124" } } }), {
    method: "item/completed", params: { contentTokenCount: 0, item: { processId: "1000" } },
  });
  assert.deepEqual(sanitiseMessage({ method: "thread/started", params: { thread: { modelProvider: "openai", projectId: "project-marker" } } }), {
    method: "thread/started", params: { thread: { modelProvider: "openai", projectId: "<PROJECT_ID>" } },
  });
});

test("the live approval permits only the expected marker command in the isolated working directory", async () => {
  const scenario = scenarioNamed("approval_allowed");
  const recording = await readRecording(path.join(DIRECTORY, `${scenario.name}.ndjson`));
  const approvals = recording.frames.flatMap(({ frame }) => {
    const message = frame["message"] as { method?: string; params?: { command: string; cwd: string } } | undefined;
    return message?.method === "item/commandExecution/requestApproval" ? [message.params!] : [];
  });
  assert.equal(approvals.length, 1);
  const { command, cwd } = approvals[0]!;
  const workspace = `${PLACEHOLDERS.workspace}/cwd`;
  const request = { kind: "command" as const, subject: { command: [command], cwd } };
  assert.ok(isCodexMarkerApproval(request, scenario, workspace));
  assert.ok(!isCodexMarkerApproval({ ...request, subject: { command: [`${command}; touch extra.txt`], cwd } }, scenario, workspace));
  assert.ok(!isCodexMarkerApproval({ ...request, subject: { command: [command], cwd: "/tmp/other" } }, scenario, workspace));
  assert.ok(!isCodexMarkerApproval({ ...request, kind: "file_change" }, scenario, workspace));
  assert.ok(!isCodexMarkerApproval(request, scenarioNamed("approval_denied"), workspace));
});
