// The committed Codex tapes replay through a fresh driver without a CLI or credential.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { scanRecordingText } from "../../../scripts/check-recordings.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { CODEX_PROTOCOL_WORDS } from "../../recordings/codex/protocol-words.ts";
import { CODEX_SDK_NAME, CODEX_VENDOR_NAME, isCodexMarkerApproval } from "../../recordings/codex/record.ts";
import { replayCodex } from "../../recordings/codex/replay.ts";
import { readRecording } from "../../recordings/format.ts";
import { PLACEHOLDERS, createSanitiser } from "../../recordings/sanitiser.ts";
import { SCENARIO_NAMES, scenarioNamed } from "../../recordings/scenarios.ts";

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
    const { run } = await replayCodex(recording);
    assert.equal(run.scenario.name, scenario);
  });
}

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
