// The driver against the real @cursor/sdk 1.4.2, with nothing faked but the
// model catalog (setup-env.ts puts one in CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON,
// which the SDK reads instead of asking Cursor) and every outbound connection
// refused. Creating, resuming and replacing a thread run entirely on this
// machine: the SDK validates the driver's options, writes the agent into the
// driver's JSONL store under the instance's state directory, and refuses an
// agent the store does not hold with its own AgentNotFoundError. No run is
// started: a run would reach Cursor's hosted models.

import "./setup-env.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { createFakeHost } from "../../../src/conformance/index.ts";
import { READ_ONLY_TOOLS, cursorDriver } from "../../../src/drivers/cursor/index.ts";
import type { AriEvent } from "../../../src/index.ts";
import { instanceDirectories } from "../../helpers/conformance.ts";
import { MANAGED_KEY } from "./harness.ts";
import { networkAttempts } from "./setup-env.ts";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-cursor-real-")));
const HOME = path.join(ROOT, "home");
const WORKSPACE = path.join(ROOT, "project");
fs.mkdirSync(HOME);
fs.mkdirSync(WORKSPACE);
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** Runs a test with HOME at an empty directory: the SDK reads the home directory when it is used, so it sees this one, never the user's own. */
function withHome(body: () => Promise<void>): () => Promise<void> {
  return async () => {
    const saved = process.env["HOME"];
    process.env["HOME"] = HOME;
    try {
      await body();
    } finally {
      if (saved === undefined) delete process.env["HOME"];
      else process.env["HOME"] = saved;
    }
  };
}

function policy(mode: "full_access" | "read_only" = "full_access") {
  return { mode, interaction: "default" as const, cwd: WORKSPACE };
}

async function openInstance() {
  const host = createFakeHost({ config: cursorDriver.defaultConfig(), paths: instanceDirectories(ROOT, "real"), secrets: [{ namespace: "cursor", key: "api-key", value: MANAGED_KEY }], mcpServerName: () => "host-tools" });
  const instance = await cursorDriver.create(host, { instanceId: "real", config: cursorDriver.defaultConfig(), environment: {} });
  return { host, instance };
}

function collect(session: { events(): AsyncIterable<AriEvent> }): AriEvent[] {
  const events: AriEvent[] = [];
  void (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  return events;
}

test("status() finds the real SDK and its version", withHome(async () => {
  const { instance } = await openInstance();
  const status = await instance.status();
  assert.equal(status.state, "ready");
  assert.equal(status.version, "1.4.2");
  assert.equal(status.advisory, undefined);
  assert.deepEqual(status.auth, { status: "configured", evidence: "passive", scope: "managed_profile" });
  await instance.dispose();
}));

test("threads are real Cursor agents in the instance's own store: created, resumed by another session, and replaced when Cursor does not hold them", withHome(async () => {
  const { host, instance } = await openInstance();
  const first = await instance.openSession({ launch: { mcpServers: [{ name: "launch-docs", transport: "http", url: "http://127.0.0.1:9/mcp" }] } });
  const created = await first.createThread({ cwd: WORKSPACE, policy: policy() });
  assert.match(created.native.id ?? "", /^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "Cursor picked the agent id");
  assert.equal(created.handle, created.native.id);
  assert.equal(created.cwd, WORKSPACE);
  const readOnly = await first.createThread({ cwd: WORKSPACE, policy: policy("read_only") });
  const agents = fs.readFileSync(path.join(host.paths.stateDir, "cursor-agents", "agents.ndjson"), "utf8");
  assert.ok(agents.includes(created.native.id!) && agents.includes(readOnly.native.id!), "the real SDK wrote both agents into the driver's store");
  assert.ok(host.calls.some((call) => call.operation === "hostTools.mcpServerFor" && call.args[0] === created.id));
  await first.close();

  const second = await instance.openSession({});
  const events = collect(second);
  const resumed = await second.resumeThread({ native: { handle: created.handle! }, policy: policy() });
  assert.equal(resumed.id, created.id, "the real SDK resumed the same agent");
  const resumedReadOnly = await second.resumeThread({ native: { id: readOnly.native.id!, strength: "strong" }, policy: policy("read_only") });
  assert.equal(resumedReadOnly.id, readOnly.id);

  const missing = "agent-00000000-0000-4000-8000-00000000dead";
  const replaced = await second.resumeThread({ native: { id: missing, strength: "strong" }, policy: policy() });
  assert.notEqual(replaced.native.id, missing);
  const deadline = Date.now() + 5000;
  while (!events.some((event) => event.body.type === "session.replaced") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  const notice = events.find((event) => event.body.type === "session.replaced");
  assert.ok(notice !== undefined && notice.body.type === "session.replaced");
  assert.equal(notice.body.previousNativeId, missing);
  assert.equal(notice.body.contextLost, true);
  assert.match(notice.body.reason, /not found/);
  await second.close();
  await instance.dispose();

  assert.deepEqual(fs.readdirSync(HOME), [], "the SDK wrote nothing under the home directory");
  assert.deepEqual(networkAttempts(), []);
}));

test("the tools a read_only thread offers are tool names the real SDK knows", withHome(async () => {
  const sdk = await import("@cursor/sdk");
  const store = new sdk.JsonlLocalAgentStore(path.join(ROOT, "probe-store"));
  let valid: string[] = [];
  await assert.rejects(sdk.Agent.create({ apiKey: MANAGED_KEY, model: { id: "composer-2.5" }, local: { cwd: WORKSPACE, store }, tools: ["not-a-cursor-tool"] }), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    valid = (/Valid tool names: (.*)\.$/.exec(message)?.[1] ?? "").split(", ");
    return (error as { name?: string }).name === "ConfigurationError";
  });
  assert.ok(valid.length > 20, "the SDK listed its tool names");
  for (const tool of READ_ONLY_TOOLS) assert.ok(valid.includes(tool), `${tool} is a Cursor tool name`);
  for (const writer of ["shell", "edit", "delete", "mcp", "task", "write"]) assert.ok(!READ_ONLY_TOOLS.includes(writer), `${writer} is not offered to a read_only thread`);
  assert.deepEqual(networkAttempts(), []);
}));
