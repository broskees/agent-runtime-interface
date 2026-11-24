// The test suite runs under Node (`pnpm run test`) and under Bun
// (`pnpm run test:bun`, scripts/test-bun.ts). The gate runs both; `gate:bun`,
// the gate of CI's Bun leg, runs every other gate step and the Bun one. The
// Bun run leaves a file out only when test/bun-excluded.txt lists it with the
// Node-only feature it needs.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { EXCLUSION_LIST, parseExclusions, testFiles } from "../scripts/test-bun.ts";
import { REPO_ROOT } from "./helpers/spec.ts";

describe("the Bun test run", () => {
  test("runs the files node --test runs: every test/**/*.test.ts and nothing else", () => {
    const files = testFiles(REPO_ROOT);
    assert.ok(files.includes("test/test-bun.test.ts"));
    assert.ok(files.includes("test/drivers/claude/conformance.test.ts"), "files in nested directories are found");
    assert.ok(files.every((file) => file.startsWith("test/") && file.endsWith(".test.ts")));
    assert.ok(!files.some((file) => file.endsWith(".e2e.ts") || file.endsWith(".suite.ts")));
  });

  test("leaves out only files the committed list names, each with the Node-only feature it needs", () => {
    const files = testFiles(REPO_ROOT);
    const exclusions = parseExclusions(fs.readFileSync(path.join(REPO_ROOT, EXCLUSION_LIST), "utf8"), files);
    for (const exclusion of exclusions) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, exclusion.file)), exclusion.file);
      assert.ok(exclusion.feature.length > 0, exclusion.file);
    }
    // The Bun run must still be most of the suite.
    assert.ok(exclusions.length < files.length / 10, `${exclusions.length} of ${files.length} files are left out`);
  });

  test("refuses a list line for a file the suite does not run, a line without a feature, and a file listed twice", () => {
    const files = ["test/a.test.ts", "test/b.test.ts"];
    assert.deepEqual(parseExclusions("# a comment\n\ntest/a.test.ts: Node's module hooks\n", files), [{ file: "test/a.test.ts", feature: "Node's module hooks" }]);
    assert.throws(() => parseExclusions("test/missing.test.ts: anything\n", files), /line 1: test\/missing\.test\.ts is not a test file the suite runs/);
    assert.throws(() => parseExclusions("test/a.test.ts\n", files), /line 1: write "<test file>: <the Node-only feature it needs>"/);
    assert.throws(() => parseExclusions("test/a.test.ts: \n", files), /line 1: write/);
    assert.throws(() => parseExclusions("test/a.test.ts: one\ntest/a.test.ts: two\n", files), /line 2: test\/a\.test\.ts is listed twice/);
  });
});

describe("the gate scripts", () => {
  const scripts = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const steps = (name: string): string[] => scripts[name]!.split(" && ");

  test("gate runs the test suite under Node and then under Bun", () => {
    const gate = steps("gate");
    assert.equal(scripts["test:bun"], "node scripts/test-bun.ts");
    assert.equal(gate[gate.indexOf("pnpm run test") + 1], "pnpm run test:bun");
  });

  test("gate:bun runs every gate step, with the test suite under Bun only", () => {
    assert.deepEqual(
      steps("gate:bun"),
      steps("gate").filter((step) => step !== "pnpm run test"),
    );
  });
});
