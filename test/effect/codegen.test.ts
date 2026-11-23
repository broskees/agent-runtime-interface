// The Effect Schema generator (scripts/codegen-effect.ts): its drift check
// fails whenever a committed module under src/effect/generated is stale; on a
// schema that uses every keyword the generator translates, its Effect schemas
// give the same verdict as ARI's validators on every sample value; and a shape
// it cannot translate exactly fails generation with a message.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";
import { CodegenError, writeGenerated } from "../../scripts/codegen.ts";
import { EFFECT_OUTPUT_DIR, findEffectDrift, generateEffect, writeEffectGenerated } from "../../scripts/codegen-effect.ts";
import { REPO_ROOT } from "../helpers/spec.ts";

const CODEGEN_EFFECT = path.join(REPO_ROOT, "scripts", "codegen-effect.ts");
const EXTENSION_ID = "https://ari.invalid/spec/v1/extensions/";

const tempDirs: string[] = [];
after(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

/** A temp root with a copy of spec/ and of the given repository directories. */
function tempRoot(directories: readonly string[]): string {
  const root = tempDir("ari-codegen-effect-");
  for (const directory of ["spec", ...directories]) fs.cpSync(path.join(REPO_ROOT, directory), path.join(root, directory), { recursive: true });
  return root;
}

function writeExtension(root: string, name: string, defs: Record<string, unknown>): void {
  const document = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: `${EXTENSION_ID}${name}.schema.json`, $defs: defs };
  fs.writeFileSync(path.join(root, "spec", "v1", "extensions", `${name}.schema.json`), JSON.stringify(document, null, 2));
}

function runCheck(root: string) {
  return spawnSync(process.execPath, [CODEGEN_EFFECT, "--check", "--root", root], { encoding: "utf8" });
}

describe("the Effect codegen drift check", () => {
  test("passes on the committed tree", () => {
    assert.deepEqual(findEffectDrift(REPO_ROOT), []);
  });

  test("passes on a faithful copy and fails when one schema changes", () => {
    const root = tempRoot([EFFECT_OUTPUT_DIR]);
    const passing = runCheck(root);
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /codegen:effect:check passed/);

    const eventsFile = path.join(root, "spec", "v1", "events.schema.json");
    const events = JSON.parse(fs.readFileSync(eventsFile, "utf8"));
    events.$defs.NoticeBody.properties.severity = { type: "integer" };
    fs.writeFileSync(eventsFile, JSON.stringify(events, null, 2));
    const failing = runCheck(root);
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /src\/effect\/generated\/events\.ts differs from the spec/);
  });

  test("fails on a missing module and on a stray one", () => {
    const missing = tempRoot([EFFECT_OUTPUT_DIR]);
    fs.rmSync(path.join(missing, EFFECT_OUTPUT_DIR, "thread.ts"));
    const missingResult = runCheck(missing);
    assert.equal(missingResult.status, 1);
    assert.match(missingResult.stderr, /src\/effect\/generated\/thread\.ts is missing/);

    const stray = tempRoot([EFFECT_OUTPUT_DIR]);
    fs.writeFileSync(path.join(stray, EFFECT_OUTPUT_DIR, "stray.ts"), "export {};\n");
    const strayResult = runCheck(stray);
    assert.equal(strayResult.status, 1);
    assert.match(strayResult.stderr, /src\/effect\/generated\/stray\.ts is not produced by codegen/);
  });

  test("an extension schema gets its own module and changes no other", () => {
    const root = tempRoot([EFFECT_OUTPUT_DIR]);
    writeExtension(root, "x.sample", { SampleThing: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } });
    assert.deepEqual(findEffectDrift(root), [`${EFFECT_OUTPUT_DIR}/extensions/x.sample.ts is missing`]);
  });
});

// ---------------------------------------------------------------------------
// Every keyword the generator translates, checked against ARI's validators.

const KEYWORD_DEFS: Record<string, unknown> = {
  KwPattern: { type: "string", pattern: "^[a-z]+-[0-9]+$" },
  KwLength: { type: "string", minLength: 2, maxLength: 3 },
  KwNumberRange: { type: "number", minimum: 0, maximum: 10, exclusiveMinimum: -1, exclusiveMaximum: 10 },
  KwInteger: { type: "integer", exclusiveMinimum: 0 },
  KwTypes: { type: ["string", "integer", "null"], minLength: 1, minimum: 5 },
  KwConstNull: { const: null },
  KwConstNumber: { type: "number", const: 2 },
  KwEnum: { enum: ["a", 1, true, null] },
  KwArray: { type: "array", items: { type: "boolean" }, minItems: 1, maxItems: 2 },
  KwAnyArray: { type: "array" },
  KwTuple: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], minItems: 2, maxItems: 2 },
  KwEmptyArray: { type: "array", items: false },
  KwMap: { type: "object", additionalProperties: { type: "integer" } },
  KwClosedEmpty: { type: "object", additionalProperties: false },
  KwOpenObject: { type: "object" },
  KwObject: { type: "object", properties: { a: { type: "string" }, b: {} }, required: ["a", "b", "c"] },
  KwAnyOfFields: {
    type: "object",
    properties: { p: { type: "string" }, q: { type: "string" } },
    anyOf: [{ required: ["p"] }, { required: ["q"] }],
  },
  KwOneOfFields: {
    type: "object",
    properties: { p: { type: "string" }, q: { type: "string" } },
    oneOf: [{ required: ["p"] }, { required: ["q"] }],
  },
  KwFieldsNoProperties: { type: "object", oneOf: [{ required: ["p"] }, { required: ["q"] }] },
  KwRequiredNoProperties: { type: "object", required: ["z"] },
  KwAllOf: {
    allOf: [{ $ref: "#/$defs/KwObject" }, { type: "object", properties: { d: { type: "boolean" } }, required: ["d"] }, { description: "noted" }],
  },
  KwUnionAnyOf: { anyOf: [{ type: "string" }, { type: "integer", minimum: 10 }] },
  KwUnionOneOf: { oneOf: [{ type: "integer" }, { type: "number", minimum: 0 }] },
  KwNot: { type: "string", not: { const: "forbidden" } },
  KwNotRef: { $ref: "#/$defs/KwPattern", not: { const: "ab-1" } },
  KwTrue: true,
  KwFalse: false,
  KwAnything: { description: "Any value." },
  KwExtensionName: { type: "string", pattern: "^x:" },
  KwNullableRef: { anyOf: [{ $ref: "#/$defs/KwInteger" }, { type: "null" }] },
  KwRecursive: {
    type: "object",
    properties: { value: { type: "integer" }, next: { $ref: "#/$defs/KwRecursive" } },
    required: ["value"],
  },
  KwCrossFile: { type: "object", properties: { native: { $ref: "../common.schema.json#/$defs/NativeRef" } }, required: ["native"] },
};

const SAMPLES: readonly unknown[] = [
  undefined,
  null,
  true,
  false,
  0,
  1,
  -3,
  2,
  5,
  2.5,
  9.5,
  10,
  11,
  2 ** 60,
  Number.NaN,
  "",
  "a",
  "ab",
  "abcd",
  "\u{1F600}\u{1F600}",
  "\u{1F600}\u{1F600}\u{1F600}\u{1F600}",
  "ab-1",
  "abc-22",
  "x:",
  "x:vendor\nline",
  "forbidden",
  [],
  [true],
  [true, false],
  [true, false, true],
  ["s", 1],
  ["s", 1.5],
  ["s"],
  ["s", 1, 2],
  {},
  { a: "s", b: 1, c: 2 },
  { a: "s", b: 1 },
  { a: "s", b: undefined, c: 1 },
  { a: "s", b: null, c: null, extra: [1] },
  { a: "s", b: 1, c: 1, d: true },
  { a: "s", b: 1, c: 1, d: "no" },
  { p: "x" },
  { q: "y" },
  { p: "x", q: "y" },
  { p: 1 },
  { z: 1 },
  { z: undefined },
  { k: 1, l: 2 },
  { k: 1.5 },
  { value: 1 },
  { value: 1, next: { value: 2, next: { value: 3 } } },
  { value: 1, next: { value: "no" } },
  { native: { id: "n", strength: "strong" } },
  { native: { id: "n" } },
];

type Verdict = (value: unknown) => boolean;

/** The definitions that restrict `additionalProperties` and declare no properties: maps. */
const MAP_DEFS = new Set(["KwMap", "KwClosedEmpty"]);

/** JSON text that shows undefined values instead of dropping them. */
function describeValue(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value, (_key, item: unknown) => (item === undefined ? "<undefined>" : item));
}

describe("every keyword the generator translates", () => {
  let validators: Record<string, { is: Verdict }> = {};
  let effectIs: (name: string) => Verdict = () => () => false;

  before(async () => {
    // A copy of the repository's sources with a synthetic extension schema,
    // generated by both code generators, loading `effect` from this checkout.
    const root = tempRoot(["src"]);
    fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
    writeExtension(root, "x.keywords", KEYWORD_DEFS);
    writeGenerated(root);
    writeEffectGenerated(root);
    const moduleUrl = (relative: string): string => pathToFileURL(path.join(root, relative)).href;
    validators = await import(moduleUrl("src/generated/extensions/x.keywords.ts"));
    const effectSchemas = (await import(moduleUrl(`${EFFECT_OUTPUT_DIR}/extensions/x.keywords.ts`))) as Record<string, unknown>;
    const { Schema } = await import(moduleUrl("src/effect/effect-modules.ts"));
    effectIs = (name) => Schema.is(effectSchemas[`${name}Schema`]);
  });

  test("the Effect schemas give the same verdicts as the validators on every sample", () => {
    const disagreements: string[] = [];
    for (const name of Object.keys(KEYWORD_DEFS)) {
      const validator = validators[`${name}Schema`]!;
      const effect = effectIs(name);
      let accepted = 0;
      for (const sample of SAMPLES) {
        const expected = validator.is(sample);
        const actual = effect(sample);
        if (expected) accepted++;
        // The one documented difference outside JSON data: a map entry whose
        // value is undefined, in an object whose other fields are restricted
        // by additionalProperties (see test/effect/schemas.test.ts).
        if (MAP_DEFS.has(name) && sample !== null && typeof sample === "object" && Object.values(sample).includes(undefined)) {
          assert.equal(actual, false, `${name}: ${String(sample)}`);
          continue;
        }
        if (expected !== actual) disagreements.push(`${name}: validator ${expected}, Effect ${actual} for ${describeValue(sample)}`);
      }
      if (name !== "KwFalse") assert.ok(accepted > 0, `${name}: no sample is accepted, so the comparison proves little`);
      if (name !== "KwTrue" && name !== "KwAnything") assert.ok(accepted < SAMPLES.length, `${name}: every sample is accepted`);
    }
    assert.deepEqual(disagreements, []);
  });

  test("oneOf rejects a value that matches two branches, as JSON Schema does", () => {
    assert.equal(validators.KwUnionOneOfSchema!.is(5), false);
    assert.equal(effectIs("KwUnionOneOf")(5), false);
    assert.equal(effectIs("KwUnionOneOf")(-3), true);
    assert.equal(effectIs("KwUnionOneOf")(2.5), true);
  });

  test("string lengths count code points", () => {
    assert.equal(effectIs("KwLength")("\u{1F600}\u{1F600}"), true);
    assert.equal(effectIs("KwLength")("\u{1F600}\u{1F600}\u{1F600}\u{1F600}"), false);
  });
});

describe("shapes the generator cannot translate exactly fail generation", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["an object const", { const: { a: 1 } }, /"const" values must be strings, numbers, booleans or null/],
    ["a tuple of variable length", { type: "array", prefixItems: [{ type: "string" }] }, /"prefixItems" needs "minItems" equal to its length/],
    ["$ref next to a validation keyword", { $ref: "#/$defs/BadOther", minimum: 1 }, /"\$ref" cannot be combined with minimum/],
    ["properties without a type", { properties: { a: { type: "string" } } }, /properties need a "type"/],
    ["an enum value outside its type", { type: "string", enum: ["a", 1] }, /"enum" value 1 does not match "type"/],
    [
      "allOf members that disagree on a property",
      { allOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { a: { type: "integer" } } }] },
      /"allOf" members give property "a" different schemas/,
    ],
  ];
  for (const [label, schema, message] of cases) {
    test(label, () => {
      const root = tempRoot([]);
      writeExtension(root, "x.bad", { BadShape: schema, BadOther: { type: "integer" } });
      assert.throws(
        () => generateEffect(root),
        (error: unknown) => error instanceof CodegenError && message.test(error.message) && error.message.includes("spec/v1/extensions/x.bad.schema.json"),
      );
    });
  }
});
