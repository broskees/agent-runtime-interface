// `ari/conformance`: the conformance kit. The 15 scenarios, the harness
// interface a driver author implements, the fake host that records every
// host-service call, the `node:test` adapter, replay fixtures, virtual time,
// and the in-memory reference driver that passes every scenario.
// docs/conformance.md explains how to plug a driver in.
//
// Browser-safe: nothing reachable from here imports a Node built-in. The
// scenarios import no test runner; the `node:test` adapter takes `node:test`'s
// `test` function as an argument.

export { SCENARIOS } from "./scenarios/index.ts";
export type { Scenario } from "./scenarios/index.ts";
export { GATED_MEMBERS } from "./scenarios/capabilities.ts";
export { SETTLEMENT_PAUSE_MS } from "./scenarios/turns.ts";
export { MUTATING_HOST_OPERATIONS } from "./scenarios/account.ts";

export { createConformanceSuite, runConformance } from "./runner.ts";
export type { ConformanceOptions, ConformanceSuite } from "./runner.ts";
export { formatReport } from "./report.ts";
export type { ConformanceReport, RecordedViolation, ScenarioResult, ScenarioStatus } from "./report.ts";

export type {
  AmbientAuthArrangement,
  CapabilityExercise,
  ConformanceHarness,
  ConformanceWorkspace,
  HarnessRig,
  InstanceArrangement,
  InstanceFileWatch,
  NativeAgent,
  NativeApproval,
  NativeApprovalHandle,
  NativeApprovalOption,
  NativeFailure,
  NativeSessionState,
  NativeTool,
  NativeTurn,
  RigRequest,
} from "./harness.ts";

export { HOST_OPERATIONS, createFakeHost } from "./fake-host.ts";
export type { FakeHost, FakeHostOptions, FakeSpawnRequest, HostCall, HostOperation } from "./fake-host.ts";

export { conformanceTests } from "./node-test.ts";
export type { ConformanceTestOptions, NodeTestContext, NodeTestFunction } from "./node-test.ts";

export { SUPPORTED_FIXTURE_PERSISTENCE, checkFixture, loadFixture } from "./fixtures.ts";
export type { FixtureCheck } from "./fixtures.ts";

export { VirtualClock } from "./virtual-clock.ts";
export type { VirtualTimerHandle } from "./virtual-clock.ts";
export { ConformanceFailure } from "./util.ts";
export { ScenarioContext, ScenarioNotApplicable } from "./context.ts";
export type { CreatedInstance, InstanceOptions, OpenedSession, ScenarioClock } from "./context.ts";

export { REFERENCE_CLI_MANIFEST, REFERENCE_CONFIG_SCHEMA, REFERENCE_POISON_MS, referenceCapabilities, referenceDriver } from "./reference/driver.ts";
export type { ReferenceDriverConfig } from "./reference/driver.ts";
export { REFERENCE_WORKSPACE, referenceHarness, referenceNativeTurn } from "./reference/harness.ts";
export type { ReferenceHarnessOptions } from "./reference/harness.ts";
export { ReferenceAgent } from "./reference/agent.ts";
export type { ReferenceAgentIo, ReferenceAgentOptions } from "./reference/agent.ts";
export { MemoryReferenceStore } from "./reference/store.ts";
export type { ReferenceStore } from "./reference/store.ts";
export { createMemoryProcess } from "./reference/memory-process.ts";
export type { MemoryProcess, MemoryProcessHandlers } from "./reference/memory-process.ts";
export { REFERENCE_AGENT_VERSION, REFERENCE_ERRORS } from "./reference/protocol.ts";
export type * from "./reference/protocol.ts";
