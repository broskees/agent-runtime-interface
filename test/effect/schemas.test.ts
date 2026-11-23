// The Effect schemas generated from spec/v1 (`ari/effect`) accept and reject
// exactly what the zero-dependency validators of `ari` accept and reject: the
// 38 event examples (one valid and one invalid body for each of the 19 event
// variants), thousands of mutations of them and of a recorded session stream,
// and the forward-compatibility cases. Decoding keeps unknown values.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Exit, Schema } from "effect";
import * as ari from "../../src/index.ts";
import type { Validator } from "../../src/index.ts";
import * as ariEffect from "../../src/effect/index.ts";
import { envelope, EVENT_BODY_EXAMPLES, withoutRequiredField } from "../fixtures/event-examples.ts";
import { sessionEvents } from "../fixtures/session-stream.ts";

type EffectSchema = Schema.Codec<unknown>;

function effectSchemaFor(validator: Validator<unknown>): EffectSchema {
  const schema = (ariEffect as Record<string, unknown>)[`${validator.name}Schema`];
  assert.ok(Schema.isSchema(schema), `ari/effect has no Effect schema named ${validator.name}Schema`);
  return schema as EffectSchema;
}

function effectAccepts(schema: EffectSchema, value: unknown): boolean {
  return Exit.isSuccess(Schema.decodeUnknownExit(schema)(value));
}

describe("one Effect schema per definition", () => {
  test("every validator of the root export has an Effect schema of the same name in ari/effect", () => {
    const validatorNames = Object.keys(ari).filter((name) => name.endsWith("Schema") && "~standard" in (ari as unknown as Record<string, object>)[name]!);
    assert.ok(validatorNames.length > 250, `found ${validatorNames.length} validators`);
    for (const name of validatorNames) {
      assert.ok(Schema.isSchema((ariEffect as Record<string, unknown>)[name]), `ari/effect is missing ${name}`);
    }
    const effectNames = Object.keys(ariEffect).filter((name) => name.endsWith("Schema"));
    assert.deepEqual(effectNames.sort(), validatorNames.sort());
  });
});

describe("the 38 event examples", () => {
  test("covers the 19 variants with one valid and one invalid body each", () => {
    assert.equal(EVENT_BODY_EXAMPLES.length, 19);
    assert.equal(new Set(EVENT_BODY_EXAMPLES.map((example) => example.variant)).size, 19);
  });

  for (const example of EVENT_BODY_EXAMPLES) {
    const valid = example.body;
    const invalid = withoutRequiredField(example);

    test(`${example.variant}: the Effect schemas and the validators accept the valid body`, () => {
      const variantSchema = effectSchemaFor(example.validator);
      assert.equal(example.validator.is(valid), true);
      assert.equal(effectAccepts(variantSchema, valid), true);
      assert.equal(ari.AriEventBodySchema.is(valid), true);
      assert.equal(effectAccepts(ariEffect.AriEventBodySchema, valid), true);
      assert.equal(ari.AriEventSchema.is(envelope(valid)), true);
      assert.equal(effectAccepts(ariEffect.AriEventSchema, envelope(valid)), true);
    });

    test(`${example.variant}: the Effect schemas and the validators reject the body without "${example.requiredField}"`, () => {
      const variantSchema = effectSchemaFor(example.validator);
      assert.equal(example.validator.is(invalid), false);
      assert.equal(effectAccepts(variantSchema, invalid), false);
      assert.equal(ari.AriEventBodySchema.is(invalid), false);
      assert.equal(effectAccepts(ariEffect.AriEventBodySchema, invalid), false);
      assert.equal(ari.AriEventSchema.is(envelope(invalid)), false);
      assert.equal(effectAccepts(ariEffect.AriEventSchema, envelope(invalid)), false);
    });
  }

  test("the rejection names the missing field", () => {
    const example = EVENT_BODY_EXAMPLES.find((candidate) => candidate.variant === "session.replaced")!;
    const exit = Schema.decodeUnknownExit(effectSchemaFor(example.validator))(withoutRequiredField(example));
    assert.ok(Exit.isFailure(exit));
    assert.match(String(exit.cause), /contextLost/);
  });
});

// ---------------------------------------------------------------------------
// Mutations: every field removed, nulled, retyped or renamed, at every depth.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a copy of `root` with `change` applied to the value at `path`. */
function changeAt(root: unknown, path: readonly (string | number)[], change: (parent: Record<string, unknown> | unknown[], key: string | number) => void): unknown {
  const copy = structuredClone(root);
  let parent = copy as Record<string, unknown> | unknown[];
  for (const key of path.slice(0, -1)) parent = (parent as Record<string | number, unknown>)[key] as Record<string, unknown> | unknown[];
  change(parent, path[path.length - 1]!);
  return copy;
}

function paths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  const found: (string | number)[][] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push([...prefix, index]);
      found.push(...paths(item, [...prefix, index]));
    });
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      found.push([...prefix, key]);
      found.push(...paths(item, [...prefix, key]));
    }
  }
  return found;
}

const REPLACEMENTS: readonly unknown[] = [null, 0, -1, 1.5, 2 ** 60, "", "x:vendor.thing", "hibernating", true, [], {}, [1], { id: "z" }];

function* mutants(value: unknown): Generator<unknown> {
  for (const path of paths(value)) {
    yield changeAt(value, path, (parent, key) => {
      if (Array.isArray(parent)) parent.splice(key as number, 1);
      else delete parent[key as string];
    });
    for (const replacement of REPLACEMENTS) {
      yield changeAt(value, path, (parent, key) => {
        (parent as Record<string | number, unknown>)[key] = structuredClone(replacement);
      });
    }
    yield changeAt(value, path, (parent, key) => {
      const target = (parent as Record<string | number, unknown>)[key];
      if (isRecord(target)) target["x-extra"] = { kept: true };
    });
  }
}

describe("mutations of every example", () => {
  test("the Effect AriEvent schema and the AriEvent validator give the same verdict on every mutation", () => {
    const seeds = [
      ...EVENT_BODY_EXAMPLES.flatMap((example) => [envelope(example.body), envelope(withoutRequiredField(example))]),
      ...sessionEvents(),
    ];
    let compared = 0;
    let accepted = 0;
    const disagreements: string[] = [];
    for (const seed of seeds) {
      for (const mutant of [seed, ...mutants(seed)]) {
        const ariVerdict = ari.AriEventSchema.is(mutant);
        const effectVerdict = effectAccepts(ariEffect.AriEventSchema, mutant);
        compared++;
        if (ariVerdict) accepted++;
        if (ariVerdict !== effectVerdict && disagreements.length < 5) {
          disagreements.push(`validator ${ariVerdict}, Effect ${effectVerdict}: ${JSON.stringify(mutant)}`);
        }
      }
    }
    assert.deepEqual(disagreements, []);
    assert.ok(compared > 10_000, `compared ${compared} values`);
    assert.ok(accepted > 1_000 && compared - accepted > 1_000, `accepted ${accepted} of ${compared}: both verdicts must be well represented`);
  });
});

describe("forward compatibility and decoded values", () => {
  const cases: Array<[string, unknown]> = [
    ["a session.state event with state hibernating", envelope({ type: "session.state", state: "hibernating" })],
    [
      "an item.upsert whose item kind is x:vendor.widget",
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
    ],
    ["an event of type x:vendor.ping", envelope({ type: "x:vendor.ping", data: { at: 42 }, fallback: { title: "Ping" } })],
  ];
  for (const [name, event] of cases) {
    test(`${name} decodes, with every unknown value kept`, () => {
      assert.equal(ari.AriEventSchema.is(event), true);
      const decoded = Schema.decodeUnknownSync(ariEffect.AriEventSchema)(event);
      assert.deepEqual(decoded, event);
    });
  }

  test("an unknown core event type without the x: prefix is rejected by both", () => {
    const event = envelope({ type: "turn.paused" });
    assert.equal(ari.AriEventSchema.is(event), false);
    assert.equal(effectAccepts(ariEffect.AriEventSchema, event), false);
  });

  test("every event of a recorded session decodes to an equal value", () => {
    for (const event of sessionEvents()) {
      assert.deepEqual(Schema.decodeUnknownSync(ariEffect.AriEventSchema)(event), event);
    }
  });

  test("an integer beyond 2^53 is an integer, as in JSON Schema", () => {
    const event = { ...envelope({ type: "session.state", state: "ready" }), seq: 2 ** 60 };
    assert.equal(ari.AriEventSchema.is(event), true);
    assert.equal(effectAccepts(ariEffect.AriEventSchema, event), true);
    assert.equal(effectAccepts(ariEffect.AriEventSchema, { ...event, seq: 1.5 }), false);
  });
});

describe("undefined object fields", () => {
  test("an undefined optional field counts as absent and an undefined required field as missing, in both", () => {
    const withUndefinedOptionals = {
      ...envelope({ type: "notice", level: "info", code: undefined, text: "hi" }),
      threadId: undefined,
      native: undefined,
    };
    assert.equal(ari.AriEventSchema.is(withUndefinedOptionals), true);
    assert.equal(effectAccepts(ariEffect.AriEventSchema, withUndefinedOptionals), true);

    const withUndefinedRequired = envelope({ type: "notice", level: "info", text: undefined });
    assert.equal(ari.AriEventSchema.is(withUndefinedRequired), false);
    assert.equal(effectAccepts(ariEffect.AriEventSchema, withUndefinedRequired), false);
  });

  test("a required field whose schema allows any value is still missing when undefined", () => {
    const ping = envelope({ type: "x:vendor.ping", data: undefined });
    assert.equal(ari.AriEventSchema.is(ping), false);
    assert.equal(effectAccepts(ariEffect.AriEventSchema, ping), false);
  });

  test("outside JSON data they differ in one place: a map entry whose value is undefined", () => {
    // JSON cannot carry `undefined`, so on any JSON value the two agree. ARI's
    // validators skip an undefined map value, as `JSON.stringify` would drop
    // it. The Effect schema's decoded type says every map value is present,
    // so it rejects the entry instead of decoding a value its type denies.
    const options = { env: { HOME: "/home/user", PATH: undefined } };
    assert.equal(ari.SpawnRequestSchema.is({ command: "agent", ...options }), true);
    assert.equal(effectAccepts(ariEffect.SpawnRequestSchema, { command: "agent", ...options }), false);
    const sent = JSON.parse(JSON.stringify({ command: "agent", ...options }));
    assert.equal(ari.SpawnRequestSchema.is(sent), true);
    assert.equal(effectAccepts(ariEffect.SpawnRequestSchema, sent), true);
  });
});
