// The documents a newcomer needs. README.md's quickstart code is the committed
// code under examples/, byte for byte; each example type-checks and runs
// against the conformance kit's reference driver, installed from the packed
// tarball into a fresh project, under Node and under Bun, and prints what the
// README says it prints. README.md names every subpath and driver; LICENSE,
// SECURITY.md, CHANGELOG.md and one docs/drivers/ page per driver exist.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { TSC, installConsumer, packAsPublished, packRepositoryDependency } from "./helpers/consumer.ts";
import { REPO_ROOT } from "./helpers/spec.ts";

const DRIVERS = ["pi", "acp", "grok", "fx", "kiro", "acp-registry", "antigravity", "codex", "claude", "opencode", "cursor", "muse"];
const SUBPATH_IMPORTS = ["ari", "ari/host", "ari/driver-kit", "ari/node", "ari/wire", "ari/conformance", "ari/effect", "ari/drivers/<name>", "ari/meta/<name>", "ari/cli-manifests", "ari/json-schema/*.json"];
const EXAMPLES_DIR = path.join(REPO_ROOT, "examples");

const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

/** The code blocks README.md marks with `<!-- example: <path> -->`, by path. */
function embeddedExamples(): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const match of readme.matchAll(/<!-- example: (\S+) -->\n```ts\n([\s\S]*?)```\n/g)) blocks.set(match[1]!, match[2]!);
  return blocks;
}

/** The ```text block that follows the example `file` in README.md: what it prints. */
function documentedOutput(file: string): string {
  const start = readme.indexOf(`<!-- example: examples/${file} -->`);
  assert.ok(start !== -1, `README.md embeds examples/${file}`);
  const match = /```text\n([\s\S]*?)```/.exec(readme.slice(start));
  assert.ok(match !== null, `README.md shows what examples/${file} prints`);
  return match[1]!;
}

const tempDirs: string[] = [];
after(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

describe("README.md", () => {
  test("embeds every file under examples/ byte for byte, and nothing else as an example", () => {
    const files = fs.readdirSync(EXAMPLES_DIR).filter((name) => name.endsWith(".ts")).sort();
    assert.deepEqual(files, ["in-process.ts", "over-the-wire.ts", "reference-driver.ts"]);
    const blocks = embeddedExamples();
    assert.deepEqual([...blocks.keys()].sort(), files.map((name) => `examples/${name}`));
    for (const [file, code] of blocks) assert.equal(code, fs.readFileSync(path.join(REPO_ROOT, file), "utf8"), `README.md's copy of ${file} differs from the file`);
  });

  test("has an install section and a subpath table naming every subpath and every driver", () => {
    assert.match(readme, /^## Install$/m);
    assert.match(readme, /npm install ari/);
    const table = readme.slice(readme.indexOf("## Subpaths"), readme.indexOf("## Quickstart"));
    for (const subpath of SUBPATH_IMPORTS) assert.ok(table.includes(`| \`${subpath}\` |`), `the subpath table has a row for ${subpath}`);
    for (const name of DRIVERS) assert.ok(table.includes(`\`${name}\``), `the subpath table names the ${name} driver`);
  });

  test("states the escape hatches: host-owned x:host namespaces, your own driver, native passthrough, pin or patch", () => {
    const section = readme.slice(readme.indexOf("## Extensions and escape hatches"));
    for (const phrase of ["x:host.<name>.", "Bring your own driver", "RuntimePolicy.native", "Pin or patch"]) assert.ok(section.includes(phrase), phrase);
  });
});

describe("the other documents", () => {
  test("LICENSE is the MIT license", () => {
    const license = fs.readFileSync(path.join(REPO_ROOT, "LICENSE"), "utf8");
    assert.match(license, /^MIT License\n/);
    assert.match(license, /Permission is hereby granted, free of charge/);
  });

  test("SECURITY.md gives a reporting route and the release rules", () => {
    const security = fs.readFileSync(path.join(REPO_ROOT, "SECURITY.md"), "utf8");
    assert.match(security, /^## Reporting a vulnerability$/m);
    for (const phrase of ["trusted publishing", "--provenance", "npm audit signatures", "dependencies"]) assert.ok(security.includes(phrase), phrase);
  });

  test("CHANGELOG.md exists, and docs/drivers/ and changelogs/ have one page per driver", () => {
    assert.match(fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8"), /^# Changelog$/m);
    for (const directory of ["docs/drivers", "changelogs"]) {
      const pages = fs.readdirSync(path.join(REPO_ROOT, directory)).filter((name) => name.endsWith(".md")).sort();
      assert.deepEqual(pages, DRIVERS.map((name) => `${name}.md`).sort(), directory);
    }
  });
});

describe("the README quickstarts, run from the installed tarball", () => {
  let consumer = "";

  before(() => {
    const packDir = tempDir("ari-readme-pack-");
    const { tarball } = packAsPublished(packDir);
    consumer = tempDir("ari-readme-");
    installConsumer(consumer, [tarball, ...packRepositoryDependency("@types/node", packDir)]);
    for (const file of fs.readdirSync(EXAMPLES_DIR)) fs.copyFileSync(path.join(EXAMPLES_DIR, file), path.join(consumer, file));
  });

  test("type-check with moduleResolution nodenext", () => {
    fs.writeFileSync(
      path.join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "es2023", lib: ["es2023"], module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: false, noEmit: true, types: ["node"] },
        files: ["in-process.ts", "over-the-wire.ts", "reference-driver.ts"],
      }),
    );
    const result = spawnSync(process.execPath, [TSC, "-p", path.join(consumer, "tsconfig.json")], { cwd: consumer, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  for (const runtime of ["node", "bun"] as const) {
    for (const file of ["in-process.ts", "over-the-wire.ts"]) {
      test(`${file} runs under ${runtime === "node" ? "Node" : "Bun"} and prints what README.md shows`, () => {
        const home = tempDir("ari-readme-home-");
        const result = spawnSync(runtime === "node" ? process.execPath : "bun", [file], {
          cwd: consumer,
          encoding: "utf8",
          timeout: 60_000,
          env: { PATH: process.env["PATH"] ?? "", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") },
        });
        assert.equal(result.status, 0, `${runtime} ${file} exited ${result.status} ${result.signal ?? ""}\n${result.stdout}\n${result.stderr}`);
        assert.equal(result.stdout, documentedOutput(file));
      });
    }
  }
});
