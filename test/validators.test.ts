// The generated validators: Standard Schema v1 and Standard JSON Schema v1,
// the same verdicts as Ajv on the normative schema, issue paths that name the
// missing field, and the forward-compatibility rule (unknown enum values and
// `x:` variants validate and come back unchanged).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as ari from "../src/index.ts";
import type { Validator } from "../src/index.ts";
import { envelope, EVENT_BODY_EXAMPLES, withoutRequiredField } from "./fixtures/event-examples.ts";
import { createSpecAjv, defId } from "./helpers/spec.ts";

function allValidators(): Array<[string, Validator<unknown>]> {
  return Object.entries(ari).filter(
    (entry): entry is [string, Validator<unknown>] =>
      entry[0].endsWith("Schema") && typeof entry[1] === "object" && entry[1] !== null && "~standard" in entry[1],
  );
}

function validate(validator: Validator<unknown>, value: unknown): ari.StandardSchemaV1.Result<unknown> {
  const result = validator["~standard"].validate(value);
  assert.ok(!(result instanceof Promise), "ARI validators are synchronous");
  return result;
}

function refsIn(node: unknown, refs: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((child) => refsIn(child, refs));
  else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") refs.push(value);
      else refsIn(value, refs);
    }
  }
  return refs;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("Standard Schema v1 and Standard JSON Schema v1", () => {
  const validators = allValidators();

  test("every generated validator exposes ~standard with version 1, vendor and validate", () => {
    assert.ok(validators.length > 250, `expected one validator per definition, found ${validators.length}`);
    for (const [exportName, validator] of validators) {
      const props = validator["~standard"];
      assert.equal(props.version, 1, exportName);
      assert.equal(props.vendor, "ari", exportName);
      assert.equal(typeof props.validate, "function", exportName);
      assert.equal(typeof props.jsonSchema.input, "function", exportName);
      assert.equal(typeof props.jsonSchema.output, "function", exportName);
      assert.equal(`${validator.name}Schema`, exportName);
    }
  });

  test("jsonSchema produces self-contained draft 2020-12 and draft-07 schemas for every validator", () => {
    for (const [exportName, validator] of validators) {
      const modern = validator["~standard"].jsonSchema.input({ target: "draft-2020-12" });
      assert.equal(modern.$schema, "https://json-schema.org/draft/2020-12/schema", exportName);
      const legacy = validator["~standard"].jsonSchema.output({ target: "draft-07" });
      assert.equal(legacy.$schema, "http://json-schema.org/draft-07/schema#", exportName);
      for (const ref of refsIn(modern)) assert.match(ref, /^#\/\$defs\/[A-Za-z0-9]+$/, `${exportName}: ${ref} must be local`);
      for (const ref of refsIn(legacy)) assert.match(ref, /^#\/definitions\/[A-Za-z0-9]+$/, `${exportName}: ${ref} must be local`);
      assert.equal(legacy.$defs, undefined, `${exportName}: draft-07 output uses definitions`);
    }
  });

  test("jsonSchema throws for a target it does not support", () => {
    assert.throws(() => ari.AriEventSchema["~standard"].jsonSchema.input({ target: "openapi-3.0" }), /draft-2020-12 and draft-07/);
  });

  test("Ajv accepts the jsonSchema output in both drafts and agrees with the validator", () => {
    const modern = new Ajv2020({ strict: false }).compile(ari.AriEventSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" }));
    const legacy = new Ajv({ strict: false }).compile(ari.AriEventSchema["~standard"].jsonSchema.input({ target: "draft-07" }));
    for (const example of EVENT_BODY_EXAMPLES) {
      const valid = envelope(example.body);
      const invalid = envelope(withoutRequiredField(example));
      assert.equal(modern(valid), true, `${example.variant}: ${JSON.stringify(modern.errors)}`);
      assert.equal(legacy(valid), true, `${example.variant}: ${JSON.stringify(legacy.errors)}`);
      assert.equal(modern(invalid), false, example.variant);
      assert.equal(legacy(invalid), false, example.variant);
    }
  });
});

describe("each of the 19 event body variants", () => {
  test("covers every variant exactly once", () => {
    assert.equal(EVENT_BODY_EXAMPLES.length, 19);
    assert.equal(new Set(EVENT_BODY_EXAMPLES.map((example) => example.variant)).size, 19);
  });

  for (const example of EVENT_BODY_EXAMPLES) {
    test(`${example.variant}: a valid example validates`, () => {
      assert.equal(validate(example.validator, example.body).issues, undefined);
      assert.equal(validate(ari.AriEventBodySchema, example.body).issues, undefined);
      assert.equal(validate(ari.AriEventSchema, envelope(example.body)).issues, undefined);
    });

    test(`${example.variant}: removing required field "${example.requiredField}" is rejected with an issue at that field`, () => {
      const invalid = withoutRequiredField(example);
      const alone = validate(example.validator, invalid);
      assert.ok(alone.issues, "expected issues");
      assert.ok(
        alone.issues.some((issue) => JSON.stringify(issue.path) === JSON.stringify([example.requiredField])),
        `issues were ${JSON.stringify(alone.issues)}`,
      );
      const wrapped = validate(ari.AriEventSchema, envelope(invalid));
      assert.ok(wrapped.issues, "expected issues");
      assert.ok(
        wrapped.issues.some((issue) => JSON.stringify(issue.path) === JSON.stringify(["body", example.requiredField])),
        `issues were ${JSON.stringify(wrapped.issues)}`,
      );
    });
  }

  test("Ajv on the normative schema gives the same verdicts as the generated validators", () => {
    const ajv = createSpecAjv();
    const ajvEvent = ajv.getSchema(defId("events.schema.json", "AriEvent"))!;
    for (const example of EVENT_BODY_EXAMPLES) {
      for (const event of [envelope(example.body), envelope(withoutRequiredField(example))]) {
        assert.equal(ari.AriEventSchema.is(event), ajvEvent(event), `${example.variant}: ${JSON.stringify(event.body)}`);
      }
    }
  });
});

describe("forward compatibility: unknown values validate and come back unchanged", () => {
  test("a session.state event with state hibernating", () => {
    const event = deepFreeze(envelope({ type: "session.state", state: "hibernating" }));
    const before = structuredClone(event);
    const result = validate(ari.AriEventSchema, event);
    assert.equal(result.issues, undefined);
    assert.ok(!result.issues);
    assert.equal(result.value, event, "the validator returns the same object");
    assert.deepEqual(result.value, before);
  });

  test("an item.upsert whose item kind is x:vendor.widget", () => {
    const event = deepFreeze(
      envelope({
        type: "item.upsert",
        item: {
          id: "item-9",
          kind: "x:vendor.widget",
          native: { id: null, strength: "none", ordinal: 3 },
          status: "completed",
          data: { dials: [1, 2, 3] },
          fallback: { title: "Widget", text: "A vendor widget" },
          vendorOnlyField: "kept",
        },
      }),
    );
    const before = structuredClone(event);
    const result = validate(ari.AriEventSchema, event);
    assert.equal(result.issues, undefined);
    assert.ok(!result.issues);
    assert.equal(result.value, event);
    assert.deepEqual(result.value, before);
  });

  test("an event of type x:vendor.ping", () => {
    const event = deepFreeze(envelope({ type: "x:vendor.ping", data: { at: 42 }, fallback: { title: "Ping" } }));
    const before = structuredClone(event);
    const result = validate(ari.AriEventSchema, event);
    assert.equal(result.issues, undefined);
    assert.ok(!result.issues);
    assert.equal(result.value, event);
    assert.deepEqual(result.value, before);
  });

  test("an unknown core event type without the x: prefix is still rejected", () => {
    const result = validate(ari.AriEventSchema, envelope({ type: "turn.paused" }));
    assert.ok(result.issues && result.issues.length > 0);
  });
});

describe("undefined object fields", () => {
  test("an undefined optional field counts as absent and an undefined required field as missing, as JSON and Ajv treat them", () => {
    const ajvEvent = createSpecAjv().getSchema(defId("events.schema.json", "AriEvent"))!;
    const withUndefinedOptionals = {
      ...envelope({ type: "notice", level: "info", code: undefined, text: "hi" }),
      threadId: undefined,
      native: undefined,
    };
    assert.equal(validate(ari.AriEventSchema, withUndefinedOptionals).issues, undefined);
    assert.equal(ajvEvent(withUndefinedOptionals), true);

    const withUndefinedRequired = envelope({ type: "notice", level: "info", text: undefined });
    const result = validate(ari.AriEventSchema, withUndefinedRequired);
    assert.deepEqual(result.issues, [{ message: 'Missing required field "text"', path: ["body", "text"] }]);
    assert.equal(ajvEvent(withUndefinedRequired), false);
  });
});

describe("validator conveniences", () => {
  test("is() and parse() agree with validate()", () => {
    const good = envelope({ type: "notice", level: "info", text: "hi" });
    assert.equal(ari.AriEventSchema.is(good), true);
    assert.equal(ari.AriEventSchema.parse(good), good);
    const bad = envelope({ type: "notice", level: "info" });
    assert.equal(ari.AriEventSchema.is(bad), false);
    assert.throws(
      () => ari.AriEventSchema.parse(bad),
      (error: unknown) => ari.isAriError(error, "validation") && /body\.text/.test((error as Error).message),
    );
  });

  test("a wrong type reports the received type", () => {
    const result = validate(ari.NativeRefSchema, { id: 7, strength: "strong" });
    assert.deepEqual(result.issues, [{ message: "Expected string or null, received number", path: ["id"] }]);
  });
});
