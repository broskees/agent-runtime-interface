// A missing `pi` fails loudly only when used: importing the driver loads no
// vendor package and spawns nothing; without `pi`, `create()` works,
// `status()` names the binary to install and `openSession` rejects with
// `driver_unavailable`; with `pi`, `status()` reports its version and an
// advisory when it is outside the tested range. The last test runs the driver
// on real Node host services against a `pi` found on PATH, and type-checks
// every frame that fake exchanged, read from its trace file.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakeHost } from "../../../src/conformance/index.ts";
import { PI_TESTED_VERSIONS, piDriver } from "../../../src/drivers/pi/index.ts";
import { isAriError, toCallError } from "../../../src/index.ts";
import type { AriEvent, Request } from "../../../src/index.ts";
import { createCoordination, createNodeHostServices } from "../../../src/node/index.ts";
import { FAKE_PI, framesUnder } from "./harness.ts";
import { checkRunsAgainstPiTypes } from "./pi-types.ts";
import { openPiTestRig, policy } from "./rig.ts";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

test("importing ari/drivers/pi and ari/meta/pi loads no vendor package, no Node built-in, and spawns nothing", () => {
  const script = `
    import { registerHooks, syncBuiltinESMExports } from "node:module";
    import childProcess from "node:child_process";
    let spawns = 0;
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
      const original = childProcess[name];
      childProcess[name] = (...args) => { spawns += 1; return original(...args); };
    }
    syncBuiltinESMExports();
    const resolved = [];
    registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); resolved.push(result.url); return result; } });
    const driver = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "src/drivers/pi/index.ts")).href)});
    const meta = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "src/meta/pi.ts")).href)});
    console.log(JSON.stringify({ resolved, spawns, kind: driver.piDriver.kind, label: meta.label }));
  `;
  // The child registers node:module hooks, which Bun lacks, so it runs on Node whichever runtime runs this test.
  const result = spawnSync(NODE_EXECUTABLE, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { resolved: string[]; spawns: number; kind: string; label: string };
  assert.equal(report.kind, "pi");
  assert.equal(report.label, "Pi");
  assert.equal(report.spawns, 0);
  assert.ok(report.resolved.some((url) => url.endsWith("/src/drivers/pi/session.ts")), "the resolve hook saw the driver's modules");
  assert.deepEqual(
    report.resolved.filter((url) => url.includes("/node_modules/")),
    [],
    "a vendor package was loaded",
  );
  assert.deepEqual(
    report.resolved.filter((url) => url.startsWith("node:")),
    [],
    "a Node built-in was loaded at import",
  );
});

test("without pi, create() succeeds, status() names the binary, and openSession rejects with driver_unavailable", async () => {
  const host = createFakeHost({ config: piDriver.defaultConfig(), resolveExecutable: async () => null });
  const instance = await piDriver.create(host, { instanceId: "no-pi", config: piDriver.defaultConfig(), environment: {} });
  const status = await instance.status();
  assert.equal(status.state, "unavailable");
  assert.equal(status.installed, false);
  assert.equal(status.error?.code, "driver_unavailable");
  assert.equal((status.error as { binary?: string }).binary, "pi");
  const probe = await instance.probe();
  assert.equal(probe.installed, false);
  await assert.rejects(instance.openSession({}), (error: unknown) => {
    assert.ok(isAriError(error, "driver_unavailable"), `rejected with ${String(error)}`);
    assert.equal((toCallError(error) as { binary?: string }).binary, "pi");
    return true;
  });
  assert.equal(host.spawns.length, 0);
});

test("with pi, status() reports its version, and an advisory only outside the tested range", async () => {
  const tested = await openPiTestRig();
  const inRange = await tested.instance.status();
  assert.equal(inRange.state, "ready");
  assert.equal(inRange.version, "1.6.0");
  assert.equal(inRange.advisory, undefined);
  await tested.close();

  for (const version of ["0.9.4", "2.0.0"]) {
    const untested = await openPiTestRig({ fakeVersion: version });
    const status = await untested.instance.status();
    assert.equal(status.version, version);
    assert.equal(status.advisory?.kind, "untested_version");
    assert.equal(status.advisory?.currentVersion, version);
    assert.equal(status.advisory?.testedRange, PI_TESTED_VERSIONS);
    await untested.close();
  }
});

test("on real Node host services, the driver finds pi on PATH and completes a turn with an approval", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-pi-node-")));
  temporary.push(root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  for (const directory of [bin, home, project]) fs.mkdirSync(directory);
  // The user's own pi: a script on PATH. This fake has no puppet channel here, so it runs in autopilot.
  fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_PI)} "$@"\n`, { mode: 0o755 });
  const config = { binary: "pi", provider: "fake", model: "fake/fake-small" };
  const host = await createNodeHostServices<typeof config>({
    hostRoot: path.join(root, "host"),
    instanceId: "pi-node",
    config: { get: async () => ({ config }) },
    attachments: { resolve: async () => null },
    hostTools: { mcpServerFor: async (threadId) => ({ name: `host-${threadId.slice(-6)}`, config: { name: `host-${threadId.slice(-6)}`, transport: "http", url: "http://127.0.0.1:9/mcp" } }) },
    callbacks: { register: async (flowId) => ({ url: `http://127.0.0.1:9/${flowId}` }) },
    coordination: createCoordination(),
    writeDiagnostic: () => undefined,
    // FAKE_PI_TRACE_DIRECTORY tells the fake where to trace its frames; real pi ignores it.
    baseEnv: { PATH: bin, HOME: home, FAKE_PI_TRACE_DIRECTORY: path.join(root, "traces") },
    envPolicy: { stripAmbient: [...(piDriver.cliManifest?.envScrubPrefixes ?? [])] },
  });
  try {
    const instance = await piDriver.create(host, { instanceId: "pi-node", config, environment: {} });
    const status = await instance.status();
    assert.equal(status.version, "1.6.0");
    assert.equal(status.auth?.status, "authenticated");
    const session = await instance.openSession({});
    const events: AriEvent[] = [];
    void (async () => {
      for await (const event of session.events()) events.push(event);
    })();
    const thread = await session.createThread({ cwd: project, policy: policy(project) });
    assert.equal(thread.cwd, project);
    const started = await session.startTurn({ threadId: thread.id, clientTurnKey: "node-1", intent: "start", content: [{ type: "text", text: "Hello" }] });
    assert.equal(started.status, "accepted");
    if (started.status !== "accepted") return;
    const deadline = Date.now() + 10_000;
    let request: Request | undefined;
    while (request === undefined && Date.now() < deadline) {
      for (const event of events) if (event.body.type === "request.upsert" && event.body.request.status === "pending") request = event.body.request as Request;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(request !== undefined, "the autopilot's approval reached the host");
    await session.respond({ requestId: request.id, responseKey: "node-approve", optionId: "allow-once" });
    let terminal: AriEvent | undefined;
    while (terminal === undefined && Date.now() < deadline) {
      terminal = events.find((event) => event.body.type === "turn.terminal");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((terminal?.body as { status?: string } | undefined)?.status, "completed");
    await session.close();
    await instance.dispose();
    // Nothing under the provider's own config directory.
    assert.equal(fs.existsSync(path.join(home, ".pi")), false);

    // This fake had no puppet channel; its trace file still holds every frame, and they match Pi's types.
    const frames = framesUnder(root);
    for (const type of ["get_available_models", "get_state", "get_entries", "prompt", "extension_ui_response"]) {
      assert.ok(frames.some((frame) => frame.direction === "in" && frame.record["type"] === type), `no ${type} frame was traced`);
    }
    for (const type of ["response", "agent_start", "message_end", "extension_ui_request", "agent_settled"]) {
      assert.ok(frames.some((frame) => frame.direction === "out" && frame.record["type"] === type), `no ${type} frame was traced`);
    }
    assert.deepEqual(checkRunsAgainstPiTypes([{ frames, root }]).diagnostics, []);
  } finally {
    await host.dispose();
  }
});
