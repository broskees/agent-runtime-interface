// The adapter for `node:test`. It registers one test per harness with one
// subtest per scenario: a failed scenario fails its subtest with the reason,
// a scenario that does not apply is skipped with its reason, and notes become
// diagnostics.
//
// Under a runner whose `node:test` cannot run a test inside another test, the
// scenarios run in the harness's own test instead. Bun 1.3's `node:test`
// throws an error with code `ERR_NOT_IMPLEMENTED` from `context.test()` and
// from `context.skip()` inside a running test (bun issue 5090). Then every
// scenario still runs in order, its notes and its not-applicable reason
// become diagnostics, and the harness's test fails at the end with the reason
// of every failed scenario.
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

function notApplicableMessage(result: ScenarioResult): string {
  return `not applicable (${result.notApplicableBy ?? "harness"}): ${result.reason ?? ""}`;
}

function failureMessage(result: ScenarioResult): string {
  return `scenario ${result.id} (${result.key}) failed: ${result.reason ?? "no reason given"}`;
}

/** True for the error a `node:test` that lacks a feature throws when asked for it (Bun's has code `ERR_NOT_IMPLEMENTED`). */
function isNotImplemented(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ERR_NOT_IMPLEMENTED";
}

/** Registers the conformance suite for `harness` with `node:test`. */
export function conformanceTests<Config>(test: NodeTestFunction, harness: ConformanceHarness<Config>, options: ConformanceTestOptions = {}): void {
  test(`ARI conformance: ${harness.name}`, async (context) => {
    const suite = createConformanceSuite(harness, options);
    const results: ScenarioResult[] = [];
    let subtests = true;
    const inlineFailures: string[] = [];
    for (const scenario of suite.order) {
      if (subtests) {
        try {
          await context.test(subtestName(scenario), async (subtest) => {
            const result = await suite.run(scenario);
            results.push(result);
            for (const note of result.notes) subtest.diagnostic(note);
            if (result.status === "not_applicable") {
              subtest.skip(notApplicableMessage(result));
              return;
            }
            if (result.status === "failed") throw new Error(failureMessage(result));
          });
          continue;
        } catch (error) {
          // Refused before the subtest started, so the scenario has not run: run it and the rest inline.
          if (!isNotImplemented(error)) throw error;
          subtests = false;
        }
      }
      const result = await suite.run(scenario);
      results.push(result);
      const name = subtestName(result);
      for (const note of result.notes) context.diagnostic(`${name}: ${note}`);
      if (result.status === "not_applicable") context.diagnostic(`${name}: skipped, ${notApplicableMessage(result)}`);
      if (result.status === "failed") inlineFailures.push(failureMessage(result));
    }
    results.sort((a, b) => a.id - b.id);
    await options.onReport?.({ harness: harness.name, results, passed: results.every((result) => result.status !== "failed") });
    if (inlineFailures.length > 0) throw new Error(inlineFailures.join("\n"));
  });
}
