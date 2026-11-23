// The package as a consumer gets it: strict, erasable TypeScript compiled to
// ESM; a tarball that installs into a fresh project and imports; and a
// package-contents check that fails on stray files, missing build output and
// an oversized root export.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { checkManifest, checkPackage, checkTarball } from "../scripts/check-package.ts";
import type { PackageJson } from "../scripts/check-package.ts";
import { packedFiles } from "../scripts/check-rules.ts";
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
  let consumer = "";

  before(() => {
    requireBuild();
    const packDir = tempDir("ari-pack-");
    const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const tarball = path.join(packDir, (JSON.parse(output) as Array<{ filename: string }>)[0]!.filename);
    consumer = tempDir("ari-consumer-");
    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
    execFileSync("npm", ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", tarball], { cwd: consumer, encoding: "utf8" });
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
    const { problems } = await checkPackage(root, packedFiles(REPO_ROOT));
    assert.ok(problems.some((problem) => /over the budget of 1000 bytes/.test(problem)), problems.join("\n"));
  });
});
