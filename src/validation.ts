// Runtime behind the generated validators in src/generated/. Each generated
// module embeds its schema document and creates one validator per definition
// with `createValidator`. Validation interprets the JSON Schema 2020-12 subset
// that scripts/codegen.ts allows in spec/v1, so a validator accepts exactly
// what the normative schema accepts. It never copies or strips the input:
// unknown fields, enum values and `x:` variants come back unchanged.

import { AriError } from "./ari-error.ts";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "./standard-schema.ts";

/** A JSON Schema node: a boolean schema or an object of keywords. */
export type SchemaNode = boolean | { readonly [keyword: string]: unknown };

/** One schema file from spec/v1, embedded in its generated module. */
export interface SchemaDocument {
  readonly $id: string;
  readonly $defs: { readonly [name: string]: SchemaNode };
  readonly [keyword: string]: unknown;
}

export type ValidationIssue = StandardSchemaV1.Issue & { readonly path: ReadonlyArray<string | number> };

/** A validator that implements Standard Schema v1 and Standard JSON Schema v1. */
export interface Validator<T> {
  readonly "~standard": StandardSchemaV1.Props<T, T> & StandardJSONSchemaV1.Props<T, T>;
  /** The schema definition name, for example `AriEvent`. */
  readonly name: string;
  /** The absolute id of the definition, for example `https://ari.invalid/spec/v1/events.schema.json#/$defs/AriEvent`. */
  readonly schemaId: string;
  /** True when `value` is valid. */
  is(value: unknown): value is T;
  /** Returns `value` unchanged when valid; otherwise throws an `AriError` with code `validation`. */
  parse(value: unknown): T;
}

const VENDOR = "ari";

const TARGET_URIS: { readonly [target: string]: string } = {
  "draft-2020-12": "https://json-schema.org/draft/2020-12/schema",
  "draft-07": "http://json-schema.org/draft-07/schema#",
};

export function createValidator<T>(
  name: string,
  documentId: string,
  documents: () => readonly SchemaDocument[],
): Validator<T> {
  let registry: Registry | undefined;
  const getRegistry = (): Registry => {
    registry ??= new Registry(documents());
    return registry;
  };
  const schemaId = `${documentId}#/$defs/${name}`;

  const collectIssues = (value: unknown): ValidationIssue[] => {
    const reg = getRegistry();
    const resolved = reg.resolve(`#/$defs/${name}`, documentId);
    return validateNode(reg, resolved.node, value, [], resolved.baseId);
  };

  const toJsonSchema = (options: StandardJSONSchemaV1.Options): Record<string, unknown> => {
    const schemaUri = TARGET_URIS[options.target];
    if (schemaUri === undefined) {
      throw new Error(`ARI validators can produce JSON Schema for draft-2020-12 and draft-07, not "${options.target}".`);
    }
    return bundleJsonSchema(getRegistry(), name, documentId, options.target, schemaUri);
  };

  return {
    "~standard": {
      version: 1,
      vendor: VENDOR,
      validate: (value: unknown): StandardSchemaV1.Result<T> => {
        const issues = collectIssues(value);
        if (issues.length === 0) return { value: value as T };
        return { issues };
      },
      jsonSchema: { input: toJsonSchema, output: toJsonSchema },
    },
    name,
    schemaId,
    is: (value: unknown): value is T => collectIssues(value).length === 0,
    parse: (value: unknown): T => {
      const issues = collectIssues(value);
      if (issues.length === 0) return value as T;
      const first = issues[0];
      const where = first !== undefined && first.path.length > 0 ? ` at ${first.path.join(".")}` : "";
      throw new AriError({
        code: "validation",
        message: `Invalid ${name}${where}: ${first?.message ?? "invalid value"}`,
        issues: issues.map((issue) => ({ message: issue.message, path: [...issue.path] })),
      });
    },
  };
}

interface ResolvedNode {
  readonly node: SchemaNode;
  readonly baseId: string;
  readonly definitionName: string | undefined;
}

class Registry {
  readonly documentsById: Map<string, SchemaDocument>;
  readonly regexCache = new Map<string, RegExp>();

  constructor(documents: readonly SchemaDocument[]) {
    this.documentsById = new Map(documents.map((document) => [document.$id, document]));
  }

  resolve(ref: string, baseId: string): ResolvedNode {
    const hashIndex = ref.indexOf("#");
    const filePart = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
    const pointer = hashIndex === -1 ? "" : ref.slice(hashIndex + 1);
    const documentId = filePart === "" ? baseId : new URL(filePart, baseId).href;
    const document = this.documentsById.get(documentId);
    if (document === undefined) {
      throw new Error(`Schema reference "${ref}" from ${baseId} names an unknown document ${documentId}.`);
    }
    let node: unknown = document;
    const segments = pointer === "" ? [] : pointer.split("/").slice(1).map(decodePointerSegment);
    for (const segment of segments) {
      if (node === null || typeof node !== "object") {
        throw new Error(`Schema reference "${ref}" from ${baseId} does not resolve.`);
      }
      node = (node as { readonly [key: string]: unknown })[segment];
    }
    if (node === undefined) {
      throw new Error(`Schema reference "${ref}" from ${baseId} does not resolve.`);
    }
    const definitionName = segments.length === 2 && segments[0] === "$defs" ? segments[1] : undefined;
    return { node: node as SchemaNode, baseId: documentId, definitionName };
  }

  regex(pattern: string): RegExp {
    let compiled = this.regexCache.get(pattern);
    if (compiled === undefined) {
      compiled = new RegExp(pattern, "u");
      this.regexCache.set(pattern, compiled);
    }
    return compiled;
  }
}

function decodePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

type Path = ReadonlyArray<string | number>;

function issue(path: Path, message: string): ValidationIssue {
  return { message, path: [...path] };
}

function isPlainObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    default:
      return false;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  }
  return false;
}

function validateNode(registry: Registry, node: SchemaNode, value: unknown, path: Path, baseId: string): ValidationIssue[] {
  if (node === true) return [];
  if (node === false) return [issue(path, "No value is allowed here")];

  const issues: ValidationIssue[] = [];
  const keywords = node;

  if (typeof keywords.$ref === "string") {
    const resolved = registry.resolve(keywords.$ref, baseId);
    issues.push(...validateNode(registry, resolved.node, value, path, resolved.baseId));
  }

  if (keywords.type !== undefined) {
    const types = Array.isArray(keywords.type) ? (keywords.type as string[]) : [keywords.type as string];
    if (!types.some((type) => matchesType(type, value))) {
      issues.push(issue(path, `Expected ${types.join(" or ")}, received ${describe(value)}`));
      return issues;
    }
  }

  if (keywords.const !== undefined && !jsonEqual(keywords.const, value)) {
    issues.push(issue(path, `Expected ${JSON.stringify(keywords.const)}`));
  }

  if (Array.isArray(keywords.enum) && !keywords.enum.some((allowed) => jsonEqual(allowed, value))) {
    issues.push(issue(path, `Expected one of ${keywords.enum.map((allowed) => JSON.stringify(allowed)).join(", ")}`));
  }

  if (typeof value === "string") {
    if (typeof keywords.pattern === "string" && !registry.regex(keywords.pattern).test(value)) {
      issues.push(issue(path, `Expected a string matching ${keywords.pattern}`));
    }
    const length = [...value].length;
    if (typeof keywords.minLength === "number" && length < keywords.minLength) {
      issues.push(issue(path, `Expected at least ${keywords.minLength} characters`));
    }
    if (typeof keywords.maxLength === "number" && length > keywords.maxLength) {
      issues.push(issue(path, `Expected at most ${keywords.maxLength} characters`));
    }
  }

  if (typeof value === "number") {
    if (typeof keywords.minimum === "number" && value < keywords.minimum) {
      issues.push(issue(path, `Expected a number >= ${keywords.minimum}`));
    }
    if (typeof keywords.maximum === "number" && value > keywords.maximum) {
      issues.push(issue(path, `Expected a number <= ${keywords.maximum}`));
    }
    if (typeof keywords.exclusiveMinimum === "number" && value <= keywords.exclusiveMinimum) {
      issues.push(issue(path, `Expected a number > ${keywords.exclusiveMinimum}`));
    }
    if (typeof keywords.exclusiveMaximum === "number" && value >= keywords.exclusiveMaximum) {
      issues.push(issue(path, `Expected a number < ${keywords.exclusiveMaximum}`));
    }
  }

  if (Array.isArray(value)) {
    issues.push(...validateArray(registry, keywords, value, path, baseId));
  }

  if (isPlainObject(value)) {
    issues.push(...validateObject(registry, keywords, value, path, baseId));
  }

  if (Array.isArray(keywords.allOf)) {
    for (const member of keywords.allOf as SchemaNode[]) {
      issues.push(...validateNode(registry, member, value, path, baseId));
    }
  }

  if (Array.isArray(keywords.anyOf)) {
    issues.push(...validateUnion(registry, keywords.anyOf as SchemaNode[], value, path, baseId, "anyOf"));
  }

  if (Array.isArray(keywords.oneOf)) {
    issues.push(...validateUnion(registry, keywords.oneOf as SchemaNode[], value, path, baseId, "oneOf"));
  }

  if (keywords.not !== undefined) {
    if (validateNode(registry, keywords.not as SchemaNode, value, path, baseId).length === 0) {
      issues.push(issue(path, "Value matches a schema it must not match"));
    }
  }

  return issues;
}

function validateArray(
  registry: Registry,
  keywords: { readonly [keyword: string]: unknown },
  value: readonly unknown[],
  path: Path,
  baseId: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof keywords.minItems === "number" && value.length < keywords.minItems) {
    issues.push(issue(path, `Expected at least ${keywords.minItems} items`));
  }
  if (typeof keywords.maxItems === "number" && value.length > keywords.maxItems) {
    issues.push(issue(path, `Expected at most ${keywords.maxItems} items`));
  }
  const prefixItems = Array.isArray(keywords.prefixItems) ? (keywords.prefixItems as SchemaNode[]) : [];
  value.forEach((item, index) => {
    const itemSchema = index < prefixItems.length ? prefixItems[index] : (keywords.items as SchemaNode | undefined);
    if (itemSchema !== undefined) {
      issues.push(...validateNode(registry, itemSchema, item, [...path, index], baseId));
    }
  });
  return issues;
}

function validateObject(
  registry: Registry,
  keywords: { readonly [keyword: string]: unknown },
  value: { readonly [key: string]: unknown },
  path: Path,
  baseId: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const properties = isPlainObject(keywords.properties) ? (keywords.properties as { readonly [key: string]: SchemaNode }) : {};
  if (Array.isArray(keywords.required)) {
    for (const key of keywords.required as string[]) {
      if (!Object.hasOwn(value, key)) {
        issues.push(issue([...path, key], `Missing required field "${key}"`));
      }
    }
  }
  for (const [key, propertyValue] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (propertySchema !== undefined) {
      issues.push(...validateNode(registry, propertySchema, propertyValue, [...path, key], baseId));
    } else if (keywords.additionalProperties !== undefined) {
      issues.push(
        ...validateNode(registry, keywords.additionalProperties as SchemaNode, propertyValue, [...path, key], baseId),
      );
    }
  }
  return issues;
}

function validateUnion(
  registry: Registry,
  branches: readonly SchemaNode[],
  value: unknown,
  path: Path,
  baseId: string,
  keyword: "anyOf" | "oneOf",
): ValidationIssue[] {
  const results = branches.map((branch) => validateNode(registry, branch, value, path, baseId));
  const passing = results.filter((branchIssues) => branchIssues.length === 0).length;
  if (keyword === "anyOf" && passing > 0) return [];
  if (keyword === "oneOf" && passing === 1) return [];
  if (passing > 1) return [issue(path, "Value matches more than one variant")];

  // Report the issues of the one variant whose discriminator fields (fields
  // fixed by `const` or `pattern`) match the value, so that an event with a
  // known `type` but a missing field reports that field's path.
  const candidates = branches
    .map((branch, index) => ({ branch, index }))
    .filter(({ branch }) => discriminatorMatches(registry, branch, value, baseId));
  if (candidates.length === 1) {
    const only = candidates[0];
    if (only !== undefined) return results[only.index] ?? [];
  }
  const requiredOnly = branches.every(
    (branch) => typeof branch === "object" && Object.keys(branch).every((key) => key === "required"),
  );
  if (requiredOnly) {
    const alternatives = branches.map((branch) => ((branch as { required?: string[] }).required ?? []).join(" + "));
    return [issue(path, `Expected one of these fields: ${alternatives.join(", ")}`)];
  }
  return [issue(path, "Value matches none of the allowed variants")];
}

function discriminatorMatches(registry: Registry, branch: SchemaNode, value: unknown, baseId: string): boolean {
  if (!isPlainObject(value)) return false;
  let node = branch;
  let nodeBaseId = baseId;
  while (typeof node === "object" && typeof node.$ref === "string") {
    const resolved = registry.resolve(node.$ref, nodeBaseId);
    node = resolved.node;
    nodeBaseId = resolved.baseId;
  }
  if (typeof node !== "object" || !isPlainObject(node.properties)) return false;
  let sawDiscriminator = false;
  for (const [key, propertyNode] of Object.entries(node.properties as { readonly [key: string]: SchemaNode })) {
    let property = propertyNode;
    let propertyBaseId = nodeBaseId;
    while (typeof property === "object" && typeof property.$ref === "string") {
      const resolved = registry.resolve(property.$ref, propertyBaseId);
      property = resolved.node;
      propertyBaseId = resolved.baseId;
    }
    if (typeof property !== "object") continue;
    const isDiscriminator = property.const !== undefined || typeof property.pattern === "string";
    if (!isDiscriminator) continue;
    sawDiscriminator = true;
    if (!Object.hasOwn(value, key)) return false;
    if (validateNode(registry, property, value[key], [], propertyBaseId).length > 0) return false;
  }
  return sawDiscriminator;
}

// Standard JSON Schema output: one self-contained schema per validator. Every
// referenced definition is copied into `$defs` (draft 2020-12) or
// `definitions` (draft-07) under its own name, which codegen keeps unique.
function bundleJsonSchema(
  registry: Registry,
  name: string,
  documentId: string,
  target: string,
  schemaUri: string,
): Record<string, unknown> {
  const definitionsKey = target === "draft-07" ? "definitions" : "$defs";
  const definitions: Record<string, unknown> = {};
  const pending: Array<{ name: string; documentId: string }> = [];

  const rewrite = (node: unknown, baseId: string): unknown => {
    if (Array.isArray(node)) return node.map((item) => rewrite(item, baseId));
    if (!isPlainObject(node)) return node;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "$ref" && typeof child === "string") {
        const resolved = registry.resolve(child, baseId);
        if (resolved.definitionName === undefined) {
          throw new Error(`Cannot bundle reference "${child}": it does not point at a definition.`);
        }
        if (!(resolved.definitionName in definitions)) {
          definitions[resolved.definitionName] = {};
          pending.push({ name: resolved.definitionName, documentId: resolved.baseId });
        }
        output.$ref = `#/${definitionsKey}/${resolved.definitionName}`;
      } else if (key === "properties" || key === "$defs") {
        output[key] = Object.fromEntries(
          Object.entries(child as { readonly [key: string]: unknown }).map(([name, schema]) => [name, rewrite(schema, baseId)]),
        );
      } else {
        output[key] = rewrite(child, baseId);
      }
    }
    if (target === "draft-07" && Array.isArray(output.prefixItems)) {
      const restItems = output.items;
      output.items = output.prefixItems;
      delete output.prefixItems;
      if (restItems !== undefined) output.additionalItems = restItems;
    }
    return output;
  };

  const root = registry.resolve(`#/$defs/${name}`, documentId);
  const rootSchema = rewrite(root.node, root.baseId);
  const done = new Set<string>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || done.has(next.name)) continue;
    done.add(next.name);
    const resolved = registry.resolve(`#/$defs/${next.name}`, next.documentId);
    definitions[next.name] = rewrite(resolved.node, resolved.baseId);
  }

  const bundled: Record<string, unknown> = typeof rootSchema === "boolean" ? { allOf: [rootSchema] } : { ...(rootSchema as object) };
  return { $schema: schemaUri, ...bundled, [definitionsKey]: definitions };
}
