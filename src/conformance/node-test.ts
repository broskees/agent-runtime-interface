// The adapter for `node:test`. It registers one test per harness with one
// subtest per scenario: a failed scenario fails its subtest with the reason,
// a scenario that does not apply is skipped with its reason, and notes become
// diagnostics.
//
// The adapter takes `node:test`'s `test` function as an argument instead of
// importing `node:test`, so `ari/conformance` stays free of Node built-ins and
// loads in a browser. Pass it the real function:
//
//   import test from "node:test";
//   import { conformanceTests } from "ari/conformance";
//   conformanceTests(test, myHarness);

import type { ConformanceHarness } from "./harness.ts";
import type { ConformanceReport, ScenarioResult } from "./report.ts";
import { createConformanceSuite } from "./runner.ts";
import type { ConformanceOptions } from "./runner.ts";

/** The part of `node:test`'s `TestContext` the adapter uses. */
export interface NodeTestContext {
  test(name: string, fn: (context: NodeTestContext) => Promise<void>): Promise<void>;
  skip(message?: string): void;
  diagnostic(message: string): void;
}

/** The part of `node:test`'s `test` function the adapter uses. */
export type NodeTestFunction = (name: string, fn: (context: NodeTestContext) => Promise<void>) => unknown;

export interface ConformanceTestOptions extends ConformanceOptions {
  /** Called with the whole report once every scenario ran, for example to write the fixtures somewhere. */
  readonly onReport?: (report: ConformanceReport) => void | Promise<void>;
}

function subtestName(result: Pick<ScenarioResult, "id" | "key" | "title">): string {
  return `scenario ${result.id} (${result.key}): ${result.title}`;
}

/** Registers the conformance suite for `harness` with `node:test`. */
export function conformanceTests<Config>(test: NodeTestFunction, harness: ConformanceHarness<Config>, options: ConformanceTestOptions = {}): void {
  test(`ARI conformance: ${harness.name}`, async (context) => {
    const suite = createConformanceSuite(harness, options);
    const results: ScenarioResult[] = [];
    for (const scenario of suite.order) {
      await context.test(subtestName(scenario), async (subtest) => {
        const result = await suite.run(scenario);
        results.push(result);
        for (const note of result.notes) subtest.diagnostic(note);
        if (result.status === "not_applicable") {
          subtest.skip(`not applicable (${result.notApplicableBy ?? "harness"}): ${result.reason ?? ""}`);
          return;
        }
        if (result.status === "failed") throw new Error(`scenario ${result.id} (${result.key}) failed: ${result.reason ?? "no reason given"}`);
      });
    }
    results.sort((a, b) => a.id - b.id);
    await options.onReport?.({ harness: harness.name, results, passed: results.every((result) => result.status !== "failed") });
  });
}
