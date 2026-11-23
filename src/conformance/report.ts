// The conformance report: one result per scenario.

import type { Fixture } from "../generated/fixture.ts";
import type { EventGrammarViolation } from "../host/event-grammar.ts";

export type ScenarioStatus = "passed" | "failed" | "not_applicable";

export interface ScenarioResult {
  /** The scenario's number, 1 to 15, as the appendix of the acceptance criteria and docs/conformance.md list them. */
  readonly id: number;
  /** The stable key, such as `settlement`. Harness reasons are keyed by it. */
  readonly key: string;
  readonly title: string;
  readonly status: ScenarioStatus;
  /** Why the scenario failed, or why it does not apply. */
  readonly reason?: string;
  /** What made it not applicable: a declared capability or member, or the harness's stated reason. */
  readonly notApplicableBy?: "capability" | "harness";
  /** Checks inside the scenario that were skipped for a stated reason, and other facts worth showing. */
  readonly notes: readonly string[];
  /** One replay fixture per session the scenario opened, in the format of spec/v1/fixture.schema.json. */
  readonly fixtures: readonly Fixture[];
  readonly durationMs: number;
}

export interface ConformanceReport {
  readonly harness: string;
  /** In scenario order, 1 to 15 (only those run). */
  readonly results: readonly ScenarioResult[];
  /** True when no scenario failed. */
  readonly passed: boolean;
}

/** A grammar violation seen on one of the suite's event streams. */
export interface RecordedViolation {
  readonly scenario: string;
  readonly sessionId: string;
  readonly violation: EventGrammarViolation;
}

/** A one-line summary per scenario, for logs. */
export function formatReport(report: ConformanceReport): string {
  const lines = [`ARI conformance: ${report.harness}: ${report.passed ? "passed" : "FAILED"}`];
  for (const result of report.results) {
    const status = result.status === "not_applicable" ? `not applicable (${result.notApplicableBy ?? "harness"})` : result.status;
    lines.push(`  ${String(result.id).padStart(2)} ${result.key}: ${status}${result.reason === undefined ? "" : `: ${result.reason}`}`);
    for (const note of result.notes) lines.push(`       note: ${note}`);
  }
  return lines.join("\n");
}
