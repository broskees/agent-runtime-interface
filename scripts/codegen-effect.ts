// Generates the Effect Schema modules of `ari/effect` from the normative JSON
// Schema in spec/v1: src/effect/generated/<file>.ts, one module per schema
// file, with one Effect schema per definition. It extends scripts/codegen.ts,
// whose spec model and keyword subset it reuses, and has its own drift check.
//
// Usage:
//   node scripts/codegen-effect.ts            write src/effect/generated
//   node scripts/codegen-effect.ts --check    exit 1 if a generated file is stale
//   --root <dir>                              run against another checkout
//
// Each Effect schema must accept exactly the values the definition accepts (the
// values ARI's zero-dependency validators accept), and its type must be the
// TypeScript type scripts/codegen.ts generates for the definition: every
// generated schema is declared as `Effect.Schema.Codec<Wire.Name>`, so the
// type-check proves the second rule. Where a schema shape has no exact Effect
// equivalent with that type, generation fails with a message naming the file
// and the place, instead of writing a schema that accepts something else.
//
// The translation, keyword by keyword:
//   $ref                 Schema.suspend(() => <Name>Schema), so modules that
//                        import each other in a cycle never read a schema
//                        before it exists
//   const, enum          Schema.Literal, Schema.Literals and Schema.Null
//   anyOf, oneOf         Schema.Union, with { mode: "oneOf" } for oneOf
//   allOf                the object members merged into one object schema
//   not                  a check that the excluded schema does not match
//   type string          Schema.String; `pattern: "^x:"` alone with it gives
//                        Schema.TemplateLiteral(["x:", Schema.String]), whose
//                        type is `x:${string}`; other patterns, minLength and
//                        maxLength (in code points) become checks
//   type number/integer  Schema.Finite / kit.Integer, plus range checks
//   type boolean/null    Schema.Boolean / Schema.Null
//   type array           Schema.mutable(Schema.Array(...)) or, for
//                        prefixItems, Schema.mutable(Schema.Tuple([...])),
//                        plus length checks
//   type object          Schema.StructWithRest(Schema.Struct(fields),
//                        [kit.OtherFields]) so unknown fields are kept, or
//                        Schema.Record(Schema.String, ...) without properties.
//                        Optional fields use Schema.optional (an undefined
//                        value counts as absent); when a required field's
//                        schema would accept undefined, the object checks it
//                        with kit.hasFields. An anyOf/oneOf of required-field
//                        alternatives becomes a union of one object schema per
//                        alternative.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNOTATION_KEYWORDS,
  CodegenError,
  EXTENSION_PATTERN,
  isAnnotationOnly,
  isRequiredOnlyUnion,
  isSchemaObject,
  jsDoc,
  listFiles,
  propertyKey,
  loadSpec,
  SpecModel,
  toPosix,
} from "./codegen.ts";
import type { Json, SchemaObject, SpecFile } from "./codegen.ts";

/** Where the generated modules go, relative to the repository root. */
export const EFFECT_OUTPUT_DIR = "src/effect/generated";

const STRING_KEYWORDS = ["pattern", "minLength", "maxLength"];
const NUMBER_KEYWORDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"];
const ARRAY_KEYWORDS = ["items", "prefixItems", "minItems", "maxItems"];
const OBJECT_KEYWORDS = ["properties", "required", "additionalProperties"];
const TYPE_KEYWORDS = new Set([...STRING_KEYWORDS, ...NUMBER_KEYWORDS, ...ARRAY_KEYWORDS, ...OBJECT_KEYWORDS]);

function fail(message: string): never {
  throw new CodegenError(message);
}

/** A generated Effect schema expression and whether it lets `undefined` through. */
interface Expression {
  readonly code: string;
  readonly acceptsUndefined: boolean;
}

interface ModuleContext {
  readonly model: SpecModel;
  /** The schema file whose module is being generated. */
  readonly file: SpecFile;
  /** Schema constants imported from other generated modules. */
  readonly valueImports: Map<SpecFile, Set<string>>;
  /** Memo for `definitionAcceptsUndefined`. */
  readonly undefinedMemo: Map<string, boolean>;
}

/** A schema node together with the file its `$ref`s are relative to. */
interface ScopedNode {
  readonly scope: SpecFile;
  readonly node: Json;
}

function where(scope: SpecFile, at: string): string {
  return `spec/v1/${scope.relPath} ${at}`;
}

function keywordsOf(node: SchemaObject): string[] {
  return Object.keys(node).filter((key) => !ANNOTATION_KEYWORDS.includes(key));
}

function constName(definition: string): string {
  return `${definition}Schema`;
}

/** `Schema.Union`, one member per line when the members do not fit on one short line. */
function unionCode(members: readonly string[], mode: "anyOf" | "oneOf"): string {
  const modeOption = mode === "oneOf" ? `, { mode: "oneOf" }` : "";
  const oneLine = members.join(", ");
  if (oneLine.length <= 80 && !oneLine.includes("\n")) return `Schema.Union([${oneLine}]${modeOption})`;
  return `Schema.Union([\n${members.map((member) => `  ${member.split("\n").join("\n  ")},`).join("\n")}\n]${modeOption})`;
}

function withChecks(base: string, checks: readonly string[]): string {
  return checks.length === 0 ? base : `${base}.check(${checks.join(", ")})`;
}

function isJsonPrimitive(value: Json): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function jsonTypeMatches(type: string, value: Json): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isSchemaObject(value);
    default:
      return false;
  }
}

function typesOf(node: SchemaObject, scope: SpecFile, at: string): string[] | undefined {
  if (node.type === undefined) return undefined;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.length === 0 || !types.every((type) => typeof type === "string")) fail(`${where(scope, at)}: "type" must be a string or a non-empty array of strings`);
  return types as string[];
}

function resolveRef(ctx: ModuleContext, scope: SpecFile, ref: string): { file: SpecFile; name: string; node: Json } {
  const target = ctx.model.resolveRef(scope, ref);
  return { file: target.file, name: target.name, node: target.file.defs.get(target.name)! };
}

/**
 * True when the definition's schema accepts `undefined`. A definition that can
 * only reach itself is taken not to, which is the least fixed point: a value
 * is accepted only through finitely many steps.
 */
function definitionAcceptsUndefined(ctx: ModuleContext, file: SpecFile, name: string): boolean {
  const key = `${file.relPath}#${name}`;
  const known = ctx.undefinedMemo.get(key);
  if (known !== undefined) return known;
  ctx.undefinedMemo.set(key, false);
  const result = expression(ctx, file, file.defs.get(name)!, `#/$defs/${name}`, { dryRun: true }).acceptsUndefined;
  ctx.undefinedMemo.set(key, result);
  return result;
}

interface ExpressionOptions {
  /** Compute without recording imports (used for the `undefined` analysis). */
  readonly dryRun?: boolean;
}

function expression(ctx: ModuleContext, scope: SpecFile, node: Json, at: string, options: ExpressionOptions = {}): Expression {
  if (node === true) return { code: "Schema.Unknown", acceptsUndefined: true };
  if (node === false) return { code: "Schema.Never", acceptsUndefined: false };
  if (!isSchemaObject(node)) fail(`${where(scope, at)}: a schema must be an object or a boolean`);
  if (isAnnotationOnly(node)) return { code: "Schema.Unknown", acceptsUndefined: true };

  if (node.not !== undefined) {
    const { not: excluded, ...rest } = node;
    const base = isAnnotationOnly(rest) ? { code: "Schema.Unknown", acceptsUndefined: true } : expression(ctx, scope, rest, at, options);
    const notCode = expression(ctx, scope, excluded, `${at}/not`, options).code;
    // Effect cannot add a check to a suspended schema; a one-member union can take one.
    const checkable = base.code.startsWith("Schema.suspend(") ? `Schema.Union([${base.code}])` : base.code;
    // Conservative: whether `undefined` gets through also depends on the excluded schema.
    return { code: withChecks(checkable, [`kit.not(${notCode})`]), acceptsUndefined: base.acceptsUndefined };
  }

  const keywords = keywordsOf(node);

  if (typeof node.$ref === "string") {
    if (keywords.length > 1) fail(`${where(scope, at)}: "$ref" cannot be combined with ${keywords.filter((key) => key !== "$ref").join(", ")}`);
    const target = resolveRef(ctx, scope, node.$ref);
    if (target.file !== ctx.file && !options.dryRun) {
      let names = ctx.valueImports.get(target.file);
      if (names === undefined) {
        names = new Set();
        ctx.valueImports.set(target.file, names);
      }
      names.add(constName(target.name));
    }
    return {
      code: `Schema.suspend(() => ${constName(target.name)})`,
      acceptsUndefined: definitionAcceptsUndefined(ctx, target.file, target.name),
    };
  }

  if (node.const !== undefined || Array.isArray(node.enum)) return literalExpression(scope, node, at, keywords);

  if (Array.isArray(node.allOf)) {
    const others = keywords.filter((key) => key !== "allOf");
    if (others.length > 0) fail(`${where(scope, at)}: "allOf" cannot be combined with ${others.join(", ")}`);
    return objectExpression(ctx, scope, mergeAllOf(ctx, scope, node, at), at, options);
  }

  const union = Array.isArray(node.anyOf) ? "anyOf" : Array.isArray(node.oneOf) ? "oneOf" : undefined;
  if (union !== undefined && !isRequiredOnlyUnion(node[union] as Json[])) {
    const others = keywords.filter((key) => key !== union);
    if (others.length > 0) fail(`${where(scope, at)}: "${union}" cannot be combined with ${others.join(", ")}`);
    const members = (node[union] as Json[]).map((member, index) => expression(ctx, scope, member, `${at}/${union}/${index}`, options));
    if (members.length === 0) fail(`${where(scope, at)}: "${union}" must not be empty`);
    return {
      code: unionCode(members.map((member) => member.code), union),
      acceptsUndefined: members.some((member) => member.acceptsUndefined),
    };
  }

  const types = typesOf(node, scope, at);
  if (types === undefined) {
    const typeKeywords = keywords.filter((key) => TYPE_KEYWORDS.has(key) || key === "anyOf" || key === "oneOf");
    fail(`${where(scope, at)}: ${typeKeywords.join(", ")} need a "type"`);
  }
  const members = types.map((type) => typedExpression(ctx, scope, node, type, at, options));
  if (members.length === 1) return members[0]!;
  return { code: unionCode(members.map((member) => member.code), "anyOf"), acceptsUndefined: false };
}

function literalExpression(scope: SpecFile, node: SchemaObject, at: string, keywords: readonly string[]): Expression {
  const keyword = node.const !== undefined ? "const" : "enum";
  const others = keywords.filter((key) => key !== keyword && key !== "type");
  if (others.length > 0) fail(`${where(scope, at)}: "${keyword}" cannot be combined with ${others.join(", ")}`);
  const values = keyword === "const" ? [node.const as Json] : (node.enum as Json[]);
  const types = typesOf(node, scope, at);
  for (const value of values) {
    if (!isJsonPrimitive(value)) fail(`${where(scope, at)}: "${keyword}" values must be strings, numbers, booleans or null`);
    if (types !== undefined && !types.some((type) => jsonTypeMatches(type, value))) {
      fail(`${where(scope, at)}: "${keyword}" value ${JSON.stringify(value)} does not match "type"`);
    }
  }
  const nonNull = values.filter((value) => value !== null).map((value) => JSON.stringify(value));
  const members: string[] = [];
  if (nonNull.length === 1) members.push(`Schema.Literal(${nonNull[0]})`);
  if (nonNull.length > 1) members.push(`Schema.Literals([${nonNull.join(", ")}])`);
  if (values.includes(null)) members.push("Schema.Null");
  if (members.length === 0) return { code: "Schema.Never", acceptsUndefined: false };
  return { code: members.length === 1 ? members[0]! : `Schema.Union([${members.join(", ")}])`, acceptsUndefined: false };
}

function typedExpression(ctx: ModuleContext, scope: SpecFile, node: SchemaObject, type: string, at: string, options: ExpressionOptions): Expression {
  switch (type) {
    case "string":
      return { code: stringExpression(node), acceptsUndefined: false };
    case "number":
    case "integer":
      return { code: numberExpression(node, type), acceptsUndefined: false };
    case "boolean":
      return { code: "Schema.Boolean", acceptsUndefined: false };
    case "null":
      return { code: "Schema.Null", acceptsUndefined: false };
    case "array":
      return { code: arrayExpression(ctx, scope, node, at, options), acceptsUndefined: false };
    case "object":
      return objectExpression(ctx, scope, { scope, node }, at, options);
    default:
      fail(`${where(scope, at)}: unknown type "${type}"`);
  }
}

function stringExpression(node: SchemaObject): string {
  const extensionName = node.pattern === EXTENSION_PATTERN;
  const checks: string[] = [];
  if (typeof node.pattern === "string" && !extensionName) checks.push(`Schema.isPattern(new RegExp(${JSON.stringify(node.pattern)}, "u"))`);
  if (typeof node.minLength === "number") checks.push(`Schema.isMinCodePoints(${node.minLength})`);
  if (typeof node.maxLength === "number") checks.push(`Schema.isMaxCodePoints(${node.maxLength})`);
  // `^x:` matches every string that starts with `x:`, as the template literal does.
  const base = extensionName ? `Schema.TemplateLiteral(["x:", Schema.String])` : "Schema.String";
  return withChecks(base, checks);
}

function numberExpression(node: SchemaObject, type: "number" | "integer"): string {
  const checks: string[] = [];
  if (typeof node.minimum === "number") checks.push(`Schema.isGreaterThanOrEqualTo(${node.minimum})`);
  if (typeof node.maximum === "number") checks.push(`Schema.isLessThanOrEqualTo(${node.maximum})`);
  if (typeof node.exclusiveMinimum === "number") checks.push(`Schema.isGreaterThan(${node.exclusiveMinimum})`);
  if (typeof node.exclusiveMaximum === "number") checks.push(`Schema.isLessThan(${node.exclusiveMaximum})`);
  return withChecks(type === "integer" ? "kit.Integer" : "Schema.Finite", checks);
}

function arrayExpression(ctx: ModuleContext, scope: SpecFile, node: SchemaObject, at: string, options: ExpressionOptions): string {
  const minItems = typeof node.minItems === "number" ? node.minItems : undefined;
  const maxItems = typeof node.maxItems === "number" ? node.maxItems : undefined;
  if (Array.isArray(node.prefixItems)) {
    // The TypeScript type of `prefixItems` is a fixed tuple, so only a fixed
    // length keeps type and values in step: every prefix element present and
    // nothing after them.
    const count = node.prefixItems.length;
    const closed = maxItems === count || node.items === false;
    if (minItems !== count || !closed) {
      fail(`${where(scope, at)}: "prefixItems" needs "minItems" equal to its length and "maxItems" equal to it (or "items": false), because its TypeScript type is a fixed tuple`);
    }
    if (maxItems !== undefined && maxItems < count) fail(`${where(scope, at)}: "maxItems" is shorter than "prefixItems"`);
    const elements = node.prefixItems.map((item, index) => expression(ctx, scope, item, `${at}/prefixItems/${index}`, options).code);
    return `Schema.mutable(Schema.Tuple([${elements.join(", ")}]))`;
  }
  const item = node.items === undefined ? "Schema.Unknown" : expression(ctx, scope, node.items, `${at}/items`, options).code;
  const checks: string[] = [];
  if (minItems !== undefined) checks.push(`Schema.isMinLength(${minItems})`);
  if (maxItems !== undefined) checks.push(`Schema.isMaxLength(${maxItems})`);
  return withChecks(`Schema.mutable(Schema.Array(${item}))`, checks);
}

/** One object property: its schema node and the file that node's refs are relative to. */
interface PropertySource {
  readonly name: string;
  readonly scope: SpecFile;
  readonly node: Json;
}

/** An object schema, possibly merged from `allOf` members that live in different files. */
interface ObjectShape {
  readonly properties: PropertySource[];
  readonly required: string[];
  readonly additional: ScopedNode | undefined;
  readonly alternatives: { readonly mode: "anyOf" | "oneOf"; readonly branches: string[][] } | undefined;
}

function objectShape(scope: SpecFile, node: SchemaObject, at: string): ObjectShape {
  const properties = isSchemaObject(node.properties) ? Object.entries(node.properties).map(([name, child]) => ({ name, scope, node: child })) : [];
  const required = Array.isArray(node.required) ? node.required.map(String) : [];
  const additional = node.additionalProperties === undefined ? undefined : { scope, node: node.additionalProperties };
  const unionKey = Array.isArray(node.anyOf) ? "anyOf" : Array.isArray(node.oneOf) ? "oneOf" : undefined;
  let alternatives: ObjectShape["alternatives"];
  if (unionKey !== undefined) {
    const branches = (node[unionKey] as Json[]).map((branch) => ((branch as SchemaObject).required as Json[]).map(String));
    if (branches.some((names) => names.length === 0)) fail(`${where(scope, at)}: a required-field alternative must name at least one field`);
    alternatives = { mode: unionKey, branches };
  }
  return { properties, required, additional, alternatives };
}

function mergeAllOf(ctx: ModuleContext, scope: SpecFile, node: SchemaObject, at: string): ObjectShape {
  const merged: ObjectShape = { properties: [], required: [], additional: undefined, alternatives: undefined };
  let sawObjectType = false;
  let alternatives: ObjectShape["alternatives"];
  const visit = (memberScope: SpecFile, member: Json, memberAt: string): void => {
    if (!isSchemaObject(member)) fail(`${where(memberScope, memberAt)}: an "allOf" member must be an object schema`);
    if (isAnnotationOnly(member)) return;
    const keywords = keywordsOf(member);
    if (typeof member.$ref === "string") {
      if (keywords.length > 1) fail(`${where(memberScope, memberAt)}: "$ref" cannot be combined with other keywords`);
      const target = resolveRef(ctx, memberScope, member.$ref);
      visit(target.file, target.node, `#/$defs/${target.name}`);
      return;
    }
    if (Array.isArray(member.allOf)) {
      if (keywords.length > 1) fail(`${where(memberScope, memberAt)}: "allOf" cannot be combined with other keywords`);
      member.allOf.forEach((child, index) => visit(memberScope, child, `${memberAt}/allOf/${index}`));
      return;
    }
    const allowed = new Set(["type", ...OBJECT_KEYWORDS, "anyOf", "oneOf"]);
    const unsupported = keywords.filter((key) => !allowed.has(key));
    if (unsupported.length > 0 || (member.type !== undefined && member.type !== "object")) {
      fail(`${where(memberScope, memberAt)}: "allOf" members must be object schemas (type, properties, required); found ${keywords.join(", ")}`);
    }
    const union = member.anyOf ?? member.oneOf;
    if (union !== undefined && !isRequiredOnlyUnion(union as Json[])) {
      fail(`${where(memberScope, memberAt)}: an "allOf" member may only use anyOf/oneOf for required-field alternatives`);
    }
    if (member.additionalProperties !== undefined && member.additionalProperties !== true) {
      fail(`${where(memberScope, memberAt)}: an "allOf" member cannot restrict additionalProperties`);
    }
    if (member.type === "object") sawObjectType = true;
    const shape = objectShape(memberScope, member, memberAt);
    for (const property of shape.properties) {
      const existing = merged.properties.find((candidate) => candidate.name === property.name);
      if (existing === undefined) {
        merged.properties.push(property);
      } else if (existing.scope !== property.scope || JSON.stringify(existing.node) !== JSON.stringify(property.node)) {
        fail(`${where(scope, at)}: "allOf" members give property "${property.name}" different schemas`);
      }
    }
    for (const name of shape.required) if (!merged.required.includes(name)) merged.required.push(name);
    if (shape.alternatives !== undefined) {
      if (alternatives !== undefined) fail(`${where(scope, at)}: only one "allOf" member may list required-field alternatives`);
      alternatives = shape.alternatives;
    }
  };
  (node.allOf as Json[]).forEach((member, index) => visit(scope, member, `${at}/allOf/${index}`));
  if (!sawObjectType) fail(`${where(scope, at)}: at least one "allOf" member must say "type": "object"`);
  return { ...merged, alternatives };
}

function objectExpression(
  ctx: ModuleContext,
  scope: SpecFile,
  source: ObjectShape | ScopedNode,
  at: string,
  options: ExpressionOptions,
): Expression {
  const shape = "properties" in source ? source : objectShape(source.scope, source.node as SchemaObject, at);
  const additional = shape.additional;
  const additionalIsOpen = additional === undefined || additional.node === true;

  if (shape.properties.length === 0) {
    const value = additionalIsOpen ? "Schema.Unknown" : expression(ctx, additional!.scope, additional!.node, `${at}/additionalProperties`, options).code;
    const checks: string[] = [];
    if (shape.required.length > 0) checks.push(`kit.hasFields(${JSON.stringify(shape.required)})`);
    if (shape.alternatives !== undefined) {
      checks.push(`kit.hasFieldAlternatives(${JSON.stringify(shape.alternatives.branches)}, ${JSON.stringify(shape.alternatives.mode)})`);
    }
    return { code: withChecks(`Schema.Record(Schema.String, ${value})`, checks), acceptsUndefined: false };
  }
  if (!additionalIsOpen) fail(`${where(scope, at)}: an object with properties cannot restrict additionalProperties`);

  const fieldCode = new Map<string, Expression>();
  for (const property of shape.properties) {
    fieldCode.set(property.name, expression(ctx, property.scope, property.node, `${at}/properties/${property.name}`, options));
  }
  const struct = (required: ReadonlySet<string>): string => {
    const lines: string[] = [];
    // Required fields whose schema would let `undefined` through. The object
    // checks them, because Effect cannot add a check to a suspended schema.
    const mustBeDefined: string[] = [];
    for (const property of shape.properties) {
      const field = fieldCode.get(property.name)!;
      const doc = isSchemaObject(property.node) ? jsDoc(property.node.description, "    ") : "";
      const isRequired = required.has(property.name);
      if (isRequired && field.acceptsUndefined) mustBeDefined.push(property.name);
      lines.push(`${doc}    ${propertyKey(property.name)}: ${isRequired ? field.code : `Schema.optional(${field.code})`},`);
    }
    // A required field the schema does not describe: any value except undefined.
    for (const name of required) {
      if (fieldCode.has(name)) continue;
      mustBeDefined.push(name);
      lines.push(`    ${propertyKey(name)}: Schema.Unknown,`);
    }
    const checks = mustBeDefined.length === 0 ? [] : [`kit.hasFields(${JSON.stringify(mustBeDefined)})`];
    return withChecks(`Schema.StructWithRest(\n  Schema.Struct({\n${lines.join("\n")}\n  }),\n  [kit.OtherFields],\n)`, checks);
  };

  if (shape.alternatives === undefined) return { code: struct(new Set(shape.required)), acceptsUndefined: false };
  for (const name of shape.alternatives.branches.flat()) {
    if (!fieldCode.has(name)) fail(`${where(scope, at)}: required-field alternative names "${name}", which is not a property`);
  }
  // One object schema per alternative, each requiring its own fields: the
  // union accepts what "at least one" (anyOf) or "exactly one" (oneOf) of the
  // alternatives accepts, and its type is the generated TypeScript union.
  const variants = shape.alternatives.branches.map((branch) => struct(new Set([...shape.required, ...branch])));
  return { code: unionCode(variants, shape.alternatives.mode), acceptsUndefined: false };
}

// ---------------------------------------------------------------------------

function relativeImport(fromModule: string, toModule: string): string {
  const relative = path.posix.relative(path.posix.dirname(fromModule), toModule);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function generateModule(model: SpecModel, file: SpecFile): string {
  const ctx: ModuleContext = { model, file, valueImports: new Map(), undefinedMemo: new Map() };
  const modulePath = `${EFFECT_OUTPUT_DIR}/${file.modulePath}.ts`;
  const declarations: string[] = [];
  for (const [name, schema] of file.defs) {
    const doc = isSchemaObject(schema) ? jsDoc(schema.description, "") : "";
    const body = expression(ctx, file, schema, `#/$defs/${name}`).code;
    declarations.push(
      `${doc}export const ${constName(name)}: Effect.Schema.Codec<Wire.${name}> = ${body}.annotate({ identifier: ${JSON.stringify(name)} });`,
    );
  }
  const usesKit = declarations.some((declaration) => declaration.includes("kit."));
  const header = [
    `// Generated by scripts/codegen-effect.ts from spec/v1/${file.relPath}. Do not edit.`,
    "// Change the schema and run `pnpm run codegen` instead.",
    "",
    `import type * as Effect from "effect";`,
    `import type * as Wire from ${JSON.stringify(relativeImport(modulePath, `src/generated/${file.modulePath}.ts`))};`,
    `import { Schema } from ${JSON.stringify(relativeImport(modulePath, "src/effect/effect-modules.ts"))};`,
  ];
  if (usesKit) header.push(`import * as kit from ${JSON.stringify(relativeImport(modulePath, "src/effect/schema-kit.ts"))};`);
  const importFiles = [...ctx.valueImports.keys()].sort((left, right) => left.relPath.localeCompare(right.relPath));
  for (const dependency of importFiles) {
    const names = [...ctx.valueImports.get(dependency)!].sort();
    header.push(`import { ${names.join(", ")} } from ${JSON.stringify(relativeImport(modulePath, `${EFFECT_OUTPUT_DIR}/${dependency.modulePath}.ts`))};`);
  }
  return `${header.join("\n")}\n\n${declarations.join("\n\n")}\n`;
}

/** Every generated Effect module, keyed by path relative to `root`. */
export function generateEffect(root: string): Map<string, string> {
  const model = new SpecModel(loadSpec(path.join(root, "spec", "v1")));
  const outputs = new Map<string, string>();
  for (const file of model.files) outputs.set(`${EFFECT_OUTPUT_DIR}/${file.modulePath}.ts`, generateModule(model, file));
  return outputs;
}

function existingGeneratedFiles(root: string): string[] {
  return listFiles(path.join(root, EFFECT_OUTPUT_DIR)).map((full) => toPosix(path.relative(root, full)));
}

/** Paths that differ from what the Effect codegen would write, are missing, or should not exist. */
export function findEffectDrift(root: string): string[] {
  const outputs = generateEffect(root);
  const drift: string[] = [];
  for (const [relative, content] of outputs) {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) drift.push(`${relative} is missing`);
    else if (fs.readFileSync(full, "utf8") !== content) drift.push(`${relative} differs from the spec`);
  }
  for (const relative of existingGeneratedFiles(root)) {
    if (!outputs.has(relative)) drift.push(`${relative} is not produced by codegen`);
  }
  return drift;
}

export function writeEffectGenerated(root: string): void {
  const outputs = generateEffect(root);
  for (const relative of existingGeneratedFiles(root)) {
    if (!outputs.has(relative)) fs.rmSync(path.join(root, relative));
  }
  for (const [relative, content] of outputs) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (!fs.existsSync(full) || fs.readFileSync(full, "utf8") !== content) fs.writeFileSync(full, content);
  }
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex === -1 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") : path.resolve(argv[rootIndex + 1] ?? ".");
  try {
    if (check) {
      const drift = findEffectDrift(root);
      if (drift.length > 0) {
        process.stderr.write(`codegen:effect:check failed. Run \`pnpm run codegen\`.\n${drift.map((line) => `  ${line}`).join("\n")}\n`);
        return 1;
      }
      process.stdout.write(`codegen:effect:check passed: ${EFFECT_OUTPUT_DIR} matches spec/v1.\n`);
      return 0;
    }
    writeEffectGenerated(root);
    process.stdout.write(`codegen wrote ${EFFECT_OUTPUT_DIR} from spec/v1.\n`);
    return 0;
  } catch (error) {
    if (error instanceof CodegenError) {
      process.stderr.write(`codegen failed: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
