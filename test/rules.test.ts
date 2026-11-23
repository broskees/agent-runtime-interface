// The repository rule checker fails, naming the file and the rule, on each of
// its five violations, and passes a clean fixture and the real repository.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { checkRepository } from "../scripts/check-rules.ts";
import type { RuleViolation } from "../scripts/check-rules.ts";
import { REPO_ROOT } from "./helpers/spec.ts";

// Host names are assembled at runtime so that this file does not contain them.
const HOST_NAME = ["T", "3", "code"].join("");
const SETTINGS_NAME = ["Server", "Settings"].join("");

const tempDirs: string[] = [];
after(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
});

const realPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as Record<string, unknown>;

/** A minimal clean repository: the real export map and peers, one source file and its build. */
function cleanFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ari-rules-"));
  tempDirs.push(root);
  const files: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        name: "rules-fixture",
        version: "0.0.0",
        type: "module",
        files: ["dist"],
        exports: realPackage.exports,
        dependencies: {},
        peerDependencies: realPackage.peerDependencies,
        peerDependenciesMeta: realPackage.peerDependenciesMeta,
      },
      null,
      2,
    ),
    "README.md": "# fixture\n",
    "src/index.ts": 'export { helper } from "./helper.ts";\nimport type { Thing } from "effect";\nexport type T = Thing;\n',
    "src/helper.ts": "export const helper = (value: string): string => value.trim();\n",
    "src/node/index.ts": 'import * as fs from "node:fs";\nexport const exists = (file: string): boolean => fs.existsSync(file);\n',
    "src/drivers/sample/index.ts": 'export async function load(): Promise<unknown> {\n  return import("@cursor/sdk");\n}\n',
    "dist/index.js": 'export { helper } from "./helper.js";\n',
    "dist/helper.js": "export const helper = (value) => value.trim();\n",
    "dist/node/index.js": 'import * as fs from "node:fs";\nexport const exists = (file) => fs.existsSync(file);\n',
    "dist/drivers/sample/index.js": 'export async function load() {\n  return import("@cursor/sdk");\n}\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  return root;
}

function write(root: string, relative: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
}

const SHIPPED = ["package.json", "README.md", "dist/index.js", "dist/helper.js", "dist/node/index.js", "dist/drivers/sample/index.js"];

function check(root: string, tarballFiles: readonly string[] = SHIPPED): RuleViolation[] {
  return checkRepository({ root, tarballFiles });
}

function only(violations: RuleViolation[], rule: RuleViolation["rule"], file: string): void {
  assert.ok(violations.length > 0, "expected a violation");
  for (const violation of violations) {
    assert.equal(violation.rule, rule, JSON.stringify(violation));
    assert.equal(violation.file, file, JSON.stringify(violation));
  }
}

describe("repository rules", () => {
  test("a clean fixture passes", () => {
    assert.deepEqual(check(cleanFixture()), []);
  });

  test("the real repository passes", () => {
    assert.deepEqual(checkRepository({ root: REPO_ROOT }), []);
  });

  test("(a) a non-empty dependencies field fails", () => {
    const root = cleanFixture();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    pkg.dependencies = { "left-pad": "1.3.0" };
    write(root, "package.json", JSON.stringify(pkg));
    only(check(root), "no-runtime-dependencies", "package.json");
  });

  test("(b) a host product name in source or in a shipped file fails", () => {
    const inSource = cleanFixture();
    write(inSource, "src/notes.ts", `// adapted from ${HOST_NAME}\nexport const notes = 1;\n`);
    only(check(inSource), "no-host-names", "src/notes.ts");

    const inShipped = cleanFixture();
    write(inShipped, "README.md", `# fixture\n\nWorks with ${SETTINGS_NAME}.\n`);
    only(check(inShipped), "no-host-names", "README.md");

    const inTests = cleanFixture();
    write(inTests, "test/sample.test.ts", `const host = "${HOST_NAME.toLowerCase()}";\n`);
    only(check(inTests), "no-host-names", "test/sample.test.ts");
  });

  test("(c) a Node built-in reachable from a browser-safe entry fails", () => {
    const root = cleanFixture();
    write(root, "src/helper.ts", 'import { readFileSync } from "node:fs";\nexport const helper = (file: string): string => readFileSync(file, "utf8");\n');
    only(check(root), "browser-safe-entries", "src/helper.ts");

    const bare = cleanFixture();
    write(bare, "src/meta/sample.ts", 'import * as path from "path";\nexport const label = path.basename("/x/Sample");\n');
    only(check(bare), "browser-safe-entries", "src/meta/sample.ts");
  });

  test("(d) a static import of effect or of an optional vendor SDK in src/ fails", () => {
    const vendor = cleanFixture();
    write(vendor, "src/drivers/sample/index.ts", 'import { Agent } from "@cursor/sdk";\nexport const agent = Agent;\n');
    only(check(vendor), "no-static-optional-imports", "src/drivers/sample/index.ts");

    const effect = cleanFixture();
    write(effect, "src/effect/index.ts", 'import { Effect } from "effect";\nexport const succeed = Effect.succeed;\n');
    only(check(effect), "no-static-optional-imports", "src/effect/index.ts");
  });

  test("(e) a built file importing a bare package fails unless it is a Node built-in in a Node-only subpath or an optional peer through import()", () => {
    const bare = cleanFixture();
    write(bare, "dist/helper.js", 'import pad from "left-pad";\nexport const helper = (value) => pad(value.trim(), 4);\n');
    only(check(bare), "dist-imports", "dist/helper.js");

    const builtinInCore = cleanFixture();
    write(builtinInCore, "dist/helper.js", 'import { readFileSync } from "node:fs";\nexport const helper = (file) => readFileSync(file, "utf8");\n');
    only(check(builtinInCore), "dist-imports", "dist/helper.js");

    const staticPeer = cleanFixture();
    write(staticPeer, "dist/drivers/sample/index.js", 'import { Agent } from "@cursor/sdk";\nexport const load = async () => Agent;\n');
    only(check(staticPeer), "dist-imports", "dist/drivers/sample/index.js");

    const undeclaredDynamic = cleanFixture();
    write(undeclaredDynamic, "dist/drivers/sample/index.js", 'export async function load() {\n  return import("some-other-sdk");\n}\n');
    only(check(undeclaredDynamic), "dist-imports", "dist/drivers/sample/index.js");
  });

  test("the command line exits non-zero and names the file and rule", () => {
    const root = cleanFixture();
    write(root, "src/drivers/sample/index.ts", 'import { Agent } from "@cursor/sdk";\nexport const agent = Agent;\n');
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "check-rules.ts"), "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/drivers\/sample\/index\.ts: \[no-static-optional-imports\]/);
  });
});
