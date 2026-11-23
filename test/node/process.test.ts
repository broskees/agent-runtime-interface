// Process spawning in `ari/node`: a child's environment is the base minus
// every stripped name or prefix plus explicit additions; `resolveExecutable`
// searches a given PATH; and disposing, aborting, `kill()`, a timeout or the
// child's own exit end the child's whole process group, grandchildren
// included.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { isAriError } from "../../src/index.ts";
import type { SpawnedProcess } from "../../src/index.ts";
import { buildChildEnvironment, createProcessService, resolveExecutable } from "../../src/node/index.ts";

const NODE = process.execPath;

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += Buffer.from(chunk).toString("utf8");
  return text;
}

/** Reads `stream` until it has produced one complete line, and returns that line. */
async function readFirstLine(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += Buffer.from(chunk).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline !== -1) return text.slice(0, newline);
  }
  throw new Error(`the stream ended before a full line: ${JSON.stringify(text)}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntilGone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isAlive(pid);
}

// A child that starts a grandchild, prints the grandchild's pid, and keeps
// running. With `ignoreTerm`, both ignore SIGTERM, so only SIGKILL ends them.
function parentOfGrandchildScript(options: { ignoreTerm?: boolean; exitAfterPrinting?: boolean } = {}): string {
  const ignore = options.ignoreTerm === true ? "process.on('SIGTERM', () => {});" : "";
  return [
    "const { spawn } = require('node:child_process');",
    ignore,
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(`${ignore} setInterval(() => {}, 1000);`)}], { stdio: 'ignore' });`,
    "process.stdout.write(grandchild.pid + '\\n');",
    options.exitAfterPrinting === true ? "setTimeout(() => process.exit(0), 50);" : "setInterval(() => {}, 1000);",
  ].join("\n");
}

async function startParentOfGrandchild(
  spawn: (request: { command: string; args: string[] }) => Promise<SpawnedProcess>,
  options: { ignoreTerm?: boolean; exitAfterPrinting?: boolean } = {},
): Promise<{ child: SpawnedProcess; grandchildPid: number }> {
  const child = await spawn({ command: NODE, args: ["-e", parentOfGrandchildScript(options)] });
  const grandchildPid = Number(await readFirstLine(child.stdout));
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, `grandchild pid: ${grandchildPid}`);
  return { child, grandchildPid };
}

describe("ari/node process spawning", () => {
  test("the child gets the base environment minus stripped names and prefixes, plus explicit additions", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ari-process-home-"));
    const service = createProcessService({
      envPolicy: { stripAmbient: ["GOOGLE_APPLICATION_CREDENTIALS", "ANTHROPIC_API_KEY", "AWS_*"] },
      baseEnv: {
        PATH: process.env.PATH,
        HOME: home,
        GOOGLE_APPLICATION_CREDENTIALS: "/secret/adc.json",
        GOOGLE_CLOUD_PROJECT: "not listed",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        ANTHROPIC_API_KEY_HINT: "only the exact name is listed",
        AWS_ACCESS_KEY_ID: "AKIA-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        ARI_TEST_UNLISTED: "kept",
      },
    });
    try {
      const child = await service.spawn({
        command: NODE,
        args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        env: { ARI_TEST_ADDED: "added" },
        stdin: "ignore",
      });
      const [output, exit] = await Promise.all([readAll(child.stdout), child.exited]);
      assert.deepEqual(exit, { code: 0, signal: null });
      const environment = JSON.parse(output) as Record<string, string>;
      assert.equal("GOOGLE_APPLICATION_CREDENTIALS" in environment, false);
      assert.equal("ANTHROPIC_API_KEY" in environment, false);
      assert.equal("AWS_ACCESS_KEY_ID" in environment, false, "stripped by the AWS_* prefix");
      assert.equal("AWS_SECRET_ACCESS_KEY" in environment, false, "stripped by the AWS_* prefix");
      assert.equal(environment.GOOGLE_CLOUD_PROJECT, "not listed");
      assert.equal(environment.ANTHROPIC_API_KEY_HINT, "only the exact name is listed");
      assert.equal(environment.ARI_TEST_UNLISTED, "kept");
      assert.equal(environment.ARI_TEST_ADDED, "added");
      assert.equal(environment.HOME, home);
    } finally {
      await service.dispose();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("an explicit addition is applied after stripping, so a driver can pass its own credential", () => {
    const environment = buildChildEnvironment(
      { ANTHROPIC_API_KEY: "ambient", GOOGLE_X: "ambient", KEEP: "1" },
      { stripAmbient: ["ANTHROPIC_API_KEY", "GOOGLE_*"] },
      { ANTHROPIC_API_KEY: "from-secrets" },
    );
    assert.deepEqual(environment, { KEEP: "1", ANTHROPIC_API_KEY: "from-secrets" });
  });

  test("the service never strips anything the policy does not list, and reports its policy", () => {
    const service = createProcessService({ envPolicy: { stripAmbient: ["A_*"] }, baseEnv: {} });
    assert.deepEqual(service.envPolicy, { stripAmbient: ["A_*"] });
    assert.deepEqual(buildChildEnvironment({ A_1: "x", B_1: "y", UNSET: undefined }, service.envPolicy), { B_1: "y" });
  });

  test("resolveExecutable finds an executable on a given PATH and returns null when it is absent", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ari-resolve-"));
    const otherDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ari-resolve-other-"));
    try {
      const executable = path.join(directory, "fake-agent");
      await fs.writeFile(executable, "#!/bin/sh\necho hi\n", { mode: 0o755 });
      await fs.writeFile(path.join(directory, "not-executable"), "data", { mode: 0o644 });
      await fs.mkdir(path.join(directory, "a-directory"));
      const service = createProcessService({ envPolicy: { stripAmbient: [] }, baseEnv: { PATH: otherDirectory } });
      const searchPath = [path.join(directory, "missing"), otherDirectory, directory].join(path.delimiter);

      assert.equal(await service.resolveExecutable("fake-agent", { path: searchPath }), executable);
      assert.equal(await service.resolveExecutable("not-executable", { path: searchPath }), null);
      assert.equal(await service.resolveExecutable("a-directory", { path: searchPath }), null);
      assert.equal(await service.resolveExecutable("absent-agent", { path: searchPath }), null);
      // Without `path`, the child environment's PATH is searched.
      assert.equal(await service.resolveExecutable("fake-agent"), null);
      const withDefaultPath = createProcessService({ envPolicy: { stripAmbient: [] }, baseEnv: { PATH: directory } });
      assert.equal(await withDefaultPath.resolveExecutable("fake-agent"), executable);
      // A name with a directory part is checked as a path.
      assert.equal(await resolveExecutable(executable, undefined), executable);
      assert.equal(await resolveExecutable(path.join(directory, "absent-agent"), undefined), null);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      await fs.rm(otherDirectory, { recursive: true, force: true });
    }
  });

  test("disposing kills the child's whole process group, grandchild included", async () => {
    const service = createProcessService({ envPolicy: { stripAmbient: [] } });
    const { child, grandchildPid } = await startParentOfGrandchild(service.spawn);
    assert.equal(isAlive(grandchildPid), true, "the grandchild runs before disposal");
    await service.dispose();
    assert.deepEqual(await child.exited, { code: null, signal: "SIGTERM" });
    assert.equal(await waitUntilGone(child.pid!), true, "the child is gone");
    assert.equal(await waitUntilGone(grandchildPid), true, "the grandchild is gone");
    await assert.rejects(service.spawn({ command: NODE }), (error: unknown) => isAriError(error, "invalid_state"));
  });

  test("a child still starting when the service is disposed is ended, and its spawn rejects", async () => {
    const service = createProcessService({ envPolicy: { stripAmbient: [] } });
    const spawning = service.spawn({ command: NODE, args: ["-e", "setInterval(() => {}, 1000)"] });
    const disposing = service.dispose();
    await assert.rejects(spawning, (error: unknown) => isAriError(error, "invalid_state"));
    await disposing;
  });

  test("aborting the service's signal kills the child's whole process group", async () => {
    const controller = new AbortController();
    const service = createProcessService({ envPolicy: { stripAmbient: [] }, signal: controller.signal });
    const { child, grandchildPid } = await startParentOfGrandchild(service.spawn);
    assert.equal(isAlive(grandchildPid), true);
    controller.abort();
    assert.equal((await child.exited).signal, "SIGTERM");
    assert.equal(await waitUntilGone(grandchildPid), true, "the grandchild is gone after abort");
    await service.dispose();
  });

  test("a group that ignores SIGTERM gets SIGKILL after the grace period", async () => {
    const service = createProcessService({ envPolicy: { stripAmbient: [] }, killGraceMs: 200 });
    const { child, grandchildPid } = await startParentOfGrandchild(service.spawn, { ignoreTerm: true });
    const started = Date.now();
    await service.dispose();
    assert.equal((await child.exited).signal, "SIGKILL");
    assert.equal(await waitUntilGone(grandchildPid), true, "the grandchild is gone");
    assert.ok(Date.now() - started >= 200, "SIGKILL waited for the grace period");
  });

  test("kill() without a signal ends the group; a timeout does too", async () => {
    const service = createProcessService({ envPolicy: { stripAmbient: [] } });
    try {
      const first = await startParentOfGrandchild(service.spawn);
      await first.child.kill();
      assert.equal(await waitUntilGone(first.grandchildPid), true, "kill() ends the grandchild");

      const timed = await service.spawn({ command: NODE, args: ["-e", parentOfGrandchildScript()], timeoutMs: 300 });
      const grandchildPid = Number(await readFirstLine(timed.stdout));
      assert.equal((await timed.exited).signal, "SIGTERM");
      assert.equal(await waitUntilGone(grandchildPid), true, "the timeout ends the grandchild");
    } finally {
      await service.dispose();
    }
  });

  test("a process the child leaves behind in its group is ended when the child exits", async () => {
    const service = createProcessService({ envPolicy: { stripAmbient: [] } });
    try {
      const { child, grandchildPid } = await startParentOfGrandchild(service.spawn, { exitAfterPrinting: true });
      assert.deepEqual(await child.exited, { code: 0, signal: null });
      assert.equal(await waitUntilGone(grandchildPid), true, "the orphaned grandchild is gone");
    } finally {
      await service.dispose();
    }
  });

  test("stdin, stdout and stderr are pipes the driver can use", async () => {
    const service = createProcessService({ envPolicy: { stripAmbient: [] } });
    try {
      const child = await service.spawn({
        command: NODE,
        args: ["-e", "process.stdin.on('data', (d) => process.stdout.write(d.toString().toUpperCase())); process.stderr.write('ready')"],
      });
      await child.write("hello ");
      await child.write(new TextEncoder().encode("world"));
      await child.closeStdin();
      const [stdout, stderr, exit] = await Promise.all([readAll(child.stdout), readAll(child.stderr), child.exited]);
      assert.equal(stdout, "HELLO WORLD");
      assert.equal(stderr, "ready");
      assert.deepEqual(exit, { code: 0, signal: null });

      const ignored = await service.spawn({ command: NODE, args: ["-e", ""], stdin: "ignore" });
      await assert.rejects(ignored.write("x"), (error: unknown) => isAriError(error, "invalid_state"));
      await ignored.exited;
    } finally {
      await service.dispose();
    }
  });

  test("spawning a missing executable rejects with not_found, and a malformed request with validation", async () => {
    const service = createProcessService({ envPolicy: { stripAmbient: [] }, baseEnv: { PATH: "" } });
    await assert.rejects(service.spawn({ command: "/nonexistent/ari-agent" }), (error: unknown) => isAriError(error, "not_found"));
    await assert.rejects(service.spawn({ command: NODE, stdin: "inherit" }), (error: unknown) => isAriError(error, "validation"));
    await assert.rejects(service.spawn({ command: NODE, timeoutMs: -1 }), (error: unknown) => isAriError(error, "validation"));
    await service.dispose();
  });
});
