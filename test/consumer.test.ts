// Every subpath works for a consumer. The package is packed as it is
// published (scripts/pack.ts) and installed with npm into fresh projects:
//
// - One without `effect` or any vendor SDK, type-checked with
//   `moduleResolution: "nodenext"`. Every export subpath other than
//   `ari/effect`, all 12 `ari/drivers/<name>` and `ari/meta/<name>` modules
//   and a JSON Schema file import under Node, and again under
//   `node --conditions=development`, which must not reach the src/ files the
//   tarball leaves out; a file importing a type from each type-checks; each
//   SDK driver (claude, cursor, opencode, muse) reports its missing SDK in
//   `status()`; and Bun imports `ari`, `ari/host` and `ari/conformance` and
//   runs the conformance suite against the reference driver.
// - One with `effect` installed, where `ari/effect` imports and type-checks.
//   It needs `effect` by design: test/effect/without-effect.test.ts shows the
//   error it gives without it.
//
// The README quickstarts run against the same install in readme.test.ts.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { checkPublishedManifest } from "../scripts/check-package.ts";
import type { PackageJson } from "../scripts/check-package.ts";
import { TSC, filesUnder, installConsumer, packAsPublished, packRepositoryDependency } from "./helpers/consumer.ts";
import { REPO_ROOT } from "./helpers/spec.ts";

/** The export subpaths of the package (§17.2). */
const EXPORT_SUBPATHS = [".", "./host", "./driver-kit", "./node", "./wire", "./conformance", "./effect", "./drivers/*", "./meta/*", "./cli-manifests", "./json-schema/*"];
/** The first-party drivers; each has `ari/drivers/<name>` and `ari/meta/<name>`. */
const DRIVERS = ["pi", "acp", "grok", "fx", "kiro", "acp-registry", "antigravity", "codex", "claude", "opencode", "cursor", "muse"];
/** The entries with one module each, other than `ari/effect`. */
const SINGLE_ENTRIES = ["ari", "ari/host", "ari/driver-kit", "ari/node", "ari/wire", "ari/conformance", "ari/cli-manifests"];
const JSON_SCHEMA_FILE = "ari/json-schema/events.schema.json";
/** The SDK each SDK-based driver loads, and that `status()` must name when it is missing. */
const SDK_PACKAGES: Record<string, string> = {
  claude: "@anthropic-ai/claude-agent-sdk",
  cursor: "@cursor/sdk",
  muse: "@muse-code/sdk",
  "opencode 1.x": "@opencode-ai/sdk",
  "opencode 2.x": "@opencode/client",
};

const repositoryManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as PackageJson & { exports: Record<string, unknown> };

const tempDirs: string[] = [];
after(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

/** A home and XDG directories of its own, so nothing the package runs reads or writes the user's. */
function isolatedEnvironment(): NodeJS.ProcessEnv {
  const home = tempDir("ari-consumer-home-");
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  };
}

/** Runs `program` with `args` in `cwd` and returns its stdout; fails the test with its output when it exits non-zero. */
function run(program: string, args: readonly string[], cwd: string, timeout = 120_000): string {
  const result = spawnSync(program, [...args], { cwd, encoding: "utf8", env: isolatedEnvironment(), timeout });
  assert.equal(result.status, 0, `${program} ${args.join(" ")} exited ${result.status} ${result.signal ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** The last line of `output`, parsed as JSON. */
function lastJsonLine(output: string): unknown {
  return JSON.parse(output.trim().split("\n").at(-1) ?? "null");
}

function typeCheck(directory: string, files: readonly string[], types: readonly string[]): void {
  fs.writeFileSync(
    path.join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2023",
        lib: ["es2023"],
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        skipLibCheck: false,
        resolveJsonModule: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        types,
      },
      files,
    }),
  );
  const result = spawnSync(process.execPath, [TSC, "-p", path.join(directory, "tsconfig.json")], { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

/**
 * A module script that imports every subpath other than `ari/effect` and
 * prints what it found: each module's export count, the `kind` of every
 * driver each driver module exports, and the JSON Schema file's `$id`.
 */
const IMPORT_EVERYTHING = `
const single = ${JSON.stringify(SINGLE_ENTRIES)};
const drivers = ${JSON.stringify(DRIVERS)};
const found = { modules: {}, drivers: {}, meta: {}, json: null };
for (const specifier of single) found.modules[specifier] = Object.keys(await import(specifier)).length;
for (const name of drivers) {
  const module = await import("ari/drivers/" + name);
  found.drivers[name] = [...new Set(Object.values(module)
    .filter((value) => value !== null && typeof value === "object" && typeof value.kind === "string" && typeof value.create === "function" && typeof value.defaultConfig === "function")
    .map((driver) => driver.kind))];
  found.meta[name] = Object.keys(await import("ari/meta/" + name)).length;
}
found.json = (await import(${JSON.stringify(JSON_SCHEMA_FILE)}, { with: { type: "json" } })).default.$id;
console.log(JSON.stringify(found));
`;

interface Found {
  modules: Record<string, number>;
  drivers: Record<string, string[]>;
  meta: Record<string, number>;
  json: string;
}

describe("package.json exports", () => {
  test("hold the 11 subpaths, and any extra entry is documented in README.md", () => {
    const subpaths = Object.keys(repositoryManifest.exports);
    for (const subpath of EXPORT_SUBPATHS) assert.ok(subpaths.includes(subpath), `exports lacks ${subpath}`);
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    for (const extra of subpaths.filter((subpath) => !EXPORT_SUBPATHS.includes(subpath))) {
      assert.ok(readme.includes(`\`ari${extra.slice(1)}\``), `exports has ${extra}, which README.md does not document`);
    }
  });

  test("the drivers in src/drivers/ are exactly the 12 first-party drivers", () => {
    const directories = fs.readdirSync(path.join(REPO_ROOT, "src", "drivers"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    assert.deepEqual(directories.sort(), [...DRIVERS].sort());
  });
});

describe("a consumer project without effect or any vendor SDK", () => {
  let consumer = "";
  let installed = "";

  before(() => {
    const packDir = tempDir("ari-consumer-pack-");
    const { tarball } = packAsPublished(packDir);
    consumer = tempDir("ari-consumer-");
    installConsumer(consumer, [tarball, ...packRepositoryDependency("@types/node", packDir)]);
    installed = path.join(consumer, "node_modules", "ari");
  });

  test("has the package installed, and neither effect nor any vendor SDK", () => {
    assert.ok(fs.existsSync(path.join(installed, "dist", "index.js")));
    assert.equal(fs.existsSync(path.join(installed, "src")), false, "sources are not shipped");
    for (const peer of Object.keys(repositoryManifest.peerDependencies ?? {})) {
      assert.equal(fs.existsSync(path.join(consumer, "node_modules", ...peer.split("/"))), false, `${peer} is installed`);
    }
  });

  test("its package.json is the published one: every export condition and the bin name a shipped file", () => {
    const published = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8")) as PackageJson & { exports: Record<string, Record<string, string> | string> };
    const shipped = filesUnder(installed);
    assert.deepEqual(checkPublishedManifest(published, shipped), []);
    assert.deepEqual(Object.keys(published.exports), Object.keys(repositoryManifest.exports));
    for (const [subpath, entry] of Object.entries(published.exports)) {
      if (typeof entry === "string") continue;
      assert.deepEqual(Object.keys(entry), ["types", "default"], `exports["${subpath}"]`);
    }
    assert.equal(published.scripts, undefined, "the published package.json carries no scripts");
    // The repository keeps the condition, so code in it runs without a build,
    // and the check fails it against the shipped files: one problem per entry.
    assert.equal((repositoryManifest.exports["."] as Record<string, string>)["development"], "./src/index.ts");
    const problems = checkPublishedManifest(repositoryManifest, shipped);
    assert.equal(problems.filter((problem) => problem.includes("condition development")).length, EXPORT_SUBPATHS.length - 1, problems.join("\n"));
  });

  test("imports every subpath except ari/effect: 7 entries, 12 drivers, 12 metadata modules and a JSON Schema file", () => {
    const found = lastJsonLine(run(process.execPath, ["--input-type=module", "-e", IMPORT_EVERYTHING], consumer)) as Found;
    for (const specifier of SINGLE_ENTRIES) assert.ok(found.modules[specifier]! > 0, `${specifier} exported nothing`);
    for (const name of DRIVERS) {
      assert.deepEqual(found.drivers[name], [name], `ari/drivers/${name} exports a driver of kind ${name}`);
      assert.ok(found.meta[name]! > 0, `ari/meta/${name} exported nothing`);
    }
    assert.equal(found.json, "https://ari.invalid/spec/v1/events.schema.json");
  });

  test("node --conditions=development loads every one of them from the tarball, the same as without the condition", () => {
    const plain = lastJsonLine(run(process.execPath, ["--input-type=module", "-e", IMPORT_EVERYTHING], consumer));
    const development = lastJsonLine(run(process.execPath, ["--conditions=development", "--input-type=module", "-e", IMPORT_EVERYTHING], consumer));
    assert.deepEqual(development, plain);
    const root = run(process.execPath, ["--conditions=development", "--input-type=module", "-e", 'console.log(import.meta.resolve("ari"))'], consumer).trim();
    assert.match(root, /\/node_modules\/ari\/dist\/index\.js$/);
  });

  test("a file importing a type from each entry type-checks with moduleResolution nodenext", () => {
    const namespace = (specifier: string): string => `ns_${specifier.replace(/[^a-z0-9]+/g, "_")}`;
    const lines = [
      'import type { AriEvent, ConfigValues, Driver, Session } from "ari";',
      'import type { ReducedSession } from "ari/host";',
      'import type { DeriveIdInput } from "ari/driver-kit";',
      'import type { NodeHostServices } from "ari/node";',
      'import type { WireSession } from "ari/wire";',
      'import type { ConformanceHarness } from "ari/conformance";',
      'import type { CliLaunchManifest } from "ari/cli-manifests";',
      `import eventsSchema from ${JSON.stringify(JSON_SCHEMA_FILE)} with { type: "json" };`,
      ...DRIVERS.flatMap((name) => [`import type * as ${namespace(`drivers ${name}`)} from "ari/drivers/${name}";`, `import type * as ${namespace(`meta ${name}`)} from "ari/meta/${name}";`]),
      "",
      "type IsSet<T> = [T] extends [never] ? false : true;",
      "/** The names of a module's exports that are typed as a `Driver`. */",
      "type DriverExports<Module> = { [Name in keyof Module]: Module[Name] extends Driver<any> ? Name : never }[keyof Module];",
      "export type Entries = [AriEvent, Session, ReducedSession, DeriveIdInput, NodeHostServices<ConfigValues>, WireSession, ConformanceHarness, CliLaunchManifest];",
      "export const schemaId: string = eventsSchema.$id;",
      `export const everyDriverModuleTypesADriver: [${DRIVERS.map(() => "true").join(", ")}] = [${DRIVERS.map((name) => `true as IsSet<DriverExports<typeof ${namespace(`drivers ${name}`)}>>`).join(", ")}];`,
      `export const everyMetaModuleHasExports: [${DRIVERS.map(() => "true").join(", ")}] = [${DRIVERS.map((name) => `true as IsSet<keyof typeof ${namespace(`meta ${name}`)}>`).join(", ")}];`,
    ];
    fs.writeFileSync(path.join(consumer, "types.ts"), `${lines.join("\n")}\n`);
    typeCheck(consumer, ["types.ts"], ["node"]);
  });

  test("each SDK driver is created without its SDK, and status() names the package to install", () => {
    for (const sdk of new Set(Object.values(SDK_PACKAGES))) {
      const missing = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(sdk)})`], { cwd: consumer, encoding: "utf8" });
      assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/, `${sdk} must not be installed in the consumer`);
    }
    const script = `
import { claudeDriver } from "ari/drivers/claude";
import { cursorDriver } from "ari/drivers/cursor";
import { museDriver } from "ari/drivers/muse";
import { opencodeDriver } from "ari/drivers/opencode";
import { createFakeHost, createMemoryProcess } from "ari/conformance";

const paths = { stateDir: process.env.HOME + "/state", cacheDir: process.env.HOME + "/cache", tmpDir: process.env.HOME + "/tmp" };
/** A host whose PATH has \`binary\`, which prints \`version\` for --version. */
const hostWith = (binary, version) => createFakeHost({
  paths,
  resolveExecutable: async (name) => (name === binary ? "/opt/bin/" + binary : null),
  spawn: async (request) => {
    const memory = createMemoryProcess({ onStdin() {}, onStdinClosed() {}, onKill() {} });
    queueMicrotask(() => {
      if (request.args?.[0] === "--version") memory.stdout(version + "\\n");
      memory.exit(request.args?.[0] === "--version" ? 0 : 1, null);
    });
    return memory.process;
  },
});
const cases = {
  claude: [claudeDriver, createFakeHost({ paths })],
  cursor: [cursorDriver, createFakeHost({ paths })],
  muse: [museDriver, hostWith("muse", "1.4.25")],
  "opencode 1.x": [opencodeDriver, hostWith("opencode", "1.19.6")],
  "opencode 2.x": [opencodeDriver, hostWith("opencode", "opencode v2.1.2")],
};
const results = {};
for (const [name, [driver, host]] of Object.entries(cases)) {
  const instance = await driver.create(host, { instanceId: name.replace(/\\W/g, "-"), config: driver.defaultConfig(), environment: {} });
  const status = await instance.status();
  let opened;
  try { await instance.openSession({}); opened = "opened"; } catch (error) { opened = error.callError ?? String(error); }
  await instance.dispose();
  results[name] = { state: status.state, error: status.error, opened, spawned: host.spawns.map((spawn) => [spawn.command, ...(spawn.args ?? [])].join(" ")) };
}
console.log(JSON.stringify(results));
`;
    const results = lastJsonLine(run(process.execPath, ["--input-type=module", "-e", script], consumer)) as Record<
      string,
      { state: string; error?: { code: string; package?: string; message: string }; opened: { code?: string; package?: string } | string; spawned: string[] }
    >;
    assert.deepEqual(Object.keys(results), Object.keys(SDK_PACKAGES));
    for (const [name, sdk] of Object.entries(SDK_PACKAGES)) {
      const result = results[name]!;
      assert.equal(result.state, "unavailable", `${name}: ${JSON.stringify(result)}`);
      assert.equal(result.error?.code, "driver_unavailable", name);
      assert.equal(result.error?.package, sdk, name);
      assert.ok(result.error?.message.includes(sdk), `${name}: the message names ${sdk}: ${result.error?.message}`);
      assert.deepEqual(result.opened, { ...(result.opened as object), code: "driver_unavailable", package: sdk }, name);
      assert.ok(result.spawned.every((command) => command.endsWith(" --version")), `${name} ran only --version: ${result.spawned.join(", ")}`);
    }
  });

  test("Bun imports ari, ari/host and ari/conformance, and the reference driver passes the conformance suite there", () => {
    const script = `
import { AriEventSchema, ARI_VERSION } from "ari";
import { EventGrammar } from "ari/host";
import { formatReport, referenceHarness, runConformance } from "ari/conformance";

const event = { seq: 1, at: "2026-11-23T00:00:00Z", sessionId: "s", body: { type: "session.state", state: "hibernating" } };
const grammar = new EventGrammar({ mode: "strict" });
const passedGrammar = grammar.observe(event) === event;
const report = await runConformance(referenceHarness());
if (!report.passed) console.error(formatReport(report));
console.log(JSON.stringify({ runtime: typeof Bun === "undefined" ? "not bun" : "bun", version: ARI_VERSION, valid: AriEventSchema.is(event), passedGrammar, results: report.results.map((result) => result.status) }));
`;
    fs.writeFileSync(path.join(consumer, "bun-check.ts"), script);
    const found = lastJsonLine(run("bun", ["run", "bun-check.ts"], consumer, 300_000));
    assert.deepEqual(found, { runtime: "bun", version: "1.0.0", valid: true, passedGrammar: true, results: Array.from({ length: 15 }, () => "passed") });
  });
});

describe("a consumer project with effect installed", () => {
  let consumer = "";

  before(() => {
    const packDir = tempDir("ari-effect-consumer-pack-");
    const { tarball } = packAsPublished(packDir);
    consumer = tempDir("ari-effect-consumer-");
    installConsumer(consumer, [tarball, ...packRepositoryDependency("effect", packDir), ...packRepositoryDependency("@types/node", packDir)]);
  });

  test("imports ari/effect, and its tagged errors and services work", () => {
    assert.ok(fs.existsSync(path.join(consumer, "node_modules", "effect", "package.json")));
    const script = `
import { Effect } from "effect";
import { callErrors } from "ari";
import { referenceDriver } from "ari/conformance";
import { AriDriver, UnsupportedError, toTaggedError } from "ari/effect";

const tagged = toTaggedError(callErrors.unsupported("threads.fork"));
const kind = await Effect.runPromise(Effect.gen(function* () { return (yield* AriDriver).kind; }).pipe(Effect.provide(AriDriver.layer(referenceDriver))));
console.log(JSON.stringify({ tag: tagged._tag, unsupported: tagged instanceof UnsupportedError, capability: tagged.capability, kind }));
`;
    assert.deepEqual(lastJsonLine(run(process.execPath, ["--input-type=module", "-e", script], consumer)), {
      tag: "UnsupportedError",
      unsupported: true,
      capability: "threads.fork",
      kind: "reference",
    });
  });

  test("a file importing types from ari/effect type-checks with moduleResolution nodenext", () => {
    const lines = [
      'import { Effect } from "effect";',
      'import { AriDriver, UnsupportedError, toTaggedError } from "ari/effect";',
      'import type { AriCallError, EffectSession } from "ari/effect";',
      'import { callErrors } from "ari";',
      "",
      "export type Checked = [AriCallError, EffectSession];",
      "export const driverKind = Effect.gen(function* () {",
      "  const driver = yield* AriDriver;",
      "  return driver.kind;",
      "});",
      "const tagged: AriCallError | undefined = toTaggedError(callErrors.unsupported(\"threads.fork\"));",
      "export const unsupported: boolean = tagged instanceof UnsupportedError;",
    ];
    fs.writeFileSync(path.join(consumer, "effect-types.ts"), `${lines.join("\n")}\n`);
    typeCheck(consumer, ["effect-types.ts"], ["node"]);
  });
});
