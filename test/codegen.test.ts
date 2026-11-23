// Codegen writes one TypeScript module and one published schema per spec file,
// and `codegen --check` fails whenever a committed generated file is stale.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { findDrift, generate } from "../scripts/codegen.ts";
import { REPO_ROOT, specSchemaFiles } from "./helpers/spec.ts";

const CODEGEN = path.join(REPO_ROOT, "scripts", "codegen.ts");
const tempDirs: string[] = [];

after(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
});

/** A temp copy of the parts of the repo codegen reads and writes. */
function copyRepo(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-codegen-"));
  tempDirs.push(directory);
  for (const part of ["spec", "src/generated", "json-schema"]) {
    fs.cpSync(path.join(REPO_ROOT, part), path.join(directory, part), { recursive: true });
  }
  return directory;
}

function runCheck(root: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [CODEGEN, "--check", "--root", root], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

describe("codegen", () => {
  test("writes exactly one generated module and one published schema per spec file, plus methods.json", () => {
    const outputs = generate(REPO_ROOT);
    const files = specSchemaFiles();
    const modules = [...outputs.keys()].filter((key) => key.startsWith("src/generated/")).sort();
    const published = [...outputs.keys()].filter((key) => key.startsWith("json-schema/")).sort();
    assert.deepEqual(modules, files.map((file) => `src/generated/${file.relPath.replace(/\.schema\.json$/, ".ts")}`).sort());
    assert.deepEqual(published, [...files.map((file) => `json-schema/${file.relPath}`), "json-schema/methods.json"].sort());
  });

  test("the committed generated files match the spec", () => {
    assert.deepEqual(findDrift(REPO_ROOT), []);
  });

  test("--check passes on an unchanged copy and fails after one schema changes", () => {
    const root = copyRepo();
    assert.equal(runCheck(root).status, 0);

    const schemaPath = path.join(root, "spec", "v1", "common.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    schema.$defs.NativeRef.properties.label = { type: "string" };
    fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));

    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/generated\/common\.ts differs from the spec/);
    assert.match(result.stderr, /json-schema\/common\.schema\.json differs from the spec/);
  });

  test("--check fails on a hand-edited generated file and on a stray file", () => {
    const root = copyRepo();
    fs.appendFileSync(path.join(root, "src", "generated", "events.ts"), "\nexport const handEdited = true;\n");
    fs.writeFileSync(path.join(root, "json-schema", "stray.schema.json"), "{}\n");
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/generated\/events\.ts differs from the spec/);
    assert.match(result.stderr, /json-schema\/stray\.schema\.json is not produced by codegen/);
  });

  test("adding an extension schema adds its own generated files and changes no existing one", () => {
    const root = copyRepo();
    const extension = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://ari.invalid/spec/v1/extensions/sample.widget.schema.json",
      $defs: {
        SampleWidget: {
          type: "object",
          properties: { native: { $ref: "../common.schema.json#/$defs/NativeRef" } },
          required: ["native"],
        },
      },
    };
    fs.writeFileSync(path.join(root, "spec", "v1", "extensions", "sample.widget.schema.json"), JSON.stringify(extension, null, 2));
    assert.deepEqual(findDrift(root).sort(), [
      "json-schema/extensions/sample.widget.schema.json is missing",
      "src/generated/extensions/sample.widget.ts is missing",
    ]);
  });

  test("codegen rejects keywords outside the supported subset", () => {
    const root = copyRepo();
    const schemaPath = path.join(root, "spec", "v1", "plan.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    schema.$defs.Plan.if = { required: ["turnId"] };
    fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /keyword "if" is outside the subset codegen supports/);
  });
});
