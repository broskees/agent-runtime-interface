// The 15 conformance scenarios, in their numbered order.

import { authStatesScenario, sideEffectFreeProbeScenario } from "./account.ts";
import { capabilityHonestyScenario } from "./capabilities.ts";
import { duplicateAlwaysScenario, idempotentResponsesScenario } from "./requests.ts";
import type { Scenario } from "./scenario.ts";
import { replayFromSeqScenario, sessionReplacedScenario, symlinkedWorkspaceScenario } from "./sessions.ts";
import {
  completedScenario,
  failedScenario,
  grammarScenario,
  interruptedScenario,
  processExitScenario,
  settlementScenario,
  steerAfterEndScenario,
} from "./turns.ts";

export const SCENARIOS: readonly Scenario[] = [
  grammarScenario,
  completedScenario,
  interruptedScenario,
  failedScenario,
  processExitScenario,
  settlementScenario,
  steerAfterEndScenario,
  duplicateAlwaysScenario,
  sessionReplacedScenario,
  authStatesScenario,
  symlinkedWorkspaceScenario,
  sideEffectFreeProbeScenario,
  replayFromSeqScenario,
  capabilityHonestyScenario,
  idempotentResponsesScenario,
];

export type { Scenario } from "./scenario.ts";
