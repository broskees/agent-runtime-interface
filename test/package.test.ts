// The package as a consumer gets it: strict, erasable TypeScript compiled to
// ESM; a tarball, packed as it is published (scripts/pack.ts), that installs
// into a fresh project and imports; a package-contents check that fails on
// stray files, missing build output, a published export condition or bin that
// names an unshipped file, an oversized root export, and any code of the
// Claude Agent SDK (an optional peer the npm package never ships); and the
// two release guards: packing the repository directly is refused, and a
// non-empty `dependencies` fails scripts/check-dependencies.ts.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { CLAUDE_SDK_CODE_MARKER, checkManifest, checkPackage, checkPublishedManifest, checkTarball, publishedContents, tarballContents, vendorCodeProblems } from "../scripts/check-package.ts";
import type { PackageJson } from "../scripts/check-package.ts";
import { packedFiles } from "../scripts/check-rules.ts";
import { REFUSE_REPOSITORY_PACK_MESSAGE, packPackage, publishedManifest } from "../scripts/pack.ts";
import { NOT_SET_UP, installConsumer } from "./helpers/consumer.ts";
import { REPO_ROOT } from "./helpers/spec.ts";

const tempDirs: string[] = [];
after(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as PackageJson;

function requireBuild(): void {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "dist", "index.js")), "dist/ is missing: run `pnpm run build` first (the gate does)");
}

describe("compiler settings", () => {
  test("tsconfig.json sets strict and erasableSyntaxOnly, and the suite runs on .ts sources", () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8"));
    assert.equal(tsconfig.compilerOptions.strict, true);
    assert.equal(tsconfig.compilerOptions.erasableSyntaxOnly, true);
    assert.equal(import.meta.filename.endsWith(".ts"), true, "this test itself runs through Node's type stripping");
  });
});

describe("the packed tarball", () => {
  let consumer = NOT_SET_UP;

  before(() => {
    requireBuild();
    const { tarball } = packPackage(REPO_ROOT, tempDir("ari-pack-"));
    consumer = tempDir("ari-consumer-");
    installConsumer(consumer, [tarball]);
  });

  test("installs into a fresh project with no vendor SDKs, and `ari` imports from it", () => {
    assert.equal(fs.existsSync(path.join(consumer, "node_modules", "ari", "dist", "index.js")), true);
    assert.equal(fs.existsSync(path.join(consumer, "node_modules", "ari", "src")), false, "sources are not shipped");
    assert.equal(fs.existsSync(path.join(consumer, "node_modules", "effect")), false, "optional peers are not installed");
    const script = [
      'import { AriEventSchema, ARI_VERSION, callErrors, isCallError, applyPatch } from "ari";',
      'import events from "ari/json-schema/events.schema.json" with { type: "json" };',
      'const event = { seq: 1, at: "2026-11-23T00:00:00Z", sessionId: "s", body: { type: "session.state", state: "hibernating" } };',
      "const error = JSON.parse(JSON.stringify(callErrors.unsupported('threads.fork')));",
      "console.log(JSON.stringify({",
      "  version: ARI_VERSION,",
      "  valid: AriEventSchema.is(event),",
      "  guard: isCallError(error, 'unsupported'),",
      "  patched: applyPatch({ a: 1, b: 2 }, { b: null }),",
      "  schemaId: events.$id,",
      "}));",
    ].join("\n");
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: consumer, encoding: "utf8" });
    assert.deepEqual(JSON.parse(output), {
      version: "1.0.0",
      valid: true,
      guard: true,
      patched: { a: 1 },
      schemaId: "https://ari.invalid/spec/v1/events.schema.json",
    });
  });

  test("its type declarations type-check in a nodenext consumer", () => {
    fs.writeFileSync(
      path.join(consumer, "check.ts"),
      [
        'import { AriEventSchema, callErrors, type AriEvent, type Session, type Driver } from "ari";',
        'const event: AriEvent = { seq: 1, at: "", sessionId: "s", body: { type: "notice", level: "info", text: "hi" } };',
        "export const verdict: boolean = AriEventSchema.is(event);",
        "export const error: Error = callErrors.transport();",
        "export type Surface = [Session, Driver];",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(consumer, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, types: [] }, files: ["check.ts"] }),
    );
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    const result = spawnSync(process.execPath, [tsc, "-p", path.join(consumer, "tsconfig.json")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

describe("the package-contents check", () => {
  test("passes on the real package", async () => {
    requireBuild();
    const { problems, bytes, budget } = await checkPackage(REPO_ROOT);
    assert.deepEqual(problems, []);
    assert.ok(bytes > 0 && bytes <= budget);
  });

  test("fails on a file outside the allowed contents and on missing build output", () => {
    requireBuild();
    const files = packedFiles(REPO_ROOT);
    const withStray = checkTarball(REPO_ROOT, pkg, [...files, "src/index.ts", "scripts/codegen.ts"]);
    assert.ok(withStray.some((problem) => problem.includes("tarball holds src/index.ts")));
    assert.ok(withStray.some((problem) => problem.includes("tarball holds scripts/codegen.ts")));
    const withoutMaps = checkTarball(REPO_ROOT, pkg, files.filter((file) => file !== "dist/patch.js.map" && file !== "dist/index.d.ts"));
    assert.ok(withoutMaps.some((problem) => problem.includes("lacks dist/patch.js.map")));
    assert.ok(withoutMaps.some((problem) => problem.includes('exports["."].types')));
  });

  test("fails when a required package.json field is wrong", () => {
    assert.deepEqual(checkManifest(pkg), []);
    const broken = structuredClone(pkg);
    broken.sideEffects = true;
    broken.dependencies = { "left-pad": "1.3.0" };
    delete broken.peerDependenciesMeta!["@cursor/sdk"];
    const problems = checkManifest(broken);
    assert.ok(problems.some((problem) => problem.includes('"sideEffects"')));
    assert.ok(problems.some((problem) => problem.includes('"dependencies"')));
    assert.ok(problems.some((problem) => problem.includes("@cursor/sdk")));
  });

  test("fails when the root export exceeds the recorded byte budget", async () => {
    requireBuild();
    const root = tempDir("ari-budget-");
    for (const part of ["package.json", "README.md", "LICENSE", "dist", "json-schema", "src"]) {
      fs.cpSync(path.join(REPO_ROOT, part), path.join(root, part), { recursive: true });
    }
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "size-budget.json"), JSON.stringify({ rootExportMinifiedBytes: 1000 }));
    const { problems } = await checkPackage(root, publishedContents(REPO_ROOT));
    assert.ok(problems.some((problem) => /over the budget of 1000 bytes/.test(problem)), problems.join("\n"));
  });

  test("fails when the published package.json sends a condition or the bin to a file the tarball does not ship, or has dependencies", () => {
    requireBuild();
    const { manifest, files } = publishedContents(REPO_ROOT);
    assert.deepEqual(checkPublishedManifest(manifest, files), []);
    const broken = structuredClone(manifest);
    (broken.exports!["./host"] as Record<string, string>)["development"] = "./src/host/index.ts";
    (broken.exports!["./meta/*"] as Record<string, string>)["browser"] = "./dist/meta/*.browser.js";
    broken.bin = { "ari-driver": "./dist/wire/missing-cli.js" };
    broken.dependencies = { "left-pad": "1.3.0" };
    const problems = checkPublishedManifest(broken, files);
    assert.ok(problems.some((problem) => problem.includes('exports["./host"] condition development sends ./src/host/index.ts')), problems.join("\n"));
    assert.ok(problems.some((problem) => problem.includes('exports["./meta/*"] condition browser sends 11 of 11 subpaths')), problems.join("\n"));
    assert.ok(problems.some((problem) => problem.includes("bin ari-driver is ./dist/wire/missing-cli.js")), problems.join("\n"));
    assert.ok(problems.some((problem) => problem.includes('"dependencies" must be empty')), problems.join("\n"));
  });

  test("finds no code of the Claude Agent SDK in the real package, and fails a package, staged or packed, that ships the SDK's sdk.mjs", async () => {
    requireBuild();
    // The string the check looks for: the environment variable the SDK sets for every Claude Code process it starts.
    assert.equal(CLAUDE_SDK_CODE_MARKER, "CLAUDE_CODE_SDK_READS_SESSION_STATE");
    const sdkModule = path.join(fs.realpathSync(path.join(REPO_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk")), "sdk.mjs");
    assert.ok(fs.readFileSync(sdkModule).includes(CLAUDE_SDK_CODE_MARKER), "the pinned SDK's sdk.mjs contains the string");
    const real = publishedContents(REPO_ROOT);
    assert.deepEqual(vendorCodeProblems(real), []);
    assert.ok(real.filesContaining("failed to load: ").includes("dist/drivers/claude/sdk.js"), "the check reads every shipped file");
    const root = tempDir("ari-vendored-");
    for (const part of ["package.json", "README.md", "LICENSE", "dist", "json-schema", "src", "scripts"]) {
      fs.cpSync(path.join(REPO_ROOT, part), path.join(root, part), { recursive: true });
    }
    fs.mkdirSync(path.join(root, "dist", "vendor"));
    fs.copyFileSync(sdkModule, path.join(root, "dist", "vendor", "sdk.js"));
    const { problems } = await checkPackage(root);
    assert.ok(problems.some((problem) => problem.startsWith("dist/vendor/sdk.js holds code of @anthropic-ai/claude-agent-sdk")), problems.join("\n"));
    const { tarball } = packPackage(root, tempDir("ari-vendored-pack-"));
    assert.deepEqual(vendorCodeProblems(tarballContents(tarball)), [
      `${path.basename(tarball)} holds code of @anthropic-ai/claude-agent-sdk (it contains ${CLAUDE_SDK_CODE_MARKER}, a string unique to the SDK's sdk.mjs); the npm package must not ship the SDK, an optional peer`,
    ]);
  });
});

describe("packing as published", () => {
  test("the published package.json drops the development condition and the scripts, and keeps every other field", () => {
    const published = publishedManifest(pkg as never) as Record<string, unknown> & { exports: Record<string, unknown> };
    const expected = structuredClone(pkg) as Record<string, unknown> & { exports: Record<string, unknown> };
    delete expected["scripts"];
    for (const entry of Object.values(expected.exports)) if (typeof entry === "object" && entry !== null) delete (entry as Record<string, unknown>)["development"];
    assert.deepEqual(published, expected);
    assert.ok(!JSON.stringify(published).includes('"development"'));
    assert.deepEqual(publishedManifest(pkg as never, { repository: "git+https://github.com/example/ari.git" })["repository"], { type: "git", url: "git+https://github.com/example/ari.git" });
  });

  test("the tarball holds the published package.json and the same files a repository pack lists, and the repository's package.json is unchanged", () => {
    requireBuild();
    const before = fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
    const packed = packPackage(REPO_ROOT, tempDir("ari-pack-check-"));
    assert.equal(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"), before);
    const contents = tarballContents(packed.tarball);
    assert.deepEqual(contents.manifest, packed.manifest);
    assert.deepEqual(contents.manifest, publishedManifest(pkg as never));
    assert.deepEqual(contents.files, packedFiles(REPO_ROOT));
    assert.deepEqual([...packed.files], contents.files);
  });

  test("check-package.ts --tarball passes the packed tarball and fails one packed straight from the repository", () => {
    requireBuild();
    const checkScript = path.join(REPO_ROOT, "scripts", "check-package.ts");
    const { tarball } = packPackage(REPO_ROOT, tempDir("ari-tarball-check-"));
    const passed = spawnSync(process.execPath, [checkScript, "--tarball", tarball], { encoding: "utf8" });
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /the published package\.json sends every export condition and the bin to a shipped file/);
    // Skipping the prepack refusal ships the repository's own package.json, development condition included.
    const rawDirectory = tempDir("ari-raw-pack-");
    const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", rawDirectory], { cwd: REPO_ROOT, encoding: "utf8" });
    const rawTarball = path.join(rawDirectory, (JSON.parse(output) as Array<{ filename: string }>)[0]!.filename);
    const failed = spawnSync(process.execPath, [checkScript, "--tarball", rawTarball], { encoding: "utf8" });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stderr, /exports\["\."\] condition development sends \.\/src\/index\.ts, which the tarball does not ship/);
  });

  test("npm pack in the repository itself is refused by the prepack script", () => {
    const destination = tempDir("ari-refused-pack-");
    const result = spawnSync("npm", ["pack", "--pack-destination", destination], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(REFUSE_REPOSITORY_PACK_MESSAGE), result.stderr);
    assert.deepEqual(fs.readdirSync(destination), []);
  });
});

describe("scripts/check-dependencies.ts, which the release workflow runs before it builds and before it publishes", () => {
  const script = path.join(REPO_ROOT, "scripts", "check-dependencies.ts");

  test("passes the repository's package.json and the packed tarball", () => {
    requireBuild();
    const { tarball } = packPackage(REPO_ROOT, tempDir("ari-deps-pack-"));
    for (const file of [path.join(REPO_ROOT, "package.json"), tarball]) {
      const result = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /no runtime dependencies/);
    }
  });

  test("fails a package.json, or a tarball, whose dependencies are not empty", () => {
    const directory = tempDir("ari-deps-");
    const manifest = path.join(directory, "package.json");
    fs.writeFileSync(manifest, JSON.stringify({ ...pkg, dependencies: { "left-pad": "1.3.0", zod: "4.0.0" } }));
    const packed = JSON.parse(execFileSync("npm", ["pack", directory, "--json", "--ignore-scripts", "--pack-destination", directory], { cwd: directory, encoding: "utf8" })) as Array<{ filename: string }>;
    for (const file of [manifest, path.join(directory, packed[0]!.filename)]) {
      const result = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
      assert.equal(result.status, 1, `${file}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /"dependencies" must be empty, but it lists left-pad, zod/);
    }
  });
});
