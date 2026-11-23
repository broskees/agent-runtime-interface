// The normative JSON Schema in spec/v1: every file is a valid draft 2020-12
// schema, every reference resolves, and every type, event variant and item
// kind the contract requires has a definition.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { createSpecAjv, defId, resolveSpecRef, SPEC_DIR, specSchemaFiles } from "./helpers/spec.ts";
import type { JsonObject } from "./helpers/spec.ts";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

// Inventory A of the wire data types, by definition name. The "patch form"
// entry is the six patch types; the Handshake entry is checked for its four
// version fields below.
const WIRE_DATA_TYPES = [
  "RefStrength", "NativeRef", "AriEvent", "AriEventBody",
  "ThreadPatch", "TurnPatch", "ItemPatch", "RequestPatch", "SubagentPatch", "PlanPatch",
  "Failure", "FailureClass", "CallError", "Capabilities", "ConfigOption", "ConfigValues", "RuntimePolicy",
  "SlashCommand", "Skill", "Thread", "ThreadSnapshot", "Turn", "Item", "ItemKind", "Request", "Question",
  "Answer", "ApprovalScope", "Subagent", "SubagentOutcome", "Plan", "BackgroundTaskSummary", "TaskInfo",
  "UsageSnapshot", "LimitWindow", "LimitStatus", "LaunchContext", "McpServerConfig", "DynamicToolSpec",
  "ContentBlock", "HistoricalMessage", "McpTool", "McpCallResult", "StartTurnResult", "ConfigChangePlan",
  "ForkPoint", "RollbackTarget", "SessionHandle", "AuthStatus", "AuthState", "AuthMethod", "AuthFlow",
  "TransferredProfile", "InstanceStatus", "ProbeResult", "UpdateAdvisory", "ModelCatalog", "NativeSessionInfo",
  "Page", "SubProvider", "ResetCreditOutcome", "UsageRecord", "Icon", "DriverMetadata", "CliLaunchManifest",
  "EnvPolicy", "SpawnRequest", "AttachmentInfo", "HostToolServer", "DynamicToolCall", "Lease",
  "DiagnosticEntry", "TelemetryEvent", "Handshake",
];

// Inventory B: the 19 event body variants (18 named types plus the `x:` form).
const EVENT_TYPES = [
  "session.state", "session.replaced", "capabilities.updated", "config.updated", "commands.updated",
  "thread.upsert", "turn.upsert", "item.upsert", "item.delta", "request.upsert", "subagent.upsert",
  "plan.upsert", "background.updated", "usage.updated", "limits.updated", "notice", "retry", "turn.terminal",
];

// Inventory C: the 19 item kinds (plus the `x:` form, checked separately).
const ITEM_KINDS = [
  "user_message", "assistant_message", "reasoning", "command_execution", "file_change", "file_read",
  "file_search", "web_search", "mcp_tool_call", "dynamic_tool_call", "tool_call", "todo_list",
  "proposed_plan", "compaction", "review", "image", "subagent_spawn", "system_notice", "error",
];

function allDefinitions(): Map<string, { relPath: string; schema: JsonObject }> {
  const definitions = new Map<string, { relPath: string; schema: JsonObject }>();
  for (const file of specSchemaFiles()) {
    for (const [name, schema] of Object.entries(file.document.$defs as JsonObject)) {
      definitions.set(name, { relPath: file.relPath, schema: schema as JsonObject });
    }
  }
  return definitions;
}

function collectRefs(node: unknown, refs: string[]): string[] {
  if (Array.isArray(node)) node.forEach((child) => collectRefs(child, refs));
  else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") refs.push(value);
      else collectRefs(value, refs);
    }
  }
  return refs;
}

describe("spec/v1 schema files", () => {
  const files = specSchemaFiles();

  test("there are core and extension schema files", () => {
    assert.ok(files.length >= 15, `expected the core schema files, found ${files.length}`);
    assert.ok(files.some((file) => file.relPath === "events.schema.json"));
  });

  test("every file declares draft 2020-12 and passes the 2020-12 meta-schema", () => {
    const ajv = createSpecAjv();
    for (const file of files) {
      assert.equal(file.document.$schema, DRAFT_2020_12, `${file.relPath} must declare draft 2020-12`);
      const valid = ajv.validateSchema(file.document);
      assert.equal(valid, true, `${file.relPath} fails the meta-schema: ${JSON.stringify(ajv.errors)}`);
    }
  });

  test("every $ref resolves, both by hand and when Ajv compiles every definition", () => {
    const ajv = createSpecAjv();
    let resolved = 0;
    for (const file of files) {
      for (const ref of collectRefs(file.document, [])) {
        assert.doesNotThrow(() => resolveSpecRef(ref, file.relPath), `${file.relPath}: ${ref}`);
        resolved++;
      }
      for (const name of Object.keys(file.document.$defs as JsonObject)) {
        assert.doesNotThrow(() => ajv.getSchema(defId(file.relPath, name)), `${file.relPath}#/$defs/${name} must compile`);
        assert.ok(ajv.getSchema(defId(file.relPath, name)), `${file.relPath}#/$defs/${name} must compile`);
      }
    }
    assert.ok(resolved > 300, `expected the spec to cross-reference heavily, found ${resolved} references`);
  });

  test("definition names are unique across all files", () => {
    const seen = new Map<string, string>();
    for (const file of files) {
      for (const name of Object.keys(file.document.$defs as JsonObject)) {
        assert.equal(seen.get(name), undefined, `${name} is defined in ${seen.get(name)} and ${file.relPath}`);
        seen.set(name, file.relPath);
      }
    }
  });
});

describe("the spec covers the contract's inventories", () => {
  const definitions = allDefinitions();

  test("every wire data type of inventory A has a definition", () => {
    assert.equal(WIRE_DATA_TYPES.length, 74, "69 inventory entries, with the patch entry expanded to six types");
    const missing = WIRE_DATA_TYPES.filter((name) => !definitions.has(name));
    assert.deepEqual(missing, []);
  });

  test("Handshake carries ariVersion, grammarVersions, method versions and a persistence version", () => {
    const handshake = definitions.get("Handshake")!.schema;
    assert.deepEqual(handshake.required, ["ariVersion", "grammarVersions", "methodVersions", "persistenceVersion"]);
  });

  test("AriEventBody has a variant for each of the 18 named event types and the x: form", () => {
    const body = definitions.get("AriEventBody")!;
    const variants = (body.schema.oneOf as JsonObject[]).map((member) => resolveSpecRef(member.$ref as string, body.relPath));
    const types = variants.map(({ node, relPath }) => {
      const typeSchema = ((node as JsonObject).properties as JsonObject).type as JsonObject;
      if (typeSchema.const !== undefined) return typeSchema.const as string;
      const resolved = resolveSpecRef(typeSchema.$ref as string, relPath).node as JsonObject;
      assert.equal(resolved.pattern, "^x:", "the non-const variant must be the x: extension form");
      return "x:";
    });
    assert.equal(types.length, 19);
    assert.deepEqual(types.filter((type) => type !== "x:").sort(), [...EVENT_TYPES].sort());
    assert.ok(types.includes("x:"));
    assert.ok(definitions.has("ExtensionEventBody"));
  });

  test("ItemKind lists the 19 item kinds plus the x: extension form", () => {
    const itemKind = definitions.get("ItemKind")!;
    const [known, extension] = itemKind.schema.anyOf as JsonObject[];
    assert.deepEqual([...(known!.enum as string[])].sort(), [...ITEM_KINDS].sort());
    assert.equal((resolveSpecRef(extension!.$ref as string, itemKind.relPath).node as JsonObject).pattern, "^x:");
  });

  test("the shared experimental extension ari.goal has its schema under spec/v1/extensions/", () => {
    const file = path.join(SPEC_DIR, "extensions", "ari.goal.schema.json");
    assert.ok(fs.existsSync(file));
    const goal = definitions.get("AriGoal");
    assert.equal(goal?.relPath, "extensions/ari.goal.schema.json");
    assert.ok((goal!.schema.required as string[]).includes("derived"));
  });
});
