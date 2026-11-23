// Building blocks for the Effect schemas that scripts/codegen-effect.ts
// generates into src/effect/generated/. Each one makes an Effect schema accept
// exactly what the JSON Schema in spec/v1 accepts, and so what ARI's
// zero-dependency validators (src/validation.ts) accept, where Effect's own
// schemas differ:
//
// - JSON Schema `integer` is any integral number. `Schema.Int` accepts only
//   safe integers, so `Integer` checks `Number.isInteger` instead.
// - ARI objects are open: fields the schema does not name are allowed and kept.
//   `Schema.Struct` would strip them, so object schemas add `OtherFields` as an
//   index signature, which keeps them in the decoded value.
// - A required field whose value is `undefined` counts as missing, as
//   `JSON.stringify` drops it. Objects whose required fields would otherwise
//   accept `undefined` (such as `Schema.Unknown`) check them with `hasFields`.

import type { Schema as EffectSchema } from "effect";
import { Schema } from "./effect-modules.ts";

/** JSON Schema `integer`: a finite number with no fractional part, of any size. */
export const Integer = Schema.Finite.check(
  Schema.makeFilter((value: number) => Number.isInteger(value), { expected: "an integer" }),
);

/** The index signature that keeps the fields an object schema does not name. */
export const OtherFields = Schema.Record(Schema.String, Schema.Unknown);

function hasField(value: { readonly [key: string]: unknown }, key: string): boolean {
  return Object.hasOwn(value, key) && value[key] !== undefined;
}

/** Every field in `names` is present and not `undefined`. */
export function hasFields(names: readonly string[]) {
  return Schema.makeFilter((value: { readonly [key: string]: unknown }) => names.every((name) => hasField(value, name)), {
    expected: `an object with the fields ${names.join(", ")}`,
  });
}

/**
 * For objects without declared properties: a JSON Schema `anyOf` or `oneOf`
 * whose branches only list required fields. `anyOf` needs at least one branch
 * to hold and `oneOf` exactly one.
 */
export function hasFieldAlternatives(alternatives: ReadonlyArray<readonly string[]>, mode: "anyOf" | "oneOf") {
  return Schema.makeFilter(
    (value: { readonly [key: string]: unknown }) => {
      const holding = alternatives.filter((names) => names.every((name) => hasField(value, name))).length;
      return mode === "anyOf" ? holding > 0 : holding === 1;
    },
    { expected: `${mode === "anyOf" ? "at least" : "exactly"} one of these field sets: ${alternatives.map((names) => names.join(" + ")).join(", ")}` },
  );
}

/** JSON Schema `not`: the value must not match `excluded`. */
export function not(excluded: EffectSchema.Top) {
  const matches = Schema.is(excluded);
  return Schema.makeFilter((value: unknown) => !matches(value), { expected: "a value that does not match the excluded schema" });
}
