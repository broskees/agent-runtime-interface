// applyPatch follows ACP v2 patch semantics: omitted is unchanged, null
// clears, a value replaces, nested objects and arrays are replaced whole, and
// neither input is mutated.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { applyPatch, ItemSchema } from "../src/index.ts";
import type { Item, ItemPatch } from "../src/index.ts";
import { REPO_ROOT } from "./helpers/spec.ts";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function baseItem(): Item {
  return {
    id: "item-1",
    kind: "mcp_tool_call",
    native: { id: "call-1", strength: "strong" },
    status: "running",
    title: "Search the docs",
    output: "partial",
    tool: { server: "docs", name: "search", input: { query: "patch" } },
    paths: ["a.ts", "b.ts"],
  };
}

describe("applyPatch", () => {
  test("a field the patch omits is unchanged", () => {
    const result = applyPatch(baseItem(), { id: "item-1", status: "completed" });
    assert.equal(result.title, "Search the docs");
    assert.equal(result.output, "partial");
    assert.equal(result.status, "completed");
  });

  test("a field set to undefined counts as omitted", () => {
    const result = applyPatch(baseItem(), { id: "item-1", title: undefined });
    assert.equal(result.title, "Search the docs");
  });

  test("a null field is cleared", () => {
    const patch: ItemPatch = { id: "item-1", title: null, output: null };
    const result = applyPatch(baseItem(), patch);
    assert.equal("title" in result, false);
    assert.equal("output" in result, false);
    assert.equal(ItemSchema.is(result), true);
  });

  test("a value replaces the field", () => {
    const result = applyPatch(baseItem(), { id: "item-1", output: "full output", exitCode: 0 });
    assert.equal(result.output, "full output");
    assert.equal(result.exitCode, 0);
  });

  test("nested objects and arrays are replaced whole, never merged", () => {
    const result = applyPatch(baseItem(), { id: "item-1", tool: { name: "fetch" }, paths: ["c.ts"] });
    assert.deepEqual(result.tool, { name: "fetch" }, "the old server and input are gone");
    assert.deepEqual(result.paths, ["c.ts"]);
  });

  test("the input objects are not mutated", () => {
    const target = deepFreeze(baseItem());
    const patch = deepFreeze({ id: "item-1", status: "completed", title: null, tool: { name: "fetch" } } satisfies ItemPatch);
    const targetBefore = structuredClone(target);
    const patchBefore = structuredClone(patch);
    const result = applyPatch(target, patch);
    assert.notEqual(result, target);
    assert.deepEqual(target, targetBefore);
    assert.deepEqual(patch, patchBefore);
  });

  test("an entity opens from its first patch, and unknown fields survive", () => {
    const opened = applyPatch<Item & { vendorField?: string }>(undefined, {
      id: "item-2",
      kind: "assistant_message",
      native: { id: null, strength: "none", ordinal: 0 },
      status: "running",
      vendorField: "kept",
      title: null,
    });
    assert.deepEqual(opened, {
      id: "item-2",
      kind: "assistant_message",
      native: { id: null, strength: "none", ordinal: 0 },
      status: "running",
      vendorField: "kept",
    });
  });

  test("the doc comment states the rule for nested objects", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "src", "patch.ts"), "utf8");
    assert.match(source, /Nested objects and arrays are replaced whole, never merged/);
  });
});
