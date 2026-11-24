// Type-level proof that the driver's own description of the Cursor SDK
// (src/drivers/cursor/sdk.ts) matches the pinned devDependency @cursor/sdk
// 1.4.2. `pnpm run typecheck` fails when either side drifts.
//
// - Sent: the SDK module is assignable to the driver's `CursorSdk`. Its
//   members are function-typed properties there, so their parameters are
//   checked strictly: every agent option, send option (`onDelta` included)
//   and MCP server config the driver can pass is one the SDK accepts.
// - Read: every SDK interaction update, run, run result, steer outcome and
//   agent handle is assignable to the driver's view of it, so every field the
//   driver reads exists in the SDK's type with a compatible type.
// - The fake: fake-sdk.ts types its module by the SDK itself, and the
//   harness and rig hand it to `createCursorDriver`, which only accepts a
//   `CursorSdk`; so every call the driver makes on the fake and every value
//   the fake gives back, in every test, is checked against the SDK's types.
//   At run time the fake also checks each update with the SDK's own
//   `InteractionUpdateSchema`, and creates and resumes agents with the real
//   SDK, which validates the driver's options itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import type * as CursorSdkModule from "@cursor/sdk";
import type { AgentOptions, InteractionUpdate, JsonlLocalAgentStore, McpServerConfig, Run, RunResult, SDKAgent, SendOptions, SteerAckOutcome, StoredSdkCredentials, ModelListItem, SDKUser } from "@cursor/sdk";
import type {
  CursorAgentOptions,
  CursorInteractionUpdate,
  CursorMcpServerConfig,
  CursorModel,
  CursorRun,
  CursorRunResult,
  CursorSdk,
  CursorSdkAgent,
  CursorSendOptions,
  CursorSteerOutcome,
  CursorStoredLogin,
  CursorUser,
} from "../../../src/drivers/cursor/sdk.ts";
import type { FakeCursorSdkModule } from "./fake-sdk.ts";

type Is<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;

// What the driver sends is what the SDK accepts.
export type SentChecks = [
  Is<Assignable<CursorAgentOptions<JsonlLocalAgentStore>, AgentOptions>>,
  Is<Assignable<CursorAgentOptions<JsonlLocalAgentStore>, Partial<AgentOptions>>>,
  Is<Assignable<CursorSendOptions, SendOptions>>,
  Is<Assignable<CursorMcpServerConfig, McpServerConfig>>,
];

// What the SDK gives back has every field the driver reads.
export type ReadChecks = [
  Is<Assignable<InteractionUpdate, CursorInteractionUpdate>>,
  Is<Assignable<Run, CursorRun>>,
  Is<Assignable<RunResult, CursorRunResult>>,
  Is<Assignable<SteerAckOutcome, CursorSteerOutcome>>,
  Is<Assignable<SDKAgent, CursorSdkAgent>>,
  Is<Assignable<StoredSdkCredentials, CursorStoredLogin>>,
  Is<Assignable<ModelListItem, CursorModel>>,
  Is<Assignable<SDKUser, CursorUser>>,
];

// The whole module, the real one and the fake one.
export type ModuleChecks = [Is<Assignable<typeof CursorSdkModule, CursorSdk<JsonlLocalAgentStore>>>, Is<Assignable<FakeCursorSdkModule, CursorSdk<JsonlLocalAgentStore>>>];

test("the driver's SDK types match @cursor/sdk 1.4.2 (checked by pnpm run typecheck; this file fails to compile otherwise)", async () => {
  const sdk = await import("@cursor/sdk");
  // The members the driver calls exist at run time too.
  for (const member of [sdk.Agent.create, sdk.Agent.resume, sdk.Cursor.me, sdk.Cursor.models.list, sdk.FileCredentialStore, sdk.JsonlLocalAgentStore]) assert.equal(typeof member, "function");
});
