// The `ari-driver` bin: package.json declares it, it starts a first-party
// driver by name from `ari/drivers/<name>` (no registry), or any driver by
// module path, and nothing a driver prints can corrupt the protocol on stdout.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, test } from "node:test";
import { createFakeHost } from "../../src/conformance/index.ts";
import { isAriError } from "../../src/index.ts";
import { isModulePath, startAriDriver } from "../../src/wire/index.ts";
import { REPO_ROOT } from "../helpers/spec.ts";
import { ARI_DRIVER_BIN, REFERENCE_DRIVER_MODULE, requireBuild, startBuiltAriDriver } from "./helpers.ts";

const tempDirs: string[] = [];
after(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

const REFERENCE_URL = pathToFileURL(REFERENCE_DRIVER_MODULE).href;

/** Writes a module that exports drivers built from the reference driver. */
function driverModule(directory: string, name: string, body: string): string {
  const file = path.join(directory, name);
  fs.writeFileSync(file, `import { referenceDriver } from ${JSON.stringify(REFERENCE_URL)};\n${body}\n`);
  return file;
}

function runBin(args: string[]): { status: number | null; stdout: string; stderr: string } {
  requireBuild();
  const result = spawnSync(process.execPath, [ARI_DRIVER_BIN, ...args], { encoding: "utf8", input: "" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("the ari-driver bin", () => {
  test("package.json declares it as dist/wire/cli.js, an executable Node script", () => {
    requireBuild();
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { bin: { [name: string]: string } };
    assert.equal(pkg.bin["ari-driver"], "./dist/wire/cli.js");
    assert.equal(path.resolve(REPO_ROOT, pkg.bin["ari-driver"]!), ARI_DRIVER_BIN);
    assert.ok(fs.readFileSync(ARI_DRIVER_BIN, "utf8").startsWith("#!/usr/bin/env node\n"));
  });

  test("--version, --help, and usage errors", () => {
    assert.deepEqual(runBin(["--version"]), { status: 0, stdout: "ari-driver (ARI contract 1.0.0)\n", stderr: "" });
    const help = runBin(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: ari-driver <driver>/);
    const none = runBin([]);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /Usage: ari-driver/);
    assert.equal(runBin(["a", "b"]).status, 2);
    assert.equal(runBin(["./x.js", "--export"]).status, 2);
  });

  test("names and paths are told apart: a path has a separator, a leading dot, or a script extension", () => {
    for (const name of ["pi", "my-driver", "codex"]) assert.equal(isModulePath(name), false, name);
    for (const spec of ["./driver.js", "../d/index.ts", "/abs/driver.mjs", "driver.ts", "dir\\driver.js", ".hidden"]) assert.equal(isModulePath(spec), true, spec);
  });

  test("a first-party driver is found by name in ari/drivers/<name>, with no registry", async () => {
    requireBuild();
    // A copy of the built package with one extra driver directory, as a driver phase adds one.
    const root = tempDir("ari-driver-by-name-");
    fs.cpSync(path.join(REPO_ROOT, "dist"), path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "ari", type: "module" }));
    fs.mkdirSync(path.join(root, "dist", "drivers", "demo-agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "drivers", "demo-agent", "index.js"),
      'import { referenceDriver } from "../../conformance/reference/driver.js";\nexport const demoAgentDriver = { ...referenceDriver, kind: "demo-agent" };\nexport const helper = 1;\n',
    );
    const command = [process.execPath, path.join(root, "dist", "wire", "cli.js")];
    const started = await startAriDriver({ driver: "demo-agent", command });
    try {
      assert.equal(started.driver.kind, "demo-agent");
      assert.equal(started.driver.metadata.displayName, "Reference agent");
    } finally {
      await started.close();
    }

    await assert.rejects(startAriDriver({ driver: "no-such-agent", command }), (error: unknown) => {
      assert.ok(isAriError(error, "transport"), String(error));
      assert.match(error.message, /exited with code 1/);
      assert.match(error.message, /No first-party driver named "no-such-agent"/);
      return true;
    });
    const badName = spawnSync(command[0]!, [command[1]!, "Bad_Name"], { encoding: "utf8", input: "" });
    assert.equal(badName.status, 1);
    assert.match(badName.stderr, /neither a first-party driver name/);
  });

  test("any driver loads by module path: the default export, the only driver, or the one --export names", async () => {
    const directory = tempDir("ari-driver-by-path-");
    const single = driverModule(directory, "single.mjs", "export const onlyDriver = referenceDriver;\nexport const notADriver = { kind: 'x' };");
    const byDefault = driverModule(directory, "default.mjs", "export default { ...referenceDriver, kind: 'from-default' };\nexport const other = { ...referenceDriver, kind: 'other' };");
    const several = driverModule(directory, "several.mjs", "export const first = { ...referenceDriver, kind: 'first' };\nexport const second = { ...referenceDriver, kind: 'second' };");
    const none = driverModule(directory, "none.mjs", "export const nothing = 1;");

    for (const [driver, exportName, kind] of [
      [single, undefined, "reference"],
      [byDefault, undefined, "from-default"],
      [several, "second", "second"],
    ] as const) {
      const started = await startBuiltAriDriver({ driver, ...(exportName === undefined ? {} : { exportName }) });
      try {
        assert.equal(started.driver.kind, kind, driver);
      } finally {
        await started.close();
      }
    }
    await assert.rejects(startBuiltAriDriver({ driver: several }), (error: unknown) => isAriError(error, "transport") && /exports several drivers \(first, second\); choose one with --export/.test(error.message));
    await assert.rejects(startBuiltAriDriver({ driver: none }), (error: unknown) => isAriError(error, "transport") && /exports no driver/.test(error.message));
    await assert.rejects(startBuiltAriDriver({ driver: path.join(directory, "missing.mjs") }), (error: unknown) => isAriError(error, "transport") && /No driver module at/.test(error.message));
    // A relative path resolves against ari-driver's working directory.
    const relative = await startBuiltAriDriver({ driver: "./single.mjs", cwd: directory });
    try {
      assert.equal(relative.driver.kind, "reference");
    } finally {
      await relative.close();
    }
  });

  test("a driver that writes to stdout or console cannot corrupt the protocol; the text goes to stderr", async () => {
    const directory = tempDir("ari-driver-noisy-");
    const noisy = driverModule(
      directory,
      "noisy.mjs",
      [
        "console.log('noise while loading');",
        "process.stdout.write('raw stdout noise\\n');",
        "export const noisyDriver = {",
        "  ...referenceDriver,",
        "  kind: 'noisy',",
        "  defaultConfig() { console.info('noise in defaultConfig'); return referenceDriver.defaultConfig(); },",
        "  async create(host, input) { console.log({ creating: input.instanceId }); console.table([1]); return referenceDriver.create(host, input); },",
        "};",
      ].join("\n"),
    );
    const started = await startBuiltAriDriver({ driver: noisy });
    try {
      assert.equal(started.driver.kind, "noisy");
      const instance = await started.driver.create(createFakeHost(), { instanceId: "noisy-1", config: started.driver.defaultConfig(), environment: {} });
      assert.equal(instance.id, "noisy-1");
      assert.equal((await instance.catalog.list()).models.length > 0, true);
      const stderr = started.stderrTail();
      for (const text of ["noise while loading", "raw stdout noise", "noise in defaultConfig", "creating"]) assert.ok(stderr.includes(text), `${text} went to stderr: ${stderr}`);
    } finally {
      await started.close();
    }
  });

  test("closing stdin ends ari-driver: it disposes its instances and exits 0", async () => {
    const started = await startBuiltAriDriver({ driver: REFERENCE_DRIVER_MODULE });
    await started.driver.create(createFakeHost(), { instanceId: "exit-1", config: started.driver.defaultConfig(), environment: {} });
    await started.close();
    assert.equal(started.child.exitCode, 0);
  });
});
