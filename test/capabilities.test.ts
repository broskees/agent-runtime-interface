// The Capabilities schema holds the 12 groups and every §7 addition, and the
// capability helpers report on and off paths and throw `unsupported` for off.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  capabilityValue,
  CapabilitiesSchema,
  hasCapability,
  isAriError,
  isCallError,
  requireCapability,
} from "../src/index.ts";
import type { Capabilities } from "../src/index.ts";
import { fullCapabilities } from "./fixtures/capabilities.ts";
import { resolveSpecRef } from "./helpers/spec.ts";
import type { JsonObject } from "./helpers/spec.ts";

// One path that is on and one that is off in the fixture, for each group.
const GROUP_PATHS: ReadonlyArray<{ group: string; on: string; off: string; expected?: unknown }> = [
  { group: "sessions", on: "sessions.switchModel", off: "sessions.switchRuntimeMode" },
  { group: "threads", on: "threads.fork.fromTurn", off: "threads.rollback" },
  { group: "turns", on: "turns.steer", off: "turns.queue" },
  { group: "streaming", on: "streaming.assistantText", off: "streaming.reasoning" },
  { group: "tools", on: "tools.mcpApps", off: "tools.dynamicTools" },
  { group: "approvals", on: "approvals.command", off: "approvals.fileRead" },
  { group: "planning", on: "planning.todoList", off: "planning.proposedPlan" },
  { group: "subagents", on: "subagents.stop", off: "subagents.wait" },
  { group: "context", on: "context.instructionChannels", off: "context.syntheticContext" },
  { group: "checkpointing", on: "checkpointing.conversationRollback", off: "checkpointing.workspace" },
  { group: "identity", on: "identity.turnIds", off: "identity.requestIds" },
  { group: "runtimePolicy", on: "runtimePolicy.modes.full_access", off: "runtimePolicy.modes.auto" },
];

// The additions of the §7 table, as schema paths inside Capabilities.
const ADDITIONS = [
  "requests.responseModes",
  "requests.allowCustomAnswer",
  "requests.approvalScopes",
  "threads.fork.fromTurn",
  "threads.fork.fromItem",
  "threads.fork.fromSubagent",
  "threads.fork.crossCwd",
  "turns.multiNativeTurnsPerRequest",
  "turns.steeringInterruptsTools",
  "background.list",
  "background.stop",
  "background.await",
  "background.tasksEndWithProcess",
  "mcp.acceptsHostServers",
  "mcp.scope",
  "sessionModel",
  "externallyOwned",
  "diffs.emits",
  "diffs.canDisable",
  "context.instructionChannels",
  "contextWindowReporting",
  "extensions",
  "ariVersion",
];

const RUNTIME_MODES = ["read_only", "approval_required", "auto_accept_edits", "auto", "full_access"];

/** Follows a dotted path through the Capabilities schema, resolving $refs. */
function schemaAt(pathText: string): JsonObject {
  let current = resolveSpecRef("capabilities.schema.json#/$defs/Capabilities");
  for (const segment of pathText.split(".")) {
    const properties = (current.node as JsonObject).properties as JsonObject | undefined;
    const child = properties?.[segment] as JsonObject | undefined;
    assert.ok(child, `Capabilities schema has no ${pathText} (stopped at ${segment})`);
    current = typeof child.$ref === "string" ? resolveSpecRef(child.$ref, current.relPath) : { relPath: current.relPath, node: child };
  }
  return current.node as JsonObject;
}

describe("Capabilities schema", () => {
  test("a complete capabilities object validates, and each top-level group is required", () => {
    assert.equal(CapabilitiesSchema.is(fullCapabilities()), true);
    for (const group of GROUP_PATHS.map((entry) => entry.group)) {
      const caps = fullCapabilities() as unknown as Record<string, unknown>;
      delete caps[group];
      const result = CapabilitiesSchema["~standard"].validate(caps);
      assert.ok(!(result instanceof Promise) && result.issues?.some((issue) => issue.path?.[0] === group), group);
    }
  });

  test("the schema has the 12 groups", () => {
    for (const { group } of GROUP_PATHS) assert.equal(schemaAt(group).type, "object", group);
    assert.equal(GROUP_PATHS.length, 12);
  });

  test("the schema has every addition of the §7 table", () => {
    for (const addition of ADDITIONS) {
      assert.ok(schemaAt(addition), addition);
      assert.notEqual(capabilityValue(fullCapabilities(), addition), undefined, `the fixture sets ${addition}`);
    }
  });

  test("each of the 5 runtime modes declares native or client_boundary enforcement", () => {
    for (const mode of RUNTIME_MODES) {
      const support = schemaAt(`runtimePolicy.modes.${mode}`);
      assert.deepEqual(support.required, ["supported", "enforcement"], mode);
      const enforcement = schemaAt(`runtimePolicy.modes.${mode}.enforcement`);
      assert.deepEqual((enforcement.anyOf as JsonObject[])[0]!.enum, ["native", "client_boundary"]);
    }
  });
});

describe("capability helpers", () => {
  for (const { group, on, off } of GROUP_PATHS) {
    test(`${group}: ${on} is on and ${off} is off`, () => {
      const caps = fullCapabilities();
      assert.equal(hasCapability(caps, on), true);
      assert.doesNotThrow(() => requireCapability(caps, on));
      assert.equal(hasCapability(caps, off), false);
      assert.throws(
        () => requireCapability(caps, off),
        (error: unknown) => {
          assert.ok(isAriError(error, "unsupported"));
          const data: unknown = JSON.parse(JSON.stringify(error));
          assert.ok(isCallError(data, "unsupported"));
          assert.equal(data.capability, off);
          return true;
        },
      );
    });
  }

  test("a missing path is off", () => {
    assert.equal(hasCapability(fullCapabilities(), "threads.teleport"), false);
    assert.equal(capabilityValue(fullCapabilities(), "threads.teleport.deeper"), undefined);
  });

  test("an expected value checks equality or array membership", () => {
    const caps: Capabilities = fullCapabilities();
    assert.equal(hasCapability(caps, "context.instructionChannels", "system"), true);
    assert.equal(hasCapability(caps, "context.instructionChannels", "first_user_message"), false);
    assert.equal(hasCapability(caps, "sessionModel", "process_per_instance"), true);
    assert.throws(() => requireCapability(caps, "mcp.scope", "thread"), (error: unknown) => isAriError(error, "unsupported"));
  });
});
