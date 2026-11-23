// Effect never loads unless asked: installed into a project without `effect`,
// every subpath of the package other than `ari/effect` imports, and
// `ari/effect` fails with an error that names the missing package. The
// repository rule `effect-only-in-ari-effect` (scripts/check-rules.ts) keeps
// it so: no source file outside src/effect/ loads `effect` or src/effect/.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { checkRepository } from "../../scripts/check-rules.ts";
import { REPO_ROOT } from "../helpers/spec.ts";

const tempDirs: string[] = [];
after(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

type ExportMap = Record<string, string | Record<string, string>>;
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { name: string; exports: ExportMap };

/**
 * The import specifiers of every export subpath other than `ari/effect` whose
 * target file exists under `base`, reading the export condition `condition`
 * (string entries such as `./json-schema/*` count for every condition).
 */
function specifiersIn(base: string, condition: "default" | "development"): { modules: string[]; json: string[] } {
  const modules: string[] = [];
  const json: string[] = [];
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (subpath === "./effect") continue;
    const target = typeof entry === "string" ? entry : entry[condition]!;
    const specifierFor = (match: string): string => `${pkg.name}${subpath.slice(1).replace("*", match)}`;
    if (!target.includes("*")) {
      if (fs.existsSync(path.join(base, target))) modules.push(specifierFor(""));
      continue;
    }
    const [prefix, suffix] = target.slice(2).split("*") as [string, string];
    const directory = path.join(base, prefix);
    if (!fs.existsSync(directory)) continue;
    for (const relative of fs.readdirSync(directory, { recursive: true }) as string[]) {
      const posix = relative.split(path.sep).join("/");
      if (!posix.endsWith(suffix) || posix.endsWith(".d.ts") || !fs.statSync(path.join(directory, relative)).isFile()) continue;
      const match = suffix === "" ? posix : posix.slice(0, -suffix.length);
      if (subpath === "./json-schema/*") json.push(specifierFor(match));
      else modules.push(specifierFor(match));
    }
  }
  return { modules: modules.sort(), json: json.sort() };
}

describe("a project without effect", () => {
  let consumer = "";

  before(() => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "dist", "index.js")), "dist/ is missing: run `pnpm run build` first (the gate does)");
    const packDir = tempDir("ari-effect-pack-");
    const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], { cwd: REPO_ROOT, encoding: "utf8" });
    const tarball = path.join(packDir, (JSON.parse(output) as Array<{ filename: string }>)[0]!.filename);
    consumer = tempDir("ari-no-effect-");
    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
    execFileSync("npm", ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", tarball], { cwd: consumer, encoding: "utf8" });
  });

  test("has no effect package to load", () => {
    assert.equal(fs.existsSync(path.join(consumer, "node_modules", "effect")), false);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("effect")'], { cwd: consumer, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot find package 'effect'/);
  });

  test("imports every subpath other than ari/effect", () => {
    const installed = path.join(consumer, "node_modules", pkg.name);
    const { modules, json } = specifiersIn(installed, "default");
    // Every subpath whose source exists in this repository is in the tarball.
    assert.deepEqual({ modules, json }, specifiersIn(REPO_ROOT, "development"));
    for (const core of ["ari", "ari/host", "ari/driver-kit", "ari/cli-manifests"]) assert.ok(modules.includes(core), core);
    assert.ok(json.length > 10, `found ${json.length} json-schema files`);
    const script = [
      `const modules = ${JSON.stringify(modules)};`,
      `const json = ${JSON.stringify(json)};`,
      "const loaded = [];",
      "for (const specifier of modules) { const module = await import(specifier); loaded.push([specifier, Object.keys(module).length]); }",
      'for (const specifier of json) { const module = await import(specifier, { with: { type: "json" } }); loaded.push([specifier, Object.keys(module.default).length]); }',
      "console.log(JSON.stringify(loaded));",
    ].join("\n");
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: consumer, encoding: "utf8" });
    const loaded = JSON.parse(output) as Array<[string, number]>;
    assert.equal(loaded.length, modules.length + json.length);
    for (const [specifier, exportCount] of loaded) assert.ok(exportCount > 0, `${specifier} exported nothing`);
  });

  test("ari/effect fails with an error naming the effect package", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("ari/effect")'], { cwd: consumer, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ari\/effect needs the optional peer dependency "effect" \(\^4\.0\.0\), which is not installed/);
  });
});

describe("rule effect-only-in-ari-effect", () => {
  function fixture(files: Record<string, string>): string {
    const root = tempDir("ari-effect-rule-");
    const all: Record<string, string> = {
      "package.json": JSON.stringify({ name: "ari", version: "0.0.0", type: "module", exports: {}, dependencies: {}, peerDependencies: { effect: "^4.0.0" } }),
      "src/effect/index.ts": 'export const Schema = (await import("effect/Schema")).Schema;\n',
      "src/index.ts": 'import type { Effect } from "effect";\nexport type Run = Effect.Effect<void>;\n',
      ...files,
    };
    for (const [relative, content] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), content);
    }
    return root;
  }

  function violations(root: string): string[] {
    return checkRepository({ root, tarballFiles: [] })
      .filter((violation) => violation.rule === "effect-only-in-ari-effect")
      .map((violation) => violation.file);
  }

  test("allows src/effect/ to load effect, and type-only imports elsewhere", () => {
    assert.deepEqual(violations(fixture({})), []);
  });

  test("fails a dynamic import of effect outside src/effect/", () => {
    assert.deepEqual(violations(fixture({ "src/drivers/sample/index.ts": 'export const load = () => import("effect/Stream");\n' })), [
      "src/drivers/sample/index.ts",
    ]);
  });

  test("fails a relative import of src/effect/ and the package's own ari/effect specifier", () => {
    const root = fixture({
      "src/host/uses-effect.ts": 'export { Schema } from "../effect/index.ts";\n',
      "src/node/uses-effect.ts": 'export const load = () => import("ari/effect");\n',
    });
    assert.deepEqual(violations(root).sort(), ["src/host/uses-effect.ts", "src/node/uses-effect.ts"]);
  });

  test("the real repository passes", () => {
    assert.deepEqual(
      checkRepository({ root: REPO_ROOT }).filter((violation) => violation.rule === "effect-only-in-ari-effect"),
      [],
    );
  });
});
