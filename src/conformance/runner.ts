// Runs the scenarios against a harness and builds the report.
//
// Scenario 1 (the event grammar) judges every stream the suite produced, so
// it runs after the others; the report still lists results in scenario order.
// Each scenario runs with fresh rigs and cleans up after itself, so one
// failing scenario does not change another's result.

import { ScenarioContext, ScenarioNotApplicable } from "./context.ts";
import type { SuiteState } from "./context.ts";
import type { ConformanceHarness, ConformanceWorkspace } from "./harness.ts";
import type { ConformanceReport, ScenarioResult } from "./report.ts";
import { SCENARIOS } from "./scenarios/index.ts";
import type { Scenario } from "./scenarios/index.ts";
import { realNow } from "./util.ts";

export interface ConformanceOptions {
  /** Run only these scenarios, by number or key. Defaults to all 15. */
  readonly scenarios?: ReadonlyArray<number | string>;
  /** The longest real-time wait for any one step, in milliseconds. Defaults to 10000. */
  readonly timeoutMs?: number;
}

/** A run of the suite whose scenarios can be run one at a time, as the `node:test` adapter does. */
export interface ConformanceSuite {
  /** The scenarios to run, in the order to run them (scenario 1 last). */
  readonly order: readonly Scenario[];
  /** Runs one scenario of `order`. */
  run(scenario: Scenario): Promise<ScenarioResult>;
}

function selected(options: ConformanceOptions): Scenario[] {
  const wanted = options.scenarios;
  const scenarios = wanted === undefined ? [...SCENARIOS] : SCENARIOS.filter((scenario) => wanted.includes(scenario.id) || wanted.includes(scenario.key));
  if (wanted !== undefined) {
    for (const name of wanted) {
      if (!SCENARIOS.some((scenario) => scenario.id === name || scenario.key === name)) throw new TypeError(`unknown conformance scenario ${JSON.stringify(name)}`);
    }
  }
  // The grammar scenario judges the streams the others produced.
  return [...scenarios.filter((scenario) => scenario.id !== 1), ...scenarios.filter((scenario) => scenario.id === 1)];
}

/** Prepares a run of the suite against `harness`. */
export function createConformanceSuite<Config>(harness: ConformanceHarness<Config>, options: ConformanceOptions = {}): ConformanceSuite {
  const order = selected(options);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const suite: SuiteState = { violations: [], streams: 0 };
  let workspace: Promise<ConformanceWorkspace> | undefined;
  const genericHarness = harness as ConformanceHarness<unknown>;

  return {
    order,
    async run(scenario) {
      const started = realNow();
      const context = new ScenarioContext({ harness: genericHarness, workspace: { cwd: "" }, scenarioKey: scenario.key, timeoutMs, suite });
      const finish = (fields: Pick<ScenarioResult, "status"> & Partial<ScenarioResult>): ScenarioResult => ({
        id: scenario.id,
        key: scenario.key,
        title: scenario.title,
        notes: [...context.notes],
        fixtures: [...context.fixtures],
        durationMs: realNow() - started,
        ...fields,
      });
      let reason: string | undefined;
      try {
        reason = context.harnessReason(scenario.key);
      } catch (error) {
        return finish({ status: "failed", reason: (error as Error).message });
      }
      if (reason !== undefined) return finish({ status: "not_applicable", notApplicableBy: "harness", reason });

      let outcome: Pick<ScenarioResult, "status"> & Partial<ScenarioResult>;
      try {
        workspace ??= harness.workspace();
        const ready = new ScenarioContext({ harness: genericHarness, workspace: await workspace, scenarioKey: scenario.key, timeoutMs, suite });
        try {
          await scenario.run(ready);
          outcome = { status: "passed" };
        } catch (error) {
          if (error instanceof ScenarioNotApplicable) outcome = { status: "not_applicable", notApplicableBy: error.by, reason: error.message };
          else outcome = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
        } finally {
          await ready.cleanup();
          context.notes.push(...ready.notes);
          context.fixtures.push(...ready.fixtures);
        }
      } catch (error) {
        outcome = { status: "failed", reason: `the harness's workspace failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      return finish(outcome);
    },
  };
}

/** Runs the suite against `harness` and returns the report. */
export async function runConformance<Config>(harness: ConformanceHarness<Config>, options: ConformanceOptions = {}): Promise<ConformanceReport> {
  const suite = createConformanceSuite(harness, options);
  const results: ScenarioResult[] = [];
  for (const scenario of suite.order) results.push(await suite.run(scenario));
  results.sort((a, b) => a.id - b.id);
  return { harness: harness.name, results, passed: results.every((result) => result.status !== "failed") };
}
